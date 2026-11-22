import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { generateSync } from 'otplib';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { StaffService } from './staff.service.js';
import { loadConfig } from '../config/config.js';
import { appDatabaseUrl, ensureLocalAppLogin, markEnvironment } from '../database/local.js';
import { defaultMigrationsDir, migrateUp } from '../database/migrations.js';
import { SECURITY_SETTING_DEFAULTS, writeSecuritySettings } from '../database/settings.js';
import { configureApp } from '../http/configure-app.js';
import { hashToken } from '../identity/secrets.js';
import { blockedRequests } from '../testing/blocked-request.js';
import { createTestClock } from '../testing/test-clock.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';

// Staff identity (slice 8). Real PostgreSQL, the API connected as its restricted role.
// Authenticator codes are produced here by otplib, an independent implementation, from the
// secret the database hands out at enrolment: if the database's own arithmetic were wrong,
// no code made here would be accepted.

const D = SECURITY_SETTING_DEFAULTS;
const testClock = createTestClock(new Date('2026-06-01T08:00:00.000Z'));
const { clock, advance } = testClock;

let database: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let base: string;
let nest: INestApplication;
const { whileBlocked } = blockedRequests(() => owner, advance);

before(async () => {
  database = await createTestDatabase();
  owner = new pg.Pool({ connectionString: database.url });
  await migrateUp(owner, defaultMigrationsDir());
  await ensureLocalAppLogin(owner);
  await markEnvironment(owner, 'test');
  await testClock.start(owner);
  app = new pg.Pool({ connectionString: appDatabaseUrl(database.url), max: 3 });
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    APP_DATABASE_URL: appDatabaseUrl(database.url),
    SIGN_IN_CODE_DELIVERY: 'development-display',
    REGISTRATION_TERMS: 'demonstration',
  });
  nest = configureApp(
    await NestFactory.create(AppModule.register(config, clock), { logger: false }),
    { info: () => undefined, error: () => undefined },
  );
  await nest.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
});
after(async () => {
  await nest.close();
  await app.end();
  await owner.end();
  await database.drop();
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}
async function call(
  method: string,
  route: string,
  options: { body?: unknown; token?: string; key?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.key) headers['idempotency-key'] = options.key;
  if (route.startsWith('/auth/code')) {
    headers['x-trucker-development-code'] = 'local-visitor';
    headers['idempotency-key'] = `test-${randomUUID()}`;
  }
  const response = await fetch(base + route, {
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
const key = (): string => `test-${randomUUID()}`;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const PASSWORD = 'correct horse battery staple';

/** The authenticator code for a secret at the test clock's time, from otplib. */
const codeFor = (secret: string): string =>
  generateSync({ secret, epoch: Math.floor(clock().getTime() / 1000) });

interface Staff {
  id: string;
  email: string;
  password: string;
  secret: string;
  recoveryCodes: string[];
  token: string;
}
let counter = 0;
const newEmail = (): string => `staff${++counter}@example.test`;

async function count(table: string, where = 'true', values: unknown[] = []): Promise<number> {
  const found = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM trucker.${table} WHERE ${where}`,
    values,
  );
  return found.rows[0]!.n;
}
interface AuditRow {
  action: string;
  outcome: string;
  actor_staff_id: string | null;
  subject_staff_id: string | null;
  detail: Record<string, unknown>;
}
const auditOf = async (subject: string): Promise<AuditRow[]> =>
  (
    await owner.query<AuditRow>(
      `SELECT action, outcome, actor_staff_id, subject_staff_id, detail
       FROM trucker.staff_audit_entry WHERE subject_staff_id = $1 ORDER BY id`,
      [subject],
    )
  ).rows;
const auditCount = (): Promise<number> => count('staff_audit_entry');

/** Enrols with a link: sets the password, proves the authenticator, keeps what is shown once. */
async function enrol(
  link: string,
  password = PASSWORD,
): Promise<{ secret: string; recoveryCodes: string[]; email: string }> {
  const begun = await call('POST', '/staff/enrolment/begin', { body: { token: link, password } });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const secret = begun.body.secret as string;
  const done = await call('POST', '/staff/enrolment/complete', {
    body: { token: link, code: codeFor(secret) },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return {
    secret,
    recoveryCodes: done.body.recoveryCodes as string[],
    email: begun.body.email as string,
  };
}

/** Both steps. Time moves on first, so that a code is never one already used. */
async function signIn(staff: { email: string; password: string; secret: string }): Promise<string> {
  await advance(31);
  const first = await call('POST', '/staff/sign-in', {
    body: { email: staff.email, password: staff.password },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await call('POST', '/staff/sign-in/code', {
    body: { ticket: first.body.ticket, code: codeFor(staff.secret) },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  return second.body.token as string;
}

/** The operator command's function, as the migration role. */
async function bootstrap(email: string, name = 'First Administrator') {
  const link = randomBytes(32).toString('base64url');
  const result = await owner.query<{ status: string; staff_id: string | null }>(
    'SELECT status, staff_id FROM trucker.bootstrap_staff_admin($1, $2, $3)',
    [email, name, sha(link)],
  );
  return { ...result.rows[0]!, link };
}

let admin: Staff;
/** The first administrator, made once by the operator command and enrolled. */
async function theAdmin(): Promise<Staff> {
  if (admin) return admin;
  const email = newEmail();
  const made = await bootstrap(email);
  assert.equal(made.status, 'created');
  const enrolled = await enrol(made.link);
  admin = { id: made.staff_id!, password: PASSWORD, ...enrolled, token: '' };
  admin.token = await signIn(admin);
  return admin;
}
/** A token for the administrator that is live now, whatever earlier tests did to time. */
async function adminToken(): Promise<string> {
  const who = await theAdmin();
  who.token = await signIn(who);
  return who.token;
}

/** An account created in the console by the administrator, enrolled and signed in. */
async function newStaff(privileges: string[] = []): Promise<Staff> {
  const token = await adminToken();
  const email = newEmail();
  const created = await call('POST', '/staff/accounts', {
    token,
    key: key(),
    body: { email, displayName: `Staff ${counter}`, participantLink: 'declared_none' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = (created.body.account as { id: string }).id;
  const enrolled = await enrol(created.body.enrolmentToken as string);
  for (const privilege of privileges) {
    const granted = await call('POST', `/staff/accounts/${id}/privileges`, {
      token,
      body: { privilege, granted: true },
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
  }
  const staff = { id, password: PASSWORD, ...enrolled, token: '' };
  staff.token = await signIn(staff);
  return staff;
}

async function refused(work: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(work, (error: Error) => {
    assert.match(error.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// S-2: the first administrator
// ---------------------------------------------------------------------------------------------
test('the operator command creates one administrator who cannot sign in until enrolled; its link works once', async () => {
  assert.equal(await count('staff_account'), 0, 'no staff account ships with the migrations');
  const who = await theAdmin();
  const row = await owner.query<{ status: string; link: string }>(
    'SELECT status, participant_link AS link FROM trucker.staff_account WHERE id = $1',
    [who.id],
  );
  // Whether the administrator also has a participant account was not declared, and is
  // recorded as exactly that.
  assert.deepEqual(row.rows[0], { status: 'active', link: 'not_declared' });
  const me = await call('GET', '/staff/me', { token: who.token });
  assert.equal(me.status, 200);
  assert.deepEqual((me.body.staff as { privileges: string[] }).privileges, ['staff_admin']);
  assert.equal(who.recoveryCodes.length, 10);
  assert.equal(new Set(who.recoveryCodes).size, 10);
  const trail = await auditOf(who.id);
  assert.deepEqual(
    trail.slice(0, 2).map((entry) => [entry.action, entry.outcome, entry.actor_staff_id]),
    [
      ['staff.bootstrap', 'done', null],
      ['staff.enrolled', 'done', who.id],
    ],
  );
});

test('the operator command refuses once an administrator is active, and resets nobody', async () => {
  const who = await theAdmin();
  const before = await owner.query(
    'SELECT password_hash, totp_secret, status FROM trucker.staff_account WHERE id = $1',
    [who.id],
  );
  const entries = await auditCount();
  // Same email, and another one: both refused.
  for (const email of [who.email, newEmail()]) {
    const again = await bootstrap(email);
    assert.equal(again.status, 'administrator_exists');
    assert.equal(again.staff_id, null);
    const state = await call('POST', '/staff/enrolment/state', { body: { token: again.link } });
    assert.equal(state.status, 410);
  }
  const afterwards = await owner.query(
    'SELECT password_hash, totp_secret, status FROM trucker.staff_account WHERE id = $1',
    [who.id],
  );
  assert.deepEqual(afterwards.rows, before.rows, 'the administrator was not touched');
  assert.equal(await count('staff_account'), await count('staff_account', 'true'));
  assert.equal(await auditCount(), entries + 2, 'each refused run is recorded');
  // The administrator still signs in with what they had.
  assert.equal((await call('GET', '/staff/me', { token: await adminToken() })).status, 200);
});

test('before enrolment the command can replace the link; the old one stops working', async () => {
  // A second database state is needed: no active administrator. A scratch account stands in
  // by disabling nothing: the rule is exercised directly on a fresh database.
  const scratch = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: scratch.url });
  try {
    await migrateUp(pool, defaultMigrationsDir());
    const make = async (email: string) => {
      const link = randomBytes(32).toString('base64url');
      const result = await pool.query<{ status: string; staff_id: string }>(
        'SELECT status, staff_id FROM trucker.bootstrap_staff_admin($1, $2, $3)',
        [email, 'Operator Made', sha(link)],
      );
      return { ...result.rows[0]!, link };
    };
    const first = await make('one@example.test');
    const second = await make('one@example.test');
    assert.equal(first.status, 'created');
    assert.equal(second.status, 'reissued');
    assert.equal(second.staff_id, first.staff_id);
    const open = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM trucker.staff_enrolment WHERE ended_at IS NULL',
    );
    assert.deepEqual(open.rows, [{ token_hash: sha(second.link) }]);
    // Another email while an invited administrator exists: a second invited administrator.
    // Neither can sign in; whoever enrols first closes the door on the command.
    assert.equal((await make('not-an-email')).status, 'invalid');
    const count = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM trucker.staff_account',
    );
    assert.equal(count.rows[0]!.n, 1);
  } finally {
    await pool.end();
    await scratch.drop();
  }
});

// ---------------------------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------------------------
test('enrolment needs a real password and a working authenticator; wrong codes end the link', async () => {
  const token = await adminToken();
  const email = newEmail();
  const created = await call('POST', '/staff/accounts', {
    token,
    key: key(),
    body: { email, displayName: 'Enrolling', participantLink: 'declared_none' },
  });
  const link = created.body.enrolmentToken as string;
  const id = (created.body.account as { id: string; status: string }).id;
  assert.equal((created.body.account as { status: string }).status, 'invited');
  assert.deepEqual((await call('POST', '/staff/enrolment/state', { body: { token: link } })).body, {
    email,
  });
  // Too short, and the email itself, are refused; nothing is stored.
  for (const password of ['short', email.padEnd(12, 'x').slice(0, email.length)]) {
    const weak = await call('POST', '/staff/enrolment/begin', { body: { token: link, password } });
    assert.equal(weak.status, 422, JSON.stringify(weak.body));
  }
  // A code before a password is set proves nothing.
  const early = await call('POST', '/staff/enrolment/complete', {
    body: { token: link, code: '000000' },
  });
  assert.equal(early.body.code, 'enrolment_not_started');
  const begun = await call('POST', '/staff/enrolment/begin', {
    body: { token: link, password: PASSWORD },
  });
  const secret = begun.body.secret as string;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(begun.body.otpauthUri as string, /^otpauth:\/\/totp\/.*secret=[A-Z2-7]{32}/);
  // The account is still not usable: no password alone signs in.
  assert.equal(
    (await call('POST', '/staff/sign-in', { body: { email, password: PASSWORD } })).status,
    401,
  );
  // A recovery-shaped value is not an authenticator code.
  const wrong = await call('POST', '/staff/enrolment/complete', {
    body: { token: link, code: 'abcd-efgh-ijkl-mnop' },
  });
  assert.equal(wrong.body.code, 'staff_code_refused');
  // The right code completes it, once.
  const done = await call('POST', '/staff/enrolment/complete', {
    body: { token: link, code: codeFor(secret) },
  });
  assert.equal(done.status, 200);
  assert.equal((done.body.recoveryCodes as string[]).length, 10);
  for (const route of ['state', 'begin', 'complete']) {
    const again = await call('POST', `/staff/enrolment/${route}`, {
      body: { token: link, password: PASSWORD, code: codeFor(secret) },
    });
    assert.equal(again.status, 410, `${route} after use`);
  }
  // Nothing stored is the password, the secret or a recovery code.
  const stored = await owner.query<{ password_hash: string; secret: Buffer }>(
    'SELECT password_hash, totp_secret AS secret FROM trucker.staff_account WHERE id = $1',
    [id],
  );
  assert.match(stored.rows[0]!.password_hash, /^\$2a\$12\$/);
  assert.ok(!stored.rows[0]!.secret.toString('latin1').includes(secret));
  const codes = await owner.query<{ code_hash: string }>(
    'SELECT code_hash FROM trucker.staff_recovery_code WHERE staff_id = $1',
    [id],
  );
  assert.equal(codes.rowCount, 10);
  for (const row of codes.rows) assert.match(row.code_hash, /^[0-9a-f]{64}$/);

  // Another account: the limit of wrong codes ends the link, and the right code no longer helps.
  const other = await call('POST', '/staff/accounts', {
    token,
    key: key(),
    body: { email: newEmail(), displayName: 'Guessing', participantLink: 'declared_none' },
  });
  const guessLink = other.body.enrolmentToken as string;
  const guess = await call('POST', '/staff/enrolment/begin', {
    body: { token: guessLink, password: PASSWORD },
  });
  for (let attempt = 0; attempt < D.staff_failure_limit; attempt += 1) {
    const tried = await call('POST', '/staff/enrolment/complete', {
      body: { token: guessLink, code: '000000' },
    });
    assert.equal(tried.body.code, 'staff_code_refused');
  }
  const late = await call('POST', '/staff/enrolment/complete', {
    body: { token: guessLink, code: codeFor(guess.body.secret as string) },
  });
  assert.equal(late.status, 410);
});

test('a value that is not a code is refused as a wrong code and counted, also as the first thing a database session does', async () => {
  // The first call of a session, and a call after its cached plans are reset, once failed with
  // an unexpected error instead of a refusal (migration 0015).
  const made = await call('POST', '/staff/accounts', {
    token: await adminToken(),
    key: key(),
    body: { email: newEmail(), displayName: 'Malformed', participantLink: 'declared_none' },
  });
  const link = made.body.enrolmentToken as string;
  const begun = await call('POST', '/staff/enrolment/begin', {
    body: { token: link, password: PASSWORD },
  });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const failures = async (): Promise<number> =>
    (
      await owner.query<{ n: number }>(
        'SELECT failed_count AS n FROM trucker.staff_enrolment WHERE token_hash = $1',
        [sha(link)],
      )
    ).rows[0]!.n;
  const complete = 'SELECT status FROM trucker.staff_enrol_complete($1, $2, $3, NULL)';
  // Four refusals in all, one short of the limit that ends the link.
  for (const [round, value] of ['abcd-efgh-ijkl-mnop'].entries()) {
    const session = new pg.Client({ connectionString: database.url });
    await session.connect();
    try {
      const first = await session.query<{ status: string }>(complete, [
        sha(link),
        value,
        '0'.repeat(64),
      ]);
      assert.equal(first.rows[0]!.status, 'wrong_code', value);
      // The same session after its plans are thrown away.
      await session.query('DISCARD PLANS');
      const second = await session.query<{ status: string }>(complete, [
        sha(link),
        null,
        '0'.repeat(64),
      ]);
      assert.equal(second.rows[0]!.status, 'wrong_code');
    } finally {
      await session.end();
    }
    assert.equal(await failures(), (round + 1) * 2);
  }
  {
    const session = new pg.Client({ connectionString: database.url });
    await session.connect();
    try {
      const empty = await session.query<{ status: string }>(complete, [
        sha(link),
        '',
        '0'.repeat(64),
      ]);
      assert.equal(empty.rows[0]!.status, 'wrong_code');
    } finally {
      await session.end();
    }
  }
  assert.equal(await failures(), 3);
  // Through the API as well, and the right code still completes the enrolment afterwards.
  const wrong = await call('POST', '/staff/enrolment/complete', {
    body: { token: link, code: 'abcd-efgh-ijkl-mnop' },
  });
  assert.equal(wrong.body.code, 'staff_code_refused');
  const done = await call('POST', '/staff/enrolment/complete', {
    body: { token: link, code: codeFor(begun.body.secret as string) },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
});

test('an enrolment link expires at the protected period, judged by the database clock', async () => {
  const token = await adminToken();
  const created = await call('POST', '/staff/accounts', {
    token,
    key: key(),
    body: { email: newEmail(), displayName: 'Late', participantLink: 'declared_none' },
  });
  const link = created.body.enrolmentToken as string;
  await advance(D.staff_enrolment_hours * 3600 - 5);
  assert.equal(
    (await call('POST', '/staff/enrolment/state', { body: { token: link } })).status,
    200,
  );
  await advance(6);
  for (const route of ['state', 'begin']) {
    const late = await call('POST', `/staff/enrolment/${route}`, {
      body: { token: link, password: PASSWORD },
    });
    assert.equal(late.status, 410, route);
  }
});

// ---------------------------------------------------------------------------------------------
// STF-1: no session without both factors
// ---------------------------------------------------------------------------------------------
test('a password alone opens nothing: a session exists only after a correct code', async () => {
  const staff = await newStaff();
  await advance(31);
  const sessions = await count('staff_session', 'staff_id = $1 AND revoked_at IS NULL', [staff.id]);
  const first = await call('POST', '/staff/sign-in', {
    body: { email: staff.email, password: staff.password },
  });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body), ['ticket']);
  const ticket = first.body.ticket as string;
  assert.equal(
    await count('staff_session', 'staff_id = $1 AND revoked_at IS NULL', [staff.id]),
    sessions,
    'the password step created no session',
  );
  // The ticket is not a session: it opens no staff route.
  for (const route of ['/staff/me', '/staff/accounts', '/staff/audit']) {
    assert.equal((await call('GET', route, { token: ticket })).status, 401, route);
  }
  // A wrong code is refused and creates nothing.
  const wrong = await call('POST', '/staff/sign-in/code', { body: { ticket, code: '000000' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'staff_code_refused');
  assert.equal(
    await count('staff_session', 'staff_id = $1 AND revoked_at IS NULL', [staff.id]),
    sessions,
  );
  // The right code creates exactly one.
  const code = codeFor(staff.secret);
  const right = await call('POST', '/staff/sign-in/code', { body: { ticket, code } });
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.equal(
    await count('staff_session', 'staff_id = $1 AND revoked_at IS NULL', [staff.id]),
    sessions + 1,
  );
  // The same request again (its answer was lost): the same session, nothing new.
  const again = await call('POST', '/staff/sign-in/code', { body: { ticket, code } });
  assert.equal(again.status, 200);
  assert.equal(again.body.token, right.body.token);
  assert.equal(
    await count('staff_session', 'staff_id = $1 AND revoked_at IS NULL', [staff.id]),
    sessions + 1,
  );
  // The same code cannot open a second sign-in: a code is accepted once.
  const second = await call('POST', '/staff/sign-in', {
    body: { email: staff.email, password: staff.password },
  });
  const replay = await call('POST', '/staff/sign-in/code', {
    body: { ticket: second.body.ticket, code },
  });
  assert.equal(replay.status, 401);
});

test('exactly one function creates a staff session, and it is the one that checks the code', async () => {
  const sources = await owner.query<{ name: string }>(
    `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'trucker' AND p.prosrc ~* 'insert\\s+into\\s+trucker\\.staff_session\\M'
     ORDER BY 1`,
  );
  assert.deepEqual(
    sources.rows.map((row) => row.name),
    ['staff_sign_in_verify'],
  );
  const body = await owner.query<{ source: string }>(
    `SELECT p.prosrc AS source FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'trucker' AND p.proname = 'staff_sign_in_verify'`,
  );
  const source = body.rows[0]!.source;
  assert.ok(
    source.indexOf('staff_check_code') < source.indexOf('INSERT INTO trucker.staff_session'),
    'the code is checked before the session is made',
  );
  // No setting anywhere makes the code optional.
  const settings = await owner.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
     WHERE table_schema = 'trucker' AND table_name = 'security_setting'`,
  );
  for (const row of settings.rows) assert.doesNotMatch(row.name, /mfa|factor|optional|skip|bypass/);
  // The staff limits are development defaults: adding them withdrew any production review,
  // so a production API does not start until they have been looked at.
  const reviewed = await owner.query<{ reviewed: boolean }>(
    'SELECT reviewed_for_production AS reviewed FROM trucker.security_setting',
  );
  assert.equal(reviewed.rows[0]!.reviewed, false);
});

test('authenticator codes: the step before and after are accepted, older and newer ones are not', async () => {
  const staff = await newStaff();
  const attempt = async (offsetSeconds: number): Promise<number> => {
    await advance(120); // a fresh step each time, clear of the last one used
    const first = await call('POST', '/staff/sign-in', {
      body: { email: staff.email, password: staff.password },
    });
    const code = generateSync({
      secret: staff.secret,
      epoch: Math.floor(clock().getTime() / 1000) + offsetSeconds,
    });
    return (
      await call('POST', '/staff/sign-in/code', { body: { ticket: first.body.ticket, code } })
    ).status;
  };
  assert.equal(await attempt(0), 200);
  assert.equal(await attempt(-30), 200);
  assert.equal(await attempt(30), 200);
  assert.equal(await attempt(-90), 401);
  assert.equal(await attempt(90), 401);
});

test('a recovery code signs in once, in place of the authenticator, and is then spent', async () => {
  const staff = await newStaff();
  const [first, second] = staff.recoveryCodes as [string, string];
  const step = async (code: string): Promise<Reply> => {
    const password = await call('POST', '/staff/sign-in', {
      body: { email: staff.email, password: staff.password },
    });
    return call('POST', '/staff/sign-in/code', { body: { ticket: password.body.ticket, code } });
  };
  const used = await step(first);
  assert.equal(used.status, 200, JSON.stringify(used.body));
  assert.equal((used.body.staff as { recoveryCodesLeft: number }).recoveryCodesLeft, 9);
  assert.equal((await step(first)).status, 401, 'a recovery code works once');
  // Typed in capitals and without dashes, it is the same code.
  assert.equal((await step(second.replaceAll('-', '').toUpperCase())).status, 200);
  // A recovery code never replaces the password.
  const noPassword = await call('POST', '/staff/sign-in', {
    body: { email: staff.email, password: staff.recoveryCodes[2] },
  });
  assert.equal(noPassword.status, 401);
  const trail = await auditOf(staff.id);
  assert.deepEqual(
    trail
      .filter((entry) => entry.action === 'staff.sign_in' && entry.outcome === 'done')
      .map((entry) => entry.detail.method),
    ['authenticator', 'recovery_code', 'recovery_code'],
  );
});

// ---------------------------------------------------------------------------------------------
// Refusals say nothing, and are limited (STF-4)
// ---------------------------------------------------------------------------------------------
test('sign-in answers the same for an unknown email, a wrong password, and accounts that may not sign in', async () => {
  const token = await adminToken();
  const active = await newStaff();
  const invited = await call('POST', '/staff/accounts', {
    token,
    key: key(),
    body: { email: newEmail(), displayName: 'Invited', participantLink: 'declared_none' },
  });
  const disabled = await newStaff();
  await call('POST', `/staff/accounts/${disabled.id}/status`, {
    token: await adminToken(),
    body: { status: 'disabled' },
  });
  const answers = [];
  for (const [email, password] of [
    ['nobody@example.test', PASSWORD],
    [active.email, 'not the password at all'],
    [(invited.body.account as { email: string }).email, PASSWORD],
    [disabled.email, disabled.password],
  ] as const) {
    const reply = await call('POST', '/staff/sign-in', { body: { email, password } });
    answers.push(JSON.stringify([reply.status, reply.body.code, reply.body.message]));
  }
  assert.equal(new Set(answers).size, 1, answers.join('\n'));
  assert.match(answers[0]!, /401.*staff_sign_in_refused/);
});

test('wrong passwords and wrong codes lock the account for the protected period; the caller cannot loosen it', async () => {
  const staff = await newStaff();
  const password = (value: string): Promise<Reply> =>
    call('POST', '/staff/sign-in', { body: { email: staff.email, password: value } });
  for (let attempt = 0; attempt < D.staff_failure_limit; attempt += 1)
    assert.equal((await password('wrong wrong wrong')).status, 401);
  // Locked: the right password is refused too, with the same answer.
  assert.equal((await password(staff.password)).status, 401);
  assert.equal(
    (await auditOf(staff.id)).filter((entry) => entry.action === 'staff.locked').length,
    1,
  );
  await advance(D.staff_lock_minutes * 60 - 5);
  assert.equal((await password(staff.password)).status, 401);
  await advance(6);
  assert.equal((await password(staff.password)).status, 200);

  // The limit is the database's. Tightened by the migration role, it applies at once;
  // settings the API's role invents for itself change nothing.
  await writeSecuritySettings(owner, { staff_failure_limit: 3 }, false);
  try {
    const other = await newStaff();
    const client = await app.connect();
    try {
      await client.query(`SELECT set_config('trucker.staff_failure_limit', '1000', false)`);
      await refused(
        () => client.query('UPDATE trucker.security_setting SET staff_failure_limit = 20'),
        /permission denied/i,
      );
    } finally {
      client.release();
    }
    for (let attempt = 0; attempt < 3; attempt += 1)
      await call('POST', '/staff/sign-in', {
        body: { email: other.email, password: 'wrong wrong wrong' },
      });
    assert.equal(
      (await call('POST', '/staff/sign-in', { body: { email: other.email, password: PASSWORD } }))
        .status,
      401,
      'locked after three',
    );
  } finally {
    await writeSecuritySettings(owner, { staff_failure_limit: D.staff_failure_limit }, false);
  }

  // Wrong codes count against the account as well.
  const third = await newStaff();
  await advance(31);
  for (let attempt = 0; attempt < D.staff_failure_limit; attempt += 1) {
    const ticket = await call('POST', '/staff/sign-in', {
      body: { email: third.email, password: third.password },
    });
    if (ticket.status !== 200) break;
    await call('POST', '/staff/sign-in/code', {
      body: { ticket: ticket.body.ticket, code: '000000' },
    });
  }
  assert.equal(
    (await call('POST', '/staff/sign-in', { body: { email: third.email, password: PASSWORD } }))
      .status,
    401,
  );
});

test('the step between password and code is short, and a code that waited behind a lock is judged afterwards', async () => {
  const staff = await newStaff();
  await advance(31);
  const first = await call('POST', '/staff/sign-in', {
    body: { email: staff.email, password: staff.password },
  });
  await advance(D.staff_ticket_seconds + 1);
  const late = await call('POST', '/staff/sign-in/code', {
    body: { ticket: first.body.ticket, code: codeFor(staff.secret) },
  });
  assert.equal(late.status, 410);
  assert.equal(late.body.code, 'staff_sign_in_expired');

  // A ticket still good when the request was sent, expired by the time the lock was free.
  const second = await call('POST', '/staff/sign-in', {
    body: { email: staff.email, password: staff.password },
  });
  const sessions = await count('staff_session', 'staff_id = $1', [staff.id]);
  const code = codeFor(staff.secret);
  const waited = await whileBlocked(
    [
      'SELECT 1 FROM trucker.staff_sign_in_ticket WHERE ticket_hash = $1 FOR UPDATE',
      [sha(second.body.ticket as string)],
    ],
    () => call('POST', '/staff/sign-in/code', { body: { ticket: second.body.ticket, code } }),
    D.staff_ticket_seconds + 1,
  );
  assert.equal(waited.status, 410);
  assert.equal(await count('staff_session', 'staff_id = $1', [staff.id]), sessions);
});

// ---------------------------------------------------------------------------------------------
// STF-2: staff and participants are apart
// ---------------------------------------------------------------------------------------------
test('a participant token opens no staff route, and a staff token opens no participant route', async () => {
  const staff = await newStaff(['staff_admin']);
  const asked = await call('POST', '/auth/code-requests', { body: { phone: '+999881234567' } });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const verified = await call('POST', '/auth/code-verifications', {
    body: { challengeId: asked.body.challengeId, code: asked.body.developmentCode },
  });
  const participant = verified.body.token as string;
  assert.equal((await call('GET', '/me', { token: participant })).status, 200);
  for (const [method, route] of [
    ['GET', '/staff/me'],
    ['GET', '/staff/accounts'],
    ['GET', '/staff/audit'],
    ['POST', '/staff/sign-out'],
    ['POST', `/staff/accounts/${staff.id}/status`],
    ['POST', `/staff/accounts/${staff.id}/privileges`],
  ] as const) {
    const reply = await call(method, route, {
      token: participant,
      ...(method === 'POST'
        ? { body: { status: 'disabled', privilege: 'reviewer', granted: true } }
        : {}),
    });
    assert.equal(reply.status, 401, `${method} ${route} with a participant token`);
  }
  for (const route of ['/me', '/me/sessions', '/organisations']) {
    assert.equal(
      (await call('GET', route, { token: staff.token })).status,
      401,
      `${route} with a staff token`,
    );
  }
  // The same holds in the database, asked directly as the API's role.
  const staffCheck = await app.query<{ status: string }>(
    'SELECT status FROM trucker.staff_session_check($1, NULL)',
    [hashToken(participant)],
  );
  assert.equal(staffCheck.rows[0]!.status, 'unknown');
  const participantCheck = await app.query<{ status: string }>(
    'SELECT status FROM trucker.session_check($1, NULL)',
    [hashToken(staff.token)],
  );
  assert.equal(participantCheck.rows[0]!.status, 'unknown');
});

// ---------------------------------------------------------------------------------------------
// STF-3: the API's database role
// ---------------------------------------------------------------------------------------------
test('as the API role: no staff table can be read or written, no building block run, and invented tokens reach nothing', async () => {
  const staff = await newStaff();
  for (const table of [
    'staff_account',
    'staff_privilege',
    'staff_enrolment',
    'staff_recovery_code',
    'staff_sign_in_ticket',
    'staff_session',
    'staff_audit_entry',
  ]) {
    await refused(() => app.query(`SELECT * FROM trucker.${table}`), /permission denied/i);
    await refused(() => app.query(`DELETE FROM trucker.${table}`), /permission denied/i);
  }
  for (const statement of [
    `INSERT INTO trucker.staff_session (id, staff_id, token_hash, created_at, last_used_at, absolute_expires_at)
       VALUES (gen_random_uuid(), '${staff.id}', '${'a'.repeat(64)}', now(), now(), now() + interval '1 hour')`,
    `INSERT INTO trucker.staff_privilege VALUES ('${staff.id}', 'staff_admin', NULL, now())`,
    `UPDATE trucker.staff_account SET status = 'active'`,
    `SELECT * FROM trucker.bootstrap_staff_admin('forged@example.test', 'Forged', '${'b'.repeat(64)}')`,
    `SELECT * FROM trucker.staff_check_code('${staff.id}', NULL, NULL, '000000', '${'c'.repeat(64)}', now())`,
    `SELECT * FROM trucker.staff_enter('${hashToken(staff.token)}', NULL, 'staff.forged', NULL, NULL)`,
    `SELECT trucker.staff_audit(now(), NULL, 'staff.forged', 'done', NULL, NULL, '{}')`,
    `SELECT trucker.staff_end_sessions('${staff.id}', 'signed_out', now())`,
    `SELECT trucker.staff_open_enrolment('${staff.id}', '${'d'.repeat(64)}', now())`,
    `SELECT trucker.staff_privileges('${staff.id}')`,
    `SELECT * FROM trucker.staff_live_session('${hashToken(staff.token)}')`,
    `SELECT * FROM trucker.staff_view_of('${staff.id}')`,
    `SELECT trucker.totp_code('\\x00'::bytea, 1)`,
    `SELECT trucker.staff_password_material('x', '${'e'.repeat(64)}')`,
    `SELECT trucker_ext.crypt('x', trucker_ext.gen_salt('bf'))`,
    `SELECT trucker_ext.gen_random_bytes(4)`,
  ]) {
    await refused(() => app.query(statement), /permission denied/i);
  }
  // What it may call decides for itself who is asking. An invented token hash is nobody.
  const invented = 'f'.repeat(64);
  const direct = async (sql: string, values: unknown[]): Promise<string> =>
    (await app.query<{ status: string }>(sql, values)).rows[0]!.status;
  assert.equal(
    await direct('SELECT status FROM trucker.staff_session_check($1, NULL)', [invented]),
    'unknown',
  );
  assert.equal(
    await direct(
      `SELECT status FROM trucker.staff_create($1, $2, 'x@example.test', 'X', 'declared_none', NULL, $3, NULL)`,
      [invented, key(), 'a'.repeat(64)],
    ),
    'unauthorized',
  );
  assert.equal(
    await direct(
      `SELECT trucker.staff_set_privilege($1, $2, 'staff_admin', true, NULL) AS status`,
      [invented, staff.id],
    ),
    'unauthorized',
  );
  assert.equal(
    await direct(`SELECT trucker.staff_set_status($1, $2, 'disabled', NULL) AS status`, [
      invented,
      staff.id,
    ]),
    'unauthorized',
  );
  assert.equal((await app.query('SELECT * FROM trucker.staff_list($1)', [invented])).rowCount, 0);
  assert.equal(
    (await app.query('SELECT * FROM trucker.staff_audit_list($1, NULL)', [invented])).rowCount,
    0,
  );
  assert.equal((await app.query('SELECT * FROM trucker.staff_me($1)', [invented])).rowCount, 0);
  // A real session without the privilege gets nothing from the lists either.
  assert.equal(
    (await app.query('SELECT * FROM trucker.staff_list($1)', [hashToken(staff.token)])).rowCount,
    0,
  );
  assert.equal(
    (await app.query('SELECT * FROM trucker.staff_audit_list($1, NULL)', [hashToken(staff.token)]))
      .rowCount,
    0,
  );
  // Without the key the API holds, a correct code is not accepted: what is stored is not
  // enough to sign in with.
  await advance(31);
  const ticket = randomBytes(32).toString('base64url');
  const noKey = await direct(
    'SELECT status FROM trucker.staff_sign_in_password($1, $2, $3, $4, NULL)',
    [staff.email, staff.password, '0'.repeat(64), sha(ticket)],
  );
  assert.equal(noKey, 'refused');
});

// ---------------------------------------------------------------------------------------------
// STF-5, STF-6: privileges
// ---------------------------------------------------------------------------------------------
test('without staff_admin nothing can be administered, and every refusal is recorded', async () => {
  const plain = await newStaff();
  const reviewer = await newStaff(['reviewer']);
  const target = await newStaff();
  for (const who of [plain, reviewer]) {
    who.token = await signIn(who);
    const entries = await auditCount();
    const attempts: [string, string, unknown?][] = [
      ['GET', '/staff/accounts'],
      ['GET', '/staff/audit'],
      [
        'POST',
        '/staff/accounts',
        { email: newEmail(), displayName: 'No', participantLink: 'declared_none' },
      ],
      ['POST', `/staff/accounts/${target.id}/status`, { status: 'disabled' }],
      ['POST', `/staff/accounts/${target.id}/privileges`, { privilege: 'reviewer', granted: true }],
      ['POST', `/staff/accounts/${who.id}/privileges`, { privilege: 'staff_admin', granted: true }],
      ['POST', `/staff/accounts/${target.id}/enrolment`, {}],
      [
        'POST',
        `/staff/accounts/${target.id}/participant-link`,
        { participantLink: 'declared_none' },
      ],
    ];
    for (const [method, route, body] of attempts) {
      const reply = await call(method, route, {
        token: who.token,
        key: key(),
        ...(body ? { body } : {}),
      });
      assert.equal(reply.status, 403, `${method} ${route}: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.code, 'staff_privilege_required');
    }
    // One sign-in entry was written by signIn above; every refusal added exactly one more.
    const refusals = await owner.query<{ action: string }>(
      `SELECT action FROM trucker.staff_audit_entry
       WHERE actor_staff_id = $1 AND outcome = 'refused' AND detail ->> 'reason' = 'privilege_not_held'
       ORDER BY id DESC LIMIT $2`,
      [who.id, attempts.length],
    );
    assert.equal(refusals.rowCount, attempts.length);
    assert.equal(await auditCount(), entries + attempts.length);
  }
  const untouched = await owner.query<{ status: string }>(
    'SELECT status FROM trucker.staff_account WHERE id = $1',
    [target.id],
  );
  assert.equal(untouched.rows[0]!.status, 'active');
  assert.deepEqual(
    (await owner.query('SELECT 1 FROM trucker.staff_privilege WHERE staff_id = $1', [target.id]))
      .rows,
    [],
  );
});

test('an administrator grants and removes privileges for others, never for themselves; each is recorded once', async () => {
  const token = await adminToken();
  const who = await theAdmin();
  const other = await newStaff();
  const grant = (id: string, privilege: string, granted: boolean, as = token): Promise<Reply> =>
    call('POST', `/staff/accounts/${id}/privileges`, { token: as, body: { privilege, granted } });

  const live = await adminToken();
  const given = await grant(other.id, 'reviewer', true, live);
  assert.equal(given.status, 200, JSON.stringify(given.body));
  assert.equal(given.body.outcome, 'changed');
  assert.deepEqual((given.body.account as { privileges: string[] }).privileges, ['reviewer']);
  const row = await owner.query<{ granted_by: string }>(
    `SELECT granted_by FROM trucker.staff_privilege WHERE staff_id = $1 AND privilege = 'reviewer'`,
    [other.id],
  );
  assert.equal(row.rows[0]!.granted_by, who.id);
  // Asked again, nothing changes and nothing more is recorded.
  const entries = await auditCount();
  assert.equal((await grant(other.id, 'reviewer', true, live)).body.outcome, 'unchanged');
  assert.equal(await auditCount(), entries);
  // Removal.
  assert.equal((await grant(other.id, 'reviewer', false, live)).body.outcome, 'changed');
  assert.equal((await grant(other.id, 'reviewer', false, live)).body.outcome, 'unchanged');
  assert.deepEqual(
    (await auditOf(other.id))
      .filter((entry) => entry.action.startsWith('staff.privilege'))
      .map((entry) => [entry.action, entry.outcome, entry.actor_staff_id, entry.detail.privilege]),
    [
      ['staff.privilege.grant', 'done', who.id, 'reviewer'],
      ['staff.privilege.remove', 'done', who.id, 'reviewer'],
    ],
  );
  // Never oneself: not a grant, not a removal, not through any other door.
  const before = await auditCount();
  for (const [route, body] of [
    [`/staff/accounts/${who.id}/privileges`, { privilege: 'reviewer', granted: true }],
    [`/staff/accounts/${who.id}/privileges`, { privilege: 'staff_admin', granted: false }],
    [`/staff/accounts/${who.id}/status`, { status: 'disabled' }],
    [`/staff/accounts/${who.id}/enrolment`, {}],
    [`/staff/accounts/${who.id}/participant-link`, { participantLink: 'declared_none' }],
  ] as const) {
    const reply = await call('POST', route, { token: live, body });
    assert.equal(reply.status, 409, `${route}: ${JSON.stringify(reply.body)}`);
    assert.equal(reply.body.code, 'staff_self_action');
  }
  assert.equal(await auditCount(), before + 5, 'each refusal is recorded');
  const mine = await call('GET', '/staff/me', { token: live });
  assert.deepEqual((mine.body.staff as { privileges: string[]; status: string }).privileges, [
    'staff_admin',
  ]);
  // The table itself refuses a grant recorded as made by its own holder.
  await refused(
    () =>
      owner.query(`INSERT INTO trucker.staff_privilege VALUES ($1, 'reviewer', $1, now())`, [
        other.id,
      ]),
    /staff_privilege_not_self/,
  );
});

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------
test('creating an account needs an explicit declaration about a participant account; a repeat creates nothing more', async () => {
  const token = await adminToken();
  const who = await theAdmin();
  const email = newEmail();
  // No declaration, "not declared", and a declaration that contradicts itself are refused.
  for (const body of [
    { email, displayName: 'New' },
    { email, displayName: 'New', participantLink: 'not_declared' },
    { email, displayName: 'New', participantLink: 'declared' },
    {
      email,
      displayName: 'New',
      participantLink: 'declared_none',
      participantPhone: '+99988000001',
    },
    { email, displayName: 'New', participantLink: 'declared', participantPhone: '12345' },
    { email: 'not an email', displayName: 'New', participantLink: 'declared_none' },
  ]) {
    const reply = await call('POST', '/staff/accounts', { token, key: key(), body });
    assert.equal(reply.status, 422, JSON.stringify(body));
  }
  assert.equal(await count('staff_account', 'email = $1', [email]), 0);
  const retry = key();
  const body = {
    email: `  ${email.toUpperCase()} `,
    displayName: 'New Person',
    participantLink: 'declared',
    participantPhone: '+999 880 000 02',
  };
  const first = await call('POST', '/staff/accounts', { token, key: retry, body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const account = first.body.account as Record<string, unknown>;
  assert.equal(account.email, email);
  assert.equal(account.status, 'invited');
  assert.equal(account.participantLink, 'declared');
  assert.equal(account.participantPhone, '+99988000002');
  assert.deepEqual(account.privileges, []);
  // The answer was lost; the same request again.
  const again = await call('POST', '/staff/accounts', { token, key: retry, body });
  assert.equal(again.status, 201);
  assert.equal((again.body.account as { id: string }).id, account.id);
  assert.equal(await count('staff_account', 'email = $1', [email]), 1);
  assert.equal(
    (await auditOf(account.id as string)).filter((entry) => entry.action === 'staff.create').length,
    1,
  );
  // The link from the answer that was lost is replaced by the one that arrived.
  assert.notEqual(again.body.enrolmentToken, first.body.enrolmentToken);
  assert.equal(
    (await call('POST', '/staff/enrolment/state', { body: { token: first.body.enrolmentToken } }))
      .status,
    410,
  );
  assert.equal(
    (await call('POST', '/staff/enrolment/state', { body: { token: again.body.enrolmentToken } }))
      .status,
    200,
  );
  // The same email under another key is taken.
  const taken = await call('POST', '/staff/accounts', { token, key: key(), body });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'staff_email_taken');
  // The declaration can be changed by an administrator, and the change is recorded.
  const changed = await call('POST', `/staff/accounts/${account.id as string}/participant-link`, {
    token,
    body: { participantLink: 'declared_none' },
  });
  assert.equal(changed.body.outcome, 'changed');
  assert.equal((changed.body.account as { participantPhone: null }).participantPhone, null);
  const link = (await auditOf(account.id as string)).find(
    (entry) => entry.action === 'staff.participant_link',
  );
  assert.deepEqual(link?.detail, {
    before: 'declared',
    after: 'declared_none',
    phone_changed: true,
  });
  assert.equal(link?.actor_staff_id, who.id);
  // The audit list never holds a phone number, a link or a password.
  const trail = await owner.query<{ text: string }>(
    'SELECT detail::text AS text FROM trucker.staff_audit_entry',
  );
  for (const row of trail.rows) assert.doesNotMatch(row.text, /\+999|correct horse|[A-Z2-7]{32}/);
});

test('disabling an account ends its sessions at the next request; a disabled account cannot sign in or enrol', async () => {
  const token = await adminToken();
  const staff = await newStaff(['reviewer']);
  assert.equal((await call('GET', '/staff/me', { token: staff.token })).status, 200);
  const live = await adminToken();
  const off = await call('POST', `/staff/accounts/${staff.id}/status`, {
    token: live,
    body: { status: 'disabled' },
  });
  assert.equal(off.body.outcome, 'changed');
  assert.equal((off.body.account as { status: string }).status, 'disabled');
  assert.equal((await call('GET', '/staff/me', { token: staff.token })).status, 401);
  assert.equal(await count('staff_session', 'staff_id = $1 AND revoked_at IS NULL', [staff.id]), 0);
  assert.equal(
    (await call('POST', '/staff/sign-in', { body: { email: staff.email, password: PASSWORD } }))
      .status,
    401,
  );
  const noLink = await call('POST', `/staff/accounts/${staff.id}/enrolment`, { token: live });
  assert.equal(noLink.status, 409);
  assert.equal(noLink.body.code, 'staff_account_disabled');
  // Asked again: nothing changes, nothing more is recorded.
  const entries = await auditCount();
  const twice = await call('POST', `/staff/accounts/${staff.id}/status`, {
    token: live,
    body: { status: 'disabled' },
  });
  assert.equal(twice.body.outcome, 'unchanged');
  assert.equal(await auditCount(), entries);
  // Enabled again, the person signs in with what they had; the old session stays ended.
  const on = await call('POST', `/staff/accounts/${staff.id}/status`, {
    token: live,
    body: { status: 'enabled' },
  });
  assert.equal((on.body.account as { status: string }).status, 'active');
  assert.equal((await call('GET', '/staff/me', { token: staff.token })).status, 401);
  assert.equal((await call('GET', '/staff/me', { token: await signIn(staff) })).status, 200);
  void token;
  // The rule itself, not only the function that disables: however an account stops being
  // active, none of its sessions is live. Here the migration role changes the row directly.
  const bystander = await newStaff();
  await owner.query(`UPDATE trucker.staff_account SET status = 'disabled' WHERE id = $1`, [
    bystander.id,
  ]);
  assert.equal((await call('GET', '/staff/me', { token: bystander.token })).status, 401);
  const ended = await owner.query<{ reason: string }>(
    'SELECT revoked_reason AS reason FROM trucker.staff_session WHERE token_hash = $1',
    [hashToken(bystander.token)],
  );
  assert.equal(ended.rows[0]!.reason, 'account_closed');
});

test('a new enrolment link for another person replaces their credentials only when it is used', async () => {
  const staff = await newStaff();
  const live = await adminToken();
  const issued = await call('POST', `/staff/accounts/${staff.id}/enrolment`, { token: live });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  // Until the link is used, what the person has keeps working.
  const still = await signIn(staff);
  assert.equal((await call('GET', '/staff/me', { token: still })).status, 200);
  const renewed = await enrol(issued.body.enrolmentToken as string, 'a different long password');
  // Used: the old session, password, authenticator and recovery codes are all gone.
  assert.equal((await call('GET', '/staff/me', { token: still })).status, 401);
  await advance(31);
  assert.equal(
    (await call('POST', '/staff/sign-in', { body: { email: staff.email, password: PASSWORD } }))
      .status,
    401,
  );
  const fresh = { ...staff, password: 'a different long password', secret: renewed.secret };
  const password = await call('POST', '/staff/sign-in', {
    body: { email: fresh.email, password: fresh.password },
  });
  assert.equal(password.status, 200);
  for (const stale of [codeFor(staff.secret), staff.recoveryCodes[0]!]) {
    const reply = await call('POST', '/staff/sign-in/code', {
      body: { ticket: password.body.ticket, code: stale },
    });
    assert.equal(reply.status, 401);
  }
  assert.equal((await call('GET', '/staff/me', { token: await signIn(fresh) })).status, 200);
  assert.equal(await count('staff_recovery_code', 'staff_id = $1', [staff.id]), 10);
});

// ---------------------------------------------------------------------------------------------
// STF-7, STF-9: sessions
// ---------------------------------------------------------------------------------------------
test('a staff session ends when idle or at its absolute limit, also for a request that waited behind a lock', async () => {
  const staff = await newStaff();
  await advance(D.staff_session_idle_minutes * 60 - 5);
  assert.equal((await call('GET', '/staff/me', { token: staff.token })).status, 200);
  await advance(D.staff_session_idle_minutes * 60 + 1);
  assert.equal((await call('GET', '/staff/me', { token: staff.token })).status, 401);
  assert.equal(
    (await auditOf(staff.id)).filter(
      (entry) => entry.action === 'staff.session_ended' && entry.detail.reason === 'idle_expired',
    ).length,
    1,
  );
  // Kept in use, it still ends at the absolute limit.
  const token = await signIn(staff);
  const steps = Math.ceil(
    (D.staff_session_absolute_hours * 60) / (D.staff_session_idle_minutes - 1),
  );
  let ended = false;
  for (let step = 0; step < steps + 1 && !ended; step += 1) {
    await advance((D.staff_session_idle_minutes - 1) * 60);
    ended = (await call('GET', '/staff/me', { token })).status === 401;
  }
  assert.ok(ended, 'the session ended at the absolute limit');
  assert.ok((await auditOf(staff.id)).some((entry) => entry.detail.reason === 'absolute_expired'));

  // An administrator's change sent while the session was live, carried out after it expired.
  const acting = await newStaff(['staff_admin']);
  const target = await newStaff();
  acting.token = await signIn(acting);
  const waited = await whileBlocked(
    [
      'SELECT 1 FROM trucker.staff_session WHERE token_hash = $1 FOR UPDATE',
      [hashToken(acting.token)],
    ],
    () =>
      call('POST', `/staff/accounts/${target.id}/privileges`, {
        token: acting.token,
        body: { privilege: 'reviewer', granted: true },
      }),
    D.staff_session_idle_minutes * 60 + 1,
  );
  assert.equal(waited.status, 401);
  assert.equal(
    await count('staff_privilege', 'staff_id = $1', [target.id]),
    0,
    'nothing was granted',
  );
});

test('sign-out ends the session; asked twice it is still one sign-out', async () => {
  const staff = await newStaff();
  const before = (await auditOf(staff.id)).filter(
    (entry) => entry.action === 'staff.sign_out',
  ).length;
  assert.equal((await call('POST', '/staff/sign-out', { token: staff.token })).status, 204);
  assert.equal((await call('GET', '/staff/me', { token: staff.token })).status, 401);
  assert.equal((await call('POST', '/staff/sign-out', { token: staff.token })).status, 401);
  assert.equal(
    (await auditOf(staff.id)).filter((entry) => entry.action === 'staff.sign_out').length,
    before + 1,
  );
});

// ---------------------------------------------------------------------------------------------
// STF-8: the audit list
// ---------------------------------------------------------------------------------------------
test('the audit list is read by administrators only, in pages, and cannot be changed by anyone', async () => {
  const token = await adminToken();
  const first = await call('GET', '/staff/audit', { token });
  assert.equal(first.status, 200);
  const entries = first.body.entries as { id: string; action: string; occurredAt: string }[];
  assert.equal(entries.length, 50);
  assert.ok(first.body.nextAfter, 'there are more than fifty entries by now');
  const ids = entries.map((entry) => Number(entry.id));
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => b - a),
    'newest first',
  );
  const second = await call('GET', `/staff/audit?after=${first.body.nextAfter as string}`, {
    token,
  });
  const more = (second.body.entries as { id: string }[]).map((entry) => Number(entry.id));
  assert.ok(more.length > 0 && Math.max(...more) < Math.min(...ids), 'the next page is older');
  assert.equal((await call('GET', '/staff/audit?after=abc', { token })).status, 422);
  // Nobody changes or removes an entry: not the API's role, and not the migration role
  // without first taking the guard away, which is itself a visible change to the schema.
  for (const statement of [
    `UPDATE trucker.staff_audit_entry SET outcome = 'done'`,
    `DELETE FROM trucker.staff_audit_entry`,
    `TRUNCATE trucker.staff_audit_entry`,
  ]) {
    await refused(() => owner.query(statement), /cannot be changed or removed/);
    await refused(() => app.query(statement), /permission denied/i);
  }
});

// ---------------------------------------------------------------------------------------------
// SEC-01 (docs/delivery/SECURITY_BACKLOG.md): administrators acting on each other at the same
// moment. Every change of status or privilege now runs alone (an advisory lock taken before
// anything is read), the caller is checked after that lock, and the change is undone if no
// active, enrolled administrator would remain. Which request goes first is not fixed; the tests
// accept either order and require: no 500, every refusal clean, an administrator left.
// These are the last tests in this file because they change who the administrators are.
// ---------------------------------------------------------------------------------------------
/** The test administrator holds staff_admin again (earlier SEC-01 tests take it away). */
async function restoreTestAdministrator(): Promise<void> {
  const who = await theAdmin();
  await owner.query(
    `INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at)
     VALUES ($1, 'staff_admin', NULL, now()) ON CONFLICT DO NOTHING`,
    [who.id],
  );
}
/** Makes the given accounts the only administrators. */
async function onlyAdministrators(...accounts: Staff[]): Promise<void> {
  await owner.query(
    `DELETE FROM trucker.staff_privilege WHERE privilege = 'staff_admin' AND NOT (staff_id = ANY ($1::uuid[]))`,
    [accounts.map((account) => account.id)],
  );
}
async function administratorsLeft(): Promise<number> {
  return count(
    'staff_privilege p JOIN trucker.staff_account a ON a.id = p.staff_id',
    `p.privilege = 'staff_admin' AND a.status = 'active' AND a.enrolled_at IS NOT NULL`,
  );
}
type Act = (as: Staff, target: Staff) => Promise<Reply>;
const removeAdmin: Act = (as, target) =>
  call('POST', `/staff/accounts/${target.id}/privileges`, {
    token: as.token,
    body: { privilege: 'staff_admin', granted: false },
  });
const disable: Act = (as, target) =>
  call('POST', `/staff/accounts/${target.id}/status`, {
    token: as.token,
    body: { status: 'disabled' },
  });
/**
 * Starts every request while a second connection holds the privilege and account tables, so
 * that all of them are in flight together, then lets them go.
 */
async function together(requests: (() => Promise<Reply>)[]): Promise<Reply[]> {
  const holder = await owner.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(
      'LOCK TABLE trucker.staff_privilege, trucker.staff_account IN SHARE ROW EXCLUSIVE MODE',
    );
    const all = Promise.all(requests.map((request) => request()));
    for (let attempt = 0; ; attempt += 1) {
      const waiting = await owner.query<{ n: number }>(
        `SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE NOT l.granted AND a.datname = current_database()`,
      );
      if (waiting.rows[0]!.n >= requests.length) break;
      if (attempt > 400) throw new Error('the requests did not all start waiting');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await holder.query('COMMIT');
    return await all;
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
}
const answersOf = (replies: Reply[]): string =>
  replies.map((r) => `${r.status} ${String(r.body.outcome ?? r.body.code)}`).join(' and ');
/** Exactly one change; every other request refused with a 4xx, none with a server error. */
function oneChangedOthersRefused(replies: Reply[]): void {
  const answers = answersOf(replies);
  assert.equal(replies.filter((r) => r.body.outcome === 'changed').length, 1, answers);
  assert.ok(
    replies.every((r) => r.body.outcome === 'changed' || (r.status >= 400 && r.status < 500)),
    `a request failed instead of being refused (${answers})`,
  );
}

test('SEC-01-a and e: two administrators remove each other at the same moment; one remains, the other is refused cleanly and audited', async () => {
  await restoreTestAdministrator();
  const first = await newStaff(['staff_admin']);
  const second = await newStaff(['staff_admin']);
  await onlyAdministrators(first, second);
  const replies = await together([
    () => removeAdmin(first, second),
    () => removeAdmin(second, first),
  ]);
  oneChangedOthersRefused(replies);
  assert.equal(await administratorsLeft(), 1);
  // The loser lost staff_admin while waiting, so it is refused as no longer holding it (403),
  // never by a deadlock abort.
  const loserIndex = replies.findIndex((r) => r.body.outcome !== 'changed');
  const loser = loserIndex === 0 ? first : second;
  assert.equal(replies[loserIndex]!.status, 403, answersOf(replies));
  const refusals = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM trucker.staff_audit_entry
     WHERE actor_staff_id = $1 AND action = 'staff.privilege.remove' AND outcome = 'refused'
       AND detail ->> 'reason' = 'privilege_not_held'`,
    [loser.id],
  );
  assert.equal(refusals.rows[0]!.n, 1, 'the refusal is audited once');
  // The refused caller keeps its session: it can still read its own account.
  const me = await call('GET', '/staff/me', { token: loser.token });
  assert.equal(me.status, 200, JSON.stringify(me.body));
});

test('SEC-01-b: two administrators disable each other at the same moment; one remains, no 500', async () => {
  await restoreTestAdministrator();
  const first = await newStaff(['staff_admin']);
  const second = await newStaff(['staff_admin']);
  await onlyAdministrators(first, second);
  const replies = await together([() => disable(first, second), () => disable(second, first)]);
  oneChangedOthersRefused(replies);
  assert.equal(await administratorsLeft(), 1);
  // The loser's sessions were ended by the other's change, so it is refused as signed out.
  assert.equal(replies.find((r) => r.body.outcome !== 'changed')!.status, 401, answersOf(replies));
});

test('SEC-01-c: one disables while the other removes the privilege; one remains, no 500', async () => {
  await restoreTestAdministrator();
  const first = await newStaff(['staff_admin']);
  const second = await newStaff(['staff_admin']);
  await onlyAdministrators(first, second);
  const replies = await together([() => disable(first, second), () => removeAdmin(second, first)]);
  oneChangedOthersRefused(replies);
  assert.equal(await administratorsLeft(), 1);
});

test('SEC-01-d: three administrators acting in a ring leave at least one, with no 500', async () => {
  await restoreTestAdministrator();
  const a = await newStaff(['staff_admin']);
  const b = await newStaff(['staff_admin']);
  const c = await newStaff(['staff_admin']);
  await onlyAdministrators(a, b, c);
  const replies = await together([
    () => removeAdmin(a, b),
    () => removeAdmin(b, c),
    () => removeAdmin(c, a),
  ]);
  const answers = answersOf(replies);
  assert.ok(
    replies.every((r) => r.status < 500),
    answers,
  );
  assert.ok((await administratorsLeft()) >= 1, answers);
});

test('SEC-01: both administration functions take the lock first and check that an administrator remains; the check refuses when none would', async () => {
  // Through the API the check cannot be reached: a caller with a live session is an active,
  // enrolled account holding staff_admin, and nobody can act on themselves, so the caller always
  // remains. The check is a backstop against later changes. It is tested directly, and both
  // functions are required to call the lock before anything else and the check after the change.
  const source = await owner.query<{ name: string; src: string }>(
    `SELECT p.proname AS name, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'trucker' AND p.proname IN ('staff_set_status', 'staff_set_privilege')`,
  );
  assert.equal(source.rows.length, 2);
  for (const { name, src } of source.rows) {
    const lock = src.indexOf('pg_advisory_xact_lock(trucker.staff_administration_lock())');
    assert.ok(lock >= 0, `${name} takes the administration lock`);
    assert.ok(
      lock < src.indexOf('staff_enter('),
      `${name} takes the lock before reading the caller`,
    );
    assert.ok(
      src.includes('staff_administrator_remains()'),
      `${name} checks that an administrator remains`,
    );
    assert.ok(
      src.includes("RETURN 'last_administrator'"),
      `${name} refuses with last_administrator`,
    );
  }
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM trucker.staff_privilege WHERE privilege = 'staff_admin'`);
    await assert.rejects(
      client.query('SELECT trucker.staff_administrator_remains()'),
      (error: { code?: string }) => error.code === 'TA001',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.ok((await administratorsLeft()) >= 1);
  // The API answers the refusal as a conflict with its own code.
  const thrown = (() => {
    try {
      (nest.get(StaffService) as unknown as { refuse(status: string): void }).refuse(
        'last_administrator',
      );
    } catch (error) {
      return error as { status?: number; code?: string };
    }
    return null;
  })();
  assert.equal(thrown?.status, 409);
  assert.equal(thrown?.code, 'last_administrator');
});
