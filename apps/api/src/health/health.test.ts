import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { loadConfig } from '../config/config.js';
import { defaultMigrationsDir, migrateUp } from '../database/migrations.js';
import { createTestDatabase } from '../testing/test-database.js';

async function startApi(
  databaseUrl: string,
): Promise<{ base: string; close: () => Promise<void> }> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DB_CONNECT_TIMEOUT_MS: '500',
  });
  const app: INestApplication = await NestFactory.create(AppModule.register(config), {
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

test('live is 200 and ready is 200 when the database is reachable and migrated', async () => {
  const database = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: database.url });
  await migrateUp(pool, defaultMigrationsDir());
  await pool.end();
  const api = await startApi(database.url);
  try {
    const live = await fetch(`${api.base}/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'live' });

    const ready = await fetch(`${api.base}/health/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      status: 'ready',
      checks: { database: 'ok', migrations: 'ok' },
    });
  } finally {
    await api.close();
    await database.drop();
  }
});

test('ready is 503 while migrations are pending; live stays 200', async () => {
  const database = await createTestDatabase();
  const api = await startApi(database.url);
  try {
    const ready = await fetch(`${api.base}/health/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), {
      status: 'not_ready',
      checks: { database: 'ok', migrations: 'pending' },
    });
    assert.equal((await fetch(`${api.base}/health/live`)).status, 200);
  } finally {
    await api.close();
    await database.drop();
  }
});

test('ready is 503 when the database is unreachable; live stays 200; no detail leaks', async () => {
  // Port 9 (discard) on localhost: nothing listens there.
  const api = await startApi('postgres://nobody:not-a-real-secret@127.0.0.1:9/none');
  try {
    const ready = await fetch(`${api.base}/health/ready`);
    assert.equal(ready.status, 503);
    const text = await ready.text();
    assert.deepEqual(JSON.parse(text), {
      status: 'not_ready',
      checks: { database: 'unavailable', migrations: 'unknown' },
    });
    assert.ok(!text.includes('not-a-real-secret'));
    assert.equal((await fetch(`${api.base}/health/live`)).status, 200);
  } finally {
    await api.close();
  }
});
