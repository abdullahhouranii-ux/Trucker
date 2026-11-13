import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { contrastRatio } from './contrast.ts';
import { renderTokens } from '../../scripts/build-tokens.mjs';

type Tokens = {
  version: string;
  color: Record<string, string>;
  contrast: { foreground: string; background: string; minimum: number; use: string }[];
};
const read = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8');
const tokens = JSON.parse(read('./tokens.json')) as Tokens;

test('tokens.css is generated from tokens.json and is up to date', () => {
  assert.equal(read('./tokens.css').replaceAll('\r\n', '\n'), renderTokens(tokens));
});

test('the token version is a three-part version number', () => {
  assert.match(tokens.version, /^\d+\.\d+\.\d+$/);
});

test('contrast ratio matches known values', () => {
  assert.equal(contrastRatio('#000000', '#FFFFFF'), 21);
  assert.equal(contrastRatio('#FFFFFF', '#FFFFFF'), 1);
});

test('every declared colour pair meets its minimum contrast', () => {
  for (const pair of tokens.contrast) {
    const foreground = tokens.color[pair.foreground];
    const background = tokens.color[pair.background];
    assert.ok(foreground && background, `unknown colour in pair for ${pair.use}`);
    const ratio = contrastRatio(foreground, background);
    assert.ok(
      ratio >= pair.minimum,
      `${pair.foreground} on ${pair.background} (${pair.use}) is ${ratio.toFixed(2)}, needs ${pair.minimum}`,
    );
  }
});
