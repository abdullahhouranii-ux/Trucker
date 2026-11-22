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
import { settleFee } from '../testing/fee.js';
import { createTestClock } from '../testing/test-clock.js';
import { blockedRequests } from '../testing/blocked-request.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';

// Assignment, reservation and confirmation (slice 15). Real PostgreSQL, the API connected as
// its restricted role. Shippers, carriers, vehicles, drivers and bookings are made through the
// routes of the earlier slices. Occupancy episodes do not exist in the product yet: where a test
// needs one it is put in place by the migration role. Test accounts and fictional evidence only.

const D = SECURITY_SETTING_DEFAULTS;
const testClock = createTestClock(new Date('2026-06-01T08:00:00.000Z'));
const { clock, advance } = testClock;

let database: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
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
let secondAdmin: Staff | undefined;
const secondAdministrator = async (): Promise<Staff> =>
  fresh(secondAdmin ?? (secondAdmin = await newStaff(['staff_admin'])));
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
const accept = (person: Person, org: string, quotation: string, version: number, retry = key()) =>
  call('POST', `/organisations/${org}/quotations/${quotation}/accept`, {
    token: person.token,
    key: retry,
    body: { version },
  });
async function bookingsOf(person: Person, org: string): Promise<Booking[]> {
  const reply = await call('GET', `/organisations/${org}/bookings`, { token: person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.bookings as Booking[];
}
const statusOf = async (table: string, id: string): Promise<string> =>
  (await owner.query<{ status: string }>(`SELECT status FROM trucker.${table} WHERE id = $1`, [id]))
    .rows[0]!.status;
const ms = (value: string | null): number | null =>
  value === null ? null : new Date(value).getTime();

// ---------------------------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------------------------
const fleet = (org: string, rest = ''): string => `/organisations/${org}/fleet${rest}`;
let plate = 0;
const newPlate = (): string => `FX${String(10_000 + plate++)}`;
const vehicleBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'truck',
  category: 'fictional_rigid_truck',
  equipmentType: 'box',
  registrationCountry: 'XA',
  registrationNumber: newPlate(),
  ...over,
});
/** A date some days after the test clock's present, as documents state it. */
const day = (days: number): string =>
  new Date(clock().getTime() + days * 86_400_000).toISOString().slice(0, 10);
const documentBody = (type: string, over: Record<string, unknown> = {}) => ({
  type,
  documentNumber: `DOC-${randomBytes(3).toString('hex')}`,
  issuingCountry: 'XA',
  expiryDate: day(200),
  ...over,
});
interface Doc {
  id: string;
  type: string;
  status: string;
  version: number;
  expiryDate: string;
  documentNumber?: string;
  licenceClasses: string[];
}
interface Vehicle {
  id: string;
  kind: string;
  registrationNumber: string;
  status: string;
  ownership: string;
  version: number;
  eligibility: string;
  documents: Doc[];
}
interface Driver {
  id: string;
  status: string;
  phone: string;
  version: number;
  name?: string;
  eligibility?: string;
  documents?: Doc[];
  authorisations?: { id: string; vehicleId: string | null }[];
}
interface Fleet {
  open: boolean;
  vehicles: Vehicle[];
  drivers: Driver[];
}
async function fleetOf(person: Person, org: string): Promise<Fleet> {
  const reply = await call('GET', fleet(org), { token: person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.fleet as Fleet;
}
const vehicleOf = async (person: Person, org: string, id: string): Promise<Vehicle> =>
  (await fleetOf(person, org)).vehicles.find((vehicle) => vehicle.id === id)!;
async function registered(person: Person, org: string, over: Record<string, unknown> = {}) {
  const reply = await call('POST', fleet(org, '/vehicles'), {
    token: person.token,
    key: key(),
    body: vehicleBody(over),
  });
  assert.equal(reply.status, 201, reply.text);
  return reply.body.vehicle as Vehicle;
}
const staffDecide = async (
  staff: Staff,
  route: string,
  version: number,
  decision: string,
  reason: string,
  noConflict = true,
): Promise<Reply> =>
  call('POST', `/staff/fleet/${route}`, {
    token: (await fresh(staff)).token,
    body: { version, decision, reason, noConflict },
  });
const verifyOwnership = async (vehicle: Vehicle): Promise<Reply> =>
  staffDecide(
    await reviewer(),
    `vehicles/${vehicle.id}/ownership`,
    vehicle.version,
    'verified',
    'ownership_evidence_accepted',
  );
interface Queue {
  claims: {
    id: string;
    version: number;
    otherClaims: { vehicleId: string; ownership: string; carrier: string }[];
  }[];
  documents: (Doc & { subject: string; vehicleId?: string; personId?: string })[];
}
async function queue(): Promise<Queue> {
  const reply = await call('GET', '/staff/fleet', { token: (await reviewer()).token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.fleet as Queue;
}
/** Accepts every document awaiting a decision for one vehicle or one driver. */
async function acceptDocuments(subject: string): Promise<void> {
  for (const item of (await queue()).documents.filter(
    (doc) => doc.vehicleId === subject || doc.personId === subject,
  )) {
    const reply = await staffDecide(
      await reviewer(),
      `documents/${item.id}/decision`,
      item.version,
      'accepted',
      'document_accepted',
    );
    assert.equal(reply.status, 200, reply.text);
  }
}
const submitVehicleDocument = (person: Person, org: string, vehicle: string, body: unknown) =>
  call('POST', fleet(org, `/vehicles/${vehicle}/documents`), {
    token: person.token,
    key: key(),
    body,
  });
interface DriverSide {
  invitations: { id: string; version: number; carrier: { legalName: string } }[];
  affiliation: { id: string; version: number; eligibility: string } | null;
  documents: Doc[];
}
async function driverSide(person: Person): Promise<DriverSide> {
  const reply = await call('GET', '/me/driver', { token: person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.driver as DriverSide;
}
const invite = (person: Person, org: string, phone: string): Promise<Reply> =>
  call('POST', fleet(org, '/drivers'), { token: person.token, key: key(), body: { phone } });
const respond = (driver: Person, id: string, version: number, decision: string): Promise<Reply> =>
  call('POST', `/me/driver/invitations/${id}/respond`, {
    token: driver.token,
    key: key(),
    body: { version, decision },
  });
/** A driver who accepted the carrier's invitation. */
async function affiliated(carrier: Person, org: string) {
  const driver = await newPerson();
  assert.equal((await invite(carrier, org, driver.phone)).status, 201);
  const invitation = (await driverSide(driver)).invitations[0]!;
  const reply = await respond(driver, invitation.id, invitation.version, 'accept');
  assert.equal(reply.status, 200, reply.text);
  return { driver, affiliation: invitation.id };
}
const submitDriverDocument = (driver: Person, body: unknown): Promise<Reply> =>
  call('POST', '/me/driver/documents', { token: driver.token, key: key(), body });
async function driverDocuments(driver: Person, classes: string[]): Promise<void> {
  for (const body of [
    documentBody('fictional_driving_licence', { licenceClasses: classes }),
    documentBody('fictional_identity_card'),
  ])
    assert.equal((await submitDriverDocument(driver, body)).status, 201);
  await acceptDocuments(driver.personId);
}
const authorise = (
  person: Person,
  org: string,
  affiliation: string,
  vehicleId: string | null,
  granted = true,
): Promise<Reply> =>
  call('POST', fleet(org, `/drivers/${affiliation}/authorisations`), {
    token: person.token,
    key: key(),
    body: { vehicleId, granted },
  });
// ---------------------------------------------------------------------------------------------
// Resources and bookings for these tests
// ---------------------------------------------------------------------------------------------
interface Party {
  person: Person;
  org: string;
}
const DOCUMENTS: Record<string, string[]> = {
  truck: ['fictional_registration_card', 'fictional_insurance_certificate'],
  trailer: ['fictional_registration_card'],
};
/** A vehicle whose ownership is verified and whose documents are accepted. */
async function eligibleVehicle(
  carrier: Party,
  over: Record<string, unknown> = {},
  expiry = day(200),
): Promise<Vehicle> {
  const vehicle = await registered(carrier.person, carrier.org, over);
  assert.equal((await verifyOwnership(vehicle)).status, 200);
  for (const type of DOCUMENTS[vehicle.kind]!)
    assert.equal(
      (
        await submitVehicleDocument(
          carrier.person,
          carrier.org,
          vehicle.id,
          documentBody(type, { expiryDate: expiry }),
        )
      ).status,
      201,
    );
  await acceptDocuments(vehicle.id);
  return vehicleOf(carrier.person, carrier.org, vehicle.id);
}
// The shipments of these tests ask for a curtain-side body.
const rigid = (carrier: Party) => eligibleVehicle(carrier, { equipmentType: 'curtain_side' });
const tractor = (carrier: Party) =>
  eligibleVehicle(carrier, { category: 'fictional_tractor_unit', equipmentType: 'box' });
const semiTrailer = (carrier: Party, equipmentType = 'curtain_side') =>
  eligibleVehicle(carrier, { kind: 'trailer', category: 'fictional_semi_trailer', equipmentType });
/** A driver with accepted documents who may drive every vehicle of the carrier. */
async function readyDriver(carrier: Party, classes = ['fictional_class_2']) {
  const made = await affiliated(carrier.person, carrier.org);
  await driverDocuments(made.driver, classes);
  assert.equal((await authorise(carrier.person, carrier.org, made.affiliation, null)).status, 200);
  return made;
}
const suspend = async (subject: 'vehicle' | 'driver', id: string, suspended: boolean) =>
  call('POST', '/staff/fleet/suspensions', {
    token: (await administrator()).token,
    body: { subject, id, suspended, reason: suspended ? 'safety_review' : null },
  });

/**
 * A booking of this carrier with a new shipper. With no shift the planned interval runs from
 * 46 to 70 hours after the present; a shift moves the whole shipment later by that many hours.
 */
async function booked(carrier: Party, shift = 0, anchor = clock()) {
  const shipper = await verifiedShipper();
  const at = (hours: number, country = 'XA'): string =>
    new Date(anchor.getTime() + (hours + shift + (ZONE_HOURS[country] ?? 0)) * 3_600_000)
      .toISOString()
      .slice(0, 16);
  const made = await draft(
    shipper.person,
    shipper.org,
    content({
      pickup: {
        address: 'Warehouse 9, Private Street',
        countryCode: 'XA',
        timeZone: 'Etc/GMT-4',
        accessNotes: 'Gate code 5512',
        from: { local: at(48) },
        until: { local: at(50) },
      },
      delivery: {
        address: 'Depot 3, Hidden Road',
        countryCode: 'XB',
        timeZone: 'Etc/GMT-3',
        accessNotes: 'Use the north entrance',
        from: { local: at(54, 'XB') },
        until: { local: at(58, 'XB') },
      },
    }),
  );
  const publishedReply = await act(shipper.person, shipper.org, made.id, 'publish', {
    version: made.version,
    ...details(),
  });
  assert.equal(publishedReply.status, 200, publishedReply.text);
  const shipment = publishedReply.body.shipment as Shipment;
  assert.equal((await setTerms(shipper.person, shipper.org, shipment.id)).status, 200);
  const quotation = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ earliestPickup: { local: at(48.5) } }),
  );
  const reply = await accept(shipper.person, shipper.org, quotation.id, 1);
  assert.equal(reply.status, 200, reply.text);
  const booking = reply.body.booking as Booking;
  // Trucker's fee, verified by two administrators: confirmation then follows full assignment.
  await settleFee(
    call,
    (await administrator()).token,
    (await secondAdministrator()).token,
    booking.id,
  );
  return { shipper, shipment, booking, anchor };
}

interface Member {
  registrationCountry: string;
  registrationNumber: string;
  id?: string;
}
interface Resources {
  truck: Member | null;
  trailer: Member | null;
  driver: { name: string; affiliationId?: string } | null;
}
interface Blocker {
  code: string;
  role?: string;
  reason?: string;
}
interface View extends Booking {
  confirmedAt: string | null;
  overdue: boolean;
  waitDecision: { decidedAt: string } | null;
  assignmentVersion: number;
  dispatch: { ready: boolean; blockers: Blocker[] };
  needsReassignment: boolean;
  atRisk: boolean;
  acknowledgedAt: string | null;
  resources: Resources | null;
  substitution: {
    id: string;
    status: string;
    version: number;
    differences: { role: string; change: string }[];
    proposed: Resources;
  } | null;
  site: {
    pickup: { address: string; accessNotes: string };
    delivery: { address: string; accessNotes: string };
  } | null;
  vehicleChanges: {
    at: string;
    changes: { role: string; from: Member | null; to: Member | null }[];
  }[];
}
interface Candidates {
  vehicles: { id: string; kind: string; state: string; requiresTrailer: boolean }[];
  drivers: { affiliationId: string; name: string; state: string }[];
}
const bookingRoute = (org: string, id: string, rest = ''): string =>
  `/organisations/${org}/bookings/${id}${rest}`;
async function detailOf(party: Party, id: string) {
  const reply = await call('GET', bookingRoute(party.org, id), { token: party.person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body as unknown as { open: boolean; booking: View; candidates: Candidates | null };
}
const viewOf = async (party: Party, id: string): Promise<View> =>
  (await detailOf(party, id)).booking;
interface Wanted {
  version: number;
  truckId?: string | null;
  trailerId?: string | null;
  driverId?: string | null;
}
const assign = (party: Party, id: string, set: Wanted): Promise<Reply> =>
  call('POST', bookingRoute(party.org, id, '/assignment'), {
    token: party.person.token,
    body: {
      version: set.version,
      truckId: set.truckId ?? null,
      trailerId: set.trailerId ?? null,
      driverId: set.driverId ?? null,
    },
  });
/** The set as it stands, with some members replaced. */
async function wanted(party: Party, id: string, change: Omit<Wanted, 'version'>): Promise<Wanted> {
  const view = await viewOf(party, id);
  return {
    version: view.assignmentVersion,
    truckId: view.resources?.truck?.id ?? null,
    trailerId: view.resources?.trailer?.id ?? null,
    driverId: view.resources?.driver?.affiliationId ?? null,
    ...change,
  };
}
const reassign = async (party: Party, id: string, change: Omit<Wanted, 'version'>) =>
  assign(party, id, await wanted(party, id, change));
async function assigned(
  party: Party,
  id: string,
  change: Omit<Wanted, 'version'>,
  outcome: string,
) {
  const reply = await reassign(party, id, change);
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.body.outcome, outcome, reply.text);
  return reply.body.booking as View;
}
const decideSubstitution = (party: Party, id: string, version: number, decision: string) =>
  call('POST', `/organisations/${party.org}/substitutions/${id}/decision`, {
    token: party.person.token,
    body: { version, decision },
  });
const waitFor = (party: Party, id: string): Promise<Reply> =>
  call('POST', bookingRoute(party.org, id, '/wait'), { token: party.person.token });
interface DriverAssignment {
  bookingId: string;
  version: number;
  acknowledgedAt: string | null;
  truck: Member | null;
  trailer: Member | null;
}
async function assignmentsOf(driver: Person): Promise<DriverAssignment[]> {
  const reply = await call('GET', '/me/driver/assignments', { token: driver.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.assignments as DriverAssignment[];
}
const acknowledge = (driver: Person, id: string, version: number): Promise<Reply> =>
  call('POST', `/me/driver/assignments/${id}/acknowledge`, {
    token: driver.token,
    body: { version },
  });
interface Attention {
  bookings: {
    id: string;
    overdue: boolean;
    needsReassignment: boolean;
    atRisk: boolean;
    substitutionOpen: boolean;
  }[];
  consistency: { code: string; booking: string; record: string }[];
}
async function attention(): Promise<Attention> {
  const reply = await call('GET', '/staff/bookings/attention', { token: (await reviewer()).token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.attention as Attention;
}

interface Reservation {
  id: string;
  resource_kind: string;
  resource_id: string;
  purpose: string;
  status: string;
  release_reason: string | null;
  from_at: Date;
  until_at: Date;
  overrun_recorded_at: Date | null;
}
const reservationsOf = async (booking: string): Promise<Reservation[]> =>
  (
    await owner.query<Reservation>(
      `SELECT id, resource_kind, resource_id, purpose, status, release_reason,
              lower(planned) AS from_at, upper(planned) AS until_at, overrun_recorded_at
       FROM trucker.resource_reservation WHERE booking_id = $1 ORDER BY resource_kind, created_at, id`,
      [booking],
    )
  ).rows;
const activeOf = async (booking: string): Promise<Reservation[]> =>
  (await reservationsOf(booking)).filter((item) => item.status === 'active');
const held = async (resource: string): Promise<number> =>
  count('resource_reservation', `resource_id = $1 AND status = 'active'`, [resource]);
/** The booking row, whole. It never changes. */
const rowOf = async (table: string, column: string, id: string): Promise<string> =>
  JSON.stringify(
    (
      await owner.query<{ row: unknown }>(
        `SELECT to_jsonb(x) AS row FROM trucker.${table} x WHERE ${column} = $1`,
        [id],
      )
    ).rows[0]?.row ?? null,
  );
const consistency = async (): Promise<{ code: string; booking: string; record: string }[]> =>
  (
    await owner.query<{ c: { code: string; booking: string; record: string }[] }>(
      'SELECT trucker.booking_consistency() AS c',
    )
  ).rows[0]!.c;
/** Occupancy does not exist in the product yet: the migration role opens an episode. */
async function openEpisode(booking: string, resource: string): Promise<string> {
  const made = await owner.query<{ id: string }>(
    `INSERT INTO trucker.occupancy_episode
       (resource_kind, vehicle_id, person_id, booking_id, reservation_id, opened_at)
     SELECT r.resource_kind, r.vehicle_id, r.person_id, r.booking_id, r.id, $3
     FROM trucker.resource_reservation r
     WHERE r.booking_id = $1 AND r.resource_id = $2 AND r.status = 'active' RETURNING id`,
    [booking, resource, clock()],
  );
  assert.equal(made.rowCount, 1);
  return made.rows[0]!.id;
}
/** An episode closes only through a recorded release (slice 18a): the migration role writes one. */
const closeEpisode = async (id: string) => {
  await owner.query(
    `INSERT INTO trucker.resource_release
       (booking_id, episode_id, reservation_id, role, released_by, released_at, basis)
     SELECT e.booking_id, e.id, e.reservation_id, e.resource_kind, r.created_by, $2, 'condition'
     FROM trucker.occupancy_episode e JOIN trucker.resource_reservation r ON r.id = e.reservation_id
     WHERE e.id = $1`,
    [id, clock()],
  );
  await owner.query(
    `UPDATE trucker.occupancy_episode SET closed_at = $2, release_reason = 'released' WHERE id = $1`,
    [id, clock()],
  );
};
const refusal = (reply: Reply): unknown[] => [reply.status, reply.body.code, reply.body.details];
const freshParty = async (party: Party): Promise<Party> => ({
  person: await again(party.person),
  org: party.org,
});
const NEW_TABLES = [
  'booking_assignment_state',
  'booking_substitution',
  'resource_reservation',
  'booking_assignment',
  'booking_confirmation',
  'assignment_acknowledgement',
  'booking_wait_decision',
  'occupancy_episode',
  'booking_risk_flag',
];

// ---------------------------------------------------------------------------------------------
test('ASG-1, ASG-3: a partial set confirms nothing; a complete, eligible, reserved set confirms the booking in the same transaction, and operational details are released only then', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { driver, affiliation } = await readyDriver(carrier);
  const { shipper, booking } = await booked(carrier);
  const before = await rowOf('booking', 'id', booking.id);

  // At the start: nothing assigned, nothing released to either side.
  const start = await detailOf(carrier, booking.id);
  assert.deepEqual(
    [
      start.booking.status,
      start.booking.assignmentVersion,
      start.booking.site,
      start.booking.confirmedAt,
      start.booking.role,
    ],
    ['awaiting_resources', 0, null, null, 'carrier'],
  );
  assert.deepEqual(start.booking.resources, { truck: null, trailer: null, driver: null });
  assert.deepEqual(
    start.candidates!.vehicles.map((item) => [item.id, item.state]),
    [[truck.id, 'eligible']],
  );
  assert.deepEqual(
    start.candidates!.drivers.map((item) => [item.affiliationId, item.state]),
    [[affiliation, 'eligible']],
  );
  let forShipper = await detailOf(shipper, booking.id);
  assert.deepEqual(
    [
      forShipper.booking.resources,
      forShipper.candidates,
      forShipper.booking.site,
      forShipper.booking.role,
    ],
    [null, null, null, 'shipper'],
  );

  // A truck alone: reserved, but the booking is not confirmed and nothing is released.
  const first = await assign(carrier, booking.id, { version: 0, truckId: truck.id });
  assert.equal(first.status, 200, first.text);
  const partial = first.body.booking as View;
  assert.deepEqual(
    [first.body.outcome, partial.status, partial.assignmentVersion, partial.site],
    ['assigned', 'awaiting_resources', 1, null],
  );
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [booking.id]), 0);
  assert.equal((await activeOf(booking.id)).length, 1);
  forShipper = await detailOf(shipper, booking.id);
  assert.deepEqual(
    [forShipper.booking.status, forShipper.booking.resources],
    ['awaiting_resources', null],
  );

  // A command names the set it saw.
  const stale = await assign(carrier, booking.id, {
    version: 0,
    truckId: truck.id,
    driverId: affiliation,
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'assignment_changed']);

  // The driver completes the set: confirmed at that moment, by the database.
  const at = clock();
  const done = await assign(carrier, booking.id, {
    version: 1,
    truckId: truck.id,
    driverId: affiliation,
  });
  assert.equal(done.status, 200, done.text);
  const confirmed = done.body.booking as View;
  assert.deepEqual(
    [done.body.outcome, confirmed.status, ms(confirmed.confirmedAt), confirmed.assignmentVersion],
    ['confirmed', 'confirmed', at.getTime(), 2],
  );
  const reserved = await activeOf(booking.id);
  assert.deepEqual(
    reserved.map((item) => [
      item.resource_kind,
      item.resource_id,
      item.purpose,
      item.from_at.getTime(),
      item.until_at.getTime(),
    ]),
    [
      [
        'driver',
        driver.personId,
        'assignment',
        ms(booking.plannedReservation.startAt),
        ms(booking.plannedReservation.endAt),
      ],
      [
        'truck',
        truck.id,
        'assignment',
        ms(booking.plannedReservation.startAt),
        ms(booking.plannedReservation.endAt),
      ],
    ],
  );
  // The carrier now sees the addresses and access notes; no site contact exists to show.
  assert.deepEqual(confirmed.site, {
    pickup: { address: 'Warehouse 9, Private Street', accessNotes: 'Gate code 5512' },
    delivery: { address: 'Depot 3, Hidden Road', accessNotes: 'Use the north entrance' },
  });
  // The shipper now sees registration numbers and the driver's name, and nothing more of them.
  forShipper = await detailOf(shipper, booking.id);
  assert.deepEqual(
    [forShipper.booking.status, forShipper.booking.resources, forShipper.booking.site],
    [
      'confirmed',
      {
        truck: { registrationCountry: 'XA', registrationNumber: truck.registrationNumber },
        trailer: null,
        driver: { name: 'Test Person (fictional)' },
      },
      null,
    ],
  );
  const shown = JSON.stringify(forShipper);
  for (const hidden of [truck.id, affiliation, driver.phone, driver.personId, 'DOC-'])
    assert.ok(!shown.includes(hidden), `the shipper is shown ${hidden}`);
  for (const text of [shown, JSON.stringify(await detailOf(carrier, booking.id))])
    assert.doesNotMatch(text, /contact/i);

  // The same set again changes nothing, also for a retry that still names an old number.
  for (const version of [2, 0]) {
    const repeat = await assign(carrier, booking.id, {
      version,
      truckId: truck.id,
      driverId: affiliation,
    });
    assert.deepEqual(
      [repeat.status, repeat.body.outcome, (repeat.body.booking as View).assignmentVersion],
      [200, 'unchanged', 2],
    );
  }
  assert.equal((await reservationsOf(booking.id)).length, 2);

  // Assignments before confirmation are not vehicle changes.
  assert.deepEqual(forShipper.booking.vehicleChanges, []);
  // Confirmed is not ready for dispatch: the driver has not acknowledged.
  assert.deepEqual((await viewOf(carrier, booking.id)).dispatch, {
    ready: false,
    blockers: [{ code: 'acknowledgement_missing' }],
  });

  // The booking snapshot is untouched; the history says who was told what.
  assert.equal(await rowOf('booking', 'id', booking.id), before);
  const history = (
    await owner.query<{ action: string; organisation_id: string; after_values: unknown }>(
      `SELECT action, organisation_id, after_values FROM trucker.audit_entry
       WHERE record_id = $1 AND action IN ('booking.confirmed', 'booking.assignment_changed')`,
      [booking.id],
    )
  ).rows;
  assert.deepEqual(history.map((row) => [row.action, row.organisation_id]).sort(), [
    ['booking.assignment_changed', carrier.org],
    ['booking.assignment_changed', carrier.org],
    ['booking.confirmed', shipper.org],
  ]);
  const told = JSON.stringify(history.find((row) => row.action === 'booking.confirmed'));
  assert.ok(!told.includes(truck.id) && !told.includes(affiliation));
  // A confirmation is a record of the past.
  await refused(
    () =>
      owner.query('UPDATE trucker.booking_confirmation SET set_no = 9 WHERE booking_id = $1', [
        booking.id,
      ]),
    /record of the past/,
  );
  await refused(
    () =>
      owner.query('DELETE FROM trucker.booking_confirmation WHERE booking_id = $1', [booking.id]),
    /record of the past/,
  );
  // Nothing here opened an occupancy.
  assert.equal(await count('occupancy_episode', 'booking_id = $1', [booking.id]), 0);

  // Only an administrator of the carrier assigns. Others: as for a missing record.
  const other = await verifiedCarrier();
  const outsider = await newPerson();
  for (const party of [shipper, other, { person: outsider, org: carrier.org }]) {
    const reply = await assign(party, booking.id, { version: 2, truckId: truck.id });
    assert.equal(reply.status, 404, reply.text);
  }
  assert.equal(
    (await call('GET', bookingRoute(other.org, booking.id), { token: other.person.token })).status,
    404,
  );
  assert.equal((await call('GET', bookingRoute(carrier.org, booking.id))).status, 401);
});

test('ASG-1: every hard requirement is checked for the whole planned interval and none can be waived; each refusal names the role and the first reason, and changes nothing', async () => {
  const carrier = await verifiedCarrier();
  const other = await verifiedCarrier();
  const { booking } = await booked(carrier);
  const good = await rigid(carrier);
  const box = await eligibleVehicle(carrier);
  const claimed = await registered(carrier.person, carrier.org, { equipmentType: 'curtain_side' });
  const theirs = await rigid(other);
  // Its documents lapse 60 hours from now, inside the planned interval of 46 to 70 hours.
  const lapsing = await eligibleVehicle(carrier, { equipmentType: 'curtain_side' }, day(2));
  const unit = await tractor(carrier);
  const trailer = await semiTrailer(carrier);
  const boxTrailer = await semiTrailer(carrier, 'box');
  const undocumented = await affiliated(carrier.person, carrier.org);
  const unauthorised = await affiliated(carrier.person, carrier.org);
  await driverDocuments(unauthorised.driver, ['fictional_class_2']);
  const lowerClass = await readyDriver(carrier, ['fictional_class_1']);
  const ready = await readyDriver(carrier);
  const theirDriver = await readyDriver(other);

  const refusedFor = async (set: Omit<Wanted, 'version'>, role: string, reason: string) => {
    const reply = await assign(carrier, booking.id, { version: 0, ...set });
    assert.deepEqual(refusal(reply), [409, 'resource_not_eligible', { role, reason }], reply.text);
    assert.equal((await reservationsOf(booking.id)).length, 0);
    assert.equal((await viewOf(carrier, booking.id)).assignmentVersion, 0);
  };
  await refusedFor({ truckId: box.id }, 'truck', 'equipment_mismatch');
  await refusedFor({ truckId: claimed.id }, 'truck', 'ownership_not_verified');
  await refusedFor({ truckId: theirs.id }, 'truck', 'not_found');
  await refusedFor({ truckId: lapsing.id }, 'truck', 'document_expires_in_window');
  await refusedFor({ truckId: trailer.id }, 'truck', 'not_found');
  // A trailer goes with a truck that pulls one, and carries the equipment type.
  await refusedFor({ trailerId: trailer.id }, 'trailer', 'truck_needed_first');
  await refusedFor({ truckId: good.id, trailerId: trailer.id }, 'trailer', 'trailer_not_needed');
  await refusedFor({ truckId: unit.id, trailerId: good.id }, 'trailer', 'not_found');
  await refusedFor({ truckId: unit.id, trailerId: boxTrailer.id }, 'trailer', 'equipment_mismatch');
  // Drivers: documents, an authorisation for the vehicle, a licence class that covers it.
  await refusedFor({ driverId: undocumented.affiliation }, 'driver', 'document_missing');
  await refusedFor(
    { truckId: good.id, driverId: unauthorised.affiliation },
    'driver',
    'not_authorised',
  );
  await refusedFor(
    { truckId: unit.id, trailerId: trailer.id, driverId: lowerClass.affiliation },
    'driver',
    'licence_class_not_covering',
  );
  await refusedFor({ driverId: theirDriver.affiliation }, 'driver', 'not_found');
  await refusedFor({ truckId: randomUUID() }, 'truck', 'not_found');

  // A tractor unit and a driver without the trailer: assigned, but not a complete set.
  const without = await assign(carrier, booking.id, {
    version: 0,
    truckId: unit.id,
    driverId: ready.affiliation,
  });
  assert.deepEqual(
    [without.status, without.body.outcome, (without.body.booking as View).status],
    [200, 'assigned', 'awaiting_resources'],
  );
  const withTrailer = await assign(carrier, booking.id, {
    version: 1,
    truckId: unit.id,
    trailerId: trailer.id,
    driverId: ready.affiliation,
  });
  assert.deepEqual(
    [withTrailer.status, withTrailer.body.outcome],
    [200, 'confirmed'],
    withTrailer.text,
  );
  assert.deepEqual(
    (withTrailer.body.booking as View).resources?.trailer?.registrationNumber,
    trailer.registrationNumber,
  );
  assert.deepEqual((await activeOf(booking.id)).map((item) => item.resource_kind).sort(), [
    'driver',
    'trailer',
    'truck',
  ]);
  // A malformed request is refused before the database is asked.
  const malformed = await call('POST', bookingRoute(carrier.org, booking.id, '/assignment'), {
    token: carrier.person.token,
    body: { version: 2, truckId: 'not-an-id', trailerId: null, driverId: null },
  });
  assert.equal(malformed.status, 422, malformed.text);
});

test('ASG-2: two simultaneous assignments of one resource to overlapping bookings leave exactly one reservation; intervals that touch both succeed; a driver is one person across carriers; the database itself refuses an overlap', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const first = await booked(carrier); // 46 to 70 hours
  const overlapping = await booked(carrier, 10, first.anchor); // 56 to 80 hours
  const touching = await booked(carrier, 24, first.anchor); // 70 to 94 hours

  const race = await Promise.all([
    assign(carrier, first.booking.id, { version: 0, truckId: truck.id }),
    assign(carrier, overlapping.booking.id, { version: 0, truckId: truck.id }),
  ]);
  assert.deepEqual(race.map((reply) => reply.status).sort(), [200, 409], JSON.stringify(race));
  const lost = race.find((reply) => reply.status === 409)!;
  assert.deepEqual(refusal(lost), [
    409,
    'resource_not_free',
    { role: 'truck', reason: 'reserved' },
  ]);
  assert.equal(await held(truck.id), 1);
  const winner = race[0]!.status === 200 ? first : overlapping;
  const loser = winner === first ? overlapping : first;
  assert.equal((await reservationsOf(loser.booking.id)).length, 0);

  // The same for a driver.
  const { driver, affiliation } = await readyDriver(carrier);
  const drivers = await Promise.all([
    assign(carrier, winner.booking.id, { version: 1, truckId: truck.id, driverId: affiliation }),
    assign(carrier, loser.booking.id, { version: 0, driverId: affiliation }),
  ]);
  assert.deepEqual(
    drivers.map((reply) => reply.status).sort(),
    [200, 409],
    JSON.stringify(drivers),
  );
  assert.deepEqual(refusal(drivers.find((reply) => reply.status === 409)!), [
    409,
    'resource_not_free',
    { role: 'driver', reason: 'reserved' },
  ]);
  assert.equal(await held(driver.personId), 1);

  // A booking whose planned interval starts where another ends takes the same truck.
  if (winner === first) {
    const next = await assign(carrier, touching.booking.id, { version: 0, truckId: truck.id });
    assert.equal(next.status, 200, next.text);
    const [earlier] = await activeOf(first.booking.id);
    const [later] = await activeOf(touching.booking.id);
    assert.equal(earlier!.until_at.getTime(), later!.from_at.getTime());
    assert.equal(await held(truck.id), 2);
  } else {
    // The overlapping booking won the truck: it overlaps the third one too.
    const next = await assign(carrier, touching.booking.id, { version: 0, truckId: truck.id });
    assert.deepEqual(refusal(next), [
      409,
      'resource_not_free',
      { role: 'truck', reason: 'reserved' },
    ]);
  }

  // The database refuses an overlap whoever writes it, and allows intervals that touch.
  const holder = (await activeOf(winner.booking.id)).find(
    (item) => item.resource_kind === 'truck',
  )!;
  const insert = (from: Date, until: Date, status = 'active') =>
    owner.query(
      `INSERT INTO trucker.resource_reservation
         (booking_id, resource_kind, vehicle_id, purpose, planned, status, created_by, created_at,
          released_at, release_reason)
       VALUES ($1, 'truck', $2, 'assignment', tstzrange($3, $4, '[)'), $5, $6, $7,
               CASE WHEN $5 = 'released' THEN $7::timestamptz END,
               CASE WHEN $5 = 'released' THEN 'unassigned' END)`,
      [loser.booking.id, truck.id, from, until, status, carrier.person.personId, clock()],
    );
  const inside = new Date(holder.from_at.getTime() + 3_600_000);
  await refused(() => insert(inside, holder.until_at), /resource_reservation_no_overlap/);
  await refused(
    () => insert(new Date(holder.from_at.getTime() - 3_600_000), inside),
    /resource_reservation_no_overlap/,
  );
  // A released reservation is history and blocks nothing.
  await insert(inside, holder.until_at, 'released');
  // An interval must be half-open and bounded.
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.resource_reservation
           (booking_id, resource_kind, vehicle_id, purpose, planned, created_by, created_at)
         VALUES ($1, 'truck', $2, 'assignment', tstzrange($3, $4, '[]'), $5, $6)`,
        [
          loser.booking.id,
          truck.id,
          new Date(holder.from_at.getTime() - 7_200_000),
          new Date(holder.from_at.getTime() - 3_600_000),
          carrier.person.personId,
          clock(),
        ],
      ),
    /resource_reservation_interval/,
  );

  // A driver who moves to another carrier is still the same person: reserved once.
  const side = await driverSide(driver);
  const left = await call('POST', `/me/driver/affiliations/${side.affiliation!.id}/leave`, {
    token: driver.token,
    key: key(),
    body: { version: side.affiliation!.version },
  });
  assert.equal(left.status, 200, left.text);
  const second = await verifiedCarrier();
  assert.equal((await invite(second.person, second.org, driver.phone)).status, 201);
  const invitation = (await driverSide(driver)).invitations[0]!;
  assert.equal((await respond(driver, invitation.id, invitation.version, 'accept')).status, 200);
  assert.equal((await authorise(second.person, second.org, invitation.id, null)).status, 200);
  const theirs = await booked(second, 5); // overlaps both earlier bookings
  const taken = await assign(second, theirs.booking.id, { version: 0, driverId: invitation.id });
  assert.deepEqual(refusal(taken), [
    409,
    'resource_not_free',
    { role: 'driver', reason: 'reserved' },
  ]);
  assert.deepEqual(
    (await detailOf(second, theirs.booking.id)).candidates!.drivers.map((item) => item.state),
    ['reserved'],
  );
  assert.equal(await held(driver.personId), 1);
});

test('reassignment follows the substitution rules: like-for-like takes effect at once, a hard requirement is never waived, the price cannot change, and a materially different substitute needs the shipper; the old set stays until the new one commits', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const spare = await rigid(carrier);
  const box = await eligibleVehicle(carrier);
  const unit = await tractor(carrier);
  const trailer = await semiTrailer(carrier);
  const one = await readyDriver(carrier);
  const two = await readyDriver(carrier);
  const { shipper, booking } = await booked(carrier);
  const row = await rowOf('booking', 'id', booking.id);
  await assigned(
    carrier,
    booking.id,
    { truckId: truck.id, driverId: one.affiliation },
    'confirmed',
  );
  const confirmation = await rowOf('booking_confirmation', 'booking_id', booking.id);
  assert.equal((await acknowledge(one.driver, booking.id, 1)).status, 200);
  assert.equal((await viewOf(carrier, booking.id)).dispatch.ready, true);

  // From confirmation on, a resource is replaced, not taken away.
  const removal = await reassign(carrier, booking.id, { driverId: null });
  assert.deepEqual([removal.status, removal.body.code], [409, 'assignment_incomplete']);
  // A substitute that fails a hard requirement is refused; the old set is intact.
  const waived = await reassign(carrier, booking.id, { truckId: box.id });
  assert.deepEqual(refusal(waived), [
    409,
    'resource_not_eligible',
    { role: 'truck', reason: 'equipment_mismatch' },
  ]);
  assert.deepEqual(
    (await activeOf(booking.id)).map((item) => item.resource_id).sort(),
    [truck.id, one.driver.personId].sort(),
  );
  assert.equal((await viewOf(carrier, booking.id)).dispatch.ready, true);

  // Like-for-like: another truck of the same category. It takes effect in one transaction,
  // and the earlier acknowledgement no longer stands.
  let view = await assigned(carrier, booking.id, { truckId: spare.id }, 'assigned');
  assert.deepEqual(
    [view.status, view.assignmentVersion, view.resources?.truck?.id, view.acknowledgedAt],
    ['confirmed', 2, spare.id, null],
  );
  assert.deepEqual(view.dispatch.blockers, [{ code: 'acknowledgement_missing' }]);
  assert.deepEqual(
    (await reservationsOf(booking.id))
      .filter((item) => item.resource_id === truck.id)
      .map((item) => [item.status, item.release_reason]),
    [['released', 'reassigned']],
  );
  assert.equal(await held(spare.id), 1);
  // N-1: the swap is in the shipper's history and on its page, with the registrations only.
  const plate = (vehicle: Vehicle) => ({
    registrationCountry: 'XA',
    registrationNumber: vehicle.registrationNumber,
  });
  const swapped = [{ role: 'truck', from: plate(truck), to: plate(spare) }];
  const swapAt = clock().getTime();
  for (const party of [shipper, carrier])
    assert.deepEqual(
      (await viewOf(party, booking.id)).vehicleChanges.map((item) => [ms(item.at), item.changes]),
      [[swapAt, swapped]],
    );
  const swapRecords = (
    await owner.query<{ organisation_id: string; after_values: unknown; before_values: unknown }>(
      `SELECT organisation_id, after_values, before_values FROM trucker.audit_entry
       WHERE record_id = $1 AND action = 'booking.vehicles_changed'`,
      [booking.id],
    )
  ).rows;
  assert.deepEqual(swapRecords, [
    { organisation_id: shipper.org, after_values: { changes: swapped }, before_values: null },
  ]);
  for (const hidden of [truck.id, spare.id, carrier.person.personId])
    assert.ok(!JSON.stringify(swapRecords).includes(hidden), `the record names ${hidden}`);
  // A change of driver: the same, and the driver who left sees nothing.
  view = await assigned(carrier, booking.id, { driverId: two.affiliation }, 'assigned');
  assert.equal(view.assignmentVersion, 3);
  assert.deepEqual(await assignmentsOf(one.driver), []);
  assert.equal((await acknowledge(one.driver, booking.id, 3)).status, 404);
  assert.equal((await acknowledge(two.driver, booking.id, 3)).status, 200);
  assert.equal((await viewOf(carrier, booking.id)).dispatch.ready, true);
  // A change of driver adds no vehicle change.
  assert.equal((await viewOf(shipper, booking.id)).vehicleChanges.length, 1);

  // Materially different: a tractor unit with a trailer in place of the rigid truck. It is a
  // proposal. The current set stays, and the substitute is held while the shipper decides.
  const proposed = await assigned(
    carrier,
    booking.id,
    { truckId: unit.id, trailerId: trailer.id },
    'proposed',
  );
  assert.deepEqual(
    [proposed.assignmentVersion, proposed.resources?.truck?.id, proposed.resources?.trailer],
    [3, spare.id, null],
  );
  assert.deepEqual(
    proposed.substitution!.differences.map((item) => [item.role, item.change]),
    [
      ['truck', 'category'],
      ['trailer', 'added'],
    ],
  );
  assert.deepEqual(
    (await activeOf(booking.id)).map((item) => [item.resource_id, item.purpose]).sort(),
    [
      [spare.id, 'assignment'],
      [two.driver.personId, 'assignment'],
      [unit.id, 'proposed_substitute'],
      [trailer.id, 'proposed_substitute'],
    ].sort(),
  );
  assert.equal((await viewOf(carrier, booking.id)).dispatch.ready, true);
  // The same request again is the same proposal; another change waits for the decision.
  await assigned(carrier, booking.id, { truckId: unit.id, trailerId: trailer.id }, 'proposed');
  assert.equal(await count('booking_substitution', 'booking_id = $1', [booking.id]), 1);
  const meanwhile = await reassign(carrier, booking.id, { truckId: truck.id });
  assert.deepEqual([meanwhile.status, meanwhile.body.code], [409, 'substitution_open']);
  // The held substitute cannot be booked elsewhere (AT-248).
  const elsewhere = await booked(carrier, 5);
  const taken = await assign(carrier, elsewhere.booking.id, { version: 0, truckId: unit.id });
  assert.deepEqual(refusal(taken), [
    409,
    'resource_not_free',
    { role: 'truck', reason: 'reserved' },
  ]);

  // The shipper is shown what would change; only the shipper decides, only the carrier withdraws.
  const forShipper = await viewOf(shipper, booking.id);
  assert.deepEqual(forShipper.substitution!.proposed, {
    truck: { registrationCountry: 'XA', registrationNumber: unit.registrationNumber },
    trailer: { registrationCountry: 'XA', registrationNumber: trailer.registrationNumber },
    driver: { name: 'Test Person (fictional)' },
  });
  const id = proposed.substitution!.id;
  assert.equal((await decideSubstitution(carrier, id, 1, 'accept')).status, 404);
  assert.equal((await decideSubstitution(shipper, id, 1, 'withdraw')).status, 404);
  assert.equal((await decideSubstitution(elsewhere.shipper, id, 1, 'accept')).status, 404);
  assert.deepEqual(refusal(await decideSubstitution(shipper, id, 2, 'accept')).slice(0, 2), [
    409,
    'assignment_changed',
  ]);
  // Declined: the substitute is free again, the set and its acknowledgement are as they were.
  const declined = await decideSubstitution(shipper, id, 1, 'decline');
  assert.deepEqual([declined.status, declined.body.outcome], [200, 'declined'], declined.text);
  assert.deepEqual(
    (await reservationsOf(booking.id))
      .filter((item) => [unit.id, trailer.id].includes(item.resource_id))
      .map((item) => [item.status, item.release_reason]),
    [
      ['released', 'proposal_declined'],
      ['released', 'proposal_declined'],
    ],
  );
  view = await viewOf(carrier, booking.id);
  assert.deepEqual(
    [view.assignmentVersion, view.substitution, view.dispatch.ready],
    [3, null, true],
  );
  assert.deepEqual(await decideSubstitution(shipper, id, 1, 'accept').then((reply) => reply.body), {
    outcome: 'already_decided',
    status: 'declined',
  });

  // A substitute that stops meeting a hard requirement cannot be accepted by the shipper
  // (AT-255): the proposal ends, and the shipper is not told what is wrong with the vehicle.
  const again1 = await assigned(
    carrier,
    booking.id,
    { truckId: unit.id, trailerId: trailer.id },
    'proposed',
  );
  assert.equal((await suspend('vehicle', unit.id, true)).status, 200);
  const failed = await decideSubstitution(shipper, again1.substitution!.id, 1, 'accept');
  assert.deepEqual(
    [failed.status, failed.body.code],
    [409, 'substitution_checks_failed'],
    failed.text,
  );
  assert.equal(await statusOf('booking_substitution', again1.substitution!.id), 'failed_checks');
  assert.deepEqual(
    (await activeOf(booking.id)).map((item) => item.resource_id).sort(),
    [spare.id, two.driver.personId].sort(),
  );
  const records = (
    await owner.query<{ organisation_id: string; after_values: Record<string, unknown> }>(
      `SELECT organisation_id, after_values FROM trucker.audit_entry
       WHERE record_id = $1 AND action = 'substitution.checks_failed'`,
      [again1.substitution!.id],
    )
  ).rows;
  assert.deepEqual(
    records.map((item) => [item.organisation_id, item.after_values.failed ?? null]).sort(),
    [
      [carrier.org, { role: 'truck', reason: 'suspended' }],
      [shipper.org, null],
    ].sort(),
  );
  assert.equal((await suspend('vehicle', unit.id, false)).status, 200);

  // Accepted: one transaction makes the substitute's reservations the booking's and releases
  // the original. The set number moves on, so the acknowledgement must be given again.
  const third = await assigned(
    carrier,
    booking.id,
    { truckId: unit.id, trailerId: trailer.id },
    'proposed',
  );
  const heldBefore = (await activeOf(booking.id)).filter(
    (item) => item.purpose === 'proposed_substitute',
  );
  const accepted = await decideSubstitution(shipper, third.substitution!.id, 1, 'accept');
  assert.deepEqual([accepted.status, accepted.body.outcome], [200, 'accepted'], accepted.text);
  // A substitution the shipper accepted is its own decision, not a vehicle change made for it.
  assert.equal((await viewOf(shipper, booking.id)).vehicleChanges.length, 1);
  view = await viewOf(carrier, booking.id);
  assert.deepEqual(
    [
      view.status,
      view.assignmentVersion,
      view.resources?.truck?.id,
      view.resources?.trailer?.id,
      view.resources?.driver?.affiliationId,
      view.substitution,
      view.acknowledgedAt,
    ],
    ['confirmed', 4, unit.id, trailer.id, two.affiliation, null, null],
  );
  const now = await reservationsOf(booking.id);
  assert.deepEqual(
    now
      .filter((item) => item.status === 'active')
      .map((item) => [item.id, item.purpose])
      .sort(),
    [
      ...heldBefore.map((item) => [item.id, 'assignment']),
      [
        now.find((item) => item.resource_id === two.driver.personId && item.status === 'active')!
          .id,
        'assignment',
      ],
    ].sort(),
  );
  assert.deepEqual(
    now
      .filter((item) => item.resource_id === spare.id)
      .map((item) => [item.status, item.release_reason]),
    [['released', 'substituted']],
  );
  assert.deepEqual(
    (await assignmentsOf(two.driver)).map((item) => [item.version, item.acknowledgedAt]),
    [[4, null]],
  );
  // The price cannot change through any of this (AT-247): the snapshot is the same row, and
  // the confirmation is the same record.
  assert.equal(await rowOf('booking', 'id', booking.id), row);
  assert.equal(await rowOf('booking_confirmation', 'booking_id', booking.id), confirmation);
  assert.equal((await viewOf(shipper, booking.id)).transportAmount, booking.transportAmount);
  assert.deepEqual(await consistency(), []);

  // Acceptance racing a withdrawal: one of them happens, the other finds it decided.
  const back = await assigned(
    carrier,
    booking.id,
    { truckId: spare.id, trailerId: null },
    'proposed',
  );
  const both = await Promise.all([
    decideSubstitution(shipper, back.substitution!.id, 1, 'accept'),
    decideSubstitution(carrier, back.substitution!.id, 1, 'withdraw'),
  ]);
  assert.deepEqual(
    both.map((reply) => reply.status),
    [200, 200],
    JSON.stringify(both),
  );
  const outcomes = both.map((reply) => reply.body.outcome as string).sort();
  assert.ok(
    JSON.stringify(outcomes) === JSON.stringify(['accepted', 'already_decided']) ||
      JSON.stringify(outcomes) === JSON.stringify(['already_decided', 'withdrawn']),
    JSON.stringify(outcomes),
  );
  const final = await statusOf('booking_substitution', back.substitution!.id);
  view = await viewOf(carrier, booking.id);
  assert.equal(view.resources?.truck?.id, final === 'accepted' ? spare.id : unit.id);
  assert.equal(
    (await activeOf(booking.id)).filter((item) => item.purpose === 'proposed_substitute').length,
    0,
  );
  assert.deepEqual(await consistency(), []);
});

test('a confirmed booking stays confirmed when a resource loses eligibility: dispatch is visibly blocked and reassignment is called for, nothing is cancelled, and the shipper is not told why', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const spare = await rigid(carrier);
  const { driver, affiliation } = await readyDriver(carrier);
  const { shipper, shipment, booking } = await booked(carrier);
  const confirmed = await assigned(
    carrier,
    booking.id,
    { truckId: truck.id, driverId: affiliation },
    'confirmed',
  );
  assert.equal((await acknowledge(driver, booking.id, 1)).status, 200);
  assert.deepEqual((await viewOf(carrier, booking.id)).dispatch, { ready: true, blockers: [] });
  const confirmation = await rowOf('booking_confirmation', 'booking_id', booking.id);

  // The truck is suspended. The confirmation is history; readiness is judged now.
  assert.equal((await suspend('vehicle', truck.id, true)).status, 200);
  let view = await viewOf(carrier, booking.id);
  assert.deepEqual(
    [view.status, view.confirmedAt, view.needsReassignment, view.dispatch],
    [
      'confirmed',
      confirmed.confirmedAt,
      true,
      {
        ready: false,
        blockers: [{ code: 'needs_reassignment', role: 'truck', reason: 'suspended' }],
      },
    ],
  );
  const forShipper = await viewOf(shipper, booking.id);
  assert.deepEqual(
    [forShipper.status, forShipper.needsReassignment, forShipper.dispatch],
    ['confirmed', true, { ready: false, blockers: [{ code: 'needs_reassignment' }] }],
  );
  assert.ok(!JSON.stringify(forShipper).includes('suspended'));
  // Both lists show it, and so does the operations queue. Nothing was cancelled or released.
  for (const party of [carrier, shipper])
    assert.equal(
      ((await bookingsOf(party.person, party.org)) as unknown as View[])[0]!.needsReassignment,
      true,
    );
  assert.ok(
    (await attention()).bookings.some((item) => item.id === booking.id && item.needsReassignment),
  );
  assert.equal((await activeOf(booking.id)).length, 2);
  assert.equal(await rowOf('booking_confirmation', 'booking_id', booking.id), confirmation);
  assert.equal(await statusOf('shipment_draft', shipment.id), 'awarded');
  assert.equal(await count('booking', 'shipment_id = $1', [shipment.id]), 1);

  // The carrier reassigns: a like-for-like truck. The suspended one cannot come back.
  view = await assigned(carrier, booking.id, { truckId: spare.id }, 'assigned');
  assert.deepEqual(
    [view.needsReassignment, view.dispatch.blockers],
    [false, [{ code: 'acknowledgement_missing' }]],
  );
  const back = await reassign(carrier, booking.id, { truckId: truck.id });
  assert.deepEqual(refusal(back), [
    409,
    'resource_not_eligible',
    { role: 'truck', reason: 'suspended' },
  ]);

  // The driver's affiliation ends: the same, for the driver.
  const record = (await fleetOf(carrier.person, carrier.org)).drivers.find(
    (item) => item.id === affiliation,
  )!;
  const ended = await call('POST', fleet(carrier.org, `/drivers/${affiliation}/end`), {
    token: carrier.person.token,
    key: key(),
    body: { version: record.version },
  });
  assert.equal(ended.status, 200, ended.text);
  view = await viewOf(carrier, booking.id);
  assert.deepEqual(
    [view.status, view.dispatch.blockers[0]],
    ['confirmed', { code: 'needs_reassignment', role: 'driver', reason: 'not_affiliated' }],
  );
  assert.deepEqual(await assignmentsOf(driver), []);

  // The carrier's capability is withdrawn: still confirmed, still not cancelled, and the
  // carrier can no longer assign.
  assert.equal((await revokeCapability(carrier.org, 'carry_as_company')).status, 200);
  const after = await detailOf(carrier, booking.id);
  assert.deepEqual(
    [after.booking.status, after.candidates, after.booking.dispatch.blockers[0]],
    [
      'confirmed',
      null,
      { code: 'needs_reassignment', role: 'truck', reason: 'carrier_not_eligible' },
    ],
  );
  const closed = await reassign(carrier, booking.id, { truckId: spare.id });
  assert.deepEqual([closed.status, closed.body.code], [403, 'carrier_not_eligible']);
  assert.equal((await viewOf(shipper, booking.id)).status, 'confirmed');
  assert.equal(await rowOf('booking_confirmation', 'booking_id', booking.id), confirmation);
});

test('ASG-7, AB-5: the assigned driver sees and acknowledges their own assignment and nothing else; the booking is confirmed without it, and dispatch is not ready until it is given', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const one = await readyDriver(carrier);
  const two = await readyDriver(carrier);
  const outsider = await newPerson();
  const { shipper, booking } = await booked(carrier);
  assert.deepEqual(await assignmentsOf(one.driver), []);
  assert.equal((await acknowledge(one.driver, booking.id, 1)).status, 404);

  const view = await assigned(
    carrier,
    booking.id,
    { truckId: truck.id, driverId: one.affiliation },
    'confirmed',
  );
  assert.deepEqual(view.dispatch, {
    ready: false,
    blockers: [{ code: 'acknowledgement_missing' }],
  });
  const mine = await assignmentsOf(one.driver);
  assert.deepEqual(
    mine.map((item) => [
      item.bookingId,
      item.version,
      item.acknowledgedAt,
      item.truck,
      item.trailer,
    ]),
    [
      [
        booking.id,
        1,
        null,
        { registrationCountry: 'XA', registrationNumber: truck.registrationNumber },
        null,
      ],
    ],
  );
  // No price, fee, address, access note, reference or shipper.
  const shown = JSON.stringify(mine);
  for (const hidden of [
    '1250.50',
    '37.52',
    'Warehouse 9',
    'Depot 3',
    'Gate code',
    'north entrance',
    'REF-PRIVATE',
    'Fixture Shipper',
    shipper.org,
  ])
    assert.ok(!shown.includes(hidden), `the driver is shown ${hidden}`);
  assert.ok(shown.includes('North industrial area') && shown.includes('Fixture Carrier'));
  // Nobody else sees it or can acknowledge it.
  assert.deepEqual(await assignmentsOf(two.driver), []);
  assert.deepEqual(await assignmentsOf(outsider), []);
  assert.deepEqual(await assignmentsOf(carrier.person), []);
  assert.equal((await call('GET', '/me/driver/assignments')).status, 401);
  for (const person of [two.driver, outsider, carrier.person, shipper.person])
    assert.equal((await acknowledge(person, booking.id, 1)).status, 404);
  // An acknowledgement is of the set that was shown.
  const stale = await acknowledge(one.driver, booking.id, 7);
  assert.deepEqual([stale.status, stale.body.code], [409, 'assignment_changed']);
  const at = clock();
  assert.deepEqual((await acknowledge(one.driver, booking.id, 1)).body, { outcome: 'recorded' });
  assert.deepEqual((await acknowledge(one.driver, booking.id, 1)).body, {
    outcome: 'already_recorded',
  });
  const after = await viewOf(carrier, booking.id);
  assert.deepEqual(
    [ms(after.acknowledgedAt), after.dispatch],
    [at.getTime(), { ready: true, blockers: [] }],
  );
  assert.equal(ms((await assignmentsOf(one.driver))[0]!.acknowledgedAt), at.getTime());
  const recorded = (
    await owner.query<{ organisation_id: string; actor_person_id: string }>(
      `SELECT organisation_id, actor_person_id FROM trucker.audit_entry
       WHERE record_id = $1 AND action = 'assignment.acknowledged'`,
      [booking.id],
    )
  ).rows;
  assert.deepEqual(recorded, [
    { organisation_id: carrier.org, actor_person_id: one.driver.personId },
  ]);
  // The shipper sees whether dispatch is ready, not who has yet to do what.
  assert.deepEqual((await viewOf(shipper, booking.id)).dispatch, { ready: true, blockers: [] });

  // The driver leaves the carrier: the assignment is no longer theirs to see.
  const side = await driverSide(one.driver);
  const left = await call('POST', `/me/driver/affiliations/${side.affiliation!.id}/leave`, {
    token: one.driver.token,
    key: key(),
    body: { version: side.affiliation!.version },
  });
  assert.equal(left.status, 200, left.text);
  assert.deepEqual(await assignmentsOf(one.driver), []);
  assert.equal((await viewOf(carrier, booking.id)).needsReassignment, true);
});

test('ASG-8, AB-4: after a missed assignment deadline the booking is shown as overdue; only the shipper records a decision to wait; nothing is cancelled or assigned automatically', async () => {
  let carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { affiliation } = await readyDriver(carrier);
  const made = await booked(carrier);
  let shipper: Party = made.shipper;
  const { booking, shipment } = made;
  const early = await waitFor(shipper, booking.id);
  assert.deepEqual([early.status, early.body.code], [409, 'assignment_not_overdue']);
  assert.equal((await viewOf(shipper, booking.id)).overdue, false);

  // The deadline is twelve hours after acceptance.
  await advance(12 * 3600 + 60);
  carrier = await freshParty(carrier);
  shipper = await freshParty(shipper);
  for (const party of [carrier, shipper]) {
    const view = await viewOf(party, booking.id);
    assert.deepEqual(
      [view.status, view.overdue, view.waitDecision],
      ['awaiting_resources', true, null],
    );
  }
  assert.ok((await attention()).bookings.some((item) => item.id === booking.id && item.overdue));
  // Nothing happened by itself.
  assert.equal((await reservationsOf(booking.id)).length, 0);
  assert.equal(await statusOf('shipment_draft', shipment.id), 'awarded');

  // A late carrier cannot convert silence into consent to wait.
  const refusedLateAssignment = await reassign(carrier, booking.id, {
    truckId: truck.id,
    driverId: affiliation,
  });
  assert.deepEqual(
    [refusedLateAssignment.status, refusedLateAssignment.body.code],
    [409, 'assignment_wait_required'],
  );
  assert.equal((await reservationsOf(booking.id)).length, 0);
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [booking.id]), 0);

  // Only the shipper decides to wait, once.
  assert.equal((await waitFor(carrier, booking.id)).status, 404);
  const at = clock();
  const waited = await waitFor(shipper, booking.id);
  assert.deepEqual(
    [waited.status, waited.body.outcome, ms((waited.body.booking as View).waitDecision!.decidedAt)],
    [200, 'recorded', at.getTime()],
  );
  const repeat = await waitFor(shipper, booking.id);
  assert.deepEqual([repeat.status, repeat.body.outcome], [200, 'already_recorded']);
  assert.equal(await count('booking_wait_decision', 'booking_id = $1', [booking.id]), 1);
  assert.equal(
    await count(
      'audit_entry',
      `record_id = $1 AND action = 'booking.wait_decided' AND organisation_id = $2`,
      [booking.id, shipper.org],
    ),
    1,
  );
  // A wait is never recorded before the deadline, whoever writes it.
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.booking_wait_decision (booking_id, decided_by, decided_at, assignment_due_at)
         SELECT b.id, b.accepted_by, b.assignment_due_at, b.assignment_due_at
         FROM trucker.booking b WHERE b.id <> $1 LIMIT 1`,
        [booking.id],
      ),
    /booking_wait_after_deadline/,
  );
  // The decision changes nothing else: still awaiting, still overdue, and the carrier's to assign.
  const still = await viewOf(carrier, booking.id);
  assert.deepEqual(
    [still.status, still.overdue, !!still.waitDecision],
    ['awaiting_resources', true, true],
  );
  const done = await assigned(
    carrier,
    booking.id,
    { truckId: truck.id, driverId: affiliation },
    'confirmed',
  );
  assert.deepEqual([done.status, done.overdue], ['confirmed', false]);

  // A confirmed booking has nothing to wait for.
  const next = await booked(carrier, 40);
  const other = await rigid(carrier);
  const second = await readyDriver(carrier);
  await assigned(
    carrier,
    next.booking.id,
    { truckId: other.id, driverId: second.affiliation },
    'confirmed',
  );
  await advance(12 * 3600 + 60);
  const late = await waitFor(await freshParty(next.shipper), next.booking.id);
  assert.deepEqual([late.status, late.body.code], [409, 'booking_confirmed']);
});

test('occupancy is separate from the plan: many closed episodes and one open; a resource still occupied past its planned end cannot be newly reserved before now, and puts a later booking at risk without cancelling it', async () => {
  let carrier = await verifiedCarrier();
  const one = await rigid(carrier);
  const two = await rigid(carrier);
  const first = await booked(carrier); // 46 to 70 hours
  const unassigned = await booked(carrier, 25); // 71 to 95 hours
  const second = await booked(carrier); // 46 to 70 hours
  const later = await booked(carrier, 32); // 78 to 102 hours
  await assigned(carrier, first.booking.id, { truckId: one.id }, 'assigned');
  await assigned(carrier, second.booking.id, { truckId: two.id }, 'assigned');
  await assigned(carrier, later.booking.id, { truckId: two.id }, 'assigned');

  // The database: any number of closed episodes for a resource, and one open.
  const a = await openEpisode(first.booking.id, one.id);
  await refused(() => openEpisode(first.booking.id, one.id), /occupancy_episode_one_open/);
  await closeEpisode(a);
  await closeEpisode(await openEpisode(first.booking.id, one.id));
  const open1 = await openEpisode(first.booking.id, one.id);
  assert.equal(await count('occupancy_episode', 'resource_id = $1', [one.id]), 3);
  assert.equal(
    await count('occupancy_episode', 'resource_id = $1 AND closed_at IS NULL', [one.id]),
    1,
  );
  const open2 = await openEpisode(second.booking.id, two.id);

  // Inside the plan: the later booking cannot be dispatched while its truck is out, but it is
  // not at risk, and nothing is recorded.
  let view = await viewOf(carrier, later.booking.id);
  assert.ok(
    view.dispatch.blockers.some(
      (item) => item.code === 'resource_occupied' && item.role === 'truck',
    ),
  );
  assert.equal(view.atRisk, false);
  assert.equal(await count('booking_risk_flag', 'booking_id = $1', [later.booking.id]), 0);

  // 72 hours on: both trucks are still out, past the planned end of 70 hours.
  await advance(72 * 3600);
  carrier = await freshParty(carrier);
  // Consent to wait is independent of resource availability.
  assert.equal(
    (await waitFor(await freshParty(unassigned.shipper), unassigned.booking.id)).status,
    200,
  );
  // A new reservation that would start before now is refused, exactly like an overlap.
  const blocked = await assign(carrier, unassigned.booking.id, { version: 0, truckId: one.id });
  assert.deepEqual(refusal(blocked), [
    409,
    'resource_not_free',
    { role: 'truck', reason: 'occupied' },
  ]);
  assert.equal(
    (await detailOf(carrier, unassigned.booking.id)).candidates!.vehicles.find(
      (item) => item.id === one.id,
    )!.state,
    'occupied',
  );
  assert.equal((await reservationsOf(unassigned.booking.id)).length, 0);

  // The later booking that already holds the other truck is at risk. It is flagged once, its
  // dispatch is blocked, and nothing is cancelled or reassigned.
  view = await viewOf(carrier, later.booking.id);
  assert.equal(view.atRisk, true);
  assert.ok(
    view.dispatch.blockers.some(
      (item) => item.code === 'resource_overrunning' && item.role === 'truck',
    ),
  );
  const overrun = async () =>
    (await reservationsOf(second.booking.id)).find((item) => item.resource_id === two.id)!
      .overrun_recorded_at;
  const seenAt = await overrun();
  assert.equal(seenAt!.getTime(), clock().getTime());
  await advance(600);
  carrier = await freshParty(carrier);
  const forShipper = await viewOf(await freshParty(later.shipper), later.booking.id);
  assert.deepEqual(
    [forShipper.atRisk, forShipper.dispatch.blockers.map((item) => Object.keys(item))],
    [true, forShipper.dispatch.blockers.map(() => ['code'])],
  );
  assert.ok(
    (await attention()).bookings.some((item) => item.id === later.booking.id && item.atRisk),
  );
  assert.equal(await count('booking_risk_flag', 'booking_id = $1', [later.booking.id]), 1);
  assert.equal((await overrun())!.getTime(), seenAt!.getTime());
  assert.equal((await activeOf(later.booking.id)).length, 1);
  assert.equal(await held(two.id), 2);

  // Released: the truck can be reserved, and the later booking is no longer at risk.
  await closeEpisode(open1);
  const free = await assign(carrier, unassigned.booking.id, { version: 0, truckId: one.id });
  assert.equal(free.status, 200, free.text);
  await closeEpisode(open2);
  view = await viewOf(carrier, later.booking.id);
  assert.deepEqual(
    [view.atRisk, view.dispatch.blockers.filter((item) => item.role === 'truck')],
    [false, []],
  );
  // Nothing in this slice wrote an episode: every one is the migration role's.
  assert.equal(await count('occupancy_episode'), 4);
});

test('ASG-9, ASG-10: the consistency check reports nothing for correct bookings and each seeded violation; the API role reaches the records only through functions; outside a marked database nothing is assigned', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { driver, affiliation } = await readyDriver(carrier);
  const { booking } = await booked(carrier);
  await assigned(carrier, booking.id, { truckId: truck.id, driverId: affiliation }, 'confirmed');
  assert.deepEqual(await consistency(), []);
  assert.deepEqual((await attention()).consistency, []);

  // Each violation is written by the migration role inside a transaction that is rolled back.
  const seeded = async (statements: [string, unknown[]][], expected: string[]) => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const [text, values] of statements) await client.query(text, values);
      const found = (
        await client.query<{ c: { code: string; booking: string }[] }>(
          'SELECT trucker.booking_consistency() AS c',
        )
      ).rows[0]!.c;
      assert.deepEqual(
        found.filter((item) => item.booking === booking.id).map((item) => item.code),
        expected,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };
  await seeded(
    [
      [
        `UPDATE trucker.booking_assignment SET status = 'ended', ended_at = now(), ended_set_no = 9
         WHERE booking_id = $1 AND role = 'truck'`,
        [booking.id],
      ],
    ],
    ['confirmed_missing_member', 'reservation_without_member'],
  );
  await seeded(
    [
      [
        `UPDATE trucker.resource_reservation SET status = 'released', released_at = now(), release_reason = 'unassigned'
         WHERE booking_id = $1 AND resource_kind = 'driver'`,
        [booking.id],
      ],
    ],
    ['member_without_reservation'],
  );
  const proposal = `INSERT INTO trucker.booking_substitution
      (id, booking_id, status, from_set_no, truck_id, affiliation_id, differences, proposed_by, proposed_at, decided_at)
    VALUES ('00000000-0000-4000-8000-000000000001', $1, 'declined', 1, $2, $3, '[{"role": "truck"}]', $4, now(), now())`;
  await seeded(
    [
      [proposal, [booking.id, truck.id, affiliation, carrier.person.personId]],
      [
        `INSERT INTO trucker.resource_reservation
           (booking_id, resource_kind, vehicle_id, purpose, substitution_id, planned, created_by, created_at)
         VALUES ($1, 'trailer', $2, 'proposed_substitute', '00000000-0000-4000-8000-000000000001',
                 tstzrange(now() + interval '900 hours', now() + interval '901 hours', '[)'), $3, now())`,
        [booking.id, truck.id, carrier.person.personId],
      ],
    ],
    ['proposed_reservation_without_proposal'],
  );
  await seeded(
    [
      [
        `INSERT INTO trucker.occupancy_episode (resource_kind, person_id, booking_id, reservation_id, opened_at)
         SELECT 'driver', r.person_id, r.booking_id, r.id, now() FROM trucker.resource_reservation r
         WHERE r.booking_id = $1 AND r.resource_kind = 'driver'`,
        [booking.id],
      ],
      [
        `UPDATE trucker.resource_reservation SET status = 'released', released_at = now(), release_reason = 'unassigned'
         WHERE booking_id = $1 AND resource_kind = 'driver'`,
        [booking.id],
      ],
    ],
    ['member_without_reservation', 'occupancy_without_reservation'],
  );
  assert.deepEqual(await consistency(), []);

  // The operations queue is for staff who hold a privilege, and each look is recorded.
  const plain = await newStaff([]);
  assert.equal(
    (await call('GET', '/staff/bookings/attention', { token: plain.token })).status,
    403,
  );
  assert.equal((await call('GET', '/staff/bookings/attention')).status, 401);
  assert.deepEqual(
    (await staffAudit(plain, 'staff.booking_attention')).map((row) => row.outcome),
    ['refused'],
  );
  assert.ok((await staffAudit(await reviewer(), 'staff.booking_attention')).length > 0);

  // The API role: no table, and each function decides for itself who is asking.
  await asApiRole({}, async (client) => {
    for (const table of NEW_TABLES) {
      await client.query('SAVEPOINT s');
      await refused(() => client.query(`SELECT 1 FROM trucker.${table}`), /permission denied/);
      await client.query('ROLLBACK TO SAVEPOINT s');
    }
    for (const [text, values] of [
      [
        'SELECT status FROM trucker.set_booking_assignment($1, 1, $2, NULL, $3, true)',
        [booking.id, truck.id, affiliation],
      ],
      ['SELECT status FROM trucker.booking_detail($1, true)', [booking.id]],
      ['SELECT status FROM trucker.record_booking_wait($1)', [booking.id]],
      ['SELECT status FROM trucker.driver_assignments(true)', []],
      ['SELECT status FROM trucker.driver_assignment_receipt($1, 1)', [booking.id]],
    ] as [string, unknown[]][])
      assert.equal(
        (await client.query<{ status: string }>(text, values)).rows[0]!.status,
        'unauthorized',
        text,
      );
    for (const text of [
      'SELECT trucker.booking_consistency()',
      'SELECT trucker.overrun_note(now())',
      'SELECT trucker.resource_lock(ARRAY[]::uuid[])',
      `SELECT trucker.reservation_blocker(gen_random_uuid(), gen_random_uuid(), now(), now(), now())`,
    ]) {
      await client.query('SAVEPOINT s');
      await refused(() => client.query(text), /permission denied/);
      await client.query('ROLLBACK TO SAVEPOINT s');
    }
  });
  // Outside a database marked for development the carrier is answered "closed".
  const session = await again(carrier.person);
  await asApiRole(
    { tokenHash: hashToken(session.token), organisationId: carrier.org },
    async (client) => {
      const reply = await client.query<{ status: string }>(
        'SELECT status FROM trucker.set_booking_assignment($1, 1, NULL, NULL, NULL, false)',
        [booking.id],
      );
      assert.equal(reply.rows[0]!.status, 'closed');
    },
  );
  await asApiRole({ tokenHash: hashToken((await again(driver)).token) }, async (client) => {
    const reply = await client.query<{ detail: unknown[] }>(
      'SELECT detail FROM trucker.driver_assignments(false)',
    );
    assert.deepEqual(reply.rows[0]!.detail, []);
  });
  assert.equal((await activeOf(booking.id)).length, 2);
});

// Cancellation before dispatch: use the same real journey, database and restricted role.
const cancelBooking = async (
  party: Party,
  bookingId: string,
  reason = 'other',
  note: string | null = 'Test cancellation',
  version?: number,
) =>
  call('POST', bookingRoute(party.org, bookingId, '/cancel'), {
    token: party.person.token,
    body: { version: version ?? (await viewOf(party, bookingId)).assignmentVersion, reason, note },
  });

test('CAN-1, CAN-5: only the booking parties cancel; validation refuses invalid reasons and keeps facts and private notes correctly', async () => {
  const carrier = await verifiedCarrier();
  const made = await booked(carrier);
  const outsider = await verifiedShipper();
  const missing = randomUUID();
  for (const id of [made.booking.id, missing]) {
    const reply = await call('POST', bookingRoute(outsider.org, id, '/cancel'), {
      token: outsider.person.token,
      body: { version: 0, reason: 'other', note: 'Secret' },
    });
    assert.equal(reply.status, 404);
  }
  assert.equal(
    (
      await call('POST', bookingRoute(made.shipper.org, made.booking.id, '/cancel'), {
        body: { version: 0, reason: 'other', note: 'x' },
      })
    ).status,
    401,
  );
  assert.equal(
    (await cancelBooking(made.shipper, made.booking.id, 'resource_unavailable')).status,
    422,
  );
  assert.equal((await cancelBooking(made.shipper, made.booking.id, 'other', '   ')).status, 422);
  assert.equal(await count('booking_cancellation', 'booking_id=$1', [made.booking.id]), 0);
  const reply = await cancelBooking(made.shipper, made.booking.id, 'other', 'Private note 7821');
  assert.deepEqual([reply.status, reply.body.outcome], [200, 'cancelled']);
  const mine = reply.body.booking as View & { cancellation: { note: string; chargeBasis: string } };
  assert.equal(mine.status, 'cancelled');
  assert.equal(mine.cancellation.note, 'Private note 7821');
  assert.equal(mine.cancellation.chargeBasis, 'none_recorded');
  const otherView = await detailOf(carrier, made.booking.id);
  assert.equal(JSON.stringify(otherView).includes('Private note 7821'), false);
  const facts = (
    await owner.query(`SELECT * FROM trucker.booking_cancellation WHERE booking_id=$1`, [
      made.booking.id,
    ])
  ).rows[0]!;
  assert.equal(facts.party, 'shipper');
  assert.equal(facts.was_confirmed, false);
  assert.equal(facts.assignment_overdue, false);
  assert.equal(
    facts.terms_hash,
    (await owner.query('SELECT terms_hash FROM trucker.booking WHERE id=$1', [made.booking.id]))
      .rows[0]!.terms_hash,
  );
  await assert.rejects(
    owner.query('UPDATE trucker.booking_cancellation SET note=$2 WHERE booking_id=$1', [
      made.booking.id,
      'rewritten',
    ]),
    /cannot be changed/,
  );
});

test('CAN-2, CAN-6, CAN-7: cancellation frees all resources, preserves snapshots, hides the driver assignment and blocks every further command', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { driver, affiliation } = await readyDriver(carrier);
  const made = await booked(carrier);
  const confirmed = await assigned(
    carrier,
    made.booking.id,
    { truckId: truck.id, driverId: affiliation },
    'confirmed',
  );
  assert.equal(
    (await acknowledge(driver, made.booking.id, confirmed.assignmentVersion)).status,
    200,
  );
  const snapshot = (
    await owner.query('SELECT to_jsonb(b) AS value FROM trucker.booking b WHERE id=$1', [
      made.booking.id,
    ])
  ).rows[0]!.value;
  const confirmation = (
    await owner.query(
      'SELECT to_jsonb(c) AS value FROM trucker.booking_confirmation c WHERE booking_id=$1',
      [made.booking.id],
    )
  ).rows[0]!.value;
  assert.equal(
    (await cancelBooking(carrier, made.booking.id, 'resource_unavailable', null, 0)).status,
    409,
  );
  assert.equal(
    (await cancelBooking(carrier, made.booking.id, 'resource_unavailable', null)).status,
    200,
  );
  assert.equal(
    (await reservationsOf(made.booking.id)).filter((x) => x.status === 'active').length,
    0,
  );
  assert.equal((await activeOf(made.booking.id)).length, 0);
  assert.equal(
    (await assignmentsOf(driver)).some((x) => x.bookingId === made.booking.id),
    false,
  );
  assert.equal((await viewOf(carrier, made.booking.id)).dispatch.ready, false);
  for (const response of [
    await assign(carrier, made.booking.id, {
      version: confirmed.assignmentVersion + 1,
      truckId: truck.id,
      driverId: affiliation,
    }),
    await acknowledge(driver, made.booking.id, confirmed.assignmentVersion + 1),
    await waitFor(made.shipper, made.booking.id),
  ])
    assert.equal(response.status, 409, response.text);
  assert.deepEqual(
    (
      await owner.query('SELECT to_jsonb(b) AS value FROM trucker.booking b WHERE id=$1', [
        made.booking.id,
      ])
    ).rows[0]!.value,
    snapshot,
  );
  assert.deepEqual(
    (
      await owner.query(
        'SELECT to_jsonb(c) AS value FROM trucker.booking_confirmation c WHERE booking_id=$1',
        [made.booking.id],
      )
    ).rows[0]!.value,
    confirmation,
  );
  assert.deepEqual(
    (await consistency()).filter((x) => x.booking === made.booking.id),
    [],
  );
  const next = await booked(carrier, 0, made.anchor);
  await assigned(
    carrier,
    next.booking.id,
    { truckId: truck.id, driverId: affiliation },
    'confirmed',
  );
});

test('CAN-3: lost-response retries and simultaneous cancellations leave one record and one event per party', async () => {
  const carrier = await verifiedCarrier();
  const made = await booked(carrier);
  const replies = await Promise.all([
    cancelBooking(made.shipper, made.booking.id, 'dates_changed', null, 0),
    cancelBooking(carrier, made.booking.id, 'cannot_meet_window', null, 0),
  ]);
  assert.deepEqual(
    replies.map((x) => x.status),
    [200, 200],
  );
  assert.deepEqual(replies.map((x) => x.body.outcome).sort(), ['already_cancelled', 'cancelled']);
  const before = (
    await owner.query(
      'SELECT to_jsonb(c) AS value FROM trucker.booking_cancellation c WHERE booking_id=$1',
      [made.booking.id],
    )
  ).rows[0]!.value;
  assert.equal(
    (await cancelBooking(made.shipper, made.booking.id, 'other', 'Different retry', 0)).body
      .outcome,
    'already_cancelled',
  );
  assert.equal(await count('booking_cancellation', 'booking_id=$1', [made.booking.id]), 1);
  assert.equal(
    await count('audit_entry', "record_id=$1 AND action='booking.cancelled'", [made.booking.id]),
    2,
  );
  assert.deepEqual(
    (
      await owner.query(
        'SELECT to_jsonb(c) AS value FROM trucker.booking_cancellation c WHERE booking_id=$1',
        [made.booking.id],
      )
    ).rows[0]!.value,
    before,
  );
});

test('CAN-4: cancellation racing assignment leaves no active resource and no confirmation after cancellation', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { affiliation } = await readyDriver(carrier);
  const made = await booked(carrier);
  const [cancelled, assignedReply] = await Promise.all([
    cancelBooking(made.shipper, made.booking.id, 'dates_changed', null, 0),
    assign(carrier, made.booking.id, { version: 0, truckId: truck.id, driverId: affiliation }),
  ]);
  // If assignment wins, cancellation's stale version must be explicitly retried.
  assert.ok([200, 409].includes(cancelled.status), cancelled.text);
  assert.ok([200, 409].includes(assignedReply.status), assignedReply.text);
  if (cancelled.status === 409)
    assert.equal(
      (await cancelBooking(made.shipper, made.booking.id, 'dates_changed', null)).status,
      200,
    );
  assert.equal(
    (await reservationsOf(made.booking.id)).filter((x) => x.status === 'active').length,
    0,
  );
  assert.equal((await activeOf(made.booking.id)).length, 0);
  assert.equal((await viewOf(made.shipper, made.booking.id)).status, 'cancelled');
});

test('CAN-7: any occupancy episode marks the dispatch boundary; cancellation cannot release occupied or previously dispatched resources', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const made = await booked(carrier);
  await assigned(carrier, made.booking.id, { truckId: truck.id }, 'assigned');
  const episode = await openEpisode(made.booking.id, truck.id);
  assert.equal(
    (await cancelBooking(carrier, made.booking.id, 'resource_unavailable', null)).status,
    409,
  );
  assert.equal(
    (await reservationsOf(made.booking.id)).filter((x) => x.status === 'active').length,
    1,
  );
  assert.equal(await count('booking_cancellation', 'booking_id=$1', [made.booking.id]), 0);
  await closeEpisode(episode);
  assert.equal(
    (await cancelBooking(carrier, made.booking.id, 'resource_unavailable', null)).status,
    409,
  );
});

test('CAN-8: accept, cancel, republish and accept creates a new booking per cycle and preserves earlier bookings and quotations', async () => {
  const carrier = await verifiedCarrier();
  const made = await booked(carrier);
  assert.equal(
    (await cancelBooking(made.shipper, made.booking.id, 'dates_changed', null)).status,
    200,
  );
  const current = await call('GET', shipments(made.shipper.org, `/${made.shipment.id}`), {
    token: made.shipper.person.token,
  });
  assert.equal(current.status, 200, current.text);
  const cancelledShipment = current.body.shipment as Shipment;
  assert.equal(cancelledShipment.status, 'booking_cancelled');
  // The shipments list offers the state as a filter, and it lists this shipment.
  const listed = await call('GET', shipments(made.shipper.org, '?status=booking_cancelled'), {
    token: made.shipper.person.token,
  });
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(
    (listed.body.shipments as { id: string }[]).map((item) => item.id),
    [made.shipment.id],
  );
  const republished = await act(
    made.shipper.person,
    made.shipper.org,
    made.shipment.id,
    'republish',
    {
      version: cancelledShipment.version,
      quotationDeadline: { local: local(24) },
    },
  );
  assert.equal(republished.status, 200, republished.text);
  const newCycle = (republished.body.shipment as Shipment).publication.publicationCycle;
  assert.notEqual(newCycle, made.shipment.publication.publicationCycle);
  // The history says which state the shipment was republished from.
  const republishedFrom = await owner.query<{ status: string }>(
    `SELECT before_values ->> 'status' AS status FROM trucker.audit_entry
     WHERE record_id = $1 AND action = 'shipment.republished'`,
    [made.shipment.id],
  );
  assert.deepEqual(republishedFrom.rows, [{ status: 'booking_cancelled' }]);
  const quotation = await quoted(carrier.person, carrier.org, made.shipment.id);
  const accepted = await accept(made.shipper.person, made.shipper.org, quotation.id, 1);
  assert.equal(accepted.status, 200, accepted.text);
  const next = accepted.body.booking as Booking;
  assert.notEqual(next.id, made.booking.id);
  assert.equal(await count('booking', 'shipment_id=$1', [made.shipment.id]), 2);
  assert.equal(await count('booking_publication_cycle', 'shipment_id=$1', [made.shipment.id]), 2);
  assert.equal((await viewOf(carrier, made.booking.id)).status, 'cancelled');
  assert.equal((await viewOf(carrier, next.id)).status, 'awaiting_resources');
  const staff = await newStaff(['reviewer']);
  for (const [id, state] of [
    [made.booking.id, 'cancelled'],
    [next.id, 'awaiting_resources'],
  ]) {
    const read = await call('GET', `/staff/bookings/${id}/detail`, { token: staff.token });
    assert.equal(read.status, 200, read.text);
    assert.equal((read.body.booking as Booking).status, state);
  }
  const plain = await newStaff([]);
  assert.equal(
    (await call('GET', `/staff/bookings/${made.booking.id}/detail`, { token: plain.token })).status,
    403,
  );
});

test('CAN-4: a pending substitution is ended atomically and cannot be accepted after cancellation', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const unit = await tractor(carrier);
  const trailer = await semiTrailer(carrier);
  const { driver, affiliation } = await readyDriver(carrier);
  const made = await booked(carrier);
  await assigned(
    carrier,
    made.booking.id,
    { truckId: truck.id, driverId: affiliation },
    'confirmed',
  );
  const proposed = await assigned(
    carrier,
    made.booking.id,
    { truckId: unit.id, trailerId: trailer.id },
    'proposed',
  );
  assert.ok(proposed.substitution);
  const original = proposed.substitution!;
  assert.equal(
    (await cancelBooking(made.shipper, made.booking.id, 'dates_changed', null)).status,
    200,
  );
  assert.equal(
    await count('booking_substitution', "booking_id=$1 AND status='proposed'", [made.booking.id]),
    0,
  );
  assert.equal(
    (await reservationsOf(made.booking.id)).filter((x) => x.status === 'active').length,
    0,
  );
  assert.equal(
    (await decideSubstitution(made.shipper, original.id, original.version, 'accept')).status,
    409,
  );
  assert.equal(
    (await acknowledge(driver, made.booking.id, proposed.assignmentVersion)).status,
    409,
  );
  assert.deepEqual(
    (await consistency()).filter((x) => x.booking === made.booking.id),
    [],
  );
});

test('CAN-4: a cancellation waiting behind the assignment lock rechecks session expiry and saves nothing', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const made = await booked(carrier);
  await assigned(carrier, made.booking.id, { truckId: truck.id }, 'assigned');
  const { whileBlocked } = blockedRequests(() => owner, advance);
  const reply = await whileBlocked(
    [
      'SELECT 1 FROM trucker.booking_assignment_state WHERE booking_id=$1 FOR UPDATE',
      [made.booking.id],
    ],
    () => cancelBooking(made.shipper, made.booking.id, 'dates_changed', null, 1),
    D.session_idle_minutes * 60 + 1,
  );
  assert.equal(reply.status, 401, reply.text);
  assert.equal(await count('booking_cancellation', 'booking_id=$1', [made.booking.id]), 0);
  assert.equal(
    (await reservationsOf(made.booking.id)).filter((x) => x.status === 'active').length,
    1,
  );
});

test('CAN-9: consistency detects a seeded active reservation on a cancelled booking; identity and cancellation tables remain private', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const made = await booked(carrier);
  await assigned(carrier, made.booking.id, { truckId: truck.id }, 'assigned');
  assert.equal(
    (await cancelBooking(carrier, made.booking.id, 'resource_unavailable', null)).status,
    200,
  );
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE trucker.resource_reservation SET status='active',released_at=NULL,release_reason=NULL WHERE booking_id=$1",
      [made.booking.id],
    );
    const found = (
      await client.query<{ v: { code: string; booking: string }[] }>(
        'SELECT trucker.booking_consistency() AS v',
      )
    ).rows[0]!.v;
    assert.ok(
      found.some((x) => x.code === 'cancelled_active_reservation' && x.booking === made.booking.id),
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  for (const table of ['booking_cancellation', 'booking_publication_cycle'])
    await refused(() => app.query(`SELECT * FROM trucker.${table}`), /permission denied/);
  await refused(
    () => app.query('SELECT trucker.cancellation_values($1,$2)', [made.booking.id, 'staff']),
    /permission denied/,
  );
});

test('CAN-4: cancellation races acknowledgement and substitution decisions without leaving live resources', async () => {
  for (const operation of ['acknowledge', 'substitution'] as const) {
    const carrier = await verifiedCarrier();
    const truck = await rigid(carrier);
    const { driver, affiliation } = await readyDriver(carrier);
    const made = await booked(carrier);
    let detail = await assigned(
      carrier,
      made.booking.id,
      { truckId: truck.id, driverId: affiliation },
      'confirmed',
    );
    if (operation === 'substitution') {
      const unit = await tractor(carrier);
      const trailer = await semiTrailer(carrier);
      detail = await assigned(
        carrier,
        made.booking.id,
        { truckId: unit.id, trailerId: trailer.id },
        'proposed',
      );
    }
    const [cancelled, competing] = await Promise.all([
      cancelBooking(made.shipper, made.booking.id, 'dates_changed', null, detail.assignmentVersion),
      operation === 'acknowledge'
        ? acknowledge(driver, made.booking.id, detail.assignmentVersion)
        : decideSubstitution(
            made.shipper,
            detail.substitution!.id,
            detail.substitution!.version,
            'accept',
          ),
    ]);
    assert.ok([200, 409].includes(cancelled.status), cancelled.text);
    assert.ok([200, 409].includes(competing.status), competing.text);
    if (cancelled.status === 409) {
      const latest = await viewOf(made.shipper, made.booking.id);
      const retry = await cancelBooking(
        made.shipper,
        made.booking.id,
        'dates_changed',
        null,
        latest.assignmentVersion,
      );
      assert.equal(retry.status, 200, retry.text);
    }
    assert.equal((await viewOf(carrier, made.booking.id)).status, 'cancelled');
    assert.equal(
      (await reservationsOf(made.booking.id)).filter((x) => x.status === 'active').length,
      0,
    );
    assert.equal((await activeOf(made.booking.id)).length, 0);
    assert.equal(
      await count('booking_substitution', "booking_id=$1 AND status='proposed'", [made.booking.id]),
      0,
    );
    assert.deepEqual(
      (await consistency()).filter((x) => x.booking === made.booking.id),
      [],
    );
  }
});
