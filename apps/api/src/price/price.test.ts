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
import { ensureQuotationFleet } from '../testing/quotation-fleet.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';

// Assignment, reservation and confirmation (slice 15). Real PostgreSQL, the API connected as
// Shipment roles and authority (slice 22). Real PostgreSQL, the API connected as its
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
const quote = async (
  person: Person,
  org: string,
  shipment: string,
  body = quoteBody(),
  retry = key(),
) => {
  await ensureQuotationFleet(owner, person.personId, org, shipment);
  return call('POST', `/organisations/${org}/discovery/shipments/${shipment}/quotations`, {
    token: person.token,
    key: retry,
    body,
  });
};
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
// ---------------------------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// Resources and bookings for these tests
// ---------------------------------------------------------------------------------------------
interface Party {
  person: Person;
  org: string;
}
// ---------------------------------------------------------------------------------------------
// Personal accounts
// ---------------------------------------------------------------------------------------------
const identity = {
  documentType: 'identity_evidence',
  documentNumber: 'ID-1',
  issuingCountry: 'XA',
};
const organiseBody = () => ({ capability: 'organise', evidence: [identity] });
async function granted(party: Party, body: Record<string, unknown>): Promise<void> {
  const application = await submitted(party.person, party.org, body);
  const reply = await decide(await reviewer(), application.id, 'verified');
  assert.equal(reply.status, 200, reply.text);
}
const asParty = <T>(party: Party, work: (client: pg.PoolClient) => Promise<T>): Promise<T> =>
  asApiRole({ tokenHash: hashToken(party.person.token), organisationId: party.org }, work);
// ---------------------------------------------------------------------------------------------
// Authority and roles
// ---------------------------------------------------------------------------------------------
const auth = (org: string, rest = ''): string => `/organisations/${org}/authorities${rest}`;
interface Authority {
  id: string;
  version: number;
  status: string;
  role: string;
  mayPublish: boolean;
  feePayerAgreed: boolean;
}
interface AuthorityOverview {
  accountCode: string;
  organiser: boolean;
  authorities: Authority[];
  arranged: { id: string; status: string; parties: Record<string, unknown> }[];
}
async function authorityOverview(party: Party): Promise<AuthorityOverview> {
  const reply = await call('GET', auth(party.org), { token: party.person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.overview as AuthorityOverview;
}
const requestAuthority = (organiser: Party, customerCode: string): Promise<Reply> =>
  call('POST', auth(organiser.org), { token: organiser.person.token, body: { customerCode } });
const decideAuthority = (
  customer: Party,
  id: string,
  body: Record<string, unknown>,
): Promise<Reply> =>
  call('POST', auth(customer.org, `/${id}/decision`), { token: customer.person.token, body });
/** An active authority from the customer to the organiser. */
async function authorised(
  organiser: Party,
  customer: Party,
  allow: { mayPublish?: boolean; feePayerAgreed?: boolean } = {},
): Promise<string> {
  const code = (await authorityOverview(customer)).accountCode;
  const asked = await requestAuthority(organiser, code);
  assert.equal(asked.status, 201, asked.text);
  const made = asked.body.authority as Authority;
  const reply = await decideAuthority(customer, made.id, {
    version: made.version,
    decision: 'accept',
    mayPublish: allow.mayPublish ?? true,
    feePayerAgreed: allow.feePayerAgreed ?? true,
  });
  assert.equal(reply.status, 200, reply.text);
  return made.id;
}
/** A verified organiser: a broker company, verified first-time for nothing but organise. */
async function broker(): Promise<Party> {
  const made = await newShipper({ legalName: 'Fixture Broker (fictional)' });
  await granted(made, organiseBody());
  return made;
}
const partiesRoute = (org: string, shipment: string): string =>
  `/organisations/${org}/shipments/${shipment}/parties`;
const setParties = (
  party: Party,
  shipment: Shipment,
  body: Record<string, unknown>,
): Promise<Reply> =>
  call('POST', partiesRoute(party.org, shipment.id), {
    token: party.person.token,
    body: {
      version: shipment.version,
      sender: 'customer',
      receiver: { name: 'Receiver Fixture (fictional)' },
      freightPayer: 'receiver',
      feePayer: 'customer',
      ...body,
    },
  });
const publish = (party: Party, shipment: Shipment): Promise<Reply> =>
  act(party.person, party.org, shipment.id, 'publish', { version: shipment.version, ...details() });
const problems = (reply: Reply): string[] =>
  (
    (reply.body.details as { problems?: { field: string; code: string }[] } | undefined)
      ?.problems ?? []
  ).map((problem) => `${problem.field}:${problem.code}`);

// ---------------------------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------------------------
const commissionRoute = (org: string, shipment: string, query = ''): string =>
  `/organisations/${org}/shipments/${shipment}/commission${query}`;
const setCommission = (
  party: Party,
  shipment: Shipment,
  body: Record<string, unknown>,
): Promise<Reply> =>
  call('POST', commissionRoute(party.org, shipment.id), {
    token: party.person.token,
    body: { version: shipment.version, ...body },
  });
const terms = (party: Party, shipment: string, query = ''): Promise<Reply> =>
  call('GET', commissionRoute(party.org, shipment, query), { token: party.person.token });
// ---------------------------------------------------------------------------------------------
// Commission contracts
// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// Price breakdown, views by role, fee payer, freight terms
// ---------------------------------------------------------------------------------------------
interface Price {
  currency: string;
  shippingPrice: string;
  fee?: { amount: string; basisPoints: number; payer: string };
  total?: string;
  commission?: {
    option: string;
    basisPoints: number | null;
    amount: string;
    contract: boolean;
  } | null;
  net?: string;
  freight: {
    payer: string | null;
    method: string | null;
    dueRule: string | null;
    dueDays: number | null;
  };
}
type Priced = Omit<Booking, 'paymentDueDays' | 'carrierNet' | 'fee' | 'shipperTotal'> & {
  price: Price;
  paymentDueDays: number | null;
  carrierNet?: string;
  fee?: Booking['fee'];
  shipperTotal?: string;
};
const bookingRoute = (org: string, id: string): string => `/organisations/${org}/bookings/${id}`;
async function bookingAs(party: Party, id: string): Promise<{ booking: Priced; text: string }> {
  const reply = await call('GET', bookingRoute(party.org, id), { token: party.person.token });
  assert.equal(reply.status, 200, reply.text);
  return { booking: reply.body.booking as Priced, text: reply.text };
}
const acceptWith = (party: Party, quotation: string, version: number, freightMethod?: string) =>
  call('POST', `/organisations/${party.org}/quotations/${quotation}/accept`, {
    token: party.person.token,
    key: key(),
    body: freightMethod === undefined ? { version } : { version, freightMethod },
  });
/** A shipper's own published shipment, open to quotations. */
async function ownShipment(shipper: Party): Promise<Shipment> {
  const made = await draft(shipper.person, shipper.org);
  const published = await publish(shipper, made);
  assert.equal(published.status, 200, published.text);
  const shipment = published.body.shipment as Shipment;
  assert.equal((await setTerms(shipper.person, shipper.org, shipment.id)).status, 200);
  return shipment;
}
const freight = (methods: string[], dueDays?: number | null) =>
  dueDays === undefined ? { methods } : { methods, dueDays };

test('PB-1: a quotation states the freight methods the carrier accepts and the days after proof of delivery, within the settings in force', async () => {
  const shipper = await verifiedShipper();
  const shipment = await ownShipment(shipper);
  const carrier = await verifiedCarrier();
  const context = await call(
    'GET',
    `/organisations/${carrier.org}/discovery/shipments/${shipment.id}/quotation`,
    {
      token: carrier.person.token,
    },
  );
  assert.equal((context.body.quotation as { freightMaxDueDays: number }).freightMaxDueDays, 15);

  for (const [given, problem] of [
    [freight([]), 'freight.methods:invalid'],
    [freight(['cheque']), 'freight.methods:invalid'],
    [freight(['bank_transfer', 'bank_transfer'], 5), 'freight.methods:invalid'],
    [freight(['card_gateway'], 5), 'freight.methods:card_gateway_not_active'],
    [freight(['bank_transfer']), 'freight.dueDays:out_of_range'],
    [freight(['bank_transfer'], 16), 'freight.dueDays:out_of_range'],
    [freight(['cash_on_delivery'], 5), 'freight.dueDays:not_applicable'],
  ] as const) {
    const reply = await quote(
      carrier.person,
      carrier.org,
      shipment.id,
      quoteBody({ freight: given }),
    );
    assert.equal(reply.status, 422, `${JSON.stringify(given)}: ${reply.text}`);
    assert.deepEqual(problems(reply), [problem], JSON.stringify(given));
  }
  assert.equal(await count('quotation', 'shipment_id = $1', [shipment.id]), 0);

  // Stated; the version shows it; a revision changes it; a reconfirmation keeps it.
  const made = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({
      freight: freight(['bank_transfer', 'cash_on_delivery'], 10),
    }),
  );
  const first = made.versions[0] as unknown as { freight: { methods: string[]; dueDays: number } };
  assert.deepEqual(first.freight, { methods: ['cash_on_delivery', 'bank_transfer'], dueDays: 10 });
  const revised = await call(
    'POST',
    `/organisations/${carrier.org}/quotations/${made.id}/revisions`,
    {
      token: carrier.person.token,
      key: key(),
      body: { version: 1, ...quoteBody({ freight: freight(['cash_on_delivery']) }) },
    },
  );
  assert.equal(revised.status, 200, revised.text);
  const stored = await owner.query<{ methods: string[]; days: number | null }>(
    `SELECT freight_methods AS methods, freight_due_days AS days FROM trucker.quotation_version
     WHERE quotation_id = $1 ORDER BY version_no`,
    [made.id],
  );
  assert.deepEqual(stored.rows, [
    { methods: ['cash_on_delivery', 'bank_transfer'], days: 10 },
    { methods: ['cash_on_delivery'], days: null },
  ]);

  // A material change by the shipper: the reconfirmation keeps the freight terms of the version.
  const changed = await act(shipper.person, shipper.org, shipment.id, 'published-changes', {
    ...content({ grossWeightKg: '13000' }),
    publication: details(),
    version: shipment.version,
  });
  assert.equal(changed.status, 200, changed.text);
  const reconfirmed = await call(
    'POST',
    `/organisations/${carrier.org}/quotations/${made.id}/reconfirm`,
    {
      token: carrier.person.token,
      key: key(),
      body: { version: 2 },
    },
  );
  assert.equal(reconfirmed.status, 200, reconfirmed.text);
  const third = await owner.query<{ methods: string[]; days: number | null }>(
    `SELECT freight_methods AS methods, freight_due_days AS days FROM trucker.quotation_version
     WHERE quotation_id = $1 AND version_no = 3`,
    [made.id],
  );
  assert.deepEqual(third.rows, [{ methods: ['cash_on_delivery'], days: null }]);

  // Left out: bank transfer within the days in force (a development default).
  const other = await verifiedCarrier();
  const plain = await quoted(other.person, other.org, shipment.id);
  assert.deepEqual((plain.versions[0] as unknown as { freight: unknown }).freight, {
    methods: ['bank_transfer'],
    dueDays: 15,
  });
  // The table refuses terms that do not hang together.
  await refused(
    () =>
      owner.query(
        `UPDATE trucker.quotation_version SET freight_due_days = NULL WHERE quotation_id = $1`,
        [plain.id],
      ),
    /./,
  );
});

test('PB-2: the customer chooses one of the offered freight methods when accepting; the booking fixes the method and its due rule', async () => {
  const shipper = await verifiedShipper();
  const shipment = await ownShipment(shipper);
  const carrier = await verifiedCarrier();
  const made = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({
      freight: freight(['cash_on_delivery', 'bank_transfer'], 10),
    }),
  );
  // Two methods offered: the customer must choose, and only one of those.
  const none = await acceptWith(shipper, made.id, 1);
  assert.deepEqual([none.status, problems(none)], [422, ['freightMethod:required']]);
  const other = await acceptWith(shipper, made.id, 1, 'card_gateway');
  assert.deepEqual([other.status, problems(other)], [422, ['freightMethod:not_offered']]);
  assert.equal(await count('booking', 'shipment_id = $1', [shipment.id]), 0);
  const done = await acceptWith(shipper, made.id, 1, 'cash_on_delivery');
  assert.equal(done.status, 200, done.text);
  const booking = done.body.booking as Priced;
  assert.deepEqual(booking.price.freight, {
    payer: 'customer',
    method: 'cash_on_delivery',
    dueRule: 'on_delivery',
    dueDays: null,
  });
  assert.equal(booking.paymentDueDays, null);

  // One method offered: taken without asking; the days come from the quotation.
  const second = await verifiedShipper();
  const shipment2 = await ownShipment(second);
  const made2 = await quoted(
    carrier.person,
    carrier.org,
    shipment2.id,
    quoteBody({
      freight: freight(['bank_transfer'], 7),
    }),
  );
  const done2 = await acceptWith(second, made2.id, 1);
  assert.equal(done2.status, 200, done2.text);
  const booking2 = done2.body.booking as Priced;
  assert.deepEqual(
    [
      booking2.price.freight.method,
      booking2.price.freight.dueRule,
      booking2.price.freight.dueDays,
      booking2.paymentDueDays,
    ],
    ['bank_transfer', 'after_proof_of_delivery', 7, 7],
  );
  // Fixed on the booking: not changed by anyone.
  await refused(
    () =>
      owner.query(`UPDATE trucker.booking SET freight_method = 'bank_transfer' WHERE id = $1`, [
        booking.id,
      ]),
    /cannot be changed/,
  );
});

test('PB-3: one price record, exact to the minor unit; the fee is paid by the shipment fee payer; each role is shown only its own figures', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  // The organiser pays Trucker's fee, by its own act (slice 22), and takes 10%.
  const authority = await authorised(organiser, customer);
  const made = await draft(organiser.person, organiser.org);
  assert.equal(
    (await setParties(organiser, made, { customerAuthorityId: authority, feePayer: 'organiser' }))
      .status,
    200,
  );
  assert.equal(
    (await setCommission(organiser, made, { option: 'percentage', basisPoints: 1000 })).status,
    200,
  );
  const published = await publish(organiser, made);
  assert.equal(published.status, 200, published.text);
  const shipment = published.body.shipment as Shipment;
  assert.equal((await setTerms(organiser.person, organiser.org, shipment.id)).status, 200);
  const carrier = await verifiedCarrier();
  const quotation = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({
      commissionAccepted: { commission: '125.05', net: '1125.45' },
    }),
  );
  const accepted = await acceptWith(customer, quotation.id, 1);
  assert.equal(accepted.status, 200, accepted.text);
  const id = (accepted.body.booking as Priced).id;

  // The record: every part, adding up.
  const row = (
    await owner.query<Record<string, unknown>>(
      `SELECT made_before_breakdown AS before, shipping_amount::text AS price, commission_option AS option,
              commission_amount::text AS commission, carrier_net::text AS net, fee_basis_points AS points,
              fee_amount::text AS fee, fee_payer AS payer, fee_payer_organisation_id AS payer_id,
              customer_total::text AS total, freight_payer AS freight_payer, freight_method AS method,
              financial_setting_version_id IS NOT NULL AS versioned
       FROM trucker.booking_price WHERE booking_id = $1`,
      [id],
    )
  ).rows[0]!;
  assert.deepEqual(row, {
    before: false,
    price: '1250.50',
    option: 'percentage',
    commission: '125.05',
    net: '1125.45',
    points: 300,
    fee: '37.52',
    payer: 'organiser',
    payer_id: organiser.org,
    total: '1250.50',
    freight_payer: 'receiver',
    method: 'bank_transfer',
    versioned: true,
  });

  // The customer: the shipping price, the fee and who pays it, its own total. No commission.
  const asCustomer = await bookingAs(customer, id);
  assert.deepEqual(
    [
      asCustomer.booking.price.shippingPrice,
      asCustomer.booking.price.fee,
      asCustomer.booking.price.total,
    ],
    [
      '1250.50',
      {
        method: 'percentage_of_shipping_price',
        basisPoints: 300,
        amount: '37.52',
        payer: 'organiser',
      },
      '1250.50',
    ],
  );
  assert.deepEqual(
    [asCustomer.booking.shipperTotal, asCustomer.booking.carrierNet, asCustomer.booking.price.net],
    ['1250.50', undefined, undefined],
  );
  assert.doesNotMatch(asCustomer.text, /commission|1125\.45|125\.05/i);

  // The carrier: the price, the commission and its net. Not the fee nor the customer's total.
  const asCarrier = await bookingAs(carrier, id);
  assert.deepEqual(
    [asCarrier.booking.price.commission, asCarrier.booking.price.net, asCarrier.booking.carrierNet],
    [
      { option: 'percentage', basisPoints: 1000, contract: false, amount: '125.05' },
      '1125.45',
      '1125.45',
    ],
  );
  assert.deepEqual(
    [
      asCarrier.booking.price.fee,
      asCarrier.booking.price.total,
      asCarrier.booking.fee,
      asCarrier.booking.shipperTotal,
    ],
    [undefined, undefined, undefined, undefined],
  );
  assert.doesNotMatch(asCarrier.text, /37\.52|"total"/);

  // The organiser: the price, the commission, the net, and the fee it pays. Not a party to
  // the booking, it reads this on its own shipment.
  assert.equal(
    (await call('GET', bookingRoute(organiser.org, id), { token: organiser.person.token })).status,
    404,
  );
  const asOrganiser = await terms(organiser, shipment.id);
  assert.equal(asOrganiser.status, 200, asOrganiser.text);
  const organiserPrice = asOrganiser.body.bookedPrice as Price;
  assert.deepEqual(
    [
      organiserPrice.shippingPrice,
      organiserPrice.commission?.amount,
      organiserPrice.net,
      organiserPrice.fee?.amount,
      organiserPrice.total,
    ],
    ['1250.50', '125.05', '1125.45', '37.52', undefined],
  );

  // Staff: everything.
  const staff = await newStaff(['reviewer']);
  const asStaff = await call('GET', `/staff/bookings/${id}/detail`, { token: staff.token });
  assert.equal(asStaff.status, 200, asStaff.text);
  const staffPrice = (asStaff.body.booking as Priced).price;
  assert.deepEqual(
    [staffPrice.total, staffPrice.net, staffPrice.fee?.payer, staffPrice.commission?.amount],
    ['1250.50', '1125.45', 'organiser', '125.05'],
  );

  // Never changed, and a record that does not add up is refused before anything else.
  await refused(
    () =>
      owner.query('UPDATE trucker.booking_price SET carrier_net = 1 WHERE booking_id = $1', [id]),
    /never changed/,
  );
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.booking_price
           (booking_id, made_before_breakdown, currency_code, minor_units, rounding, shipping_amount,
            commission_amount, carrier_net, fee_method, fee_basis_points, fee_amount, fee_payer,
            fee_payer_organisation_id, customer_total, recorded_at)
         VALUES ($1, true, 'XTS', 2, 'half_up', 100, 0, 99, 'percentage_of_shipping_price', 300, 3, 'customer',
                 $2, 103, now())`,
        [id, customer.org],
      ),
    /booking_price_adds_up/,
  );
  // The API's role reaches no row.
  await refused(
    () => asParty(customer, (client) => client.query('SELECT * FROM trucker.booking_price')),
    /permission denied/,
  );
});

test('PB-4: the customer pays the fee where it is the fee payer; the acceptance preview shows its total and the offered freight terms', async () => {
  const shipper = await verifiedShipper();
  const shipment = await ownShipment(shipper);
  const carrier = await verifiedCarrier();
  await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ freight: freight(['bank_transfer'], 12) }),
  );
  // What acceptance would fix, shown to the shipper before it accepts.
  const overview = await call('GET', shipments(shipper.org, `/${shipment.id}/booking`), {
    token: shipper.person.token,
  });
  assert.equal(overview.status, 200, overview.text);
  const preview = (overview.body.acceptance as Record<string, unknown>[])[0]!;
  assert.deepEqual(
    [
      preview.shipperTotal,
      (preview.fee as { payer: string }).payer,
      preview.paymentDueDays,
      preview.freight,
    ],
    ['1288.02', 'shipper', 12, { methods: ['bank_transfer'], dueDays: 12 }],
  );
  const id = preview.quotationId as string;
  const done = await acceptWith(shipper, id, 1);
  const booking = done.body.booking as Priced;
  assert.deepEqual(
    [booking.price.fee?.payer, booking.price.total, booking.shipperTotal],
    ['customer', '1288.02', '1288.02'],
  );
});
