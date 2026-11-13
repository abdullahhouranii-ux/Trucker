// Regression tests for starting processes from the helper scripts. They run on every platform;
// the Windows CI job is where the shell-related failures they guard against would appear.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { npmCliPath, probe, repoRoot, resolveCommand, run } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// A directory whose name contains spaces and characters a shell would interpret.
const awkwardDir = mkdtempSync(path.join(tmpdir(), 'trucker dev & (tools) '));
after(() => rmSync(awkwardDir, { recursive: true, force: true }));

const echoScript = path.join(awkwardDir, 'echo args.mjs');
writeFileSync(echoScript, 'console.log(JSON.stringify(process.argv.slice(2)));\n');

// Every one of these would be split, expanded or executed by cmd.exe or a POSIX shell.
const HOSTILE_ARGUMENTS = [
  'two words',
  '  leading and trailing  ',
  'amp&ersand',
  'pipe|char',
  'semi;colon',
  'redirect>stolen.txt',
  'input<file',
  '%PATH%',
  '%USERPROFILE%\\x',
  '$HOME',
  '$(whoami)',
  '`whoami`',
  '"double quoted"',
  "it's",
  '^caret^',
  'back\\slash\\',
  'trailing backslash before quote\\"',
  'paren(the)sis',
  'excl!amation',
  'star*and?',
  'a && echo injected',
  '',
];

function echoed(output) {
  return JSON.parse(output.trim().split('\n').at(-1));
}

test('arguments with spaces and shell-special characters arrive unchanged', () => {
  const result = probe('node', [echoScript, ...HOSTILE_ARGUMENTS]);
  assert.ok(result.ok, result.output);
  assert.deepEqual(echoed(result.output), HOSTILE_ARGUMENTS);
});

test('nothing is interpreted: no redirect target is created and no command is injected', () => {
  probe('node', [echoScript, ...HOSTILE_ARGUMENTS], { cwd: awkwardDir });
  assert.deepEqual(readdirSync(awkwardDir).sort(), ['echo args.mjs']);
  assert.ok(!existsSync(path.join(repoRoot, 'stolen.txt')));
});

test('a script in a path with spaces and special characters runs, also as the working directory', () => {
  const result = probe('node', ['echo args.mjs', 'x y'], { cwd: awkwardDir });
  assert.ok(result.ok, result.output);
  assert.deepEqual(echoed(result.output), ['x y']);
});

test('run() returns the exit code and preserves arguments', () => {
  const marker = path.join(awkwardDir, 'ran with args.json');
  const writer = path.join(awkwardDir, 'write args.mjs');
  writeFileSync(
    writer,
    "import { writeFileSync } from 'node:fs';\n" +
      'writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n' +
      'process.exit(7);\n',
  );
  const code = run('node', [writer, marker, 'a b', 'c&d', '%PATH%'], { stdio: 'ignore' });
  assert.equal(code, 7);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), ['a b', 'c&d', '%PATH%']);
  rmSync(marker);
  rmSync(writer);
});

test('with-env.mjs passes its command and arguments through unchanged', () => {
  const result = probe('node', [
    path.join(here, 'with-env.mjs'),
    'node',
    echoScript,
    'arg with space',
    'a&b|c',
    '%PATH%',
    '"q"',
  ]);
  assert.ok(result.ok, result.output);
  assert.deepEqual(echoed(result.output), ['arg with space', 'a&b|c', '%PATH%', '"q"']);
});

test('npm is started as node + npm-cli.js, never as a batch file or through a shell', () => {
  const cli = npmCliPath();
  assert.ok(cli, 'npm-cli.js not found next to this Node.js');
  const resolved = resolveCommand('npm', ['--version']);
  assert.equal(resolved.file, process.execPath);
  assert.deepEqual(resolved.args, [cli, '--version']);
  assert.ok(!/\.(cmd|bat)$/i.test(resolved.file));

  const version = probe('npm', ['--version']);
  assert.ok(version.ok, version.output);
  assert.match(version.output, /^\d+\.\d+\.\d+$/);
});

test('on Windows, a missing npm-cli.js is refused instead of falling back to a shell', () => {
  assert.equal(npmCliPath({}, path.join(awkwardDir, 'nowhere', 'node.exe')), undefined);
  const notFound = { findNpmCli: () => undefined };
  assert.throws(
    () => resolveCommand('npm', ['--version'], { ...notFound, platform: 'win32' }),
    /refusing to start npm\.cmd through a shell/,
  );
  // On Unix npm is a real executable, so it may be started directly, still without a shell.
  assert.deepEqual(resolveCommand('npm', ['--version'], { ...notFound, platform: 'linux' }), {
    file: 'npm',
    args: ['--version'],
  });
});

test('npm receives a path with spaces and passes script arguments with spaces through', () => {
  // A throw-away package inside the awkward directory, run through the real npm launcher.
  const projectDir = path.join(awkwardDir, 'npm project');
  mkdirSync(projectDir);
  writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'probe', private: true, scripts: { show: 'node show.mjs' } }),
  );
  writeFileSync(
    path.join(projectDir, 'show.mjs'),
    'console.log(JSON.stringify(process.argv.slice(2)));\n',
  );
  const result = probe('npm', [
    '--prefix',
    projectDir,
    'run',
    '--silent',
    'show',
    '--',
    'two words',
    'plain',
  ]);
  assert.ok(result.ok, result.output);
  assert.deepEqual(echoed(result.output), ['two words', 'plain']);
  rmSync(projectDir, { recursive: true, force: true });
});

test('no helper script asks for a shell', () => {
  for (const file of readdirSync(here).filter((name) => name.endsWith('.mjs'))) {
    if (file === 'lib.test.mjs') continue;
    const source = readFileSync(path.join(here, file), 'utf8');
    assert.ok(!/shell:\s*(true|windows)/.test(source), `${file} starts a shell`);
    assert.ok(!/\b(exec|execSync)\(/.test(source), `${file} uses exec, which starts a shell`);
  }
});
