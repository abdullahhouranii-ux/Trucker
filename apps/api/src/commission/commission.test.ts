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
const bookingRoute = (org: string, id: string, rest = ''): string =>
  `/organisations/${org}/bookings/${id}${rest}`;
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
/** A shipment the organiser arranged for the customer, published and open to quotations. */
async function arranged(organiser: Party, authority: string, over: Record<string, unknown> = {}) {
  const made = await draft(organiser.person, organiser.org);
  const set = await setParties(organiser, made, { customerAuthorityId: authority, ...over });
  assert.equal(set.status, 200, set.text);
  const reply = await publish(organiser, made);
  assert.equal(reply.status, 200, reply.text);
  const shipment = reply.body.shipment as Shipment;
  assert.equal((await setTerms(organiser.person, organiser.org, shipment.id)).status, 200);
  return shipment;
}
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

test('CM-1: a commission is the organiser’s, on a draft it arranges for a customer, within the limit, and fixed once published; the customer is never told it', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  const authority = await authorised(organiser, customer);

  // Not on a shipment of one's own.
  const own = await draft(organiser.person, organiser.org);
  const mine = await setCommission(organiser, own, { option: 'percentage', basisPoints: 500 });
  assert.equal(mine.status, 422, mine.text);
  assert.deepEqual(problems(mine), ['commission:own_shipment']);

  const made = await draft(organiser.person, organiser.org);
  assert.equal((await setParties(organiser, made, { customerAuthorityId: authority })).status, 200);
  for (const [body, problem] of [
    [{ option: 'percentage', basisPoints: 2501 }, 'commissionPercentage:out_of_range'],
    [{ option: 'percentage', basisPoints: 0 }, 'commissionPercentage:out_of_range'],
    [{ option: 'percentage' }, 'commissionPercentage:out_of_range'],
    [{ option: 'fixed', amount: '0', currency: 'XTS' }, 'commissionAmount:invalid'],
    [{ option: 'fixed', amount: '10.123', currency: 'XTS' }, 'commissionAmount:invalid'],
    [{ option: 'fixed', amount: '10', currency: 'QQQ' }, 'commissionCurrency:unavailable'],
  ] as const) {
    const reply = await setCommission(organiser, made, body);
    assert.equal(reply.status, 422, reply.text);
    assert.deepEqual(problems(reply), [problem]);
  }
  assert.equal(
    await count('shipment_commission'),
    await count('shipment_commission', 'shipment_id <> $1', [made.id]),
  );
  // A stale version changes nothing.
  const stale = await setCommission(
    organiser,
    { ...made, version: made.version + 1 },
    {
      option: 'percentage',
      basisPoints: 500,
    },
  );
  assert.deepEqual([stale.status, stale.body.code], [409, 'record_changed']);

  const saved = await setCommission(organiser, made, { option: 'percentage', basisPoints: 2500 });
  assert.equal(saved.status, 200, saved.text);
  // Replaced, then removed, then set again: one row at most.
  assert.equal((await setCommission(organiser, made, { option: 'none' })).status, 200);
  assert.equal(await count('shipment_commission', 'shipment_id = $1', [made.id]), 0);
  assert.equal(
    (await setCommission(organiser, made, { option: 'percentage', basisPoints: 1000 })).status,
    200,
  );
  assert.equal(
    await count('audit_entry', "record_id = $1 AND action = 'shipment.commission_set'", [made.id]),
    3,
  );

  const published = await publish(organiser, made);
  assert.equal(published.status, 200, published.text);
  const shipment = published.body.shipment as Shipment;
  const fixed = await setCommission(organiser, shipment, { option: 'none' });
  assert.deepEqual([fixed.status, fixed.body.code], [409, 'shipment_roles_fixed']);
  assert.equal(await count('shipment_commission', 'shipment_id = $1', [made.id]), 1);

  // The organiser and a carrier are told the terms; the customer and an outsider are not.
  const mineTerms = await terms(organiser, shipment.id);
  assert.equal(mineTerms.status, 200, mineTerms.text);
  assert.deepEqual([mineTerms.body.arranged, mineTerms.body.editable], [true, false]);
  const ownTerms = await terms(organiser, own.id);
  assert.deepEqual([ownTerms.body.arranged, ownTerms.body.editable], [false, true]);
  assert.deepEqual(mineTerms.body.commission, {
    option: 'percentage',
    basisPoints: 1000,
    amount: null,
    currency: null,
  });
  const carrier = await verifiedCarrier();
  const figures = await terms(carrier, shipment.id, '?amount=1250.50&currency=XTS');
  assert.equal(figures.status, 200, figures.text);
  assert.deepEqual([figures.body.arranged, figures.body.editable], [undefined, undefined]);
  assert.deepEqual(figures.body.figures, {
    state: 'ok',
    commission: '125.05',
    net: '1125.45',
    currency: 'XTS',
  });
  assert.equal((await terms(customer, shipment.id)).status, 404);
  assert.equal((await terms(await verifiedShipper(), shipment.id)).status, 404);
  // Nothing the customer is given about the shipment names a commission.
  for (const reply of [
    await call('GET', auth(customer.org), { token: customer.person.token }),
    await quotationsOf(customer, shipment.id),
  ]) {
    assert.equal(reply.status, 200, reply.text);
    assert.doesNotMatch(reply.text, /commission/i);
  }
});

test('CM-2: no quotation exists on a commissioned shipment unless the carrier accepted exactly the commission and the net; amounts round half-up and always add up', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  const shipment = await commissioned(organiser, customer, {
    option: 'percentage',
    basisPoints: 100,
  });
  const carrier = await verifiedCarrier();
  const before = await count('quotation');

  // 1% of 1250.50 is 12.505: half-up to 12.51, and the net is what remains.
  const unaccepted = await quote(carrier.person, carrier.org, shipment.id);
  assert.deepEqual(
    [unaccepted.status, unaccepted.body.code],
    [409, 'commission_acceptance_required'],
  );
  assert.deepEqual(refusal(unaccepted), { commission: '12.51', net: '1237.99' });
  for (const wrong of [
    { commission: '12.50', net: '1238.00' },
    { commission: '12.51', net: '1238.00' },
    { commission: '12.51|1237.99', net: '' },
  ]) {
    const reply = await quote(
      carrier.person,
      carrier.org,
      shipment.id,
      quoteBody({ commissionAccepted: wrong }),
    );
    assert.deepEqual(
      [reply.status, reply.body.code],
      [409, 'commission_acceptance_required'],
      reply.text,
    );
  }
  assert.equal(await count('quotation'), before);

  const accepted = { commission: '12.51', net: '1237.99' };
  const quotation = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ commissionAccepted: accepted }),
  );
  const row = (
    await owner.query<Record<string, string>>(
      `SELECT organiser_organisation_id AS organiser, option, basis_points::text AS points,
              shipping_amount::text AS price, commission_amount::text AS commission,
              net_amount::text AS net, accepted_by AS by
       FROM trucker.quotation_commission WHERE quotation_id = $1 AND version_no = 1`,
      [quotation.id],
    )
  ).rows[0]!;
  assert.deepEqual(row, {
    organiser: organiser.org,
    option: 'percentage',
    points: '100',
    price: '1250.50',
    commission: '12.51',
    net: '1237.99',
    by: carrier.person.personId,
  });
  // The acceptance is no part of the quotation the customer reads.
  assert.equal(quotation.versions[0]!.amount, '1250.50');

  // A new price needs its own acceptance: the old figures do not carry over.
  const revise = (body: Record<string, unknown>) =>
    call('POST', `/organisations/${carrier.org}/quotations/${quotation.id}/revisions`, {
      token: carrier.person.token,
      key: key(),
      body: { version: 1, ...quoteBody({ amount: '2000', ...body }) },
    });
  const carried = await revise({ commissionAccepted: accepted });
  assert.deepEqual(
    [carried.status, carried.body.code],
    [409, 'commission_acceptance_required'],
    carried.text,
  );
  assert.deepEqual(refusal(carried), { commission: '20.00', net: '1980.00' });
  const revised = await revise({ commissionAccepted: { commission: '20.00', net: '1980.00' } });
  assert.equal(revised.status, 200, revised.text);
  assert.equal(await count('quotation_commission', 'quotation_id = $1', [quotation.id]), 2);

  // Who sees it: the carrier its own, the organiser all of its shipments, the customer none.
  const second = await verifiedCarrier();
  await quoted(second.person, second.org, shipment.id, quoteBody({ commissionAccepted: accepted }));
  const shape = (lines: Line[]) =>
    lines.map((line) => [line.role, line.shippingPrice, line.commission, line.net]);
  assert.deepEqual(shape((await commissions(carrier)).quotations), [
    ['carrier', '2000.00', '20.00', '1980.00'],
  ]);
  assert.deepEqual(shape((await commissions(second)).quotations), [
    ['carrier', '1250.50', '12.51', '1237.99'],
  ]);
  // Compared without regard to order: quotations may share an instant under the test clock.
  assert.deepEqual(shape((await commissions(organiser)).quotations).sort(), [
    ['organiser', '1250.50', '12.51', '1237.99'],
    ['organiser', '2000.00', '20.00', '1980.00'],
  ]);
  assert.deepEqual(await commissions(customer), { quotations: [], bookings: [] });
  const read = await quotationsOf(customer, shipment.id);
  assert.equal(read.status, 200, read.text);
  assert.doesNotMatch(read.text, /commission|1980|1237\.99/i);

  // A shipment with no commission is quoted as before, whatever is sent with it.
  const plain = await arranged(organiser, await authorised(organiser, await verifiedShipper()));
  const count0 = await count('quotation_commission');
  await quoted(carrier.person, carrier.org, plain.id, quoteBody({ commissionAccepted: accepted }));
  assert.equal(await count('quotation_commission'), count0);
});

test('CM-3: a fixed commission must be in the quotation’s currency and leave the carrier something', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  const carrier = await verifiedCarrier();
  const fixed = await commissioned(organiser, customer, {
    option: 'fixed',
    amount: '100',
    currency: 'XTS',
  });
  const told = await quote(carrier.person, carrier.org, fixed.id);
  assert.deepEqual([told.status, told.body.code], [409, 'commission_acceptance_required']);
  assert.deepEqual(refusal(told), { commission: '100.00', net: '1150.50' });
  const tooSmall = await quote(carrier.person, carrier.org, fixed.id, quoteBody({ amount: '100' }));
  assert.deepEqual(
    [tooSmall.status, tooSmall.body.code],
    [409, 'commission_leaves_nothing'],
    tooSmall.text,
  );
  const figures = await terms(carrier, fixed.id, '?amount=90&currency=XTS');
  assert.equal((figures.body.figures as { state: string }).state, 'nothing_left');
  assert.equal(await count('quotation', 'shipment_id = $1', [fixed.id]), 0);
  // A fixed amount in one currency is never taken from a price in another.
  const other = await owner.query<{ status: string }>(
    "SELECT status FROM trucker.commission_figures($1, 1250.50, 'QQQ')",
    [fixed.id],
  );
  assert.equal(other.rows[0]!.status, 'currency');
  await quoted(
    carrier.person,
    carrier.org,
    fixed.id,
    quoteBody({ commissionAccepted: { commission: '100.00', net: '1150.50' } }),
  );
  assert.equal(await count('quotation', 'shipment_id = $1', [fixed.id]), 1);
});

test('CM-4: the booking keeps the commission as accepted; the carrier and the organiser read it, the customer does not; nothing recorded is ever changed', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  const shipment = await commissioned(organiser, customer, {
    option: 'percentage',
    basisPoints: 1000,
  });
  const carrier = await verifiedCarrier();
  const quotation = await quoted(
    carrier.person,
    carrier.org,
    shipment.id,
    quoteBody({ commissionAccepted: { commission: '125.05', net: '1125.45' } }),
  );
  const done = await accept(customer.person, customer.org, quotation.id, 1);
  assert.equal(done.status, 200, done.text);
  const booking = done.body.booking as Booking;
  // The customer's price is the shipping price; Trucker's fee is reckoned on it, as before.
  assert.equal(booking.transportAmount, '1250.50');
  assert.doesNotMatch(done.text, /commission|1125\.45/i);

  const shape = (lines: Line[]) =>
    lines.map((line) => [line.bookingId, line.role, line.shippingPrice, line.commission, line.net]);
  assert.deepEqual(shape((await commissions(carrier)).bookings), [
    [booking.id, 'carrier', '1250.50', '125.05', '1125.45'],
  ]);
  assert.deepEqual(shape((await commissions(organiser)).bookings), [
    [booking.id, 'organiser', '1250.50', '125.05', '1125.45'],
  ]);
  assert.deepEqual(await commissions(customer), { quotations: [], bookings: [] });
  const seen = await call('GET', bookingRoute(customer.org, booking.id), {
    token: customer.person.token,
  });
  assert.equal(seen.status, 200, seen.text);
  assert.doesNotMatch(seen.text, /commission|1125\.45/i);

  // Recorded once, never altered: not by the owner of the database either.
  for (const statement of [
    'UPDATE trucker.booking_commission SET commission_amount = 1 WHERE booking_id = $1',
    'DELETE FROM trucker.booking_commission WHERE booking_id = $1',
  ])
    await refused(() => owner.query(statement, [booking.id]), /never changed/);
  await refused(
    () =>
      owner.query(
        'UPDATE trucker.quotation_commission SET net_amount = 1 WHERE quotation_id = $1',
        [quotation.id],
      ),
    /never changed/,
  );
  await refused(() => owner.query('TRUNCATE trucker.booking_commission'), /never changed/);
  // And the role the API runs as reaches none of the tables.
  for (const table of ['shipment_commission', 'quotation_commission', 'booking_commission'])
    await refused(
      () => asParty(carrier, (client) => client.query(`SELECT * FROM trucker.${table}`)),
      /permission denied/,
    );
});

test('CM-5: a customer that is also a carrier is still not told the commission on a shipment arranged for it', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  await granted(customer, carrierBody());
  const shipment = await commissioned(organiser, customer, {
    option: 'percentage',
    basisPoints: 500,
  });
  // Another carrier is told; the customer, though a carrier, is not.
  assert.equal((await terms(await verifiedCarrier(), shipment.id)).status, 200);
  const asked = await terms(customer, shipment.id, '?amount=1000&currency=XTS');
  assert.equal(asked.status, 404, asked.text);
  assert.deepEqual(await commissions(customer), { quotations: [], bookings: [] });
});
