import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { locales } from './config.ts';

type Json = string | Json[] | { [key: string]: Json };
const load = (locale: string): Json =>
  JSON.parse(readFileSync(new URL(`./messages/${locale}.json`, import.meta.url), 'utf8')) as Json;

// Flattens a catalogue to "path -> text" so shapes can be compared.
function flatten(value: Json, path = ''): Map<string, string> {
  if (typeof value === 'string') return new Map([[path, value]]);
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  const result = new Map<string, string>();
  for (const [key, child] of entries) {
    for (const [childPath, text] of flatten(child, path ? `${path}.${key}` : key))
      result.set(childPath, text);
  }
  return result;
}

const reference = flatten(load('en'));

for (const locale of locales) {
  const catalogue = flatten(load(locale));

  test(`${locale}: has exactly the keys of the English catalogue`, () => {
    assert.deepEqual([...catalogue.keys()].sort(), [...reference.keys()].sort());
  });

  test(`${locale}: no message is empty or padded`, () => {
    for (const [key, text] of catalogue) {
      assert.ok(text.trim().length > 0, `${key} is empty`);
      assert.equal(text, text.trim(), `${key} has surrounding spaces`);
    }
  });
}

test('Arabic and Urdu messages are written in Arabic script, apart from the product name', () => {
  for (const locale of ['ar', 'ur']) {
    for (const [key, text] of flatten(load(locale))) {
      assert.match(
        text.replaceAll('Trucker', ''),
        /[؀-ۿ]/,
        `${locale} ${key} has no Arabic-script text`,
      );
    }
  }
});

test('an unconfirmed revocation is worded as uncertain, never as still active', () => {
  // The request may have been carried out and only the answer lost, so the session may or may
  // not be active. Each language must say "may", and must not say it is still signed in.
  const uncertain: Record<string, string> = {
    en: 'may still be active',
    ar: 'قد تكون',
    ur: 'ہو سکت',
  };
  const definite: Record<string, string[]> = {
    en: ['is still active', 'are still active', 'still signed in'],
    ar: ['ما زلت مسجّل', 'لذلك ما زالت'],
    ur: ['ابھی تک سائن اِن ہیں', 'ابھی فعال ہے۔', 'ابھی فعال ہیں۔'],
  };
  for (const locale of locales) {
    const messages = flatten(load(locale));
    for (const key of [
      'sign_out_unconfirmed',
      'end_session_unconfirmed',
      'end_others_unconfirmed',
    ]) {
      const text = messages.get(`auth.errors.${key}`) ?? '';
      assert.ok(text.includes(uncertain[locale] ?? '?'), `${locale} ${key}: ${text}`);
      for (const phrase of definite[locale] ?? [])
        assert.ok(!text.includes(phrase), `${locale} ${key} says "${phrase}"`);
    }
  }
});
