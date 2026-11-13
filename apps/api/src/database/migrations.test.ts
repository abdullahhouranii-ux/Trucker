import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import {
  MigrationError,
  defaultMigrationsDir,
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

async function withDatabase(run: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const database: TestDatabase = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: database.url, max: 4 });
  try {
    await run(pool);
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
