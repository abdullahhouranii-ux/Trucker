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
import { restoreFinancialSettings } from '../testing/financial.js';
import { hashToken } from '../identity/secrets.js';
import { DEMONSTRATION_TERMS_VERSION } from '../identity/terms.js';
import { createTestClock } from '../testing/test-clock.js';
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
// ---------------------------------------------------------------------------------------------
// Financial settings
// ---------------------------------------------------------------------------------------------
interface Setting {
  id: string;
  versionNo: number;
  version: number;
  status: string;
  state: string;
  developmentDefault: boolean;
  feeBasisPoints: number;
  commissionOptions: string[];
  commissionMaxBasisPoints: number;
  commissionSettlementMaxDays: number;
  freightDueDays: number;
  feePaymentHours: number;
  effectiveAt: string | null;
}
interface Overview {
  now: string;
  inForce: Setting;
  versions: Setting[];
}
async function settingsOf(staff: Staff): Promise<Overview> {
  const reply = await call('GET', '/staff/financial-settings', { token: staff.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.settings as Overview;
}
const values = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  feeBasisPoints: 450,
  commissionOptions: ['percentage', 'fixed', 'contract'],
  commissionMaxBasisPoints: 2000,
  commissionSettlementMaxDays: 30,
  freightDueDays: 20,
  feePaymentHours: 8,
  note: 'Test change (fictional)',
  effectiveFrom: null,
  ...over,
});
const draftSetting = (staff: Staff, body = values(), retry = key()) =>
  call('POST', '/staff/financial-settings', { token: staff.token, key: retry, body });
const moveSetting = (staff: Staff, setting: Setting, move: string, version = setting.version) =>
  call('POST', `/staff/financial-settings/${setting.id}/moves`, {
    token: staff.token,
    body: { version, move },
  });
/** A version drafted by one administrator and approved by another. */
async function approved(drafter: Staff, approver: Staff, body = values()): Promise<Setting> {
  const drafted = await draftSetting(drafter, body);
  assert.equal(drafted.status, 201, drafted.text);
  const reply = await moveSetting(approver, drafted.body.setting as Setting, 'approve');
  assert.equal(reply.status, 200, reply.text);
  return reply.body.setting as Setting;
}
/** Times come in the database server's zone; compared as instants. */
const instant = (value: string | null): string | null =>
  value === null ? null : new Date(value).toISOString();
const iso = (offsetSeconds: number): string =>
  new Date(clock().getTime() + offsetSeconds * 1000).toISOString();
/** A shipper's published shipment with one quotation, ready to be accepted. */
async function offer(amount = '1000') {
  const shipper = await verifiedShipper();
  const made = await draft(shipper.person, shipper.org);
  const published = await publish(shipper, made);
  assert.equal(published.status, 200, published.text);
  const shipment = published.body.shipment as Shipment;
  assert.equal((await setTerms(shipper.person, shipper.org, shipment.id)).status, 200);
  const carrier = await verifiedCarrier();
  const quotation = await quoted(carrier.person, carrier.org, shipment.id, quoteBody({ amount }));
  return { shipper, quotation };
}
async function book(made: Awaited<ReturnType<typeof offer>>): Promise<Booking> {
  const reply = await accept(made.shipper.person, made.shipper.org, made.quotation.id, 1);
  assert.equal(reply.status, 200, reply.text);
  return reply.body.booking as Booking;
}
const bookingRoute = (org: string, id: string): string => `/organisations/${org}/bookings/${id}`;
const versionOf = async (booking: string): Promise<string> =>
  (
    await owner.query<{ v: string }>(
      'SELECT financial_setting_version_id AS v FROM trucker.booking WHERE id = $1',
      [booking],
    )
  ).rows[0]!.v;
const staffAudit = async (action: string, outcome: string, actor: string): Promise<number> =>
  Number(
    (
      await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM trucker.staff_audit_entry
         WHERE action = $1 AND outcome = $2 AND actor_staff_id = $3`,
        [action, outcome, actor],
      )
    ).rows[0]!.n,
  );
const ready = async (): Promise<boolean> =>
  (await owner.query<{ r: boolean }>('SELECT trucker.financial_settings_ready() AS r')).rows[0]!.r;

test('FS-1: one administrator drafts and another approves; bookings from then use the new version and record it; earlier bookings keep their figures and their version; nothing written is ever changed', async () => {
  const first = await newStaff(['staff_admin']);
  const second = await newStaff(['staff_admin']);
  const reviewer = await newStaff(['reviewer']);
  const participant = await verifiedShipper();

  // Only an administrator reads or drafts; a reviewer's attempt is recorded.
  const denied = await call('GET', '/staff/financial-settings', { token: reviewer.token });
  assert.deepEqual([denied.status, denied.body.code], [403, 'staff_privilege_required']);
  assert.equal(await staffAudit('staff.financial_settings', 'refused', reviewer.id), 1);
  assert.equal((await draftSetting(reviewer)).status, 403);
  assert.equal(
    (await call('GET', '/staff/financial-settings', { token: participant.person.token })).status,
    401,
  );

  // In development a default is in force, and it does not count as approved.
  const start = await settingsOf(first);
  assert.deepEqual(
    [
      start.inForce.developmentDefault,
      start.inForce.state,
      start.inForce.feeBasisPoints,
      start.inForce.freightDueDays,
      start.inForce.feePaymentHours,
    ],
    [true, 'in_force', 300, 15, 12],
  );
  assert.equal(await ready(), false);
  const before = await offer();
  const earlier = await book(before);
  assert.deepEqual(
    [earlier.fee.basisPoints, earlier.fee.amount, earlier.paymentDueDays],
    [300, '30.00', 15],
  );
  assert.equal(await versionOf(earlier.id), start.inForce.id);

  // Each value is judged, and a draft needs a retry key.
  const bad = await draftSetting(
    first,
    values({
      feeBasisPoints: 5001,
      commissionOptions: ['percentage', 'percentage'],
      commissionMaxBasisPoints: 0,
      commissionSettlementMaxDays: 366,
      freightDueDays: -1,
      feePaymentHours: 169,
      note: '   ',
      effectiveFrom: '2026-06-01 09:00',
    }),
  );
  assert.equal(bad.status, 422, bad.text);
  assert.deepEqual(problems(bad).sort(), [
    'commissionMaxBasisPoints:out_of_range',
    'commissionOptions:invalid',
    'commissionSettlementMaxDays:out_of_range',
    'effectiveFrom:invalid',
    'feeBasisPoints:out_of_range',
    'feePaymentHours:out_of_range',
    'freightDueDays:out_of_range',
    'note:required',
  ]);
  const past = await draftSetting(first, values({ effectiveFrom: iso(-60) }));
  assert.deepEqual(problems(past), ['effectiveFrom:passed']);
  const noKey = await call('POST', '/staff/financial-settings', {
    token: first.token,
    body: values(),
  });
  assert.deepEqual([noKey.status, noKey.body.code], [400, 'retry_key_required']);
  assert.equal(await count('financial_setting_version', 'NOT development_default'), 0);

  // A draft; the same request again makes nothing more; the key for something else is refused.
  const retry = key();
  const drafted = await draftSetting(first, values(), retry);
  assert.equal(drafted.status, 201, drafted.text);
  const draftRow = drafted.body.setting as Setting;
  assert.deepEqual(
    [draftRow.status, draftRow.state, draftRow.effectiveAt],
    ['draft', 'draft', null],
  );
  const again = await draftSetting(first, values(), retry);
  assert.deepEqual(
    [again.body.outcome, (again.body.setting as Setting).id],
    ['already_drafted', draftRow.id],
  );
  const other = await draftSetting(first, values({ feeBasisPoints: 1 }), retry);
  assert.deepEqual([other.status, other.body.code], [409, 'retry_key_conflict']);
  assert.equal(await count('financial_setting_version', 'NOT development_default'), 1);
  // A draft changes nothing yet.
  assert.equal((await book(await offer())).fee.basisPoints, 300);

  // The drafter cannot approve; the attempt is recorded. A stale version changes nothing.
  const own = await moveSetting(first, draftRow, 'approve');
  assert.deepEqual([own.status, own.body.code], [409, 'different_person_required']);
  assert.equal(await staffAudit('staff.financial_setting.approve', 'refused', first.id), 1);
  const stale = await moveSetting(second, draftRow, 'approve', draftRow.version + 1);
  assert.deepEqual([stale.status, stale.body.code], [409, 'record_changed']);
  const done = await moveSetting(second, draftRow, 'approve');
  assert.equal(done.status, 200, done.text);
  const inForce = done.body.setting as Setting;
  assert.deepEqual(
    [inForce.status, inForce.state, instant(inForce.effectiveAt)],
    ['approved', 'in_force', clock().toISOString()],
  );
  assert.equal((await moveSetting(second, inForce, 'approve')).body.outcome, 'already_approved');
  assert.equal(await ready(), true);
  assert.equal(await staffAudit('staff.financial_setting.drafted', 'done', first.id), 1);
  assert.equal(await staffAudit('staff.financial_setting.approve', 'done', second.id), 1);

  // From now: the new fee and freight due days, and the version recorded.
  const later = await book(await offer());
  assert.deepEqual(
    [later.fee.basisPoints, later.fee.amount, later.paymentDueDays],
    [450, '45.00', 20],
  );
  assert.equal(await versionOf(later.id), inForce.id);
  // The earlier booking keeps its figures and its version.
  const kept = await call('GET', bookingRoute(before.shipper.org, earlier.id), {
    token: before.shipper.person.token,
  });
  assert.equal(kept.status, 200, kept.text);
  const keptBooking = kept.body.booking as Booking;
  assert.deepEqual(
    [keptBooking.fee.basisPoints, keptBooking.fee.amount, keptBooking.paymentDueDays],
    [300, '30.00', 15],
  );
  assert.equal(await versionOf(earlier.id), start.inForce.id);

  // History lists both, newest first; the default is superseded.
  const now = await settingsOf(first);
  assert.deepEqual([now.versions[0]!.id, now.versions[0]!.state], [inForce.id, 'in_force']);
  assert.equal(now.versions.find((item) => item.id === start.inForce.id)!.state, 'superseded');

  // Nothing written is ever changed or removed, by anyone; the API's role reaches no row.
  for (const statement of [
    'UPDATE trucker.financial_setting_version SET fee_basis_points = 1 WHERE id = $1',
    "UPDATE trucker.financial_setting_version SET status = 'withdrawn', closed_at = now() WHERE id = $1",
    'DELETE FROM trucker.financial_setting_version WHERE id = $1',
  ])
    await refused(() => owner.query(statement, [inForce.id]), /never changed or removed/);
  await refused(
    () =>
      owner.query('UPDATE trucker.booking SET financial_setting_version_id = NULL WHERE id = $1', [
        later.id,
      ]),
    /cannot be changed/,
  );
  await refused(
    () =>
      asParty(participant, (client) =>
        client.query('SELECT * FROM trucker.financial_setting_version'),
      ),
    /permission denied/,
  );
  // A direct approval by the migration role is refused too: approval is a move of a draft.
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.financial_setting_version
           (status, fee_basis_points, commission_options, commission_max_basis_points,
            commission_settlement_max_days, freight_due_days, note, effective_at, draft_key, draft_hash,
            drafted_by, drafted_at, approved_by, approved_at)
         VALUES ('approved', 1, '{}', 1, 1, 1, 'x', now(), $1, 'x', $2, now(), $3, now())`,
        [key(), first.id, second.id],
      ),
    /written as a draft/,
  );
  await restoreFinancialSettings(owner);
});

test('FS-2: a version takes effect at its time, to the instant; until then it can be withdrawn; a draft whose time has passed cannot be approved', async () => {
  const first = await newStaff(['staff_admin']);
  const second = await newStaff(['staff_admin']);
  // Two offers ready before anything is scheduled.
  const one = await offer();
  const two = await offer();
  const inForceBefore = (await settingsOf(first)).inForce;

  const scheduled = await approved(
    first,
    second,
    values({ feeBasisPoints: 700, effectiveFrom: iso(600) }),
  );
  assert.deepEqual([scheduled.state, instant(scheduled.effectiveAt)], ['scheduled', iso(600)]);
  // Before its time: the version in force applies.
  const early = await book(one);
  assert.equal(early.fee.basisPoints, inForceBefore.feeBasisPoints);
  assert.equal(await versionOf(early.id), inForceBefore.id);
  // At its time exactly: the new version applies.
  await advance(600);
  const onTime = await book(two);
  assert.deepEqual([onTime.fee.basisPoints, onTime.fee.amount], [700, '70.00']);
  assert.equal(await versionOf(onTime.id), scheduled.id);
  // In effect, it cannot be withdrawn.
  const late = await moveSetting(await fresh(first), scheduled, 'withdraw');
  assert.deepEqual([late.status, late.body.code], [409, 'version_in_effect']);

  // A scheduled version is withdrawn before its time and never applies.
  await fresh(second);
  const toWithdraw = await approved(
    first,
    second,
    values({ feeBasisPoints: 900, effectiveFrom: iso(300) }),
  );
  // A permitted move never carries a change of value with it, even by the migration role.
  await refused(
    () =>
      owner.query(
        `UPDATE trucker.financial_setting_version
         SET status = 'withdrawn', closed_at = now(), fee_basis_points = 1 WHERE id = $1`,
        [toWithdraw.id],
      ),
    /never changed or removed/,
  );
  const withdrawn = await moveSetting(first, toWithdraw, 'withdraw');
  assert.equal(withdrawn.status, 200, withdrawn.text);
  const gone = withdrawn.body.setting as Setting;
  assert.equal(gone.state, 'withdrawn');
  assert.equal((await moveSetting(first, gone, 'withdraw')).body.outcome, 'already_withdrawn');
  const twice = await moveSetting(second, gone, 'withdraw');
  assert.deepEqual([twice.status, twice.body.code], [409, 'version_not_open']);
  assert.equal(await staffAudit('staff.financial_setting.withdraw', 'done', first.id), 1);
  const three = await offer();
  await advance(400);
  const after = await book(three);
  assert.equal(await versionOf(after.id), scheduled.id);

  // A draft whose time passes before approval cannot be approved: it is discarded instead.
  await fresh(first);
  await fresh(second);
  const slow = (await draftSetting(first, values({ effectiveFrom: iso(120) }))).body
    .setting as Setting;
  await advance(180);
  await fresh(first);
  await fresh(second);
  const passed = await moveSetting(second, slow, 'approve');
  assert.deepEqual([passed.status, passed.body.code], [409, 'effective_time_passed']);
  const discarded = await moveSetting(first, slow, 'discard');
  assert.equal(discarded.status, 200, discarded.text);
  const closed = await moveSetting(second, discarded.body.setting as Setting, 'approve');
  assert.deepEqual([closed.status, closed.body.code], [409, 'version_not_open']);
  const states = (await settingsOf(first)).versions.map((item) => [item.versionNo, item.state]);
  assert.ok(states.some(([, state]) => state === 'discarded'));
  assert.ok(states.some(([, state]) => state === 'withdrawn'));
  await restoreFinancialSettings(owner);
});

test('FS-3: commission options and limits come from the version in force; a commission fixed on a shipment before a change stays', async () => {
  const first = await newStaff(['staff_admin']);
  const second = await newStaff(['staff_admin']);
  const organiser = await broker();
  const customer = await verifiedShipper();
  // Published before the change, at 25%.
  const before = await commissioned(organiser, customer, {
    option: 'percentage',
    basisPoints: 2500,
  });

  await approved(
    first,
    second,
    values({
      commissionOptions: ['percentage', 'fixed'],
      commissionMaxBasisPoints: 1000,
      commissionSettlementMaxDays: 20,
    }),
  );
  const authority = await authorised(organiser, customer);
  const made = await draft(organiser.person, organiser.org);
  assert.equal((await setParties(organiser, made, { customerAuthorityId: authority })).status, 200);
  const limits = await terms(organiser, made.id);
  assert.deepEqual(limits.body.limits, { options: ['percentage', 'fixed'], maxBasisPoints: 1000 });
  const notOffered = await setCommission(organiser, made, { option: 'contract' });
  assert.deepEqual(problems(notOffered), ['commission:not_offered']);
  const tooHigh = await setCommission(organiser, made, { option: 'percentage', basisPoints: 1001 });
  assert.deepEqual(problems(tooHigh), ['commissionPercentage:out_of_range']);
  assert.equal(
    (await setCommission(organiser, made, { option: 'percentage', basisPoints: 1000 })).status,
    200,
  );

  // Contracts: the same limit, and the settlement days of the version in force.
  const carrier = await verifiedCarrier();
  const code = (await contractsOf(carrier)).accountCode;
  const bounds = await call('GET', contractsRoute(organiser.org), {
    token: organiser.person.token,
  });
  assert.deepEqual((bounds.body.contracts as Record<string, unknown>).limits, {
    maxBasisPoints: 1000,
    settlementMaxDays: 20,
  });
  const contractHigh = await propose(organiser, code, {
    ...tenPercent,
    basisPoints: 1001,
    settlementDays: 21,
  });
  assert.deepEqual(problems(contractHigh).sort(), [
    'basisPoints:out_of_range',
    'settlementDays:out_of_range',
  ]);
  assert.equal((await propose(organiser, code, { ...tenPercent, settlementDays: 20 })).status, 201);

  // The shipment published before keeps its 25%: the carrier quotes with it.
  const kept = await quote(
    carrier.person,
    carrier.org,
    before.id,
    quoteBody({ commissionAccepted: { commission: '312.63', net: '937.87' } }),
  );
  assert.equal(kept.status, 201, kept.text);
  await restoreFinancialSettings(owner);
});

test('FS-4: an approval and a booking never interleave: each waits for the other', async () => {
  const first = await newStaff(['staff_admin']);
  const second = await newStaff(['staff_admin']);
  const waiting = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const found = await owner.query(
        "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
      );
      if (found.rowCount! > 0) return true;
    }
    return false;
  };
  // A booking waits while an approval holds the settings.
  const made = await offer();
  const holder = await owner.connect();
  try {
    await holder.query('BEGIN');
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('financial.settings', 0))");
    const pending = accept(made.shipper.person, made.shipper.org, made.quotation.id, 1);
    assert.ok(await waiting(), 'the booking waits for the settings');
    await holder.query('COMMIT');
    assert.equal((await pending).status, 200);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
  // An approval waits while a booking holds the settings.
  const drafted = (await draftSetting(first, values())).body.setting as Setting;
  const reader = await owner.connect();
  try {
    await reader.query('BEGIN');
    await reader.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('financial.settings', 0))",
    );
    const pending = moveSetting(second, drafted, 'approve');
    assert.ok(await waiting(), 'the approval waits for the booking');
    await reader.query('COMMIT');
    assert.equal((await pending).status, 200);
  } finally {
    await reader.query('ROLLBACK').catch(() => undefined);
    reader.release();
  }
  await restoreFinancialSettings(owner);
});

// Changed from the review's version only in how it sees the wait: a test role that is not a
// superuser (as in the Windows CI job) cannot read another role's query text or wait event,
// but can see that a lock in this database is not granted. Only the audited request waits.
async function auditWaitForBlocked(fragment: string): Promise<void> {
  void fragment;
  for (let i = 0; i < 400; i++) {
    const rows = await owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()',
    );
    if (rows.rows[0]!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Audit request did not reach the controlled lock');
}

test('AUDIT-4: financial-setting approval must recheck an expired session after its lock wait', async () => {
  const drafter = await newStaff(['staff_admin']);
  const approver = await newStaff(['staff_admin']);
  const drafted = await draftSetting(drafter);
  assert.equal(drafted.status, 201, drafted.text);
  const setting = drafted.body.setting as Setting;
  const holder = await owner.connect();
  await holder.query('BEGIN');
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('financial.settings',0))");
  const pending = moveSetting(approver, setting, 'approve').then(
    (reply) => ({ reply }),
    (error) => ({ error }),
  );
  try {
    await auditWaitForBlocked('staff_financial_move');
    await advance(D.staff_session_idle_minutes * 60 + 1);
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
  const result = await pending;
  if ('error' in result) throw result.error;
  const state = (
    await owner.query('SELECT status FROM trucker.financial_setting_version WHERE id=$1', [
      setting.id,
    ])
  ).rows[0];
  const check = await call('GET', '/staff/me', { token: approver.token });
  console.log(
    'AUDIT-4 OBSERVED',
    JSON.stringify({
      approvalStatus: result.reply.status,
      approval: result.reply.body,
      setting: state.status,
      subsequentSessionCheck: check.status,
    }),
  );
  assert.equal(
    result.reply.status,
    401,
    'An expired staff session approved financial settings after waiting for the lock',
  );
});
