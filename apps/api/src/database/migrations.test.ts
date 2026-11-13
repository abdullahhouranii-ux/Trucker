import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import {
  MigrationError,
  checksumOf,
  defaultMigrationsDir,
  findUnsupportedStatements,
  migrateUp,
  migrationStatus,
  readMigrationFiles,
} from './migrations.js';

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'trucker-migrations-'));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql);
  }
  return dir;
}

async function withDatabase(run: (pool: pg.Pool, url: string) => Promise<void>): Promise<void> {
  const database: TestDatabase = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: database.url, max: 4 });
  try {
    await run(pool, database.url);
  } finally {
    await pool.end();
    await database.drop();
  }
}

const temporaryDirs: string[] = [];
before(() => undefined);
after(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dir(files: Record<string, string>): Promise<string> {
  const created = await migrationsDir(files);
  temporaryDirs.push(created);
  return created;
}

test('the repository migrations are valid and apply to an empty database', async () => {
  const files = await readMigrationFiles(defaultMigrationsDir());
  assert.ok(files.length >= 1);
  await withDatabase(async (pool) => {
    const applied = await migrateUp(pool, defaultMigrationsDir());
    assert.deepEqual(
      applied,
      files.map((file) => file.version),
    );
    const status = await migrationStatus(pool, defaultMigrationsDir());
    assert.deepEqual(status.pending, []);
    assert.deepEqual(status.problems, []);
  });
});

test('a second run applies nothing', async () => {
  await withDatabase(async (pool) => {
    await migrateUp(pool, defaultMigrationsDir());
    assert.deepEqual(await migrateUp(pool, defaultMigrationsDir()), []);
  });
});

test('status on an empty database reports everything pending and creates nothing', async () => {
  await withDatabase(async (pool) => {
    const status = await migrationStatus(pool, defaultMigrationsDir());
    assert.deepEqual(status.applied, []);
    assert.ok(status.pending.length >= 1);
    const table = await pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
    );
    assert.equal(table.rows[0]?.present, false);
  });
});

test('a migration edited after it was applied is detected and blocks further runs', async () => {
  const migrations = await dir({ '0001_first.sql': 'CREATE TABLE a (id integer);' });
  await withDatabase(async (pool) => {
    await migrateUp(pool, migrations);
    await writeFile(path.join(migrations, '0001_first.sql'), 'CREATE TABLE a (id bigint);');
    const status = await migrationStatus(pool, migrations);
    assert.equal(status.problems.length, 1);
    await assert.rejects(migrateUp(pool, migrations), MigrationError);
  });
});

test('an applied migration whose file has gone is reported', async () => {
  const two = await dir({
    '0001_first.sql': 'CREATE TABLE a (id integer);',
    '0002_second.sql': 'CREATE TABLE b (id integer);',
  });
  const one = await dir({ '0001_first.sql': 'CREATE TABLE a (id integer);' });
  await withDatabase(async (pool) => {
    await migrateUp(pool, two);
    const status = await migrationStatus(pool, one);
    assert.equal(status.problems.length, 1);
  });
});

test('gaps and badly named files are refused before the database is touched', async () => {
  const gap = await dir({ '0001_first.sql': 'SELECT 1;', '0003_third.sql': 'SELECT 1;' });
  await assert.rejects(readMigrationFiles(gap), MigrationError);
  const badName = await dir({ 'first.sql': 'SELECT 1;' });
  await assert.rejects(readMigrationFiles(badName), MigrationError);
});

test('a failing migration is rolled back completely and nothing later is applied', async () => {
  const migrations = await dir({
    '0001_first.sql': 'CREATE TABLE a (id integer);',
    '0002_broken.sql': 'CREATE TABLE b (id integer); SELECT * FROM table_that_does_not_exist;',
    '0003_third.sql': 'CREATE TABLE c (id integer);',
  });
  await withDatabase(async (pool) => {
    await assert.rejects(migrateUp(pool, migrations), MigrationError);
    const tables = await pool.query<{ a: boolean; b: boolean; c: boolean }>(
      `SELECT to_regclass('public.a') IS NOT NULL AS a,
              to_regclass('public.b') IS NOT NULL AS b,
              to_regclass('public.c') IS NOT NULL AS c`,
    );
    assert.deepEqual(tables.rows[0], { a: true, b: false, c: false });
    const status = await migrationStatus(pool, migrations);
    assert.deepEqual(status.applied, [1]);
    assert.deepEqual(status.pending, [2, 3]);
  });
});

test('two runners started together apply each migration exactly once', async () => {
  const migrations = await dir({
    '0001_first.sql': 'CREATE TABLE a (id integer); SELECT pg_sleep(0.3);',
    '0002_second.sql': 'CREATE TABLE b (id integer);',
  });
  await withDatabase(async (pool) => {
    const [first, second] = await Promise.all([
      migrateUp(pool, migrations),
      migrateUp(pool, migrations),
    ]);
    assert.deepEqual([...first, ...second].sort(), [1, 2]);
    assert.ok(first.length === 0 || second.length === 0);
    const count = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM public.schema_migrations',
    );
    assert.equal(count.rows[0]?.n, '2');
  });
});

test('the checksum is the same for LF, CRLF, CR and a byte-order mark', () => {
  const lf = 'CREATE TABLE a (\n  id integer\n);\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const cr = lf.replace(/\n/g, '\r');
  assert.equal(checksumOf(crlf), checksumOf(lf));
  assert.equal(checksumOf(cr), checksumOf(lf));
  assert.equal(checksumOf(`\uFEFF${crlf}`), checksumOf(lf));
  assert.notEqual(checksumOf(lf.replace('integer', 'bigint')), checksumOf(lf));
});

test('a migration applied with LF endings is not reported as edited when checked out with CRLF', async () => {
  const sql = 'CREATE TABLE a (\n  id integer\n);\n';
  const migrations = await dir({ '0001_first.sql': sql });
  await withDatabase(async (pool) => {
    await migrateUp(pool, migrations);
    await writeFile(path.join(migrations, '0001_first.sql'), sql.replace(/\n/g, '\r\n'));
    const status = await migrationStatus(pool, migrations);
    assert.deepEqual(status.problems, []);
    assert.deepEqual(status.pending, []);
    assert.deepEqual(await migrateUp(pool, migrations), []);
  });
});

test('every SQL file in the repository is stored with LF endings only', async () => {
  for (const file of await readMigrationFiles(defaultMigrationsDir())) {
    assert.ok(!file.sql.includes('\r'));
  }
});

test('files that control transactions or cannot run in one are refused before any database work', async () => {
  for (const sql of [
    'BEGIN; CREATE TABLE a (id integer); COMMIT;',
    'CREATE TABLE a (id integer);\nCOMMIT;',
    'create index concurrently a_idx on a (id);',
    'VACUUM a;',
    'ROLLBACK;',
    'SAVEPOINT s;',
  ]) {
    assert.ok(findUnsupportedStatements(sql).length > 0, sql);
    await assert.rejects(readMigrationFiles(await dir({ '0001_bad.sql': sql })), MigrationError);
  }
});

test('keywords inside comments, strings and function bodies are not mistaken for statements', () => {
  const sql = `
    -- COMMIT; this is a comment
    /* BEGIN; ROLLBACK; */
    CREATE TABLE notes (body text DEFAULT 'COMMIT; VACUUM');
    CREATE FUNCTION f() RETURNS integer LANGUAGE plpgsql AS $body$
    BEGIN
      RETURN 1;
    END;
    $body$;
    COMMENT ON TABLE notes IS 'begin; end;';`;
  assert.deepEqual(findUnsupportedStatements(sql), []);
});

test('waiting for another runner is bounded', async () => {
  const migrations = await dir({ '0001_first.sql': 'CREATE TABLE a (id integer);' });
  await withDatabase(async (pool) => {
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock('7426018350912'::bigint)");
      const started = Date.now();
      await assert.rejects(migrateUp(pool, migrations, { lockWaitMs: 400 }), MigrationError);
      const waited = Date.now() - started;
      assert.ok(waited >= 400 && waited < 3000, `waited ${waited} ms`);
    } finally {
      await holder.query("SELECT pg_advisory_unlock('7426018350912'::bigint)");
      holder.release();
    }
    assert.deepEqual(await migrateUp(pool, migrations, { lockWaitMs: 400 }), [1]);
  });
});

test('a migration statement waiting on a table lock fails within its bound and is rolled back', async () => {
  const migrations = await dir({
    '0001_first.sql': 'CREATE TABLE a (id integer);',
    '0002_alter.sql': 'ALTER TABLE a ADD COLUMN note text;',
  });
  const first = await dir({ '0001_first.sql': 'CREATE TABLE a (id integer);' });
  await withDatabase(async (pool) => {
    await migrateUp(pool, first);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE a IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await assert.rejects(
        migrateUp(pool, migrations, { statementLockTimeoutMs: 300 }),
        MigrationError,
      );
      assert.ok(Date.now() - started < 3000);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    assert.deepEqual((await migrationStatus(pool, migrations)).pending, [2]);
    assert.deepEqual(await migrateUp(pool, migrations), [2]);
  });
});

test('after a runner is killed mid-migration, nothing is half-applied and the next run completes', async () => {
  const migrations = await dir({
    '0001_first.sql': 'CREATE TABLE a (id integer);',
    '0002_slow.sql': 'CREATE TABLE b (id integer); SELECT pg_sleep(2);',
    '0003_third.sql': 'CREATE TABLE c (id integer);',
  });
  const cli = fileURLToPath(new URL('../cli/migrate.js', import.meta.url));
  await withDatabase(async (pool, url) => {
    const child = spawn(process.execPath, [cli, 'up'], {
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: url, MIGRATIONS_DIR: migrations },
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Wait until the first migration is recorded and the second is in flight, then kill hard.
    for (let i = 0; i < 100; i += 1) {
      const applied = (await migrationStatus(pool, migrations)).applied;
      if (applied.length === 1) break;
      await sleep(50);
    }
    await sleep(300);
    child.kill('SIGKILL');
    await exited;

    const afterKill = await migrationStatus(pool, migrations);
    assert.deepEqual(afterKill.applied, [1]);
    assert.deepEqual(afterKill.problems, []);

    // The server ends the dead session, rolls back and frees the lock; the next run waits for that.
    const applied = await migrateUp(pool, migrations, { lockWaitMs: 15_000 });
    assert.deepEqual(applied, [2, 3]);
    const tables = await pool.query<{ a: boolean; b: boolean; c: boolean }>(
      `SELECT to_regclass('public.a') IS NOT NULL AS a,
              to_regclass('public.b') IS NOT NULL AS b,
              to_regclass('public.c') IS NOT NULL AS c`,
    );
    assert.deepEqual(tables.rows[0], { a: true, b: true, c: true });
    const count = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM public.schema_migrations',
    );
    assert.equal(count.rows[0]?.n, '3');
  });
});
