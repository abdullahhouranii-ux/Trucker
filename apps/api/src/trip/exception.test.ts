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
const refusalOf = (reply: Reply): Record<string, unknown> | undefined =>
  reply.body.details as Record<string, unknown> | undefined;
const tripViewOf = async (party: Party, id: string): Promise<TripView> =>
  (await viewOf(party, id)) as unknown as TripView;
const dispatch = (party: Party, id: string, retry = key()): Promise<Reply> =>
  call('POST', bookingRoute(party.org, id, '/dispatch'), { token: party.person.token, key: retry });
const byDriver = (driver: Person, id: string, version: number, milestone: string): Promise<Reply> =>
  call('POST', `/me/driver/assignments/${id}/milestones`, {
    token: driver.token,
    body: { version, milestone },
  });
const onBehalf = (party: Party, id: string, body: Record<string, unknown>): Promise<Reply> =>
  call('POST', bookingRoute(party.org, id, '/milestones'), { token: party.person.token, body });
const episodesOf = async (booking: string) =>
  (
    await owner.query<{ resource_kind: string; closed_at: Date | null }>(
      'SELECT resource_kind, closed_at FROM trucker.occupancy_episode WHERE booking_id = $1 ORDER BY resource_kind',
      [booking],
    )
  ).rows;
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
const queueOf = async (
  staff: Staff,
): Promise<{ open: TripCase[]; resolved: TripCase[]; blocks: unknown[]; holds: unknown[] }> => {
  const reply = await ops(await fresh(staff), '');
  assert.equal(reply.status, 200, reply.text);
  return reply.body.operations as {
    open: TripCase[];
    resolved: TripCase[];
    blocks: unknown[];
    holds: unknown[];
  };
};
const reportAs = (party: Party, id: string, body: unknown, retry = key()): Promise<Reply> =>
  call('POST', bookingRoute(party.org, id, '/exceptions'), {
    token: party.person.token,
    key: retry,
    body,
  });
const reportByDriver = (driver: Person, id: string, body: unknown, retry = key()): Promise<Reply> =>
  call('POST', `/me/driver/assignments/${id}/exceptions`, {
    token: driver.token,
    key: retry,
    body,
  });
const tripOf = async (party: Party, id: string) =>
  (await tripViewOf(party, id)).trip as unknown as OperationsTrip;
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

test('EXC-1, EXC-5: the driver, the carrier and the shipper report exceptions; each is a case in the operations queue at once; a party sees its type and state, and only the reporting side the description', async () => {
  const before = await onTrip(false);
  const early = await reportAs(before.carrier, before.booking.id, {
    type: 'delay',
    description: 'Not yet dispatched',
  });
  assert.deepEqual([early.status, early.body.code], [409, 'not_dispatched']);
  const carrier = await freshParty(before.carrier);
  assert.equal((await dispatch(carrier, before.booking.id)).status, 200);
  const id = before.booking.id;
  const operations = await operator();
  // Each side, once; the same key again returns the same case.
  const retry = key();
  const byDriverReply = await reportByDriver(
    before.driver,
    id,
    { type: 'breakdown', description: 'Engine warning light near the border' },
    retry,
  );
  assert.equal(byDriverReply.status, 200, byDriverReply.text);
  await advance(1);
  const repeated = await reportByDriver(
    before.driver,
    id,
    { type: 'breakdown', description: 'Engine warning light near the border' },
    retry,
  );
  assert.deepEqual(
    [repeated.body.outcome, (repeated.body.case as TripCase).id],
    ['already_reported', (byDriverReply.body.case as TripCase).id],
  );
  const conflict = await reportByDriver(
    before.driver,
    id,
    { type: 'delay', description: 'Something else' },
    retry,
  );
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'retry_key_conflict']);
  const byCarrier = await reportAs(carrier, id, {
    type: 'document_problem',
    description: 'Carrier note 6620',
  });
  assert.equal(byCarrier.status, 200, byCarrier.text);
  await advance(1);
  const byShipper = await reportAs(before.shipper, id, {
    type: 'receiver_absent',
    description: 'Shipper note 3381',
  });
  assert.equal(byShipper.status, 200, byShipper.text);
  // Not valid, and not theirs.
  for (const body of [
    { type: 'alien_attack', description: 'x' },
    { type: 'delay', description: '   ' },
  ]) {
    const reply = await reportAs(carrier, id, body);
    assert.equal(reply.status, 422, reply.text);
  }
  const outsider = await verifiedCarrier();
  const stranger = await reportAs(outsider, id, { type: 'delay', description: 'x' });
  assert.deepEqual([stranger.status, stranger.body.code], [404, 'not_found']);
  const missingKey = await call('POST', bookingRoute(carrier.org, id, '/exceptions'), {
    token: carrier.person.token,
    body: { type: 'delay', description: 'x' },
  });
  assert.deepEqual([missingKey.status, missingKey.body.code], [400, 'retry_key_required']);
  assert.equal(await count('trip_case', 'booking_id = $1', [id]), 3);
  // In the queue at once, with everything.
  const queue = await queueOf(operations);
  const mine = queue.open.filter((item) => item.reportedAs !== 'system');
  const shown = mine.filter((item) => [id].includes((item as { bookingId?: string }).bookingId!));
  assert.deepEqual(
    shown.map((item) => [item.reportedAs, item.type, item.state, item.description !== null]),
    [
      ['driver', 'breakdown', 'open', true],
      ['carrier', 'document_problem', 'open', true],
      ['shipper', 'receiver_absent', 'open', true],
    ],
  );
  // The shipper sees all three, and only its own description; the carrier also its driver's.
  const shipperCases = (await tripOf(before.shipper, id)).cases;
  assert.deepEqual(
    shipperCases.map((item) => [item.reportedAs, item.type, item.state, item.description]),
    [
      ['driver', 'breakdown', 'open', null],
      ['carrier', 'document_problem', 'open', null],
      ['shipper', 'receiver_absent', 'open', 'Shipper note 3381'],
    ],
  );
  const carrierCases = (await tripOf(await freshParty(carrier), id)).cases;
  assert.deepEqual(
    carrierCases.map((item) => item.description),
    ['Engine warning light near the border', 'Carrier note 6620', null],
  );
  for (const item of [...shipperCases, ...carrierCases])
    assert.equal((item as { events?: unknown }).events, undefined);
  // History: both organisations, without the description.
  const history = await owner.query<{ after_values: Record<string, unknown> }>(
    "SELECT after_values FROM trucker.audit_entry WHERE record_id = $1 AND action = 'trip.exception_reported'",
    [id],
  );
  assert.equal(history.rowCount, 6);
  assert.ok(history.rows.every((row) => !JSON.stringify(row).includes('note 3381')));
});

test('EXC-2: only staff holding the operations privilege see the queue and act; a case is acknowledged, acted on and resolved with who, when and why; the parties see the state, not the notes', async () => {
  const trip = await onTrip();
  const id = trip.booking.id;
  const reported = await reportByDriver(trip.driver, id, {
    type: 'delay',
    description: 'Queue at the port',
  });
  const item = reported.body.case as TripCase;
  // The privilege: granted by a staff administrator; a reviewer or administrator cannot use it.
  const admin = await newStaff(['staff_admin']);
  const reviewer = await newStaff(['reviewer']);
  for (const staff of [admin, reviewer]) {
    for (const reply of [
      await ops(await fresh(staff), ''),
      await ops(staff, `/bookings/${id}`),
      await ops(staff, `/cases/${item.id}/action`, { version: 1, action: 'acknowledge' }),
      await ops(staff, `/bookings/${id}/hold`, { hold: true, reason: 'other', note: 'x' }),
      await ops(staff, `/bookings/${id}/block`, { block: true, reason: 'other', note: 'x' }),
    ])
      assert.deepEqual([reply.status, reply.body.code], [403, 'staff_privilege_required']);
  }
  const granted = await call('POST', `/staff/accounts/${reviewer.id}/privileges`, {
    token: (await fresh(admin)).token,
    body: { privilege: 'operations', granted: true },
  });
  assert.equal(granted.status, 200, granted.text);
  const operations = await fresh(reviewer);
  // Acting before acknowledging, without a note, or on a stale version: refused.
  const early = await ops(operations, `/cases/${item.id}/action`, {
    version: 1,
    action: 'action',
    note: 'Called the driver',
  });
  assert.deepEqual([early.status, early.body.code], [409, 'case_not_open']);
  const ack = await ops(operations, `/cases/${item.id}/action`, {
    version: 1,
    action: 'acknowledge',
  });
  assert.equal(ack.status, 200, ack.text);
  const stale = await ops(operations, `/cases/${item.id}/action`, {
    version: 1,
    action: 'action',
    note: 'x',
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'record_changed']);
  const noNote = await ops(operations, `/cases/${item.id}/action`, {
    version: 2,
    action: 'resolve',
  });
  assert.equal(noNote.status, 422, noNote.text);
  await advance(60);
  const acted = await ops(await fresh(operations), `/cases/${item.id}/action`, {
    version: 2,
    action: 'action',
    note: 'Internal note 5517: called the driver',
  });
  assert.equal(acted.status, 200, acted.text);
  const resolved = await ops(operations, `/cases/${item.id}/action`, {
    version: 3,
    action: 'resolve',
    note: 'Port queue cleared',
  });
  assert.equal(resolved.status, 200, resolved.text);
  const after = resolved.body.case as TripCase;
  assert.deepEqual(
    [after.state, after.events!.map((event) => [event.action, event.by, event.note])],
    [
      'resolved',
      [
        ['acknowledged', 'Test Staff', null],
        ['action', 'Test Staff', 'Internal note 5517: called the driver'],
        ['resolved', 'Test Staff', 'Port queue cleared'],
      ],
    ],
  );
  const again2 = await ops(operations, `/cases/${item.id}/action`, {
    version: 4,
    action: 'action',
    note: 'x',
  });
  assert.deepEqual([again2.status, again2.body.code], [409, 'case_not_open']);
  // The parties: the state, never the notes.
  for (const party of [trip.shipper, await freshParty(trip.carrier)]) {
    const seen = JSON.stringify(await tripViewOf(await freshParty(party), id));
    assert.ok(seen.includes('"state":"resolved"'));
    assert.ok(!seen.includes('5517') && !seen.includes('Port queue cleared'));
  }
  const history = await owner.query<{
    action: string;
    actor_staff_id: string;
    after_values: unknown;
  }>(
    "SELECT action, actor_staff_id, after_values FROM trucker.audit_entry WHERE record_id = $1 AND action = 'trip.case_updated' ORDER BY occurred_at",
    [id],
  );
  assert.equal(history.rowCount, 4);
  assert.ok(history.rows.every((row) => row.actor_staff_id === reviewer.id));
  assert.ok(!JSON.stringify(history.rows).includes('5517'));
  // Records are never changed or removed.
  await refused(
    () => owner.query("UPDATE trucker.trip_case SET description = 'x'"),
    /only moves forward/,
  );
  await refused(
    () => owner.query("UPDATE trucker.trip_case SET state = 'open', row_version = row_version + 1"),
    /only moves forward/,
  );
  await refused(
    () => owner.query("UPDATE trucker.trip_case_event SET note = 'x'"),
    /never changed/,
  );
  await refused(() => owner.query('DELETE FROM trucker.trip_case_event'), /never changed/);
});

test('DB-9, DD-4: operations blocks a dispatch with a reason the parties see and a note they do not; the block is lifted with a note; a dispatch and a block at the same moment end with one of them', async () => {
  const operations = await operator();
  const trip = await onTrip(false);
  const id = trip.booking.id;
  const noNote = await ops(await fresh(operations), `/bookings/${id}/block`, {
    block: true,
    reason: 'safety_review',
    note: '',
  });
  assert.equal(noNote.status, 422);
  const blocked = await ops(operations, `/bookings/${id}/block`, {
    block: true,
    reason: 'safety_review',
    note: 'Block note 9083',
  });
  assert.equal(blocked.status, 200, blocked.text);
  const twice = await ops(operations, `/bookings/${id}/block`, {
    block: true,
    reason: 'other',
    note: 'again',
  });
  assert.deepEqual([twice.status, twice.body.code], [409, 'already_blocked']);
  const refusedDispatch = await dispatch(trip.carrier, id);
  assert.deepEqual(
    [
      refusedDispatch.body.code,
      refusalOf(refusedDispatch)?.reason,
      refusalOf(refusedDispatch)?.cause,
    ],
    ['dispatch_refused', 'operations_block', 'safety_review'],
  );
  for (const party of [trip.shipper, await freshParty(trip.carrier)]) {
    const view = await tripViewOf(await freshParty(party), id);
    assert.deepEqual(
      view.dispatch.blockers.filter((item) => item.code === 'operations_block'),
      [{ code: 'operations_block', reason: 'safety_review' }],
    );
    assert.equal(view.dispatch.ready, false);
    assert.ok(!JSON.stringify(view).includes('9083'));
  }
  const lifted = await ops(await fresh(operations), `/bookings/${id}/block`, {
    block: false,
    note: 'Checked: safe',
  });
  assert.equal(lifted.status, 200, lifted.text);
  const notBlocked = await ops(operations, `/bookings/${id}/block`, { block: false, note: 'x' });
  assert.deepEqual([notBlocked.status, notBlocked.body.code], [409, 'not_blocked']);
  const record = await opsBooking(operations, id);
  assert.deepEqual(
    record.blocks.map((item) => [item.reason, item.note, item.liftedAt !== null]),
    [['safety_review', 'Block note 9083', true]],
  );
  // Direct writes: a lifted block stays lifted and is never removed.
  await refused(
    () =>
      owner.query(
        'UPDATE trucker.dispatch_block SET lifted_at = NULL, lifted_by = NULL, lift_note = NULL',
      ),
    /only ever lifted/,
  );
  await refused(() => owner.query('DELETE FROM trucker.dispatch_block'), /only ever lifted/);
  // Dispatched now: a block comes too late.
  const carrier = await freshParty(trip.carrier);
  assert.equal((await dispatch(carrier, id)).status, 200);
  const late = await ops(await fresh(operations), `/bookings/${id}/block`, {
    block: true,
    reason: 'other',
    note: 'Too late',
  });
  assert.deepEqual([late.status, late.body.code], [409, 'booking_dispatched']);
  // A block takes the same locks as a dispatch: it waits while the shipment is locked.
  const waited = await onTrip(false);
  const waitedBlock = await whileHeld(
    `SELECT 1 FROM trucker.shipment_draft WHERE id = (SELECT shipment_id FROM trucker.booking WHERE id = $1) FOR UPDATE`,
    [waited.booking.id],
    async () =>
      ops(await fresh(operations), `/bookings/${waited.booking.id}/block`, {
        block: true,
        reason: 'other',
        note: 'Waited',
      }),
    async () => undefined,
  );
  assert.equal(waitedBlock.status, 200, waitedBlock.text);
  // At the same moment: exactly one of them.
  const race = await onTrip(false);
  await fresh(operations);
  const [byCarrier, byOperations] = await Promise.all([
    dispatch(race.carrier, race.booking.id),
    ops(operations, `/bookings/${race.booking.id}/block`, {
      block: true,
      reason: 'suspected_fraud',
      note: 'Race',
    }),
  ]);
  assert.equal(
    [byCarrier.status, byOperations.status].filter((status) => status === 200).length,
    1,
    `${byCarrier.text} / ${byOperations.text}`,
  );
  const trips = await count('trip', 'booking_id = $1', [race.booking.id]);
  const blocks = await count('dispatch_block', 'booking_id = $1 AND lifted_at IS NULL', [
    race.booking.id,
  ]);
  assert.equal(trips + blocks, 1);
  assert.deepEqual(await consistency(), []);
});

test('EXC-4: a trip on hold accepts no milestone until it is resumed; the hold is seen with its reason, not its note', async () => {
  const operations = await operator();
  const before = await onTrip(false);
  const tooSoon = await ops(await fresh(operations), `/bookings/${before.booking.id}/hold`, {
    hold: true,
    reason: 'safety_review',
    note: 'x',
  });
  assert.deepEqual([tooSoon.status, tooSoon.body.code], [409, 'not_dispatched']);
  assert.equal((await dispatch(before.carrier, before.booking.id)).status, 200);
  const id = before.booking.id;
  const held = await ops(operations, `/bookings/${id}/hold`, {
    hold: true,
    reason: 'document_concern',
    note: 'Hold note 4410',
  });
  assert.equal(held.status, 200, held.text);
  const twice = await ops(operations, `/bookings/${id}/hold`, {
    hold: true,
    reason: 'other',
    note: 'x',
  });
  assert.deepEqual([twice.status, twice.body.code], [409, 'already_held']);
  const driver = await again(before.driver);
  const refusedDriver = await byDriver(driver, id, 1, 'departed_for_pickup');
  assert.deepEqual([refusedDriver.status, refusedDriver.body.code], [409, 'trip_on_hold']);
  const carrier = await freshParty(before.carrier);
  const refusedCarrier = await onBehalf(carrier, id, {
    version: 1,
    milestone: 'departed_for_pickup',
    statedAt: iso(clock()),
    reason: 'no_signal',
  });
  assert.deepEqual([refusedCarrier.status, refusedCarrier.body.code], [409, 'trip_on_hold']);
  const refusedOps = await ops(operations, `/bookings/${id}/milestones`, {
    version: 1,
    milestone: 'departed_for_pickup',
    statedAt: iso(clock()),
    reason: 'no_signal',
  });
  assert.deepEqual([refusedOps.status, refusedOps.body.code], [409, 'trip_on_hold']);
  assert.equal(
    await count(
      'trip_milestone',
      'trip_id IN (SELECT id FROM trucker.trip WHERE booking_id = $1)',
      [id],
    ),
    0,
  );
  for (const party of [before.shipper, carrier]) {
    const trip = await tripOf(await freshParty(party), id);
    assert.equal(trip.hold?.reason, 'document_concern');
    assert.ok(!JSON.stringify(trip).includes('4410'));
  }
  // The driver sees the hold too.
  const assignments = await call('GET', '/me/driver/assignments', { token: driver.token });
  const listed = (
    assignments.body.assignments as { bookingId: string; trip?: OperationsTrip }[]
  ).find((item) => item.bookingId === id);
  assert.equal(listed?.trip?.hold?.reason, 'document_concern');
  const resumed = await ops(await fresh(operations), `/bookings/${id}/hold`, {
    hold: false,
    note: 'Documents checked',
  });
  assert.equal(resumed.status, 200, resumed.text);
  const notHeld = await ops(operations, `/bookings/${id}/hold`, { hold: false, note: 'x' });
  assert.deepEqual([notHeld.status, notHeld.body.code], [409, 'not_held']);
  const recorded = await byDriver(await again(driver), id, 1, 'departed_for_pickup');
  assert.equal(recorded.status, 200, recorded.text);
  await refused(
    () => owner.query('UPDATE trucker.trip_hold SET resumed_at = NULL'),
    /only ever lifted/,
  );
  // A hold that waited for the trip while a milestone was being recorded: one of them first.
  const holder = await whileHeld(
    'SELECT 1 FROM trucker.trip WHERE booking_id = $1 FOR UPDATE',
    [id],
    () => ops(operations, `/bookings/${id}/hold`, { hold: true, reason: 'other', note: 'Wait' }),
    async () => undefined,
  );
  assert.equal(holder.status, 200, holder.text);
  const blockedNext = await byDriver(await again(driver), id, 2, 'arrived_at_pickup');
  assert.deepEqual([blockedNext.status, blockedNext.body.code], [409, 'trip_on_hold']);
});

test("DD-6: operations records a milestone on the driver's behalf; the parties see that Trucker operations entered it, not who", async () => {
  const operations = await operator();
  const trip = await onTrip();
  const id = trip.booking.id;
  await advance(10 * 60);
  const recorded = await ops(await fresh(operations), `/bookings/${id}/milestones`, {
    version: 1,
    milestone: 'departed_for_pickup',
    statedAt: iso(new Date(clock().getTime() - 5 * 60_000)),
    reason: 'driver_unable',
    note: 'Ops note 7740',
  });
  assert.equal(recorded.status, 200, recorded.text);
  const skipped = await ops(operations, `/bookings/${id}/milestones`, {
    version: 2,
    milestone: 'loading_started',
    statedAt: iso(clock()),
    reason: 'no_phone',
  });
  assert.deepEqual([skipped.status, skipped.body.code], [409, 'milestone_out_of_sequence']);
  const seen = (await opsBooking(operations, id)).trip!.milestones[0]! as Milestone & {
    enteredAs: string;
  };
  assert.deepEqual(
    [seen.basis, seen.enteredAs, seen.enteredBy, seen.note],
    ['reported', 'operations', 'Test Staff', 'Ops note 7740'],
  );
  for (const party of [trip.shipper, await freshParty(trip.carrier)]) {
    const milestone = (await tripOf(await freshParty(party), id)).milestones[0]! as Milestone & {
      enteredAs: string;
    };
    assert.deepEqual(
      [milestone.basis, milestone.enteredAs, milestone.enteredBy, milestone.note ?? null],
      ['reported', 'operations', null, null],
    );
  }
  const audit = await owner.query<{ actor_staff_id: string; actor_person_id: string | null }>(
    "SELECT actor_staff_id, actor_person_id FROM trucker.audit_entry WHERE record_id = $1 AND action = 'trip.milestone_recorded'",
    [id],
  );
  assert.deepEqual(
    audit.rows.map((row) => [row.actor_staff_id, row.actor_person_id]),
    [
      [operations.id, null],
      [operations.id, null],
    ],
  );
});

test('A milestone recorded by mistake: operations withdraws the latest one with a reason; it stays in the record as withdrawn; the trip goes back one step and the step is recorded again', async () => {
  const operations = await operator();
  const trip = await onTrip();
  const id = trip.booking.id;
  const none = await ops(await fresh(operations), `/bookings/${id}/milestones/withdraw`, {
    version: 1,
    note: 'Nothing yet',
  });
  assert.deepEqual([none.status, none.body.code], [409, 'nothing_to_withdraw']);
  const driver = trip.driver;
  assert.equal((await byDriver(driver, id, 1, 'departed_for_pickup')).status, 200);
  const departedAt = clock().getTime();
  await advance(10 * 60);
  assert.equal((await byDriver(driver, id, 2, 'arrived_at_pickup')).status, 200);
  const noNote = await ops(operations, `/bookings/${id}/milestones/withdraw`, {
    version: 3,
    note: ' ',
  });
  assert.equal(noNote.status, 422);
  const stale = await ops(operations, `/bookings/${id}/milestones/withdraw`, {
    version: 2,
    note: 'Pressed by mistake',
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'record_changed']);
  const withdrawn = await ops(operations, `/bookings/${id}/milestones/withdraw`, {
    version: 3,
    note: 'Pressed by mistake at the depot',
  });
  assert.equal(withdrawn.status, 200, withdrawn.text);
  const after = withdrawn.body.trip as OperationsTrip;
  assert.deepEqual(
    [
      after.version,
      after.next,
      after.milestones.map((m) => m.milestone),
      after.withdrawn.map((w) => [w.milestone, w.note]),
    ],
    [
      4,
      'arrived_at_pickup',
      ['departed_for_pickup'],
      [['arrived_at_pickup', 'Pressed by mistake at the depot']],
    ],
  );
  // The parties see it was withdrawn, not why.
  const shipperTrip = await tripOf(trip.shipper, id);
  assert.deepEqual(
    shipperTrip.withdrawn.map((w) => [w.milestone, w.note]),
    [['arrived_at_pickup', null]],
  );
  // Recorded again, on the driver's behalf, at a time between the departure and the withdrawn
  // milestone: compared with the milestone in force before it, not the withdrawn one.
  const redone = await onBehalf(await freshParty(trip.carrier), id, {
    version: 4,
    milestone: 'arrived_at_pickup',
    statedAt: iso(new Date(departedAt + 5 * 60_000)),
    reason: 'correction',
  });
  assert.equal(redone.status, 200, redone.text);
  const final = redone.body.trip as OperationsTrip;
  assert.deepEqual(
    [final.next, final.milestones.map((m) => [m.milestone, m.needsReview])],
    [
      'loading_started',
      [
        ['departed_for_pickup', false],
        ['arrived_at_pickup', false],
      ],
    ],
  );
  // Only the latest in force is withdrawn, the trip moves back only with a withdrawal, and two
  // in force for one step are refused, whichever path writes.
  const tripId = final.id;
  const first = (
    await owner.query<{ id: string }>(
      "SELECT id FROM trucker.trip_milestone WHERE trip_id = $1 AND milestone = 'departed_for_pickup'",
      [tripId],
    )
  ).rows[0]!.id;
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.trip_milestone_withdrawal (milestone_id, trip_id, withdrawn_by, withdrawn_at, note)
         VALUES ($1, $2, $3, now(), 'x')`,
        [first, tripId, operations.id],
      ),
    /only the latest/,
  );
  await refused(
    () =>
      owner.query(
        'UPDATE trucker.trip SET milestone_count = milestone_count - 1, row_version = row_version + 1 WHERE id = $1',
        [tripId],
      ),
    /only moves/,
  );
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.trip_milestone (trip_id, seq, milestone, stated_at, recorded_at, basis, driver_id, recorded_by)
         SELECT trip_id, seq, milestone, stated_at, recorded_at, basis, driver_id, recorded_by
         FROM trucker.trip_milestone WHERE id = $1`,
        [first],
      ),
    /already recorded/,
  );
  await refused(
    () => owner.query('DELETE FROM trucker.trip_milestone_withdrawal'),
    /never changed/,
  );
});

test('EXC-3, DD-9: an overrun opens one case, linked to the later booking it puts at risk, however often it is seen; no arrival at pick-up by the end of the window opens one too; neither changes anything else', async () => {
  const operations = await operator();
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
  // Other tests' trips share this database: count this booking's cases.
  const casesOf = (kind: string) =>
    count('trip_case', 'booking_id = $1 AND kind = $2', [earlier.booking.id, kind]);
  await tick();
  assert.equal(await count('trip_case', 'booking_id = $1', [earlier.booking.id]), 0);
  // Past the end of the pick-up window with no arrival: one case.
  const pickupUntil = (
    await owner.query<{ at: Date }>(
      "SELECT (shipment_snapshot #>> '{pickup,until,at}')::timestamptz AS at FROM trucker.booking WHERE id = $1",
      [earlier.booking.id],
    )
  ).rows[0]!.at;
  await advance(Math.ceil((pickupUntil.getTime() - clock().getTime()) / 1000) + 60);
  assert.ok((await tick()) >= 1);
  assert.equal(await tick(), 0);
  assert.deepEqual([await casesOf('no_pickup_arrival'), await casesOf('overrun')], [1, 0]);
  // Past the planned end with the truck still occupied: one overrun case, linked to the later one.
  const end = new Date(earlier.booking.plannedReservation.endAt);
  await advance(Math.ceil((end.getTime() - clock().getTime()) / 1000) + 60);
  assert.ok((await tick()) >= 1);
  for (let i = 0; i < 3; i += 1) assert.equal(await tick(), 0);
  assert.deepEqual([await casesOf('no_pickup_arrival'), await casesOf('overrun')], [1, 1]);
  // Seen again by a command that touches bookings and by the queue: still one each.
  await tripViewOf(await freshParty(carrier), later.booking.id);
  const queue = await queueOf(operations);
  const system = queue.open.filter(
    (item) => (item as { bookingId?: string }).bookingId === earlier.booking.id,
  );
  assert.deepEqual(
    system.map((item) => [item.kind, item.reportedAs, item.state, item.atRisk]).sort(),
    [
      ['no_pickup_arrival', 'system', 'open', []],
      ['overrun', 'system', 'open', [later.booking.id]],
    ],
  );
  assert.equal(await count('trip_case', 'booking_id = $1', [earlier.booking.id]), 2);
  assert.deepEqual((await opsBooking(operations, later.booking.id)).atRiskFrom.length, 1);
  // No automatic consequence: the episodes stay open, the later booking stays confirmed.
  assert.deepEqual(
    (await episodesOf(earlier.booking.id)).map((row) => row.closed_at),
    [null, null],
  );
  assert.equal(await count('booking_cancellation', 'booking_id = $1', [later.booking.id]), 0);
  const opened = await owner.query(
    "SELECT organisation_id FROM trucker.audit_entry WHERE record_id = $1 AND action = 'trip.case_opened'",
    [earlier.booking.id],
  );
  assert.equal(opened.rowCount, 4);
  // The parties see the cases exist, with their kind and state.
  const shipperView = await tripOf(await freshParty(earlier.shipper), earlier.booking.id);
  assert.deepEqual(shipperView.cases.map((item) => [item.kind, item.state]).sort(), [
    ['no_pickup_arrival', 'open'],
    ['overrun', 'open'],
  ]);
  assert.deepEqual(await consistency(), []);
});

test('EXC-1: a report that waited for the trip while the driver left the carrier records nothing', async () => {
  const trip = await onTrip();
  const id = trip.booking.id;
  const seen = (await fleetOf(trip.carrier.person, trip.carrier.org)).drivers.find(
    (item) => item.id === trip.affiliation,
  )!;
  const reply = await whileHeld(
    'SELECT 1 FROM trucker.trip WHERE booking_id = $1 FOR UPDATE',
    [id],
    () => reportByDriver(trip.driver, id, { type: 'delay', description: 'Waiting' }),
    async () => {
      const ended = await call(
        'POST',
        fleet(trip.carrier.org, `/drivers/${trip.affiliation}/end`),
        {
          token: trip.carrier.person.token,
          key: key(),
          body: { version: seen.version },
        },
      );
      assert.equal(ended.status, 200, ended.text);
    },
  );
  assert.deepEqual([reply.status, reply.body.code], [404, 'not_found']);
  assert.equal(await count('trip_case', 'booking_id = $1', [id]), 0);
});
