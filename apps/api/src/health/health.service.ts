import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { defaultMigrationsDir, migrationStatus } from '../database/migrations.js';
import { APP_CONFIG, DB_POOL } from '../tokens.js';

export interface ReadinessChecks {
  database: 'ok' | 'unavailable';
  migrations: 'ok' | 'pending' | 'inconsistent' | 'unknown';
}

class DeadlineExceeded extends Error {}

/** Resolves or rejects with the work, or rejects when the deadline passes first. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  // The abandoned work may still fail later; that failure is already accounted for.
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceeded()), Math.max(1, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type HealthConfig = Pick<AppConfig, 'HEALTH_CHECK_TIMEOUT_MS' | 'MIGRATIONS_DIR'>;

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pick<pg.Pool, 'query'>,
    @Inject(APP_CONFIG) private readonly config: HealthConfig,
  ) {}

  /**
   * Ready means: the database answers and its schema matches the migrations shipped with this
   * build. The whole check has one deadline, so a stalled connection or a stalled query makes
   * the answer "not ready" instead of making the caller wait. The server-side statement timeout
   * on the pool then cancels whatever was abandoned.
   */
  async check(): Promise<ReadinessChecks> {
    const deadlineAt = Date.now() + this.config.HEALTH_CHECK_TIMEOUT_MS;
    try {
      await withDeadline(this.pool.query('SELECT 1'), deadlineAt - Date.now());
    } catch {
      return { database: 'unavailable', migrations: 'unknown' };
    }
    try {
      const status = await withDeadline(
        migrationStatus(this.pool, this.config.MIGRATIONS_DIR ?? defaultMigrationsDir()),
        deadlineAt - Date.now(),
      );
      if (status.problems.length > 0) return { database: 'ok', migrations: 'inconsistent' };
      if (status.pending.length > 0) return { database: 'ok', migrations: 'pending' };
      return { database: 'ok', migrations: 'ok' };
    } catch {
      return { database: 'ok', migrations: 'unknown' };
    }
  }
}
