import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ApiError } from '../http/api-error.js';
import { PaymentService } from '../payment/payment.service.js';
import type { RefundRequest } from '../payment/provider.js';
import { DB_POOL } from '../tokens.js';
import type { StaffCaller } from './staff.service.js';

/**
 * Refunds of Trucker's fee and reconciliation, the staff side (db/migrations/0027_refunds.sql).
 * The database decides who may do what (requested and approved by different administrators; a
 * bank refund confirmed by someone other than the one who sent it; reconciliation by someone
 * who had no hand in it), that refunds never exceed the payment, and that nothing recorded
 * changes. A provider refund is marked submitted before the provider is asked, with the
 * request's identifier as the idempotency key, so a lost answer is resolved by asking again.
 */

type Detail = Record<string, unknown>;

const ERRORS: Record<string, [number, string, string]> = {
  unauthorized: [401, 'unauthorized', 'Authentication is required.'],
  forbidden: [
    403,
    'staff_privilege_required',
    'Your account does not hold the privilege this needs.',
  ],
  not_found: [404, 'not_found', 'The requested resource was not found.'],
  key_conflict: [
    409,
    'retry_key_conflict',
    'This retry key was used for a different request. Nothing was recorded.',
  ],
  same_person: [
    409,
    'different_person_required',
    'This step is taken by a different administrator from the one who took the step before.',
  ],
  not_independent: [
    409,
    'independent_person_required',
    'Reconciliation is recorded by someone who had no hand in the payment or the refund.',
  ],
  not_open: [409, 'refund_not_open', 'This refund is no longer open for that.'],
  conflict: [409, 'record_changed', 'The refund changed since it was opened. Nothing was changed.'],
  already_reconciled: [
    409,
    'already_reconciled',
    'This is already reconciled. Record a correction that names the entry it replaces.',
  ],
};

function refuse(status: string, detail: unknown): never {
  if (status === 'invalid') {
    const problems = (Array.isArray(detail) ? detail : []) as { field: string; code: string }[];
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields: problems.map((problem) => problem.field),
      problems,
    });
  }
  const known = ERRORS[status] ?? ERRORS.not_found!;
  throw new ApiError(known[0], known[1], known[2], detail ? { record: detail } : undefined);
}

@Injectable()
export class RefundService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(PaymentService) private readonly payments: PaymentService,
  ) {}

  private async run(sql: string, values: unknown[]) {
    return (await this.pool.query<{ status: string; detail: Detail | null }>(sql, values)).rows[0]!;
  }

  async overview(caller: StaffCaller): Promise<Detail> {
    const row = await this.run('SELECT status, detail FROM trucker.staff_refunds($1, $2)', [
      caller.tokenHash,
      caller.requestId ?? null,
    ]);
    if (row.status !== 'ok') refuse(row.status, null);
    return row.detail!;
  }

  async request(caller: StaffCaller, key: string, content: Detail) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_refund_request($1, $2, $3, $4)',
      [caller.tokenHash, key, JSON.stringify(content), caller.requestId ?? null],
    );
    if (row.status === 'repeated') return { outcome: 'already_requested', refund: row.detail };
    if (row.status !== 'requested') refuse(row.status, row.detail);
    return { outcome: 'requested', refund: row.detail };
  }

  async decide(
    caller: StaffCaller,
    id: string,
    version: number,
    decision: 'approve' | 'withdraw',
    note: string | null,
  ) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_refund_decide($1, $2, $3, $4, $5, $6)',
      [caller.tokenHash, id, version, decision, note, caller.requestId ?? null],
    );
    if (row.status !== 'approved' && row.status !== 'withdrawn') refuse(row.status, row.detail);
    return { outcome: row.status, refund: row.detail };
  }

  /**
   * Submits an approved refund. A provider refund is then sent to the provider; when its answer
   * is lost the refund stays submitted, and submitting it again asks the provider again.
   */
  async submit(caller: StaffCaller, id: string, version: number, bankReference: string | null) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_refund_submit($1, $2, $3, $4, $5)',
      [caller.tokenHash, id, version, bankReference, caller.requestId ?? null],
    );
    if (row.status !== 'submitted' && row.status !== 'already_submitted')
      refuse(row.status, row.detail);
    const detail = row.detail as { refund: Detail; provider: RefundRequest | null };
    if (!detail.provider) return { outcome: 'submitted', refund: detail.refund };
    let answered;
    try {
      answered = await this.payments.refund(detail.provider);
    } catch {
      throw new ApiError(
        502,
        'refund_unconfirmed',
        'It is not confirmed that the provider received the refund. It stays submitted; submitting it again asks the provider again, for the same refund.',
        { refund: detail.refund },
      );
    }
    // An answer Trucker cannot apply (a malformed one, or a different refund reference) is not
    // reported as an outcome: the refund stays submitted and is asked about again.
    if (!['pending', 'completed', 'failed', 'repeated', 'contradicted'].includes(answered.status))
      throw new ApiError(
        502,
        'refund_unconfirmed',
        'The provider answered with something Trucker could not apply. The refund stays submitted.',
        { refund: detail.refund },
      );
    return { outcome: answered.status, refund: answered.detail };
  }

  async outcome(
    caller: StaffCaller,
    id: string,
    version: number,
    outcome: 'completed' | 'failed',
    statementReference: string | null,
    note: string | null,
  ) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_refund_outcome($1, $2, $3, $4, $5, $6, $7)',
      [caller.tokenHash, id, version, outcome, statementReference, note, caller.requestId ?? null],
    );
    if (row.status !== 'completed' && row.status !== 'failed') refuse(row.status, row.detail);
    return { outcome: row.status, refund: row.detail };
  }

  async reconcile(caller: StaffCaller, key: string, content: Detail) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_reconcile($1, $2, $3, $4)',
      [caller.tokenHash, key, JSON.stringify(content), caller.requestId ?? null],
    );
    if (row.status === 'repeated') return { outcome: 'already_recorded', entry: row.detail };
    if (row.status !== 'recorded') refuse(row.status, row.detail);
    return { outcome: 'recorded', entry: row.detail };
  }
}
