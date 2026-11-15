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

// Fleet and drivers (slice 13). Real PostgreSQL, the API connected as its restricted role.
// Carriers are verified through the verification routes, by staff accounts put in place directly
// by the migration role. Test accounts and fictional documents only.

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
const problems = (reply: Reply): { field: string; code: string }[] =>
  ((reply.body.details as { problems?: unknown } | undefined)?.problems ?? []) as {
    field: string;
    code: string;
  }[];

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
const startOf = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
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
const TRUCK_DOCUMENTS = ['fictional_registration_card', 'fictional_insurance_certificate'];
/** A truck whose ownership is verified and whose documents are accepted. */
async function eligibleTruck(person: Person, org: string, over: Record<string, unknown> = {}) {
  const vehicle = await registered(person, org, over);
  assert.equal((await verifyOwnership(vehicle)).status, 200);
  for (const type of TRUCK_DOCUMENTS)
    assert.equal(
      (await submitVehicleDocument(person, org, vehicle.id, documentBody(type))).status,
      201,
    );
  await acceptDocuments(vehicle.id);
  return vehicleOf(person, org, vehicle.id);
}
const vehicleEligibility = async (
  vehicle: string,
  org: string,
  from: Date,
  until: Date,
  equipment: string | null = null,
): Promise<string> =>
  (
    await owner.query<{ e: string }>(
      'SELECT trucker.vehicle_eligibility($1, $2, $3, $4, $5) AS e',
      [vehicle, org, from, until, equipment],
    )
  ).rows[0]!.e;
const driverEligibility = async (
  affiliation: string,
  vehicle: string | null,
  from: Date,
  until: Date,
): Promise<string> =>
  (
    await owner.query<{ e: string }>('SELECT trucker.driver_eligibility($1, $2, $3, $4) AS e', [
      affiliation,
      vehicle,
      from,
      until,
    ])
  ).rows[0]!.e;
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
const audited = (record: string, action: string): Promise<number> =>
  count('audit_entry', 'record_id = $1 AND action = $2', [record, action]);

// ---------------------------------------------------------------------------------------------
test('FLT-1: only an administrator of a verified carrier manages a fleet; others are refused as for a missing record', async () => {
  const carrier = await verifiedCarrier();
  const outsider = await newPerson();
  const shipper = await verifiedShipper();
  assert.equal((await call('GET', fleet(carrier.org))).status, 401);
  for (const [method, route, body] of [
    ['GET', '', undefined],
    ['POST', '/vehicles', vehicleBody()],
    ['POST', '/drivers', { phone: newPhone() }],
  ] as const) {
    const asOutsider = await call(method, fleet(carrier.org, route), {
      token: outsider.token,
      key: key(),
      ...(body ? { body } : {}),
    });
    assert.equal(asOutsider.status, 404, `${method} ${route}: ${asOutsider.text}`);
    // An administrator of an organisation that is not a carrier.
    const asShipper = await call(method, fleet(shipper.org, route), {
      token: shipper.person.token,
      key: key(),
      ...(body ? { body } : {}),
    });
    assert.equal(asShipper.status, 403, `${method} ${route}: ${asShipper.text}`);
    assert.equal(asShipper.body.code, 'carrier_not_eligible');
  }
  assert.equal(await count('vehicle'), 0);
  assert.equal(await count('driver_affiliation'), 0);
  const mine = await fleetOf(carrier.person, carrier.org);
  assert.deepEqual([mine.open, mine.vehicles, mine.drivers], [true, [], []]);
});

test('a vehicle is registered once, with problems reported by field; retries and limits hold; outside a marked database it is closed', async () => {
  const { person, org } = await verifiedCarrier();
  const bad = await call('POST', fleet(org, '/vehicles'), {
    token: person.token,
    key: key(),
    body: vehicleBody({
      kind: 'trailer',
      category: 'fictional_rigid_truck',
      equipmentType: 'nothing',
      registrationCountry: 'XC',
      registrationNumber: '!',
    }),
  });
  assert.equal(bad.status, 422, bad.text);
  assert.deepEqual(
    problems(bad).map((problem) => `${problem.field}:${problem.code}`),
    [
      'category:unavailable',
      'equipmentType:unavailable',
      'registrationCountry:unavailable',
      'registrationNumber:invalid',
    ],
  );
  // Spaces, dashes and case are not part of a registration.
  const sent = key();
  const body = vehicleBody({ registrationNumber: 'ab-12 cd' });
  const first = await call('POST', fleet(org, '/vehicles'), {
    token: person.token,
    key: sent,
    body,
  });
  assert.equal(first.status, 201, first.text);
  const vehicle = first.body.vehicle as Vehicle;
  assert.deepEqual(
    [first.body.outcome, vehicle.registrationNumber, vehicle.ownership, vehicle.eligibility],
    ['registered', 'AB12CD', 'claimed', 'ownership_not_verified'],
  );
  const again1 = await call('POST', fleet(org, '/vehicles'), {
    token: person.token,
    key: sent,
    body,
  });
  assert.deepEqual([again1.status, again1.body.outcome], [201, 'already_registered']);
  const other = await call('POST', fleet(org, '/vehicles'), {
    token: person.token,
    key: sent,
    body: vehicleBody(),
  });
  assert.deepEqual([other.status, other.body.code], [409, 'retry_key_conflict']);
  const twice = await call('POST', fleet(org, '/vehicles'), {
    token: person.token,
    key: key(),
    body: vehicleBody({ registrationNumber: 'AB12CD' }),
  });
  assert.deepEqual([twice.status, twice.body.code], [409, 'fleet_record_exists']);
  assert.equal(await count('vehicle', 'organisation_id = $1', [org]), 1);
  assert.equal(await audited(vehicle.id, 'vehicle.registered'), 1);
  // The same new number sent twice at the same moment: one record.
  const number = newPlate();
  const both = await Promise.all(
    [0, 1].map(() =>
      call('POST', fleet(org, '/vehicles'), {
        token: person.token,
        key: key(),
        body: vehicleBody({ registrationNumber: number }),
      }),
    ),
  );
  assert.deepEqual(both.map((reply) => reply.status).sort(), [201, 409]);
  assert.equal(await count('vehicle', 'registration_number = $1', [number]), 1);
  await owner.query('UPDATE trucker.security_setting SET fleet_vehicle_limit = 2');
  try {
    const over = await call('POST', fleet(org, '/vehicles'), {
      token: person.token,
      key: key(),
      body: vehicleBody(),
    });
    assert.deepEqual([over.status, over.body.code], [409, 'fleet_limit']);
  } finally {
    await owner.query('UPDATE trucker.security_setting SET fleet_vehicle_limit = $1', [
      D.fleet_vehicle_limit,
    ]);
  }
  // Without the fixtures allowed, as in production, nothing can be registered.
  const closed = await asApiRole(
    { tokenHash: hashToken(person.token), organisationId: org },
    (client) =>
      client.query<{ status: string }>(
        'SELECT status FROM trucker.register_vehicle($1, $2, false)',
        [key(), JSON.stringify(vehicleBody())],
      ),
  );
  assert.equal(closed.rows[0]!.status, 'closed');
});

test('FLT-2: a claim is not ownership; a conflicting claim reveals nothing, restricts nobody, and only one claim can be verified', async () => {
  const first = await verifiedCarrier();
  const second = await verifiedCarrier();
  const number = newPlate();
  const mine = await eligibleTruck(first.person, first.org, { registrationNumber: number });
  assert.equal(mine.eligibility, 'eligible');
  // The second carrier claims the same registration: answered exactly like any registration.
  const claim = await call('POST', fleet(second.org, '/vehicles'), {
    token: second.person.token,
    key: key(),
    body: vehicleBody({ registrationNumber: number }),
  });
  assert.equal(claim.status, 201, claim.text);
  const theirs = claim.body.vehicle as Vehicle;
  assert.deepEqual([claim.body.outcome, theirs.ownership], ['registered', 'claimed']);
  for (const text of [claim.text, JSON.stringify(await fleetOf(second.person, second.org))])
    assert.ok(!text.includes(first.org) && !text.includes(mine.id), 'the other claim is disclosed');
  // The existing carrier sees and loses nothing.
  const after = await vehicleOf(first.person, first.org, mine.id);
  assert.deepEqual([after.eligibility, after.version], ['eligible', mine.version]);
  assert.ok(!JSON.stringify(await fleetOf(first.person, first.org)).includes(theirs.id));
  // Staff see both claims.
  const waiting = (await queue()).claims.find((item) => item.id === theirs.id)!;
  assert.deepEqual(
    waiting.otherClaims.map((item) => [item.vehicleId, item.ownership]),
    [[mine.id, 'verified']],
  );
  // The second claim cannot be verified while the first stands; it can be rejected.
  const refusedVerify = await verifyOwnership(theirs);
  assert.deepEqual([refusedVerify.status, refusedVerify.body.code], [409, 'ownership_conflict']);
  assert.equal((await vehicleOf(first.person, first.org, mine.id)).eligibility, 'eligible');
  const rejected = await staffDecide(
    await reviewer(),
    `vehicles/${theirs.id}/ownership`,
    theirs.version,
    'rejected',
    'claim_not_upheld',
  );
  assert.deepEqual([rejected.status, rejected.body.outcome], [200, 'decided']);
  const repeat = await staffDecide(
    await reviewer(),
    `vehicles/${theirs.id}/ownership`,
    theirs.version,
    'rejected',
    'claim_not_upheld',
  );
  assert.deepEqual([repeat.status, repeat.body.outcome], [200, 'already_decided']);
  assert.equal(await audited(theirs.id, 'vehicle.ownership_decided'), 1);
  // Two claims, neither verified, decided at the same moment by two reviewers: one is verified.
  const contested = newPlate();
  const a = await registered(first.person, first.org, { registrationNumber: contested });
  const b = await registered(second.person, second.org, { registrationNumber: contested });
  const other = await newStaff(['reviewer']);
  const replies = await Promise.all([
    verifyOwnership(a),
    staffDecide(
      other,
      `vehicles/${b.id}/ownership`,
      b.version,
      'verified',
      'ownership_evidence_accepted',
    ),
  ]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  assert.equal(
    await count('vehicle', `registration_number = $1 AND ownership = 'verified'`, [contested]),
    1,
  );
});

test('FLT-4: documents are checked by field, decided by staff, and cover a window only until they lapse, by the database clock', async () => {
  const { person, org } = await verifiedCarrier();
  const vehicle = await registered(person, org);
  assert.equal((await verifyOwnership(vehicle)).status, 200);
  assert.equal((await vehicleOf(person, org, vehicle.id)).eligibility, 'document_missing');
  const bad = await submitVehicleDocument(person, org, vehicle.id, {
    type: 'fictional_registration_card',
    documentNumber: ' ',
    issuingCountry: 'ZZ',
    expiryDate: day(-1),
    licenceClasses: ['fictional_class_1'],
  });
  assert.equal(bad.status, 422, bad.text);
  assert.deepEqual(
    problems(bad).map((problem) => `${problem.field}:${problem.code}`),
    [
      'documentNumber:required',
      'issuingCountry:unavailable',
      'expiryDate:past',
      'licenceClasses:invalid',
    ],
  );
  const unknown = await submitVehicleDocument(
    person,
    org,
    vehicle.id,
    documentBody('fictional_driving_licence'),
  );
  assert.deepEqual(problems(unknown), [{ field: 'type', code: 'unavailable' }]);
  const expiry = day(30);
  for (const type of TRUCK_DOCUMENTS)
    assert.equal(
      (
        await submitVehicleDocument(
          person,
          org,
          vehicle.id,
          documentBody(type, { expiryDate: expiry }),
        )
      ).status,
      201,
    );
  // Submitted is not accepted.
  assert.equal((await vehicleOf(person, org, vehicle.id)).eligibility, 'document_missing');
  await acceptDocuments(vehicle.id);
  assert.equal((await vehicleOf(person, org, vehicle.id)).eligibility, 'eligible');
  const lapse = startOf(expiry);
  const now = clock();
  const second = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);
  assert.equal(await vehicleEligibility(vehicle.id, org, now, lapse), 'eligible');
  assert.equal(
    await vehicleEligibility(vehicle.id, org, now, second(lapse, 1)),
    'document_expires_in_window',
  );
  assert.equal(
    await vehicleEligibility(vehicle.id, org, lapse, second(lapse, 60)),
    'document_expired',
  );
  assert.equal(await vehicleEligibility(vehicle.id, org, now, now, 'box'), 'eligible');
  assert.equal(
    await vehicleEligibility(vehicle.id, org, now, now, 'flatbed'),
    'equipment_mismatch',
  );
  // Operating control is its own question: another organisation cannot put the vehicle forward.
  const elsewhere = await verifiedCarrier();
  assert.equal(
    await vehicleEligibility(vehicle.id, elsewhere.org, now, now),
    'not_operating_controller',
  );
  // A renewal awaiting a decision changes nothing; rejected, the accepted one still stands;
  // accepted, it replaces the earlier one.
  const renew = (expiryDate: string) =>
    submitVehicleDocument(
      person,
      org,
      vehicle.id,
      documentBody('fictional_registration_card', { expiryDate }),
    );
  assert.equal((await renew(day(90))).status, 201);
  const pending = (await queue()).documents.find((doc) => doc.vehicleId === vehicle.id)!;
  const noConflictMissing = await staffDecide(
    await reviewer(),
    `documents/${pending.id}/decision`,
    pending.version,
    'accepted',
    'document_accepted',
    false,
  );
  assert.deepEqual(
    [noConflictMissing.status, noConflictMissing.body.code],
    [409, 'reviewer_not_independent'],
  );
  const reject = await staffDecide(
    await reviewer(),
    `documents/${pending.id}/decision`,
    pending.version,
    'rejected',
    'details_mismatch',
  );
  assert.equal(reject.status, 200, reject.text);
  assert.equal(await vehicleEligibility(vehicle.id, org, now, lapse), 'eligible');
  assert.equal((await renew(day(90))).status, 201);
  await acceptDocuments(vehicle.id);
  assert.equal(
    await count(
      'fleet_document',
      `vehicle_id = $1 AND type_code = 'fictional_registration_card' AND status = 'accepted'`,
      [vehicle.id],
    ),
    1,
  );
  // The insurance still lapses first.
  assert.equal(
    await vehicleEligibility(vehicle.id, org, now, second(lapse, 1)),
    'document_expires_in_window',
  );
  // The version limit is a protected setting.
  await owner.query('UPDATE trucker.security_setting SET fleet_document_version_limit = 3');
  try {
    const over = await renew(day(120));
    assert.deepEqual([over.status, over.body.code], [409, 'fleet_limit']);
  } finally {
    await owner.query('UPDATE trucker.security_setting SET fleet_document_version_limit = $1', [
      D.fleet_document_version_limit,
    ]);
  }
});

test('FLT-3: a driver joins only by their own acceptance, with one active carrier; invitations disclose nothing', async () => {
  const first = await verifiedCarrier();
  const second = await verifiedCarrier();
  const phone = newPhone();
  // A number nobody has registered: invited all the same.
  const invited = await invite(first.person, first.org, phone);
  assert.deepEqual([invited.status, invited.body.outcome], [201, 'invited']);
  const twice = await invite(first.person, first.org, phone);
  assert.deepEqual([twice.status, twice.body.code], [409, 'fleet_record_exists']);
  const badPhone = await invite(first.person, first.org, '12345');
  assert.deepEqual(problems(badPhone), [{ field: 'phone', code: 'invalid' }]);
  const driver = await newPerson(phone);
  const stranger = await newPerson();
  const side = await driverSide(driver);
  assert.equal(side.invitations.length, 1);
  assert.equal(side.affiliation, null);
  assert.equal((await driverSide(stranger)).invitations.length, 0);
  const invitation = side.invitations[0]!;
  // Nobody else can answer it.
  const notTheirs = await respond(stranger, invitation.id, invitation.version, 'accept');
  assert.equal(notTheirs.status, 404, notTheirs.text);
  const pendingDriver = (await fleetOf(first.person, first.org)).drivers[0]!;
  assert.deepEqual(
    [pendingDriver.status, pendingDriver.name, pendingDriver.documents],
    ['invited', undefined, undefined],
  );
  const accepted = await respond(driver, invitation.id, invitation.version, 'accept');
  assert.deepEqual([accepted.status, accepted.body.outcome], [200, 'accepted']);
  const active = (await fleetOf(first.person, first.org)).drivers[0]!;
  assert.deepEqual(
    [active.status, active.name, active.eligibility],
    ['active', 'Test Person (fictional)', 'document_missing'],
  );
  assert.equal(await audited(invitation.id, 'driver.affiliation_accepted'), 1);
  // Another carrier invites the same number: answered as any invitation, nothing disclosed.
  const elsewhere = await invite(second.person, second.org, phone);
  assert.deepEqual([elsewhere.status, elsewhere.body.outcome], [201, 'invited']);
  const offered = (await driverSide(driver)).invitations[0]!;
  const refusedSecond = await respond(driver, offered.id, offered.version, 'accept');
  assert.deepEqual(
    [refusedSecond.status, refusedSecond.body.code],
    [409, 'driver_affiliation_exists'],
  );
  const seenBySecond = (await fleetOf(second.person, second.org)).drivers[0]!;
  assert.deepEqual([seenBySecond.status, seenBySecond.name], ['invited', undefined]);
  const declined = await respond(driver, offered.id, offered.version, 'decline');
  assert.deepEqual([declined.status, declined.body.outcome], [200, 'declined']);
  // Two invitations accepted at the same moment by one person: one affiliation.
  const free = await newPerson();
  assert.equal((await invite(first.person, first.org, free.phone)).status, 201);
  assert.equal((await invite(second.person, second.org, free.phone)).status, 201);
  const offers = (await driverSide(free)).invitations;
  const replies = await Promise.all(
    offers.map((offer) => respond(free, offer.id, offer.version, 'accept')),
  );
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  assert.equal(
    await count('driver_affiliation', `person_id = $1 AND status = 'active'`, [free.personId]),
    1,
  );
});

test("FLT-5: a driver needs accepted documents, an authorisation for the vehicle and a licence class that covers it; ending the affiliation ends eligibility and the carrier's access to the documents", async () => {
  const { person, org } = await verifiedCarrier();
  const rigid = await eligibleTruck(person, org);
  const tractor = await eligibleTruck(person, org, { category: 'fictional_tractor_unit' });
  const { driver, affiliation } = await affiliated(person, org);
  const now = clock();
  assert.equal(await driverEligibility(affiliation, null, now, now), 'document_missing');
  const noClasses = await submitDriverDocument(driver, documentBody('fictional_driving_licence'));
  assert.deepEqual(problems(noClasses), [{ field: 'licenceClasses', code: 'required' }]);
  const badClass = await submitDriverDocument(
    driver,
    documentBody('fictional_driving_licence', { licenceClasses: ['fictional_class_9'] }),
  );
  assert.deepEqual(problems(badClass), [{ field: 'licenceClasses', code: 'unavailable' }]);
  await driverDocuments(driver, ['fictional_class_1']);
  assert.equal(await driverEligibility(affiliation, null, now, now), 'eligible');
  assert.equal(await driverEligibility(affiliation, rigid.id, now, now), 'not_authorised');
  const granted = await authorise(person, org, affiliation, rigid.id);
  assert.deepEqual([granted.status, granted.body.outcome], [200, 'changed']);
  assert.equal((await authorise(person, org, affiliation, rigid.id)).body.outcome, 'unchanged');
  assert.equal(await driverEligibility(affiliation, rigid.id, now, now), 'eligible');
  assert.equal(await driverEligibility(affiliation, tractor.id, now, now), 'not_authorised');
  // Authorised for every vehicle: the licence class still has to cover the category.
  assert.equal((await authorise(person, org, affiliation, null)).status, 200);
  assert.equal(
    await driverEligibility(affiliation, tractor.id, now, now),
    'licence_class_not_covering',
  );
  // Another carrier's vehicle is not one the driver can be put forward for.
  const other = await verifiedCarrier();
  const foreign = await eligibleTruck(other.person, other.org);
  assert.equal(await driverEligibility(affiliation, foreign.id, now, now), 'vehicle_not_found');
  const cross = await authorise(person, org, affiliation, foreign.id);
  assert.equal(cross.status, 404, cross.text);
  // What the carrier sees of the driver's documents: no numbers.
  const seen = (await fleetOf(person, org)).drivers.find((item) => item.id === affiliation)!;
  assert.equal(seen.documents!.length, 2);
  assert.ok(seen.documents!.every((doc) => doc.documentNumber === undefined));
  assert.ok((await driverSide(driver)).documents.every((doc) => doc.documentNumber !== undefined));
  // The carrier ends the affiliation.
  const ended = await call('POST', fleet(org, `/drivers/${affiliation}/end`), {
    token: person.token,
    key: key(),
    body: { version: seen.version },
  });
  assert.deepEqual([ended.status, ended.body.outcome], [200, 'ended']);
  assert.equal(await driverEligibility(affiliation, rigid.id, now, now), 'not_affiliated');
  assert.equal(
    await count('driver_authorisation', `affiliation_id = $1 AND status = 'active'`, [affiliation]),
    0,
  );
  const gone = (await fleetOf(person, org)).drivers.find((item) => item.id === affiliation)!;
  assert.deepEqual(
    [gone.status, gone.documents, gone.eligibility],
    ['ended', undefined, undefined],
  );
  // The documents stay the driver's own.
  const own = await driverSide(driver);
  assert.equal(own.affiliation, null);
  assert.equal(own.documents.length, 2);
  // Without a carrier the driver cannot submit, and can join another.
  const alone = await submitDriverDocument(driver, documentBody('fictional_identity_card'));
  assert.deepEqual([alone.status, alone.body.code], [409, 'driver_not_affiliated']);
  assert.equal((await invite(other.person, other.org, driver.phone)).status, 201);
  const offer = (await driverSide(driver)).invitations[0]!;
  assert.equal((await respond(driver, offer.id, offer.version, 'accept')).status, 200);
  // The accepted documents follow the driver to a carrier of the same country.
  const joined = (await fleetOf(other.person, other.org)).drivers.find(
    (item) => item.id === offer.id,
  )!;
  assert.equal(joined.eligibility, 'eligible');
  // The driver leaves.
  const mine = (await driverSide(driver)).affiliation!;
  const left = await call('POST', `/me/driver/affiliations/${mine.id}/leave`, {
    token: driver.token,
    key: key(),
    body: { version: mine.version },
  });
  assert.deepEqual([left.status, left.body.outcome], [200, 'ended']);
  assert.equal(await audited(offer.id, 'driver.affiliation_ended'), 1);
});

test('FLT-6 and suspensions: revoking the carrier capability or suspending a resource ends eligibility at the next check, without editing the resource', async () => {
  const { person, org } = await verifiedCarrier();
  const truck = await eligibleTruck(person, org);
  const { driver, affiliation } = await affiliated(person, org);
  await driverDocuments(driver, ['fictional_class_2']);
  assert.equal((await authorise(person, org, affiliation, null)).status, 200);
  const now = clock();
  assert.equal(await driverEligibility(affiliation, truck.id, now, now), 'eligible');
  // Suspension by staff with staff_admin, with a reason.
  const suspend = async (subject: string, id: string, suspended: boolean, staff?: Staff) =>
    call('POST', '/staff/fleet/suspensions', {
      token: (staff ?? (await administrator())).token,
      body: { subject, id, suspended, reason: suspended ? 'safety_review' : null },
    });
  assert.equal((await suspend('vehicle', truck.id, true, await reviewer())).status, 403);
  assert.deepEqual((await suspend('vehicle', truck.id, true)).body, { outcome: 'changed' });
  assert.deepEqual((await suspend('vehicle', truck.id, true)).body, { outcome: 'unchanged' });
  assert.equal(await vehicleEligibility(truck.id, org, now, now), 'suspended');
  assert.deepEqual((await suspend('vehicle', truck.id, false)).body, { outcome: 'changed' });
  assert.equal(await vehicleEligibility(truck.id, org, now, now), 'eligible');
  assert.deepEqual((await suspend('driver', driver.personId, true)).body, { outcome: 'changed' });
  assert.equal(await driverEligibility(affiliation, truck.id, now, now), 'suspended');
  assert.deepEqual((await suspend('driver', driver.personId, false)).body, { outcome: 'changed' });
  assert.equal(await audited(truck.id, 'fleet.suspended'), 1);
  // The capability is withdrawn: every resource is ineligible, and none was edited.
  const before = await owner.query(
    'SELECT id, row_version, updated_at FROM trucker.vehicle WHERE id = $1',
    [truck.id],
  );
  assert.equal((await revokeCapability(org, 'carry_as_company')).status, 200);
  assert.equal(await vehicleEligibility(truck.id, org, now, now), 'carrier_not_eligible');
  assert.equal(await driverEligibility(affiliation, truck.id, now, now), 'carrier_not_eligible');
  const after = await owner.query(
    'SELECT id, row_version, updated_at FROM trucker.vehicle WHERE id = $1',
    [truck.id],
  );
  assert.deepEqual(after.rows, before.rows);
  const closed = await call('GET', fleet(org), { token: person.token });
  assert.deepEqual([closed.status, closed.body.code], [403, 'carrier_not_eligible']);
  // A former carrier can still retire a vehicle and end an affiliation.
  const retired = await call('POST', fleet(org, `/vehicles/${truck.id}/retire`), {
    token: person.token,
    key: key(),
    body: { version: truck.version },
  });
  assert.deepEqual([retired.status, retired.body.outcome], [200, 'retired']);
  assert.equal(await vehicleEligibility(truck.id, org, now, now), 'not_found');
});

test('FLT-7 and FLT-8: decisions need the reviewer privilege and independence; other organisations and the API role reach nothing', async () => {
  const first = await verifiedCarrier();
  const second = await verifiedCarrier();
  const vehicle = await registered(first.person, first.org);
  const decideAs = (staff: Staff, noConflict = true) =>
    staffDecide(
      staff,
      `vehicles/${vehicle.id}/ownership`,
      vehicle.version,
      'verified',
      'ownership_evidence_accepted',
      noConflict,
    );
  const plain = await newStaff([]);
  assert.equal((await decideAs(plain)).status, 403);
  assert.equal(
    (await call('GET', '/staff/fleet', { token: (await fresh(plain)).token })).status,
    403,
  );
  assert.equal((await call('GET', '/staff/fleet', { token: first.person.token })).status, 401);
  // A reviewer who is the carrier's own administrator cannot decide for it.
  const connected = await newStaff(['reviewer'], { link: 'declared', phone: first.person.phone });
  const own = await decideAs(connected);
  assert.deepEqual([own.status, own.body.code], [409, 'reviewer_not_independent']);
  const undeclared = await decideAs(await reviewer(), false);
  assert.deepEqual([undeclared.status, undeclared.body.code], [409, 'reviewer_not_independent']);
  const invalid = await staffDecide(
    await reviewer(),
    `vehicles/${vehicle.id}/ownership`,
    vehicle.version,
    'verified',
    'claim_not_upheld',
  );
  assert.equal(invalid.status, 422, invalid.text);
  const stale = await staffDecide(
    await reviewer(),
    `vehicles/${vehicle.id}/ownership`,
    vehicle.version + 1,
    'verified',
    'ownership_evidence_accepted',
  );
  assert.deepEqual([stale.status, stale.body.code], [409, 'fleet_record_changed']);
  assert.equal((await vehicleOf(first.person, first.org, vehicle.id)).ownership, 'claimed');
  assert.equal((await decideAs(await reviewer())).status, 200);
  const refusals = await staffAudit(connected, 'staff.fleet_ownership_decide');
  assert.deepEqual(
    refusals.map((entry) => [entry.outcome, entry.detail.reason]),
    [['refused', 'connected']],
  );
  // Another carrier's administrator, under either organisation.
  for (const [org, route] of [
    [first.org, ''],
    [first.org, `/vehicles/${vehicle.id}/documents`],
    [second.org, `/vehicles/${vehicle.id}/documents`],
    [second.org, `/vehicles/${vehicle.id}/retire`],
  ] as const) {
    const reply = await call(route === '' ? 'GET' : 'POST', fleet(org, route), {
      token: second.person.token,
      key: key(),
      ...(route === ''
        ? {}
        : { body: route.endsWith('retire') ? { version: 1 } : documentBody(TRUCK_DOCUMENTS[0]!) }),
    });
    assert.equal(reply.status, 404, `${org} ${route}: ${reply.text}`);
    assert.ok(!reply.text.includes(vehicle.registrationNumber));
  }
  assert.ok(
    !JSON.stringify(await fleetOf(second.person, second.org)).includes(vehicle.registrationNumber),
  );
  // As the API's database role: no table, no building block.
  const context = { tokenHash: hashToken(first.person.token), organisationId: first.org };
  for (const table of [
    'vehicle',
    'driver_affiliation',
    'driver_authorisation',
    'fleet_document',
    'fleet_suspension',
    'fleet_retry_key',
    'fleet_document_type',
    'licence_class',
  ])
    await refused(
      () => asApiRole(context, (client) => client.query(`SELECT * FROM trucker.${table}`)),
      /permission denied/,
    );
  for (const statement of [
    `SELECT trucker.vehicle_eligibility('${vehicle.id}', '${first.org}', now(), now(), NULL)`,
    `SELECT trucker.driver_eligibility('${vehicle.id}', NULL, now(), now())`,
    `SELECT trucker.fleet_documents_of('${vehicle.id}', true)`,
    `SELECT * FROM trucker.fleet_carrier_enter()`,
  ])
    await refused(
      () => asApiRole(context, (client) => client.query(statement)),
      /permission denied/,
    );
});

// Last: it moves the clock past document expiry.
test('a document lapses by the clock alone: eligibility ends with no worker, and a lapsed document cannot be accepted', async () => {
  const carrier = await verifiedCarrier();
  const vehicle = await registered(carrier.person, carrier.org);
  assert.equal((await verifyOwnership(vehicle)).status, 200);
  const soon = day(2);
  for (const type of TRUCK_DOCUMENTS)
    assert.equal(
      (
        await submitVehicleDocument(
          carrier.person,
          carrier.org,
          vehicle.id,
          documentBody(type, { expiryDate: type === TRUCK_DOCUMENTS[0] ? soon : day(200) }),
        )
      ).status,
      201,
    );
  const waiting = (await queue()).documents.filter((doc) => doc.vehicleId === vehicle.id);
  const insurance = waiting.find((doc) => doc.type === TRUCK_DOCUMENTS[1])!;
  const card = waiting.find((doc) => doc.type === TRUCK_DOCUMENTS[0])!;
  assert.equal(
    (
      await staffDecide(
        await reviewer(),
        `documents/${insurance.id}/decision`,
        insurance.version,
        'accepted',
        'document_accepted',
      )
    ).status,
    200,
  );
  await advance(3 * 86_400);
  const late = await staffDecide(
    await reviewer(),
    `documents/${card.id}/decision`,
    card.version,
    'accepted',
    'document_accepted',
  );
  assert.equal(late.status, 422, late.text);
  // A second vehicle whose documents were accepted in time lapses on its own.
  const person = await again(carrier.person);
  const other = await eligibleTruck(person, carrier.org);
  assert.equal(other.eligibility, 'eligible');
  await owner.query(
    `UPDATE trucker.fleet_document SET expiry_date = $2 WHERE vehicle_id = $1 AND type_code = $3`,
    [other.id, day(1), TRUCK_DOCUMENTS[1]],
  );
  assert.equal((await vehicleOf(person, carrier.org, other.id)).eligibility, 'eligible');
  await advance(86_400);
  const later = await again(carrier.person);
  assert.equal((await vehicleOf(later, carrier.org, other.id)).eligibility, 'document_expired');
  assert.equal(
    await count('fleet_document', `vehicle_id = $1 AND status = 'accepted'`, [other.id]),
    2,
  );
});
