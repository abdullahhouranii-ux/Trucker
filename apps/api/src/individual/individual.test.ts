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

// Assignment, reservation and confirmation (slice 15). Real PostgreSQL, the API connected as
// Individual accounts and truck owners (slice 21). Real PostgreSQL, the API connected as its
// restricted role. The helpers are those of the assignment tests: every participant, vehicle,
// driver and booking is made through the routes of the earlier slices. Test accounts and
// fictional evidence only.
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
  return { shipper, shipment, booking: reply.body.booking as Booking, anchor };
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

// ---------------------------------------------------------------------------------------------
// Personal accounts
// ---------------------------------------------------------------------------------------------
const createPersonal = (person: Person, over: Record<string, unknown> = {}): Promise<Reply> =>
  call('POST', '/organisations', {
    token: person.token,
    key: key(),
    body: {
      kind: 'individual',
      legalName: 'Fixture Individual (fictional)',
      countryCode: 'XA',
      registrationNumber: newNumber(),
      ...over,
    },
  });
async function personalAccount(person?: Person): Promise<Party> {
  const who = person ?? (await newPerson());
  const reply = await createPersonal(who);
  assert.equal(reply.status, 201, reply.text);
  const made = reply.body.organisation as { id: string; kind: string };
  assert.equal(made.kind, 'individual');
  return { person: who, org: made.id };
}
const identity = {
  documentType: 'identity_evidence',
  documentNumber: 'ID-1',
  issuingCountry: 'XA',
};
const ownerBody = (extra: Record<string, unknown> = {}) => ({
  capability: 'carry_as_owner_operator',
  service: SERVICE,
  evidence: [
    identity,
    { documentType: 'owner_operator_permit', documentNumber: 'OP-2', issuingCountry: 'XA' },
  ],
  ...extra,
});
const organiseBody = () => ({ capability: 'organise', evidence: [identity] });
async function granted(party: Party, body: Record<string, unknown>): Promise<void> {
  const application = await submitted(party.person, party.org, body);
  const reply = await decide(await reviewer(), application.id, 'verified');
  assert.equal(reply.status, 200, reply.text);
}
/** A verified truck owner: a personal account holding carry_as_owner_operator. */
async function truckOwner(person?: Person): Promise<Party> {
  const party = await personalAccount(person);
  await granted(party, ownerBody());
  return party;
}
const register = (person: Person, org: string, body: Record<string, unknown>): Promise<Reply> =>
  call('POST', fleet(org, '/vehicles'), { token: person.token, key: key(), body });
const asParty = <T>(party: Party, work: (client: pg.PoolClient) => Promise<T>): Promise<T> =>
  asApiRole({ tokenHash: hashToken(party.person.token), organisationId: party.org }, work);
const becomeOwnDriver = (party: Party): Promise<Reply> =>
  call('POST', fleet(party.org, '/drivers/self'), { token: party.person.token });
const problemCodes = (reply: Reply): string[] =>
  ((reply.body.details as { problems?: { code: string }[] } | undefined)?.problems ?? []).map(
    (problem) => problem.code,
  );
const errorCode = (reply: Reply): string => reply.body.code as string;

test('IA-1, IA-2: one personal account per person, with one member for good; each kind of account applies only for the capabilities it may hold', async () => {
  const person = await newPerson();
  const account = await personalAccount(person);
  // A second one is refused, also when two are asked for at the same moment.
  const second = await createPersonal(person);
  assert.equal(second.status, 409, second.text);
  assert.equal(errorCode(second), 'personal_account_exists');
  const racer = await newPerson();
  const both = await Promise.all([createPersonal(racer), createPersonal(racer)]);
  assert.deepEqual(both.map((reply) => reply.status).sort(), [201, 409]);
  assert.equal(
    await count('organisation', "created_by = $1 AND kind = 'individual'", [racer.personId]),
    1,
  );
  // A company is still a company, and a person may hold both.
  const company = await newOrganisation(person);
  const read = await call('GET', `/organisations/${company}`, { token: person.token });
  assert.equal((read.body.organisation as { kind: string }).kind, 'company');

  // The database itself keeps the account to its one member and its kind.
  const other = await newPerson();
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.membership (organisation_id, person_id, role, created_at)
         VALUES ($1, $2, 'admin', now())`,
        [account.org, other.personId],
      ),
    /a personal account has one member/,
  );
  await refused(
    () =>
      owner.query("UPDATE trucker.organisation SET kind = 'company' WHERE id = $1", [account.org]),
    /the kind of an account is fixed/,
  );
  // The API's role cannot create one by writing the table, nor call the building blocks.
  await refused(
    () =>
      asParty(account, (client) =>
        client.query("UPDATE trucker.organisation SET kind = 'company' WHERE id = $1", [
          account.org,
        ]),
      ),
    /permission denied/,
  );
  await refused(
    () =>
      asParty(account, (client) => client.query('SELECT trucker.is_carrier($1)', [account.org])),
    /permission denied/,
  );

  // What each kind may apply for.
  for (const capability of ['ship', 'carry_as_company']) {
    const reply = await submit(person, account.org, { capability, evidence: evidence() });
    assert.equal(reply.status, 422, reply.text);
    assert.ok(problemCodes(reply).includes('not_for_account_kind'), reply.text);
  }
  const wrong = await submit(person, company, ownerBody());
  assert.equal(wrong.status, 422, wrong.text);
  assert.ok(problemCodes(wrong).includes('not_for_account_kind'), wrong.text);
  assert.equal(
    await count('verification_application', 'organisation_id = ANY ($1)', [[account.org, company]]),
    0,
  );
  const offered = (await overview(person, account.org)) as unknown as {
    mayApply: Record<string, string | null>;
  };
  assert.deepEqual(offered.mayApply, {
    ship: null,
    carry_as_company: null,
    organise: 'initial',
    carry_as_owner_operator: 'initial',
  });
  // Whatever path wrote it, a capability the kind may not hold is never recorded.
  await granted(account, organiseBody());
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.organisation_capability (organisation_id, capability, status, basis, granted_application, granted_at)
         SELECT organisation_id, 'ship', status, basis, granted_application, granted_at
         FROM trucker.organisation_capability WHERE organisation_id = $1`,
        [account.org],
      ),
    /cannot hold this capability/,
  );
});

test('IA-3, IA-4, IA-5, P2-1: a verified truck owner holds one truck and one trailer, is its own and only driver, and works the journey to a confirmed booking under the same checks as a company', async () => {
  const account = await personalAccount();
  // Not a carrier until staff decide.
  assert.equal(
    (await call('GET', fleet(account.org), { token: account.person.token })).status,
    403,
  );
  const application = await submitted(account.person, account.org, ownerBody());
  const waiting = (await call('GET', '/staff/verification', { token: (await reviewer()).token }))
    .body.applications as { applicationId: string; accountKind: string; capability: string }[];
  assert.deepEqual(
    waiting
      .filter((entry) => entry.applicationId === application.id)
      .map((entry) => [entry.accountKind, entry.capability]),
    [['individual', 'carry_as_owner_operator']],
  );
  assert.equal((await decide(await reviewer(), application.id, 'verified')).status, 200);
  const owned: Party = account;

  // One truck and one trailer; the same registration twice at once leaves one.
  const truck = await eligibleVehicle(owned, { equipmentType: 'curtain_side' });
  const more = await register(owned.person, owned.org, vehicleBody());
  assert.equal(more.status, 409, more.text);
  assert.equal(errorCode(more), 'owner_fleet_limit');
  const trailers = await Promise.all([
    register(
      owned.person,
      owned.org,
      vehicleBody({ kind: 'trailer', category: 'fictional_semi_trailer' }),
    ),
    register(
      owned.person,
      owned.org,
      vehicleBody({ kind: 'trailer', category: 'fictional_semi_trailer' }),
    ),
  ]);
  assert.deepEqual(trailers.map((reply) => reply.status).sort(), [201, 409]);
  assert.equal(
    await count('vehicle', "organisation_id = $1 AND status = 'active'", [owned.org]),
    2,
  );

  // Nobody is invited; the owner becomes the driver by their own act, once.
  const invited = await invite(owned.person, owned.org, (await newPerson()).phone);
  assert.equal(invited.status, 409, invited.text);
  assert.equal(errorCode(invited), 'owner_is_only_driver');
  const first = await becomeOwnDriver(owned);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.outcome, 'affiliated');
  assert.equal((await becomeOwnDriver(owned)).body.outcome, 'already_affiliated');
  assert.equal(await count('driver_affiliation', 'organisation_id = $1', [owned.org]), 1);
  const affiliation = (await fleetOf(owned.person, owned.org)).drivers[0]!.id;
  // A company account cannot use this route.
  const company = await verifiedCarrier();
  const notPersonal = await becomeOwnDriver(company);
  assert.equal(notPersonal.status, 409, notPersonal.text);
  assert.equal(errorCode(notPersonal), 'not_a_personal_account');

  // No rule is relaxed: without accepted driver documents the owner is not an eligible driver.
  const { shipper, booking } = await booked(owned);
  const early = await detailOf(owned, booking.id);
  assert.deepEqual(
    early.candidates!.vehicles.filter((item) => item.id === truck.id).map((item) => item.state),
    ['eligible'],
  );
  assert.notEqual(early.candidates!.drivers[0]!.state, 'eligible');
  await driverDocuments(owned.person, ['fictional_class_2']);
  assert.equal((await authorise(owned.person, owned.org, affiliation, null)).status, 200);

  // The shipper is told which kind of account quoted, and nothing more about the person.
  const compared = await call(
    'GET',
    `/organisations/${shipper.org}/shipments/${booking.shipmentId}/quotations`,
    { token: shipper.person.token },
  );
  assert.equal(compared.status, 200, compared.text);
  assert.match(compared.text, /"accountKind":"individual"/);
  assert.ok(!compared.text.includes(owned.person.phone));

  const confirmed = await assigned(
    owned,
    booking.id,
    { truckId: truck.id, driverId: affiliation },
    'confirmed',
  );
  assert.equal(confirmed.status, 'confirmed');
  const mine = (await assignmentsOf(owned.person)).find((item) => item.bookingId === booking.id)!;
  assert.equal((await acknowledge(owned.person, booking.id, mine.version)).status, 200);

  // Suspended or revoked: no new work, and the booking is not cancelled by it.
  assert.equal((await revokeCapability(owned.org, 'carry_as_owner_operator')).status, 200);
  assert.equal((await call('GET', fleet(owned.org), { token: owned.person.token })).status, 403);
  assert.equal(await count('booking_cancellation', 'booking_id = $1', [booking.id]), 0);
  // Cancellation before dispatch still works for the shipper.
  assert.equal((await cancelBooking(shipper, booking.id)).status, 200);
  assert.equal(
    await count('resource_reservation', "booking_id = $1 AND status = 'active'", [booking.id]),
    0,
  );
});

test('IA-6: one active affiliation per driver holds between a company and the driver’s own account, also when both are attempted at once', async () => {
  // Driving for a company: cannot become their own driver.
  const company = await verifiedCarrier();
  const { driver, affiliation } = await affiliated(company.person, company.org);
  const owned = await truckOwner(driver);
  const blocked = await becomeOwnDriver(owned);
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(errorCode(blocked), 'driver_affiliation_exists');
  // After leaving the company they can; then a company's invitation cannot be accepted.
  const left = await call('POST', `/me/driver/affiliations/${affiliation}/leave`, {
    token: driver.token,
    key: key(),
    body: { version: (await driverSide(driver)).affiliation!.version },
  });
  assert.equal(left.status, 200, left.text);
  assert.equal((await becomeOwnDriver(owned)).body.outcome, 'affiliated');
  assert.equal((await invite(company.person, company.org, driver.phone)).status, 201);
  const invitation = (await driverSide(driver)).invitations[0]!;
  const accepted = await respond(driver, invitation.id, invitation.version, 'accept');
  assert.equal(accepted.status, 409, accepted.text);
  assert.equal(errorCode(accepted), 'driver_affiliation_exists');

  // Both at the same moment: exactly one active affiliation results.
  const other = await newPerson();
  const account = await truckOwner(other);
  assert.equal((await invite(company.person, company.org, other.phone)).status, 201);
  const offer = (await driverSide(other)).invitations[0]!;
  const raced = await Promise.all([
    becomeOwnDriver(account),
    respond(other, offer.id, offer.version, 'accept'),
  ]);
  assert.deepEqual(
    raced.map((reply) => reply.status).sort(),
    [200, 409],
    JSON.stringify(raced.map((r) => r.text)),
  );
  assert.equal(
    await count('driver_affiliation', "person_id = $1 AND status = 'active'", [other.personId]),
    1,
  );
});

test('IA-6: an acceptance waiting its turn for the person holds no row that another command of the same person needs', async () => {
  // The order of locks, made visible: the turn for the person is taken before anything else,
  // so two commands of one person can never each hold what the other waits for.
  const company = await verifiedCarrier();
  const other = await newPerson();
  assert.equal((await invite(company.person, company.org, other.phone)).status, 201);
  const offer = (await driverSide(other)).invitations[0]!;
  const holder = await owner.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('driver.affiliation:' || $1::text, 0))",
      [other.personId],
    );
    const waiting = respond(other, offer.id, offer.version, 'accept');
    let seen = 0;
    for (let attempt = 0; attempt < 100 && seen === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen = (
        await owner.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")
      ).rowCount!;
    }
    assert.equal(seen, 1, 'the acceptance is waiting for the person’s turn');
    // Nothing of the person is held meanwhile: this would wait, and here fail, if it were.
    await holder.query('SELECT 1 FROM trucker.person WHERE id = $1 FOR UPDATE NOWAIT', [
      other.personId,
    ]);
    await holder.query('COMMIT');
    const reply = await waiting;
    assert.equal(reply.status, 200, reply.text);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
});

test('A-11, P2-2, IA-7: an organiser publishes its own shipments once verified; one personal account may organise and carry but never quotes on its own shipment; nothing of a personal account is readable by another', async () => {
  const coordinator = await personalAccount();
  const made = await draft(coordinator.person, coordinator.org);
  const tooEarly = await act(coordinator.person, coordinator.org, made.id, 'publish', {
    version: made.version,
    ...details(),
  });
  assert.notEqual(tooEarly.status, 200);
  await granted(coordinator, organiseBody());
  const published = await act(coordinator.person, coordinator.org, made.id, 'publish', {
    version: made.version,
    ...details(),
  });
  assert.equal(published.status, 200, published.text);
  const shipment = (published.body.shipment as Shipment).id;
  assert.equal((await setTerms(coordinator.person, coordinator.org, shipment)).status, 200);
  // A broker is a company holding the same capability.
  const broker = await newShipper({ legalName: 'Fixture Broker (fictional)' });
  await granted(broker, organiseBody());
  const brokerDraft = await draft(broker.person, broker.org);
  assert.equal(
    (
      await act(broker.person, broker.org, brokerDraft.id, 'publish', {
        version: brokerDraft.version,
        ...details(),
      })
    ).status,
    200,
  );

  // The same account also becomes a truck owner; it still cannot quote on its own shipment,
  // while another truck owner can.
  await granted(coordinator, ownerBody());
  const own = await quote(coordinator.person, coordinator.org, shipment, quoteBody());
  assert.notEqual(own.status, 201, own.text);
  const rival = await truckOwner();
  assert.equal((await quote(rival.person, rival.org, shipment, quoteBody())).status, 201);

  // Isolation: the rival reads nothing of the coordinator's account.
  await eligibleVehicle(coordinator, { equipmentType: 'curtain_side' });
  for (const path of [
    `/organisations/${coordinator.org}`,
    fleet(coordinator.org),
    `/organisations/${coordinator.org}/shipments`,
    route(coordinator.org),
  ])
    assert.equal((await call('GET', path, { token: rival.person.token })).status, 404, path);
  const seen = await asParty(rival, (client) =>
    client.query('SELECT 1 FROM trucker.organisation WHERE id = $1', [coordinator.org]),
  );
  assert.equal(seen.rowCount, 0);
  await refused(
    () => asParty(rival, (client) => client.query('SELECT 1 FROM trucker.vehicle')),
    /permission denied/,
  );
});
