import pg from 'pg';
import type { AppConfig } from '../config/config.js';

export function createPool(
  config: Pick<AppConfig, 'DATABASE_URL' | 'DB_POOL_MAX' | 'DB_CONNECT_TIMEOUT_MS'>,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
  });
  // An idle client that loses its connection must not crash the process; readiness reports it.
  pool.on('error', () => undefined);
  return pool;
}
