// Two design-review images plus font/resource evidence. No account or production data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { repoRoot } from './lib.mjs';

const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const out = path.join(repoRoot, 'apps/web/tests/output');
mkdirSync(out, { recursive: true });
const origin = 'http://127.0.0.1:3139';
const server = spawn(
  process.execPath,
  [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '-p', '3139'],
  {
    cwd: path.join(repoRoot, 'apps/web'),
    shell: false,
    stdio: 'ignore',
  },
);
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80 && !ready; attempt++) {
    ready = await fetch(`${origin}/en`)
      .then((reply) => reply.ok)
      .catch(() => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'review server did not start');
  browser = await puppeteer.launch({
    executablePath:
      process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const evidence = [];
  for (const [locale, width, image] of [
    ['en', 1440, 'redesign-home-en.png'],
    ['ar', 390, 'redesign-home-ar.png'],
  ]) {
    await page.setViewport({ width, height: 1000 });
    await page.goto(`${origin}/${locale}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const facts = await page.evaluate(() => ({
      width: innerWidth,
      contentWidth: document.documentElement.scrollWidth,
      font: getComputedStyle(document.body).fontFamily,
      loadedFonts: [...document.fonts]
        .filter((font) => font.status === 'loaded')
        .map((font) => font.family),
      fontRequests: performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.includes('.woff2')).length,
    }));
    assert.ok(facts.contentWidth <= width + 1);
    assert.ok(
      facts.loadedFonts.some((font) => facts.font.includes(font.replaceAll('"', ''))),
      'actual body font must be loaded',
    );
    await page.screenshot({ path: path.join(out, image), fullPage: true });
    evidence.push({ locale, ...facts });
  }
  writeFileSync(path.join(out, 'redesign-resources.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  server.kill();
}
