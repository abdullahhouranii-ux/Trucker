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

// Carrier onboarding and discovery (slice 11). Real PostgreSQL, the API connected as its
// restricted role. Shippers and carriers are verified through the verification routes, by
// staff accounts put in place directly by the migration role. Test accounts and fictional
// evidence only. The lead time is lowered so that a deadline can pass within a session.

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
    publicationCycle: string | null;
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
// Carriers
// ---------------------------------------------------------------------------------------------
type Service = { countries: string[]; equipmentTypes: string[] };
const SERVICE: Service = { countries: ['XA', 'XB'], equipmentTypes: ['box', 'curtain_side'] };
/** The entries the fictional carrier requirements of country XA ask for. */
const carrierEvidence = (): Record<string, unknown>[] => [
  { documentType: 'registration_certificate', documentNumber: 'REG-C-1', issuingCountry: 'XA' },
  { documentType: 'haulage_licence', documentNumber: 'HAUL-C-2', issuingCountry: 'XA' },
];
const carrierBody = (service: Service = SERVICE, extra: Record<string, unknown> = {}) => ({
  capability: 'carry_as_company',
  service,
  evidence: carrierEvidence(),
  ...extra,
});
interface Capability {
  capability: string;
  status: string;
  effective: boolean;
  service: Service | null;
}
interface CarrierOverview extends Overview {
  capabilities: Capability[];
  mayApply: Record<string, string | null>;
  mayDiscover: boolean;
  requirementsFor: Record<string, { documentType: string; required: boolean }[]>;
}
const capabilityOf = async (person: Person, org: string, name: string) =>
  ((await overview(person, org)) as CarrierOverview).capabilities.find(
    (item) => item.capability === name,
  );
let carrierReviewer: Staff | undefined;
const reviewer = async (): Promise<Staff> =>
  fresh(carrierReviewer ?? (carrierReviewer = await newStaff(['reviewer'])));
async function verifiedCarrier(service: Service = SERVICE) {
  const { person, org } = await newShipper({ legalName: 'Fixture Carrier (fictional)' });
  const application = await submitted(person, org, carrierBody(service));
  const reply = await decide(await reviewer(), application.id, 'verified');
  assert.equal(reply.status, 200, reply.text);
  return { person, org };
}
const discoveryRoute = (org: string, rest = ''): string => `/organisations/${org}/discovery${rest}`;
const list = (person: Person, org: string, query: Record<string, string> = {}): Promise<Reply> =>
  call('GET', discoveryRoute(org, `/shipments?${new URLSearchParams(query).toString()}`), {
    token: person.token,
  });
const detailOf = (person: Person, org: string, id: string): Promise<Reply> =>
  call('GET', discoveryRoute(org, `/shipments/${id}`), { token: person.token });
interface Item {
  id: string;
  shipment: Record<string, unknown> & { quotationDeadline: { at: string } };
  changedSinceStart: boolean;
}
const items = (reply: Reply): Item[] => (reply.body.items as Item[] | undefined) ?? [];
const ids = (reply: Reply): string[] => items(reply).map((item) => item.id);
async function everything(person: Person, org: string, query: Record<string, string> = {}) {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const reply = await list(person, org, cursor ? { ...query, cursor } : query);
    assert.equal(reply.status, 200, reply.text);
    seen.push(...ids(reply));
    cursor = reply.body.next as string | null;
    if (!cursor) return seen;
  }
  throw new Error('too many pages');
}
let adminCounter: Staff | undefined;
const administrator = async (): Promise<Staff> =>
  fresh(adminCounter ?? (adminCounter = await newStaff(['staff_admin'])));
const revokeCapability = async (org: string, capability: string): Promise<Reply> =>
  call('POST', `/staff/verification/organisations/${org}/revoke`, {
    token: (await administrator()).token,
    body: { capability, reason: 'verified_in_error', noConflict: true },
  });
const logRows = async (org: string) =>
  (
    await owner.query<{
      kind: string;
      outcome: string;
      shipment_id: string | null;
      shown: string[];
      filter: Record<string, string>;
      reason: string | null;
    }>(
      `SELECT kind, outcome, shipment_id, shown, filter, reason FROM trucker.carrier_access_log
       WHERE organisation_id = $1 ORDER BY id`,
      [org],
    )
  ).rows;

// ---------------------------------------------------------------------------------------------
// CAR-1, CAR-3: applying as a carrier, with the declared service
// ---------------------------------------------------------------------------------------------
test('an organisation applies as a carrier with declared countries and equipment; each problem is reported by field', async () => {
  const { person, org } = await newShipper({ legalName: 'Applying Carrier (fictional)' });
  const before = (await overview(person, org)) as CarrierOverview;
  assert.equal(before.mayApply.carry_as_company, 'initial');
  assert.deepEqual(
    before.requirementsFor.carry_as_company!.map((item) => item.documentType).sort(),
    ['haulage_licence', 'registration_certificate'],
  );
  // Nothing declared, an unknown equipment type, a country this database does not have, and
  // the shipper's evidence instead of the carrier's.
  const empty = await submit(person, org, {
    capability: 'carry_as_company',
    service: { countries: [], equipmentTypes: [] },
  });
  assert.equal(empty.status, 422, empty.text);
  assert.deepEqual(codes(empty).sort(), [
    'evidence.haulage_licence.documentNumber:required',
    'evidence:invalid',
    'service.countries:required',
    'service.equipmentTypes:required',
  ]);
  const unknown = await submit(
    person,
    org,
    carrierBody({ countries: ['XA', 'QQ'], equipmentTypes: ['tanker'] }),
  );
  assert.deepEqual(codes(unknown).sort(), [
    'service.countries:country_unavailable',
    'service.equipmentTypes:unknown',
  ]);
  // A service declared for the shipper capability is refused.
  const wrong = await submit(person, org, { service: SERVICE });
  assert.ok(codes(wrong).includes('service:carrier_only'), codes(wrong).join());
  // The same request twice makes one application; a stale version is refused.
  const retry = key();
  const first = await submit(person, org, carrierBody(), retry);
  assert.equal(first.status, 201, first.text);
  const second = await submit(person, org, carrierBody(), retry);
  assert.equal(second.status, 201, second.text);
  assert.equal(await count('verification_application', 'organisation_id = $1', [org]), 1);
  const stale = await submit(person, org, { ...carrierBody(), version: 1 }, key());
  assert.equal(stale.status, 409);
  const application = (first.body.verification as CarrierOverview).applications[0]!;
  assert.equal((application as unknown as { capability: string }).capability, 'carry_as_company');
  assert.deepEqual((application as unknown as { service: unknown }).service, {
    kind: 'declared_matching_criteria',
    countries: ['XA', 'XB'],
    equipmentTypes: ['box', 'curtain_side'],
  });
  // Decided by staff: a carrier, not a shipper.
  const decided = await decide(await reviewer(), application.id, 'verified');
  assert.equal(decided.status, 200, decided.text);
  const after = (await overview(person, org)) as CarrierOverview;
  assert.equal(after.organisation.status, 'verified');
  assert.equal(after.mayDiscover, true);
  assert.equal(after.mayPublish, false);
  assert.equal(after.mayApply.carry_as_company, 'service_change');
  assert.equal(after.mayApply.ship, 'capability');
  const carry = after.capabilities.find((item) => item.capability === 'carry_as_company')!;
  assert.deepEqual([carry.status, carry.effective], ['granted', true]);
  assert.deepEqual(carry.service?.countries, ['XA', 'XB']);
  // The status route says the same and names the declaration as matching criteria only.
  const status = await call('GET', discoveryRoute(org), { token: person.token });
  assert.equal(status.status, 200, status.text);
  assert.deepEqual(status.body.discovery, {
    mayDiscover: true,
    service: {
      kind: 'declared_matching_criteria',
      countries: ['XA', 'XB'],
      equipmentTypes: ['box', 'curtain_side'],
    },
  });
});

test('after the migrations no carrier requirement or declaration exists, and none can be declared outside a marked database', async () => {
  const scratch = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: scratch.url });
  try {
    await migrateUp(pool, defaultMigrationsDir());
    for (const table of [
      'carrier_service_country',
      'carrier_service_equipment',
      'carrier_access_log',
      'evidence_requirement',
      'equipment_type',
    ])
      assert.equal(
        (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trucker.${table}`))
          .rows[0]!.n,
        0,
        table,
      );
  } finally {
    await pool.end();
    await scratch.drop();
  }
});

// ---------------------------------------------------------------------------------------------
// CAR-2, CB-2: the two capabilities are decided and withdrawn independently
// ---------------------------------------------------------------------------------------------
test('shipper and carrier capabilities are decided and withdrawn independently of each other', async () => {
  const { person, org } = await verifiedShipper();
  const shipment = await published(person, org);
  // A refused carrier application leaves the shipper capability as it was.
  const refusedOne = await submitted(person, org, carrierBody());
  assert.equal(refusedOne.kind, 'capability');
  const rejected = await decide(await reviewer(), refusedOne.id, 'rejected');
  assert.equal(rejected.status, 200, rejected.text);
  let now = (await overview(person, org)) as CarrierOverview;
  assert.deepEqual(
    [now.organisation.status, now.mayPublish, now.mayDiscover],
    ['verified', true, false],
  );
  // Granted: both.
  const accepted = await submitted(person, org, carrierBody());
  assert.equal((await decide(await reviewer(), accepted.id, 'verified')).status, 200);
  now = (await overview(person, org)) as CarrierOverview;
  assert.deepEqual([now.mayPublish, now.mayDiscover], [true, true]);
  // Withdrawing the carrier capability: still a shipper, shipment not suspended.
  const carryGone = await revokeCapability(org, 'carry_as_company');
  assert.equal(carryGone.status, 200, carryGone.text);
  now = (await overview(person, org)) as CarrierOverview;
  assert.deepEqual(
    [now.organisation.status, now.mayPublish, now.mayDiscover],
    ['verified', true, false],
  );
  assert.deepEqual((await get(person, org, shipment.id)).publication.suspendedFor, []);
  // The same withdrawal again is recognised; withdrawing a capability not held is refused.
  assert.equal((await revokeCapability(org, 'carry_as_company')).body.outcome, 'already_revoked');
  // Granted again, then the shipper capability withdrawn: still a carrier.
  const again2 = await submitted(person, org, carrierBody());
  assert.equal((await decide(await reviewer(), again2.id, 'verified')).status, 200);
  const shipGone = await revokeCapability(org, 'ship');
  assert.equal(shipGone.status, 200, shipGone.text);
  now = (await overview(person, org)) as CarrierOverview;
  assert.deepEqual(
    [now.organisation.status, now.mayPublish, now.mayDiscover],
    ['verified', false, true],
  );
  assert.deepEqual((await get(person, org, shipment.id)).publication.suspendedFor, [
    'verification',
  ]);
  // The last capability withdrawn: the organisation is no longer verified.
  assert.equal((await revokeCapability(org, 'carry_as_company')).status, 200);
  now = (await overview(person, org)) as CarrierOverview;
  assert.deepEqual(
    [now.organisation.status, now.mayPublish, now.mayDiscover],
    ['verification_withdrawn', false, false],
  );
  // Each withdrawal is one history entry naming its capability.
  const revocations = await owner.query<{ capability: string }>(
    `SELECT after_values ->> 'capability' AS capability FROM trucker.audit_entry
     WHERE organisation_id = $1 AND action = 'verification.revoked' ORDER BY occurred_at, id`,
    [org],
  );
  // (Entries made at the same clock moment have no order of their own.)
  assert.deepEqual(revocations.rows.map((row) => row.capability).sort(), [
    'carry_as_company',
    'carry_as_company',
    'ship',
  ]);
});

// ---------------------------------------------------------------------------------------------
// Shared legal identity: an amendment revalidates both capabilities, never silently
// ---------------------------------------------------------------------------------------------
test('an identity amendment must answer every capability held, and revalidates each, with its own history entry', async () => {
  const { person, org } = await verifiedShipper();
  const carrierApp = await submitted(person, org, carrierBody());
  assert.equal((await decide(await reviewer(), carrierApp.id, 'verified')).status, 200);
  const proposed = {
    legalName: 'Renamed Fixture Group (fictional)',
    countryCode: 'XA',
    registrationNumber: newNumber(),
  };
  // The shipper's evidence alone does not answer the carrier capability.
  const short = await submit(person, org, { proposed });
  assert.equal(short.status, 422, short.text);
  assert.ok(
    codes(short).includes('evidence.haulage_licence.documentNumber:required'),
    codes(short).join(),
  );
  // An amendment cannot change the declared service at the same time.
  const mixed = await submit(person, org, {
    proposed,
    service: SERVICE,
    evidence: [...evidence(), carrierEvidence()[1]!],
  });
  assert.ok(codes(mixed).includes('proposed:amendment_only'), codes(mixed).join());
  const amendment = await submitted(person, org, {
    proposed,
    evidence: [...evidence(), carrierEvidence()[1]!],
  });
  assert.equal(amendment.kind, 'amendment');
  assert.deepEqual((amendment as unknown as { revalidates: string[] }).revalidates, [
    'carry_as_company',
    'ship',
  ]);
  // Under review, the approved identity stays in force for both, and the proposal gives nothing.
  let now = (await overview(person, org)) as CarrierOverview;
  assert.deepEqual(
    [now.organisation.legalName, now.mayPublish, now.mayDiscover],
    ['Fixture Shipper (fictional)', true, true],
  );
  // Approved: the identity changes and both capabilities are revalidated on it, in one step.
  const approved = await decide(await reviewer(), amendment.id, 'verified');
  assert.equal(approved.status, 200, approved.text);
  now = (await overview(person, org)) as CarrierOverview;
  assert.deepEqual(
    [now.organisation.legalName, now.mayPublish, now.mayDiscover],
    [proposed.legalName, true, true],
  );
  const grants = await owner.query<{ capability: string; granted_application: string }>(
    'SELECT capability, granted_application FROM trucker.organisation_capability WHERE organisation_id = $1 ORDER BY capability',
    [org],
  );
  assert.deepEqual(
    grants.rows.map((row) => row.granted_application),
    [amendment.id, amendment.id],
  );
  const revalidated = await owner.query<{
    capability: string;
    before_name: string;
    after_name: string;
  }>(
    `SELECT after_values ->> 'capability' AS capability, before_values ->> 'legalName' AS before_name,
            after_values ->> 'legalName' AS after_name
     FROM trucker.audit_entry WHERE organisation_id = $1 AND action = 'capability.revalidated'
     ORDER BY after_values ->> 'capability'`,
    [org],
  );
  assert.deepEqual(revalidated.rows, [
    {
      capability: 'carry_as_company',
      before_name: 'Fixture Shipper (fictional)',
      after_name: proposed.legalName,
    },
    {
      capability: 'ship',
      before_name: 'Fixture Shipper (fictional)',
      after_name: proposed.legalName,
    },
  ]);
  // The declared service was carried forward unchanged.
  assert.deepEqual((await capabilityOf(person, org, 'carry_as_company'))?.service?.countries, [
    'XA',
    'XB',
  ]);
});

test('a refused amendment changes neither capability; an identity changed outside an approved amendment carries neither', async () => {
  const { person, org } = await verifiedShipper();
  const carrierApp = await submitted(person, org, carrierBody());
  assert.equal((await decide(await reviewer(), carrierApp.id, 'verified')).status, 200);
  const amendment = await submitted(person, org, {
    proposed: {
      legalName: 'Refused Name (fictional)',
      countryCode: 'XA',
      registrationNumber: newNumber(),
    },
    evidence: [...evidence(), carrierEvidence()[1]!],
  });
  assert.equal((await decide(await reviewer(), amendment.id, 'rejected')).status, 200);
  let now = (await overview(person, org)) as CarrierOverview;
  assert.deepEqual(
    [now.organisation.legalName, now.mayPublish, now.mayDiscover],
    ['Fixture Shipper (fictional)', true, true],
  );
  assert.equal(
    await count('audit_entry', `organisation_id = $1 AND action = 'capability.revalidated'`, [org]),
    0,
  );
  // The legal identity changed directly by the migration role, bypassing review: neither
  // capability counts any more, because neither rests on the new identity.
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('trucker.acting_staff', $1, true)`, [
      (await reviewer()).id,
    ]);
    await client.query(
      `UPDATE trucker.organisation SET legal_name = 'Changed Without Review', version = version + 1, updated_at = now() WHERE id = $1`,
      [org],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  now = (await overview(person, org)) as CarrierOverview;
  assert.deepEqual([now.mayPublish, now.mayDiscover], [false, false]);
  assert.deepEqual(
    now.capabilities.map((item) => [item.capability, item.status, item.effective]),
    [
      ['carry_as_company', 'granted', false],
      ['ship', 'granted', false],
    ],
  );
  const listed = await list(person, org);
  assert.equal(listed.status, 403);
  assert.equal(listed.body.code, 'carrier_not_eligible');
});

// ---------------------------------------------------------------------------------------------
// CB-4: a changed declaration is decided before it is used
// ---------------------------------------------------------------------------------------------
test('a new declared service is decided by staff before discovery uses it; the same declaration again changes nothing', async () => {
  const shipper = await verifiedShipper();
  const toXb = await published(shipper.person, shipper.org);
  const carrier = await verifiedCarrier({ countries: ['XA'], equipmentTypes: ['curtain_side'] });
  assert.deepEqual(ids(await list(carrier.person, carrier.org)).includes(toXb.id), false);
  const same = await submit(
    carrier.person,
    carrier.org,
    carrierBody({ countries: ['XA'], equipmentTypes: ['curtain_side'] }),
  );
  assert.ok(codes(same).includes('service.countries:nothing_changed'), codes(same).join());
  const wider = await submitted(
    carrier.person,
    carrier.org,
    carrierBody({ countries: ['XA', 'XB'], equipmentTypes: ['curtain_side'] }),
  );
  assert.equal(wider.kind, 'capability');
  // Under review: the decided declaration stays in force.
  assert.equal(ids(await list(carrier.person, carrier.org)).includes(toXb.id), false);
  assert.equal((await decide(await reviewer(), wider.id, 'verified')).status, 200);
  assert.equal(ids(await list(carrier.person, carrier.org)).includes(toXb.id), true);
});

// ---------------------------------------------------------------------------------------------
// CAR-4, CAR-5, CAR-7: every condition, on its own, at every request
// ---------------------------------------------------------------------------------------------
test('a shipment is shown only while every eligibility condition holds; otherwise it answers like one that does not exist', async () => {
  const shipper = await verifiedShipper();
  const shipment = await published(shipper.person, shipper.org);
  const carrier = await verifiedCarrier();
  const seen = await list(carrier.person, carrier.org);
  assert.equal(seen.status, 200, seen.text);
  assert.ok(ids(seen).includes(shipment.id));
  assert.equal((await detailOf(carrier.person, carrier.org, shipment.id)).status, 200);
  const missing = randomUUID();
  const ghost = await detailOf(carrier.person, carrier.org, missing);
  assert.equal(ghost.status, 404);

  // Not matching what a carrier declared: countries, equipment.
  const narrowCountries = await verifiedCarrier({
    countries: ['XA'],
    equipmentTypes: ['curtain_side'],
  });
  const narrowEquipment = await verifiedCarrier({
    countries: ['XA', 'XB'],
    equipmentTypes: ['flatbed'],
  });
  for (const other of [narrowCountries, narrowEquipment]) {
    assert.equal(ids(await list(other.person, other.org)).includes(shipment.id), false);
    const answer = await detailOf(other.person, other.org, shipment.id);
    assert.deepEqual([answer.status, answer.body.code], [ghost.status, ghost.body.code]);
  }
  // Not a carrier at all, and the shipper itself: the same answer for a real shipment as for
  // a missing one, so nothing is learnt about which shipments exist.
  for (const who of [shipper, await newShipper()]) {
    const real = await detailOf(who.person, who.org, shipment.id);
    const none = await detailOf(who.person, who.org, missing);
    assert.equal(real.status, 403);
    assert.deepEqual([real.status, real.body.code], [none.status, none.body.code]);
    assert.equal((await list(who.person, who.org)).status, 403);
  }
  // Another person's organisation is not reachable by selecting it.
  const outsider = await newPerson();
  assert.equal((await list(outsider, carrier.org)).status, 404);

  // The route closes: gone at the next request, before anything is recorded about it.
  await owner.query(
    `UPDATE trucker.lane SET state = 'closed' WHERE origin_country = 'XA' AND destination_country = 'XB'`,
  );
  try {
    assert.equal(ids(await list(carrier.person, carrier.org)).includes(shipment.id), false);
    assert.equal((await detailOf(carrier.person, carrier.org, shipment.id)).status, 404);
  } finally {
    await owner.query(
      `UPDATE trucker.lane SET state = 'enabled' WHERE origin_country = 'XA' AND destination_country = 'XB'`,
    );
  }
  assert.equal(ids(await list(carrier.person, carrier.org)).includes(shipment.id), true);

  // The shipper's verification withdrawn: suspended, and gone.
  const second = await verifiedShipper();
  const suspendedOne = await published(second.person, second.org);
  assert.ok(ids(await list(carrier.person, carrier.org)).includes(suspendedOne.id));
  assert.equal((await revokeCapability(second.org, 'ship')).status, 200);
  assert.equal(ids(await list(carrier.person, carrier.org)).includes(suspendedOne.id), false);
  assert.equal((await detailOf(carrier.person, carrier.org, suspendedOne.id)).status, 404);

  // Withdrawn by the shipper: gone.
  const third = await published(shipper.person, shipper.org);
  assert.equal(
    (await act(shipper.person, shipper.org, third.id, 'withdraw', { version: third.version }))
      .status,
    200,
  );
  assert.equal(ids(await list(carrier.person, carrier.org)).includes(third.id), false);

  // Past its deadline by the clock, before any expiry is recorded: gone.
  const soon = await published(shipper.person, shipper.org, {
    quotationDeadline: { local: local(0.2) },
  });
  assert.ok(ids(await list(carrier.person, carrier.org)).includes(soon.id));
  await advance(13 * 60);
  const carrierAgain = await again(carrier.person);
  assert.equal(await entries(soon.id, 'shipment.expired'), 0);
  assert.equal(ids(await list(carrierAgain, carrier.org)).includes(soon.id), false);
  assert.equal((await detailOf(carrierAgain, carrier.org, soon.id)).status, 404);
  // Discovery records nothing about the shipment itself.
  assert.equal(await entries(soon.id, 'shipment.expired'), 0);

  // The carrier capability withdrawn: the next request is refused, list and detail alike.
  assert.equal((await revokeCapability(carrier.org, 'carry_as_company')).status, 200);
  assert.equal((await list(carrierAgain, carrier.org)).status, 403);
  assert.equal((await detailOf(carrierAgain, carrier.org, shipment.id)).status, 403);
});

test('an organisation holding both capabilities never discovers its own shipments', async () => {
  const both = await verifiedShipper();
  const app2 = await submitted(both.person, both.org, carrierBody());
  assert.equal((await decide(await reviewer(), app2.id, 'verified')).status, 200);
  const own = await published(both.person, both.org);
  const other = await verifiedShipper();
  const theirs = await published(other.person, other.org);
  const seen = ids(await list(both.person, both.org));
  assert.ok(seen.includes(theirs.id));
  assert.ok(!seen.includes(own.id));
  assert.equal((await detailOf(both.person, both.org, own.id)).status, 404);
});

// ---------------------------------------------------------------------------------------------
// CAR-6: exactly the approved projection, nothing else, anywhere
// ---------------------------------------------------------------------------------------------
test('a carrier sees exactly the approved projection of the latest version, and nothing that identifies the shipper', async () => {
  const shipper = await verifiedShipper({
    legalName: 'Secret Shipper Holdings (fictional)',
    registrationNumber: 'SECRET-REG-77',
  });
  const shipment = await published(shipper.person, shipper.org);
  const changed = await change(
    shipper.person,
    shipper.org,
    shipment,
    content({ grossWeightKg: '13000' }),
  );
  assert.equal(changed.status, 200, changed.text);
  const carrier = await verifiedCarrier();
  const preview = await call('GET', shipments(shipper.org, `/${shipment.id}/publication`), {
    token: shipper.person.token,
  });
  const projection =
    (preview.body as { carrierView?: Record<string, unknown> }).carrierView ??
    ((preview.body.publication as Record<string, unknown> | undefined)?.carrierView as Record<
      string,
      unknown
    >);
  const one = await detailOf(carrier.person, carrier.org, shipment.id);
  assert.equal(one.status, 200, one.text);
  const item = one.body.shipment as Item;
  assert.deepEqual(Object.keys(item).sort(), ['changedSinceStart', 'id', 'shipment']);
  const listed = items(await list(carrier.person, carrier.org)).find(
    (entry) => entry.id === shipment.id,
  )!;
  assert.deepEqual(Object.keys(listed).sort(), ['changedSinceStart', 'id', 'shipment']);
  // The same fields as the shipper's preview, of the latest version.
  assert.deepEqual(listed.shipment, item.shipment);
  if (projection)
    assert.deepEqual(Object.keys(item.shipment).sort(), Object.keys(projection).sort());
  assert.equal(item.shipment.publishedVersion, 2);
  assert.equal((item.shipment.cargo as { grossWeightKg: string }).grossWeightKg, '13000');
  assert.equal(item.shipment.shipper, 'verified_shipper');
  const secrets = [
    'Private Street',
    'Hidden Road',
    'Gate code',
    'REF-PRIVATE',
    '99977000',
    'Secret Shipper',
    'SECRET-REG-77',
    shipper.org,
    shipper.person.personId,
    shipper.person.phone,
  ];
  const pageText = (await list(carrier.person, carrier.org)).text;
  for (const text of [one.text, pageText])
    for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} reached a carrier`);
  // Nor through a cursor, a filter's refusal or an error.
  await owner.query('UPDATE trucker.security_setting SET discovery_page_size = 1');
  try {
    const first = await list(carrier.person, carrier.org);
    const cursor = first.body.next as string | null;
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      assert.deepEqual(Object.keys(decoded).sort(), ['a', 'd', 'f', 'i', 'o', 'v']);
      assert.equal(decoded.o, carrier.org);
      for (const secret of secrets) assert.ok(!JSON.stringify(decoded).includes(secret));
    }
    const badFilter = await list(carrier.person, carrier.org, { equipmentType: 'NOT VALID' });
    assert.equal(badFilter.status, 422);
    for (const secret of secrets) assert.ok(!badFilter.text.includes(secret));
  } finally {
    await owner.query('UPDATE trucker.security_setting SET discovery_page_size = 20');
  }
});

// ---------------------------------------------------------------------------------------------
// CAR-13: pagination, its snapshot and its cursor
// ---------------------------------------------------------------------------------------------
test('a list traversal keeps each shipment at the position it had when the list started; ineligible shipments disappear', async () => {
  const shipper = await verifiedShipper();
  // Five shipments, deadlines 3h to 7h ahead, on an equipment type only this test uses.
  const made: Shipment[] = [];
  for (let hours = 3; hours <= 7; hours += 1)
    made.push(
      await published(shipper.person, shipper.org, {
        equipmentType: 'box',
        quotationDeadline: { local: local(hours) },
      }),
    );
  const [s1, s2, s3, s4, s5] = made as [Shipment, Shipment, Shipment, Shipment, Shipment];
  const carrier = await verifiedCarrier({ countries: ['XA', 'XB'], equipmentTypes: ['box'] });
  await owner.query('UPDATE trucker.security_setting SET discovery_page_size = 2');
  try {
    const query = { equipmentType: 'box' };
    const page1 = await list(carrier.person, carrier.org, query);
    assert.deepEqual(ids(page1), [s1.id, s2.id]);
    const cursor = page1.body.next as string;
    assert.ok(cursor);
    // Time moves on between pages. (A version made at the traversal's very first instant
    // counts as already there.)
    await advance(1);
    // Between pages: s3's deadline moves after s5's, s5's moves before s1's, s4 is withdrawn,
    // and a new shipment is published with the earliest deadline of all.
    assert.equal(
      (
        await change(
          shipper.person,
          shipper.org,
          s3,
          content(),
          details({ equipmentType: 'box', quotationDeadline: { local: local(9) } }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await change(
          shipper.person,
          shipper.org,
          s5,
          content(),
          details({ equipmentType: 'box', quotationDeadline: { local: local(2) } }),
        )
      ).status,
      200,
    );
    assert.equal(
      (await act(shipper.person, shipper.org, s4.id, 'withdraw', { version: s4.version })).status,
      200,
    );
    const late = await published(shipper.person, shipper.org, {
      equipmentType: 'box',
      quotationDeadline: { local: local(1) },
    });
    const page2 = await list(carrier.person, carrier.org, { ...query, cursor });
    assert.equal(page2.status, 200, page2.text);
    // Original order kept: s3 then s5, each marked changed and showing its new deadline;
    // s4 gone; the newcomer sorts before the position reached and is not shown in this
    // traversal. No duplicate, no skip.
    assert.deepEqual(ids(page2), [s3.id, s5.id]);
    assert.deepEqual(
      items(page2).map((item) => item.changedSinceStart),
      [true, true],
    );
    const shownDeadline = items(page2)[0]!.shipment.quotationDeadline.at;
    const current = (await get(shipper.person, shipper.org, s3.id)).publication.quotationDeadline
      .at;
    assert.equal(new Date(shownDeadline).getTime(), new Date(current!).getTime());
    assert.equal(page2.body.next, null);
    const traversal = [...ids(page1), ...ids(page2)];
    assert.equal(new Set(traversal).size, traversal.length);
    // A new traversal orders by the deadlines as they are now, and includes the newcomer.
    assert.deepEqual(await everything(carrier.person, carrier.org, query), [
      late.id,
      s5.id,
      s1.id,
      s2.id,
      s3.id,
    ]);

    // A page from an earlier traversal still shows nothing that has stopped being eligible.
    const restart = await list(carrier.person, carrier.org, query);
    const next = restart.body.next as string;
    assert.equal(
      (
        await act(shipper.person, shipper.org, s1.id, 'withdraw', {
          version: (await get(shipper.person, shipper.org, s1.id)).version,
        })
      ).status,
      200,
    );
    const page = await list(carrier.person, carrier.org, { ...query, cursor: next });
    assert.ok(!ids(page).includes(s1.id));

    // A cursor belongs to one organisation, one filter, one traversal.
    const otherFilter = await list(carrier.person, carrier.org, {
      equipmentType: 'curtain_side',
      cursor: next,
    });
    assert.deepEqual([otherFilter.status, otherFilter.body.code], [400, 'cursor_invalid']);
    const someoneElse = await verifiedCarrier({ countries: ['XA', 'XB'], equipmentTypes: ['box'] });
    const borrowed = await list(someoneElse.person, someoneElse.org, { ...query, cursor: next });
    assert.deepEqual([borrowed.status, borrowed.body.code], [400, 'cursor_invalid']);
    const decoded = JSON.parse(Buffer.from(next, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(
      JSON.stringify({ ...decoded, a: new Date(clock().getTime() + 60_000).toISOString() }),
    ).toString('base64url');
    assert.equal(
      (await list(carrier.person, carrier.org, { ...query, cursor: forged })).status,
      400,
    );
    assert.equal(
      (await list(carrier.person, carrier.org, { ...query, cursor: 'bm90LWpzb24' })).status,
      400,
    );
    // Too old: refused, and a new list works.
    await advance(2 * 3600 + 60);
    const later = await again(carrier.person);
    const old = await list(later, carrier.org, { ...query, cursor: next });
    assert.deepEqual([old.status, old.body.code], [409, 'cursor_expired']);
    assert.equal((await list(later, carrier.org, query)).status, 200);
  } finally {
    await owner.query('UPDATE trucker.security_setting SET discovery_page_size = 20');
  }
});

test('a cursor kept from before a revocation gives nothing afterwards', async () => {
  const shipper = await verifiedShipper();
  await published(shipper.person, shipper.org);
  await published(shipper.person, shipper.org);
  const carrier = await verifiedCarrier();
  await owner.query('UPDATE trucker.security_setting SET discovery_page_size = 1');
  try {
    const first = await list(carrier.person, carrier.org);
    const next = first.body.next as string;
    assert.ok(next);
    assert.equal((await revokeCapability(carrier.org, 'carry_as_company')).status, 200);
    const reused = await list(carrier.person, carrier.org, { cursor: next });
    assert.deepEqual([reused.status, reused.body.code], [403, 'carrier_not_eligible']);
    assert.ok(!reused.text.includes('"items"'));
  } finally {
    await owner.query('UPDATE trucker.security_setting SET discovery_page_size = 20');
  }
});

// ---------------------------------------------------------------------------------------------
// CAR-7, CAR-8: requests delayed past a deadline or a revocation, and concurrent changes
// ---------------------------------------------------------------------------------------------
test('a request that waited while a deadline passed, or while its capability was withdrawn, answers as of the moment it proceeds', async () => {
  const shipper = await verifiedShipper();
  const soon = await published(shipper.person, shipper.org, {
    quotationDeadline: { local: local(0.2) },
  });
  const carrier = await verifiedCarrier();
  assert.ok(ids(await list(carrier.person, carrier.org)).includes(soon.id));
  const waitedList = await whileBlocked(
    ['SELECT 1 FROM trucker.organisation WHERE id = $1 FOR UPDATE', [carrier.org]],
    () => list(carrier.person, carrier.org),
    13 * 60,
  );
  assert.equal(waitedList.status, 200, waitedList.text);
  assert.ok(!ids(waitedList).includes(soon.id));
  const fresh2 = await again(carrier.person);
  const other = await published((shipper.person = await again(shipper.person)), shipper.org);
  assert.equal((await detailOf(fresh2, carrier.org, other.id)).status, 200);
  // Withdrawn while the request waited: refused once it proceeds.
  const admin = await administrator();
  const waitedDetail = await whileBlocked(
    [
      `WITH locked AS (SELECT id FROM trucker.organisation WHERE id = $1 FOR UPDATE)
       UPDATE trucker.organisation_capability c
       SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = 'verified_in_error'
       FROM locked WHERE c.organisation_id = locked.id AND c.capability = 'carry_as_company'`,
      [carrier.org, admin.id],
    ],
    () => detailOf(fresh2, carrier.org, other.id),
    1,
  );
  assert.deepEqual([waitedDetail.status, waitedDetail.body.code], [403, 'carrier_not_eligible']);
});

test('concurrent reads while a shipment is withdrawn and a capability is revoked give consistent answers and no server error', async () => {
  const shipper = await verifiedShipper();
  const target = await published(shipper.person, shipper.org);
  const carrier = await verifiedCarrier();
  const before2 = await count('carrier_access_log', 'organisation_id = $1', [carrier.org]);
  const reads = Array.from({ length: 12 }, (_, index) =>
    index % 2 === 0
      ? list(carrier.person, carrier.org)
      : detailOf(carrier.person, carrier.org, target.id),
  );
  const changes = [
    act(shipper.person, shipper.org, target.id, 'withdraw', { version: target.version }),
    revokeCapability(carrier.org, 'carry_as_company'),
  ];
  const replies = await Promise.all([...reads, ...changes]);
  for (const reply of replies)
    assert.ok([200, 403, 404].includes(reply.status), `${reply.status} ${reply.text}`);
  // Each answer is one of the consistent ones: shown while everything held, not otherwise.
  for (const reply of replies.slice(0, 12)) {
    if (reply.status === 200 && Array.isArray(reply.body.items)) continue;
    if (reply.status === 200) assert.equal((reply.body.shipment as Item).id, target.id);
  }
  assert.equal(await entries(target.id, 'shipment.withdrawn'), 1);
  // Every read that reached the carrier check left one log entry, never two.
  const logged = await count('carrier_access_log', 'organisation_id = $1', [carrier.org]);
  assert.ok(logged - before2 <= 12, `${logged - before2} entries for 12 reads`);
  assert.equal((await list(carrier.person, carrier.org)).status, 403);
});

// ---------------------------------------------------------------------------------------------
// CB-7: the access log
// ---------------------------------------------------------------------------------------------
test('carrier reads are logged for staff only, append-only, by identifier and codes, never by content', async () => {
  const shipper = await verifiedShipper();
  const shipment = await published(shipper.person, shipper.org);
  const carrier = await verifiedCarrier();
  const listed = await list(carrier.person, carrier.org, { pickupCountry: 'XA' });
  assert.equal(listed.status, 200);
  assert.equal((await detailOf(carrier.person, carrier.org, shipment.id)).status, 200);
  const missing = randomUUID();
  assert.equal((await detailOf(carrier.person, carrier.org, missing)).status, 404);
  const rows = await logRows(carrier.org);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.outcome]),
    [
      ['list', 'shown'],
      ['detail', 'shown'],
      ['detail', 'not_found'],
    ],
  );
  assert.ok(rows[0]!.shown.includes(shipment.id));
  assert.deepEqual(rows[0]!.filter, { pickupCountry: 'XA' });
  assert.equal(rows[2]!.shipment_id, missing);
  const raw = JSON.stringify(
    (
      await owner.query('SELECT * FROM trucker.carrier_access_log WHERE organisation_id = $1', [
        carrier.org,
      ])
    ).rows,
  );
  for (const secret of [
    'Ceramic',
    'Private Street',
    'Hidden Road',
    'North industrial',
    'Port district',
    'Gate code',
  ])
    assert.ok(!raw.includes(secret), `${secret} copied into the access log`);
  // Append-only, even for the migration role.
  await refused(
    () => owner.query('UPDATE trucker.carrier_access_log SET outcome = $1', ['refused']),
    /cannot be changed or removed/,
  );
  await refused(
    () => owner.query('DELETE FROM trucker.carrier_access_log'),
    /cannot be changed or removed/,
  );
  await refused(
    () => owner.query('TRUNCATE trucker.carrier_access_log'),
    /cannot be changed or removed/,
  );
  // The API role can neither read nor write it.
  await asApiRole(
    { tokenHash: hashToken(carrier.person.token), organisationId: carrier.org },
    async (client) => {
      await refused(
        () => client.query('SELECT * FROM trucker.carrier_access_log'),
        /permission denied/,
      );
    },
  );
  await asApiRole(
    { tokenHash: hashToken(carrier.person.token), organisationId: carrier.org },
    async (client) => {
      await refused(
        () =>
          client.query(
            `INSERT INTO trucker.carrier_access_log (occurred_at, organisation_id, person_id, kind, outcome) VALUES (now(), $1, $2, 'list', 'shown')`,
            [carrier.org, carrier.person.personId],
          ),
        /permission denied/,
      );
    },
  );
  // Staff with a review privilege read it, and each look is recorded; others cannot.
  const staff = await reviewer();
  const read = await call('GET', `/staff/shipments/${shipment.id}/carrier-access`, {
    token: staff.token,
  });
  assert.equal(read.status, 200, read.text);
  const entriesRead = read.body.entries as { kind: string; organisation: { id: string } }[];
  assert.ok(
    entriesRead.some((entry) => entry.organisation.id === carrier.org && entry.kind === 'detail'),
  );
  assert.ok(
    (await staffAudit(staff, 'staff.carrier_access_view')).some(
      (entry) => entry.outcome === 'done',
    ),
  );
  const nobody = await newStaff([]);
  const denied = await call('GET', `/staff/shipments/${shipment.id}/carrier-access`, {
    token: nobody.token,
  });
  assert.equal(denied.status, 403);
  assert.ok(
    (await staffAudit(nobody, 'staff.carrier_access_view')).some(
      (entry) => entry.outcome === 'refused',
    ),
  );
  // The shipper has no route to it: its own shipment answers nothing about who looked.
  const shipperView = await call('GET', shipments(shipper.org, `/${shipment.id}`), {
    token: shipper.person.token,
  });
  assert.ok(!shipperView.text.includes(carrier.org));
  assert.ok(!shipperView.text.includes('Fixture Carrier'));
});

test('the read limit is enforced by the database and the refusal is logged', async () => {
  const carrier = await verifiedCarrier();
  await owner.query('UPDATE trucker.security_setting SET discovery_read_limit = 3');
  try {
    for (let index = 0; index < 3; index += 1)
      assert.equal((await list(carrier.person, carrier.org)).status, 200);
    const limited = await list(carrier.person, carrier.org);
    assert.deepEqual([limited.status, limited.body.code], [429, 'too_many_requests']);
    assert.deepEqual((await logRows(carrier.org)).at(-1), {
      kind: 'list',
      outcome: 'refused',
      shipment_id: null,
      shown: [],
      filter: {},
      reason: 'rate_limited',
    });
    await advance(61);
    assert.equal((await list(await again(carrier.person), carrier.org)).status, 200);
  } finally {
    await owner.query('UPDATE trucker.security_setting SET discovery_read_limit = 120');
  }
});

test('discovery answers are never to be stored by a cache', async () => {
  const carrier = await verifiedCarrier();
  for (const path of ['', '/shipments', `/shipments/${randomUUID()}`]) {
    const response = await fetch(base + discoveryRoute(carrier.org, path), {
      headers: { authorization: `Bearer ${carrier.person.token}` },
    });
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
    assert.match(response.headers.get('vary') ?? '', /Authorization/i, path);
    await response.text();
  }
});

test("the API's role reaches discovery only through its functions", async () => {
  const carrier = await verifiedCarrier();
  const shipper = await verifiedShipper();
  const shipment = await published(shipper.person, shipper.org);
  await asApiRole(
    { tokenHash: hashToken(carrier.person.token), organisationId: carrier.org },
    async (client) => {
      // Another organisation's shipment rows, versions and declarations are invisible.
      const rows = await client.query('SELECT id FROM trucker.shipment_draft WHERE id = $1', [
        shipment.id,
      ]);
      assert.equal(rows.rowCount, 0);
      const versions = await client.query(
        'SELECT 1 FROM trucker.shipment_publication_version WHERE shipment_id = $1',
        [shipment.id],
      );
      assert.equal(versions.rowCount, 0);
      const declarations = await client.query(
        `SELECT 1 FROM trucker.carrier_service_country s JOIN trucker.verification_application a ON a.id = s.application_id
       WHERE a.organisation_id <> $1`,
        [carrier.org],
      );
      assert.equal(declarations.rowCount, 0);
    },
  );
  for (const statement of [
    'SELECT trucker.discovery_enter()',
    'SELECT trucker.capability_effective(gen_random_uuid(), $$ship$$)',
    'SELECT trucker.carrier_service(gen_random_uuid())',
  ])
    await asApiRole(
      { tokenHash: hashToken(carrier.person.token), organisationId: carrier.org },
      async (client) => {
        await refused(() => client.query(statement), /permission denied/);
      },
    );
});
