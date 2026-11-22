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

// Acceptance and booking (slice 14). Real PostgreSQL, the API connected as its restricted role.
// Shippers and carriers are verified through the verification routes. Test accounts, fictional
// evidence and development-default commercial values only.

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

// ---------------------------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------------------------
interface Booking {
  id: string;
  status: string;
  shipmentId: string;
  quotationId: string;
  quotationVersion: number;
  shipper: { id: string; legalName: string };
  carrier: { id: string; legalName: string };
  currency: string;
  transportAmount: string;
  fee: { payer: string; basisPoints: number; rounding: string; amount: string };
  shipperTotal: string;
  carrierNet: string;
  paymentDueDays: number;
  quotation: QVersion;
  inclusions: { code: string; included: boolean }[];
  assignment: { dueAt: string; hours: number; leadHours: number };
  plannedReservation: { startAt: string; endAt: string };
  acceptedAt: string;
  role?: string;
}
interface Preview {
  quotationId: string;
  version: number;
  state: string;
  transportAmount: string;
  fee: { payer: string; basisPoints: number; amount: string };
  shipperTotal: string;
  paymentDueDays: number;
  assignmentDueAt: string | null;
}
const accept = (person: Person, org: string, quotation: string, version: number, retry = key()) =>
  call('POST', `/organisations/${org}/quotations/${quotation}/accept`, {
    token: person.token,
    key: retry,
    body: { version },
  });
async function overviewOf(person: Person, org: string, shipment: string) {
  const reply = await call('GET', shipments(org, `/${shipment}/booking`), { token: person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body as { open: boolean; booking: Booking | null; acceptance: Preview[] };
}
async function bookingsOf(person: Person, org: string): Promise<Booking[]> {
  const reply = await call('GET', `/organisations/${org}/bookings`, { token: person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.bookings as Booking[];
}
const statusOf = async (table: string, id: string): Promise<string> =>
  (await owner.query<{ status: string }>(`SELECT status FROM trucker.${table} WHERE id = $1`, [id]))
    .rows[0]!.status;
const hours = (from: Date, n: number): number => from.getTime() + n * 3_600_000;
const ms = (value: string | null): number | null =>
  value === null ? null : new Date(value).getTime();

test('accepting a quotation creates one booking with exact snapshots of the version, price, fee and terms; the others are not selected', async () => {
  const { shipper, shipment, carrier } = await market();
  const other = await verifiedCarrier();
  const mine = await quoted(carrier.person, carrier.org, shipment.id);
  const theirs = await quoted(other.person, other.org, shipment.id, quoteBody({ amount: '1300' }));
  // Before accepting, the shipper is shown what acceptance would fix.
  const before = await overviewOf(shipper.person, shipper.org, shipment.id);
  assert.equal(before.booking, null);
  const preview = before.acceptance.find((item) => item.quotationId === mine.id)!;
  assert.deepEqual(
    [
      preview.state,
      preview.transportAmount,
      preview.fee,
      preview.shipperTotal,
      preview.paymentDueDays,
    ],
    [
      'ok',
      '1250.50',
      { payer: 'shipper', basisPoints: 300, rounding: 'half_up', amount: '37.52' },
      '1288.02',
      15,
    ],
  );
  const accepted = clock();
  const reply = await accept(shipper.person, shipper.org, mine.id, 1);
  assert.equal(reply.status, 200, reply.text);
  const booking = reply.body.booking as Booking;
  assert.equal(reply.body.outcome, 'accepted');
  // 1250.50 × 3% = 37.515, rounded half-up to 37.52. The carrier receives what it quoted.
  assert.deepEqual(
    [
      booking.status,
      booking.currency,
      booking.transportAmount,
      booking.fee,
      booking.shipperTotal,
      booking.carrierNet,
    ],
    [
      'awaiting_resources',
      'XTS',
      '1250.50',
      { payer: 'shipper', basisPoints: 300, rounding: 'half_up', amount: '37.52' },
      '1288.02',
      '1250.50',
    ],
  );
  assert.deepEqual(
    [
      booking.quotationId,
      booking.quotationVersion,
      booking.quotation.versionNo,
      booking.quotation.amount,
    ],
    [mine.id, 1, 1, '1250.50'],
  );
  assert.deepEqual(
    booking.inclusions.map((item) => [item.code, item.included]),
    INCLUSIONS.map((code) => [code, answers()[code]]),
  );
  assert.deepEqual(
    [booking.shipper.id, booking.carrier.id, booking.paymentDueDays],
    [shipper.org, carrier.org, 15],
  );
  // The assignment deadline: 12 hours after acceptance (the pick-up is 48 hours away).
  assert.equal(ms(booking.assignment.dueAt), hours(new Date(booking.acceptedAt), 12));
  assert.ok(Math.abs(new Date(booking.acceptedAt).getTime() - accepted.getTime()) < 60_000);
  // The planned interval: 2 hours before the pick-up window to 12 hours after the delivery window.
  const windows = await owner.query<{ p: Date; d: Date }>(
    'SELECT pickup_from_at AS p, delivery_until_at AS d FROM trucker.shipment_draft WHERE id = $1',
    [shipment.id],
  );
  assert.deepEqual(
    [ms(booking.plannedReservation.startAt), ms(booking.plannedReservation.endAt)],
    [hours(windows.rows[0]!.p, -2), hours(windows.rows[0]!.d, 12)],
  );
  // The records.
  assert.deepEqual(
    [
      await statusOf('quotation', mine.id),
      await statusOf('quotation', theirs.id),
      await statusOf('shipment_draft', shipment.id),
    ],
    ['accepted', 'not_selected', 'awarded'],
  );
  assert.equal(await count('booking', 'shipment_id = $1', [shipment.id]), 1);
  for (const [record, action] of [
    [mine.id, 'quotation.accepted'],
    [theirs.id, 'quotation.not_selected'],
    [shipment.id, 'shipment.awarded'],
    [booking.id, 'booking.created'],
  ] as const)
    assert.equal(await entries(record, action), 1, action);
  // Both parties see the same booking; the other carrier sees none and its quotation not selected.
  const asCarrier = (await bookingsOf(carrier.person, carrier.org))[0]!;
  const asShipper = (await bookingsOf(shipper.person, shipper.org))[0]!;
  assert.deepEqual([asCarrier.role, asShipper.role], ['carrier', 'shipper']);
  assert.deepEqual({ ...asCarrier, role: undefined }, { ...asShipper, role: undefined });
  assert.deepEqual(await bookingsOf(other.person, other.org), []);
  assert.equal((await mineOne(other.person, other.org, theirs.id)).standing, 'not_selected');
  assert.equal((await mineOne(carrier.person, carrier.org, mine.id)).standing, 'accepted');
  // An awarded shipment is no longer discoverable, and its quotations cannot change.
  const gone = await call('GET', `/organisations/${other.org}/discovery/shipments/${shipment.id}`, {
    token: other.person.token,
  });
  assert.equal(gone.status, 404, gone.text);
  const late = await carrierAct(carrier.person, carrier.org, mine.id, 'withdraw', { version: 1 });
  assert.equal(late.status, 409, late.text);
  const after = await overviewOf(shipper.person, shipper.org, shipment.id);
  assert.deepEqual([after.booking?.id, after.acceptance], [booking.id, []]);
  // The snapshot cannot be changed, and later settings do not alter it.
  await refused(
    () => owner.query('UPDATE trucker.booking SET fee_amount = 0 WHERE id = $1', [booking.id]),
    /cannot be changed/,
  );
  await refused(
    () => owner.query('DELETE FROM trucker.booking WHERE id = $1', [booking.id]),
    /cannot be changed/,
  );
  await owner.query(
    'UPDATE trucker.security_setting SET booking_fee_basis_points = 900, booking_payment_due_days = 60',
  );
  try {
    assert.deepEqual((await bookingsOf(carrier.person, carrier.org))[0], asCarrier);
  } finally {
    await owner.query(
      'UPDATE trucker.security_setting SET booking_fee_basis_points = $1, booking_payment_due_days = $2',
      [D.booking_fee_basis_points, D.booking_payment_due_days],
    );
  }
  // Nothing was assigned, reserved or confirmed.
  // The row stores no state: nothing on it can say "confirmed".
  const stored = await owner.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'trucker' AND table_name = 'booking' AND column_name = 'status'`,
  );
  assert.equal(stored.rowCount, 0);
});

test('the fee is exact: half-up at the minor unit, from the settings at the moment of acceptance, and the database refuses any other figure', async () => {
  const cases: [string, number, string, string, string][] = [
    // amount, basis points, payer, fee, shipper total
    ['16.50', 300, 'shipper', '0.50', '17.00'], // 0.495 rounds up
    ['16.49', 300, 'shipper', '0.49', '16.98'], // 0.4947 rounds down
    ['999999999999.99', 300, 'shipper', '30000000000.00', '1029999999999.99'],
    ['100', 0, 'shipper', '0.00', '100.00'],
    ['1250.50', 250, 'carrier', '31.26', '1250.50'], // 31.2625; the carrier pays
  ];
  for (const [amount, points, payer, fee, total] of cases) {
    const { shipper, shipment, carrier } = await market();
    const made = await quoted(carrier.person, carrier.org, shipment.id, quoteBody({ amount }));
    await owner.query(
      'UPDATE trucker.security_setting SET booking_fee_basis_points = $1, booking_fee_payer = $2',
      [points, payer],
    );
    try {
      const reply = await accept(shipper.person, shipper.org, made.id, 1);
      assert.equal(reply.status, 200, reply.text);
      const booking = reply.body.booking as Booking;
      assert.deepEqual(
        [booking.fee.amount, booking.fee.payer, booking.fee.basisPoints, booking.shipperTotal],
        [fee, payer, points, total],
        amount,
      );
      if (payer === 'carrier') assert.equal(booking.carrierNet, '1219.24');
      // Amounts are text end to end.
      assert.ok(!/"(transportAmount|amount|shipperTotal)":\s*[0-9]/.test(reply.text));
    } finally {
      await owner.query(
        `UPDATE trucker.security_setting SET booking_fee_basis_points = $1, booking_fee_payer = 'shipper'`,
        [D.booking_fee_basis_points],
      );
    }
  }
  // A booking whose fee is not the stated share cannot exist.
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.booking
         SELECT (jsonb_populate_record(b, jsonb_build_object('id', gen_random_uuid(), 'fee_amount', b.fee_amount + 0.01))).*
         FROM trucker.booking b LIMIT 1`,
      ),
    /booking_fee_exact|duplicate key/,
  );
});

test('a retried acceptance returns the same booking and creates nothing more; a second acceptance of an awarded shipment is refused', async () => {
  const { shipper, shipment, carrier } = await market();
  const other = await verifiedCarrier();
  const mine = await quoted(carrier.person, carrier.org, shipment.id);
  const theirs = await quoted(other.person, other.org, shipment.id);
  const sent = key();
  const first = await accept(shipper.person, shipper.org, mine.id, 1, sent);
  assert.equal(first.status, 200, first.text);
  const second = await accept(shipper.person, shipper.org, mine.id, 1, sent);
  assert.deepEqual([second.status, second.body.outcome], [200, 'already_accepted']);
  assert.deepEqual(second.body.booking, first.body.booking);
  // The same key for another quotation or another version is refused.
  for (const [quotation, version] of [
    [theirs.id, 1],
    [mine.id, 2],
  ] as const) {
    const misuse = await accept(shipper.person, shipper.org, quotation, version, sent);
    assert.deepEqual([misuse.status, misuse.body.code], [409, 'retry_key_conflict']);
  }
  // A new attempt, on either quotation.
  for (const quotation of [mine.id, theirs.id]) {
    const again1 = await accept(shipper.person, shipper.org, quotation, 1);
    assert.deepEqual([again1.status, again1.body.code], [409, 'shipment_already_awarded']);
  }
  assert.equal(await count('booking', 'shipment_id = $1', [shipment.id]), 1);
  assert.equal(await entries((first.body.booking as Booking).id, 'booking.created'), 1);
  assert.equal(await entries(shipment.id, 'shipment.awarded'), 1);
  // Two identical requests at the same moment execute once.
  const fresh1 = await market();
  const made = await quoted(fresh1.carrier.person, fresh1.carrier.org, fresh1.shipment.id);
  const same = key();
  const both = await Promise.all(
    [0, 1].map(() => accept(fresh1.shipper.person, fresh1.shipper.org, made.id, 1, same)),
  );
  assert.deepEqual(
    both.map((reply) => reply.status),
    [200, 200],
  );
  assert.deepEqual(both.map((reply) => reply.body.outcome).sort(), [
    'accepted',
    'already_accepted',
  ]);
  assert.equal(await count('booking', 'shipment_id = $1', [fresh1.shipment.id]), 1);
});

test('acceptance is atomic under races: two acceptances leave exactly one booking; an acceptance racing a withdrawal leaves one consistent outcome', async () => {
  for (let round = 0; round < 3; round += 1) {
    const { shipper, shipment, carrier } = await market();
    const other = await verifiedCarrier();
    const mine = await quoted(carrier.person, carrier.org, shipment.id);
    const theirs = await quoted(other.person, other.org, shipment.id);
    const replies = await Promise.all([
      accept(shipper.person, shipper.org, mine.id, 1),
      accept(shipper.person, shipper.org, theirs.id, 1),
    ]);
    assert.deepEqual(
      replies.map((reply) => reply.status).sort(),
      [200, 409],
      replies.map((r) => r.text).join(),
    );
    assert.equal(
      replies.find((reply) => reply.status === 409)!.body.code,
      'shipment_already_awarded',
    );
    assert.equal(await count('booking', 'shipment_id = $1', [shipment.id]), 1);
    assert.equal(
      await count('quotation', `shipment_id = $1 AND status = 'accepted'`, [shipment.id]),
      1,
    );
    assert.equal(
      await count('quotation', `shipment_id = $1 AND status = 'not_selected'`, [shipment.id]),
      1,
    );
  }
  for (let round = 0; round < 3; round += 1) {
    const { shipper, shipment, carrier } = await market();
    const mine = await quoted(carrier.person, carrier.org, shipment.id);
    const [accepted, withdrawn] = await Promise.all([
      accept(shipper.person, shipper.org, mine.id, 1),
      carrierAct(carrier.person, carrier.org, mine.id, 'withdraw', { version: 1 }),
    ]);
    const outcome = [accepted.status, withdrawn.status, await statusOf('quotation', mine.id)];
    const bookings = await count('booking', 'shipment_id = $1', [shipment.id]);
    assert.ok(accepted.status < 500 && withdrawn.status < 500, outcome.join());
    if (accepted.status === 200)
      assert.deepEqual([...outcome, bookings], [200, 409, 'accepted', 1]);
    else assert.deepEqual([...outcome, bookings], [409, 200, 'withdrawn', 0]);
  }
});

test('acceptance is checked again at its own moment: a stale version, an expired, unconfirmed, ineligible or suspended quotation is refused and nothing is created', async () => {
  const none = async (shipment: string) =>
    assert.equal(await count('booking', 'shipment_id = $1', [shipment]), 0);
  // A stale version: the carrier revised after the shipper loaded the page.
  {
    const { shipper, shipment, carrier } = await market();
    const made = await quoted(carrier.person, carrier.org, shipment.id);
    const revised = await carrierAct(carrier.person, carrier.org, made.id, 'revisions', {
      ...quoteBody({ amount: '1400' }),
      version: 1,
    });
    assert.equal(revised.status, 200, revised.text);
    const stale = await accept(shipper.person, shipper.org, made.id, 1);
    assert.deepEqual([stale.status, stale.body.code], [409, 'quotation_changed']);
    await none(shipment.id);
    const current = await accept(shipper.person, shipper.org, made.id, 2);
    assert.equal(current.status, 200, current.text);
    assert.deepEqual(
      [
        (current.body.booking as Booking).quotationVersion,
        (current.body.booking as Booking).transportAmount,
      ],
      [2, '1400.00'],
    );
  }
  // Needs reconfirmation after a material change.
  {
    const { shipper, shipment, carrier } = await market();
    const made = await quoted(carrier.person, carrier.org, shipment.id);
    const changed = await change(
      shipper.person,
      shipper.org,
      shipment,
      content({ grossWeightKg: '13000' }),
    );
    assert.equal(changed.status, 200, changed.text);
    const reply = await accept(shipper.person, shipper.org, made.id, 1);
    assert.deepEqual([reply.status, reply.body.code], [409, 'quotation_needs_reconfirmation']);
    const preview = (await overviewOf(shipper.person, shipper.org, shipment.id)).acceptance[0]!;
    assert.deepEqual([preview.state, preview.assignmentDueAt], ['reconfirmation_needed', null]);
    await none(shipment.id);
  }
  // The carrier's capability is withdrawn.
  {
    const { shipper, shipment, carrier } = await market();
    const made = await quoted(carrier.person, carrier.org, shipment.id);
    assert.equal((await revokeCapability(carrier.org, 'carry_as_company')).status, 200);
    const reply = await accept(shipper.person, shipper.org, made.id, 1);
    assert.deepEqual([reply.status, reply.body.code], [409, 'quotation_carrier_not_eligible']);
    await none(shipment.id);
  }
  // The shipper's verification is withdrawn: the shipment is suspended.
  {
    const { shipper, shipment, carrier } = await market();
    const made = await quoted(carrier.person, carrier.org, shipment.id);
    assert.equal((await revokeCapability(shipper.org, 'ship')).status, 200);
    const reply = await accept(shipper.person, shipper.org, made.id, 1);
    assert.deepEqual([reply.status, reply.body.code], [409, 'shipment_suspended']);
    await none(shipment.id);
  }
  // Rejected, and withdrawn, quotations.
  {
    const { shipper, shipment, carrier } = await market();
    const made = await quoted(carrier.person, carrier.org, shipment.id);
    assert.equal((await reject(shipper.person, shipper.org, made.id, 1)).status, 200);
    const reply = await accept(shipper.person, shipper.org, made.id, 1);
    assert.deepEqual([reply.status, reply.body.code], [409, 'quotation_not_open']);
    await none(shipment.id);
  }
});

test('a booking names an immutable, demonstration-only version of the terms, and that register cannot be changed or taken to production', async () => {
  const { shipper, shipment, carrier } = await market();
  const made = await quoted(carrier.person, carrier.org, shipment.id);
  const terms = (
    await owner.query<{ code: string; version_no: number; content_hash: string; body: string }>(
      'SELECT code, version_no, content_hash, body FROM trucker.booking_terms',
    )
  ).rows;
  assert.equal(terms.length, 1);
  assert.match(terms[0]!.body, /^Demonstration booking terms, for development and testing only/);
  const expected = {
    code: 'booking',
    version: 1,
    demonstration: true,
    contentHash: terms[0]!.content_hash,
  };
  // Shown before accepting, and fixed on the booking.
  const preview = (await overviewOf(shipper.person, shipper.org, shipment.id)).acceptance[0]!;
  assert.deepEqual((preview as unknown as { terms: unknown }).terms, expected);
  const reply = await accept(shipper.person, shipper.org, made.id, 1);
  assert.equal(reply.status, 200, reply.text);
  const booking = reply.body.booking as Booking & { terms: unknown };
  assert.deepEqual(booking.terms, expected);
  const seenByCarrier = (await bookingsOf(carrier.person, carrier.org))[0] as Booking & {
    terms: unknown;
  };
  assert.deepEqual(seenByCarrier.terms, expected);
  // A version is never changed or removed, by anyone; a booking cannot name another version.
  await refused(
    () => owner.query(`UPDATE trucker.booking_terms SET body = 'Other text'`),
    /cannot be changed or removed/,
  );
  await refused(() => owner.query('DELETE FROM trucker.booking_terms'), /cannot be changed/);
  await refused(() => owner.query('TRUNCATE trucker.booking_terms CASCADE'), /cannot be changed/);
  await refused(
    () => owner.query('UPDATE trucker.booking SET terms_version = 2 WHERE id = $1', [booking.id]),
    /cannot be changed or removed/,
  );
  // Only demonstration terms can exist, with a hash of their own content.
  const insert = (demonstration: boolean, hash: string) =>
    owner.query(
      `INSERT INTO trucker.booking_terms (code, version_no, demonstration, body, content_hash, created_at)
       VALUES ('booking', 2, $1, 'Later text', $2, now())`,
      [demonstration, hash],
    );
  const hashOf = (
    await owner.query<{ h: string }>(
      `SELECT encode(sha256(convert_to('booking:2:Later text', 'UTF8')), 'hex') AS h`,
    )
  ).rows[0]!.h;
  await refused(() => insert(false, hashOf), /booking_terms_demonstration_only/);
  // An unmarked or production database accepts no terms at all, so acceptance there is closed.
  const scratch = await createTestDatabase();
  const bare = new pg.Pool({ connectionString: scratch.url });
  try {
    await migrateUp(bare, defaultMigrationsDir());
    assert.equal((await bare.query('SELECT 1 FROM trucker.booking_terms')).rowCount, 0);
    const add = () =>
      bare.query(
        `INSERT INTO trucker.booking_terms (code, version_no, demonstration, body, content_hash, created_at)
         VALUES ('booking', 1, true, 'Text', encode(sha256(convert_to('booking:1:Text', 'UTF8')), 'hex'), now())`,
      );
    await refused(add, /allowed only in a database marked local-development or test/);
    await bare.query(`UPDATE trucker.environment SET kind = 'production', marked_at = now()`);
    await refused(add, /allowed only in a database marked local-development or test/);
    assert.equal(
      (await bare.query<{ t: string | null }>('SELECT (trucker.booking_terms_current()).code AS t'))
        .rows[0]!.t,
      null,
    );
  } finally {
    await bare.end();
    await scratch.drop();
  }
  await refused(() => insert(true, 'not-the-hash'), /booking_terms_hash/);
  // A database holding demonstration terms cannot be marked as production. Other guards refuse
  // this too, so they are set aside inside a transaction that is rolled back.
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    for (const name of [
      'environment_guard',
      'environment_guard_catalogue',
      'environment_guard_quotation_registers',
      'environment_guard_fleet_registers',
    ])
      await client.query(`ALTER TABLE trucker.environment DISABLE TRIGGER ${name}`);
    await refused(
      () => client.query(`UPDATE trucker.environment SET kind = 'production'`),
      /holds demonstration booking terms and cannot be marked production/,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  // The API role cannot read or write the register.
  await asApiRole({}, async (client) => {
    await refused(() => client.query('SELECT * FROM trucker.booking_terms'), /permission denied/);
  });
});

test("a refused acceptance is recorded in the asking shipper's history only: the reason and version numbers, nothing of the carrier, and nothing for a caller who may not see the quotation", async () => {
  const refusals = async (quotation: string) =>
    (
      await owner.query<{
        organisation_id: string;
        actor_person_id: string;
        after_values: Record<string, unknown>;
        before_values: unknown;
      }>(
        `SELECT organisation_id, actor_person_id, after_values, before_values FROM trucker.audit_entry
         WHERE record_id = $1 AND action = 'acceptance.refused' ORDER BY occurred_at, id`,
        [quotation],
      )
    ).rows;
  const { shipper, shipment, carrier } = await market();
  const other = await verifiedCarrier();
  const made = await quoted(carrier.person, carrier.org, shipment.id);
  const theirs = await quoted(other.person, other.org, shipment.id, quoteBody({ amount: '1300' }));
  // People who may not see the quotation: refused as for a missing record, and nothing is written.
  const outsider = await newPerson();
  for (const [person, org] of [
    [carrier.person, carrier.org],
    [other.person, other.org],
    [outsider, shipper.org],
  ] as const) {
    const reply = await accept(person, org, made.id, 1);
    assert.equal(reply.status, 404, reply.text);
  }
  assert.equal(
    await count('audit_entry', `action = 'acceptance.refused' AND record_id = $1`, [made.id]),
    0,
  );
  // A stale version: recorded with the version asked for and the current one.
  const revised = await carrierAct(carrier.person, carrier.org, made.id, 'revisions', {
    ...quoteBody({ amount: '1400' }),
    version: 1,
  });
  assert.equal(revised.status, 200, revised.text);
  const stale = await accept(shipper.person, shipper.org, made.id, 1);
  assert.deepEqual([stale.status, stale.body.code], [409, 'quotation_changed']);
  // A retry key used for a different request.
  const retry = key();
  const first = await accept(shipper.person, shipper.org, theirs.id, 1, retry);
  assert.equal(first.status, 200, first.text);
  const reused = await accept(shipper.person, shipper.org, made.id, 2, retry);
  assert.deepEqual([reused.status, reused.body.code], [409, 'retry_key_conflict']);
  // The shipment is awarded: a later acceptance of another quotation is refused.
  const late = await accept(shipper.person, shipper.org, made.id, 2);
  assert.deepEqual([late.status, late.body.code], [409, 'shipment_already_awarded']);
  const rows = await refusals(made.id);
  assert.deepEqual(
    // The test clock stands still, so the order is not asserted.
    rows
      .map((row) => row.after_values)
      .sort((x, y) => String(x.reason).localeCompare(String(y.reason))),
    [
      { reason: 'already_awarded', expectedVersion: 2 },
      { reason: 'conflict', expectedVersion: 1, currentVersion: 2 },
      { reason: 'key_conflict', expectedVersion: 2 },
    ],
  );
  for (const row of rows) {
    assert.equal(row.organisation_id, shipper.org);
    assert.equal(row.actor_person_id, shipper.person.personId);
    assert.equal(row.before_values, null);
  }
  // Nothing of it is in either carrier's history, which is all a carrier can read.
  for (const org of [carrier.org, other.org])
    assert.equal(
      await count('audit_entry', `organisation_id = $1 AND action = 'acceptance.refused'`, [org]),
      0,
    );
  const session = await again(carrier.person);
  await asApiRole(
    { tokenHash: hashToken(session.token), organisationId: carrier.org },
    async (client) => {
      const seen = await client.query(
        `SELECT 1 FROM trucker.audit_entry WHERE action = 'acceptance.refused'`,
      );
      assert.equal(seen.rowCount, 0);
      // The same request does read the carrier's own history.
      const own = await client.query('SELECT 1 FROM trucker.audit_entry');
      assert.ok((own.rowCount ?? 0) > 0);
    },
  );
  // A refusal for a reason about the carrier says no more than the shipper is told.
  {
    const next = await market();
    const quotation = await quoted(next.carrier.person, next.carrier.org, next.shipment.id);
    assert.equal((await revokeCapability(next.carrier.org, 'carry_as_company')).status, 200);
    const reply = await accept(next.shipper.person, next.shipper.org, quotation.id, 1);
    assert.deepEqual([reply.status, reply.body.code], [409, 'quotation_carrier_not_eligible']);
    assert.deepEqual(
      (await refusals(quotation.id)).map((row) => [row.organisation_id, row.after_values]),
      [[next.shipper.org, { reason: 'carrier_not_eligible', expectedVersion: 1 }]],
    );
  }
});

test('who may accept: only an administrator of the shipper; the carrier, outsiders and the API role reach nothing; outside a marked database acceptance is closed', async () => {
  const { shipper, shipment, carrier } = await market();
  const made = await quoted(carrier.person, carrier.org, shipment.id);
  const outsider = await newPerson();
  for (const [person, org] of [
    [carrier.person, carrier.org],
    [carrier.person, shipper.org],
    [outsider, shipper.org],
  ] as const) {
    const reply = await accept(person, org, made.id, 1);
    assert.equal(reply.status, 404, reply.text);
    const view = await call('GET', shipments(org, `/${shipment.id}/booking`), {
      token: person.token,
    });
    assert.equal(view.status, 404, view.text);
  }
  assert.equal(
    (await accept({ ...shipper.person, token: 'x.y' }, shipper.org, made.id, 1)).status,
    401,
  );
  const noKey = await call('POST', `/organisations/${shipper.org}/quotations/${made.id}/accept`, {
    token: shipper.person.token,
    body: { version: 1 },
  });
  assert.deepEqual([noKey.status, noKey.body.code], [400, 'retry_key_required']);
  const asNumber = await call(
    'POST',
    `/organisations/${shipper.org}/quotations/${made.id}/accept`,
    {
      token: shipper.person.token,
      key: key(),
      body: { version: '1' },
    },
  );
  assert.equal(asNumber.status, 422, asNumber.text);
  assert.equal(await count('booking', 'shipment_id = $1', [shipment.id]), 0);
  // As the API's database role: no table, no building block; without fixtures it is closed.
  const context = { tokenHash: hashToken(shipper.person.token), organisationId: shipper.org };
  for (const statement of [
    'SELECT * FROM trucker.booking',
    'SELECT * FROM trucker.booking_retry_key',
    'SELECT * FROM trucker.acceptance_terms(1, 2, NULL, now())',
    `SELECT trucker.booking_terms_available(true)`,
    `UPDATE trucker.security_setting SET booking_fee_basis_points = 0`,
  ])
    await refused(
      () => asApiRole(context, (client) => client.query(statement)),
      /permission denied/,
    );
  const closed = await asApiRole(context, (client) =>
    client.query<{ status: string }>(
      'SELECT status FROM trucker.accept_quotation($1, 1, $2, false)',
      [made.id, key()],
    ),
  );
  assert.equal(closed.rows[0]!.status, 'closed');
  // No route assigns, confirms, cancels, invoices or pays.
  const booked = await accept(shipper.person, shipper.org, made.id, 1);
  assert.equal(booked.status, 200, booked.text);
  const id = (booked.body.booking as Booking).id;
  for (const [method, route] of [
    ['POST', `/organisations/${carrier.org}/bookings/${id}/confirm`],
    ['POST', `/organisations/${carrier.org}/bookings/${id}/assignments`],
    ['POST', `/organisations/${shipper.org}/bookings/${id}/cancel`],
    ['POST', `/organisations/${shipper.org}/bookings/${id}/payments`],
    ['GET', `/organisations/${shipper.org}/bookings/${id}/invoice`],
  ] as const)
    assert.equal(
      (
        await call(method, route, {
          token: shipper.person.token,
          key: key(),
          ...(method === 'POST' ? { body: {} } : {}),
        })
      ).status,
      404,
      route,
    );
  // Staff read it; each look is recorded.
  const staff = await reviewer();
  const read = await call('GET', `/staff/shipments/${shipment.id}/booking`, { token: staff.token });
  assert.equal(read.status, 200, read.text);
  assert.equal((read.body.booking as Booking).id, id);
  assert.equal((await staffAudit(staff, 'staff.booking_view')).at(-1)?.outcome, 'done');
  assert.equal(
    (
      await call('GET', `/staff/shipments/${shipment.id}/booking`, {
        token: (await newStaff([])).token,
      })
    ).status,
    403,
  );
});

// Last: these move the clock.
test('short notice is refused, not booked late: when the assignment deadline has already passed no booking is created', async () => {
  // The pick-up window opens 7 hours from now; resources must be assigned 6 hours before it.
  const shipper = await verifiedShipper();
  const soon = await draft(
    shipper.person,
    shipper.org,
    content({
      pickup: {
        ...(content().pickup as object),
        from: { local: local(7) },
        until: { local: local(9) },
      },
    }),
  );
  const made = await act(shipper.person, shipper.org, soon.id, 'publish', {
    version: soon.version,
    ...details({ quotationDeadline: { local: local(3) } }),
  });
  assert.equal(made.status, 200, made.text);
  assert.equal((await setTerms(shipper.person, shipper.org, soon.id)).status, 200);
  const carrier = await verifiedCarrier();
  const quotation = await quoted(
    carrier.person,
    carrier.org,
    soon.id,
    quoteBody({ validUntil: { local: local(2.5) }, earliestPickup: { local: local(7.5) } }),
  );
  // With more than 6 hours to go the deadline is 6 hours before the pick-up, not 12 hours on.
  const early = (await overviewOf(shipper.person, shipper.org, soon.id)).acceptance[0]!;
  const pickup = (
    await owner.query<{ p: Date }>(
      'SELECT pickup_from_at AS p FROM trucker.shipment_draft WHERE id = $1',
      [soon.id],
    )
  ).rows[0]!.p;
  assert.deepEqual([early.state, ms(early.assignmentDueAt)], ['ok', hours(pickup, -6)]);
  // An hour and a half later it is less than 6 hours to the pick-up.
  await advance(90 * 60);
  const person = await again(shipper.person);
  const late = (await overviewOf(person, shipper.org, soon.id)).acceptance[0]!;
  assert.deepEqual([late.state, late.assignmentDueAt], ['assignment_deadline_passed', null]);
  const reply = await accept(person, shipper.org, quotation.id, 1);
  assert.deepEqual([reply.status, reply.body.code], [409, 'assignment_deadline_passed']);
  assert.equal(await count('booking', 'shipment_id = $1', [soon.id]), 0);
  assert.deepEqual(
    [await statusOf('quotation', quotation.id), await statusOf('shipment_draft', soon.id)],
    ['submitted', 'published'],
  );
  // The database itself refuses a booking that would start overdue.
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.booking
         SELECT (jsonb_populate_record(b, jsonb_build_object(
                   'id', gen_random_uuid(), 'shipment_id', $1::uuid, 'quotation_id', $2::uuid,
                   'accepted_at', b.pickup_from_at, 'assignment_due_at', b.pickup_from_at - interval '6 hours'))).*
         FROM trucker.booking b LIMIT 1`,
        [soon.id, quotation.id],
      ),
    /booking_not_overdue|booking_assignment_rule/,
  );
});

test("an acceptance one second after the quotation's validity is refused, also for a request that waited behind a lock", async () => {
  const { shipper, shipment, carrier } = await market();
  const made = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ validUntil: { local: local(0.3) } }),
  );
  // The request waits behind a lock on the shipment while the validity passes.
  const waited = await whileBlocked(
    ['SELECT 1 FROM trucker.shipment_draft WHERE id = $1 FOR UPDATE', [shipment.id]],
    () => accept(shipper.person, shipper.org, made.id, 1),
    19 * 60,
  );
  assert.deepEqual([waited.status, waited.body.code], [409, 'quotation_not_open']);
  assert.equal(await count('booking', 'shipment_id = $1', [shipment.id]), 0);
  assert.equal(await statusOf('quotation', made.id), 'expired');
  assert.equal(await entries(made.id, 'quotation.expired'), 1);
});
