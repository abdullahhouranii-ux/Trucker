import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';
import type { StaffCaller } from './staff.service.js';

/**
 * Financial settings, the staff side (db/migrations/0022_financial_settings.sql). Every rule is
 * the database's: that only an administrator drafts, approves, discards or withdraws; that the
 * approver is not the drafter; that a version is never changed once written; and which version
 * is in force at any moment.
 */

type Detail = Record<string, unknown>;
export type Move = 'approve' | 'discard' | 'withdraw';

const OUTCOMES: Record<string, string> = {
  drafted: 'drafted',
  approved: 'approved',
  discarded: 'discarded',
  withdrawn: 'withdrawn',
};
const REPEATED: Record<Move | 'draft', string> = {
  draft: 'already_drafted',
  approve: 'already_approved',
  discard: 'already_discarded',
  withdraw: 'already_withdrawn',
};

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
        'This retry key was used for a different request. Nothing was drafted.',
      );
    case 'same_person':
      throw new ApiError(
        409,
        'different_person_required',
        'A version is approved by a different administrator from the one who drafted it.',
      );
    case 'effective_passed':
      throw new ApiError(
        409,
        'effective_time_passed',
        'The effective time of this draft has passed. Discard it and draft it again.',
      );
    case 'already_effective':
      throw new ApiError(
        409,
        'version_in_effect',
        'This version is already in effect and cannot be withdrawn. Draft a new version instead.',
        { version: detail },
      );
    case 'not_open':
      throw new ApiError(409, 'version_not_open', 'This version is no longer open for this.', {
        version: detail,
      });
    case 'conflict':
      throw new ApiError(
        409,
        'record_changed',
        'The version changed since it was opened. Nothing was changed.',
      );
    default:
      throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  }
}

@Injectable()
export class FinanceService {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async overview(caller: StaffCaller): Promise<Detail> {
    const row = (
      await this.pool.query<{ status: string; detail: Detail | null }>(
        'SELECT status, detail FROM trucker.staff_financial_settings($1, $2)',
        [caller.tokenHash, caller.requestId ?? null],
      )
    ).rows[0]!;
    if (row.status !== 'ok') refuse(row.status, row.detail);
    return row.detail!;
  }

  async draft(caller: StaffCaller, retryKey: string, content: Detail) {
    const row = (
      await this.pool.query<{ status: string; detail: unknown }>(
        'SELECT status, detail FROM trucker.staff_financial_draft($1, $2, $3, $4)',
        [caller.tokenHash, retryKey, JSON.stringify(content), caller.requestId ?? null],
      )
    ).rows[0]!;
    if (row.status === 'repeated') return { outcome: REPEATED.draft, setting: row.detail };
    if (OUTCOMES[row.status] === undefined) refuse(row.status, row.detail);
    return { outcome: OUTCOMES[row.status]!, setting: row.detail };
  }

  async move(caller: StaffCaller, id: string, version: number, move: Move) {
    const row = (
      await this.pool.query<{ status: string; detail: unknown }>(
        'SELECT status, detail FROM trucker.staff_financial_move($1, $2, $3, $4, $5)',
        [caller.tokenHash, id, version, move, caller.requestId ?? null],
      )
    ).rows[0]!;
    if (row.status === 'repeated') return { outcome: REPEATED[move], setting: row.detail };
    if (OUTCOMES[row.status] === undefined) refuse(row.status, row.detail);
    return { outcome: OUTCOMES[row.status]!, setting: row.detail };
  }
}
