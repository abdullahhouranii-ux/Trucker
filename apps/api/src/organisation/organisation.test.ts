import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import { AppModule } from '../app.module.js';
import { ConfigError, loadConfig, SECURITY_PERIOD_DEFAULTS } from '../config/config.js';
import { inspectAccess, productionStartProblems } from '../database/access.js';
import {
  appDatabaseUrl,
  ensureLocalAppLogin,
  fixtureSafeguardProblems,
  FIXTURES_ACKNOWLEDGEMENT,
  loadCountryFixtures,
  markEnvironment,
} from '../database/local.js';
import { defaultMigrationsDir, migrateUp } from '../database/migrations.js';
import { SECURITY_SETTING_DEFAULTS, writeSecuritySettings } from '../database/settings.js';
import { configureApp } from '../http/configure-app.js';
import type { Logger } from '../http/logger.js';
import { hashToken } from '../identity/secrets.js';
import { DEMONSTRATION_TERMS_VERSION } from '../identity/terms.js';
import { createTestClock } from '../testing/test-clock.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';

// ---------------------------------------------------------------------------------------------
// A migrated test database, marked "test", holding the fictional countries. The API under test
// connects with the local login of the API's role, never with the migration role.
// ---------------------------------------------------------------------------------------------
const testClock = createTestClock();
const { clock, advance } = testClock;

const logged: string[] = [];
const collecting: Logger = {
  info: (entry) => void logged.push(JSON.stringify(entry)),
  error: (entry) => void logged.push(JSON.stringify(entry)),
};

interface Api {
  base: string;
}
let database: TestDatabase;
let owner: pg.Pool; // the migration role: sets things up, and plays the attacker's foil
let app: pg.Pool; // the API's role, used directly to test what the database itself allows
let api: Api; // API role, fixtures on
let single: Api; // the same with one pooled connection
let noFixtures: Api; // API role, fixtures off: what any environment without approved countries sees
let privileged: Api; // connected with the migration role
const apps: INestApplication[] = [];

async function startApi(overrides: Record<string, string>): Promise<Api> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    SIGN_IN_CODE_DELIVERY: 'development-display',
    REGISTRATION_TERMS: 'demonstration',
    ...overrides,
  });
  const nest = configureApp(
    await NestFactory.create(AppModule.register(config, clock), { logger: false }),
    collecting,
  );
  await nest.listen(0, '127.0.0.1');
  apps.push(nest);
  const { port } = nest.getHttpServer().address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}` };
}

before(async () => {
  database = await createTestDatabase();
  owner = new pg.Pool({ connectionString: database.url });
  await migrateUp(owner, defaultMigrationsDir());
  await ensureLocalAppLogin(owner);
  await markEnvironment(owner, 'test');
  await testClock.start(owner);
  await loadCountryFixtures(owner);
  const appUrl = appDatabaseUrl(database.url);
  app = new pg.Pool({ connectionString: appUrl, max: 2 });
  api = await startApi({ APP_DATABASE_URL: appUrl, COUNTRY_FIXTURES: 'local-development' });
  single = await startApi({
    APP_DATABASE_URL: appUrl,
    COUNTRY_FIXTURES: 'local-development',
    DB_POOL_MAX: '1',
  });
  noFixtures = await startApi({ APP_DATABASE_URL: appUrl });
  privileged = await startApi({ COUNTRY_FIXTURES: 'local-development' });
});
after(async () => {
  for (const nest of apps) await nest.close();
  await app.end();
  await owner.end();
  await database.drop();
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
  requestId: string | null;
}
async function call(
  target: Api,
  method: string,
  route: string,
  options: { body?: unknown; token?: string; key?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.key) headers['idempotency-key'] = options.key;
  if (route === '/auth/code-requests') {
    headers['x-trucker-development-code'] = 'local-visitor';
    headers['idempotency-key'] = `test-${randomUUID()}`;
  }
  if (route === '/auth/code-verifications') headers['idempotency-key'] = `test-${randomUUID()}`;
  const response = await fetch(target.base + route, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    requestId: response.headers.get('x-request-id'),
  };
}

// Fictional numbers: country code 999 is not assigned to any country.
let phoneCounter = 0;
const newPhone = (): string => `+99977${String(1_000_000 + phoneCounter++)}`;
const key = (): string => `test-${randomUUID()}`;

interface Person {
  token: string;
  personId: string;
  sessionId: string;
  phone: string;
}
async function signInAs(phone: string): Promise<Person> {
  const asked = await call(api, 'POST', '/auth/code-requests', { body: { phone } });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const verified = await call(api, 'POST', '/auth/code-verifications', {
    body: { challengeId: asked.body.challengeId, code: asked.body.developmentCode },
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  await advance(SECURITY_SETTING_DEFAULTS.code_resend_wait_seconds + 1);
  return {
    token: verified.body.token as string,
    personId: (verified.body.person as { id: string }).id,
    sessionId: (verified.body.session as { id: string }).id,
    phone,
  };
}
/** A signed-in person who has finished registration. */
async function newPerson(): Promise<Person> {
  const person = await signInAs(newPhone());
  const done = await call(api, 'POST', '/me/registration', {
    token: person.token,
    body: {
      displayName: 'Test Person (fictional)',
      termsVersion: DEMONSTRATION_TERMS_VERSION,
      termsLanguage: 'en',
      termsSeen: true,
    },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return person;
}

const details = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  legalName: 'Fixture Freight Company (fictional)',
  countryCode: 'XA',
  registrationNumber: 'FX-000123',
  ...overrides,
});
interface Organisation {
  id: string;
  version: number;
  status: string;
  legalName: string;
  [name: string]: unknown;
}
async function createOrganisation(
  person: Person,
  overrides: Record<string, unknown> = {},
  retryKey = key(),
): Promise<Organisation> {
  const reply = await call(api, 'POST', '/organisations', {
    token: person.token,
    key: retryKey,
    body: details(overrides),
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.organisation as Organisation;
}
const count = async (table: string, where = 'true', values: unknown[] = []): Promise<number> =>
  (
    await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trucker.${table} WHERE ${where}`,
      values,
    )
  ).rows[0]!.n;

/** Runs statements as the API's role with a given request context, then rolls back. */
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
const refused = async (work: () => Promise<unknown>, pattern: RegExp): Promise<void> => {
  await assert.rejects(work, (error: Error) => pattern.test(error.message), String(pattern));
};

// ---------------------------------------------------------------------------------------------
// The API's database role (TI-1) and the catalogue (TI-2)
// ---------------------------------------------------------------------------------------------
test('the API role is bound by row security; the migration role is not, and is detected', async () => {
  const bound = await inspectAccess(app);
  assert.deepEqual(bound.problems, []);
  assert.equal(bound.rowSecurityBinds, true);
  assert.equal(bound.environment, 'test');
  const unbound = await inspectAccess(owner);
  assert.equal(unbound.rowSecurityBinds, false);
  assert.ok(unbound.problems.some((problem) => problem.includes('owns tables')));
});

test('the API role cannot switch off, alter or add to row security, or become another role', async () => {
  const ownerRole = (await owner.query<{ current_user: string }>('SELECT current_user')).rows[0]!
    .current_user;
  const quotedOwnerRole = '"' + ownerRole.replaceAll('"', '""') + '"';
  for (const statement of [
    'ALTER TABLE trucker.organisation DISABLE ROW LEVEL SECURITY',
    'ALTER TABLE trucker.organisation NO FORCE ROW LEVEL SECURITY',
    'DROP POLICY organisation_read ON trucker.organisation',
    'ALTER POLICY organisation_read ON trucker.organisation USING (true)',
    'CREATE POLICY open_all ON trucker.organisation FOR SELECT USING (true)',
    'ALTER TABLE trucker.organisation OWNER TO trucker_app',
    'DROP FUNCTION trucker.is_member(uuid)',
    'CREATE OR REPLACE FUNCTION trucker.is_member(organisation uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$',
    'DROP TRIGGER organisation_audit ON trucker.organisation',
    'ALTER TABLE trucker.organisation DISABLE TRIGGER organisation_audit',
    'CREATE TABLE trucker.side_door (id int)',
    `SET ROLE ${quotedOwnerRole}`,
    `SET SESSION AUTHORIZATION ${quotedOwnerRole}`,
    'SET row_security = off; SELECT * FROM trucker.organisation',
  ]) {
    await refused(
      () => asApiRole({}, (client) => client.query(statement)),
      /permission denied|must be owner|must be member|row-level security policy|not permitted|cannot/i,
    );
  }
});

test('the API role cannot write organisations, memberships, history, countries or the mark directly', async () => {
  const person = await newPerson();
  const organisation = await createOrganisation(person);
  const context = { tokenHash: hashToken(person.token), organisationId: organisation.id };
  for (const statement of [
    `INSERT INTO trucker.organisation (legal_name, country_code, registration_number, created_by, created_at, updated_at)
       VALUES ('x', 'XA', 'x', '${person.personId}', now(), now())`,
    `DELETE FROM trucker.organisation WHERE id = '${organisation.id}'`,
    `UPDATE trucker.organisation SET status = 'verified' WHERE id = '${organisation.id}'`,
    `UPDATE trucker.organisation SET created_by = gen_random_uuid() WHERE id = '${organisation.id}'`,
    `INSERT INTO trucker.membership (organisation_id, person_id, role, created_at)
       VALUES ('${organisation.id}', '${person.personId}', 'admin', now())`,
    `UPDATE trucker.membership SET ended_at = now()`,
    `DELETE FROM trucker.membership`,
    `INSERT INTO trucker.audit_entry (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, after_values)
       VALUES (now(), '${person.personId}', '${organisation.id}', 'organisation.updated', 'organisation', '${organisation.id}', '{}')`,
    `UPDATE trucker.audit_entry SET after_values = '{}'`,
    `DELETE FROM trucker.audit_entry`,
    `TRUNCATE trucker.audit_entry`,
    `INSERT INTO trucker.country (code, name_en, name_ar, name_ur, registration_state, fixture)
       VALUES ('XZ', 'x', 'x', 'x', 'enabled', true)`,
    `UPDATE trucker.country SET registration_state = 'enabled'`,
    `UPDATE trucker.environment SET kind = 'production'`,
    `DELETE FROM trucker.session`,
    `DELETE FROM trucker.identity_event`,
    `UPDATE trucker.identity_event SET kind = 'signed_in'`,
  ]) {
    await refused(
      () => asApiRole(context, (client) => client.query(statement)),
      /permission denied/i,
    );
  }
});

test('every table has row security: a policy, or no right at all for the API', async () => {
  // Tables the API may read whole: they hold no data about an organisation or a person.
  const open = new Set([
    'environment',
    'country',
    'country_time_zone',
    'lane',
    'lane_transit',
    'evidence_requirement',
    'cargo_category',
    'equipment_type',
  ]);
  // Tables the API's role has no right on at all. Row security with no policy is their second
  // barrier. A new table is on neither list, so it must carry row security and a policy, or
  // this test fails.
  const closed = [
    'fee_invoice_draft',
    'record_photo',
    'booking_closure',
    'booking_closure_assignment',
    'booking_payment_event',
    'booking_payment_record',
    'booking_dispute',
    'booking_dispute_event',
    'booking_price',
    'financial_setting_version',
    'booking_fee',
    'fee_checkout',
    'fee_receipt',
    'payment_notification',
    'fee_checkout_inquiry',
    'trip',
    'trip_milestone',
    'trip_estimate',
    'dispatch_block',
    'trip_hold',
    'trip_milestone_withdrawal',
    'trip_case',
    'trip_case_booking',
    'trip_case_event',
    'trip_delivery_outcome',
    'cargo_handover',
    'resource_release',
    'instruction_authority',
    'delivery_shortfall',
    'cargo_case',
    'cargo_instruction',
    'trip_leg',
    'exception_cost',
    'carrier_claim',
    'settlement_hold',
    'cargo_handover_receipt',
    'cargo_command',
    'pod_version',
    'pod_item',
    'pod_review',
    'pod_file_view',
    'fee_payment',
    'fee_refund',
    'refund_request',
    'refund_event',
    'reconciliation_entry',
    'commission_contract',
    'booking_commission',
    'quotation_commission',
    'shipment_commission',
    'booking_party',
    'organiser_authority',
    'shipment_party',
    'booking_cancellation',
    'booking_publication_cycle',
    'assignment_acknowledgement',
    'booking',
    'booking_assignment',
    'booking_assignment_state',
    'booking_confirmation',
    'booking_retry_key',
    'booking_risk_flag',
    'booking_substitution',
    'booking_terms',
    'booking_wait_decision',
    'carrier_access_log',
    'country_currency',
    'currency',
    'driver_affiliation',
    'driver_authorisation',
    'fleet_document',
    'fleet_document_type',
    'fleet_retry_key',
    'fleet_suspension',
    'identity_event',
    'licence_class',
    'licence_class_category',
    'occupancy_episode',
    'person',
    'quotation',
    'quotation_inclusion',
    'quotation_read_log',
    'quotation_retry_key',
    'quotation_version',
    'resource_reservation',
    'security_setting',
    'session',
    'shipment_quotation_terms',
    'shipment_retry_key',
    'sign_in_challenge',
    'staff_account',
    'staff_audit_entry',
    'staff_enrolment',
    'staff_privilege',
    'staff_recovery_code',
    'staff_session',
    'staff_sign_in_ticket',
    'terms_acceptance',
    'test_clock',
    'vehicle',
    'vehicle_category',
    'verification_retry_key',
  ];
  const tables = await owner.query<{
    name: string;
    secured: boolean;
    policies: number;
    rights: number;
  }>(
    `SELECT c.relname AS name, c.relrowsecurity AS secured,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            (SELECT count(*)::int FROM information_schema.role_table_grants g
              WHERE g.table_schema = 'trucker' AND g.table_name = c.relname
                AND g.grantee IN ('trucker_app', 'PUBLIC'))
            + (SELECT count(*)::int FROM information_schema.column_privileges g
              WHERE g.table_schema = 'trucker' AND g.table_name = c.relname
                AND g.grantee IN ('trucker_app', 'PUBLIC')) AS rights
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'trucker' AND c.relkind = 'r' ORDER BY 1`,
  );
  const byName = new Map(tables.rows.map((table) => [table.name, table]));
  for (const name of closed) {
    const table = byName.get(name);
    assert.ok(table, `${name} is missing`);
    assert.ok(table.secured, `${name} has no row security`);
    assert.equal(table.policies, 0, `${name} has a policy: nothing should reach it`);
    assert.equal(table.rights, 0, `the API's role has a right on ${name}`);
  }
  const checked = tables.rows.filter(
    (table) => !open.has(table.name) && !closed.includes(table.name),
  );
  assert.deepEqual(
    checked.map((table) => table.name),
    [
      'audit_entry',
      'carrier_service_country',
      'carrier_service_equipment',
      'membership',
      'organisation',
      'organisation_capability',
      'retry_key',
      'shipment_draft',
      'shipment_publication_version',
      'shipment_suspension',
      'verification_application',
      'verification_evidence',
    ],
  );
  for (const table of checked) {
    assert.ok(table.secured, `${table.name} has no row security`);
    assert.ok(table.policies > 0, `${table.name} has no policy`);
  }
  // And the API role holds no right to bypass them through ownership or membership.
  const roles = await owner.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('trucker_app', 'trucker_api_local')`,
  );
  assert.equal(roles.rowCount, 2);
  for (const role of roles.rows) assert.ok(!role.rolsuper && !role.rolbypassrls, role.rolname);
});

// ---------------------------------------------------------------------------------------------
// Creating an organisation (ORG-1 to ORG-6, ORG-10)
// ---------------------------------------------------------------------------------------------
test('a registered person creates a draft shipper organisation and becomes its administrator', async () => {
  const person = await newPerson();
  const organisation = await createOrganisation(person, {
    tradingName: 'Fixture Freight',
    address: 'Unit 1, Example Road',
    contactName: 'A. Person',
  });
  assert.equal(organisation.status, 'draft');
  assert.equal(organisation.requestedCapability, 'ship');
  assert.equal(organisation.version, 1);
  assert.equal(organisation.tradingName, 'Fixture Freight');
  const members = await owner.query<{ person_id: string; role: string; ended_at: Date | null }>(
    'SELECT person_id, role, ended_at FROM trucker.membership WHERE organisation_id = $1',
    [organisation.id],
  );
  assert.deepEqual(members.rows, [{ person_id: person.personId, role: 'admin', ended_at: null }]);
  // The number's country code (+999) plays no part: the same person registers in another country.
  const second = await createOrganisation(person, { countryCode: 'XB' });
  assert.equal(second.countryCode, 'XB');
});

test('nobody creates an organisation without signing in, or before finishing registration', async () => {
  const anonymous = await call(api, 'POST', '/organisations', { key: key(), body: details() });
  assert.equal(anonymous.status, 401);
  const unfinished = await signInAs(newPhone());
  const reply = await call(api, 'POST', '/organisations', {
    token: unfinished.token,
    key: key(),
    body: details(),
  });
  assert.equal(reply.status, 403);
  assert.equal(reply.body.code, 'registration_incomplete');
  assert.equal(await count('organisation', 'created_by = $1', [unfinished.personId]), 0);
});

test('organisation, first administrator and history are written together or not at all', async () => {
  const person = await newPerson();
  await owner.query(`
    CREATE FUNCTION trucker.test_break() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'forced failure for the test'; END $$;
    CREATE TRIGGER test_break BEFORE INSERT ON trucker.membership
      FOR EACH ROW EXECUTE FUNCTION trucker.test_break();`);
  try {
    const retryKey = key();
    const reply = await call(api, 'POST', '/organisations', {
      token: person.token,
      key: retryKey,
      body: details(),
    });
    assert.equal(reply.status, 500);
    assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 0);
    assert.equal(await count('audit_entry', 'actor_person_id = $1', [person.personId]), 0);
    assert.equal(await count('retry_key', 'person_id = $1', [person.personId]), 0);
  } finally {
    await owner.query(
      'DROP TRIGGER test_break ON trucker.membership; DROP FUNCTION trucker.test_break()',
    );
  }
  // The same person succeeds once the fault is gone, so nothing half-made was left behind.
  await createOrganisation(person);
});

test('missing or malformed details are refused, each field is named, and nothing is saved', async () => {
  const person = await newPerson();
  const cases: [Record<string, unknown>, string[]][] = [
    [{ legalName: '   ' }, ['legalName']],
    [{ legalName: undefined, registrationNumber: '' }, ['legalName', 'registrationNumber']],
    [{ countryCode: 'xa' }, ['countryCode']],
    [{ countryCode: 'XAA' }, ['countryCode']],
    [{ legalName: 'x'.repeat(201) }, ['legalName']],
    [{ address: 'x'.repeat(501) }, ['address']],
    [{ contactName: 7 }, ['contactName']],
  ];
  for (const [overrides, fields] of cases) {
    const reply = await call(api, 'POST', '/organisations', {
      token: person.token,
      key: key(),
      body: details(overrides),
    });
    assert.equal(reply.status, 422, JSON.stringify(overrides));
    assert.equal(reply.body.code, 'validation_failed');
    assert.deepEqual((reply.body.details as { fields: string[] }).fields, fields);
  }
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 0);
  assert.equal(await count('retry_key', 'person_id = $1', [person.personId]), 0);
});

test('only a country that is open for registration is accepted', async () => {
  const person = await newPerson();
  for (const countryCode of ['XC', 'ZZ', 'AA']) {
    const reply = await call(api, 'POST', '/organisations', {
      token: person.token,
      key: key(),
      body: details({ countryCode }),
    });
    assert.equal(reply.status, 422, countryCode);
    assert.deepEqual((reply.body.details as { fields: string[] }).fields, ['countryCode']);
  }
  const open = await call(api, 'GET', '/registration/countries', { token: person.token });
  assert.deepEqual(
    (open.body.countries as { code: string; fixture: boolean }[]).map((country) => country.code),
    ['XA', 'XB'],
  );
  assert.ok((open.body.countries as { fixture: boolean }[]).every((country) => country.fixture));
  assert.equal((await call(api, 'GET', '/registration/countries')).status, 401);
});

test('names and addresses come back exactly as typed, in any script', async () => {
  const person = await newPerson();
  const values = {
    legalName: 'شركة الشحن التجريبية (وهمية) ذ.م.م',
    tradingName: 'آزمائشی فریٹ کمپنی (فرضی)',
    registrationNumber: 'CR-۱۲۳٤٥/A',
    address: 'مبنى 7، Example Road 12, طابق ٣',
    contactName: 'Zoë D’Souza–محمد',
  };
  const organisation = await createOrganisation(person, values);
  const read = await call(api, 'GET', `/organisations/${organisation.id}`, { token: person.token });
  for (const [name, value] of Object.entries(values))
    assert.equal((read.body.organisation as Record<string, unknown>)[name], value, name);
});

// ---------------------------------------------------------------------------------------------
// Decisions O-1 and O-4
// ---------------------------------------------------------------------------------------------
test('the same registration number may be used on several drafts, and reveals nothing (O-1)', async () => {
  const first = await newPerson();
  const second = await newPerson();
  const number = `DUP-${randomBytes(4).toString('hex')}`;
  const a = await createOrganisation(first, {
    registrationNumber: number,
    legalName: 'First claimant',
  });
  const reply = await call(api, 'POST', '/organisations', {
    token: second.token,
    key: key(),
    body: details({ registrationNumber: number, legalName: 'Second claimant' }),
  });
  assert.equal(reply.status, 201);
  const b = reply.body.organisation as Organisation;
  assert.notEqual(a.id, b.id);
  assert.ok(!JSON.stringify(reply.body).includes('First claimant'));
  assert.ok(!JSON.stringify(reply.body).includes(a.id));
  // The same person may also hold two drafts with one number.
  await createOrganisation(first, { registrationNumber: number });
  assert.equal(await count('organisation', 'registration_number = $1', [number]), 3);
});

test('one person may create five organisations by default, and no more (O-4)', async () => {
  const person = await newPerson();
  for (let made = 0; made < 4; made += 1) await createOrganisation(person);
  // Three at once when one place is left: exactly one succeeds.
  const racing = await Promise.all(
    [1, 2, 3].map(() =>
      call(api, 'POST', '/organisations', { token: person.token, key: key(), body: details() }),
    ),
  );
  assert.deepEqual(racing.map((reply) => reply.status).sort(), [201, 409, 409]);
  const over = racing.find((reply) => reply.status === 409)!;
  assert.equal(over.body.code, 'organisation_limit_reached');
  assert.deepEqual(over.body.details, { limit: 5 });
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 5);
  assert.equal(SECURITY_SETTING_DEFAULTS.organisation_creation_limit, 5);
});

test("the creation limit and the time of a change are the database's: a caller can set neither", async () => {
  const person = await newPerson();
  const first = await createOrganisation(person);
  const context = { tokenHash: hashToken(person.token) };
  // The limit is a protected setting. Tightened by the migration role, it applies at once,
  // to the API and to a direct call alike; nothing the caller sets is read.
  await writeSecuritySettings(owner, { organisation_creation_limit: 1 }, false);
  try {
    const viaApi = await call(api, 'POST', '/organisations', {
      token: person.token,
      key: key(),
      body: details(),
    });
    assert.equal(viaApi.status, 409);
    assert.deepEqual(viaApi.body.details, { limit: 1 });
    await refused(
      () =>
        asApiRole(context, async (client) => {
          await client.query(
            `SELECT set_config('trucker.organisation_creation_limit', '1000', true)`,
          );
          return client.query(
            `SELECT trucker.create_organisation('Over the limit', NULL, 'XA', 'X-2', NULL, NULL, true)`,
          );
        }),
      /creation limit reached/,
    );
    await refused(
      () =>
        asApiRole(context, (client) =>
          client.query(`UPDATE trucker.security_setting SET organisation_creation_limit = 1000`),
        ),
      /permission denied/,
    );
  } finally {
    await writeSecuritySettings(owner, { ...SECURITY_SETTING_DEFAULTS }, false);
  }
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 1);

  // The time of a change: the API's role may not write it, and what it leaves out is filled
  // in from the database's clock and copied into the history.
  const selected = { ...context, organisationId: first.id };
  await refused(
    () =>
      asApiRole(selected, (client) =>
        client.query(
          `UPDATE trucker.organisation SET legal_name = 'Backdated', version = version + 1,
             updated_at = '2000-01-01' WHERE id = $1`,
          [first.id],
        ),
      ),
    /permission denied/,
  );
  await advance(90);
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('trucker.session_token_hash', $1, true),
              set_config('trucker.organisation_id', $2, true)`,
      [selected.tokenHash, first.id],
    );
    const changed = await client.query<{ updated_at: Date }>(
      `UPDATE trucker.organisation SET legal_name = 'Stamped by the database', version = version + 1
       WHERE id = $1 RETURNING updated_at`,
      [first.id],
    );
    await client.query('COMMIT');
    assert.equal(changed.rows[0]!.updated_at.toISOString(), clock().toISOString());
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  const entry = await owner.query<{ occurred_at: Date }>(
    `SELECT occurred_at FROM trucker.audit_entry
     WHERE organisation_id = $1 AND action = 'organisation.updated'`,
    [first.id],
  );
  assert.equal(entry.rows[0]!.occurred_at.toISOString(), clock().toISOString());
});

// ---------------------------------------------------------------------------------------------
// Changing an organisation (ORG-7, ORG-8)
// ---------------------------------------------------------------------------------------------
test('an administrator changes a draft; a stale save is refused with the current values', async () => {
  const person = await newPerson();
  const created = await createOrganisation(person);
  const saved = await call(api, 'PATCH', `/organisations/${created.id}`, {
    token: person.token,
    body: { ...details({ legalName: 'Renamed (fictional)' }), version: 1 },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((saved.body.organisation as Organisation).version, 2);
  const stale = await call(api, 'PATCH', `/organisations/${created.id}`, {
    token: person.token,
    body: { ...details({ legalName: 'Overwrite attempt' }), version: 1 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'organisation_changed');
  const current = (stale.body.details as { current: Organisation }).current;
  assert.equal(current.legalName, 'Renamed (fictional)');
  assert.equal(current.version, 2);
  // Two saves at once from the same version: one wins, the other is told.
  const both = await Promise.all(
    ['One', 'Two'].map((name) =>
      call(api, 'PATCH', `/organisations/${created.id}`, {
        token: person.token,
        body: { ...details({ legalName: name }), version: 2 },
      }),
    ),
  );
  assert.deepEqual(both.map((reply) => reply.status).sort(), [200, 409]);
  const invalid = await call(api, 'PATCH', `/organisations/${created.id}`, {
    token: person.token,
    body: { ...details({ countryCode: 'XC' }), version: 3 },
  });
  assert.equal(invalid.status, 422);
  assert.equal(
    (
      await call(api, 'PATCH', `/organisations/${created.id}`, {
        token: person.token,
        body: details(),
      })
    ).status,
    422,
    'the version is required',
  );
});

test('an organisation that is no longer a draft cannot be changed, by the API or in the database', async () => {
  const person = await newPerson();
  const created = await createOrganisation(person);
  // No path to another status exists in this slice, so the test sets one as the table's owner,
  // with the history trigger off for that one statement.
  await owner.query(`ALTER TABLE trucker.organisation DISABLE TRIGGER organisation_audit`);
  await owner.query(`UPDATE trucker.organisation SET status = 'submitted' WHERE id = $1`, [
    created.id,
  ]);
  await owner.query(`ALTER TABLE trucker.organisation ENABLE TRIGGER organisation_audit`);
  const reply = await call(api, 'PATCH', `/organisations/${created.id}`, {
    token: person.token,
    body: { ...details({ legalName: 'Too late' }), version: 1 },
  });
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, 'organisation_not_editable');
  const direct = await asApiRole(
    { tokenHash: hashToken(person.token), organisationId: created.id },
    (client) =>
      client.query(
        `UPDATE trucker.organisation SET legal_name = 'Too late', version = version + 1 WHERE id = $1`,
        [created.id],
      ),
  );
  assert.equal(direct.rowCount, 0);
});

// ---------------------------------------------------------------------------------------------
// Isolation: the database checks who is asking and that they are a member (TI-3 to TI-8)
// ---------------------------------------------------------------------------------------------
test('without a request context the API role sees no organisation data at all', async () => {
  await createOrganisation(await newPerson());
  for (const table of ['organisation', 'membership', 'audit_entry', 'retry_key']) {
    const found = await app.query(`SELECT 1 FROM trucker.${table}`);
    assert.equal(found.rowCount, 0, table);
  }
});

test('a forged context selects nothing: the organisation identifier is not trusted', async () => {
  const mine = await newPerson();
  const theirs = await newPerson();
  const myOrganisation = await createOrganisation(mine);
  const theirOrganisation = await createOrganisation(theirs, { legalName: 'Theirs' });
  const rows = (context: { tokenHash?: string; organisationId?: string }, sql: string) =>
    asApiRole(context, async (client) => (await client.query(sql)).rowCount);

  // My real session, their organisation named as the one I act for.
  const forgedOrganisation = {
    tokenHash: hashToken(mine.token),
    organisationId: theirOrganisation.id,
  };
  assert.equal(
    await rows(
      forgedOrganisation,
      `SELECT 1 FROM trucker.organisation WHERE id = '${theirOrganisation.id}'`,
    ),
    0,
  );
  assert.equal(await rows(forgedOrganisation, `SELECT 1 FROM trucker.audit_entry`), 0);
  assert.equal(
    await rows(
      forgedOrganisation,
      `SELECT 1 FROM trucker.membership WHERE organisation_id = '${theirOrganisation.id}'`,
    ),
    0,
  );
  assert.equal(
    await rows(
      forgedOrganisation,
      `UPDATE trucker.organisation SET legal_name = 'taken', version = version + 1 WHERE id = '${theirOrganisation.id}'`,
    ),
    0,
  );
  // Naming an organisation I do not belong to shows me nothing at all, not even my own.
  assert.equal(await rows(forgedOrganisation, `SELECT 1 FROM trucker.organisation`), 0);
  // With my own selected I do see it, so the zeroes above are the rule and not an empty table.
  assert.equal(
    await rows(
      { tokenHash: hashToken(mine.token), organisationId: myOrganisation.id },
      `SELECT 1 FROM trucker.organisation`,
    ),
    1,
  );

  // No session, or an invented one, with a real organisation identifier.
  for (const tokenHash of ['', hashToken('invented-token'), 'x'.repeat(64)]) {
    const forgedPerson = { tokenHash, organisationId: myOrganisation.id };
    assert.equal(await rows(forgedPerson, `SELECT 1 FROM trucker.organisation`), 0);
    assert.equal(await rows(forgedPerson, `SELECT 1 FROM trucker.audit_entry`), 0);
    assert.equal(await rows(forgedPerson, `SELECT 1 FROM trucker.retry_key`), 0);
  }
  // Settings the policies do not read change nothing.
  const invented = await asApiRole({}, async (client) => {
    await client.query(
      `SELECT set_config('trucker.person_id', $1, true), set_config('trucker.organisation_id', $2, true)`,
      [mine.personId, myOrganisation.id],
    );
    return (await client.query('SELECT 1 FROM trucker.organisation')).rowCount;
  });
  assert.equal(invented, 0);
  assert.equal(
    (
      await owner.query(`SELECT legal_name FROM trucker.organisation WHERE id = $1`, [
        theirOrganisation.id,
      ])
    ).rows[0].legal_name,
    'Theirs',
  );
});

test('selecting one organisation hides every other, even for a member of both', async () => {
  // One person, an administrator of A and of B. A third organisation, C, belongs to someone else.
  const person = await newPerson();
  const stranger = await newPerson();
  const a = await createOrganisation(person, {
    legalName: 'Organisation A',
    registrationNumber: 'A-1',
  });
  await advance(1);
  const b = await createOrganisation(person, {
    legalName: 'Organisation B',
    registrationNumber: 'B-1',
  });
  const c = await createOrganisation(stranger, {
    legalName: 'Organisation C',
    registrationNumber: 'C-1',
  });
  const retryKey = key();
  await createOrganisation(stranger, { legalName: 'Keyed' }, retryKey);
  // A later creation time, so the newest-first order below does not depend on chance.
  await advance(1);
  await createOrganisation(person, { legalName: 'Organisation A2' }, key());
  const tokenHash = hashToken(person.token);
  const seen = (context: { tokenHash?: string; organisationId?: string }) =>
    asApiRole(context, async (client) => ({
      organisations: (
        await client.query<{ legal_name: string }>(
          'SELECT legal_name FROM trucker.organisation ORDER BY 1',
        )
      ).rows.map((row) => row.legal_name),
      memberships: (
        await client.query<{ organisation_id: string }>(
          'SELECT organisation_id FROM trucker.membership',
        )
      ).rows.map((row) => row.organisation_id),
      history: [
        ...new Set(
          (
            await client.query<{ organisation_id: string }>(
              'SELECT organisation_id FROM trucker.audit_entry',
            )
          ).rows.map((row) => row.organisation_id),
        ),
      ],
      retryKeys: (await client.query('SELECT 1 FROM trucker.retry_key')).rowCount,
    }));

  // Selected A: A only. B is the same person's organisation and is still not readable.
  assert.deepEqual(await seen({ tokenHash, organisationId: a.id }), {
    organisations: ['Organisation A'],
    memberships: [a.id],
    history: [a.id],
    retryKeys: 0,
  });
  // Selected B: B only.
  assert.deepEqual(await seen({ tokenHash, organisationId: b.id }), {
    organisations: ['Organisation B'],
    memberships: [b.id],
    history: [b.id],
    retryKeys: 0,
  });
  // Selecting A does not let B be read or changed by naming it in the statement.
  const reach = await asApiRole({ tokenHash, organisationId: a.id }, async (client) => ({
    read: (await client.query('SELECT 1 FROM trucker.organisation WHERE id = $1', [b.id])).rowCount,
    history: (
      await client.query('SELECT 1 FROM trucker.audit_entry WHERE organisation_id = $1', [b.id])
    ).rowCount,
    membership: (
      await client.query('SELECT 1 FROM trucker.membership WHERE organisation_id = $1', [b.id])
    ).rowCount,
    changed: (
      await client.query(
        `UPDATE trucker.organisation SET legal_name = 'Reached from A', version = version + 1 WHERE id = $1`,
        [b.id],
      )
    ).rowCount,
  }));
  assert.deepEqual(reach, { read: 0, history: 0, membership: 0, changed: 0 });

  // Absent context: a real session with no organisation selected reads no organisation table.
  // The person's own retry keys are reachable there, and only there.
  assert.deepEqual(await seen({ tokenHash }), {
    organisations: [],
    memberships: [],
    history: [],
    retryKeys: 3,
  });
  // No session and no organisation: nothing.
  assert.deepEqual(await seen({}), {
    organisations: [],
    memberships: [],
    history: [],
    retryKeys: 0,
  });

  // Forged context: an organisation the person does not belong to, a made-up one, and a
  // malformed one. Nothing is visible, including the person's own organisations.
  for (const organisationId of [c.id, randomUUID(), 'not-an-identifier', `${a.id}' OR '1'='1`])
    assert.deepEqual(
      await seen({ tokenHash, organisationId }),
      { organisations: [], memberships: [], history: [], retryKeys: 0 },
      organisationId,
    );
  // Forged person with a real organisation selected: nothing.
  for (const forged of ['', hashToken('invented-token')])
    assert.deepEqual(await seen({ tokenHash: forged, organisationId: a.id }), {
      organisations: [],
      memberships: [],
      history: [],
      retryKeys: 0,
    });

  // The chooser is its own path. It answers only a request with no organisation selected,
  // lists exactly the person's organisations, and returns only what a chooser needs.
  const chooser = (context: { tokenHash?: string; organisationId?: string }) =>
    asApiRole(context, async (client) => {
      const found = await client.query('SELECT * FROM trucker.my_organisations()');
      return {
        names: found.rows.map((row: { legal_name: string }) => row.legal_name),
        columns: found.fields.map((field) => field.name),
      };
    });
  assert.deepEqual(await chooser({ tokenHash }), {
    names: ['Organisation A2', 'Organisation B', 'Organisation A'],
    columns: ['id', 'status', 'legal_name', 'registration_number', 'created_at'],
  });
  for (const organisationId of [a.id, b.id, c.id])
    await refused(
      () => chooser({ tokenHash, organisationId }),
      /not available to a request that has selected an organisation/,
    );
  assert.deepEqual((await chooser({})).names, []);
  assert.deepEqual((await chooser({ tokenHash: hashToken('invented-token') })).names, []);

  // The same through the API: each organisation is read by selecting it, and the list holds
  // summaries only.
  const listed = await call(api, 'GET', '/organisations', { token: person.token });
  assert.deepEqual(
    (listed.body.organisations as Record<string, unknown>[]).map((entry) =>
      Object.keys(entry).sort(),
    ),
    [1, 2, 3].map(() => ['createdAt', 'id', 'legalName', 'registrationNumber', 'status']),
  );
  const readA = await call(api, 'GET', `/organisations/${a.id}`, { token: person.token });
  assert.equal((readA.body.organisation as Organisation).legalName, 'Organisation A');
  assert.ok(!JSON.stringify(readA.body).includes('Organisation B'));
  const historyA = await call(api, 'GET', `/organisations/${a.id}/history`, {
    token: person.token,
  });
  assert.ok(!JSON.stringify(historyA.body).includes(b.id));
  assert.equal(await count('organisation', `id = $1 AND legal_name = 'Organisation B'`, [b.id]), 1);
});

test('creating an organisation needs a live session too: a forged one is refused by the database', async () => {
  const create = `SELECT trucker.create_organisation('Forged', NULL, 'XA', 'X-1', NULL, NULL, true)`;
  for (const tokenHash of ['', hashToken('invented-token')])
    await refused(
      () => asApiRole({ tokenHash }, (client) => client.query(create)),
      /no signed-in person/,
    );
  const person = await newPerson();
  await call(api, 'POST', '/auth/sign-out', { token: person.token });
  await refused(
    () => asApiRole({ tokenHash: hashToken(person.token) }, (client) => client.query(create)),
    /no signed-in person/,
  );
  assert.equal(await count('organisation', `legal_name = 'Forged'`), 0);
});

test('another person gets the same answer as for an organisation that does not exist', async () => {
  const mine = await newPerson();
  const other = await newPerson();
  const organisation = await createOrganisation(mine);
  const missing = randomUUID();
  for (const [method, suffix, body] of [
    ['GET', '', undefined],
    ['GET', '/history', undefined],
    ['PATCH', '', { ...details(), version: 1 }],
  ] as const) {
    const theirs = await call(api, method, `/organisations/${organisation.id}${suffix}`, {
      token: other.token,
      ...(body ? { body } : {}),
    });
    const none = await call(api, method, `/organisations/${missing}${suffix}`, {
      token: other.token,
      ...(body ? { body } : {}),
    });
    assert.equal(theirs.status, 404, `${method} ${suffix}`);
    assert.deepEqual(
      { status: theirs.status, code: theirs.body.code, message: theirs.body.message },
      { status: none.status, code: none.body.code, message: none.body.message },
    );
    assert.ok(!JSON.stringify(theirs.body).includes(organisation.legalName));
  }
  assert.equal(
    (await call(api, 'GET', '/organisations/not-an-identifier', { token: mine.token })).status,
    404,
  );
  assert.equal((await call(api, 'GET', `/organisations/${organisation.id}`)).status, 401);
  // Nothing was changed by the refused attempt.
  assert.equal(
    (
      (await call(api, 'GET', `/organisations/${organisation.id}`, { token: mine.token })).body
        .organisation as Organisation
    ).version,
    1,
  );
});

test('each person lists only the organisations they belong to; a member of two sees both', async () => {
  const first = await newPerson();
  const second = await newPerson();
  const a = await createOrganisation(first, { legalName: 'A' });
  await advance(1);
  const b = await createOrganisation(second, { legalName: 'B' });
  const ids = async (person: Person): Promise<string[]> =>
    (
      (await call(api, 'GET', '/organisations', { token: person.token })).body
        .organisations as Organisation[]
    ).map((organisation) => organisation.id);
  assert.deepEqual(await ids(first), [a.id]);
  assert.deepEqual(await ids(second), [b.id]);
  assert.equal((await call(api, 'GET', '/organisations')).status, 401);

  // The second person is made an administrator of A as well (by the migration role: no
  // invitation flow exists in this slice).
  await owner.query(
    `INSERT INTO trucker.membership (organisation_id, person_id, role, created_at) VALUES ($1, $2, 'admin', now())`,
    [a.id, second.personId],
  );
  assert.deepEqual(await ids(second), [b.id, a.id], 'newest first');
  for (const organisation of [a, b])
    assert.equal(
      (await call(api, 'GET', `/organisations/${organisation.id}`, { token: second.token })).status,
      200,
    );
  // Acting for A does not show B's history, and the other way round.
  const historyOfA = await call(api, 'GET', `/organisations/${a.id}/history`, {
    token: second.token,
  });
  assert.ok(
    (historyOfA.body.entries as { after: { legalName: string } }[]).every(
      (entry) => entry.after.legalName === 'A',
    ),
  );
  // Once the membership ends, access ends at the next request.
  await owner.query(
    `UPDATE trucker.membership SET ended_at = now() WHERE organisation_id = $1 AND person_id = $2`,
    [a.id, second.personId],
  );
  assert.deepEqual(await ids(second), [b.id]);
  assert.equal(
    (await call(api, 'GET', `/organisations/${a.id}`, { token: second.token })).status,
    404,
  );
});

test('nothing is left on a pooled connection for the next request', async () => {
  const first = await newPerson();
  const second = await newPerson();
  const a = await createOrganisation(first, { legalName: 'Only for the first' });
  const b = await createOrganisation(second, { legalName: 'Only for the second' });
  // One connection serves every request of this API, in turn.
  const names = async (person: Person): Promise<string[]> =>
    (
      (await call(single, 'GET', '/organisations', { token: person.token })).body
        .organisations as Organisation[]
    ).map((organisation) => organisation.legalName);
  assert.deepEqual(await names(first), ['Only for the first']);
  assert.deepEqual(await names(second), ['Only for the second']);
  // After a refused request, and after a failed one, the next caller still sees only their own.
  assert.equal(
    (await call(single, 'GET', `/organisations/${a.id}`, { token: second.token })).status,
    404,
  );
  assert.deepEqual(await names(second), ['Only for the second']);
  assert.equal(
    (
      await call(single, 'PATCH', `/organisations/${b.id}`, {
        token: second.token,
        body: { version: 1 },
      })
    ).status,
    422,
  );
  assert.deepEqual(await names(first), ['Only for the first']);
  assert.equal((await call(single, 'GET', '/organisations')).status, 401);

  // In the database: after commit, after rollback and after a timeout, the settings are gone.
  const client = await app.connect();
  try {
    const setContext = `SELECT set_config('trucker.session_token_hash', $1, true), set_config('trucker.organisation_id', $2, true)`;
    const leftOver = async (): Promise<[string, number | null]> => [
      (await client.query(`SELECT current_setting('trucker.session_token_hash', true) AS value`))
        .rows[0].value ?? '',
      (await client.query('SELECT 1 FROM trucker.organisation')).rowCount,
    ];
    await client.query('BEGIN');
    await client.query(setContext, [hashToken(first.token), a.id]);
    assert.equal((await client.query('SELECT 1 FROM trucker.organisation')).rowCount, 1);
    await client.query('COMMIT');
    assert.deepEqual(await leftOver(), ['', 0], 'after commit');
    await client.query('BEGIN');
    await client.query(setContext, [hashToken(first.token), a.id]);
    await client.query('ROLLBACK');
    assert.deepEqual(await leftOver(), ['', 0], 'after rollback');
    await client.query('BEGIN');
    await client.query(setContext, [hashToken(first.token), a.id]);
    await client.query(`SET LOCAL statement_timeout = '50ms'`);
    await assert.rejects(client.query('SELECT pg_sleep(1)'), /statement timeout/);
    await client.query('ROLLBACK');
    assert.deepEqual(await leftOver(), ['', 0], 'after a timeout');
  } finally {
    client.release();
  }
});

test('ending a session ends organisation access at the next request', async () => {
  const person = await newPerson();
  const organisation = await createOrganisation(person);
  assert.equal((await call(api, 'POST', '/auth/sign-out', { token: person.token })).status, 204);
  for (const [method, route] of [
    ['GET', '/organisations'],
    ['GET', `/organisations/${organisation.id}`],
    ['GET', `/organisations/${organisation.id}/history`],
    ['GET', '/registration/countries'],
  ] as const)
    assert.equal((await call(api, method, route, { token: person.token })).status, 401, route);
  const direct = await asApiRole(
    { tokenHash: hashToken(person.token), organisationId: organisation.id },
    async (client) => (await client.query('SELECT 1 FROM trucker.organisation')).rowCount,
  );
  assert.equal(direct, 0, 'the database refuses the revoked session too');
});

// ---------------------------------------------------------------------------------------------
// Audit history (AU-1 to AU-5)
// ---------------------------------------------------------------------------------------------
test('every create and change writes one history entry, with who, what, when and the values', async () => {
  const person = await newPerson();
  const made = await call(api, 'POST', '/organisations', {
    token: person.token,
    key: key(),
    body: details(),
  });
  const organisation = made.body.organisation as Organisation;
  await advance(5);
  const changed = await call(api, 'PATCH', `/organisations/${organisation.id}`, {
    token: person.token,
    body: { ...details({ legalName: 'Second name (fictional)' }), version: 1 },
  });
  assert.equal(changed.status, 200);
  // A refused change writes nothing.
  await call(api, 'PATCH', `/organisations/${organisation.id}`, {
    token: person.token,
    body: { ...details({ legalName: 'Stale' }), version: 1 },
  });
  const history = await call(api, 'GET', `/organisations/${organisation.id}/history`, {
    token: person.token,
  });
  const entries = history.body.entries as {
    action: string;
    actorPersonId: string;
    requestId: string;
    occurredAt: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  }[];
  assert.deepEqual(
    entries.map((entry) => entry.action),
    ['organisation.created', 'organisation.updated'],
  );
  assert.ok(entries.every((entry) => entry.actorPersonId === person.personId));
  assert.equal(entries[0]!.requestId, made.requestId);
  assert.equal(entries[1]!.requestId, changed.requestId);
  assert.equal(entries[0]!.before, null);
  assert.equal(entries[0]!.after.legalName, 'Fixture Freight Company (fictional)');
  assert.equal(entries[1]!.before!.legalName, 'Fixture Freight Company (fictional)');
  assert.equal(entries[1]!.after.legalName, 'Second name (fictional)');
  assert.equal(entries[1]!.after.version, 2);
  assert.equal(
    entries[1]!.occurredAt,
    (changed.body.organisation as { updatedAt: string }).updatedAt,
  );
  const stored = await owner.query<{ organisation_id: string; record_id: string }>(
    'SELECT organisation_id, record_id FROM trucker.audit_entry WHERE organisation_id = $1',
    [organisation.id],
  );
  assert.equal(stored.rowCount, 2);
});

test('a change and its history entry stand or fall together', async () => {
  const person = await newPerson();
  const organisation = await createOrganisation(person);
  const context = { tokenHash: hashToken(person.token), organisationId: organisation.id };
  // The change is made, then the transaction fails: neither the change nor an entry remains.
  await asApiRole(context, async (client) => {
    const changed = await client.query(
      `UPDATE trucker.organisation SET legal_name = 'Lost', version = version + 1 WHERE id = $1`,
      [organisation.id],
    );
    assert.equal(changed.rowCount, 1);
    assert.equal((await client.query('SELECT 1 FROM trucker.audit_entry')).rowCount, 2);
  });
  assert.equal(await count('audit_entry', 'organisation_id = $1', [organisation.id]), 1);
  assert.equal(
    await count('organisation', `id = $1 AND legal_name = 'Lost'`, [organisation.id]),
    0,
  );
  // The entry cannot be written (the version does not rise by one): the change is refused.
  await refused(
    () =>
      asApiRole(context, (client) =>
        client.query(
          `UPDATE trucker.organisation SET legal_name = 'No entry', version = version + 2 WHERE id = $1`,
          [organisation.id],
        ),
      ),
    /raise the version by one/,
  );
  // A change with no signed-in person behind it is refused even for the table's owner.
  await refused(
    () =>
      owner.query(
        `UPDATE trucker.organisation SET legal_name = 'Nobody', version = version + 1 WHERE id = $1`,
        [organisation.id],
      ),
    /without a signed-in person/,
  );
  assert.equal(
    await count('organisation', `id = $1 AND legal_name = 'Fixture Freight Company (fictional)'`, [
      organisation.id,
    ]),
    1,
  );
});

test('history holds no sign-in secret, and is read only by the organisation’s administrators', async () => {
  const person = await newPerson();
  const other = await newPerson();
  const organisation = await createOrganisation(person);
  const all = await owner.query<{ entry: string }>(
    'SELECT row_to_json(a)::text AS entry FROM trucker.audit_entry a',
  );
  const everything = all.rows.map((row) => row.entry).join('\n');
  for (const secret of [person.token, hashToken(person.token), other.token, hashToken(other.token)])
    assert.ok(!everything.includes(secret), 'a session token or its hash is in the history');
  assert.ok(!everything.includes(person.phone) && !everything.includes(person.phone.slice(1)));
  assert.equal(
    (await call(api, 'GET', `/organisations/${organisation.id}/history`, { token: other.token }))
      .status,
    404,
  );
  assert.equal((await call(api, 'GET', `/organisations/${organisation.id}/history`)).status, 401);
});

// ---------------------------------------------------------------------------------------------
// Safe retries (SR-1 to SR-8)
// ---------------------------------------------------------------------------------------------
test('a retry key is required, and a repeated request creates nothing new', async () => {
  const person = await newPerson();
  const missing = await call(api, 'POST', '/organisations', {
    token: person.token,
    body: details(),
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'retry_key_required');
  assert.equal(
    (
      await call(api, 'POST', '/organisations', {
        token: person.token,
        key: 'short',
        body: details(),
      })
    ).status,
    400,
  );
  const retryKey = key();
  const first = await createOrganisation(person, {}, retryKey);
  const again = await createOrganisation(person, {}, retryKey);
  assert.equal(again.id, first.id);
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 1);
  assert.equal(await count('audit_entry', 'organisation_id = $1', [first.id]), 1);
  // Five identical requests at the same moment still make one organisation.
  const racingKey = key();
  const racing = await Promise.all(
    [1, 2, 3, 4, 5].map(() =>
      call(api, 'POST', '/organisations', { token: person.token, key: racingKey, body: details() }),
    ),
  );
  assert.deepEqual([...new Set(racing.map((reply) => reply.status))], [201]);
  assert.equal(
    new Set(racing.map((reply) => (reply.body.organisation as Organisation).id)).size,
    1,
  );
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 2);
});

test('the same key with different content is refused; a refused request is not remembered', async () => {
  const person = await newPerson();
  const retryKey = key();
  await createOrganisation(person, {}, retryKey);
  const different = await call(api, 'POST', '/organisations', {
    token: person.token,
    key: retryKey,
    body: details({ legalName: 'Something else' }),
  });
  assert.equal(different.status, 409);
  assert.equal(different.body.code, 'retry_key_conflict');
  // Invalid first, then corrected, with one key.
  const correctedKey = key();
  const invalid = await call(api, 'POST', '/organisations', {
    token: person.token,
    key: correctedKey,
    body: details({ legalName: '' }),
  });
  assert.equal(invalid.status, 422);
  await createOrganisation(person, {}, correctedKey);
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 2);
});

test('a key belongs to the person who used it: another person learns nothing from it', async () => {
  const first = await newPerson();
  const second = await newPerson();
  const shared = key();
  const mine = await createOrganisation(first, { legalName: 'Private to the first' }, shared);
  const theirs = await call(api, 'POST', '/organisations', {
    token: second.token,
    key: shared,
    body: details({ legalName: 'Private to the first' }),
  });
  assert.equal(theirs.status, 201);
  assert.notEqual((theirs.body.organisation as Organisation).id, mine.id);
  const stored = await asApiRole(
    { tokenHash: hashToken(second.token) },
    async (client) =>
      (await client.query<{ record_id: string }>('SELECT record_id FROM trucker.retry_key')).rows,
  );
  assert.deepEqual(
    stored.map((row) => row.record_id),
    [(theirs.body.organisation as Organisation).id],
  );
});

test('a stored result is returned only to an authenticated, authorised caller', async () => {
  const person = await newPerson();
  const retryKey = key();
  const created = await createOrganisation(
    person,
    { legalName: 'Not for a revoked session' },
    retryKey,
  );
  const body = details({ legalName: 'Not for a revoked session' });

  // 1. The session is revoked: the retry is refused before any stored result is read.
  assert.equal((await call(api, 'POST', '/auth/sign-out', { token: person.token })).status, 204);
  const revoked = await call(api, 'POST', '/organisations', {
    token: person.token,
    key: retryKey,
    body,
  });
  assert.equal(revoked.status, 401);
  assert.ok(!JSON.stringify(revoked.body).includes(created.id));
  assert.ok(!JSON.stringify(revoked.body).includes('Not for a revoked session'));
  // No token at all, and an invented one, fare the same.
  for (const token of [undefined, 'invented-token'])
    assert.equal(
      (
        await call(api, 'POST', '/organisations', {
          ...(token ? { token } : {}),
          key: retryKey,
          body,
        })
      ).status,
      401,
    );

  // 2. The same person signs in again: the key is theirs, and the retry returns the same record.
  const back = await signInAs(person.phone);
  const repeated = await call(api, 'POST', '/organisations', {
    token: back.token,
    key: retryKey,
    body,
  });
  assert.equal(repeated.status, 201);
  assert.equal((repeated.body.organisation as Organisation).id, created.id);
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 1);

  // 3. The record has changed since: the retry shows it as it is now, not a stored copy.
  await call(api, 'PATCH', `/organisations/${created.id}`, {
    token: back.token,
    body: { ...details({ legalName: 'Renamed since' }), version: 1 },
  });
  const current = await call(api, 'POST', '/organisations', {
    token: back.token,
    key: retryKey,
    body,
  });
  assert.equal((current.body.organisation as Organisation).legalName, 'Renamed since');

  // 4. The person is no longer a member: the retry gives nothing away.
  await owner.query('UPDATE trucker.membership SET ended_at = now() WHERE organisation_id = $1', [
    created.id,
  ]);
  const removed = await call(api, 'POST', '/organisations', {
    token: back.token,
    key: retryKey,
    body,
  });
  assert.equal(removed.status, 404);
  assert.ok(!JSON.stringify(removed.body).includes('Renamed since'));
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 1);
});

test('a retry key is remembered for 24 hours by default; after that it is treated as new', async () => {
  assert.equal(SECURITY_PERIOD_DEFAULTS.RETRY_KEY_RETENTION_HOURS, 24);
  const person = await newPerson();
  const retryKey = key();
  const first = await createOrganisation(person, {}, retryKey);
  await advance(23 * 3600);
  const within = await signInAs(person.phone);
  assert.equal((await createOrganisation(within, {}, retryKey)).id, first.id);
  await advance(2 * 3600);
  const later = await signInAs(person.phone);
  const second = await createOrganisation(later, {}, retryKey);
  assert.notEqual(second.id, first.id);
  assert.equal(await count('retry_key', 'person_id = $1', [person.personId]), 1);
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 2);
});

// ---------------------------------------------------------------------------------------------
// Countries, fixtures and production (CC-1 to CC-7)
// ---------------------------------------------------------------------------------------------
test('with fixtures switched off no country is open, and creation says registration is closed', async () => {
  const person = await newPerson();
  const open = await call(noFixtures, 'GET', '/registration/countries', { token: person.token });
  assert.deepEqual(open.body.countries, []);
  const reply = await call(noFixtures, 'POST', '/organisations', {
    token: person.token,
    key: key(),
    body: details(),
  });
  assert.equal(reply.status, 503);
  assert.equal(reply.body.code, 'organisation_registration_closed');
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 0);
  // Asking the database for fixtures directly does not help: the API role has no such switch
  // beyond the function's own argument, and a closed country stays closed.
  await refused(
    () =>
      asApiRole({ tokenHash: hashToken(person.token) }, (client) =>
        client.query(`SELECT trucker.create_organisation('x', NULL, 'XC', 'x', NULL, NULL, true)`),
      ),
    /not open for registration/,
  );
});

test('an API connected with the migration role keeps organisation data closed', async () => {
  const person = await newPerson();
  for (const [method, route] of [
    ['GET', '/organisations'],
    ['GET', '/registration/countries'],
    ['GET', `/organisations/${randomUUID()}`],
  ] as const) {
    const reply = await call(privileged, method, route, { token: person.token });
    assert.equal(reply.status, 503, route);
    assert.equal(reply.body.code, 'organisation_access_closed');
  }
  const create = await call(privileged, 'POST', '/organisations', {
    token: person.token,
    key: key(),
    body: details(),
  });
  assert.equal(create.status, 503);
  assert.equal(await count('organisation', 'created_by = $1', [person.personId]), 0);
  // Sign-in and the person's own account still work there.
  assert.equal((await call(privileged, 'GET', '/me', { token: person.token })).status, 200);
});

test('the database itself refuses fixture countries unless it is marked for them', async () => {
  const scratch = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: scratch.url });
  try {
    await migrateUp(pool, defaultMigrationsDir());
    assert.equal(
      await (async () =>
        (await pool.query('SELECT count(*)::int AS n FROM trucker.country')).rows[0].n)(),
      0,
      'no country ships',
    );
    assert.equal(
      (await pool.query('SELECT kind FROM trucker.environment')).rows[0].kind,
      'unmarked',
    );
    const fixture = `INSERT INTO trucker.country (code, name_en, name_ar, name_ur, registration_state, fixture) VALUES ('XA', 'x', 'x', 'x', 'enabled', true)`;
    // Unmarked: refused.
    await refused(() => pool.query(fixture), /marked local-development or test/);
    await refused(() => loadCountryFixtures(pool), /marked local-development or test/);
    // A private-use code can never be entered as a real country, marked or not.
    await refused(
      () =>
        pool.query(
          `INSERT INTO trucker.country (code, name_en, name_ar, name_ur, fixture) VALUES ('XA', 'x', 'x', 'x', false)`,
        ),
      /country_fixture_uses_private_code/,
    );
    // Marked production: fixtures refused, and the mark cannot be moved or removed.
    await pool.query(`UPDATE trucker.environment SET kind = 'production', marked_at = now()`);
    await refused(() => pool.query(fixture), /marked local-development or test/);
    await refused(() => markEnvironment(pool, 'local-development'), /cannot be re-marked/);
    await refused(() => markEnvironment(pool, 'test'), /cannot be re-marked/);
    await refused(
      () => pool.query(`UPDATE trucker.environment SET kind = 'unmarked'`),
      /cannot be re-marked/,
    );
    await refused(() => pool.query('DELETE FROM trucker.environment'), /cannot be removed/);
    await refused(
      () => pool.query(`INSERT INTO trucker.environment (singleton, kind) VALUES (true, 'test')`),
      /duplicate key/,
    );
    assert.deepEqual(
      productionStartProblems({
        rowSecurityBinds: true,
        problems: [],
        environment: 'production',
        settingsReviewed: true,
        financialSettingsApproved: true,
        connectionEncrypted: true,
        parametersKeptOutOfLogs: true,
      }),
      [],
    );
  } finally {
    await pool.end();
    await scratch.drop();
  }
  // Even in a database marked for fixtures, a fixture cannot carry a code that could be a
  // real country's.
  await refused(
    () =>
      owner.query(
        `INSERT INTO trucker.country (code, name_en, name_ar, name_ur, fixture) VALUES ('AB', 'x', 'x', 'x', true)`,
      ),
    /country_fixture_uses_private_code/,
  );
  // A database that holds fixtures can never be marked production, or unmarked.
  await refused(
    () => owner.query(`UPDATE trucker.environment SET kind = 'production'`),
    /holds fixture countries/,
  );
  await refused(
    () => owner.query(`UPDATE trucker.environment SET kind = 'unmarked'`),
    /cannot be unmarked/,
  );
});

test('loading fixtures needs every safeguard at once; production configuration refuses them', () => {
  const good = {
    NODE_ENV: 'development',
    TRUCKER_LOCAL_FIXTURES: FIXTURES_ACKNOWLEDGEMENT,
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/trucker_dev',
  };
  assert.deepEqual(fixtureSafeguardProblems(good), []);
  assert.deepEqual(fixtureSafeguardProblems({ ...good, NODE_ENV: 'test' }), []);
  for (const [change, expected] of [
    [{ NODE_ENV: 'production' }, /NODE_ENV/],
    [{ NODE_ENV: undefined }, /NODE_ENV/],
    [{ TRUCKER_LOCAL_FIXTURES: undefined }, /TRUCKER_LOCAL_FIXTURES/],
    [{ TRUCKER_LOCAL_FIXTURES: 'true' }, /TRUCKER_LOCAL_FIXTURES/],
    [{ DATABASE_URL: 'postgres://u:p@db.example.test:5432/trucker' }, /on this machine/],
    [{ DATABASE_URL: undefined }, /on this machine/],
  ] as const) {
    const problems = fixtureSafeguardProblems({ ...good, ...change });
    assert.equal(problems.length, 1, JSON.stringify(change));
    assert.match(problems[0]!, expected);
  }

  const production = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://owner:p@db.example.test:5432/trucker',
    APP_DATABASE_URL: 'postgres://api:p@db.example.test:5432/trucker',
    IDENTITY_SECRET: 'a-production-secret-of-sufficient-length',
    ...Object.fromEntries(
      Object.entries(SECURITY_PERIOD_DEFAULTS).map(([name, value]) => [name, String(value)]),
    ),
  };
  assert.doesNotThrow(() => loadConfig(production));
  const problemsOf = (env: Record<string, string | undefined>): string => {
    try {
      loadConfig(env);
      return '';
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      return error.problems.join('\n');
    }
  };
  assert.match(
    problemsOf({ ...production, COUNTRY_FIXTURES: 'local-development' }),
    /COUNTRY_FIXTURES must not be set in production/,
  );
  assert.match(
    problemsOf({ ...production, APP_DATABASE_URL: undefined }),
    /APP_DATABASE_URL must be set in production/,
  );
  assert.match(
    problemsOf({ ...production, APP_DATABASE_URL: production.DATABASE_URL }),
    /must differ/,
  );
  assert.match(
    problemsOf({ ...production, ORGANISATION_CREATION_LIMIT: '5' }),
    /ORGANISATION_CREATION_LIMIT is no longer read by the API/,
  );
  assert.match(
    problemsOf({ ...production, RETRY_KEY_RETENTION_HOURS: undefined }),
    /RETRY_KEY_RETENTION_HOURS must be set explicitly/,
  );
  // Outside production, fixtures still need a database on this machine.
  assert.match(
    problemsOf({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@db.example.test:5432/trucker',
      COUNTRY_FIXTURES: 'local-development',
    }),
    /COUNTRY_FIXTURES local-development needs a database on this machine/,
  );
  // Production does not start against a database that is not marked production, or with a
  // role that row security does not bind.
  assert.match(
    productionStartProblems({
      rowSecurityBinds: true,
      problems: [],
      environment: 'test',
      settingsReviewed: true,
      financialSettingsApproved: true,
      connectionEncrypted: true,
      parametersKeptOutOfLogs: true,
    }).join(),
    /not "production"/,
  );
  assert.match(
    productionStartProblems({
      rowSecurityBinds: true,
      problems: [],
      environment: 'unmarked',
      settingsReviewed: true,
      financialSettingsApproved: true,
      connectionEncrypted: true,
      parametersKeptOutOfLogs: true,
    }).join(),
    /not "production"/,
  );
  assert.equal(
    productionStartProblems({
      rowSecurityBinds: false,
      problems: ['the database role is a superuser'],
      environment: 'production',
      settingsReviewed: true,
      financialSettingsApproved: true,
      connectionEncrypted: true,
      parametersKeptOutOfLogs: true,
    }).length,
    1,
  );
  // Nor with limits in the database that nobody has recorded as reviewed for production.
  assert.match(
    productionStartProblems({
      rowSecurityBinds: true,
      problems: [],
      environment: 'production',
      settingsReviewed: false,
      financialSettingsApproved: true,
      connectionEncrypted: true,
      parametersKeptOutOfLogs: true,
    }).join(),
    /have not been recorded as reviewed for production/,
  );
  // Nor while only the development default of the financial settings is in force.
  assert.match(
    productionStartProblems({
      rowSecurityBinds: true,
      problems: [],
      environment: 'production',
      settingsReviewed: true,
      financialSettingsApproved: false,
      connectionEncrypted: true,
      parametersKeptOutOfLogs: true,
    }).join(),
    /no approved version of the financial settings is in force/,
  );
  // Nor over a connection that is not encrypted, nor with a server that may log parameters.
  const gates = productionStartProblems({
    rowSecurityBinds: true,
    problems: [],
    environment: 'production',
    settingsReviewed: true,
    financialSettingsApproved: true,
    connectionEncrypted: false,
    parametersKeptOutOfLogs: false,
  }).join('\n');
  assert.match(gates, /connection to the database is not encrypted/);
  assert.match(
    gates,
    /log_parameter_max_length and log_parameter_max_length_on_error must both be 0/,
  );
});

test('a production API does not start against a database that is not marked production', async () => {
  const main = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../main.js');
  const start = (databaseUrl: string): Promise<{ code: number | null; output: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [main], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'production',
          PORT: '39217',
          DATABASE_URL: database.url,
          APP_DATABASE_URL: databaseUrl,
          IDENTITY_SECRET: 'a-production-secret-of-sufficient-length',
          ...Object.fromEntries(
            Object.entries(SECURITY_PERIOD_DEFAULTS).map(([name, value]) => [name, String(value)]),
          ),
        },
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const timer = setTimeout(() => child.kill(), 15_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  // The API's own role, but the database is marked "test" and holds fixture countries.
  const marked = await start(appDatabaseUrl(database.url));
  assert.equal(marked.code, 1, marked.output);
  assert.match(marked.output, /Refusing to start in production/);
  assert.match(marked.output, /marked "test", not "production"/);
  assert.match(marked.output, /have not been recorded as reviewed for production/);
  // This test server speaks no TLS and logs parameters by default: both gates are read from it.
  assert.match(marked.output, /connection to the database is not encrypted/);
  assert.match(marked.output, /may write statement parameters to its log/);
  // The migration role, under another name so that the two connection strings differ.
  const ownerAgain = new URL(database.url);
  ownerAgain.searchParams.set('application_name', 'same-role');
  const privilegedStart = await start(ownerAgain.toString());
  assert.equal(privilegedStart.code, 1, privilegedStart.output);
  assert.match(privilegedStart.output, /owns tables in the trucker schema/);
});

test('no country, currency or time zone name is written into migrations or organisation code', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const files = [
    ...readdirSync(path.join(root, 'db/migrations')).map((name) =>
      path.join(root, 'db/migrations', name),
    ),
    ...readdirSync(path.join(root, 'apps/api/src/organisation'))
      .filter((name) => !name.endsWith('.test.ts'))
      .map((name) => path.join(root, 'apps/api/src/organisation', name)),
    ...readdirSync(path.join(root, 'apps/api/src/shipment'))
      .filter((name) => !name.endsWith('.test.ts'))
      .map((name) => path.join(root, 'apps/api/src/shipment', name)),
    path.join(root, 'apps/api/src/database/access.ts'),
    path.join(root, 'apps/api/src/database/local.ts'),
    path.join(root, 'db/fixtures/local-development/countries.json'),
  ];
  assert.ok(files.length >= 8);
  // Built from pieces so that this test file does not itself contain the names.
  const names = [
    ['Om', 'an'],
    ['Emir', 'ates'],
    ['Sau', 'di'],
    ['Qat', 'ar'],
    ['Kuw', 'ait'],
    ['Bahr', 'ain'],
    ['Du', 'bai'],
    ['Mus', 'cat'],
    ['Asia', '/'],
    ['Europe', '/'],
  ].map((parts) => parts.join(''));
  const codes = ['OMR', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'USD'];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const name of names)
      assert.ok(!content.includes(name), `${path.basename(file)} names ${name}`);
    for (const code of codes)
      assert.ok(
        !new RegExp(`\\b${code}\\b`).test(content),
        `${path.basename(file)} contains ${code}`,
      );
    // Country codes written as data must be from the private-use range.
    for (const match of content.matchAll(/"code":\s*"([A-Z]{2})"/g))
      assert.match(
        match[1]!,
        /^(AA|Q[M-Z]|X[A-Z]|ZZ)$/,
        `${path.basename(file)} lists ${match[1]}`,
      );
  }
});
