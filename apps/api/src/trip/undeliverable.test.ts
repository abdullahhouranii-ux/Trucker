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
const operator = async (): Promise<Staff> => newStaff(['operations']);
const ops = (staff: Staff, route: string, body?: unknown): Promise<Reply> =>
  call(body === undefined ? 'GET' : 'POST', `/staff/operations${route}`, {
    token: staff.token,
    ...(body === undefined ? {} : { body }),
  });
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
const handover = (party: Party, id: string, body: Record<string, unknown>) =>
  call('POST', bookingRoute(party.org, id, '/handover'), { token: party.person.token, body });
const release = (party: Party, id: string, role: string) =>
  call('POST', bookingRoute(party.org, id, `/resources/${role}/release`), {
    token: party.person.token,
  });
const openEpisodes = (id: string) =>
  count('occupancy_episode', 'booking_id = $1 AND closed_at IS NULL', [id]);
const handoverBody = (quantity = 14) => ({
  kind: 'returned_to_shipper',
  handedBy: 'Fictional Driver',
  handedByStanding: 'Driver of the carrier',
  receivedBy: 'Fictional Warehouse Clerk',
  receivedByStanding: "Clerk at the shipper's warehouse",
  handedAt: iso(new Date(clock().getTime() - 60_000)),
  place: 'Origin warehouse, gate 2 (fictional)',
  quantity,
  condition: 'Crates intact (fictional)',
});
/** Why delivery fell short, and the quantities (slice 18d). */
const shortfall = (reason = 'receiver_refused', delivered = 0, remaining = 14) => ({
  reason,
  location: 'Delivery gate (fictional)',
  cargoCondition: 'Sealed crates (fictional)',
  quantityUnit: 'crates',
  quantityDelivered: delivered,
  quantityRemaining: remaining,
  contactAttempts: 2,
});
/** The receiving side confirms a handover: the shipper's administrator (slice 18d). */
const confirmReceipt = async (party: Party, id: string, handoverId: string) =>
  call('POST', bookingRoute(party.org, id, '/cargo'), {
    token: party.person.token,
    key: key(),
    body: {
      command: 'confirm_receipt',
      handoverId,
      state: 'confirmed',
      reference: 'Warehouse receipt 001 (fictional)',
    },
  });
const handoverIdOf = async (id: string) =>
  (
    await owner.query<{ id: string }>(
      'SELECT h.id FROM trucker.cargo_handover h JOIN trucker.trip t ON t.id = h.trip_id WHERE t.booking_id = $1 AND NOT EXISTS (SELECT 1 FROM trucker.cargo_handover_receipt r WHERE r.handover_id = h.id)',
      [id],
    )
  ).rows[0]!.id;

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
// Undeliverable and refused cargo (slice 18d, R-406)
// ---------------------------------------------------------------------------------------------
interface Cost {
  id: string;
  kind: string;
  amount: string;
  interimPayer: string;
  provisionalLiability: string;
  finalLiability: string | null;
  held: boolean;
}
interface Instruction {
  id: string;
  version: number;
  action: string;
  state: string;
  emergency: boolean;
  approvalBasis: string | null;
  costs: Cost[] | null;
}
interface Cargo {
  authorities:
    | { id: string; holderRole: string; endedAt: string | null; alternateContact?: string | null }[]
    | null;
  onVehicle: string | number;
  case: {
    id: string;
    version: number;
    cargoClass: string;
    responseDueAt: string;
    escalateAt: string;
    escalatedAt: string | null;
    instructions: Instruction[];
    handovers: { id: string; quantity: string; receipt: { state: string } | null }[];
    legs: { id: string; state: string }[];
    claims: { id: string; state: string }[] | null;
    holds: { id: string; ownerKind: string; releasedAt: string | null }[] | null;
  } | null;
}
const cargoCommand = (party: Party, id: string, body: Record<string, unknown>, retry = key()) =>
  call('POST', bookingRoute(party.org, id, '/cargo'), {
    token: party.person.token,
    key: retry,
    body,
  });
const driverCargo = (driver: Person, id: string, body: Record<string, unknown>, retry = key()) =>
  call('POST', `/me/driver/assignments/${id}/cargo`, { token: driver.token, key: retry, body });
const opsCargo = async (staff: Staff, id: string, body: Record<string, unknown>, retry = key()) =>
  call('POST', `/staff/operations/bookings/${id}/cargo`, {
    token: (await fresh(staff)).token,
    key: retry,
    body,
  });
const cargoOf = async (party: Party, id: string): Promise<Cargo> =>
  ((await tripViewOf(party, id)).trip as unknown as { cargo: Cargo }).cargo;
const declareSelf = (shipper: Party, id: string, over: Record<string, unknown> = {}) =>
  cargoCommand(shipper, id, {
    command: 'declare_authority',
    holder: 'self',
    confirmContract: true,
    basisNote: 'The sale contract makes us the party who instructs (fictional)',
    actions: [
      'retry_delivery',
      'alternate_destination',
      'temporary_storage',
      'return_to_sender',
      'return_destination',
    ],
    spendLimit: '500.00',
    alternateContact: 'Fictional Duty Manager, +99900000001',
    ...over,
  });
const costLine = (over: Record<string, unknown> = {}) => ({
  kind: 'storage',
  quantity: '2',
  unit: 'day',
  unitAmount: '25.00',
  ...over,
});

/**
 * A dispatched trip that arrived at delivery, where the receiver refused everything: a case with
 * 14 crates on the vehicle. The customer has declared its authority unless asked not to.
 */
async function refusedTrip(reason = 'receiver_refused', declare = true) {
  const trip = await onTrip();
  const id = trip.booking.id;
  await arrive(trip.driver, id);
  const recorded = await deliverAsDriver(trip.driver, id, {
    version: 0,
    outcome: 'refused',
    remarks: 'Receiver refused the load (fictional)',
    shortfall: { ...shortfall(reason), refusalReason: 'Not what was ordered (fictional)' },
  });
  assert.equal(recorded.status, 200, recorded.text);
  const shipper = await freshParty(trip.shipper);
  if (declare) assert.equal((await declareSelf(shipper, id)).status, 200);
  return { ...trip, id, shipper, carrier: await freshParty(trip.carrier) };
}
const caseVersion = async (party: Party, id: string) => (await cargoOf(party, id)).case!.version;
const openInstruction = async (party: Party, id: string): Promise<Instruction> =>
  (await cargoOf(party, id)).case!.instructions.at(-1)!;

/** Puts the booking's organiser in place directly, as an organiser-arranged booking would have it. */
async function withOrganiser(id: string): Promise<Party> {
  const person = await newPerson();
  const org = await newOrganisation(person, { legalName: 'Fixture Organiser (fictional)' });
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE trucker.booking_party DISABLE TRIGGER booking_party_guard');
    await client.query(
      'UPDATE trucker.booking_party SET organiser_organisation_id = $2 WHERE booking_id = $1',
      [id, org],
    );
    await client.query('ALTER TABLE trucker.booking_party ENABLE TRIGGER booking_party_guard');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { person: await again(person), org };
}

test('UD-T1: an instruction from anyone without authority in force is refused: the carrier, an organiser without a mandate, a customer that has not declared, a mandate outside its actions, expired or ended, or ended while the instruction waited', async () => {
  const trip = await refusedTrip('receiver_refused', false);
  const { id, shipper, carrier } = trip;
  const organiser = await withOrganiser(id);
  let viewer = shipper;
  const issue =
    (party: Party, action = 'temporary_storage', version?: number) =>
    async () =>
      cargoCommand(party, id, {
        command: 'issue',
        action,
        version: version ?? (await caseVersion(viewer, id)),
      });
  assert.deepEqual(
    [(await issue(carrier)()).status, (await issue(carrier)()).body.code],
    [404, 'not_found'],
  );
  for (const party of [shipper, organiser]) {
    const reply = await issue(party)();
    assert.deepEqual([reply.status, reply.body.code], [403, 'no_instruction_authority']);
  }
  // The customer must state that it holds the authority.
  const unconfirmed = await declareSelf(shipper, id, { confirmContract: false });
  assert.equal(unconfirmed.status, 422, unconfirmed.text);
  // A mandate for the organiser: storage only, until tomorrow.
  const mandate = await cargoCommand(shipper, id, {
    command: 'declare_authority',
    holder: 'organiser',
    basisNote: 'Mandate for storage only (fictional)',
    actions: ['temporary_storage'],
    spendLimit: '100.00',
    validUntil: iso(new Date(clock().getTime() + 24 * 3600_000)),
    alternateContact: 'Fictional Organiser Desk, +99900000002',
  });
  assert.equal(mandate.status, 200, mandate.text);
  const outside = await issue(organiser, 'return_to_sender')();
  assert.deepEqual([outside.status, outside.body.code], [403, 'no_instruction_authority']);
  // Expired: nothing new.
  await advance(25 * 3600);
  const shipperNow = await freshParty(shipper);
  viewer = shipperNow;
  const expired = await issue(await freshParty(organiser))();
  assert.deepEqual([expired.status, expired.body.code], [403, 'no_instruction_authority']);
  // A new mandate, ended while the organiser's instruction waits for the trip: refused.
  assert.equal(
    (
      await cargoCommand(shipperNow, id, {
        command: 'declare_authority',
        holder: 'organiser',
        basisNote: 'Renewed mandate (fictional)',
        actions: ['temporary_storage'],
        spendLimit: '100.00',
        alternateContact: 'Fictional Organiser Desk, +99900000002',
      })
    ).status,
    200,
  );
  const organiserNow = await freshParty(organiser);
  const version = await caseVersion(shipperNow, id);
  const current = (await cargoOf(shipperNow, id)).authorities!.find(
    (item) => item.holderRole === 'organiser' && item.endedAt === null,
  )!;
  const waited = await whileHeld(
    'SELECT 1 FROM trucker.trip WHERE booking_id = $1 FOR UPDATE',
    [id],
    issue(organiserNow, 'temporary_storage', version),
    async () => {
      await owner.query(
        "UPDATE trucker.instruction_authority SET ended_at = now(), ended_by = declared_by, end_reason = 'Ended by the customer' WHERE id = $1",
        [current.id],
      );
    },
  );
  assert.deepEqual([waited.status, waited.body.code], [403, 'no_instruction_authority']);
  assert.equal(
    await count('cargo_instruction', 'case_id = $1', [(await cargoOf(shipperNow, id)).case!.id]),
    0,
  );
  // The history of who held authority is kept; the booking snapshot is untouched.
  assert.equal(await count('instruction_authority', 'booking_id = $1', [id]), 2);
});

test('UD-T2, UD-T3: stale or simultaneous instructions never both run; a lost answer retried with its key repeats nothing', async () => {
  const trip = await refusedTrip();
  const { id, shipper, carrier } = trip;
  const version = await caseVersion(shipper, id);
  const retry = key();
  const body = {
    command: 'issue',
    action: 'temporary_storage',
    version,
    details: 'Store at the nearest warehouse',
  };
  const [one, two] = await Promise.all([
    cargoCommand(shipper, id, body, retry),
    cargoCommand(shipper, id, { ...body, action: 'return_to_sender' }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409], `${one.text} / ${two.text}`);
  // The same key again: the first answer, nothing new.
  const again1 = await cargoCommand(shipper, id, body, retry);
  assert.equal(again1.status, one.status);
  const conflict = await cargoCommand(shipper, id, { ...body, details: 'Other' }, retry);
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'retry_key_conflict']);
  const caseId = (await cargoOf(shipper, id)).case!.id;
  assert.equal(await count('cargo_instruction', 'case_id = $1', [caseId]), 1);
  // A stale version is refused.
  const stale = await cargoCommand(shipper, id, { ...body, version });
  assert.equal(stale.status, 409);
  // The offer, sent twice with one key: one set of costs.
  const instruction = await openInstruction(shipper, id);
  const offerKey = key();
  const offer = {
    command: 'offer',
    instructionId: instruction.id,
    version: instruction.version,
    feasible: true,
    eta: iso(new Date(clock().getTime() + 3600_000)),
    costs: [
      costLine(),
      costLine({ kind: 'handling', quantity: '1', unit: 'lump_sum', unitAmount: '40.00' }),
    ],
  };
  assert.equal((await cargoCommand(carrier, id, offer, offerKey)).status, 200);
  assert.equal((await cargoCommand(carrier, id, offer, offerKey)).status, 200);
  assert.equal(await count('exception_cost', 'case_id = $1', [caseId]), 2);
  // Two approvals at once: one is recorded.
  const offered = await openInstruction(shipper, id);
  const decide = {
    command: 'decide',
    instructionId: offered.id,
    version: offered.version,
    decision: 'approve',
  };
  const approvals = await Promise.all([
    cargoCommand(shipper, id, decide),
    cargoCommand(shipper, id, decide),
  ]);
  assert.deepEqual(approvals.map((reply) => reply.status).sort(), [200, 409]);
  const approved = await openInstruction(shipper, id);
  assert.deepEqual(
    [
      approved.state,
      approved.approvalBasis,
      approved.costs!.map((item) => [item.amount, item.interimPayer]),
    ],
    [
      'approved',
      'authorised_party',
      [
        ['50.00', 'instructing_party'],
        ['40.00', 'instructing_party'],
      ],
    ],
  );
  // The case cannot be closed while an instruction is open.
  const closing = await opsCargo(await operator(), id, {
    command: 'close_case',
    note: 'Too early',
  });
  assert.deepEqual([closing.status, closing.body.code], [409, 'instruction_open']);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'execute',
        instructionId: approved.id,
        version: approved.version,
        step: 'start',
      })
    ).status,
    200,
  );
});

test('UD-T4, UD-T5: a refusal by the receiver charges nobody automatically, never the receiver; a claim of carrier fault places a hold and changes no amount or liability', async () => {
  const trip = await refusedTrip('receiver_refused');
  const { id, shipper, carrier } = trip;
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'issue',
        action: 'temporary_storage',
        version: await caseVersion(shipper, id),
      })
    ).status,
    200,
  );
  let instruction = await openInstruction(shipper, id);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'offer',
        instructionId: instruction.id,
        version: instruction.version,
        feasible: true,
        costs: [costLine()],
      })
    ).status,
    200,
  );
  instruction = await openInstruction(shipper, id);
  const cost = instruction.costs![0]!;
  assert.deepEqual(
    [cost.provisionalLiability, cost.finalLiability, cost.interimPayer],
    ['pending', null, 'not_set'],
  );
  // No liability value can name the receiver.
  await refused(
    () =>
      owner.query(
        "UPDATE trucker.exception_cost SET provisional_liability = 'receiver' WHERE id = $1",
        [cost.id],
      ),
    /check constraint|only moves forward/,
  );
  // A claim of carrier fault: a hold on that cost, nothing deducted.
  const claim = await cargoCommand(shipper, id, {
    command: 'raise_claim',
    costIds: [cost.id],
    reason: 'The carrier arrived a day late (fictional)',
  });
  assert.equal(claim.status, 200, claim.text);
  const after = (await cargoOf(shipper, id)).case!;
  const sameCost = after.instructions.at(-1)!.costs![0]!;
  assert.deepEqual(
    [
      sameCost.amount,
      sameCost.provisionalLiability,
      sameCost.finalLiability,
      sameCost.held,
      after.claims![0]!.state,
    ],
    ['50.00', 'pending', null, true, 'open'],
  );
  // The carrier is not shown to be at fault by the claim alone; and a wrong address presumes the contract.
  const other = await refusedTrip('wrong_address');
  assert.equal(
    (
      await cargoCommand(other.shipper, other.id, {
        command: 'issue',
        action: 'retry_delivery',
        version: await caseVersion(other.shipper, other.id),
      })
    ).status,
    200,
  );
  const retryInstruction = await openInstruction(other.shipper, other.id);
  assert.equal(
    (
      await cargoCommand(other.carrier, other.id, {
        command: 'offer',
        instructionId: retryInstruction.id,
        version: retryInstruction.version,
        feasible: true,
        costs: [costLine({ kind: 'retry', quantity: '1', unit: 'trip', unitAmount: '80.00' })],
      })
    ).status,
    200,
  );
  const offeredRetry = await openInstruction(other.shipper, other.id);
  assert.equal(offeredRetry.costs![0]!.provisionalLiability, 'per_contract');
  // Above the spending limit of the authority in force: nothing approved.
  assert.equal((await declareSelf(other.shipper, other.id, { spendLimit: '50.00' })).status, 200);
  const over = await cargoCommand(other.shipper, other.id, {
    command: 'decide',
    instructionId: offeredRetry.id,
    version: offeredRetry.version,
    decision: 'approve',
  });
  assert.deepEqual([over.status, over.body.code], [409, 'over_spend_limit']);
  assert.equal((await openInstruction(other.shipper, other.id)).state, 'offered');
});

test('UD-T6, UD-T7, UD-T8: a partial delivery keeps its quantities; a handover not confirmed by the receiving side moves no custody; recording delivery or storage releases nothing', async () => {
  const trip = await onTrip();
  const id = trip.booking.id;
  await arrive(trip.driver, id);
  const partial = await deliverAsDriver(trip.driver, id, {
    version: 0,
    outcome: 'partly_delivered',
    receiverName: 'Fictional Receiver',
    remarks: 'Four crates refused (fictional)',
    shortfall: shortfall('cargo_damaged', 10, 4),
  });
  assert.equal(partial.status, 200, partial.text);
  const shipper = await freshParty(trip.shipper);
  const carrier = await freshParty(trip.carrier);
  assert.equal(Number((await cargoOf(shipper, id)).onVehicle), 4);
  // More than is on the vehicle: refused.
  assert.equal(
    (await handover(carrier, id, { ...handoverBody(5), kind: 'warehouse' })).status,
    422,
  );
  const handed = await handover(carrier, id, { ...handoverBody(3), kind: 'warehouse' });
  assert.equal(handed.status, 200, handed.text);
  // Not confirmed: still 4 on the vehicle, release refused.
  assert.equal(Number((await cargoOf(shipper, id)).onVehicle), 4);
  assert.equal((await release(carrier, id, 'truck')).body.code, 'custody_open');
  // The carrier cannot confirm its own handover; the receiving side rejects, then a new one is confirmed.
  const own = await cargoCommand(carrier, id, {
    command: 'confirm_receipt',
    handoverId: await handoverIdOf(id),
    state: 'confirmed',
    reference: 'x',
  });
  assert.equal(own.status, 404);
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'confirm_receipt',
        handoverId: await handoverIdOf(id),
        state: 'rejected',
        reference: 'Warehouse full (fictional)',
      })
    ).status,
    200,
  );
  assert.equal(Number((await cargoOf(shipper, id)).onVehicle), 4);
  assert.equal(
    (await handover(carrier, id, { ...handoverBody(4), kind: 'warehouse' })).status,
    200,
  );
  assert.equal((await confirmReceipt(shipper, id, await handoverIdOf(id))).status, 200);
  assert.equal(Number((await cargoOf(shipper, id)).onVehicle), 0);
  // Recording all of this released nothing.
  assert.equal(await openEpisodes(id), 2);
  assert.equal((await release(carrier, id, 'truck')).status, 200);
  assert.deepEqual(await consistency(), []);
});

test('UD-T9: releasing the truck stops its waiting, while storage may continue and a hold stays', async () => {
  const trip = await refusedTrip('receiver_absent');
  const { id, shipper } = trip;
  let carrier = trip.carrier;
  // Three hours at the site: one hour billable after two free.
  await advance(3 * 3600);
  carrier = await freshParty(carrier);
  const shipperNow = await freshParty(shipper);
  assert.equal(
    (
      await cargoCommand(shipperNow, id, {
        command: 'issue',
        action: 'temporary_storage',
        version: await caseVersion(shipperNow, id),
      })
    ).status,
    200,
  );
  let instruction = await openInstruction(shipperNow, id);
  const tooLong = await cargoCommand(carrier, id, {
    command: 'offer',
    instructionId: instruction.id,
    version: instruction.version,
    feasible: true,
    costs: [costLine({ kind: 'waiting', quantity: '2', unit: 'hour', unitAmount: '10.00' })],
  });
  assert.deepEqual([tooLong.status, tooLong.body.code], [409, 'exceeds_billable_waiting']);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'offer',
        instructionId: instruction.id,
        version: instruction.version,
        feasible: true,
        costs: [
          costLine({ kind: 'waiting', quantity: '1', unit: 'hour', unitAmount: '10.00' }),
          costLine(),
        ],
      })
    ).status,
    200,
  );
  instruction = await openInstruction(shipperNow, id);
  assert.equal(
    (
      await cargoCommand(shipperNow, id, {
        command: 'decide',
        instructionId: instruction.id,
        version: instruction.version,
        decision: 'approve',
      })
    ).status,
    200,
  );
  instruction = await openInstruction(shipperNow, id);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'execute',
        instructionId: instruction.id,
        version: instruction.version,
        step: 'start',
      })
    ).status,
    200,
  );
  // Into the warehouse, confirmed; the truck is released.
  assert.equal(
    (
      await handover(carrier, id, {
        ...handoverBody(14),
        kind: 'warehouse',
        instructionId: instruction.id,
      })
    ).status,
    200,
  );
  assert.equal((await confirmReceipt(shipperNow, id, await handoverIdOf(id))).status, 200);
  const dispute = await cargoCommand(shipperNow, id, {
    command: 'dispute_cost',
    costIds: [instruction.costs![1]!.id],
    reason: 'The storage rate was not agreed (fictional)',
  });
  assert.equal(dispute.status, 200, dispute.text);
  assert.equal((await release(carrier, id, 'truck')).status, 200);
  // Hours later: no more waiting is billable after the release; storage may still be offered.
  await advance(5 * 3600);
  carrier = await freshParty(carrier);
  const shipperLater = await freshParty(shipper);
  instruction = await openInstruction(shipperLater, id);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'execute',
        instructionId: instruction.id,
        version: instruction.version,
        step: 'complete',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await cargoCommand(shipperLater, id, {
        command: 'issue',
        action: 'temporary_storage',
        version: await caseVersion(shipperLater, id),
        details: 'Keep it stored',
      })
    ).status,
    200,
  );
  instruction = await openInstruction(shipperLater, id);
  const moreWaiting = await cargoCommand(carrier, id, {
    command: 'offer',
    instructionId: instruction.id,
    version: instruction.version,
    feasible: true,
    costs: [costLine({ kind: 'waiting', quantity: '1', unit: 'hour', unitAmount: '10.00' })],
  });
  assert.deepEqual([moreWaiting.status, moreWaiting.body.code], [409, 'exceeds_billable_waiting']);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'offer',
        instructionId: instruction.id,
        version: instruction.version,
        feasible: true,
        costs: [costLine({ quantity: '5' })],
      })
    ).status,
    200,
  );
  const cargo = await cargoOf(shipperLater, id);
  assert.equal(cargo.case!.holds!.filter((item) => item.releasedAt === null).length, 1);
});

test('UD-T10: a return driven by the same truck is a leg of the original trip: the occupancy continues, nothing is released or rewritten, and the leg has its own delivery', async () => {
  const trip = await refusedTrip();
  const { id, shipper } = trip;
  const carrier = trip.carrier;
  const before = await owner.query('SELECT to_jsonb(b) AS b FROM trucker.booking b WHERE id = $1', [
    id,
  ]);
  const tripBefore = await owner.query(
    'SELECT milestone_count, row_version FROM trucker.trip WHERE booking_id = $1',
    [id],
  );
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'issue',
        action: 'return_to_sender',
        version: await caseVersion(shipper, id),
      })
    ).status,
    200,
  );
  let instruction = await openInstruction(shipper, id);
  // The booking's terms allow no return trip fee: none can be offered.
  const fee = await cargoCommand(carrier, id, {
    command: 'offer',
    instructionId: instruction.id,
    version: instruction.version,
    feasible: true,
    costs: [costLine({ kind: 'return', quantity: '1', unit: 'trip', unitAmount: '120.00' })],
  });
  assert.deepEqual([fee.status, fee.body.code], [409, 'return_fee_not_allowed']);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'offer',
        instructionId: instruction.id,
        version: instruction.version,
        feasible: true,
        costs: [
          costLine({ kind: 'handling', quantity: '1', unit: 'lump_sum', unitAmount: '30.00' }),
        ],
      })
    ).status,
    200,
  );
  instruction = await openInstruction(shipper, id);
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'decide',
        instructionId: instruction.id,
        version: instruction.version,
        decision: 'approve',
      })
    ).status,
    200,
  );
  instruction = await openInstruction(shipper, id);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'execute',
        instructionId: instruction.id,
        version: instruction.version,
        step: 'start',
      })
    ).status,
    200,
  );
  const leg = (await cargoOf(shipper, id)).case!.legs[0]!;
  assert.equal(leg.state, 'planned');
  // Still occupied: no release, not even by operations.
  assert.equal((await release(carrier, id, 'truck')).body.code, 'leg_under_way');
  const forced = await ops(await operator(), `/bookings/${id}/resources/truck/release`, {
    override: true,
    note: 'Try',
  });
  assert.deepEqual([forced.status, forced.body.code], [409, 'leg_under_way']);
  assert.equal(await openEpisodes(id), 2);
  // The driver drives the leg; the sender receives the cargo.
  for (const step of ['departed', 'arrived']) {
    const reply = await driverCargo(trip.driver, id, { command: 'leg', legId: leg.id, step });
    assert.equal(reply.status, 200, reply.text);
  }
  const done = await driverCargo(trip.driver, id, {
    command: 'leg',
    legId: leg.id,
    step: 'completed',
    quantityDelivered: '14',
    receiverName: 'Fictional Sender Clerk',
  });
  assert.equal(done.status, 200, done.text);
  assert.equal(Number((await cargoOf(shipper, id)).onVehicle), 0);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'execute',
        instructionId: instruction.id,
        version: (await openInstruction(shipper, id)).version,
        step: 'complete',
      })
    ).status,
    200,
  );
  assert.equal((await release(carrier, id, 'truck')).status, 200);
  // The original booking and trip were not rewritten.
  const after = await owner.query('SELECT to_jsonb(b) AS b FROM trucker.booking b WHERE id = $1', [
    id,
  ]);
  const tripAfter = await owner.query(
    'SELECT milestone_count, row_version FROM trucker.trip WHERE booking_id = $1',
    [id],
  );
  assert.deepEqual([after.rows[0], tripAfter.rows[0]], [before.rows[0], tripBefore.rows[0]]);
  assert.deepEqual(await consistency(), []);
});

test('UD-T11: silence approves nothing; after the response time the case is escalated and only a planned protective action within the cap is allowed; a later settings version does not change the booking', async () => {
  const trip = await refusedTrip('receiver_absent');
  const { id, shipper } = trip;
  let carrier = trip.carrier;
  // The response time comes from the booking's own terms (general cargo: 240 minutes, development value).
  const caseBefore = (await cargoOf(shipper, id)).case!;
  assert.equal(
    new Date(caseBefore.responseDueAt).getTime() -
      Date.parse(
        (
          await owner.query('SELECT opened_at FROM trucker.cargo_case WHERE id = $1', [
            caseBefore.id,
          ])
        ).rows[0].opened_at,
      ),
    240 * 60_000,
  );
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'issue',
        action: 'return_to_sender',
        version: caseBefore.version,
      })
    ).status,
    200,
  );
  let instruction = await openInstruction(shipper, id);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'offer',
        instructionId: instruction.id,
        version: instruction.version,
        feasible: true,
        costs: [
          costLine({ kind: 'handling', quantity: '1', unit: 'lump_sum', unitAmount: '30.00' }),
        ],
      })
    ).status,
    200,
  );
  // Before the response time: no emergency action.
  const early = await cargoCommand(carrier, id, {
    command: 'emergency',
    action: 'temporary_storage',
    costs: [costLine()],
  });
  assert.deepEqual([early.status, early.body.code], [409, 'response_time_not_passed']);
  // Nobody answers. The offer is not approved by silence; the watch escalates once.
  await advance(5 * 3600 + 60);
  await tick();
  await tick();
  carrier = await freshParty(carrier);
  const shipperNow = await freshParty(shipper);
  instruction = await openInstruction(shipperNow, id);
  assert.equal(instruction.state, 'offered');
  const escalated = (await cargoOf(shipperNow, id)).case!;
  assert.ok(escalated.escalatedAt !== null);
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM trucker.audit_entry WHERE record_id = $1 AND action = 'trip.cargo_escalated'",
        [id],
      )
    ).rows[0].n,
    2, // one entry for each side, written once
  );
  const notPlanned = await cargoCommand(carrier, id, {
    command: 'emergency',
    action: 'return_to_sender',
    costs: [],
  });
  assert.deepEqual([notPlanned.status, notPlanned.body.code], [409, 'not_in_emergency_plan']);
  const overCap = await cargoCommand(carrier, id, {
    command: 'emergency',
    action: 'temporary_storage',
    costs: [costLine({ quantity: '5' })],
  });
  assert.deepEqual([overCap.status, overCap.body.code], [409, 'over_emergency_cap']);
  const emergency = await cargoCommand(carrier, id, {
    command: 'emergency',
    action: 'temporary_storage',
    details: 'Into covered storage before the site closes (fictional)',
    costs: [costLine({ quantity: '2' })],
  });
  assert.equal(emergency.status, 200, emergency.text);
  const cargo = (await cargoOf(shipperNow, id)).case!;
  assert.deepEqual(
    cargo.instructions.map((item) => [item.action, item.state, item.emergency, item.approvalBasis]),
    [
      ['return_to_sender', 'withdrawn', false, null],
      ['temporary_storage', 'approved', true, 'emergency_plan'],
    ],
  );
  assert.equal(cargo.instructions[1]!.costs![0]!.interimPayer, 'carrier');
  // Selling, destroying, abandoning or crossing a border is never an action.
  const sell = await cargoCommand(shipperNow, id, {
    command: 'issue',
    action: 'sell_cargo',
    version: cargo.version,
  });
  assert.equal(sell.status, 422);
});

test('UD-T12: each hold belongs to its cause; closing the case or deciding another claim releases none but its own', async () => {
  const operations = await operator();
  const trip = await refusedTrip();
  const { id, shipper, carrier } = trip;
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'issue',
        action: 'temporary_storage',
        version: await caseVersion(shipper, id),
      })
    ).status,
    200,
  );
  let instruction = await openInstruction(shipper, id);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'offer',
        instructionId: instruction.id,
        version: instruction.version,
        feasible: true,
        costs: [
          costLine(),
          costLine({ kind: 'handling', quantity: '1', unit: 'lump_sum', unitAmount: '40.00' }),
        ],
      })
    ).status,
    200,
  );
  instruction = await openInstruction(shipper, id);
  const [storage, handling] = instruction.costs!;
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'dispute_cost',
        costIds: [storage!.id],
        reason: 'Rate not agreed',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'raise_claim',
        costIds: [handling!.id],
        reason: 'Damaged by the carrier',
      })
    ).status,
    200,
  );
  let cargo = (await cargoOf(shipper, id)).case!;
  const disputeHold = cargo.holds!.find((item) => item.ownerKind === 'cost_dispute')!;
  const claimHold = cargo.holds!.find((item) => item.ownerKind === 'carrier_claim')!;
  // The claim is open: its hold stays. The dispute's costs have no final liability: its hold stays.
  for (const hold of [disputeHold, claimHold]) {
    const reply = await opsCargo(operations, id, {
      command: 'release_hold',
      holdId: hold.id,
      note: 'x',
    });
    assert.deepEqual([reply.status, reply.body.code], [409, 'hold_owner_open']);
  }
  // The claim is decided (recorded from a settlement), and only its hold is released.
  assert.equal(
    (
      await opsCargo(operations, id, {
        command: 'decide_claim',
        claimId: cargo.claims![0]!.id,
        decision: 'rejected',
        source: 'settlement',
        reference: 'Settlement 12 (fictional)',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await opsCargo(operations, id, {
        command: 'release_hold',
        holdId: claimHold.id,
        note: 'Claim decided',
      })
    ).status,
    200,
  );
  // Closing the case releases nothing.
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'withdraw',
        instructionId: instruction.id,
        version: instruction.version,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await opsCargo(operations, id, {
        command: 'close_case',
        note: 'Cargo resolved outside Trucker',
      })
    ).status,
    200,
  );
  cargo = (await cargoOf(shipper, id)).case!;
  assert.equal(cargo.holds!.find((item) => item.id === disputeHold.id)!.releasedAt, null);
  // The dispute's own decision: the final liability, from the contract, with its reference.
  assert.equal(
    (
      await opsCargo(operations, id, {
        command: 'record_liability',
        costId: storage!.id,
        liability: 'contracting_customer',
        source: 'contract',
        reference: 'Clause 7 (fictional)',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await opsCargo(operations, id, {
        command: 'release_hold',
        holdId: disputeHold.id,
        note: 'Liability recorded',
      })
    ).status,
    200,
  );
  // Nothing recorded here is a payment or a movement of money.
  const costs = await owner.query(
    'SELECT amount FROM trucker.exception_cost WHERE case_id = $1 ORDER BY amount',
    [cargo.id],
  );
  assert.deepEqual(
    costs.rows.map((row) => row.amount),
    ['40.00', '50.00'],
  );
});

test('UD-T13: each side sees only what it may; others see nothing', async () => {
  const trip = await refusedTrip();
  const { id, shipper, carrier } = trip;
  const organiser = await withOrganiser(id);
  // An approved storage with its cost, which the driver is to carry out.
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'issue',
        action: 'temporary_storage',
        version: await caseVersion(shipper, id),
      })
    ).status,
    200,
  );
  let instruction = await openInstruction(shipper, id);
  assert.equal(
    (
      await cargoCommand(carrier, id, {
        command: 'offer',
        instructionId: instruction.id,
        version: instruction.version,
        feasible: true,
        costs: [costLine()],
      })
    ).status,
    200,
  );
  instruction = await openInstruction(shipper, id);
  assert.equal(
    (
      await cargoCommand(shipper, id, {
        command: 'decide',
        instructionId: instruction.id,
        version: instruction.version,
        decision: 'approve',
      })
    ).status,
    200,
  );
  // The driver: the approved instruction, but no authorities, costs, totals, claims or holds.
  const driverView = await call('GET', '/me/driver/assignments', {
    token: (await again(trip.driver)).token,
  });
  const mine = (
    driverView.body.assignments as { bookingId: string; trip?: { cargo: Cargo } }[]
  ).find((item) => item.bookingId === id)!;
  const driverInstruction = mine.trip!.cargo.case!.instructions[0]!;
  assert.deepEqual(
    [
      mine.trip!.cargo.authorities,
      mine.trip!.cargo.case!.claims,
      mine.trip!.cargo.case!.holds,
      driverInstruction.state,
      driverInstruction.costs,
      (driverInstruction as unknown as { approvedTotal: unknown }).approvedTotal,
    ],
    [null, null, null, 'approved', null, null],
  );
  // The carrier does not see the alternate contact.
  assert.equal((await cargoOf(carrier, id)).authorities![0]!.alternateContact ?? null, null);
  assert.ok((await cargoOf(shipper, id)).authorities![0]!.alternateContact);
  // Another carrier and an organiser without authority see nothing.
  const outsider = await verifiedCarrier();
  const stranger = await cargoCommand(outsider, id, {
    command: 'issue',
    action: 'temporary_storage',
    version: 1,
  });
  assert.equal(stranger.status, 404);
  const listed = await call('GET', `/organisations/${organiser.org}/cargo-cases`, {
    token: organiser.person.token,
  });
  assert.deepEqual([listed.status, listed.body.cases], [200, []]);
  const authorities = await call('GET', bookingRoute(outsider.org, id, '/authorities'), {
    token: outsider.person.token,
  });
  assert.equal(authorities.status, 404);
});
