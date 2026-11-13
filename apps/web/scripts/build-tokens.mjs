// Writes src/design/tokens.css from src/design/tokens.json. Run `npm run tokens -w @trucker/web`
// after changing a token. A unit test fails when the two files disagree.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(`../src/design/${name}`, import.meta.url));

export function renderTokens(tokens) {
  const lines = [];
  const add = (name, value) => lines.push(`  --${name}: ${value};`);
  for (const [name, value] of Object.entries(tokens.color)) add(`c-${name}`, value.toLowerCase());
  add('f-latin', tokens.font.latin);
  add('f-arabic', tokens.font.arabic);
  for (const [name, value] of Object.entries(tokens.lineHeight)) add(`lh-${name}`, value);
  for (const [name, value] of Object.entries(tokens.size)) add(`t-${name}`, `${value}rem`);
  for (const [name, value] of Object.entries(tokens.space)) add(`s-${name}`, `${value}rem`);
  for (const [name, value] of Object.entries(tokens.radius)) add(`r-${name}`, `${value}rem`);
  for (const [name, value] of Object.entries(tokens.target)) add(`target-${name}`, `${value}rem`);
  for (const [name, value] of Object.entries(tokens.motion)) add(`motion-${name}`, value);
  return [
    `/* Generated from tokens.json (version ${tokens.version}, ${tokens.status}). Do not edit by hand. */`,
    ':root {',
    ...lines,
    '}',
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tokens = JSON.parse(readFileSync(here('tokens.json'), 'utf8'));
  writeFileSync(here('tokens.css'), renderTokens(tokens));
  console.log(`tokens.css written for version ${tokens.version}`);
}
