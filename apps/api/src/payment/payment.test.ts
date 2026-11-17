import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { DEVELOPMENT_PAYMENT_TEST_SECRET, loadConfig } from '../config/config.js';
import { FeeLapseJob } from '../fee/fee-lapse.job.js';
import { PAYMENT_PROVIDER } from './provider.js';
import { SIGNATURE_HEADER, sign } from './signature.js';
import type { TestPaymentProvider } from './test-provider.js';
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

// Online payment of Trucker's fee, and receipts (slice 27). Real PostgreSQL, the API connected as
// its restricted role, with the development stand-in for a payment provider, which moves no
// money. Shippers, carriers, vehicles, drivers and bookings are made through the routes of the
// earlier slices. Test accounts and fictional evidence only.

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
    PAYMENT_PROVIDER: 'test',
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
async function booked(carrier: Party, shift = 0, anchor = clock(), settle = false) {
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
  if (settle)
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
interface FeeView {
  status: string;
  dueAt: string | null;
  paidAt: string | null;
  payer?: string;
  amount?: string;
  currency?: string;
  reference?: string;
  paymentHours?: number;
  verifying?: boolean;
  refunds?: { reason: string; amount: string; currency: string; status: string }[];
  checkout?: Checkout | null;
  receipts?: {
    number: string;
    method: string;
    amount: string;
    currency: string;
    issuedAt: string;
  }[];
}
interface Checkout {
  id: string;
  status: string;
  provider: string;
  providerReference: string | null;
  amount: string;
  currency: string;
  expiresAt: string;
  reference: string;
}
interface View extends Booking {
  feePayment: FeeView;
  cancellation?: { party: string; reason: string; at: string } | null;
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
const consistency = async (): Promise<{ code: string; booking: string; record: string }[]> =>
  (
    await owner.query<{ c: { code: string; booking: string; record: string }[] }>(
      'SELECT trucker.booking_consistency() AS c',
    )
  ).rows[0]!.c;
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Trucker's fee
// ---------------------------------------------------------------------------------------------
const feeRow = async (booking: string) =>
  (
    await owner.query<{
      status: string;
      amount: string;
      due_at: Date;
      accepted_at: Date;
      assignment_due_at: Date;
      price_fee: string;
    }>(
      `SELECT f.status, trucker.amount_text(f.amount, f.minor_units) AS amount, f.due_at, b.accepted_at,
              b.assignment_due_at, trucker.amount_text(p.fee_amount, p.minor_units) AS price_fee
       FROM trucker.booking_fee f JOIN trucker.booking b ON b.id = f.booking_id
       JOIN trucker.booking_price p ON p.booking_id = b.id WHERE f.booking_id = $1`,
      [booking],
    )
  ).rows[0]!;
const confirmationOf = async (booking: string) =>
  (
    await owner.query<{ completed_by: string; confirmed_by: string | null; staff: string | null }>(
      `SELECT completed_by, confirmed_by, confirmed_by_staff AS staff FROM trucker.booking_confirmation
       WHERE booking_id = $1`,
      [booking],
    )
  ).rows[0];
const refundsOf = async (booking: string) =>
  (
    await owner.query<{ reason: string; amount: string; status: string }>(
      `SELECT reason, trucker.amount_text(amount, minor_units) AS amount, status FROM trucker.fee_refund
       WHERE booking_id = $1 ORDER BY recorded_at, id`,
      [booking],
    )
  ).rows;
const auditOf = async (booking: string, action: string) =>
  (
    await owner.query<{ org: string; person: string | null; staff: string | null }>(
      `SELECT organisation_id AS org, actor_person_id AS person, actor_staff_id AS staff
       FROM trucker.audit_entry WHERE record_id = $1 AND action = $2 ORDER BY organisation_id`,
      [booking, action],
    )
  ).rows;
/** The lapse job, run as the API runs it: one booking per call until there is none. */
async function lapseRun(): Promise<string[]> {
  const results: string[] = [];
  for (;;) {
    const row = (await app.query<{ r: string }>('SELECT trucker.lapse_overdue_fee() AS r'))
      .rows[0]!;
    results.push(row.r);
    if (row.r === 'none') return results;
  }
}
/** Sessions are short and these tests move the clock by hours: sign in again after a move. */
const statusOf = async (table: string, id: string): Promise<string> =>
  (await owner.query<{ status: string }>(`SELECT status FROM trucker.${table} WHERE id = $1`, [id]))
    .rows[0]!.status;
const freshParty = async (party: Party): Promise<Party> => ({
  person: await newPerson(party.person.phone),
  org: party.org,
});
const until = async (at: string, extraSeconds = 1): Promise<void> =>
  advance(Math.ceil((new Date(at).getTime() - clock().getTime()) / 1000) + extraSeconds);
const cancel = (party: Party, id: string, reason: string, version: number): Promise<Reply> =>
  call('POST', bookingRoute(party.org, id, '/cancel'), {
    token: party.person.token,
    body: { version, reason, note: null },
  });
// ---------------------------------------------------------------------------------------------
// Online payment
// ---------------------------------------------------------------------------------------------
const standIn = (): TestPaymentProvider => nest.get(PAYMENT_PROVIDER) as TestPaymentProvider;
const openCheckout = (party: Party, booking: string, key = `pay-${randomUUID()}`) =>
  call('POST', `/organisations/${party.org}/fee-checkouts`, {
    token: party.person.token,
    key,
    body: { bookingId: booking },
  });
async function opened(party: Party, booking: string): Promise<Checkout> {
  const reply = await openCheckout(party, booking);
  assert.equal(reply.status, 201, reply.text);
  return reply.body.checkout as Checkout;
}
const complete = (reference: string, outcome: 'paid' | 'declined', notify?: boolean) =>
  call('POST', `/payments/test/checkouts/${reference}/complete`, {
    body: { outcome, ...(notify === undefined ? {} : { notify }) },
  });
/** A notification posted as a provider posts it: raw bytes and a signature header. */
async function notify(body: Buffer | string, headers: Record<string, string>): Promise<Reply> {
  const response = await fetch(`${base}/payments/notifications/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, text };
}
const signed = (event: Record<string, unknown>, at = clock()) => {
  const body = JSON.stringify(event);
  return { body, headers: { [SIGNATURE_HEADER]: sign(DEVELOPMENT_PAYMENT_TEST_SECRET, body, at) } };
};
const receiptsOf = async (booking: string) =>
  (
    await owner.query<{ number: string; method: string; amount: string }>(
      `SELECT number, method, trucker.amount_text(amount, minor_units) AS amount FROM trucker.fee_receipt
       WHERE booking_id = $1 ORDER BY number`,
      [booking],
    )
  ).rows;
const notificationsOf = async () => count('payment_notification');
const tick = (): Promise<number> => nest.get(FeeLapseJob).tick();
/**
 * Holds the shipment's lock, starts the work, waits until the database reports that many
 * requests waiting for locks, then lets go: the requests are then certain to have overlapped.
 */
async function whileHeld<T>(shipment: string, waiting: number, work: () => Promise<T>): Promise<T> {
  const holder = await owner.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM trucker.shipment_draft WHERE id = $1 FOR UPDATE', [shipment]);
  const result = work();
  try {
    for (let attempt = 0; ; attempt += 1) {
      const n = (
        await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE NOT l.granted AND a.datname = current_database()`,
        )
      ).rows[0]!.n;
      if (n >= waiting) break;
      if (attempt > 400) throw new Error(`only ${n} of ${waiting} requests waited`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
  return result;
}

test('PAY-1, R-13: only the payer opens a checkout, for the fee as due; asking again resumes the one in progress and never opens a second', async () => {
  const carrier = await verifiedCarrier();
  const { shipper, booking } = await booked(carrier);
  const fee = await feeRow(booking.id);
  const options = await call('GET', '/payments/options');
  assert.deepEqual(options.body, { online: true, provider: 'test' });

  const key = `pay-${randomUUID()}`;
  const first = await openCheckout(shipper, booking.id, key);
  assert.equal(first.status, 201, first.text);
  const checkout = first.body.checkout as Checkout;
  assert.deepEqual(
    [first.body.outcome, checkout.status, checkout.provider, checkout.amount, checkout.currency],
    ['created', 'open', 'test', fee.amount, booking.currency],
  );
  assert.match(checkout.providerReference!, /^tchk_[0-9a-f]{20}$/);
  // Half an hour, or less when the fee's deadline comes sooner.
  assert.equal(
    new Date(checkout.expiresAt).getTime(),
    Math.min(clock().getTime() + 30 * 60_000, fee.due_at.getTime()),
  );
  // The same request again, and another request: the same checkout.
  const again = await openCheckout(shipper, booking.id, key);
  assert.deepEqual(
    [again.status, again.body.outcome, (again.body.checkout as Checkout).id],
    [201, 'already_requested', checkout.id],
  );
  const other = await openCheckout(shipper, booking.id);
  assert.deepEqual(
    [other.body.outcome, (other.body.checkout as Checkout).id],
    ['resumed', checkout.id],
  );
  assert.equal(await count('fee_checkout', 'booking_id = $1', [booking.id]), 1);

  // The payer sees it, to resume it; the carrier neither opens one nor sees it.
  assert.equal((await viewOf(shipper, booking.id)).feePayment.checkout!.id, checkout.id);
  const byCarrier = await openCheckout(carrier, booking.id);
  assert.equal(byCarrier.status, 404, byCarrier.text);
  assert.equal((await viewOf(carrier, booking.id)).feePayment.checkout, undefined);
  const noKey = await call('POST', `/organisations/${shipper.org}/fee-checkouts`, {
    token: shipper.person.token,
    body: { bookingId: booking.id },
  });
  assert.equal(noKey.status, 400, noKey.text);

  // A fee already settled is not paid again.
  const paid = await booked(carrier, 1, clock(), true);
  const refusedPaid = await openCheckout(paid.shipper, paid.booking.id);
  assert.deepEqual([refusedPaid.status, refusedPaid.body.code], [409, 'fee_not_due']);
});

test('PAY-2, R-12, G-8, G-10: a return from the checkout is not proof; the signed notification settles the fee and confirms the booking, once, with a receipt; an unsigned, stale or altered notification counts for nothing', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { affiliation } = await readyDriver(carrier);
  const { shipper, booking } = await booked(carrier);
  await assigned(
    carrier,
    booking.id,
    { truckId: truck.id, trailerId: null, driverId: affiliation },
    'assigned',
  );
  const checkout = await opened(shipper, booking.id);

  // The payer pays on the stand-in's page, but its notice does not arrive: nothing changes.
  const paidPage = await complete(checkout.providerReference!, 'paid', false);
  assert.deepEqual([paidPage.status, paidPage.body.notified], [200, false]);
  const meanwhile = await viewOf(shipper, booking.id);
  assert.deepEqual([meanwhile.status, meanwhile.feePayment.status], ['awaiting_fee', 'due']);
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [booking.id]), 0);

  // Refused: no signature, a wrong one, one too old, and a body changed after signing.
  const notice = standIn().notice(checkout.providerReference!)!;
  const body = notice.body.toString('utf8');
  const before = await notificationsOf();
  assert.equal((await notify(body, {})).status, 400);
  assert.equal(
    (
      await notify(body, {
        [SIGNATURE_HEADER]: sign('another-secret-of-at-least-32-chars!', body, clock()),
      })
    ).status,
    400,
  );
  const stale = new Date(clock().getTime() - 10 * 60_000);
  assert.equal(
    (await notify(body, { [SIGNATURE_HEADER]: sign(DEVELOPMENT_PAYMENT_TEST_SECRET, body, stale) }))
      .status,
    400,
  );
  assert.equal(
    (await notify(body.replace(/"amount":"[^"]+"/, '"amount":"0.01"'), notice.headers)).status,
    400,
  );
  assert.equal(await notificationsOf(), before);
  assert.equal((await feeRow(booking.id)).status, 'due');

  // The signed notice: paid, confirmed and a receipt, in one transaction.
  const applied = await notify(body, notice.headers);
  assert.equal(applied.status, 200, applied.text);
  assert.deepEqual([applied.body.outcome, applied.body.result], ['recorded', 'settled']);
  assert.equal((await feeRow(booking.id)).status, 'paid');
  assert.deepEqual(await confirmationOf(booking.id), {
    completed_by: 'online_payment',
    confirmed_by: null,
    staff: null,
  });
  const receipts = await receiptsOf(booking.id);
  assert.equal(receipts.length, 1);
  assert.match(receipts[0]!.number, /^TR-[0-9]{8}$/);
  assert.deepEqual([receipts[0]!.method, receipts[0]!.amount], ['online', checkout.amount]);
  const forShipper = (await viewOf(shipper, booking.id)).feePayment;
  assert.deepEqual(
    [forShipper.status, forShipper.receipts!.map((item) => item.number), forShipper.checkout],
    ['paid', [receipts[0]!.number], null],
  );
  const forCarrier = await viewOf(carrier, booking.id);
  assert.deepEqual([forCarrier.status, forCarrier.feePayment.receipts], ['confirmed', undefined]);
  assert.deepEqual(
    (await auditOf(booking.id, 'booking.fee_paid')).map((item) => [
      item.org,
      item.person,
      item.staff,
    ]),
    [shipper.org, carrier.org].sort().map((org) => [org, null, null]),
  );

  // The same notice again, and the provider's answer to a status check: applied once.
  const repeated = await notify(body, notice.headers);
  assert.deepEqual(
    [repeated.status, repeated.body.outcome, repeated.body.result],
    [200, 'repeated', 'settled'],
  );
  const transaction = JSON.parse(body).transaction as string;
  const checked = (
    await app.query<{ status: string; detail: { result: string } }>(
      'SELECT status, detail FROM trucker.payment_report($1, $2, $3, $4)',
      [
        'test',
        `status:${transaction}`,
        'status_check',
        JSON.stringify({
          status: 'paid',
          providerReference: checkout.providerReference,
          transactionId: transaction,
          amount: checkout.amount,
          currency: checkout.currency,
          paidAt: clock().toISOString(),
        }),
      ],
    )
  ).rows[0]!;
  assert.deepEqual([checked.status, checked.detail.result], ['recorded', 'already_applied']);
  assert.equal(await count('fee_payment', 'booking_id = $1', [booking.id]), 1);
  assert.equal((await receiptsOf(booking.id)).length, 1);
  assert.deepEqual(await consistency(), []);
  for (const statement of [
    `UPDATE trucker.fee_receipt SET amount = amount + 1 WHERE booking_id = '${booking.id}'`,
    `DELETE FROM trucker.payment_notification`,
    `UPDATE trucker.fee_checkout SET status = 'open', row_version = row_version + 1 WHERE id = '${checkout.id}'`,
  ])
    await refused(() => owner.query(statement), /not changed|only moves|never/);
});

test('PAY-3, G-10: a signed notification whose amount or currency differs from the checkout, or that names no checkout, settles nothing and is shown to staff; the payer can start again', async () => {
  const carrier = await verifiedCarrier();
  const { shipper, booking } = await booked(carrier);
  const checkout = await opened(shipper, booking.id);
  const event = (over: Record<string, unknown>) =>
    signed({
      id: `tevt_${randomBytes(8).toString('hex')}`,
      type: 'checkout.paid',
      checkout: checkout.providerReference,
      transaction: `ttx_${randomBytes(8).toString('hex')}`,
      amount: checkout.amount,
      currency: checkout.currency,
      paidAt: clock().toISOString(),
      ...over,
    });
  const short = event({ amount: '1.00' });
  const mismatch = await notify(short.body, short.headers);
  assert.deepEqual([mismatch.status, mismatch.body.result], [200, 'mismatch']);
  const stranger = event({ checkout: 'tchk_00000000000000000000' });
  const unknown = await notify(stranger.body, stranger.headers);
  assert.deepEqual([unknown.status, unknown.body.result], [200, 'unknown_checkout']);
  assert.equal((await feeRow(booking.id)).status, 'due');
  assert.equal(await count('fee_payment', 'booking_id = $1', [booking.id]), 0);

  const overview = await call('GET', '/staff/fee-payments', {
    token: (await administrator()).token,
  });
  const review = (
    overview.body.fees as { onlineReview: { result: string; reference: string | null }[] }
  ).onlineReview;
  assert.deepEqual(
    review
      .slice(0, 2)
      .map((item) => item.result)
      .sort(),
    ['mismatch', 'unknown_checkout'],
  );
  assert.ok(
    review.some((item) => item.result === 'mismatch' && item.reference === checkout.reference),
  );

  // The mismatched checkout is closed; a new one can be opened.
  const fresh = await openCheckout(shipper, booking.id);
  assert.deepEqual(
    [fresh.body.outcome, (fresh.body.checkout as Checkout).id !== checkout.id],
    ['created', true],
  );
});

test('PAY-4, R-15, G-11: an open checkout holds the booking past the deadline until word can arrive; a lost notice is found by asking the provider; with no payment the booking lapses; money taken after a cancellation is returned', async () => {
  let carrier = await verifiedCarrier();
  // Paid in time, notice lost: found by the status check, settled although the deadline passed.
  const kept = await booked(carrier);
  const dueAt = (await feeRow(kept.booking.id)).due_at;
  await advance(Math.floor((dueAt.getTime() - clock().getTime()) / 1000) - 10 * 60);
  carrier = await freshParty(carrier);
  const keptShipper = await freshParty(kept.shipper);
  const late = await booked(carrier, 1);
  const keptCheckout = await opened(keptShipper, kept.booking.id);
  assert.equal(new Date(keptCheckout.expiresAt).getTime(), dueAt.getTime());
  await advance(5 * 60);
  assert.equal((await complete(keptCheckout.providerReference!, 'paid', false)).status, 200);
  await advance(6 * 60);
  // Past the deadline, inside the grace: neither lapsed nor shown overdue.
  await lapseRun();
  assert.equal((await feeRow(kept.booking.id)).status, 'due');
  assert.equal((await viewOf(keptShipper, kept.booking.id)).feePayment.status, 'due');
  // The job asks the provider first, and the payment it took in time settles the fee.
  await tick();
  assert.equal((await feeRow(kept.booking.id)).status, 'paid');
  assert.deepEqual(
    (await receiptsOf(kept.booking.id)).map((item) => item.method),
    ['online'],
  );

  // Unpaid: once the checkout and the grace are over, the provider says expired and it lapses.
  const lateShipper = await freshParty(late.shipper);
  const lateCheckout = await opened(lateShipper, late.booking.id);
  await until((await feeRow(late.booking.id)).due_at.toISOString(), 16 * 60);
  await tick();
  assert.deepEqual(
    [(await feeRow(late.booking.id)).status, await statusOf('fee_checkout', lateCheckout.id)],
    ['lapsed', 'expired'],
  );
  const tooLate = await complete(lateCheckout.providerReference!, 'paid');
  assert.deepEqual([tooLate.status, tooLate.body.code], [409, 'checkout_not_open']);

  // Cancelled while a checkout was open, then paid on it: the money is returned.
  carrier = await freshParty(carrier);
  const dropped = await booked(carrier, 2);
  const droppedCheckout = await opened(dropped.shipper, dropped.booking.id);
  const cancelled = await cancel(dropped.shipper, dropped.booking.id, 'dates_changed', 0);
  assert.equal(cancelled.status, 200, cancelled.text);
  const paidAfter = await complete(droppedCheckout.providerReference!, 'paid');
  assert.deepEqual([paidAfter.status, paidAfter.body.result], [200, 'refund_due']);
  assert.deepEqual(
    (await refundsOf(dropped.booking.id)).map((item) => [item.reason, item.amount]),
    [['booking_ended', droppedCheckout.amount]],
  );
  assert.deepEqual(await receiptsOf(dropped.booking.id), []);
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [dropped.booking.id]), 0);
  assert.deepEqual(await consistency(), []);
});

test('PAY-5: a transfer verified by two administrators gets a receipt too; numbers are unique; only the payer is shown them', async () => {
  const carrier = await verifiedCarrier();
  const one = await booked(carrier, 0, clock(), true);
  const two = await booked(carrier, 1, clock(), true);
  const a = await receiptsOf(one.booking.id);
  const b = await receiptsOf(two.booking.id);
  assert.deepEqual(
    [a.length, b.length, a[0]!.method, b[0]!.method],
    [1, 1, 'bank_transfer', 'bank_transfer'],
  );
  assert.notEqual(a[0]!.number, b[0]!.number);
  assert.equal(
    (await viewOf(one.shipper, one.booking.id)).feePayment.receipts![0]!.number,
    a[0]!.number,
  );
  const listed = await call('GET', `/organisations/${carrier.org}/bookings`, {
    token: carrier.person.token,
  });
  assert.ok(!listed.text.includes(a[0]!.number) && !listed.text.includes(b[0]!.number));
});

test('PAY-6, R-13: the same notice delivered twice at once, or a notice and a status check for one payment, apply it once', async () => {
  const carrier = await verifiedCarrier();
  const { shipper, booking } = await booked(carrier);
  const checkout = await opened(shipper, booking.id);
  assert.equal((await complete(checkout.providerReference!, 'paid', false)).status, 200);
  const notice = standIn().notice(checkout.providerReference!)!;
  const replies = await whileHeld(booking.shipmentId, 2, () =>
    Promise.all([notify(notice.body, notice.headers), notify(notice.body, notice.headers)]),
  );
  assert.deepEqual(replies.map((reply) => reply.body.outcome).sort(), ['recorded', 'repeated']);

  const other = await booked(carrier, 1);
  const otherCheckout = await opened(other.shipper, other.booking.id);
  assert.equal((await complete(otherCheckout.providerReference!, 'paid', false)).status, 200);
  const otherNotice = standIn().notice(otherCheckout.providerReference!)!;
  const transaction = JSON.parse(otherNotice.body.toString('utf8')).transaction as string;
  const [delivered, asked] = await whileHeld(other.booking.shipmentId, 2, () =>
    Promise.all([
      notify(otherNotice.body, otherNotice.headers),
      app.query<{ status: string; detail: { result: string } }>(
        'SELECT status, detail FROM trucker.payment_report($1, $2, $3, $4)',
        [
          'test',
          `status:${transaction}`,
          'status_check',
          JSON.stringify({
            status: 'paid',
            providerReference: otherCheckout.providerReference,
            transactionId: transaction,
            amount: otherCheckout.amount,
            currency: otherCheckout.currency,
            paidAt: clock().toISOString(),
          }),
        ],
      ),
    ]),
  );
  assert.deepEqual([delivered.body.result as string, asked.rows[0]!.detail.result].sort(), [
    'already_applied',
    'settled',
  ]);
  assert.equal(
    await count('fee_payment', 'booking_id IN ($1, $2)', [booking.id, other.booking.id]),
    2,
  );
  assert.equal(
    await count('fee_receipt', 'booking_id IN ($1, $2)', [booking.id, other.booking.id]),
    2,
  );
  assert.deepEqual(await consistency(), []);
});

// ---------------------------------------------------------------------------------------------
// Review of slice 27: what is and is not shown about double charges and late notifications
// ---------------------------------------------------------------------------------------------
test("PAY-7, R-13: simultaneous requests, and a retry after the provider's answer was lost, open one provider checkout; only a refusal lets a new one be opened", async () => {
  const carrier = await verifiedCarrier();
  const { shipper, booking } = await booked(carrier);
  const reference = (await viewOf(shipper, booking.id)).feePayment.reference!;

  // Two requests at once, each with its own retry key.
  const both = await whileHeld(booking.shipmentId, 2, () =>
    Promise.all([openCheckout(shipper, booking.id), openCheckout(shipper, booking.id)]),
  );
  assert.deepEqual(
    both.map((reply) => reply.status),
    [201, 201],
  );
  const ids = both.map((reply) => (reply.body.checkout as Checkout).id);
  assert.equal(ids[0], ids[1]);
  assert.deepEqual(both.map((reply) => reply.body.outcome).sort(), ['created', 'resumed']);
  assert.equal(standIn().checkoutsFor(reference), 1);

  // The provider opens a checkout but its answer is lost: the payer is told nothing was
  // started for certain, and asking again reaches the same provider checkout.
  const second = await booked(carrier, 1);
  const secondReference = (await viewOf(second.shipper, second.booking.id)).feePayment.reference!;
  standIn().trouble = 'lose-next-answer';
  const lost = await openCheckout(second.shipper, second.booking.id);
  assert.deepEqual([lost.status, lost.body.code], [502, 'payment_provider_unavailable']);
  const retried = await openCheckout(second.shipper, second.booking.id);
  assert.equal(retried.status, 201, retried.text);
  assert.equal((retried.body.checkout as Checkout).status, 'open');
  assert.equal(standIn().checkoutsFor(secondReference), 1);
  assert.equal(await count('fee_checkout', 'booking_id = $1', [second.booking.id]), 1);

  // A refusal is an answer: that checkout failed, and the next request opens a new one.
  const third = await booked(carrier, 2);
  standIn().trouble = 'refuse-next';
  const refusedOpen = await openCheckout(third.shipper, third.booking.id);
  assert.equal(refusedOpen.status, 502, refusedOpen.text);
  const afterRefusal = await openCheckout(third.shipper, third.booking.id);
  assert.deepEqual([afterRefusal.status, afterRefusal.body.outcome], [201, 'created']);
  assert.equal(
    await count('fee_checkout', "booking_id = $1 AND status = 'failed'", [third.booking.id]),
    1,
  );
});

test('PAY-8: money a provider takes on a checkout Trucker had already replaced is recorded; the second payment for the fee is returned, never kept', async () => {
  const carrier = await verifiedCarrier();
  const made = await booked(carrier);
  const first = await opened(made.shipper, made.booking.id);
  // The first checkout's time runs out; the payer starts again.
  await advance(31 * 60);
  const shipper = await freshParty(made.shipper);
  const replacement = await opened(shipper, made.booking.id);
  assert.notEqual(replacement.id, first.id);
  assert.equal(await statusOf('fee_checkout', first.id), 'expired');
  // A provider that took money on the first one after all (the stand-in itself refuses to):
  const late = signed({
    id: `tevt_${randomBytes(8).toString('hex')}`,
    type: 'checkout.paid',
    checkout: first.providerReference,
    transaction: `ttx_${randomBytes(8).toString('hex')}`,
    amount: first.amount,
    currency: first.currency,
    paidAt: clock().toISOString(),
  });
  const onFirst = await notify(late.body, late.headers);
  assert.deepEqual([onFirst.status, onFirst.body.result], [200, 'settled']);
  // And the payer also pays on the replacement: both payments are recorded, one is returned.
  const onSecond = await complete(replacement.providerReference!, 'paid');
  assert.deepEqual([onSecond.status, onSecond.body.result], [200, 'refund_due']);
  assert.deepEqual(
    (await refundsOf(made.booking.id)).map((item) => [item.reason, item.amount]),
    [['duplicate_payment', replacement.amount]],
  );
  assert.equal(await count('fee_payment', 'booking_id = $1', [made.booking.id]), 2);
  assert.equal((await receiptsOf(made.booking.id)).length, 1);
});

test("PAY-9, R-15: with the provider unreachable, nothing settles on the payer's word; once the grace period ends the booking lapses and other bookings still lapse; the notification that arrives later is returned; a captured notice replayed after the signature window is refused", async () => {
  const carrier = await verifiedCarrier();
  const made = await booked(carrier);
  const other = await booked(carrier, 1);
  const dueAt = (await feeRow(made.booking.id)).due_at;
  await advance(Math.floor((dueAt.getTime() - clock().getTime()) / 1000) - 10 * 60);
  const shipper = await freshParty(made.shipper);
  const checkout = await opened(shipper, made.booking.id);
  // Paid in time on the provider's page; its notice does not arrive, and then the provider
  // cannot be reached at all.
  assert.equal((await complete(checkout.providerReference!, 'paid', false)).status, 200);
  const notice = standIn().notice(checkout.providerReference!)!;
  standIn().trouble = 'outage';
  try {
    // Inside the grace period: held.
    await advance(10 * 60 + 60);
    await tick();
    assert.equal((await feeRow(made.booking.id)).status, 'due');
    // After it, with the provider still silent: the job records the lapse, and the other
    // booking's lapse is not stopped by the outage.
    await advance(15 * 60);
    await tick();
    assert.deepEqual(
      [(await feeRow(made.booking.id)).status, (await feeRow(other.booking.id)).status],
      ['lapsed', 'lapsed'],
    );
  } finally {
    standIn().trouble = 'none';
  }
  // The notice, sent again by the provider with a fresh signature, now only records money to
  // return: a delayed notification does not revive a lapsed booking.
  const resent = notice.body;
  const late = await notify(resent, {
    [SIGNATURE_HEADER]: sign(DEVELOPMENT_PAYMENT_TEST_SECRET, resent, clock()),
  });
  assert.deepEqual([late.status, late.body.result], [200, 'refund_due']);
  assert.deepEqual(
    (await refundsOf(made.booking.id)).map((item) => item.reason),
    ['booking_ended'],
  );
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [made.booking.id]), 0);
  // The notice exactly as it was first signed, replayed now: outside the window, refused.
  const replayed = await notify(notice.body, notice.headers);
  assert.equal(replayed.status, 400, replayed.text);
});
