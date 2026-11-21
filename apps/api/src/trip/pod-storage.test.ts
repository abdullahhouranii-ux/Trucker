import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { test } from 'node:test';
import type pg from 'pg';
import type { AccessGuard } from '../database/access.js';
import type { IdentityService } from '../identity/identity.service.js';
import type { FileStore } from '../storage/file-store.js';
import { PodController } from './pod.controller.js';
import { PodService } from './pod.service.js';

// Fault injection at the database boundary: COMMIT is applied but its reply is lost.
// These tests use the real service transaction/cleanup code, not a replacement for it.
function fixture(mode: 'lost-commit' | 'refused' | 'already-received' | 'lost-staff-reply') {
  const files = new Map<string, Buffer>();
  let nextKey = 0;
  let committedKey: string | undefined;
  let calls = 0;
  const disconnected = new Error('database acknowledgement lost');
  const store: FileStore = {
    async put(bytes) {
      const key = `file-${++nextKey}`;
      files.set(key, Buffer.from(bytes));
      return key;
    },
    async get(key) {
      return files.get(key) ?? null;
    },
    async remove(key) {
      files.delete(key);
    },
  };
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('pod_receive')) {
        calls++;
        const receipt = JSON.parse(String(values?.[2])) as { key: string };
        if (mode === 'refused') return { rows: [{ status: 'fingerprint_mismatch' }] };
        if (mode === 'already-received' || committedKey)
          return { rows: [{ status: 'already_received' }] };
        committedKey = receipt.key;
        return { rows: [{ status: 'received' }] };
      }
      if (sql === 'COMMIT' && mode === 'lost-commit' && calls === 1) throw disconnected;
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    async query(_sql: string, values: unknown[]) {
      const receipt = JSON.parse(String(values[3])) as { key: string };
      committedKey = receipt.key;
      throw disconnected;
    },
  } as unknown as pg.Pool;
  const access = { async requireBoundRole() {} } as unknown as AccessGuard;
  return {
    service: new PodService(pool, access, store),
    files,
    disconnected,
    committedKey: () => committedKey,
  };
}

test('lost COMMIT reply preserves the referenced POD bytes; retry removes only its duplicate', async () => {
  const f = fixture('lost-commit');
  const bytes = Buffer.from('evidence that must survive');
  const upload = () =>
    f.service.receive({ tokenHash: 'caller' }, 'org', 'booking', 'item', 'image/png', bytes);
  await assert.rejects(upload, (error) => error === f.disconnected);
  const original = f.committedKey()!;
  assert.deepEqual(f.files.get(original), bytes);
  assert.equal((await upload()).outcome, 'already_received');
  assert.equal(f.files.size, 1);
  assert.deepEqual(f.files.get(original), bytes);
});

test('lost staff function reply preserves committed evidence', async () => {
  const f = fixture('lost-staff-reply');
  const bytes = Buffer.from('staff evidence');
  await assert.rejects(
    f.service.receive({ tokenHash: 'staff' }, null, 'booking', 'item', 'image/png', bytes),
    (error) => error === f.disconnected,
  );
  assert.deepEqual(f.files.get(f.committedKey()!), bytes);
});

test('confirmed rejection removes only the rejected upload', async () => {
  const f = fixture('refused');
  f.files.set('previous-evidence', Buffer.from('keep'));
  await assert.rejects(
    f.service.receive(
      { tokenHash: 'caller' },
      'org',
      'booking',
      'item',
      'image/png',
      Buffer.from('bad'),
    ),
  );
  assert.deepEqual([...f.files.keys()], ['previous-evidence']);
});

test('confirmed duplicate upload is cleaned up', async () => {
  const f = fixture('already-received');
  const result = await f.service.receive(
    { tokenHash: 'caller' },
    'org',
    'booking',
    'item',
    'image/png',
    Buffer.from('duplicate'),
  );
  assert.equal(result.outcome, 'already_received');
  assert.equal(f.files.size, 0);
});

for (const [mediaType, disposition] of [
  ['application/pdf', 'attachment'],
  ['image/png', 'inline'],
] as const) {
  test(`API sends ${mediaType} with ${disposition} and private headers`, async () => {
    const bytes = Buffer.from('file');
    const identity = {
      async authenticate() {
        return { tokenHash: 'caller' };
      },
    } as unknown as IdentityService;
    const pods = {
      async file() {
        return { bytes, mediaType, fingerprint: 'hash' };
      },
    } as unknown as PodService;
    const headers = new Map<string, string>();
    let sent: unknown;
    const response = {
      statusCode: 0,
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
      end(body: unknown) {
        sent = body;
      },
    };
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await new PodController(identity, pods).file(
      id,
      id,
      id,
      { headers: {} },
      response as unknown as ServerResponse,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(headers.get('content-disposition'), disposition);
    assert.equal(headers.get('cache-control'), 'private, no-store');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(sent, bytes);
  });
}
