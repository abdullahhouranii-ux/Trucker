import assert from 'node:assert/strict';
import { test } from 'node:test';
import { direction, isLocale, localeNames, locales, pathInLocale } from './config.ts';

test('English is left to right; Arabic and Urdu are right to left', () => {
  assert.equal(direction('en'), 'ltr');
  assert.equal(direction('ar'), 'rtl');
  assert.equal(direction('ur'), 'rtl');
});

test('only the three designed languages are accepted', () => {
  assert.ok(isLocale('ur'));
  assert.ok(!isLocale('fr'));
  assert.ok(!isLocale('EN'));
  assert.ok(!isLocale(''));
});

test('every language has a name in its own script', () => {
  for (const locale of locales) assert.ok(localeNames[locale].length > 0);
});

test('switching language keeps the rest of the path', () => {
  assert.equal(pathInLocale('/en', 'ar'), '/ar');
  assert.equal(pathInLocale('/en/shipments/new', 'ur'), '/ur/shipments/new');
  assert.equal(pathInLocale('/', 'ar'), '/ar');
  assert.equal(pathInLocale('/shipments', 'ar'), '/ar/shipments');
  assert.equal(pathInLocale('/ur/', 'en'), '/en');
});
