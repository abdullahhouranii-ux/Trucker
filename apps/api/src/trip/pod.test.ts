import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

const storageDir = mkdtempSync(path.join(tmpdir(), 'trucker-pod-'));
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
    FILE_STORAGE: 'local',
    FILE_STORAGE_DIR: storageDir,
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
// The shipments of these tests ask for a curtain-side body.
const rigid = (carrier: Party) => eligibleVehicle(carrier, { equipmentType: 'curtain_side' });
/** A driver with accepted documents who may drive every vehicle of the carrier. */
async function readyDriver(carrier: Party, classes = ['fictional_class_2']) {
  const made = await affiliated(carrier.person, carrier.org);
  await driverDocuments(made.driver, classes);
  assert.equal((await authorise(carrier.person, carrier.org, made.affiliation, null)).status, 200);
  return made;
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
const acknowledge = (driver: Person, id: string, version: number): Promise<Reply> =>
  call('POST', `/me/driver/assignments/${id}/acknowledge`, {
    token: driver.token,
    body: { version },
  });
const freshParty = async (party: Party): Promise<Party> => ({
  person: await again(party.person),
  org: party.org,
});
// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// Dispatch and the trip (slice 17a)
// ---------------------------------------------------------------------------------------------
interface Milestone {
  milestone: string;
  statedAt: string;
  recordedAt: string;
  basis: 'observed' | 'reported';
  about: string;
  enteredBy: string | null;
  reason: string | null;
  note?: string | null;
  needsReview: boolean;
}
interface Trip {
  id: string;
  version: number;
  dispatchedAt: string;
  late: boolean;
  next: string | null;
  milestones: Milestone[];
  estimate: { arrivalAt: string; statedAt: string; statedAs: string; statedBy: string } | null;
}
interface TripView extends View {
  dispatchFrom: string;
  trip: Trip | null;
}
const tripViewOf = async (party: Party, id: string): Promise<TripView> =>
  (await viewOf(party, id)) as unknown as TripView;
const dispatch = (party: Party, id: string, retry = key()): Promise<Reply> =>
  call('POST', bookingRoute(party.org, id, '/dispatch'), { token: party.person.token, key: retry });
const byDriver = (driver: Person, id: string, version: number, milestone: string): Promise<Reply> =>
  call('POST', `/me/driver/assignments/${id}/milestones`, {
    token: driver.token,
    body: { version, milestone },
  });
const iso = (date: Date): string => date.toISOString();

/** A booking of this carrier confirmed with a truck and a driver who has acknowledged it. */
async function ready(carrier: Party, shift = 0) {
  const truck = await rigid(carrier);
  const { driver, affiliation } = await readyDriver(carrier);
  const made = await booked(carrier, shift);
  const view = await assigned(
    carrier,
    made.booking.id,
    { truckId: truck.id, driverId: affiliation },
    'confirmed',
  );
  const acknowledged = await acknowledge(driver, made.booking.id, view.assignmentVersion);
  assert.equal(acknowledged.status, 200, acknowledged.text);
  return { ...made, truck, driver, affiliation };
}
/** Moves the clock to the earliest dispatch time of the booking, plus some seconds. */
async function untilDispatchable(party: Party, id: string, extra = 60): Promise<void> {
  const earliest = new Date((await tripViewOf(party, id)).dispatchFrom);
  await advance(Math.ceil((earliest.getTime() - clock().getTime()) / 1000) + extra);
}

// ---------------------------------------------------------------------------------------------
// Exceptions and operations (slice 17b)
// ---------------------------------------------------------------------------------------------
const operator = async (): Promise<Staff> => newStaff(['operations']);
/** A confirmed, acknowledged booking at its dispatch time, dispatched unless asked not to. */
async function onTrip(dispatchIt = true) {
  let carrier = await verifiedCarrier();
  const made = await ready(carrier);
  await untilDispatchable(carrier, made.booking.id);
  carrier = await freshParty(carrier);
  if (dispatchIt) assert.equal((await dispatch(carrier, made.booking.id)).status, 200);
  return {
    ...made,
    carrier,
    driver: await again(made.driver),
    shipper: await freshParty(made.shipper),
  };
}

// ---------------------------------------------------------------------------------------------
// Delivery outcome, custody and release (slice 18a)
// ---------------------------------------------------------------------------------------------
const STEPS = [
  'departed_for_pickup',
  'arrived_at_pickup',
  'loading_started',
  'loaded_departed',
  'arrived_at_delivery',
];
/** The driver records every milestone up to arrival at delivery. */
async function arrive(driver: Person, id: string, steps = STEPS): Promise<void> {
  for (const [index, milestone] of steps.entries()) {
    await advance(60);
    const reply = await byDriver(driver, id, index + 1, milestone);
    assert.equal(reply.status, 200, reply.text);
  }
}
const deliverAsDriver = (driver: Person, id: string, body: Record<string, unknown>) =>
  call('POST', `/me/driver/assignments/${id}/delivery`, { token: driver.token, body });
// ---------------------------------------------------------------------------------------------
// Proof of delivery (slice 18b)
// ---------------------------------------------------------------------------------------------
interface PodItem {
  id: string;
  kind: string;
  required: boolean;
  received: boolean;
  fingerprint: string;
}
interface PodVersion {
  id: string;
  version: number;
  state: string;
  basis: string;
  enteredAs: string;
  items: PodItem[];
  review: { decision: string } | null;
}
interface Pod {
  state: string;
  versions: PodVersion[];
}
/** A fictional file: random bytes with the header of its type, and its declaration. */
function fictionalFile(kind: string, mediaType = 'image/jpeg', size = 2048) {
  const bytes = randomBytes(size);
  if (mediaType === 'image/jpeg') bytes.set([0xff, 0xd8, 0xff], 0);
  if (mediaType === 'application/pdf') bytes.set(Buffer.from('%PDF-'), 0);
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  return { bytes, declared: { kind, mediaType, sizeBytes: bytes.length, fingerprint } };
}
type FictionalFile = ReturnType<typeof fictionalFile>;
const podRoute = (org: string, id: string, rest = '') => bookingRoute(org, id, `/pod${rest}`);
const driverPodRoute = (id: string, rest = '') => `/me/driver/assignments/${id}/pod${rest}`;
async function putFile(route: string, token: string | undefined, bytes: Buffer, mediaType: string) {
  const response = await fetch(base + route, {
    method: 'PUT',
    headers: {
      'content-type': mediaType,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: bytes,
  });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  return { status: response.status, body, text };
}
async function getFile(route: string, token: string | undefined) {
  const response = await fetch(base + route, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    cache: response.headers.get('cache-control'),
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}
const podOf = async (party: Party, id: string): Promise<Pod> =>
  ((await tripViewOf(party, id)).trip as unknown as { pod: Pod }).pod;
const storedFiles = (): number => readdirSync(storageDir).length;

/** A trip delivered in full by the driver: the POD is next. */
async function delivered(outcome = 'delivered_in_full', extra: Record<string, unknown> = {}) {
  const trip = await onTrip();
  const id = trip.booking.id;
  await arrive(trip.driver, id);
  const reply = await deliverAsDriver(trip.driver, id, {
    version: 0,
    outcome,
    receiverName: outcome === 'refused' ? null : 'Fictional Receiver',
    remarks: outcome === 'delivered_in_full' ? null : 'Fictional remarks',
    ...extra,
  });
  assert.equal(reply.status, 200, reply.text);
  return {
    ...trip,
    id,
    carrier: await freshParty(trip.carrier),
    shipper: await freshParty(trip.shipper),
  };
}
/** The driver declares a version and sends every file; returns the items as declared. */
async function capture(
  driver: Person,
  id: string,
  files: FictionalFile[],
  version = 1,
  extra: Record<string, unknown> = {},
) {
  const declared = await call('POST', driverPodRoute(id), {
    token: driver.token,
    body: { version, items: files.map((file) => file.declared), ...extra },
  });
  assert.equal(declared.status, 200, declared.text);
  const pod = declared.body.pod as Pod;
  const items = pod.versions.at(-1)!.items;
  for (const [index, item] of items.entries()) {
    const sent = await putFile(
      driverPodRoute(id, `/items/${item.id}`),
      driver.token,
      files[index]!.bytes,
      files[index]!.declared.mediaType,
    );
    assert.equal(sent.status, 200, sent.text);
  }
  return items;
}

test('POD-1: only the assigned driver or the carrier captures; the manifest must hold what the outcome needs; a file whose fingerprint or type differs is refused and nothing is kept; the POD is reviewable only once every required item has arrived', async () => {
  const trip = await delivered();
  const { id, shipper, carrier } = trip;
  const signature = fictionalFile('signature', 'image/png');
  const photo = {
    ...fictionalFile('cargo_photo'),
    declared: { ...fictionalFile('cargo_photo').declared },
  };
  const optionalPhoto = fictionalFile('cargo_photo');
  // The shipper, another carrier and a driver without the assignment cannot capture (AT-404).
  const outsider = await verifiedCarrier();
  for (const [route, token] of [
    [podRoute(shipper.org, id), shipper.person.token],
    [podRoute(outsider.org, id), outsider.person.token],
  ] as const) {
    const reply = await call('POST', route, {
      token,
      body: { version: 1, items: [signature.declared] },
    });
    assert.deepEqual([reply.status, reply.body.code], [404, 'not_found']);
  }
  const stranger = await newPerson();
  const notAssigned = await call('POST', driverPodRoute(id), {
    token: stranger.token,
    body: { version: 1, items: [signature.declared] },
  });
  assert.equal(notAssigned.status, 404);
  // A delivery needs the receiver's signature or a signed document (PD-1).
  const missing = await call('POST', driverPodRoute(id), {
    token: trip.driver.token,
    body: { version: 1, items: [photo.declared] },
  });
  assert.deepEqual([missing.status, missing.body.code], [422, 'evidence_missing']);
  // Before anything is declared, the POD is not received (not "missing").
  assert.equal((await podOf(shipper, id)).state, 'not_received');
  const declared = await call('POST', driverPodRoute(id), {
    token: trip.driver.token,
    body: {
      version: 1,
      items: [signature.declared, { ...optionalPhoto.declared, optional: true }],
    },
  });
  assert.equal(declared.status, 200, declared.text);
  const [signatureItem, optionalItem] = (declared.body.pod as Pod).versions[0]!.items;
  assert.equal((await podOf(shipper, id)).state, 'upload_incomplete');
  // Not reviewable yet (DI-402).
  const early = await call('POST', podRoute(shipper.org, id, '/review'), {
    token: shipper.person.token,
    body: { podId: (declared.body.pod as Pod).versions[0]!.id, version: 1, decision: 'accepted' },
  });
  assert.deepEqual([early.status, early.body.code], [409, 'pod_not_ready']);
  // Other bytes: refused, recorded, and not kept (AT-402).
  const before = storedFiles();
  const other = fictionalFile('signature', 'image/png');
  const wrong = await putFile(
    driverPodRoute(id, `/items/${signatureItem!.id}`),
    trip.driver.token,
    other.bytes,
    'image/png',
  );
  assert.deepEqual([wrong.status, wrong.body.code], [422, 'fingerprint_mismatch']);
  assert.equal(storedFiles(), before);
  assert.equal(
    await count('audit_entry', "record_id = $1 AND action = 'trip.pod_integrity_failed'", [id]),
    2,
  );
  // The declared type only; and only JPEG, PNG or PDF.
  const wrongType = await putFile(
    driverPodRoute(id, `/items/${signatureItem!.id}`),
    trip.driver.token,
    signature.bytes,
    'image/jpeg',
  );
  assert.deepEqual([wrongType.status, wrongType.body.code], [422, 'media_type_mismatch']);
  const unsupported = await putFile(
    driverPodRoute(id, `/items/${signatureItem!.id}`),
    trip.driver.token,
    signature.bytes,
    'text/html',
  );
  assert.equal(unsupported.status, 415);
  // Larger than allowed: refused before it is all read.
  const huge = await putFile(
    driverPodRoute(id, `/items/${signatureItem!.id}`),
    trip.driver.token,
    Buffer.alloc(10 * 1024 * 1024 + 1),
    'image/png',
  ).catch(() => ({ status: 413, body: {}, text: '' }));
  assert.equal(huge.status, 413);
  assert.equal(storedFiles(), before);
  // The right file: received; sent again, nothing changes.
  const right = await putFile(
    driverPodRoute(id, `/items/${signatureItem!.id}`),
    trip.driver.token,
    signature.bytes,
    'image/png',
  );
  assert.equal(right.status, 200, right.text);
  const twice = await putFile(
    driverPodRoute(id, `/items/${signatureItem!.id}`),
    trip.driver.token,
    signature.bytes,
    'image/png',
  );
  assert.deepEqual([twice.status, twice.body.outcome], [200, 'already_received']);
  assert.equal(storedFiles(), before + 1);
  // The optional photo has not arrived; the POD is ready all the same.
  const pod = await podOf(shipper, id);
  assert.deepEqual(
    [pod.state, pod.versions[0]!.items.map((item) => [item.required, item.received])],
    [
      'ready_for_review',
      [
        [true, true],
        [false, false],
      ],
    ],
  );
  void optionalItem;
  void carrier;
});

test('POD-2: only the shipper decides, once, never by silence; accepting moves no money, holds or resources', async () => {
  const trip = await delivered();
  const { id, shipper, carrier } = trip;
  await capture(trip.driver, id, [fictionalFile('signature')]);
  const version = (await podOf(shipper, id)).versions[0]!;
  const decide = (party: Party, decision = 'accepted', note: string | null = null) =>
    call('POST', podRoute(party.org, id, '/review'), {
      token: party.person.token,
      body: { podId: version.id, version: 1, decision, note },
    });
  // The carrier and the driver cannot decide (AT-411, E-1).
  assert.equal((await decide(carrier)).status, 404);
  const driverTry = await call('POST', `/me/driver/assignments/${id}/pod/review`, {
    token: trip.driver.token,
    body: { podId: version.id, version: 1, decision: 'accepted' },
  });
  assert.equal(driverTry.status, 404);
  // A month passes: nothing is accepted by silence (AT-413, R-402).
  await advance(30 * 24 * 3600);
  const shipperNow = await freshParty(shipper);
  assert.equal((await podOf(shipperNow, id)).state, 'ready_for_review');
  // Asking for more evidence needs a note.
  assert.equal((await decide(shipperNow, 'more_evidence_requested')).status, 422);
  // What money, holds and resources look like before.
  const snapshot = async () =>
    (
      await owner.query(
        `SELECT to_jsonb(b) AS booking,
                (SELECT count(*) FROM trucker.fee_payment f WHERE f.booking_id = b.id)::int AS payments,
                (SELECT count(*) FROM trucker.settlement_hold h WHERE h.booking_id = b.id)::int AS holds,
                (SELECT count(*) FROM trucker.resource_release r WHERE r.booking_id = b.id)::int AS releases,
                (SELECT count(*) FROM trucker.occupancy_episode e WHERE e.booking_id = b.id AND e.closed_at IS NULL)::int AS open
         FROM trucker.booking b WHERE b.id = $1`,
        [id],
      )
    ).rows[0];
  const before = await snapshot();
  // Two decisions at once: one stands (AT-412).
  // Two decisions at once, both waiting on the trip while it is held: one stands (AT-412).
  const holder = await owner.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM trucker.trip WHERE booking_id = $1 FOR UPDATE', [id]);
  const both = Promise.all([decide(shipperNow), decide(shipperNow)]);
  try {
    for (let attempt = 0; ; attempt += 1) {
      const waiting = (
        await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity x ON x.pid = l.pid
           WHERE NOT l.granted AND x.datname = current_database()`,
        )
      ).rows[0]!.n;
      if (waiting >= 2) break;
      if (attempt > 400) throw new Error('the decisions did not wait for the trip');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
  const [one, two] = await both;
  assert.deepEqual([one.status, two.status].sort(), [200, 409]);
  assert.equal(await count('pod_review', 'pod_id = $1', [version.id]), 1);
  assert.equal((await podOf(shipperNow, id)).state, 'accepted');
  // Nothing about money, holds or resources changed (AT-414, E-3).
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.open, 2);
  // An accepted POD is not replaced.
  const after = await call('POST', driverPodRoute(id), {
    token: (await again(trip.driver)).token,
    body: { version: 2, replacesReason: 'x', items: [fictionalFile('signature').declared] },
  });
  assert.deepEqual([after.status, after.body.code], [409, 'pod_accepted']);
});

test('POD-3: more evidence is a new version; earlier versions stay readable; a decision names its version and a replaced one cannot be decided', async () => {
  const trip = await delivered('partly_delivered', {
    shortfall: {
      reason: 'receiver_refused',
      location: 'Gate (fictional)',
      cargoCondition: 'Sealed',
      quantityUnit: 'crates',
      quantityDelivered: 10,
      quantityRemaining: 4,
      contactAttempts: 1,
    },
  });
  const { id, shipper } = trip;
  const signature = fictionalFile('signed_document', 'application/pdf');
  // A partial delivery also needs a photo of the cargo.
  const noPhoto = await call('POST', driverPodRoute(id), {
    token: trip.driver.token,
    body: { version: 1, items: [signature.declared] },
  });
  assert.deepEqual([noPhoto.status, noPhoto.body.code], [422, 'evidence_missing']);
  const photo = fictionalFile('cargo_photo');
  const [firstItem] = await capture(trip.driver, id, [signature, photo]);
  const first = (await podOf(shipper, id)).versions[0]!;
  const asked = await call('POST', podRoute(shipper.org, id, '/review'), {
    token: shipper.person.token,
    body: {
      podId: first.id,
      version: 1,
      decision: 'more_evidence_requested',
      note: 'The stamp is not readable',
    },
  });
  assert.equal(asked.status, 200, asked.text);
  // A second version needs its reason and names the version it follows.
  const driver = await again(trip.driver);
  const better = fictionalFile('signed_document');
  const noReason = await call('POST', driverPodRoute(id), {
    token: driver.token,
    body: { version: 2, items: [better.declared, fictionalFile('cargo_photo').declared] },
  });
  assert.equal(noReason.status, 422);
  const stale = await call('POST', driverPodRoute(id), {
    token: driver.token,
    body: { version: 1, replacesReason: 'Clearer photo', items: [better.declared] },
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'record_changed']);
  const secondPhoto = fictionalFile('cargo_photo');
  await capture(driver, id, [better, secondPhoto], 2, {
    replacesReason: 'A clearer copy of the stamp',
  });
  const pod = await podOf(shipper, id);
  assert.deepEqual(
    pod.versions.map((item) => [item.version, item.state]),
    [
      [1, 'more_evidence_requested'],
      [2, 'ready_for_review'],
    ],
  );
  // The first version cannot be decided again; its decision names the version.
  const shipperNow = await freshParty(shipper);
  const again1 = await call('POST', podRoute(shipperNow.org, id, '/review'), {
    token: shipperNow.person.token,
    body: { podId: first.id, version: 1, decision: 'accepted' },
  });
  assert.deepEqual([again1.status, again1.body.code], [409, 'pod_already_decided']);
  const wrongVersion = await call('POST', podRoute(shipperNow.org, id, '/review'), {
    token: shipperNow.person.token,
    body: { podId: pod.versions[1]!.id, version: 1, decision: 'accepted' },
  });
  assert.deepEqual([wrongVersion.status, wrongVersion.body.code], [409, 'record_changed']);
  // Earlier files stay readable to reviewers, byte for byte (AT-403).
  const read = await getFile(
    podRoute(shipperNow.org, id, `/items/${firstItem!.id}/file`),
    shipperNow.person.token,
  );
  assert.deepEqual(
    [read.status, read.type, read.cache, read.bytes.equals(signature.bytes)],
    [200, 'application/pdf', 'private, no-store', true],
  );
  assert.equal(
    (
      await call('POST', podRoute(shipperNow.org, id, '/review'), {
        token: shipperNow.person.token,
        body: { podId: pod.versions[1]!.id, version: 2, decision: 'accepted' },
      })
    ).status,
    200,
  );
});

test("POD-4: on the driver's behalf it is marked reported with its reason; outsiders read nothing; every staff view of a file is recorded", async () => {
  const trip = await delivered('refused', {
    shortfall: {
      reason: 'receiver_refused',
      location: 'Gate (fictional)',
      cargoCondition: 'Sealed',
      quantityUnit: 'crates',
      quantityDelivered: 0,
      quantityRemaining: 14,
      contactAttempts: 2,
    },
  });
  const { id, shipper, carrier } = trip;
  const photo = fictionalFile('cargo_photo');
  // A refusal needs a photo, no signature; on behalf, a reason and the capture time.
  const noReason = await call('POST', podRoute(carrier.org, id), {
    token: carrier.person.token,
    body: {
      version: 1,
      capturedAt: iso(new Date(clock().getTime() - 60_000)),
      items: [photo.declared],
    },
  });
  assert.deepEqual(
    [noReason.status, (noReason.body.details as { fields: string[] }).fields],
    [422, ['reason']],
  );
  const declared = await call('POST', podRoute(carrier.org, id), {
    token: carrier.person.token,
    body: {
      version: 1,
      reason: 'paper_copy',
      capturedAt: iso(new Date(clock().getTime() - 60_000)),
      items: [photo.declared],
    },
  });
  assert.equal(declared.status, 200, declared.text);
  const version = (declared.body.pod as Pod).versions[0]!;
  assert.deepEqual([version.basis, version.enteredAs], ['reported', 'carrier']);
  const item = version.items[0]!;
  assert.equal(
    (
      await putFile(
        podRoute(carrier.org, id, `/items/${item.id}`),
        carrier.person.token,
        photo.bytes,
        'image/jpeg',
      )
    ).status,
    200,
  );
  // Outsiders: another organisation, no sign-in (AT-405).
  const outsider = await verifiedCarrier();
  assert.equal(
    (await getFile(podRoute(outsider.org, id, `/items/${item.id}/file`), outsider.person.token))
      .status,
    404,
  );
  assert.equal(
    (await getFile(podRoute(shipper.org, id, `/items/${item.id}/file`), undefined)).status,
    401,
  );
  // The driver reads the trip's files.
  assert.equal(
    (await getFile(driverPodRoute(id, `/items/${item.id}/file`), trip.driver.token)).status,
    200,
  );
  // Operations reads it: the view is recorded (AT-415).
  const operations = await operator();
  const viewed = await getFile(
    `/staff/operations/bookings/${id}/pod/items/${item.id}/file`,
    operations.token,
  );
  assert.deepEqual([viewed.status, viewed.bytes.equals(photo.bytes)], [200, true]);
  assert.equal(await count('pod_file_view', 'item_id = $1', [item.id]), 1);
  assert.equal(
    await count(
      'staff_audit_entry',
      "action = 'staff.operations.pod_file' AND actor_staff_id = $1",
      [operations.id],
    ),
    1,
  );
  // Records are never changed or removed.
  await refused(
    () =>
      owner.query('UPDATE trucker.pod_item SET fingerprint = $2 WHERE id = $1', [
        item.id,
        '0'.repeat(64),
      ]),
    /only moves forward/,
  );
  await refused(
    () => owner.query('DELETE FROM trucker.pod_file_view WHERE item_id = $1', [item.id]),
    /only moves forward/,
  );
});

test("POD-5: operations uploads a paper POD on the driver's behalf; with file storage closed, nothing is accepted as stored", async () => {
  const trip = await delivered();
  const { id, shipper } = trip;
  const operations = await operator();
  const paper = fictionalFile('signed_document', 'application/pdf');
  const declared = await call('POST', `/staff/operations/bookings/${id}/pod`, {
    token: operations.token,
    body: {
      version: 1,
      reason: 'device_lost',
      capturedAt: iso(new Date(clock().getTime() - 60_000)),
      items: [paper.declared],
    },
  });
  assert.equal(declared.status, 200, declared.text);
  const item = (declared.body.pod as Pod).versions[0]!.items[0]!;
  const sent = await putFile(
    `/staff/operations/bookings/${id}/pod/items/${item.id}`,
    operations.token,
    paper.bytes,
    'application/pdf',
  );
  assert.equal(sent.status, 200, sent.text);
  const pod = await podOf(shipper, id);
  assert.deepEqual([pod.state, pod.versions[0]!.enteredAs], ['ready_for_review', 'operations']);
  // A newer version declared before any decision replaces it: the replaced one cannot be decided.
  const newer = await call('POST', driverPodRoute(id), {
    token: (await again(trip.driver)).token,
    body: {
      version: 2,
      replacesReason: 'The driver has the original',
      items: [fictionalFile('signature').declared],
    },
  });
  assert.equal(newer.status, 200, newer.text);
  const shipperNow = await freshParty(shipper);
  const replaced = await call('POST', podRoute(shipperNow.org, id, '/review'), {
    token: shipperNow.person.token,
    body: { podId: pod.versions[0]!.id, version: 1, decision: 'accepted' },
  });
  assert.deepEqual([replaced.status, replaced.body.code], [409, 'pod_superseded']);
  assert.deepEqual(
    (await podOf(shipperNow, id)).versions.map((item) => item.state),
    ['superseded', 'upload_incomplete'],
  );
  // Production refuses the development stand-in; local storage needs a folder.
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://a:b@db.example/x',
        APP_DATABASE_URL: 'postgres://c:d@db.example/x',
        IDENTITY_SECRET: 'x'.repeat(40),
        RETRY_KEY_RETENTION_HOURS: '24',
        FILE_STORAGE: 'local',
        FILE_STORAGE_DIR: '/tmp/x',
      }),
    /FILE_STORAGE must not be local in production/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', DATABASE_URL: database.url, FILE_STORAGE: 'local' }),
    /FILE_STORAGE_DIR must be set/,
  );
});
