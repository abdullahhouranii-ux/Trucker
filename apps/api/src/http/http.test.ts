import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import {
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiError, mapError } from './api-error.js';
import { configureApp } from './configure-app.js';
import type { Logger } from './logger.js';
import { resolveRequestId } from './request-id.js';

const SECRET = 'password=hunter2 at /srv/internal/path';

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new TypeError(`database exploded: ${SECRET}`);
  }

  @Get('deliberate')
  deliberate(): never {
    throw new ApiError(409, 'example_conflict', 'That item is already taken.', { item: 'A-1' });
  }

  @Get('framework')
  framework(): never {
    throw new NotFoundException(`row 42 in table secret_table: ${SECRET}`);
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const logged: Array<{ level: string; entry: Readonly<Record<string, unknown>> }> = [];
const collecting: Logger = {
  info: (entry) => void logged.push({ level: 'info', entry }),
  error: (entry) => void logged.push({ level: 'error', entry }),
};

let app: INestApplication;
let base: string;

before(async () => {
  app = configureApp(await NestFactory.create(ProbeModule, { logger: false }), collecting);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
after(async () => {
  await app.close();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('S2-01 an unknown route returns 404 with the standard body', async () => {
  const response = await fetch(`${base}/no/such/route`);
  assert.equal(response.status, 404);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'requestId']);
  assert.equal(body.code, 'not_found');
  assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert.ok(!JSON.stringify(body).includes('/no/such/route'));
});

test('S2-02 a malformed JSON body returns 400 without the parser message', async () => {
  const response = await fetch(`${base}/probe/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"broken": ',
  });
  assert.equal(response.status, 400);
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.equal(body.code, 'bad_request');
  assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert.ok(!/unexpected|json|position|token/i.test(String(body.message)), text);
});

test('S2-02 an oversized body returns 413 with the standard body', async () => {
  const response = await fetch(`${base}/probe/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filler: 'x'.repeat(300_000) }),
  });
  assert.equal(response.status, 413);
  assert.equal(((await response.json()) as { code: string }).code, 'payload_too_large');
});

test('S2-03 an unexpected exception returns a generic 500 and logs the detail with the identifier', async () => {
  logged.length = 0;
  const response = await fetch(`${base}/probe/boom`);
  assert.equal(response.status, 500);
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'requestId']);
  assert.equal(body.code, 'internal_error');
  for (const leak of ['hunter2', 'exploded', 'TypeError', 'internal/path', ' at ', '.ts', '.js']) {
    assert.ok(!text.includes(leak), `response leaked "${leak}": ${text}`);
  }
  const errorLine = logged.find((l) => l.level === 'error');
  assert.ok(errorLine, 'the failure was not logged');
  assert.equal(errorLine.entry.requestId, body.requestId);
  assert.equal(errorLine.entry.name, 'TypeError');
  assert.match(String(errorLine.entry.stack), /boom/);
});

test('S2-03 a framework exception does not leak its own message', async () => {
  const response = await fetch(`${base}/probe/framework`);
  assert.equal(response.status, 404);
  const text = await response.text();
  assert.equal((JSON.parse(text) as { code: string }).code, 'not_found');
  assert.ok(!text.includes('secret_table') && !text.includes('hunter2'), text);
});

test('S2-04 a deliberate application error keeps its code, status and details', async () => {
  const response = await fetch(`${base}/probe/deliberate`);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    code: 'example_conflict',
    message: 'That item is already taken.',
    details: { item: 'A-1' },
    requestId: response.headers.get('x-request-id'),
  });
});

test('S2-05 every response carries X-Request-Id, success or error', async () => {
  for (const path of ['/probe/ok', '/probe/boom', '/probe/deliberate', '/nothing-here']) {
    const response = await fetch(`${base}${path}`);
    assert.match(response.headers.get('x-request-id') ?? '', UUID, path);
    await response.arrayBuffer();
  }
});

test('S2-06 a valid inbound identifier is echoed; invalid ones are replaced', async () => {
  const kept = await fetch(`${base}/probe/ok`, {
    headers: { 'x-request-id': 'trace_ABC.123-xyz' },
  });
  assert.equal(kept.headers.get('x-request-id'), 'trace_ABC.123-xyz');

  for (const bad of [
    'short',
    'has spaces in it',
    'semi;colon;value',
    'x'.repeat(129),
    '<script>alert(1)</script>',
  ]) {
    const response = await fetch(`${base}/probe/ok`, { headers: { 'x-request-id': bad } });
    const returned = response.headers.get('x-request-id') ?? '';
    assert.notEqual(returned, bad);
    assert.match(returned, UUID, `for inbound "${bad.slice(0, 20)}"`);
  }
  assert.match(resolveRequestId(undefined), UUID);
  assert.match(resolveRequestId(['a', 'b']), UUID);
});

test('S2-07 each request writes one log line without query string, headers or body', async () => {
  logged.length = 0;
  const response = await fetch(`${base}/probe/echo?token=query-secret-value`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer header-secret-value' },
    body: JSON.stringify({ note: 'body-secret-value' }),
  });
  assert.equal(response.status, 201);
  await response.arrayBuffer();
  // The log line is written when the response finishes, which can be just after the client sees it.
  for (let i = 0; i < 50 && logged.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const lines = logged.filter((l) => l.entry.event === 'request');
  assert.equal(lines.length, 1);
  const entry = lines[0]?.entry ?? {};
  assert.deepEqual(Object.keys(entry).sort(), [
    'durationMs',
    'event',
    'method',
    'path',
    'requestId',
    'status',
  ]);
  assert.equal(entry.method, 'POST');
  assert.equal(entry.path, '/probe/echo');
  assert.equal(entry.status, 201);
  assert.equal(entry.requestId, response.headers.get('x-request-id'));
  const serialised = JSON.stringify(logged);
  for (const secret of ['query-secret-value', 'header-secret-value', 'body-secret-value']) {
    assert.ok(!serialised.includes(secret), `log contains ${secret}`);
  }
});

test('error mapping: only client-error statuses pass through; everything else is a 500', () => {
  assert.equal(mapError(new Error('x')).status, 500);
  assert.equal(mapError('a string').status, 500);
  assert.equal(mapError({ status: 200 }).status, 500);
  assert.equal(mapError({ status: 502, message: 'upstream detail' }).code, 'internal_error');
  assert.equal(mapError({ statusCode: 418 }).code, 'request_error');
  assert.equal(mapError({ status: 429 }).code, 'too_many_requests');
});
