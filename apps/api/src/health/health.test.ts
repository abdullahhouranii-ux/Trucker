import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { loadConfig } from '../config/config.js';
import { defaultMigrationsDir, migrateUp } from '../database/migrations.js';
import { createTestDatabase } from '../testing/test-database.js';
import { HealthService } from './health.service.js';

async function startApi(
  databaseUrl: string,
  overrides: Record<string, string> = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    DB_CONNECT_TIMEOUT_MS: '500',
    ...overrides,
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

test('the readiness check returns within its deadline when a query never answers', async () => {
  const neverAnswers = { query: () => new Promise<never>(() => undefined) };
  const service = new HealthService(neverAnswers as never, { HEALTH_CHECK_TIMEOUT_MS: 200 });
  const started = Date.now();
  const checks = await service.check();
  assert.deepEqual(checks, { database: 'unavailable', migrations: 'unknown' });
  assert.ok(Date.now() - started < 1000);
});

test('ready is 503 within the deadline when a query on an open connection stalls, then recovers', async () => {
  const database = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: database.url });
  await migrateUp(pool, defaultMigrationsDir());
  const api = await startApi(database.url, {
    HEALTH_CHECK_TIMEOUT_MS: '300',
    DB_STATEMENT_TIMEOUT_MS: '1000',
  });
  const blocker = await pool.connect();
  try {
    assert.equal((await fetch(`${api.base}/health/ready`)).status, 200);

    // An exclusive lock makes the readiness query wait on an established connection.
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE public.schema_migrations IN ACCESS EXCLUSIVE MODE');
    const started = Date.now();
    const stalled = await fetch(`${api.base}/health/ready`);
    const elapsed = Date.now() - started;
    assert.equal(stalled.status, 503);
    assert.deepEqual(await stalled.json(), {
      status: 'not_ready',
      checks: { database: 'ok', migrations: 'unknown' },
    });
    assert.ok(elapsed < 1500, `readiness took ${elapsed} ms`);
    assert.equal((await fetch(`${api.base}/health/live`)).status, 200);

    await blocker.query('ROLLBACK');
    // The abandoned statement is cancelled by the server-side statement timeout.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal((await fetch(`${api.base}/health/ready`)).status, 200);
  } finally {
    blocker.release();
    await api.close();
    await pool.end();
    await database.drop();
  }
});

test('ready is 503 within the deadline when the server accepts connections but never speaks', async () => {
  const sockets: Socket[] = [];
  const silent = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const { port } = silent.address() as AddressInfo;
  const api = await startApi(`postgres://nobody:nothing@127.0.0.1:${port}/none`, {
    HEALTH_CHECK_TIMEOUT_MS: '300',
  });
  try {
    const started = Date.now();
    const ready = await fetch(`${api.base}/health/ready`);
    assert.equal(ready.status, 503);
    assert.ok(Date.now() - started < 1500);
    assert.equal((await fetch(`${api.base}/health/live`)).status, 200);
  } finally {
    await api.close();
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => silent.close(resolve));
  }
});
