// Checks what a developer machine needs and reports each item as ok, missing or optional.
// Exits 1 when a required item is missing, so it can gate other scripts.
import { existsSync } from 'node:fs';
import pg from 'pg';
import { developmentEnv, envFile, probe } from './lib.mjs';

const results = [];
const record = (name, required, ok, detail) => results.push({ name, required, ok, detail });

const nodeMajor = Number(process.versions.node.split('.')[0]);
record('Node.js 22', true, nodeMajor === 22, `found ${process.version}`);

const npm = probe('npm', ['--version']);
const [npmMajor, npmMinor] = npm.output.split('.').map(Number);
record(
  'npm 10.9 or later (below 11)',
  true,
  npm.ok && npmMajor === 10 && npmMinor >= 9,
  npm.ok ? `found ${npm.output}` : 'npm not found',
);

record('dependencies installed (npm ci)', true, existsSync('node_modules/pg'), 'node_modules');

const docker = probe('docker', ['compose', 'version']);
record(
  'Docker with compose (only for the Docker database)',
  false,
  docker.ok,
  docker.ok ? docker.output.split('\n')[0] : 'not available',
);

record('.env file (optional; npm run dev:env creates it)', false, existsSync(envFile), envFile);

const env = developmentEnv();
if (!env.DATABASE_URL) {
  record('DATABASE_URL set', true, false, 'not set in the environment or .env');
} else {
  record('DATABASE_URL set', true, true, 'value not shown');
  const client = new pg.Client({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    const version = (await client.query('SHOW server_version')).rows[0].server_version;
    record('database reachable', true, true, `PostgreSQL ${version}`);
    const major = Number(String(version).split('.')[0]);
    record(
      'PostgreSQL major version 16 (the documented selection)',
      false,
      major === 16,
      `found major ${major}`,
    );
    const canCreate = (
      await client.query(
        'SELECT rolcreatedb OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user',
      )
    ).rows[0]?.ok;
    record('role may create databases (needed by the tests)', true, canCreate === true, '');
  } catch {
    record('database reachable', true, false, 'could not connect; is the database started?');
  } finally {
    await client.end().catch(() => undefined);
  }
}

let failed = false;
for (const { name, required, ok, detail } of results) {
  const state = ok ? 'ok      ' : required ? 'MISSING ' : 'optional';
  if (!ok && required) failed = true;
  console.log(`${state} ${name}${detail ? `  (${detail})` : ''}`);
}
console.log(failed ? '\nNot ready: fix the items marked MISSING.' : '\nReady.');
process.exit(failed ? 1 : 0);
