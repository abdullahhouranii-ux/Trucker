// Browser checks for the staff console. Run `npm run test:browser` from the repository root: it
// builds the API and the console, serves the console with `next start` and drives a real Chrome
// against the real API and a real PostgreSQL database.
//
// The checks use a database of their own, created here and dropped at the end, because the
// operator command that creates the first administrator works only where none exists yet.
// Authenticator codes are made by otplib from the key the enrolment page shows.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { generateSync } from 'otplib';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const pg = createRequire(new URL('../../api/package.json', import.meta.url))('pg');
const port = Number(process.env.CONSOLE_TEST_PORT ?? 3201);
const apiPort = Number(process.env.CONSOLE_API_TEST_PORT ?? 3202);
const relayPort = apiPort + 20;
const origin = `http://localhost:${port}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const cli = (name) => fileURLToPath(new URL(`../../api/dist/cli/${name}.js`, import.meta.url));
const apiMain = fileURLToPath(new URL('../../api/dist/main.js', import.meta.url));
const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('./output/', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const counts = {};
function check(group, ok, message) {
  counts[group] = (counts[group] ?? 0) + 1;
  if (!ok) failures.push(`${group}: ${message}`);
}

// The console reaches the API through a stand-in, so the checks can lose an answer on its way
// back: the API did the work, the console never hears.
const relay = { mode: 'pass', lost: [] };
const LOSABLE = [
  ['POST', /^\/staff\/accounts\/[^/]+\/privileges$/],
  ['POST', /^\/staff\/sign-out$/],
  ['POST', /^\/staff\/verification\/[^/]+\/decision$/],
];
function startRelay() {
  const server = http.createServer((request, response) => {
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
          const losable = LOSABLE.some(
            ([method, path]) => method === request.method && path.test(request.url),
          );
          if (relay.mode === 'lose' && losable) {
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
    child.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${file} ${args.join(' ')}: ${output}`)),
    );
  });
}

/** The authenticator code for a key, `ahead` seconds from now. */
const codeFor = (key, ahead = 0) =>
  generateSync({ secret: key, epoch: Math.floor(Date.now() / 1000) + ahead });

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set.');
  if (!existsSync(apiMain)) throw new Error('Build the API first: npm run build -w @trucker/api');

  // A database for these checks alone.
  const name = `trucker_console_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.pathname = `/${name}`;
  const dropDatabase = async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  };

  const apiEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(apiPort),
    DATABASE_URL: databaseUrl.toString(),
    CONSOLE_ORIGIN: origin,
    // For the test participant who applies for verification: displayed codes, demonstration
    // terms and the fictional countries, all local-development only.
    SIGN_IN_CODE_DELIVERY: 'development-display',
    REGISTRATION_TERMS: 'demonstration',
    COUNTRY_FIXTURES: 'local-development',
  };
  let apiServer;
  let server;
  let relayServer;
  let browser;
  const closers = [];
  let apiLog = '';
  let serverLog = '';
  try {
    await run(cli('migrate'), ['up'], apiEnv);
    const appRole = await run(cli('local-database'), ['app-role'], apiEnv);
    apiEnv.APP_DATABASE_URL = /APP_DATABASE_URL=(\S+)/.exec(appRole)[1];
    await run(cli('local-database'), ['fixtures'], {
      ...apiEnv,
      TRUCKER_LOCAL_FIXTURES: 'local-development-only',
    });

    apiServer = spawn(process.execPath, [apiMain], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: apiEnv,
    });
    apiServer.stdout.on('data', (chunk) => (apiLog += chunk));
    apiServer.stderr.on('data', (chunk) => (apiLog += chunk));
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        if ((await fetch(`${apiOrigin}/health/live`)).status === 200) break;
      } catch {
        // not listening yet
      }
      await sleep(250);
    }
    relayServer = await startRelay();

    server = spawn(
      process.execPath,
      [require.resolve('next/dist/bin/next'), 'start', '-p', String(port)],
      {
        cwd: appDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          TRUCKER_API_URL: `http://127.0.0.1:${relayPort}`,
          CONSOLE_ORIGIN: origin,
        },
      },
    );
    server.stdout.on('data', (chunk) => (serverLog += chunk));
    server.stderr.on('data', (chunk) => (serverLog += chunk));
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        if ((await fetch(`${origin}/sign-in`)).status === 200) break;
      } catch {
        // not listening yet
      }
      await sleep(250);
    }

    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: ['--no-sandbox'],
    });
    const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
    mkdirSync(outDir, { recursive: true });
    // At most five pictures, for design review only.
    const shots = {
      application: 'console-application-390',
      withdraw: 'console-withdraw-390',
      'published shipment': 'console-published-shipment-390',
    };

    /** Helpers bound to one page, so that two staff members can be signed in at once. */
    const driver = (page) => {
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const open = async (path) => {
        await page.setViewport({ width: 390, height: 900 });
        // An address that differs only after the # would not load the page again.
        if (path.includes('#')) await page.goto('about:blank');
        const response = await page.goto(origin + path, { waitUntil: 'networkidle0' });
        await page.evaluate(() => document.fonts.ready);
        return response;
      };
      const text = (selector) =>
        page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, selector);
      const submit = async (selector) => {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle0' }),
          page.click(selector),
        ]);
        await page.evaluate(() => document.fonts.ready);
      };
      // Keyboard only: Tab from the top of the page must reach every control, each must show
      // where the focus is, and the skip link must move the focus to the content.
      const keyboard = async (state) => {
        await page.evaluate(() => {
          // Tab continues from wherever the focus last was, so put it at the very start.
          document.getElementById('kb-start')?.remove();
          document.body.insertAdjacentHTML(
            'afterbegin',
            '<span id="kb-start" tabindex="-1"></span>',
          );
          document.getElementById('kb-start').focus();
          window.scrollTo(0, 0);
          const controls = [
            ...document.querySelectorAll(
              'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select, textarea, summary',
            ),
          ].filter((element) => {
            if (element.closest('details:not([open])') && element.tagName !== 'SUMMARY')
              return false;
            const box = element.getBoundingClientRect();
            return box.width > 0 || element.classList.contains('skip-link');
          });
          controls.forEach((element, index) => (element.dataset.kb = String(index)));
          document.body.dataset.kbCount = String(controls.length);
        });
        const total = Number(await page.evaluate(() => document.body.dataset.kbCount));
        const reached = new Set();
        const unseen = [];
        let skipWorks = null;
        for (let press = 0; press < total + 3; press += 1) {
          await page.keyboard.press('Tab');
          const focused = await page.evaluate(() => {
            const element = document.activeElement;
            if (!element || element === document.body) return null;
            const style = getComputedStyle(element);
            return {
              kb: element.dataset.kb ?? null,
              skip: element.classList.contains('skip-link'),
              shown:
                (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
                style.boxShadow !== 'none',
              name: (
                element.textContent.trim() ||
                element.id ||
                element.name ||
                element.tagName
              ).slice(0, 40),
            };
          });
          if (!focused) break;
          if (focused.kb !== null) {
            if (reached.has(focused.kb)) break;
            reached.add(focused.kb);
          }
          if (!focused.shown) unseen.push(focused.name);
          if (focused.skip && skipWorks === null) {
            await page.keyboard.press('Enter');
            skipWorks = (await page.evaluate(() => document.activeElement?.id)) === 'main';
            // Back to the skip link, to carry on from where Tab was.
            await page.evaluate(() => document.querySelector('.skip-link').focus());
          }
        }
        const missed = await page.evaluate(
          (seen) => {
            const groups = new Set(
              [...document.querySelectorAll('[data-kb]')]
                .filter((element) => seen.includes(element.dataset.kb) && element.type === 'radio')
                .map((element) => `${element.form?.id ?? ''}:${element.name}`),
            );
            return (
              [...document.querySelectorAll('[data-kb]')]
                .filter((element) => !seen.includes(element.dataset.kb))
                // Tab stops once at a group of radio buttons; the arrow keys move within it.
                .filter(
                  (element) =>
                    !(
                      element.type === 'radio' &&
                      groups.has(`${element.form?.id ?? ''}:${element.name}`)
                    ),
                )
                .map((element) =>
                  (
                    element.textContent.trim() ||
                    element.id ||
                    element.name ||
                    element.tagName
                  ).slice(0, 40),
                )
            );
          },
          [...reached],
        );
        await page.evaluate(() => document.getElementById('kb-start')?.remove());
        check(
          'keyboard',
          missed.length === 0 && unseen.length === 0 && skipWorks === true,
          `${state}: not reached by Tab [${missed.join(', ')}], focus not shown on [${unseen.join(', ')}], skip link works: ${skipWorks}`,
        );
      };
      const inspect = async (state) => {
        await keyboard(state);
        for (const width of [320, 390, 768, 1280]) {
          await page.setViewport({ width, height: 900 });
          const found = await page.evaluate(findOverflow);
          check('layout', found.length === 0, `${state} at ${width}px: ${found.join('; ')}`);
        }
        await page.setViewport({ width: 390, height: 900 });
        if (shots[state])
          await page.screenshot({ path: `${outDir}${shots[state]}.png`, fullPage: true });
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        const doubled = await page.evaluate(findOverflow);
        check('layout', doubled.length === 0, `${state} with text doubled: ${doubled.join('; ')}`);
        await page.evaluate(() => (document.documentElement.style.fontSize = ''));
        const facts = await page.evaluate(() => ({
          h1: document.querySelectorAll('h1').length,
          unlabelled: [...document.querySelectorAll('input:not([type=hidden])')].filter(
            (input) =>
              !input.closest('label') && !document.querySelector(`label[for="${input.id}"]`),
          ).length,
          small: [
            ...document.querySelectorAll('a[href], button, input:not([type=hidden]), summary'),
          ]
            .filter((element) => !element.classList.contains('skip-link'))
            .map((element) => ({
              box: element.getBoundingClientRect(),
              name:
                element.textContent.trim() ||
                element.id ||
                element.getAttribute('name') ||
                element.tagName,
            }))
            .filter(({ box }) => box.width > 0 && Math.min(box.width, box.height) < 24)
            .map(({ name }) => name),
        }));
        check(
          'structure',
          facts.h1 === 1 && facts.unlabelled === 0 && facts.small.length === 0,
          `${state}: ${facts.h1} main headings, ${facts.unlabelled} inputs without a label, small targets [${facts.small.join(', ')}]`,
        );
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
          'accessibility rules',
          violations.length === 0,
          `${state}: ${violations.join(' | ')}`,
        );
      };
      /** Sets a password and an authenticator with a link; gives back the key and the codes. */
      const enrol = async (link, password) => {
        await open(link.slice(origin.length));
        await page.waitForSelector('#enrol-password-form');
        await page.type('#password', password);
        await page.type('#passwordAgain', password);
        await page.click('#enrol-password-form button[type=submit]');
        await page.waitForSelector('#enrol-code-form');
        const key = (await text('#authenticator-key')).replaceAll(' ', '');
        return { key };
      };
      const finishEnrol = async (key) => {
        await page.type('#code', codeFor(key));
        await page.click('#enrol-code-form button[type=submit]');
        await page.waitForSelector('#recovery-codes');
        return page.evaluate(() =>
          [...document.querySelectorAll('#recovery-codes li')].map((item) => item.textContent),
        );
      };
      const signIn = async (email, password, code) => {
        await open('/sign-in');
        await page.type('#email', email);
        await page.type('#password', password);
        await submit('#sign-in-form button[type=submit]');
        if (!page.url().endsWith('/sign-in/code')) return;
        await page.type('#code', code);
        await submit('#code-form button[type=submit]');
      };
      return { page, pageErrors, open, text, submit, inspect, enrol, finishEnrol, signIn };
    };

    const one = driver(await browser.newPage());
    const { page } = one;

    // ------------------------------------------------------------------------------------
    // Nobody is signed in: every page leads to sign-in, and nothing is cached or framed
    // ------------------------------------------------------------------------------------
    for (const path of ['/', '/staff', '/audit']) {
      await one.open(path);
      check(
        'gate',
        page.url() === `${origin}/sign-in`,
        `${path} without a session is ${page.url()}`,
      );
    }
    const headers = (await fetch(`${origin}/sign-in`)).headers;
    check(
      'headers',
      headers.get('cache-control') === 'no-store' &&
        headers.get('x-frame-options') === 'DENY' &&
        headers.get('referrer-policy') === 'no-referrer' &&
        (headers.get('x-robots-tag') ?? '').includes('noindex'),
      `sign-in is served with ${JSON.stringify(Object.fromEntries(headers))}`,
    );
    await one.inspect('sign-in');

    // ------------------------------------------------------------------------------------
    // The first administrator: operator command, enrolment link, password, authenticator
    // ------------------------------------------------------------------------------------
    const adminEmail = 'first.admin@example.test';
    const adminPassword = 'a long phrase for the first admin';
    const made = JSON.parse(
      await run(cli('staff-bootstrap'), [adminEmail, 'First', 'Administrator'], apiEnv),
    );
    check(
      'bootstrap',
      made.status === 'created' && made.enrolmentLink.startsWith(`${origin}/enrol#`),
      `the operator command answered ${JSON.stringify(made)}`,
    );
    // Before enrolment the account cannot sign in at all.
    await one.signIn(adminEmail, adminPassword, '000000');
    check(
      'sign-in',
      page.url() === `${origin}/sign-in?error=refused` &&
        (await page.evaluate(() => document.activeElement?.id)) === 'error-summary',
      `an account that is not set up led to ${page.url()}`,
    );
    await one.inspect('sign-in refused');
    // The enrolment page without a link, and with a made-up one.
    await one.open('/enrol');
    await page.waitForSelector('#enrol-invalid');
    await one.inspect('enrol invalid');
    await one.open(`/enrol#${randomBytes(32).toString('base64url')}`);
    await page.waitForSelector('#enrol-invalid');
    check('enrolment', true, 'a made-up link is refused');

    await one.open(made.enrolmentLink.slice(origin.length));
    await page.waitForSelector('#enrol-password-form');
    check(
      'enrolment',
      (await one.text('#enrol-email')) === adminEmail,
      `the link is for ${await one.text('#enrol-email')}`,
    );
    await one.inspect('enrol password');
    await page.type('#password', adminPassword);
    await page.type('#passwordAgain', `${adminPassword} `);
    await page.click('#enrol-password-form button[type=submit]');
    await page.waitForSelector('#enrol-error');
    check(
      'enrolment',
      ((await one.text('#enrol-error')) ?? '').includes('not the same'),
      'two different passwords were accepted',
    );
    const { key: adminKey } = await one.enrol(made.enrolmentLink, adminPassword);
    check(
      'enrolment',
      /^[A-Z2-7]{32}$/.test(adminKey) &&
        (await page.evaluate(() => document.querySelector('.qr svg') !== null)),
      `the authenticator step shows the key "${adminKey}" and a QR code`,
    );
    await one.inspect('enrol authenticator');
    await page.type('#code', '000000');
    await page.click('#enrol-code-form button[type=submit]');
    await page.waitForSelector('#enrol-error');
    check(
      'enrolment',
      ((await one.text('#enrol-error')) ?? '').includes('not accepted'),
      'a wrong authenticator code completed enrolment',
    );
    const adminCodes = await one.finishEnrol(adminKey);
    check(
      'enrolment',
      adminCodes.length === 10 &&
        adminCodes.every((code) => /^([a-z2-7]{4}-){3}[a-z2-7]{4}$/.test(code)),
      `recovery codes shown: ${adminCodes.length}`,
    );
    await one.inspect('enrol done');
    // The link worked once.
    await one.open(made.enrolmentLink.slice(origin.length));
    await page.waitForSelector('#enrol-invalid');
    // And the operator command now refuses: an administrator exists.
    const second = await run(cli('staff-bootstrap'), ['other@example.test', 'Other'], apiEnv).catch(
      (error) => String(error),
    );
    check(
      'bootstrap',
      second.includes('already exists') && second.includes('never resets'),
      `a second run of the operator command answered: ${second.slice(0, 200)}`,
    );

    // ------------------------------------------------------------------------------------
    // Sign-in: password, then code. Neither alone.
    // ------------------------------------------------------------------------------------
    await one.signIn(adminEmail, 'not the password at all', '');
    check(
      'sign-in',
      page.url() === `${origin}/sign-in?error=refused`,
      `a wrong password: ${page.url()}`,
    );
    await one.open('/sign-in');
    await page.type('#email', adminEmail);
    await page.type('#password', adminPassword);
    await one.submit('#sign-in-form button[type=submit]');
    check('sign-in', page.url() === `${origin}/sign-in/code`, `after the password: ${page.url()}`);
    await one.inspect('sign-in code');
    // With the password accepted and no code yet, nothing is open.
    for (const path of ['/', '/staff', '/audit']) {
      const probe = await browser.newPage();
      await probe.goto(origin + path, { waitUntil: 'networkidle0' });
      check(
        'gate',
        probe.url() === `${origin}/sign-in`,
        `${path} after the password only: ${probe.url()}`,
      );
      await probe.close();
    }
    await page.type('#code', '000000');
    await one.submit('#code-form button[type=submit]');
    check(
      'sign-in',
      page.url() === `${origin}/sign-in/code?error=code`,
      `a wrong code led to ${page.url()}`,
    );
    // The code of the next half minute: the one used at enrolment is not accepted twice.
    await page.type('#code', codeFor(adminKey, 30));
    await one.submit('#code-form button[type=submit]');
    check(
      'sign-in',
      page.url() === `${origin}/` && (await one.text('#my-privileges')) === 'Staff administrator',
      `signing in led to ${page.url()}`,
    );
    const cookies = await browser.cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === 'trucker_staff_session');
    check(
      'sign-in',
      sessionCookie?.httpOnly === true &&
        sessionCookie.sameSite === 'Strict' &&
        !cookies.some((cookie) => cookie.name === 'trucker_staff_ticket'),
      `the session cookie is ${JSON.stringify(sessionCookie)}`,
    );
    await one.inspect('my account');

    // ------------------------------------------------------------------------------------
    // Staff accounts: add one, with the declaration; its link is shown once
    // ------------------------------------------------------------------------------------
    await one.open('/staff');
    check(
      'staff accounts',
      (await page.evaluate(() => document.querySelectorAll('#staff-list .account').length)) === 1 &&
        (await page.evaluate(
          () => document.querySelectorAll('#staff-list .account button').length,
        )) === 0,
      'the administrator sees controls on their own account',
    );
    const otherEmail = 'second.person@example.test';
    await page.type('#email', otherEmail);
    await page.type('#displayName', 'Second Person');
    await page.click('#create-form input[name=participantLink][value=declared]');
    await page.type('#participantPhone', '+99988000123');
    await page.click('#create-form button[type=submit]');
    await page.waitForSelector('#created-link');
    await page.waitForSelector(`[data-email="${otherEmail}"]`);
    const otherLink = await one.text('#created-link [data-link]');
    const otherId = await page.evaluate(
      (email) => document.querySelector(`[data-email="${email}"]`).id.replace('account-', ''),
      otherEmail,
    );
    check(
      'staff accounts',
      otherLink.startsWith(`${origin}/enrol#`) &&
        (await page.evaluate(
          (id) => document.querySelector(`#account-${id} [data-status]`).dataset.status,
          otherId,
        )) === 'invited' &&
        (await page.evaluate(
          (id) => document.querySelector(`#account-${id} [data-link]`).dataset.link,
          otherId,
        )) === 'declared',
      `the new account's link is "${otherLink}"`,
    );
    await one.inspect('staff accounts');
    // The link is not kept: a fresh load of the page does not show it.
    await one.open('/staff');
    check(
      'staff accounts',
      (await one.text('#created-link')) === null && !(await page.content()).includes('enrol#'),
      'the enrolment link is still on the page after a reload',
    );
    // The same email again is refused.
    await page.type('#email', otherEmail);
    await page.type('#displayName', 'Again');
    await page.click('#create-form input[name=participantLink][value=declared_none]');
    await page.click('#create-form button[type=submit]');
    await page.waitForSelector('#create-error');
    check(
      'staff accounts',
      ((await one.text('#create-error')) ?? '').includes('already exists'),
      'a second account with the same email was accepted',
    );

    // ------------------------------------------------------------------------------------
    // The second person, in a browser of their own: no privileges, so no administration
    // ------------------------------------------------------------------------------------
    const otherContext = await browser.createBrowserContext();
    const two = driver(await otherContext.newPage());
    const otherPassword = 'another long phrase entirely';
    const { key: otherKey } = await two.enrol(otherLink, otherPassword);
    const otherCodes = await two.finishEnrol(otherKey);
    await two.signIn(otherEmail, otherPassword, codeFor(otherKey, 30));
    check(
      'privileges',
      two.page.url() === `${origin}/` &&
        ((await two.text('#my-privileges')) ?? '').startsWith('None'),
      `the second person signed in to ${two.page.url()}`,
    );
    for (const path of ['/staff', '/audit']) {
      await two.open(path);
      check(
        'privileges',
        (await two.text('#forbidden')) !== null &&
          (await two.page.evaluate(() => document.querySelector('#staff-list, #audit-list'))) ===
            null,
        `${path} is shown to a person without the privilege`,
      );
    }
    await two.inspect('forbidden');

    // ------------------------------------------------------------------------------------
    // The administrator grants, removes, disables and enables; an answer is lost on the way
    // ------------------------------------------------------------------------------------
    const act = async (action) => one.submit(`#account-${otherId} [data-action="${action}"]`);
    const chips = () =>
      page.evaluate(
        (id) =>
          [...document.querySelectorAll(`#account-${id} [data-privilege]`)].map(
            (chip) => chip.dataset.privilege,
          ),
        otherId,
      );
    await one.open('/staff');
    await act('grant-reviewer');
    check(
      'privileges',
      page.url().startsWith(`${origin}/staff?done=granted`) &&
        ((await one.text('#staff-confirmation')) ?? '').includes('confirmed') &&
        (await chips()).join() === 'reviewer',
      `granting led to ${page.url()} with [${await chips()}]`,
    );
    await two.open('/');
    check(
      'privileges',
      (await two.text('#my-privileges')) === 'Reviewer',
      `the second person now holds "${await two.text('#my-privileges')}"`,
    );
    // Reviewer is not administrator.
    await two.open('/staff');
    check('privileges', (await two.text('#forbidden')) !== null, 'a reviewer can administer staff');

    // The server removes the privilege; the answer is lost.
    relay.mode = 'lose';
    await act('remove-reviewer');
    check(
      'lost answer',
      relay.lost[0] === `POST /staff/accounts/${otherId}/privileges -> 200` &&
        page.url().startsWith(`${origin}/staff?error=unconfirmed`),
      `a lost answer led to ${page.url()}: ${relay.lost}`,
    );
    relay.mode = 'pass';
    await one.open('/staff');
    check(
      'lost answer',
      (await chips()).length === 0,
      `after the connection returned the list shows [${await chips()}]`,
    );
    // Asked again, nothing is done twice: there is nothing left to remove, so the control now
    // offers the grant, and granting twice in a row says so.
    await act('grant-reviewer');
    check('privileges', (await chips()).join() === 'reviewer', 'granting again failed');

    await act('disable');
    check(
      'staff accounts',
      page.url().startsWith(`${origin}/staff?done=disabled`) &&
        (await page.evaluate(
          (id) => document.querySelector(`#account-${id} [data-status]`).dataset.status,
          otherId,
        )) === 'disabled',
      `disabling led to ${page.url()}`,
    );
    // The disabled person's open page is ended at their next request, and they cannot sign in.
    await two.open('/');
    check(
      'staff accounts',
      two.page.url() === `${origin}/sign-in?error=session_ended`,
      `a disabled person's next request went to ${two.page.url()}`,
    );
    await two.signIn(otherEmail, otherPassword, otherCodes[0]);
    check(
      'staff accounts',
      two.page.url() === `${origin}/sign-in?error=refused`,
      `a disabled person signing in went to ${two.page.url()}`,
    );
    await act('enable');
    await page.click(`#account-${otherId} [data-action="issue-link"]`);
    await page.waitForSelector(`#issued-link-${otherId}`);
    check(
      'staff accounts',
      ((await one.text(`#issued-link-${otherId} [data-link]`)) ?? '').startsWith(
        `${origin}/enrol#`,
      ),
      'a new enrolment link was not shown',
    );
    // The declaration is changed, and that is recorded.
    // Done with the keyboard alone: open the disclosure, choose with the arrow keys or Space,
    // and send the form with Enter.
    await one.open('/staff');
    await page.focus(`#account-${otherId} summary`);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    const radioFocused = await page.evaluate(() => document.activeElement?.type);
    await page.keyboard.press('Space');
    const chosen = await page.evaluate(() => document.activeElement?.value);
    if (chosen !== 'declared_none') await page.keyboard.press('ArrowUp');
    check(
      'keyboard',
      radioFocused === 'radio' &&
        (await page.evaluate(
          (id) =>
            document.querySelector(`#account-${id} input[name=participantLink]:checked`)?.value,
          otherId,
        )) === 'declared_none',
      `the declaration could not be chosen with the keyboard (focus was on ${radioFocused})`,
    );
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.keyboard.press('Enter'),
    ]);
    check(
      'staff accounts',
      page.url().startsWith(`${origin}/staff?done=declared`) &&
        (await page.evaluate(
          (id) => document.querySelector(`#account-${id} [data-link]`).dataset.link,
          otherId,
        )) === 'declared_none',
      `changing the declaration led to ${page.url()}`,
    );
    // Enabled again, the person signs in with a recovery code, which then is spent.
    await two.signIn(otherEmail, otherPassword, otherCodes[0]);
    check(
      'sign-in',
      two.page.url() === `${origin}/` && (await two.text('#recovery-left')) === '9 of 10',
      `signing in with a recovery code led to ${two.page.url()} with ${await two.text('#recovery-left')} left`,
    );

    // ------------------------------------------------------------------------------------
    // The audit list
    // ------------------------------------------------------------------------------------
    await one.open('/audit');
    const audit = await page.evaluate(() =>
      [...document.querySelectorAll('#audit-list li')].map((item) => ({
        action: item.dataset.action,
        outcome: item.dataset.outcome,
        text: item.textContent,
      })),
    );
    const refusedViews = audit.filter(
      (entry) =>
        entry.outcome === 'refused' &&
        ['staff.list', 'staff.audit_list'].includes(entry.action) &&
        entry.text.includes(otherEmail),
    );
    check(
      'audit',
      refusedViews.length >= 3 &&
        audit.some((entry) => entry.action === 'staff.bootstrap') &&
        audit.some(
          (entry) => entry.action === 'staff.privilege.grant' && entry.outcome === 'done',
        ) &&
        audit.some((entry) => entry.action === 'staff.participant_link'),
      `the audit list holds ${audit.length} entries, ${refusedViews.length} refused views`,
    );
    const auditText = await page.content();
    check(
      'audit',
      ![
        adminPassword,
        otherPassword,
        adminKey,
        otherKey,
        'enrol#',
        '+99988000123',
        ...adminCodes,
      ].some((secret) => auditText.includes(secret)),
      'the audit list shows a password, a key, a link, a recovery code or a phone number',
    );
    await one.inspect('audit');

    // ------------------------------------------------------------------------------------
    // Organisation verification: queue, application, decision, withdrawal
    // ------------------------------------------------------------------------------------
    // A participant (a test account, by the API) creates an organisation in a fictional
    // country and submits it. The staff screens are driven in the browser.
    const participant = async (method, route, { token, body, key } = {}) => {
      const response = await fetch(apiOrigin + route, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(key ? { 'idempotency-key': key } : {}),
          ...(route.startsWith('/auth/code')
            ? { 'x-trucker-development-code': 'local-visitor' }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const raw = await response.text();
      return { status: response.status, body: raw ? JSON.parse(raw) : {} };
    };
    const newKey = () => `console-${randomBytes(12).toString('hex')}`;
    const asked = await participant('POST', '/auth/code-requests', {
      body: { phone: '+99988000777' },
      key: newKey(),
    });
    const signedIn = await participant('POST', '/auth/code-verifications', {
      body: { challengeId: asked.body.challengeId, code: asked.body.developmentCode },
      key: newKey(),
    });
    const applicant = signedIn.body.token;
    const terms = await participant('GET', '/registration/terms?language=en', { token: applicant });
    await participant('POST', '/me/registration', {
      token: applicant,
      body: {
        displayName: 'Console Test Applicant (fictional)',
        termsVersion: terms.body.version,
        termsLanguage: 'en',
        termsSeen: true,
      },
    });
    const madeOrg = await participant('POST', '/organisations', {
      token: applicant,
      key: newKey(),
      body: {
        legalName: 'Console Fixture Haulage (fictional)',
        countryCode: 'XA',
        registrationNumber: 'CON-0001',
      },
    });
    const applicantOrg = madeOrg.body.organisation?.id;
    const overviewOf = async () =>
      (
        await participant('GET', `/organisations/${applicantOrg}/verification`, {
          token: applicant,
        })
      ).body.verification;
    const submitApplication = async () =>
      participant('POST', `/organisations/${applicantOrg}/verification/applications`, {
        token: applicant,
        key: newKey(),
        body: {
          version: (await overviewOf()).organisation.version,
          declarationAccepted: true,
          declarationLanguage: 'en',
          evidence: [
            {
              documentType: 'registration_certificate',
              documentNumber: 'REG-0001',
              issuingCountry: 'XA',
              issuedOn: '2025-01-15',
              expiresOn: null,
            },
            {
              documentType: 'transport_licence',
              documentNumber: 'LIC-0002',
              issuingCountry: 'XA',
              issuedOn: null,
              expiresOn: null,
            },
          ],
        },
      });
    const sent = await submitApplication();
    check(
      'verification',
      sent.status === 201,
      `the test applicant could not submit: ${sent.status} ${JSON.stringify(sent.body)}`,
    );
    const applicationId = sent.body.verification?.applications[0].id;
    // Read directly, as the migration role, to show that a retry changes nothing.
    const db = new pg.Client({ connectionString: databaseUrl.toString() });
    await db.connect();
    closers.push(() => db.end());

    // An administrator who is not a reviewer does not see applications; it is recorded.
    for (const path of ['/verification', `/verification/${applicationId}`]) {
      await one.open(path);
      check(
        'verification',
        (await one.text('#forbidden')) !== null &&
          !(await page.content()).includes('Console Fixture Haulage'),
        `${path} is shown to an administrator who is not a reviewer`,
      );
    }
    // The reviewer sees the queue and the application.
    await two.open('/verification');
    check(
      'verification',
      (await two.page.evaluate(
        (id) => document.querySelector(`#queue [data-application="${id}"]`)?.dataset.status,
        applicationId,
      )) === 'submitted',
      'the queue does not show the submitted application',
    );
    await two.inspect('verification queue');
    await two.submit(`#queue [data-application="${applicationId}"] a`);
    check(
      'verification',
      two.page.url() === `${origin}/verification/${applicationId}` &&
        ((await two.text('#demonstration-notice')) ?? '').includes('Demonstration only') &&
        ((await two.text('#application-facts')) ?? '').includes('CON-0001') &&
        (await two.page.evaluate(() => document.querySelectorAll('.evidence li').length)) === 2 &&
        (await two.text('#competing')) === null,
      `opening the application led to ${two.page.url()}`,
    );
    await two.inspect('application');
    // "Other" without a note is not a decision.
    await two.page.select('#decision', 'changes_requested:other');
    await two.page.click('#noConflict');
    await two.submit('#record-decision');
    check(
      'verification',
      two.page.url().includes('error=validation_failed') &&
        (await two.text('#review-error')) !== null &&
        (await overviewOf()).applications[0].status === 'submitted',
      `"other" without a note led to ${two.page.url()}`,
    );
    // Changes requested, with the keyboard alone: choose, type the note, tick, send.
    await two.page.focus('#decision');
    await two.page.select('#decision', 'changes_requested:evidence_unclear');
    await two.page.keyboard.press('Tab');
    await two.page.keyboard.type('Please give the full licence number.');
    await two.page.keyboard.press('Tab');
    await two.page.keyboard.press('Space');
    await two.page.keyboard.press('Tab');
    await Promise.all([
      two.page.waitForNavigation({ waitUntil: 'networkidle0' }),
      two.page.keyboard.press('Enter'),
    ]);
    const afterAsk = await overviewOf();
    check(
      'verification',
      two.page.url().includes('done=decided') &&
        (await two.text('#review-confirmation')) !== null &&
        (await two.page.evaluate(() => document.querySelector('#decision-form'))) === null &&
        afterAsk.organisation.status === 'changes_requested' &&
        afterAsk.applications[0].decisionNote === 'Please give the full licence number.',
      `requesting changes led to ${two.page.url()} and the organisation is ${afterAsk.organisation.status}`,
    );
    // A new version; the reviewer sees the earlier one beside it, and verifies.
    const resent = await submitApplication();
    const secondApplication = resent.body.verification.applications[0].id;
    await two.open(`/verification/${secondApplication}`);
    check(
      'verification',
      (await two.page.evaluate(() => document.querySelectorAll('#earlier > li').length)) === 1 &&
        ((await two.text('#earlier')) ?? '').includes('Please give the full licence number.'),
      'the earlier version and its decision are not shown to the reviewer',
    );
    // The decision is recorded and its answer is lost on the way back.
    const recorded = async () => ({
      application: (
        await db.query(
          `SELECT status, decided_by, decided_at, decision_reason, row_version
           FROM trucker.verification_application WHERE id = $1`,
          [secondApplication],
        )
      ).rows[0],
      capabilities: (
        await db.query(
          `SELECT status, granted_at FROM trucker.organisation_capability WHERE organisation_id = $1`,
          [applicantOrg],
        )
      ).rows,
      organisationEntries: Number(
        (
          await db.query(
            'SELECT count(*) AS n FROM trucker.audit_entry WHERE organisation_id = $1',
            [applicantOrg],
          )
        ).rows[0].n,
      ),
      decisionEntries: Number(
        (
          await db.query(
            `SELECT count(*) AS n FROM trucker.staff_audit_entry
             WHERE action = 'staff.verification_decide' AND detail ->> 'application' = $1`,
            [secondApplication],
          )
        ).rows[0].n,
      ),
    });
    await two.page.select('#decision', 'verified:evidence_accepted');
    await two.page.click('#noConflict');
    relay.lost.length = 0;
    relay.mode = 'lose';
    await two.submit('#record-decision');
    check(
      'lost answer',
      relay.lost[0] === `POST /staff/verification/${secondApplication}/decision -> 200` &&
        two.page.url().includes('error=unconfirmed') &&
        (await two.text('#review-confirmation')) === null,
      `a lost decision answer led to ${two.page.url()}: ${relay.lost}`,
    );
    relay.mode = 'pass';
    // The page could not be shown either; trying again keeps what was sent.
    if ((await two.page.$('#retry')) !== null) await two.submit('#retry');
    const afterLost = await recorded();
    check(
      'lost answer',
      afterLost.application.status === 'verified' &&
        afterLost.capabilities.length === 1 &&
        afterLost.decisionEntries === 1 &&
        ((await two.text('#review-error h2')) ?? '') === 'Not confirmed' &&
        ((await two.text('#review-error')) ?? '').includes('not confirmed') &&
        (await two.page.$('#resend-form')) !== null &&
        (await two.page.evaluate(
          () => document.querySelector('#application-status').dataset.status,
        )) === 'verified',
      `after the lost answer the page is ${two.page.url()}, the application ${afterLost.application.status}`,
    );
    await two.inspect('lost decision');
    // Sent again: the original result is confirmed, and nothing is decided, granted or
    // recorded a second time.
    await two.page.click('#resendNoConflict');
    await two.submit('#resend-decision');
    const afterRetry = await recorded();
    check(
      'lost answer',
      two.page.url().includes('done=already_decided') &&
        ((await two.text('#review-confirmation')) ?? '').includes('Nothing was recorded twice') &&
        JSON.stringify(afterRetry) === JSON.stringify(afterLost),
      `the retry led to ${two.page.url()}; before ${JSON.stringify(afterLost)}, after ${JSON.stringify(afterRetry)}`,
    );
    const afterVerify = await overviewOf();
    check(
      'verification',
      afterVerify.organisation.status === 'verified' &&
        afterVerify.capability?.basis === 'demonstration',
      `the organisation is ${afterVerify.organisation.status}`,
    );

    // Published shipments, read-only: the applicant publishes, the reviewer reads.
    const zoned = (hours, offsetHours) =>
      new Date(Date.now() + (hours + offsetHours) * 3_600_000).toISOString().slice(0, 16);
    const madeDraft = await participant('POST', `/organisations/${applicantOrg}/shipments`, {
      token: applicant,
      key: newKey(),
      body: {
        shipperReference: 'CONSOLE-PUB-1',
        cargoDescription: 'Boxed tiles (fictional)',
        grossWeightKg: '9000',
        pickup: {
          address: 'Warehouse 1 (fictional)',
          countryCode: 'XA',
          timeZone: 'Etc/GMT-4',
          from: { local: zoned(48, 4) },
          until: { local: zoned(50, 4) },
        },
        delivery: {
          address: 'Depot 2 (fictional)',
          countryCode: 'XB',
          timeZone: 'Etc/GMT-3',
          from: { local: zoned(54, 3) },
          until: { local: zoned(58, 3) },
        },
      },
    });
    const publishedShipment = madeDraft.body.shipment?.id;
    const publishedReply = await participant(
      'POST',
      `/organisations/${applicantOrg}/shipments/${publishedShipment}/publish`,
      {
        token: applicant,
        key: newKey(),
        body: {
          version: madeDraft.body.shipment?.version,
          cargoCategory: 'general_dry',
          equipmentType: 'box',
          dangerousGoods: false,
          pickupArea: 'North area (fictional)',
          deliveryArea: 'Port area (fictional)',
          quotationDeadline: { local: zoned(24, 4) },
        },
      },
    );
    check(
      'shipments',
      publishedReply.status === 200,
      `publishing answered ${publishedReply.status}`,
    );
    await two.open('/shipments');
    check(
      'shipments',
      (await two.page.evaluate(
        (id) => document.querySelector(`#shipments [data-shipment="${id}"]`)?.dataset.state,
        publishedShipment,
      )) === 'published',
      'the published shipment is not listed for the reviewer',
    );
    await two.inspect('published shipments');
    await two.submit(`#shipments [data-shipment="${publishedShipment}"] a`);
    check(
      'shipments',
      two.page.url() === `${origin}/shipments/${publishedShipment}` &&
        ((await two.text('#carrier-view')) ?? '').includes('verified_shipper') &&
        !((await two.text('#carrier-view')) ?? '').includes('Warehouse 1') &&
        ((await two.text('#shipment-record')) ?? '').includes('Warehouse 1') &&
        (await two.page.$('form')) === null,
      `the shipment page is ${two.page.url()}`,
    );
    await two.inspect('published shipment');
    // Fleet: an ownership claim waits for a decision. The claim is put in place directly (the
    // carrier's own screens are checked in the web application's checks).
    const claimId = (
      await db.query(
        `INSERT INTO trucker.vehicle
           (organisation_id, kind, category_code, equipment_type, registration_country,
            registration_number, created_by, created_at, updated_at)
         SELECT $1, 'truck', 'fictional_rigid_truck', 'box', 'XA', 'CONSOLE1', m.person_id, now(), now()
         FROM trucker.membership m WHERE m.organisation_id = $1 LIMIT 1
         RETURNING id`,
        [applicantOrg],
      )
    ).rows[0].id;
    await two.open('/fleet');
    check(
      'fleet',
      (await two.page.$(`#claims [data-claim="${claimId}"]`)) !== null &&
        (await two.text('#documents-empty')) !== null &&
        (await two.page.$('#suspension-form')) === null,
      'the claim is not listed for the reviewer',
    );
    await two.inspect('fleet');
    // Without the declaration of independence nothing is decided.
    await two.page.select(`#decision-${claimId}`, 'verified:ownership_evidence_accepted');
    await two.submit(`[data-decide="${claimId}"] button`);
    const ownershipOf = async () =>
      (await db.query('SELECT ownership FROM trucker.vehicle WHERE id = $1', [claimId])).rows[0]
        .ownership;
    check(
      'fleet',
      two.page.url().includes('error=conflict_not_declared') &&
        (await two.text('#fleet-error')) !== null &&
        (await ownershipOf()) === 'claimed',
      `deciding without the declaration led to ${two.page.url()}`,
    );
    await two.page.select(`#decision-${claimId}`, 'verified:ownership_evidence_accepted');
    await two.page.click(`#noConflict-${claimId}`);
    await two.submit(`[data-decide="${claimId}"] button`);
    check(
      'fleet',
      two.page.url().includes('done=decided') &&
        (await ownershipOf()) === 'verified' &&
        (await two.text('#claims-empty')) !== null,
      `verifying the claim led to ${two.page.url()}`,
    );
    // An administrator sees the page and the suspension form.
    await one.open('/fleet');
    check(
      'fleet',
      (await one.text('#forbidden')) === null && (await one.page.$('#suspension-form')) !== null,
      'an administrator cannot read the fleet page',
    );
    await one.page.type('#suspension-id', claimId);
    await one.submit('#record-suspension');
    check(
      'fleet',
      one.page.url().includes('done=suspension_changed') &&
        (await one.page.$(`#suspensions [data-suspension="${claimId}"]`)) !== null,
      `suspending led to ${one.page.url()}`,
    );
    await one.inspect('fleet suspended');
    // An administrator who is not a reviewer reads them too.
    await one.open('/shipments');
    check(
      'shipments',
      (await one.text('#forbidden')) === null,
      'an administrator cannot read published shipments',
    );

    // Withdrawing the verification. The first administrator's own declaration was never
    // recorded, and "not declared" is not "independent": refused.
    const withdraw = async (who, reason = 'verified_in_error') => {
      await who.open(`/verification/withdraw?organisation=${applicantOrg}`);
      await who.page.select('#capability', 'ship');
      await who.page.select('#reason', reason);
      await who.page.click('#noConflict');
      await who.submit('#withdraw-verification');
    };
    await withdraw(one);
    check(
      'verification',
      page.url().includes('error=link_not_declared') &&
        ((await one.text('#review-error')) ?? '').includes('not recorded') &&
        (await overviewOf()).organisation.status === 'verified',
      `an administrator with no declaration withdrawing led to ${page.url()}`,
    );
    await one.inspect('withdraw');
    // The reviewer is made an administrator too, and records the first one's declaration.
    await one.open('/staff');
    await act('grant-staff_admin');
    await two.open('/staff');
    const adminId = await two.page.evaluate(
      (email) =>
        [...document.querySelectorAll('[id^=account-]')]
          .find((item) => item.textContent.includes(email))
          ?.id.slice('account-'.length),
      adminEmail,
    );
    await two.page.evaluate((id) => {
      document.querySelector(`#account-${id} details`).open = true;
    }, adminId);
    await two.page.click(`#account-${adminId} input[name=participantLink][value=declared_none]`);
    await two.submit(`#account-${adminId} [data-action="declare"]`);
    check(
      'verification',
      two.page.url().startsWith(`${origin}/staff?done=declared`),
      `recording the administrator's declaration led to ${two.page.url()}`,
    );
    // Not the one who gave the verification, though now an administrator.
    await withdraw(two);
    check(
      'verification',
      two.page.url().includes('error=different_person_required') &&
        (await overviewOf()).organisation.status === 'verified',
      `the one who verified withdrawing led to ${two.page.url()}`,
    );
    // A different, independent administrator: done, status and capability together.
    await withdraw(one);
    const afterWithdraw = await overviewOf();
    check(
      'verification',
      page.url().includes('done=revoked') &&
        (await one.text('#review-confirmation')) !== null &&
        afterWithdraw.organisation.status === 'verification_withdrawn' &&
        afterWithdraw.capability?.status === 'revoked' &&
        afterWithdraw.mayPublish === false &&
        afterWithdraw.applications.length === 2,
      `withdrawing led to ${page.url()} and the organisation is ${afterWithdraw.organisation.status}`,
    );
    // The published shipment is suspended by the withdrawal, in the same transaction.
    await one.open(`/shipments/${publishedShipment}`);
    check(
      'shipments',
      (await page.evaluate(() => document.querySelector('#shipment-state')?.dataset.state)) ===
        'suspended' && ((await one.text('#suspensions')) ?? '').includes('open'),
      'the shipment is not shown suspended after the verification was withdrawn',
    );
    // Quotations are shown read-only: none was sent for this shipment.
    check(
      'shipments',
      (await page.$('#quotations-title')) !== null &&
        (await page.$('#no-quotations')) !== null &&
        (await page.$('#quotations-unavailable')) === null &&
        (await page.$$('#quotations-title ~ * form')).length === 0,
      'the shipment page does not show its quotations read-only',
    );
    await withdraw(one);
    check(
      'verification',
      page.url().includes('done=already_revoked'),
      `withdrawing again led to ${page.url()}`,
    );
    // All of it is in the audit list, refusals included.
    await one.open('/audit');
    const reviewAudit = await page.evaluate(() =>
      [...document.querySelectorAll('#audit-list li')].map(
        (item) => `${item.dataset.action} ${item.dataset.outcome}`,
      ),
    );
    check(
      'audit',
      [
        'staff.verification_view done',
        'staff.verification_decide done',

        'staff.verification_revoke refused',
        'staff.verification_revoke done',
        'staff.shipment_list done',
        'staff.shipment_view done',
      ].every((entry) => reviewAudit.includes(entry)),
      `the audit list lacks verification entries: ${[...new Set(reviewAudit)].join(', ')}`,
    );

    // ------------------------------------------------------------------------------------
    // Sign-out whose answer is lost: never reported as done
    // ------------------------------------------------------------------------------------
    await one.open('/');
    relay.lost.length = 0;
    relay.mode = 'lose';
    await one.submit('#sign-out');
    check(
      'lost answer',
      relay.lost[0] === 'POST /staff/sign-out -> 204' &&
        page.url() === `${origin}/?error=sign_out_unconfirmed`,
      `a lost sign-out answer led to ${page.url()}: ${relay.lost}`,
    );
    check(
      'lost answer',
      (await page.evaluate(() => document.querySelector('[data-state=unavailable]'))) !== null &&
        ((await one.text('main')) ?? '').includes('may still be active'),
      'with no answer the page claims something about the session',
    );
    relay.mode = 'pass';
    await one.submit('#retry');
    check(
      'lost answer',
      page.url() === `${origin}/sign-in?error=session_ended`,
      `after the connection returned the page is ${page.url()}`,
    );
    // Signed in again with a recovery code, and out again, confirmed this time.
    // With the keyboard alone: type, Tab, Enter.
    await one.open('/sign-in');
    await page.focus('#email');
    await page.keyboard.type(adminEmail);
    await page.keyboard.press('Tab');
    await page.keyboard.type(adminPassword);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.keyboard.press('Enter'),
    ]);
    await page.focus('#code');
    await page.keyboard.type(adminCodes[0]);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.keyboard.press('Enter'),
    ]);
    check('sign-in', page.url() === `${origin}/`, `a recovery code sign-in led to ${page.url()}`);
    await one.submit('#sign-out');
    check(
      'sign-in',
      page.url() === `${origin}/sign-in?done=signed_out` &&
        (await one.text('#signed-out')) !== null,
      `signing out led to ${page.url()}`,
    );
    for (const path of ['/', '/staff', '/audit']) {
      await one.open(path);
      check(
        'gate',
        page.url().startsWith(`${origin}/sign-in`),
        `${path} after sign-out: ${page.url()}`,
      );
    }
    check(
      'scripts',
      one.pageErrors.length === 0 && two.pageErrors.length === 0,
      `script errors: ${[...one.pageErrors, ...two.pageErrors].join(' | ')}`,
    );
  } catch (error) {
    failures.push(`the checks stopped: ${error?.stack ?? error}`);
    if (serverLog.includes('Error') || apiLog.includes('error'))
      console.error(`${serverLog.slice(-2000)}\n${apiLog.slice(-2000)}`);
  } finally {
    for (const close of closers) await close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    server?.kill();
    relayServer?.close();
    if (apiServer) {
      const stopped = new Promise((resolve) => apiServer.once('exit', resolve));
      apiServer.kill();
      await stopped;
    }
    await dropDatabase().catch((error) => console.error('database not dropped:', error));
  }

  console.log(`console checks run: ${JSON.stringify(counts)}`);
  if (failures.length > 0) {
    console.error(
      `${failures.length} failed:\n${failures.map((failure) => ` - ${failure}`).join('\n')}`,
    );
    process.exitCode = 1;
  } else {
    console.log('all console browser checks passed');
  }
}

await main();
