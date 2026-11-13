// Shared helpers for the local development scripts. Plain Node.js, no dependencies beyond the
// workspace, so the same commands work on Linux, macOS and Windows.
//
// Processes are always started WITHOUT a shell. Arguments are passed as an array and reach the
// program exactly as given: spaces, quotes, &, |, %, ; and similar are never interpreted.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const envFile = path.join(repoRoot, '.env');
export const envExample = path.join(repoRoot, '.env.example');
export const composeFile = path.join(repoRoot, 'tools', 'dev', 'docker-compose.yml');

/** Values from .env, with anything already set in the real environment taking precedence. */
export function developmentEnv() {
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

/**
 * Finds npm's JavaScript entry point. On Windows `npm` is a batch file (npm.cmd), which cannot
 * be started without a shell; running npm-cli.js with the current Node.js binary avoids both
 * the batch file and the shell, so argument boundaries are preserved.
 */
export function npmCliPath(env = process.env, execPath = process.execPath) {
  const candidates = [
    // Set by npm itself when a script runs under `npm run`.
    env.npm_execpath,
    // Windows layout: npm sits beside node.exe.
    path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Unix layout: <prefix>/bin/node and <prefix>/lib/node_modules/npm.
    path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find(
    (candidate) => candidate && path.basename(candidate) === 'npm-cli.js' && existsSync(candidate),
  );
}

/**
 * Turns a command name into the real executable and argument list to start, never a shell.
 *  - `node` is the Node.js binary running this script.
 *  - `npm` is that binary running npm-cli.js. Where npm-cli.js cannot be found, plain `npm` is
 *    used on Unix (a real executable there); on Windows that is refused rather than falling back
 *    to a shell.
 *  - Anything else is started as given and must be a real executable (for example docker).
 */
export function resolveCommand(
  command,
  args,
  { platform = process.platform, findNpmCli = npmCliPath } = {},
) {
  if (command === 'node') return { file: process.execPath, args: [...args] };
  if (command === 'npm') {
    const cli = findNpmCli();
    if (cli) return { file: process.execPath, args: [cli, ...args] };
    if (platform === 'win32') {
      throw new Error(
        'npm-cli.js was not found next to node.exe; refusing to start npm.cmd through a shell',
      );
    }
    return { file: 'npm', args: [...args] };
  }
  return { file: command, args: [...args] };
}

/** Runs a command, inheriting the terminal. Returns its exit code (1 if it could not start). */
export function run(command, args, options = {}) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.file, resolved.args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
    shell: false,
  });
  if (result.error) console.error(`could not start ${command}: ${result.error.message}`);
  return result.status ?? 1;
}

/** Runs a command quietly and returns { ok, output }. Never throws. */
export function probe(command, args, options = {}) {
  let resolved;
  try {
    resolved = resolveCommand(command, args);
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
  const result = spawnSync(resolved.file, resolved.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
    shell: false,
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}
