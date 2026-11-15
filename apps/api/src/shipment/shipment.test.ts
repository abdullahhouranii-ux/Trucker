import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
import { SECURITY_SETTING_DEFAULTS, writeSecuritySettings } from '../database/settings.js';
import { configureApp } from '../http/configure-app.js';
import { hashToken } from '../identity/secrets.js';
import { DEMONSTRATION_TERMS_VERSION } from '../identity/terms.js';
import { blockedRequests } from '../testing/blocked-request.js';
import { createTestClock } from '../testing/test-clock.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';

// ---------------------------------------------------------------------------------------------
// A migrated database marked "test" holding the fictional countries, zones and lanes. The API
// connects as its restricted role. `owner` is the migration role: it sets things up, looks
// inside, and holds locks. `app` is the API's role used directly, to test what the database
// itself allows. One zone that changes its clocks is added here, in test data only.
// ---------------------------------------------------------------------------------------------
const CHANGING_ZONE = ['America', 'New_York'].join('/');
const D = SECURITY_SETTING_DEFAULTS;
const testClock = createTestClock(new Date('2026-06-01T08:00:00.000Z'));
const { clock, advance } = testClock;

interface Api {
  base: string;
}
let database: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let api: Api; // fixtures counted
let noFixtures: Api; // what any environment without approved countries sees
const apps: INestApplication[] = [];
const { whileBlocked, lockRow } = blockedRequests(() => owner, advance);

async function startApi(overrides: Record<string, string>): Promise<Api> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    APP_DATABASE_URL: appDatabaseUrl(database.url),
    SIGN_IN_CODE_DELIVERY: 'development-display',
    REGISTRATION_TERMS: 'demonstration',
    ...overrides,
  });
  const nest = configureApp(
    await NestFactory.create(AppModule.register(config, clock), { logger: false }),
    { info: () => undefined, error: () => undefined },
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
  await owner.query(
    `INSERT INTO trucker.country_time_zone (country_code, zone_name) VALUES ('XA', $1)`,
    [CHANGING_ZONE],
  );
  app = new pg.Pool({ connectionString: appDatabaseUrl(database.url), max: 3 });
  api = await startApi({ COUNTRY_FIXTURES: 'local-development' });
  noFixtures = await startApi({});
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
const key = (): string => `test-${randomUUID()}`;
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
  if (route.startsWith('/auth/code')) {
    headers['x-trucker-development-code'] = 'local-visitor';
    headers['idempotency-key'] = key();
  }
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
const newPhone = (): string => `+99988${String(1_000_000 + phoneCounter++)}`;

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
  await advance(D.code_resend_wait_seconds + 1);
  return {
    token: verified.body.token as string,
    personId: (verified.body.person as { id: string }).id,
    sessionId: (verified.body.session as { id: string }).id,
    phone,
  };
}
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
async function newOrganisation(person: Person): Promise<string> {
  const reply = await call(api, 'POST', '/organisations', {
    token: person.token,
    key: key(),
    body: {
      legalName: 'Fixture Shipper (fictional)',
      countryCode: 'XA',
      registrationNumber: 'FX-777',
    },
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return (reply.body.organisation as { id: string }).id;
}
/** A registered person who administers one organisation. */
async function newShipper(): Promise<{ person: Person; org: string }> {
  const person = await newPerson();
  return { person, org: await newOrganisation(person) };
}

interface WindowEnd {
  local: string | null;
  offsetMinutes: number | null;
  at: string | null;
  offsetChoices: number[] | null;
}
interface Place {
  address: string | null;
  countryCode: string | null;
  timeZone: string | null;
  accessNotes: string | null;
  from: WindowEnd;
  until: WindowEnd;
}
interface Shipment {
  id: string;
  status: string;
  version: number;
  shipperReference: string | null;
  cargoDescription: string | null;
  grossWeightKg: string | null;
  pieces: number | null;
  packaging: string | null;
  equipmentNeeded: string | null;
  pickup: Place;
  delivery: Place;
  route: { status: string; basis: string; transit: string[]; reasons: Record<string, unknown>[] };
  createdAt: string;
  updatedAt: string;
  discardedAt: string | null;
}
const shipments = (org: string, rest = ''): string => `/organisations/${org}/shipments${rest}`;

async function create(
  person: Person,
  org: string,
  body: Record<string, unknown> = { cargoDescription: 'Boxed tiles (fictional)' },
  retryKey = key(),
  target = api,
): Promise<Reply> {
  return call(target, 'POST', shipments(org), { token: person.token, key: retryKey, body });
}
async function created(
  person: Person,
  org: string,
  body?: Record<string, unknown>,
): Promise<Shipment> {
  const reply = await create(person, org, body);
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.shipment as Shipment;
}
const fetchOne = async (person: Person, org: string, id: string): Promise<Shipment> => {
  const reply = await call(api, 'GET', shipments(org, `/${id}`), { token: person.token });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.shipment as Shipment;
};
const count = async (table: string, where = 'true', values: unknown[] = []): Promise<number> =>
  (
    await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trucker.${table} WHERE ${where}`,
      values,
    )
  ).rows[0]!.n;
const problems = (reply: Reply): { field: string; code: string; offsets?: number[] }[] =>
  ((reply.body.details as { problems?: unknown }).problems ?? []) as {
    field: string;
    code: string;
    offsets?: number[];
  }[];
const refused = async (work: () => Promise<unknown>, pattern: RegExp): Promise<void> => {
  await assert.rejects(work, (error: Error) => pattern.test(error.message), String(pattern));
};
/** Runs statements as the API's role with a request context, then rolls back. */
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
// Drafts (SH-1 to SH-4)
// ---------------------------------------------------------------------------------------------
test('an administrator saves a draft and gets back what was given, in any script', async () => {
  const { person, org } = await newShipper();
  const body = {
    shipperReference: 'PO-2026/118',
    cargoDescription: 'بلاط سيراميك في صناديق — سرامک ٹائلیں (fictional)',
    grossWeightKg: '12500.5',
    pieces: 40,
    packaging: 'Pallets, shrink-wrapped',
    equipmentNeeded: 'Flatbed with straps',
    pickup: { address: 'Gate 4, Fixture Road', countryCode: 'XA', accessNotes: 'Call at the gate' },
    delivery: { address: 'Yard B', countryCode: 'XB' },
  };
  const draft = await created(person, org, body);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.version, 1);
  assert.equal(draft.shipperReference, body.shipperReference);
  assert.equal(draft.cargoDescription, body.cargoDescription);
  assert.equal(draft.grossWeightKg, '12500.5');
  assert.equal(draft.pieces, 40);
  assert.equal(draft.pickup.address, 'Gate 4, Fixture Road');
  assert.equal(draft.pickup.accessNotes, 'Call at the gate');
  assert.equal(draft.delivery.countryCode, 'XB');
  assert.equal(draft.createdAt, clock().toISOString());
  assert.equal(draft.updatedAt, draft.createdAt);
  assert.equal(draft.discardedAt, null);
  assert.deepEqual(await fetchOne(person, org, draft.id), draft);
  // Written together: the draft and one history entry.
  assert.equal(await count('shipment_draft', 'id = $1', [draft.id]), 1);
  assert.equal(await count('audit_entry', 'record_id = $1', [draft.id]), 1);
});

test('a draft may be incomplete; what is missing stays missing, and nothing is invented', async () => {
  const { person, org } = await newShipper();
  // A time typed for a place that has no country or zone yet: kept as typed, no instant.
  const timeOnly = await created(person, org, {
    pickup: { from: { local: '2026-07-01T09:00' } },
  });
  assert.deepEqual(timeOnly.pickup.from, {
    local: '2026-07-01T09:00',
    offsetMinutes: null,
    at: null,
    offsetChoices: null,
  });
  assert.equal(timeOnly.pickup.countryCode, null);
  assert.equal(timeOnly.pickup.timeZone, null);
  assert.equal(timeOnly.route.status, 'unknown');
  assert.equal(timeOnly.cargoDescription, null);
  // A country with no zone chosen: none is chosen for the person, even where only one exists.
  const countryOnly = await created(person, org, {
    pickup: { countryCode: 'XA', until: { local: '2026-07-01T17:00' } },
  });
  assert.equal(countryOnly.pickup.timeZone, null);
  assert.deepEqual(countryOnly.pickup.until, {
    local: '2026-07-01T17:00',
    offsetMinutes: null,
    at: null,
    offsetChoices: null,
  });
  // A zone with no time.
  const zoneOnly = await created(person, org, {
    delivery: { countryCode: 'XB', timeZone: 'Etc/GMT-3' },
  });
  assert.deepEqual(zoneOnly.delivery.from, {
    local: null,
    offsetMinutes: null,
    at: null,
    offsetChoices: null,
  });
  // Later the zone is given: the same typed time now resolves, and only then.
  const completed = await call(api, 'PATCH', shipments(org, `/${countryOnly.id}`), {
    token: person.token,
    key: key(),
    body: {
      version: 1,
      pickup: { countryCode: 'XA', timeZone: 'Etc/GMT-4', until: { local: '2026-07-01T17:00' } },
    },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.deepEqual((completed.body.shipment as Shipment).pickup.until, {
    local: '2026-07-01T17:00',
    offsetMinutes: 240,
    at: '2026-07-01T13:00:00.000Z',
    offsetChoices: null,
  });
  // Nothing at all is not a draft.
  for (const empty of [{}, { cargoDescription: '   ' }, { pickup: {}, delivery: {} }]) {
    const reply = await create(person, org, empty);
    assert.equal(reply.status, 422, JSON.stringify(empty));
    assert.deepEqual(problems(reply), [{ field: '', code: 'empty' }]);
  }
});

test('weight and pieces are optional numbers with units and bounds', async () => {
  const { person, org } = await newShipper();
  for (const [given, stored] of [
    ['0.001', '0.001'],
    ['100000', '100000'],
    ['12.50', '12.5'],
    [750, '750'],
  ] as const) {
    const draft = await created(person, org, { grossWeightKg: given });
    assert.equal(draft.grossWeightKg, stored, String(given));
  }
  for (const [given, stored] of [
    [1, 1],
    ['100000', 100000],
    ['42', 42],
  ] as const) {
    assert.equal((await created(person, org, { pieces: given })).pieces, stored, String(given));
  }
  const before = await count('shipment_draft');
  for (const bad of ['0', '-1', '100000.001', '1.2345', 'heavy', '1e3', '12,5', 1_000_000]) {
    const reply = await create(person, org, { cargoDescription: 'x', grossWeightKg: bad });
    assert.equal(reply.status, 422, String(bad));
    assert.deepEqual(
      problems(reply),
      [{ field: 'grossWeightKg', code: 'out_of_range' }],
      String(bad),
    );
  }
  for (const bad of ['0', '-3', '100001', '1.5', 'many', 2.5]) {
    const reply = await create(person, org, { cargoDescription: 'x', pieces: bad });
    assert.equal(reply.status, 422, String(bad));
    assert.deepEqual(problems(reply), [{ field: 'pieces', code: 'out_of_range' }], String(bad));
  }
  assert.equal(await count('shipment_draft'), before, 'nothing was saved by a refused request');
  // The database holds the same bounds itself, whatever reaches it.
  for (const [column, value] of [
    ['gross_weight_kg', '0'],
    ['gross_weight_kg', '100000.001'],
    ['pieces', '0'],
    ['pieces', '100001'],
  ]) {
    await refused(
      () => owner.query(`UPDATE trucker.shipment_draft SET ${column} = ${value}`),
      /violates check constraint/,
    );
  }
});

test('malformed input is refused by field, and nothing is saved', async () => {
  const { person, org } = await newShipper();
  const before = await count('shipment_draft');
  const cases: [Record<string, unknown>, string][] = [
    [{ shipperReference: 'x'.repeat(65) }, 'shipperReference'],
    [{ cargoDescription: 'x'.repeat(2001) }, 'cargoDescription'],
    [{ packaging: 'x'.repeat(201) }, 'packaging'],
    [{ equipmentNeeded: 'x'.repeat(501) }, 'equipmentNeeded'],
    [{ pickup: { address: 'x'.repeat(501) } }, 'pickup.address'],
    [{ delivery: { accessNotes: 'x'.repeat(1001) } }, 'delivery.accessNotes'],
    [{ pickup: { countryCode: 'xa' } }, 'pickup.countryCode'],
    [{ pickup: { from: { local: '01/07/2026 09:00' } } }, 'pickup.from.local'],
    [
      { delivery: { until: { local: '2026-07-01T09:00', offsetMinutes: 1.5 } } },
      'delivery.until.offsetMinutes',
    ],
    [{ cargoDescription: 7 }, 'cargoDescription'],
  ];
  for (const [body, field] of cases) {
    const reply = await create(person, org, body);
    assert.equal(reply.status, 422, field);
    assert.deepEqual((reply.body.details as { fields: string[] }).fields, [field]);
  }
  // Found by the database: a country that is not in the register, a zone that is not the
  // country's, a zone with no country, a time that is not a time.
  const byDatabase: [Record<string, unknown>, string, string][] = [
    [{ pickup: { countryCode: 'ZZ' } }, 'pickup.countryCode', 'country_unavailable'],
    [
      { pickup: { countryCode: 'XA', timeZone: 'Etc/GMT-3' } },
      'pickup.timeZone',
      'zone_not_configured',
    ],
    [
      { delivery: { countryCode: 'XB', timeZone: 'Not/AZone' } },
      'delivery.timeZone',
      'zone_not_configured',
    ],
    [{ delivery: { timeZone: 'Etc/GMT-3' } }, 'delivery.timeZone', 'zone_needs_country'],
    [{ pickup: { from: { local: '2026-02-30T09:00' } } }, 'pickup.from', 'time_invalid'],
    [{ pickup: { from: { local: '2026-07-01T25:00' } } }, 'pickup.from', 'time_invalid'],
  ];
  for (const [body, field, code] of byDatabase) {
    const reply = await create(person, org, body);
    assert.equal(reply.status, 422, field);
    assert.deepEqual(problems(reply), [{ field, code }]);
  }
  // A retry key is required, and a refused request is not remembered under its key.
  const noKey = await call(api, 'POST', shipments(org), {
    token: person.token,
    body: { cargoDescription: 'x' },
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.body.code, 'retry_key_required');
  const sameKey = key();
  assert.equal((await create(person, org, { pieces: '0' }, sameKey)).status, 422);
  assert.equal((await create(person, org, { pieces: '5' }, sameKey)).status, 201);
  assert.equal(await count('shipment_draft'), before + 1);
});

// ---------------------------------------------------------------------------------------------
// Who may reach a draft (TI-2 to TI-5, SR-1)
// ---------------------------------------------------------------------------------------------
test('a draft of an organisation the person does not belong to answers as if it did not exist', async () => {
  const a = await newShipper();
  const b = await newShipper();
  const theirs = await created(b.person, b.org);
  const missing = randomUUID();
  const body = { cargoDescription: 'Reached from outside' };
  const attempts: [string, string, { body?: unknown; key?: string }][] = [
    ['GET', shipments(b.org), {}],
    ['GET', `/organisations/${b.org}/shipment-places`, {}],
    ['POST', shipments(b.org), { body, key: key() }],
    ['GET', shipments(b.org, `/${theirs.id}`), {}],
    ['PATCH', shipments(b.org, `/${theirs.id}`), { body: { ...body, version: 1 }, key: key() }],
    ['POST', shipments(b.org, `/${theirs.id}/discard`), { body: { version: 1 }, key: key() }],
    ['GET', shipments(b.org, `/${theirs.id}/history`), {}],
    // Their draft named under one's own organisation: also nothing.
    ['GET', shipments(a.org, `/${theirs.id}`), {}],
    ['PATCH', shipments(a.org, `/${theirs.id}`), { body: { ...body, version: 1 }, key: key() }],
    ['POST', shipments(a.org, `/${theirs.id}/discard`), { body: { version: 1 }, key: key() }],
    ['GET', shipments(a.org, `/${theirs.id}/history`), {}],
  ];
  for (const [method, route, options] of attempts) {
    const reply = await call(api, method, route, { token: a.person.token, ...options });
    const same = await call(
      api,
      method,
      route.replace(b.org, missing).replace(theirs.id, missing),
      {
        token: a.person.token,
        ...options,
        ...(options.key ? { key: key() } : {}),
      },
    );
    assert.equal(reply.status, 404, `${method} ${route}`);
    assert.deepEqual(
      { status: reply.status, code: reply.body.code, message: reply.body.message },
      { status: same.status, code: same.body.code, message: same.body.message },
      `${method} ${route}`,
    );
  }
  assert.deepEqual(await fetchOne(b.person, b.org, theirs.id), theirs, 'nothing changed');
  assert.equal(await count('shipment_draft', 'organisation_id = $1', [b.org]), 1);
  // Not an identifier at all.
  const odd = await call(api, 'GET', shipments(a.org, '/not-an-id'), { token: a.person.token });
  assert.equal(odd.status, 404);
});

test('no session, an invented one and a revoked one reach nothing, whatever key they send', async () => {
  const { person, org } = await newShipper();
  const retryKey = key();
  const first = await create(person, org, { cargoDescription: 'Before sign-out' }, retryKey);
  assert.equal(first.status, 201);
  const draft = first.body.shipment as Shipment;
  const routes: [string, string, { body?: unknown; key?: string }][] = [
    ['GET', shipments(org), {}],
    ['POST', shipments(org), { body: { cargoDescription: 'Before sign-out' }, key: retryKey }],
    ['GET', shipments(org, `/${draft.id}`), {}],
    [
      'PATCH',
      shipments(org, `/${draft.id}`),
      { body: { cargoDescription: 'x', version: 1 }, key: key() },
    ],
    ['POST', shipments(org, `/${draft.id}/discard`), { body: { version: 1 }, key: key() }],
    ['GET', shipments(org, `/${draft.id}/history`), {}],
  ];
  for (const token of [undefined, 'invented.token']) {
    for (const [method, route, options] of routes) {
      const reply = await call(api, method, route, { ...options, ...(token ? { token } : {}) });
      assert.equal(reply.status, 401, `${method} ${route}`);
      assert.equal(reply.body.shipment, undefined);
    }
  }
  assert.equal((await call(api, 'POST', '/auth/sign-out', { token: person.token })).status, 204);
  for (const [method, route, options] of routes) {
    const reply = await call(api, method, route, { ...options, token: person.token });
    assert.equal(reply.status, 401, `revoked: ${method} ${route}`);
    assert.equal(
      reply.body.shipment,
      undefined,
      'a stored retry is not returned to a revoked session',
    );
  }
  // Signed in again, the same key still means the same draft.
  const again = await signInAs(person.phone);
  const repeated = await create(again, org, { cargoDescription: 'Before sign-out' }, retryKey);
  assert.equal(repeated.status, 201);
  assert.equal((repeated.body.shipment as Shipment).id, draft.id);
  assert.equal(await count('shipment_draft', 'organisation_id = $1', [org]), 1);
});

test('as the API role: selecting A shows A only; nothing can be written; the functions decide who asks', async () => {
  const person = await newPerson();
  const orgA = await newOrganisation(person);
  const orgB = await newOrganisation(person); // the same person administers both
  const inA = await created(person, orgA, { cargoDescription: 'In A' });
  const inB = await created(person, orgB, { cargoDescription: 'In B' });
  const tokenHash = hashToken(person.token);
  const visible = (context: { tokenHash?: string; organisationId?: string }): Promise<string[]> =>
    asApiRole(context, async (client) =>
      (
        await client.query<{ id: string }>('SELECT id FROM trucker.shipment_draft ORDER BY id')
      ).rows.map((row) => row.id),
    );
  assert.deepEqual(await visible({ tokenHash, organisationId: orgA }), [inA.id]);
  assert.deepEqual(await visible({ tokenHash, organisationId: orgB }), [inB.id]);
  assert.deepEqual(await visible({ tokenHash }), [], 'no organisation selected');
  assert.deepEqual(await visible({ organisationId: orgA }), [], 'no session');
  assert.deepEqual(
    await visible({ tokenHash: 'f'.repeat(64), organisationId: orgA }),
    [],
    'invented session',
  );
  assert.deepEqual(
    await visible({ tokenHash, organisationId: randomUUID() }),
    [],
    'forged organisation',
  );
  const stranger = await newShipper();
  assert.deepEqual(
    await visible({ tokenHash: hashToken(stranger.person.token), organisationId: orgA }),
    [],
    'another person naming A',
  );
  // Naming B's draft while A is selected reads nothing, through the table or the functions.
  await asApiRole({ tokenHash, organisationId: orgA }, async (client) => {
    const direct = await client.query('SELECT 1 FROM trucker.shipment_draft WHERE id = $1', [
      inB.id,
    ]);
    assert.equal(direct.rowCount, 0);
    const update = await client.query<{ status: string }>(
      `SELECT status FROM trucker.update_shipment_draft($1, 1, $2, '{"cargoDescription":"x"}', true)`,
      [inB.id, key()],
    );
    assert.equal(update.rows[0]!.status, 'not_found');
    const discard = await client.query<{ status: string }>(
      'SELECT status FROM trucker.discard_shipment_draft($1, 1, $2)',
      [inB.id, key()],
    );
    assert.equal(discard.rows[0]!.status, 'not_found');
    await refused(
      () => client.query(`SELECT * FROM trucker.list_shipment_drafts('all', $1)`, [inB.id]),
      /unknown cursor/,
    );
  });
  // Nothing can be written except through the functions.
  for (const statement of [
    `INSERT INTO trucker.shipment_draft (organisation_id, created_by, created_at, updated_at)
       VALUES ('${orgA}', '${person.personId}', now(), now())`,
    `UPDATE trucker.shipment_draft SET cargo_description = 'changed'`,
    `UPDATE trucker.shipment_draft SET status = 'discarded', discarded_at = now()`,
    `UPDATE trucker.shipment_draft SET organisation_id = '${orgB}'`,
    `DELETE FROM trucker.shipment_draft`,
    `TRUNCATE trucker.shipment_draft`,
    `SELECT * FROM trucker.shipment_retry_key`,
    `INSERT INTO trucker.shipment_retry_key VALUES ('${person.personId}', 'kkkkkkkkkkkkkkkkkkkk', 'create', '', '${inA.id}', 1, now())`,
    `DELETE FROM trucker.shipment_retry_key`,
    `INSERT INTO trucker.audit_entry (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, after_values)
       VALUES (now(), '${person.personId}', '${orgA}', 'shipment.updated', 'shipment_draft', '${inA.id}', '{}')`,
    `UPDATE trucker.country SET operating_state = 'enabled'`,
    `INSERT INTO trucker.country_time_zone VALUES ('XA', 'Etc/GMT-9')`,
    `DELETE FROM trucker.country_time_zone`,
    `INSERT INTO trucker.lane (origin_country, destination_country, state) VALUES ('XC', 'XC', 'enabled')`,
    `UPDATE trucker.lane SET state = 'enabled'`,
    `DELETE FROM trucker.lane_transit`,
    `UPDATE trucker.security_setting SET shipment_open_draft_limit = 10000`,
    `SELECT trucker.resolve_shipment_content('{}'::jsonb, true)`,
    `SELECT * FROM trucker.local_time_candidates('2026-01-01 00:00', 'Etc/GMT-4')`,
    `SELECT trucker.country_available('XA', true)`,
  ]) {
    await assert.rejects(
      () => asApiRole({ tokenHash, organisationId: orgA }, (client) => client.query(statement)),
      /permission denied/i,
      statement,
    );
  }
  // The functions find for themselves who is asking: no session, no draft.
  for (const context of [
    { organisationId: orgA },
    { tokenHash: 'f'.repeat(64), organisationId: orgA },
  ]) {
    await asApiRole(context, async (client) => {
      const made = await client.query<{ status: string }>(
        `SELECT status FROM trucker.create_shipment_draft($1, '{"cargoDescription":"forged"}', true)`,
        [key()],
      );
      assert.equal(made.rows[0]!.status, 'unauthorized');
      const listed = await client.query(`SELECT * FROM trucker.list_shipment_drafts('all', NULL)`);
      assert.equal(listed.rowCount, 0);
    });
  }
  // A real session with an organisation it does not administer.
  await asApiRole(
    { tokenHash: hashToken(stranger.person.token), organisationId: orgA },
    async (client) => {
      const made = await client.query<{ status: string }>(
        `SELECT status FROM trucker.create_shipment_draft($1, '{"cargoDescription":"forged"}', true)`,
        [key()],
      );
      assert.equal(made.rows[0]!.status, 'not_found');
    },
  );
  // Settings the caller invents are not read.
  await asApiRole({ tokenHash, organisationId: orgA }, async (client) => {
    for (const name of ['trucker.shipment_page_size', 'trucker.shipment_open_draft_limit'])
      await client.query(`SELECT set_config($1, '100000', true)`, [name]);
    const listed = await client.query(`SELECT * FROM trucker.list_shipment_drafts('all', NULL)`);
    assert.equal(listed.rowCount, 1);
  });
  assert.equal(await count('shipment_draft', `cargo_description = 'forged'`), 0);
});

// ---------------------------------------------------------------------------------------------
// Safe retries on create (SR-2)
// ---------------------------------------------------------------------------------------------
test('create: the same key and content make one draft; different content is refused; keys are personal', async () => {
  const { person, org } = await newShipper();
  const retryKey = key();
  const body = { cargoDescription: 'Sent twice (fictional)', pieces: 3 };
  const first = await create(person, org, body, retryKey);
  const second = await create(person, org, body, retryKey);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body.shipment, first.body.shipment);
  const different = await create(person, org, { ...body, pieces: 4 }, retryKey);
  assert.equal(different.status, 409);
  assert.equal(different.body.code, 'retry_key_conflict');
  // Identical requests at the same moment.
  const racedKey = key();
  const raced = await Promise.all([1, 2, 3, 4, 5].map(() => create(person, org, body, racedKey)));
  assert.deepEqual([...new Set(raced.map((reply) => reply.status))], [201]);
  assert.equal(new Set(raced.map((reply) => (reply.body.shipment as Shipment).id)).size, 1);
  assert.equal(await count('shipment_draft', 'organisation_id = $1', [org]), 2);
  assert.equal(
    await count('audit_entry', `organisation_id = $1 AND action = 'shipment.created'`, [org]),
    2,
  );
  // Another person sending the same key gets their own draft and learns nothing.
  const other = await newShipper();
  const theirs = await create(other.person, other.org, body, retryKey);
  assert.equal(theirs.status, 201);
  assert.notEqual((theirs.body.shipment as Shipment).id, (first.body.shipment as Shipment).id);
  // The same key for one's other organisation is a different request.
  const secondOrg = await newOrganisation(person);
  const elsewhere = await create(person, secondOrg, body, retryKey);
  assert.equal(elsewhere.status, 409);
  assert.equal(elsewhere.body.code, 'retry_key_conflict');
  // After the retention period the key is treated as new.
  await advance(D.retry_key_retention_hours * 3600);
  const fresh = await signInAs(person.phone);
  const later = await create(fresh, org, body, retryKey);
  assert.equal(later.status, 201);
  assert.notEqual((later.body.shipment as Shipment).id, (first.body.shipment as Shipment).id);
});

// ---------------------------------------------------------------------------------------------
// Changing a draft, and an answer that was lost (SH-5)
// ---------------------------------------------------------------------------------------------
test('a change needs the version it was made against; a stale one is refused with the current draft', async () => {
  const { person, org } = await newShipper();
  const draft = await created(person, org, { cargoDescription: 'First wording' });
  const save = (version: number, cargoDescription: string, retryKey = key()): Promise<Reply> =>
    call(api, 'PATCH', shipments(org, `/${draft.id}`), {
      token: person.token,
      key: retryKey,
      body: { cargoDescription, version },
    });
  await advance(120);
  const saved = await save(1, 'Second wording');
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.outcome, 'updated');
  const now = saved.body.shipment as Shipment;
  assert.deepEqual([now.version, now.cargoDescription], [2, 'Second wording']);
  assert.equal(now.updatedAt, clock().toISOString());
  assert.equal(now.createdAt, draft.createdAt);
  // Made against the old version, by someone who has not seen the change.
  const stale = await save(1, 'Written over the top');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'shipment_changed');
  assert.deepEqual((stale.body.details as { current: Shipment }).current, now);
  assert.deepEqual(await fetchOne(person, org, draft.id), now, 'nothing was saved');
  // Two saves from the same version at the same moment: one wins.
  const both = await Promise.all([save(2, 'One'), save(2, 'Other')]);
  assert.deepEqual(both.map((reply) => reply.status).sort(), [200, 409]);
  assert.equal((await fetchOne(person, org, draft.id)).version, 3);
  // No key, no version, a version that is not a number.
  const noKey = await call(api, 'PATCH', shipments(org, `/${draft.id}`), {
    token: person.token,
    body: { cargoDescription: 'x', version: 3 },
  });
  assert.equal(noKey.status, 400);
  for (const version of [undefined, 'three', 0, 2.5]) {
    const reply = await call(api, 'PATCH', shipments(org, `/${draft.id}`), {
      token: person.token,
      key: key(),
      body: { cargoDescription: 'x', version },
    });
    assert.equal(reply.status, 422, String(version));
  }
  // A change that would empty the draft, or that is invalid, saves nothing.
  const emptied = await save(3, '');
  assert.equal(emptied.status, 422);
  assert.equal((await fetchOne(person, org, draft.id)).version, 3);
});

test('a change whose answer was lost can be asked for again: applied once, recognised as its own', async () => {
  const { person, org } = await newShipper();
  const draft = await created(person, org, { cargoDescription: 'Before' });
  const retryKey = key();
  const body = { cargoDescription: 'After', pieces: 9, version: 1 };
  const send = (payload: Record<string, unknown> = body, withKey = retryKey): Promise<Reply> =>
    call(api, 'PATCH', shipments(org, `/${draft.id}`), {
      token: person.token,
      key: withKey,
      body: payload,
    });
  const first = await send();
  assert.deepEqual(
    [first.status, first.body.outcome, first.body.appliedVersion],
    [200, 'updated', 2],
  );
  // The answer never arrived, so the very same request is sent again. Sent against version
  // 1, it would look stale; it is recognised by its key instead, and not applied twice.
  const again = await send();
  assert.deepEqual(
    [again.status, again.body.outcome, again.body.appliedVersion],
    [200, 'already_applied', 2],
  );
  assert.deepEqual(again.body.shipment, first.body.shipment);
  assert.equal(
    await count('audit_entry', `record_id = $1 AND action = 'shipment.updated'`, [draft.id]),
    1,
  );
  // Someone changes the draft afterwards. Asked a third time, the first request is still
  // answered as applied, with the draft as it is now: nothing is put back.
  const later = await send({ cargoDescription: 'Later still', version: 2 }, key());
  assert.equal(later.status, 200);
  const third = await send();
  assert.deepEqual(
    [third.status, third.body.outcome, third.body.appliedVersion],
    [200, 'already_applied', 2],
  );
  assert.deepEqual(
    [(third.body.shipment as Shipment).version, (third.body.shipment as Shipment).cargoDescription],
    [3, 'Later still'],
  );
  // The same key with other content, or for another draft, is a different request.
  const changed = await send({ ...body, pieces: 10 });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'retry_key_conflict');
  const otherDraft = await created(person, org);
  const elsewhere = await call(api, 'PATCH', shipments(org, `/${otherDraft.id}`), {
    token: person.token,
    key: retryKey,
    body,
  });
  assert.equal(elsewhere.body.code, 'retry_key_conflict');
  assert.equal((await fetchOne(person, org, otherDraft.id)).version, 1);
  // A revoked session gets nothing back for the key that succeeded.
  await call(api, 'POST', '/auth/sign-out', { token: person.token });
  assert.equal((await send()).status, 401);
});

// ---------------------------------------------------------------------------------------------
// Discarding (SH-6)
// ---------------------------------------------------------------------------------------------
test('discard keeps the record and its history, checks the version, and happens once', async () => {
  const { person, org } = await newShipper();
  const draft = await created(person, org, { cargoDescription: 'To be discarded', pieces: 2 });
  const discard = (version: unknown, retryKey = key()): Promise<Reply> =>
    call(api, 'POST', shipments(org, `/${draft.id}/discard`), {
      token: person.token,
      key: retryKey,
      body: { version },
    });
  // A version is required, and must be the current one.
  assert.equal((await discard(undefined)).status, 422);
  const changed = await call(api, 'PATCH', shipments(org, `/${draft.id}`), {
    token: person.token,
    key: key(),
    body: { cargoDescription: 'Changed first', pieces: 2, version: 1 },
  });
  assert.equal(changed.status, 200);
  const stale = await discard(1);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'shipment_changed');
  assert.equal((stale.body.details as { current: Shipment }).current.status, 'draft');
  assert.equal((await fetchOne(person, org, draft.id)).status, 'draft');
  const noKey = await call(api, 'POST', shipments(org, `/${draft.id}/discard`), {
    token: person.token,
    body: { version: 2 },
  });
  assert.equal(noKey.status, 400);

  await advance(30);
  const retryKey = key();
  const done = await discard(2, retryKey);
  assert.deepEqual([done.status, done.body.outcome], [200, 'discarded']);
  const gone = done.body.shipment as Shipment;
  assert.deepEqual(
    [gone.status, gone.version, gone.discardedAt],
    ['discarded', 3, clock().toISOString()],
  );
  // Kept: every field is still there, and it can still be opened.
  assert.equal(gone.cargoDescription, 'Changed first');
  assert.deepEqual(await fetchOne(person, org, draft.id), gone);
  assert.equal(await count('shipment_draft', 'id = $1', [draft.id]), 1);

  // Again with the same key (the answer was lost), with a new key, with any version: answered
  // as already discarded, and nothing more is written.
  for (const [version, withKey] of [
    [2, retryKey],
    [3, key()],
    [1, key()],
    [99, key()],
  ] as const) {
    const repeat = await discard(version, withKey);
    assert.deepEqual(
      [repeat.status, repeat.body.outcome],
      [200, 'already_discarded'],
      String(version),
    );
    assert.deepEqual(repeat.body.shipment, gone);
  }
  const several = await Promise.all([discard(3), discard(3), discard(3)]);
  assert.deepEqual([...new Set(several.map((reply) => reply.body.outcome))], ['already_discarded']);
  assert.equal(
    await count('audit_entry', `record_id = $1 AND action = 'shipment.discarded'`, [draft.id]),
    1,
  );
  assert.equal((await fetchOne(person, org, draft.id)).version, 3);

  // A discarded draft cannot be changed.
  const late = await call(api, 'PATCH', shipments(org, `/${draft.id}`), {
    token: person.token,
    key: key(),
    body: { cargoDescription: 'Too late', version: 3 },
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'shipment_discarded');
  // It leaves the default list and is found among the discarded.
  const open = await call(api, 'GET', shipments(org), { token: person.token });
  assert.deepEqual(open.body.shipments, []);
  const discarded = await call(api, 'GET', shipments(org, '?status=discarded'), {
    token: person.token,
  });
  assert.deepEqual(
    (discarded.body.shipments as { id: string }[]).map((row) => row.id),
    [draft.id],
  );
  // Two discards of a live draft at the same moment: one discard, one entry.
  const another = await created(person, org);
  const raced = await Promise.all(
    [1, 2, 3].map(() =>
      call(api, 'POST', shipments(org, `/${another.id}/discard`), {
        token: person.token,
        key: key(),
        body: { version: 1 },
      }),
    ),
  );
  assert.deepEqual(raced.map((reply) => reply.body.outcome).sort(), [
    'already_discarded',
    'already_discarded',
    'discarded',
  ]);
  assert.equal(
    await count('audit_entry', `record_id = $1 AND action = 'shipment.discarded'`, [another.id]),
    1,
  );
});

// ---------------------------------------------------------------------------------------------
// The list (SH-7): order of creation, which never changes
// ---------------------------------------------------------------------------------------------
test('pages stay stable while drafts are changed, discarded and added', async () => {
  const { person, org } = await newShipper();
  const made: string[] = [];
  for (let index = 0; index < 45; index += 1)
    made.push((await created(person, org, { shipperReference: `REF-${index}` })).id);
  const newestFirst = [...made].reverse();
  const page = async (
    afterId?: string,
    status?: string,
  ): Promise<{ ids: string[]; next: string | null }> => {
    const query = [status ? `status=${status}` : '', afterId ? `after=${afterId}` : ''].filter(
      Boolean,
    );
    const reply = await call(
      api,
      'GET',
      shipments(org, query.length ? `?${query.join('&')}` : ''),
      {
        token: person.token,
      },
    );
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return {
      ids: (reply.body.shipments as { id: string }[]).map((row) => row.id),
      next: reply.body.nextAfter as string | null,
    };
  };
  // Undisturbed: 20, 20, 5, newest created first, each draft once.
  const one = await page();
  assert.deepEqual(one.ids, newestFirst.slice(0, 20));
  assert.equal(one.next, newestFirst[19]);

  // While the reader is between pages: a draft already read is changed, one not yet read is
  // changed, two are added, and one not yet read is discarded.
  const patch = (id: string): Promise<Reply> =>
    call(api, 'PATCH', shipments(org, `/${id}`), {
      token: person.token,
      key: key(),
      body: { shipperReference: 'CHANGED', version: 1 },
    });
  // Time passes first, so that the changed drafts really are the most recently changed: an
  // order by last change would now put them in front.
  await advance(600);
  assert.equal((await patch(newestFirst[3]!)).status, 200);
  assert.equal((await patch(newestFirst[25]!)).status, 200);
  await advance(600);
  const added = [(await created(person, org)).id, (await created(person, org)).id];
  const discardedId = newestFirst[41]!;
  await call(api, 'POST', shipments(org, `/${discardedId}/discard`), {
    token: person.token,
    key: key(),
    body: { version: 1 },
  });

  const two = await page(one.next!);
  const three = await page(two.next!);
  assert.equal(three.next, null);
  // Changing a draft moved nothing: page two is exactly what it would have been.
  assert.deepEqual(two.ids, newestFirst.slice(20, 40));
  // The discarded draft is not shown; nothing else shifted, was repeated or was skipped.
  assert.deepEqual(
    three.ids,
    newestFirst.slice(40).filter((id) => id !== discardedId),
  );
  const walked = [...one.ids, ...two.ids, ...three.ids];
  assert.equal(new Set(walked).size, walked.length, 'no draft twice');
  assert.deepEqual(
    walked,
    newestFirst.filter((id) => id !== discardedId),
    'every draft that was there and is still open, once',
  );
  assert.ok(!walked.some((id) => added.includes(id)), 'drafts added during the walk are not in it');
  // A new walk starts with the new drafts.
  assert.deepEqual((await page()).ids.slice(0, 2), [...added].reverse());
  // The last draft of a page can itself be discarded: the walk goes on from where it was.
  const cursor = newestFirst[19]!;
  await call(api, 'POST', shipments(org, `/${cursor}/discard`), {
    token: person.token,
    key: key(),
    body: { version: 1 },
  });
  assert.deepEqual((await page(cursor)).ids, newestFirst.slice(20, 40));
  // Filters walk the same order.
  assert.deepEqual((await page(undefined, 'discarded')).ids, [cursor, discardedId]);
  const all = await page(undefined, 'all');
  assert.deepEqual(all.ids, [...[...added].reverse(), ...newestFirst.slice(0, 18)]);

  // A cursor must be a draft of this organisation; anything else is refused, not guessed at.
  const other = await newShipper();
  const theirs = await created(other.person, other.org);
  for (const bad of [randomUUID(), theirs.id, 'not-an-id']) {
    const reply = await call(api, 'GET', shipments(org, `?after=${bad}`), { token: person.token });
    assert.equal(reply.status, 422, bad);
    assert.deepEqual((reply.body.details as { fields: string[] }).fields, ['after']);
  }
  const badStatus = await call(api, 'GET', shipments(org, '?status=awarded'), {
    token: person.token,
  });
  assert.equal(badStatus.status, 422);

  // The page size is the database's setting, not the caller's.
  await writeSecuritySettings(owner, { shipment_page_size: 7 }, false);
  try {
    const small = await page();
    assert.equal(small.ids.length, 7);
    const ignored = await call(api, 'GET', shipments(org, '?limit=1000&pageSize=1000'), {
      token: person.token,
    });
    assert.equal((ignored.body.shipments as unknown[]).length, 7);
  } finally {
    await writeSecuritySettings(owner, { ...D }, false);
  }
});

test('the number of open drafts is limited by the protected setting, also under simultaneous requests', async () => {
  const { person, org } = await newShipper();
  await writeSecuritySettings(owner, { shipment_open_draft_limit: 3 }, false);
  try {
    const first = await created(person, org);
    const raced = await Promise.all([1, 2, 3, 4, 5].map(() => create(person, org)));
    assert.deepEqual(raced.map((reply) => reply.status).sort(), [201, 201, 409, 409, 409]);
    const over = raced.find((reply) => reply.status === 409)!;
    assert.equal(over.body.code, 'shipment_limit_reached');
    assert.deepEqual(over.body.details, { limit: 3 });
    assert.equal(await count('shipment_draft', 'organisation_id = $1', [org]), 3);
    // Discarded drafts do not count: discarding one makes room for one.
    await call(api, 'POST', shipments(org, `/${first.id}/discard`), {
      token: person.token,
      key: key(),
      body: { version: 1 },
    });
    assert.equal((await create(person, org)).status, 201);
    assert.equal((await create(person, org)).status, 409);
    // Another organisation has its own count.
    const other = await newShipper();
    assert.equal((await create(other.person, other.org)).status, 201);
  } finally {
    await writeSecuritySettings(owner, { ...D }, false);
  }
  assert.equal((await create(person, org)).status, 201);
});

// ---------------------------------------------------------------------------------------------
// The route check (RT-1 to RT-6)
// ---------------------------------------------------------------------------------------------
test('no operating state, time zone or lane ships: after the migrations every route is closed', async () => {
  const scratch = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: scratch.url, max: 1 });
  try {
    await migrateUp(pool, defaultMigrationsDir());
    for (const table of [
      'country',
      'country_time_zone',
      'lane',
      'lane_transit',
      'shipment_draft',
    ]) {
      const rows = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM trucker.${table}`,
      );
      assert.equal(rows.rows[0]!.n, 0, table);
    }
    const route = await pool.query<{ route: { status: string; reasons: { code: string }[] } }>(
      `SELECT trucker.route_check('XA', 'XB', true) AS route`,
    );
    assert.equal(route.rows[0]!.route.status, 'closed');
    // The fixtures are refused there: the database is not marked for them.
    await refused(() => loadCountryFixtures(pool), /marked local-development or test/);
    // A zone the database does not know is refused even for the migration role.
    await pool.query(`UPDATE trucker.environment SET kind = 'test'`);
    await loadCountryFixtures(pool);
    await refused(
      () => pool.query(`INSERT INTO trucker.country_time_zone VALUES ('XA', 'Not/AZone')`),
      /does not know the time zone/,
    );
  } finally {
    await pool.end();
    await scratch.drop();
  }
});

test('a draft is saved whatever its route, and says which part is not open', async () => {
  const { person, org } = await newShipper();
  const route = async (origin?: string, destination?: string): Promise<Shipment['route']> => {
    const draft = await created(person, org, {
      cargoDescription: 'Route check (fictional)',
      ...(origin ? { pickup: { countryCode: origin } } : {}),
      ...(destination ? { delivery: { countryCode: destination } } : {}),
    });
    assert.equal(draft.route.basis, 'configuration');
    return draft.route;
  };
  const open = { status: 'open', basis: 'configuration', reasons: [] };
  // Domestic, direct, and through a transit country that is open.
  assert.deepEqual(await route('XA', 'XA'), { ...open, transit: [] });
  assert.deepEqual(await route('XA', 'XB'), { ...open, transit: [] });
  assert.deepEqual(await route('XB', 'XD'), { ...open, transit: ['XA'] });
  // A transit country that is closed.
  assert.deepEqual(await route('XB', 'XA'), {
    status: 'closed',
    basis: 'configuration',
    transit: ['XC'],
    reasons: [{ part: 'transit', code: 'country_closed', country: 'XC', position: 1 }],
  });
  // A lane that exists and is closed; no lane at all, also for a domestic route.
  assert.deepEqual((await route('XA', 'XD')).reasons, [{ part: 'lane', code: 'lane_closed' }]);
  assert.deepEqual((await route('XB', 'XB')).reasons, [{ part: 'lane', code: 'lane_missing' }]);
  // The lane the other way round is a different lane.
  assert.deepEqual((await route('XD', 'XB')).reasons, [{ part: 'lane', code: 'lane_missing' }]);
  // A closed country at either end.
  assert.deepEqual((await route('XA', 'XC')).reasons, [
    { part: 'destination', code: 'country_closed', country: 'XC' },
    { part: 'lane', code: 'lane_missing' },
  ]);
  assert.deepEqual((await route('XC', 'XA')).reasons, [
    { part: 'origin', code: 'country_closed', country: 'XC' },
    { part: 'lane', code: 'lane_missing' },
  ]);
  // Not yet known: a place has no country.
  for (const [origin, destination] of [
    ['XA', undefined],
    [undefined, 'XB'],
    [undefined, undefined],
  ] as const)
    assert.deepEqual(await route(origin, destination), {
      status: 'unknown',
      basis: 'configuration',
      reasons: [],
    });
});

test('the route answer follows the registers, is stored nowhere, and never counts fixtures unasked', async () => {
  const { person, org } = await newShipper();
  const draft = await created(person, org, {
    cargoDescription: 'Follows the register (fictional)',
    pickup: { countryCode: 'XA' },
    delivery: { countryCode: 'XB' },
  });
  assert.equal(draft.route.status, 'open');
  const stored = await owner.query(
    'SELECT to_jsonb(d) AS row FROM trucker.shipment_draft d WHERE id = $1',
    [draft.id],
  );
  assert.ok(
    !JSON.stringify(stored.rows[0]).includes('route'),
    'no route answer is stored in the draft',
  );
  await owner.query(
    `UPDATE trucker.lane SET state = 'closed' WHERE origin_country = 'XA' AND destination_country = 'XB'`,
  );
  try {
    const closed = await fetchOne(person, org, draft.id);
    assert.deepEqual(closed.route.reasons, [{ part: 'lane', code: 'lane_closed' }]);
    assert.equal(closed.version, draft.version, 'the draft itself did not change');
    assert.equal(closed.updatedAt, draft.updatedAt);
  } finally {
    await owner.query(
      `UPDATE trucker.lane SET state = 'enabled' WHERE origin_country = 'XA' AND destination_country = 'XB'`,
    );
  }
  assert.equal((await fetchOne(person, org, draft.id)).route.status, 'open');
  // An API that was not asked to count fixtures sees none of them: the same draft is closed,
  // no fixture country is offered, and none can be put into a draft.
  const plain = await call(noFixtures, 'GET', shipments(org, `/${draft.id}`), {
    token: person.token,
  });
  assert.equal(plain.status, 200);
  assert.equal((plain.body.shipment as Shipment).route.status, 'closed');
  const offered = await call(noFixtures, 'GET', `/organisations/${org}/shipment-places`, {
    token: person.token,
  });
  assert.deepEqual(offered.body.countries, []);
  const refusedPlace = await create(
    person,
    org,
    { pickup: { countryCode: 'XA' } },
    key(),
    noFixtures,
  );
  assert.equal(refusedPlace.status, 422);
  assert.deepEqual(problems(refusedPlace), [
    { field: 'pickup.countryCode', code: 'country_unavailable' },
  ]);
  // With fixtures counted, they are offered and labelled as fixtures, with their zones.
  const places = await call(api, 'GET', `/organisations/${org}/shipment-places`, {
    token: person.token,
  });
  const countries = places.body.countries as {
    code: string;
    fixture: boolean;
    timeZones: string[];
  }[];
  assert.deepEqual(
    countries.map((country) => country.code),
    ['XA', 'XB', 'XC', 'XD'],
  );
  assert.ok(countries.every((country) => country.fixture));
  assert.deepEqual(countries.find((country) => country.code === 'XD')!.timeZones, [
    'Etc/GMT-4',
    'Etc/GMT-5',
  ]);
});

// ---------------------------------------------------------------------------------------------
// Time (TZ-1 to TZ-5)
// ---------------------------------------------------------------------------------------------
test("a window is typed in its place's own time, stored as an instant, and shown again as typed", async () => {
  const { person, org } = await newShipper();
  const draft = await created(person, org, {
    pickup: {
      countryCode: 'XA',
      timeZone: 'Etc/GMT-4',
      from: { local: '2026-07-01T09:00' },
      until: { local: '2026-07-01T12:30' },
    },
    delivery: {
      countryCode: 'XB',
      timeZone: 'Etc/GMT-3',
      from: { local: '2026-07-01T11:45' },
      until: { local: '2026-07-02T08:00' },
    },
  });
  // Nine o'clock four hours ahead of UTC is five o'clock UTC; the other place is three ahead.
  assert.deepEqual(draft.pickup.from, {
    local: '2026-07-01T09:00',
    offsetMinutes: 240,
    at: '2026-07-01T05:00:00.000Z',
    offsetChoices: null,
  });
  assert.deepEqual(draft.pickup.until, {
    local: '2026-07-01T12:30',
    offsetMinutes: 240,
    at: '2026-07-01T08:30:00.000Z',
    offsetChoices: null,
  });
  assert.deepEqual(draft.delivery.from, {
    local: '2026-07-01T11:45',
    offsetMinutes: 180,
    at: '2026-07-01T08:45:00.000Z',
    offsetChoices: null,
  });
  assert.equal(draft.delivery.until.at, '2026-07-02T05:00:00.000Z');
  // The name of the zone is what is stored, never an offset on its own.
  const row = await owner.query<{ pickup_time_zone: string; delivery_time_zone: string }>(
    'SELECT pickup_time_zone, delivery_time_zone FROM trucker.shipment_draft WHERE id = $1',
    [draft.id],
  );
  assert.deepEqual(row.rows[0], { pickup_time_zone: 'Etc/GMT-4', delivery_time_zone: 'Etc/GMT-3' });
  // The same wall-clock time in another zone of the same country is another instant.
  const moved = await call(api, 'PATCH', shipments(org, `/${draft.id}`), {
    token: person.token,
    key: key(),
    body: {
      version: 1,
      pickup: { countryCode: 'XD', timeZone: 'Etc/GMT-5', from: { local: '2026-07-01T09:00' } },
    },
  });
  assert.deepEqual((moved.body.shipment as Shipment).pickup.from, {
    local: '2026-07-01T09:00',
    offsetMinutes: 300,
    at: '2026-07-01T04:00:00.000Z',
    offsetChoices: null,
  });
});

test('a time that does not exist is refused; a time that occurs twice must be chosen', async () => {
  const { person, org } = await newShipper();
  const at = (local: string, offsetMinutes?: number): Record<string, unknown> => ({
    pickup: {
      countryCode: 'XA',
      timeZone: CHANGING_ZONE,
      from: { local, ...(offsetMinutes === undefined ? {} : { offsetMinutes }) },
    },
  });
  const before = await count('shipment_draft');
  // The clocks go forward over this time: it never happens.
  const skipped = await create(person, org, at('2026-03-08T02:30'));
  assert.equal(skipped.status, 422);
  assert.deepEqual(problems(skipped), [{ field: 'pickup.from', code: 'time_does_not_exist' }]);
  // The clocks go back over this time: it happens twice. Nothing is chosen for the person.
  const twice = await create(person, org, at('2026-11-01T01:30'));
  assert.equal(twice.status, 422);
  assert.deepEqual(problems(twice), [
    { field: 'pickup.from', code: 'time_ambiguous', offsets: [-240, -300] },
  ]);
  // A choice that is neither of the two is no choice.
  for (const wrong of [0, 240, -299]) {
    const reply = await create(person, org, at('2026-11-01T01:30', wrong));
    assert.equal(reply.status, 422, String(wrong));
    assert.equal(problems(reply)[0]!.code, 'time_ambiguous');
  }
  assert.equal(await count('shipment_draft'), before, 'nothing was saved');
  // Each choice is a different instant, an hour apart, and the choice is kept.
  const earlier = await created(person, org, at('2026-11-01T01:30', -240));
  const later = await created(person, org, at('2026-11-01T01:30', -300));
  assert.deepEqual(earlier.pickup.from, {
    local: '2026-11-01T01:30',
    offsetMinutes: -240,
    at: '2026-11-01T05:30:00.000Z',
    offsetChoices: [-240, -300],
  });
  assert.deepEqual(later.pickup.from, {
    local: '2026-11-01T01:30',
    offsetMinutes: -300,
    at: '2026-11-01T06:30:00.000Z',
    offsetChoices: [-240, -300],
  });
  // A choice sent with a time that occurs once is not needed and not used.
  const once = await created(person, org, at('2026-07-01T09:00', -300));
  assert.deepEqual(once.pickup.from, {
    local: '2026-07-01T09:00',
    offsetMinutes: -240,
    at: '2026-07-01T13:00:00.000Z',
    offsetChoices: null,
  });
  // Changing a draft with an ambiguous time needs the choice again.
  const kept = await call(api, 'PATCH', shipments(org, `/${later.id}`), {
    token: person.token,
    key: key(),
    body: { ...at('2026-11-01T01:30'), version: 1 },
  });
  assert.equal(kept.status, 422);
  assert.equal(problems(kept)[0]!.code, 'time_ambiguous');
  assert.equal((await fetchOne(person, org, later.id)).pickup.from.offsetMinutes, -300);
  // The two offsets are shown for the organisation's own draft only, also to the API role.
  const choices = (organisationId: string): Promise<unknown> =>
    asApiRole({ tokenHash: hashToken(person.token), organisationId }, async (client) => {
      const result = await client.query<{ choices: unknown }>(
        'SELECT trucker.offset_choices($1) AS choices',
        [later.id],
      );
      return result.rows[0]!.choices;
    });
  assert.deepEqual(await choices(org), { 'pickup.from': [-240, -300] });
  assert.deepEqual(await choices(await newOrganisation(person)), {});
});

test('a window may not end before it starts, nor delivery end before pick-up starts; the past is not judged', async () => {
  const { person, org } = await newShipper();
  const places = (
    pickup: [string | null, string | null],
    delivery: [string | null, string | null],
  ): Record<string, unknown> => ({
    pickup: {
      countryCode: 'XA',
      timeZone: 'Etc/GMT-4',
      from: { local: pickup[0] },
      until: { local: pickup[1] },
    },
    delivery: {
      countryCode: 'XB',
      timeZone: 'Etc/GMT-3',
      from: { local: delivery[0] },
      until: { local: delivery[1] },
    },
  });
  const backwards = await create(
    person,
    org,
    places(['2026-07-01T12:00', '2026-07-01T11:59'], [null, null]),
  );
  assert.deepEqual(problems(backwards), [{ field: 'pickup.until', code: 'window_order' }]);
  const delivery = await create(
    person,
    org,
    places([null, null], ['2026-07-02T10:00', '2026-07-02T09:00']),
  );
  assert.deepEqual(problems(delivery), [{ field: 'delivery.until', code: 'window_order' }]);
  // Compared as instants, across zones: 08:59 three hours ahead is 05:59 UTC, before 10:00
  // four hours ahead (06:00 UTC), although the clock on the wall reads later... earlier.
  const early = await create(
    person,
    org,
    places(['2026-07-01T10:00', null], [null, '2026-07-01T08:59']),
  );
  assert.deepEqual(problems(early), [{ field: 'delivery.until', code: 'delivery_before_pickup' }]);
  // At the same instant it is allowed: 09:00 three hours ahead is 10:00 four hours ahead.
  assert.equal(
    (await create(person, org, places(['2026-07-01T10:00', null], [null, '2026-07-01T09:00'])))
      .status,
    201,
  );
  // Equal ends, and windows entirely in the past, are a draft's business.
  assert.equal(
    (await create(person, org, places(['2026-07-01T12:00', '2026-07-01T12:00'], [null, null])))
      .status,
    201,
  );
  assert.equal(
    (
      await create(
        person,
        org,
        places(['2020-01-01T08:00', '2020-01-01T09:00'], ['2020-01-02T08:00', null]),
      )
    ).status,
    201,
  );
  // Without a zone there is no instant, so nothing is compared and nothing is assumed.
  const noZones = await create(person, org, {
    pickup: { from: { local: '2026-07-01T12:00' }, until: { local: '2026-07-01T09:00' } },
  });
  assert.equal(noZones.status, 201);
});

test('a change that waits behind a lock is stamped with the time after the wait, and not made if the session ended meanwhile', async () => {
  const { person, org } = await newShipper();
  const draft = await created(person, org, { cargoDescription: 'Waiting' });
  const save = (version: number, text: string): Promise<Reply> =>
    call(api, 'PATCH', shipments(org, `/${draft.id}`), {
      token: person.token,
      key: key(),
      body: { cargoDescription: text, version },
    });
  // Held up for ten minutes: the change is made, and timed when it was made.
  const waited = await whileBlocked(
    lockRow('shipment_draft', draft.id),
    () => save(1, 'After the wait'),
    600,
  );
  assert.equal(waited.status, 200, JSON.stringify(waited.body));
  assert.equal((waited.body.shipment as Shipment).updatedAt, clock().toISOString());
  const entry = await owner.query<{ occurred_at: Date }>(
    `SELECT occurred_at FROM trucker.audit_entry WHERE record_id = $1 AND action = 'shipment.updated'`,
    [draft.id],
  );
  assert.equal(entry.rows[0]!.occurred_at.toISOString(), clock().toISOString());
  // Held up until the session has been idle too long: nothing is changed, discarded or made.
  await call(api, 'GET', '/me', { token: person.token }); // used now
  const idle = D.session_idle_minutes * 60;
  const tooLate = await whileBlocked(
    lockRow('shipment_draft', draft.id),
    () => save(2, 'Too late'),
    idle,
  );
  assert.equal(tooLate.status, 401);
  const fresh = await signInAs(person.phone);
  assert.deepEqual(
    [
      (await fetchOne(fresh, org, draft.id)).version,
      (await fetchOne(fresh, org, draft.id)).cargoDescription,
    ],
    [2, 'After the wait'],
  );
  await call(api, 'GET', '/me', { token: fresh.token });
  const discard = await whileBlocked(
    lockRow('shipment_draft', draft.id),
    () =>
      call(api, 'POST', shipments(org, `/${draft.id}/discard`), {
        token: fresh.token,
        key: key(),
        body: { version: 2 },
      }),
    idle,
  );
  assert.equal(discard.status, 401);
  const third = await signInAs(person.phone);
  assert.equal((await fetchOne(third, org, draft.id)).status, 'draft');
  assert.equal(await count('audit_entry', 'record_id = $1', [draft.id]), 2);
  // Creating, queued behind another creation for the same organisation.
  await call(api, 'GET', '/me', { token: third.token });
  const before = await count('shipment_draft', 'organisation_id = $1', [org]);
  const made = await whileBlocked(
    ['SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`shipment.create:${org}`]],
    () => create(third, org),
    idle,
  );
  assert.equal(made.status, 401);
  assert.equal(await count('shipment_draft', 'organisation_id = $1', [org]), before);
});

// ---------------------------------------------------------------------------------------------
// History (AU-1, AU-2)
// ---------------------------------------------------------------------------------------------
test('create, change and discard each leave one entry, with who, when, the request and the values', async () => {
  const { person, org } = await newShipper();
  const made = await create(person, org, { cargoDescription: 'Version one', pieces: 1 });
  const draft = made.body.shipment as Shipment;
  await advance(60);
  const changed = await call(api, 'PATCH', shipments(org, `/${draft.id}`), {
    token: person.token,
    key: key(),
    body: { cargoDescription: 'Version two', pieces: 2, version: 1 },
  });
  await advance(60);
  const discarded = await call(api, 'POST', shipments(org, `/${draft.id}/discard`), {
    token: person.token,
    key: key(),
    body: { version: 2 },
  });
  const history = await call(api, 'GET', shipments(org, `/${draft.id}/history`), {
    token: person.token,
  });
  assert.equal(history.status, 200);
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
    ['shipment.created', 'shipment.updated', 'shipment.discarded'],
  );
  assert.deepEqual(
    entries.map((entry) => entry.requestId),
    [made.requestId, changed.requestId, discarded.requestId],
  );
  assert.ok(entries.every((entry) => entry.actorPersonId === person.personId));
  assert.equal(entries[2]!.occurredAt, clock().toISOString());
  assert.equal(entries[0]!.before, null);
  assert.deepEqual(
    [entries[0]!.after.cargo_description, entries[0]!.after.pieces, entries[0]!.after.version],
    ['Version one', 1, 1],
  );
  assert.deepEqual(
    [
      entries[1]!.before!.cargo_description,
      entries[1]!.after.cargo_description,
      entries[1]!.after.version,
    ],
    ['Version one', 'Version two', 2],
  );
  assert.deepEqual([entries[2]!.before!.status, entries[2]!.after.status], ['draft', 'discarded']);
  // No token, hash or phone number is in the history.
  const text = JSON.stringify(entries);
  assert.ok(!text.includes(person.token.split('.')[1]!));
  assert.ok(!text.includes(hashToken(person.token)));
  assert.ok(!text.includes(person.phone));
  // A refused request leaves none.
  await call(api, 'PATCH', shipments(org, `/${draft.id}`), {
    token: person.token,
    key: key(),
    body: { cargoDescription: 'Refused', version: 3 },
  });
  assert.equal(await count('audit_entry', 'record_id = $1', [draft.id]), 3);
});

// ---------------------------------------------------------------------------------------------
// What this slice must not contain (SH-8)
// ---------------------------------------------------------------------------------------------
test('there is no route to quote, book or pay, and no such word in the shipment code', async () => {
  const { person, org } = await newShipper();
  const draft = await created(person, org);
  for (const [method, action] of [
    ['POST', 'publication'],
    ['POST', 'quotations'],
    ['GET', 'quotations'],
    ['POST', 'offers'],
    ['POST', 'book'],
    ['POST', 'booking'],
    ['POST', 'accept'],
    ['POST', 'pay'],
    ['POST', 'payments'],
    ['DELETE', ''],
  ] as const) {
    const reply = await call(
      api,
      method,
      shipments(org, `/${draft.id}${action ? `/${action}` : ''}`),
      {
        token: person.token,
        key: key(),
        ...(method === 'GET' ? {} : { body: {} }),
      },
    );
    assert.equal(reply.status, 404, `${method} ${action}`);
  }
  // A status that belongs to a later slice cannot be written.
  const row = await owner.query<{ status: string }>(
    'SELECT status FROM trucker.shipment_draft WHERE id = $1',
    [draft.id],
  );
  assert.equal(row.rows[0]!.status, 'draft');
  await refused(
    () =>
      owner.query(`UPDATE trucker.shipment_draft SET status = 'awarded' WHERE id = $1`, [draft.id]),
    /violates check constraint/,
  );
  // The routes that exist are exactly these.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.resolve(here, '../../src/shipment');
  const controller = readFileSync(path.join(source, 'shipment.controller.ts'), 'utf8');
  const routes = [...controller.matchAll(/@(Get|Post|Patch|Put|Delete)\('([^']*)'\)/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes.sort(), [
    'Get shipment-catalogues',
    'Get shipment-places',
    'Get shipments',
    'Get shipments/:id',
    'Get shipments/:id/history',
    'Get shipments/:id/publication',
    'Patch shipments/:id',
    'Post shipments',
    'Post shipments/:id/copy',
    'Post shipments/:id/discard',
    'Post shipments/:id/publish',
    'Post shipments/:id/published-changes',
    'Post shipments/:id/republish',
    'Post shipments/:id/withdraw',
  ]);
  // No field, column or message about price, payment, quotations or booking. Publication is
  // this slice's; the quotation deadline is its one mention of quotations (PB-3).
  const root = path.resolve(here, '../../../..');
  const files = [
    ...readdirSync(source)
      .filter((name) => !name.endsWith('.test.ts'))
      .map((name) => path.join(source, name)),
    path.join(root, 'db/migrations/0005_shipment_drafts.sql'),
    path.join(root, 'db/migrations/0008_shipment_publication.sql'),
  ];
  for (const file of files) {
    const code = readFileSync(file, 'utf8')
      // Comments say what the slice does not do; only what is not a comment is searched.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*(\/\/|--).*$/gm, '')
      .replace(/COMMENT ON [^;]*;/g, '')
      .replace(/quotation_?deadline/gi, '');
    for (const word of [
      'price',
      'amount',
      'currency',
      'payment',
      'invoice',
      'quotation',
      'quote',
      'booking',
      'declared_value',
    ])
      assert.ok(!code.toLowerCase().includes(word), `${path.basename(file)} mentions "${word}"`);
  }
});
