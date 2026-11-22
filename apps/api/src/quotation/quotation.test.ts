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

// Quotations (slice 12). Real PostgreSQL, the API connected as its
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
let adminCounter: Staff | undefined;
const administrator = async (): Promise<Staff> =>
  fresh(adminCounter ?? (adminCounter = await newStaff(['staff_admin'])));
const revokeCapability = async (org: string, capability: string): Promise<Reply> =>
  call('POST', `/staff/verification/organisations/${org}/revoke`, {
    token: (await administrator()).token,
    body: { capability, reason: 'verified_in_error', noConflict: true },
  });

// ---------------------------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------------------------
const INCLUSIONS = ['fictional_item_1', 'fictional_item_2', 'fictional_item_3'];
const answers = (included = true): Record<string, boolean> =>
  Object.fromEntries(INCLUSIONS.map((code, index) => [code, index === 0 ? included : !included]));
const quoteBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  amount: '1250.50',
  inclusions: answers(),
  validUntil: { local: local(12) },
  earliestPickup: { local: local(48.5) },
  notes: 'Two drivers available (fictional)',
  ...over,
});
interface QVersion {
  versionNo: number;
  kind: string;
  amount: string;
  currency: string;
  inclusions: Record<string, boolean>;
  shipmentVersion: number;
  validUntil: { at: string };
}
interface Quotation {
  id: string;
  status: string;
  standing: string;
  currentVersion: number;
  reconfirmationNeeded: boolean;
  closedReason: string | null;
  versions: QVersion[];
  carrier?: { id: string; legalName: string; verified: boolean };
}
const termsRoute = (org: string, shipment: string) =>
  shipments(org, `/${shipment}/quotation-terms`);
async function setTerms(
  person: Person,
  org: string,
  shipment: string,
  currency = 'XTS',
  version = 0,
) {
  return call('POST', termsRoute(org, shipment), {
    token: person.token,
    key: key(),
    body: { version, currency },
  });
}
const quote = (person: Person, org: string, shipment: string, body = quoteBody(), retry = key()) =>
  call('POST', `/organisations/${org}/discovery/shipments/${shipment}/quotations`, {
    token: person.token,
    key: retry,
    body,
  });
const carrierAct = (
  person: Person,
  org: string,
  quotation: string,
  action: 'revisions' | 'reconfirm' | 'withdraw',
  body: Record<string, unknown>,
  retry = key(),
) =>
  call('POST', `/organisations/${org}/quotations/${quotation}/${action}`, {
    token: person.token,
    key: retry,
    body,
  });
const reject = (person: Person, org: string, quotation: string, version: number, retry = key()) =>
  call('POST', `/organisations/${org}/quotations/${quotation}/reject`, {
    token: person.token,
    key: retry,
    body: { version },
  });
async function shipperView(person: Person, org: string, shipment: string) {
  const reply = await call('GET', shipments(org, `/${shipment}/quotations`), {
    token: person.token,
  });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.quotations as {
    terms: {
      currency: string;
      inclusions: { code: string }[];
      locked: boolean;
      version: number;
    } | null;
    quotations: Quotation[];
    currencyChoices: { code: string }[];
  };
}
async function mine(person: Person, org: string): Promise<Quotation[]> {
  const reply = await call('GET', `/organisations/${org}/quotations`, { token: person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.quotations as Quotation[];
}
const mineOne = async (person: Person, org: string, id: string): Promise<Quotation> =>
  (await mine(person, org)).find((item) => item.id === id)!;
/** A published shipment with its quotation terms set, and a carrier that can see it. */
async function market() {
  const shipper = await verifiedShipper();
  const shipment = await published(shipper.person, shipper.org);
  const terms = await setTerms(shipper.person, shipper.org, shipment.id);
  assert.equal(terms.status, 200, terms.text);
  const carrier = await verifiedCarrier();
  return { shipper, shipment, carrier };
}
async function quoted(person: Person, org: string, shipment: string, body = quoteBody()) {
  const reply = await quote(person, org, shipment, body);
  assert.equal(reply.status, 201, reply.text);
  return reply.body.quotation as Quotation;
}

// ---------------------------------------------------------------------------------------------
// Registers and terms (QB-3, QB-4)
// ---------------------------------------------------------------------------------------------
test('after the migrations no currency or inclusion exists, and none can be added outside a marked database', async () => {
  const scratch = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: scratch.url });
  try {
    await migrateUp(pool, defaultMigrationsDir());
    for (const table of [
      'currency',
      'country_currency',
      'quotation_inclusion',
      'quotation',
      'shipment_quotation_terms',
    ])
      assert.equal(
        (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trucker.${table}`))
          .rows[0]!.n,
        0,
        table,
      );
    await refused(
      () =>
        pool.query(
          `INSERT INTO trucker.currency (code, minor_units, name_en) VALUES ('XTS', 2, 'Test')`,
        ),
      /fictional and allowed only/,
    );
    await refused(
      () =>
        pool.query(
          `INSERT INTO trucker.quotation_inclusion (code, name_en, name_ar, name_ur) VALUES ('x_item', 'X', 'X', 'X')`,
        ),
      /fictional and allowed only/,
    );
  } finally {
    await pool.end();
    await scratch.drop();
  }
});

test('the shipper sets one currency per shipment with every inclusion of the register; the terms lock once a quotation exists', async () => {
  const shipper = await verifiedShipper();
  const shipment = await published(shipper.person, shipper.org);
  const carrier = await verifiedCarrier();
  // No terms yet: a carrier cannot quote.
  const early = await quote(carrier.person, carrier.org, shipment.id);
  assert.deepEqual([early.status, early.body.code], [409, 'quotation_terms_missing']);
  const view = await shipperView(shipper.person, shipper.org, shipment.id);
  assert.deepEqual(
    view.currencyChoices.map((item) => item.code),
    ['XTS'],
  );
  // A currency not configured for the pick-up country is refused.
  const wrong = await setTerms(shipper.person, shipper.org, shipment.id, 'EUR');
  assert.equal(wrong.status, 422);
  assert.ok(codes(wrong).includes('currency:unavailable'));
  const retry = key();
  const first = await call('POST', termsRoute(shipper.org, shipment.id), {
    token: shipper.person.token,
    key: retry,
    body: { version: 0, currency: 'XTS' },
  });
  assert.equal(first.status, 200, first.text);
  const again2 = await call('POST', termsRoute(shipper.org, shipment.id), {
    token: shipper.person.token,
    key: retry,
    body: { version: 0, currency: 'XTS' },
  });
  assert.equal(again2.body.outcome, 'already_set');
  const terms = (await shipperView(shipper.person, shipper.org, shipment.id)).terms!;
  assert.deepEqual([terms.currency, terms.version, terms.locked], ['XTS', 1, false]);
  assert.deepEqual(
    terms.inclusions.map((item) => item.code),
    INCLUSIONS,
  );
  // A stale terms version is refused.
  assert.equal((await setTerms(shipper.person, shipper.org, shipment.id, 'XTS', 0)).status, 409);
  // Once a quotation exists, even withdrawn, the terms cannot change.
  const q = await quoted(carrier.person, carrier.org, shipment.id);
  assert.equal(
    (await carrierAct(carrier.person, carrier.org, q.id, 'withdraw', { version: 1 })).status,
    200,
  );
  const locked = await setTerms(shipper.person, shipper.org, shipment.id, 'XTS', 1);
  assert.deepEqual([locked.status, locked.body.code], [409, 'quotation_terms_locked']);
  assert.equal((await shipperView(shipper.person, shipper.org, shipment.id)).terms!.locked, true);
  // Another organisation cannot set terms on it.
  const other = await verifiedShipper();
  assert.equal((await setTerms(other.person, other.org, shipment.id)).status, 404);
});

// ---------------------------------------------------------------------------------------------
// QUO-4: exact amounts and complete, comparable answers
// ---------------------------------------------------------------------------------------------
test('amounts are exact decimals within the currency precision, every inclusion is answered, and times are checked; problems are reported by field', async () => {
  const { shipment, carrier } = await market();
  const bad = await quote(carrier.person, carrier.org, shipment.id, {
    amount: '12,50',
    inclusions: { fictional_item_1: true, not_an_item: false },
    validUntil: { local: local(30) },
    earliestPickup: { local: local(60) },
  });
  assert.equal(bad.status, 422, bad.text);
  assert.deepEqual(codes(bad).sort(), [
    'amount:invalid',
    'earliestPickup:outside_window',
    'inclusions.fictional_item_2:required',
    'inclusions.fictional_item_3:required',
    'inclusions:unknown',
    'validUntil:after_deadline',
  ]);
  const precise = await quote(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ amount: '10.125' }),
  );
  assert.ok(codes(precise).includes('amount:precision'));
  const zero = await quote(carrier.person, carrier.org, shipment.id, quoteBody({ amount: '0' }));
  assert.ok(codes(zero).includes('amount:not_positive'));
  const soon = await quote(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ validUntil: { local: local(0.1) } }),
  );
  assert.ok(codes(soon).includes('validUntil:too_soon'));
  const numeric = await quote(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ amount: 1250.5 }),
  );
  assert.equal(numeric.status, 422, 'an amount sent as a binary number is refused');
  assert.equal(await count('quotation', 'carrier_organisation_id = $1', [carrier.org]), 0);
  // The largest amount is kept exactly, never rounded through a binary number.
  const big = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ amount: '999999999999.99' }),
  );
  assert.equal(big.versions[0]!.amount, '999999999999.99');
  const stored = await owner.query<{ amount: string }>(
    'SELECT amount::text AS amount FROM trucker.quotation_version WHERE quotation_id = $1',
    [big.id],
  );
  assert.equal(stored.rows[0]!.amount, '999999999999.99');
  // A whole amount is shown with the currency's minor units, not changed.
  const revised = await carrierAct(carrier.person, carrier.org, big.id, 'revisions', {
    ...quoteBody({ amount: '1250' }),
    version: 1,
  });
  assert.equal((revised.body.quotation as Quotation).versions[0]!.amount, '1250.00');
});

test('every quotation on a shipment answers the same inclusions, the shipper sees each carrier by name, and carriers never see one another', async () => {
  const { shipper, shipment, carrier } = await market();
  const second = await verifiedCarrier();
  const a = await quoted(carrier.person, carrier.org, shipment.id, quoteBody({ amount: '900' }));
  const b = await quoted(
    second.person,
    second.org,
    shipment.id,
    quoteBody({ amount: '875.25', inclusions: answers(false) }),
  );
  const view = await shipperView(shipper.person, shipper.org, shipment.id);
  assert.equal(view.quotations.length, 2);
  for (const q of view.quotations) {
    assert.deepEqual(Object.keys(q.versions[0]!.inclusions).sort(), [...INCLUSIONS].sort());
    assert.equal(q.versions[0]!.currency, 'XTS');
    assert.equal(q.carrier!.legalName, 'Fixture Carrier (fictional)');
    assert.equal(q.carrier!.verified, true);
    assert.equal(q.standing, 'current');
  }
  // Each carrier sees only its own: in its list, in the shipment's quotation context, and by id.
  assert.deepEqual(
    (await mine(carrier.person, carrier.org)).map((q) => q.id),
    [a.id],
  );
  const context = await call(
    'GET',
    `/organisations/${second.org}/discovery/shipments/${shipment.id}/quotation`,
    {
      token: second.person.token,
    },
  );
  assert.equal(context.status, 200, context.text);
  assert.ok(!context.text.includes(a.id) && !context.text.includes('"900.00"'));
  const theirs = await carrierAct(second.person, second.org, a.id, 'withdraw', { version: 1 });
  assert.equal(theirs.status, 404);
  // Nobody else reads the shipment's quotations.
  const outsider = await verifiedShipper();
  const peek = await call('GET', shipments(outsider.org, `/${shipment.id}/quotations`), {
    token: outsider.person.token,
  });
  assert.equal(peek.status, 404);
  assert.ok(!peek.text.includes(b.id));
  // The shipper's reads are logged, by identifier only.
  const log = await owner.query<{ shown: string[] }>(
    'SELECT shown FROM trucker.quotation_read_log WHERE shipment_id = $1 ORDER BY id DESC LIMIT 1',
    [shipment.id],
  );
  assert.deepEqual([...log.rows[0]!.shown].sort(), [a.id, b.id].sort());
});

// ---------------------------------------------------------------------------------------------
// QUO-3, QUO-9: one open quotation, retries, concurrency
// ---------------------------------------------------------------------------------------------
test('one open quotation per carrier and shipment, under simultaneous requests too; retries apply once', async () => {
  const { shipment, carrier } = await market();
  const retry = key();
  const first = await quote(carrier.person, carrier.org, shipment.id, quoteBody(), retry);
  assert.equal(first.status, 201, first.text);
  const repeat = await quote(carrier.person, carrier.org, shipment.id, quoteBody(), retry);
  assert.deepEqual([repeat.status, repeat.body.outcome], [201, 'already_submitted']);
  const changedBody = await quote(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ amount: '1' }),
    retry,
  );
  assert.deepEqual([changedBody.status, changedBody.body.code], [409, 'retry_key_conflict']);
  const second = await quote(carrier.person, carrier.org, shipment.id);
  assert.deepEqual([second.status, second.body.code], [409, 'quotation_exists']);
  // Simultaneously, from another carrier: exactly one.
  const other = await verifiedCarrier();
  const replies = await Promise.all(
    Array.from({ length: 5 }, () => quote(other.person, other.org, shipment.id)),
  );
  assert.equal(replies.filter((reply) => reply.status === 201).length, 1);
  for (const reply of replies) assert.ok([201, 409].includes(reply.status), reply.text);
  assert.equal(
    await count('quotation', `carrier_organisation_id = $1 AND status = 'submitted'`, [other.org]),
    1,
  );
  // A withdrawal sent twice withdraws once; a stale version is refused.
  const q = first.body.quotation as Quotation;
  const stale = await carrierAct(carrier.person, carrier.org, q.id, 'withdraw', { version: 2 });
  assert.equal(stale.status, 409);
  const wRetry = key();
  const w1 = await carrierAct(
    carrier.person,
    carrier.org,
    q.id,
    'withdraw',
    { version: 1 },
    wRetry,
  );
  const w2 = await carrierAct(
    carrier.person,
    carrier.org,
    q.id,
    'withdraw',
    { version: 1 },
    wRetry,
  );
  assert.deepEqual([w1.body.outcome, w2.body.outcome], ['withdrawn', 'already_withdrawn']);
  assert.equal(await entries(q.id, 'quotation.withdrawn'), 1);
  // A new quotation after withdrawal is allowed.
  assert.equal((await quote(carrier.person, carrier.org, shipment.id)).status, 201);
});

// ---------------------------------------------------------------------------------------------
// QUO-5: versions
// ---------------------------------------------------------------------------------------------
test('a revision is a new version; earlier versions stay; the version limit and "nothing changed" are enforced', async () => {
  const { shipper, shipment, carrier } = await market();
  const q = await quoted(carrier.person, carrier.org, shipment.id);
  const same = await carrierAct(carrier.person, carrier.org, q.id, 'revisions', {
    ...quoteBody(),
    version: 1,
  });
  assert.ok(codes(same).includes('amount:nothing_changed'));
  const r = await carrierAct(carrier.person, carrier.org, q.id, 'revisions', {
    ...quoteBody({ amount: '1100.00' }),
    version: 1,
  });
  assert.equal(r.status, 200, r.text);
  const now = r.body.quotation as Quotation;
  assert.deepEqual(
    [now.currentVersion, now.versions.map((v) => [v.versionNo, v.kind, v.amount])],
    [
      2,
      [
        [2, 'revised', '1100.00'],
        [1, 'submitted', '1250.50'],
      ],
    ],
  );
  const versions = await owner.query(
    'SELECT 1 FROM trucker.quotation_version WHERE quotation_id = $1',
    [q.id],
  );
  assert.equal(versions.rowCount, 2);
  await refused(
    () =>
      owner.query(`UPDATE trucker.quotation_version SET amount = 1 WHERE quotation_id = $1`, [
        q.id,
      ]),
    /cannot be changed or removed/,
  );
  const stale = await carrierAct(carrier.person, carrier.org, q.id, 'revisions', {
    ...quoteBody({ amount: '5' }),
    version: 1,
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'quotation_changed']);
  await owner.query('UPDATE trucker.security_setting SET quotation_version_limit = 2');
  try {
    const over = await carrierAct(carrier.person, carrier.org, q.id, 'revisions', {
      ...quoteBody({ amount: '5' }),
      version: 2,
    });
    assert.deepEqual([over.status, over.body.code], [409, 'quotation_limit']);
  } finally {
    await owner.query('UPDATE trucker.security_setting SET quotation_version_limit = 5');
  }
  // The shipper sees the latest as current, with the earlier one kept.
  const seen = (await shipperView(shipper.person, shipper.org, shipment.id)).quotations[0]!;
  assert.deepEqual([seen.currentVersion, seen.versions.length], [2, 2]);
});

// ---------------------------------------------------------------------------------------------
// QUO-6: expiry without a worker, once, not paused by anything
// ---------------------------------------------------------------------------------------------
test('a quotation expires at its validity by the clock, recorded once, including for a request that waited past it', async () => {
  const { shipper, shipment, carrier } = await market();
  const q = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ validUntil: { local: local(0.3) } }),
  );
  const validity = q.versions[0]!.validUntil.at;
  // A revision that waited behind the carrier's lock while the validity passed is refused.
  const waited = await whileBlocked(
    ['SELECT 1 FROM trucker.organisation WHERE id = $1 FOR UPDATE', [carrier.org]],
    () =>
      carrierAct(carrier.person, carrier.org, q.id, 'revisions', {
        ...quoteBody({ amount: '1' }),
        version: 1,
      }),
    19 * 60,
  );
  assert.deepEqual([waited.status, waited.body.code], [409, 'quotation_not_open']);
  const carrier2 = await again(carrier.person);
  const shipper2 = await again(shipper.person);
  await Promise.all([
    ...Array.from({ length: 4 }, () => mine(carrier2, carrier.org)),
    shipperView(shipper2, shipper.org, shipment.id),
  ]);
  assert.equal(await entries(q.id, 'quotation.expired'), 1);
  const record = await owner.query<{ occurred_at: Date; actor_person_id: string | null }>(
    `SELECT occurred_at, actor_person_id FROM trucker.audit_entry WHERE record_id = $1 AND action = 'quotation.expired'`,
    [q.id],
  );
  assert.equal(record.rows[0]!.occurred_at.toISOString(), new Date(validity).toISOString());
  assert.equal(record.rows[0]!.actor_person_id, null);
  assert.equal((await mineOne(carrier2, carrier.org, q.id)).status, 'expired');
  // Cannot be revived; a new quotation is a new record.
  assert.equal(
    (await carrierAct(carrier2, carrier.org, q.id, 'withdraw', { version: 1 })).status,
    409,
  );
  assert.equal((await quote(carrier2, carrier.org, shipment.id)).status, 201);
});

// ---------------------------------------------------------------------------------------------
// QUO-7: material changes and reconfirmation
// ---------------------------------------------------------------------------------------------
test('a material change marks open quotations for reconfirmation once per shipment version; a reconfirmation keeps the values; a shortened deadline needs a revision', async () => {
  const { shipper, shipment, carrier } = await market();
  const q = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ validUntil: { local: local(12) } }),
  );
  assert.equal(
    (await carrierAct(carrier.person, carrier.org, q.id, 'reconfirm', { version: 1 })).body.code,
    'reconfirmation_not_needed',
  );
  const changed = await change(
    shipper.person,
    shipper.org,
    shipment,
    content({ grossWeightKg: '13000' }),
  );
  assert.equal(changed.status, 200, changed.text);
  let now = await mineOne(carrier.person, carrier.org, q.id);
  assert.deepEqual([now.standing, now.reconfirmationNeeded], ['needs_reconfirmation', true]);
  assert.equal(await entries(q.id, 'quotation.reconfirmation_required'), 1);
  // A minor change does not ask again.
  const after1 = await get(shipper.person, shipper.org, shipment.id);
  const minor = await change(
    shipper.person,
    shipper.org,
    after1,
    content({ grossWeightKg: '13000', shipperReference: 'REF-NEW' }),
  );
  assert.equal(minor.status, 200, minor.text);
  assert.equal(await entries(q.id, 'quotation.reconfirmation_required'), 1);
  const ok = await carrierAct(carrier.person, carrier.org, q.id, 'reconfirm', { version: 1 });
  assert.equal(ok.status, 200, ok.text);
  now = ok.body.quotation as Quotation;
  assert.deepEqual(
    [now.currentVersion, now.standing, now.versions[0]!.kind, now.versions[0]!.amount],
    [2, 'current', 'reconfirmed', '1250.50'],
  );
  assert.equal(now.versions[0]!.shipmentVersion, 2);
  // The deadline moved before the validity: reconfirming is not enough.
  const after2 = await get(shipper.person, shipper.org, shipment.id);
  const shorter = await change(
    shipper.person,
    shipper.org,
    after2,
    content({ grossWeightKg: '13000' }),
    details({ quotationDeadline: { local: local(6) } }),
  );
  assert.equal(shorter.status, 200, shorter.text);
  assert.equal(await entries(q.id, 'quotation.reconfirmation_required'), 2);
  const notEnough = await carrierAct(carrier.person, carrier.org, q.id, 'reconfirm', {
    version: 2,
  });
  assert.deepEqual([notEnough.status, notEnough.body.code], [409, 'revision_required']);
  const revised = await carrierAct(carrier.person, carrier.org, q.id, 'revisions', {
    ...quoteBody({ validUntil: { local: local(5) } }),
    version: 2,
  });
  assert.equal(revised.status, 200, revised.text);
  assert.equal((revised.body.quotation as Quotation).standing, 'current');
});

// ---------------------------------------------------------------------------------------------
// QUO-8: suspension freezes without pausing expiry; resumption rechecks everything
// ---------------------------------------------------------------------------------------------
test('suspension freezes quotations without pausing expiry; on resumption each is judged again for eligibility, validity and reconfirmation', async () => {
  const shipper = await verifiedShipper();
  const shipment = await published(shipper.person, shipper.org);
  assert.equal((await setTerms(shipper.person, shipper.org, shipment.id)).status, 200);
  const shortLived = await verifiedCarrier();
  const longLived = await verifiedCarrier();
  const leaving = await verifiedCarrier();
  const a = await quoted(
    shortLived.person,
    shortLived.org,
    shipment.id,
    quoteBody({ validUntil: { local: local(0.4) } }),
  );
  const b = await quoted(
    longLived.person,
    longLived.org,
    shipment.id,
    quoteBody({ validUntil: { local: local(12) } }),
  );
  const c = await quoted(
    leaving.person,
    leaving.org,
    shipment.id,
    quoteBody({ validUntil: { local: local(12) } }),
  );
  // Suspended: the shipper's verification withdrawn.
  assert.equal((await revokeCapability(shipper.org, 'ship')).status, 200);
  for (const [who, q] of [
    [longLived, b],
    [leaving, c],
  ] as const) {
    const now = await mineOne(who.person, who.org, q.id);
    assert.equal(now.standing, 'shipment_suspended');
    const frozen = await carrierAct(who.person, who.org, q.id, 'revisions', {
      ...quoteBody({ amount: '1' }),
      version: 1,
    });
    assert.deepEqual([frozen.status, frozen.body.code], [409, 'shipment_suspended']);
  }
  // Time passes during the suspension: the short-lived quotation expires on time.
  await advance(25 * 60);
  const s2 = await again(shortLived.person);
  assert.equal((await mineOne(s2, shortLived.org, a.id)).status, 'expired');
  // One carrier loses its capability meanwhile.
  assert.equal((await revokeCapability(leaving.org, 'carry_as_company')).status, 200);
  // Resumed: the shipper verified again.
  const shipper2 = await again(shipper.person);
  const reapplied = await submitted(shipper2, shipper.org);
  assert.equal((await decide(await reviewer(), reapplied.id, 'verified')).status, 200);
  const view = await shipperView(shipper2, shipper.org, shipment.id);
  const standing = Object.fromEntries(view.quotations.map((q) => [q.id, q.standing]));
  assert.deepEqual(standing, {
    [a.id]: 'expired',
    [b.id]: 'current',
    [c.id]: 'carrier_not_eligible',
  });
  // The expired one stays expired; the current one can be changed again.
  const l2 = await again(longLived.person);
  const thawed = await carrierAct(l2, longLived.org, b.id, 'revisions', {
    ...quoteBody({ amount: '1000' }),
    version: 1,
  });
  assert.equal(thawed.status, 200, thawed.text);
  assert.equal(await entries(a.id, 'quotation.expired'), 1);
});

// ---------------------------------------------------------------------------------------------
// QB-10: withdrawn shipments; rejection
// ---------------------------------------------------------------------------------------------
test('withdrawing the shipment closes open quotations once; the shipper may reject an open one', async () => {
  const { shipper, shipment, carrier } = await market();
  const second = await verifiedCarrier();
  const q1 = await quoted(carrier.person, carrier.org, shipment.id);
  const q2 = await quoted(second.person, second.org, shipment.id);
  // Rejection: once, by the shipper only, against the current version.
  assert.equal((await reject(carrier.person, carrier.org, q2.id, 1)).status, 404);
  assert.equal((await reject(shipper.person, shipper.org, q2.id, 2)).status, 409);
  const rRetry = key();
  const r1 = await reject(shipper.person, shipper.org, q2.id, 1, rRetry);
  const r2 = await reject(shipper.person, shipper.org, q2.id, 1, rRetry);
  assert.deepEqual([r1.body.outcome, r2.body.outcome], ['rejected', 'already_rejected']);
  assert.equal((await mineOne(second.person, second.org, q2.id)).status, 'rejected');
  const current = await get(shipper.person, shipper.org, shipment.id);
  assert.equal(
    (await act(shipper.person, shipper.org, shipment.id, 'withdraw', { version: current.version }))
      .status,
    200,
  );
  const closed = await mineOne(carrier.person, carrier.org, q1.id);
  assert.deepEqual([closed.status, closed.closedReason], ['closed', 'shipment_withdrawn']);
  assert.equal(await entries(q1.id, 'quotation.closed'), 1);
  assert.equal(await entries(q2.id, 'quotation.closed'), 0);
  // Nothing more can be quoted on it.
  const late = await quote((await verifiedCarrier()).person, carrier.org, shipment.id);
  assert.ok([403, 404].includes(late.status), late.text);
});

// ---------------------------------------------------------------------------------------------
// QUO-1, QUO-10, QUO-11: who may quote, the API role, nothing beyond quotations
// ---------------------------------------------------------------------------------------------
test('only an organisation that can discover the shipment may quote; others are answered as for a shipment that does not exist', async () => {
  const { shipper, shipment, carrier } = await market();
  const narrow = await verifiedCarrier({ countries: ['XA'], equipmentTypes: ['curtain_side'] });
  const ghost = randomUUID();
  const refusedNarrow = await quote(narrow.person, narrow.org, shipment.id);
  const refusedGhost = await quote(narrow.person, narrow.org, ghost);
  assert.deepEqual(
    [refusedNarrow.status, refusedNarrow.body.code],
    [refusedGhost.status, refusedGhost.body.code],
  );
  const notCarrier = await quote(shipper.person, shipper.org, shipment.id);
  assert.deepEqual([notCarrier.status, notCarrier.body.code], [403, 'carrier_not_eligible']);
  // The carrier capability withdrawn: it can still withdraw its open quotation, nothing else.
  const q = await quoted(carrier.person, carrier.org, shipment.id);
  assert.equal((await revokeCapability(carrier.org, 'carry_as_company')).status, 200);
  assert.equal((await quote(carrier.person, carrier.org, shipment.id)).status, 403);
  assert.equal(
    (
      await carrierAct(carrier.person, carrier.org, q.id, 'revisions', {
        ...quoteBody({ amount: '1' }),
        version: 1,
      })
    ).status,
    403,
  );
  assert.equal(
    (await carrierAct(carrier.person, carrier.org, q.id, 'withdraw', { version: 1 })).status,
    200,
  );
});

test("the API's role reaches quotations only through their functions, and no fee, payment, invoice or confirmation route exists", async () => {
  const { shipment, carrier } = await market();
  await quoted(carrier.person, carrier.org, shipment.id);
  for (const table of [
    'quotation',
    'quotation_version',
    'shipment_quotation_terms',
    'currency',
    'quotation_inclusion',
    'quotation_read_log',
  ])
    await asApiRole(
      { tokenHash: hashToken(carrier.person.token), organisationId: carrier.org },
      async (client) => {
        await refused(() => client.query(`SELECT 1 FROM trucker.${table}`), /permission denied/);
      },
    );
  for (const statement of [
    'SELECT trucker.quotation_expire_shipment(gen_random_uuid(), now())',
    'SELECT trucker.quotation_carrier_enter(gen_random_uuid())',
  ])
    await asApiRole(
      { tokenHash: hashToken(carrier.person.token), organisationId: carrier.org },
      async (client) => {
        await refused(() => client.query(statement), /permission denied/);
      },
    );
  for (const path of [
    // Acceptance and the booking list arrived with slice 14 (booking.test.ts). These did not.
    `/organisations/${carrier.org}/bookings/${randomUUID()}/confirm`,
    `/organisations/${carrier.org}/bookings/${randomUUID()}/invoice`,
    `/organisations/${carrier.org}/quotations/${randomUUID()}/fee`,
    `/organisations/${carrier.org}/payments`,
  ]) {
    const reply = await call('POST', path, { token: carrier.person.token, body: {} });
    assert.equal(reply.status, 404, path);
  }
});

test('staff read the quotations of a published shipment read-only, and each look is recorded', async () => {
  const { shipment, carrier } = await market();
  await quoted(carrier.person, carrier.org, shipment.id);
  const staff = await reviewer();
  const read = await call('GET', `/staff/shipments/${shipment.id}/quotations`, {
    token: staff.token,
  });
  assert.equal(read.status, 200, read.text);
  assert.equal((read.body.quotations as Quotation[]).length, 1);
  assert.ok(
    (await staffAudit(staff, 'staff.quotation_view')).some((entry) => entry.outcome === 'done'),
  );
  const nobody = await newStaff([]);
  assert.equal(
    (await call('GET', `/staff/shipments/${shipment.id}/quotations`, { token: nobody.token }))
      .status,
    403,
  );
});
