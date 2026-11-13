// Shared helpers for the local development scripts. Plain Node.js, no dependencies beyond the
// workspace, so the same commands work on Linux, macOS and Windows.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const envFile = path.join(repoRoot, '.env');
export const envExample = path.join(repoRoot, '.env.example');
export const composeFile = path.join(repoRoot, 'tools', 'dev', 'docker-compose.yml');
const windows = process.platform === 'win32';

/** Values from .env, with anything already set in the real environment taking precedence. */
export function developmentEnv() {
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

/** Runs a command, inheriting the terminal. Returns its exit code (1 if it could not start). */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    // npm and npx are batch files on Windows and need a shell there.
    shell: windows,
    ...options,
  });
  return result.status ?? 1;
}

/** Runs a command quietly and returns { ok, output }. Never throws. */
export function probe(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', shell: windows });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}
