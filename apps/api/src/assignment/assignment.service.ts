import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import type { StaffCaller } from '../staff/staff.service.js';
import { DB_POOL } from '../tokens.js';

/**
 * Assignment, reservation and confirmation (db/migrations/0014_assignments.sql). The carrier
 * sets the assigned set of a booking; each member holds a planned reservation; the booking is
 * confirmed when the set is complete, eligible and reserved. After confirmation a materially
 * different substitute needs the shipper's acceptance. The driver acknowledges their own
 * assignment. Pre-dispatch cancellation releases reservations through migration 0017. Nothing
 * here dispatches or opens occupancy. The database owns each rule; this service maps its answers
 * to HTTP.
 */

export interface Caller {
  readonly personId: string;
  readonly tokenHash: string;
  readonly requestId?: string | undefined;
}
type Detail = Record<string, unknown>;

const ERRORS: Record<string, [number, string, string]> = {
  cancelled: [409, 'booking_cancelled', 'This booking has been cancelled.'],
  already_dispatched: [
    409,
    'booking_dispatched',
    'This booking has been dispatched. Open an operations case instead.',
  ],
  unauthorized: [401, 'unauthorized', 'Authentication is required.'],
  forbidden: [
    403,
    'staff_privilege_required',
    'Your account does not hold the privilege this needs.',
  ],
  not_found: [404, 'not_found', 'The requested resource was not found.'],
  not_carrier: [403, 'carrier_not_eligible', 'This organisation is not a verified carrier now.'],
  closed: [
    409,
    'booking_closed',
    'Bookings are not available here: the commercial terms are not approved for this environment.',
  ],
  conflict: [
    409,
    'assignment_changed',
    'The assignment changed since it was opened. Nothing was changed.',
  ],
  incomplete: [
    409,
    'assignment_incomplete',
    'This booking is confirmed: a resource can be replaced, not taken away.',
  ],
  substitution_open: [
    409,
    'substitution_open',
    'A proposed substitution is waiting for the shipper. Withdraw it before changing the assignment.',
  ],
  checks_failed: [
    409,
    'substitution_checks_failed',
    'The proposed substitute no longer meets the requirements. The proposal has ended and nothing was changed.',
  ],
  wait_required: [
    409,
    'assignment_wait_required',
    'The assignment deadline has passed. The shipper must choose to wait before resources can be assigned.',
  ],
  not_due: [409, 'assignment_not_overdue', 'The assignment deadline has not passed.'],
  fee_not_paid: [
    409,
    'fee_not_paid',
    "Trucker's fee was not paid by its deadline. The booking is lapsing and nothing was reserved.",
  ],
  confirmed: [409, 'booking_confirmed', 'This booking is already confirmed.'],
  invalid: [422, 'validation_failed', 'Some fields are missing or not valid.'],
};

function refuse(status: string, detail?: Detail | null): never {
  if (status === 'not_eligible')
    throw new ApiError(
      409,
      'resource_not_eligible',
      'A resource does not meet a requirement of this booking. Nothing was changed.',
      { role: detail?.role ?? null, reason: detail?.reason ?? null },
    );
  if (status === 'not_free')
    throw new ApiError(
      409,
      'resource_not_free',
      'A resource is not free for the planned time of this booking. Nothing was changed.',
      { role: detail?.role ?? null, reason: detail?.reason ?? null },
    );
  const known = ERRORS[status] ?? ERRORS.not_found!;
  throw new ApiError(known[0], known[1], known[2]);
}

export interface AssignmentInput {
  readonly version: number;
  readonly truckId: string | null;
  readonly trailerId: string | null;
  readonly driverId: string | null;
}

@Injectable()
export class AssignmentService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
  ) {}

  /** One transaction as the caller. Definite refusals are kept, so their records persist. */
  private async asCaller<T>(
    caller: Caller,
    organisationId: string,
    work: (client: pg.PoolClient, allowFixtures: boolean) => Promise<T>,
  ): Promise<T> {
    const access = await this.access.requireBoundRole();
    const allowFixtures = this.access.fixturesAllowed(access);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('trucker.session_token_hash', $1, true),
                set_config('trucker.organisation_id', $2, true),
                set_config('trucker.request_id', $3, true)`,
        [caller.tokenHash, organisationId, caller.requestId ?? ''],
      );
      const result = await work(client, allowFixtures);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        await client.query('COMMIT');
        throw error;
      }
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  detail(caller: Caller, organisationId: string, bookingId: string): Promise<Detail> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: Detail }>(
        'SELECT status, detail FROM trucker.booking_detail($1, $2)',
        [bookingId, allowFixtures],
      );
      const row = result.rows[0]!;
      if (row.status !== 'ok') refuse(row.status);
      return row.detail;
    });
  }

  cancel(
    caller: Caller,
    organisationId: string,
    bookingId: string,
    input: { version: number; reason: string; note?: string | null },
  ) {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: Detail | null }>(
        'SELECT status, detail FROM trucker.cancel_booking($1, $2, $3, $4, $5)',
        [bookingId, input.version, input.reason, input.note ?? null, allowFixtures],
      );
      const row = result.rows[0]!;
      if (row.status === 'cancelled' || row.status === 'already_cancelled')
        return { outcome: row.status, booking: row.detail };
      return refuse(row.status);
    });
  }

  assign(caller: Caller, organisationId: string, bookingId: string, input: AssignmentInput) {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: Detail | null }>(
        'SELECT status, detail FROM trucker.set_booking_assignment($1, $2, $3, $4, $5, $6)',
        [bookingId, input.version, input.truckId, input.trailerId, input.driverId, allowFixtures],
      );
      const row = result.rows[0]!;
      if (['assigned', 'confirmed', 'unchanged', 'proposed'].includes(row.status))
        return { outcome: row.status, booking: row.detail };
      return refuse(row.status, row.detail);
    });
  }

  decide(
    caller: Caller,
    organisationId: string,
    substitutionId: string,
    version: number,
    decision: 'accept' | 'decline' | 'withdraw',
  ) {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: Detail | null }>(
        'SELECT status, detail FROM trucker.decide_booking_substitution($1, $2, $3, $4)',
        [substitutionId, version, decision, allowFixtures],
      );
      const row = result.rows[0]!;
      if (['accepted', 'declined', 'withdrawn'].includes(row.status))
        return { outcome: row.status, booking: row.detail };
      if (row.status === 'already_decided')
        return { outcome: 'already_decided', status: row.detail?.status ?? null };
      return refuse(row.status, row.detail);
    });
  }

  wait(caller: Caller, organisationId: string, bookingId: string) {
    return this.asCaller(caller, organisationId, async (client) => {
      const result = await client.query<{ status: string; detail: Detail | null }>(
        'SELECT status, detail FROM trucker.record_booking_wait($1)',
        [bookingId],
      );
      const row = result.rows[0]!;
      if (row.status === 'recorded' || row.status === 'already_recorded')
        return { outcome: row.status, booking: row.detail };
      return refuse(row.status);
    });
  }

  driverAssignments(caller: Caller): Promise<Detail[]> {
    return this.asCaller(caller, '', async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: Detail[] }>(
        'SELECT status, detail FROM trucker.driver_assignments($1)',
        [allowFixtures],
      );
      const row = result.rows[0]!;
      if (row.status !== 'ok') refuse(row.status);
      return row.detail;
    });
  }

  acknowledge(caller: Caller, bookingId: string, version: number) {
    return this.asCaller(caller, '', async (client) => {
      const result = await client.query<{ status: string }>(
        'SELECT status FROM trucker.driver_assignment_receipt($1, $2)',
        [bookingId, version],
      );
      const row = result.rows[0]!;
      if (row.status === 'recorded' || row.status === 'already_recorded')
        return { outcome: row.status };
      return refuse(row.status);
    });
  }

  async staffDetail(caller: StaffCaller, bookingId: string): Promise<Detail> {
    const result = await this.pool.query<{ status: string; detail: Detail }>(
      'SELECT status, detail FROM trucker.staff_booking_detail($1,$2,$3)',
      [caller.tokenHash, bookingId, caller.requestId ?? null],
    );
    const row = result.rows[0]!;
    if (row.status !== 'ok') refuse(row.status);
    return row.detail;
  }

  async staffAttention(caller: StaffCaller): Promise<Detail> {
    const result = await this.pool.query<{ status: string; detail: Detail }>(
      'SELECT status, detail FROM trucker.staff_booking_attention($1, $2)',
      [caller.tokenHash, caller.requestId ?? null],
    );
    const row = result.rows[0]!;
    if (row.status !== 'ok') refuse(row.status);
    return row.detail;
  }
}
