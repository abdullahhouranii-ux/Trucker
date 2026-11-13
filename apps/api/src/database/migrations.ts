import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Forward-only SQL migrations for transactional SQL only.
 *
 * Files are named NNNN_description.sql, numbered from 0001 without gaps. The runner wraps each
 * file in its own transaction and records it with a checksum, so an applied file that is later
 * edited is detected. One runner at a time holds an advisory lock; waiting for it is bounded.
 *
 * Not supported, and refused when the files are read:
 *  - transaction control inside a file (BEGIN, COMMIT, ROLLBACK, SAVEPOINT and similar): the
 *    runner owns the transaction;
 *  - statements PostgreSQL will not run inside a transaction (CREATE/DROP INDEX CONCURRENTLY,
 *    REINDEX CONCURRENTLY, VACUUM, CREATE/DROP DATABASE, CREATE/DROP TABLESPACE, ALTER SYSTEM);
 *  - SQL-standard function bodies written with BEGIN ATOMIC (use a dollar-quoted body).
 * Work of those kinds needs a separately reviewed procedure outside this runner.
 *
 * Two barriers stop a file from ending the runner's transaction: the statement check above,
 * which refuses the file before anything runs, and a check after the file has run that the
 * session is still inside the very transaction the runner opened. Transaction control hidden
 * inside a DO block or a called procedure is rejected by PostgreSQL itself, because the runner
 * has an open transaction.
 */

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const ADVISORY_LOCK_KEY = '7426018350912';
const LOCK_POLL_MS = 200;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationStatus {
  readonly applied: readonly number[];
  readonly pending: readonly number[];
  readonly problems: readonly string[];
}

export interface MigrateOptions {
  /** How long to wait for another runner to finish. Default 30 s. */
  readonly lockWaitMs?: number;
  /** How long any migration statement may wait for a table lock. Default 10 s. */
  readonly statementLockTimeoutMs?: number;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export function defaultMigrationsDir(): string {
  // dist/database/migrations.js -> repository root /db/migrations
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations');
}

/**
 * The text that is hashed and executed: no byte-order mark, LF line endings only. A file
 * checked out with CRLF on one machine and LF on another therefore has one checksum.
 */
export function normaliseSql(raw: string): string {
  const withoutMark = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutMark.replace(/\r\n?/g, '\n');
}

export function checksumOf(raw: string): string {
  return createHash('sha256').update(normaliseSql(raw), 'utf8').digest('hex');
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Splits SQL into top-level statements, with comments, string literals, dollar-quoted bodies
 * and quoted identifiers blanked out. It reads the text once, left to right, the way
 * PostgreSQL's own lexer decides what is code: whichever construct starts first wins, so a
 * comment marker inside a string is text and a quote inside a comment is comment.
 *
 * Handled: line comments, nested block comments, standard strings (doubled quote), escape strings
 * (E prefix, backslash escapes), dollar quoting with or without a tag, quoted identifiers.
 * Anything left unterminated is an error: the file is refused.
 */
export function splitSqlStatements(sql: string): string[] {
  const text = normaliseSql(sql);
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const unterminated = (what: string): never => {
    throw new MigrationError(`unterminated ${what} in migration SQL`);
  };

  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];

    if (ch === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      current += ' ';
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= text.length) unterminated('block comment');
        if (text[i] === '/' && text[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      current += ' ';
    } else if (ch === "'") {
      const previous = text[i - 1];
      const beforePrevious = text[i - 2];
      const escapeString =
        (previous === 'e' || previous === 'E') &&
        (beforePrevious === undefined || !IDENTIFIER_CHAR.test(beforePrevious));
      i += 1;
      for (;;) {
        if (i >= text.length) unterminated('string literal');
        if (escapeString && text[i] === '\\') {
          i += 2;
        } else if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
        } else if (text[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      current += ' ';
    } else if (ch === '"') {
      i += 1;
      for (;;) {
        if (i >= text.length) unterminated('quoted identifier');
        if (text[i] === '"' && text[i + 1] === '"') {
          i += 2;
        } else if (text[i] === '"') {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      current += ' ';
    } else if (ch === '$' && !(i > 0 && IDENTIFIER_CHAR.test(text[i - 1] as string))) {
      const tag = DOLLAR_TAG.exec(text.slice(i, i + 80))?.[0];
      if (tag === undefined) {
        // A positional parameter such as $1, or a stray dollar sign: ordinary code.
        current += ch;
        i += 1;
      } else {
        const close = text.indexOf(tag, i + tag.length);
        if (close === -1) unterminated('dollar-quoted string');
        i = close + tag.length;
        current += ' ';
      }
    } else if (ch === ';') {
      statements.push(current);
      current = '';
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== '');
}

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i,
    'controls a transaction; the runner owns the transaction',
  ],
  [
    /^(CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|REINDEX\b[\s\S]*\bCONCURRENTLY)\b/i,
    'cannot run inside a transaction (CONCURRENTLY)',
  ],
  [
    /^(VACUUM|CREATE\s+DATABASE|DROP\s+DATABASE|CREATE\s+TABLESPACE|DROP\s+TABLESPACE|ALTER\s+SYSTEM)\b/i,
    'cannot run inside a transaction',
  ],
];

/** Returns the reasons a migration file is not acceptable to this runner. */
export function findUnsupportedStatements(sql: string): string[] {
  const reasons: string[] = [];
  for (const text of splitSqlStatements(sql)) {
    for (const [pattern, reason] of FORBIDDEN) {
      if (pattern.test(text)) {
        reasons.push(`"${text.split(/\s+/).slice(0, 3).join(' ')}" ${reason}`);
      }
    }
  }
  return reasons;
}

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    throw new MigrationError(`migrations directory not found: ${dir}`);
  }
  const files: MigrationFile[] = [];
  for (const entry of entries.filter((e) => e.endsWith('.sql')).sort()) {
    const match = FILE_PATTERN.exec(entry);
    if (!match) {
      throw new MigrationError(`migration file name must be NNNN_description.sql: ${entry}`);
    }
    const raw = await readFile(path.join(dir, entry), 'utf8');
    const unsupported = findUnsupportedStatements(raw);
    if (unsupported.length > 0) {
      throw new MigrationError(`${entry} is not supported: ${unsupported.join('; ')}`);
    }
    files.push({
      version: Number(match[1]),
      name: match[2] as string,
      checksum: checksumOf(raw),
      sql: normaliseSql(raw),
    });
  }
  files.forEach((file, index) => {
    if (file.version !== index + 1) {
      throw new MigrationError(
        `migrations must be numbered from 0001 without gaps or duplicates; found ${String(
          file.version,
        ).padStart(4, '0')} at position ${index + 1}`,
      );
    }
  });
  return files;
}

async function readApplied(db: Queryable): Promise<Map<number, string>> {
  const exists = await db.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  if (!exists.rows[0]?.present) {
    return new Map();
  }
  const rows = await db.query<{ version: number; checksum: string }>(
    'SELECT version, checksum FROM public.schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((row) => [row.version, row.checksum]));
}

function compare(files: readonly MigrationFile[], applied: Map<number, string>): MigrationStatus {
  const problems: string[] = [];
  const byVersion = new Map(files.map((file) => [file.version, file]));
  for (const [version, checksum] of applied) {
    const file = byVersion.get(version);
    if (!file) {
      problems.push(`migration ${version} is applied in the database but its file is missing`);
    } else if (file.checksum !== checksum) {
      problems.push(`migration ${version} was changed after it was applied`);
    }
  }
  return {
    applied: [...applied.keys()],
    pending: files.filter((file) => !applied.has(file.version)).map((file) => file.version),
    problems,
  };
}

/** Read-only: creates nothing. Safe to call from the readiness check. */
export async function migrationStatus(db: Queryable, dir: string): Promise<MigrationStatus> {
  const files = await readMigrationFiles(dir);
  return compare(files, await readApplied(db));
}

async function acquireRunnerLock(client: pg.PoolClient, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [ADVISORY_LOCK_KEY],
    );
    if (result.rows[0]?.locked) return;
    if (Date.now() >= deadline) {
      throw new MigrationError(
        `another migration run holds the lock; gave up after waiting ${waitMs} ms`,
      );
    }
    await sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

/** Applies every pending migration in order. Returns the versions applied by this call. */
export async function migrateUp(
  pool: pg.Pool,
  dir: string,
  options: MigrateOptions = {},
): Promise<number[]> {
  return applyMigrations(pool, await readMigrationFiles(dir), options);
}

/**
 * Applies already-read migration files. Use migrateUp: it is the only path that runs the
 * statement check first. This function is exported so that tests can prove the second barrier
 * (the transaction check after each file) works even if the first were bypassed.
 */
export async function applyMigrations(
  pool: pg.Pool,
  files: readonly MigrationFile[],
  options: MigrateOptions = {},
): Promise<number[]> {
  const lockWaitMs = options.lockWaitMs ?? 30_000;
  const statementLockTimeoutMs = options.statementLockTimeoutMs ?? 10_000;
  const client = await pool.connect();
  let broken = false;
  try {
    await acquireRunnerLock(client, lockWaitMs);
    try {
      // Session settings for this runner only: no statement limit, bounded table-lock waits.
      await client.query('SET statement_timeout = 0');
      await client.query(`SET lock_timeout = ${Math.trunc(statementLockTimeoutMs)}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          version integer PRIMARY KEY,
          name text NOT NULL,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      const status = compare(files, await readApplied(client));
      if (status.problems.length > 0) {
        throw new MigrationError(status.problems.join('; '));
      }
      const appliedNow: number[] = [];
      for (const file of files.filter((f) => status.pending.includes(f.version))) {
        await client.query('BEGIN');
        try {
          const before = await client.query<{ id: string }>(
            'SELECT pg_current_xact_id()::text AS id',
          );
          await client.query(file.sql);
          const after = await client.query<{ id: string | null }>(
            'SELECT pg_current_xact_id_if_assigned()::text AS id',
          );
          if (after.rows[0]?.id !== before.rows[0]?.id) {
            throw new MigrationError(
              'the file ended the transaction opened by the runner; its changes may be ' +
                'committed without a history entry and must be inspected by hand',
            );
          }
          await client.query(
            'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [file.version, file.name, file.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          const reason = error instanceof Error ? error.message : String(error);
          throw new MigrationError(`migration ${file.version} (${file.name}) failed: ${reason}`);
        }
        appliedNow.push(file.version);
      }
      return appliedNow;
    } finally {
      try {
        await client.query('RESET lock_timeout');
        await client.query('RESET statement_timeout');
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [ADVISORY_LOCK_KEY]);
      } catch {
        // The connection is gone; the server releases the lock when the session ends.
        broken = true;
      }
    }
  } catch (error) {
    // A connection that failed mid-run is discarded rather than returned to the pool.
    broken = !(error instanceof MigrationError);
    throw error;
  } finally {
    client.release(broken);
  }
}
