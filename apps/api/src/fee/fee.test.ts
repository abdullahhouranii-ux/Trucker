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
import {
  decideReceipt,
  feeDue,
  matching,
  recordReceipt,
  retryKey,
  settleFee,
  statementLine,
  type FeePayment,
} from '../testing/fee.js';
import { restoreFinancialSettings, setFinancialSettings } from '../testing/financial.js';
import { createTestClock } from '../testing/test-clock.js';
import { blockedRequests } from '../testing/blocked-request.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';

// Trucker's fee before confirmation (slice 26). Real PostgreSQL, the API connected as its
// restricted role. Shippers, carriers, vehicles, drivers and bookings are made through the routes
// of the earlier slices; staff accounts and sessions are put in place by the migration role.
// Test accounts, fictional evidence and fictional bank statement lines only.

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
const problemsOf = (reply: Reply): string[] =>
  (
    (reply.body.details as { problems?: { field: string; code: string }[] } | undefined)
      ?.problems ?? []
  )
    .map((problem) => `${problem.field}:${problem.code}`)
    .sort();

test('FP-1, D-6: acceptance records the fee due; the payer is shown the amount, the reference and a deadline that is the earlier of the settings hours and the assignment deadline; the carrier sees only whether it is settled; a fee of nothing is not required', async () => {
  const carrier = await verifiedCarrier();
  const { shipper, booking } = await booked(carrier);
  const row = await feeRow(booking.id);
  assert.equal(row.status, 'due');
  assert.equal(row.amount, row.price_fee);
  assert.equal(row.due_at.getTime(), row.accepted_at.getTime() + 12 * 3_600_000);
  assert.ok(row.due_at <= row.assignment_due_at);

  const forShipper = (await detailOf(shipper, booking.id)).booking;
  const fee = forShipper.feePayment;
  assert.deepEqual(
    [fee.status, fee.payer, fee.amount, fee.currency, fee.paymentHours, fee.verifying, fee.refunds],
    ['due', 'customer', row.amount, booking.currency, 12, false, []],
  );
  assert.match(fee.reference!, /^TF-[0-9A-F]{10}$/);
  assert.equal(new Date(fee.dueAt!).toISOString(), row.due_at.toISOString());
  assert.equal(forShipper.status, 'awaiting_resources');

  // The carrier: whether it is settled and by when; never the amount or the reference.
  const forCarrier = await detailOf(carrier, booking.id);
  assert.deepEqual(Object.keys(forCarrier.booking.feePayment).sort(), [
    'dueAt',
    'paidAt',
    'status',
  ]);
  assert.ok(!JSON.stringify(forCarrier).includes(fee.reference!));
  assert.deepEqual(
    forCarrier.booking.dispatch.blockers.map((item) => item.code),
    ['not_confirmed', 'fee_not_paid'],
  );
  const listed = await call('GET', `/organisations/${carrier.org}/bookings`, {
    token: carrier.person.token,
  });
  assert.equal(listed.status, 200, listed.text);
  assert.ok(!listed.text.includes(fee.reference!));

  // The hours come from the settings in force, and the deadline never passes the assignment's.
  await setFinancialSettings(owner, { feePaymentHours: 2 });
  try {
    const short = await booked(carrier, 1);
    const shortRow = await feeRow(short.booking.id);
    assert.equal(shortRow.due_at.getTime(), shortRow.accepted_at.getTime() + 2 * 3_600_000);
    await setFinancialSettings(owner, { feePaymentHours: 168 });
    const long = await booked(carrier, 2);
    const longRow = await feeRow(long.booking.id);
    assert.equal(longRow.due_at.toISOString(), longRow.assignment_due_at.toISOString());

    // A fee of nothing: not required, and full assignment alone confirms.
    await setFinancialSettings(owner, { feeBasisPoints: 0 });
    const truck = await rigid(carrier);
    const { affiliation } = await readyDriver(carrier);
    const free = await booked(carrier, 3);
    assert.equal((await feeRow(free.booking.id)).status, 'not_required');
    const view = (await detailOf(free.shipper, free.booking.id)).booking.feePayment;
    assert.deepEqual([view.status, view.reference, view.dueAt], ['not_required', null, null]);
    const confirmed = await assigned(
      carrier,
      free.booking.id,
      { truckId: truck.id, trailerId: null, driverId: affiliation },
      'confirmed',
    );
    assert.equal(confirmed.status, 'confirmed');
    assert.equal((await confirmationOf(free.booking.id))!.completed_by, 'assignment');
  } finally {
    await restoreFinancialSettings(owner);
  }
});

test('FP-2, R-14, G-8, G-9: one administrator records the transfer and another approves it; the booking is confirmed by whichever of fee and full assignment comes second, never before both', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { affiliation } = await readyDriver(carrier);
  const { shipper, booking } = await booked(carrier);
  const first = await administrator();
  const second = await secondAdministrator();

  // Full assignment first: everything reserved, nothing confirmed or released.
  const assignedFirst = await assigned(
    carrier,
    booking.id,
    { truckId: truck.id, trailerId: null, driverId: affiliation },
    'assigned',
  );
  assert.deepEqual([assignedFirst.status, assignedFirst.site], ['awaiting_fee', null]);
  assert.equal((await activeOf(booking.id)).length, 2);
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [booking.id]), 0);
  assert.equal((await viewOf(shipper, booking.id)).status, 'awaiting_fee');

  // Recorded by the first administrator: in hand, being verified, still not confirmed.
  const due = await feeDue(call, first.token, booking.id);
  const recorded = await recordReceipt(call, first.token, matching(due));
  assert.equal(recorded.status, 201, recorded.text);
  const payment = recorded.body.payment as FeePayment;
  assert.deepEqual([recorded.body.outcome, payment.status], ['recorded', 'recorded']);
  const verifying = (await viewOf(shipper, booking.id)).feePayment;
  assert.deepEqual([verifying.status, verifying.verifying], ['due', true]);
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [booking.id]), 0);

  // Never approved by the one who recorded it, a reviewer, or a participant.
  const same = await decideReceipt(call, first.token, payment, 'approve');
  assert.equal(same.status, 409, same.text);
  assert.equal(same.body.code, 'different_person_required');
  assert.equal(
    (await decideReceipt(call, (await reviewer()).token, payment, 'approve')).status,
    403,
  );
  assert.equal((await decideReceipt(call, shipper.person.token, payment, 'approve')).status, 401);
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [booking.id]), 0);

  // Approved by the second: paid and confirmed in the same transaction, by that administrator.
  const approved = await decideReceipt(call, second.token, payment, 'approve');
  assert.equal(approved.status, 200, approved.text);
  assert.deepEqual(
    [
      approved.body.outcome,
      (approved.body.payment as { outcome: string }).outcome,
      (approved.body.booking as View).status,
    ],
    ['approved', 'settled', 'confirmed'],
  );
  assert.deepEqual(await confirmationOf(booking.id), {
    completed_by: 'fee_verification',
    confirmed_by: null,
    staff: second.id,
  });
  const forCarrier = await viewOf(carrier, booking.id);
  assert.equal(forCarrier.status, 'confirmed');
  assert.ok(forCarrier.site, 'the site details are released on confirmation');
  assert.equal(forCarrier.feePayment.status, 'paid');
  const parties = [shipper.org, carrier.org].sort();
  assert.deepEqual(
    (await auditOf(booking.id, 'booking.fee_paid')).map((item) => [item.org, item.staff]),
    parties.map((org) => [org, second.id]),
  );
  assert.deepEqual(
    (await auditOf(booking.id, 'booking.confirmed')).map((item) => [item.org, item.staff]),
    [[shipper.org, second.id]],
  );
  assert.deepEqual(
    (await staffAudit(first, 'staff.fee_payment.recorded')).map((item) => item.outcome),
    ['done'],
  );
  assert.deepEqual(
    (await staffAudit(second, 'staff.fee_payment.decided')).map((item) => item.outcome),
    ['done'],
  );
  assert.deepEqual(
    (await staffAudit(first, 'staff.fee_payment.decide')).map((item) => item.detail.reason),
    ['same_person'],
  );

  // Decided once. What was written is never changed or removed, even by the migration role.
  const decidedAgain = await decideReceipt(
    call,
    second.token,
    { id: payment.id, version: 2 },
    'reject',
    'x',
  );
  assert.equal(decidedAgain.status, 409, decidedAgain.text);
  assert.equal(decidedAgain.body.code, 'receipt_already_decided');
  for (const statement of [
    `UPDATE trucker.fee_payment SET amount = amount + 1 WHERE id = '${payment.id}'`,
    `DELETE FROM trucker.fee_payment WHERE id = '${payment.id}'`,
    `UPDATE trucker.booking_fee SET status = 'due', paid_at = NULL, payment_id = NULL, row_version = row_version + 1 WHERE booking_id = '${booking.id}'`,
    `DELETE FROM trucker.booking_fee WHERE booking_id = '${booking.id}'`,
  ])
    await refused(() => owner.query(statement), /only|never/);

  // The other order: the fee first, then the assignment that completes the set confirms.
  const otherTruck = await rigid(carrier);
  const other = await readyDriver(carrier);
  const later = await booked(carrier, 1);
  await settleFee(call, first.token, second.token, later.booking.id);
  const paidFirst = await viewOf(later.shipper, later.booking.id);
  assert.deepEqual(
    [paidFirst.status, paidFirst.feePayment.status, paidFirst.dispatch.blockers.map((b) => b.code)],
    ['awaiting_resources', 'paid', ['not_confirmed']],
  );
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [later.booking.id]), 0);
  await assigned(
    carrier,
    later.booking.id,
    { truckId: otherTruck.id, trailerId: null, driverId: other.affiliation },
    'confirmed',
  );
  assert.equal((await confirmationOf(later.booking.id))!.completed_by, 'assignment');
  assert.deepEqual(await consistency(), []);
});

test('FP-3, R-12, R-13: only an exact match to a known reference is recorded against a fee that is due; a statement line is matched once; a retried request records once; a reused key is refused', async () => {
  const carrier = await verifiedCarrier();
  const { booking } = await booked(carrier);
  const first = await administrator();
  const second = await secondAdministrator();
  const due = await feeDue(call, first.token, booking.id);
  const record = (over: Record<string, unknown>, key?: string) =>
    recordReceipt(call, first.token, { ...matching(due), ...over }, key);

  const wrong = await record({ amount: '1.00', currency: 'ZZZ' });
  assert.equal(wrong.status, 422, wrong.text);
  assert.deepEqual(problemsOf(wrong), ['amount:mismatch', 'currency:mismatch']);
  const unknown = await record({
    reference: 'TF-0000000000',
    valueDate: '2026-13-40',
    statementReference: ' ',
  });
  assert.deepEqual(problemsOf(unknown), [
    'reference:unknown',
    'statementReference:required',
    'valueDate:invalid',
  ]);
  const future = await record({
    valueDate: new Date(clock().getTime() + 3 * 86_400_000).toISOString().slice(0, 10),
  });
  assert.deepEqual(problemsOf(future), ['valueDate:future']);
  const noKey = await call('POST', '/staff/fee-payments', {
    token: first.token,
    body: matching(due),
  });
  assert.equal(noKey.status, 400, noKey.text);
  assert.equal(await count('fee_payment', 'booking_id = $1', [booking.id]), 0);

  // A lost response, retried with the same key: one record.
  const key = retryKey();
  const line = statementLine();
  const made = await record({ statementReference: line }, key);
  assert.equal(made.status, 201, made.text);
  const repeated = await record({ statementReference: line }, key);
  assert.equal(repeated.status, 201, repeated.text);
  assert.equal(repeated.body.outcome, 'already_recorded');
  assert.equal((repeated.body.payment as FeePayment).id, (made.body.payment as FeePayment).id);
  const reused = await record({ statementReference: statementLine() }, key);
  assert.equal(reused.status, 409, reused.text);
  assert.equal(reused.body.code, 'retry_key_conflict');
  // The same line of the statement cannot be matched again.
  const twice = await record({ statementReference: line });
  assert.deepEqual(problemsOf(twice), ['statementReference:already_recorded']);
  assert.equal(await count('fee_payment', 'booking_id = $1', [booking.id]), 1);

  // A rejection needs a reason, and frees the line; the reference is read as staff type it.
  const payment = made.body.payment as FeePayment;
  const bare = await decideReceipt(call, second.token, payment, 'reject');
  assert.deepEqual(problemsOf(bare), ['note:required']);
  const rejected = await decideReceipt(
    call,
    second.token,
    payment,
    'reject',
    'Not on the statement (fictional)',
  );
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal((await viewOf(carrier, booking.id)).feePayment.status, 'due');
  const reRecorded = await record({
    statementReference: line,
    reference: ` ${due.reference.toLowerCase()} `,
  });
  assert.equal(reRecorded.status, 201, reRecorded.text);
  assert.equal(
    await count('fee_payment', "booking_id = $1 AND status = 'recorded'", [booking.id]),
    1,
  );
});

test('FP-4, D-7, G-11: a fee not paid by its deadline lapses the booking as a recorded cancellation; nothing is reserved or confirmed after it; the shipment can be published again; money that arrives later is recorded for return', async () => {
  let carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { affiliation } = await readyDriver(carrier);
  const made = await booked(carrier);
  const { shipment, booking } = made;
  await assigned(
    carrier,
    booking.id,
    { truckId: truck.id, trailerId: null, driverId: null },
    'assigned',
  );
  const due = (await viewOf(made.shipper, booking.id)).feePayment;
  assert.equal((await lapseRun()).includes('lapsed'), false);

  // Past the deadline: shown as overdue, and staff see it among bookings needing attention.
  await until(due.dueAt!);
  const shipper = await freshParty(made.shipper);
  carrier = await freshParty(carrier);
  assert.equal((await viewOf(shipper, booking.id)).feePayment.status, 'overdue');
  const attention = await call('GET', '/staff/bookings/attention', {
    token: (await administrator()).token,
  });
  assert.equal(attention.status, 200, attention.text);
  assert.ok(
    (attention.body.attention as { bookings: { id: string; feeStatus: string }[] }).bookings.some(
      (item) => item.id === booking.id && item.feeStatus === 'overdue',
    ),
  );
  // Nothing more is reserved for it.
  const refusedAssignment = await assign(carrier, booking.id, {
    version: 1,
    truckId: truck.id,
    trailerId: null,
    driverId: affiliation,
  });
  assert.equal(refusedAssignment.status, 409, refusedAssignment.text);
  assert.equal(refusedAssignment.body.code, 'fee_not_paid');
  assert.equal((await activeOf(booking.id)).length, 1);

  // The job records the lapse: one booking per call, until there is none.
  const run = await lapseRun();
  assert.deepEqual([run.includes('lapsed'), run.at(-1)], [true, 'none']);
  const lapsed = await viewOf(shipper, booking.id);
  assert.deepEqual(
    [
      lapsed.status,
      lapsed.cancellation!.party,
      lapsed.cancellation!.reason,
      lapsed.feePayment.status,
    ],
    ['cancelled', 'platform', 'fee_not_paid', 'lapsed'],
  );
  assert.equal(new Date(lapsed.cancellation!.at).toISOString(), new Date(due.dueAt!).toISOString());
  assert.equal((await activeOf(booking.id)).length, 0);
  assert.deepEqual(
    (await auditOf(booking.id, 'booking.lapsed')).map((item) => [
      item.org,
      item.person,
      item.staff,
    ]),
    [shipper.org, carrier.org].sort().map((org) => [org, null, null]),
  );
  assert.deepEqual(await consistency(), []);
  const late = await assign(carrier, booking.id, {
    version: 2,
    truckId: truck.id,
    trailerId: null,
    driverId: affiliation,
  });
  assert.equal(late.status, 409, late.text);

  // The shipment can be published again.
  const current = await call('GET', `/organisations/${shipper.org}/shipments/${shipment.id}`, {
    token: shipper.person.token,
  });
  const cancelledShipment = current.body.shipment as Shipment;
  assert.equal(cancelledShipment.status, 'booking_cancelled');
  const republished = await act(shipper.person, shipper.org, shipment.id, 'republish', {
    version: cancelledShipment.version,
    quotationDeadline: { local: local(24) },
  });
  assert.equal(republished.status, 200, republished.text);

  // Money that arrives now is recorded as it came, and approving it never confirms anything.
  const first = await administrator();
  const second = await secondAdministrator();
  const recorded = await recordReceipt(call, first.token, {
    reference: due.reference,
    amount: '5.00',
    currency: due.currency,
    valueDate: clock().toISOString().slice(0, 10),
    statementReference: statementLine(),
  });
  assert.equal(recorded.status, 201, recorded.text);
  const approved = await decideReceipt(
    call,
    second.token,
    recorded.body.payment as FeePayment,
    'approve',
  );
  assert.equal(approved.status, 200, approved.text);
  assert.equal((approved.body.payment as { outcome: string }).outcome, 'refund_due');
  assert.deepEqual(await refundsOf(booking.id), [
    { reason: 'booking_ended', amount: '5.00', status: 'pending' },
  ]);
  assert.equal(await count('booking_confirmation', 'booking_id = $1', [booking.id]), 0);
  assert.deepEqual(
    (await viewOf(shipper, booking.id)).feePayment.refunds!.map((item) => [
      item.reason,
      item.status,
    ]),
    [['booking_ended', 'pending']],
  );
});

test('FP-5: a transfer recorded by the deadline holds the booking past it until the second administrator decides; approval then settles and confirms, rejection lets it lapse at once', async () => {
  const carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { affiliation } = await readyDriver(carrier);
  const kept = await booked(carrier);
  const dropped = await booked(carrier, 1);
  const withdrawn = await booked(carrier, 2);
  const first = await administrator();
  const keptReceipt = await recordReceipt(
    call,
    first.token,
    matching(await feeDue(call, first.token, kept.booking.id)),
  );
  const droppedReceipt = await recordReceipt(
    call,
    first.token,
    matching(await feeDue(call, first.token, dropped.booking.id)),
  );
  assert.equal(keptReceipt.status, 201, keptReceipt.text);
  assert.equal(droppedReceipt.status, 201, droppedReceipt.text);
  const withdrawnDue = await feeDue(call, first.token, withdrawn.booking.id);
  const withdrawnReceipt = await recordReceipt(call, first.token, matching(withdrawnDue));
  assert.equal(withdrawnReceipt.status, 201, withdrawnReceipt.text);

  // The full set is assigned in time; only the fee is missing.
  await assigned(
    carrier,
    kept.booking.id,
    { truckId: truck.id, trailerId: null, driverId: affiliation },
    'assigned',
  );
  await until(withdrawnDue.dueAt);
  await lapseRun();
  assert.deepEqual(
    [
      (await feeRow(kept.booking.id)).status,
      (await feeRow(dropped.booking.id)).status,
      (await feeRow(withdrawn.booking.id)).status,
    ],
    ['due', 'due', 'due'],
  );
  // While held, the customer may still cancel: that is the customer's cancellation, not a
  // lapse, and the transfer in hand is returned once approved.
  const shipperNow = await freshParty(withdrawn.shipper);
  const cancelled = await cancel(shipperNow, withdrawn.booking.id, 'dates_changed', 0);
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.deepEqual(
    [
      (await viewOf(shipperNow, withdrawn.booking.id)).cancellation!.party,
      (await feeRow(withdrawn.booking.id)).status,
    ],
    ['shipper', 'closed'],
  );
  const held = (await viewOf(await freshParty(kept.shipper), kept.booking.id)).feePayment;
  assert.deepEqual([held.status, held.verifying], ['due', true]);
  const approver = await secondAdministrator();
  // A second transfer recorded after the deadline does not settle it, even while it is held.
  const recorder = await administrator();
  const lateSecond = await recordReceipt(call, recorder.token, {
    ...matching(await feeDue(call, recorder.token, kept.booking.id)),
    statementReference: statementLine(),
  });
  assert.equal(lateSecond.status, 201, lateSecond.text);
  const lateOutcome = await decideReceipt(
    call,
    approver.token,
    lateSecond.body.payment as FeePayment,
    'approve',
  );
  assert.equal(lateOutcome.status, 200, lateOutcome.text);
  assert.deepEqual(
    [
      (lateOutcome.body.payment as { outcome: string }).outcome,
      (await feeRow(kept.booking.id)).status,
    ],
    ['refund_due', 'due'],
  );
  const withdrawnOutcome = await decideReceipt(
    call,
    approver.token,
    withdrawnReceipt.body.payment as FeePayment,
    'approve',
  );
  assert.equal(withdrawnOutcome.status, 200, withdrawnOutcome.text);
  assert.deepEqual(
    (await refundsOf(withdrawn.booking.id)).map((item) => item.reason),
    ['booking_ended'],
  );
  const approved = await decideReceipt(
    call,
    approver.token,
    keptReceipt.body.payment as FeePayment,
    'approve',
  );
  assert.equal(approved.status, 200, approved.text);
  assert.equal((approved.body.booking as View).status, 'confirmed');
  assert.equal((await feeRow(kept.booking.id)).status, 'paid');

  const rejected = await decideReceipt(
    call,
    approver.token,
    droppedReceipt.body.payment as FeePayment,
    'reject',
    'Amount never reached the account (fictional)',
  );
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal((rejected.body.booking as View).status, 'cancelled');
  assert.equal((await feeRow(dropped.booking.id)).status, 'lapsed');
  await lapseRun();
  assert.equal((await feeRow(kept.booking.id)).status, 'paid');
});

test('FP-6, D-8: a cancellation after the fee is paid records a full refund; before payment it closes the fee; money paid twice is recorded for return', async () => {
  const carrier = await verifiedCarrier();
  const first = await administrator();
  const second = await secondAdministrator();
  const paid = await booked(carrier, 0, clock(), true);
  const unpaid = await booked(carrier, 1);
  const twice = await booked(carrier, 2, clock(), true);
  const fee = (await feeRow(paid.booking.id)).amount;

  const cancelPaid = await cancel(paid.shipper, paid.booking.id, 'dates_changed', 0);
  assert.equal(cancelPaid.status, 200, cancelPaid.text);
  assert.deepEqual(await refundsOf(paid.booking.id), [
    { reason: 'cancelled_after_payment', amount: fee, status: 'pending' },
  ]);
  assert.equal((await feeRow(paid.booking.id)).status, 'paid');
  assert.deepEqual(
    (await auditOf(paid.booking.id, 'booking.refund_recorded')).map((item) => [
      item.org,
      item.person,
    ]),
    [paid.shipper.org, carrier.org].sort().map((org) => [org, paid.shipper.person.personId]),
  );

  const cancelUnpaid = await cancel(carrier, unpaid.booking.id, 'resource_unavailable', 0);
  assert.equal(cancelUnpaid.status, 200, cancelUnpaid.text);
  assert.equal((await feeRow(unpaid.booking.id)).status, 'closed');
  assert.deepEqual(await refundsOf(unpaid.booking.id), []);

  // A second transfer for a fee already paid: recorded as it came, returned in full.
  const reference = (await viewOf(twice.shipper, twice.booking.id)).feePayment.reference!;
  const extra = await recordReceipt(call, first.token, {
    reference,
    amount: '12.34',
    currency: twice.booking.currency,
    valueDate: clock().toISOString().slice(0, 10),
    statementReference: statementLine(),
  });
  assert.equal(extra.status, 201, extra.text);
  assert.equal(
    (await decideReceipt(call, second.token, extra.body.payment as FeePayment, 'approve')).status,
    200,
  );
  assert.deepEqual(await refundsOf(twice.booking.id), [
    { reason: 'duplicate_payment', amount: '12.34', status: 'pending' },
  ]);

  const overview = await call('GET', '/staff/fee-payments', { token: first.token });
  assert.equal(overview.status, 200, overview.text);
  const refunds = (overview.body.fees as { refunds: { bookingId: string; reason: string }[] })
    .refunds;
  assert.deepEqual(
    refunds
      .filter((item) => [paid.booking.id, twice.booking.id].includes(item.bookingId))
      .map((item) => item.reason)
      .sort(),
    ['cancelled_after_payment', 'duplicate_payment'],
  );
  assert.deepEqual(await consistency(), []);
});

test('FP-7, R-15: commands judge the deadline at the moment they hold the booking: an assignment that waited across it is refused; an approval that waited across it still settles a transfer recorded in time; a transfer recorded by a request that waited across it is late and returned', async () => {
  let carrier = await verifiedCarrier();
  const truck = await rigid(carrier);
  const { affiliation } = await readyDriver(carrier);
  const { whileBlocked } = blockedRequests(() => owner, advance);

  const waited = await booked(carrier);
  const dueAt = new Date((await viewOf(waited.shipper, waited.booking.id)).feePayment.dueAt!);
  await advance(Math.floor((dueAt.getTime() - clock().getTime()) / 1000) - 60);
  carrier = await freshParty(carrier);
  const reply = await whileBlocked(
    ['SELECT trucker.assignment_state_lock($1, now())', [waited.booking.id]],
    () =>
      assign(carrier, waited.booking.id, {
        version: 0,
        truckId: truck.id,
        trailerId: null,
        driverId: affiliation,
      }),
    120,
  );
  assert.equal(reply.status, 409, reply.text);
  assert.equal(reply.body.code, 'fee_not_paid');
  assert.equal((await activeOf(waited.booking.id)).length, 0);

  const inTime = await booked(carrier, 1);
  const first = await administrator();
  await assigned(
    carrier,
    inTime.booking.id,
    { truckId: truck.id, trailerId: null, driverId: affiliation },
    'assigned',
  );
  const recorded = await recordReceipt(
    call,
    first.token,
    matching(await feeDue(call, first.token, inTime.booking.id)),
  );
  assert.equal(recorded.status, 201, recorded.text);
  const inTimeDue = new Date((await viewOf(inTime.shipper, inTime.booking.id)).feePayment.dueAt!);
  await advance(Math.floor((inTimeDue.getTime() - clock().getTime()) / 1000) - 60);
  const second = await secondAdministrator();
  const approval = await whileBlocked(
    ['SELECT trucker.assignment_state_lock($1, now())', [inTime.booking.id]],
    () => decideReceipt(call, second.token, recorded.body.payment as FeePayment, 'approve'),
    120,
  );
  assert.equal(approval.status, 200, approval.text);
  assert.equal((approval.body.booking as View).status, 'confirmed');
  assert.ok(clock() > inTimeDue);
  await lapseRun();
  assert.equal((await feeRow(waited.booking.id)).status, 'lapsed');

  // A transfer recorded by a request that waited across the deadline is late: the booking
  // lapses in that same request, and the money is returned, never used to confirm.
  carrier = await freshParty(carrier);
  const crossing = await booked(carrier, 2);
  const crossingDue = await feeDue(call, (await administrator()).token, crossing.booking.id);
  await advance(
    Math.floor((new Date(crossingDue.dueAt).getTime() - clock().getTime()) / 1000) - 60,
  );
  const recorder = await administrator();
  const lateRecord = await whileBlocked(
    ['SELECT trucker.assignment_state_lock($1, now())', [crossing.booking.id]],
    () => recordReceipt(call, recorder.token, matching(crossingDue)),
    120,
  );
  assert.equal(lateRecord.status, 201, lateRecord.text);
  assert.equal((await feeRow(crossing.booking.id)).status, 'lapsed');
  const lateDecision = await decideReceipt(
    call,
    (await secondAdministrator()).token,
    lateRecord.body.payment as FeePayment,
    'approve',
  );
  assert.equal(lateDecision.status, 200, lateDecision.text);
  assert.deepEqual(
    [
      (lateDecision.body.payment as { outcome: string }).outcome,
      (lateDecision.body.booking as View).status,
    ],
    ['refund_due', 'cancelled'],
  );
  assert.deepEqual(
    (await refundsOf(crossing.booking.id)).map((item) => item.reason),
    ['booking_ended'],
  );
  assert.deepEqual(await consistency(), []);
});
