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
const origin = `http://localhost:${port}`;
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

async function main() {
  const server = spawn(
    process.execPath,
    [require.resolve('next/dist/bin/next'), 'start', '-p', String(port)],
    {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
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

    // At most five pictures, for design review only.
    mkdirSync(outDir, { recursive: true });
    for (const [name, path, width, scale] of [
      ['en-1440', '/en', 1440, 1],
      ['ar-390', '/ar', 390, 1],
      ['ur-768', '/ur', 768, 1],
      ['en-390-text-doubled', '/en', 390, 2],
      ['not-found-390', '/ur/no-such-page', 390, 1],
    ]) {
      await open(path, width);
      await page.evaluate(
        (factor) => (document.documentElement.style.fontSize = `${factor * 100}%`),
        scale,
      );
      await page.screenshot({ path: `${outDir}${name}.png`, fullPage: true });
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  console.log('checks run:', JSON.stringify(counts));
  if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const failure of failures.slice(0, 40)) console.error(' - ' + failure);
    if (serverLog.includes('Error')) console.error(serverLog.slice(-2000));
    process.exitCode = 1;
  } else {
    console.log('all browser checks passed');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
