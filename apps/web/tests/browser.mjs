// Browser checks for the built web application. Run `npm run test:browser` from the repository
// root: it builds the application, serves it with `next start` and drives a real Chrome.
//
// Needs a Chrome or Chromium binary. Set CHROME_PATH, or install one at a usual location.
// What these checks do not cover is listed in docs/delivery/WEB_FOUNDATION_SLICE_3.md.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const port = Number(process.env.WEB_TEST_PORT ?? 3101);
const apiPort = Number(process.env.API_TEST_PORT ?? 3102);
const origin = `http://localhost:${port}`;
const apiMain = fileURLToPath(new URL('../../api/dist/main.js', import.meta.url));
const apiMigrate = fileURLToPath(new URL('../../api/dist/cli/migrate.js', import.meta.url));
const apiSettings = fileURLToPath(
  new URL('../../api/dist/cli/security-settings.js', import.meta.url),
);
const apiLocalDatabase = fileURLToPath(
  new URL('../../api/dist/cli/local-database.js', import.meta.url),
);
const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('./output/', import.meta.url));
const locales = ['en', 'ar', 'ur'];
const apiOrigin = `http://127.0.0.1:${apiPort}`;
// The web application reaches the API through a stand-in on this port, so the checks can lose
// an answer on its way back. It adds no header of its own and otherwise passes everything on.
const relayPort = apiPort + 20;
const relay = { mode: 'pass', lost: [] };
const REVOCATIONS = [
  ['POST', /^\/auth\/sign-out$/],
  ['DELETE', /^\/me\/sessions\/[^/]+$/],
  ['POST', /^\/me\/sessions\/revoke-others$/],
  // Creating and changing an organisation: the same question, was it done or not.
  ['POST', /^\/organisations$/],
  ['PATCH', /^\/organisations\/[^/]+$/],
  // Saving, changing and discarding a shipment draft.
  ['POST', /^\/organisations\/[^/]+\/shipments$/],
  ['PATCH', /^\/organisations\/[^/]+\/shipments\/[^/]+$/],
  ['POST', /^\/organisations\/[^/]+\/shipments\/[^/]+\/discard$/],
  // Submitting an application for verification.
  ['POST', /^\/organisations\/[^/]+\/verification\/applications$/],
  // Publishing and withdrawing a shipment.
  ['POST', /^\/organisations\/[^/]+\/shipments\/[^/]+\/publish$/],
  ['POST', /^\/organisations\/[^/]+\/shipments\/[^/]+\/withdraw$/],
  // Sending and withdrawing a quotation.
  ['POST', /^\/organisations\/[^/]+\/discovery\/shipments\/[^/]+\/quotations$/],
  ['POST', /^\/organisations\/[^/]+\/quotations\/[^/]+\/withdraw$/],
  // Registering a vehicle and inviting a driver.
  ['POST', /^\/organisations\/[^/]+\/fleet\/vehicles$/],
  ['POST', /^\/organisations\/[^/]+\/fleet\/drivers$/],
  // Accepting a quotation.
  ['POST', /^\/organisations\/[^/]+\/quotations\/[^/]+\/accept$/],
  ['POST', /^\/organisations\/[^/]+\/bookings\/[^/]+\/cancel$/],
  // Assigning resources to a booking.
  ['POST', /^\/organisations\/[^/]+\/bookings\/[^/]+\/assignment$/],
];
function startRelay() {
  const server = http.createServer((request, response) => {
    // "down": nothing gets through, as if the network between web and API had failed.
    if (relay.mode === 'down') return request.socket.destroy();
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: apiPort,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (answer) => {
        const chunks = [];
        answer.on('data', (chunk) => chunks.push(chunk));
        answer.on('end', () => {
          const revocation = REVOCATIONS.some(
            ([method, path]) => method === request.method && path.test(request.url),
          );
          // "lose": the API carried the revocation out and answered, but the answer never
          // arrives. After that nothing gets through until the test restores the connection.
          if (relay.mode === 'lose' && revocation) {
            relay.lost.push(`${request.method} ${request.url} -> ${answer.statusCode}`);
            relay.mode = 'down';
            return request.socket.destroy();
          }
          response.writeHead(answer.statusCode, answer.headers);
          response.end(Buffer.concat(chunks));
        });
      },
    );
    upstream.on('error', () => request.socket.destroy());
    request.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(relayPort, '127.0.0.1', () => resolve(server)));
}
// This machine's own address on the network. A connection made to it arrives from it, so it
// stands in for a visitor who is not on this machine.
const outsideAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
const messagesFor = (locale) =>
  JSON.parse(readFileSync(new URL(`../src/i18n/messages/${locale}.json`, import.meta.url), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One request made by hand, so the test controls the address connected to and every header,
// including Host. Returns the status, the headers and the body.
function rawRequest({ connectTo, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: connectTo, port, path, method, headers, setHost: false },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

// Asks for a sign-in code the way a browser without scripts does: reads the sign-in form, posts
// it, and returns what the web application stored for the visitor and showed on the next page.
async function rawCodeRequest({ connectTo, hostHeader, extraHeaders = {}, phone }) {
  const base = { host: hostHeader, ...extraHeaders };
  const form = await rawRequest({ connectTo, path: '/en/sign-in', headers: base });
  const fields = [
    ...form.body.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g),
  ].map((match) => [match[1], match[2] ?? '']);
  const boundary = `----trucker${Date.now()}`;
  const part = (name, value) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.from(
    fields.map(([name, value]) => part(name, value)).join('') +
      part('phone', phone) +
      `--${boundary}--\r\n`,
  );
  const posted = await rawRequest({
    connectTo,
    path: '/en/sign-in',
    method: 'POST',
    headers: {
      ...base,
      origin: `http://${hostHeader}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
  });
  const setCookie = (posted.headers['set-cookie'] ?? []).find((value) =>
    value.startsWith('trucker_sign_in='),
  );
  const cookieValue = setCookie ? setCookie.split(';')[0].slice('trucker_sign_in='.length) : '';
  let stored = null;
  try {
    stored = JSON.parse(decodeURIComponent(cookieValue));
  } catch {
    // nothing stored
  }
  const next = await rawRequest({
    connectTo,
    path: '/en/sign-in/code',
    headers: { ...base, cookie: `trucker_sign_in=${cookieValue}` },
  });
  return {
    status: posted.status,
    location: posted.headers.location ?? posted.headers['x-action-redirect'] ?? '',
    stored,
    page: next.body,
  };
}
const widths = [320, 360, 390, 412, 600, 768, 1024, 1280, 1440, 1920];

const failures = [];
const counts = {};
function check(group, ok, message) {
  counts[group] = (counts[group] ?? 0) + 1;
  if (!ok) failures.push(`${group}: ${message}`);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error('No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.');
  return found;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${origin}/en`, { redirect: 'manual' });
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the web application did not start');
}

// Runs in the page: anything wider than the viewport, outside it, or clipped.
function findOverflow() {
  const viewport = document.documentElement.clientWidth;
  const found = [];
  if (document.documentElement.scrollWidth > viewport + 1) {
    found.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${viewport})`);
  }
  for (const element of document.querySelectorAll('body *')) {
    if (element.closest('.visually-hidden, .skip-link, svg')) continue;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const label = `${element.tagName.toLowerCase()}.${element.className}`;
    if (box.right > viewport + 1 || box.left < -1) found.push(`${label} is outside the viewport`);
    const style = getComputedStyle(element);
    // A single-line text box scrolls a value longer than itself: that is how it works, and a
    // person can move through it. Everything else must not cut its content off.
    if (element.tagName === 'INPUT') continue;
    if (
      element.scrollWidth > element.clientWidth + 1 &&
      element.clientWidth > 0 &&
      style.overflowX !== 'visible'
    ) {
      found.push(`${label} clips its content`);
    }
  }
  return found.slice(0, 4);
}

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
}

async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL must be set: the journey checks use the real API and database.');
  if (!existsSync(apiMain)) throw new Error('Build the API first: npm run build -w @trucker/api');
  // The API under test: real code, real PostgreSQL. Codes are displayed because this is a local
  // development configuration.
  const apiEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(apiPort),
    SIGN_IN_CODE_DELIVERY: 'development-display',
    REGISTRATION_TERMS: 'demonstration',
    // The development stand-in for a payment provider (slice 27): it moves no money.
    PAYMENT_PROVIDER: 'test',
    // Proof-of-delivery files kept in a temporary folder (slice 18b's development stand-in).
    FILE_STORAGE: 'local',
    FILE_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'trucker-browser-pod-')),
  };
  await run(apiMigrate, ['up'], apiEnv);
  // The resend wait is shortened so the checks do not take minutes. Limits are protected
  // settings in the database, changed by the migration role and never by the API; the values
  // found here are put back when the checks end.
  const settingsBefore = JSON.parse(await run(apiSettings, ['show'], apiEnv));
  const restoreSettings = () =>
    run(
      apiSettings,
      [
        'set',
        `code_resend_wait_seconds=${settingsBefore.code_resend_wait_seconds}`,
        `code_max_per_hour=${settingsBefore.code_max_per_hour}`,
        `shipment_page_size=${settingsBefore.shipment_page_size}`,
        ...(settingsBefore.reviewed_for_production ? ['--reviewed-for-production'] : []),
      ],
      apiEnv,
    );
  // Two drafts to a page, so that paging is seen with a handful of drafts.
  await run(
    apiSettings,
    ['set', 'code_resend_wait_seconds=10', 'code_max_per_hour=30', 'shipment_page_size=2'],
    apiEnv,
  );
  // The API runs as its own database role, which row security binds, never as the migration
  // role. The fictional countries are loaded with the explicit acknowledgement they require.
  const appRole = await run(apiLocalDatabase, ['app-role'], apiEnv);
  apiEnv.APP_DATABASE_URL = /APP_DATABASE_URL=(\S+)/.exec(appRole)[1];
  apiEnv.COUNTRY_FIXTURES = 'local-development';
  await run(apiLocalDatabase, ['fixtures'], {
    ...apiEnv,
    TRUCKER_LOCAL_FIXTURES: 'local-development-only',
  });
  // A zone whose clocks change, for the fictional country XA, so that a time that occurs twice
  // and one that does not exist can be shown. The fixtures have fixed-offset zones only. It is
  // removed when the checks end.
  const owner = new (createRequire(new URL('../../api/package.json', import.meta.url))(
    'pg',
  ).Client)({ connectionString: process.env.DATABASE_URL });
  await owner.connect();
  await owner.query(
    `INSERT INTO trucker.country_time_zone (country_code, zone_name)
     VALUES ('XA', 'America/New_York') ON CONFLICT DO NOTHING`,
  );
  const removeTestZone = async () => {
    await owner.query(
      `DELETE FROM trucker.country_time_zone z
       WHERE z.country_code = 'XA' AND z.zone_name = 'America/New_York'
         AND NOT EXISTS (SELECT 1 FROM trucker.shipment_draft d
                         WHERE 'America/New_York' IN (d.pickup_time_zone, d.delivery_time_zone))`,
    );
    await owner.end();
  };
  let apiLog = '';
  let apiServer;
  const apiAnswers = async () => {
    try {
      return (await fetch(`${apiOrigin}/health/live`)).status === 200;
    } catch {
      return false;
    }
  };
  // The API is stopped and started again during the checks, to see what the web application
  // does when it gets no answer. Sessions are in the database, so they survive a restart.
  const startApi = async () => {
    apiServer = spawn(process.execPath, [apiMain], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: apiEnv,
    });
    apiServer.stdout.on('data', (chunk) => (apiLog += chunk));
    apiServer.stderr.on('data', (chunk) => (apiLog += chunk));
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await apiAnswers()) return;
      await sleep(250);
    }
    throw new Error('the API did not start');
  };
  const stopApi = async () => {
    const stopped = new Promise((resolve) => apiServer.once('exit', resolve));
    apiServer.kill();
    await stopped;
    for (let attempt = 0; attempt < 40 && (await apiAnswers()); attempt += 1) await sleep(100);
  };
  // What the API itself says about a session token: 200 while valid, 401 once revoked.
  const apiSaysToken = async (token) =>
    (await fetch(`${apiOrigin}/me`, { headers: { authorization: `Bearer ${token}` } })).status;
  await startApi();
  const relayServer = await startRelay();

  const server = spawn(
    process.execPath,
    // Listens on every address, so the checks can also arrive as a visitor from outside.
    [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '0.0.0.0'],
    {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        TRUCKER_API_URL: `http://127.0.0.1:${relayPort}`,
        TRUCKER_DEVELOPMENT_CODE_DISPLAY: 'local-visitors',
      },
    },
  );
  let serverLog = '';
  server.stdout.on('data', (chunk) => (serverLog += chunk));
  server.stderr.on('data', (chunk) => (serverLog += chunk));

  let browser;
  try {
    await waitForServer();
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage();
    const pageErrors = [];
    const foreignRequests = new Set();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol.startsWith('http') && url.origin !== origin) foreignRequests.add(url.origin);
    });
    const open = async (path, width = 1280) => {
      await page.setViewport({ width, height: 900 });
      const response = await page.goto(origin + path, { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.fonts.ready);
      return response;
    };

    // Routing
    const root = await fetch(`${origin}/`, { redirect: 'manual' });
    check(
      'routing',
      root.status === 307 && root.headers.get('location') === '/en',
      `/ answered ${root.status} to ${root.headers.get('location')}`,
    );
    check(
      'routing',
      (await fetch(`${origin}/fr`)).status === 404,
      'an unknown language is not a 404',
    );
    check(
      'routing',
      !(await fetch(`${origin}/en`)).headers.has('x-powered-by'),
      'the framework advertises itself in a header',
    );
    const missing = await open('/ar/no-such-page');
    check(
      'routing',
      missing.status() === 404,
      `an unknown page under a language answered ${missing.status()}`,
    );
    const missingPage = await page.evaluate(
      () =>
        `${document.documentElement.lang}:${document.documentElement.dir}:${document.querySelector('.not-found a')?.getAttribute('href')}`,
    );
    check(
      'routing',
      missingPage === 'ar:rtl:/ar',
      `the not-found page under /ar is ${missingPage}`,
    );
    check(
      'routing',
      (await page.evaluate(() => document.querySelectorAll('h1').length)) === 1,
      'the not-found page does not have exactly one main heading',
    );

    // Language, direction, structure and fonts
    for (const locale of locales) {
      const response = await open(`/${locale}`);
      check('language', response.status() === 200, `/${locale} answered ${response.status()}`);
      const facts = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        title: document.title,
        h1: document.querySelectorAll('h1').length,
        main: document.querySelectorAll('main').length,
        current: [...document.querySelectorAll('.languages a[aria-current="true"]')]
          .map((link) => link.lang)
          .join(','),
        bodyFont: getComputedStyle(document.body).fontFamily,
        barlow: document.fonts.check('16px Barlow', 'Trucker'),
        arabic: document.fonts.check('16px "Noto Sans Arabic"', 'شحن اردو ٹرک'),
        headingsInOrder: (() => {
          let previous = 0;
          for (const heading of document.querySelectorAll('h1, h2, h3')) {
            const level = Number(heading.tagName[1]);
            if (level > previous + 1) return false;
            previous = level;
          }
          return true;
        })(),
      }));
      const rtl = locale !== 'en';
      check(
        'language',
        facts.lang === locale && facts.dir === (rtl ? 'rtl' : 'ltr'),
        `/${locale} is marked ${facts.lang} ${facts.dir}`,
      );
      check(
        'language',
        facts.title.length > 0 && facts.h1 === 1 && facts.main === 1,
        `/${locale} title, main heading or main region is wrong`,
      );
      check(
        'language',
        facts.current === locale,
        `/${locale} marks ${facts.current} as the current language`,
      );
      check('language', facts.headingsInOrder, `/${locale} skips a heading level`);
      check('fonts', facts.barlow, `/${locale}: Barlow did not load`);
      check(
        'fonts',
        !rtl || (facts.arabic && facts.bodyFont.includes('Noto Sans Arabic')),
        `/${locale}: Noto Sans Arabic did not load or is not the body font`,
      );
    }
    check(
      'privacy',
      foreignRequests.size === 0,
      `the pages contact other hosts: ${[...foreignRequests].join(', ')}`,
    );

    // Switching language keeps the page and changes direction
    await open('/en');
    await Promise.all([page.waitForNavigation(), page.click('.languages a[lang="ur"]')]);
    check(
      'language',
      page.url() === `${origin}/ur` &&
        (await page.evaluate(() => document.documentElement.dir)) === 'rtl',
      `the Urdu link led to ${page.url()}`,
    );

    // One layout at many widths, and with the reader's text size doubled
    for (const locale of locales) {
      for (const width of widths) {
        await open(`/${locale}`, width);
        const found = await page.evaluate(findOverflow);
        check('responsive', found.length === 0, `${locale} at ${width}px: ${found.join('; ')}`);
      }
      for (const [label, width, scale] of [
        ['1280px at 200% zoom', 640, 1],
        ['390px at 200% zoom', 195, 1],
        ['390px with text size doubled', 390, 2],
        ['320px with text size doubled', 320, 2],
      ]) {
        await open(`/${locale}`, width);
        await page.evaluate(
          (factor) => (document.documentElement.style.fontSize = `${factor * 100}%`),
          scale,
        );
        const found = await page.evaluate(findOverflow);
        check('zoom', found.length === 0, `${locale}, ${label}: ${found.join('; ')}`);
      }
    }

    // Keyboard: every control reached, in reading order, with a visible focus indicator
    for (const [locale, width] of [
      ['en', 1280],
      ['en', 390],
      ['ar', 390],
    ]) {
      await open(`/${locale}`, width);
      const expected = await page.evaluate(
        () => document.querySelectorAll('a[href], button, input, select, textarea').length,
      );
      const seen = [];
      for (let presses = 0; presses < expected + 2; presses += 1) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => {
          const element = document.activeElement;
          if (!element || element === document.body) return null;
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            position: [...document.querySelectorAll('*')].indexOf(element),
            ring: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2,
            visible: box.width > 0 && box.height > 0 && box.top >= 0,
          };
        });
        if (!focused) break;
        seen.push(focused);
      }
      const inOrder = seen.every(
        (item, index) => index === 0 || item.position > seen[index - 1].position,
      );
      check(
        'keyboard',
        seen.length === expected,
        `${locale} at ${width}px: reached ${seen.length} of ${expected} controls`,
      );
      check('keyboard', inOrder, `${locale} at ${width}px: focus does not follow reading order`);
      check(
        'keyboard',
        seen.every((item) => item.ring && item.visible),
        `${locale} at ${width}px: a focused control has no visible indicator`,
      );
    }
    await open('/en', 390);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    check(
      'keyboard',
      (await page.evaluate(() => document.activeElement?.id)) === 'main',
      'the skip link does not move focus to the main content',
    );

    // Touch targets, left-to-right islands, motion
    for (const locale of locales) {
      for (const width of [320, 390]) {
        await open(`/${locale}`, width);
        const small = await page.evaluate(() =>
          [...document.querySelectorAll('a[href], button')]
            .filter((element) => !element.classList.contains('skip-link'))
            .map((element) => ({
              box: element.getBoundingClientRect(),
              text: element.textContent.trim(),
            }))
            .filter(({ box }) => Math.min(box.width, box.height) < 44)
            .map(({ box, text }) => `${text} (${Math.round(Math.min(box.width, box.height))}px)`),
        );
        check(
          'targets',
          small.length === 0,
          `${locale} at ${width}px: smaller than 44px: ${small.join(', ')}`,
        );
        const broken = await page.evaluate(() =>
          [...document.querySelectorAll('.ltr')]
            .filter(
              (element) =>
                getComputedStyle(element).direction !== 'ltr' ||
                element.offsetHeight > parseFloat(getComputedStyle(element).fontSize) * 2.2,
            )
            .map((element) => element.textContent),
        );
        check(
          'mixed direction',
          broken.length === 0,
          `${locale} at ${width}px: split or misdirected: ${broken.join(', ')}`,
        );
      }
    }
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await open('/en');
    check(
      'motion',
      (await page.evaluate(() => document.getAnimations().length)) === 0,
      'something animates although reduced motion is requested',
    );
    await page.emulateMediaFeatures([]);

    // Automated accessibility rules (only part of what WCAG covers)
    const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
    for (const path of ['/en', '/ar', '/ur', '/en/no-such-page']) {
      for (const width of [390, 1280]) {
        await open(path, width);
        await page.evaluate(axeSource);
        const violations = await page.evaluate(async () => {
          const result = await window.axe.run(document, {
            runOnly: {
              type: 'tag',
              values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
            },
          });
          return result.violations.map(
            (violation) =>
              `${violation.id} (${violation.nodes.length}): ${violation.nodes[0].html.slice(0, 120)}`,
          );
        });
        check(
          'accessibility rules',
          violations.length === 0,
          `${path} at ${width}px: ${violations.join(' | ')}`,
        );
      }
    }
    check('scripts', pageErrors.length === 0, `script errors: ${pageErrors.join(' | ')}`);

    // ------------------------------------------------------------------------------------
    // Registration journey against the real API and database, in each language
    // ------------------------------------------------------------------------------------
    mkdirSync(outDir, { recursive: true });
    // At most five pictures, for design review only.
    const shots = {
      'en:booking refund': 'booking-refund-en-390',
      'ar:booking refund': 'booking-refund-ar-390',
      'en:trip for carrier': 'trip-carrier-en-390',
      'en:trip for shipper': 'cargo-shipper-en-390',
      'ur:trip for shipper': 'cargo-shipper-ur-390',
      'ar:driver trip': 'driver-trip-ar-390',
    };
    // Fictional numbers: country code 999 is not assigned. Unique per run.
    const stamp = String(Date.now()).slice(-7);
    const phoneFor = (index) => `+9995${index}${stamp}`;
    const text = (selector) =>
      page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, selector);
    const focusedId = () => page.evaluate(() => document.activeElement?.id ?? '');
    const submit = async (selector) => {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click(selector),
      ]);
      await page.evaluate(() => document.fonts.ready);
    };
    // Checks one state of one screen: layout at several widths, doubled text, rules, direction.
    const inspect = async (locale, state) => {
      const label = `${locale} ${state}`;
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewport({ width, height: 900 });
        const found = await page.evaluate(findOverflow);
        check('journey layout', found.length === 0, `${label} at ${width}px: ${found.join('; ')}`);
      }
      await page.setViewport({ width: 390, height: 900 });
      const shot = shots[`${locale}:${state}`];
      if (shot) await page.screenshot({ path: `${outDir}${shot}.png`, fullPage: true });
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      const doubled = await page.evaluate(findOverflow);
      check(
        'journey layout',
        doubled.length === 0,
        `${label} with text doubled: ${doubled.join('; ')}`,
      );
      await page.evaluate(() => (document.documentElement.style.fontSize = ''));
      const facts = await page.evaluate(() => ({
        dir: document.documentElement.dir,
        lang: document.documentElement.lang,
        h1: document.querySelectorAll('h1').length,
        unlabelled: [...document.querySelectorAll('input:not([type=hidden])')].filter(
          (input) => !document.querySelector(`label[for="${input.id}"]`),
        ).length,
        small: [...document.querySelectorAll('a[href], button, input:not([type=hidden])')]
          .filter((element) => !element.classList.contains('skip-link'))
          .map((element) => ({
            box: element.getBoundingClientRect(),
            name: element.textContent.trim() || element.id,
          }))
          .filter(({ box }) => box.width > 0 && Math.min(box.width, box.height) < 24)
          .map(({ name }) => name),
        islands: [...document.querySelectorAll('.ltr')].filter(
          (element) => getComputedStyle(element).direction !== 'ltr',
        ).length,
      }));
      check(
        'journey structure',
        facts.lang === locale && facts.dir === (locale === 'en' ? 'ltr' : 'rtl'),
        `${label}: marked ${facts.lang} ${facts.dir}`,
      );
      check(
        'journey structure',
        facts.h1 === 1 && facts.unlabelled === 0,
        `${label}: ${facts.h1} main headings, ${facts.unlabelled} inputs without a label`,
      );
      check(
        'journey structure',
        facts.small.length === 0 && facts.islands === 0,
        `${label}: small targets [${facts.small.join(', ')}], misdirected islands ${facts.islands}`,
      );
      // After a form is sent, Next.js swaps the page in place and the title can arrive a moment
      // after the content. Wait for it, so the rules run on the finished page; a page that
      // never gets a title still fails the document-title rule below.
      await page
        .waitForFunction(() => document.title.trim() !== '', { timeout: 5000 })
        .catch(() => undefined);
      await page.evaluate(axeSource);
      const violations = await page.evaluate(async () => {
        const result = await window.axe.run(document, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
          },
        });
        return result.violations.map(
          (violation) =>
            `${violation.id} (${violation.nodes.length}): ${violation.nodes[0].html.slice(0, 120)}`,
        );
      });
      check(
        'journey accessibility rules',
        violations.length === 0,
        `${label}: ${violations.join(' | ')}`,
      );
    };

    const people = {};
    for (const [index, locale] of locales.entries()) {
      const phone = phoneFor(index);
      await open(`/${locale}/sign-in`, 390);
      await inspect(locale, 'sign-in');

      // Nothing typed: refused, the summary has focus and links to the field.
      await submit('#sign-in-form button[type=submit]');
      check(
        'journey',
        (await focusedId()) === 'error-summary',
        `${locale}: focus is not on the error summary after an empty sign-in`,
      );
      check(
        'journey',
        (await page.evaluate(() =>
          document.querySelector('#error-summary a')?.getAttribute('href'),
        )) === '#phone',
        `${locale}: the summary does not link to the phone field`,
      );
      check(
        'journey',
        (await page.evaluate(() =>
          document.querySelector('#phone').getAttribute('aria-invalid'),
        )) === 'true',
        `${locale}: the phone field is not marked invalid`,
      );
      await inspect(locale, 'sign-in error');

      // A number without a country code: refused, and what was typed is still there.
      await page.type('#phone', '0501234567');
      await submit('#sign-in-form button[type=submit]');
      check(
        'journey',
        (await page.evaluate(() => document.querySelector('#phone').value)) === '0501234567',
        `${locale}: the typed number was lost after an error`,
      );
      check(
        'journey',
        page.url().includes('error=phone') && !page.url().includes('0501234567'),
        `${locale}: wrong address after an invalid number: ${page.url()}`,
      );

      await page.evaluate(() => (document.querySelector('#phone').value = ''));
      await page.type('#phone', phone);
      await submit('#sign-in-form button[type=submit]');
      check(
        'journey',
        page.url() === `${origin}/${locale}/sign-in/code`,
        `${locale}: a valid number led to ${page.url()}`,
      );
      const code = await text('.notice-development .ltr');
      check('journey', /^[0-9]{6}$/.test(code ?? ''), `${locale}: no development code is shown`);
      await inspect(locale, 'code');

      const wrong = code === '000000' ? '000001' : '000000';
      await page.type('#code', wrong);
      await submit('form.card button.button-primary');
      check(
        'journey',
        page.url().includes('error=code_incorrect') && page.url().includes('left=4'),
        `${locale}: a wrong code led to ${page.url()}`,
      );
      check(
        'journey',
        (await focusedId()) === 'error-summary',
        `${locale}: focus is not on the error summary after a wrong code`,
      );
      check(
        'journey',
        (await page.evaluate(() => document.querySelector('#code').value)) === '',
        `${locale}: the code field kept a value`,
      );
      await inspect(locale, 'code error');

      await page.type('#code', code);
      await submit('form.card button.button-primary');
      check(
        'journey',
        page.url() === `${origin}/${locale}/register`,
        `${locale}: a correct code for a new number led to ${page.url()}`,
      );
      await inspect(locale, 'register');

      await submit('#register-form button[type=submit]');
      const summary = await page.evaluate(() =>
        [...document.querySelectorAll('#error-summary a')].map((link) => link.getAttribute('href')),
      );
      check(
        'journey',
        summary.join(',') === '#displayName,#termsSeen' && (await focusedId()) === 'error-summary',
        `${locale}: empty registration reported ${summary.join(',')}`,
      );
      await inspect(locale, 'register error');

      // A draft survives a change of language: type, switch language, switch back.
      const name = {
        en: 'Test Person (fictional)',
        ar: 'شخص تجريبي (وهمي)',
        ur: 'آزمائشی فرد (فرضی)',
      }[locale];
      await page.type('#displayName', name);
      await page.type('#contactEmail', 'person@example.test');
      await page.click('#termsSeen');
      const other = locale === 'en' ? 'ar' : 'en';
      await submit(`.languages a[lang="${other}"]`);
      check(
        'journey',
        page.url().startsWith(`${origin}/${other}/register`),
        `${locale}: the language link left the registration page: ${page.url()}`,
      );
      await page
        .waitForFunction(() => document.querySelector('#displayName').value !== '', {
          timeout: 5000,
        })
        .catch(() => undefined);
      const kept = await page.evaluate(() =>
        [
          document.querySelector('#displayName').value,
          document.querySelector('#contactEmail').value,
          document.querySelector('#termsSeen').checked,
        ].join('|'),
      );
      check(
        'journey',
        kept === `${name}|person@example.test|true`,
        `${locale}: after changing language the draft is "${kept}"`,
      );
      await submit(`.languages a[lang="${locale}"]`);
      await page
        .waitForFunction(() => document.querySelector('#displayName').value !== '', {
          timeout: 5000,
        })
        .catch(() => undefined);

      await submit('#register-form button[type=submit]');
      check(
        'journey',
        page.url() === `${origin}/${locale}/account?done=registered`,
        `${locale}: registration led to ${page.url()}`,
      );
      check(
        'journey',
        (await text('.facts bdi')) === name,
        `${locale}: the account shows the name "${await text('.facts bdi')}"`,
      );
      check(
        'journey',
        (await page.evaluate(() => document.querySelectorAll('.session').length)) === 1,
        `${locale}: the account does not show exactly one session`,
      );
      await inspect(locale, 'account');
      people[locale] = { phone, name };

      // ----------------------------------------------------------------------------------
      // Organisation onboarding, in this language
      // ----------------------------------------------------------------------------------
      const org = messagesFor(locale).org;
      const sessionTokenNow = (await browser.cookies()).find(
        (cookie) => cookie.name === 'trucker_session',
      )?.value;
      const apiAs = async (method, route, body) => {
        const response = await fetch(apiOrigin + route, {
          method,
          headers: {
            authorization: `Bearer ${sessionTokenNow}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() };
      };
      await submit('#open-organisations');
      check(
        'organisation',
        page.url() === `${origin}/${locale}/organisations` &&
          (await text('#no-organisations')) === org.none,
        `${locale}: the organisations page for a new person is ${page.url()}`,
      );
      await inspect(locale, 'organisations empty');
      await submit('#create-organisation');
      check(
        'organisation',
        (await text('#fixture-notice')) === org.fixtureNotice,
        `${locale}: the fictional countries are not labelled as development-only`,
      );
      await inspect(locale, 'organisation new');

      // Nothing typed: each required field is named and linked; focus is on the summary.
      await submit('#organisation-new-form button[type=submit]');
      const orgSummary = await page.evaluate(() =>
        [...document.querySelectorAll('#error-summary a')].map((link) => link.getAttribute('href')),
      );
      check(
        'organisation',
        orgSummary.join(',') === '#legalName,#countryCode,#registrationNumber' &&
          (await focusedId()) === 'error-summary',
        `${locale}: an empty organisation form reported ${orgSummary.join(',')}`,
      );
      check(
        'organisation',
        (await apiAs('GET', '/organisations')).body.organisations.length === 0,
        `${locale}: a refused form created an organisation`,
      );
      await inspect(locale, 'organisation new error');

      const legalName = {
        en: 'Fixture Freight Company (fictional)',
        ar: 'شركة الشحن التجريبية (وهمية)',
        ur: 'آزمائشی فریٹ کمپنی (فرضی)',
      }[locale];
      const registrationNumber = `FX-${stamp}-${index}`;
      await page.type('#legalName', legalName);
      await page.select('#countryCode', 'XA');
      await page.type('#registrationNumber', registrationNumber);
      await page.type('#address', 'Unit 7, Example Road');
      // The draft survives a change of language and back.
      const otherLanguage = locale === 'en' ? 'ar' : 'en';
      await submit(`.languages a[lang="${otherLanguage}"]`);
      await page
        .waitForFunction(() => document.querySelector('#legalName').value !== '', { timeout: 5000 })
        .catch(() => undefined);
      await submit(`.languages a[lang="${locale}"]`);
      await page
        .waitForFunction(() => document.querySelector('#legalName').value !== '', { timeout: 5000 })
        .catch(() => undefined);
      const keptOrganisation = await page.evaluate(() =>
        ['legalName', 'countryCode', 'registrationNumber', 'address']
          .map((id) => document.getElementById(id).value)
          .join('|'),
      );
      check(
        'organisation',
        keptOrganisation === `${legalName}|XA|${registrationNumber}|Unit 7, Example Road`,
        `${locale}: after changing language the organisation draft is "${keptOrganisation}"`,
      );
      await submit('#organisation-new-form button[type=submit]');
      const organisationId = /\/organisations\/([0-9a-f-]{36})\?done=created$/.exec(
        page.url(),
      )?.[1];
      check(
        'organisation',
        Boolean(organisationId) && (await text('#organisation-confirmation')) === org.created,
        `${locale}: creating an organisation led to ${page.url()}`,
      );
      check(
        'organisation',
        ((await text('#organisation-status')) ?? '').includes(org.statusDraft) &&
          ((await text('#organisation-status')) ?? '').includes(org.draftNotice) &&
          (await text('h1')) === legalName,
        `${locale}: the organisation page does not say it is an unverified draft`,
      );
      const stored = (await apiAs('GET', `/organisations/${organisationId}`)).body.organisation;
      check(
        'organisation',
        stored?.legalName === legalName &&
          stored?.status === 'draft' &&
          stored?.countryCode === 'XA' &&
          stored?.requestedCapability === 'ship' &&
          stored?.version === 1,
        `${locale}: what the API stored is ${JSON.stringify(stored)}`,
      );
      await inspect(locale, 'organisation');

      // Change it. The draft of a change also survives a change of language.
      const formSelector = `#organisation-form-${organisationId}`;
      await page.type('#tradingName', 'Fixture Freight');
      await submit(`.languages a[lang="${otherLanguage}"]`);
      await page
        .waitForFunction(() => document.querySelector('#tradingName').value !== '', {
          timeout: 5000,
        })
        .catch(() => undefined);
      await submit(`.languages a[lang="${locale}"]`);
      await page
        .waitForFunction(() => document.querySelector('#tradingName').value !== '', {
          timeout: 5000,
        })
        .catch(() => undefined);
      check(
        'organisation',
        (await page.evaluate(() => document.querySelector('#tradingName').value)) ===
          'Fixture Freight',
        `${locale}: the draft of a change was lost on a language change`,
      );
      await submit(`${formSelector} button[type=submit]`);
      check(
        'organisation',
        page.url() === `${origin}/${locale}/organisations/${organisationId}?done=saved` &&
          (await text('#organisation-confirmation')) === org.saved &&
          ((await text('#organisation-facts')) ?? '').includes('Fixture Freight'),
        `${locale}: saving a change led to ${page.url()}`,
      );
      check(
        'organisation',
        (await apiAs('GET', `/organisations/${organisationId}`)).body.organisation.version === 2 &&
          (await apiAs('GET', `/organisations/${organisationId}/history`)).body.entries.length ===
            2,
        `${locale}: the change or its history entry is missing on the server`,
      );
      await inspect(locale, 'organisation saved');

      // Someone else saves in between (here: the API directly). The form's save is refused,
      // nothing is overwritten, and the current values are shown.
      const elsewhere = await apiAs('PATCH', `/organisations/${organisationId}`, {
        legalName: `${legalName} 2`,
        tradingName: 'Changed elsewhere',
        countryCode: 'XA',
        registrationNumber,
        version: 2,
      });
      await page.type('#contactName', 'Overwrite attempt');
      await submit(`${formSelector} button[type=submit]`);
      check(
        'organisation',
        elsewhere.status === 200 &&
          page.url() ===
            `${origin}/${locale}/organisations/${organisationId}?error=organisation_changed` &&
          ((await text('#error-summary')) ?? '').includes(org.errors.organisation_changed) &&
          (await focusedId()) === 'error-summary',
        `${locale}: a stale save led to ${page.url()}`,
      );
      const afterStale = (await apiAs('GET', `/organisations/${organisationId}`)).body.organisation;
      check(
        'organisation',
        afterStale.tradingName === 'Changed elsewhere' &&
          afterStale.contactName === null &&
          afterStale.version === 3 &&
          (await page.evaluate(() => document.querySelector('#tradingName').value)) ===
            'Changed elsewhere' &&
          (await page.evaluate(() => document.querySelector('#contactName').value)) === '',
        `${locale}: a stale save overwrote the other change, or old values are shown`,
      );
      await inspect(locale, 'organisation changed elsewhere');

      // Stored, not simulated: the list shows it after a fresh load.
      await open(`/${locale}/organisations`, 390);
      check(
        'organisation',
        (await page.evaluate(() => document.querySelectorAll('.organisation').length)) === 1 &&
          ((await text('.organisation h2')) ?? '') === `${legalName} 2`,
        `${locale}: the list does not show the one organisation`,
      );
      await inspect(locale, 'organisations');
      people[locale].organisationId = organisationId;

      // ----------------------------------------------------------------------------------
      // Shipment drafts, in this language
      // ----------------------------------------------------------------------------------
      const ship = messagesFor(locale).ship;
      const shipBase = `/organisations/${organisationId}`;
      const shipPages = `${origin}/${locale}/organisations/${organisationId}/shipments`;
      // The API directly, as this person: used to look at what is stored and to play the part
      // of a colleague who changes a draft meanwhile.
      const shipApi = async (method, route, body) => {
        const response = await fetch(apiOrigin + shipBase + route, {
          method,
          headers: {
            authorization: `Bearer ${sessionTokenNow}`,
            ...(method === 'GET'
              ? {}
              : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() };
      };
      const storedDraft = async (id) => (await shipApi('GET', `/shipments/${id}`)).body.shipment;
      // What a stored draft holds, in the shape a change is sent in.
      const asInput = (draft) => {
        const place = (value) => ({
          address: value.address,
          countryCode: value.countryCode,
          timeZone: value.timeZone,
          accessNotes: value.accessNotes,
          from: { local: value.from.local },
          until: { local: value.until.local },
        });
        return {
          shipperReference: draft.shipperReference,
          cargoDescription: draft.cargoDescription,
          grossWeightKg: draft.grossWeightKg,
          pieces: draft.pieces,
          packaging: draft.packaging,
          equipmentNeeded: draft.equipmentNeeded,
          pickup: place(draft.pickup),
          delivery: place(draft.delivery),
        };
      };
      const setValue = async (selector, value) => {
        await page.evaluate((s) => (document.querySelector(s).value = ''), selector);
        if (value !== '') await page.type(selector, value);
        else
          await page.evaluate(
            (s) =>
              document.querySelector(s).dispatchEvent(new window.Event('input', { bubbles: true })),
            selector,
          );
      };
      const valueOf = (selector) =>
        page.evaluate((s) => document.querySelector(s)?.value ?? null, selector);
      const waitForValue = (selector, value) =>
        page
          .waitForFunction(
            (s, v) => document.querySelector(s)?.value === v,
            { timeout: 5000 },
            selector,
            value,
          )
          .catch(() => undefined);

      await open(`/${locale}/organisations/${organisationId}`, 390);
      await submit('#open-shipments');
      check(
        'shipment',
        page.url() === shipPages && (await text('#no-shipments')) === ship.none,
        `${locale}: the shipment drafts of a new organisation are at ${page.url()}`,
      );
      await inspect(locale, 'shipments empty');
      await submit('#create-shipment');
      const newForm = `#shipment-new-form-${organisationId}`;
      check('shipment', page.url() === `${shipPages}/new`, `${locale}: new draft is ${page.url()}`);
      await inspect(locale, 'shipment new');

      // Nothing at all is not a draft.
      await submit(`${newForm} button[type=submit]`);
      check(
        'shipment',
        ((await text('#error-summary')) ?? '').includes(ship.errors.empty) &&
          (await focusedId()) === 'error-summary' &&
          (await shipApi('GET', '/shipments?status=all')).body.shipments.length === 0,
        `${locale}: an empty draft form led to ${page.url()}`,
      );
      // Numbers out of bounds are refused by field; what was typed stays.
      const description = {
        en: 'Bottled water on pallets (fictional)',
        ar: 'مياه معبأة على منصات (وهمية)',
        ur: 'پیلٹوں پر بوتل بند پانی (فرضی)',
      }[locale];
      await page.type('#cargoDescription', description);
      await page.type('#grossWeightKg', '0');
      await page.type('#pieces', '1.5');
      await submit(`${newForm} button[type=submit]`);
      await waitForValue('#cargoDescription', description);
      const numberErrors = await page.evaluate(() => ({
        weight: document.querySelector('#grossWeightKg-error')?.textContent ?? '',
        pieces: document.querySelector('#pieces-error')?.textContent ?? '',
        invalid: document.querySelector('#grossWeightKg').getAttribute('aria-invalid'),
        links: [...document.querySelectorAll('#error-summary a')].map((a) =>
          a.getAttribute('href'),
        ),
      }));
      check(
        'shipment',
        numberErrors.weight === ship.errors.grossWeightKg &&
          numberErrors.pieces === ship.errors.pieces &&
          numberErrors.invalid === 'true' &&
          numberErrors.links.join(',') === '#grossWeightKg,#pieces' &&
          (await valueOf('#cargoDescription')) === description &&
          (await valueOf('#grossWeightKg')) === '0' &&
          (await shipApi('GET', '/shipments?status=all')).body.shipments.length === 0,
        `${locale}: numbers out of bounds reported ${JSON.stringify(numberErrors)}`,
      );
      await inspect(locale, 'shipment new error');
      // Half a time is asked for whole, before anything is sent.
      await setValue('#grossWeightKg', '1250.50');
      await setValue('#pieces', '12');
      await page.type('#pickupFromDate', '2026-07-01');
      await submit(`${newForm} button[type=submit]`);
      check(
        'shipment',
        ((await text('#pickupFromDate-error')) ?? '') === ship.errors.time_incomplete,
        `${locale}: a date without a time was not asked for whole`,
      );
      await waitForValue('#pickupFromDate', '2026-07-01');

      const reference = `SHP-${stamp}-${index}`;
      await page.type('#shipperReference', reference);
      await page.type('#pickupAddress', 'Gate 3, Example Depot');
      await page.select('#pickupCountry', 'XA');
      await page.select('#pickupZone', 'Etc/GMT-4');
      await page.type('#pickupFromTime', '09:00');
      await page.type('#pickupUntilDate', '2026-07-01');
      await page.type('#pickupUntilTime', '12:30');
      await page.select('#deliveryCountry', 'XB');
      await page.select('#deliveryZone', 'Etc/GMT-3');
      await page.type('#deliveryFromDate', '2026-07-01');
      await page.type('#deliveryFromTime', '11:45');
      // The draft survives a change of language and back.
      await submit(`.languages a[lang="${otherLanguage}"]`);
      await waitForValue('#shipperReference', reference);
      await submit(`.languages a[lang="${locale}"]`);
      await waitForValue('#shipperReference', reference);
      check(
        'shipment',
        (await valueOf('#shipperReference')) === reference &&
          (await valueOf('#pickupZone')) === 'Etc/GMT-4' &&
          (await valueOf('#deliveryFromTime')) === '11:45',
        `${locale}: the shipment draft was lost on a language change`,
      );
      await submit(`${newForm} button[type=submit]`);
      const shipmentId = /\/shipments\/([0-9a-f-]{36})\?done=created$/.exec(page.url())?.[1];
      const first = shipmentId ? await storedDraft(shipmentId) : undefined;
      check(
        'shipment',
        Boolean(shipmentId) &&
          (await text('#shipment-confirmation')) === ship.createdDone &&
          ((await text('#shipment-status')) ?? '').includes(ship.statusDraft) &&
          ((await text('#shipment-status')) ?? '').includes(ship.draftNotice),
        `${locale}: saving a draft led to ${page.url()}`,
      );
      check(
        'shipment',
        first?.status === 'draft' &&
          first.version === 1 &&
          first.cargoDescription === description &&
          first.grossWeightKg === '1250.5' &&
          first.pieces === 12 &&
          first.pickup.from.at === '2026-07-01T05:00:00.000Z' &&
          first.pickup.until.at === '2026-07-01T08:30:00.000Z' &&
          first.delivery.from.at === '2026-07-01T08:45:00.000Z' &&
          first.delivery.until.local === null,
        `${locale}: the stored draft is ${JSON.stringify(first)}`,
      );
      // The route is open in the fictional configuration, and says that this is all it means.
      const routeText = (await text('#shipment-route')) ?? '';
      check(
        'shipment',
        (await page.evaluate(() => document.querySelector('#shipment-route').dataset.route)) ===
          'open' &&
          routeText.includes(ship.routeOpen) &&
          routeText.includes(ship.routeBasis),
        `${locale}: the route of an open lane reads "${routeText}"`,
      );
      await inspect(locale, 'shipment');

      // Change it: a destination with no open route. The draft is saved all the same.
      const editForm = `#shipment-form-${shipmentId}`;
      await page.select('#deliveryCountry', 'XD');
      await page.select('#deliveryZone', 'Etc/GMT-5');
      await submit(`${editForm} button[type=submit]`);
      const closedText = (await text('#shipment-route')) ?? '';
      check(
        'shipment',
        page.url() === `${shipPages}/${shipmentId}?done=saved` &&
          (await text('#shipment-confirmation')) === ship.savedDone &&
          closedText.includes(ship.routeClosed) &&
          closedText.includes(ship.reasonLaneClosed) &&
          closedText.includes(ship.routeDraftSaved) &&
          (await storedDraft(shipmentId)).version === 2 &&
          (await storedDraft(shipmentId)).delivery.countryCode === 'XD',
        `${locale}: a change to a closed route led to ${page.url()}: "${closedText}"`,
      );
      await inspect(locale, 'shipment route closed');

      // A colleague saves in between. This person's save is refused, nothing is overwritten,
      // and what they typed is still in the form.
      const colleague = async (version, cargoDescription) =>
        shipApi('PATCH', `/shipments/${shipmentId}`, {
          ...asInput(await storedDraft(shipmentId)),
          cargoDescription,
          version,
        });
      const meanwhile = await colleague(2, 'Changed elsewhere');
      await page.type('#packaging', 'Wooden crates');
      await submit(`${editForm} button[type=submit]`);
      await waitForValue('#packaging', 'Wooden crates');
      const afterConflict = await storedDraft(shipmentId);
      check(
        'shipment conflict',
        meanwhile.status === 200 &&
          page.url() === `${shipPages}/${shipmentId}?error=shipment_changed&base=2` &&
          ((await text('#error-summary')) ?? '').includes(ship.errors.shipment_changed) &&
          ((await text('#shipment-conflict')) ?? '').includes(ship.conflictTitle),
        `${locale}: a stale save led to ${page.url()}`,
      );
      check(
        'shipment conflict',
        afterConflict.version === 3 &&
          afterConflict.packaging === null &&
          afterConflict.cargoDescription === 'Changed elsewhere' &&
          ((await text('#shipment-facts')) ?? '').includes('Changed elsewhere') &&
          (await valueOf('#packaging')) === 'Wooden crates' &&
          (await valueOf('#cargoDescription')) === description &&
          (await valueOf(`${editForm} input[name=version]`)) === '3',
        `${locale}: after a stale save the draft is ${JSON.stringify(afterConflict)}, the form holds "${await valueOf('#packaging')}"`,
      );
      await inspect(locale, 'shipment conflict');
      // Dropping one's own changes shows the saved draft.
      await submit('#drop-changes');
      await waitForValue('#cargoDescription', 'Changed elsewhere');
      check(
        'shipment conflict',
        (await valueOf('#cargoDescription')) === 'Changed elsewhere' &&
          (await valueOf('#packaging')) === '' &&
          (await text('#shipment-conflict')) === null,
        `${locale}: dropping changes left "${await valueOf('#cargoDescription')}" in the form`,
      );
      // Again, and this time the person wants their version kept. In a conflict the ordinary
      // save is gone: only the action that says it overwrites is offered.
      await colleague(3, 'Changed again');
      await page.type('#packaging', 'Wooden crates');
      await submit(`${editForm} button[type=submit]`);
      await waitForValue('#packaging', 'Wooden crates');
      const offered = await page.evaluate(
        (form) => ({
          buttons: [...document.querySelectorAll(`${form} button[type=submit]`)].map((b) => b.id),
          label: document.querySelector('#overwrite-shipment')?.textContent ?? '',
          warning: document.querySelector('#shipment-conflict')?.textContent ?? '',
        }),
        editForm,
      );
      check(
        'shipment conflict',
        offered.buttons.join(',') === 'overwrite-shipment' &&
          offered.label === ship.overwrite &&
          offered.warning.includes(ship.conflictKeep),
        `${locale}: a conflict offers ${JSON.stringify(offered.buttons)} labelled "${offered.label}"`,
      );
      // A colleague saves once more before the overwrite is pressed: the version check still
      // holds, nothing is saved, and the person is asked again with their input kept.
      await colleague(4, 'Changed a third time');
      await submit('#overwrite-shipment');
      await waitForValue('#packaging', 'Wooden crates');
      const notOverwritten = await storedDraft(shipmentId);
      check(
        'shipment conflict',
        page.url() === `${shipPages}/${shipmentId}?error=shipment_changed&base=4` &&
          notOverwritten.version === 5 &&
          notOverwritten.packaging === null &&
          notOverwritten.cargoDescription === 'Changed a third time' &&
          (await valueOf('#packaging')) === 'Wooden crates' &&
          (await valueOf(`${editForm} input[name=version]`)) === '5',
        `${locale}: an overwrite after another save led to ${page.url()}: ${JSON.stringify(notOverwritten)}`,
      );
      // Coming back to the page later, the carried-over input is still there. The ordinary
      // save does not overwrite: it is refused and the explicit choice is asked for.
      await open(`/${locale}/organisations/${organisationId}/shipments/${shipmentId}`, 390);
      await waitForValue('#packaging', 'Wooden crates');
      await submit('#save-shipment');
      await waitForValue('#packaging', 'Wooden crates');
      check(
        'shipment conflict',
        page.url() === `${shipPages}/${shipmentId}?error=overwrite_not_chosen&base=4` &&
          ((await text('#error-summary')) ?? '').includes(ship.errors.overwrite_not_chosen) &&
          (await page.evaluate(() => document.querySelector('#save-shipment'))) === null &&
          (await storedDraft(shipmentId)).version === 5 &&
          (await storedDraft(shipmentId)).packaging === null,
        `${locale}: an ordinary save of carried-over input led to ${page.url()}`,
      );
      await inspect(locale, 'shipment overwrite');
      await submit('#overwrite-shipment');
      const savedOver = await storedDraft(shipmentId);
      check(
        'shipment conflict',
        page.url() === `${shipPages}/${shipmentId}?done=saved` &&
          savedOver.version === 6 &&
          savedOver.packaging === 'Wooden crates' &&
          savedOver.cargoDescription === 'Changed elsewhere' &&
          (await valueOf(`${editForm} input[name=carriedFrom]`)) === '' &&
          (await page.evaluate(() => document.querySelector('#overwrite-shipment'))) === null,
        `${locale}: the explicit overwrite led to ${page.url()}: ${JSON.stringify(savedOver)}`,
      );

      // A time that occurs twice (the clocks go back) must be chosen; neither is assumed.
      await page.select('#pickupZone', 'America/New_York');
      await setValue('#pickupFromDate', '2026-11-01');
      await setValue('#pickupFromTime', '01:30');
      await setValue('#pickupUntilDate', '2026-11-01');
      await setValue('#pickupUntilTime', '05:00');
      await setValue('#deliveryFromDate', '2026-11-02');
      await submit(`${editForm} button[type=submit]`);
      await waitForValue('#pickupFromTime', '01:30');
      const offsetOptions = await page.evaluate(() =>
        [...(document.querySelector('#pickupFromOffset')?.options ?? [])].map((o) => o.value),
      );
      check(
        'shipment time',
        page
          .url()
          .startsWith(
            `${shipPages}/${shipmentId}?error=pickup.from%3Atime_ambiguous%3A-240%3A-300`,
          ) &&
          ((await text('#pickupFromDate-error')) ?? '') === ship.errors.time_ambiguous &&
          offsetOptions.join(',') === ',-240,-300' &&
          (await valueOf('#pickupFromOffset')) === '' &&
          (await storedDraft(shipmentId)).version === 6,
        `${locale}: an ambiguous time led to ${page.url()} with choices [${offsetOptions}]`,
      );
      await inspect(locale, 'shipment ambiguous time');
      await page.select('#pickupFromOffset', '-300');
      await submit(`${editForm} button[type=submit]`);
      const chosen = await storedDraft(shipmentId);
      check(
        'shipment time',
        page.url() === `${shipPages}/${shipmentId}?done=saved` &&
          chosen.pickup.from.at === '2026-11-01T06:30:00.000Z' &&
          chosen.pickup.from.offsetMinutes === -300 &&
          (await valueOf('#pickupFromOffset')) === '-300',
        `${locale}: the chosen later time was stored as ${JSON.stringify(chosen.pickup.from)}`,
      );
      // A time the clocks skip does not exist and is refused.
      await setValue('#pickupFromDate', '2026-03-08');
      await setValue('#pickupFromTime', '02:30');
      await setValue('#pickupUntilDate', '2026-03-08');
      await setValue('#pickupUntilTime', '05:00');
      await setValue('#deliveryFromDate', '2026-03-09');
      await submit(`${editForm} button[type=submit]`);
      check(
        'shipment time',
        ((await text('#pickupFromDate-error')) ?? '') === ship.errors.time_does_not_exist &&
          (await storedDraft(shipmentId)).version === 7,
        `${locale}: a time that does not exist led to ${page.url()}`,
      );
      // Leave the test zone, so that it can be removed when the checks end.
      await shipApi('PATCH', `/shipments/${shipmentId}`, {
        ...asInput(chosen),
        pickup: { ...asInput(chosen).pickup, timeZone: 'Etc/GMT-4' },
        version: 7,
      });

      // Paging: newest created first, two to a page here; a change does not move a draft.
      const extra = [];
      for (const number of [1, 2, 3]) {
        const made = await shipApi('POST', '/shipments', {
          shipperReference: `EXTRA-${stamp}-${index}-${number}`,
        });
        extra.push(made.body.shipment.id);
      }
      const idsOnPage = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('#shipment-list [data-shipment]')].map(
            (item) => item.dataset.shipment,
          ),
        );
      await open(`/${locale}/organisations/${organisationId}/shipments`, 390);
      const pageOne = await idsOnPage();
      check(
        'shipment list',
        pageOne.join(',') === `${extra[2]},${extra[1]}` &&
          ((await text('#shipment-list h2')) ?? '') === `EXTRA-${stamp}-${index}-3`,
        `${locale}: the first page holds ${pageOne}`,
      );
      await inspect(locale, 'shipments');
      // Between the pages the oldest draft is changed and a new one is added.
      await shipApi('PATCH', `/shipments/${shipmentId}`, {
        ...asInput(await storedDraft(shipmentId)),
        packaging: 'Changed between pages',
        version: 8,
      });
      const late = (await shipApi('POST', '/shipments', { shipperReference: `LATE-${stamp}` })).body
        .shipment.id;
      await submit('#older-shipments');
      const pageTwo = await idsOnPage();
      check(
        'shipment list',
        pageTwo.join(',') === `${extra[0]},${shipmentId}` &&
          (await page.evaluate(() => document.querySelector('#older-shipments'))) === null,
        `${locale}: the second page holds ${pageTwo}`,
      );
      await submit('#newest-shipments');
      check(
        'shipment list',
        (await idsOnPage()).join(',') === `${late},${extra[2]}`,
        `${locale}: a new walk does not start with the newest draft`,
      );

      // Discard: the record and its history stay, the draft leaves the open list.
      await open(`/${locale}/organisations/${organisationId}/shipments/${late}`, 390);
      await submit('#discard-shipment');
      const discarded = await storedDraft(late);
      check(
        'shipment discard',
        page.url() === `${shipPages}/${late}?done=discarded` &&
          (await text('#shipment-confirmation')) === ship.discardedDone &&
          ((await text('#shipment-status')) ?? '').includes(ship.discardedNotice) &&
          (await page.evaluate(() => document.querySelector('form'))) === null &&
          discarded.status === 'discarded' &&
          discarded.version === 2 &&
          (await shipApi('GET', `/shipments/${late}/history`)).body.entries.length === 2,
        `${locale}: discarding led to ${page.url()}: ${JSON.stringify(discarded)}`,
      );
      await inspect(locale, 'shipment discarded');
      await open(`/${locale}/organisations/${organisationId}/shipments?status=discarded`, 390);
      check(
        'shipment discard',
        (await idsOnPage()).join(',') === late &&
          (await shipApi('GET', '/shipments')).body.shipments.every((entry) => entry.id !== late),
        `${locale}: the discarded draft is not listed as discarded only`,
      );
      people[locale].shipmentId = shipmentId;
      await open(`/${locale}/account`, 390);
      // Sign out before the next language, so each run starts as a visitor. The last stays signed in.
      if (index < locales.length - 1) {
        const plainToken = (await browser.cookies()).find(
          (cookie) => cookie.name === 'trucker_session',
        )?.value;
        await submit('#sign-out');
        check(
          'revocation',
          page.url() === `${origin}/${locale}/sign-in?done=signed_out` &&
            (await text('#signed-out-confirmed')) === messagesFor(locale).auth.account.signedOut &&
            (await apiSaysToken(plainToken)) === 401,
          `${locale}: a plain sign-out led to ${page.url()} or the API still accepts the token`,
        );
      }
    }

    // Stored, not simulated: still signed in after a reload, and the name comes from the database.
    await page.reload({ waitUntil: 'networkidle0' });
    check(
      'journey',
      page.url().startsWith(`${origin}/ur/account`) &&
        (await text('.facts bdi')) === people.ur.name,
      'after a reload the account is not shown',
    );

    // The session token is not readable by page scripts and nothing secret is in an address.
    const cookies = await browser.cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === 'trucker_session');
    check(
      'journey security',
      Boolean(sessionCookie?.httpOnly) && sessionCookie?.sameSite === 'Lax',
      'the session cookie is not HttpOnly and SameSite=Lax',
    );
    check(
      'journey security',
      !(await page.evaluate(() => document.cookie)).includes('trucker_session'),
      'page scripts can read the session cookie',
    );
    check(
      'journey security',
      !cookies.some((cookie) => cookie.name === 'trucker_sign_in'),
      'the sign-in progress cookie was not removed after sign-in',
    );
    check(
      'journey security',
      !apiLog.includes(people.ur.phone.slice(1)) &&
        !/[^0-9][0-9]{6}[^0-9]/.test(
          apiLog
            .replace(/"time":"[^"]*"/g, '')
            .replace(/"requestId":"[^"]*"/g, '')
            // Organisation identifiers appear in paths; they are random, not secrets.
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ''),
        ),
      'the API log contains a number or a code',
    );

    // A second browser signs in as the same person; ending that session from the first stops it.
    // The same number may not ask for a code again until the resend wait (10 s here) has passed.
    await new Promise((resolve) => setTimeout(resolve, 10_500));
    const secondContext = await browser.createBrowserContext();
    const second = await secondContext.newPage();
    await second.setViewport({ width: 390, height: 900 });
    await second.goto(`${origin}/en/sign-in`, { waitUntil: 'networkidle0' });
    await second.type('#phone', people.ur.phone);
    await Promise.all([
      second.waitForNavigation({ waitUntil: 'networkidle0' }),
      second.click('#sign-in-form button[type=submit]'),
    ]);
    const secondCode = await second.evaluate(
      () => document.querySelector('.notice-development .ltr')?.textContent ?? '',
    );
    await second.type('#code', secondCode);
    await Promise.all([
      second.waitForNavigation({ waitUntil: 'networkidle0' }),
      second.click('form.card button.button-primary'),
    ]);
    check(
      'journey sessions',
      second.url() === `${origin}/en/account`,
      `a returning person was sent to ${second.url()}`,
    );

    const tokenOf = async (context) =>
      (await context.cookies()).find((cookie) => cookie.name === 'trucker_session')?.value;
    const secondToken = await tokenOf(secondContext);
    check(
      'revocation',
      (await apiSaysToken(secondToken)) === 200,
      'the second session is not accepted by the API before it is ended',
    );
    await page.reload({ waitUntil: 'networkidle0' });
    check(
      'journey sessions',
      (await page.evaluate(() => document.querySelectorAll('.session').length)) === 2,
      'the first browser does not list two sessions',
    );
    await submit('.session form button');
    check(
      'journey sessions',
      (await page.evaluate(() => document.querySelectorAll('.session').length)) === 1,
      'the other session is still listed after ending it',
    );
    check(
      'revocation',
      page.url() === `${origin}/ur/account?done=session_ended` &&
        (await text('#account-confirmation')) === messagesFor('ur').auth.account.sessionEnded,
      `ending a session led to ${page.url()} without the confirmation`,
    );
    check(
      'revocation',
      (await apiSaysToken(secondToken)) === 401,
      'the API still accepts a session after the web application confirmed it ended',
    );
    await second.goto(`${origin}/en/account`, { waitUntil: 'networkidle0' });
    check(
      'journey sessions',
      second.url() === `${origin}/en/sign-in?error=session_ended`,
      `the ended session still opened ${second.url()}`,
    );
    check(
      'journey sessions',
      (
        await second.evaluate(() => document.querySelector('#error-summary')?.textContent ?? '')
      ).includes('session has ended'),
      'the ended session is not explained',
    );
    await secondContext.close();

    // ------------------------------------------------------------------------------------
    // Organisations: another person's organisation, and answers lost on the way back
    // ------------------------------------------------------------------------------------
    const urOrg = messagesFor('ur').org;
    const urToken = await tokenOf(browser.defaultBrowserContext());
    const urApi = async (route) => {
      const response = await fetch(apiOrigin + route, {
        headers: { authorization: `Bearer ${urToken}` },
      });
      return { status: response.status, body: await response.json() };
    };
    // Another person's organisation answers exactly like one that does not exist.
    const theirs = await open(`/ur/organisations/${people.en.organisationId}`, 390);
    const nothing = await open('/ur/organisations/00000000-0000-4000-8000-000000000000', 390);
    check(
      'organisation',
      theirs.status() === 404 &&
        nothing.status() === 404 &&
        !(await page.content()).includes('Fixture Freight Company'),
      `another person's organisation answered ${theirs.status()}, a missing one ${nothing.status()}`,
    );
    check(
      'organisation',
      (await urApi(`/organisations/${people.en.organisationId}`)).status === 404 &&
        (await urApi('/organisations')).body.organisations.length === 1,
      'the API shows another person an organisation that is not theirs',
    );

    // Creating: the server creates the organisation, the answer is lost.
    await open('/ur/organisations/new', 390);
    await page.type('#legalName', 'ادارہ جس کا جواب گم ہوا (فرضی)');
    await page.select('#countryCode', 'XB');
    await page.type('#registrationNumber', `LOST-${stamp}`);
    relay.mode = 'lose';
    await submit('#organisation-new-form button[type=submit]');
    const afterLostCreate = (await urApi('/organisations')).body.organisations;
    check(
      'lost answer',
      relay.lost.length === 1 &&
        relay.lost[0] === 'POST /organisations -> 201' &&
        afterLostCreate.length === 2,
      `the organisation whose answer was lost was not created on the server: ${relay.lost}`,
    );
    const lostCreate = (await text('#error-summary')) ?? '';
    const retryKeyShown = new URL(page.url()).searchParams.get('retry');
    check(
      'lost answer',
      page.url().startsWith(`${origin}/ur/organisations/new?error=create_unconfirmed`) &&
        lostCreate.includes(urOrg.errors.create_unconfirmed) &&
        (await page.evaluate(() => document.getElementById('organisation-confirmation'))) === null,
      `a lost create answer led to ${page.url()} without the uncertain message`,
    );
    await inspect('ur', 'organisation unconfirmed');
    relay.mode = 'pass';
    // Trying again with the same details and the same key makes no second organisation.
    await submit('#retry-organisations');
    await page
      .waitForFunction(() => document.querySelector('#legalName')?.value !== '', { timeout: 5000 })
      .catch(() => undefined);
    check(
      'lost answer',
      (await page.evaluate(() => document.querySelector('input[name=retryKey]')?.value)) ===
        retryKeyShown &&
        (await page.evaluate(() => document.querySelector('#registrationNumber')?.value)) ===
          `LOST-${stamp}`,
      'after a lost answer the form did not come back with the same retry key and details',
    );
    await submit('#organisation-new-form button[type=submit]');
    const lostId = /\/organisations\/([0-9a-f-]{36})\?done=created$/.exec(page.url())?.[1];
    const afterRetry = (await urApi('/organisations')).body.organisations;
    check(
      'lost answer',
      Boolean(lostId) &&
        afterRetry.length === 2 &&
        afterRetry.some((organisation) => organisation.id === lostId) &&
        afterLostCreate.some((organisation) => organisation.id === lostId),
      `the retry made a second organisation, or led to ${page.url()}`,
    );

    // Saving a change: the server saves it, the answer is lost.
    await page.evaluate(() => (document.querySelector('#legalName').value = ''));
    await page.type('#legalName', 'نیا نام (فرضی)');
    relay.mode = 'lose';
    await submit(`#organisation-form-${lostId} button[type=submit]`);
    const savedOnServer = (await urApi(`/organisations/${lostId}`)).body.organisation;
    check(
      'lost answer',
      relay.lost.length === 2 &&
        relay.lost[1] === `PATCH /organisations/${lostId} -> 200` &&
        savedOnServer.legalName === 'نیا نام (فرضی)' &&
        savedOnServer.version === 2,
      `the change whose answer was lost was not saved on the server: ${relay.lost}`,
    );
    check(
      'lost answer',
      page.url() === `${origin}/ur/organisations/${lostId}?error=save_unconfirmed` &&
        ((await text('#error-summary')) ?? '').includes(urOrg.errors.save_unconfirmed),
      `a lost save answer led to ${page.url()} without the uncertain message`,
    );
    relay.mode = 'pass';
    await submit('#retry-organisations');
    check(
      'lost answer',
      page.url() === `${origin}/ur/organisations/${lostId}` &&
        (await text('h1')) === 'نیا نام (فرضی)' &&
        (await text('#error-summary')) === null &&
        (await page.evaluate(() => document.querySelector('input[name=version]').value)) === '2',
      `after the connection returned the page does not show the saved state: ${page.url()}`,
    );
    relay.lost.length = 0;

    // ------------------------------------------------------------------------------------
    // Shipment drafts: another organisation's drafts, and answers lost on the way back
    // ------------------------------------------------------------------------------------
    const urShip = messagesFor('ur').ship;
    const urOrgId = people.ur.organisationId;
    const urShipPages = `${origin}/ur/organisations/${urOrgId}/shipments`;
    const theirDrafts = await open(`/ur/organisations/${people.en.organisationId}/shipments`, 390);
    const theirDraft = await open(
      `/ur/organisations/${urOrgId}/shipments/${people.en.shipmentId}`,
      390,
    );
    check(
      'shipment',
      theirDrafts.status() === 404 &&
        theirDraft.status() === 404 &&
        (await urApi(`/organisations/${people.en.organisationId}/shipments`)).status === 404 &&
        (await urApi(`/organisations/${urOrgId}/shipments/${people.en.shipmentId}`)).status === 404,
      `another organisation's drafts answered ${theirDrafts.status()} and ${theirDraft.status()}`,
    );
    // Every draft of the organisation, walking the pages to the end.
    const urDrafts = async () => {
      const all = [];
      let after = '';
      do {
        const body = (
          await urApi(`/organisations/${urOrgId}/shipments?status=all${after && `&after=${after}`}`)
        ).body;
        all.push(...body.shipments);
        after = body.nextAfter ?? '';
      } while (after);
      return all;
    };
    const draftsBefore = (await urDrafts()).length;
    const historyOf = async (id) =>
      (await urApi(`/organisations/${urOrgId}/shipments/${id}/history`)).body.entries;

    // Saving a new draft: the server saves it, the answer is lost.
    await open(`/ur/organisations/${urOrgId}/shipments/new`, 390);
    await page.type('#cargoDescription', 'مسودہ جس کا جواب گم ہوا (فرضی)');
    relay.mode = 'lose';
    await submit(`#shipment-new-form-${urOrgId} button[type=submit]`);
    const shipRetryKey = new URL(page.url()).searchParams.get('retry');
    check(
      'shipment lost answer',
      relay.lost[0] === `POST /organisations/${urOrgId}/shipments -> 201` &&
        (await urDrafts()).length === draftsBefore + 1 &&
        page.url().startsWith(`${urShipPages}/new?error=create_unconfirmed`) &&
        ((await text('#error-summary')) ?? '').includes(urShip.errors.create_unconfirmed) &&
        (await page.evaluate(() => document.getElementById('shipment-confirmation'))) === null,
      `a lost answer to a new draft led to ${page.url()}: ${relay.lost}`,
    );
    relay.mode = 'pass';
    await submit('#retry-shipments');
    await page
      .waitForFunction(() => document.querySelector('#cargoDescription')?.value !== '', {
        timeout: 5000,
      })
      .catch(() => undefined);
    check(
      'shipment lost answer',
      (await page.evaluate(() => document.querySelector('input[name=retryKey]')?.value)) ===
        shipRetryKey,
      'after a lost answer the draft form did not come back with the same retry key',
    );
    await submit(`#shipment-new-form-${urOrgId} button[type=submit]`);
    const lostDraft = /\/shipments\/([0-9a-f-]{36})\?done=created$/.exec(page.url())?.[1];
    check(
      'shipment lost answer',
      Boolean(lostDraft) &&
        (await urDrafts()).length === draftsBefore + 1 &&
        (await historyOf(lostDraft)).length === 1,
      `sending the same draft again made a second one, or led to ${page.url()}`,
    );

    // Changing it: the server saves the change, the answer is lost. Asking again with the same
    // key is recognised as the same change and saves nothing twice.
    await page.type('#packaging', 'گتے کے ڈبے');
    relay.mode = 'lose';
    await submit(`#shipment-form-${lostDraft} button[type=submit]`);
    const changeKey = new URL(page.url()).searchParams.get('retry');
    check(
      'shipment lost answer',
      relay.lost[1] === `PATCH /organisations/${urOrgId}/shipments/${lostDraft} -> 200` &&
        page.url().startsWith(`${urShipPages}/${lostDraft}?error=save_unconfirmed`) &&
        ((await text('#error-summary')) ?? '').includes(urShip.errors.save_unconfirmed) &&
        (await historyOf(lostDraft)).length === 2,
      `a lost answer to a change led to ${page.url()}: ${relay.lost}`,
    );
    relay.mode = 'pass';
    await submit('#retry-shipments');
    check(
      'shipment lost answer',
      (await page.evaluate(() => document.querySelector('input[name=retryKey]')?.value)) ===
        changeKey &&
        (await page.evaluate(() => document.querySelector('#packaging')?.value)) === 'گتے کے ڈبے' &&
        (await page.evaluate(() => document.querySelector('input[name=version]')?.value)) === '2',
      'after a lost answer the change form did not come back with its key and the saved state',
    );
    await submit(`#shipment-form-${lostDraft} button[type=submit]`);
    check(
      'shipment lost answer',
      page.url() === `${urShipPages}/${lostDraft}?done=already` &&
        (await text('#shipment-confirmation')) === urShip.alreadyDone &&
        (await historyOf(lostDraft)).length === 2 &&
        (await urApi(`/organisations/${urOrgId}/shipments/${lostDraft}`)).body.shipment.version ===
          2,
      `asking for the same change again led to ${page.url()}`,
    );

    // Discarding it: the server discards, the answer is lost. Asking again discards nothing twice.
    relay.mode = 'lose';
    await submit('#discard-shipment');
    check(
      'shipment lost answer',
      relay.lost[2] === `POST /organisations/${urOrgId}/shipments/${lostDraft}/discard -> 200` &&
        page.url().startsWith(`${urShipPages}/${lostDraft}?error=discard_unconfirmed`) &&
        ((await text('#error-summary')) ?? '').includes(urShip.errors.discard_unconfirmed),
      `a lost answer to a discard led to ${page.url()}: ${relay.lost}`,
    );
    relay.mode = 'pass';
    await submit('#retry-shipments');
    const again = await fetch(
      `${apiOrigin}/organisations/${urOrgId}/shipments/${lostDraft}/discard`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${urToken}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({ version: 2 }),
      },
    );
    check(
      'shipment lost answer',
      ((await text('#shipment-status')) ?? '').includes(urShip.discardedNotice) &&
        (await page.evaluate(() => document.querySelector('form'))) === null &&
        again.status === 200 &&
        (await again.json()).outcome === 'already_discarded' &&
        (await historyOf(lostDraft)).length === 3,
      `after a lost discard the page is ${page.url()}, a second discard answered ${again.status}`,
    );
    relay.lost.length = 0;
    await open('/ur/account', 390);

    // ------------------------------------------------------------------------------------
    // Organisation verification: submit, lose an answer, withdraw, correct, amend
    // ------------------------------------------------------------------------------------
    // The applicant's side is driven in the browser. Staff decide through the staff API with a
    // test staff account and session put in place by the migration role; the console's own
    // checks drive the staff screens.
    const verifyOrg = (
      await (
        await fetch(`${apiOrigin}/organisations`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${urToken}`,
            'content-type': 'application/json',
            'idempotency-key': `verify-${stamp}-organisation`,
          },
          body: JSON.stringify({
            legalName: 'Verification Fixture Company (fictional)',
            countryCode: 'XA',
            registrationNumber: `VER-${stamp}`,
          }),
        })
      ).json()
    ).organisation.id;
    const reviewerToken = `${randomBytes(16).toString('hex')}.${randomBytes(16).toString('hex')}`;
    const reviewerId = (
      await owner.query(
        `INSERT INTO trucker.staff_account
           (email, display_name, status, enrolled_at, password_hash, totp_secret, participant_link,
            created_at, updated_at)
         VALUES ($1, 'Browser Test Reviewer', 'active', now(), 'not-a-real-hash', '\\x00',
                 'declared_none', now(), now())
         RETURNING id`,
        [`reviewer-${stamp}@example.test`],
      )
    ).rows[0].id;
    await owner.query(
      `INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at)
       VALUES ($1, 'reviewer', NULL, now())`,
      [reviewerId],
    );
    await owner.query(
      `INSERT INTO trucker.staff_session (id, staff_id, token_hash, created_at, last_used_at, absolute_expires_at)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 hour')`,
      [reviewerId, createHash('sha256').update(reviewerToken).digest('hex')],
    );
    const overviewOf = async () =>
      (await urApi(`/organisations/${verifyOrg}/verification`)).body.verification;
    const decideAs = async (decision, reason, note = null) => {
      const overview = await overviewOf();
      const response = await fetch(
        `${apiOrigin}/staff/verification/${overview.applications[0].id}/decision`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${reviewerToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ version: 1, decision, reason, note, noConflict: true }),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    const verifyPath = (locale) => `/${locale}/organisations/${verifyOrg}/verification`;
    const statusOf = () =>
      page.evaluate(() => document.querySelector('#verification-status')?.dataset.status ?? null);
    const versionsShown = () =>
      page.evaluate(() => document.querySelectorAll('#versions > li').length);
    const everyLocale = async (state) => {
      for (const locale of locales) {
        await open(verifyPath(locale), 390);
        await inspect(locale, state);
      }
    };
    const urVerify = messagesFor('ur').verify;

    // From the organisation's page to its verification page.
    await open(`/ur/organisations/${verifyOrg}`, 390);
    await submit('#open-verification');
    check(
      'verification',
      page.url() === `${origin}${verifyPath('ur')}` &&
        (await statusOf()) === 'draft' &&
        ((await text('#demonstration-notice')) ?? '') === urVerify.demoNotice &&
        ((await text('#publication-check')) ?? '').includes(urVerify.publishNo) &&
        (await page.evaluate(() => document.querySelectorAll('fieldset[id^=ev-]').length)) === 3,
      `the verification page is ${page.url()} with status ${await statusOf()}`,
    );
    await everyLocale('verification form');

    // Nothing typed: refused by field, and the summary links to the first field.
    await open(verifyPath('ur'), 390);
    await submit('#submit-verification');
    const summaryLinks = await page.evaluate(() =>
      [...document.querySelectorAll('#error-summary a')].map((a) => a.getAttribute('href')),
    );
    check(
      'verification',
      (await focusedId()) === 'error-summary' &&
        summaryLinks.includes('#ev-registration_certificate-documentNumber') &&
        summaryLinks.includes('#ev-transport_licence-documentNumber') &&
        summaryLinks.includes('#declaration') &&
        !summaryLinks.some((href) => href.includes('tax_certificate')) &&
        (await overviewOf()).applications.length === 0,
      `an empty submission answered with links ${summaryLinks}`,
    );
    await inspect('ur', 'verification errors');

    // Filled in and sent; the server submits it and the answer is lost. The page does not say
    // it was done, and what it shows afterwards is the server's state: one version, submitted.
    await page.type('#ev-registration_certificate-documentNumber', 'REG-0001');
    await page.type('#ev-transport_licence-documentNumber', 'LIC-0002');
    await page.$eval('#ev-registration_certificate-issuedOn', (input) => {
      input.value = '2025-01-15';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await page.click('#declaration');
    relay.lost.length = 0;
    relay.mode = 'lose';
    await submit('#submit-verification');
    check(
      'lost answer',
      relay.lost[0] === `POST /organisations/${verifyOrg}/verification/applications -> 201` &&
        page.url().includes('error=submit_unconfirmed') &&
        (await text('#verification-confirmation')) === null &&
        (await page.evaluate(() =>
          document.querySelector('[data-state=verification-unavailable]'),
        )) !== null,
      `a lost submission answer led to ${page.url()}: ${relay.lost}`,
    );
    relay.mode = 'pass';
    relay.lost.length = 0;
    await submit('#retry-verification');
    // The page keeps no claim of its own: what it shows now is the server's state.
    check(
      'lost answer',
      (await statusOf()) === 'submitted' &&
        (await versionsShown()) === 1 &&
        (await text('#verification-confirmation')) === null &&
        (await page.evaluate(() => document.querySelector('#submit-verification'))) === null &&
        (await overviewOf()).applications.length === 1,
      `after a lost submission the page shows ${await statusOf()} with ${await versionsShown()} versions`,
    );
    await everyLocale('verification submitted');
    // Under review the organisation's details cannot be changed.
    await open(`/ur/organisations/${verifyOrg}`, 390);
    check(
      'verification',
      (await page.evaluate(() => document.querySelector('form[id^=organisation-form]'))) === null &&
        ((await text('#organisation-status')) ?? '').includes(urVerify.status.submitted) &&
        ((await text('#organisation-status')) ?? '').includes(urOrg.lockedNotice),
      'an organisation under review still offers its edit form',
    );

    // Withdrawn: back to a draft, the withdrawn version kept. Then submitted again.
    await open(verifyPath('ur'), 390);
    await submit('#withdraw-application');
    check(
      'verification',
      page.url().includes('done=withdrawn') &&
        (await statusOf()) === 'draft' &&
        (await versionsShown()) === 1 &&
        ((await text('#versions .chip')) ?? '') === urVerify.status.withdrawn,
      `withdrawing led to ${page.url()} with status ${await statusOf()}`,
    );
    // What the withdrawn version said is offered again, so nothing is retyped.
    check(
      'verification',
      (await page.$eval('#ev-registration_certificate-documentNumber', (i) => i.value)) ===
        'REG-0001' &&
        (await page.$eval('#ev-registration_certificate-issuedOn', (i) => i.value)) ===
          '2025-01-15',
      'the earlier entries are not offered again',
    );
    await page.click('#declaration');
    await submit('#submit-verification');
    check(
      'verification',
      page.url().includes('done=submitted') &&
        ((await text('#verification-confirmation')) ?? '') === urVerify.doneSubmitted &&
        (await versionsShown()) === 2,
      `submitting again led to ${page.url()}`,
    );

    // Staff ask for changes, with a note. The applicant sees the reason and the note, in each
    // language, and nothing about who decided.
    const asked = await decideAs(
      'changes_requested',
      'other',
      'The licence number looks incomplete.',
    );
    check('verification', asked.status === 200, `the decision answered ${asked.status}`);
    await everyLocale('verification changes requested');
    await open(verifyPath('ar'), 390);
    const arVerify = messagesFor('ar').verify;
    check(
      'verification',
      (await statusOf()) === 'changes_requested' &&
        ((await text('#decision')) ?? '').includes(arVerify.reasons.other) &&
        ((await text('#decision')) ?? '').includes('The licence number looks incomplete.') &&
        !(await page.content()).includes(reviewerId) &&
        !(await page.content()).includes(`reviewer-${stamp}`),
      'the applicant is not shown the reason and note, or is shown who decided',
    );
    // Corrected and sent as a new version; the earlier ones stay as they were.
    await page.$eval('#ev-transport_licence-documentNumber', (input) => (input.value = ''));
    await page.type('#ev-transport_licence-documentNumber', 'LIC-0002-FULL');
    await page.click('#declaration');
    await submit('#submit-verification');
    const afterCorrection = await overviewOf();
    check(
      'verification',
      afterCorrection.applications.map((item) => `${item.versionNo}:${item.status}`).join() ===
        '3:submitted,2:changes_requested,1:withdrawn' &&
        afterCorrection.applications[0].evidence.some(
          (entry) => entry.documentNumber === 'LIC-0002-FULL',
        ) &&
        afterCorrection.applications[1].evidence.some(
          (entry) => entry.documentNumber === 'LIC-0002',
        ),
      `after the correction the versions are ${JSON.stringify(afterCorrection.applications.map((item) => [item.versionNo, item.status]))}`,
    );

    // Verified. The page says on what basis, and offers only an amendment.
    const accepted = await decideAs('verified', 'evidence_accepted');
    check('verification', accepted.body.outcome === 'decided', JSON.stringify(accepted.body));
    await everyLocale('verification verified');
    await open(verifyPath('en'), 390);
    const enVerify = messagesFor('en').verify;
    check(
      'verification',
      (await statusOf()) === 'verified' &&
        ((await text('#verification-status h3')) ?? '') === enVerify.status.verified &&
        ((await text('#publication-check')) ?? '').includes(enVerify.publishYes) &&
        (await page.$eval('#proposedLegalName', (input) => input.value)) ===
          'Verification Fixture Company (fictional)',
      `a verified organisation's page shows ${await statusOf()}`,
    );
    // An amendment that changes nothing is refused at the field.
    await page.click('#declaration');
    await submit('#submit-verification');
    check(
      'verification',
      (await page.evaluate(() =>
        document.querySelector('#error-summary a')?.getAttribute('href'),
      )) === '#proposedLegalName' &&
        ((await text('#error-summary')) ?? '').includes(enVerify.errors.nothing_changed),
      'an amendment that changes nothing was not refused at the field',
    );
    // The verified identity cannot be changed on the organisation's own page; the rest can.
    await open(`/en/organisations/${verifyOrg}`, 390);
    await page.$eval('#legalName', (input) => (input.value = ''));
    await page.type('#legalName', 'Quietly Renamed (fictional)');
    await submit('form[id^=organisation-form] button[type=submit]');
    const enOrg = messagesFor('en').org;
    check(
      'verification',
      ((await text('#error-summary')) ?? '').includes(enOrg.errors.identity_needs_review) &&
        (await overviewOf()).organisation.legalName === 'Verification Fixture Company (fictional)',
      'a verified legal name was changed without a review',
    );
    await inspect('en', 'verified organisation');
    // Proposed properly: under review, and the approved identity stays in force meanwhile.
    await open(verifyPath('en'), 390);
    await page.$eval('#proposedLegalName', (input) => (input.value = ''));
    await page.type('#proposedLegalName', 'Verification Fixture Renamed (fictional)');
    await page.click('#declaration');
    await submit('#submit-verification');
    const amending = await overviewOf();
    check(
      'verification',
      page.url().includes('done=submitted') &&
        amending.organisation.status === 'verified' &&
        amending.organisation.legalName === 'Verification Fixture Company (fictional)' &&
        amending.applications[0].kind === 'amendment' &&
        amending.mayPublish === true &&
        ((await text('#verification-status')) ?? '').includes(enVerify.next.amendment),
      `after proposing an amendment the organisation is ${amending.organisation.status} named ${amending.organisation.legalName}`,
    );
    await inspect('en', 'verification amendment');

    // Another person's organisation answers exactly like one that does not exist.
    const theirVerification = await open(
      `/ur/organisations/${people.en.organisationId}/verification`,
      390,
    );
    const noVerification = await open(
      '/ur/organisations/00000000-0000-4000-8000-000000000000/verification',
      390,
    );
    check(
      'verification',
      theirVerification.status() === 404 && noVerification.status() === 404,
      `another person's verification page answered ${theirVerification.status()}, a missing one ${noVerification.status()}`,
    );
    // With no answer from the API the page says so and claims nothing.
    relay.mode = 'down';
    await open(verifyPath('ur'), 390);
    check(
      'verification',
      (await page.evaluate(() =>
        document.querySelector('[data-state=verification-unavailable]'),
      )) !== null && ((await text('#error-summary')) ?? '').includes(urVerify.errors.unavailable),
      'with the API unreachable the verification page claims something',
    );
    relay.mode = 'pass';
    await open('/ur/account', 390);

    // ------------------------------------------------------------------------------------
    // Shipment publication: publish, preview, change, lose an answer, expire, withdraw, copy
    // ------------------------------------------------------------------------------------
    // The verified organisation from the verification checks publishes. No carrier can read
    // anything: the preview is the shipper's only. Times are made from the real clock, in the
    // fictional zones (XA is UTC+4, XB is UTC+3).
    const zoned = (hours, offsetHours) =>
      new Date(Date.now() + (hours + offsetHours) * 3_600_000).toISOString().slice(0, 16);
    const makeShipment = async (name, org = verifyOrg) =>
      (
        await (
          await fetch(`${apiOrigin}/organisations/${org}/shipments`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${urToken}`,
              'content-type': 'application/json',
              'idempotency-key': `${name}-${stamp}-draft`,
            },
            body: JSON.stringify({
              shipperReference: `${name.toUpperCase()}-${stamp}`,
              cargoDescription: 'Ceramic tiles in crates (fictional)',
              grossWeightKg: '12000',
              pieces: '24',
              packaging: 'Wooden crates',
              pickup: {
                address: 'Warehouse 9, Private Street',
                countryCode: 'XA',
                timeZone: 'Etc/GMT-4',
                accessNotes: 'Gate code 5512',
                from: { local: zoned(48, 4) },
                until: { local: zoned(50, 4) },
              },
              delivery: {
                address: 'Depot 3, Hidden Road',
                countryCode: 'XB',
                timeZone: 'Etc/GMT-3',
                from: { local: zoned(54, 3) },
                until: { local: zoned(58, 3) },
              },
            }),
          })
        ).json()
      ).shipment.id;
    const pubShipment = await makeShipment('pub');
    const shipmentPath = (locale, shipment = pubShipment) =>
      `/${locale}/organisations/${verifyOrg}/shipments/${shipment}`;
    const stateShown = () =>
      page.evaluate(() => document.querySelector('#shipment-status')?.dataset.state ?? null);
    const pubCount = async (action, shipment = pubShipment) =>
      Number(
        (
          await owner.query(
            'SELECT count(*) AS n FROM trucker.audit_entry WHERE record_id = $1 AND action = $2',
            [shipment, action],
          )
        ).rows[0].n,
      );
    const inEachLocale = async (state) => {
      for (const locale of locales) {
        await open(shipmentPath(locale), 390);
        await inspect(locale, state);
      }
    };
    const urPub = messagesFor('ur').pub;
    const enPub = messagesFor('en').pub;
    await inEachLocale('publish form');

    // Sent without the details: refused by field, focus on the summary, nothing published.
    await open(shipmentPath('ur'), 390);
    await submit('#publish-shipment');
    const pubLinks = await page.evaluate(() =>
      [...document.querySelectorAll('#error-summary a')].map((a) => a.getAttribute('href')),
    );
    check(
      'publication',
      (await focusedId()) === 'error-summary' &&
        [
          '#cargoCategory',
          '#equipmentType',
          '#dangerousGoods-no',
          '#pickupArea',
          '#deliveryArea',
          '#deadlineDate',
        ].every((href) => pubLinks.includes(href)) &&
        (await pubCount('shipment.published')) === 0,
      `an empty publication answered with links ${pubLinks}`,
    );
    await inspect('ur', 'publish errors');

    // Filled in; the server publishes it and the answer is lost. Not reported as done; the
    // retry shows the server's state, published once.
    const deadline = zoned(24, 4);
    await page.select('#cargoCategory', 'general_dry');
    await page.select('#equipmentType', 'curtain_side');
    await page.click('#dangerousGoods-no');
    await page.type('#pickupArea', 'North industrial area');
    await page.type('#deliveryArea', 'Port district');
    await page.type('#deadlineDate', deadline.slice(0, 10));
    await page.type('#deadlineTime', deadline.slice(11, 16));
    relay.lost.length = 0;
    relay.mode = 'lose';
    await submit('#publish-shipment');
    relay.mode = 'pass';
    check(
      'lost answer',
      relay.lost[0] ===
        `POST /organisations/${verifyOrg}/shipments/${pubShipment}/publish -> 200` &&
        page.url().includes('error=publish_unconfirmed') &&
        (await text('#shipment-confirmation')) === null,
      `a lost publication answer led to ${page.url()}: ${relay.lost}`,
    );
    relay.lost.length = 0;
    await submit('#retry-shipments');
    check(
      'lost answer',
      (await stateShown()) === 'published' &&
        (await pubCount('shipment.published')) === 1 &&
        (await page.evaluate(() => document.querySelector('#publish-form'))) === null,
      `after a lost publication the page shows ${await stateShown()} with ${await pubCount('shipment.published')} publications`,
    );
    await inEachLocale('published');
    await open(shipmentPath('en'), 390);
    const previewText = (await text('#carrier-preview')) ?? '';
    check(
      'publication',
      previewText.includes('North industrial area') &&
        previewText.includes(enPub.verifiedShipper) &&
        ![
          'Private Street',
          'Hidden Road',
          'Gate code',
          `PUB-${stamp}`,
          'Verification Fixture',
        ].some((secret) => previewText.includes(secret)) &&
        ((await text('#preview-caution')) ?? '') === enPub.previewCaution &&
        ((await text('#preview-hidden')) ?? '') === enPub.previewHidden &&
        (await page.evaluate(() => document.querySelectorAll('#published-versions li').length)) ===
          1,
      `the preview shows "${previewText.slice(0, 200)}"`,
    );

    // A material change through the change page: a new version.
    await submit('#change-published');
    await inEachLocale('published change');
    await open(`${shipmentPath('en')}/change`, 390);
    await page.$eval('#grossWeightKg', (input) => (input.value = ''));
    await page.type('#grossWeightKg', '13000');
    await submit('#save-published-change');
    check(
      'publication',
      page.url().includes('pubDone=changed_material') &&
        ((await text('#shipment-confirmation')) ?? '') === enPub.done.changed_material &&
        (await page.evaluate(() => document.querySelectorAll('#published-versions li').length)) ===
          2 &&
        (await pubCount('shipment.version_created')) === 1,
      `a material change led to ${page.url()}`,
    );

    // Withdrawal: the server withdraws the shipment and the answer is lost. Not reported as
    // done; the retry shows it withdrawn, and sending the same request again confirms it
    // without a second transition or history entry.
    const wdShipment = await makeShipment('wd');
    const wdApi = (path, init = {}) =>
      fetch(`${apiOrigin}/organisations/${verifyOrg}/shipments/${wdShipment}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${urToken}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      }).then(async (reply) => ({ status: reply.status, body: await reply.json() }));
    const wdDraft = (await wdApi('')).body.shipment;
    const wdPublished = await wdApi('/publish', {
      method: 'POST',
      headers: { 'idempotency-key': `wd-${stamp}-publish` },
      body: JSON.stringify({
        version: wdDraft.version,
        cargoCategory: 'general_dry',
        equipmentType: 'box',
        dangerousGoods: false,
        pickupArea: 'North industrial area',
        deliveryArea: 'Port district',
        quotationDeadline: { local: zoned(24, 4) },
      }),
    });
    const wdState = async () =>
      (
        await owner.query(
          'SELECT status, version, withdrawn_at FROM trucker.shipment_draft WHERE id = $1',
          [wdShipment],
        )
      ).rows[0];
    const beforeWithdrawal = await wdState();
    await open(shipmentPath('en', wdShipment), 390);
    relay.lost.length = 0;
    relay.mode = 'lose';
    await submit('#withdraw-shipment');
    relay.mode = 'pass';
    const lostWithdrawalUrl = page.url();
    const afterLoss = await wdState();
    check(
      'lost answer',
      wdPublished.status === 200 &&
        relay.lost[0] ===
          `POST /organisations/${verifyOrg}/shipments/${wdShipment}/withdraw -> 200` &&
        lostWithdrawalUrl.includes('error=withdraw_unconfirmed') &&
        !lostWithdrawalUrl.includes('pubDone=') &&
        (await text('#shipment-confirmation')) === null &&
        afterLoss.status === 'withdrawn' &&
        afterLoss.version === beforeWithdrawal.version + 1,
      `a lost withdrawal answer led to ${lostWithdrawalUrl}: ${relay.lost}, server ${afterLoss.status}`,
    );
    relay.lost.length = 0;
    await submit('#retry-shipments');
    const withdrawKey = new URL(lostWithdrawalUrl).searchParams.get('withdrawRetry');
    const resent = await wdApi('/withdraw', {
      method: 'POST',
      headers: { 'idempotency-key': withdrawKey ?? 'missing-key' },
      body: JSON.stringify({ version: beforeWithdrawal.version }),
    });
    const afterWdRetry = await wdState();
    check(
      'lost answer',
      (await stateShown()) === 'withdrawn' &&
        (await page.$('#withdraw-form')) === null &&
        Boolean(withdrawKey) &&
        resent.status === 200 &&
        resent.body.outcome === 'already_withdrawn' &&
        afterWdRetry.version === afterLoss.version &&
        afterWdRetry.withdrawn_at.getTime() === afterLoss.withdrawn_at.getTime() &&
        (await pubCount('shipment.withdrawn', wdShipment)) === 1 &&
        relay.lost.length === 0,
      `after a lost withdrawal the page shows ${await stateShown()}, the same request again answered ${resent.status} ${resent.body.outcome}, with ${await pubCount('shipment.withdrawn', wdShipment)} withdrawals`,
    );

    // ------------------------------------------------------------------------------------
    // Carrier onboarding and discovery: apply, lose an answer, verified, discover, open
    // ------------------------------------------------------------------------------------
    // A second organisation of the same person applies as a carrier in the browser. Staff
    // decide through the staff API. It then discovers the shipment published above.
    const carrierOrg = (
      await (
        await fetch(`${apiOrigin}/organisations`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${urToken}`,
            'content-type': 'application/json',
            'idempotency-key': `carrier-${stamp}-organisation`,
          },
          body: JSON.stringify({
            legalName: 'Carrier Fixture Company (fictional)',
            countryCode: 'XA',
            registrationNumber: `CAR-${stamp}`,
          }),
        })
      ).json()
    ).organisation.id;
    const carrierPath = (locale) => `/${locale}/organisations/${carrierOrg}/carrier`;
    const discoverPath = (locale) => `/${locale}/organisations/${carrierOrg}/discover`;
    const carrierState = () =>
      page.evaluate(() => document.querySelector('#carrier-status')?.dataset.state ?? null);
    const carrierOverview = async () =>
      (await urApi(`/organisations/${carrierOrg}/verification`)).body.verification;
    const urCarrier = messagesFor('ur').carrier;
    await open(`/en/organisations/${carrierOrg}`, 390);
    await submit('#open-carrier-page');
    check(
      'carrier',
      page.url() === `${origin}${carrierPath('en')}` && (await carrierState()) === 'none',
      `the organisation's carrier link led to ${page.url()} showing ${await carrierState()}`,
    );
    for (const locale of locales) {
      await open(carrierPath(locale), 390);
      await inspect(locale, 'carrier apply');
    }
    // Sent with nothing declared: refused by field, nothing submitted.
    await open(carrierPath('ur'), 390);
    await page.type('#ev-registration_certificate-documentNumber', 'REG-CAR-1');
    await page.type('#ev-haulage_licence-documentNumber', 'HAUL-CAR-2');
    await page.click('#declaration');
    await submit('#submit-carrier');
    const carrierLinks = await page.evaluate(() =>
      [...document.querySelectorAll('#error-summary a')].map((a) => a.getAttribute('href')),
    );
    check(
      'carrier',
      (await focusedId()) === 'error-summary' &&
        carrierLinks.includes('#service-countries') &&
        carrierLinks.includes('#service-equipment') &&
        ((await text('#error-summary')) ?? '').includes(urCarrier.errors.countries) &&
        (await carrierOverview()).applications.length === 0,
      `an application with nothing declared answered ${page.url()} with links ${carrierLinks}`,
    );
    await inspect('ur', 'carrier errors');
    // Declared and sent; the server records it and the answer is lost. Not reported as done;
    // the page then shows the application as the server holds it, recorded once.
    await page.click('#service-country-XA');
    await page.click('#service-country-XB');
    await page.click('#service-equipment-curtain_side');
    if (!(await page.$eval('#declaration', (input) => input.checked)))
      await page.click('#declaration');
    relay.lost.length = 0;
    relay.mode = 'lose';
    await submit('#submit-carrier');
    relay.mode = 'pass';
    const lostCarrierUrl = page.url();
    check(
      'lost answer',
      relay.lost[0] === `POST /organisations/${carrierOrg}/verification/applications -> 201` &&
        lostCarrierUrl.includes('error=submit_unconfirmed') &&
        (await text('#carrier-confirmation')) === null,
      `a lost carrier application answer led to ${lostCarrierUrl}: ${relay.lost}`,
    );
    relay.lost.length = 0;
    await open(carrierPath('ur'), 390);
    const afterLostCarrier = await carrierOverview();
    check(
      'lost answer',
      (await carrierState()) === 'under_review' &&
        afterLostCarrier.applications.length === 1 &&
        afterLostCarrier.applications[0].capability === 'carry_as_company' &&
        afterLostCarrier.applications[0].service.countries.join() === 'XA,XB' &&
        (await page.$('#submit-carrier')) === null,
      `after a lost carrier application the page shows ${await carrierState()} with ${afterLostCarrier.applications.length} applications`,
    );
    const carrierDecision = await fetch(
      `${apiOrigin}/staff/verification/${afterLostCarrier.applications[0].id}/decision`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${reviewerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          decision: 'verified',
          reason: 'evidence_accepted',
          noConflict: true,
        }),
      },
    );
    await open(carrierPath('en'), 390);
    check(
      'carrier',
      carrierDecision.status === 200 &&
        (await carrierState()) === 'granted' &&
        (await page.$('#open-discovery')) !== null &&
        (await page.$('#declared-service')) !== null &&
        ((await text('#matching-note')) ?? '') === messagesFor('en').carrier.matchingNote,
      `after the decision the carrier page shows ${await carrierState()}`,
    );
    await inspect('en', 'carrier verified');

    // Discovery: the shipment published above, as carriers see it, nothing more.
    await submit('#open-discovery');
    const discovered = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#discovery-list > li')].map((li) => li.dataset.shipment),
      );
    const secretsShown = async () => {
      const body = (await page.evaluate(() => document.body.textContent)) ?? '';
      return [
        'Private Street',
        'Hidden Road',
        'Gate code',
        `PUB-${stamp}`,
        'Verification Fixture',
        `VER-${stamp}`,
      ].filter((secret) => body.includes(secret));
    };
    check(
      'discovery',
      page.url() === `${origin}${discoverPath('en')}` &&
        (await discovered()).includes(pubShipment) &&
        !(await discovered()).includes(wdShipment) &&
        (await secretsShown()).length === 0,
      `discovery showed ${await discovered()} with ${await secretsShown()}`,
    );
    for (const locale of locales) {
      const response = await open(discoverPath(locale), 390);
      check(
        'discovery',
        (response.headers()['cache-control'] ?? '').includes('no-store'),
        `${locale}: the discovery page may be stored by a cache: ${response.headers()['cache-control']}`,
      );
      await inspect(locale, 'discovery list');
    }
    // A filter that matches nothing, then cleared.
    await open(discoverPath('en'), 390);
    await page.select('#filter-pickupCountry', 'XB');
    await submit('#apply-filter');
    check(
      'discovery',
      page.url().includes('pickupCountry=XB') &&
        (await text('#discovery-empty')) === messagesFor('en').disc.empty &&
        (await discovered()).length === 0,
      `a filter matching nothing led to ${page.url()} with ${await discovered()}`,
    );
    await submit('#clear-filter');
    await submit(`[data-open="${pubShipment}"]`);
    check(
      'discovery',
      page.url() === `${origin}${discoverPath('en')}/${pubShipment}` &&
        ((await text('#discovered')) ?? '').includes('North industrial area') &&
        ((await text('#discovered')) ?? '').includes(messagesFor('en').pub.verifiedShipper) &&
        (await secretsShown()).length === 0,
      `the discovered shipment led to ${page.url()} with ${await secretsShown()}`,
    );
    for (const locale of locales) {
      await open(`${discoverPath(locale)}/${pubShipment}`, 390);
      await inspect(locale, 'discovered shipment');
    }
    // The shipper's own organisation is not a carrier: refused, and pointed to the carrier page.
    await open(`/en/organisations/${verifyOrg}/discover`, 390);
    check(
      'discovery',
      (await page.evaluate(() => document.querySelector('[data-state]')?.dataset.state)) ===
        'discovery-carrier_not_eligible' &&
        (await page.$('#open-carrier')) !== null &&
        (await page.$('#discovery-list')) === null,
      `a shipper opening discovery saw ${page.url()}`,
    );

    // ------------------------------------------------------------------------------------
    // Quotations: terms, problems by field, lost answers, comparison, rejection
    // ------------------------------------------------------------------------------------
    const quotesPath = (locale) =>
      `/${locale}/organisations/${verifyOrg}/shipments/${pubShipment}/quotations`;
    const quotePath = (locale) => `${discoverPath(locale)}/${pubShipment}`;
    const enQuo = messagesFor('en').quo;
    const urQuo = messagesFor('ur').quo;
    const quotationRows = async () =>
      (
        await owner.query(
          `SELECT q.id, q.status, q.current_version, trim_scale(v.amount)::text AS amount
           FROM trucker.quotation q JOIN trucker.quotation_version v
             ON v.quotation_id = q.id AND v.version_no = q.current_version
           WHERE q.shipment_id = $1 ORDER BY q.created_at`,
          [pubShipment],
        )
      ).rows;
    const quoCount = async (action) =>
      Number(
        (
          await owner.query(
            `SELECT count(*) AS n FROM trucker.audit_entry a JOIN trucker.quotation q ON q.id = a.record_id
             WHERE q.shipment_id = $1 AND a.action = $2`,
            [pubShipment, action],
          )
        ).rows[0].n,
      );
    const standingShown = () =>
      page.evaluate(
        () => document.querySelector('#own-quotation [data-standing]')?.dataset.standing ?? null,
      );
    // Before the shipper chooses a currency, nothing can be sent.
    await open(quotePath('en'), 390);
    check(
      'quotation',
      (await page.$('#terms-missing')) !== null && (await page.$('#submit-quotation')) === null,
      `before terms the carrier page offered ${await page.$('#submit-quotation')}`,
    );
    // The shipper opens the quotations from the shipment and chooses the one currency.
    await open(shipmentPath('en'), 390);
    await submit('#open-quotations');
    check(
      'quotation',
      page.url() === `${origin}${quotesPath('en')}` && (await page.$('#terms-form')) !== null,
      `the shipment's quotations link led to ${page.url()}`,
    );
    await page.select('#currency', 'XTS');
    await submit('#save-terms');
    check(
      'quotation',
      page.url().includes('qDone=set') && ((await text('#quotation-terms')) ?? '').includes('XTS'),
      `saving the currency led to ${page.url()}`,
    );
    for (const locale of locales) {
      await open(quotePath(locale), 390);
      await inspect(locale, 'quotation form');
    }
    // Sent with nothing filled in: refused by field, nothing recorded.
    await open(quotePath('ur'), 390);
    await submit('#submit-quotation');
    const quoLinks = await page.evaluate(() =>
      [...document.querySelectorAll('#error-summary a')].map((a) => a.getAttribute('href')),
    );
    check(
      'quotation',
      (await focusedId()) === 'error-summary' &&
        quoLinks.includes('#amount') &&
        quoLinks.includes('#inc-fictional_item_1') &&
        quoLinks.includes('#validUntilDate') &&
        quoLinks.includes('#earliestPickupDate') &&
        (await quotationRows()).length === 0,
      `an empty quotation answered ${page.url()} with links ${quoLinks}`,
    );
    await inspect('ur', 'quotation errors');
    // Too many decimal places for the currency: refused at the amount, with the limit.
    const fillQuotation = async (amount) => {
      await page.$eval('#amount', (input) => (input.value = ''));
      await page.type('#amount', amount);
      for (const item of [1, 2, 3])
        await page.click(`#inc-fictional_item_${item}-${item === 2 ? 'no' : 'yes'}`);
      const until = zoned(6, 4);
      const pickup = zoned(49, 4);
      for (const [id, value] of [
        ['#validUntilDate', until.slice(0, 10)],
        ['#validUntilTime', until.slice(11, 16)],
        ['#earliestPickupDate', pickup.slice(0, 10)],
        ['#earliestPickupTime', pickup.slice(11, 16)],
      ]) {
        await page.$eval(id, (input) => (input.value = ''));
        await page.type(id, value);
      }
    };
    await fillQuotation('1250.505');
    await submit('#submit-quotation');
    check(
      'quotation',
      page.url().includes('amount%3Aprecision') || page.url().includes('amount:precision')
        ? ((await text('#error-summary')) ?? '').includes(
            urQuo.errors.amount_precision.replace('{n}', '2'),
          ) && (await quotationRows()).length === 0
        : false,
      `three decimal places led to ${page.url()}`,
    );
    // Sent; the server records it and the answer is lost. Not reported as sent; the page then
    // shows the quotation as the server holds it, recorded once.
    await open(quotePath('ur'), 390);
    await fillQuotation('1250.5');
    relay.lost.length = 0;
    relay.mode = 'lose';
    await submit('#submit-quotation');
    relay.mode = 'pass';
    check(
      'lost answer',
      relay.lost[0]?.startsWith(
        `POST /organisations/${carrierOrg}/discovery/shipments/${pubShipment}/quotations -> 201`,
      ) &&
        page.url().includes('qError=submit_unconfirmed') &&
        (await text('#quotation-confirmation')) === null,
      `a lost quotation answer led to ${page.url()}: ${relay.lost}`,
    );
    relay.lost.length = 0;
    await open(quotePath('ur'), 390);
    const afterLostQuote = await quotationRows();
    check(
      'lost answer',
      afterLostQuote.length === 1 &&
        afterLostQuote[0].amount === '1250.5' &&
        (await quoCount('quotation.submitted')) === 1 &&
        (await page.$('#own-quotation')) !== null &&
        (await standingShown()) === 'current',
      `after a lost quotation answer: ${JSON.stringify(afterLostQuote)} and ${await quoCount('quotation.submitted')} records`,
    );
    // With no answer from the API the session is unconfirmed, not ended: the page says the
    // quotation could not be loaded and does not send the carrier to sign in.
    relay.mode = 'down';
    await open(quotePath('en'), 390);
    const downUrl = page.url();
    const downShown = await page.evaluate(
      () => document.querySelector('[data-state]')?.dataset.state ?? null,
    );
    relay.mode = 'pass';
    check(
      'lost answer',
      downUrl.startsWith(`${origin}${quotePath('en')}`) && !downUrl.includes('sign-in'),
      `with the API unreachable the quotation page led to ${downUrl} showing ${downShown}`,
    );
    // The shipper compares: the exact amount, the inclusions answered, no contact details.
    await open(quotesPath('en'), 390);
    const listed = await page.evaluate(() =>
      [...document.querySelectorAll('#quotation-list > li')].map((li) => li.dataset.amount),
    );
    check(
      'quotation',
      listed.join() === '1250.50' &&
        (await page.$('#terms-locked')) !== null &&
        (await page.$('#terms-form')) === null &&
        ((await text('#quotation-list')) ?? '').includes(enQuo.carrierVerified) &&
        !((await text('#quotation-list')) ?? '').includes(`CAR-${stamp}`),
      `the shipper's comparison listed ${listed}`,
    );
    // Withdrawn; the server records it and the answer is lost. Asking again does not withdraw
    // twice, and the page shows it withdrawn.
    await open(quotePath('ur'), 390);
    relay.mode = 'lose';
    await submit('#withdraw-quotation');
    relay.mode = 'pass';
    check(
      'lost answer',
      relay.lost[0]?.startsWith(
        `POST /organisations/${carrierOrg}/quotations/${afterLostQuote[0].id}/withdraw -> 200`,
      ) && page.url().includes('qError=withdraw_unconfirmed'),
      `a lost withdrawal answer led to ${page.url()}: ${relay.lost}`,
    );
    relay.lost.length = 0;
    await open(quotePath('ur'), 390);
    check(
      'lost answer',
      (await quotationRows())[0].status === 'withdrawn' &&
        (await quoCount('quotation.withdrawn')) === 1 &&
        (await page.$('#withdraw-quotation')) === null &&
        (await page.$('#ended-quotation')) !== null,
      `after a lost withdrawal: ${JSON.stringify(await quotationRows())}`,
    );
    // A new quotation, then the shipper rejects it.
    await fillQuotation('990');
    await submit('#submit-quotation');
    await open(quotesPath('en'), 390);
    await inspect('en', 'quotation comparison');
    for (const locale of ['ar', 'ur']) {
      await open(quotesPath(locale), 390);
      await inspect(locale, 'quotation comparison');
    }
    await open(quotesPath('en'), 390);
    const rejectedQuote = (await quotationRows())[1];
    const listedAfter = await page.evaluate(() =>
      [...document.querySelectorAll('#quotation-list > li')].map((li) => li.dataset.amount),
    );
    await submit(`[data-reject="${rejectedQuote.id}"]`);
    check(
      'quotation',
      listedAfter.join() === '990.00,1250.50' &&
        page.url().includes('qDone=rejected') &&
        (await quotationRows())[1].status === 'rejected' &&
        (await quoCount('quotation.rejected')) === 1 &&
        (await page.$(`[data-reject="${rejectedQuote.id}"]`)) === null,
      `rejecting led to ${page.url()} after listing ${listedAfter}`,
    );
    await open(quotePath('en'), 390);
    check(
      'quotation',
      (await page.$('#ended-quotation')) !== null &&
        (await page.evaluate(
          () => document.querySelector('#ended-quotation [data-standing]')?.dataset.standing,
        )) === 'rejected',
      `the carrier sees ${await page.evaluate(() => document.querySelector('#ended-quotation')?.textContent)}`,
    );

    // ------------------------------------------------------------------------------------
    // Fleet and drivers: register, lose an answer, documents, staff decisions, a driver joins
    // ------------------------------------------------------------------------------------
    const fleetPath = (locale) => `/${locale}/organisations/${carrierOrg}/fleet`;
    const enFleet = messagesFor('en').fleet;
    const urFleet = messagesFor('ur').fleet;
    const fleetRows = async (table, where = 'organisation_id = $1') =>
      (await owner.query(`SELECT * FROM trucker.${table} WHERE ${where} ORDER BY 1`, [carrierOrg]))
        .rows;
    const staffFleet = async (route, body) =>
      fetch(`${apiOrigin}/staff/fleet${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${reviewerToken}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const acceptWaitingDocuments = async () => {
      const waiting = (await (await staffFleet('')).json()).fleet.documents;
      const replies = [];
      for (const item of waiting)
        replies.push(
          (
            await staffFleet(`/documents/${item.id}/decision`, {
              version: item.version,
              decision: 'accepted',
              reason: 'document_accepted',
              noConflict: true,
            })
          ).status,
        );
      return replies;
    };
    await open(carrierPath('en'), 390);
    await submit('#open-fleet');
    check(
      'fleet',
      page.url() === `${origin}${fleetPath('en')}` &&
        (await text('#fleet-notice')) === enFleet.notice &&
        (await page.$('#no-vehicles')) !== null &&
        (await page.$('#no-drivers')) !== null,
      `the carrier page's fleet link led to ${page.url()}`,
    );
    // Sent with nothing chosen: refused by field, nothing registered.
    await open(fleetPath('ur'), 390);
    await submit('#register-vehicle');
    const fleetLinks = await page.evaluate(() =>
      [...document.querySelectorAll('#error-summary a')].map((a) => a.getAttribute('href')),
    );
    check(
      'fleet',
      (await focusedId()) === 'error-summary' &&
        [
          '#kind',
          '#category',
          '#equipmentType',
          '#registrationCountry',
          '#registrationNumber',
        ].every((link) => fleetLinks.includes(link)) &&
        ((await text('#error-summary')) ?? '').includes(urFleet.errors.kind_required) &&
        (await fleetRows('vehicle')).length === 0,
      `an empty vehicle answered ${page.url()} with links ${fleetLinks}`,
    );
    await inspect('ur', 'fleet errors');
    // Registered; the server records it and the answer is lost. Not reported as done; the list
    // then shows the vehicle once, as a claim.
    await page.select('#kind', 'truck');
    await page.select('#category', 'fictional_rigid_truck');
    await page.select('#equipmentType', 'box');
    await page.select('#registrationCountry', 'XA');
    await page.type('#registrationNumber', `br ${stamp}`);
    relay.lost.length = 0;
    relay.mode = 'lose';
    await submit('#register-vehicle');
    relay.mode = 'pass';
    check(
      'lost answer',
      relay.lost[0] === `POST /organisations/${carrierOrg}/fleet/vehicles -> 201` &&
        page.url().includes('fError=vehicle_unconfirmed') &&
        (await text('#fleet-confirmation')) === null,
      `a lost vehicle answer led to ${page.url()}: ${relay.lost}`,
    );
    relay.lost.length = 0;
    await open(fleetPath('ur'), 390);
    const vehicles = await fleetRows('vehicle');
    check(
      'lost answer',
      vehicles.length === 1 &&
        vehicles[0].registration_number === `BR${stamp}` &&
        (await page.$eval('#vehicle-list > li', (li) => li.dataset.ownership)) === 'claimed' &&
        ((await text('#vehicle-list')) ?? '').includes(urFleet.eligibility.ownership_not_verified),
      `after a lost vehicle answer there are ${vehicles.length} vehicles`,
    );
    const vehiclePath = (locale) => `${fleetPath(locale)}/vehicles/${vehicles[0].id}`;
    // A document sent empty is refused by field; two documents are then sent.
    await open(vehiclePath('en'), 390);
    await submit('#submit-document');
    const documentLinks = await page.evaluate(() =>
      [...document.querySelectorAll('#error-summary a')].map((a) => a.getAttribute('href')),
    );
    check(
      'fleet',
      ['#type'].every((link) => documentLinks.includes(link)) &&
        (await fleetRows('fleet_document')).length === 0,
      `an empty document answered ${page.url()} with links ${documentLinks}`,
    );
    const expiry = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const sendDocument = async (type, classes = []) => {
      await page.select('#type', type);
      await page.type('#documentNumber', `DOC-${type.slice(-4)}-${stamp}`);
      await page.select('#issuingCountry', 'XA');
      await page.type('#expiryDate', expiry);
      for (const item of classes) await page.click(`#licenceClass-${item}`);
      await submit('#submit-document');
    };
    await sendDocument('fictional_registration_card');
    const firstSent = page.url();
    await sendDocument('fictional_insurance_certificate');
    check(
      'fleet',
      firstSent.includes('fDone=submitted') &&
        page.url().includes('fDone=submitted') &&
        (await fleetRows('fleet_document')).length === 2 &&
        (await page.$eval('#vehicle-eligibility', (p) => p.dataset.eligibility)) ===
          'ownership_not_verified',
      `sending two documents led to ${page.url()}`,
    );
    // Staff verify the claim and accept the documents (their own screens are checked in the
    // console's checks). The vehicle is then eligible, with nothing reserved or assigned.
    const owned = await staffFleet(`/vehicles/${vehicles[0].id}/ownership`, {
      version: vehicles[0].row_version,
      decision: 'verified',
      reason: 'ownership_evidence_accepted',
      noConflict: true,
    });
    const acceptedVehicleDocuments = await acceptWaitingDocuments();
    for (const locale of locales) {
      await open(vehiclePath(locale), 390);
      await inspect(locale, 'vehicle');
    }
    await open(vehiclePath('en'), 390);
    check(
      'fleet',
      owned.status === 200 &&
        acceptedVehicleDocuments.join() === '200,200' &&
        (await page.$eval('#vehicle-eligibility', (p) => p.dataset.eligibility)) === 'eligible' &&
        (await page.$eval('#vehicle-facts', (card) => card.dataset.ownership)) === 'verified',
      `after the decisions (${owned.status}; ${acceptedVehicleDocuments}) the vehicle page shows ${await page.$eval('#vehicle-eligibility', (p) => p.dataset.eligibility)}`,
    );
    // A driver is invited by number; the answer is lost; one invitation exists. The carrier's
    // administrator invites their own number here, so that the same browser can answer it.
    const ownPhone = (
      await owner.query(
        `SELECT p.phone_e164 FROM trucker.person p JOIN trucker.membership m ON m.person_id = p.id
         WHERE m.organisation_id = $1`,
        [carrierOrg],
      )
    ).rows[0].phone_e164;
    await open(fleetPath('ur'), 390);
    await page.type('#phone', 'not a number');
    await submit('#invite-driver');
    check(
      'fleet',
      ((await text('#error-summary')) ?? '').includes(urFleet.errors.phone_invalid) &&
        (await fleetRows('driver_affiliation')).length === 0,
      `a bad number led to ${page.url()}`,
    );
    await page.$eval('#phone', (input) => (input.value = ''));
    await page.type('#phone', ownPhone);
    relay.mode = 'lose';
    await submit('#invite-driver');
    relay.mode = 'pass';
    check(
      'lost answer',
      relay.lost[0] === `POST /organisations/${carrierOrg}/fleet/drivers -> 201` &&
        page.url().includes('fError=invite_unconfirmed'),
      `a lost invitation answer led to ${page.url()}: ${relay.lost}`,
    );
    relay.lost.length = 0;
    await open(fleetPath('en'), 390);
    check(
      'lost answer',
      (await fleetRows('driver_affiliation')).length === 1 &&
        (await page.$eval('#driver-list > li', (li) => li.dataset.status)) === 'invited',
      `after a lost invitation there are ${(await fleetRows('driver_affiliation')).length} invitations`,
    );
    // The driver's own page, on a phone: the invitation, accepted; then the documents.
    for (const locale of locales) {
      await open(`/${locale}/driver`, 390);
      await inspect(locale, 'driver invitation');
    }
    await open('/en/account', 390);
    await submit('#open-driver');
    const invitationId = (await fleetRows('driver_affiliation'))[0].id;
    await submit(`[data-accept="${invitationId}"]`);
    check(
      'fleet',
      page.url().includes('fDone=accepted') &&
        (await page.$('#driver-affiliation')) !== null &&
        (await page.$eval('#driver-eligibility', (p) => p.dataset.eligibility)) ===
          'document_missing' &&
        (await fleetRows('driver_affiliation'))[0].status === 'active',
      `accepting the invitation led to ${page.url()}`,
    );
    // A licence without its classes is refused at the classes.
    await sendDocument('fictional_driving_licence');
    check(
      'fleet',
      ((await text('#error-summary')) ?? '').includes(enFleet.errors.licenceClasses_required),
      `a licence without classes led to ${page.url()}`,
    );
    await open('/en/driver', 390);
    await sendDocument('fictional_driving_licence', ['fictional_class_1']);
    await sendDocument('fictional_identity_card');
    const acceptedDriverDocuments = await acceptWaitingDocuments();
    for (const locale of locales) {
      await open(`/${locale}/driver`, 390);
      await inspect(locale, 'driver');
    }
    await open('/en/driver', 390);
    check(
      'fleet',
      acceptedDriverDocuments.join() === '200,200' &&
        (await page.$eval('#driver-eligibility', (p) => p.dataset.eligibility)) === 'eligible' &&
        ((await text('#document-list')) ?? '').includes(`DOC-ence-${stamp}`),
      `after the decisions (${acceptedDriverDocuments}) the driver page shows ${await page.$eval('#driver-eligibility', (p) => p.dataset.eligibility)}`,
    );
    // The carrier sees the driver working with it and eligible, never the document numbers;
    // it authorises the driver for every vehicle.
    for (const locale of locales) {
      await open(fleetPath(locale), 390);
      await inspect(locale, 'fleet');
    }
    await open(fleetPath('en'), 390);
    const fleetText = (await page.evaluate(() => document.body.textContent)) ?? '';
    await submit(`[data-authorise="${invitationId}"]`);
    check(
      'fleet',
      !fleetText.includes(`DOC-ence-${stamp}`) &&
        !fleetText.includes(`DOC-card-${stamp}`) &&
        page.url().includes('fDone=changed') &&
        (await page.$eval('#driver-list > li [data-authorised]', (p) => p.dataset.authorised)) ===
          'all' &&
        (await fleetRows('driver_authorisation')).length === 1,
      `authorising led to ${page.url()}`,
    );
    // The carrier ends the affiliation: the driver is listed as ended, with nothing more.
    await submit(`[data-end="${invitationId}"]`);
    check(
      'fleet',
      page.url().includes('fDone=ended') &&
        (await page.$eval('#driver-list > li', (li) => li.dataset.status)) === 'ended' &&
        (await page.$('#driver-list > li [data-eligibility]')) === null &&
        (await fleetRows('driver_authorisation', `organisation_id = $1 AND status = 'active'`))
          .length === 0,
      `ending the affiliation led to ${page.url()}`,
    );

    // ------------------------------------------------------------------------------------
    // Acceptance and booking: what accepting fixes, a lost answer, one booking, both parties
    // ------------------------------------------------------------------------------------
    // A second shipment, published and quoted through the API, so that the shipment above
    // stays open for the checks that follow. The same person administers both organisations.
    const post = async (route, body, name) => {
      const response = await fetch(apiOrigin + route, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${urToken}`,
          'content-type': 'application/json',
          'idempotency-key': `book-${stamp}-${name}-key`,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const bookShipment = await makeShipment('book');
    const bookPublished = await post(
      `/organisations/${verifyOrg}/shipments/${bookShipment}/publish`,
      {
        version: 1,
        cargoCategory: 'general_dry',
        equipmentType: 'curtain_side',
        dangerousGoods: false,
        pickupArea: 'North industrial area',
        deliveryArea: 'Port district',
        quotationDeadline: { local: zoned(24, 4) },
      },
      'publish',
    );
    const bookTerms = await post(
      `/organisations/${verifyOrg}/shipments/${bookShipment}/quotation-terms`,
      { version: 0, currency: 'XTS' },
      'terms',
    );
    const bookQuote = await post(
      `/organisations/${carrierOrg}/discovery/shipments/${bookShipment}/quotations`,
      {
        amount: '1250.50',
        inclusions: { fictional_item_1: true, fictional_item_2: false, fictional_item_3: true },
        validUntil: { local: zoned(6, 4) },
        earliestPickup: { local: zoned(49, 4) },
      },
      'quote',
    );
    const bookQuotation = bookQuote.body.quotation?.id;
    const bookQuotes = (locale) =>
      `/${locale}/organisations/${verifyOrg}/shipments/${bookShipment}/quotations`;
    const bookings = async () =>
      (await owner.query('SELECT * FROM trucker.booking WHERE shipment_id = $1', [bookShipment]))
        .rows;
    const enBook = messagesFor('en').book;
    for (const locale of locales) {
      await open(bookQuotes(locale), 390);
      await inspect(locale, 'acceptance');
    }
    await open(bookQuotes('en'), 390);
    const money = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('[data-acceptance="ok"] [data-money]')].map((dd) => [
            dd.dataset.money,
            dd.textContent.trim(),
          ]),
        ),
      );
    const shown = await money();
    check(
      'booking',
      [bookPublished.status, bookTerms.status, bookQuote.status].join() === '200,200,201' &&
        shown.transport === '1250.50 XTS' &&
        (shown.fee ?? '').startsWith('37.52 XTS') &&
        shown.total === '1288.02 XTS' &&
        (await text('#no-commitment')) === messagesFor('en').quo.noCommitmentShipper &&
        (await page.$('#booking')) === null,
      `before accepting (${bookPublished.status}, ${bookTerms.status}, ${bookQuote.status}) the page showed ${JSON.stringify(shown)}`,
    );
    // Accepted; the server records it and the answer is lost. Not reported as done; the page
    // then shows the one booking, and accepting again is not offered.
    relay.lost.length = 0;
    relay.mode = 'lose';
    await submit(`[data-accept="${bookQuotation}"]`);
    relay.mode = 'pass';
    check(
      'lost answer',
      relay.lost[0] ===
        `POST /organisations/${verifyOrg}/quotations/${bookQuotation}/accept -> 200` &&
        page.url().includes('qError=accept_unconfirmed') &&
        (await text('#quotation-confirmation')) === null,
      `a lost acceptance answer led to ${page.url()}: ${relay.lost}`,
    );
    relay.lost.length = 0;
    await open(bookQuotes('en'), 390);
    const made = await bookings();
    check(
      'lost answer',
      made.length === 1 &&
        (await page.$eval('#booking [data-booking]', (card) => card.dataset.status)) ===
          'awaiting_resources' &&
        ((await text('#booking')) ?? '').includes(enBook.statusNote) &&
        ((await text('#booking')) ?? '').includes(enBook.termsNote) &&
        (await page.$eval(
          '#booking [data-terms]',
          (p) => `${p.dataset.terms}/${p.dataset.demonstration}`,
        )) === 'booking-1/true' &&
        (await page.$(`[data-accept="${bookQuotation}"]`)) === null &&
        (await page.$('[data-reject]')) === null &&
        (await page.$eval('#quotation-list [data-standing]', (p) => p.dataset.standing)) ===
          'accepted',
      `after a lost acceptance there are ${made.length} bookings`,
    );
    for (const locale of locales) {
      await open(bookQuotes(locale), 390);
      await inspect(locale, 'booking');
    }
    // The shipment itself shows that it is awarded.
    await open(shipmentPath('en', bookShipment), 390);
    check(
      'booking',
      (await stateShown()) === 'awarded' &&
        (await page.$('#withdraw-shipment')) === null &&
        (await page.$('#publish-shipment')) === null,
      `the awarded shipment page shows ${await stateShown()}`,
    );
    await inspect('en', 'awarded shipment');
    // Both parties' booking lists show the same booking, each with its own figures (slice 25,
    // D-11): the shipper the price, the fee and its total; the carrier the price and its net.
    const figures = async (org) => {
      await open(`/en/organisations/${org}/bookings`, 390);
      return page.evaluate(() =>
        [...document.querySelectorAll('#booking-list [data-money]')]
          .map((dd) => `${dd.dataset.money}=${dd.textContent.trim()}`)
          .join(';'),
      );
    };
    const asShipper = await figures(verifyOrg);
    for (const locale of locales) {
      await open(`/${locale}/organisations/${verifyOrg}/bookings`, 390);
      await inspect(locale, 'bookings');
    }
    const asCarrier = await figures(carrierOrg);
    check(
      'booking',
      asShipper === 'transport=1250.50 XTS;fee=37.52 XTS, paid by the shipper;total=1288.02 XTS' &&
        asCarrier === 'transport=1250.50 XTS;net=1250.50 XTS',
      `the shipper saw ${asShipper} and the carrier ${asCarrier}`,
    );
    // The carrier's own quotation list leads to the booking, not to the closed shipment.
    await open(`/en/organisations/${carrierOrg}/quotations`, 390);
    await submit(`[data-booking-link="${bookQuotation}"]`);
    check(
      'booking',
      page.url() === `${origin}/en/organisations/${carrierOrg}/bookings`,
      `the accepted quotation's link led to ${page.url()}`,
    );

    // ------------------------------------------------------------------------------------
    // Assignment and confirmation, a lost answer, what each side is shown, the driver's
    // acknowledgement, a proposed substitution, and the shipper's decision to wait
    // ------------------------------------------------------------------------------------
    const enAsg = messagesFor('en').asg;
    const bookingId = (await bookings())[0].id;
    const bookingPath = (locale, org, id = bookingId) =>
      `/${locale}/organisations/${org}/bookings/${id}`;

    // Trucker's fee (slice 26) is verified by two administrators through the staff API before
    // the assignment below, so that the assignment confirms the booking. The console journey
    // covers the staff screens.
    const feeAdmin = async () => {
      const token = `${randomBytes(16).toString('hex')}.${randomBytes(16).toString('hex')}`;
      const id = (
        await owner.query(
          `INSERT INTO trucker.staff_account
             (email, display_name, status, enrolled_at, password_hash, totp_secret, participant_link,
              created_at, updated_at)
           VALUES ($1, 'Browser Test Administrator', 'active', now(), 'not-a-real-hash', '\\x00',
                   'declared_none', now(), now())
           RETURNING id`,
          [`fee-${randomUUID()}@example.test`],
        )
      ).rows[0].id;
      await owner.query(
        `INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at)
         VALUES ($1, 'staff_admin', NULL, now())`,
        [id],
      );
      await owner.query(
        `INSERT INTO trucker.staff_session (id, staff_id, token_hash, created_at, last_used_at, absolute_expires_at)
         VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 hour')`,
        [id, createHash('sha256').update(token).digest('hex')],
      );
      return token;
    };
    const asStaff = async (token, method, route, body, key) => {
      const response = await fetch(`${apiOrigin}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(key ? { 'idempotency-key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const settleFee = async (booking) => {
      const recorder = await feeAdmin();
      const approver = await feeAdmin();
      const due = (await asStaff(recorder, 'GET', '/staff/fee-payments')).body.fees.due.find(
        (item) => item.bookingId === booking,
      );
      const recorded = await asStaff(
        recorder,
        'POST',
        '/staff/fee-payments',
        {
          reference: due.reference,
          amount: due.amount,
          currency: due.currency,
          valueDate: due.dueAt.slice(0, 10),
          statementReference: `STMT-${randomBytes(5).toString('hex').toUpperCase()}`,
        },
        `fee-${randomUUID()}`,
      );
      const approved = await asStaff(
        approver,
        'POST',
        `/staff/fee-payments/${recorded.body.payment.id}/decision`,
        { version: recorded.body.payment.version, decision: 'approve' },
      );
      return `${recorded.status}/${approved.status}`;
    };
    const feeSettled = await settleFee(bookingId);
    check('fee', feeSettled === '201/200', `the fee of the booking was settled with ${feeSettled}`);
    for (const locale of locales) {
      await open(bookingPath(locale, verifyOrg), 390);
      await inspect(locale, 'booking fee paid');
    }
    check(
      'fee',
      (await page.$eval('.fee-payment', (item) => item.dataset.feeStatus)) === 'paid' &&
        (await page.$('[data-fee-due]')) === null,
      'the shipper sees the fee paid',
    );
    const asgRows = async (table, where = 'booking_id = $1', id = bookingId) =>
      (await owner.query(`SELECT * FROM trucker.${table} WHERE ${where}`, [id])).rows;
    const activeReservations = async (id = bookingId) =>
      asgRows('resource_reservation', `booking_id = $1 AND status = 'active'`, id);
    // More of the fleet, through the API (its screens are checked above): a curtain-side truck,
    // a tractor unit and a semi-trailer, each verified with accepted documents; and the driver
    // back with the carrier, licensed for all of them.
    const plateOf = (prefix) => `${prefix}${stamp}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const addVehicle = async (name, body) => {
      const made = await post(
        `/organisations/${carrierOrg}/fleet/vehicles`,
        { registrationCountry: 'XA', registrationNumber: plateOf(name), ...body },
        `vehicle-${name}`,
      );
      const vehicle = made.body.vehicle;
      if (!vehicle) return { status: made.status };
      const owned = await staffFleet(`/vehicles/${vehicle.id}/ownership`, {
        version: vehicle.version,
        decision: 'verified',
        reason: 'ownership_evidence_accepted',
        noConflict: true,
      });
      const types =
        body.kind === 'trailer'
          ? ['fictional_registration_card']
          : ['fictional_registration_card', 'fictional_insurance_certificate'];
      for (const type of types)
        await post(
          `/organisations/${carrierOrg}/fleet/vehicles/${vehicle.id}/documents`,
          {
            type,
            documentNumber: `DOC-${name}-${type.slice(-4)}`,
            issuingCountry: 'XA',
            expiryDate: expiry,
          },
          `document-${name}-${type}`,
        );
      return { id: vehicle.id, plate: vehicle.registrationNumber, status: owned.status };
    };
    const curtain = await addVehicle('cs', {
      kind: 'truck',
      category: 'fictional_rigid_truck',
      equipmentType: 'curtain_side',
    });
    const unit = await addVehicle('tu', {
      kind: 'truck',
      category: 'fictional_tractor_unit',
      equipmentType: 'box',
    });
    const semi = await addVehicle('st', {
      kind: 'trailer',
      category: 'fictional_semi_trailer',
      equipmentType: 'curtain_side',
    });
    const reinvited = await post(
      `/organisations/${carrierOrg}/fleet/drivers`,
      { phone: ownPhone },
      'reinvite',
    );
    const driverSide = await (
      await fetch(`${apiOrigin}/me/driver`, { headers: { authorization: `Bearer ${urToken}` } })
    ).json();
    const rejoin = driverSide.driver.invitations[0];
    const rejoined = await post(
      `/me/driver/invitations/${rejoin?.id}/respond`,
      { version: rejoin?.version, decision: 'accept' },
      'rejoin',
    );
    const relicensed = await post(
      '/me/driver/documents',
      {
        type: 'fictional_driving_licence',
        documentNumber: `DOC-lic2-${stamp}`,
        issuingCountry: 'XA',
        expiryDate: expiry,
        licenceClasses: ['fictional_class_1', 'fictional_class_2'],
      },
      'licence2',
    );
    const acceptedForAssignment = await acceptWaitingDocuments();
    const authorisedAgain = await post(
      `/organisations/${carrierOrg}/fleet/drivers/${rejoin?.id}/authorisations`,
      { vehicleId: null, granted: true },
      'authorise2',
    );
    const members = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('#resources [data-member]')].map((dd) => [
            dd.dataset.member,
            dd.dataset.assigned === 'yes' ? dd.textContent.trim() : null,
          ]),
        ),
      );
    const ready = () => page.$eval('#dispatch', (item) => item.dataset.ready);
    const pickupAddress = 'Warehouse 9, Private Street';

    // The carrier opens the booking from its list. Nothing is assigned, nothing is released,
    // and a truck of the wrong equipment type is listed but cannot be chosen, with the reason.
    await open(`/en/organisations/${carrierOrg}/bookings`, 390);
    await submit(`[data-open-booking="${bookingId}"]`);
    const boxOption = await page.$eval(
      `#truckId option[value="${vehicles[0].id}"]`,
      (option) => `${option.disabled}/${option.textContent}`,
    );
    check(
      'assignment',
      [curtain.status, unit.status, semi.status, reinvited.status, rejoined.status].join() ===
        '200,200,200,201,200' &&
        relicensed.status === 201 &&
        authorisedAgain.status === 200 &&
        acceptedForAssignment.every((status) => status === 200) &&
        page.url() === `${origin}${bookingPath('en', carrierOrg)}` &&
        (await page.$eval('[data-state="booking"]', (item) => item.dataset.role)) === 'carrier' &&
        JSON.stringify(await members()) ===
          JSON.stringify({ truck: null, trailer: null, driver: null }) &&
        (await page.$('#site')) === null &&
        boxOption.startsWith('true/') &&
        boxOption.includes(enFleet.eligibility.equipment_mismatch) &&
        (await ready()) === 'no' &&
        (await page.$('#dispatch [data-blocker="not_confirmed"]')) !== null,
      `the carrier's booking page: ${page.url()}, fleet ${[curtain.status, unit.status, semi.status, reinvited.status, rejoined.status, relicensed.status, authorisedAgain.status]}, documents ${acceptedForAssignment}, option ${boxOption}`,
    );
    for (const locale of locales) {
      await open(bookingPath(locale, carrierOrg), 390);
      await inspect(locale, 'assign');
    }
    // A truck and the driver are assigned; the server records it and the answer is lost. Not
    // reported as done; the page then shows the booking confirmed, once, with the details that
    // are released to the carrier only now.
    await open(bookingPath('en', carrierOrg), 390);
    await page.select('#truckId', curtain.id);
    await page.select('#driverId', rejoin.id);
    relay.mode = 'lose';
    await submit('#save-assignment');
    relay.mode = 'pass';
    check(
      'lost answer',
      relay.lost[0] ===
        `POST /organisations/${carrierOrg}/bookings/${bookingId}/assignment -> 200` &&
        page.url().includes('aError=assign_unconfirmed'),
      `a lost assignment answer led to ${page.url()}: ${relay.lost}`,
    );
    relay.lost.length = 0;
    // The same address once the connection is back: uncertain in words, with what now stands.
    await open(`${bookingPath('en', carrierOrg)}?aError=assign_unconfirmed`, 390);
    check(
      'lost answer',
      ((await text('#error-summary')) ?? '').includes(enAsg.errors.assign_unconfirmed) &&
        (await page.$('#assignment-confirmation')) === null &&
        (await asgRows('booking_confirmation')).length === 1 &&
        (await activeReservations()).length === 2 &&
        (await page.$eval('[data-booking]', (card) => card.dataset.status)) === 'confirmed' &&
        ((await text('[data-site="pickup"]')) ?? '').includes(pickupAddress) &&
        ((await members()).truck ?? '').includes(curtain.plate) &&
        (await ready()) === 'no' &&
        (await page.$('#dispatch [data-blocker="acknowledgement_missing"]')) !== null,
      `after a lost assignment there are ${(await activeReservations()).length} reservations and ${(await asgRows('booking_confirmation')).length} confirmations`,
    );
    // Saving the same set again changes nothing.
    await submit('#save-assignment');
    check(
      'assignment',
      page.url().includes('aDone=unchanged') &&
        (await asgRows('resource_reservation')).length === 2 &&
        (await asgRows('occupancy_episode')).length === 0,
      `saving the same set again led to ${page.url()}`,
    );
    for (const locale of locales) {
      await open(bookingPath(locale, carrierOrg), 390);
      await inspect(locale, 'assigned');
    }
    // The shipper now sees the registration and the driver's name: no address of its own is
    // repeated as released, no form, no phone and no document number.
    await open(bookingPath('en', verifyOrg), 390);
    const shipperSees = (await page.evaluate(() => document.body.textContent)) ?? '';
    check(
      'assignment',
      (await page.$eval('[data-state="booking"]', (item) => item.dataset.role)) === 'shipper' &&
        ((await members()).truck ?? '').includes(curtain.plate) &&
        (await members()).driver !== null &&
        (await page.$('#site')) === null &&
        (await page.$('#assign')) === null &&
        !shipperSees.includes(ownPhone) &&
        !shipperSees.includes('DOC-'),
      `the shipper's booking page shows ${JSON.stringify(await members())}`,
    );
    for (const locale of locales) {
      await open(bookingPath(locale, verifyOrg), 390);
      await inspect(locale, 'booking for shipper');
    }
    // The driver sees the assignment on their own page, with no price and no address, and
    // acknowledges it. Dispatch is then not blocked.
    await open('/en/driver', 390);
    const driverSees = (await text(`[data-assignment="${bookingId}"]`)) ?? '';
    check(
      'assignment',
      driverSees.includes('North industrial area') &&
        driverSees.includes(curtain.plate) &&
        !driverSees.includes('1250.50') &&
        !driverSees.includes(pickupAddress) &&
        (await page.$(`[data-acknowledge="${bookingId}"]`)) !== null,
      `the driver's page shows: ${driverSees.slice(0, 200)}`,
    );
    for (const locale of locales) {
      await open(`/${locale}/driver`, 390);
      await inspect(locale, 'driver assignment');
    }
    await open('/en/driver', 390);
    await submit(`[data-acknowledge="${bookingId}"]`);
    const acknowledgedOnPage = await page.$(`[data-assignment="${bookingId}"] [data-acknowledged]`);
    await open(bookingPath('en', carrierOrg), 390);
    check(
      'assignment',
      acknowledgedOnPage !== null &&
        (await asgRows('assignment_acknowledgement')).length === 1 &&
        (await ready()) === 'yes' &&
        (await page.$eval('#acknowledgement', (item) => item.dataset.given)) === 'yes',
      `after the acknowledgement dispatch readiness is ${await ready()}`,
    );
    // A tractor unit with a trailer in place of the rigid truck is materially different: it is
    // proposed, the current truck stays, and the shipper decides.
    await page.select('#truckId', unit.id);
    await page.select('#trailerId', semi.id);
    await submit('#save-assignment');
    check(
      'assignment',
      page.url().includes('aDone=proposed') &&
        (await page.$('#withdraw-substitution')) !== null &&
        (await page.$('#assign-form')) === null &&
        ((await members()).truck ?? '').includes(curtain.plate) &&
        (await activeReservations()).filter((row) => row.purpose === 'proposed_substitute')
          .length === 2 &&
        (await ready()) === 'yes',
      `proposing a different set led to ${page.url()}`,
    );
    await open(bookingPath('en', verifyOrg), 390);
    check(
      'assignment',
      (await page.$('[data-difference="truck-category"]')) !== null &&
        (await page.$('[data-difference="trailer-added"]')) !== null &&
        ((await text('#substitution-proposed')) ?? '').includes(unit.plate) &&
        (await page.$('#accept-substitution')) !== null &&
        (await page.$('#withdraw-substitution')) === null,
      'the shipper is not shown the proposed substitution with its differences',
    );
    for (const locale of locales) {
      await open(bookingPath(locale, verifyOrg), 390);
      await inspect(locale, 'substitution');
      // The arrow points from the earlier value to the later one in the page's reading direction.
      const categoryChange = (await text('[data-difference="truck-category"]')) ?? '';
      const [forward, backward] = locale === 'en' ? ['→', '←'] : ['←', '→'];
      check(
        'assignment',
        categoryChange.includes(forward) && !categoryChange.includes(backward),
        `${locale}: the category change reads ${categoryChange}`,
      );
    }
    await open(bookingPath('en', verifyOrg), 390);
    await submit('#decline-substitution');
    check(
      'assignment',
      page.url().includes('aDone=declined') &&
        (await page.$('#substitution')) === null &&
        (await activeReservations()).length === 2 &&
        ((await members()).truck ?? '').includes(curtain.plate) &&
        (await ready()) === 'yes',
      `declining the substitution led to ${page.url()}`,
    );
    // A truck of the same category replaces the current one at once (N-1). The shipper's page
    // then lists the change, with the registrations only.
    const sameCategory = await addVehicle('cs2', {
      kind: 'truck',
      category: 'fictional_rigid_truck',
      equipmentType: 'curtain_side',
    });
    await acceptWaitingDocuments();
    await open(bookingPath('en', carrierOrg), 390);
    await page.select('#truckId', sameCategory.id);
    await submit('#save-assignment');
    const swapRows = await owner.query(
      `SELECT organisation_id FROM trucker.audit_entry
       WHERE record_id = $1 AND action = 'booking.vehicles_changed'`,
      [bookingId],
    );
    await open(bookingPath('en', verifyOrg), 390);
    const changesShown = (await text('#vehicle-changes')) ?? '';
    check(
      'assignment',
      sameCategory.status === 200 &&
        swapRows.rows.map((row) => row.organisation_id).join() === verifyOrg &&
        ((await members()).truck ?? '').includes(sameCategory.plate) &&
        changesShown.includes(curtain.plate) &&
        changesShown.includes(sameCategory.plate) &&
        !changesShown.includes(sameCategory.id),
      `after a same-category swap the shipper's page lists: ${changesShown}`,
    );
    for (const locale of locales) {
      await open(bookingPath(locale, verifyOrg), 390);
      await inspect(locale, 'vehicle changes');
      // The arrow points from the replaced vehicle to its replacement in the reading direction.
      const swap = (await text('#vehicle-changes [data-change="truck"]')) ?? '';
      const [forward, backward] = locale === 'en' ? ['→', '←'] : ['←', '→'];
      check(
        'assignment',
        swap.includes(forward) && !swap.includes(backward),
        `${locale}: the vehicle change reads ${swap}`,
      );
    }

    // Dispatch (slice 17a). The booking starts in about two days, so dispatch is refused as too
    // early and the page says why. The migration role then widens the dispatch window to its
    // highest permitted value (72 hours) for this run, and the carrier dispatches. The trip
    // replaces cancelling and assignment; the driver sees the addresses and the shipper's name,
    // records the first milestone, the carrier records the second on the driver's behalf, and
    // the driver states an arrival estimate. The shipper sees all of it except the carrier's note.
    // The same-category swap asked the driver to acknowledge the new set again.
    await open('/en/driver', 390);
    if ((await page.$(`[data-acknowledge="${bookingId}"]`)) !== null)
      await submit(`[data-acknowledge="${bookingId}"]`);
    await open(bookingPath('en', carrierOrg), 390);
    if ((await ready()) !== 'yes' || (await page.$('#dispatch-booking')) === null)
      throw new Error(`before dispatch the booking is not ready: ${await text('#dispatch')}`);
    const earliestShown = (await text('#dispatch-from')) ?? '';
    await submit('#dispatch-booking');
    check(
      'dispatch',
      earliestShown.includes('UTC') &&
        page.url().includes('aError=dispatch_refused') &&
        page.url().includes('aReason=too_early') &&
        ((await text('#error-summary')) ?? '').includes('too early') &&
        (await owner.query('SELECT 1 FROM trucker.trip WHERE booking_id = $1', [bookingId]))
          .rowCount === 0,
      `an early dispatch led to ${page.url()}`,
    );
    await owner.query('UPDATE trucker.security_setting SET dispatch_lead_hours = 72');
    try {
      await open(bookingPath('en', carrierOrg), 390);
      await submit('#dispatch-booking');
      const trips = await owner.query('SELECT id FROM trucker.trip WHERE booking_id = $1', [
        bookingId,
      ]);
      check(
        'dispatch',
        page.url().includes('aDone=dispatched') &&
          trips.rowCount === 1 &&
          (await page.$('#trip-facts')) !== null &&
          (await page.$('#cancel-booking')) === null &&
          (await page.$('#assign')) === null &&
          (await page.$('#on-behalf-form')) !== null,
        `dispatching led to ${page.url()}`,
      );
    } finally {
      await owner.query('UPDATE trucker.security_setting SET dispatch_lead_hours = 12');
    }
    await open('/en/driver', 390);
    const driverTrip = (await text(`[data-assignment="${bookingId}"]`)) ?? '';
    check(
      'dispatch',
      driverTrip.includes(pickupAddress) &&
        (await page.$(`[data-assignment="${bookingId}"] [data-shipper]`)) !== null &&
        !driverTrip.includes('1250.50') &&
        (await page.$(`[data-record-milestone="departed_for_pickup"]`)) !== null,
      `the dispatched driver's page shows: ${driverTrip.slice(0, 300)}`,
    );
    await submit('[data-record-milestone="departed_for_pickup"]');
    check(
      'dispatch',
      page.url().includes('aDone=recorded') &&
        (await page.$('[data-milestone="departed_for_pickup"][data-basis="observed"]')) !== null &&
        (await page.$('[data-record-milestone="arrived_at_pickup"]')) !== null,
      `recording the first milestone led to ${page.url()}`,
    );
    await open(bookingPath('en', carrierOrg), 390);
    await page.select('#on-behalf-reason', 'no_signal');
    await page.type('#on-behalf-note', 'Gate note 4471');
    await submit('#record-on-behalf');
    check(
      'dispatch',
      page.url().includes('aDone=recorded') &&
        (await page.$('[data-milestone="arrived_at_pickup"][data-basis="reported"]')) !== null &&
        ((await text('#trip-milestones')) ?? '').includes('Gate note 4471'),
      `recording on the driver's behalf led to ${page.url()}`,
    );
    await open('/en/driver', 390);
    const estimate = new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 16);
    await page.$eval(
      `#estimate-${bookingId}`,
      (input, value) => {
        input.value = value;
      },
      estimate,
    );
    await submit('[data-state-estimate]');
    await open(bookingPath('en', verifyOrg), 390);
    const shipperTrip = (await text('#trip')) ?? '';
    check(
      'dispatch',
      (await page.$('#trip-estimate[data-stated-as="driver"]')) !== null &&
        shipperTrip.includes(estimate.replace('T', ' ')) &&
        (await page.$('[data-milestone="arrived_at_pickup"][data-basis="reported"]')) !== null &&
        !shipperTrip.includes('Gate note 4471') &&
        (await page.$('#cancel-booking')) === null &&
        (await page.$('#on-behalf-form')) === null,
      `the shipper's trip shows: ${shipperTrip.slice(0, 300)}`,
    );
    // A problem reported by the driver (slice 17b): the carrier sees its description, the
    // shipper its type and state only; the form says to call the emergency number first.
    await open('/en/driver', 390);
    const emergencyShown = (await page.$(`#report-${bookingId} [data-emergency]`)) !== null;
    await page.select(`#report-${bookingId}-type`, 'breakdown');
    await page.type(`#report-${bookingId}-description`, 'Engine light 5521');
    await submit(`[data-report="report-${bookingId}"]`);
    const reportedShown = page.url().includes('aDone=reported');
    await open(bookingPath('en', carrierOrg), 390);
    const carrierCase = (await text('#trip-cases')) ?? '';
    await open(bookingPath('en', verifyOrg), 390);
    const shipperCase = (await text('#trip-cases')) ?? '';
    check(
      'dispatch',
      emergencyShown &&
        reportedShown &&
        carrierCase.includes('Breakdown') &&
        carrierCase.includes('Engine light 5521') &&
        shipperCase.includes('Breakdown') &&
        !shipperCase.includes('5521') &&
        (
          await owner.query(
            "SELECT 1 FROM trucker.trip_case WHERE booking_id = $1 AND kind = 'exception'",
            [bookingId],
          )
        ).rowCount === 1,
      `the reported problem shows: carrier ${carrierCase.slice(0, 200)}; shipper ${shipperCase.slice(0, 200)}`,
    );
    // Delivery (slice 18a) and undeliverable cargo (slice 18d, R-406): the driver records the
    // remaining milestones and a partial delivery with what fell short; the carrier's release is
    // refused while cargo is in custody. The shipper declares its authority and instructs
    // storage; the carrier offers its costs; the shipper approves, which decides no liability.
    // The carrier hands the cargo to a warehouse: custody moves only when the shipper confirms
    // the receipt. Then the truck and the driver are released. The shipper sees the outcome and
    // the case, never the releases.
    await open('/en/driver', 390);
    for (const step of ['loading_started', 'loaded_departed', 'arrived_at_delivery'])
      await submit(`[data-record-milestone="${step}"]`);
    await page.select(`#delivery-${bookingId}-outcome`, 'partly_delivered');
    await page.type(`#delivery-${bookingId}-receiver`, 'Fictional Receiver');
    await page.type(`#delivery-${bookingId}-remarks`, 'Two cartons refused 4410');
    await page.select(`#delivery-${bookingId}-short-reason`, 'receiver_refused');
    await page.type(`#delivery-${bookingId}-refusal`, 'Not ordered (fictional)');
    await page.type(`#delivery-${bookingId}-short-location`, 'On the truck at the gate');
    await page.type(`#delivery-${bookingId}-short-condition`, 'Sealed cartons');
    await page.type(`#delivery-${bookingId}-short-unit`, 'cartons');
    await page.type(`#delivery-${bookingId}-short-delivered`, '8');
    await page.type(`#delivery-${bookingId}-short-remaining`, '2');
    await submit(`[data-record-delivery="delivery-${bookingId}"]`);
    const outcomeRecorded =
      page.url().includes('aDone=recorded') &&
      (await page.$(`[data-assignment="${bookingId}"] [data-outcome="partly_delivered"]`)) !== null;
    await open(bookingPath('en', carrierOrg), 390);
    const custodyShown = (await page.$('#custody[data-custody="open"]')) !== null;
    const caseShown = (await page.$('#cargo-on-vehicle[data-on-vehicle="2"]')) !== null;
    await submit('[data-release="truck"]');
    const releaseRefused = page.url().includes('aError=custody_open');
    // The shipper: no instruction before an authority is declared; then storage is instructed.
    await open(bookingPath('en', verifyOrg), 390);
    const noAuthority =
      (await page.$('#cargo-issue')) !== null && (await page.$('#cargo-authorities-none')) !== null;
    await page.click('#cargo-declare [name="confirmContract"]');
    await page.type('#cargo-spend', '200.00');
    await page.type('#cargo-contact', 'Fictional duty desk, +99900000003');
    await page.type('#cargo-basis', 'Sale contract clause 4 (fictional)');
    await submit('[data-cargo="declare"]');
    const declared = page.url().includes('aDone=cargo_declared');
    await page.select('#cargo-action', 'temporary_storage');
    await page.type('#cargo-details', 'Nearest covered storage');
    await submit('[data-cargo="issue"]');
    const issued = page.url().includes('aDone=cargo_issued');
    await open(bookingPath('en', carrierOrg), 390);
    await page.select('#offer-cost0-kind', 'storage');
    await page.type('#offer-cost0-quantity', '2');
    await page.select('#offer-cost0-unit', 'day');
    await page.type('#offer-cost0-amount', '25');
    await submit('[data-cargo="offer"]');
    const costOffered = page.url().includes('aDone=cargo_offered');
    await open(bookingPath('en', verifyOrg), 390);
    const costShown = ((await text('#cargo-instructions')) ?? '').includes('50.00');
    await submit('[data-cargo="approve"]');
    const approved = page.url().includes('aDone=cargo_approved');
    await open(bookingPath('en', carrierOrg), 390);
    await submit('[data-cargo="start"]');
    await page.select('#handover-kind', 'warehouse');
    const instruction = await page.$eval('#handover-instruction option:last-child', (o) => o.value);
    await page.select('#handover-instruction', instruction);
    await page.type('#handover-quantity', '2');
    await page.type('#handover-condition', 'Sealed cartons');
    await page.type('#handover-by', 'Fictional Driver');
    await page.type('#handover-by-standing', 'Driver of the carrier');
    await page.type('#handover-to', 'Fictional Clerk');
    await page.type('#handover-to-standing', 'Clerk at the storage (fictional)');
    await page.type('#handover-place', 'Storage depot (fictional)');
    await submit('#record-handover');
    const handedOver = page.url().includes('aDone=handed_over');
    const pendingShown = (await page.$('#custody[data-custody="pending"]')) !== null;
    await submit('[data-release="truck"]');
    const stillRefused = page.url().includes('aError=custody_open');
    await open(bookingPath('en', verifyOrg), 390);
    await page.type('#cargo-handovers input[name="reference"]', 'Depot receipt 77');
    await submit('[data-cargo="confirm"]');
    const receiptConfirmed = page.url().includes('aDone=cargo_confirmed');
    await open(bookingPath('en', carrierOrg), 390);
    await submit('[data-cargo="complete"]');
    await submit('[data-release="truck"]');
    await submit('[data-release="driver"]');
    const releasedRows = await owner.query(
      'SELECT role FROM trucker.resource_release WHERE booking_id = $1 ORDER BY role',
      [bookingId],
    );
    const openEpisodes = await owner.query(
      'SELECT 1 FROM trucker.occupancy_episode WHERE booking_id = $1 AND closed_at IS NULL',
      [bookingId],
    );
    const costRows = await owner.query(
      `SELECT c.amount::text AS amount, c.interim_payer, c.final_liability FROM trucker.exception_cost c
       JOIN trucker.cargo_case k ON k.id = c.case_id WHERE k.booking_id = $1`,
      [bookingId],
    );
    // Proof of delivery (slice 18b): the driver sends a signature and a photo of the cargo; the
    // shipper sees it ready, opens a file and accepts it. Accepting releases nothing more.
    const podDir = mkdtempSync(path.join(tmpdir(), 'trucker-pod-files-'));
    const signatureFile = path.join(podDir, 'signature.png');
    const photoFile = path.join(podDir, 'cargo.jpg');
    writeFileSync(
      signatureFile,
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(512)]),
    );
    writeFileSync(photoFile, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(512)]));
    await open('/en/driver', 390);
    await (await page.$('#pod-file-signature')).uploadFile(signatureFile);
    await (await page.$('#pod-file-cargo_photo')).uploadFile(photoFile);
    await submit('[data-pod-capture="true"]');
    const podSent = page.url().includes('aDone=pod_captured');
    await open(bookingPath('en', verifyOrg), 390);
    const podReady = (await page.$('#pod[data-pod="ready_for_review"]')) !== null;
    const fileHref = await page.$eval('#pod-versions a', (link) => link.getAttribute('href'));
    const fileStatus = await page.evaluate(async (href) => (await fetch(href)).status, fileHref);
    await submit('[data-pod-decision="accepted"]');
    const podAccepted =
      page.url().includes('aDone=pod_accepted') &&
      (await page.$('#pod[data-pod="accepted"]')) !== null;
    check(
      'delivery',
      podSent && podReady && fileStatus === 200 && podAccepted,
      `proof of delivery: sent ${podSent}, ready ${podReady}, file ${fileStatus}, accepted ${podAccepted}`,
    );
    await open(bookingPath('en', verifyOrg), 390);
    const shipperDelivery = (await text('#delivery-facts')) ?? '';
    check(
      'delivery',
      outcomeRecorded &&
        custodyShown &&
        caseShown &&
        releaseRefused &&
        noAuthority &&
        declared &&
        issued &&
        costOffered &&
        costShown &&
        approved &&
        handedOver &&
        pendingShown &&
        stillRefused &&
        receiptConfirmed &&
        releasedRows.rows.map((row) => row.role).join() === 'driver,truck' &&
        openEpisodes.rowCount === 0 &&
        costRows.rows.length === 1 &&
        costRows.rows[0].amount === '50.00' &&
        costRows.rows[0].interim_payer === 'instructing_party' &&
        costRows.rows[0].final_liability === null &&
        shipperDelivery.includes('Partly delivered') &&
        shipperDelivery.includes('4410') &&
        (await page.$('#releases')) === null,
      `delivery: outcome ${outcomeRecorded}, custody ${custodyShown}, case ${caseShown}, refused ${releaseRefused}, no authority ${noAuthority}, declared ${declared}, issued ${issued}, offered ${costOffered}, cost ${costShown}, approved ${approved}, handed ${handedOver}, pending ${pendingShown}, still refused ${stillRefused}, receipt ${receiptConfirmed}, released ${releasedRows.rows.map((row) => row.role)}, costs ${JSON.stringify(costRows.rows)}, shipper ${shipperDelivery.slice(0, 200)}`,
    );
    for (const locale of locales) {
      await open(bookingPath(locale, carrierOrg), 390);
      await inspect(locale, 'trip for carrier');
      await open(bookingPath(locale, verifyOrg), 390);
      await inspect(locale, 'trip for shipper');
      await open(`/${locale}/driver`, 390);
      await inspect(locale, 'driver trip');
    }

    // A second booking, left unassigned. The real clock cannot be moved here, so the migration
    // role moves this booking's own acceptance and deadline back 13 hours, consistently, with
    // the snapshot guard set aside for that one statement. The deadline has then passed: both
    // sides see it, the shipper records a decision to wait, and nothing else changes.
    const waitShipment = await makeShipment('wait');
    await post(
      `/organisations/${verifyOrg}/shipments/${waitShipment}/publish`,
      {
        version: 1,
        cargoCategory: 'general_dry',
        equipmentType: 'curtain_side',
        dangerousGoods: false,
        pickupArea: 'North industrial area',
        deliveryArea: 'Port district',
        quotationDeadline: { local: zoned(24, 4) },
      },
      'wait-publish',
    );
    await post(
      `/organisations/${verifyOrg}/shipments/${waitShipment}/quotation-terms`,
      { version: 0, currency: 'XTS' },
      'wait-terms',
    );
    const waitQuote = await post(
      `/organisations/${carrierOrg}/discovery/shipments/${waitShipment}/quotations`,
      {
        amount: '900',
        inclusions: { fictional_item_1: true, fictional_item_2: false, fictional_item_3: true },
        validUntil: { local: zoned(6, 4) },
        earliestPickup: { local: zoned(49, 4) },
      },
      'wait-quote',
    );
    const waitAccepted = await post(
      `/organisations/${verifyOrg}/quotations/${waitQuote.body.quotation?.id}/accept`,
      { version: 1 },
      'wait-accept',
    );
    const waitBooking = waitAccepted.body.booking?.id;
    await owner.query('BEGIN');
    try {
      await owner.query('ALTER TABLE trucker.booking DISABLE TRIGGER booking_guard');
      await owner.query(
        `UPDATE trucker.booking SET accepted_at = accepted_at - interval '13 hours',
                assignment_due_at = assignment_due_at - interval '13 hours' WHERE id = $1`,
        [waitBooking],
      );
      await owner.query('ALTER TABLE trucker.booking ENABLE TRIGGER booking_guard');
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
    await open(bookingPath('en', verifyOrg, waitBooking), 390);
    check(
      'assignment',
      waitAccepted.status === 200 &&
        (await page.$('[data-flag="overdue"]')) !== null &&
        (await page.$('#wait-for-carrier')) !== null &&
        (await page.$('#resources-hidden')) !== null,
      `the overdue booking page (${waitAccepted.status}) does not offer the decision to wait`,
    );
    await inspect('en', 'overdue');
    await submit('#wait-for-carrier');
    check(
      'assignment',
      page.url().includes('aDone=recorded') &&
        (await page.$('#wait-recorded')) !== null &&
        (await page.$('#wait-for-carrier')) === null &&
        (await asgRows('booking_wait_decision', 'booking_id = $1', waitBooking)).length === 1 &&
        (await asgRows('resource_reservation', 'booking_id = $1', waitBooking)).length === 0 &&
        (await asgRows('booking_confirmation', 'booking_id = $1', waitBooking)).length === 0,
      `recording the wait led to ${page.url()}`,
    );
    await open(bookingPath('en', carrierOrg, waitBooking), 390);
    check(
      'assignment',
      (await page.$('[data-flag="overdue"]')) !== null &&
        (await page.$('#wait-recorded')) !== null &&
        (await page.$('#wait-for-carrier')) === null &&
        (await page.$('#assign-form')) !== null,
      'the carrier is not shown the overdue booking with the wait decision',
    );
    await inspect('en', 'overdue for carrier');

    // Cancellation: the API commits but its response is lost. The retry reconciles the
    // terminal result without another cancellation or audit event.
    await open(bookingPath('en', carrierOrg, waitBooking), 390);
    await page.select('#cancel-reason', 'other');
    await page.type('#cancel-note', 'Private cancellation note 7821');
    relay.mode = 'lose';
    await submit('#cancel-booking-submit');
    relay.mode = 'pass';
    check(
      'cancellation',
      relay.lost.at(-1)?.includes(`/bookings/${waitBooking}/cancel -> 200`),
      'the relay did not lose a committed cancellation response',
    );
    await open(`${bookingPath('en', carrierOrg, waitBooking)}?aError=cancel_unconfirmed`, 390);
    check(
      'cancellation',
      (await page.$('#cancellation-record')) !== null &&
        (await page.$('#assign-form')) === null &&
        (await ready()) === 'no',
      'a cancelled booking still offers assignment or dispatch',
    );
    await submit('#cancel-booking-submit');
    const cancelledRows = await owner.query(
      'SELECT * FROM trucker.booking_cancellation WHERE booking_id=$1',
      [waitBooking],
    );
    const cancellationEvents = await owner.query(
      "SELECT organisation_id FROM trucker.audit_entry WHERE record_id=$1 AND action='booking.cancelled'",
      [waitBooking],
    );
    check(
      'cancellation',
      cancelledRows.rowCount === 1 && cancellationEvents.rowCount === 2,
      'a cancellation retry duplicated its record or either party history entry',
    );
    check(
      'cancellation',
      (await text('#cancellation-record')).includes('Private cancellation note 7821'),
      'the cancelling party cannot read its private note',
    );
    for (const locale of locales) {
      await open(bookingPath(locale, carrierOrg, waitBooking), 390);
      await inspect(locale, 'cancelled booking');
    }
    await open(bookingPath('ur', verifyOrg, waitBooking), 390);
    check(
      'cancellation',
      !(await text('body')).includes('Private cancellation note 7821'),
      'the private cancellation note leaked to the other party',
    );
    relay.lost.length = 0;

    // ------------------------------------------------------------------------------------
    // Individual accounts and truck owners (slice 21): the same person opens a personal
    // account in the browser, applies as a truck owner, is verified by staff through the
    // staff API, registers the one truck the account may hold, and becomes its driver.
    // ------------------------------------------------------------------------------------
    for (const locale of locales) {
      await open(`/${locale}/organisations/new?kind=individual`, 390);
      await inspect(locale, 'personal account form');
    }
    await open('/en/organisations/new', 390);
    await submit('#switch-kind');
    await page.type('#legalName', 'Individual Fixture Person (fictional)');
    await page.select('#countryCode', 'XA');
    await page.type('#registrationNumber', `IND-${stamp}`);
    await submit('#organisation-new-form button[type=submit]');
    const personalOrg = /organisations\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    const personalRead = await urApi(`/organisations/${personalOrg}`);
    check(
      'individual',
      personalRead.body.organisation?.kind === 'individual',
      `creating a personal account led to ${page.url()} with kind ${personalRead.body.organisation?.kind}`,
    );
    // A second one is refused, with a message.
    await open('/en/organisations/new?kind=individual', 390);
    await page.type('#legalName', 'Individual Fixture Person (fictional)');
    await page.select('#countryCode', 'XA');
    await page.type('#registrationNumber', `IND2-${stamp}`);
    await submit('#organisation-new-form button[type=submit]');
    check(
      'individual',
      ((await text('#error-summary')) ?? '').includes(
        messagesFor('en').org.errors.personal_account_exists,
      ),
      `a second personal account answered ${page.url()}`,
    );
    // The carrier page of a personal account applies for the truck-owner capability.
    const ownerPath = (locale) => `/${locale}/organisations/${personalOrg}/carrier`;
    await open(ownerPath('en'), 390);
    await page.type('#ev-identity_evidence-documentNumber', 'ID-OWN-1');
    await page.type('#ev-owner_operator_permit-documentNumber', 'OP-OWN-2');
    await page.click('#service-country-XA');
    await page.click('#service-equipment-curtain_side');
    await page.click('#declaration');
    await submit('#submit-carrier');
    const ownerOverview = (await urApi(`/organisations/${personalOrg}/verification`)).body
      .verification;
    check(
      'individual',
      ownerOverview.applications.length === 1 &&
        ownerOverview.applications[0].capability === 'carry_as_owner_operator',
      `the personal account's carrier page applied for ${ownerOverview.applications[0]?.capability}`,
    );
    const ownerQueue = await (
      await fetch(`${apiOrigin}/staff/verification`, {
        headers: { authorization: `Bearer ${reviewerToken}` },
      })
    ).json();
    const ownerDecision = await fetch(
      `${apiOrigin}/staff/verification/${ownerOverview.applications[0].id}/decision`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${reviewerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          decision: 'verified',
          reason: 'evidence_accepted',
          noConflict: true,
        }),
      },
    );
    check(
      'individual',
      ownerDecision.status === 200 &&
        ownerQueue.applications.some(
          (entry) => entry.organisationId === personalOrg && entry.accountKind === 'individual',
        ),
      `staff saw and decided the truck owner's application: ${ownerDecision.status}`,
    );
    // The fleet of a truck owner: one truck; nobody is invited; the owner is the driver.
    const ownerFleet = (locale) => `/${locale}/organisations/${personalOrg}/fleet`;
    const registerOwn = async (plate) => {
      await open(ownerFleet('en'), 390);
      await page.select('#kind', 'truck');
      await page.select('#category', 'fictional_rigid_truck');
      await page.select('#equipmentType', 'curtain_side');
      await page.select('#registrationCountry', 'XA');
      await page.type('#registrationNumber', plate);
      await submit('#register-vehicle');
    };
    await registerOwn(`OW${stamp}`);
    await registerOwn(`OX${stamp}`);
    const ownVehicles = (await urApi(`/organisations/${personalOrg}/fleet`)).body.fleet.vehicles;
    check(
      'individual',
      ownVehicles.length === 1 &&
        ((await text('#error-summary')) ?? '').includes(
          messagesFor('en').fleet.errors.owner_fleet_limit,
        ) &&
        (await page.$('#invite-form')) === null &&
        (await page.$('#become-own-driver')) !== null,
      `a truck owner's fleet page holds ${ownVehicles.length} trucks after two registrations`,
    );
    // The person still drives for the company carrier: becoming their own driver is refused
    // with the reason. After leaving, it is recorded, once.
    await submit('#become-own-driver');
    const stillCompany = ((await text('#error-summary')) ?? '').includes(
      messagesFor('en').fleet.errors.driver_affiliation_exists,
    );
    const mineNow = (
      await (
        await fetch(`${apiOrigin}/me/driver`, { headers: { authorization: `Bearer ${urToken}` } })
      ).json()
    ).driver.affiliation;
    const leftCompany = await post(
      `/me/driver/affiliations/${mineNow?.id}/leave`,
      { version: mineNow?.version },
      'leave-for-own',
    );
    await open(ownerFleet('en'), 390);
    await submit('#become-own-driver');
    const ownDrivers = (await urApi(`/organisations/${personalOrg}/fleet`)).body.fleet.drivers;
    check(
      'individual',
      stillCompany &&
        leftCompany.status === 200 &&
        ownDrivers.length === 1 &&
        ownDrivers[0].status === 'active' &&
        (await page.$('#become-own-driver')) === null &&
        (await page.$('#own-driver')) !== null,
      `becoming the driver of the own account: refused first ${stillCompany}, left ${leftCompany.status}, drivers ${ownDrivers.length}`,
    );
    for (const locale of locales) {
      await open(ownerFleet(locale), 390);
      await inspect(locale, 'truck owner fleet');
    }

    // ------------------------------------------------------------------------------------
    // Shipment roles and authority (slice 22): the personal account becomes an organiser,
    // asks the shipper for authority by its account code, the shipper accepts, the organiser
    // names the shipper as the customer of a draft and publishes it, and the shipper sees it.
    // ------------------------------------------------------------------------------------
    const organiseApplied = await post(
      `/organisations/${personalOrg}/verification/applications`,
      {
        version: (await urApi(`/organisations/${personalOrg}/verification`)).body.verification
          .organisation.version,
        declarationAccepted: true,
        declarationLanguage: 'en',
        capability: 'organise',
        evidence: [
          { documentType: 'identity_evidence', documentNumber: 'ID-ORG-1', issuingCountry: 'XA' },
        ],
      },
      'organise-apply',
    );
    const organiseApplication = organiseApplied.body.verification?.applications?.[0];
    const organiseDecision = await fetch(
      `${apiOrigin}/staff/verification/${organiseApplication?.id}/decision`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${reviewerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          decision: 'verified',
          reason: 'evidence_accepted',
          noConflict: true,
        }),
      },
    );
    const authPath = (locale, org) => `/${locale}/organisations/${org}/authorities`;
    await open(`/en/organisations/${verifyOrg}`, 390);
    await submit('#open-authorities');
    const customerCode = (await text('#account-code')) ?? '';
    check(
      'authority',
      organiseDecision.status === 200 &&
        page.url() === `${origin}${authPath('en', verifyOrg)}` &&
        /^TR[0-9A-F]{10}$/.test(customerCode) &&
        (await page.$('#request-form')) === null,
      `the customer's authorities page showed code ${customerCode} after ${organiseDecision.status}`,
    );
    // A wrong code is refused with a message that says nothing about any account.
    await open(authPath('en', personalOrg), 390);
    await page.type('#customerCode', 'TR0000000000');
    await submit('#request-authority');
    const wrongCode = ((await text('#authority-error')) ?? '').includes(
      messagesFor('en').roles.errors.account_code_not_found,
    );
    await page.type('#customerCode', customerCode);
    await submit('#request-authority');
    check(
      'authority',
      wrongCode &&
        ((await text('#authority-done')) ?? '').includes(messagesFor('en').roles.done.requested) &&
        (await page.$('[data-status="requested"][data-role="organiser"]')) !== null,
      `asking for authority led to ${page.url()}`,
    );
    for (const locale of locales) {
      await open(authPath(locale, verifyOrg), 390);
      await inspect(locale, 'authority requested');
    }
    // The customer accepts and chooses what it allows.
    await open(authPath('en', verifyOrg), 390);
    await page.click('[data-status="requested"] input[name="mayPublish"]');
    await page.click('[data-status="requested"] input[name="feePayerAgreed"]');
    await submit('[data-status="requested"] [data-accept]');
    const granted = (await urApi(`/organisations/${personalOrg}/authorities`)).body.overview
      .authorities[0];
    check(
      'authority',
      granted?.status === 'active' &&
        granted.mayPublish === true &&
        granted.feePayerAgreed === true &&
        (await page.$('[data-status="active"] [data-end]')) !== null,
      `after the customer accepted, the authority is ${granted?.status}`,
    );
    // The organiser names the customer on a draft in the browser, then publishes it.
    const arrangedShipment = await makeShipment('arr', personalOrg);
    const arrangedPath = (locale) =>
      `/${locale}/organisations/${personalOrg}/shipments/${arrangedShipment}`;
    await open(arrangedPath('en'), 390);
    await page.select('#customerAuthorityId', granted.id);
    await page.type('#receiverName', 'Receiver Fixture (fictional)');
    await page.select('#freightPayer', 'receiver');
    await submit('#save-roles');
    const savedParties = (
      await urApi(`/organisations/${personalOrg}/shipments/${arrangedShipment}/parties`)
    ).body.parties;
    check(
      'authority',
      (await page.$('#roles-saved')) !== null &&
        savedParties?.customer?.id === verifyOrg &&
        savedParties.receiver?.name === 'Receiver Fixture (fictional)' &&
        savedParties.freightPayer === 'receiver' &&
        savedParties.feePayer === 'customer',
      `saving the roles led to ${page.url()} with customer ${savedParties?.customer?.id}`,
    );
    for (const locale of locales) {
      await open(arrangedPath(locale), 390);
      await inspect(locale, 'shipment roles');
    }
    // Commission (slice 23): the organiser states it on the draft, in the browser.
    await open(arrangedPath('en'), 390);
    await page.select('#commissionOption', 'percentage');
    await page.type('#commissionPercent', '7.5');
    await submit('#save-commission');
    const savedCommission = (
      await urApi(`/organisations/${personalOrg}/shipments/${arrangedShipment}/commission`)
    ).body;
    check(
      'commission',
      (await page.$('#commission-saved')) !== null &&
        savedCommission.commission?.option === 'percentage' &&
        savedCommission.commission.basisPoints === 750 &&
        ((await text('#commission-current')) ?? '').includes('7.5%'),
      `saving 7.5% led to ${page.url()} with ${JSON.stringify(savedCommission.commission)}`,
    );
    // More than the limit is refused where it was typed, and nothing changes.
    await page.$eval('#commissionPercent', (input) => (input.value = ''));
    await page.type('#commissionPercent', '26');
    await submit('#save-commission');
    check(
      'commission',
      ((await text('#commission-error')) ?? '').includes(
        messagesFor('en').commission.errors.commissionPercentage_out_of_range,
      ) &&
        (await urApi(`/organisations/${personalOrg}/shipments/${arrangedShipment}/commission`)).body
          .commission?.basisPoints === 750,
      `26% answered ${page.url()}`,
    );
    // The hint gives the limit of the financial settings in force (slice 24): 25% by default.
    await open(arrangedPath('en'), 390);
    check(
      'settings',
      ((await text('#commissionPercent-hint')) ?? '').includes('0.01 to 25.'),
      `the commission hint reads: ${await text('#commissionPercent-hint')}`,
    );
    for (const locale of locales) {
      await open(arrangedPath(locale), 390);
      await inspect(locale, 'shipment commission');
    }
    const arrangedPublished = await post(
      `/organisations/${personalOrg}/shipments/${arrangedShipment}/publish`,
      {
        version: 1,
        cargoCategory: 'general_dry',
        equipmentType: 'curtain_side',
        dangerousGoods: false,
        pickupArea: 'North industrial area',
        deliveryArea: 'Port district',
        quotationDeadline: { local: zoned(24, 4) },
      },
      'arranged-publish',
    );
    await open(arrangedPath('en'), 390);
    const rolesFixed = (await page.$('#roles-form')) === null && (await page.$('#roles')) !== null;
    const commissionFixed =
      (await page.$('#commission-form')) === null && (await page.$('#commission')) !== null;
    // The carrier is told the commission before it prices, is refused without accepting the
    // exact figures, and is shown them; ticking and sending again makes the quotation.
    const arrangedTerms = await post(
      `/organisations/${personalOrg}/shipments/${arrangedShipment}/quotation-terms`,
      { version: 0, currency: 'XTS' },
      'arranged-terms',
    );
    const arrangedQuote = (locale, query = '') =>
      `/${locale}/organisations/${carrierOrg}/discover/${arrangedShipment}${query}`;
    const commissionRows = async () =>
      (
        await owner.query(
          `SELECT c.commission_amount::text AS commission, c.net_amount::text AS net
           FROM trucker.quotation q JOIN trucker.quotation_commission c ON c.quotation_id = q.id
           WHERE q.shipment_id = $1`,
          [arrangedShipment],
        )
      ).rows;
    await open(arrangedQuote('en'), 390);
    const toldBefore = (await text('#commission-terms')) ?? '';
    const offeredBefore = (await page.$('#commissionAccept')) !== null;
    await fillQuotation('1000');
    await submit('#submit-quotation');
    const askedText = (await text('#commission-acceptance')) ?? '';
    check(
      'commission',
      commissionFixed &&
        arrangedTerms.status === 200 &&
        toldBefore.includes('7.5%') &&
        !offeredBefore &&
        page.url().includes('commission_acceptance_required') &&
        askedText.includes('75.00') &&
        askedText.includes('925.00') &&
        (await commissionRows()).length === 0,
      `a quotation without acceptance answered ${page.url()} and asked: ${askedText.slice(0, 160)}`,
    );
    for (const locale of locales) {
      await open(
        arrangedQuote(locale, '?qError=commission_acceptance_required&cc=75.00&cn=925.00'),
        390,
      );
      await inspect(locale, 'commission acceptance');
    }
    await open(
      arrangedQuote('en', '?qError=commission_acceptance_required&cc=75.00&cn=925.00'),
      390,
    );
    await fillQuotation('1000');
    await page.click('#commissionAccept');
    await submit('#submit-quotation');
    const ownCommission = await page.evaluate(() => ({
      commission: document.querySelector('#own-quotation-commission [data-commission]')?.dataset
        .commission,
      net: document.querySelector('#own-quotation-commission [data-net]')?.dataset.net,
    }));
    check(
      'commission',
      page.url().includes('qDone=submitted') &&
        ownCommission.commission === '75.00' &&
        ownCommission.net === '925.00' &&
        JSON.stringify(await commissionRows()) === '[{"commission":"75.00","net":"925.00"}]',
      `after accepting, ${page.url()} shows ${JSON.stringify(ownCommission)} with ${JSON.stringify(await commissionRows())}`,
    );
    await inspect('en', 'commission accepted');
    // The customer reads the quotation: the shipping price, and no commission anywhere.
    await open(`/en/organisations/${verifyOrg}/shipments/${arrangedShipment}/quotations`, 390);
    const customerSees = await page.evaluate(() => document.body.innerText);
    check(
      'commission',
      customerSees.includes('1000.00') && !/commission|925\.00|75\.00/i.test(customerSees),
      `the customer's quotation page reads: ${customerSees.slice(0, 200)}`,
    );

    // Price breakdown and freight terms (slice 25). The customer accepts the arranged quotation;
    // each role then sees only its own figures.
    const arrangedQuotation = (
      await owner.query('SELECT id FROM trucker.quotation WHERE shipment_id = $1', [
        arrangedShipment,
      ])
    ).rows[0].id;
    await open(`/en/organisations/${verifyOrg}/shipments/${arrangedShipment}/quotations`, 390);
    const singleMethod = (await page.$('input[name="freightMethod"]')) === null;
    await submit(`[data-accept="${arrangedQuotation}"]`);
    const arrangedBooking = (
      await owner.query('SELECT id FROM trucker.booking WHERE shipment_id = $1', [arrangedShipment])
    ).rows[0]?.id;
    const arrangedBookingPath = (locale, org) =>
      `/${locale}/organisations/${org}/bookings/${arrangedBooking}`;
    const moneyIn = (scope) =>
      page.evaluate(
        (selector) =>
          Object.fromEntries(
            [...document.querySelectorAll(selector)].map((item) => [
              item.dataset.money,
              item.textContent.trim(),
            ]),
          ),
        `${scope} [data-money]`,
      );
    await open(arrangedBookingPath('en', verifyOrg), 390);
    const customerMoney = await moneyIn('main');
    const customerText = await page.evaluate(() => document.body.innerText);
    await inspect('en', 'booking customer price');
    await open(arrangedBookingPath('en', carrierOrg), 390);
    const carrierMoney = await moneyIn('main');
    await inspect('en', 'booking carrier price');
    check(
      'price',
      singleMethod &&
        arrangedBooking !== undefined &&
        customerMoney.transport === '1000.00 XTS' &&
        (customerMoney.fee ?? '').startsWith('30.00 XTS') &&
        customerMoney.total === '1030.00 XTS' &&
        customerMoney.commission === undefined &&
        customerMoney.net === undefined &&
        !/925\.00|75\.00/.test(customerText) &&
        carrierMoney.commission === '75.00 XTS' &&
        carrierMoney.net === '925.00 XTS' &&
        carrierMoney.fee === undefined &&
        carrierMoney.total === undefined,
      `the customer saw ${JSON.stringify(customerMoney)}, the carrier ${JSON.stringify(carrierMoney)}`,
    );
    // Trucker's fee (slice 26): the customer, who pays it, is shown the amount, the reference
    // to quote and the deadline; the carrier only whether it is settled, never the reference.
    const feeReference = (
      await owner.query('SELECT reference FROM trucker.booking_fee WHERE booking_id = $1', [
        arrangedBooking,
      ])
    ).rows[0]?.reference;
    const feeShown = () =>
      page.evaluate(() => ({
        status: document.querySelector('.fee-payment')?.dataset.feeStatus ?? null,
        reference: document.querySelector('[data-fee-reference]')?.textContent.trim() ?? null,
        amount: document.querySelector('[data-fee-amount]')?.textContent.trim() ?? null,
        due: document.querySelector('[data-fee-due]') !== null,
        text: document.body.innerText,
      }));
    for (const locale of locales) {
      await open(arrangedBookingPath(locale, verifyOrg), 390);
      await inspect(locale, 'booking fee due');
    }
    await open(arrangedBookingPath('en', verifyOrg), 390);
    const customerFee = await feeShown();
    await open(arrangedBookingPath('en', carrierOrg), 390);
    const carrierFee = await feeShown();
    check(
      'fee',
      typeof feeReference === 'string' &&
        customerFee.status === 'due' &&
        customerFee.reference === feeReference &&
        customerFee.amount === '30.00 XTS' &&
        customerFee.due &&
        customerFee.text.includes(messagesFor('en').book.feePayment.howToPay) &&
        carrierFee.status === 'due' &&
        carrierFee.reference === null &&
        carrierFee.amount === null &&
        !carrierFee.text.includes(feeReference),
      `the customer saw ${JSON.stringify({ ...customerFee, text: undefined })}, the carrier ${JSON.stringify({ ...carrierFee, text: undefined })}`,
    );
    // Online payment (slice 27): the customer goes to the provider's page (here the development
    // stand-in), pays, and comes back. The fee shows paid only because the stand-in's signed
    // notification was recorded; a receipt is shown. The carrier sees neither.
    await open(arrangedBookingPath('en', verifyOrg), 390);
    await submit('#pay-online-button');
    const standInUrl = page.url();
    for (const locale of locales) {
      await open(standInUrl.replace(`${origin}/en/`, `/${locale}/`).replace(origin, ''), 390);
      await inspect(locale, 'stand-in checkout');
    }
    await open(standInUrl.replace(origin, ''), 390);
    const standInShown =
      (await page.$('[data-state="stand-in-checkout"][data-status="open"]')) !== null &&
      ((await text('#stand-in-amount')) ?? '').includes('30.00 XTS');
    await submit('#stand-in-pay');
    const backAfterPay = page.url();
    const paidOnline = await page.evaluate(() => ({
      status: document.querySelector('.fee-payment')?.dataset.feeStatus ?? null,
      notice: document.querySelector('#payment-notice')?.dataset.confirmed ?? null,
      receipts: [...document.querySelectorAll('[data-receipt]')].map(
        (item) => item.dataset.receipt,
      ),
      payButton: document.querySelector('#pay-online-button') !== null,
    }));
    await inspect('en', 'booking paid online');
    const receiptRows = (
      await owner.query('SELECT number, method FROM trucker.fee_receipt WHERE booking_id = $1', [
        arrangedBooking,
      ])
    ).rows;
    await open(arrangedBookingPath('en', carrierOrg), 390);
    const carrierAfter = await page.evaluate(() => document.body.innerText);
    check(
      'payment',
      standInUrl.startsWith(`${origin}/en/payments/test/tchk_`) &&
        standInShown &&
        backAfterPay.startsWith(`${origin}${arrangedBookingPath('en', verifyOrg)}?payment=paid`) &&
        paidOnline.status === 'paid' &&
        paidOnline.notice === 'true' &&
        !paidOnline.payButton &&
        receiptRows.length === 1 &&
        receiptRows[0].method === 'online' &&
        JSON.stringify(paidOnline.receipts) === JSON.stringify([receiptRows[0].number]) &&
        !carrierAfter.includes(receiptRows[0].number),
      `online payment: stand-in ${standInUrl}, back at ${backAfterPay}, shown ${JSON.stringify(paidOnline)}, receipts ${JSON.stringify(receiptRows)}`,
    );
    // The stand-in's page refuses a second payment of the same checkout.
    await open(standInUrl.replace(origin, ''), 390);
    check(
      'payment',
      (await page.$('#stand-in-closed')) !== null && (await page.$('#stand-in-pay')) === null,
      'the stand-in offers to pay a checkout already paid',
    );
    // Refunds (slice 28): money owed back on this booking (a fictional record that it was paid
    // twice) is partly returned through the stand-in by two administrators. The customer sees
    // how much is back; the carrier sees nothing of it.
    const owedRow = (
      await owner.query(
        `INSERT INTO trucker.fee_refund
           (booking_id, payment_id, reason, currency_code, minor_units, amount, status, recorded_at)
         SELECT p.booking_id, p.id, 'duplicate_payment', p.currency_code, p.minor_units, p.amount,
                'pending', now()
         FROM trucker.fee_payment p WHERE p.booking_id = $1 AND p.status = 'approved'
         RETURNING id`,
        [arrangedBooking],
      )
    ).rows[0];
    const asker = await feeAdmin();
    const approver = await feeAdmin();
    const refundAsked = await asStaff(
      asker,
      'POST',
      '/staff/refunds',
      {
        refundId: owedRow?.id,
        amount: '10.00',
        method: 'provider',
        note: 'Paid twice (fictional)',
      },
      `refund-${randomUUID()}`,
    );
    const approvedRefund = await asStaff(
      approver,
      'POST',
      `/staff/refunds/${refundAsked.body.refund?.id}/decision`,
      { version: refundAsked.body.refund?.version, decision: 'approve' },
    );
    const sentRefund = await asStaff(
      asker,
      'POST',
      `/staff/refunds/${refundAsked.body.refund?.id}/submit`,
      {
        version: approvedRefund.body.refund?.version,
      },
    );
    for (const locale of locales) {
      await open(arrangedBookingPath(locale, verifyOrg), 390);
      await inspect(locale, 'booking refund');
    }
    await open(arrangedBookingPath('en', verifyOrg), 390);
    const refundLine = (await text('[data-fee-refunds]')) ?? '';
    await open(arrangedBookingPath('en', carrierOrg), 390);
    const carrierRefund = await page.$('[data-fee-refunds]');
    const feeMessages = messagesFor('en').book.feePayment;
    check(
      'refund',
      refundAsked.status === 201 &&
        approvedRefund.status === 200 &&
        sentRefund.status === 200 &&
        sentRefund.body.outcome === 'completed' &&
        refundLine.includes(feeMessages.refundStatus.partly_refunded) &&
        refundLine.includes(feeMessages.refundedSoFar) &&
        refundLine.includes('10.00') &&
        carrierRefund === null,
      `refund: ${refundAsked.status}/${approvedRefund.status}/${sentRefund.status} ${sentRefund.body.outcome}; the customer saw "${refundLine}"; the carrier saw it: ${carrierRefund !== null}`,
    );
    // The organiser sees the booked price on its own shipment.
    for (const locale of locales) {
      await open(arrangedPath(locale), 390);
      await inspect(locale, 'booked price');
    }
    await open(arrangedPath('en'), 390);
    const organiserMoney = await moneyIn('#booked-price');
    check(
      'price',
      (organiserMoney.commission ?? '').includes('75.00') &&
        (organiserMoney.net ?? '').includes('925.00') &&
        organiserMoney.fee === undefined,
      `the organiser saw ${JSON.stringify(organiserMoney)}`,
    );

    // A quotation offering two freight methods: the customer chooses one when accepting.
    const freightShipment = await makeShipment('freight');
    const freightPublished = await post(
      `/organisations/${verifyOrg}/shipments/${freightShipment}/publish`,
      {
        version: 1,
        cargoCategory: 'general_dry',
        equipmentType: 'curtain_side',
        dangerousGoods: false,
        pickupArea: 'North industrial area',
        deliveryArea: 'Port district',
        quotationDeadline: { local: zoned(24, 4) },
      },
      'freight-publish',
    );
    const freightTerms = await post(
      `/organisations/${verifyOrg}/shipments/${freightShipment}/quotation-terms`,
      { version: 0, currency: 'XTS' },
      'freight-terms',
    );
    const freightQuote = (locale) =>
      `/${locale}/organisations/${carrierOrg}/discover/${freightShipment}`;
    await open(freightQuote('en'), 390);
    await fillQuotation('500');
    await page.click('#freight-cash_on_delivery');
    await page.$eval('#freightDueDays', (input) => (input.value = ''));
    await page.type('#freightDueDays', '10');
    await submit('#submit-quotation');
    const offered = await page
      .$eval('#own-quotation-facts [data-freight]', (item) => item.dataset.freight)
      .catch(() => null);
    for (const locale of locales) {
      await open(freightQuote(locale), 390);
      await inspect(locale, 'quotation freight');
    }
    const freightQuotation = (
      await owner.query('SELECT id FROM trucker.quotation WHERE shipment_id = $1', [
        freightShipment,
      ])
    ).rows[0]?.id;
    const freightQuotes = (locale) =>
      `/${locale}/organisations/${verifyOrg}/shipments/${freightShipment}/quotations`;
    for (const locale of locales) {
      await open(freightQuotes(locale), 390);
      await inspect(locale, 'freight choice');
    }
    // Accepting without a choice is refused, and nothing is booked.
    await open(freightQuotes('en'), 390);
    await submit(`[data-accept="${freightQuotation}"]`);
    const unchosen =
      page.url().includes('freightMethod') &&
      (await owner.query('SELECT 1 FROM trucker.booking WHERE shipment_id = $1', [freightShipment]))
        .rowCount === 0;
    await open(freightQuotes('en'), 390);
    await page.click(`#freight-${freightQuotation}-cash_on_delivery`);
    await submit(`[data-accept="${freightQuotation}"]`);
    const fixed = (
      await owner.query(
        'SELECT freight_method AS m, freight_due_rule AS r FROM trucker.booking WHERE shipment_id = $1',
        [freightShipment],
      )
    ).rows[0];
    const freightLine = await page
      .$eval('#booking [data-freight]', (item) => item.dataset.freight)
      .catch(() => null);
    check(
      'price',
      freightPublished.status === 200 &&
        freightTerms.status === 200 &&
        offered === 'cash_on_delivery bank_transfer' &&
        unchosen &&
        fixed?.m === 'cash_on_delivery' &&
        fixed?.r === 'on_delivery' &&
        freightLine === 'cash_on_delivery',
      `freight: offered ${offered}, refused without a choice ${unchosen}, fixed ${JSON.stringify(fixed)}, shown ${freightLine} at ${page.url()}`,
    );

    // Commission contracts (slice 23b): the organiser proposes on its contracts page, the
    // carrier accepts on its own; a shipment then takes each carrier's contract commission.
    const contractsPath = (locale, org) => `/${locale}/organisations/${org}/contracts`;
    const carrierCode = (await urApi(`/organisations/${carrierOrg}/commission-contracts`)).body
      .contracts.accountCode;
    await open(contractsPath('en', personalOrg), 390);
    await page.type('#carrierCode', carrierCode);
    await page.type('#contractPercent', '5');
    await page.type('#settlementDays', '0');
    await submit('#propose-contract');
    const daysRefused = ((await text('#contract-error')) ?? '').includes(
      messagesFor('en').contracts.errors.settlementDays_out_of_range,
    );
    await page.type('#carrierCode', carrierCode);
    await page.type('#contractPercent', '5');
    await page.type('#settlementDays', '7');
    await submit('#propose-contract');
    const proposedRow = await page.$('[data-status="proposed"][data-role="organiser"]');
    await open(contractsPath('en', carrierOrg), 390);
    await submit('[data-status="proposed"][data-role="carrier"] [data-accept]');
    const inForce = (
      await urApi(`/organisations/${carrierOrg}/commission-contracts`)
    ).body.contracts.contracts.find((item) => item.status === 'active');
    check(
      'contracts',
      daysRefused &&
        proposedRow !== null &&
        inForce?.basisPoints === 500 &&
        inForce.settlementDays === 7 &&
        (await page.$('[data-status="active"][data-role="carrier"]')) !== null,
      `the contract journey ended at ${page.url()} with ${JSON.stringify(inForce)}`,
    );
    for (const locale of locales) {
      await open(contractsPath(locale, carrierOrg), 390);
      await inspect(locale, 'contracts');
    }
    // A shipment arranged with the contract option, chosen in the browser.
    const contractShipment = await makeShipment('arr-contract', personalOrg);
    const contractParties = await post(
      `/organisations/${personalOrg}/shipments/${contractShipment}/parties`,
      {
        version: 1,
        customerAuthorityId: granted.id,
        sender: 'customer',
        receiver: 'not_named',
        freightPayer: 'customer',
        feePayer: 'customer',
      },
      'contract-parties',
    );
    await open(`/en/organisations/${personalOrg}/shipments/${contractShipment}`, 390);
    await page.select('#commissionOption', 'contract');
    await submit('#save-commission');
    const contractOption = (
      await urApi(`/organisations/${personalOrg}/shipments/${contractShipment}/commission`)
    ).body.commission?.option;
    const contractPublished = await post(
      `/organisations/${personalOrg}/shipments/${contractShipment}/publish`,
      {
        version: 1,
        cargoCategory: 'general_dry',
        equipmentType: 'curtain_side',
        dangerousGoods: false,
        pickupArea: 'North industrial area',
        deliveryArea: 'Port district',
        quotationDeadline: { local: zoned(24, 4) },
      },
      'contract-publish',
    );
    const contractTerms = await post(
      `/organisations/${personalOrg}/shipments/${contractShipment}/quotation-terms`,
      { version: 0, currency: 'XTS' },
      'contract-terms',
    );
    const contractQuote = (locale, query = '') =>
      `/${locale}/organisations/${carrierOrg}/discover/${contractShipment}${query}`;
    await open(contractQuote('en'), 390);
    const toldContract = (await text('#commission-terms')) ?? '';
    check(
      'contracts',
      contractParties.status === 200 &&
        contractOption === 'contract' &&
        contractPublished.status === 200 &&
        contractTerms.status === 200 &&
        toldContract.includes('5%') &&
        (await page.$('#commission-terms[data-option="contract"]')) !== null,
      `the carrier was told: ${toldContract.slice(0, 200)} (option ${contractOption}, publish ${contractPublished.status})`,
    );
    for (const locale of locales) {
      await open(contractQuote(locale), 390);
      await inspect(locale, 'contract terms');
    }
    await open(contractQuote('en'), 390);
    await fillQuotation('1000');
    await submit('#submit-quotation');
    const askedContract = (await text('#commission-acceptance')) ?? '';
    await open(
      contractQuote('en', '?qError=commission_acceptance_required&cc=50.00&cn=950.00'),
      390,
    );
    await fillQuotation('1000');
    await page.click('#commissionAccept');
    await submit('#submit-quotation');
    const contractRow = (
      await owner.query(
        `SELECT trucker.amount_text(c.commission_amount, c.minor_units) AS commission, c.contract_id AS contract
         FROM trucker.quotation q JOIN trucker.quotation_commission c ON c.quotation_id = q.id
         WHERE q.shipment_id = $1`,
        [contractShipment],
      )
    ).rows;
    check(
      'contracts',
      askedContract.includes('50.00') &&
        askedContract.includes('950.00') &&
        page.url().includes('qDone=submitted') &&
        contractRow.length === 1 &&
        contractRow[0].commission === '50.00' &&
        contractRow[0].contract === inForce?.id,
      `quoting under the contract: asked ${askedContract.slice(0, 120)}, then ${page.url()} with ${JSON.stringify(contractRow)}`,
    );
    // The carrier ends the contract: the shipment page then says it cannot quote.
    await open(contractsPath('en', carrierOrg), 390);
    await submit('[data-status="active"][data-role="carrier"] [data-end]');
    await open(contractQuote('en'), 390);
    check(
      'contracts',
      (await page.$('#open-contracts')) !== null &&
        ((await text('#commission-terms')) ?? '').includes(
          messagesFor('en').commission.carrierNoContract.slice(0, 40),
        ),
      `after the contract ended the carrier page reads: ${(await text('#commission-terms')) ?? ''}`,
    );
    await inspect('en', 'no contract');
    await open(arrangedPath('en'), 390);
    // The customer sees the shipment arranged in its name, with who arranged it.
    await open(authPath('en', verifyOrg), 390);
    const arrangedText = (await text(`[data-arranged="${arrangedShipment}"]`)) ?? '';
    check(
      'authority',
      arrangedPublished.status === 200 &&
        rolesFixed &&
        arrangedText.includes('Individual Fixture Person (fictional)') &&
        arrangedText.includes('Receiver Fixture (fictional)'),
      `the customer's page shows the arranged shipment as: ${arrangedText.slice(0, 200)}`,
    );
    for (const locale of locales) {
      await open(authPath(locale, verifyOrg), 390);
      await inspect(locale, 'authority in force');
    }
    // The customer ends it: nothing new can be arranged in its name.
    await open(authPath('en', verifyOrg), 390);
    await submit('[data-status="active"] [data-end]');
    const endedShipment = await makeShipment('arr2', personalOrg);
    const afterEnd = await post(
      `/organisations/${personalOrg}/shipments/${endedShipment}/parties`,
      {
        version: 1,
        customerAuthorityId: granted.id,
        sender: 'customer',
        receiver: 'not_named',
        freightPayer: 'customer',
        feePayer: 'customer',
      },
      'after-end',
    );
    check(
      'authority',
      (await page.$('[data-status="ended"]')) !== null && afterEnd.status === 422,
      `after the customer ended the authority a new draft answered ${afterEnd.status}`,
    );

    // Suspended when the verification is withdrawn by staff (test accounts, migration role).
    const adminToken = `${randomBytes(16).toString('hex')}.${randomBytes(16).toString('hex')}`;
    const adminId = (
      await owner.query(
        `INSERT INTO trucker.staff_account
           (email, display_name, status, enrolled_at, password_hash, totp_secret, participant_link,
            created_at, updated_at)
         VALUES ($1, 'Browser Test Administrator', 'active', now(), 'not-a-real-hash', '\\x00',
                 'declared_none', now(), now())
         RETURNING id`,
        [`admin-${stamp}@example.test`],
      )
    ).rows[0].id;
    await owner.query(
      `INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at)
       VALUES ($1, 'staff_admin', NULL, now())`,
      [adminId],
    );
    await owner.query(
      `INSERT INTO trucker.staff_session (id, staff_id, token_hash, created_at, last_used_at, absolute_expires_at)
       VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 hour')`,
      [adminId, createHash('sha256').update(adminToken).digest('hex')],
    );
    const revoke = await fetch(
      `${apiOrigin}/staff/verification/organisations/${verifyOrg}/revoke`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ capability: 'ship', reason: 'verified_in_error', noConflict: true }),
      },
    );
    await inEachLocale('suspended');
    await open(shipmentPath('ar'), 390);
    check(
      'publication',
      revoke.status === 200 &&
        (await stateShown()) === 'suspended' &&
        (await page.evaluate(() =>
          [...document.querySelectorAll('#suspension-causes li')]
            .map((item) => item.dataset.cause)
            .join(),
        )) === 'verification' &&
        (await pubCount('shipment.suspended')) === 1,
      `after the withdrawal of verification the page shows ${await stateShown()}`,
    );

    // Suspended: gone from discovery at the next request, detail and list alike.
    await open(discoverPath('en'), 390);
    const afterSuspension = await discovered();
    await open(`${discoverPath('en')}/${pubShipment}`, 390);
    check(
      'discovery',
      !afterSuspension.includes(pubShipment) &&
        (await page.evaluate(() => document.querySelector('[data-state]')?.dataset.state)) ===
          'discovered-not_found',
      `a suspended shipment still discoverable: ${afterSuspension}`,
    );

    // The deadline passes. The real clock cannot be moved here, so the migration role moves
    // the record's own times back 25 hours, all of them consistently: the deadline and the start
    // of the open suspension. The page shows it expired and records the expiry once; the
    // suspension ends with it.
    await owner.query(
      `UPDATE trucker.shipment_draft
       SET deadline_local = deadline_local - interval '25 hours', deadline_at = deadline_at - interval '25 hours'
       WHERE id = $1`,
      [pubShipment],
    );
    await owner.query(
      `UPDATE trucker.shipment_suspension SET started_at = started_at - interval '25 hours'
       WHERE shipment_id = $1 AND ended_at IS NULL`,
      [pubShipment],
    );
    await inEachLocale('expired');
    check(
      'publication',
      (await stateShown()) === 'expired' &&
        (await pubCount('shipment.expired')) === 1 &&
        (await page.$('#republish-form')) !== null &&
        (await page.$('#copy-form')) !== null,
      `after the deadline the page shows ${await stateShown()} with ${await pubCount('shipment.expired')} expiry records`,
    );
    // Publishing again needs every check: the verification is withdrawn, so it is refused.
    await open(shipmentPath('ur'), 390);
    const newDeadline = zoned(20, 4);
    await page.type('#deadlineDate', newDeadline.slice(0, 10));
    await page.type('#deadlineTime', newDeadline.slice(11, 16));
    await submit('#republish-shipment');
    check(
      'publication',
      page.url().includes('error=publication_not_allowed') &&
        ((await text('#error-summary')) ?? '').includes(urPub.errors.publication_not_allowed) &&
        (await stateShown()) === 'expired',
      `republishing without verification led to ${page.url()}`,
    );
    // A new draft from a copy.
    await submit('#copy-shipment');
    check(
      'publication',
      page.url().includes('pubDone=copied') &&
        (await stateShown()) === 'draft' &&
        !page.url().includes(pubShipment) &&
        (await page.$eval('#pickupArea', (input) => input.value)) === 'North industrial area',
      `copying led to ${page.url()}`,
    );
    await open('/ur/account', 390);

    // ------------------------------------------------------------------------------------
    // Ending sessions when the API does not confirm it
    // ------------------------------------------------------------------------------------
    const ur = messagesFor('ur').auth;
    const en = messagesFor('en').auth;
    const summaryText = () => text('#error-summary');
    const firstToken = await tokenOf(browser.defaultBrowserContext());
    check('revocation', (await apiSaysToken(firstToken)) === 200, 'the first session is not valid');

    // A second session again, so there is one to end. Same number: wait out the resend limit.
    await sleep(10_500);
    const thirdContext = await browser.createBrowserContext();
    const third = await thirdContext.newPage();
    await third.goto(`${origin}/en/sign-in`, { waitUntil: 'networkidle0' });
    await third.type('#phone', people.ur.phone);
    await Promise.all([
      third.waitForNavigation({ waitUntil: 'networkidle0' }),
      third.click('#sign-in-form button[type=submit]'),
    ]);
    await third.type(
      '#code',
      await third.evaluate(() => document.querySelector('.notice-development .ltr').textContent),
    );
    await Promise.all([
      third.waitForNavigation({ waitUntil: 'networkidle0' }),
      third.click('form.card button.button-primary'),
    ]);
    const thirdToken = await tokenOf(thirdContext);
    await open('/ur/account', 390);
    check(
      'revocation',
      (await page.evaluate(() => document.querySelectorAll('.session').length)) === 2,
      'two sessions are not listed before the failure checks',
    );

    // 1. The API answers with an error (503) instead of a confirmation.
    await stopApi();
    const failing = http.createServer((request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"code":"service_unavailable","message":"stand-in for a failing API"}');
    });
    await new Promise((resolve) => failing.listen(apiPort, '127.0.0.1', resolve));
    await submit('.session form button');
    check(
      'revocation',
      page.url() === `${origin}/ur/account?error=end_session_unconfirmed`,
      `ending a session against a failing API led to ${page.url()}`,
    );
    check(
      'revocation',
      ((await summaryText()) ?? '').includes(ur.errors.end_session_unconfirmed) &&
        (await focusedId()) === 'error-summary',
      'a failed end-session is not explained in Urdu with focus on the summary',
    );
    await submit('#sign-out');
    check(
      'revocation',
      page.url() === `${origin}/ur/account?error=sign_out_unconfirmed` &&
        ((await summaryText()) ?? '').includes(ur.errors.sign_out_unconfirmed),
      `signing out against a failing API led to ${page.url()}`,
    );
    check(
      'revocation',
      (await tokenOf(browser.defaultBrowserContext())) === firstToken,
      'the session cookie was removed although sign-out was not confirmed',
    );
    await new Promise((resolve) => {
      failing.close(resolve);
      failing.closeAllConnections();
    });

    // 2. The API does not answer at all.
    await submit('#sign-out');
    check(
      'revocation',
      page.url() === `${origin}/ur/account?error=sign_out_unconfirmed` &&
        (await page.evaluate(() => document.querySelector('[data-state]')?.dataset.state)) ===
          'account-unavailable',
      `signing out with no API led to ${page.url()}`,
    );
    check(
      'revocation',
      ((await summaryText()) ?? '').includes(ur.errors.sign_out_unconfirmed) &&
        ((await summaryText()) ?? '').includes(ur.errors.account_unavailable) &&
        !page.url().includes('session_ended'),
      'with no API the page does not say that sign-out was unconfirmed, or claims the session ended',
    );
    check(
      'revocation',
      (await page.evaluate(() =>
        ['retry-account', 'sign-out', 'sign-out-local'].every((id) => document.getElementById(id)),
      )) && (await tokenOf(browser.defaultBrowserContext())) === firstToken,
      'retry, sign out and browser-only sign out are not all offered, or the cookie was removed',
    );
    await inspect('ur', 'account unavailable');

    // 3. The API is back. Nothing was revoked by the failed attempts, and retrying works.
    await startApi();
    check(
      'revocation',
      (await apiSaysToken(firstToken)) === 200 && (await apiSaysToken(thirdToken)) === 200,
      'a session was revoked although the web application reported failure',
    );
    await submit('#retry-account');
    check(
      'revocation',
      page.url() === `${origin}/ur/account` &&
        (await page.evaluate(() => document.querySelectorAll('.session').length)) === 2 &&
        (await summaryText()) === null,
      `retrying the account led to ${page.url()}`,
    );

    // "End all other sessions": failure first, then the confirmed result.
    await stopApi();
    await submit('.form-inline form:first-child button');
    check(
      'revocation',
      page.url() === `${origin}/ur/account?error=end_others_unconfirmed` &&
        ((await summaryText()) ?? '').includes(ur.errors.end_others_unconfirmed),
      `ending other sessions with no API led to ${page.url()}`,
    );
    await startApi();
    check(
      'revocation',
      (await apiSaysToken(thirdToken)) === 200,
      'the other session was revoked although failure was reported',
    );
    await open('/ur/account', 390);
    await submit('.form-inline form:first-child button');
    check(
      'revocation',
      page.url() === `${origin}/ur/account?done=others_ended&count=1` &&
        (await text('#account-confirmation')) === ur.account.othersEnded.replace('{n}', '1'),
      `ending other sessions led to ${page.url()}`,
    );
    check(
      'revocation',
      (await apiSaysToken(thirdToken)) === 401 && (await apiSaysToken(firstToken)) === 200,
      'after a confirmed "end all others" the other token is still accepted, or this one is not',
    );
    await inspect('ur', 'account confirmation');
    // Ending a session that is already gone is reported as such, not as success.
    await third.goto(`${origin}/en/account`, { waitUntil: 'networkidle0' });
    check(
      'revocation',
      third.url() === `${origin}/en/sign-in?error=session_ended`,
      `the revoked session still opened ${third.url()}`,
    );
    await thirdContext.close();

    // ------------------------------------------------------------------------------------
    // The revocation is carried out, but its answer is lost on the way back
    // ------------------------------------------------------------------------------------
    await sleep(10_500);
    const fourthContext = await browser.createBrowserContext();
    const fourth = await fourthContext.newPage();
    await fourth.goto(`${origin}/en/sign-in`, { waitUntil: 'networkidle0' });
    await fourth.type('#phone', people.ur.phone);
    await Promise.all([
      fourth.waitForNavigation({ waitUntil: 'networkidle0' }),
      fourth.click('#sign-in-form button[type=submit]'),
    ]);
    await fourth.type(
      '#code',
      await fourth.evaluate(() => document.querySelector('.notice-development .ltr').textContent),
    );
    await Promise.all([
      fourth.waitForNavigation({ waitUntil: 'networkidle0' }),
      fourth.click('form.card button.button-primary'),
    ]);
    const fourthToken = await tokenOf(fourthContext);
    await fourthContext.close();
    await open('/ur/account', 390);
    check(
      'lost answer',
      (await page.evaluate(() => document.querySelectorAll('.session').length)) === 2 &&
        (await apiSaysToken(fourthToken)) === 200,
      'there is no second active session to end',
    );

    // Ending another session: done on the server, answer lost.
    relay.mode = 'lose';
    await submit('.session form button');
    check(
      'lost answer',
      relay.lost.length === 1 && /^DELETE \/me\/sessions\/[0-9a-f-]+ -> 204$/.test(relay.lost[0]),
      `the API did not carry out the end-session request whose answer was lost: ${relay.lost}`,
    );
    check(
      'lost answer',
      (await apiSaysToken(fourthToken)) === 401,
      'the session whose end was not confirmed is still accepted by the API',
    );
    const lostEnd = (await summaryText()) ?? '';
    check(
      'lost answer',
      page.url() === `${origin}/ur/account?error=end_session_unconfirmed` &&
        lostEnd.includes(ur.errors.end_session_unconfirmed) &&
        (await page.evaluate(() => document.getElementById('account-confirmation'))) === null,
      `a lost end-session answer led to ${page.url()} without the uncertain message`,
    );
    check(
      'lost answer',
      ur.errors.end_session_unconfirmed.includes('ہو سکتا ہے') &&
        !lostEnd.includes(ur.account.sessionEnded),
      'the page claims an outcome it cannot know',
    );
    relay.mode = 'pass';
    await submit('#retry-account');
    check(
      'lost answer',
      page.url() === `${origin}/ur/account` &&
        (await page.evaluate(() => document.querySelectorAll('.session').length)) === 1 &&
        (await summaryText()) === null,
      `after the connection returned, retrying did not show the true state: ${page.url()}`,
    );

    // Signing out: done on the server, answer lost. The page is uncertain; the retry confirms.
    relay.mode = 'lose';
    await submit('#sign-out');
    check(
      'lost answer',
      relay.lost.length === 2 && relay.lost[1] === 'POST /auth/sign-out -> 204',
      `the API did not carry out the sign-out whose answer was lost: ${relay.lost}`,
    );
    check(
      'lost answer',
      (await apiSaysToken(firstToken)) === 401,
      'the session was not revoked on the server although the API answered 204',
    );
    const lostSignOut = (await summaryText()) ?? '';
    check(
      'lost answer',
      page.url() === `${origin}/ur/account?error=sign_out_unconfirmed` &&
        lostSignOut.includes(ur.errors.sign_out_unconfirmed) &&
        lostSignOut.includes(ur.errors.account_unavailable),
      `a lost sign-out answer led to ${page.url()} without the uncertain message`,
    );
    check(
      'lost answer',
      (await tokenOf(browser.defaultBrowserContext())) === firstToken &&
        (await page.evaluate(() =>
          ['sign-out', 'sign-out-local', 'retry-account'].every((id) =>
            document.getElementById(id),
          ),
        )),
      'after a lost answer the cookie was removed or a retry is not offered',
    );
    await inspect('ur', 'sign-out unconfirmed');
    relay.mode = 'pass';

    // The retry: the server says the session is already over, which confirms the sign-out.
    await submit('#sign-out');
    check(
      'revocation',
      page.url() === `${origin}/ur/sign-in?done=signed_out` &&
        (await text('#signed-out-confirmed')) === ur.account.signedOut,
      `signing out led to ${page.url()}`,
    );
    check(
      'revocation',
      (await tokenOf(browser.defaultBrowserContext())) === undefined &&
        (await apiSaysToken(firstToken)) === 401,
      'after a confirmed sign-out the cookie remains or the API still accepts the token',
    );
    await inspect('ur', 'signed out');
    await open('/ur/account', 390);
    check(
      'journey sessions',
      page.url().startsWith(`${origin}/ur/sign-in`),
      `after signing out the account opened ${page.url()}`,
    );

    // Browser-only sign-out: offered after a failure, and reported as not confirmed.
    await open('/en/sign-in', 390);
    await page.type('#phone', people.en.phone);
    await submit('#sign-in-form button[type=submit]');
    await page.type('#code', await text('.notice-development .ltr'));
    await submit('form.card button.button-primary');
    const localToken = await tokenOf(browser.defaultBrowserContext());
    check(
      'revocation',
      page.url() === `${origin}/en/account` &&
        (await page.evaluate(() => document.getElementById('sign-out-local'))) === null,
      'browser-only sign-out is offered before any failure',
    );
    await stopApi();
    await submit('#sign-out');
    check(
      'revocation',
      ((await summaryText()) ?? '').includes(en.errors.sign_out_unconfirmed),
      'the failed sign-out is not explained in English',
    );
    await submit('#sign-out-local');
    check(
      'revocation',
      page.url() === `${origin}/en/sign-in?done=signed_out_local` &&
        (await text('#signed-out-local')) === en.account.signedOutLocal &&
        (await page.evaluate(() => document.getElementById('signed-out-confirmed'))) === null,
      `browser-only sign-out led to ${page.url()} or claims confirmation`,
    );
    check(
      'revocation',
      (await tokenOf(browser.defaultBrowserContext())) === undefined,
      'browser-only sign-out left the session cookie in place',
    );
    await inspect('en', 'signed out locally');
    await startApi();
    check(
      'revocation',
      (await apiSaysToken(localToken)) === 200,
      'the page said the server session may still be active, but the API refuses the token',
    );
    // Tidy up: end that session on the server, and confirm the token is then refused.
    const tidy = await fetch(`${apiOrigin}/auth/sign-out`, {
      method: 'POST',
      headers: { authorization: `Bearer ${localToken}` },
    });
    check(
      'revocation',
      tidy.status === 204 && (await apiSaysToken(localToken)) === 401,
      'ending the left-over session on the server did not make the API refuse its token',
    );

    // ------------------------------------------------------------------------------------
    // Development codes reach only a visitor on this machine
    // ------------------------------------------------------------------------------------
    check(
      'code locality',
      Boolean(outsideAddress),
      'this machine has no network address other than loopback, so a remote visitor cannot be tested',
    );
    if (outsideAddress) {
      const outsideOrigin = `http://${outsideAddress}:${port}`;
      const sixDigits = /(^|[^0-9])[0-9]{6}([^0-9]|$)/;
      // A real browser arriving from outside, first plainly, then claiming to be local.
      for (const [label, extra, index] of [
        ['a remote visitor', {}, 3],
        ['a remote visitor claiming to be local', { 'x-trucker-visitor': 'local' }, 4],
      ]) {
        const context = await browser.createBrowserContext();
        const visitor = await context.newPage();
        await visitor.setExtraHTTPHeaders(extra);
        await visitor.goto(`${outsideOrigin}/en/sign-in`, { waitUntil: 'networkidle0' });
        await visitor.type('#phone', phoneFor(index));
        await Promise.all([
          visitor.waitForNavigation({ waitUntil: 'networkidle0' }),
          visitor.click('#sign-in-form button[type=submit]'),
        ]);
        const seen = await visitor.evaluate(() => ({
          panel: document.querySelector('.notice-development') !== null,
          body: document.body.innerText,
        }));
        const kept = decodeURIComponent(
          (await context.cookies()).find((cookie) => cookie.name === 'trucker_sign_in')?.value ??
            '',
        );
        check(
          'code locality',
          visitor.url() === `${outsideOrigin}/en/sign-in/code`,
          `${label} was sent to ${visitor.url()}`,
        );
        check(
          'code locality',
          !seen.panel && !sixDigits.test(seen.body),
          `${label} is shown a development code`,
        );
        check(
          'code locality',
          (() => {
            // Exactly a number and a challenge identifier, nothing else. (Searching for six
            // digits would misfire on the identifier, which is random hexadecimal.)
            try {
              return Object.keys(JSON.parse(kept)).sort().join(',') === 'challengeId,phone';
            } catch {
              return false;
            }
          })(),
          `${label} was handed something other than a number and a challenge: ${kept}`,
        );
        await context.close();
      }

      // Requests made by hand, so the Host header and forwarding headers can be forged too.
      const attempts = [
        {
          label: 'from outside, forging Host, the visitor mark and a forwarded address',
          connectTo: outsideAddress,
          hostHeader: `localhost:${port}`,
          extraHeaders: { 'x-trucker-visitor': 'local', 'x-forwarded-for': '127.0.0.1' },
          index: 5,
        },
        {
          label: 'from outside, forging Host and the visitor mark only',
          connectTo: outsideAddress,
          hostHeader: `localhost:${port}`,
          extraHeaders: { 'x-trucker-visitor': 'local' },
          index: 6,
        },
        {
          label: 'from this machine but passed on by a forwarder',
          connectTo: '127.0.0.1',
          hostHeader: `localhost:${port}`,
          extraHeaders: { 'x-forwarded-for': '203.0.113.7' },
          index: 7,
        },
        {
          label: 'from this machine but addressed to a public name',
          connectTo: '127.0.0.1',
          hostHeader: 'trucker.example',
          extraHeaders: {},
          index: 8,
        },
      ];
      for (const attempt of attempts) {
        const result = await rawCodeRequest({ ...attempt, phone: phoneFor(attempt.index) });
        check(
          'code locality',
          result.status === 303 && Boolean(result.stored?.challengeId),
          `${attempt.label}: the request was not accepted (${result.status}), so it proves nothing`,
        );
        check(
          'code locality',
          result.stored?.developmentCode === undefined &&
            !result.page.includes('notice-development'),
          `${attempt.label}: a development code was returned`,
        );
      }
      // The same hand-made request from this machine does get the code, so the refusals above
      // are the rule at work and not a broken test.
      const control = await rawCodeRequest({
        connectTo: '127.0.0.1',
        hostHeader: `localhost:${port}`,
        phone: phoneFor(9),
      });
      check(
        'code locality',
        /^[0-9]{6}$/.test(control.stored?.developmentCode ?? '') &&
          control.page.includes('notice-development'),
        'a visitor on this machine no longer gets the development code',
      );
    }

    // Production refuses the switch: started that way, the web application serves no page.
    const refusedPort = port + 7;
    const refused = spawn(
      process.execPath,
      [require.resolve('next/dist/bin/next'), 'start', '-p', String(refusedPort)],
      {
        cwd: appDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          TRUCKER_API_URL: apiOrigin,
          TRUCKER_STAGE: 'production',
          TRUCKER_DEVELOPMENT_CODE_DISPLAY: 'local-visitors',
        },
      },
    );
    let refusedLog = '';
    refused.stdout.on('data', (chunk) => (refusedLog += chunk));
    refused.stderr.on('data', (chunk) => (refusedLog += chunk));
    let refusedStatus = 0;
    for (let attempt = 0; attempt < 60 && refusedStatus === 0; attempt += 1) {
      await sleep(250);
      try {
        refusedStatus = (await fetch(`http://127.0.0.1:${refusedPort}/en/sign-in`)).status;
      } catch {
        // not listening yet, or it exited
      }
      if (refused.exitCode !== null) break;
    }
    refused.kill();
    check(
      'code locality',
      refusedStatus !== 200 && refusedLog.includes('must not be set in production'),
      `production with development codes switched on served a page (${refusedStatus})`,
    );

    // A second code for the same number straight away is refused, with the wait in the message.
    await open('/en/sign-in', 390);
    await page.evaluate(() => (document.querySelector('#phone').value = ''));
    await page.type('#phone', people.ar.phone);
    await submit('#sign-in-form button[type=submit]');
    await submit('.form-inline button');
    check(
      'journey',
      page.url().includes('error=code_resend_too_soon') && /seconds=[0-9]+/.test(page.url()),
      `asking again at once led to ${page.url()}`,
    );

    check(
      'scripts',
      pageErrors.length === 0,
      `script errors during the journey: ${pageErrors.join(' | ')}`,
    );
  } finally {
    if (browser) await browser.close();
    server.kill();
    apiServer?.kill();
    await restoreSettings().catch((error) => console.error('settings not restored:', error));
    await removeTestZone().catch((error) => console.error('test zone not removed:', error));
    relayServer.close();
    relayServer.closeAllConnections();
  }

  console.log('checks run:', JSON.stringify(counts));
  if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const failure of failures.slice(0, 40)) console.error(' - ' + failure);
    if (serverLog.includes('Error')) console.error(serverLog.slice(-2000));
    if (apiLog.includes('"level":"error"')) console.error(apiLog.slice(-2000));
    process.exitCode = 1;
  } else {
    console.log('all browser checks passed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
