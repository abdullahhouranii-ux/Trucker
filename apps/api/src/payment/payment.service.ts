import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';
import {
  PAYMENT_PROVIDER,
  ProviderRefused,
  type PaymentProvider,
  type ProviderReport,
  type RefundRequest,
} from './provider.js';

/**
 * Online payment of Trucker's fee (db/migrations/0025_online_payment.sql). The database decides
 * everything that matters: who may pay, whether a checkout in progress is resumed, whether a
 * report settles the fee, is money to return or is refused, and whether the booking is
 * confirmed. This service talks to the provider and checks its signatures.
 */
export interface Caller {
  readonly personId: string;
  readonly tokenHash: string;
  readonly requestId?: string | undefined;
}
type Detail = Record<string, unknown>;
interface Checkout extends Detail {
  id: string;
  status: string;
  reference: string;
  amount: string;
  currency: string;
  expiresAt: string;
}

const ERRORS: Record<string, [number, string, string]> = {
  unauthorized: [401, 'unauthorized', 'Authentication is required.'],
  not_found: [404, 'not_found', 'The requested resource was not found.'],
  not_due: [409, 'fee_not_due', "Trucker's fee is not due on this booking."],
  deadline_passed: [
    409,
    'fee_deadline_passed',
    "The deadline to pay Trucker's fee has passed. Nothing was started.",
  ],
  key_conflict: [
    409,
    'retry_key_conflict',
    'This retry key was used for a different request. Nothing was started.',
  ],
  unavailable: [503, 'online_payment_unavailable', 'Online payment is not available here.'],
  invalid: [422, 'validation_failed', 'Some fields are missing or not valid.'],
};
function refuse(status: string): never {
  const known = ERRORS[status] ?? ERRORS.not_found!;
  throw new ApiError(known[0], known[1], known[2]);
}

@Injectable()
export class PaymentService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  options(): { online: boolean; provider: string | null } {
    return { online: this.provider !== null, provider: this.provider?.name ?? null };
  }

  private async asCaller<T>(
    caller: Caller,
    organisationId: string,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    await this.access.requireBoundRole();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('trucker.session_token_hash', $1, true),
                set_config('trucker.organisation_id', $2, true),
                set_config('trucker.request_id', $3, true)`,
        [caller.tokenHash, organisationId, caller.requestId ?? ''],
      );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Opens a checkout for the payer, or resumes the one in progress. The checkout is written
   * first, then the provider is asked, with Trucker's checkout identifier as its idempotency
   * key, so a retried or interrupted request never opens two.
   */
  async openCheckout(caller: Caller, organisationId: string, bookingId: string, key: string) {
    if (!this.provider) refuse('unavailable');
    const provider = this.provider;
    const opened = await this.asCaller(caller, organisationId, async (client) => {
      const row = (
        await client.query<{ status: string; detail: Checkout | null }>(
          'SELECT status, detail FROM trucker.fee_checkout_open($1, $2, $3)',
          [bookingId, key, provider.name],
        )
      ).rows[0]!;
      return row;
    });
    if (!['created', 'existing', 'repeated'].includes(opened.status)) refuse(opened.status);
    let checkout = opened.detail!;
    if (checkout.status === 'opening') {
      let started;
      try {
        started = await provider.openCheckout({
          checkoutId: checkout.id,
          reference: checkout.reference,
          amount: checkout.amount,
          currency: checkout.currency,
          expiresAt: new Date(checkout.expiresAt),
        });
      } catch (error) {
        // Only a refusal closes it. When the answer is lost the provider may have opened a
        // checkout: it stays in progress, and asking again asks the provider again with the same
        // identifier, which reaches that same checkout rather than a second one.
        if (error instanceof ProviderRefused) {
          await this.asCaller(caller, organisationId, (client) =>
            client.query('SELECT trucker.fee_checkout_refused($1)', [checkout.id]),
          );
          throw new ApiError(
            502,
            'payment_provider_unavailable',
            'The payment provider refused to open a checkout. Try again.',
          );
        }
        // Whether the provider opened it is not known; the payer was not sent to it.
        throw new ApiError(
          502,
          'payment_provider_unavailable',
          'The payment provider did not answer, so the payer was not sent to its payment page and paid nothing through it. Asking again asks for the same checkout.',
        );
      }
      const row = await this.asCaller(
        caller,
        organisationId,
        async (client) =>
          (
            await client.query<{ status: string; detail: Checkout | null }>(
              'SELECT status, detail FROM trucker.fee_checkout_started($1, $2, $3)',
              [checkout.id, started.providerReference, started.url],
            )
          ).rows[0]!,
      );
      if (row.status !== 'ok') refuse(row.status === 'conflict' ? 'not_found' : row.status);
      checkout = row.detail!;
    }
    const outcome =
      opened.status === 'created'
        ? 'created'
        : opened.status === 'existing'
          ? 'resumed'
          : 'already_requested';
    return { outcome, checkout };
  }

  private async report(notificationId: string, kind: string, report: ProviderReport) {
    return (
      await this.pool.query<{ status: string; detail: { result?: string } | null }>(
        'SELECT status, detail FROM trucker.payment_report($1, $2, $3, $4)',
        [this.provider!.name, notificationId, kind, JSON.stringify(report)],
      )
    ).rows[0]!;
  }

  /** A notification from a provider. Only a signature the provider's rules accept counts. */
  async receive(
    providerName: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ) {
    if (!this.provider || providerName !== this.provider.name)
      throw new ApiError(404, 'not_found', 'The requested resource was not found.');
    const verified = rawBody ? this.provider.verify(rawBody, headers) : null;
    if (!verified)
      throw new ApiError(400, 'notification_refused', 'The notification was not accepted.');
    const row = await this.report(verified.notificationId, 'notification', verified.report);
    if (row.status === 'invalid')
      throw new ApiError(400, 'notification_refused', 'The notification was not accepted.');
    return { received: true, outcome: row.status, result: row.detail?.result ?? null };
  }

  /**
   * Asks the provider about checkouts whose time ran out with no word from it, and records
   * what it answers. Run by the fee job before it lapses anything. Returns how many it recorded.
   */
  /** Records when the fee job asked about a checkout and what it heard, so none waits behind others. */
  private async asked(item: { provider: string; provider_reference: string }, answer: string) {
    await this.pool.query('SELECT trucker.fee_checkout_asked($1, $2, $3)', [
      item.provider,
      item.provider_reference,
      answer,
    ]);
  }

  async checkExpiredCheckouts(): Promise<number> {
    if (!this.provider) return 0;
    const due = (
      await this.pool.query<{ provider: string; provider_reference: string }>(
        'SELECT provider, provider_reference FROM trucker.fee_checkouts_to_check()',
      )
    ).rows;
    let recorded = 0;
    for (const item of due) {
      if (item.provider !== this.provider.name) continue;
      let answer;
      try {
        answer = await this.provider.status(item.provider_reference);
      } catch {
        // Unreachable now: asked again on the next run. The hold on the booking still ends at
        // the end of the longest wait, so an outage never keeps a booking open indefinitely.
        await this.asked(item, 'unreachable');
        continue;
      }
      // Still open, or unknown to the provider: no outcome yet, asked again later.
      if (!('providerReference' in answer)) {
        await this.asked(item, answer.status === 'open' ? 'open' : 'unknown');
        continue;
      }
      const report: ProviderReport = answer;
      const id =
        report.status === 'paid'
          ? `status:${report.transactionId}`
          : `status:${item.provider_reference}:${report.status}`;
      const row = await this.report(id, 'status_check', report);
      await this.asked(item, 'reported');
      if (row.status === 'recorded') recorded += 1;
    }
    return recorded;
  }

  /** Asks the provider for a refund and records its answer. Throws when the answer is lost. */
  async refund(details: RefundRequest): Promise<{ status: string; detail: Detail | null }> {
    if (!this.provider)
      throw new ApiError(
        503,
        'online_payment_unavailable',
        'Online payment is not available here.',
      );
    const answer = await this.provider.refund(details);
    return this.recordRefund(details.refundId, answer);
  }

  private async recordRefund(refundId: string, answer: object) {
    return (
      await this.pool.query<{ status: string; detail: Detail | null }>(
        'SELECT status, detail FROM trucker.refund_provider_report($1, $2)',
        [refundId, JSON.stringify(answer)],
      )
    ).rows[0]!;
  }

  /**
   * Provider refunds submitted with no final answer: asks the provider, and sends again (with the
   * same identifier) any it never received. Run by the fee job. Returns how many it settled.
   */
  async checkSubmittedRefunds(): Promise<number> {
    if (!this.provider) return 0;
    const due = (
      await this.pool.query<{ details: RefundRequest & { provider: string } }>(
        'SELECT refunds_to_check AS details FROM trucker.refunds_to_check()',
      )
    ).rows;
    let settled = 0;
    for (const { details } of due) {
      if (details.provider !== this.provider.name) continue;
      try {
        const known = await this.provider.refundStatus(details.refundId);
        const answer = known.status === 'unknown' ? await this.provider.refund(details) : known;
        const row = await this.recordRefund(details.refundId, answer);
        if (row.status === 'completed' || row.status === 'failed') settled += 1;
      } catch {
        // Unreachable now: asked again on the next run.
      }
    }
    return settled;
  }
}
