import pg from 'pg';
import type { AppConfig } from '../config/config.js';

type PoolConfig = Pick<
  AppConfig,
  | 'DATABASE_URL'
  | 'APP_DATABASE_URL'
  | 'DB_POOL_MAX'
  | 'DB_CONNECT_TIMEOUT_MS'
  | 'DB_STATEMENT_TIMEOUT_MS'
>;

/**
 * Pool used by the API. Three separate bounds apply:
 *  - connectionTimeoutMillis: establishing a connection;
 *  - statement_timeout: the server cancels any statement that runs longer;
 *  - query_timeout: the driver gives up on a call slightly later, in case the server never answers.
 */
export function createPool(config: PoolConfig): pg.Pool {
  const pool = new pg.Pool({
    // The API's own role when one is configured; never the migration role in production.
    connectionString: config.APP_DATABASE_URL ?? config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    query_timeout: config.DB_STATEMENT_TIMEOUT_MS + 1_000,
  });
  // An idle client that loses its connection must not crash the process; readiness reports it.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Pool used only by the migration runner. Migrations may legitimately run long, so there is no
 * statement timeout; waiting for locks is bounded inside the runner instead.
 */
export function createMigrationPool(
  config: Pick<AppConfig, 'DATABASE_URL' | 'DB_CONNECT_TIMEOUT_MS'>,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
  });
  pool.on('error', () => undefined);
  return pool;
}
