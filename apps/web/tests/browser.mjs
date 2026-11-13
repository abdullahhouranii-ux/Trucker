// Browser checks for the built web application. Run `npm run test:browser` from the repository
// root: it builds the application, serves it with `next start` and drives a real Chrome.
//
// Needs a Chrome or Chromium binary. Set CHROME_PATH, or install one at a usual location.
// What these checks do not cover is listed in docs/delivery/WEB_FOUNDATION_SLICE_3.md.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
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
        ...(settingsBefore.reviewed_for_production ? ['--reviewed-for-production'] : []),
      ],
      apiEnv,
    );
  await run(apiSettings, ['set', 'code_resend_wait_seconds=10', 'code_max_per_hour=30'], apiEnv);
  // The API runs as its own database role, which row security binds, never as the migration
  // role. The fictional countries are loaded with the explicit acknowledgement they require.
  const appRole = await run(apiLocalDatabase, ['app-role'], apiEnv);
  apiEnv.APP_DATABASE_URL = /APP_DATABASE_URL=(\S+)/.exec(appRole)[1];
  apiEnv.COUNTRY_FIXTURES = 'local-development';
  await run(apiLocalDatabase, ['fixtures'], {
    ...apiEnv,
    TRUCKER_LOCAL_FIXTURES: 'local-development-only',
  });
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
      'en:organisation new error': 'organisation-new-error-en-390',
      'ar:organisation new': 'organisation-new-ar-390',
      'ur:organisation': 'organisation-ur-390',
      'en:organisations': 'organisations-en-390',
      'ur:organisation unconfirmed': 'organisation-unconfirmed-ur-390',
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
