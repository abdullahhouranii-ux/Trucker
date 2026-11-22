import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { jsonLogger } from '../http/logger.js';
import { PaymentService } from '../payment/payment.service.js';
import { APP_CONFIG, DB_POOL } from '../tokens.js';

/** How many bookings one tick lapses at most; the rest wait for the next tick. */
const PER_TICK = 100;

/**
 * Lapses bookings whose fee was not paid by its deadline (ADR-001 D-7). Each call to the
 * database lapses at most one booking, in its own transaction, so a tick never holds the locks
 * of two bookings at once. Every command that could act on such a booking also lapses it
 * first, so this job only keeps the records current; it never decides anything itself.
 * Before lapsing, it asks the payment provider about checkouts that closed with no word.
 *
 * FEE_LAPSE_INTERVAL_MS sets the period; 0 turns it off. Unset, it runs every minute, except
 * under test, where the tests run it themselves.
 */
@Injectable()
export class FeeLapseJob implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PaymentService) private readonly payments: PaymentService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.FEE_LAPSE_INTERVAL_MS ?? (this.config.NODE_ENV === 'test' ? 0 : 60_000);
    if (interval > 0) {
      this.timer = setInterval(() => void this.tick(), interval);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Lapses what is overdue now. Returns how many bookings lapsed. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let lapsed = 0;
    try {
      // First what the provider says of checkouts whose time ran out: a payment it took in time
      // settles the fee rather than letting the booking lapse. A failure there never stops lapses.
      try {
        await this.payments.checkExpiredCheckouts();
        await this.payments.checkSubmittedRefunds();
      } catch (error) {
        jsonLogger.error({
          event: 'payment_status_check_failed',
          code: (error as { code?: string }).code ?? null,
        });
      }
      for (let i = 0; i < PER_TICK; i += 1) {
        const row = (
          await this.pool.query<{ result: string }>('SELECT trucker.lapse_overdue_fee() AS result')
        ).rows[0]!;
        if (row.result === 'none') break;
        if (row.result === 'lapsed') lapsed += 1;
      }
    } catch (error) {
      jsonLogger.error({
        event: 'fee_lapse_failed',
        code: (error as { code?: string }).code ?? null,
      });
    } finally {
      this.running = false;
    }
    if (lapsed > 0) jsonLogger.info({ event: 'fee_lapsed', count: lapsed });
    return lapsed;
  }
}
