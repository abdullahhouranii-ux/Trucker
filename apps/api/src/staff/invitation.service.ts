import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';
import type { StaffCaller } from './staff.service.js';

/**
 * Pilot invitations, the staff side (db/migrations/0042_pilot_invitations.sql). Every rule is the
 * database's: that only an administrator invites or cancels, that a number has at most one open
 * invitation, that an invitation expires, and that registration takes it once. Nothing is sent to
 * the person invited: staff tell them.
 */

type Detail = Record<string, unknown>;

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
    case 'exists':
      throw new ApiError(
        409,
        'invitation_open',
        'This number already has an open invitation. Cancel it before inviting the number again.',
        { invitation: detail },
      );
    case 'registered':
      throw new ApiError(
        409,
        'already_registered',
        'Someone has already registered with this number. No invitation is needed.',
      );
    case 'not_open':
      throw new ApiError(
        409,
        'invitation_not_open',
        'This invitation is no longer open: it was taken, cancelled or has expired.',
        { invitation: detail },
      );
    case 'conflict':
      throw new ApiError(
        409,
        'record_changed',
        'The invitation changed since the page was loaded. Nothing was changed.',
      );
    default:
      throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  }
}

@Injectable()
export class InvitationService {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async overview(caller: StaffCaller): Promise<Detail> {
    const row = (
      await this.pool.query<{ status: string; detail: Detail | null }>(
        'SELECT status, detail FROM trucker.staff_pilot_invitations($1, $2)',
        [caller.tokenHash, caller.requestId ?? null],
      )
    ).rows[0]!;
    if (row.status !== 'ok') refuse(row.status, row.detail);
    return row.detail!;
  }

  async invite(
    caller: StaffCaller,
    content: { phone: string; organisationName: string; contactName: string },
  ): Promise<{ outcome: 'invited' | 'already_invited'; invitation: unknown }> {
    const row = (
      await this.pool.query<{ status: string; detail: unknown }>(
        'SELECT status, detail FROM trucker.staff_pilot_invite($1, $2, $3)',
        [caller.tokenHash, JSON.stringify(content), caller.requestId ?? null],
      )
    ).rows[0]!;
    if (row.status === 'invited') return { outcome: 'invited', invitation: row.detail };
    if (row.status === 'repeated') return { outcome: 'already_invited', invitation: row.detail };
    refuse(row.status, row.detail);
  }

  async cancel(
    caller: StaffCaller,
    id: string,
    version: number,
  ): Promise<{ outcome: 'cancelled' | 'already_cancelled'; invitation: unknown }> {
    const row = (
      await this.pool.query<{ status: string; detail: unknown }>(
        'SELECT status, detail FROM trucker.staff_pilot_cancel($1, $2, $3, $4)',
        [caller.tokenHash, id, version, caller.requestId ?? null],
      )
    ).rows[0]!;
    if (row.status === 'cancelled') return { outcome: 'cancelled', invitation: row.detail };
    if (row.status === 'repeated') return { outcome: 'already_cancelled', invitation: row.detail };
    refuse(row.status, row.detail);
  }
}
