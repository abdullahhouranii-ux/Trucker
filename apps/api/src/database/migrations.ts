import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Forward-only SQL migrations.
 *
 * Files are named NNNN_description.sql, numbered from 0001 without gaps. Each runs in its own
 * transaction and is recorded with a checksum, so an applied file that is later edited is
 * detected instead of being silently ignored. One runner at a time holds an advisory lock.
 */

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const ADVISORY_LOCK_KEY = '7426018350912';

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
    const sql = await readFile(path.join(dir, entry), 'utf8');
    files.push({
      version: Number(match[1]),
      name: match[2] as string,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
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

/** Applies every pending migration in order. Returns the versions applied by this call. */
export async function migrateUp(pool: pg.Pool, dir: string): Promise<number[]> {
  const files = await readMigrationFiles(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [ADVISORY_LOCK_KEY]);
    try {
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
          await client.query(file.sql);
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
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
