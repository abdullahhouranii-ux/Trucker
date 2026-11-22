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
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import { TripWatchJob } from './trip-watch.job.js';

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
const consistency = async (): Promise<{ code: string; booking: string; record: string }[]> =>
  (
    await owner.query<{ c: { code: string; booking: string; record: string }[] }>(
      'SELECT trucker.booking_consistency() AS c',
    )
  ).rows[0]!.c;
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
interface TripCase {
  id: string;
  kind: string;
  type: string | null;
  state: string;
  reportedAs: string;
  reportedAt: string;
  description: string | null;
  version?: number;
  atRisk?: string[];
  events?: { action: string; note: string | null; by: string }[];
}
interface OperationsTrip extends Trip {
  withdrawn: { milestone: string; withdrawnAt: string; note: string | null }[];
  hold: { reason: string; heldAt: string; note?: string } | null;
  cases: TripCase[];
}
interface OperationsBooking {
  id: string;
  blockers: { code: string; reason?: string }[];
  blocks: { reason: string; note: string; liftedAt: string | null }[];
  trip: OperationsTrip | null;
  cases: TripCase[];
  atRiskFrom: string[];
}
const operator = async (): Promise<Staff> => newStaff(['operations']);
const ops = (staff: Staff, route: string, body?: unknown): Promise<Reply> =>
  call(body === undefined ? 'GET' : 'POST', `/staff/operations${route}`, {
    token: staff.token,
    ...(body === undefined ? {} : { body }),
  });
const opsBooking = async (staff: Staff, id: string): Promise<OperationsBooking> => {
  const reply = await ops(await fresh(staff), `/bookings/${id}`);
  assert.equal(reply.status, 200, reply.text);
  return reply.body.booking as OperationsBooking;
};
const tick = (): Promise<number> => nest.get(TripWatchJob).tick();

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
interface Delivery {
  outcome: {
    version: number;
    outcome: string;
    receiverName: string | null;
    remarks: string | null;
    cargoRemains: boolean;
    basis: string;
    enteredAs: string;
    enteredBy: string | null;
    reason: string | null;
    note?: string | null;
  } | null;
  earlier: { version: number; outcome: string }[];
  custody: { open: boolean; handover: { kind: string; receivedBy: string } | null } | null;
  releases: { role: string; basis: string; releasedAs: string }[] | null;
}
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
const deliverAs = (party: Party, id: string, body: Record<string, unknown>) =>
  call('POST', bookingRoute(party.org, id, '/delivery'), { token: party.person.token, body });
const handover = (party: Party, id: string, body: Record<string, unknown>) =>
  call('POST', bookingRoute(party.org, id, '/handover'), { token: party.person.token, body });
const release = (party: Party, id: string, role: string) =>
  call('POST', bookingRoute(party.org, id, `/resources/${role}/release`), {
    token: party.person.token,
  });
const deliveryOf = async (party: Party, id: string): Promise<Delivery> =>
  ((await tripViewOf(await freshParty(party), id)).trip as unknown as { delivery: Delivery })
    .delivery;
const openEpisodes = (id: string) =>
  count('occupancy_episode', 'booking_id = $1 AND closed_at IS NULL', [id]);
const handoverBody = () => ({
  kind: 'returned_to_shipper',
  handedBy: 'Fictional Driver',
  receivedBy: 'Fictional Warehouse Clerk',
  handedAt: iso(new Date(clock().getTime() - 60_000)),
  place: 'Origin warehouse, gate 2 (fictional)',
});

test('DLV-1, E-3: the driver records one outcome after arriving at delivery; not before, not on hold, not by anyone else; recording it releases nothing', async () => {
  const operations = await operator();
  const trip = await onTrip();
  const id = trip.booking.id;
  const full = { version: 0, outcome: 'delivered_in_full', receiverName: 'Fictional Receiver' };
  const early = await deliverAsDriver(trip.driver, id, full);
  assert.deepEqual([early.status, early.body.code], [409, 'not_arrived_at_delivery']);
  await arrive(trip.driver, id);
  // On hold: refused.
  assert.equal(
    (
      await ops(await fresh(operations), `/bookings/${id}/hold`, {
        hold: true,
        reason: 'other',
        note: 'Wait',
      })
    ).status,
    200,
  );
  const held = await deliverAsDriver(trip.driver, id, full);
  assert.deepEqual([held.status, held.body.code], [409, 'trip_on_hold']);
  assert.equal(
    (await ops(operations, `/bookings/${id}/hold`, { hold: false, note: 'Go' })).status,
    200,
  );
  // Others: as missing.
  const shipper = await freshParty(trip.shipper);
  const stranger = await newPerson();
  for (const reply of [
    await deliverAs(shipper, id, full),
    await deliverAsDriver(stranger, id, full),
    await deliverAsDriver(trip.carrier.person, id, full),
  ])
    assert.deepEqual([reply.status, reply.body.code], [404, 'not_found']);
  // Not valid: no receiver for a delivery; no remarks where they are needed.
  for (const body of [
    { version: 0, outcome: 'delivered_in_full' },
    { version: 0, outcome: 'delivered_with_remarks', receiverName: 'R' },
  ]) {
    const reply = await deliverAsDriver(trip.driver, id, body);
    assert.equal(reply.status, 422, reply.text);
  }
  const recorded = await deliverAsDriver(trip.driver, id, {
    ...full,
    // A driver's own report carries no reason or stated time: they are ignored.
    statedAt: iso(new Date(clock().getTime() - 3_600_000)),
  });
  assert.equal(recorded.status, 200, recorded.text);
  const again2 = await deliverAsDriver(trip.driver, id, { ...full, version: 1 });
  assert.deepEqual([again2.status, again2.body.code], [409, 'delivery_recorded']);
  const seen = await deliveryOf(trip.shipper, id);
  assert.deepEqual(
    [
      seen.outcome?.outcome,
      seen.outcome?.basis,
      seen.outcome?.enteredAs,
      seen.custody,
      seen.releases,
    ],
    ['delivered_in_full', 'observed', 'driver', null, null],
  );
  // E-3: an outcome, and time passing, release nothing.
  await advance(3 * 24 * 3600);
  await tick();
  assert.equal(await openEpisodes(id), 2);
  assert.equal(await count('trip_case', "booking_id = $1 AND kind = 'delivery_outcome'", [id]), 0);
});

test("DLV-1, DLV-3, DLV-4: the carrier records a partial delivery on the driver's behalf; it opens one case and custody; the shipper sees it, not the carrier's note", async () => {
  const trip = await onTrip();
  const id = trip.booking.id;
  await arrive(trip.driver, id);
  const carrier = await freshParty(trip.carrier);
  const base = {
    version: 0,
    outcome: 'partly_delivered',
    receiverName: 'Fictional Receiver',
    remarks: 'Two pallets refused (fictional)',
    statedAt: iso(new Date(clock().getTime() - 10 * 60_000)),
  };
  const noReason = await deliverAs(carrier, id, base);
  assert.equal(noReason.status, 422, noReason.text);
  const future = await deliverAs(carrier, id, {
    ...base,
    reason: 'no_signal',
    statedAt: iso(new Date(clock().getTime() + 60_000)),
  });
  assert.equal(future.status, 422, future.text);
  const recorded = await deliverAs(carrier, id, {
    ...base,
    reason: 'no_signal',
    note: 'Carrier note 2231',
  });
  assert.equal(recorded.status, 200, recorded.text);
  const shipperView = await deliveryOf(trip.shipper, id);
  assert.deepEqual(
    [
      shipperView.outcome?.basis,
      shipperView.outcome?.enteredAs,
      shipperView.outcome?.cargoRemains,
      shipperView.custody,
      shipperView.outcome?.note ?? null,
    ],
    ['reported', 'carrier', true, { open: true, handover: null }, null],
  );
  assert.equal((await deliveryOf(carrier, id)).outcome?.note, 'Carrier note 2231');
  assert.equal(await count('trip_case', "booking_id = $1 AND kind = 'delivery_outcome'", [id]), 1);
  const history = await owner.query(
    "SELECT organisation_id FROM trucker.audit_entry WHERE record_id = $1 AND action = 'trip.delivery_recorded'",
    [id],
  );
  assert.equal(history.rowCount, 2);
  assert.deepEqual(await consistency(), []);
});

test('REL-1, REL-3, DLV-5: a resource is released only after an outcome and only when no cargo is in custody; the handover closes custody; a release frees the resource for its next booking', async () => {
  let carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const first = await readyDriver(carrier);
  const second = await readyDriver(carrier);
  const confirm = async (shift: number, aff: string, person: Person) => {
    const made = await booked(carrier, shift);
    const view = await assigned(
      carrier,
      made.booking.id,
      { truckId: truck.id, driverId: aff },
      'confirmed',
    );
    assert.equal((await acknowledge(person, made.booking.id, view.assignmentVersion)).status, 200);
    return made;
  };
  const earlier = await confirm(0, first.affiliation, first.driver);
  const later = await confirm(30, second.affiliation, second.driver);
  await untilDispatchable(carrier, earlier.booking.id);
  carrier = await freshParty(carrier);
  assert.equal((await dispatch(carrier, earlier.booking.id)).status, 200);
  const id = earlier.booking.id;
  const noOutcome = await release(carrier, id, 'truck');
  assert.deepEqual([noOutcome.status, noOutcome.body.code], [409, 'no_delivery_outcome']);
  const driver = await again(first.driver);
  await arrive(driver, id);
  const refusedLoad = await deliverAsDriver(await again(driver), id, {
    version: 0,
    outcome: 'refused',
    remarks: 'Receiver refused the load (fictional)',
  });
  assert.equal(refusedLoad.status, 200, refusedLoad.text);
  carrier = await freshParty(carrier);
  const blocked = await release(carrier, id, 'truck');
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'custody_open']);
  // The shipper releases nothing; an unknown role is not found.
  const shipperTry = await release(await freshParty(earlier.shipper), id, 'truck');
  assert.deepEqual([shipperTry.status, shipperTry.body.code], [404, 'not_found']);
  assert.equal((await release(carrier, id, 'trailer')).status, 404);
  // The handover: checked, then recorded once.
  for (const body of [
    { ...handoverBody(), kind: 'burned' },
    { ...handoverBody(), handedAt: iso(new Date(clock().getTime() + 60_000)) },
    { ...handoverBody(), receivedBy: ' ' },
  ]) {
    const reply = await handover(carrier, id, body);
    assert.equal(reply.status, 422, reply.text);
  }
  const handed = await handover(carrier, id, handoverBody());
  assert.equal(handed.status, 200, handed.text);
  const twice = await handover(carrier, id, handoverBody());
  assert.deepEqual([twice.status, twice.body.code], [409, 'no_custody']);
  const shipperSees = await deliveryOf(earlier.shipper, id);
  assert.deepEqual(
    [shipperSees.custody?.open, shipperSees.custody?.handover?.kind],
    [false, 'returned_to_shipper'],
  );
  // The later booking cannot be dispatched while the truck is on this trip.
  await untilDispatchable(carrier, later.booking.id);
  carrier = await freshParty(carrier);
  const notYet = await dispatch(carrier, later.booking.id);
  assert.equal(notYet.body.code, 'dispatch_refused');
  // Released, resource by resource.
  const released = await release(carrier, id, 'truck');
  assert.equal(released.status, 200, released.text);
  const repeat = await release(carrier, id, 'truck');
  assert.deepEqual([repeat.status, repeat.body.code], [409, 'already_released']);
  assert.equal((await release(carrier, id, 'driver')).status, 200);
  assert.equal(await openEpisodes(id), 0);
  assert.equal(
    await count(
      'resource_reservation',
      "booking_id = $1 AND status = 'released' AND release_reason = 'trip_released'",
      [id],
    ),
    2,
  );
  const carrierSees = await deliveryOf(carrier, id);
  assert.deepEqual(
    carrierSees.releases?.map((item) => [item.role, item.basis, item.releasedAs]),
    [
      ['driver', 'condition', 'carrier'],
      ['truck', 'condition', 'carrier'],
    ].sort(),
  );
  assert.equal((await deliveryOf(earlier.shipper, id)).releases, null);
  // The truck is free: the later booking is dispatched.
  carrier = await freshParty(carrier);
  const next = await dispatch(carrier, later.booking.id);
  assert.equal(next.status, 200, next.text);
  assert.deepEqual(await consistency(), []);
  // REL-4: nothing else closes or removes an episode, or reopens one.
  await refused(
    () =>
      owner.query(
        'UPDATE trucker.occupancy_episode SET closed_at = now(), release_reason = $2 WHERE booking_id = $1 AND closed_at IS NULL',
        [later.booking.id, 'released'],
      ),
    /only by its recorded release/,
  );
  await refused(
    () =>
      owner.query(
        'UPDATE trucker.occupancy_episode SET closed_at = NULL, release_reason = NULL WHERE booking_id = $1',
        [id],
      ),
    /only by its recorded release/,
  );
  await refused(
    () => owner.query('DELETE FROM trucker.occupancy_episode WHERE booking_id = $1', [id]),
    /only by its recorded release/,
  );
  await refused(() => owner.query('DELETE FROM trucker.resource_release'), /never changed/);
  await refused(
    () => owner.query('UPDATE trucker.cargo_handover SET place = $1', ['x']),
    /never changed/,
  );
});

test('REL-2, DL-6: operations releases with custody open only with a note, recorded as an operations release; operations corrects an outcome until a handover or a release', async () => {
  const operations = await operator();
  const trip = await onTrip();
  const id = trip.booking.id;
  await arrive(trip.driver, id);
  const recorded = await deliverAsDriver(await again(trip.driver), id, {
    version: 0,
    outcome: 'delivered_with_remarks',
    receiverName: 'Fictional Receiver',
    remarks: 'Carton crushed (fictional)',
    cargoRemains: false,
  });
  assert.equal(recorded.status, 200, recorded.text);
  // A correction: by operations, with a note, as the next version.
  const correction = {
    version: 1,
    outcome: 'partly_delivered',
    receiverName: 'Fictional Receiver',
    remarks: 'One pallet left on the truck (fictional)',
    statedAt: iso(new Date(clock().getTime() - 60_000)),
    reason: 'correction',
  };
  const noNote = await ops(await fresh(operations), `/bookings/${id}/delivery`, correction);
  assert.equal(noNote.status, 422, noNote.text);
  const stale = await ops(operations, `/bookings/${id}/delivery`, {
    ...correction,
    version: 0,
    note: 'x',
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'record_changed']);
  const corrected = await ops(operations, `/bookings/${id}/delivery`, {
    ...correction,
    note: 'The driver called: one pallet remains',
  });
  assert.equal(corrected.status, 200, corrected.text);
  const shipperSees = await deliveryOf(trip.shipper, id);
  assert.deepEqual(
    [
      shipperSees.outcome?.version,
      shipperSees.outcome?.enteredAs,
      shipperSees.outcome?.enteredBy,
      shipperSees.earlier.map((item) => [item.version, item.outcome]),
      shipperSees.custody?.open,
    ],
    [2, 'operations', null, [[1, 'delivered_with_remarks']], true],
  );
  // The carrier cannot release; operations can, with a note, as an operations release.
  const carrier = await freshParty(trip.carrier);
  assert.equal((await release(carrier, id, 'truck')).body.code, 'custody_open');
  const withoutNote = await ops(operations, `/bookings/${id}/resources/truck/release`, {
    override: true,
  });
  assert.equal(withoutNote.status, 422, withoutNote.text);
  const noOverride = await ops(operations, `/bookings/${id}/resources/truck/release`, {
    note: 'x',
  });
  assert.deepEqual([noOverride.status, noOverride.body.code], [409, 'custody_open']);
  const forced = await ops(operations, `/bookings/${id}/resources/truck/release`, {
    override: true,
    note: 'Truck swapped at the depot; pallet moved to storage',
  });
  assert.equal(forced.status, 200, forced.text);
  // Once released, the outcome is no longer corrected.
  const late = await ops(operations, `/bookings/${id}/delivery`, {
    ...correction,
    version: 2,
    note: 'again',
  });
  assert.deepEqual([late.status, late.body.code], [409, 'delivery_settled']);
  const opsView = (await opsBooking(operations, id)).trip as unknown as { delivery: Delivery };
  assert.deepEqual(
    opsView.delivery.releases?.map((item) => [item.role, item.basis, item.releasedAs]),
    [['truck', 'operations', 'operations']],
  );
  // Custody still open: operations records the handover, then the driver is released normally.
  const handed = await ops(operations, `/bookings/${id}/handover`, handoverBody());
  assert.equal(handed.status, 200, handed.text);
  assert.equal((await release(await freshParty(trip.carrier), id, 'driver')).status, 200);
  assert.deepEqual(await consistency(), []);
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.trip_delivery_outcome (trip_id, version, outcome, cargo_remains, stated_at, recorded_at,
           basis, driver_id, recorded_by_staff, reason, note, receiver_name, remarks)
         SELECT trip_id, 3, outcome, cargo_remains, stated_at, recorded_at, basis, driver_id, $2, 'correction', 'x',
                receiver_name, remarks
         FROM trucker.trip_delivery_outcome WHERE trip_id = (SELECT id FROM trucker.trip WHERE booking_id = $1) AND version = 2`,
        [id, operations.id],
      ),
    /no longer corrected|not corrected/,
  );
});

test('REL-5: two releases of one resource at the same moment record one', async () => {
  const trip = await onTrip();
  const id = trip.booking.id;
  await arrive(trip.driver, id);
  assert.equal(
    (
      await deliverAsDriver(await again(trip.driver), id, {
        version: 0,
        outcome: 'delivered_in_full',
        receiverName: 'Fictional Receiver',
      })
    ).status,
    200,
  );
  const carrier = await freshParty(trip.carrier);
  const replies = await Promise.all([release(carrier, id, 'truck'), release(carrier, id, 'truck')]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  assert.equal(await count('resource_release', 'booking_id = $1', [id]), 1);
  assert.deepEqual(await consistency(), []);
});

/** Runs work while another connection holds a lock; meanwhile runs once work is waiting. */
async function whileHeld<T>(
  sql: string,
  values: unknown[],
  work: () => Promise<T>,
  meanwhile: () => Promise<unknown>,
): Promise<T> {
  const holder = await owner.connect();
  await holder.query('BEGIN');
  await holder.query(sql, values);
  const result = work();
  try {
    for (let attempt = 0; ; attempt += 1) {
      const n = (
        await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity x ON x.pid = l.pid
           WHERE NOT l.granted AND x.datname = current_database()`,
        )
      ).rows[0]!.n;
      if (n >= 1) break;
      if (attempt > 400) throw new Error('the request did not wait');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await meanwhile();
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
  return result;
}

test('REL-1, DLV-1: a release waits for the dispatch locks; an outcome that waited while the driver left records nothing; a handover is written only for cargo in custody', async () => {
  // A release takes the same locks as a dispatch: it waits while the shipment is locked.
  const one = await onTrip();
  await arrive(one.driver, one.booking.id);
  assert.equal(
    (
      await deliverAsDriver(one.driver, one.booking.id, {
        version: 0,
        outcome: 'delivered_in_full',
        receiverName: 'Fictional Receiver',
      })
    ).status,
    200,
  );
  const carrier = await freshParty(one.carrier);
  const waited = await whileHeld(
    'SELECT 1 FROM trucker.shipment_draft WHERE id = (SELECT shipment_id FROM trucker.booking WHERE id = $1) FOR UPDATE',
    [one.booking.id],
    () => release(carrier, one.booking.id, 'truck'),
    async () => undefined,
  );
  assert.equal(waited.status, 200, waited.text);
  // A handover written directly for an outcome that left nothing on the vehicle: refused.
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.cargo_handover (trip_id, outcome_id, kind, handed_by, received_by, handed_at, place,
           recorded_by, recorded_at)
         SELECT o.trip_id, o.id, 'returned_to_shipper', 'A', 'B', now(), 'C', o.driver_id, now()
         FROM trucker.trip_delivery_outcome o JOIN trucker.trip t ON t.id = o.trip_id WHERE t.booking_id = $1`,
        [one.booking.id],
      ),
    /custody of the outcome in force/,
  );
  // The driver leaves the carrier while their outcome waits for the trip: nothing is recorded.
  const two = await onTrip();
  await arrive(two.driver, two.booking.id);
  const seen = (await fleetOf(two.carrier.person, two.carrier.org)).drivers.find(
    (item) => item.id === two.affiliation,
  )!;
  const reply = await whileHeld(
    'SELECT 1 FROM trucker.trip WHERE booking_id = $1 FOR UPDATE',
    [two.booking.id],
    () =>
      deliverAsDriver(two.driver, two.booking.id, {
        version: 0,
        outcome: 'delivered_in_full',
        receiverName: 'Fictional Receiver',
      }),
    async () => {
      const ended = await call('POST', fleet(two.carrier.org, `/drivers/${two.affiliation}/end`), {
        token: two.carrier.person.token,
        key: key(),
        body: { version: seen.version },
      });
      assert.equal(ended.status, 200, ended.text);
    },
  );
  assert.deepEqual([reply.status, reply.body.code], [404, 'not_found']);
  assert.equal(
    await count(
      'trip_delivery_outcome',
      'trip_id IN (SELECT id FROM trucker.trip WHERE booking_id = $1)',
      [two.booking.id],
    ),
    0,
  );
});
