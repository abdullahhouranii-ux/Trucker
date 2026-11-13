import { ConfigError, loadConfig } from '../config/config.js';
import {
  MigrationError,
  defaultMigrationsDir,
  migrateUp,
  migrationStatus,
  readMigrationFiles,
} from '../database/migrations.js';
import { createMigrationPool } from '../database/pool.js';

/**
 * check  - validates migration files only; needs no database.
 * up     - applies pending migrations. Run this before the API serves traffic: readiness
 *          stays 503 while anything is pending.
 * status - exits 1 when anything is pending or inconsistent.
 */
async function main(command: string | undefined): Promise<number> {
  const dir = process.env.MIGRATIONS_DIR ?? defaultMigrationsDir();

  if (command === 'check') {
    const files = await readMigrationFiles(dir);
    console.log(`migration files valid: ${files.length}`);
    return 0;
  }
  if (command !== 'up' && command !== 'status') {
    console.error('usage: migrate <check|up|status>');
    return 2;
  }

  const config = loadConfig(process.env);
  const pool = createMigrationPool(config);
  try {
    if (command === 'up') {
      const applied = await migrateUp(pool, dir, {
        lockWaitMs: config.MIGRATION_LOCK_WAIT_MS,
        statementLockTimeoutMs: config.MIGRATION_STATEMENT_LOCK_TIMEOUT_MS,
      });
      console.log(applied.length > 0 ? `applied: ${applied.join(', ')}` : 'applied: none');
      return 0;
    }
    const status = await migrationStatus(pool, dir);
    console.log(
      `applied: ${status.applied.length}, pending: ${status.pending.length}, problems: ${status.problems.length}`,
    );
    status.problems.forEach((problem) => console.error(problem));
    return status.pending.length === 0 && status.problems.length === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

try {
  process.exitCode = await main(process.argv[2]);
} catch (error) {
  if (error instanceof ConfigError || error instanceof MigrationError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
