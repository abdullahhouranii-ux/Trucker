import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';
import type { StaffCaller } from './staff.service.js';

/**
 * Trucker's fee, the staff side (db/migrations/0024_fee_payment.sql). The database holds every
 * rule: that only an administrator records or decides; that the approver is not the person who
 * recorded the receipt; that only an exact match settles a fee that is due; that money for a
 * lapsed, cancelled or already paid booking becomes a refund record; and that the later of fee
 * verification and full assignment confirms the booking.
 */

type Detail = Record<string, unknown>;
export interface FeeReceipt {
  readonly reference: string;
  readonly amount: string;
  readonly currency: string;
  readonly valueDate: string;
  readonly statementReference: string;
  readonly note?: string | null | undefined;
}

function refuse(status: string, detail: unknown): never {
  switch (status) {
    case 'unauthorized':
      throw new ApiError(401, 'unauthorized', 'Authentication is required.');
    case 'forbidden':
      throw new ApiError(
        403,
        'staff_privilege_required',
        'Your account does not hold the privilege this needs.',
      );
    case 'invalid': {
      const problems = (Array.isArray(detail) ? detail : []) as { field: string; code: string }[];
      throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
        fields: problems.map((problem) => problem.field),
        problems,
      });
    }
    case 'key_conflict':
      throw new ApiError(
        409,
        'retry_key_conflict',
        'This retry key was used for a different request. Nothing was recorded.',
      );
    case 'same_person':
      throw new ApiError(
        409,
        'different_person_required',
        'A receipt is approved by a different administrator from the one who recorded it.',
      );
    case 'already_decided':
      throw new ApiError(409, 'receipt_already_decided', 'This receipt was already decided.', {
        payment: detail,
      });
    case 'conflict':
      throw new ApiError(
        409,
        'record_changed',
        'The receipt changed since it was opened. Nothing was changed.',
      );
    default:
      throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  }
}

@Injectable()
export class FeeService {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async overview(caller: StaffCaller): Promise<Detail> {
    const row = (
      await this.pool.query<{ status: string; detail: Detail | null }>(
        'SELECT status, detail FROM trucker.staff_fee_payments($1, $2)',
        [caller.tokenHash, caller.requestId ?? null],
      )
    ).rows[0]!;
    if (row.status !== 'ok') refuse(row.status, row.detail);
    return row.detail!;
  }

  async record(caller: StaffCaller, retryKey: string, receipt: FeeReceipt) {
    const row = (
      await this.pool.query<{ status: string; detail: unknown }>(
        'SELECT status, detail FROM trucker.staff_fee_record($1, $2, $3, $4)',
        [caller.tokenHash, retryKey, JSON.stringify(receipt), caller.requestId ?? null],
      )
    ).rows[0]!;
    if (row.status === 'repeated') return { outcome: 'already_recorded', payment: row.detail };
    if (row.status !== 'recorded') refuse(row.status, row.detail);
    return { outcome: 'recorded', payment: row.detail };
  }

  async decide(
    caller: StaffCaller,
    id: string,
    version: number,
    decision: 'approve' | 'reject',
    note: string | null,
  ) {
    const row = (
      await this.pool.query<{ status: string; detail: Detail | null }>(
        'SELECT status, detail FROM trucker.staff_fee_decide($1, $2, $3, $4, $5, $6)',
        [caller.tokenHash, id, version, decision, note, caller.requestId ?? null],
      )
    ).rows[0]!;
    if (row.status !== 'approved' && row.status !== 'rejected') refuse(row.status, row.detail);
    return { outcome: row.status, ...row.detail };
  }
}
