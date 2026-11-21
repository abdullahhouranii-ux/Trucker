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
const accept = (person: Person, org: string, quotation: string, version: number, retry = key()) =>
  call('POST', `/organisations/${org}/quotations/${quotation}/accept`, {
    token: person.token,
    key: retry,
    body: { version },
  });
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
const quotationsOf = (party: Party, shipment: string): Promise<Reply> =>
  call('GET', `/organisations/${party.org}/shipments/${shipment}/quotations`, {
    token: party.person.token,
  });
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
interface Line {
  role: string;
  shippingPrice: string;
  commission: string;
  net: string;
  quotationId?: string;
  bookingId?: string;
}
async function commissions(party: Party): Promise<{ quotations: Line[]; bookings: Line[] }> {
  const reply = await call('GET', `/organisations/${party.org}/commissions`, {
    token: party.person.token,
  });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.commissions as { quotations: Line[]; bookings: Line[] };
}
/** A published shipment the organiser arranged for the customer, carrying this commission. */
async function commissioned(
  organiser: Party,
  customer: Party,
  commission: Record<string, unknown>,
) {
  const authority = await authorised(organiser, customer);
  const made = await draft(organiser.person, organiser.org);
  const set = await setParties(organiser, made, { customerAuthorityId: authority });
  assert.equal(set.status, 200, set.text);
  const saved = await setCommission(organiser, made, commission);
  assert.equal(saved.status, 200, saved.text);
  const reply = await publish(organiser, made);
  assert.equal(reply.status, 200, reply.text);
  const shipment = reply.body.shipment as Shipment;
  assert.equal((await setTerms(organiser.person, organiser.org, shipment.id)).status, 200);
  return shipment;
}
const refusal = (reply: Reply): Record<string, unknown> =>
  (reply.body.details ?? {}) as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Commission contracts
// ---------------------------------------------------------------------------------------------
interface Contract {
  id: string;
  version: number;
  status: string;
  role: string;
  option: string;
  basisPoints: number | null;
  amount: string | null;
  currency: string | null;
  earningCondition: string;
  settlementDays: number;
  endedBy: string | null;
}
interface Contracts {
  accountCode: string;
  organiser: boolean;
  carrier: boolean;
  contracts: Contract[];
}
const contractsRoute = (org: string, rest = ''): string =>
  `/organisations/${org}/commission-contracts${rest}`;
async function contractsOf(party: Party): Promise<Contracts> {
  const reply = await call('GET', contractsRoute(party.org), { token: party.person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.contracts as Contracts;
}
const tenPercent = { option: 'percentage', basisPoints: 1000, settlementDays: 7 };
const propose = (
  organiser: Party,
  carrierCode: string,
  terms: Record<string, unknown> = tenPercent,
) =>
  call('POST', contractsRoute(organiser.org), {
    token: organiser.person.token,
    body: { carrierCode, ...terms },
  });
const decideContract = (
  party: Party,
  contract: Contract,
  decision: string,
  version = contract.version,
) =>
  call('POST', contractsRoute(party.org, `/${contract.id}/decision`), {
    token: party.person.token,
    body: { version, decision },
  });
const endContract = (party: Party, contract: Contract, version = contract.version) =>
  call('POST', contractsRoute(party.org, `/${contract.id}/end`), {
    token: party.person.token,
    body: { version },
  });
/** The one contract in force for this party (contracts listed at one instant have no fixed order). */
const inForce = async (party: Party): Promise<Contract> => {
  const active = (await contractsOf(party)).contracts.filter((item) => item.status === 'active');
  assert.equal(active.length, 1);
  return active[0]!;
};
/** A contract in force between the organiser and the carrier, on these terms. */
async function contracted(
  organiser: Party,
  carrier: Party,
  terms: Record<string, unknown> = tenPercent,
): Promise<Contract> {
  const proposed = await propose(organiser, (await contractsOf(carrier)).accountCode, terms);
  assert.equal(proposed.status, 201, proposed.text);
  const made = proposed.body.contract as Contract;
  const reply = await decideContract(carrier, made, 'accept');
  assert.equal(reply.status, 200, reply.text);
  return reply.body.contract as Contract;
}
const reconfirm = (party: Party, quotation: string, body: Record<string, unknown>) =>
  call('POST', `/organisations/${party.org}/quotations/${quotation}/reconfirm`, {
    token: party.person.token,
    key: key(),
    body,
  });
const revise = (party: Party, quotation: string, body: Record<string, unknown>) =>
  call('POST', `/organisations/${party.org}/quotations/${quotation}/revisions`, {
    token: party.person.token,
    key: key(),
    body,
  });
/** A material change by the organiser: open quotations then need reconfirmation. */
async function materialChange(
  organiser: Party,
  shipment: Shipment,
  weight: string,
): Promise<Shipment> {
  const reply = await act(organiser.person, organiser.org, shipment.id, 'published-changes', {
    ...content({ grossWeightKg: weight }),
    publication: details(),
    version: shipment.version,
  });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.shipment as Shipment;
}
const viewShipment = async (party: Party, id: string): Promise<Shipment> => {
  const reply = await call('GET', shipments(party.org, `/${id}`), { token: party.person.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.shipment as Shipment;
};
const quotationRows = async (quotation: string) =>
  (
    await owner.query<{
      version: number;
      commission: string;
      net: string;
      contract: string | null;
    }>(
      `SELECT version_no AS version, trucker.amount_text(commission_amount, minor_units) AS commission,
              trucker.amount_text(net_amount, minor_units) AS net,
              contract_id AS contract
       FROM trucker.quotation_commission WHERE quotation_id = $1 ORDER BY version_no`,
      [quotation],
    )
  ).rows;

test('CC-1: an organiser proposes a contract to a carrier by its code; nothing applies until the carrier accepts; either side ends it; its terms never change', async () => {
  const organiser = await broker();
  const carrier = await verifiedCarrier();
  const shipper = await verifiedShipper();
  const carrierCode = (await contractsOf(carrier)).accountCode;
  assert.match(carrierCode, /^TR[0-9A-F]{10}$/);

  // A code that names nothing, the organiser itself, or an account that is not a carrier.
  for (const code of [
    'TR0000000000',
    (await contractsOf(organiser)).accountCode,
    (await contractsOf(shipper)).accountCode,
  ]) {
    const reply = await propose(organiser, code);
    assert.deepEqual([reply.status, reply.body.code], [404, 'account_code_not_found'], code);
  }
  // Only an organiser proposes.
  const notOrganiser = await propose(shipper, carrierCode);
  assert.deepEqual([notOrganiser.status, notOrganiser.body.code], [403, 'organiser_not_eligible']);
  // Terms outside the limits.
  for (const [terms, problem] of [
    [{ ...tenPercent, basisPoints: 2501 }, 'basisPoints:out_of_range'],
    [{ ...tenPercent, settlementDays: 0 }, 'settlementDays:out_of_range'],
    [{ ...tenPercent, settlementDays: 61 }, 'settlementDays:out_of_range'],
    [{ option: 'fixed', amount: '50', currency: 'QQQ', settlementDays: 7 }, 'currency:unavailable'],
    [{ option: 'fixed', amount: '0', currency: 'XTS', settlementDays: 7 }, 'amount:invalid'],
  ] as const) {
    const reply = await propose(organiser, carrierCode, terms);
    assert.equal(reply.status, 422, reply.text);
    assert.deepEqual(problems(reply), [problem]);
  }
  assert.equal(
    await count('commission_contract', 'organiser_organisation_id = $1', [organiser.org]),
    0,
  );

  const proposed = await propose(organiser, carrierCode.toLowerCase());
  assert.equal(proposed.status, 201, proposed.text);
  const made = proposed.body.contract as Contract;
  assert.deepEqual(
    [
      made.status,
      made.role,
      made.option,
      made.basisPoints,
      made.earningCondition,
      made.settlementDays,
    ],
    ['proposed', 'organiser', 'percentage', 1000, 'freight_receipt_recorded', 7],
  );
  // One open contract a pair: a second proposal answers with the first.
  const again = await propose(organiser, carrierCode, { ...tenPercent, basisPoints: 500 });
  assert.equal(again.body.outcome, 'already_proposed');
  assert.equal((again.body.contract as Contract).id, made.id);
  assert.equal(
    await count('commission_contract', 'organiser_organisation_id = $1', [organiser.org]),
    1,
  );

  // Only the carrier decides; the shipper sees nothing of it.
  assert.equal((await decideContract(organiser, made, 'accept')).status, 404);
  assert.deepEqual((await contractsOf(shipper)).contracts, []);
  const seen = (await contractsOf(carrier)).contracts;
  assert.deepEqual(
    seen.map((item) => [item.id, item.role, item.status]),
    [[made.id, 'carrier', 'proposed']],
  );
  const stale = await decideContract(carrier, made, 'accept', made.version + 1);
  assert.deepEqual([stale.status, stale.body.code], [409, 'record_changed']);
  const accepted = await decideContract(carrier, made, 'accept');
  assert.equal(accepted.status, 200, accepted.text);
  const active = accepted.body.contract as Contract;
  assert.equal(active.status, 'active');
  assert.equal((await decideContract(carrier, active, 'decline')).body.outcome, 'already_decided');
  assert.equal(
    await count('audit_entry', "record_id = $1 AND action LIKE 'commission_contract.%'", [made.id]),
    4,
  );

  // The terms are never changed, by anyone; the role the API runs as reaches no row.
  await refused(
    () =>
      owner.query('UPDATE trucker.commission_contract SET basis_points = 500 WHERE id = $1', [
        made.id,
      ]),
    /never changed/,
  );
  await refused(
    () => owner.query('DELETE FROM trucker.commission_contract WHERE id = $1', [made.id]),
    /never changed/,
  );
  await refused(
    () => asParty(carrier, (client) => client.query('SELECT * FROM trucker.commission_contract')),
    /permission denied/,
  );

  // The carrier ends it; it stays ended; a new one may then be proposed.
  const ended = await endContract(carrier, active);
  assert.equal(ended.status, 200, ended.text);
  assert.deepEqual(
    [(ended.body.contract as Contract).status, (ended.body.contract as Contract).endedBy],
    ['ended', 'carrier'],
  );
  assert.equal(
    (await endContract(organiser, ended.body.contract as Contract)).body.outcome,
    'already_ended',
  );
  await refused(
    () =>
      owner.query("UPDATE trucker.commission_contract SET status = 'active' WHERE id = $1", [
        made.id,
      ]),
    /never changed/,
  );
  const next = await propose(organiser, carrierCode, {
    option: 'fixed',
    amount: '50',
    currency: 'XTS',
    settlementDays: 14,
  });
  assert.equal(next.status, 201, next.text);
  const declined = await decideContract(carrier, next.body.contract as Contract, 'decline');
  assert.equal((declined.body.contract as Contract).status, 'declined');
});

test('CC-2: under the contract option each carrier quotes with the commission of its own contract; a carrier with none in force cannot quote; the exact figures are still accepted; the customer is told nothing', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  const percent = await verifiedCarrier();
  const fixed = await verifiedCarrier();
  const none = await verifiedCarrier();
  const pending = await verifiedCarrier();
  const percentContract = await contracted(organiser, percent);
  await contracted(organiser, fixed, {
    option: 'fixed',
    amount: '50',
    currency: 'XTS',
    settlementDays: 30,
  });
  assert.equal((await propose(organiser, (await contractsOf(pending)).accountCode)).status, 201);
  const shipment = await commissioned(organiser, customer, { option: 'contract' });

  // What each carrier is told before it prices.
  const told = await terms(percent, shipment.id, '?amount=1250.50&currency=XTS');
  assert.equal(told.status, 200, told.text);
  assert.equal((told.body.commission as { option: string }).option, 'contract');
  assert.equal((told.body.contract as Contract).id, percentContract.id);
  assert.deepEqual(told.body.figures, {
    state: 'ok',
    commission: '125.05',
    net: '1125.45',
    currency: 'XTS',
  });
  for (const party of [none, pending]) {
    const reply = await terms(party, shipment.id, '?amount=1250.50&currency=XTS');
    assert.equal(reply.body.contract, null);
    assert.equal((reply.body.figures as { state: string }).state, 'no_contract');
    const refusedQuote = await quote(
      party.person,
      party.org,
      shipment.id,
      quoteBody({
        commissionAccepted: { commission: '125.05', net: '1125.45' },
      }),
    );
    assert.deepEqual(
      [refusedQuote.status, refusedQuote.body.code],
      [409, 'commission_contract_required'],
      refusedQuote.text,
    );
  }
  assert.equal(await count('quotation', 'shipment_id = $1', [shipment.id]), 0);

  // A contract does not replace the acceptance of the figures for this price.
  const unaccepted = await quote(percent.person, percent.org, shipment.id);
  assert.deepEqual(
    [unaccepted.status, unaccepted.body.code],
    [409, 'commission_acceptance_required'],
  );
  assert.deepEqual(refusal(unaccepted), { commission: '125.05', net: '1125.45' });
  const q1 = await quoted(
    percent.person,
    percent.org,
    shipment.id,
    quoteBody({
      commissionAccepted: { commission: '125.05', net: '1125.45' },
    }),
  );
  const q2 = await quoted(
    fixed.person,
    fixed.org,
    shipment.id,
    quoteBody({
      commissionAccepted: { commission: '50.00', net: '1200.50' },
    }),
  );
  assert.deepEqual(await quotationRows(q1.id), [
    { version: 1, commission: '125.05', net: '1125.45', contract: percentContract.id },
  ]);
  assert.equal((await quotationRows(q2.id))[0]!.commission, '50.00');

  // The organiser reads both; each carrier its own; the customer none, and not the terms.
  // Two quotations made at the same instant: compared without regard to order.
  const lines = (await commissions(organiser)).quotations
    .map((line) => `${line.commission}/${line.net}`)
    .sort();
  assert.deepEqual(lines, ['125.05/1125.45', '50.00/1200.50']);
  assert.equal((await commissions(fixed)).quotations.length, 1);
  assert.deepEqual(await commissions(customer), { quotations: [], bookings: [] });
  assert.equal((await terms(customer, shipment.id)).status, 404);
  const read = await quotationsOf(customer, shipment.id);
  assert.equal(read.status, 200, read.text);
  assert.doesNotMatch(read.text, /commission|contract|1125\.45|1200\.50/i);
});

test('CC-3: ending a contract stops new quotations, revisions and reconfirmations under it; what was accepted stays, through to the booking; a new contract must be accepted again', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  const carrier = await verifiedCarrier();
  const first = await contracted(organiser, carrier);
  let shipment = await commissioned(organiser, customer, { option: 'contract' });
  const q = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({
      commissionAccepted: { commission: '125.05', net: '1125.45' },
    }),
  );

  // While the same contract is in force, a reconfirmation needs nothing more.
  shipment = await materialChange(organiser, shipment, '13000');
  const kept = await reconfirm(carrier, q.id, { version: 1 });
  assert.equal(kept.status, 200, kept.text);
  assert.deepEqual(
    (await quotationRows(q.id)).map((row) => [row.version, row.commission, row.contract]),
    [
      [1, '125.05', first.id],
      [2, '125.05', first.id],
    ],
  );

  // The organiser ends the contract: no revision, no reconfirmation, no new quotation.
  const ended = await endContract(organiser, await inForce(organiser));
  assert.equal(ended.status, 200, ended.text);
  const revised = await revise(carrier, q.id, {
    version: 2,
    ...quoteBody({ amount: '2000', commissionAccepted: { commission: '200.00', net: '1800.00' } }),
  });
  assert.deepEqual(
    [revised.status, revised.body.code],
    [409, 'commission_contract_required'],
    revised.text,
  );
  await materialChange(organiser, shipment, '14000');
  const noContract = await reconfirm(carrier, q.id, { version: 2 });
  assert.deepEqual(
    [noContract.status, noContract.body.code],
    [409, 'commission_contract_required'],
  );
  assert.equal((await quotationRows(q.id)).length, 2);

  // A new contract on the same terms: the figures are equal, but it is another contract, so
  // reconfirming needs them accepted again.
  const same = await contracted(organiser, carrier);
  const askedSame = await reconfirm(carrier, q.id, { version: 2 });
  assert.deepEqual(
    [askedSame.status, askedSame.body.code],
    [409, 'commission_acceptance_required'],
    askedSame.text,
  );
  assert.deepEqual(refusal(askedSame), { commission: '125.05', net: '1125.45' });
  const doneSame = await reconfirm(carrier, q.id, {
    version: 2,
    commissionAccepted: { commission: '125.05', net: '1125.45' },
  });
  assert.equal(doneSame.status, 200, doneSame.text);
  assert.deepEqual((await quotationRows(q.id))[2], {
    version: 3,
    commission: '125.05',
    net: '1125.45',
    contract: same.id,
  });

  // A new contract on other terms: reconfirming needs the new figures accepted.
  await materialChange(organiser, await viewShipment(organiser, shipment.id), '15000');
  assert.equal((await endContract(carrier, await inForce(carrier))).status, 200);
  const second = await contracted(organiser, carrier, { ...tenPercent, basisPoints: 500 });
  const asked = await reconfirm(carrier, q.id, { version: 3 });
  assert.deepEqual(
    [asked.status, asked.body.code],
    [409, 'commission_acceptance_required'],
    asked.text,
  );
  assert.deepEqual(refusal(asked), { commission: '62.53', net: '1187.97' });
  const done = await reconfirm(carrier, q.id, {
    version: 3,
    commissionAccepted: { commission: '62.53', net: '1187.97' },
  });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual((await quotationRows(q.id))[3], {
    version: 4,
    commission: '62.53',
    net: '1187.97',
    contract: second.id,
  });

  // The customer accepts; the booking keeps the commission and the contract it came from.
  const booked = await accept(customer.person, customer.org, q.id, 4);
  assert.equal(booked.status, 200, booked.text);
  const booking = (booked.body.booking as Booking).id;
  const row = (
    await owner.query<{ commission: string; contract: string }>(
      'SELECT commission_amount::text AS commission, contract_id AS contract FROM trucker.booking_commission WHERE booking_id = $1',
      [booking],
    )
  ).rows[0]!;
  assert.deepEqual(row, { commission: '62.53', contract: second.id });
  // Ending the contract later changes nothing recorded.
  assert.equal((await endContract(carrier, await inForce(carrier))).status, 200);
  assert.equal((await commissions(carrier)).bookings[0]!.commission, '62.53');
});

test('CC-4: a contract being ended while a quotation under it waits is decided one way or the other, never half', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  const carrier = await verifiedCarrier();
  const contract = await contracted(organiser, carrier);
  const shipment = await commissioned(organiser, customer, { option: 'contract' });
  // The end is held open while the quotation is sent; the quotation must wait for it.
  const holder = await owner.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(
      "UPDATE trucker.commission_contract SET status = 'ended', ended_at = now(), ended_by = 'organiser', row_version = row_version + 1 WHERE id = $1",
      [contract.id],
    );
    const waiting = quote(
      carrier.person,
      carrier.org,
      shipment.id,
      quoteBody({
        commissionAccepted: { commission: '125.05', net: '1125.45' },
      }),
    );
    let seen = 0;
    for (let attempt = 0; attempt < 100 && seen === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen = (
        await owner.query(
          "SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE NOT l.granted AND c.relname = 'commission_contract'",
        )
      ).rowCount!;
      if (seen === 0)
        seen = (
          await owner.query(
            "SELECT 1 FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted",
          )
        ).rowCount!;
    }
    assert.ok(seen > 0, 'the quotation waits for the contract being ended');
    await holder.query('COMMIT');
    const reply = await waiting;
    assert.deepEqual(
      [reply.status, reply.body.code],
      [409, 'commission_contract_required'],
      reply.text,
    );
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
  assert.equal(await count('quotation', 'shipment_id = $1', [shipment.id]), 0);
});
