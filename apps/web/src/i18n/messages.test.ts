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
