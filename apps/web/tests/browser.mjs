// Browser checks for the built web application. Run `npm run test:browser` from the repository
// root: it builds the application, serves it with `next start` and drives a real Chrome.
//
// Needs a Chrome or Chromium binary. Set CHROME_PATH, or install one at a usual location.
// What these checks do not cover is listed in docs/delivery/WEB_FOUNDATION_SLICE_3.md.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const port = Number(process.env.WEB_TEST_PORT ?? 3101);
const apiPort = Number(process.env.API_TEST_PORT ?? 3102);
const origin = `http://localhost:${port}`;
const apiMain = fileURLToPath(new URL('../../api/dist/main.js', import.meta.url));
const apiMigrate = fileURLToPath(new URL('../../api/dist/cli/migrate.js', import.meta.url));
const appDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('./output/', import.meta.url));
const locales = ['en', 'ar', 'ur'];
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
  // development configuration; the resend wait is shortened so the checks do not take minutes.
  const apiEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(apiPort),
    SIGN_IN_CODE_DELIVERY: 'development-display',
    REGISTRATION_TERMS: 'demonstration',
    SIGN_IN_CODE_RESEND_WAIT_SECONDS: '10',
    SIGN_IN_CODE_MAX_PER_HOUR: '30',
  };
  await run(apiMigrate, ['up'], apiEnv);
  const apiServer = spawn(process.execPath, [apiMain], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: apiEnv,
  });
  let apiLog = '';
  apiServer.stdout.on('data', (chunk) => (apiLog += chunk));
  apiServer.stderr.on('data', (chunk) => (apiLog += chunk));

  const server = spawn(
    process.execPath,
    [require.resolve('next/dist/bin/next'), 'start', '-p', String(port)],
    {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        TRUCKER_API_URL: `http://127.0.0.1:${apiPort}`,
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
      'en:sign-in error': 'sign-in-error-en-390',
      'ur:code': 'code-ur-390',
      'ar:register error': 'register-error-ar-390',
      'ur:register': 'register-ur-390',
      'en:account': 'account-en-390',
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
      // Sign out before the next language, so each run starts as a visitor. The last stays signed in.
      if (index < locales.length - 1) await submit('form button.button-primary');
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
          apiLog.replace(/"time":"[^"]*"/g, '').replace(/"requestId":"[^"]*"/g, ''),
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

    // Signing out ends the session; the account then needs a new sign-in.
    await submit('form button.button-primary');
    check('journey sessions', page.url() === `${origin}/ur`, `signing out led to ${page.url()}`);
    await open('/ur/account', 390);
    check(
      'journey sessions',
      page.url().startsWith(`${origin}/ur/sign-in`),
      `after signing out the account opened ${page.url()}`,
    );

    // A second code for the same number straight away is refused, with the wait in the message.
    await page.type('#phone', people.en.phone);
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
    apiServer.kill();
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
