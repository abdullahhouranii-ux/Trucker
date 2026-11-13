import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { loadConfig } from '../config/config.js';
import { inspectAccess } from '../database/access.js';
import { appDatabaseUrl, ensureLocalAppLogin, markEnvironment } from '../database/local.js';
import { defaultMigrationsDir, migrateUp } from '../database/migrations.js';
import {
  parseSettingChanges,
  readSecuritySettings,
  SECURITY_SETTING_DEFAULTS,
  writeSecuritySettings,
} from '../database/settings.js';
import { createTestClock } from '../testing/test-clock.js';
import { createTestDatabase, type TestDatabase } from '../testing/test-database.js';
import { IdentityService } from './identity.service.js';
import { codePepper, hashToken, sessionToken } from './secrets.js';

// ---------------------------------------------------------------------------------------------
// The database functions called directly, as the API's own role and nothing else: what
// someone could do who had taken that role over and could run any statement as it.
//   owner  the migration role: sets things up and looks inside
//   app    the API's role (local login), the only connection the "attacker" has
// ---------------------------------------------------------------------------------------------
const SECRET = 'hardening-test-secret-of-sufficient-length';
const PEPPER = codePepper(SECRET);
const D = SECURITY_SETTING_DEFAULTS;

let database: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
const testClock = createTestClock();
const { advance } = testClock;
const scratches: { pool: pg.Pool; app: pg.Pool; database: TestDatabase }[] = [];

before(async () => {
  database = await createTestDatabase();
  owner = new pg.Pool({ connectionString: database.url });
  await migrateUp(owner, defaultMigrationsDir());
  await ensureLocalAppLogin(owner);
  await markEnvironment(owner, 'test');
  await testClock.start(owner);
  app = new pg.Pool({ connectionString: appDatabaseUrl(database.url), max: 4 });
});
after(async () => {
  for (const scratch of scratches) {
    await scratch.app.end();
    await scratch.pool.end();
    await scratch.database.drop();
  }
  await app.end();
  await owner.end();
  await database.drop();
});

/** Another migrated database, marked as asked, with both connections. */
async function scratchDatabase(
  mark: 'unmarked' | 'local-development' | 'test' | 'production',
): Promise<{ pool: pg.Pool; app: pg.Pool }> {
  const other = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: other.url, max: 2 });
  await migrateUp(pool, defaultMigrationsDir());
  await ensureLocalAppLogin(pool);
  if (mark !== 'unmarked')
    await pool.query('UPDATE trucker.environment SET kind = $1, marked_at = now()', [mark]);
  const restricted = new pg.Pool({ connectionString: appDatabaseUrl(other.url), max: 2 });
  scratches.push({ pool, app: restricted, database: other });
  return { pool, app: restricted };
}

const refused = async (work: () => Promise<unknown>, pattern: RegExp): Promise<void> => {
  await assert.rejects(work, (error: Error) => pattern.test(error.message), String(pattern));
};

// Fictional numbers: country code 999 is not assigned to any country.
let phoneCounter = 0;
const newPhone = (): string => `+99966${String(1_000_000 + phoneCounter++)}`;
const key = (): string => `test-${randomUUID()}`;
const randomHash = (): string => randomBytes(32).toString('hex');

interface CodeRow {
  status: string;
  challenge_id: string | null;
  created_at: Date | null;
  expires_at: Date | null;
  resend_available_at: Date | null;
  retry_after_seconds: number | null;
  development_code: string | null;
}
async function requestCode(
  phone: string,
  options: { reveal?: boolean; pool?: pg.Pool; requestKey?: string } = {},
): Promise<CodeRow> {
  const result = await (options.pool ?? app).query<CodeRow>(
    'SELECT * FROM trucker.sign_in_request_code($1, $2, $3, $4)',
    [phone, options.requestKey ?? key(), PEPPER, options.reveal ?? true],
  );
  return result.rows[0]!;
}

interface VerifyRow {
  status: string;
  attempts_remaining: number | null;
  session_id: string | null;
}
async function verifyCode(
  challengeId: string,
  code: string,
  options: { sessionId?: string; tokenHash?: string; requestKey?: string; pepper?: string } = {},
): Promise<VerifyRow> {
  const result = await app.query<VerifyRow>(
    'SELECT * FROM trucker.sign_in_verify_code($1, $2, $3, $4, $5, $6, $7)',
    [
      challengeId,
      code,
      options.requestKey ?? key(),
      options.pepper ?? PEPPER,
      options.sessionId ?? randomUUID(),
      options.tokenHash ?? randomHash(),
      'hardening-test',
    ],
  );
  return result.rows[0]!;
}

interface Signed {
  phone: string;
  sessionId: string;
  tokenHash: string;
  personId: string;
  challengeId: string;
  code: string;
  verifyKey: string;
}
/** Signs in through the functions, the way the API does, and steps past the resend wait. */
async function signIn(phone = newPhone()): Promise<Signed> {
  const asked = await requestCode(phone);
  assert.equal(asked.status, 'created', JSON.stringify(asked));
  const sessionId = randomUUID();
  const tokenHash = hashToken(sessionToken(SECRET, sessionId));
  const verifyKey = key();
  const verified = await verifyCode(asked.challenge_id!, asked.development_code!, {
    sessionId,
    tokenHash,
    requestKey: verifyKey,
  });
  assert.equal(verified.status, 'signed_in', JSON.stringify(verified));
  const person = await owner.query<{ person_id: string }>(
    'SELECT person_id FROM trucker.session WHERE id = $1',
    [sessionId],
  );
  await advance(D.code_resend_wait_seconds + 1);
  return {
    phone,
    sessionId,
    tokenHash,
    personId: person.rows[0]!.person_id,
    challengeId: asked.challenge_id!,
    code: asked.development_code!,
    verifyKey,
  };
}
const wrongCode = (code: string): string => (code === '000000' ? '000001' : '000000');

const check = async (tokenHash: string): Promise<string> =>
  (
    await app.query<{ status: string }>('SELECT status FROM trucker.session_check($1, $2)', [
      tokenHash,
      'hardening-test',
    ])
  ).rows[0]!.status;
const account = async (tokenHash: string): Promise<Record<string, unknown>[]> =>
  (await app.query('SELECT * FROM trucker.my_account($1)', [tokenHash])).rows;
/** Who the organisation rules would take the caller to be, given this token hash. */
async function requestPerson(tokenHash: string): Promise<string | null> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('trucker.session_token_hash', $1, true)`, [tokenHash]);
    const found = await client.query<{ person: string | null }>(
      'SELECT trucker.request_person() AS person',
    );
    return found.rows[0]!.person;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
const sessionRow = async (id: string): Promise<Record<string, unknown> | undefined> =>
  (await owner.query('SELECT * FROM trucker.session WHERE id = $1', [id])).rows[0];
const count = async (table: string, where: string, values: unknown[]): Promise<number> =>
  (
    await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trucker.${table} WHERE ${where}`,
      values,
    )
  ).rows[0]!.n;

/** Functions the API's role may run. Anything else in the schema must be closed to it. */
const CALLABLE = [
  'complete_registration(p_token_hash text, p_display_name text, p_contact_email text, p_terms_version text, p_terms_language text, p_request_id text)',
  'create_organisation(p_legal_name text, p_trading_name text, p_country_code text, p_registration_number text, p_address text, p_contact_name text, p_allow_fixtures boolean)',
  'is_admin(organisation uuid)',
  'is_member(organisation uuid)',
  'my_account(p_token_hash text)',
  'my_organisations()',
  'my_sessions(p_token_hash text)',
  'organisation_selected()',
  'request_organisation()',
  'request_person()',
  'revoke_my_other_sessions(p_token_hash text, p_request_id text)',
  'revoke_my_session(p_token_hash text, p_session uuid, p_request_id text)',
  'security_settings_reviewed()',
  'session_check(p_token_hash text, p_request_id text)',
  'sign_in_request_code(p_phone text, p_request_key text, p_pepper text, p_reveal boolean)',
  'sign_in_verify_code(p_challenge uuid, p_code text, p_request_key text, p_pepper text, p_session uuid, p_token_hash text, p_request_id text)',
];

// ---------------------------------------------------------------------------------------------
// IH-1: no right on the identity tables, the settings, the clock or the mark
// ---------------------------------------------------------------------------------------------
test('the API role is still bound by row security after the migration', async () => {
  const access = await inspectAccess(app);
  assert.deepEqual(access.problems, []);
  assert.equal(access.environment, 'test');
  assert.equal(access.settingsReviewed, false);
});

test('the API role cannot read or write any identity table, the settings, the clock or the mark', async () => {
  const signed = await signIn();
  const tables = [
    'person',
    'session',
    'sign_in_challenge',
    'terms_acceptance',
    'identity_event',
    'security_setting',
    'test_clock',
  ];
  const statements = [
    ...tables.flatMap((table) => [
      `SELECT * FROM trucker.${table}`,
      `SELECT count(*) FROM trucker.${table}`,
      `DELETE FROM trucker.${table}`,
      `TRUNCATE trucker.${table}`,
    ]),
    `SELECT token_hash FROM trucker.session`,
    `SELECT code_hash FROM trucker.sign_in_challenge`,
    `SELECT phone_e164 FROM trucker.person`,
    `INSERT INTO trucker.person (phone_e164) VALUES ('+99900000001')`,
    `INSERT INTO trucker.session (person_id, token_hash, created_at, last_used_at, absolute_expires_at)
       VALUES ('${signed.personId}', '${randomHash()}', now(), now(), now() + interval '12 hours')`,
    `INSERT INTO trucker.sign_in_challenge (phone_e164, code_hash, request_key, created_at, expires_at)
       VALUES ('${signed.phone}', 'x', 'k', now(), now() + interval '5 minutes')`,
    `INSERT INTO trucker.terms_acceptance (person_id, terms_kind, version, language, accepted_at)
       VALUES ('${signed.personId}', 'demonstration', 'v', 'en', now())`,
    `INSERT INTO trucker.identity_event (occurred_at, kind) VALUES (now(), 'signed_in')`,
    `UPDATE trucker.session SET revoked_at = NULL, revoked_reason = NULL`,
    `UPDATE trucker.session SET last_used_at = now(), absolute_expires_at = now() + interval '1 year'`,
    `UPDATE trucker.sign_in_challenge SET failed_attempts = 0`,
    `UPDATE trucker.person SET display_name = 'changed'`,
    `UPDATE trucker.security_setting SET code_max_attempts = 10`,
    `UPDATE trucker.security_setting SET reviewed_for_production = true`,
    `INSERT INTO trucker.security_setting (singleton) VALUES (true)`,
    `INSERT INTO trucker.test_clock (singleton, fixed_at) VALUES (true, '2000-01-01')`,
    `UPDATE trucker.test_clock SET fixed_at = '2000-01-01'`,
    `UPDATE trucker.environment SET kind = 'test'`,
    `UPDATE trucker.environment SET kind = 'local-development'`,
    `ALTER TABLE trucker.session DISABLE ROW LEVEL SECURITY`,
    `CREATE POLICY open_all ON trucker.session FOR SELECT USING (true)`,
    `GRANT SELECT ON trucker.session TO trucker_app`,
  ];
  for (const statement of statements) {
    await refused(() => app.query(statement), /permission denied|must be owner/i);
  }
});

test('the privilege catalogue shows no right for the API role or PUBLIC on the closed tables', async () => {
  const rights = await owner.query<{ table_name: string; privilege_type: string }>(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
     WHERE table_schema = 'trucker' AND grantee IN ('trucker_app', 'PUBLIC')
     UNION ALL
     SELECT table_name, privilege_type || ' (column ' || column_name || ')'
     FROM information_schema.column_privileges
     WHERE table_schema = 'trucker' AND grantee IN ('trucker_app', 'PUBLIC')
     ORDER BY 1, 2`,
  );
  const byTable = new Map<string, string[]>();
  for (const row of rights.rows)
    byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.privilege_type]);
  // Exactly these tables are reachable at all, and none of them holds identity data.
  assert.deepEqual([...byTable.keys()].sort(), [
    'audit_entry',
    'country',
    'environment',
    'membership',
    'organisation',
    'retry_key',
  ]);
  // The time of a change is no longer the caller's to write.
  assert.ok(!byTable.get('organisation')!.includes('UPDATE (column updated_at)'));
  assert.ok(byTable.get('organisation')!.includes('UPDATE (column legal_name)'));
});

// ---------------------------------------------------------------------------------------------
// Restricted execution and safe search paths
// ---------------------------------------------------------------------------------------------
test('the API role may run exactly the named functions; nothing in the schema is open to PUBLIC', async () => {
  const functions = await owner.query<{
    signature: string;
    app: boolean;
    open: boolean;
  }>(
    `SELECT p.proname || '(' || coalesce((SELECT string_agg(coalesce(p.proargnames[i] || ' ', '') || format_type(p.proargtypes[i - 1], NULL), ', ' ORDER BY i) FROM generate_series(1, p.pronargs) i), '') || ')' AS signature,
            has_function_privilege('trucker_app', p.oid, 'EXECUTE') AS app,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS open
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'trucker' ORDER BY 1`,
  );
  assert.ok(functions.rows.length >= 28, 'the catalogue was read');
  assert.deepEqual(
    functions.rows.filter((row) => row.open).map((row) => row.signature),
    [],
  );
  assert.deepEqual(
    functions.rows.filter((row) => row.app).map((row) => row.signature),
    CALLABLE,
  );
});

test('the building blocks cannot be called directly by the API role', async () => {
  const signed = await signIn();
  for (const statement of [
    `SELECT trucker.random_code()`,
    `SELECT trucker.hmac_sha256('\\x00'::bytea, '\\x00'::bytea)`,
    `SELECT trucker.code_hash('${PEPPER}', '${signed.challengeId}', '000000')`,
    `SELECT * FROM trucker.live_session('${signed.tokenHash}')`,
    `SELECT * FROM trucker.account_of('${signed.sessionId}')`,
    `SELECT trucker.record_identity_event('signed_in', '${signed.personId}', '${signed.sessionId}', 'forged')`,
    `SELECT trucker.clock_now()`,
  ]) {
    await refused(() => app.query(statement), /permission denied for function/i);
  }
  // Nor replaced, dropped or re-granted.
  for (const statement of [
    `CREATE OR REPLACE FUNCTION trucker.clock_now() RETURNS timestamptz LANGUAGE sql AS $$ SELECT '2000-01-01'::timestamptz $$`,
    `CREATE OR REPLACE FUNCTION trucker.live_session(p_token_hash text) RETURNS TABLE (session_id uuid, person_id uuid) LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::uuid $$`,
    `DROP FUNCTION trucker.session_check(text, text)`,
    `ALTER FUNCTION trucker.session_check(text, text) SECURITY INVOKER`,
    `ALTER FUNCTION trucker.session_check(text, text) SET search_path = pg_temp`,
    `GRANT EXECUTE ON FUNCTION trucker.random_code() TO trucker_app`,
  ]) {
    await refused(() => app.query(statement), /permission denied|must be owner/i);
  }
});

test('every function names its search path, with temporary objects last', async () => {
  const functions = await owner.query<{ name: string; definer: boolean; config: string[] | null }>(
    `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'trucker' ORDER BY 1`,
  );
  assert.ok(functions.rows.some((row) => row.definer));
  for (const row of functions.rows) {
    const path = (row.config ?? []).find((entry) => entry.startsWith('search_path='));
    assert.ok(path, `${row.name} does not set a search path`);
    const parts = path
      .slice('search_path='.length)
      .split(',')
      .map((part) => part.trim());
    assert.equal(parts[0], 'pg_catalog', `${row.name}: ${path}`);
    assert.equal(parts[parts.length - 1], 'pg_temp', `${row.name}: ${path}`);
    for (const part of parts)
      assert.ok(['pg_catalog', 'trucker', 'pg_temp'].includes(part), `${row.name}: ${path}`);
  }
});

test('temporary tables named like the real ones change nothing', async () => {
  const signed = await signIn();
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    // What an attacker would try: stand-ins that the functions might pick up by name.
    await client.query(`CREATE TEMP TABLE session (id uuid, person_id uuid, token_hash text,
      created_at timestamptz, last_used_at timestamptz, absolute_expires_at timestamptz,
      revoked_at timestamptz, revoked_reason text) ON COMMIT DROP`);
    await client.query(
      `INSERT INTO session VALUES (gen_random_uuid(), gen_random_uuid(), $1, now(), now(), now() + interval '1 year', NULL, NULL)`,
      ['f'.repeat(64)],
    );
    await client.query(`CREATE TEMP TABLE security_setting AS
      SELECT true AS singleton, 900 AS code_ttl_seconds, 10 AS code_max_attempts,
             10 AS code_resend_wait_seconds, 30 AS code_max_per_hour,
             1440 AS session_idle_minutes, 720 AS session_absolute_hours,
             1000 AS organisation_creation_limit`);
    await client.query(`CREATE TEMP TABLE environment AS SELECT 'test'::text AS kind`);
    await client.query(
      `CREATE TEMP TABLE test_clock AS SELECT '2000-01-01'::timestamptz AS fixed_at`,
    );
    const invented = await client.query<{ status: string }>(
      'SELECT status FROM trucker.session_check($1, $2)',
      ['f'.repeat(64), null],
    );
    assert.equal(invented.rows[0]!.status, 'unknown');
    const real = await client.query<{ session_expires_at: Date; session_last_used_at: Date }>(
      'SELECT * FROM trucker.my_account($1)',
      [signed.tokenHash],
    );
    assert.equal(real.rows.length, 1);
    // Still the real idle period, counted on the real clock.
    assert.equal(
      real.rows[0]!.session_expires_at.getTime() - real.rows[0]!.session_last_used_at.getTime(),
      D.session_idle_minutes * 60_000,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

// ---------------------------------------------------------------------------------------------
// Codes: created by the database, from its cryptographic source, stored only as a keyed hash
// ---------------------------------------------------------------------------------------------
test('HMAC-SHA-256 in the database matches the published test vectors and Node', async () => {
  const hmac = async (keyBytes: Buffer, message: Buffer): Promise<string> =>
    (
      await owner.query<{ mac: string }>(
        `SELECT encode(trucker.hmac_sha256($1, $2), 'hex') AS mac`,
        [keyBytes, message],
      )
    ).rows[0]!.mac;
  // RFC 4231, test cases 1, 2 and 6.
  assert.equal(
    await hmac(Buffer.alloc(20, 0x0b), Buffer.from('Hi There')),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  );
  assert.equal(
    await hmac(Buffer.from('Jefe'), Buffer.from('what do ya want for nothing?')),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
  assert.equal(
    await hmac(
      Buffer.alloc(131, 0xaa),
      Buffer.from('Test Using Larger Than Block-Size Key - Hash Key First'),
    ),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  );
  for (const length of [0, 1, 32, 63, 64, 65, 200]) {
    const keyBytes = randomBytes(length || 1);
    const message = randomBytes(length);
    assert.equal(
      await hmac(keyBytes, message),
      createHmac('sha256', keyBytes).update(message).digest('hex'),
      `length ${length}`,
    );
  }
});

test('codes come from the cryptographic source, are six digits, and no digit is favoured', async () => {
  const source = await owner.query<{ body: string }>(
    `SELECT prosrc AS body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'trucker' AND p.proname = 'random_code'`,
  );
  const body = source.rows[0]!.body;
  assert.match(body, /gen_random_uuid\(\)/);
  // Not the ordinary generator, which is predictable, and no clock.
  assert.doesNotMatch(
    body.replace(/gen_random_uuid\(\)/g, ''),
    /random\s*\(|setseed|now\s*\(|clock/i,
  );

  const total = 30_000;
  const drawn = await owner.query<{ code: string }>(
    'SELECT trucker.random_code() AS code FROM generate_series(1, $1)',
    [total],
  );
  const counts = Array.from({ length: 6 }, () => new Array<number>(10).fill(0));
  const seen = new Set<string>();
  for (const { code } of drawn.rows) {
    assert.match(code, /^[0-9]{6}$/);
    seen.add(code);
    for (let position = 0; position < 6; position += 1)
      counts[position]![Number(code[position])]! += 1;
  }
  // Each digit should appear a tenth of the time in each position. Six standard deviations:
  // a correct generator fails this about once in a hundred million runs.
  const expected = total / 10;
  const tolerance = 6 * Math.sqrt(total * 0.1 * 0.9);
  for (const [position, digits] of counts.entries())
    for (const [digit, seenCount] of digits.entries())
      assert.ok(
        Math.abs(seenCount - expected) < tolerance,
        `digit ${digit} in position ${position}: ${seenCount}`,
      );
  // 30,000 draws from a million values repeat a few hundred times, not thousands.
  assert.ok(seen.size > total - 1_500, `only ${seen.size} different codes`);
  assert.ok(
    drawn.rows.some(({ code }) => code.startsWith('0')),
    'leading zeros are kept',
  );
});

test('the stored hash is keyed with the value the API holds and bound to the challenge', async () => {
  const phone = newPhone();
  const asked = await requestCode(phone);
  const code = asked.development_code!;
  const stored = await owner.query<{ code_hash: string }>(
    'SELECT code_hash FROM trucker.sign_in_challenge WHERE id = $1',
    [asked.challenge_id],
  );
  const hash = stored.rows[0]!.code_hash;
  assert.equal(
    hash,
    createHmac('sha256', Buffer.from(PEPPER, 'hex'))
      .update(`code:${asked.challenge_id}:${code}`)
      .digest('hex'),
  );
  // Someone holding the whole table but not the key cannot find the code by trying all
  // million values: no unkeyed hash of the code, alone or with what the row holds, matches.
  const candidates = [
    code,
    `${asked.challenge_id}${code}`,
    `${asked.challenge_id}:${code}`,
    `code:${asked.challenge_id}:${code}`,
    `${code}${asked.challenge_id}`,
    `${phone}${code}`,
  ];
  for (const candidate of candidates)
    assert.notEqual(hash, createHash('sha256').update(candidate).digest('hex'), candidate);
  // The key is not in the database: not in this row, not anywhere a text column can hold it.
  assert.ok(!JSON.stringify(stored.rows).includes(PEPPER));
  const settings = await owner.query('SELECT * FROM trucker.security_setting');
  assert.ok(!JSON.stringify(settings.rows).includes(PEPPER));
  // A different key does not open the same code.
  const other = await verifyCode(asked.challenge_id!, code, { pepper: codePepper('x'.repeat(40)) });
  assert.equal(other.status, 'incorrect');
});

test('a caller cannot choose the code, and gets it back only by asking', async () => {
  const signature = await owner.query<{ args: string }>(
    `SELECT array_to_string(p.proargnames[1:p.pronargs], ', ') AS args
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'trucker' AND p.proname = 'sign_in_request_code'`,
  );
  assert.equal(signature.rowCount, 1);
  assert.doesNotMatch(signature.rows[0]!.args, /code|hash/i);
  const silent = await requestCode(newPhone(), { reveal: false });
  assert.equal(silent.status, 'created');
  assert.equal(silent.development_code, null);
  const shown = await requestCode(newPhone(), { reveal: true });
  assert.match(shown.development_code!, /^[0-9]{6}$/);
  // Asking again with the same key returns the same challenge, never the code a second time.
  const phone = newPhone();
  const requestKey = key();
  const first = await requestCode(phone, { requestKey });
  const again = await requestCode(phone, { requestKey });
  assert.equal(again.status, 'repeated');
  assert.equal(again.challenge_id, first.challenge_id);
  assert.equal(again.development_code, null);
  // Malformed input is refused outright.
  for (const [badPhone, badKey, badPepper] of [
    ['0501234567', key(), PEPPER],
    [newPhone(), '', PEPPER],
    [newPhone(), key(), 'short'],
    [newPhone(), key(), null],
  ]) {
    await refused(
      () =>
        app.query('SELECT * FROM trucker.sign_in_request_code($1, $2, $3, true)', [
          badPhone,
          badKey,
          badPepper,
        ]),
      /invalid argument/,
    );
  }
});

test('no function hands back a code hash or a token hash', async () => {
  const signed = await signIn();
  const hashes = await owner.query<{ hash: string }>(
    `SELECT code_hash AS hash FROM trucker.sign_in_challenge
     UNION ALL SELECT token_hash FROM trucker.session`,
  );
  const asked = await requestCode(newPhone());
  const answers = [
    asked,
    await verifyCode(asked.challenge_id!, wrongCode(asked.development_code!)),
    (await app.query('SELECT * FROM trucker.session_check($1, $2)', [signed.tokenHash, null])).rows,
    await account(signed.tokenHash),
    (await app.query('SELECT * FROM trucker.my_sessions($1)', [signed.tokenHash])).rows,
  ];
  const text = JSON.stringify(answers);
  assert.ok(hashes.rows.length >= 4);
  for (const { hash } of hashes.rows) assert.ok(!text.includes(hash), 'a stored hash was returned');
});

// ---------------------------------------------------------------------------------------------
// Where codes exist at all: only in a database marked local-development or test
// ---------------------------------------------------------------------------------------------
test('an unmarked or production database creates no code and records no terms, whatever is asked', async () => {
  for (const mark of ['unmarked', 'production'] as const) {
    const scratch = await scratchDatabase(mark);
    const phone = newPhone();
    const asked = await requestCode(phone, { pool: scratch.app, reveal: true });
    assert.deepEqual(
      asked,
      {
        status: 'closed',
        challenge_id: null,
        created_at: null,
        expires_at: null,
        resend_available_at: null,
        retry_after_seconds: null,
        development_code: null,
      },
      mark,
    );
    const challenges = await scratch.pool.query('SELECT 1 FROM trucker.sign_in_challenge');
    assert.equal(challenges.rowCount, 0, mark);
    // The mark cannot be changed by the API's role to open it.
    await refused(
      () => scratch.app.query(`UPDATE trucker.environment SET kind = 'local-development'`),
      /permission denied/,
    );
    // Even with a session (put there by the migration role), demonstration terms are not
    // recorded: such a row must never exist where it could be taken for real acceptance.
    const tokenHash = randomHash();
    const person = await scratch.pool.query<{ id: string }>(
      `INSERT INTO trucker.person (phone_e164) VALUES ($1) RETURNING id`,
      [phone],
    );
    await scratch.pool.query(
      `INSERT INTO trucker.session (person_id, token_hash, created_at, last_used_at, absolute_expires_at)
       VALUES ($1, $2, now(), now(), now() + interval '12 hours')`,
      [person.rows[0]!.id, tokenHash],
    );
    const registered = await scratch.app.query<{ status: string }>(
      `SELECT trucker.complete_registration($1, 'Test Person (fictional)', NULL, 'v', 'en', NULL) AS status`,
      [tokenHash],
    );
    assert.equal(registered.rows[0]!.status, 'closed', mark);
    const terms = await scratch.pool.query('SELECT 1 FROM trucker.terms_acceptance');
    assert.equal(terms.rowCount, 0, mark);
  }
});

test('a database marked local-development creates codes, on the real clock', async () => {
  const scratch = await scratchDatabase('local-development');
  const before = Date.now();
  const asked = await requestCode(newPhone(), { pool: scratch.app });
  assert.equal(asked.status, 'created');
  assert.match(asked.development_code!, /^[0-9]{6}$/);
  assert.ok(Math.abs(asked.created_at!.getTime() - before) < 60_000);
  assert.equal(
    asked.expires_at!.getTime() - asked.created_at!.getTime(),
    D.code_ttl_seconds * 1000,
  );
});

// ---------------------------------------------------------------------------------------------
// The clock (IH-5): fixed only in a database marked test, and never by the API's role
// ---------------------------------------------------------------------------------------------
test('the clock can be fixed only where the mark is test, and is ignored anywhere else', async () => {
  const past = new Date('2001-02-03T04:05:06.000Z');
  for (const mark of ['unmarked', 'local-development', 'production'] as const) {
    const scratch = await scratchDatabase(mark);
    await refused(
      () =>
        scratch.pool.query(
          `INSERT INTO trucker.test_clock (singleton, fixed_at) VALUES (true, $1)`,
          [past],
        ),
      /only in a database marked test/,
    );
  }
  // A clock fixed while the mark was "test" stops counting the moment the mark changes.
  const scratch = await scratchDatabase('test');
  await scratch.pool.query(
    `INSERT INTO trucker.test_clock (singleton, fixed_at) VALUES (true, $1)`,
    [past],
  );
  const fixed = await requestCode(newPhone(), { pool: scratch.app });
  assert.equal(fixed.created_at!.toISOString(), past.toISOString());
  await scratch.pool.query(`UPDATE trucker.environment SET kind = 'local-development'`);
  const real = await requestCode(newPhone(), { pool: scratch.app });
  assert.ok(Math.abs(real.created_at!.getTime() - Date.now()) < 60_000, 'the real clock again');
  await refused(
    () => scratch.pool.query(`UPDATE trucker.test_clock SET fixed_at = now()`),
    /only in a database marked test/,
  );
});

test('the API role cannot move time: settings it invents are not read, and no function takes a time', async () => {
  const signed = await signIn();
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    for (const name of ['trucker.now', 'trucker.clock', 'trucker.fixed_at', 'trucker.test_clock'])
      await client.query(`SELECT set_config($1, '2000-01-01T00:00:00Z', true)`, [name]);
    const row = await client.query<{ session_last_used_at: Date }>(
      'SELECT * FROM trucker.my_account($1)',
      [signed.tokenHash],
    );
    assert.equal(row.rows.length, 1);
    assert.ok(row.rows[0]!.session_last_used_at.getFullYear() > 2000);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  const inputs = await owner.query<{ signature: string; types: string[] }>(
    `SELECT p.proname || '(' || coalesce((SELECT string_agg(coalesce(p.proargnames[i] || ' ', '') || format_type(p.proargtypes[i - 1], NULL), ', ' ORDER BY i) FROM generate_series(1, p.pronargs) i), '') || ')' AS signature,
            ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes::oid[]) t) AS types
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'trucker' AND has_function_privilege('trucker_app', p.oid, 'EXECUTE')`,
  );
  assert.equal(inputs.rowCount, CALLABLE.length);
  // Nothing the API's role can call takes a time, a period or a number: there is no
  // parameter through which a limit or the clock could be supplied.
  for (const row of inputs.rows) {
    for (const type of row.types)
      assert.ok(['text', 'uuid', 'boolean'].includes(type), `${row.signature} takes ${type}`);
    assert.doesNotMatch(row.signature, /limit|max|ttl|attempt|idle|hour|minute|second|now|time/i);
  }
});

// ---------------------------------------------------------------------------------------------
// Limits (IH-6): read from the protected row; nothing a caller sends can loosen them
// ---------------------------------------------------------------------------------------------
test('the limits apply to direct calls, and settings the caller invents do not loosen them', async () => {
  // Attempts: the code locks after the configured number, with look-alike settings in place.
  const asked = await requestCode(newPhone());
  const wrong = wrongCode(asked.development_code!);
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    for (const [name, value] of [
      ['trucker.code_max_attempts', '10'],
      ['trucker.security_setting.code_max_attempts', '10'],
      ['trucker.code_ttl_seconds', '900'],
      ['trucker.session_idle_minutes', '1440'],
    ])
      await client.query(`SELECT set_config($1, $2, true)`, [name, value]);
    const statuses: string[] = [];
    for (let attempt = 0; attempt < D.code_max_attempts + 1; attempt += 1) {
      const result = await client.query<VerifyRow>(
        'SELECT * FROM trucker.sign_in_verify_code($1, $2, $3, $4, $5, $6, $7)',
        [asked.challenge_id, wrong, key(), PEPPER, randomUUID(), randomHash(), null],
      );
      statuses.push(result.rows[0]!.status);
    }
    await client.query('COMMIT');
    assert.deepEqual(statuses, [
      ...new Array<string>(D.code_max_attempts - 1).fill('incorrect'),
      'locked',
      'locked',
    ]);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  // Locked means locked: the right code no longer works.
  assert.equal((await verifyCode(asked.challenge_id!, asked.development_code!)).status, 'locked');

  // Resend wait and codes per hour.
  const phone = newPhone();
  assert.equal((await requestCode(phone)).status, 'created');
  const soon = await requestCode(phone);
  assert.equal(soon.status, 'too_soon');
  assert.equal(soon.retry_after_seconds, D.code_resend_wait_seconds);
  for (let extra = 1; extra < D.code_max_per_hour; extra += 1) {
    await advance(D.code_resend_wait_seconds);
    assert.equal((await requestCode(phone)).status, 'created');
  }
  await advance(D.code_resend_wait_seconds);
  const many = await requestCode(phone);
  assert.equal(many.status, 'too_many');
  assert.equal(await count('sign_in_challenge', 'phone_e164 = $1', [phone]), D.code_max_per_hour);

  // Lifetime: exact to the second, on the database's clock.
  const timed = await requestCode(newPhone());
  await advance(D.code_ttl_seconds - 1);
  assert.equal(
    (await verifyCode(timed.challenge_id!, wrongCode(timed.development_code!))).status,
    'incorrect',
  );
  await advance(1);
  assert.equal((await verifyCode(timed.challenge_id!, timed.development_code!)).status, 'expired');
});

test('the functions that used to take a limit or a time no longer exist in that form', async () => {
  const signed = await signIn();
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('trucker.session_token_hash', $1, true)`, [
      signed.tokenHash,
    ]);
    await refused(
      () =>
        client.query(
          `SELECT trucker.create_organisation('Forged', NULL, 'XA', 'X-1', NULL, NULL, now(), 1000, true)`,
        ),
      /does not exist/,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test('the migration role changes a limit and it applies at once; the table keeps each within bounds', async () => {
  assert.deepEqual(await readSecuritySettings(owner), { ...D, reviewed_for_production: false });
  try {
    await writeSecuritySettings(owner, { code_max_attempts: 2 }, false);
    const asked = await requestCode(newPhone());
    const wrong = wrongCode(asked.development_code!);
    assert.equal((await verifyCode(asked.challenge_id!, wrong)).attempts_remaining, 1);
    assert.equal((await verifyCode(asked.challenge_id!, wrong)).status, 'locked');
  } finally {
    await writeSecuritySettings(owner, { ...D }, false);
  }
  for (const [name, value] of [
    ['code_ttl_seconds', 29],
    ['code_ttl_seconds', 901],
    ['code_max_attempts', 0],
    ['code_max_attempts', 11],
    ['code_resend_wait_seconds', 9],
    ['code_max_per_hour', 31],
    ['session_idle_minutes', 1441],
    ['session_absolute_hours', 721],
    ['organisation_creation_limit', 1001],
  ] as const) {
    await refused(
      () => writeSecuritySettings(owner, { [name]: value }, false),
      /violates check constraint/,
    );
  }
  await refused(() => owner.query('DELETE FROM trucker.security_setting'), /cannot be removed/);
  assert.deepEqual(await readSecuritySettings(owner), { ...D, reviewed_for_production: false });
});

test('a review for production is recorded with the values, and any later change withdraws it', async () => {
  const scratch = await scratchDatabase('unmarked');
  const reviewed = async (): Promise<boolean> =>
    (
      await scratch.app.query<{ reviewed: boolean }>(
        'SELECT trucker.security_settings_reviewed() AS reviewed',
      )
    ).rows[0]!.reviewed;
  assert.equal(await reviewed(), false);
  await writeSecuritySettings(scratch.pool, { session_idle_minutes: 20 }, true);
  assert.equal(await reviewed(), true);
  assert.equal((await inspectAccess(scratch.app)).settingsReviewed, true);
  await writeSecuritySettings(scratch.pool, { session_idle_minutes: 25 }, false);
  assert.equal(await reviewed(), false);
  // The API's role can use neither helper.
  await refused(() => readSecuritySettings(scratch.app), /permission denied/);
  await refused(
    () => writeSecuritySettings(scratch.app, { code_max_attempts: 10 }, true),
    /permission denied/,
  );
  // Only known names and whole numbers are accepted from the command line.
  assert.deepEqual(parseSettingChanges(['code_max_attempts=3', 'session_idle_minutes=15']), {
    code_max_attempts: 3,
    session_idle_minutes: 15,
  });
  for (const bad of [
    'code_max_attempts',
    'code_max_attempts=many',
    'code_max_attempts=-1',
    'reviewed_for_production=1',
    'singleton=1',
    'code_max_attempts=3; DROP TABLE trucker.session',
  ])
    assert.throws(() => parseSettingChanges([bad]), /not a setting/, bad);
});

// ---------------------------------------------------------------------------------------------
// Forging a session (IH-3)
// ---------------------------------------------------------------------------------------------
test('a session exists only after a correct code: a wrong one creates nothing, whatever is supplied', async () => {
  const phone = newPhone();
  const asked = await requestCode(phone);
  const sessionId = randomUUID();
  const tokenHash = randomHash();
  const attempt = await verifyCode(asked.challenge_id!, wrongCode(asked.development_code!), {
    sessionId,
    tokenHash,
  });
  assert.equal(attempt.status, 'incorrect');
  assert.equal(attempt.session_id, null);
  assert.equal(await sessionRow(sessionId), undefined);
  assert.equal(await check(tokenHash), 'unknown');
  assert.deepEqual(await account(tokenHash), []);
  assert.equal(await requestPerson(tokenHash), null);
  assert.equal(await count('person', 'phone_e164 = $1', [phone]), 0);

  // An unknown challenge, a malformed code, a missing code.
  for (const [challenge, code] of [
    [randomUUID(), asked.development_code],
    [asked.challenge_id, '12345'],
    [asked.challenge_id, `${asked.development_code}0`],
    [asked.challenge_id, `' OR '1'='1`],
    [asked.challenge_id, null],
  ]) {
    const forged = randomHash();
    const result = await app.query<VerifyRow>(
      'SELECT * FROM trucker.sign_in_verify_code($1, $2, $3, $4, $5, $6, $7)',
      [challenge, code, key(), PEPPER, randomUUID(), forged, null],
    );
    assert.ok(['incorrect', 'locked'].includes(result.rows[0]!.status), String(code));
    assert.equal(await check(forged), 'unknown');
  }
  // Malformed session details are refused before anything is looked at.
  for (const [badSession, badHash] of [
    [null, tokenHash],
    [randomUUID(), 'not-a-hash'],
    [randomUUID(), null],
  ]) {
    await refused(
      () =>
        app.query('SELECT * FROM trucker.sign_in_verify_code($1, $2, $3, $4, $5, $6, $7)', [
          asked.challenge_id,
          asked.development_code,
          key(),
          PEPPER,
          badSession,
          badHash,
          null,
        ]),
      /invalid argument/,
    );
  }
});

test('a correct code signs in as the number it was sent to and nobody else', async () => {
  const victim = await signIn();
  const mine = newPhone();
  const asked = await requestCode(mine);
  // There is no parameter naming a person or a number: only the challenge decides.
  const sessionId = randomUUID();
  const tokenHash = randomHash();
  const signed = await verifyCode(asked.challenge_id!, asked.development_code!, {
    sessionId,
    tokenHash,
  });
  assert.equal(signed.status, 'signed_in');
  const rows = await account(tokenHash);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.phone_e164, mine);
  assert.notEqual(rows[0]!.person_id, victim.personId);
  assert.equal(await requestPerson(tokenHash), rows[0]!.person_id);

  // Taking over an existing session's identifier or token hash with one's own correct code
  // fails as a whole and leaves the victim's session as it was.
  for (const [takeId, takeHash] of [
    [victim.sessionId, randomHash()],
    [randomUUID(), victim.tokenHash],
  ] as const) {
    const again = await requestCode(newPhone());
    await refused(
      () =>
        verifyCode(again.challenge_id!, again.development_code!, {
          sessionId: takeId,
          tokenHash: takeHash,
        }),
      /duplicate key/,
    );
  }
  const untouched = await account(victim.tokenHash);
  assert.equal(untouched.length, 1);
  assert.equal(untouched[0]!.person_id, victim.personId);
  assert.equal(untouched[0]!.phone_e164, victim.phone);
});

test('guessed, invented and malformed token hashes are nobody', async () => {
  const signed = await signIn();
  const guesses = [
    randomHash(),
    signed.sessionId,
    signed.personId,
    signed.tokenHash.toUpperCase(),
    `${signed.tokenHash} `,
    signed.tokenHash.slice(0, 63),
    `${signed.tokenHash}0`,
    '%',
    '',
    `' OR '1'='1`,
  ];
  for (const guess of guesses) {
    assert.equal(await check(guess), 'unknown', guess);
    assert.deepEqual(await account(guess), [], guess);
    assert.equal(await requestPerson(guess), null, guess);
  }
  const absent = await app.query<{ status: string }>(
    'SELECT status FROM trucker.session_check(NULL, NULL)',
  );
  assert.equal(absent.rows[0]!.status, 'unknown');
  // Naming a person directly, the way a forged request would, selects nobody.
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('trucker.person_id', $1, true), set_config('trucker.session_id', $2, true)`,
      [signed.personId, signed.sessionId],
    );
    const who = await client.query<{ person: string | null }>(
      'SELECT trucker.request_person() AS person',
    );
    assert.equal(who.rows[0]!.person, null);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

// ---------------------------------------------------------------------------------------------
// Another person's data (IH-7)
// ---------------------------------------------------------------------------------------------
test('the account functions reach only the caller: another person is neither read nor changed', async () => {
  const a = await signIn();
  const b = await signIn();
  const second = await signIn(b.phone); // a second session of B

  const mine = await account(a.tokenHash);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.person_id, a.personId);
  assert.ok(!JSON.stringify(mine).includes(b.phone));

  const sessions = await app.query<{ id: string; current: boolean }>(
    'SELECT * FROM trucker.my_sessions($1)',
    [a.tokenHash],
  );
  assert.deepEqual(
    sessions.rows.map((row) => [row.id, row.current]),
    [[a.sessionId, true]],
  );

  // Ending B's sessions as A: exactly the answer for a session that does not exist.
  const missing = await app.query<{ status: string }>(
    'SELECT trucker.revoke_my_session($1, $2, NULL) AS status',
    [a.tokenHash, randomUUID()],
  );
  for (const target of [b.sessionId, second.sessionId]) {
    const result = await app.query<{ status: string }>(
      'SELECT trucker.revoke_my_session($1, $2, NULL) AS status',
      [a.tokenHash, target],
    );
    assert.deepEqual(result.rows, missing.rows);
    assert.equal(result.rows[0]!.status, 'not_found');
  }
  const others = await app.query<{ ended: number }>(
    'SELECT trucker.revoke_my_other_sessions($1, NULL) AS ended',
    [a.tokenHash],
  );
  assert.equal(others.rows[0]!.ended, 0);
  assert.equal(await check(b.tokenHash), 'ok');
  assert.equal(await check(second.tokenHash), 'ok');

  // Registration as A changes A only.
  const done = await app.query<{ status: string }>(
    `SELECT trucker.complete_registration($1, 'Person A (fictional)', NULL, 'demonstration-test', 'en', NULL) AS status`,
    [a.tokenHash],
  );
  assert.equal(done.rows[0]!.status, 'completed');
  const people = await owner.query<{ id: string; display_name: string | null }>(
    'SELECT id, display_name FROM trucker.person WHERE id = ANY($1)',
    [[a.personId, b.personId]],
  );
  const names = new Map(people.rows.map((row) => [row.id, row.display_name]));
  assert.equal(names.get(a.personId), 'Person A (fictional)');
  assert.equal(names.get(b.personId), null);
  assert.equal(await count('terms_acceptance', 'person_id = $1', [b.personId]), 0);
  // Repeating changes nothing.
  const repeated = await app.query<{ status: string }>(
    `SELECT trucker.complete_registration($1, 'Changed', NULL, 'demonstration-test', 'ar', NULL) AS status`,
    [a.tokenHash],
  );
  assert.equal(repeated.rows[0]!.status, 'already');
  assert.equal((await account(a.tokenHash))[0]!.display_name, 'Person A (fictional)');

  // B ending B's other session works, and is recorded for B.
  const own = await app.query<{ ended: number }>(
    'SELECT trucker.revoke_my_other_sessions($1, $2) AS ended',
    [second.tokenHash, 'hardening-own'],
  );
  assert.equal(own.rows[0]!.ended, 1);
  assert.equal(await check(b.tokenHash), 'unknown');
  assert.equal(
    await count(
      'identity_event',
      `kind = 'session_revoked' AND person_id = $1 AND request_id = $2`,
      [b.personId, 'hardening-own'],
    ),
    1,
  );
});

// ---------------------------------------------------------------------------------------------
// Ended sessions, retried every way (IH-8)
// ---------------------------------------------------------------------------------------------
async function assertDead(signed: Signed, label: string): Promise<void> {
  assert.deepEqual(await account(signed.tokenHash), [], `${label}: my_account`);
  assert.equal(await requestPerson(signed.tokenHash), null, `${label}: request_person`);
  const sessions = await app.query('SELECT * FROM trucker.my_sessions($1)', [signed.tokenHash]);
  assert.equal(sessions.rowCount, 0, `${label}: my_sessions`);
  const registration = await app.query<{ status: string }>(
    `SELECT trucker.complete_registration($1, 'Late', NULL, 'v', 'en', NULL) AS status`,
    [signed.tokenHash],
  );
  assert.equal(registration.rows[0]!.status, 'unauthorized', `${label}: registration`);
  const revoke = await app.query<{ status: string }>(
    'SELECT trucker.revoke_my_session($1, $2, NULL) AS status',
    [signed.tokenHash, signed.sessionId],
  );
  assert.equal(revoke.rows[0]!.status, 'unauthorized', `${label}: revoke`);
  const others = await app.query<{ ended: number | null }>(
    'SELECT trucker.revoke_my_other_sessions($1, NULL) AS ended',
    [signed.tokenHash],
  );
  assert.equal(others.rows[0]!.ended, null, `${label}: revoke others`);
  // Organisation data: the creating function refuses, as for no session at all.
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('trucker.session_token_hash', $1, true)`, [
      signed.tokenHash,
    ]);
    await refused(
      () =>
        client.query(`SELECT trucker.create_organisation('x', NULL, 'XA', 'x', NULL, NULL, true)`),
      /no signed-in person/,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  const person = await owner.query<{ display_name: string | null }>(
    'SELECT display_name FROM trucker.person WHERE id = $1',
    [signed.personId],
  );
  assert.notEqual(person.rows[0]!.display_name, 'Late', `${label}: nothing was written`);
}

test('a revoked session is refused by every function, and repeating its sign-in does not bring it back', async () => {
  // Sign in without stepping the clock, so the repeat below is inside its two-minute window.
  const phone = newPhone();
  const asked = await requestCode(phone);
  const sessionId = randomUUID();
  const tokenHash = hashToken(sessionToken(SECRET, sessionId));
  const verifyKey = key();
  const first = await verifyCode(asked.challenge_id!, asked.development_code!, {
    sessionId,
    tokenHash,
    requestKey: verifyKey,
  });
  assert.equal(first.status, 'signed_in');
  // The same request again, while the session lives: the same session, no second one.
  const repeat = await verifyCode(asked.challenge_id!, asked.development_code!, {
    requestKey: verifyKey,
  });
  assert.deepEqual([repeat.status, repeat.session_id], ['repeated', sessionId]);
  // A different key, or a wrong code, is plain reuse.
  assert.equal((await verifyCode(asked.challenge_id!, asked.development_code!)).status, 'used');
  assert.equal(
    (
      await verifyCode(asked.challenge_id!, wrongCode(asked.development_code!), {
        requestKey: verifyKey,
      })
    ).status,
    'used',
  );

  const revoked = await app.query<{ status: string }>(
    'SELECT trucker.revoke_my_session($1, $2, $3) AS status',
    [tokenHash, sessionId, 'hardening-revoke'],
  );
  assert.equal(revoked.rows[0]!.status, 'revoked');
  const row = await sessionRow(sessionId);
  assert.equal(row!.revoked_reason, 'signed_out');

  assert.equal(await check(tokenHash), 'unknown');
  const person = (
    await owner.query<{ person_id: string }>(
      'SELECT person_id FROM trucker.session WHERE id = $1',
      [sessionId],
    )
  ).rows[0]!.person_id;
  const signed: Signed = {
    phone,
    sessionId,
    tokenHash,
    personId: person,
    challengeId: asked.challenge_id!,
    code: asked.development_code!,
    verifyKey,
  };
  await assertDead(signed, 'revoked');
  // The retry that returned the session a moment ago no longer does, and offering a fresh
  // session identifier and token with the spent code creates nothing.
  const fresh = randomHash();
  const afterwards = await verifyCode(asked.challenge_id!, asked.development_code!, {
    requestKey: verifyKey,
    tokenHash: fresh,
  });
  assert.deepEqual([afterwards.status, afterwards.session_id], ['used', null]);
  assert.equal(await check(fresh), 'unknown');
  assert.equal(await count('session', 'person_id = $1', [person]), 1);
  // Checking it again changes nothing and records nothing new.
  assert.equal(await check(tokenHash), 'unknown');
  assert.equal(await count('identity_event', 'session_id = $1', [sessionId]), 2);
});

test('an idle session is dead to every function even before anything has marked it ended', async () => {
  const signed = await signIn();
  const idle = D.session_idle_minutes * 60;
  // signIn stepped the clock past the resend wait; go to one second short of the idle period.
  await advance(idle - (D.code_resend_wait_seconds + 1) - 1);
  assert.equal((await account(signed.tokenHash)).length, 1, 'one second before');
  assert.equal(await requestPerson(signed.tokenHash), signed.personId);
  await advance(1);
  // Nothing has called the session check: the row still says it is open.
  assert.equal((await sessionRow(signed.sessionId))!.revoked_at, null);
  await assertDead(signed, 'idle');
  // The check then ends it, says why, and records it once.
  assert.equal(await check(signed.tokenHash), 'expired');
  assert.equal((await sessionRow(signed.sessionId))!.revoked_reason, 'idle_expired');
  assert.equal(await check(signed.tokenHash), 'unknown');
  assert.equal(
    await count('identity_event', `kind = 'session_expired' AND session_id = $1`, [
      signed.sessionId,
    ]),
    1,
  );
});

test('a session used all the time still dies at its absolute limit, in every function', async () => {
  const signed = await signIn();
  const step = (D.session_idle_minutes - 1) * 60;
  const limit = D.session_absolute_hours * 3600;
  let elapsed = D.code_resend_wait_seconds + 1;
  assert.equal(await check(signed.tokenHash), 'ok');
  while (elapsed + step < limit) {
    await advance(step);
    elapsed += step;
    assert.equal(await check(signed.tokenHash), 'ok', `at ${elapsed}s`);
  }
  await advance(limit - elapsed - 1);
  assert.equal((await account(signed.tokenHash)).length, 1, 'one second before the limit');
  await advance(1);
  await assertDead(signed, 'absolute');
  assert.equal(await check(signed.tokenHash), 'expired');
  assert.equal((await sessionRow(signed.sessionId))!.revoked_reason, 'absolute_expired');
});

test('shortening the absolute limit ends older sessions at once; lengthening it revives nothing', async () => {
  const signed = await signIn();
  // Two hours of regular use, so that it is never idle below.
  for (let minutes = 0; minutes < 120; minutes += 20) {
    assert.equal(await check(signed.tokenHash), 'ok');
    await advance(20 * 60);
  }
  assert.equal(await check(signed.tokenHash), 'ok');
  try {
    await writeSecuritySettings(owner, { session_absolute_hours: 1 }, false);
    await assertDead(signed, 'limit shortened');
    // Lengthening the limit again does not stretch a session past what it was created with.
    await writeSecuritySettings(owner, { session_absolute_hours: 720 }, false);
    assert.equal((await account(signed.tokenHash)).length, 1, 'inside its own 12 hours');
    for (let minutes = 0; minutes < 10 * 60; minutes += 20) {
      await advance(20 * 60);
      const status = await check(signed.tokenHash);
      if (status !== 'ok') break;
    }
    // Twelve hours after it was created it is over, however long the limit now is.
    assert.equal((await sessionRow(signed.sessionId))!.revoked_reason, 'absolute_expired');
    await assertDead(signed, 'past the limit it was created with');
  } finally {
    await writeSecuritySettings(owner, { ...D }, false);
  }
});

// ---------------------------------------------------------------------------------------------
// The API side (IH-10)
// ---------------------------------------------------------------------------------------------
test('the session check is one statement, and it sends the hash of the token, never the token', async () => {
  const statements: { text: string; values: unknown[] }[] = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      statements.push({ text, values });
      return { rows: [{ status: 'ok', person_id: randomUUID(), session_id: randomUUID() }] };
    },
  } as unknown as pg.Pool;
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    IDENTITY_SECRET: SECRET,
  });
  const service = new IdentityService(pool, config);
  const token = sessionToken(SECRET, randomUUID());
  const auth = await service.authenticate(token, 'request-1');
  assert.equal(statements.length, 1);
  assert.equal(statements[0]!.text, 'SELECT * FROM trucker.session_check($1, $2)');
  assert.deepEqual(statements[0]!.values, [hashToken(token), 'request-1']);
  assert.equal(auth.tokenHash, hashToken(token));
  // No token, or one too long to be ours, never reaches the database.
  await assert.rejects(() => service.authenticate(undefined));
  await assert.rejects(() => service.authenticate('x'.repeat(201)));
  assert.equal(statements.length, 1);
});
