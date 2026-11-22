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
const waitFor = (party: Party, id: string): Promise<Reply> =>
  call('POST', bookingRoute(party.org, id, '/wait'), { token: party.person.token });
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
const estimateBy = (driver: Person, id: string, arrivalAt: string): Promise<Reply> =>
  call('POST', `/me/driver/assignments/${id}/estimate`, {
    token: driver.token,
    body: { arrivalAt },
  });
const estimateAs = (party: Party, id: string, arrivalAt: string): Promise<Reply> =>
  call('POST', bookingRoute(party.org, id, '/estimate'), {
    token: party.person.token,
    body: { arrivalAt },
  });
const episodesOf = async (booking: string) =>
  (
    await owner.query<{ resource_kind: string; closed_at: Date | null }>(
      'SELECT resource_kind, closed_at FROM trucker.occupancy_episode WHERE booking_id = $1 ORDER BY resource_kind',
      [booking],
    )
  ).rows;
const iso = (date: Date): string => date.toISOString();
const ORDER = [
  'departed_for_pickup',
  'arrived_at_pickup',
  'loading_started',
  'loaded_departed',
  'arrived_at_delivery',
  'unloading_started',
];

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

test('DSP-1, DSP-4: only an administrator of the carrier dispatches; dispatch opens one episode for each resource and creates the trip at once; the same request again returns the same trip', async () => {
  let carrier = await verifiedCarrier();
  const made = await ready(carrier);
  const id = made.booking.id;
  // Before the window: refused, with the earliest time.
  const early = await dispatch(carrier, id);
  assert.deepEqual(
    [early.status, early.body.code, refusalOf(early)?.reason],
    [409, 'dispatch_refused', 'too_early'],
  );
  const view = await tripViewOf(carrier, id);
  assert.deepEqual([view.dispatch.ready, view.trip], [true, null]);
  assert.equal(
    new Date(view.dispatchFrom).getTime(),
    new Date(made.booking.plannedReservation.startAt).getTime() - D.dispatch_lead_hours * 3_600_000,
  );
  await untilDispatchable(carrier, id);
  carrier = await freshParty(carrier);
  const shipper = await freshParty(made.shipper);
  const outsider = await verifiedCarrier();
  for (const party of [shipper, outsider]) {
    const refused = await dispatch(party, id);
    assert.deepEqual([refused.status, refused.body.code], [404, 'not_found'], refused.text);
  }
  const noKey = await call('POST', bookingRoute(carrier.org, id, '/dispatch'), {
    token: carrier.person.token,
  });
  assert.deepEqual([noKey.status, noKey.body.code], [400, 'retry_key_required']);
  assert.equal(await count('trip', 'booking_id = $1', [id]), 0);

  const retry = key();
  const first = await dispatch(carrier, id, retry);
  assert.deepEqual([first.status, first.body.outcome], [200, 'dispatched'], first.text);
  const trip = first.body.trip as Trip;
  assert.deepEqual([trip.late, trip.next, trip.milestones], [false, 'departed_for_pickup', []]);
  assert.deepEqual(
    (await episodesOf(id)).map((item) => [item.resource_kind, item.closed_at]),
    [
      ['driver', null],
      ['truck', null],
    ],
  );
  const again = await dispatch(carrier, id, retry);
  assert.deepEqual(
    [again.status, again.body.outcome, (again.body.trip as Trip).id],
    [200, 'already_dispatched', trip.id],
  );
  const other = await dispatch(carrier, id);
  assert.deepEqual([other.status, other.body.code], [409, 'booking_dispatched']);
  assert.equal(await count('trip', 'booking_id = $1', [id]), 1);
  assert.equal(await count('occupancy_episode', 'booking_id = $1', [id]), 2);
  assert.equal(
    await count('audit_entry', "record_id = $1 AND action = 'booking.dispatched'", [id]),
    2,
  );
  const after = await tripViewOf(carrier, id);
  assert.deepEqual([after.dispatch.ready, after.trip?.id], [false, trip.id]);
  // Nothing is left to cancel (slice 16).
  const cancelled = await call('POST', bookingRoute(carrier.org, id, '/cancel'), {
    token: carrier.person.token,
    body: { version: after.assignmentVersion, reason: 'other', note: 'Too late' },
  });
  assert.deepEqual([cancelled.status, cancelled.body.code], [409, 'booking_dispatched']);
  assert.deepEqual(await consistency(), []);
});

test('DSP-2, DSP-3: each precondition, failing on its own, refuses dispatch with its name and changes nothing', async () => {
  let carrier = await verifiedCarrier();
  const unit = await tractor(carrier);
  const trailer = await semiTrailer(carrier);
  // Not confirmed: a truck alone.
  const partial = await booked(carrier);
  const truck = await rigid(carrier);
  assert.equal(
    (await assign(carrier, partial.booking.id, { version: 0, truckId: truck.id })).status,
    200,
  );
  // Confirmed, the driver has not acknowledged.
  const second = await rigid(carrier);
  const quiet = await readyDriver(carrier);
  const unacknowledged = await booked(carrier, 1);
  await assigned(
    carrier,
    unacknowledged.booking.id,
    { truckId: second.id, driverId: quiet.affiliation },
    'confirmed',
  );
  // Confirmed and acknowledged, then a substitution is proposed.
  const proposing = await ready(carrier, 2);
  await assigned(
    carrier,
    proposing.booking.id,
    { truckId: unit.id, trailerId: trailer.id },
    'proposed',
  );
  // Confirmed and acknowledged; the vehicle is suspended a minute before dispatch.
  const suspended = await ready(carrier, 3);
  // Confirmed and acknowledged; the shipper loses its capability.
  const shipperless = await ready(carrier, 4);
  // Confirmed and acknowledged; cancelled.
  const cancelled = await ready(carrier, 5);
  const cancelledView = await viewOf(cancelled.shipper, cancelled.booking.id);
  assert.equal(
    (
      await call('POST', bookingRoute(cancelled.shipper.org, cancelled.booking.id, '/cancel'), {
        token: cancelled.shipper.person.token,
        body: { version: cancelledView.assignmentVersion, reason: 'dates_changed', note: null },
      })
    ).status,
    200,
  );
  await untilDispatchable(carrier, shipperless.booking.id, 3600 * 6);
  carrier = await freshParty(carrier);
  assert.equal((await suspend('vehicle', suspended.truck.id, true)).status, 200);
  await advance(60);
  assert.equal((await revokeCapability(shipperless.shipper.org, 'ship')).status, 200);
  carrier = await freshParty(carrier);
  const cases: [string, string, Record<string, unknown>][] = [
    [partial.booking.id, 'not_confirmed', {}],
    [unacknowledged.booking.id, 'acknowledgement_missing', {}],
    [proposing.booking.id, 'substitution_open', {}],
    [suspended.booking.id, 'needs_reassignment', { role: 'truck' }],
    [shipperless.booking.id, 'capability_missing', { party: 'shipper' }],
    [cancelled.booking.id, 'booking_cancelled', {}],
  ];
  for (const [id, reason, extra] of cases) {
    const reply = await dispatch(carrier, id);
    assert.deepEqual(
      [reply.status, reply.body.code, refusalOf(reply)?.reason],
      [409, 'dispatch_refused', reason],
      `${reason}: ${reply.text}`,
    );
    for (const [field, value] of Object.entries(extra))
      assert.equal(refusalOf(reply)?.[field], value, reason);
    assert.equal(await count('trip', 'booking_id = $1', [id]), 0);
    assert.equal(await count('occupancy_episode', 'booking_id = $1', [id]), 0);
  }
});

test('DSP-5: a dispatch and a cancellation at the same moment end with exactly one of them', async () => {
  let carrier = await verifiedCarrier();
  const rounds = [];
  for (let round = 0; round < 3; round += 1) rounds.push(await ready(carrier, round * 30));
  for (const made of rounds) {
    await untilDispatchable(carrier, made.booking.id);
    carrier = await freshParty(carrier);
    const shipper = await freshParty(made.shipper);
    const version = (await viewOf(shipper, made.booking.id)).assignmentVersion;
    const release = await (async () => {
      const client = await owner.connect();
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM trucker.shipment_draft WHERE id = $1 FOR UPDATE', [
        made.shipment.id,
      ]);
      return async () => {
        await client.query('COMMIT');
        client.release();
      };
    })();
    const both = Promise.all([
      dispatch(carrier, made.booking.id),
      call('POST', bookingRoute(shipper.org, made.booking.id, '/cancel'), {
        token: shipper.person.token,
        body: { version, reason: 'dates_changed', note: null },
      }),
    ]);
    for (let attempt = 0; ; attempt += 1) {
      const n = (
        await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE NOT l.granted AND a.datname = current_database()`,
        )
      ).rows[0]!.n;
      if (n >= 2) break;
      if (attempt > 400) throw new Error('the requests did not wait');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await release();
    const [dispatched, cancelledReply] = await both;
    const trips = await count('trip', 'booking_id = $1', [made.booking.id]);
    const cancellations = await count('booking_cancellation', 'booking_id = $1', [made.booking.id]);
    assert.equal(trips + cancellations, 1, `${dispatched.text} / ${cancelledReply.text}`);
    if (trips === 1) {
      assert.equal(dispatched.status, 200);
      assert.deepEqual(
        [cancelledReply.status, cancelledReply.body.code],
        [409, 'booking_dispatched'],
      );
    } else {
      assert.equal(cancelledReply.status, 200);
      assert.deepEqual(
        [dispatched.body.code, refusalOf(dispatched)?.reason],
        ['dispatch_refused', 'booking_cancelled'],
      );
      assert.equal(await count('occupancy_episode', 'booking_id = $1', [made.booking.id]), 0);
    }
  }
  assert.deepEqual(await consistency(), []);
});

test('DSP-6: two bookings sharing a resource dispatched at the same moment: at most one succeeds; a resource still occupied by an overrunning trip blocks the next dispatch', async () => {
  let carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { driver, affiliation } = await readyDriver(carrier);
  const other = await readyDriver(carrier);
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
  const spareTruck = await rigid(carrier);
  const spare = await readyDriver(carrier);
  const last = await readyDriver(carrier);
  const confirmWith = async (vehicle: Vehicle, shift: number, aff: string, person: Person) => {
    const made = await booked(carrier, shift);
    const view = await assigned(
      carrier,
      made.booking.id,
      { truckId: vehicle.id, driverId: aff },
      'confirmed',
    );
    assert.equal((await acknowledge(person, made.booking.id, view.assignmentVersion)).status, 200);
    return made;
  };
  // Back to back: the second starts where the first ends (24 hours later).
  const first = await confirm(0, affiliation, driver);
  const second = await confirm(24, other.affiliation, other.driver);
  const third = await confirmWith(spareTruck, 1, spare.affiliation, spare.driver);
  const fourth = await confirmWith(spareTruck, 25, last.affiliation, last.driver);
  await untilDispatchable(carrier, second.booking.id);
  carrier = await freshParty(carrier);
  const [one, two] = await Promise.all([
    dispatch(carrier, first.booking.id),
    dispatch(carrier, second.booking.id),
  ]);
  const won = [one, two].filter((reply) => reply.status === 200);
  const lost = [one, two].filter((reply) => reply.status !== 200);
  assert.equal(won.length, 1, `${one.text} / ${two.text}`);
  assert.deepEqual(
    [lost[0]!.body.code, refusalOf(lost[0]!)?.reason],
    ['dispatch_refused', 'resource_occupied'],
  );
  assert.equal(
    await count('occupancy_episode', 'vehicle_id = $1 AND closed_at IS NULL', [truck.id]),
    1,
  );
  // A truck still occupied past the planned end of its trip blocks the next dispatch.
  carrier = await freshParty(carrier);
  assert.equal((await dispatch(carrier, third.booking.id)).status, 200);
  const end = new Date(third.booking.plannedReservation.endAt);
  await advance(Math.ceil((end.getTime() - clock().getTime()) / 1000) + 60);
  carrier = await freshParty(carrier);
  const blocked = await dispatch(carrier, fourth.booking.id);
  assert.deepEqual(
    [blocked.body.code, refusalOf(blocked)?.reason],
    ['dispatch_refused', 'resource_overrunning'],
  );
  assert.deepEqual(await consistency(), []);
});

test('DSP-7, TRP-7: after dispatch nothing changes the assigned set, the acknowledgement or a wait decision; nothing closes an episode', async () => {
  let carrier = await verifiedCarrier();
  const made = await ready(carrier);
  const spare = await rigid(carrier);
  await untilDispatchable(carrier, made.booking.id);
  carrier = await freshParty(carrier);
  const driver = await again(made.driver);
  assert.equal((await dispatch(carrier, made.booking.id)).status, 200);
  const changed = await reassign(carrier, made.booking.id, { truckId: spare.id });
  assert.deepEqual([changed.status, changed.body.code], [409, 'booking_dispatched']);
  const version = (await viewOf(carrier, made.booking.id)).assignmentVersion;
  const acknowledged = await acknowledge(driver, made.booking.id, version);
  assert.deepEqual([acknowledged.status, acknowledged.body.code], [409, 'booking_dispatched']);
  const shipper = await freshParty(made.shipper);
  const waited = await waitFor(shipper, made.booking.id);
  assert.deepEqual([waited.status, waited.body.code], [409, 'booking_dispatched']);
  await refused(
    () =>
      owner.query(
        `UPDATE trucker.booking_assignment SET status = 'ended', ended_at = now(), ended_set_no = set_no + 1
         WHERE booking_id = $1 AND role = 'truck'`,
        [made.booking.id],
      ),
    /dispatched/,
  );
  await refused(
    () => owner.query('DELETE FROM trucker.trip WHERE booking_id = $1', [made.booking.id]),
    /never removed/,
  );
  // Every milestone, then: the episodes stay open (release is slice 18).
  let trip = (await tripViewOf(carrier, made.booking.id)).trip!;
  for (const milestone of ORDER) {
    const reply = await byDriver(driver, made.booking.id, trip.version, milestone);
    assert.equal(reply.status, 200, reply.text);
    trip = reply.body.trip as Trip;
  }
  assert.equal(trip.next, null);
  assert.ok((await episodesOf(made.booking.id)).every((item) => item.closed_at === null));
  assert.deepEqual(await consistency(), []);
});

test('TRP-1, TRP-2: only the assigned driver, while affiliated, records milestones, and only the next one in order; a skipped or repeated step is refused with the current state', async () => {
  let carrier = await verifiedCarrier();
  const made = await ready(carrier);
  await untilDispatchable(carrier, made.booking.id);
  carrier = await freshParty(carrier);
  const driver = await again(made.driver);
  const before = await byDriver(driver, made.booking.id, 1, 'departed_for_pickup');
  assert.deepEqual([before.status, before.body.code], [409, 'not_dispatched']);
  assert.equal((await dispatch(carrier, made.booking.id)).status, 200);
  // Someone else, the carrier's administrator as a driver, and the shipper: as missing.
  const stranger = await newPerson();
  const shipper = await freshParty(made.shipper);
  for (const person of [stranger, carrier.person, shipper.person]) {
    const reply = await byDriver(person, made.booking.id, 1, 'departed_for_pickup');
    assert.deepEqual([reply.status, reply.body.code], [404, 'not_found']);
  }
  const first = await byDriver(driver, made.booking.id, 1, 'departed_for_pickup');
  assert.equal(first.status, 200, first.text);
  const trip = first.body.trip as Trip;
  assert.deepEqual(
    [
      trip.version,
      trip.next,
      trip.milestones.map((m) => [m.milestone, m.basis, m.enteredBy, m.statedAt === m.recordedAt]),
    ],
    [2, 'arrived_at_pickup', [['departed_for_pickup', 'observed', null, true]]],
  );
  const repeated = await byDriver(driver, made.booking.id, 2, 'departed_for_pickup');
  assert.deepEqual([repeated.status, repeated.body.code], [409, 'milestone_out_of_sequence']);
  assert.equal((repeated.body.details as { trip: Trip }).trip.next, 'arrived_at_pickup');
  const skipped = await byDriver(driver, made.booking.id, 2, 'loading_started');
  assert.deepEqual([skipped.status, skipped.body.code], [409, 'milestone_out_of_sequence']);
  const stale = await byDriver(driver, made.booking.id, 1, 'arrived_at_pickup');
  assert.deepEqual([stale.status, stale.body.code], [409, 'trip_changed']);
  assert.equal(await count('trip_milestone', 'trip_id = $1', [trip.id]), 1);
  // A driver who has left the carrier records nothing more.
  const seen = (await fleetOf(carrier.person, carrier.org)).drivers.find(
    (item) => item.id === made.affiliation,
  )!;
  const ended = await call('POST', fleet(carrier.org, `/drivers/${made.affiliation}/end`), {
    token: carrier.person.token,
    key: key(),
    body: { version: seen.version },
  });
  assert.equal(ended.status, 200, ended.text);
  const left = await byDriver(driver, made.booking.id, 2, 'arrived_at_pickup');
  assert.deepEqual([left.status, left.body.code], [404, 'not_found']);
  await refused(() => owner.query("UPDATE trucker.trip_milestone SET note = 'x'"), /never changed/);
});

test("TRP-3, TRP-4, TRP-5: the carrier records on the driver's behalf with a reason and a reported time; a future time is refused, an earlier one is kept and marked for review; the shipper sees milestones and the latest estimate, not the notes", async () => {
  let carrier = await verifiedCarrier();
  const made = await ready(carrier);
  await untilDispatchable(carrier, made.booking.id);
  carrier = await freshParty(carrier);
  let driver = await again(made.driver);
  assert.equal((await dispatch(carrier, made.booking.id)).status, 200);
  const departed = await byDriver(driver, made.booking.id, 1, 'departed_for_pickup');
  assert.equal(departed.status, 200);
  await advance(30 * 60);
  carrier = await freshParty(carrier);
  driver = await again(driver);
  const base = {
    version: 2,
    milestone: 'arrived_at_pickup',
    statedAt: iso(new Date(clock().getTime() - 5 * 60_000)),
  };
  for (const [body, field] of [
    [{ ...base, reason: 'other', note: null }, 'note'],
    [
      { ...base, reason: 'no_signal', statedAt: iso(new Date(clock().getTime() + 60_000)) },
      'statedAt',
    ],
  ] as [Record<string, unknown>, string][]) {
    const reply = await onBehalf(carrier, made.booking.id, body);
    assert.deepEqual(
      [reply.status, reply.body.code, refusalOf(reply)?.fields],
      [422, 'validation_failed', [field]],
      reply.text,
    );
  }
  const shipper = await freshParty(made.shipper);
  const notTheirs = await onBehalf(shipper, made.booking.id, { ...base, reason: 'no_signal' });
  assert.equal(notTheirs.status, 404);
  const arrived = await onBehalf(carrier, made.booking.id, {
    ...base,
    reason: 'no_signal',
    note: 'Called in by phone',
  });
  assert.equal(arrived.status, 200, arrived.text);
  // Earlier than the milestone before it: kept, and marked for review.
  const early = await onBehalf(carrier, made.booking.id, {
    version: 3,
    milestone: 'loading_started',
    statedAt: iso(new Date(clock().getTime() - 60 * 60_000)),
    reason: 'correction',
  });
  assert.equal(early.status, 200, early.text);
  const forCarrier = (early.body.trip as Trip).milestones;
  assert.deepEqual(
    forCarrier.map((m) => [m.milestone, m.basis, m.reason, m.needsReview, m.enteredBy !== null]),
    [
      ['departed_for_pickup', 'observed', null, false, false],
      ['arrived_at_pickup', 'reported', 'no_signal', false, true],
      ['loading_started', 'reported', 'correction', true, true],
    ],
  );
  assert.equal(forCarrier[1]!.note, 'Called in by phone');
  assert.equal(new Date(forCarrier[1]!.statedAt).getTime(), new Date(base.statedAt).getTime());
  assert.notEqual(forCarrier[1]!.statedAt, forCarrier[1]!.recordedAt);
  // Estimates: by the driver, then by the carrier; past ones refused.
  const past = await estimateBy(driver, made.booking.id, iso(new Date(clock().getTime() - 60_000)));
  assert.deepEqual([past.status, past.body.code], [422, 'validation_failed']);
  const soon = iso(new Date(clock().getTime() + 6 * 3_600_000));
  assert.equal((await estimateBy(driver, made.booking.id, soon)).status, 200);
  const later = iso(new Date(clock().getTime() + 7 * 3_600_000));
  const stated = await estimateAs(carrier, made.booking.id, later);
  assert.equal(stated.status, 200, stated.text);
  assert.equal((await estimateAs(shipper, made.booking.id, later)).status, 404);
  // The shipper's view: milestones and the latest estimate, with who and when; no notes.
  const seen = (await tripViewOf(shipper, made.booking.id)).trip!;
  assert.deepEqual(
    seen.milestones.map((m) => [m.milestone, m.basis, m.note ?? null]),
    [
      ['departed_for_pickup', 'observed', null],
      ['arrived_at_pickup', 'reported', null],
      ['loading_started', 'reported', null],
    ],
  );
  assert.equal(new Date(seen.estimate!.arrivalAt).getTime(), new Date(later).getTime());
  assert.equal(seen.estimate!.statedAs, 'carrier');
  // After arrival at delivery no estimate is taken.
  for (const milestone of ['loaded_departed', 'arrived_at_delivery']) {
    const trip = (await tripViewOf(carrier, made.booking.id)).trip!;
    assert.equal((await byDriver(driver, made.booking.id, trip.version, milestone)).status, 200);
  }
  const tooLate = await estimateBy(driver, made.booking.id, later);
  assert.deepEqual([tooLate.status, tooLate.body.code], [409, 'trip_arrived']);
  // Every record shows on both sides' history.
  assert.equal(
    await count('audit_entry', "record_id = $1 AND action = 'trip.milestone_recorded'", [
      made.booking.id,
    ]),
    10,
  );
});

test("TRP-6: the driver sees the addresses, access notes and the shipper's name from dispatch on, never before, and never the price or the fee", async () => {
  let carrier = await verifiedCarrier();
  const made = await ready(carrier);
  const item = async (person: Person) =>
    (
      (await call('GET', '/me/driver/assignments', { token: person.token })).body
        .assignments as Record<string, unknown>[]
    ).find((entry) => entry.bookingId === made.booking.id)!;
  const before = await item(made.driver);
  assert.deepEqual([before.site, before.shipper, before.trip], [undefined, undefined, undefined]);
  assert.ok(!JSON.stringify(before).includes('Warehouse 9'));
  await untilDispatchable(carrier, made.booking.id);
  carrier = await freshParty(carrier);
  assert.equal((await dispatch(carrier, made.booking.id)).status, 200);
  const driver = await again(made.driver);
  const after = await item(driver);
  assert.deepEqual(after.site, {
    pickup: { address: 'Warehouse 9, Private Street', accessNotes: 'Gate code 5512' },
    delivery: { address: 'Depot 3, Hidden Road', accessNotes: 'Use the north entrance' },
  });
  assert.equal((after.shipper as { legalName: string }).legalName, made.booking.shipper.legalName);
  // Identifiers are removed first: a random id such as "…0fee…" is not the fee.
  const text = JSON.stringify(after).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '<id>',
  );
  for (const hidden of [
    'transportAmount',
    'fee',
    'shipperTotal',
    'carrierNet',
    made.booking.transportAmount,
  ])
    assert.ok(!text.includes(hidden), `the driver is shown ${hidden}`);
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

test('TRP-8: a milestone that waited for the trip while the driver left the carrier records nothing', async () => {
  let carrier = await verifiedCarrier();
  const made = await ready(carrier);
  await untilDispatchable(carrier, made.booking.id);
  carrier = await freshParty(carrier);
  const driver = await again(made.driver);
  assert.equal((await dispatch(carrier, made.booking.id)).status, 200);
  const seen = (await fleetOf(carrier.person, carrier.org)).drivers.find(
    (item) => item.id === made.affiliation,
  )!;
  const reply = await whileHeld(
    'SELECT 1 FROM trucker.trip WHERE booking_id = $1 FOR UPDATE',
    [made.booking.id],
    () => byDriver(driver, made.booking.id, 1, 'departed_for_pickup'),
    async () => {
      const ended = await call('POST', fleet(carrier.org, `/drivers/${made.affiliation}/end`), {
        token: carrier.person.token,
        key: key(),
        body: { version: seen.version },
      });
      assert.equal(ended.status, 200, ended.text);
    },
  );
  assert.deepEqual([reply.status, reply.body.code], [404, 'not_found']);
  assert.equal(
    await count(
      'trip_milestone',
      'trip_id IN (SELECT id FROM trucker.trip WHERE booking_id = $1)',
      [made.booking.id],
    ),
    0,
  );
});
