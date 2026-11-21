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
import { restoreFinancialSettings, setFinancialSettings } from '../testing/financial.js';
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
  await ensureQuotationFleet(owner, person.personId, org, shipment);
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
  return { shipper, shipment, booking: reply.body.booking as Booking, anchor };
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
const cancelBooking = async (
  party: Party,
  bookingId: string,
  reason = 'other',
  note: string | null = 'Test cancellation',
  version?: number,
) =>
  call('POST', bookingRoute(party.org, bookingId, '/cancel'), {
    token: party.person.token,
    body: { version: version ?? (await viewOf(party, bookingId)).assignmentVersion, reason, note },
  });

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
const endAuthority = async (party: Party, id: string): Promise<Reply> =>
  call('POST', auth(party.org, `/${id}/end`), {
    token: party.person.token,
    body: {
      version: (await authorityOverview(party)).authorities.find((item) => item.id === id)!.version,
    },
  });
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
const statusOf = async (table: string, id: string): Promise<string> =>
  (await owner.query<{ status: string }>(`SELECT status FROM trucker.${table} WHERE id = $1`, [id]))
    .rows[0]!.status;
const partyRow = async (shipment: string) =>
  (
    await owner.query<{
      organiser_organisation_id: string | null;
      customer_organisation_id: string;
      fee_payer_organisation_id: string;
      fee_agreement: string | null;
      authority_id: string | null;
    }>('SELECT * FROM trucker.shipment_party WHERE shipment_id = $1', [shipment])
  ).rows[0]!;
const quotationsOf = (party: Party, shipment: string): Promise<Reply> =>
  call('GET', `/organisations/${party.org}/shipments/${shipment}/quotations`, {
    token: party.person.token,
  });
const problems = (reply: Reply): string[] =>
  (
    (reply.body.details as { problems?: { field: string; code: string }[] } | undefined)
      ?.problems ?? []
  ).map((problem) => `${problem.field}:${problem.code}`);

test('SR-1: authority is asked for by account code and exists only when the customer accepts; a wrong code reveals nothing; either side ends it', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  const code = (await authorityOverview(customer)).accountCode;
  assert.match(code, /^TR[0-9A-F]{10}$/);
  // Only a verified organiser asks.
  const notOrganiser = await requestAuthority(
    customer,
    (await authorityOverview(organiser)).accountCode,
  );
  assert.deepEqual([notOrganiser.status, notOrganiser.body.code], [403, 'organiser_not_eligible']);
  // A code naming nothing, the organiser itself, or an unverified account: one and the same answer.
  const unverified = await newShipper();
  const unverifiedCode = (
    await owner.query<{ c: string }>(
      'SELECT account_code AS c FROM trucker.organisation WHERE id = $1',
      [unverified.org],
    )
  ).rows[0]!.c;
  for (const wrong of [
    'TR0000000000',
    (await authorityOverview(organiser)).accountCode,
    unverifiedCode,
    '',
  ]) {
    const reply = await requestAuthority(organiser, wrong);
    assert.deepEqual([reply.status, reply.body.code], [404, 'account_code_not_found'], wrong);
  }
  assert.equal(await count('organiser_authority'), 0);

  const asked = await requestAuthority(organiser, code.toLowerCase());
  assert.equal(asked.status, 201, asked.text);
  const made = asked.body.authority as Authority;
  assert.deepEqual([made.status, made.role, made.mayPublish], ['requested', 'organiser', false]);
  // Asking again changes nothing.
  assert.equal((await requestAuthority(organiser, code)).body.outcome, 'already_requested');
  assert.equal(await count('organiser_authority'), 1);
  // Nothing is granted yet: the organiser cannot name the customer on a shipment.
  const early = await draft(organiser.person, organiser.org);
  const tooEarly = await setParties(organiser, early, { customerAuthorityId: made.id });
  assert.deepEqual([tooEarly.status, problems(tooEarly)], [422, ['customer:no_authority']]);
  // The organiser cannot accept its own request; a stranger sees nothing.
  const self = await decideAuthority(organiser, made.id, {
    version: 1,
    decision: 'accept',
    mayPublish: true,
    feePayerAgreed: true,
  });
  assert.equal(self.status, 404);
  const stranger = await verifiedShipper();
  assert.equal(
    (await endAuthority(customer, made.id).then(() => authorityOverview(stranger))).authorities
      .length,
    0,
  );
  // Ended before it was accepted: it cannot be accepted any more.
  const late = await decideAuthority(customer, made.id, {
    version: 2,
    decision: 'accept',
    mayPublish: true,
    feePayerAgreed: true,
  });
  assert.equal(late.body.outcome, 'already_decided');
  assert.equal((await authorityOverview(customer)).authorities[0]!.status, 'ended');

  // Asked again and accepted, with what the customer allows; a stale version is refused.
  const again = (await requestAuthority(organiser, code)).body.authority as Authority;
  const stale = await decideAuthority(customer, again.id, {
    version: 9,
    decision: 'accept',
    mayPublish: true,
    feePayerAgreed: false,
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'record_changed']);
  const accepted = await decideAuthority(customer, again.id, {
    version: 1,
    decision: 'accept',
    mayPublish: true,
    feePayerAgreed: false,
  });
  assert.equal(accepted.status, 200, accepted.text);
  const now = (await authorityOverview(organiser)).authorities.find(
    (item) => item.id === again.id,
  )!;
  assert.deepEqual([now.status, now.mayPublish, now.feePayerAgreed], ['active', true, false]);
  // Each side has its own history entries, and the API's role reads the table through nothing else.
  assert.equal(
    await count('audit_entry', "record_id = $1 AND action = 'authority.decided'", [again.id]),
    2,
  );
  await refused(
    () => asParty(organiser, (client) => client.query('SELECT 1 FROM trucker.organiser_authority')),
    /permission denied/,
  );
  // The organiser ends it too.
  assert.equal((await endAuthority(organiser, again.id)).body.outcome, 'ended');
  assert.equal((await endAuthority(customer, again.id)).body.outcome, 'already_ended');
});

test('SR-2 to SR-5, S22-2: the organiser arranges and publishes for the customer and reads the quotations; the customer sees the shipment and alone accepts; the booking is the customer’s', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  const authority = await authorised(organiser, customer);
  const shipment = await arranged(organiser, authority);
  const row = await partyRow(shipment.id);
  assert.deepEqual(
    [
      row.organiser_organisation_id,
      row.customer_organisation_id,
      row.fee_payer_organisation_id,
      row.fee_agreement,
      row.authority_id,
    ],
    [organiser.org, customer.org, customer.org, 'authority', authority],
  );
  // Once published the roles are fixed.
  const fixed = await setParties(organiser, shipment, {
    customerAuthorityId: authority,
    feePayer: 'organiser',
  });
  assert.deepEqual([fixed.status, fixed.body.code], [409, 'shipment_roles_fixed']);

  // The customer sees what was arranged in its name, with who arranged it.
  const seen = (await authorityOverview(customer)).arranged;
  assert.deepEqual(
    seen.map((item) => [
      item.id,
      (item.parties.organiser as { id: string }).id,
      item.parties.feePayer,
    ]),
    [[shipment.id, organiser.org, 'customer']],
  );
  // The organiser reaches nothing else of the customer's account.
  for (const path of [
    `/organisations/${customer.org}`,
    `/organisations/${customer.org}/shipments`,
    `/organisations/${customer.org}/bookings`,
  ])
    assert.equal((await call('GET', path, { token: organiser.person.token })).status, 404, path);

  const carrier = await verifiedCarrier();
  const quotation = await quoted(carrier.person, carrier.org, shipment.id);
  assert.equal((await quotationsOf(organiser, shipment.id)).status, 200);
  assert.equal((await quotationsOf(customer, shipment.id)).status, 200);
  // The organiser never accepts; the customer does, and the booking's shipper is the customer.
  const notMine = await accept(organiser.person, organiser.org, quotation.id, 1);
  assert.equal(notMine.status, 404, notMine.text);
  assert.equal(await count('booking'), await count('booking', 'shipment_id <> $1', [shipment.id]));
  const done = await accept(customer.person, customer.org, quotation.id, 1);
  assert.equal(done.status, 200, done.text);
  const booking = done.body.booking as Booking;
  const stored = (
    await owner.query<{
      shipper: string;
      organiser: string;
      customer: string;
      fee: string;
      roles: { organiser: { id: string } };
    }>(
      `SELECT b.shipper_organisation_id AS shipper, p.organiser_organisation_id AS organiser,
              p.customer_organisation_id AS customer, p.fee_payer_organisation_id AS fee, p.roles
       FROM trucker.booking b JOIN trucker.booking_party p ON p.booking_id = b.id WHERE b.id = $1`,
      [booking.id],
    )
  ).rows[0]!;
  assert.deepEqual(
    [stored.shipper, stored.organiser, stored.customer, stored.fee, stored.roles.organiser.id],
    [customer.org, organiser.org, customer.org, customer.org, organiser.org],
  );
  // The organiser is not a party to the booking: it cannot read or cancel it.
  assert.equal(
    (await call('GET', bookingRoute(organiser.org, booking.id), { token: organiser.person.token }))
      .status,
    404,
  );
  assert.equal(
    (await cancelBooking(organiser, booking.id).catch(() => ({ status: 404 }))).status,
    404,
  );
  assert.equal((await viewOf(customer, booking.id)).role, 'shipper');
  // History: the award in the organiser's account, the booking in the customer's.
  assert.equal(
    await count(
      'audit_entry',
      "record_id = $1 AND action = 'booking.created' AND organisation_id = $2",
      [booking.id, customer.org],
    ),
    1,
  );
  assert.equal(
    await count(
      'audit_entry',
      "record_id = $1 AND action = 'shipment.awarded' AND organisation_id = $2",
      [shipment.id, organiser.org],
    ),
    1,
  );
});

test('two organisers serving one customer reach only the shipments each arranged; the organiser of its own shipment is recorded too', async () => {
  const customer = await verifiedShipper();
  const one = await broker();
  const two = await broker();
  const first = await arranged(one, await authorised(one, customer));
  const second = await arranged(two, await authorised(two, customer));
  // Each reaches its own and not the other's, by any route.
  for (const [who, mine, other] of [
    [one, first, second],
    [two, second, first],
  ] as const) {
    assert.equal(
      (
        await call('GET', `/organisations/${who.org}/shipments/${mine.id}`, {
          token: who.person.token,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call('GET', `/organisations/${who.org}/shipments/${other.id}`, {
          token: who.person.token,
        })
      ).status,
      404,
    );
    assert.equal(
      (await call('GET', partiesRoute(who.org, other.id), { token: who.person.token })).status,
      404,
    );
    assert.equal((await quotationsOf(who, other.id)).status, 404);
    assert.equal(
      (await act(who.person, who.org, other.id, 'withdraw', { version: other.version })).status,
      404,
    );
  }
  // The customer sees both, each with its organiser.
  assert.deepEqual(
    (await authorityOverview(customer)).arranged
      .map((item) => (item.parties.organiser as { id: string }).id)
      .sort(),
    [one.org, two.org].sort(),
  );
  // An authority is to one organiser: the other cannot use it.
  const stolen = await draft(two.person, two.org);
  const reply = await setParties(two, stolen, {
    customerAuthorityId: (await partyRow(first.id)).authority_id,
  });
  assert.deepEqual([reply.status, problems(reply)], [422, ['customer:no_authority']]);

  // Its own shipment: an organiser is recorded as the organiser; a plain shipper has none.
  const own = await draft(one.person, one.org);
  assert.equal((await publish(one, own)).status, 200);
  const ownRow = await partyRow(own.id);
  assert.deepEqual(
    [
      ownRow.organiser_organisation_id,
      ownRow.customer_organisation_id,
      ownRow.fee_payer_organisation_id,
      ownRow.fee_agreement,
    ],
    [one.org, one.org, one.org, 'own_act'],
  );
  const plain = await draft(customer.person, customer.org);
  assert.equal((await publish(customer, plain)).status, 200);
  assert.equal((await partyRow(plain.id)).organiser_organisation_id, null);
  // An organiser that is also a carrier never quotes on what it organises.
  await granted(one, carrierBody());
  const mine = await quote(one.person, one.org, first.id, quoteBody());
  assert.notEqual(mine.status, 201, mine.text);
});

test('SR-3: each permission refuses exactly its action; an authority ended while a publication waits refuses it; what was done before stays', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  // Without the permission to publish, a draft can be prepared but not published.
  const limited = await authorised(organiser, customer, { mayPublish: false });
  const prepared = await draft(organiser.person, organiser.org);
  assert.equal(
    (await setParties(organiser, prepared, { customerAuthorityId: limited })).status,
    200,
  );
  const refusedPublish = await publish(organiser, prepared);
  assert.equal(refusedPublish.status, 422, refusedPublish.text);
  assert.ok(problems(refusedPublish).includes('customer:no_authority'), refusedPublish.text);
  assert.equal((await endAuthority(customer, limited)).status, 200);

  const authority = await authorised(organiser, customer);
  const published = await arranged(organiser, authority);
  const waiting = await draft(organiser.person, organiser.org);
  assert.equal(
    (await setParties(organiser, waiting, { customerAuthorityId: authority })).status,
    200,
  );
  // The publication waits behind a lock on its shipment; the customer ends the authority
  // meanwhile; when the publication proceeds it is refused and nothing is published.
  const holder = await owner.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM trucker.shipment_draft WHERE id = $1 FOR UPDATE', [waiting.id]);
  const pending = publish(organiser, waiting);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await endAuthority(customer, authority)).body.outcome, 'ended');
  await holder.query('COMMIT');
  holder.release();
  const late = await pending;
  assert.equal(late.status, 422, late.text);
  assert.ok(problems(late).includes('customer:no_authority'), late.text);
  assert.equal(await statusOf('shipment_draft', waiting.id), 'draft');
  // What was published before stays published, and the customer can still accept on it.
  assert.equal(await statusOf('shipment_draft', published.id), 'published');
  const carrier = await verifiedCarrier();
  const quotation = await quoted(carrier.person, carrier.org, published.id);
  assert.equal((await accept(customer.person, customer.org, quotation.id, 1)).status, 200);
  // The organiser can withdraw nothing new into the market: a change of the published
  // shipment is refused now, and a new draft cannot name the customer.
  const fresh = await draft(organiser.person, organiser.org);
  assert.deepEqual(
    problems(await setParties(organiser, fresh, { customerAuthorityId: authority })),
    ['customer:no_authority'],
  );
});

test('S22-3: the fee payer is the customer or the organiser, and each must have agreed', async () => {
  const organiser = await broker();
  const customer = await verifiedShipper();
  // The customer did not agree to pay the fee for this organiser's shipments.
  const authority = await authorised(organiser, customer, { feePayerAgreed: false });
  const made = await draft(organiser.person, organiser.org);
  assert.equal(
    (await setParties(organiser, made, { customerAuthorityId: authority, feePayer: 'customer' }))
      .status,
    200,
  );
  const notAgreed = await publish(organiser, made);
  assert.equal(notAgreed.status, 422, notAgreed.text);
  assert.deepEqual(
    problems(notAgreed).filter((item) => item.startsWith('feePayer')),
    ['feePayer:not_agreed'],
  );
  // The organiser names itself: its own act is its agreement.
  assert.equal(
    (await setParties(organiser, made, { customerAuthorityId: authority, feePayer: 'organiser' }))
      .status,
    200,
  );
  assert.equal((await publish(organiser, made)).status, 200);
  const row = await partyRow(made.id);
  assert.deepEqual([row.fee_payer_organisation_id, row.fee_agreement], [organiser.org, 'own_act']);
  // No one else can be named, and an account's own shipment has no organiser to pay.
  const other = await draft(organiser.person, organiser.org);
  for (const body of [
    { customerAuthorityId: authority, feePayer: 'receiver' },
    { customerAuthorityId: null, feePayer: 'organiser' },
    { customerAuthorityId: authority, freightPayer: 'organiser' },
    { customerAuthorityId: authority, receiver: { name: '' } },
  ]) {
    const reply = await setParties(organiser, other, body);
    assert.equal(reply.status, 422, JSON.stringify(body));
  }
  // With the customer's agreement, recorded with who gave it and when.
  const agreeing = await verifiedShipper();
  const agreed = await arranged(organiser, await authorised(organiser, agreeing));
  const stored = (
    await owner.query<{ fee_agreement: string; fee_agreed_by: string; fee_agreed_at: Date }>(
      'SELECT fee_agreement, fee_agreed_by, fee_agreed_at FROM trucker.shipment_party WHERE shipment_id = $1',
      [agreed.id],
    )
  ).rows[0]!;
  assert.deepEqual(
    [stored.fee_agreement, stored.fee_agreed_by],
    ['authority', agreeing.person.personId],
  );
  assert.ok(stored.fee_agreed_at instanceof Date);
});

test('SR-7: a booking keeps its accepted snapshot and its roles whatever changes afterwards; first-time broker onboarding needs no other capability', async () => {
  // A company that has never been verified applies as an organiser and nothing else.
  const fresh = await newShipper({ legalName: 'Fixture New Broker (fictional)' });
  const before = (await overview(fresh.person, fresh.org)) as unknown as {
    mayApply: Record<string, string | null>;
  };
  assert.equal(before.mayApply.organise, 'initial');
  await granted(fresh, organiseBody());
  const held = await owner.query<{ capability: string }>(
    "SELECT capability FROM trucker.organisation_capability WHERE organisation_id = $1 AND status = 'granted'",
    [fresh.org],
  );
  assert.deepEqual(
    held.rows.map((row) => row.capability),
    ['organise'],
  );

  const customer = await verifiedShipper();
  const authority = await authorised(fresh, customer);
  const shipment = await arranged(fresh, authority);
  const carrier = await verifiedCarrier();
  const quotation = await quoted(carrier.person, carrier.org, shipment.id);
  const done = await accept(customer.person, customer.org, quotation.id, 1);
  assert.equal(done.status, 200, done.text);
  const booking = (done.body.booking as Booking).id;
  const snapshot = async () =>
    (
      await owner.query<{ b: string; p: string }>(
        `SELECT to_jsonb(b)::text AS b, to_jsonb(p)::text AS p
         FROM trucker.booking b JOIN trucker.booking_party p ON p.booking_id = b.id WHERE b.id = $1`,
        [booking],
      )
    ).rows[0]!;
  const accepted = await snapshot();
  // Afterwards: the authority ends, the organiser loses its capability, the fee setting changes.
  assert.equal((await endAuthority(customer, authority)).status, 200);
  assert.equal((await revokeCapability(fresh.org, 'organise')).status, 200);
  await setFinancialSettings(owner, { feeBasisPoints: 450 });
  try {
    assert.deepEqual(await snapshot(), accepted);
  } finally {
    await restoreFinancialSettings(owner);
  }
  // The roles of a booking cannot be rewritten, even by the migration role.
  await refused(
    () =>
      owner.query(
        'UPDATE trucker.booking_party SET customer_organisation_id = $1 WHERE booking_id = $2',
        [fresh.org, booking],
      ),
    /never changed/,
  );
  await refused(
    () => owner.query('DELETE FROM trucker.booking_party WHERE booking_id = $1', [booking]),
    /never changed/,
  );
  // A booking of a shipment made the old way has its roles too: the shipper's own.
  const plainCarrier = await verifiedCarrier();
  const plain = await booked(plainCarrier);
  const own = (
    await owner.query<{ organiser: string | null; customer: string; fee: string }>(
      `SELECT organiser_organisation_id AS organiser, customer_organisation_id AS customer,
              fee_payer_organisation_id AS fee FROM trucker.booking_party WHERE booking_id = $1`,
      [plain.booking.id],
    )
  ).rows[0]!;
  assert.deepEqual(
    [own.organiser, own.customer, own.fee],
    [null, plain.shipper.org, plain.shipper.org],
  );
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

test('AUDIT-5: granting organiser authority must recheck an expired customer session after its lock wait', async () => {
  const customer = await verifiedShipper();
  const organiser = await broker();
  const code = (await authorityOverview(customer)).accountCode;
  const asked = await requestAuthority(organiser, code);
  assert.equal(asked.status, 201, asked.text);
  const authority = asked.body.authority as Authority;
  const holder = await owner.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT 1 FROM trucker.organiser_authority WHERE id=$1 FOR UPDATE', [
    authority.id,
  ]);
  const pending = decideAuthority(customer, authority.id, {
    version: authority.version,
    decision: 'accept',
    mayPublish: true,
    feePayerAgreed: true,
  }).then(
    (reply) => ({ reply }),
    (error) => ({ error }),
  );
  try {
    await auditWaitForBlocked('decide_authority');
    await advance(D.session_idle_minutes * 60 + 1);
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
  const result = await pending;
  if ('error' in result) throw result.error;
  const state = (
    await owner.query('SELECT status FROM trucker.organiser_authority WHERE id=$1', [authority.id])
  ).rows[0];
  const check = await call('GET', '/me', { token: customer.person.token });
  console.log(
    'AUDIT-5 OBSERVED',
    JSON.stringify({
      grantStatus: result.reply.status,
      grant: result.reply.body,
      authority: state.status,
      subsequentSessionCheck: check.status,
    }),
  );
  assert.equal(
    result.reply.status,
    401,
    'An expired customer session granted organiser authority after waiting for the lock',
  );
});
