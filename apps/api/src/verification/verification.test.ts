import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
import { blockedRequests } from '../testing/blocked-request.js';
import { createTestClock } from '../testing/test-clock.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';

// Organisation verification (slice 9). Real PostgreSQL, the API connected as its restricted
// role. Staff identity has its own tests (src/staff/staff.test.ts); here staff accounts and
// their sessions are put in place directly by the migration role, so that these tests are
// about verification and nothing else.

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
  await loadCountryFixtures(owner);
  app = new pg.Pool({ connectionString: appDatabaseUrl(database.url), max: 3 });
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
  await app.end();
  await owner.end();
  await database.drop();
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
  text: string;
}
const key = (): string => `test-${randomUUID()}`;
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
    headers['idempotency-key'] = key();
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

// ---------------------------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------------------------
let phoneCounter = 0;
const newPhone = (): string => `+99977${String(1_000_000 + phoneCounter++)}`;
interface Person {
  token: string;
  personId: string;
  phone: string;
}
async function newPerson(phone = newPhone()): Promise<Person> {
  const asked = await call('POST', '/auth/code-requests', { body: { phone } });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const verified = await call('POST', '/auth/code-verifications', {
    body: { challengeId: asked.body.challengeId, code: asked.body.developmentCode },
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  await advance(D.code_resend_wait_seconds + 1);
  const person = {
    token: verified.body.token as string,
    personId: (verified.body.person as { id: string }).id,
    phone,
  };
  const done = await call('POST', '/me/registration', {
    token: person.token,
    body: {
      displayName: 'Test Person (fictional)',
      termsVersion: DEMONSTRATION_TERMS_VERSION,
      termsLanguage: 'en',
      termsSeen: true,
    },
  });
  assert.ok(done.status === 200 || done.status === 409, JSON.stringify(done.body));
  return person;
}
let numberCounter = 0;
const newNumber = (): string => `VR-${++numberCounter}-${randomBytes(3).toString('hex')}`;
async function newOrganisation(
  person: Person,
  details: { countryCode?: string; registrationNumber?: string; legalName?: string } = {},
): Promise<string> {
  const reply = await call('POST', '/organisations', {
    token: person.token,
    key: key(),
    body: {
      legalName: details.legalName ?? 'Fixture Shipper (fictional)',
      countryCode: details.countryCode ?? 'XA',
      registrationNumber: details.registrationNumber ?? newNumber(),
    },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return (reply.body.organisation as { id: string }).id;
}
async function newShipper(details?: Parameters<typeof newOrganisation>[1]) {
  const person = await newPerson();
  return { person, org: await newOrganisation(person, details) };
}

interface Application {
  id: string;
  versionNo: number;
  kind: string;
  status: string;
  legalName: string;
  countryCode: string;
  registrationNumber: string;
  decisionReason: string | null;
  decisionNote: string | null;
  evidenceKind: string;
  evidence: Record<string, unknown>[];
}
interface Overview {
  organisation: {
    id: string;
    status: string;
    version: number;
    legalName: string;
    countryCode: string;
    registrationNumber: string;
  };
  requirements: { documentType: string; required: boolean }[];
  applications: Application[];
  capability: { status: string; basis: string; revokeReason: string | null } | null;
  maySubmit: string | null;
  mayPublish: boolean;
}
const route = (org: string, rest = ''): string => `/organisations/${org}/verification${rest}`;
async function overview(person: Person, org: string): Promise<Overview> {
  const reply = await call('GET', route(org), { token: person.token });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.verification as Overview;
}
/** The entries the fictional requirements of country XA ask for. */
const evidence = (extra: Record<string, unknown>[] = []): Record<string, unknown>[] => [
  {
    documentType: 'registration_certificate',
    documentNumber: 'REG-0001',
    issuingCountry: 'XA',
    issuedOn: '2025-01-15',
    expiresOn: '2027-01-15',
  },
  { documentType: 'transport_licence', documentNumber: 'LIC-0002', issuingCountry: 'XA' },
  ...extra,
];
async function submit(
  person: Person,
  org: string,
  body: Record<string, unknown> = {},
  retryKey = key(),
): Promise<Reply> {
  const version =
    (body.version as number | undefined) ?? (await overview(person, org)).organisation.version;
  return call('POST', route(org, '/applications'), {
    token: person.token,
    key: retryKey,
    body: {
      declarationAccepted: true,
      declarationLanguage: 'en',
      evidence: evidence(),
      ...body,
      version,
    },
  });
}
async function submitted(
  person: Person,
  org: string,
  body?: Record<string, unknown>,
): Promise<Application> {
  const reply = await submit(person, org, body);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return (reply.body.verification as Overview).applications[0]!;
}
const problems = (reply: Reply): { field: string; code: string }[] =>
  ((reply.body.details as { problems?: unknown } | undefined)?.problems ?? []) as {
    field: string;
    code: string;
  }[];

// ---------------------------------------------------------------------------------------------
// Staff, put in place directly by the migration role
// ---------------------------------------------------------------------------------------------
interface Staff {
  id: string;
  token: string;
}
let staffCounter = 0;
async function newStaff(
  privileges: string[],
  link: { link: 'not_declared' | 'declared_none' } | { link: 'declared'; phone: string } = {
    link: 'declared_none',
  },
): Promise<Staff> {
  const made = await owner.query<{ id: string }>(
    `INSERT INTO trucker.staff_account
       (email, display_name, status, enrolled_at, password_hash, totp_secret, participant_link,
        participant_phone, created_at, updated_at)
     VALUES ($1, 'Test Staff', 'active', $2, 'not-a-real-hash', '\\x00', $3, $4, $2, $2)
     RETURNING id`,
    [
      `reviewer${++staffCounter}@example.test`,
      clock(),
      link.link,
      link.link === 'declared' ? link.phone : null,
    ],
  );
  const id = made.rows[0]!.id;
  for (const privilege of privileges)
    await owner.query(
      `INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at) VALUES ($1, $2, NULL, $3)`,
      [id, privilege, clock()],
    );
  return { id, token: await staffSession(id) };
}
/** A session that is live now. Staff sessions are short, and these tests move the clock. */
async function staffSession(id: string): Promise<string> {
  const token = `${randomUUID()}.${randomBytes(16).toString('base64url')}`;
  await owner.query(
    `INSERT INTO trucker.staff_session (id, staff_id, token_hash, created_at, last_used_at, absolute_expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $3, $3::timestamptz + interval '8 hours')`,
    [id, hashToken(token), clock()],
  );
  return token;
}
const fresh = async (staff: Staff): Promise<Staff> => {
  staff.token = await staffSession(staff.id);
  return staff;
};
interface Detail {
  application: { id: string; rowVersion: number; status: string; claimRaised: boolean };
  organisation: { id: string; status: string };
  competing: boolean;
  independence: string;
  earlier: Record<string, unknown>[];
}
async function view(staff: Staff, application: string): Promise<Detail> {
  const reply = await call('GET', `/staff/verification/${application}`, { token: staff.token });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body as unknown as Detail;
}
async function decide(
  staff: Staff,
  application: string,
  decision: string,
  input: Record<string, unknown> = {},
): Promise<Reply> {
  await fresh(staff);
  // Read as the migration role, so that a staff member who may not even look can still try.
  const version =
    (input.version as number | undefined) ??
    (
      await owner.query<{ v: number }>(
        'SELECT row_version AS v FROM trucker.verification_application WHERE id = $1',
        [application],
      )
    ).rows[0]!.v;
  const reasons: Record<string, string> = {
    verified: 'evidence_accepted',
    changes_requested: 'evidence_unclear',
    rejected: 'not_eligible',
  };
  return call('POST', `/staff/verification/${application}/decision`, {
    token: staff.token,
    body: { decision, reason: reasons[decision], noConflict: true, ...input, version },
  });
}
async function verified(staff: Staff, person: Person, org: string): Promise<Application> {
  const application = await submitted(person, org);
  const reply = await decide(staff, application.id, 'verified');
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.outcome, 'decided');
  return application;
}

const count = async (table: string, where = 'true', values: unknown[] = []): Promise<number> =>
  (
    await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trucker.${table} WHERE ${where}`,
      values,
    )
  ).rows[0]!.n;
const history = async (person: Person, org: string) =>
  ((await call('GET', `/organisations/${org}/history`, { token: person.token })).body.entries ??
    []) as { action: string; byStaff: boolean; actorPersonId: string | null }[];
const staffAudit = async (staff: Staff, action: string) =>
  (
    await owner.query<{ outcome: string; detail: Record<string, unknown> }>(
      `SELECT outcome, detail FROM trucker.staff_audit_entry
       WHERE actor_staff_id = $1 AND action = $2 ORDER BY id`,
      [staff.id, action],
    )
  ).rows;
const refused = async (work: () => Promise<unknown>, pattern: RegExp): Promise<void> => {
  await assert.rejects(work, (error: Error) => pattern.test(error.message), String(pattern));
};
async function asApiRole<T>(
  context: { tokenHash?: string; organisationId?: string },
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('trucker.session_token_hash', $1, true),
              set_config('trucker.organisation_id', $2, true)`,
      [context.tokenHash ?? '', context.organisationId ?? ''],
    );
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------
// VER-14: nothing ships
// ---------------------------------------------------------------------------------------------
test('after the migrations no requirement exists, none can be added for a real country, and nothing can be submitted without one', async () => {
  const scratch = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: scratch.url });
  try {
    await migrateUp(pool, defaultMigrationsDir());
    for (const table of [
      'evidence_requirement',
      'verification_application',
      'organisation_capability',
    ]) {
      const rows = await pool.query(`SELECT 1 FROM trucker.${table}`);
      assert.equal(rows.rowCount, 0, table);
    }
    // A requirement for a real country would be a statement about its law. None is approved.
    await pool.query(
      `INSERT INTO trucker.country (code, name_en, name_ar, name_ur) VALUES ('OM', 'Oman', 'عُمان', 'عمان')`,
    );
    await refused(
      () =>
        pool.query(
          `INSERT INTO trucker.evidence_requirement (country_code, capability, document_type, name_en, name_ar, name_ur)
           VALUES ('OM', 'ship', 'registration_certificate', 'x', 'x', 'x')`,
        ),
      /only for fictional countries/,
    );
    // And a fictional one only where fictional countries may exist at all.
    await refused(
      () =>
        pool.query(
          `INSERT INTO trucker.country (code, name_en, name_ar, name_ur, fixture) VALUES ('XA', 'x', 'x', 'x', true)`,
        ),
      /only in a database marked/,
    );
  } finally {
    await pool.end();
    await scratch.drop();
  }
  // A country with no requirement: its organisations cannot apply.
  const { person, org } = await newShipper({ countryCode: 'XB' });
  const held = await owner.query(
    `DELETE FROM trucker.evidence_requirement WHERE country_code = 'XB' RETURNING *`,
  );
  try {
    assert.equal((await overview(person, org)).maySubmit, null);
    const reply = await submit(person, org, {
      evidence: [
        { documentType: 'registration_certificate', documentNumber: 'R', issuingCountry: 'XB' },
      ],
    });
    assert.equal(reply.status, 409, JSON.stringify(reply.body));
    assert.equal(reply.body.code, 'verification_closed');
    assert.equal(await count('verification_application', 'organisation_id = $1', [org]), 0);
  } finally {
    for (const row of held.rows as Record<string, unknown>[])
      await owner.query(
        `INSERT INTO trucker.evidence_requirement (country_code, capability, document_type, name_en, name_ar, name_ur, required, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.country_code,
          row.capability,
          row.document_type,
          row.name_en,
          row.name_ar,
          row.name_ur,
          row.required,
          row.position,
        ],
      );
  }
});

// ---------------------------------------------------------------------------------------------
// Submission (VER-1 to VER-3, VER-13, VER-15)
// ---------------------------------------------------------------------------------------------
test('an administrator submits with a declaration and evidence entries; the organisation is then locked', async () => {
  const { person, org } = await newShipper();
  const start = await overview(person, org);
  assert.equal(start.organisation.status, 'draft');
  assert.equal(start.maySubmit, 'initial');
  assert.deepEqual(
    start.requirements.map((item) => [item.documentType, item.required]),
    [
      ['registration_certificate', true],
      ['transport_licence', true],
      ['tax_certificate', false],
    ],
  );
  assert.equal(start.mayPublish, false);
  const reply = await submit(person, org);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  const now = reply.body.verification as Overview;
  assert.equal(now.organisation.status, 'submitted');
  assert.equal(now.organisation.version, start.organisation.version + 1);
  assert.equal(now.maySubmit, null);
  const [application] = now.applications;
  assert.equal(application!.versionNo, 1);
  assert.equal(application!.kind, 'initial');
  assert.equal(application!.status, 'submitted');
  // The entries are labelled for what they are, wherever they are read.
  assert.equal(application!.evidenceKind, 'declared_demonstration');
  assert.deepEqual(application!.evidence[0], {
    documentType: 'registration_certificate',
    documentNumber: 'REG-0001',
    issuingCountry: 'XA',
    issuedOn: '2025-01-15',
    expiresOn: '2027-01-15',
  });
  const stored = await owner.query<{ kind: string; version: string; language: string; by: string }>(
    `SELECT declaration_kind AS kind, declaration_version AS version, declaration_language AS language,
            submitted_by AS by
     FROM trucker.verification_application WHERE id = $1`,
    [application!.id],
  );
  assert.deepEqual(stored.rows[0], {
    kind: 'demonstration',
    version: 'demonstration-declaration-1',
    language: 'en',
    by: person.personId,
  });
  // Locked: not through the API, and not by the API's role directly.
  const edit = await call('PATCH', `/organisations/${org}`, {
    token: person.token,
    body: {
      legalName: 'Changed While Under Review',
      countryCode: 'XA',
      registrationNumber: now.organisation.registrationNumber,
      version: now.organisation.version,
    },
  });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, 'organisation_not_editable');
  const direct = await asApiRole(
    { tokenHash: hashToken(person.token), organisationId: org },
    (client) =>
      client.query(
        `UPDATE trucker.organisation SET legal_name = 'Changed', version = version + 1 WHERE id = $1`,
        [org],
      ),
  );
  assert.equal(direct.rowCount, 0);
  // A second application cannot be opened beside it.
  const second = await submit(person, org);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'verification_not_open');
  // History: the application, and the organisation's change of state.
  assert.deepEqual(
    (await history(person, org)).map((entry) => `${entry.action} ${entry.byStaff}`).sort(),
    ['organisation.created false', 'organisation.updated false', 'verification.submitted false'],
  );
});

test('a submission without the declaration, without a required entry, or with a bad entry is refused by field', async () => {
  const { person, org } = await newShipper();
  const cases: [Record<string, unknown>, string, string][] = [
    [{ declarationAccepted: false }, 'declaration', 'required'],
    [{ evidence: [evidence()[0]] }, 'evidence.transport_licence.documentNumber', 'required'],
    [
      {
        evidence: evidence([
          { documentType: 'passport', documentNumber: 'P1', issuingCountry: 'XA' },
        ]),
      },
      'evidence',
      'invalid',
    ],
    [{ evidence: [...evidence(), evidence()[0]] }, 'evidence', 'invalid'],
    [
      {
        evidence: [{ ...evidence()[0], documentNumber: '   ' }, evidence()[1]],
      },
      'evidence.registration_certificate.documentNumber',
      'required',
    ],
    [
      { evidence: [{ ...evidence()[0], issuingCountry: 'ZZ' }, evidence()[1]] },
      'evidence.registration_certificate.issuingCountry',
      'country_unavailable',
    ],
    [
      {
        evidence: [
          { ...evidence()[0], issuedOn: '2026-01-10', expiresOn: '2026-01-10' },
          evidence()[1],
        ],
      },
      'evidence.registration_certificate.expiresOn',
      'date_order',
    ],
    [
      { evidence: [{ ...evidence()[0], issuedOn: '2031-01-10', expiresOn: null }, evidence()[1]] },
      'evidence.registration_certificate.issuedOn',
      'date_in_future',
    ],
    [
      { evidence: [{ ...evidence()[0], issuedOn: '2025-02-31' }, evidence()[1]] },
      'evidence.registration_certificate.issuedOn',
      'date_invalid',
    ],
  ];
  for (const [body, field, code] of cases) {
    const reply = await submit(person, org, body);
    assert.equal(reply.status, 422, `${field}: ${JSON.stringify(reply.body)}`);
    assert.ok(
      problems(reply).some((problem) => problem.field === field && problem.code === code),
      `${field} ${code}: ${JSON.stringify(problems(reply))}`,
    );
  }
  // Made against an older state of the organisation: nothing is submitted.
  const stale = await submit(person, org, { version: 99 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'organisation_changed');
  assert.equal(await count('verification_application', 'organisation_id = $1', [org]), 0);
  assert.equal((await overview(person, org)).organisation.status, 'draft');
  // Without a retry key nothing is even looked at.
  const noKey = await call('POST', route(org, '/applications'), {
    token: person.token,
    body: {
      version: 1,
      declarationAccepted: true,
      declarationLanguage: 'en',
      evidence: evidence(),
    },
  });
  assert.equal(noKey.status, 400);
});

test('the same submission sent twice makes one version; withdrawing returns the organisation to where it was', async () => {
  const { person, org } = await newShipper();
  const retry = key();
  const version = (await overview(person, org)).organisation.version;
  const first = await submit(person, org, { version }, retry);
  // The answer was lost; the same request again, made against the same state.
  const again = await submit(person, org, { version }, retry);
  assert.equal(first.status, 201);
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(await count('verification_application', 'organisation_id = $1', [org]), 1);
  const other = await submit(person, org, { version, declarationLanguage: 'ar' }, retry);
  assert.equal(other.status, 409);
  assert.equal(other.body.code, 'retry_key_conflict');

  const application = (first.body.verification as Overview).applications[0]!;
  const withdrawKey = key();
  const withdraw = (): Promise<Reply> =>
    call('POST', route(org, `/applications/${application.id}/withdraw`), {
      token: person.token,
      key: withdrawKey,
    });
  const gone = await withdraw();
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  const now = gone.body.verification as Overview;
  assert.equal(now.organisation.status, 'draft');
  assert.equal(now.applications[0]!.status, 'withdrawn');
  assert.equal(now.maySubmit, 'initial');
  const entries = (await history(person, org)).length;
  assert.equal((await withdraw()).status, 200, 'the same withdrawal again');
  assert.equal((await history(person, org)).length, entries, 'nothing was recorded twice');
  const late = await call('POST', route(org, `/applications/${application.id}/withdraw`), {
    token: person.token,
    key: key(),
  });
  assert.equal(late.status, 409);
  // Submitted again: a new version; the withdrawn one stays as it was.
  const next = await submitted(person, org);
  assert.equal(next.versionNo, 2);
  assert.deepEqual(
    (await overview(person, org)).applications.map((item) => [item.versionNo, item.status]),
    [
      [2, 'submitted'],
      [1, 'withdrawn'],
    ],
  );
});

// ---------------------------------------------------------------------------------------------
// VER-17: other organisations
// ---------------------------------------------------------------------------------------------
test("another organisation's applications answer exactly like ones that do not exist", async () => {
  const { person, org } = await newShipper();
  const application = await submitted(person, org);
  const stranger = await newShipper();
  const missing = randomUUID();
  for (const [method, path, body] of [
    ['GET', route(org), undefined],
    ['GET', route(missing), undefined],
    [
      'POST',
      route(org, '/applications'),
      { version: 1, declarationAccepted: true, declarationLanguage: 'en', evidence: evidence() },
    ],
    ['POST', route(org, `/applications/${application.id}/withdraw`), undefined],
    // Their own organisation, someone else's application.
    ['POST', route(stranger.org, `/applications/${application.id}/withdraw`), undefined],
  ] as const) {
    const reply = await call(method, path, {
      token: stranger.person.token,
      key: key(),
      ...(body ? { body } : {}),
    });
    assert.equal(reply.status, 404, `${method} ${path}: ${reply.text}`);
    assert.ok(!reply.text.includes('Fixture Shipper'));
  }
  assert.equal((await overview(person, org)).applications[0]!.status, 'submitted');
  // As the API's role, with the stranger's own organisation selected: nothing of the other.
  await asApiRole(
    { tokenHash: hashToken(stranger.person.token), organisationId: stranger.org },
    async (client) => {
      for (const table of [
        'verification_application',
        'verification_evidence',
        'organisation_capability',
      ]) {
        const rows = await client.query(`SELECT 1 FROM trucker.${table}`);
        assert.equal(rows.rowCount, 0, table);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The decision (VER-4, VER-6, VER-9, VER-18)
// ---------------------------------------------------------------------------------------------
test('one independent reviewer verifies; the capability is granted on demonstration evidence; the decision is made once', async () => {
  const { person, org } = await newShipper();
  const reviewer = await newStaff(['reviewer']);
  const application = await submitted(person, org);
  const queue = await call('GET', '/staff/verification', { token: reviewer.token });
  assert.ok(
    (queue.body.applications as { applicationId: string }[]).some(
      (entry) => entry.applicationId === application.id,
    ),
  );
  const seen = await view(reviewer, application.id);
  assert.equal(seen.independence, 'ok');
  assert.equal(seen.competing, false);
  const looks = (await staffAudit(reviewer, 'staff.verification_view')).length;
  await view(reviewer, application.id);
  assert.equal(
    (await staffAudit(reviewer, 'staff.verification_view')).length,
    looks + 1,
    'each look is recorded',
  );

  const reply = await decide(reviewer, application.id, 'verified', {
    note: 'Entries are complete.',
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.outcome, 'decided');
  const now = await overview(person, org);
  assert.equal(now.organisation.status, 'verified');
  assert.equal(now.applications[0]!.status, 'verified');
  assert.equal(now.applications[0]!.decisionReason, 'evidence_accepted');
  assert.equal(now.applications[0]!.decisionNote, 'Entries are complete.');
  assert.deepEqual(
    { status: now.capability?.status, basis: now.capability?.basis },
    { status: 'granted', basis: 'demonstration' },
  );
  // In a test database the check says yes; in production it never would (see below).
  assert.equal(now.mayPublish, true);
  assert.equal(now.maySubmit, 'amendment');
  // The applicant is told that staff decided, not who.
  assert.ok(!JSON.stringify(now).includes(reviewer.id));
  const trail = await history(person, org);
  // (Entries made in the same instant have no order between them, so they are picked out.)
  assert.deepEqual(
    trail
      .filter((entry) => entry.byStaff)
      .map((entry) => `${entry.action} ${entry.actorPersonId}`)
      .sort(),
    ['organisation.updated null', 'verification.decided null'],
  );
  const stored = await owner.query<{ by: string; declared: boolean }>(
    'SELECT decided_by AS by, no_conflict_declared AS declared FROM trucker.verification_application WHERE id = $1',
    [application.id],
  );
  assert.deepEqual(stored.rows[0], { by: reviewer.id, declared: true });
  assert.deepEqual((await staffAudit(reviewer, 'staff.verification_decide')).at(-1), {
    outcome: 'done',
    detail: {
      application: application.id,
      result: 'verified',
      reason: 'evidence_accepted',
      no_conflict_declared: true,
    },
  });

  // The same decision by the same reviewer again (the answer was lost): nothing more happens.
  const entries = trail.length;
  const again = await decide(reviewer, application.id, 'verified', { version: 1 });
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, 'already_decided');
  assert.equal((await history(person, org)).length, entries);
  // Anyone else, or any other decision: it is no longer open.
  const other = await newStaff(['reviewer']);
  for (const [who, decision] of [
    [other, 'verified'],
    [reviewer, 'rejected'],
  ] as const) {
    const late = await decide(who, application.id, decision, { version: 2 });
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.equal(late.body.code, 'application_not_open');
  }
  assert.equal((await overview(person, org)).organisation.status, 'verified');
});

test('a decision sent again without a key is the same request only if actor, version, decision and reason all match', async () => {
  const { person, org } = await newShipper();
  const reviewer = await newStaff(['reviewer']);
  const application = await submitted(person, org);
  const decidedOn = (await view(reviewer, application.id)).application.rowVersion;
  const first = await decide(reviewer, application.id, 'changes_requested', {
    version: decidedOn,
    reason: 'evidence_unclear',
    note: 'The licence number is cut off.',
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.outcome, 'decided');
  const state = async () => ({
    application: (
      await owner.query(
        `SELECT status, decided_by, decided_at, decision_reason, decision_note, row_version
         FROM trucker.verification_application WHERE id = $1`,
        [application.id],
      )
    ).rows[0] as Record<string, unknown>,
    organisation: (await overview(person, org)).organisation,
    capabilities: await count('organisation_capability', 'organisation_id = $1', [org]),
    history: (await history(person, org)).length,
    decisions: await count(
      'staff_audit_entry',
      `action = 'staff.verification_decide' AND detail ->> 'application' = $1`,
      [application.id],
    ),
  });
  const before = await state();

  // The same request again: the first outcome, and nothing changed or recorded.
  const again = await decide(reviewer, application.id, 'changes_requested', {
    version: decidedOn,
    reason: 'evidence_unclear',
    note: 'The licence number is cut off.',
  });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.outcome, 'already_decided');
  // The note is not compared; the note recorded the first time stands.
  const otherNote = await decide(reviewer, application.id, 'changes_requested', {
    version: decidedOn,
    reason: 'evidence_unclear',
    note: 'A different note.',
  });
  assert.equal(otherNote.body.outcome, 'already_decided');
  const noNote = await decide(reviewer, application.id, 'changes_requested', {
    version: decidedOn,
    reason: 'evidence_unclear',
    note: null,
  });
  assert.equal(noNote.body.outcome, 'already_decided');
  assert.deepEqual(await state(), before);

  // Anything changed is a different request, refused, and still nothing changes.
  const changed: [string, Staff, string, Record<string, unknown>][] = [
    [
      'another reason',
      reviewer,
      'changes_requested',
      { version: decidedOn, reason: 'details_incomplete' },
    ],
    ['another decision', reviewer, 'rejected', { version: decidedOn, reason: 'not_eligible' }],
    [
      'another version',
      reviewer,
      'changes_requested',
      { version: decidedOn + 1, reason: 'evidence_unclear' },
    ],
    [
      'an older version',
      reviewer,
      'changes_requested',
      { version: decidedOn - 1 || 99, reason: 'evidence_unclear' },
    ],
    [
      'another reviewer',
      await newStaff(['reviewer']),
      'changes_requested',
      { version: decidedOn, reason: 'evidence_unclear' },
    ],
  ];
  for (const [label, who, decision, input] of changed) {
    const reply = await decide(who, application.id, decision, input);
    assert.equal(reply.status, 409, `${label}: ${reply.text}`);
    assert.equal(reply.body.code, 'application_not_open', label);
  }
  assert.deepEqual(await state(), before);
});

test('the request that raised a competing claim, sent again, reports the claim and changes nothing', async () => {
  const number = `RETRY-${randomBytes(3).toString('hex')}`;
  const holder = await newShipper({ registrationNumber: number });
  const routine = await newStaff(['reviewer']);
  await verified(routine, holder.person, holder.org);
  const claimant = await newShipper({ registrationNumber: number });
  const application = await submitted(claimant.person, claimant.org);
  const raisedOn = (await view(routine, application.id)).application.rowVersion;
  const raised = await decide(routine, application.id, 'verified', { version: raisedOn });
  assert.equal(raised.body.outcome, 'claim_review', raised.text);
  const snapshot = async () => ({
    row: (
      await owner.query(
        `SELECT status, claim_raised_by, claim_raised_at, row_version
         FROM trucker.verification_application WHERE id = $1`,
        [application.id],
      )
    ).rows[0] as Record<string, unknown>,
    history: await count('audit_entry', 'organisation_id = $1', [claimant.org]),
    decisions: await count(
      'staff_audit_entry',
      `action = 'staff.verification_decide' AND detail ->> 'application' = $1`,
      [application.id],
    ),
  });
  const before = await snapshot();
  const again = await decide(routine, application.id, 'verified', { version: raisedOn });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.outcome, 'claim_review');
  assert.deepEqual(await snapshot(), before);
  // Against the version as it is now, the same person is no longer sending the same request,
  // and may not decide the claim: refused, nothing changed.
  const changed = await decide(routine, application.id, 'verified', { version: raisedOn + 1 });
  assert.equal(changed.status, 403, changed.text);
  assert.deepEqual({ ...(await snapshot()), decisions: before.decisions }, before);
});

test('two reviewers deciding one application at the same moment produce one decision', async () => {
  const { person, org } = await newShipper();
  const first = await newStaff(['reviewer']);
  const second = await newStaff(['reviewer']);
  const application = await submitted(person, org);
  const version = (await view(first, application.id)).application.rowVersion;
  const body = (decision: string, reason: string) => ({
    decision,
    reason,
    noConflict: true,
    version,
  });
  const [one, two] = await Promise.all([
    call('POST', `/staff/verification/${application.id}/decision`, {
      token: first.token,
      body: body('verified', 'evidence_accepted'),
    }),
    call('POST', `/staff/verification/${application.id}/decision`, {
      token: second.token,
      body: body('rejected', 'not_eligible'),
    }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409], `${one.text} ${two.text}`);
  const now = await overview(person, org);
  const winner = one.status === 200 ? 'verified' : 'rejected';
  assert.equal(now.applications[0]!.status, winner);
  assert.equal(now.organisation.status, winner);
  assert.equal(
    (await history(person, org)).filter((entry) => entry.action === 'verification.decided').length,
    1,
  );
  assert.equal(now.capability === null, winner === 'rejected');
});

test('only a reviewer decides: not a participant, not other staff, not the API role by any path', async () => {
  const { person, org } = await newShipper();
  const application = await submitted(person, org);
  const body = { decision: 'verified', reason: 'evidence_accepted', noConflict: true, version: 1 };
  // A participant, even the applicant.
  for (const path of ['/staff/verification', `/staff/verification/${application.id}`]) {
    assert.equal((await call('GET', path, { token: person.token })).status, 401, path);
  }
  assert.equal(
    (
      await call('POST', `/staff/verification/${application.id}/decision`, {
        token: person.token,
        body,
      })
    ).status,
    401,
  );
  // Staff without the reviewer privilege, administrators included. Each attempt is recorded.
  const admin = await newStaff(['staff_admin']);
  for (const [method, path] of [
    ['GET', '/staff/verification'],
    ['GET', `/staff/verification/${application.id}`],
    ['POST', `/staff/verification/${application.id}/decision`],
  ] as const) {
    const reply = await call(method, path, {
      token: admin.token,
      ...(method === 'POST' ? { body } : {}),
    });
    assert.equal(reply.status, 403, `${method} ${path}: ${reply.text}`);
  }
  const refusals = await owner.query(
    `SELECT 1 FROM trucker.staff_audit_entry
     WHERE actor_staff_id = $1 AND outcome = 'refused' AND detail ->> 'reason' = 'privilege_not_held'`,
    [admin.id],
  );
  assert.equal(refusals.rowCount, 3);
  // The API's role, directly.
  const context = { tokenHash: hashToken(person.token), organisationId: org };
  for (const statement of [
    `UPDATE trucker.verification_application SET status = 'verified'`,
    `INSERT INTO trucker.organisation_capability (organisation_id, capability, status, basis, granted_application, granted_at)
       VALUES ('${org}', 'ship', 'granted', 'demonstration', '${application.id}', now())`,
    `UPDATE trucker.organisation SET status = 'verified', version = version + 1 WHERE id = '${org}'`,
    `DELETE FROM trucker.verification_evidence`,
    `INSERT INTO trucker.evidence_requirement (country_code, capability, document_type, name_en, name_ar, name_ur)
       VALUES ('XA', 'ship', 'anything', 'x', 'x', 'x')`,
    `SELECT * FROM trucker.verification_retry_key`,
    `SELECT decided_by FROM trucker.verification_application`,
    `SELECT trucker.reviewer_independence(gen_random_uuid(), '${org}', NULL, true)`,
    `SELECT trucker.acting_staff()`,
  ]) {
    await refused(
      () => asApiRole(context, (client) => client.query(statement)),
      /permission denied/i,
    );
  }
  // Passing as staff through the setting the staff functions use changes nothing: the API's
  // role still has no right to change the state, and an invented staff token is nobody.
  await asApiRole(context, async (client) => {
    await client.query(`SELECT set_config('trucker.acting_staff', $1, true)`, [admin.id]);
    const invented = await client.query<{ status: string }>(
      `SELECT status FROM trucker.staff_verification_decide($1, $2, 1, 'verified', 'evidence_accepted', NULL, true, NULL)`,
      ['f'.repeat(64), application.id],
    );
    assert.equal(invented.rows[0]!.status, 'unauthorized');
    const withParticipant = await client.query<{ status: string }>(
      `SELECT status FROM trucker.staff_verification_decide($1, $2, 1, 'verified', 'evidence_accepted', NULL, true, NULL)`,
      [hashToken(person.token), application.id],
    );
    assert.equal(withParticipant.rows[0]!.status, 'unauthorized');
  });
  const now = await overview(person, org);
  assert.equal(now.applications[0]!.status, 'submitted');
  assert.equal(now.capability, null);
});

// ---------------------------------------------------------------------------------------------
// VER-5: independence
// ---------------------------------------------------------------------------------------------
test('a reviewer who is not declared, is connected, or does not declare no connection is refused, and it is recorded', async () => {
  const creator = await newPerson();
  const org = await newOrganisation(creator);
  const application = await submitted(creator, org);
  // A former member: the membership has ended, and still counts.
  const former = await newPerson();
  await owner.query(
    `INSERT INTO trucker.membership (organisation_id, person_id, role, created_at, ended_at)
     VALUES ($1, $2, 'admin', $3, $3)`,
    [org, former.personId, clock()],
  );
  const cases: [Staff, Record<string, unknown>, string][] = [
    [await newStaff(['reviewer'], { link: 'not_declared' }), {}, 'link_not_declared'],
    [await newStaff(['reviewer'], { link: 'declared', phone: creator.phone }), {}, 'connected'],
    [await newStaff(['reviewer'], { link: 'declared', phone: former.phone }), {}, 'connected'],
    [await newStaff(['reviewer']), { noConflict: false }, 'conflict_not_declared'],
  ];
  for (const [reviewer, input, reason] of cases) {
    const reply = await decide(reviewer, application.id, 'verified', input);
    assert.equal(reply.status, 409, `${reason}: ${reply.text}`);
    assert.equal(reply.body.code, 'reviewer_not_independent');
    assert.equal((reply.body.details as { reason: string }).reason, reason);
    assert.deepEqual((await staffAudit(reviewer, 'staff.verification_decide')).at(-1), {
      outcome: 'refused',
      detail: { application: application.id, reason },
    });
  }
  // The same refusal for a rejection: independence is asked for whatever the decision.
  const rejecting = await decide(cases[0]![0], application.id, 'rejected');
  assert.equal(rejecting.status, 409);
  assert.equal((await overview(creator, org)).applications[0]!.status, 'submitted');
  // A reviewer with a declared participant account that has nothing to do with it may decide.
  const unrelated = await newPerson();
  const fine = await newStaff(['reviewer'], { link: 'declared', phone: unrelated.phone });
  assert.equal((await decide(fine, application.id, 'changes_requested')).status, 200);
});

// ---------------------------------------------------------------------------------------------
// VD-4: resubmission
// ---------------------------------------------------------------------------------------------
test('after changes requested or rejection the applicant corrects and submits a new version; earlier ones stay as they were', async () => {
  const { person, org } = await newShipper();
  const reviewer = await newStaff(['reviewer']);
  const first = await submitted(person, org);
  const asked = await decide(reviewer, first.id, 'changes_requested', {
    reason: 'other',
    note: 'The licence number looks incomplete.',
  });
  assert.equal(asked.status, 200, asked.text);
  // "Other" needs its note.
  let now = await overview(person, org);
  assert.equal(now.organisation.status, 'changes_requested');
  assert.equal(now.maySubmit, 'initial');
  assert.equal(now.capability, null);
  assert.equal(now.mayPublish, false);
  // The organisation can be corrected again.
  const edit = await call('PATCH', `/organisations/${org}`, {
    token: person.token,
    body: {
      legalName: 'Fixture Shipper Corrected (fictional)',
      countryCode: 'XA',
      registrationNumber: now.organisation.registrationNumber,
      version: now.organisation.version,
    },
  });
  assert.equal(edit.status, 200, edit.text);
  const second = await submitted(person, org, {
    evidence: [evidence()[0], { ...evidence()[1], documentNumber: 'LIC-0002-FULL' }],
  });
  assert.equal(second.versionNo, 2);
  assert.equal(second.legalName, 'Fixture Shipper Corrected (fictional)');
  const refusedTwice = await decide(reviewer, second.id, 'rejected');
  assert.equal(refusedTwice.status, 200);
  now = await overview(person, org);
  assert.equal(now.organisation.status, 'rejected');
  assert.equal(now.maySubmit, 'initial');
  const third = await submitted(person, org);
  assert.equal(third.versionNo, 3);
  // Every earlier version is still exactly what was submitted and decided.
  const versions = (await overview(person, org)).applications;
  assert.deepEqual(
    versions.map((item) => [item.versionNo, item.status, item.legalName, item.decisionReason]),
    [
      [3, 'submitted', 'Fixture Shipper Corrected (fictional)', null],
      [2, 'rejected', 'Fixture Shipper Corrected (fictional)', 'not_eligible'],
      [1, 'changes_requested', 'Fixture Shipper (fictional)', 'other'],
    ],
  );
  assert.equal(versions[2]!.decisionNote, 'The licence number looks incomplete.');
  assert.equal(
    (versions[1]!.evidence[1] as { documentNumber: string }).documentNumber,
    'LIC-0002-FULL',
  );
  assert.equal((versions[2]!.evidence[1] as { documentNumber: string }).documentNumber, 'LIC-0002');
  // The reviewer sees the earlier versions too.
  assert.equal((await view(reviewer, third.id)).earlier.length, 2);
  // A reason from another decision's list, or "other" without a note, is not a decision.
  for (const input of [
    { reason: 'evidence_accepted' },
    { reason: 'other' },
    { reason: 'other', note: '   ' },
  ]) {
    const bad = await decide(reviewer, third.id, 'rejected', input);
    assert.equal(bad.status, 422, JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------------------------
// VD-3, E-1: competing claims
// ---------------------------------------------------------------------------------------------
test('a competing registration claim is not verified as routine: it goes to a different, independent administrator-reviewer, and exposes nothing', async () => {
  const number = `CLAIM ${randomBytes(3).toString('hex')}`;
  const holder = await newShipper({
    registrationNumber: number,
    legalName: 'Holder Of The Number',
  });
  const routine = await newStaff(['reviewer']);
  await verified(routine, holder.person, holder.org);
  const holderBefore = await overview(holder.person, holder.org);

  // The same number, written differently, for another organisation of another person.
  const claimant = await newShipper({
    registrationNumber: ` ${number.toLowerCase().replace(' ', '  ')} `,
  });
  const application = await submitted(claimant.person, claimant.org);
  const seen = await view(routine, application.id);
  assert.equal(seen.competing, true);
  assert.ok(!JSON.stringify(seen).includes('Holder Of The Number'));
  assert.ok(!JSON.stringify(seen).includes(holder.org));

  const attempt = await decide(routine, application.id, 'verified');
  assert.equal(attempt.status, 200, attempt.text);
  assert.equal(attempt.body.outcome, 'claim_review');
  // The applicant learns only that it needs further review.
  const told = await call('GET', route(claimant.org), { token: claimant.person.token });
  const claimantNow = told.body.verification as Overview;
  assert.equal(claimantNow.applications[0]!.status, 'claim_review');
  assert.equal(claimantNow.organisation.status, 'submitted');
  assert.equal(claimantNow.capability, null);
  for (const secret of ['Holder Of The Number', holder.org, holder.person.personId])
    assert.ok(!told.text.includes(secret), `the applicant is shown ${secret}`);
  // The other organisation is unchanged and sees nothing.
  assert.deepEqual(await overview(holder.person, holder.org), holderBefore);
  assert.ok(
    !(await history(holder.person, holder.org)).some((entry) => entry.action.includes('claim')),
  );

  // Who may decide it: not the one who raised it, not a reviewer without staff_admin, not an
  // administrator without reviewer, not one who is not independent.
  // The one who raised it holds reviewer only, which is not enough for a claim.
  assert.equal((await decide(routine, application.id, 'verified')).status, 403);
  // Made an administrator as well, they are still the one who raised it.
  await owner.query(
    `INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at) VALUES ($1, 'staff_admin', NULL, $2)`,
    [routine.id, clock()],
  );
  for (const decision of ['verified', 'rejected']) {
    const raised = await decide(routine, application.id, decision);
    assert.equal(raised.status, 409, raised.text);
    assert.equal(raised.body.code, 'different_person_required');
  }
  assert.equal(
    (await decide(await newStaff(['reviewer']), application.id, 'verified')).status,
    403,
  );
  assert.equal(
    (await decide(await newStaff(['staff_admin']), application.id, 'verified')).status,
    403,
  );
  const connected = await newStaff(['staff_admin', 'reviewer'], {
    link: 'declared',
    phone: claimant.person.phone,
  });
  assert.equal(
    (await decide(connected, application.id, 'verified')).body.code,
    'reviewer_not_independent',
  );
  assert.equal(
    (await overview(claimant.person, claimant.org)).applications[0]!.status,
    'claim_review',
  );

  const senior = await newStaff(['staff_admin', 'reviewer']);
  const decided = await decide(senior, application.id, 'rejected', { reason: 'claim_not_upheld' });
  assert.equal(decided.status, 200, decided.text);
  assert.equal(decided.body.outcome, 'decided');
  const after = await overview(claimant.person, claimant.org);
  assert.equal(after.organisation.status, 'rejected');
  assert.equal(after.applications[0]!.decisionReason, 'claim_not_upheld');
  assert.deepEqual(
    await overview(holder.person, holder.org),
    holderBefore,
    'the holder is untouched',
  );

  // Upheld instead: the claimant is verified, and still nothing happens to the holder.
  const second = await submitted(claimant.person, claimant.org);
  const flagged = await decide(await newStaff(['reviewer']), second.id, 'verified');
  assert.equal(flagged.body.outcome, 'claim_review');
  const upheld = await decide(senior, second.id, 'verified');
  assert.equal(upheld.body.outcome, 'decided');
  assert.equal((await overview(claimant.person, claimant.org)).organisation.status, 'verified');
  assert.deepEqual(await overview(holder.person, holder.org), holderBefore);
});

test('two organisations with one registration number cannot both be verified as routine at the same moment', async () => {
  const number = `RACE-${randomBytes(3).toString('hex')}`;
  const one = await newShipper({ registrationNumber: number });
  const two = await newShipper({ registrationNumber: number });
  const first = await newStaff(['reviewer']);
  const second = await newStaff(['reviewer']);
  const a = await submitted(one.person, one.org);
  const b = await submitted(two.person, two.org);
  await fresh(first);
  await fresh(second);
  const body = { decision: 'verified', reason: 'evidence_accepted', noConflict: true, version: 1 };
  const replies = await Promise.all([
    call('POST', `/staff/verification/${a.id}/decision`, { token: first.token, body }),
    call('POST', `/staff/verification/${b.id}/decision`, { token: second.token, body }),
  ]);
  assert.deepEqual(
    replies.map((reply) => reply.body.outcome).sort(),
    ['claim_review', 'decided'],
    replies.map((reply) => reply.text).join(' '),
  );
  const states = [
    (await overview(one.person, one.org)).organisation.status,
    (await overview(two.person, two.org)).organisation.status,
  ].sort();
  assert.deepEqual(states, ['submitted', 'verified']);
});

// ---------------------------------------------------------------------------------------------
// VD-5, E-2: amendments
// ---------------------------------------------------------------------------------------------
test('a verified legal identity changes only through a reviewed amendment; until approval the approved identity stays in force', async () => {
  const { person, org } = await newShipper({ legalName: 'Approved Name (fictional)' });
  const reviewer = await newStaff(['reviewer']);
  await verified(reviewer, person, org);
  const approved = (await overview(person, org)).organisation;
  // Directly: refused by the API and, for the API's role, by the database itself.
  const direct = await call('PATCH', `/organisations/${org}`, {
    token: person.token,
    body: {
      legalName: 'Quietly Renamed',
      countryCode: 'XA',
      registrationNumber: approved.registrationNumber,
      version: approved.version,
    },
  });
  assert.equal(direct.status, 409);
  assert.equal(direct.body.code, 'identity_needs_review');
  for (const column of ['legal_name', 'registration_number']) {
    await refused(
      () =>
        asApiRole({ tokenHash: hashToken(person.token), organisationId: org }, (client) =>
          client.query(
            `UPDATE trucker.organisation SET ${column} = 'Changed', version = version + 1 WHERE id = $1`,
            [org],
          ),
        ),
      /only through an approved amendment/,
    );
  }
  // Everything else can still change, without a review.
  const address = await call('PATCH', `/organisations/${org}`, {
    token: person.token,
    body: {
      legalName: approved.legalName,
      countryCode: 'XA',
      registrationNumber: approved.registrationNumber,
      address: 'New Street 5',
      contactName: 'New Contact',
      version: approved.version,
    },
  });
  assert.equal(address.status, 200, address.text);
  assert.equal((await overview(person, org)).organisation.status, 'verified');

  // An amendment that changes nothing is not one.
  const same = await submit(person, org, {
    proposed: {
      legalName: approved.legalName,
      countryCode: 'XA',
      registrationNumber: approved.registrationNumber,
    },
  });
  assert.equal(same.status, 422);
  assert.equal(problems(same)[0]!.code, 'nothing_changed');
  const proposed = {
    legalName: 'Proposed Name (fictional)',
    countryCode: 'XA',
    registrationNumber: `${approved.registrationNumber}-N`,
  };
  const amendment = await submitted(person, org, { proposed });
  assert.equal(amendment.kind, 'amendment');
  assert.equal(amendment.legalName, 'Proposed Name (fictional)');
  // Under review: the approved identity is the organisation's identity, and its rights stand.
  let now = await overview(person, org);
  assert.equal(now.organisation.status, 'verified');
  assert.equal(now.organisation.legalName, 'Approved Name (fictional)');
  assert.equal(now.organisation.registrationNumber, approved.registrationNumber);
  assert.equal(now.mayPublish, true);
  assert.equal(now.capability?.status, 'granted');
  const shown = await call('GET', `/organisations/${org}`, { token: person.token });
  assert.equal(
    (shown.body.organisation as { legalName: string }).legalName,
    'Approved Name (fictional)',
  );

  // Refused: nothing about the organisation changes.
  assert.equal((await decide(reviewer, amendment.id, 'rejected')).status, 200);
  now = await overview(person, org);
  assert.equal(now.organisation.status, 'verified');
  assert.equal(now.organisation.legalName, 'Approved Name (fictional)');
  assert.equal(now.capability?.status, 'granted');
  assert.equal(now.mayPublish, true);
  assert.equal(now.maySubmit, 'amendment');

  // Approved: the new identity replaces the old one in the same step.
  const second = await submitted(person, org, { proposed });
  assert.equal((await decide(reviewer, second.id, 'verified')).body.outcome, 'decided');
  now = await overview(person, org);
  assert.equal(now.organisation.status, 'verified');
  assert.equal(now.organisation.legalName, 'Proposed Name (fictional)');
  assert.equal(now.organisation.registrationNumber, `${approved.registrationNumber}-N`);
  assert.equal(now.capability?.status, 'granted');
  const change = (await call('GET', `/organisations/${org}/history`, { token: person.token })).body
    .entries as {
    action: string;
    byStaff: boolean;
    before: { legalName: string };
    after: { legalName: string };
  }[];
  const renamed = change.filter(
    (entry) =>
      entry.action === 'organisation.updated' && entry.before.legalName !== entry.after.legalName,
  );
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0]!.byStaff, true);
});

// ---------------------------------------------------------------------------------------------
// E-3: withdrawing a verification
// ---------------------------------------------------------------------------------------------
test('a mistaken verification is withdrawn by a different administrator: status and capability together, history kept, nothing else touched', async () => {
  const { person, org } = await newShipper();
  const reviewer = await newStaff(['reviewer', 'staff_admin']);
  const application = await verified(reviewer, person, org);
  // Other work of the organisation: a shipment draft.
  const draft = await call('POST', `/organisations/${org}/shipments`, {
    token: person.token,
    key: key(),
    body: { cargoDescription: 'Boxed tiles (fictional)' },
  });
  assert.equal(draft.status, 201, draft.text);
  // An amendment is under review when the verification is withdrawn.
  const pending = await submitted(person, org, {
    proposed: { legalName: 'Pending Name', countryCode: 'XA', registrationNumber: 'PEND-1' },
  });
  const revoke = async (staff: Staff, input: Record<string, unknown> = {}): Promise<Reply> => {
    await fresh(staff);
    return call('POST', `/staff/verification/organisations/${org}/revoke`, {
      token: staff.token,
      body: { capability: 'ship', reason: 'verified_in_error', noConflict: true, ...input },
    });
  };
  // Not the one who gave it, though an administrator. Not a non-administrator. Not someone
  // connected, or who does not say they are unconnected.
  const own = await revoke(reviewer);
  assert.equal(own.status, 409);
  assert.equal(own.body.code, 'different_person_required');
  assert.equal((await revoke(await newStaff(['reviewer']))).status, 403);
  const connected = await newStaff(['staff_admin'], { link: 'declared', phone: person.phone });
  assert.equal((await revoke(connected)).body.code, 'reviewer_not_independent');
  const other = await newStaff(['staff_admin']);
  assert.equal((await revoke(other, { noConflict: false })).body.code, 'reviewer_not_independent');
  assert.equal((await revoke(other, { reason: 'other' })).status, 422);
  assert.equal((await overview(person, org)).organisation.status, 'verified');

  const before = await overview(person, org);
  const done = await revoke(other, { note: 'The licence entry belonged to another company.' });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.outcome, 'revoked');
  const now = await overview(person, org);
  assert.equal(now.organisation.status, 'verification_withdrawn');
  assert.deepEqual(
    { status: now.capability?.status, reason: now.capability?.revokeReason },
    { status: 'revoked', reason: 'verified_in_error' },
  );
  assert.equal(now.mayPublish, false, 'new commercial actions are blocked from this moment');
  // History is kept: every version, entry and decision, and the withdrawal itself.
  assert.deepEqual(
    now.applications.map((item) => [item.versionNo, item.status, item.evidence.length]),
    [
      [2, 'withdrawn', 2],
      [1, 'verified', 2],
    ],
  );
  assert.equal(now.applications[1]!.id, application.id);
  assert.equal(now.applications[0]!.id, pending.id);
  assert.deepEqual(now.applications[1], before.applications[1]);
  assert.ok((await history(person, org)).some((entry) => entry.action === 'verification.revoked'));
  // Existing work is not cancelled.
  const drafts = await call('GET', `/organisations/${org}/shipments`, { token: person.token });
  assert.equal((drafts.body.shipments as { status: string }[])[0]!.status, 'draft');
  // The same withdrawal again changes nothing; a different one says it is not verified.
  const entries = (await history(person, org)).length;
  assert.equal((await revoke(other)).body.outcome, 'already_revoked');
  assert.equal((await history(person, org)).length, entries);
  assert.equal(
    (await revoke(await newStaff(['staff_admin']))).body.code,
    'organisation_not_verified',
  );
  // The applicant may apply again.
  assert.equal(now.maySubmit, 'initial');
  assert.equal((await submitted(person, org)).versionNo, 3);
});

// ---------------------------------------------------------------------------------------------
// VER-10: the publication check
// ---------------------------------------------------------------------------------------------
test('the publication check says yes only for verified with the capability, and never in production on demonstration evidence', async () => {
  const { person, org } = await newShipper();
  const reviewer = await newStaff(['reviewer']);
  const says = async (): Promise<boolean> => (await overview(person, org)).mayPublish;
  assert.equal(await says(), false, 'draft');
  const first = await submitted(person, org);
  assert.equal(await says(), false, 'submitted');
  await decide(reviewer, first.id, 'changes_requested');
  assert.equal(await says(), false, 'changes requested');
  const second = await submitted(person, org);
  await decide(reviewer, second.id, 'rejected');
  assert.equal(await says(), false, 'rejected');
  const third = await submitted(person, org);
  await decide(reviewer, third.id, 'verified');
  assert.equal(await says(), true, 'verified, in a test database');
  // It answers for the organisation the request selected, and for nothing else.
  const stranger = await newShipper();
  const elsewhere = await asApiRole(
    { tokenHash: hashToken(stranger.person.token), organisationId: org },
    async (client) =>
      (await client.query<{ yes: boolean }>('SELECT trucker.organisation_may_publish() AS yes'))
        .rows[0]!.yes,
  );
  assert.equal(elsewhere, false);
  // Verified without the capability is not enough.
  await owner.query(`DELETE FROM trucker.organisation_capability WHERE organisation_id = $1`, [
    org,
  ]);
  assert.equal(await says(), false, 'verified without the capability');

  // A production database: the same rows, and the answer is no, because the capability rests
  // on demonstration evidence.
  for (const [mark, expected] of [
    ['production', false],
    ['unmarked', true],
  ] as const) {
    const scratch = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: scratch.url });
    try {
      await migrateUp(pool, defaultMigrationsDir());
      const tokenHash = 'a'.repeat(64);
      await pool.query(`ALTER TABLE trucker.evidence_requirement DISABLE TRIGGER USER`);
      await pool.query(`
        INSERT INTO trucker.country (code, name_en, name_ar, name_ur) VALUES ('OM', 'Oman', 'x', 'x');
        INSERT INTO trucker.person (id, phone_e164, created_at) VALUES ('00000000-0000-4000-8000-000000000001', '+96890000000', now());
        INSERT INTO trucker.session (id, person_id, token_hash, created_at, last_used_at, absolute_expires_at)
          VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '${tokenHash}', now(), now(), now() + interval '1 hour');
        INSERT INTO trucker.organisation (id, status, legal_name, country_code, registration_number, created_by, created_at, updated_at)
          VALUES ('00000000-0000-4000-8000-000000000003', 'verified', 'Scratch', 'OM', 'S-1', '00000000-0000-4000-8000-000000000001', now(), now());
        INSERT INTO trucker.membership (organisation_id, person_id, role, created_at)
          VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'admin', now());
        INSERT INTO trucker.staff_account (id, email, display_name, status, enrolled_at, password_hash, totp_secret, created_at, updated_at)
          VALUES ('00000000-0000-4000-8000-000000000004', 's@example.test', 'S', 'active', now(), 'x', '\\x00', now(), now());
        INSERT INTO trucker.verification_application (id, organisation_id, version_no, kind, status, legal_name, country_code, registration_number, capability, previous_status, submitted_by, submitted_at, declaration_kind, declaration_version, declaration_language, decided_by, decided_at, decision_reason, no_conflict_declared, decided_on_version)
          VALUES ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000003', 1, 'initial', 'verified', 'Scratch', 'OM', 'S-1', 'ship', 'draft', '00000000-0000-4000-8000-000000000001', now(), 'demonstration', 'd', 'en', '00000000-0000-4000-8000-000000000004', now(), 'evidence_accepted', true, 1);
        INSERT INTO trucker.organisation_capability (organisation_id, capability, status, basis, granted_application, granted_at)
          VALUES ('00000000-0000-4000-8000-000000000003', 'ship', 'granted', 'demonstration', '00000000-0000-4000-8000-000000000005', now());
      `);
      if (mark === 'production')
        await pool.query(`UPDATE trucker.environment SET kind = 'production'`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('trucker.session_token_hash', $1, true), set_config('trucker.organisation_id', $2, true)`,
          [tokenHash, '00000000-0000-4000-8000-000000000003'],
        );
        const answer = await client.query<{ yes: boolean }>(
          'SELECT trucker.organisation_may_publish() AS yes',
        );
        assert.equal(answer.rows[0]!.yes, expected, mark);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    } finally {
      await pool.end();
      await scratch.drop();
    }
  }
});

// ---------------------------------------------------------------------------------------------
// VER-16: time and sessions
// ---------------------------------------------------------------------------------------------
test('a decision that waited behind a lock is judged by the time it acts: an ended staff session decides nothing', async () => {
  const { person, org } = await newShipper();
  const reviewer = await newStaff(['reviewer']);
  const application = await submitted(person, org);
  await fresh(reviewer);
  const waited = await whileBlocked(
    ['SELECT 1 FROM trucker.verification_application WHERE id = $1 FOR UPDATE', [application.id]],
    () =>
      call('POST', `/staff/verification/${application.id}/decision`, {
        token: reviewer.token,
        body: { decision: 'verified', reason: 'evidence_accepted', noConflict: true, version: 1 },
      }),
    D.staff_session_idle_minutes * 60 + 1,
  );
  assert.equal(waited.status, 401, waited.text);
  // The applicant's own session has ended meanwhile too; a new one shows nothing was decided.
  const again = await newPerson(person.phone);
  const now = await overview(again, org);
  assert.equal(now.applications[0]!.status, 'submitted');
  assert.equal(now.capability, null);
  // A decision made afterwards is stamped with the time it was made.
  const reply = await decide(reviewer, application.id, 'verified');
  assert.equal(reply.status, 200, reply.text);
  const stamped = await owner.query<{ at: Date }>(
    'SELECT decided_at AS at FROM trucker.verification_application WHERE id = $1',
    [application.id],
  );
  assert.equal(stamped.rows[0]!.at.toISOString(), clock().toISOString());
  // A participant whose session ended submits nothing.
  const lapsed = await newShipper();
  await advance(D.session_absolute_hours * 3600 + 1);
  const late = await call('POST', route(lapsed.org, '/applications'), {
    token: lapsed.person.token,
    key: key(),
    body: {
      version: 1,
      declarationAccepted: true,
      declarationLanguage: 'en',
      evidence: evidence(),
    },
  });
  assert.equal(late.status, 401);
  assert.equal(await count('verification_application', 'organisation_id = $1', [lapsed.org]), 0);
});

// ---------------------------------------------------------------------------------------------
// VER-20
// ---------------------------------------------------------------------------------------------
test('the routes are exactly these, and none publishes, quotes, books or takes payment', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const routes = (file: string): string[] =>
    [
      ...readFileSync(path.resolve(here, '../../src', file), 'utf8').matchAll(
        /@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)/g,
      ),
    ]
      .map((match) => `${match[1]} ${match[2] ?? ''}`.trim())
      .sort();
  assert.deepEqual(routes('verification/verification.controller.ts'), [
    'Get',
    'Post applications',
    'Post applications/:id/withdraw',
  ]);
  assert.deepEqual(
    routes('staff/staff.controller.ts').filter((entry) => entry.includes('verification')),
    [
      'Get verification',
      'Get verification/:id',
      'Post verification/:id/decision',
      'Post verification/organisations/:organisationId/revoke',
    ],
  );
  const { person, org } = await newShipper();
  for (const action of [
    'publish',
    'publication',
    'quotations',
    'offers',
    'book',
    'pay',
    'approve',
  ]) {
    const reply = await call('POST', route(org, `/${action}`), {
      token: person.token,
      key: key(),
      body: {},
    });
    assert.equal(reply.status, 404, action);
  }
});
