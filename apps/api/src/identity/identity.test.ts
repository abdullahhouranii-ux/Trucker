import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { ConfigError, loadConfig, SECURITY_PERIOD_DEFAULTS } from '../config/config.js';
import { defaultMigrationsDir, migrateUp } from '../database/migrations.js';
import { configureApp } from '../http/configure-app.js';
import type { Logger } from '../http/logger.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import { maskPhone, normalizePhone } from './phone.js';
import { generateCode, hashCode, sessionToken } from './secrets.js';
import { DEMONSTRATION_TERMS_VERSION } from './terms.js';

// ---------------------------------------------------------------------------------------------
// One API per configuration, all on one migrated test database, with a clock the tests move.
// ---------------------------------------------------------------------------------------------
let now = new Date('2026-11-13T08:00:00.000Z');
const clock = (): Date => new Date(now);
const advance = (seconds: number): void => {
  now = new Date(now.getTime() + seconds * 1000);
};

const logged: string[] = [];
const collecting: Logger = {
  info: (entry) => void logged.push(JSON.stringify(entry)),
  error: (entry) => void logged.push(JSON.stringify(entry)),
};

interface Api {
  base: string;
  close(): Promise<void>;
}
let database: TestDatabase;
let pool: pg.Pool;
let api: Api; // development display on, demonstration terms on
let closed: Api; // defaults: no delivery, no terms
const apps: INestApplication[] = [];

async function startApi(overrides: Record<string, string>): Promise<Api> {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: database.url, ...overrides });
  const app = configureApp(
    await NestFactory.create(AppModule.register(config, clock), { logger: false }),
    collecting,
  );
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

before(async () => {
  database = await createTestDatabase();
  pool = new pg.Pool({ connectionString: database.url });
  await migrateUp(pool, defaultMigrationsDir());
  // The test database is on this machine, which development display requires.
  const local = new URL(database.url);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(local.hostname),
    'these tests need a local database',
  );
  api = await startApi({
    SIGN_IN_CODE_DELIVERY: 'development-display',
    REGISTRATION_TERMS: 'demonstration',
  });
  closed = await startApi({});
});
after(async () => {
  for (const app of apps) await app.close();
  await pool.end();
  await database.drop();
});

// Fictional numbers: country code 999 is not assigned to any country.
let phoneCounter = 0;
const newPhone = (): string => `+99955${String(1_000_000 + phoneCounter++)}`;
const key = (): string => `test-${randomUUID()}`;

interface Reply {
  status: number;
  body: Record<string, unknown>;
}
async function call(
  target: Api,
  method: string,
  path: string,
  options: {
    body?: unknown;
    token?: string;
    key?: string | null;
    headers?: Record<string, string>;
    askForCode?: boolean;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...options.headers };
  // Tests stand in for a developer on this machine, who asks for the code by name.
  if (options.askForCode !== false && path === '/auth/code-requests')
    headers['x-trucker-development-code'] = 'local-visitor';
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.key !== null && method === 'POST' && path.startsWith('/auth/code')) {
    headers['idempotency-key'] = options.key ?? key();
  }
  const response = await fetch(target.base + path, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function requestCode(
  phone: string,
  retryKey?: string,
): Promise<{ challengeId: string; code: string }> {
  const reply = await call(api, 'POST', '/auth/code-requests', {
    body: { phone },
    ...(retryKey ? { key: retryKey } : {}),
  });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  return {
    challengeId: reply.body.challengeId as string,
    code: reply.body.developmentCode as string,
  };
}
const verify = (challengeId: string, code: string, retryKey?: string): Promise<Reply> =>
  call(api, 'POST', '/auth/code-verifications', {
    body: { challengeId, code },
    ...(retryKey ? { key: retryKey } : {}),
  });

async function signIn(
  phone = newPhone(),
): Promise<{ token: string; sessionId: string; personId: string; phone: string }> {
  const { challengeId, code } = await requestCode(phone);
  const reply = await verify(challengeId, code);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const session = reply.body.session as { id: string };
  const person = reply.body.person as { id: string };
  advance(SECURITY_PERIOD_DEFAULTS.SIGN_IN_CODE_RESEND_WAIT_SECONDS + 1);
  return { token: reply.body.token as string, sessionId: session.id, personId: person.id, phone };
}
const wrongCode = (code: string): string => (code === '000000' ? '000001' : '000000');
const registration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  displayName: 'Test Person (fictional)',
  termsVersion: DEMONSTRATION_TERMS_VERSION,
  termsLanguage: 'en',
  termsSeen: true,
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------
test('phone numbers: international form is required and typing noise is removed', () => {
  assert.equal(normalizePhone('+971 50 123 4567'), '+971501234567');
  assert.equal(normalizePhone('00968-9123.4567'), '+96891234567');
  assert.equal(normalizePhone('(+966) 5 1234 5678'), '+966512345678');
  assert.equal(normalizePhone('‎+92 300 1234567‎'), '+923001234567');
  assert.equal(normalizePhone('+٩٧١٥٠١٢٣٤٥٦٧'), '+971501234567');
  assert.equal(normalizePhone('+۹۲۳۰۰۱۲۳۴۵۶۷'), '+923001234567');
  for (const refused of [
    '0501234567',
    '501234567',
    '+0501234567',
    '+12',
    '+1234567890123456',
    'abc',
    '+971 50 12x4567',
    '',
  ]) {
    assert.equal(normalizePhone(refused), null, refused);
  }
});

test('a masked phone number hides all but its start and last two digits', () => {
  assert.equal(maskPhone('+971501234567'), '+971•••••••67');
});

test('codes are six digits; hashes are keyed and bound to the challenge', () => {
  for (let i = 0; i < 200; i += 1) assert.match(generateCode(), /^[0-9]{6}$/);
  const a = hashCode('k'.repeat(32), 'challenge-1', '123456');
  assert.notEqual(a, hashCode('k'.repeat(32), 'challenge-2', '123456'));
  assert.notEqual(a, hashCode('j'.repeat(32), 'challenge-1', '123456'));
  assert.equal(a, hashCode('k'.repeat(32), 'challenge-1', '123456'));
  assert.notEqual(
    sessionToken('k'.repeat(32), 'session-1'),
    sessionToken('j'.repeat(32), 'session-1'),
  );
});

// ---------------------------------------------------------------------------------------------
// Configuration: what production refuses
// ---------------------------------------------------------------------------------------------
const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://app:value@db.internal.example:5432/trucker',
  IDENTITY_SECRET: 'a-real-secret-of-sufficient-length-000000',
  SIGN_IN_CODE_TTL_SECONDS: '300',
  SIGN_IN_CODE_MAX_ATTEMPTS: '5',
  SIGN_IN_CODE_RESEND_WAIT_SECONDS: '60',
  SIGN_IN_CODE_MAX_PER_HOUR: '5',
  SESSION_IDLE_MINUTES: '30',
  SESSION_ABSOLUTE_HOURS: '12',
};
function problems(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  return [];
}

test('production: a complete configuration is accepted, with sign-in and registration closed', () => {
  const config = loadConfig(production);
  assert.equal(config.SIGN_IN_CODE_DELIVERY, 'none');
  assert.equal(config.REGISTRATION_TERMS, 'none');
});

test('production refuses to display codes, even with a local database', () => {
  const found = problems({
    ...production,
    DATABASE_URL: 'postgres://a:b@localhost:5432/t',
    SIGN_IN_CODE_DELIVERY: 'development-display',
  });
  assert.ok(
    found.some((p) => p.startsWith('SIGN_IN_CODE_DELIVERY must not be development-display')),
  );
});

test('production refuses demonstration terms', () => {
  assert.ok(
    problems({ ...production, REGISTRATION_TERMS: 'demonstration' }).some((p) =>
      p.startsWith('REGISTRATION_TERMS'),
    ),
  );
});

test('production refuses a missing secret and the published development secret', () => {
  assert.ok(
    problems({ ...production, IDENTITY_SECRET: undefined }).some((p) =>
      p.startsWith('IDENTITY_SECRET must be set'),
    ),
  );
  assert.ok(
    problems({
      ...production,
      IDENTITY_SECRET: 'trucker-development-only-secret-not-for-production',
    }).some((p) => p.includes('published development value')),
  );
});

test('production refuses every security period left at its development default', () => {
  for (const name of Object.keys(SECURITY_PERIOD_DEFAULTS)) {
    const found = problems({ ...production, [name]: undefined });
    assert.ok(
      found.some((p) => p.startsWith(`${name} must be set explicitly`)),
      name,
    );
  }
});

test('displaying codes is refused when the database is not on this machine', () => {
  const found = problems({
    NODE_ENV: 'development',
    DATABASE_URL: production.DATABASE_URL,
    SIGN_IN_CODE_DELIVERY: 'development-display',
  });
  assert.ok(found.some((p) => p.includes('needs a database on this machine')));
});

test('configuration problems never contain the secret', () => {
  const found = problems({ ...production, IDENTITY_SECRET: 'short-secret-value' });
  assert.ok(found.length > 0);
  assert.ok(!found.join(' ').includes('short-secret-value'));
});

// ---------------------------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------------------------
test('a new number signs in with its code and gets a person whose registration is not complete', async () => {
  const phone = newPhone();
  const { challengeId, code } = await requestCode(phone);
  assert.match(code, /^[0-9]{6}$/);
  const reply = await verify(challengeId, code);
  assert.equal(reply.status, 200);
  const person = reply.body.person as Record<string, unknown>;
  assert.equal(person.registrationComplete, false);
  assert.equal(person.displayName, null);
  assert.equal(person.phoneMasked, maskPhone(phone));
  assert.ok(!JSON.stringify(reply.body).includes(phone), 'the full number is not echoed');

  const me = await call(api, 'GET', '/me', { token: reply.body.token as string });
  assert.equal(me.status, 200);
  assert.equal((me.body.person as { id: string }).id, person.id);
});

test('signing in again with the same number reaches the same person', async () => {
  const first = await signIn();
  const second = await signIn(first.phone);
  assert.equal(second.personId, first.personId);
  assert.notEqual(second.sessionId, first.sessionId);
});

test('the answer to a code request is the same for a registered and an unknown number', async () => {
  const known = await signIn();
  const a = await call(api, 'POST', '/auth/code-requests', { body: { phone: known.phone } });
  const b = await call(api, 'POST', '/auth/code-requests', { body: { phone: newPhone() } });
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.deepEqual(Object.keys(a.body).sort(), Object.keys(b.body).sort());
});

test('a code cannot be used twice', async () => {
  const { challengeId, code } = await requestCode(newPhone());
  assert.equal((await verify(challengeId, code)).status, 200);
  const again = await verify(challengeId, code);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'code_already_used');
  assert.equal(again.body.token, undefined);
});

test('safe retry: repeating the same sign-in request returns the same session, not a second one', async () => {
  const phone = newPhone();
  const { challengeId, code } = await requestCode(phone);
  const retryKey = key();
  const first = await verify(challengeId, code, retryKey);
  const repeat = await verify(challengeId, code, retryKey);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.token, first.body.token);
  const sessions = await pool.query(
    'SELECT count(*)::int AS n FROM trucker.session s JOIN trucker.person p ON p.id = s.person_id WHERE p.phone_e164 = $1',
    [phone],
  );
  assert.equal(sessions.rows[0].n, 1);

  // The retry is tied to the key and the code, and to a short time.
  assert.equal((await verify(challengeId, wrongCode(code), retryKey)).status, 409);
  advance(121);
  assert.equal((await verify(challengeId, code, retryKey)).status, 409);
});

test('safe retry: repeating a code request with the same key creates no second code', async () => {
  const phone = newPhone();
  const retryKey = key();
  const first = await call(api, 'POST', '/auth/code-requests', { body: { phone }, key: retryKey });
  const repeat = await call(api, 'POST', '/auth/code-requests', { body: { phone }, key: retryKey });
  assert.equal(repeat.status, 202);
  assert.equal(repeat.body.challengeId, first.body.challengeId);
  assert.equal(repeat.body.developmentCode, undefined, 'the code is shown once only');
  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM trucker.sign_in_challenge WHERE phone_e164 = $1',
    [phone],
  );
  assert.equal(rows.rows[0].n, 1);
  assert.equal(
    (await verify(first.body.challengeId as string, first.body.developmentCode as string)).status,
    200,
  );
});

test('both sign-in requests need a retry key', async () => {
  const missing = await call(api, 'POST', '/auth/code-requests', {
    body: { phone: newPhone() },
    key: null,
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'retry_key_required');
  const short = await call(api, 'POST', '/auth/code-verifications', {
    body: { challengeId: randomUUID(), code: '123456' },
    key: 'short',
  });
  assert.equal(short.status, 400);
});

test('an expired code is refused, and the boundary is exact', async () => {
  const { challengeId, code } = await requestCode(newPhone());
  advance(SECURITY_PERIOD_DEFAULTS.SIGN_IN_CODE_TTL_SECONDS - 1);
  const late = await requestCode(newPhone());
  advance(1);
  const expired = await verify(challengeId, code);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, 'code_expired');
  assert.equal(
    (await verify(late.challengeId, late.code)).status,
    200,
    'a code inside its life still works',
  );
});

test('incorrect codes are counted, the last attempt locks the code, and the right code no longer works', async () => {
  const { challengeId, code } = await requestCode(newPhone());
  const max = SECURITY_PERIOD_DEFAULTS.SIGN_IN_CODE_MAX_ATTEMPTS;
  for (let attempt = 1; attempt < max; attempt += 1) {
    const reply = await verify(challengeId, wrongCode(code));
    assert.equal(reply.status, 400);
    assert.equal(reply.body.code, 'code_incorrect');
    assert.deepEqual(reply.body.details, { attemptsRemaining: max - attempt });
  }
  const last = await verify(challengeId, wrongCode(code));
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'code_locked');
  const correct = await verify(challengeId, code);
  assert.equal(correct.status, 429);
  assert.equal(correct.body.code, 'code_locked');
});

test('incorrect attempts sent at the same moment cannot exceed the limit', async () => {
  const { challengeId, code } = await requestCode(newPhone());
  const replies = await Promise.all(
    Array.from({ length: 12 }, () => verify(challengeId, wrongCode(code))),
  );
  assert.ok(replies.every((reply) => reply.status === 400 || reply.status === 429));
  const row = await pool.query(
    'SELECT failed_attempts FROM trucker.sign_in_challenge WHERE id = $1',
    [challengeId],
  );
  assert.equal(row.rows[0].failed_attempts, SECURITY_PERIOD_DEFAULTS.SIGN_IN_CODE_MAX_ATTEMPTS);
  assert.equal((await verify(challengeId, code)).status, 429);
});

test('two correct attempts at the same moment create one session', async () => {
  const phone = newPhone();
  const { challengeId, code } = await requestCode(phone);
  const replies = await Promise.all([verify(challengeId, code), verify(challengeId, code)]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  const sessions = await pool.query(
    'SELECT count(*)::int AS n FROM trucker.session s JOIN trucker.person p ON p.id = s.person_id WHERE p.phone_e164 = $1',
    [phone],
  );
  assert.equal(sessions.rows[0].n, 1);
});

test('an unknown challenge and a malformed code are refused without detail', async () => {
  const unknown = await verify(randomUUID(), '123456');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'code_incorrect');
  assert.equal(unknown.body.details, undefined);
  const { challengeId } = await requestCode(newPhone());
  for (const code of ['12345', '1234567', 'abcdef', '']) {
    assert.equal((await verify(challengeId, code)).status, 422, code);
  }
});

test('asking again too soon is refused and says how long to wait', async () => {
  const phone = newPhone();
  await requestCode(phone);
  advance(SECURITY_PERIOD_DEFAULTS.SIGN_IN_CODE_RESEND_WAIT_SECONDS - 1);
  const soon = await call(api, 'POST', '/auth/code-requests', { body: { phone } });
  assert.equal(soon.status, 429);
  assert.equal(soon.body.code, 'code_resend_too_soon');
  assert.deepEqual(soon.body.details, { retryAfterSeconds: 1 });
  advance(1);
  assert.equal((await call(api, 'POST', '/auth/code-requests', { body: { phone } })).status, 202);
});

test('a new code replaces the previous one', async () => {
  const phone = newPhone();
  const first = await requestCode(phone);
  advance(SECURITY_PERIOD_DEFAULTS.SIGN_IN_CODE_RESEND_WAIT_SECONDS);
  const second = await requestCode(phone);
  const old = await verify(first.challengeId, first.code);
  assert.equal(old.status, 410);
  assert.equal(old.body.code, 'code_replaced');
  assert.equal((await verify(second.challengeId, second.code)).status, 200);
});

test('no more than the hourly number of codes is created for one number', async () => {
  const phone = newPhone();
  const max = SECURITY_PERIOD_DEFAULTS.SIGN_IN_CODE_MAX_PER_HOUR;
  for (let i = 0; i < max; i += 1) {
    await requestCode(phone);
    advance(SECURITY_PERIOD_DEFAULTS.SIGN_IN_CODE_RESEND_WAIT_SECONDS);
  }
  const over = await call(api, 'POST', '/auth/code-requests', { body: { phone } });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, 'too_many_code_requests');
  assert.ok((over.body.details as { retryAfterSeconds: number }).retryAfterSeconds > 0);
  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM trucker.sign_in_challenge WHERE phone_e164 = $1',
    [phone],
  );
  assert.equal(rows.rows[0].n, max);
  advance(3600);
  assert.equal((await call(api, 'POST', '/auth/code-requests', { body: { phone } })).status, 202);
});

test('a number without a country code is refused and names the field only', async () => {
  const reply = await call(api, 'POST', '/auth/code-requests', { body: { phone: '0501234567' } });
  assert.equal(reply.status, 422);
  assert.deepEqual(reply.body.details, { fields: ['phone'] });
  assert.ok(!JSON.stringify(reply.body).includes('0501234567'));
});

// ---------------------------------------------------------------------------------------------
// Where codes may and may not appear
// ---------------------------------------------------------------------------------------------
test('a local caller that does not ask for the development code by name gets none', async () => {
  const reply = await call(api, 'POST', '/auth/code-requests', {
    body: { phone: newPhone() },
    askForCode: false,
  });
  assert.equal(reply.status, 202);
  assert.equal(reply.body.developmentCode, undefined);
  assert.equal(typeof reply.body.challengeId, 'string');
});

test('a request that was forwarded gets no development code, even from this machine', async () => {
  for (const header of [
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-real-ip',
    'via',
    'cf-connecting-ip',
    'true-client-ip',
  ]) {
    const reply = await call(api, 'POST', '/auth/code-requests', {
      body: { phone: newPhone() },
      headers: { [header]: header === 'forwarded' ? 'for=127.0.0.1' : '127.0.0.1' },
    });
    assert.equal(reply.status, 202, header);
    assert.equal(reply.body.developmentCode, undefined, header);
  }
});

test('a caller from another address gets no development code, whatever it sends', async () => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
  assert.ok(address, 'this test needs a network address other than loopback');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    SIGN_IN_CODE_DELIVERY: 'development-display',
  });
  const app = configureApp(
    await NestFactory.create(AppModule.register(config, clock), { logger: false }),
    collecting,
  );
  await app.listen(0, '0.0.0.0');
  apps.push(app);
  const { port } = app.getHttpServer().address() as AddressInfo;
  // Connecting to the machine's own outside address makes that address the caller.
  const remote: Api = { base: `http://${address}:${port}`, close: () => app.close() };
  const reply = await call(remote, 'POST', '/auth/code-requests', { body: { phone: newPhone() } });
  assert.equal(reply.status, 202);
  assert.equal(reply.body.developmentCode, undefined);
  // The same server still answers a caller on this machine, so the refusal above is the rule.
  const local = await call(
    { base: `http://127.0.0.1:${port}`, close: remote.close },
    'POST',
    '/auth/code-requests',
    {
      body: { phone: newPhone() },
    },
  );
  assert.match(String(local.body.developmentCode), /^[0-9]{6}$/);
});

test('with code delivery off, no code is created and none is returned', async () => {
  const phone = newPhone();
  const reply = await call(closed, 'POST', '/auth/code-requests', { body: { phone } });
  assert.equal(reply.status, 503);
  assert.equal(reply.body.code, 'code_delivery_unavailable');
  assert.equal(reply.body.developmentCode, undefined);
  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM trucker.sign_in_challenge WHERE phone_e164 = $1',
    [phone],
  );
  assert.equal(rows.rows[0].n, 0);
});

test('neither the code nor the token nor the number is stored or logged in clear', async () => {
  logged.length = 0;
  const phone = newPhone();
  const { challengeId, code } = await requestCode(phone);
  await verify(challengeId, wrongCode(code));
  const reply = await verify(challengeId, code);
  const token = reply.body.token as string;
  await call(api, 'GET', '/me', { token });

  const challenge = await pool.query('SELECT * FROM trucker.sign_in_challenge WHERE id = $1', [
    challengeId,
  ]);
  const stored = JSON.stringify(challenge.rows[0]);
  assert.ok(!stored.includes(`"${code}"`), 'the code is not a stored value');
  assert.notEqual(challenge.rows[0].code_hash, code);
  const session = await pool.query('SELECT * FROM trucker.session WHERE id = $1', [
    (reply.body.session as { id: string }).id,
  ]);
  assert.ok(
    !JSON.stringify(session.rows[0]).includes(token.split('.')[1] as string),
    'the token is not stored',
  );
  const events = await pool.query('SELECT * FROM trucker.identity_event');
  assert.ok(!JSON.stringify(events.rows).includes(phone.slice(1)));

  assert.ok(logged.length >= 4, 'requests were logged');
  const lines = logged.join('\n');
  assert.ok(!lines.includes(code), 'the code is not in the log');
  assert.ok(!lines.includes(token.split('.')[1] as string), 'the token is not in the log');
  assert.ok(!lines.includes(phone.slice(1)), 'the number is not in the log');
});

// ---------------------------------------------------------------------------------------------
// Sessions and permissions
// ---------------------------------------------------------------------------------------------
test('every personal endpoint refuses a missing, malformed or invented token', async () => {
  const forged = sessionToken('x'.repeat(40), randomUUID());
  for (const token of [undefined, 'not-a-token', forged]) {
    for (const [method, path] of [
      ['GET', '/me'],
      ['GET', '/me/sessions'],
      ['POST', '/me/registration'],
      ['POST', '/me/sessions/revoke-others'],
      ['DELETE', `/me/sessions/${randomUUID()}`],
      ['POST', '/auth/sign-out'],
    ] as const) {
      const reply = await call(api, method, path, {
        ...(token ? { token } : {}),
        ...(method === 'POST' ? { body: {} } : {}),
      });
      assert.equal(reply.status, 401, `${method} ${path}`);
      assert.equal(reply.body.code, 'unauthorized');
    }
  }
});

test('signing out ends the session at once', async () => {
  const session = await signIn();
  assert.equal((await call(api, 'POST', '/auth/sign-out', { token: session.token })).status, 204);
  const after = await call(api, 'GET', '/me', { token: session.token });
  assert.equal(after.status, 401);
  assert.equal(after.body.code, 'unauthorized');
});

test('a person can end another of their own sessions, and that token stops working', async () => {
  const first = await signIn();
  const second = await signIn(first.phone);
  const list = await call(api, 'GET', '/me/sessions', { token: second.token });
  const sessions = list.body.sessions as { id: string; current: boolean }[];
  assert.deepEqual(sessions.map((s) => s.id).sort(), [first.sessionId, second.sessionId].sort());
  assert.equal(sessions.find((s) => s.current)?.id, second.sessionId);

  assert.equal(
    (await call(api, 'DELETE', `/me/sessions/${first.sessionId}`, { token: second.token })).status,
    204,
  );
  assert.equal((await call(api, 'GET', '/me', { token: first.token })).status, 401);
  assert.equal((await call(api, 'GET', '/me', { token: second.token })).status, 200);
  assert.equal(
    (await call(api, 'DELETE', `/me/sessions/${first.sessionId}`, { token: second.token })).status,
    404,
  );
});

test('a person cannot see or end a session of another person', async () => {
  const mine = await signIn();
  const theirs = await signIn();
  const reply = await call(api, 'DELETE', `/me/sessions/${theirs.sessionId}`, {
    token: mine.token,
  });
  assert.equal(reply.status, 404);
  assert.equal(reply.body.code, 'not_found');
  assert.equal(
    (await call(api, 'GET', '/me', { token: theirs.token })).status,
    200,
    'their session still works',
  );
  const list = await call(api, 'GET', '/me/sessions', { token: mine.token });
  assert.deepEqual(
    (list.body.sessions as { id: string }[]).map((s) => s.id),
    [mine.sessionId],
  );
  assert.equal(
    (await call(api, 'DELETE', '/me/sessions/not-a-session', { token: mine.token })).status,
    404,
  );
});

test('ending all other sessions keeps the current one', async () => {
  const a = await signIn();
  const b = await signIn(a.phone);
  const c = await signIn(a.phone);
  const other = await signIn();
  const reply = await call(api, 'POST', '/me/sessions/revoke-others', { token: c.token });
  assert.deepEqual(reply.body, { revoked: 2 });
  assert.equal((await call(api, 'GET', '/me', { token: a.token })).status, 401);
  assert.equal((await call(api, 'GET', '/me', { token: b.token })).status, 401);
  assert.equal((await call(api, 'GET', '/me', { token: c.token })).status, 200);
  assert.equal((await call(api, 'GET', '/me', { token: other.token })).status, 200);
});

test('a session unused for the idle period is ended; use inside the period keeps it', async () => {
  const session = await signIn();
  const idleSeconds = SECURITY_PERIOD_DEFAULTS.SESSION_IDLE_MINUTES * 60;
  advance(idleSeconds - 120);
  assert.equal((await call(api, 'GET', '/me', { token: session.token })).status, 200);
  advance(idleSeconds - 120);
  assert.equal(
    (await call(api, 'GET', '/me', { token: session.token })).status,
    200,
    'use restarted the idle period',
  );
  advance(idleSeconds);
  const idle = await call(api, 'GET', '/me', { token: session.token });
  assert.equal(idle.status, 401);
  assert.equal(idle.body.code, 'session_expired');
  const row = await pool.query('SELECT revoked_reason FROM trucker.session WHERE id = $1', [
    session.sessionId,
  ]);
  assert.equal(row.rows[0].revoked_reason, 'idle_expired');
  assert.equal((await call(api, 'GET', '/me', { token: session.token })).body.code, 'unauthorized');
});

test('a session ends at its absolute limit even when used all the time', async () => {
  const session = await signIn();
  const step = (SECURITY_PERIOD_DEFAULTS.SESSION_IDLE_MINUTES - 1) * 60;
  const limit = SECURITY_PERIOD_DEFAULTS.SESSION_ABSOLUTE_HOURS * 3600;
  let elapsed = SECURITY_PERIOD_DEFAULTS.SIGN_IN_CODE_RESEND_WAIT_SECONDS + 1;
  // signIn moved the clock past the resend wait; using the session now restarts its idle period.
  assert.equal((await call(api, 'GET', '/me', { token: session.token })).status, 200);
  while (elapsed + step < limit) {
    advance(step);
    elapsed += step;
    assert.equal((await call(api, 'GET', '/me', { token: session.token })).status, 200);
  }
  advance(limit - elapsed);
  const over = await call(api, 'GET', '/me', { token: session.token });
  assert.equal(over.status, 401);
  assert.equal(over.body.code, 'session_expired');
  const row = await pool.query('SELECT revoked_reason FROM trucker.session WHERE id = $1', [
    session.sessionId,
  ]);
  assert.equal(row.rows[0].revoked_reason, 'absolute_expired');
});

// ---------------------------------------------------------------------------------------------
// Registration and terms
// ---------------------------------------------------------------------------------------------
test('demonstration terms are served in three languages and say what they are', async () => {
  for (const language of ['en', 'ar', 'ur']) {
    const reply = await call(api, 'GET', `/registration/terms?language=${language}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.kind, 'demonstration');
    assert.equal(reply.body.version, DEMONSTRATION_TERMS_VERSION);
    assert.equal(reply.body.language, language);
    assert.ok((reply.body.notice as string).length > 20);
  }
  assert.equal((await call(api, 'GET', '/registration/terms?language=fr')).status, 422);
});

test('registration records the name and which demonstration text was shown, in which language', async () => {
  const session = await signIn();
  const reply = await call(api, 'POST', '/me/registration', {
    token: session.token,
    body: registration({
      displayName: '  أحمد   العيّنة  ',
      contactEmail: ' person@example.test ',
      termsLanguage: 'ar',
    }),
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const person = reply.body.person as Record<string, unknown>;
  assert.equal(person.registrationComplete, true);
  assert.equal(person.displayName, 'أحمد العيّنة');
  assert.equal(person.contactEmail, 'person@example.test');

  const rows = await pool.query(
    'SELECT terms_kind, version, language FROM trucker.terms_acceptance WHERE person_id = $1',
    [session.personId],
  );
  assert.deepEqual(rows.rows, [
    { terms_kind: 'demonstration', version: DEMONSTRATION_TERMS_VERSION, language: 'ar' },
  ]);
});

test('repeating registration changes nothing and records nothing twice', async () => {
  const session = await signIn();
  await call(api, 'POST', '/me/registration', { token: session.token, body: registration() });
  const repeat = await call(api, 'POST', '/me/registration', {
    token: session.token,
    body: registration({ displayName: 'A Different Name', termsLanguage: 'ur' }),
  });
  assert.equal(repeat.status, 200);
  assert.equal(
    (repeat.body.person as { displayName: string }).displayName,
    'Test Person (fictional)',
  );
  const rows = await pool.query(
    'SELECT language FROM trucker.terms_acceptance WHERE person_id = $1',
    [session.personId],
  );
  assert.deepEqual(rows.rows, [{ language: 'en' }]);
  const events = await pool.query(
    `SELECT count(*)::int AS n FROM trucker.identity_event WHERE person_id = $1 AND kind = 'registration_completed'`,
    [session.personId],
  );
  assert.equal(events.rows[0].n, 1);
});

test('registration is refused for missing or invalid fields and names them', async () => {
  const session = await signIn();
  const cases: [Record<string, unknown>, string][] = [
    [registration({ displayName: '   ' }), 'displayName'],
    [registration({ displayName: 'x'.repeat(121) }), 'displayName'],
    [registration({ contactEmail: 'not-an-email' }), 'contactEmail'],
    [registration({ termsLanguage: 'fr' }), 'termsLanguage'],
    [registration({ termsSeen: false }), 'termsSeen'],
  ];
  for (const [body, field] of cases) {
    const reply = await call(api, 'POST', '/me/registration', { token: session.token, body });
    assert.equal(reply.status, 422, field);
    assert.deepEqual(reply.body.details, { fields: [field] });
  }
  const me = await call(api, 'GET', '/me', { token: session.token });
  assert.equal((me.body.person as { registrationComplete: boolean }).registrationComplete, false);
});

test('registration with an outdated terms version is refused and names the current one', async () => {
  const session = await signIn();
  const reply = await call(api, 'POST', '/me/registration', {
    token: session.token,
    body: registration({ termsVersion: 'demonstration-2020-01-01' }),
  });
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, 'terms_version_changed');
  assert.deepEqual(reply.body.details, { currentVersion: DEMONSTRATION_TERMS_VERSION });
});

test('with no terms configured, registration is closed for a signed-in person', async () => {
  const session = await signIn();
  // Same database and secret: the session made on the open API is valid on the closed one.
  const reply = await call(closed, 'POST', '/me/registration', {
    token: session.token,
    body: registration(),
  });
  assert.equal(reply.status, 503);
  assert.equal(reply.body.code, 'registration_closed');
  const rows = await pool.query(
    'SELECT count(*)::int AS n FROM trucker.terms_acceptance WHERE person_id = $1',
    [session.personId],
  );
  assert.equal(rows.rows[0].n, 0);
});

test('the database itself refuses any terms kind other than demonstration', async () => {
  const session = await signIn();
  await assert.rejects(
    pool.query(
      `INSERT INTO trucker.terms_acceptance (person_id, terms_kind, version, language, accepted_at)
       VALUES ($1, 'approved', 'v1', 'en', now())`,
      [session.personId],
    ),
    /terms_acceptance_terms_kind_check/,
  );
});

test('sign-in and session events are recorded with the request identifier', async () => {
  const session = await signIn();
  await call(api, 'POST', '/me/registration', { token: session.token, body: registration() });
  await call(api, 'POST', '/auth/sign-out', { token: session.token });
  const events = await pool.query(
    'SELECT kind, request_id FROM trucker.identity_event WHERE person_id = $1 ORDER BY id',
    [session.personId],
  );
  assert.deepEqual(
    events.rows.map((row) => row.kind),
    ['signed_in', 'registration_completed', 'signed_out'],
  );
  assert.ok(events.rows.every((row) => /^[0-9a-f-]{36}$/.test(row.request_id)));
});
