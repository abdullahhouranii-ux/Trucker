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
import { blockedRequests } from '../testing/blocked-request.js';
import { createTestClock } from '../testing/test-clock.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';

// Shipment publication (slice 10). Real PostgreSQL, the API connected as its restricted role.
// Organisations are verified through slice 9's own routes, by staff accounts put in place
// directly by the migration role. The lead time is lowered here so that a deadline can pass
// without every session ending; one test runs with the default of 120 minutes.

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
  await owner.query('UPDATE trucker.security_setting SET publication_lead_minutes = 5');
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
// Shipments
// ---------------------------------------------------------------------------------------------
const ZONE_HOURS: Record<string, number> = { XA: 4, XB: 3 };
/** A wall-clock time at a place in a fictional country, some hours from the test clock. */
const local = (hours: number, country = 'XA'): string =>
  new Date(clock().getTime() + (hours + (ZONE_HOURS[country] ?? 0)) * 3_600_000)
    .toISOString()
    .slice(0, 16);
const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  shipperReference: 'REF-PRIVATE-4471',
  cargoDescription: 'Ceramic tiles in crates',
  grossWeightKg: '12000',
  pieces: '24',
  packaging: 'Wooden crates',
  equipmentNeeded: 'Straps',
  pickup: {
    address: 'Warehouse 9, Private Street',
    countryCode: 'XA',
    timeZone: 'Etc/GMT-4',
    accessNotes: 'Gate code 5512',
    from: { local: local(48) },
    until: { local: local(50) },
  },
  delivery: {
    address: 'Depot 3, Hidden Road',
    countryCode: 'XB',
    timeZone: 'Etc/GMT-3',
    accessNotes: 'Ask for the night guard on 99977000',
    from: { local: local(54, 'XB') },
    until: { local: local(58, 'XB') },
  },
  ...overrides,
});
const details = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  cargoCategory: 'general_dry',
  equipmentType: 'curtain_side',
  dangerousGoods: false,
  pickupArea: 'North industrial area',
  deliveryArea: 'Port district',
  quotationDeadline: { local: local(24) },
  ...overrides,
});
const shipments = (org: string, rest = ''): string => `/organisations/${org}/shipments${rest}`;
interface Shipment {
  id: string;
  status: string;
  version: number;
  pickup: { address: string | null };
  publication: {
    publishedVersion: number | null;
    suspendedFor: string[];
    quotationDeadline: { at: string | null };
    copiedFrom: string | null;
    pickupArea: string | null;
  };
}
async function draft(person: Person, org: string, body = content()): Promise<Shipment> {
  const reply = await call('POST', shipments(org), { token: person.token, key: key(), body });
  assert.equal(reply.status, 201, reply.text);
  return reply.body.shipment as Shipment;
}
async function get(person: Person, org: string, id: string): Promise<Shipment> {
  const reply = await call('GET', shipments(org, `/${id}`), { token: person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.shipment as Shipment;
}
const act = (
  person: Person,
  org: string,
  id: string,
  action: string,
  body: Record<string, unknown> | undefined,
  retry = key(),
): Promise<Reply> =>
  call('POST', shipments(org, `/${id}/${action}`), {
    token: person.token,
    key: retry,
    ...(body ? { body } : {}),
  });
async function published(person: Person, org: string, over: Record<string, unknown> = {}) {
  const made = await draft(person, org);
  const reply = await act(person, org, made.id, 'publish', {
    version: made.version,
    ...details(over),
  });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.shipment as Shipment;
}
const change = (
  person: Person,
  org: string,
  shipment: Shipment,
  body: Record<string, unknown> = content(),
  publication: Record<string, unknown> = details(),
  retry = key(),
): Promise<Reply> =>
  act(
    person,
    org,
    shipment.id,
    'published-changes',
    { ...body, publication, version: shipment.version },
    retry,
  );
const entries = (id: string, action: string): Promise<number> =>
  count('audit_entry', 'record_id = $1 AND action = $2', [id, action]);
const codes = (reply: Reply): string[] =>
  problems(reply).map((problem) => `${problem.field}:${problem.code}`);

/** A shipper organisation verified through slice 9's own routes. */
let reviewerForAll: Staff | undefined;
async function verifiedShipper(details?: Parameters<typeof newOrganisation>[1]) {
  const { person, org } = await newShipper(details);
  reviewerForAll = await fresh(reviewerForAll ?? (await newStaff(['reviewer'])));
  await verified(reviewerForAll, person, org);
  return { person, org };
}
/** A session for the same person again, after the clock has moved past the idle limit. */
const again = (person: Person): Promise<Person> => newPerson(person.phone);

// ---------------------------------------------------------------------------------------------
// PUB-15: catalogues
// ---------------------------------------------------------------------------------------------
test('after the migrations no category or equipment type exists, and none can be added outside a marked database', async () => {
  const scratch = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: scratch.url });
  try {
    await migrateUp(pool, defaultMigrationsDir());
    for (const table of [
      'cargo_category',
      'equipment_type',
      'shipment_publication_version',
      'shipment_suspension',
    ])
      assert.equal((await pool.query(`SELECT 1 FROM trucker.${table}`)).rowCount, 0, table);
    for (const table of ['cargo_category', 'equipment_type'])
      await refused(
        () =>
          pool.query(
            `INSERT INTO trucker.${table} (code, name_en, name_ar, name_ur) VALUES ('anything', 'x', 'x', 'x')`,
          ),
        /fictional and allowed only in a database marked/,
      );
    // Marked for tests, an entry may be added; then the database cannot become anything else.
    await markEnvironment(pool, 'test');
    await pool.query(
      `INSERT INTO trucker.equipment_type (code, name_en, name_ar, name_ur) VALUES ('flatbed', 'x', 'x', 'x')`,
    );
    await refused(
      () => pool.query(`UPDATE trucker.environment SET kind = 'production'`),
      /holds fictional catalogue entries/,
    );
  } finally {
    await pool.end();
    await scratch.drop();
  }
  // The catalogues the shipper is offered: never the excluded category.
  const { person, org } = await newShipper();
  const offered = await call('GET', `/organisations/${org}/shipment-catalogues`, {
    token: person.token,
  });
  assert.deepEqual(
    (offered.body.cargoCategories as { code: string }[]).map((entry) => entry.code),
    ['general_dry', 'palletised'],
  );
  assert.equal((offered.body.equipmentTypes as unknown[]).length, 3);
});

// ---------------------------------------------------------------------------------------------
// PUB-1 to PUB-6: publishing
// ---------------------------------------------------------------------------------------------
test('a verified shipper publishes a complete draft: one version, one history entry, nothing else changes', async () => {
  const { person, org } = await verifiedShipper();
  const made = await draft(person, org);
  const reply = await act(person, org, made.id, 'publish', { version: made.version, ...details() });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.body.outcome, 'published');
  const shipment = reply.body.shipment as Shipment;
  assert.equal(shipment.status, 'published');
  assert.equal(shipment.version, made.version + 1);
  assert.equal(shipment.publication.publishedVersion, 1);
  assert.equal(shipment.publication.pickupArea, 'North industrial area');
  assert.equal(await entries(made.id, 'shipment.published'), 1);
  assert.equal(await count('shipment_publication_version', 'shipment_id = $1', [made.id]), 1);
  // Listed as published.
  const listed = await call('GET', shipments(org, '?status=published'), { token: person.token });
  assert.deepEqual(
    (listed.body.shipments as { id: string; publishedVersion: number }[]).map((item) => [
      item.id,
      item.publishedVersion,
    ]),
    [[made.id, 1]],
  );
  // The draft functions no longer act on it.
  const patch = await call('PATCH', shipments(org, `/${made.id}`), {
    token: person.token,
    key: key(),
    body: { ...content(), version: shipment.version },
  });
  assert.equal(patch.status, 409, patch.text);
  assert.equal(patch.body.code, 'shipment_not_draft');
  const discard = await act(person, org, made.id, 'discard', { version: shipment.version });
  assert.equal(discard.status, 409, discard.text);
  assert.equal(discard.body.code, 'shipment_not_draft');
  const twice = await act(person, org, made.id, 'publish', {
    version: shipment.version,
    ...details(),
  });
  assert.equal(twice.body.code, 'shipment_not_draft');
  assert.equal(await entries(made.id, 'shipment.published'), 1);
});

test('only an organisation that may publish can publish, judged after the locks', async () => {
  // Not verified.
  const { person, org } = await newShipper();
  const made = await draft(person, org);
  const reply = await act(person, org, made.id, 'publish', { version: made.version, ...details() });
  assert.equal(reply.status, 409, reply.text);
  assert.equal(reply.body.code, 'publication_not_allowed');
  assert.equal((await get(person, org, made.id)).status, 'draft');
  // Verified, then withdrawn: refused again.
  const ok = await verifiedShipper();
  const admin = await newStaff(['staff_admin']);
  const revoked = await call('POST', `/staff/verification/organisations/${ok.org}/revoke`, {
    token: admin.token,
    body: { reason: 'verified_in_error', noConflict: true },
  });
  assert.equal(revoked.status, 200, revoked.text);
  const later = await draft(ok.person, ok.org);
  const refusedReply = await act(ok.person, ok.org, later.id, 'publish', {
    version: later.version,
    ...details(),
  });
  assert.equal(refusedReply.body.code, 'publication_not_allowed');
  // In a production database the same verification on demonstration evidence allows nothing.
  const scratch = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: scratch.url });
  try {
    await migrateUp(pool, defaultMigrationsDir());
    const ids = {
      person: randomUUID(),
      org: randomUUID(),
      staff: randomUUID(),
      application: randomUUID(),
    };
    await pool.query(`
      INSERT INTO trucker.country (code, name_en, name_ar, name_ur) VALUES ('OM', 'Oman', 'x', 'x');
      INSERT INTO trucker.person (id, phone_e164, created_at) VALUES ('${ids.person}', '+96890000000', now());
      INSERT INTO trucker.organisation (id, status, legal_name, country_code, registration_number, created_by, created_at, updated_at)
        VALUES ('${ids.org}', 'verified', 'Scratch', 'OM', 'S-1', '${ids.person}', now(), now());
      INSERT INTO trucker.staff_account (id, email, display_name, status, enrolled_at, password_hash, totp_secret, created_at, updated_at)
        VALUES ('${ids.staff}', 's@example.test', 'S', 'active', now(), 'x', '\\x00', now(), now());
      INSERT INTO trucker.verification_application (id, organisation_id, version_no, kind, status, legal_name, country_code, registration_number, capability, previous_status, submitted_by, submitted_at, declaration_kind, declaration_version, declaration_language, decided_by, decided_at, decision_reason, no_conflict_declared, decided_on_version)
        VALUES ('${ids.application}', '${ids.org}', 1, 'initial', 'verified', 'Scratch', 'OM', 'S-1', 'ship', 'draft', '${ids.person}', now(), 'demonstration', 'd', 'en', '${ids.staff}', now(), 'evidence_accepted', true, 1);
      INSERT INTO trucker.organisation_capability (organisation_id, capability, status, basis, granted_application, granted_at)
        VALUES ('${ids.org}', 'ship', 'granted', 'demonstration', '${ids.application}', now());
    `);
    const before = await pool.query<{ yes: boolean }>(
      'SELECT trucker.organisation_publishable($1) AS yes',
      [ids.org],
    );
    assert.equal(before.rows[0]!.yes, true, 'unmarked');
    await pool.query(`UPDATE trucker.environment SET kind = 'production'`);
    const after = await pool.query<{ yes: boolean }>(
      'SELECT trucker.organisation_publishable($1) AS yes',
      [ids.org],
    );
    assert.equal(after.rows[0]!.yes, false, 'production');
  } finally {
    await pool.end();
    await scratch.drop();
  }
});

test('an incomplete or invalid shipment is refused with every problem by field, and nothing is published', async () => {
  const { person, org } = await verifiedShipper();
  const empty = await draft(person, org, { cargoDescription: 'Something' });
  const reply = await act(person, org, empty.id, 'publish', { version: empty.version });
  assert.equal(reply.status, 422, reply.text);
  for (const expected of [
    'cargoCategory:required',
    'equipmentType:required',
    'dangerousGoods:required',
    'pickup.area:required',
    'delivery.area:required',
    'quotationDeadline:required',
    'grossWeightKg:required_to_publish',
    'pickup.address:required_to_publish',
    'pickup.countryCode:required_to_publish',
    'pickup.timeZone:required_to_publish',
    'pickup.from:required_to_publish',
    'delivery.until:required_to_publish',
  ])
    assert.ok(codes(reply).includes(expected), `${expected}: ${codes(reply).join(' ')}`);
  const made = await draft(person, org);
  const cases: [Record<string, unknown>, string][] = [
    [details({ dangerousGoods: true }), 'dangerousGoods:not_accepted'],
    [details({ cargoCategory: 'restricted_demo' }), 'cargoCategory:not_accepted'],
    [details({ cargoCategory: 'no_such_thing' }), 'cargoCategory:unknown'],
    [details({ equipmentType: 'no_such_thing' }), 'equipmentType:unknown'],
    [details({ quotationDeadline: { local: local(0.05) } }), 'quotationDeadline:too_soon'],
    [details({ quotationDeadline: { local: local(-1) } }), 'quotationDeadline:in_past'],
    [details({ quotationDeadline: { local: local(49) } }), 'quotationDeadline:after_pickup'],
    [details({ pickupArea: 'x'.repeat(121) }), 'pickupArea:invalid'],
  ];
  for (const [body, expected] of cases) {
    const refusedReply = await act(person, org, made.id, 'publish', {
      version: made.version,
      ...body,
    });
    assert.ok(
      [422].includes(refusedReply.status) && codes(refusedReply).includes(expected),
      `${expected}: ${refusedReply.status} ${codes(refusedReply).join(' ')}`,
    );
  }
  // A pick-up already in the past.
  const late = await draft(
    person,
    org,
    content({
      pickup: {
        ...(content().pickup as object),
        from: { local: local(-2) },
        until: { local: local(50) },
      },
    }),
  );
  const lateReply = await act(person, org, late.id, 'publish', {
    version: late.version,
    ...details({ quotationDeadline: { local: local(-3) } }),
  });
  assert.ok(codes(lateReply).includes('pickup.from:in_past'), codes(lateReply).join(' '));
  // A closed route: the fictional country XC is closed.
  const closed = await draft(
    person,
    org,
    content({
      delivery: { ...(content().delivery as object), countryCode: 'XC', timeZone: 'Etc/GMT-3' },
    }),
  );
  const closedReply = await act(person, org, closed.id, 'publish', {
    version: closed.version,
    ...details(),
  });
  assert.ok(codes(closedReply).includes('route:not_open'), codes(closedReply).join(' '));
  for (const id of [empty.id, made.id, late.id, closed.id]) {
    assert.equal((await get(person, org, id)).status, 'draft');
    assert.equal(await entries(id, 'shipment.published'), 0);
  }
  assert.equal(await count('shipment_publication_version', 'organisation_id = $1', [org]), 0);
});

test('the lead time is the protected setting: 120 minutes by default', async () => {
  const { person, org } = await verifiedShipper();
  await owner.query('UPDATE trucker.security_setting SET publication_lead_minutes = DEFAULT');
  try {
    const made = await draft(person, org);
    const soon = await act(person, org, made.id, 'publish', {
      version: made.version,
      ...details({ quotationDeadline: { local: local(1.9) } }),
    });
    const problem = problems(soon).find((item) => item.field === 'quotationDeadline') as {
      code: string;
      minutes?: number;
    };
    assert.deepEqual([problem.code, problem.minutes], ['too_soon', 120]);
    const enough = await act(person, org, made.id, 'publish', {
      version: made.version,
      ...details({ quotationDeadline: { local: local(2.1) } }),
    });
    assert.equal(enough.status, 200, enough.text);
  } finally {
    await owner.query('UPDATE trucker.security_setting SET publication_lead_minutes = 5');
  }
});

test('a publication whose answer was lost, sent again, applies once; another request with its key is refused', async () => {
  const { person, org } = await verifiedShipper();
  const made = await draft(person, org);
  const retry = key();
  const body = { version: made.version, ...details() };
  const first = await act(person, org, made.id, 'publish', body, retry);
  const again2 = await act(person, org, made.id, 'publish', body, retry);
  assert.equal(first.body.outcome, 'published');
  assert.equal(again2.status, 200, again2.text);
  assert.equal(again2.body.outcome, 'already_published');
  const other = await act(
    person,
    org,
    made.id,
    'publish',
    { ...body, pickupArea: 'Elsewhere' },
    retry,
  );
  assert.equal(other.body.code, 'retry_key_conflict');
  assert.equal(await entries(made.id, 'shipment.published'), 1);
  assert.equal(await count('shipment_publication_version', 'shipment_id = $1', [made.id]), 1);
  // Two publications of one draft at the same moment: one.
  const twin = await draft(person, org);
  const both = await Promise.all([
    act(person, org, twin.id, 'publish', { version: twin.version, ...details() }),
    act(person, org, twin.id, 'publish', { version: twin.version, ...details() }),
  ]);
  assert.deepEqual(both.map((reply) => reply.status).sort(), [200, 409]);
  assert.equal(await entries(twin.id, 'shipment.published'), 1);
  // Made against an older version: nothing.
  const stale = await draft(person, org);
  const staleReply = await act(person, org, stale.id, 'publish', {
    version: stale.version + 7,
    ...details(),
  });
  assert.equal(staleReply.body.code, 'shipment_changed');
});

// ---------------------------------------------------------------------------------------------
// PUB-7: changes and versions
// ---------------------------------------------------------------------------------------------
test('a change to what carriers would see, the deadline or the dangerous-goods answer is a new version; other changes are not', async () => {
  const { person, org } = await verifiedShipper();
  let shipment = await published(person, org);
  const v1 = (
    await owner.query(
      'SELECT carrier_values FROM trucker.shipment_publication_version WHERE shipment_id = $1',
      [shipment.id],
    )
  ).rows[0];
  const minor = await change(
    person,
    org,
    shipment,
    content({
      shipperReference: 'REF-CHANGED',
      pickup: {
        ...(content().pickup as object),
        address: 'Warehouse 10',
        accessNotes: 'Gate code 9000',
      },
    }),
  );
  assert.equal(minor.status, 200, minor.text);
  assert.deepEqual([minor.body.outcome, minor.body.material], ['changed', false]);
  shipment = minor.body.shipment as Shipment;
  assert.equal(shipment.publication.publishedVersion, 1);
  assert.equal(await entries(shipment.id, 'shipment.updated'), 1);
  // Nothing different at all: nothing written.
  const same = await change(
    person,
    org,
    shipment,
    content({
      shipperReference: 'REF-CHANGED',
      pickup: {
        ...(content().pickup as object),
        address: 'Warehouse 10',
        accessNotes: 'Gate code 9000',
      },
    }),
  );
  assert.equal(same.body.outcome, 'unchanged');
  const materials: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
      'weight',
      content({
        grossWeightKg: '13000',
        shipperReference: 'REF-CHANGED',
        pickup: {
          ...(content().pickup as object),
          address: 'Warehouse 10',
          accessNotes: 'Gate code 9000',
        },
      }),
      details(),
    ],
    [
      'area',
      content({
        grossWeightKg: '13000',
        shipperReference: 'REF-CHANGED',
        pickup: {
          ...(content().pickup as object),
          address: 'Warehouse 10',
          accessNotes: 'Gate code 9000',
        },
      }),
      details({ deliveryArea: 'Free zone' }),
    ],
    [
      'deadline',
      content({
        grossWeightKg: '13000',
        shipperReference: 'REF-CHANGED',
        pickup: {
          ...(content().pickup as object),
          address: 'Warehouse 10',
          accessNotes: 'Gate code 9000',
        },
      }),
      details({ deliveryArea: 'Free zone', quotationDeadline: { local: local(30) } }),
    ],
  ];
  for (const [label, body, publication] of materials) {
    const reply = await change(person, org, shipment, body, publication);
    assert.equal(reply.status, 200, `${label}: ${reply.text}`);
    assert.equal(reply.body.material, true, label);
    shipment = reply.body.shipment as Shipment;
  }
  assert.equal(shipment.publication.publishedVersion, 4);
  assert.equal(await entries(shipment.id, 'shipment.version_created'), 3);
  // The dangerous-goods answer cannot become "yes" while published.
  const dangerous = await change(person, org, shipment, materials[2]![1], {
    ...materials[2]![2],
    dangerousGoods: true,
  });
  assert.ok(codes(dangerous).includes('dangerousGoods:not_accepted'));
  // Moving the deadline sooner than the lead time is refused; keeping it is not judged again.
  const tooSoon = await change(person, org, shipment, materials[2]![1], {
    ...materials[2]![2],
    quotationDeadline: { local: local(0.05) },
  });
  assert.ok(codes(tooSoon).includes('quotationDeadline:too_soon'), codes(tooSoon).join(' '));
  // Every version stays as it was published.
  const versions = await owner.query<{ version_no: number; kind: string; carrier_values: unknown }>(
    'SELECT version_no, kind, carrier_values FROM trucker.shipment_publication_version WHERE shipment_id = $1 ORDER BY version_no',
    [shipment.id],
  );
  assert.deepEqual(
    versions.rows.map((row) => `${row.version_no}:${row.kind}`),
    ['1:published', '2:changed', '3:changed', '4:changed'],
  );
  assert.deepEqual(versions.rows[0]!.carrier_values, v1!.carrier_values);
  // A change sent again with its key applies once.
  const retry = key();
  const body = content({
    grossWeightKg: '14000',
    shipperReference: 'REF-CHANGED',
    pickup: {
      ...(content().pickup as object),
      address: 'Warehouse 10',
      accessNotes: 'Gate code 9000',
    },
  });
  const once = await change(person, org, shipment, body, materials[2]![2], retry);
  const twice = await change(person, org, shipment, body, materials[2]![2], retry);
  assert.equal(once.body.outcome, 'changed');
  assert.equal(twice.body.outcome, 'already_applied');
  assert.equal(await entries(shipment.id, 'shipment.version_created'), 4);
});

test('two changes at the same moment, or a change and a withdrawal: one applies, the other is refused', async () => {
  const { person, org } = await verifiedShipper();
  const shipment = await published(person, org);
  const both = await Promise.all([
    change(person, org, shipment, content({ grossWeightKg: '15000' })),
    change(person, org, shipment, content({ grossWeightKg: '16000' })),
  ]);
  assert.deepEqual(
    both.map((reply) => reply.status).sort(),
    [200, 409],
    both.map((reply) => reply.text).join(' '),
  );
  assert.equal(await entries(shipment.id, 'shipment.version_created'), 1);
  const now = await get(person, org, shipment.id);
  const race = await Promise.all([
    change(person, org, now, content({ grossWeightKg: '17000' })),
    act(person, org, now.id, 'withdraw', { version: now.version }),
  ]);
  assert.deepEqual(
    race.map((reply) => reply.status).sort(),
    [200, 409],
    race.map((reply) => reply.text).join(' '),
  );
  const changes = await entries(shipment.id, 'shipment.version_created');
  const withdrawals = await entries(shipment.id, 'shipment.withdrawn');
  assert.equal(changes - 1 + withdrawals, 1);
});

// ---------------------------------------------------------------------------------------------
// Withdrawal, copy
// ---------------------------------------------------------------------------------------------
test('withdrawal is final; the same request again changes nothing; a new draft is made from a copy', async () => {
  const { person, org } = await verifiedShipper();
  const shipment = await published(person, org);
  const retry = key();
  const first = await act(
    person,
    org,
    shipment.id,
    'withdraw',
    { version: shipment.version },
    retry,
  );
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.outcome, 'withdrawn');
  const again2 = await act(
    person,
    org,
    shipment.id,
    'withdraw',
    { version: shipment.version },
    retry,
  );
  assert.equal(again2.status, 200, again2.text);
  const other = await act(person, org, shipment.id, 'withdraw', { version: shipment.version + 1 });
  assert.equal(other.body.outcome, 'already_withdrawn');
  assert.equal(await entries(shipment.id, 'shipment.withdrawn'), 1);
  const now = await get(person, org, shipment.id);
  assert.equal(now.status, 'withdrawn');
  for (const [action, body, codeExpected] of [
    [
      'published-changes',
      { ...content(), publication: details(), version: now.version },
      'shipment_not_published',
    ],
    ['publish', { ...details(), version: now.version }, 'shipment_not_draft'],
    [
      'republish',
      { quotationDeadline: { local: local(24) }, version: now.version },
      'shipment_not_expired',
    ],
  ] as const) {
    const reply = await act(person, org, now.id, action, body);
    assert.equal(reply.body.code, codeExpected, action);
  }
  const copyKey = key();
  const copied = await act(person, org, now.id, 'copy', undefined, copyKey);
  assert.equal(copied.status, 201, copied.text);
  const copy = copied.body.shipment as Shipment;
  assert.equal(copy.status, 'draft');
  assert.equal(copy.publication.copiedFrom, now.id);
  assert.equal(copy.publication.quotationDeadline.at, null);
  assert.equal(copy.publication.pickupArea, 'North industrial area');
  assert.equal(copy.pickup.address, 'Warehouse 9, Private Street');
  const copiedAgain = await act(person, org, now.id, 'copy', undefined, copyKey);
  assert.equal((copiedAgain.body.shipment as Shipment).id, copy.id);
  assert.equal(copiedAgain.body.outcome, 'already_copied');
  // A published shipment is not copied.
  const live = await published(person, org);
  const notCopy = await act(person, org, live.id, 'copy', undefined);
  assert.equal(notCopy.body.code, 'shipment_not_copyable');
  // The copy publishes on its own, as a new shipment.
  const fromCopy = await act(person, org, copy.id, 'publish', {
    version: copy.version,
    ...details(),
  });
  assert.equal(fromCopy.status, 200, fromCopy.text);
});

// ---------------------------------------------------------------------------------------------
// PUB-9: expiry without a worker, recorded once
// ---------------------------------------------------------------------------------------------
test('a shipment past its deadline is expired at every read, before anything is recorded; the record is written once, dated at the deadline', async () => {
  const shipper = await verifiedShipper();
  let person = shipper.person;
  const org = shipper.org;
  const shipment = await published(person, org, { quotationDeadline: { local: local(0.25) } });
  const deadline = shipment.publication.quotationDeadline.at!;
  await advance(16 * 60);
  person = await again(person);
  // Read with no recording at all: the state is already right.
  const listedRaw = await asApiRole(
    { tokenHash: hashToken(person.token), organisationId: org },
    (client) =>
      client.query<{ status: string }>(
        `SELECT status FROM trucker.list_shipment_drafts('all', NULL) WHERE id = $1`,
        [shipment.id],
      ),
  );
  assert.equal(listedRaw.rows[0]!.status, 'expired');
  assert.equal(await entries(shipment.id, 'shipment.expired'), 0);
  // Many readers at the same moment: one record.
  await Promise.all(Array.from({ length: 6 }, () => get(person, org, shipment.id)));
  await call('GET', shipments(org, '?status=expired'), { token: person.token });
  assert.equal(await entries(shipment.id, 'shipment.expired'), 1);
  const record = await owner.query<{ occurred_at: Date; actor_person_id: string | null }>(
    `SELECT occurred_at, actor_person_id FROM trucker.audit_entry WHERE record_id = $1 AND action = 'shipment.expired'`,
    [shipment.id],
  );
  assert.equal(record.rows[0]!.occurred_at.toISOString(), new Date(deadline).toISOString());
  assert.equal(record.rows[0]!.actor_person_id, null);
  assert.equal((await get(person, org, shipment.id)).status, 'expired');
  // Even written by hand, a second expiry record is refused by the database.
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.audit_entry (occurred_at, organisation_id, action, record_type, record_id, after_values)
         VALUES (now(), $1, 'shipment.expired', 'shipment_draft', $2, '{}')`,
        [org, shipment.id],
      ),
    /duplicate key/,
  );
});

test('a request that waited behind a lock while the deadline passed finds the shipment expired and changes nothing', async () => {
  const shipper = await verifiedShipper();
  let person = shipper.person;
  const org = shipper.org;
  for (const action of ['published-changes', 'withdraw'] as const) {
    const shipment = await published(person, org, { quotationDeadline: { local: local(0.2) } });
    const body =
      action === 'withdraw'
        ? { version: shipment.version }
        : {
            ...content({ grossWeightKg: '1' }),
            publication: details({ quotationDeadline: { local: local(0.2) } }),
            version: shipment.version,
          };
    const reply = await whileBlocked(
      ['SELECT 1 FROM trucker.shipment_draft WHERE id = $1 FOR UPDATE', [shipment.id]],
      () => act(person, org, shipment.id, action, body),
      13 * 60,
    );
    assert.equal(reply.status, 409, `${action}: ${reply.text}`);
    assert.equal(reply.body.code, 'shipment_not_published');
    assert.equal((reply.body.details as { current: Shipment }).current.status, 'expired');
    assert.equal(await entries(shipment.id, 'shipment.expired'), 1);
    assert.equal(await entries(shipment.id, 'shipment.withdrawn'), 0);
    assert.equal(await entries(shipment.id, 'shipment.version_created'), 0);
    person = await again(person);
  }
  // A publication whose deadline became too close while it waited is refused.
  const made = await draft(person, org);
  const late = await whileBlocked(
    ['SELECT 1 FROM trucker.shipment_draft WHERE id = $1 FOR UPDATE', [made.id]],
    () =>
      act(person, org, made.id, 'publish', {
        version: made.version,
        ...details({ quotationDeadline: { local: local(0.15) } }),
      }),
    6 * 60,
  );
  assert.ok(
    codes(late).includes('quotationDeadline:too_soon'),
    `${late.status} ${codes(late).join(' ')}`,
  );
});

test('an expired shipment is published again as a new version, after every check passes again', async () => {
  const shipper = await verifiedShipper();
  let person = shipper.person;
  const org = shipper.org;
  const shipment = await published(person, org, { quotationDeadline: { local: local(0.2) } });
  await advance(13 * 60);
  person = await again(person);
  const expired = await get(person, org, shipment.id);
  assert.equal(expired.status, 'expired');
  const soon = await act(person, org, expired.id, 'republish', {
    quotationDeadline: { local: local(0.05) },
    version: expired.version,
  });
  assert.ok(codes(soon).includes('quotationDeadline:too_soon'));
  const retry = key();
  const body = { quotationDeadline: { local: local(20) }, version: expired.version };
  const first = await act(person, org, expired.id, 'republish', body, retry);
  assert.equal(first.status, 200, first.text);
  const second = await act(person, org, expired.id, 'republish', body, retry);
  assert.equal(second.body.outcome, 'already_republished');
  const now = first.body.shipment as Shipment;
  assert.deepEqual([now.status, now.publication.publishedVersion], ['published', 2]);
  assert.equal(await entries(shipment.id, 'shipment.republished'), 1);
  const kinds = await owner.query<{ kind: string }>(
    'SELECT kind FROM trucker.shipment_publication_version WHERE shipment_id = $1 ORDER BY version_no',
    [shipment.id],
  );
  assert.deepEqual(
    kinds.rows.map((row) => row.kind),
    ['published', 'republished'],
  );
  // Republication checks eligibility again.
  const other = await published(person, org, { quotationDeadline: { local: local(0.2) } });
  const admin = await newStaff(['staff_admin']);
  await call('POST', `/staff/verification/organisations/${org}/revoke`, {
    token: admin.token,
    body: { reason: 'verified_in_error', noConflict: true },
  });
  await advance(13 * 60);
  person = await again(person);
  const gone = await get(person, org, other.id);
  assert.equal(gone.status, 'expired');
  const refusedReply = await act(person, org, gone.id, 'republish', {
    quotationDeadline: { local: local(20) },
    version: gone.version,
  });
  assert.equal(refusedReply.body.code, 'publication_not_allowed');
});

// ---------------------------------------------------------------------------------------------
// PUB-12: suspension
// ---------------------------------------------------------------------------------------------
test('verification withdrawn: suspended for that cause, once; restored: resumed only after every condition passes', async () => {
  const { person, org } = await verifiedShipper();
  const shipment = await published(person, org);
  const admin = await newStaff(['staff_admin']);
  const revoked = await call('POST', `/staff/verification/organisations/${org}/revoke`, {
    token: admin.token,
    body: { reason: 'verified_in_error', noConflict: true },
  });
  assert.equal(revoked.status, 200, revoked.text);
  // Recorded in the withdrawal's own transaction, not at the next read.
  assert.equal(await entries(shipment.id, 'shipment.suspended'), 1);
  let now = await get(person, org, shipment.id);
  assert.deepEqual([now.status, now.publication.suspendedFor], ['suspended', ['verification']]);
  // Nothing is cancelled: it can still be changed (and stays suspended), and withdrawn.
  // The lane closes too: a second cause, separately.
  await owner.query(
    `UPDATE trucker.lane SET state = 'closed' WHERE origin_country = 'XA' AND destination_country = 'XB'`,
  );
  try {
    now = await get(person, org, shipment.id);
    assert.deepEqual(now.publication.suspendedFor, ['route', 'verification']);
    for (let read = 0; read < 3; read += 1) await get(person, org, shipment.id);
    assert.equal(await entries(shipment.id, 'shipment.suspended'), 2);
    const preview = await call('GET', shipments(org, `/${shipment.id}/publication`), {
      token: person.token,
    });
    assert.equal(
      (preview.body.publication as { carrierView: { state: string } }).carrierView.state,
      'suspended',
    );
  } finally {
    await owner.query(
      `UPDATE trucker.lane SET state = 'enabled' WHERE origin_country = 'XA' AND destination_country = 'XB'`,
    );
  }
  // The route passes again: that cause ends; still suspended for verification.
  now = await get(person, org, shipment.id);
  assert.deepEqual([now.status, now.publication.suspendedFor], ['suspended', ['verification']]);
  assert.equal(await entries(shipment.id, 'shipment.suspension_ended'), 1);
  // Verified again: the last cause ends in the decision's transaction, and it is published.
  reviewerForAll = await fresh(reviewerForAll!);
  await verified(reviewerForAll, person, org);
  now = await get(person, org, shipment.id);
  assert.deepEqual([now.status, now.publication.suspendedFor], ['published', []]);
  assert.equal(await entries(shipment.id, 'shipment.suspension_ended'), 2);
  assert.equal(await entries(shipment.id, 'shipment.suspended'), 2);
  const rows = await owner.query<{ cause: string; ended_by: string }>(
    'SELECT cause, ended_by FROM trucker.shipment_suspension WHERE shipment_id = $1 ORDER BY cause',
    [shipment.id],
  );
  assert.deepEqual(
    rows.rows.map((row) => `${row.cause}:${row.ended_by}`),
    ['route:recheck', 'verification:recheck'],
  );
});

test('expiry comes before suspension: a suspended shipment past its deadline expires, once, and its suspension ends with it', async () => {
  const shipper = await verifiedShipper();
  let person = shipper.person;
  const org = shipper.org;
  const shipment = await published(person, org, { quotationDeadline: { local: local(0.2) } });
  const admin = await newStaff(['staff_admin']);
  await call('POST', `/staff/verification/organisations/${org}/revoke`, {
    token: admin.token,
    body: { reason: 'verified_in_error', noConflict: true },
  });
  await owner.query(
    `UPDATE trucker.lane SET state = 'closed' WHERE origin_country = 'XA' AND destination_country = 'XB'`,
  );
  try {
    await advance(13 * 60);
    person = await again(person);
    const now = await get(person, org, shipment.id);
    assert.deepEqual([now.status, now.publication.suspendedFor], ['expired', []]);
  } finally {
    await owner.query(
      `UPDATE trucker.lane SET state = 'enabled' WHERE origin_country = 'XA' AND destination_country = 'XB'`,
    );
  }
  assert.equal(await entries(shipment.id, 'shipment.expired'), 1);
  assert.equal(
    await entries(shipment.id, 'shipment.suspended'),
    1,
    'the closed lane was never recorded: expiry came first',
  );
  assert.equal(await entries(shipment.id, 'shipment.suspension_ended'), 0);
  const ended = await owner.query<{ ended_by: string }>(
    'SELECT ended_by FROM trucker.shipment_suspension WHERE shipment_id = $1',
    [shipment.id],
  );
  assert.deepEqual(
    ended.rows.map((row) => row.ended_by),
    ['expiry'],
  );
});

test('a publication racing a verification withdrawal never leaves a shipment published without its suspension', async () => {
  for (let round = 0; round < 4; round += 1) {
    const { person, org } = await verifiedShipper();
    const made = await draft(person, org);
    const admin = await newStaff(['staff_admin']);
    const [publishReply, revokeReply] = await Promise.all([
      act(person, org, made.id, 'publish', { version: made.version, ...details() }),
      call('POST', `/staff/verification/organisations/${org}/revoke`, {
        token: admin.token,
        body: { reason: 'verified_in_error', noConflict: true },
      }),
    ]);
    assert.equal(revokeReply.status, 200, revokeReply.text);
    const row = await owner.query<{ status: string; open: number }>(
      `SELECT d.status, (SELECT count(*)::int FROM trucker.shipment_suspension s WHERE s.shipment_id = d.id AND s.ended_at IS NULL) AS open
       FROM trucker.shipment_draft d WHERE d.id = $1`,
      [made.id],
    );
    if (publishReply.status === 200)
      assert.deepEqual(row.rows[0], { status: 'published', open: 1 });
    else {
      assert.equal(publishReply.body.code, 'publication_not_allowed');
      assert.deepEqual(row.rows[0], { status: 'draft', open: 0 });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// PUB-10: what carriers would see
// ---------------------------------------------------------------------------------------------
test('the preview holds only the approved fields: never an address, access notes, the reference, the shipper or a contact', async () => {
  const { person, org } = await verifiedShipper({
    legalName: 'Unmistakable Shipper Name (fictional)',
  });
  const shipment = await published(person, org);
  const reply = await call('GET', shipments(org, `/${shipment.id}/publication`), {
    token: person.token,
  });
  const view = (reply.body.publication as { carrierView: Record<string, unknown> }).carrierView;
  assert.deepEqual(Object.keys(view).sort(), [
    'cargo',
    'dangerousGoods',
    'delivery',
    'equipment',
    'lane',
    'pickup',
    'publishedVersion',
    'quotationDeadline',
    'shipper',
    'state',
  ]);
  assert.deepEqual(Object.keys(view.pickup as object).sort(), [
    'area',
    'countryCode',
    'from',
    'timeZone',
    'until',
  ]);
  assert.equal(view.shipper, 'verified_shipper');
  const text = JSON.stringify(view);
  for (const secret of [
    'Private Street',
    'Hidden Road',
    'Gate code',
    'night guard',
    'REF-PRIVATE',
    'Unmistakable',
    org,
    person.personId,
    person.phone,
  ])
    assert.ok(!text.includes(secret), `the preview shows ${secret}`);
  assert.ok(text.includes('North industrial area') && text.includes('Ceramic tiles'));
  // A draft has no preview; another organisation's shipment answers like none.
  const stranger = await newShipper();
  for (const path of [
    `/${shipment.id}`,
    `/${shipment.id}/publication`,
    `/${shipment.id}/history`,
  ]) {
    const theirs = await call('GET', shipments(stranger.org, path), {
      token: stranger.person.token,
    });
    assert.equal(theirs.status, 404, path);
  }
  for (const action of ['publish', 'published-changes', 'withdraw', 'republish', 'copy']) {
    const theirs = await act(stranger.person, stranger.org, shipment.id, action, { version: 1 });
    assert.ok([404, 422].includes(theirs.status), `${action}: ${theirs.status}`);
    assert.ok(!theirs.text.includes('Ceramic'));
  }
  const viaRole = await asApiRole(
    { tokenHash: hashToken(stranger.person.token), organisationId: stranger.org },
    (client) =>
      client.query<{ view: unknown }>('SELECT trucker.shipment_carrier_view($1) AS view', [
        shipment.id,
      ]),
  );
  assert.equal(viaRole.rows[0]!.view, null);
});

// ---------------------------------------------------------------------------------------------
// PUB-13: the API's role
// ---------------------------------------------------------------------------------------------
test("the API's role cannot publish, version, suspend or expire anything except through the functions", async () => {
  const { person, org } = await verifiedShipper();
  const shipment = await published(person, org);
  const context = { tokenHash: hashToken(person.token), organisationId: org };
  for (const statement of [
    `UPDATE trucker.shipment_draft SET status = 'published' WHERE id = '${shipment.id}'`,
    `UPDATE trucker.shipment_draft SET deadline_at = now() WHERE id = '${shipment.id}'`,
    `INSERT INTO trucker.shipment_publication_version (shipment_id, organisation_id, version_no, kind, carrier_values, created_at, created_by)
       VALUES ('${shipment.id}', '${org}', 9, 'changed', '{}', now(), '${person.personId}')`,
    `INSERT INTO trucker.shipment_suspension (shipment_id, organisation_id, cause, started_at) VALUES ('${shipment.id}', '${org}', 'route', now())`,
    `DELETE FROM trucker.shipment_suspension`,
    `INSERT INTO trucker.cargo_category (code, name_en, name_ar, name_ur) VALUES ('mine', 'x', 'x', 'x')`,
    `SELECT trucker.shipment_settle('${shipment.id}', now())`,
    `SELECT trucker.shipment_settle_organisation('${org}', now())`,
    `SELECT trucker.organisation_publishable('${org}')`,
    `SELECT trucker.publication_problems(d, now(), true, true, true) FROM trucker.shipment_draft d`,
  ])
    await refused(
      () => asApiRole(context, (client) => client.query(statement)),
      /permission denied/i,
    );
});

// ---------------------------------------------------------------------------------------------
// Staff, read-only
// ---------------------------------------------------------------------------------------------
test('reviewers and staff administrators read published shipments; each look is recorded; nobody else may', async () => {
  const { person, org } = await verifiedShipper();
  const shipment = await published(person, org);
  const reviewer = await newStaff(['reviewer']);
  const list = await call('GET', '/staff/shipments', { token: reviewer.token });
  assert.equal(list.status, 200, list.text);
  assert.ok((list.body.shipments as { id: string }[]).some((item) => item.id === shipment.id));
  const one = await call('GET', `/staff/shipments/${shipment.id}`, { token: reviewer.token });
  assert.equal(one.status, 200, one.text);
  assert.equal((one.body.carrierView as { shipper: string }).shipper, 'verified_shipper');
  assert.equal((one.body.organisation as { id: string }).id, org);
  assert.equal((await staffAudit(reviewer, 'staff.shipment_view')).length, 1);
  assert.equal((await staffAudit(reviewer, 'staff.shipment_list')).length, 1);
  const nobody = await newStaff([]);
  for (const path of ['/staff/shipments', `/staff/shipments/${shipment.id}`]) {
    const reply = await call('GET', path, { token: nobody.token });
    assert.equal(reply.status, 403, path);
    assert.equal((await call('GET', path, { token: person.token })).status, 401, path);
  }
  const refusals = await owner.query(
    `SELECT 1 FROM trucker.staff_audit_entry WHERE actor_staff_id = $1 AND outcome = 'refused'`,
    [nobody.id],
  );
  assert.equal(refusals.rowCount, 2);
  // A draft is not a published shipment to staff.
  const privateDraft = await draft(person, org);
  assert.equal(
    (await call('GET', `/staff/shipments/${privateDraft.id}`, { token: reviewer.token })).status,
    404,
  );
});
