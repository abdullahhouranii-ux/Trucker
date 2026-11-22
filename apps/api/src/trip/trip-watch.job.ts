import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { jsonLogger } from '../http/logger.js';
import { APP_CONFIG, DB_POOL } from '../tokens.js';

/**
 * Records what the clock shows about trips (slice 17b, EXC-3, DD-9): a resource still occupied
 * past its planned end, and a trip with no arrival at pick-up by the end of the pick-up window,
 * each open one operations case, once. The same record is also made by every command that
 * touches bookings and by the operations queue, so this job only keeps the queue current when
 * nothing else happens. The same timer checks eligible booking closures after case detection.
 *
 * TRIP_WATCH_INTERVAL_MS sets the period; 0 turns it off. Unset, it runs every minute, except
 * under test, where the tests run it themselves.
 */
@Injectable()
export class TripWatchJob implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.TRIP_WATCH_INTERVAL_MS ?? (this.config.NODE_ENV === 'test' ? 0 : 60_000);
    if (interval > 0) {
      this.timer = setInterval(() => void this.tick(), interval);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns how many cases it opened. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const opened = (
        await this.pool.query<{ opened: number }>('SELECT trucker.trip_watch() AS opened')
      ).rows[0]!.opened;
      if (opened > 0) jsonLogger.info({ event: 'trip_cases_opened', count: opened });
      const closed = (
        await this.pool.query<{ closed: number }>(
          'SELECT trucker.booking_closure_watch() AS closed',
        )
      ).rows[0]!.closed;
      if (closed > 0) jsonLogger.info({ event: 'bookings_closed', count: closed });
      return opened;
    } catch (error) {
      jsonLogger.error({
        event: 'trip_watch_failed',
        code: (error as { code?: string }).code ?? null,
      });
      return 0;
    } finally {
      this.running = false;
    }
  }
}
