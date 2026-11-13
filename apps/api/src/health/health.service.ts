import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { defaultMigrationsDir, migrationStatus } from '../database/migrations.js';
import { APP_CONFIG, DB_POOL } from '../tokens.js';

export interface ReadinessChecks {
  database: 'ok' | 'unavailable';
  migrations: 'ok' | 'pending' | 'inconsistent' | 'unknown';
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Ready means: the database answers and its schema matches the migrations shipped with this build. */
  async check(): Promise<ReadinessChecks> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      return { database: 'unavailable', migrations: 'unknown' };
    }
    try {
      const status = await migrationStatus(
        this.pool,
        this.config.MIGRATIONS_DIR ?? defaultMigrationsDir(),
      );
      if (status.problems.length > 0) return { database: 'ok', migrations: 'inconsistent' };
      if (status.pending.length > 0) return { database: 'ok', migrations: 'pending' };
      return { database: 'ok', migrations: 'ok' };
    } catch {
      return { database: 'ok', migrations: 'unknown' };
    }
  }
}
