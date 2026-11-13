import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { locales } from './config.ts';
import { fill } from './format.ts';

test('placeholders are filled and unknown ones stay visible', () => {
  assert.equal(fill('Wait {seconds} seconds', { seconds: 12 }), 'Wait 12 seconds');
  assert.equal(fill('Code {code}', {}), 'Code {code}');
});

test('every language uses the same placeholders as English in every message', () => {
  type Json = string | Json[] | { [key: string]: Json };
  const flat = (value: Json, path = ''): [string, string][] =>
    typeof value === 'string'
      ? [[path, value]]
      : Object.entries(value).flatMap(([key, child]) => flat(child as Json, `${path}.${key}`));
  const load = (locale: string) =>
    new Map(
      flat(
        JSON.parse(
          readFileSync(new URL(`./messages/${locale}.json`, import.meta.url), 'utf8'),
        ) as Json,
      ),
    );
  const placeholders = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  const english = load('en');
  for (const locale of locales) {
    for (const [key, text] of load(locale)) {
      assert.deepEqual(placeholders(text), placeholders(english.get(key) ?? ''), `${locale}${key}`);
    }
  }
});
