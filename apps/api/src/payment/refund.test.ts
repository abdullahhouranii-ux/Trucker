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
import { FeeLapseJob } from '../fee/fee-lapse.job.js';
import { PAYMENT_PROVIDER } from './provider.js';
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
import { ensureQuotationFleet } from '../testing/quotation-fleet.js';
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
const freshParty = async (party: Party): Promise<Party> => ({
  person: await newPerson(party.person.phone),
  org: party.org,
});
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
const tick = (): Promise<number> => nest.get(FeeLapseJob).tick();
// ---------------------------------------------------------------------------------------------
// Refunds (slice 28)
// ---------------------------------------------------------------------------------------------
let thirdAdmin: Staff | undefined;
/** An administrator who had no hand in the payments or refunds below. */
const thirdAdministrator = async (): Promise<Staff> =>
  fresh(thirdAdmin ?? (thirdAdmin = await newStaff(['staff_admin'])));

interface Owed {
  id: string;
  bookingId: string;
  paymentId: string;
  amount: string;
  currency: string;
  status: string;
  refunded: string;
  inProgress: string;
  remaining: string;
  method: string;
}
interface RefundRequest {
  id: string;
  version: number;
  status: string;
  method: string;
  amount: string;
  currency: string;
  providerRefundReference: string | null;
  failureReason: string | null;
  reconciliation: { outcome: string } | null;
  history: { event: string; by: { id: string } | null; detail: Record<string, unknown> }[];
}
interface Entry {
  id: string;
  subjectId: string;
  outcome: string;
  supersedes: string | null;
  note: string | null;
}
interface RefundOverview {
  staffId: string;
  owed: Owed[];
  open: RefundRequest[];
  ended: RefundRequest[];
  toReconcile: { payments: { id: string }[]; refunds: RefundRequest[] };
  discrepancies: Entry[];
}
async function refundOverview(staff: Staff): Promise<RefundOverview> {
  const reply = await call('GET', '/staff/refunds', { token: staff.token });
  assert.equal(reply.status, 200, reply.text);
  return reply.body.refunds as unknown as RefundOverview;
}
const owedFor = async (booking: string): Promise<Owed | undefined> =>
  (await refundOverview(await administrator())).owed.find((item) => item.bookingId === booking);
const requestRefund = (staff: Staff, body: Record<string, unknown>, retry = key()) =>
  call('POST', '/staff/refunds', { token: staff.token, key: retry, body });
async function requested(
  staff: Staff,
  refundId: string,
  amount: string,
  method: 'bank_transfer' | 'provider' = 'bank_transfer',
): Promise<RefundRequest> {
  const reply = await requestRefund(staff, {
    refundId,
    amount,
    method,
    note: 'Returned as agreed (fictional)',
  });
  assert.equal(reply.status, 201, reply.text);
  return reply.body.refund as RefundRequest;
}
const decideRefund = (
  staff: Staff,
  request: RefundRequest,
  decision: 'approve' | 'withdraw',
  note: string | null = null,
) =>
  call('POST', `/staff/refunds/${request.id}/decision`, {
    token: staff.token,
    body: { version: request.version, decision, note },
  });
async function approved(staff: Staff, request: RefundRequest): Promise<RefundRequest> {
  const reply = await decideRefund(staff, request, 'approve');
  assert.equal(reply.status, 200, reply.text);
  return reply.body.refund as RefundRequest;
}
const submitRefund = (staff: Staff, request: RefundRequest, bankReference: string | null = null) =>
  call('POST', `/staff/refunds/${request.id}/submit`, {
    token: staff.token,
    body: { version: request.version, bankReference },
  });
const refundOutcome = (
  staff: Staff,
  request: RefundRequest,
  outcome: 'completed' | 'failed',
  statementReference: string | null,
  note: string | null = null,
) =>
  call('POST', `/staff/refunds/${request.id}/outcome`, {
    token: staff.token,
    body: { version: request.version, outcome, statementReference, note },
  });
const reconcile = (staff: Staff, body: Record<string, unknown>, retry = key()) =>
  call('POST', '/staff/reconciliations', { token: staff.token, key: retry, body });
const requestRow = async (id: string) =>
  (
    await owner.query<{ status: string; row_version: number; amount: string }>(
      `SELECT status, row_version, trucker.amount_text(amount, minor_units) AS amount
       FROM trucker.refund_request WHERE id = $1`,
      [id],
    )
  ).rows[0]!;
const eventsOf = async (id: string) =>
  (
    await owner.query<{ event: string; staff: string | null }>(
      `SELECT event, actor_staff_id AS staff FROM trucker.refund_event WHERE refund_request_id = $1 ORDER BY seq`,
      [id],
    )
  ).rows;
/** Amounts in the currency's minor units, as the API writes them. */
const minor = (amount: string): number => Math.round(Number(amount) * 1000);
const text = (units: number, like: string): string =>
  (units / 1000).toFixed((like.split('.')[1] ?? '').length);
const payerRefunds = async (party: Party, booking: string) =>
  ((await viewOf(party, booking)).feePayment.refunds ?? []) as unknown as {
    status: string;
    refunded: string;
  }[];
/** A booking cancelled after its fee was verified from the bank statement: owed back in full. */
async function owedByTransfer(carrier: Party, shift: number) {
  const made = await booked(carrier, shift, clock(), true);
  const cancelled = await cancel(made.shipper, made.booking.id, 'dates_changed', 0);
  assert.equal(cancelled.status, 200, cancelled.text);
  const owed = await owedFor(made.booking.id);
  assert.ok(owed, 'the refund is owed');
  assert.equal(owed.method, 'bank_transfer');
  return { ...made, owed };
}
/** Paid online on a checkout opened before the booking was cancelled: owed back in full. */
async function owedOnline(carrier: Party, shift: number) {
  const made = await booked(carrier, shift);
  const checkout = await opened(made.shipper, made.booking.id);
  const cancelled = await cancel(made.shipper, made.booking.id, 'dates_changed', 0);
  assert.equal(cancelled.status, 200, cancelled.text);
  const paid = await complete(checkout.providerReference!, 'paid');
  assert.deepEqual([paid.status, paid.body.result], [200, 'refund_due'], paid.text);
  const owed = await owedFor(made.booking.id);
  assert.ok(owed, 'the refund is owed');
  assert.equal(owed.method, 'online');
  const line = (
    await owner.query<{ line: string }>(
      'SELECT statement_reference AS line FROM trucker.fee_payment WHERE id = $1',
      [owed.paymentId],
    )
  ).rows[0]!.line;
  return { ...made, owed, transaction: line.split(':').slice(2).join(':') };
}
/** Holds a row's lock until that many requests wait for locks, so they certainly overlap. */
async function whileLocked<T>(
  sql: string,
  values: unknown[],
  waiting: number,
  work: () => Promise<T>,
): Promise<T> {
  const holder = await owner.connect();
  await holder.query('BEGIN');
  await holder.query(sql, values);
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
const holdPayment = 'SELECT 1 FROM trucker.fee_payment WHERE id = $1 FOR UPDATE';

test('RF-1, D-8: a bank refund is requested by one administrator, approved by another, recorded as sent, and confirmed from the statement by someone other than the sender; every step stays in its history', async () => {
  const carrier = await verifiedCarrier();
  const a = await administrator();
  const b = await secondAdministrator();
  const { shipper, booking, owed } = await owedByTransfer(carrier, 0);
  assert.deepEqual([owed.status, owed.remaining], ['pending', owed.amount]);

  // Requested: the reason is required; the provider cannot return a bank transfer.
  const noReason = await requestRefund(a, {
    refundId: owed.id,
    amount: owed.amount,
    method: 'bank_transfer',
    note: ' ',
  });
  assert.deepEqual([noReason.status, noReason.body.code], [422, 'validation_failed']);
  const notOnline = await requestRefund(a, {
    refundId: owed.id,
    amount: owed.amount,
    method: 'provider',
    note: 'Back through the provider',
  });
  assert.equal(notOnline.status, 422);
  assert.deepEqual((notOnline.body.details as { fields: string[] }).fields, ['method']);
  const retry = key();
  const body = {
    refundId: owed.id,
    amount: owed.amount,
    method: 'bank_transfer',
    note: 'Cancelled',
  };
  const first = await requestRefund(a, body, retry);
  assert.deepEqual([first.status, first.body.outcome], [201, 'requested'], first.text);
  const again = await requestRefund(a, body, retry);
  assert.deepEqual([again.status, again.body.outcome], [201, 'already_requested']);
  const other = await requestRefund(a, { ...body, amount: '1.00' }, retry);
  assert.deepEqual([other.status, other.body.code], [409, 'retry_key_conflict']);
  let request = first.body.refund as RefundRequest;
  assert.equal(await count('refund_request', 'refund_id = $1', [owed.id]), 1);
  assert.deepEqual(
    (await payerRefunds(shipper, booking.id)).map((item) => item.status),
    ['in_progress'],
  );

  // Approved by a different administrator only.
  const own = await decideRefund(a, request, 'approve');
  assert.deepEqual([own.status, own.body.code], [409, 'different_person_required']);
  const early = await submitRefund(a, request, 'TRF-1');
  assert.deepEqual([early.status, early.body.code], [409, 'refund_not_open']);
  request = await approved(b, request);
  assert.equal(request.status, 'approved');
  const stale = await decideRefund(
    b,
    { ...request, version: request.version - 1 },
    'withdraw',
    'x',
  );
  assert.equal(stale.status, 409);

  // Sent: the transfer's reference is required.
  const noReference = await submitRefund(a, request, ' ');
  assert.deepEqual([noReference.status, noReference.body.code], [422, 'validation_failed']);
  const sent = await submitRefund(a, request, 'TRF-0001 (fictional)');
  assert.deepEqual([sent.status, sent.body.outcome], [200, 'submitted'], sent.text);
  request = sent.body.refund as RefundRequest;
  assert.equal((await payerRefunds(shipper, booking.id))[0]!.status, 'in_progress');

  // Confirmed from the statement, by someone other than the sender.
  const bySender = await refundOutcome(a, request, 'completed', 'STMT-OUT-1');
  assert.deepEqual([bySender.status, bySender.body.code], [409, 'different_person_required']);
  const noLine = await refundOutcome(b, request, 'completed', null);
  assert.deepEqual([noLine.status, noLine.body.code], [422, 'validation_failed']);
  const done = await refundOutcome(b, request, 'completed', 'STMT-OUT-1');
  assert.deepEqual([done.status, done.body.outcome], [200, 'completed'], done.text);
  request = done.body.refund as RefundRequest;
  const twice = await refundOutcome(b, request, 'failed', null, 'Too late');
  assert.deepEqual([twice.status, twice.body.code], [409, 'refund_not_open']);

  assert.deepEqual(
    (await eventsOf(request.id)).map((item) => [item.event, item.staff]),
    [
      ['requested', a.id],
      ['approved', b.id],
      ['submitted', a.id],
      ['completed', b.id],
    ],
  );
  assert.deepEqual(
    (await payerRefunds(shipper, booking.id)).map((item) => [item.status, item.refunded]),
    [['refunded', owed.amount]],
  );
  const overview = await refundOverview(a);
  assert.equal(
    overview.owed.find((item) => item.id === owed.id),
    undefined,
  );
  assert.ok(overview.ended.some((item) => item.id === request.id));
  assert.ok(overview.toReconcile.refunds.some((item) => item.id === request.id));
  // The fee payments page no longer lists money that has been returned.
  const fees = await call('GET', '/staff/fee-payments', { token: a.token });
  assert.equal(
    (fees.body.fees as { refunds: { id: string }[] }).refunds.some((item) => item.id === owed.id),
    false,
  );

  // Nothing recorded changes, even written directly: not a step back (a shape the table
  // allows, with the version moved on), not an amount, not who approved it.
  for (const change of [
    "status = 'submitted', completed_at = NULL, completed_by = NULL, statement_reference = NULL",
    'amount = amount / 2',
    'approved_by = requested_by',
    "bank_reference = 'TRF-OTHER'",
  ])
    await refused(
      () =>
        owner.query(
          `UPDATE trucker.refund_request SET ${change}, row_version = row_version + 1 WHERE id = $1`,
          [request.id],
        ),
      /only moves forward|check constraint/,
    );
  assert.equal((await requestRow(request.id)).status, 'completed');
  await refused(
    () => owner.query('DELETE FROM trucker.refund_request WHERE id = $1', [request.id]),
    /never removed/,
  );
  await refused(
    () =>
      owner.query("UPDATE trucker.refund_event SET event = 'failed' WHERE refund_request_id = $1", [
        request.id,
      ]),
    /./,
  );
  await refused(
    () =>
      owner.query('DELETE FROM trucker.refund_event WHERE refund_request_id = $1', [request.id]),
    /./,
  );
  await refused(
    () => owner.query('UPDATE trucker.fee_refund SET amount = 0 WHERE id = $1', [owed.id]),
    /./,
  );
  // The app's own role cannot reach the tables at all.
  await refused(() => app.query('SELECT 1 FROM trucker.refund_request'), /permission denied/);
  assert.deepEqual(await consistency(), []);
});

test('RF-2: a refund may be partial; requests that are not failed or withdrawn never add up to more than the payment, however they arrive', async () => {
  const carrier = await verifiedCarrier();
  const a = await administrator();
  const b = await secondAdministrator();
  const c = await thirdAdministrator();
  const { shipper, booking, owed } = await owedByTransfer(carrier, 0);
  const whole = minor(owed.amount);
  const part = text(Math.round(whole / 4 / 10) * 10, owed.amount);

  const first = await requested(a, owed.id, part);
  const tooMuch = await requestRefund(a, {
    refundId: owed.id,
    amount: text(whole - minor(part) + 10, owed.amount),
    method: 'bank_transfer',
    note: 'The rest and a little more',
  });
  assert.equal(tooMuch.status, 422);
  assert.deepEqual(
    (tooMuch.body.details as { problems: { field: string; code: string; remaining?: string }[] })
      .problems,
    [{ field: 'amount', code: 'exceeds_owed', remaining: text(whole - minor(part), owed.amount) }],
  );
  const decimals = await requestRefund(a, {
    refundId: owed.id,
    amount: '1.001',
    method: 'bank_transfer',
    note: 'Too precise',
  });
  assert.equal(decimals.status, 422);

  // A withdrawn request stays on record and frees its amount.
  const noReason = await decideRefund(b, first, 'withdraw', null);
  assert.deepEqual([noReason.status, noReason.body.code], [422, 'validation_failed']);
  const withdrawn = await decideRefund(b, first, 'withdraw', 'Amount agreed again');
  assert.deepEqual([withdrawn.status, withdrawn.body.outcome], [200, 'withdrawn']);
  const late = await decideRefund(a, withdrawn.body.refund as RefundRequest, 'approve');
  assert.deepEqual([late.status, late.body.code], [409, 'refund_not_open']);
  assert.equal((await requestRow(first.id)).status, 'withdrawn');
  const all = await requested(a, owed.id, owed.amount);
  assert.equal(await owedFor(booking.id), undefined);
  assert.equal((await decideRefund(b, all, 'withdraw', 'Part only, after all')).status, 200);
  assert.equal((await owedFor(booking.id))!.remaining, owed.amount);

  // Part, completed; the payer sees how much is back.
  let partial = await approved(b, await requested(a, owed.id, part));
  partial = (await submitRefund(a, partial, 'TRF-P1')).body.refund as RefundRequest;
  assert.equal((await refundOutcome(b, partial, 'completed', 'STMT-P1')).status, 200);
  assert.deepEqual(
    (await payerRefunds(shipper, booking.id)).map((item) => [item.status, item.refunded]),
    [['partly_refunded', part]],
  );
  // A transfer that came back frees its amount too.
  let bounced = await approved(b, await requested(a, owed.id, part));
  bounced = (await submitRefund(a, bounced, 'TRF-P2')).body.refund as RefundRequest;
  const noWhy = await refundOutcome(b, bounced, 'failed', null, null);
  assert.equal(noWhy.status, 422);
  const failed = await refundOutcome(
    b,
    bounced,
    'failed',
    null,
    'Returned by the bank (fictional)',
  );
  assert.deepEqual([failed.status, failed.body.outcome], [200, 'failed']);

  // Two administrators ask at the same moment for more than is left between them: one is refused.
  const left = whole - minor(part);
  const share = text(Math.round((left * 0.6) / 10) * 10, owed.amount);
  const replies = await whileLocked(holdPayment, [owed.paymentId], 2, () =>
    Promise.all([
      requestRefund(a, { refundId: owed.id, amount: share, method: 'bank_transfer', note: 'A' }),
      requestRefund(c, { refundId: owed.id, amount: share, method: 'bank_transfer', note: 'C' }),
    ]),
  );
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 422]);

  // Written directly, past every function: the database still refuses, alone or at once.
  const staffIds = [a.id, b.id];
  const insert = (client: pg.Pool | pg.PoolClient, amount: string, at = 0) =>
    client.query(
      `INSERT INTO trucker.refund_request
         (refund_id, payment_id, method, currency_code, minor_units, amount, status, note, requested_by,
          requested_at, request_key, request_hash)
       SELECT r.id, r.payment_id, 'bank_transfer', r.currency_code, r.minor_units, $2::numeric, 'requested',
              'Direct', $3, now(), $4, 'x'
       FROM trucker.fee_refund r WHERE r.id = $1`,
      [owed.id, amount, staffIds[at], `direct-${randomUUID()}`],
    );
  await refused(() => insert(owner, owed.amount), /exceed the payment/);
  const rest = (await owedFor(booking.id))!;
  const half = text(Math.ceil(minor(rest.remaining) / 2 / 10) * 10 + 10, owed.amount);
  const one = await owner.connect();
  const two = await owner.connect();
  try {
    await one.query('BEGIN');
    await two.query('BEGIN');
    await insert(one, half, 0);
    const blocked = insert(two, half, 1).then(
      () => 'inserted',
      (error: Error) => error.message,
    );
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const n = (
        await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE NOT l.granted AND a.datname = current_database()`,
        )
      ).rows[0]!.n;
      if (n >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await one.query('COMMIT');
    assert.match(await blocked, /exceed the payment/);
    await two.query('ROLLBACK');
  } finally {
    one.release();
    two.release();
  }
  const total = (
    await owner.query<{ total: string; paid: string }>(
      `SELECT sum(q.amount)::text AS total, max(p.amount)::text AS paid FROM trucker.refund_request q
       JOIN trucker.fee_payment p ON p.id = q.payment_id
       WHERE q.payment_id = $1 AND q.status NOT IN ('failed', 'withdrawn')`,
      [owed.paymentId],
    )
  ).rows[0]!;
  assert.ok(Number(total.total) <= Number(total.paid), `${total.total} > ${total.paid}`);
});

test('RF-3, R-13: a provider refund is marked submitted before the provider is asked; when the answer is lost, or the provider is unreachable, asking again reaches the same refund and the money is returned once', async () => {
  const carrier = await verifiedCarrier();
  const a = await administrator();
  const b = await secondAdministrator();
  const { shipper, booking, owed, transaction } = await owedOnline(carrier, 0);
  const whole = minor(owed.amount);
  const half = text(Math.round(whole / 2 / 10) * 10, owed.amount);
  const standin = standIn();

  // The answer is lost: the refund stays submitted, and the provider did refund.
  let first = await approved(b, await requested(a, owed.id, half, 'provider'));
  standin.trouble = 'lose-next-answer';
  const lost = await submitRefund(a, first);
  assert.deepEqual([lost.status, lost.body.code], [502, 'refund_unconfirmed'], lost.text);
  assert.equal((await requestRow(first.id)).status, 'submitted');
  assert.equal(minor(String(standin.refundedOn(transaction))), minor(half));
  assert.equal((await payerRefunds(shipper, booking.id))[0]!.status, 'in_progress');
  // Asking again sends the same identifier: the provider answers for the refund it made.
  const again = await submitRefund(a, first);
  assert.deepEqual([again.status, again.body.outcome], [200, 'completed'], again.text);
  first = again.body.refund as RefundRequest;
  assert.ok(first.providerRefundReference);
  assert.equal(minor(String(standin.refundedOn(transaction))), minor(half));
  assert.deepEqual(
    (await eventsOf(first.id)).map((item) => item.event),
    ['requested', 'approved', 'submitted', 'resubmitted', 'completed'],
  );

  // Unreachable: nothing is claimed; the job asks later and sends what never arrived.
  const rest = text(whole - minor(half), owed.amount);
  const second = await approved(b, await requested(a, owed.id, rest, 'provider'));
  standin.trouble = 'outage';
  const down = await submitRefund(a, second);
  assert.deepEqual([down.status, down.body.code], [502, 'refund_unconfirmed']);
  assert.equal((await requestRow(second.id)).status, 'submitted');
  // While it waits, who sent it and when stay as recorded.
  await refused(
    () =>
      owner.query(
        'UPDATE trucker.refund_request SET submitted_by = $2, row_version = row_version + 1 WHERE id = $1',
        [second.id, b.id],
      ),
    /only moves forward/,
  );
  assert.equal(await tick(), 0);
  assert.equal((await requestRow(second.id)).status, 'submitted');
  standin.trouble = 'none';
  await advance(2 * 60);
  await tick();
  assert.equal((await requestRow(second.id)).status, 'completed');
  assert.equal(minor(String(standin.refundedOn(transaction))), whole);
  await tick();
  assert.equal(minor(String(standin.refundedOn(transaction))), whole);
  assert.deepEqual(
    (await payerRefunds(await freshParty(shipper), booking.id)).map((item) => [
      item.status,
      item.refunded,
    ]),
    [['refunded', owed.amount]],
  );

  // Submitted twice at the same moment: one submission, one refund at the provider.
  const twin = await owedOnline(await freshParty(carrier), 1);
  const both = await approved(
    await secondAdministrator(),
    await requested(await administrator(), twin.owed.id, twin.owed.amount, 'provider'),
  );
  const staff = [await administrator(), await thirdAdministrator()];
  const replies = await whileLocked(holdPayment, [twin.owed.paymentId], 2, () =>
    Promise.all(staff.map((member) => submitRefund(member, both))),
  );
  assert.deepEqual(
    replies.map((reply) => [reply.status, reply.body.outcome]).sort(),
    [
      [200, 'completed'],
      [200, 'repeated'],
    ],
    replies.map((reply) => reply.text).join('\n'),
  );
  assert.equal(minor(String(standin.refundedOn(twin.transaction))), minor(twin.owed.amount));
  assert.equal((await eventsOf(both.id)).filter((item) => item.event === 'submitted').length, 1);
});

test('RF-4: a provider that refuses a refund leaves it failed with the reason and the amount free; a later contradicting answer is recorded and never applied', async () => {
  const carrier = await verifiedCarrier();
  const a = await administrator();
  const b = await secondAdministrator();
  const { owed, transaction } = await owedOnline(carrier, 0);
  const standin = standIn();

  let refused1 = await approved(b, await requested(a, owed.id, owed.amount, 'provider'));
  standin.trouble = 'fail-next-refund';
  const answer = await submitRefund(a, refused1);
  assert.deepEqual([answer.status, answer.body.outcome], [200, 'failed'], answer.text);
  refused1 = answer.body.refund as RefundRequest;
  assert.equal(refused1.failureReason, 'declined by the stand-in');
  assert.equal(standin.refundedOn(transaction), 0);
  assert.equal((await owedFor(owed.bookingId))!.remaining, owed.amount);
  // A bank outcome is not recorded on a provider refund.
  const wrongPath = await refundOutcome(b, refused1, 'completed', 'STMT-X');
  assert.equal(wrongPath.status, 404);

  // The provider later says it succeeded after all: recorded, not applied.
  const contradiction = await owner.query<{ status: string }>(
    'SELECT status FROM trucker.refund_provider_report($1, $2)',
    [
      refused1.id,
      JSON.stringify({
        status: 'succeeded',
        providerRefundReference: refused1.providerRefundReference,
      }),
    ],
  );
  assert.equal(contradiction.rows[0]!.status, 'contradicted');
  assert.equal((await requestRow(refused1.id)).status, 'failed');
  assert.deepEqual((await eventsOf(refused1.id)).map((item) => item.event).slice(-2), [
    'failed',
    'provider_answered',
  ]);

  // Requested again, it goes through.
  const retried = await approved(b, await requested(a, owed.id, owed.amount, 'provider'));
  const ok = await submitRefund(a, retried);
  assert.deepEqual([ok.status, ok.body.outcome], [200, 'completed'], ok.text);
  // An answer about a different refund reference is not applied to this one.
  const foreign = await owner.query<{ status: string }>(
    'SELECT status FROM trucker.refund_provider_report($1, $2)',
    [
      retried.id,
      JSON.stringify({ status: 'failed', providerRefundReference: 'tref_someone_else' }),
    ],
  );
  assert.equal(foreign.rows[0]!.status, 'contradicted');
  assert.equal((await requestRow(retried.id)).status, 'completed');
  assert.equal(minor(String(standin.refundedOn(transaction))), minor(owed.amount));
});

test('RF-5, D-8: reconciliation is recorded by someone with no hand in the payment or refund; the outcome is worked out, not chosen; a correction replaces an entry and the replaced entry stays', async () => {
  const carrier = await verifiedCarrier();
  const a = await administrator();
  const b = await secondAdministrator();
  const c = await thirdAdministrator();
  const { owed } = await owedByTransfer(carrier, 0);

  // The payment: recorded by a, approved by b.
  const payment = {
    subjectType: 'payment',
    subjectId: owed.paymentId,
    source: 'bank_statement',
    sourceReference: 'STMT-IN-1',
    amount: owed.amount,
    currency: owed.currency,
  };
  for (const member of [a, b]) {
    const own = await reconcile(member, payment);
    assert.deepEqual([own.status, own.body.code], [409, 'independent_person_required']);
  }
  const retry = key();
  const matched = await reconcile(c, payment, retry);
  assert.deepEqual([matched.status, (matched.body.entry as Entry).outcome], [201, 'matched']);
  const repeated = await reconcile(c, payment, retry);
  assert.deepEqual([repeated.status, repeated.body.outcome], [201, 'already_recorded']);
  const second = await reconcile(c, { ...payment, sourceReference: 'STMT-IN-2' });
  assert.deepEqual([second.status, second.body.code], [409, 'already_reconciled']);

  // The refund: requested by a, approved by b, sent by a, confirmed by b.
  let request = await approved(b, await requested(a, owed.id, owed.amount));
  request = (await submitRefund(a, request, 'TRF-R1')).body.refund as RefundRequest;
  request = (await refundOutcome(b, request, 'completed', 'STMT-OUT-R1')).body
    .refund as RefundRequest;
  const refund = {
    subjectType: 'refund',
    subjectId: request.id,
    source: 'bank_statement',
    sourceReference: 'STMT-OUT-R1',
    currency: owed.currency,
  };
  assert.equal((await reconcile(a, { ...refund, amount: owed.amount })).status, 409);
  // It does not match: a note is required, and it stays listed as a discrepancy.
  const wrong = text(minor(owed.amount) - 10, owed.amount);
  const silent = await reconcile(c, { ...refund, amount: wrong });
  assert.deepEqual([silent.status, silent.body.code], [422, 'validation_failed']);
  const off = await reconcile(c, {
    ...refund,
    amount: wrong,
    note: 'Bank charged a fee (fictional)',
  });
  assert.equal(off.status, 201, off.text);
  const discrepancy = off.body.entry as Entry;
  assert.equal(discrepancy.outcome, 'discrepancy');
  assert.ok((await refundOverview(c)).discrepancies.some((item) => item.id === discrepancy.id));
  // Corrected: a note is required; the replaced entry stays as it was.
  const bare = await reconcile(c, { ...refund, amount: owed.amount, supersedes: discrepancy.id });
  assert.equal(bare.status, 422);
  const fixed = await reconcile(c, {
    ...refund,
    amount: owed.amount,
    supersedes: discrepancy.id,
    note: 'Misread the statement line',
  });
  assert.equal(fixed.status, 201, fixed.text);
  const correction = fixed.body.entry as Entry;
  assert.deepEqual([correction.outcome, correction.supersedes], ['matched', discrepancy.id]);
  const overview = await refundOverview(c);
  assert.equal(
    overview.discrepancies.some((item) => item.id === discrepancy.id),
    false,
  );
  assert.equal(
    overview.toReconcile.refunds.some((item) => item.id === request.id),
    false,
  );
  const entries = (
    await owner.query<{ id: string; outcome: string; amount: string; supersedes: string | null }>(
      `SELECT id, outcome, amount::text AS amount, supersedes FROM trucker.reconciliation_entry
       WHERE refund_request_id = $1 ORDER BY reconciled_at, supersedes NULLS FIRST`,
      [request.id],
    )
  ).rows;
  assert.deepEqual(
    entries.map((item) => [item.id, item.outcome, item.supersedes]),
    [
      [discrepancy.id, 'discrepancy', null],
      [correction.id, 'matched', discrepancy.id],
    ],
  );
  // The replaced entry cannot be corrected again: only the one in force can.
  const stale = await reconcile(c, {
    ...refund,
    amount: owed.amount,
    supersedes: discrepancy.id,
    note: 'Again',
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'already_reconciled']);
  await refused(
    () =>
      owner.query("UPDATE trucker.reconciliation_entry SET outcome = 'matched' WHERE id = $1", [
        discrepancy.id,
      ]),
    /./,
  );
  await refused(
    () => owner.query('DELETE FROM trucker.reconciliation_entry WHERE id = $1', [discrepancy.id]),
    /./,
  );
  // Only what is final is reconciled: an open refund is not.
  const another = await owedByTransfer(await freshParty(carrier), 1);
  const open = await requested(a, another.owed.id, another.owed.amount);
  const tooSoon = await reconcile(c, {
    ...refund,
    subjectId: open.id,
    amount: another.owed.amount,
  });
  assert.equal(tooSoon.status, 404);
  // A correction names the entry in force for its own subject, never another's.
  const elsewhere = await reconcile(c, {
    ...refund,
    amount: owed.amount,
    supersedes: (matched.body.entry as Entry).id,
    note: 'Wrong entry',
  });
  assert.deepEqual([elsewhere.status, elsewhere.body.code], [409, 'already_reconciled']);
  // A currency that differs is a discrepancy, never a match, even when an outcome is sent
  // straight to the database.
  const direct = await app.query<{ status: string; detail: Entry }>(
    'SELECT status, detail FROM trucker.staff_reconcile($1, $2, $3, $4)',
    [
      hashToken(c.token),
      key(),
      JSON.stringify({
        ...payment,
        subjectId: another.owed.paymentId,
        currency: owed.currency === 'XXX' ? 'XXY' : 'XXX',
        outcome: 'matched',
        note: 'Shown in another currency',
      }),
      null,
    ],
  );
  assert.deepEqual(
    [direct.rows[0]!.status, direct.rows[0]!.detail.outcome],
    ['recorded', 'discrepancy'],
  );
});

/** Holds a lock until a request waits for it, runs what happens meanwhile, then lets go. */
async function duringWait<T>(
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

test('RF-6, review R4: a refund step that waited for the payment while the staff session ended, or while the privilege was removed, changes nothing', async () => {
  const carrier = await verifiedCarrier();
  const a = await administrator();
  const b = await secondAdministrator();
  const { owed } = await owedByTransfer(carrier, 0);
  const request = await requested(a, owed.id, owed.amount);
  const late = await duringWait(
    holdPayment,
    [owed.paymentId],
    () => decideRefund(b, request, 'approve'),
    () => advance(D.staff_session_idle_minutes * 60 + 1),
  );
  assert.deepEqual([late.status, late.body.code], [401, 'unauthorized']);
  assert.equal((await requestRow(request.id)).status, 'requested');
  assert.deepEqual(
    (await eventsOf(request.id)).map((item) => item.event),
    ['requested'],
  );
  const c = await newStaff(['staff_admin']);
  const removed = await duringWait(
    holdPayment,
    [owed.paymentId],
    () => decideRefund(c, request, 'approve'),
    () =>
      owner.query(
        "DELETE FROM trucker.staff_privilege WHERE staff_id = $1 AND privilege = 'staff_admin'",
        [c.id],
      ),
  );
  assert.deepEqual([removed.status, removed.body.code], [403, 'staff_privilege_required']);
  assert.equal((await requestRow(request.id)).status, 'requested');
});
