import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { loadConfig } from '../config/config.js';
import {
  appDatabaseUrl,
  ensureLocalAppLogin,
  loadCountryFixtures,
  markEnvironment,
} from '../database/local.js';
import { defaultMigrationsDir, migrateUp } from '../database/migrations.js';
import { SECURITY_SETTING_DEFAULTS } from '../database/settings.js';
import { configureApp } from '../http/configure-app.js';
import { hashToken } from '../identity/secrets.js';
import { DEMONSTRATION_TERMS_VERSION } from '../identity/terms.js';
import { createTestClock } from '../testing/test-clock.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';

// Pilot invitations (DB-17, db/migrations/0042). Real PostgreSQL, the API connected as its
// restricted role. Test accounts and fictional numbers (+999, not assigned) only.
const D = SECURITY_SETTING_DEFAULTS;
const testClock = createTestClock(new Date('2026-06-01T08:00:00.000Z'));
const { clock, advance } = testClock;

let database: TestDatabase;
let owner: pg.Pool;
let base: string;
let nest: INestApplication;

before(async () => {
  database = await createTestDatabase();
  owner = new pg.Pool({ connectionString: database.url });
  await migrateUp(owner, defaultMigrationsDir());
  await ensureLocalAppLogin(owner);
  await markEnvironment(owner, 'test');
  await testClock.start(owner);
  await loadCountryFixtures(owner);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    APP_DATABASE_URL: appDatabaseUrl(database.url),
    SIGN_IN_CODE_DELIVERY: 'development-display',
    REGISTRATION_TERMS: 'demonstration',
    COUNTRY_FIXTURES: 'local-development',
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
  await owner.end();
  await database.drop();
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
  text: string;
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
    text,
  };
}

const setRequired = (on: boolean): Promise<unknown> =>
  owner.query('UPDATE trucker.security_setting SET pilot_invitation_required = $1', [on ? 1 : 0]);

let phoneCounter = 0;
const newPhone = (): string => `+99978${String(1_000_000 + phoneCounter++)}`;

/** Signs in with a number, which makes an unregistered person. */
async function signIn(phone: string): Promise<{ token: string; personId: string }> {
  const asked = await call('POST', '/auth/code-requests', { body: { phone } });
  assert.equal(asked.status, 202, asked.text);
  const verified = await call('POST', '/auth/code-verifications', {
    body: { challengeId: asked.body.challengeId, code: asked.body.developmentCode },
  });
  assert.equal(verified.status, 200, verified.text);
  await advance(D.code_resend_wait_seconds + 1);
  return {
    token: verified.body.token as string,
    personId: (verified.body.person as { id: string }).id,
  };
}
const register = (token: string): Promise<Reply> =>
  call('POST', '/me/registration', {
    token,
    body: {
      displayName: 'Invited Contact (fictional)',
      termsVersion: DEMONSTRATION_TERMS_VERSION,
      termsLanguage: 'en',
      termsSeen: true,
    },
  });

let staffCounter = 0;
async function newStaff(privileges: string[]): Promise<{ id: string; token: string }> {
  const made = await owner.query<{ id: string }>(
    `INSERT INTO trucker.staff_account
       (email, display_name, status, enrolled_at, password_hash, totp_secret, participant_link,
        participant_phone, created_at, updated_at)
     VALUES ($1, 'Test Staff', 'active', $2, 'not-a-real-hash', '\\x00', 'declared_none', NULL, $2, $2)
     RETURNING id`,
    [`pilot${++staffCounter}@example.test`, clock()],
  );
  const id = made.rows[0]!.id;
  for (const privilege of privileges)
    await owner.query(
      `INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at) VALUES ($1, $2, NULL, $3)`,
      [id, privilege, clock()],
    );
  const token = `${randomUUID()}.${randomBytes(16).toString('base64url')}`;
  await owner.query(
    `INSERT INTO trucker.staff_session (id, staff_id, token_hash, created_at, last_used_at, absolute_expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $3, $3::timestamptz + interval '8 hours')`,
    [id, hashToken(token), clock()],
  );
  return { id, token };
}

interface Invitation {
  id: string;
  version: number;
  phone: string;
  organisationName: string;
  contactName: string;
  status: string;
  expiresAt: string;
}
const invite = (token: string, phone: string, organisationName = 'Pilot Carrier (fictional)') =>
  call('POST', '/staff/pilot-invitations', {
    token,
    body: { phone, organisationName, contactName: 'Pilot Contact (fictional)' },
  });
async function listed(token: string): Promise<{
  required: boolean;
  validDays: number;
  invitations: Invitation[];
}> {
  const reply = await call('GET', '/staff/pilot-invitations', { token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.pilot as { required: boolean; validDays: number; invitations: Invitation[] };
}

test('PIL-1: with invitations required, registration needs an open invitation for the number, and takes it once', async () => {
  await setRequired(true);
  try {
    const admin = await newStaff(['staff_admin']);
    // No invitation: refused, recorded, and the person stays unregistered.
    const phone = newPhone();
    const person = await signIn(phone);
    const refused = await register(person.token);
    assert.deepEqual([refused.status, refused.body.code], [403, 'invitation_required']);
    const unregistered = await owner.query(
      'SELECT registration_completed_at FROM trucker.person WHERE id = $1',
      [person.personId],
    );
    assert.equal(unregistered.rows[0]!.registration_completed_at, null);
    const events = await owner.query<{ kind: string }>(
      'SELECT kind FROM trucker.identity_event WHERE person_id = $1 ORDER BY id',
      [person.personId],
    );
    assert.ok(events.rows.some((row) => row.kind === 'registration_refused_not_invited'));

    // Invited: registration succeeds and the invitation is taken.
    const made = await invite(admin.token, phone);
    assert.deepEqual([made.status, made.body.outcome], [200, 'invited']);
    const invitation = made.body.invitation as Invitation;
    assert.equal(invitation.status, 'pending');
    assert.equal(
      new Date(invitation.expiresAt).getTime() - clock().getTime(),
      D.pilot_invitation_days * 24 * 3600 * 1000,
    );
    const done = await register(person.token);
    assert.equal(done.status, 200, done.text);
    const after = (await listed(admin.token)).invitations.find((i) => i.id === invitation.id)!;
    assert.equal(after.status, 'accepted');
    const accepted = await owner.query(
      'SELECT accepted_by FROM trucker.pilot_invitation WHERE id = $1',
      [invitation.id],
    );
    assert.equal(accepted.rows[0]!.accepted_by, person.personId);

    // Taken once: the number cannot be invited again, as it is registered.
    const again = await invite(admin.token, phone);
    assert.deepEqual([again.status, again.body.code], [409, 'already_registered']);

    // Another person with another number cannot use it.
    const other = await signIn(newPhone());
    assert.equal((await register(other.token)).body.code, 'invitation_required');
  } finally {
    await setRequired(false);
  }
});

test('PIL-2: an invitation expires, a cancelled one is refused, and a new one can then be made', async () => {
  await setRequired(true);
  try {
    const admin = await newStaff(['staff_admin']);
    const phone = newPhone();
    const first = (await invite(admin.token, phone)).body.invitation as Invitation;
    // A retry of the same invitation makes nothing more; a different one for the number is refused.
    const retry = await invite(admin.token, phone);
    assert.deepEqual(
      [retry.body.outcome, (retry.body.invitation as Invitation).id],
      ['already_invited', first.id],
    );
    const different = await invite(admin.token, phone, 'Another Organisation (fictional)');
    assert.deepEqual([different.status, different.body.code], [409, 'invitation_open']);

    // Expired: the person is refused, and staff see it as expired. Staff sessions are short, so
    // a new one is opened after the clock has moved.
    await advance(D.pilot_invitation_days * 24 * 3600 + 1);
    const admin2 = await newStaff(['staff_admin']);
    const person = await signIn(phone);
    assert.equal((await register(person.token)).body.code, 'invitation_required');
    assert.equal(
      (await listed(admin2.token)).invitations.find((i) => i.id === first.id)!.status,
      'expired',
    );
    const lateCancel = await call('POST', `/staff/pilot-invitations/${first.id}/cancel`, {
      token: admin2.token,
      body: { version: first.version },
    });
    assert.deepEqual([lateCancel.status, lateCancel.body.code], [409, 'invitation_not_open']);

    // A new invitation replaces the expired one, which is kept as expired.
    const second = (await invite(admin2.token, phone)).body.invitation as Invitation;
    assert.notEqual(second.id, first.id);
    const stored = await owner.query<{ status: string }>(
      'SELECT status FROM trucker.pilot_invitation WHERE id = $1',
      [first.id],
    );
    assert.equal(stored.rows[0]!.status, 'expired');

    // A stale version is refused; the current one cancels; repeating says so.
    const stale = await call('POST', `/staff/pilot-invitations/${second.id}/cancel`, {
      token: admin2.token,
      body: { version: second.version + 1 },
    });
    assert.deepEqual([stale.status, stale.body.code], [409, 'record_changed']);
    const cancelled = await call('POST', `/staff/pilot-invitations/${second.id}/cancel`, {
      token: admin2.token,
      body: { version: second.version },
    });
    assert.deepEqual([cancelled.status, cancelled.body.outcome], [200, 'cancelled']);
    const repeated = await call('POST', `/staff/pilot-invitations/${second.id}/cancel`, {
      token: admin2.token,
      body: { version: second.version },
    });
    assert.equal(repeated.body.outcome, 'already_cancelled');
    const late = await signIn(phone);
    assert.equal((await register(late.token)).body.code, 'invitation_required');
  } finally {
    await setRequired(false);
  }
});

test('PIL-3: a driver invited by a carrier registers without a pilot invitation', async () => {
  await setRequired(true);
  try {
    // A carrier organisation and its administrator, made directly: only the driver's
    // invitation matters here.
    const admin = await newStaff(['staff_admin']);
    const carrierPhone = newPhone();
    await invite(admin.token, carrierPhone);
    const carrier = await signIn(carrierPhone);
    assert.equal((await register(carrier.token)).status, 200);
    const org = await call('POST', '/organisations', {
      token: carrier.token,
      key: `test-${randomUUID()}`,
      body: {
        legalName: 'Pilot Carrier (fictional)',
        countryCode: 'XA',
        registrationNumber: `PIL-${randomBytes(3).toString('hex')}`,
      },
    });
    assert.equal(org.status, 201, org.text);
    const driverPhone = newPhone();
    await owner.query(
      `INSERT INTO trucker.driver_affiliation (organisation_id, invited_phone, invited_by, invited_at)
       VALUES ($1, $2, $3, $4)`,
      [(org.body.organisation as { id: string }).id, driverPhone, carrier.personId, clock()],
    );
    const driver = await signIn(driverPhone);
    assert.equal((await register(driver.token)).status, 200);
  } finally {
    await setRequired(false);
  }
});

test('PIL-4: with invitations not required, registration is unchanged and an open invitation is still taken', async () => {
  const admin = await newStaff(['staff_admin']);
  const plain = await signIn(newPhone());
  assert.equal((await register(plain.token)).status, 200);
  const phone = newPhone();
  const made = (await invite(admin.token, phone)).body.invitation as Invitation;
  const person = await signIn(phone);
  assert.equal((await register(person.token)).status, 200);
  assert.equal(
    (await listed(admin.token)).invitations.find((i) => i.id === made.id)!.status,
    'accepted',
  );
  assert.equal((await listed(admin.token)).required, false);
});

test('PIL-5: only staff administrators see or change invitations; input is checked by field; the audit names no number', async () => {
  const reviewer = await newStaff(['reviewer']);
  const operations = await newStaff(['operations']);
  for (const staff of [reviewer, operations]) {
    const list = await call('GET', '/staff/pilot-invitations', { token: staff.token });
    assert.deepEqual([list.status, list.body.code], [403, 'staff_privilege_required']);
    const made = await invite(staff.token, newPhone());
    assert.deepEqual([made.status, made.body.code], [403, 'staff_privilege_required']);
  }
  // A participant's token opens no staff route.
  const participant = await signIn(newPhone());
  assert.equal(
    (await call('GET', '/staff/pilot-invitations', { token: participant.token })).status,
    401,
  );
  const admin = await newStaff(['staff_admin']);
  const bad = await call('POST', '/staff/pilot-invitations', {
    token: admin.token,
    body: { phone: '12345', organisationName: '  ', contactName: '' },
  });
  assert.equal(bad.status, 422);
  assert.deepEqual((bad.body.details as { problems: unknown[] }).problems, [
    { field: 'phone', code: 'invalid' },
    { field: 'organisationName', code: 'invalid' },
    { field: 'contactName', code: 'invalid' },
  ]);
  const phone = newPhone();
  const made = (await invite(admin.token, phone)).body.invitation as Invitation;
  const audit = await owner.query<{ action: string; outcome: string; detail: unknown }>(
    `SELECT action, outcome, detail FROM trucker.staff_audit_entry
     WHERE actor_staff_id = $1 ORDER BY id`,
    [admin.id],
  );
  const entry = audit.rows.find(
    (row) => row.action === 'staff.pilot_invite' && row.outcome === 'done',
  )!;
  assert.equal((entry.detail as { invitation: string }).invitation, made.id);
  assert.ok(!JSON.stringify(audit.rows).includes(phone), 'the audit list holds the number');
  assert.ok(
    !JSON.stringify(audit.rows).includes('Pilot Contact'),
    'the audit list holds the contact name',
  );
  const refusals = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM trucker.staff_audit_entry
     WHERE actor_staff_id = $1 AND outcome = 'refused'`,
    [reviewer.id],
  );
  assert.equal(refusals.rows[0]!.n, 2);
});

test('PIL-6: an invitation is never removed or rewritten, and the API role cannot reach the table', async () => {
  const admin = await newStaff(['staff_admin']);
  const made = (await invite(admin.token, newPhone())).body.invitation as Invitation;
  await assert.rejects(
    owner.query('DELETE FROM trucker.pilot_invitation WHERE id = $1', [made.id]),
    /never removed/,
  );
  await assert.rejects(
    owner.query(
      "UPDATE trucker.pilot_invitation SET organisation_name = 'Changed', row_version = row_version + 1 WHERE id = $1",
      [made.id],
    ),
    /only moves once/,
  );
  const app = new pg.Pool({ connectionString: appDatabaseUrl(database.url), max: 1 });
  try {
    await assert.rejects(app.query('SELECT * FROM trucker.pilot_invitation'), /permission denied/);
  } finally {
    await app.end();
  }
});

test('PIL-7: two registrations cannot take one invitation, and a cancel cannot slip in while it is taken', async () => {
  await setRequired(true);
  try {
    const admin = await newStaff(['staff_admin']);
    const phone = newPhone();
    const made = (await invite(admin.token, phone)).body.invitation as Invitation;
    const person = await signIn(phone);
    const [registered, cancelled] = await Promise.all([
      register(person.token),
      call('POST', `/staff/pilot-invitations/${made.id}/cancel`, {
        token: admin.token,
        body: { version: made.version },
      }),
    ]);
    // Exactly one wins: either the registration took it, or the cancel ended it first.
    const stored = await owner.query<{ status: string }>(
      'SELECT status FROM trucker.pilot_invitation WHERE id = $1',
      [made.id],
    );
    if (registered.status === 200) {
      assert.equal(stored.rows[0]!.status, 'accepted');
      assert.equal(cancelled.body.code, 'invitation_not_open');
    } else {
      assert.equal(registered.body.code, 'invitation_required');
      assert.equal(stored.rows[0]!.status, 'cancelled');
      assert.equal(cancelled.body.outcome, 'cancelled');
    }
  } finally {
    await setRequired(false);
  }
});
