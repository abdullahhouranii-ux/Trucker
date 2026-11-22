import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { Caller } from '../assignment/assignment.service.js';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';

/**
 * Dispatch and the trip's milestones (db/migrations/0028_dispatch.sql). The carrier's
 * administrator dispatches; the database judges every precondition at that moment, opens the
 * occupancy and creates the trip in one transaction. The driver records milestones; the
 * carrier's administrator may record one on the driver's behalf, marked as reported. No
 * location is collected, and nothing here closes an occupancy. This service maps the
 * database's answers to HTTP.
 */

type Detail = Record<string, unknown>;

/** Refusals of a cargo command (slice 18d, R-406). */
export const CARGO_ERRORS: Record<string, [number, string, string]> = {
  unauthorized: [401, 'unauthorized', 'Authentication is required.'],
  forbidden: [
    403,
    'staff_privilege_required',
    'Your account does not hold the privilege this needs.',
  ],
  not_found: [404, 'not_found', 'The requested resource was not found.'],
  not_dispatched: [409, 'not_dispatched', 'This booking has not been dispatched.'],
  key_conflict: [
    409,
    'retry_key_conflict',
    'This retry key was used for a different request. Nothing was changed.',
  ],
  conflict: [409, 'record_changed', 'This changed since it was opened. Nothing was changed.'],
  no_case: [409, 'no_cargo_case', 'No undeliverable cargo is recorded on this trip.'],
  case_closed: [409, 'cargo_case_closed', 'This cargo case is closed.'],
  no_authority: [
    403,
    'no_instruction_authority',
    'You hold no authority in force to give this instruction. Nothing was changed.',
  ],
  authority_order: [
    409,
    'authority_order',
    'The instruction of a competent authority does not allow this action.',
  ],
  instruction_open: [409, 'instruction_open', 'Another instruction is open on this cargo.'],
  not_open: [409, 'not_open', 'This is not open for that step.'],
  over_limit: [
    409,
    'over_spend_limit',
    'The total is above your spending limit. Nothing was approved.',
  ],
  not_due: [
    409,
    'response_time_not_passed',
    'The response time has not passed: no emergency action is allowed yet.',
  ],
  not_in_plan: [409, 'not_in_emergency_plan', 'This action is not in the emergency plan.'],
  over_cap: [409, 'over_emergency_cap', 'The cost is above the emergency cap.'],
  exceeds_waiting: [
    409,
    'exceeds_billable_waiting',
    'More waiting than was billable: waiting stops when the truck is released.',
  ],
  return_fee_not_allowed: [
    409,
    'return_fee_not_allowed',
    'The booking terms do not allow a return trip fee.',
  ],
  leg_under_way: [409, 'leg_under_way', 'A leg of this trip is still under way.'],
  owner_open: [
    409,
    'hold_owner_open',
    'Only the decision of the claim or dispute that placed this hold releases it.',
  ],
};

const ERRORS: Record<string, [number, string, string]> = {
  unauthorized: [401, 'unauthorized', 'Authentication is required.'],
  not_found: [404, 'not_found', 'The requested resource was not found.'],
  closed: [
    409,
    'booking_closed',
    'Bookings are not available here: the commercial terms are not approved for this environment.',
  ],
  key_conflict: [
    409,
    'retry_key_conflict',
    'This retry key was used for a different request. Nothing was changed.',
  ],
  already_dispatched: [409, 'booking_dispatched', 'This booking has already been dispatched.'],
  not_dispatched: [409, 'not_dispatched', 'This booking has not been dispatched.'],
  out_of_sequence: [
    409,
    'milestone_out_of_sequence',
    'That is not the next milestone of this trip. Nothing was recorded.',
  ],
  conflict: [409, 'trip_changed', 'The trip changed since it was opened. Nothing was recorded.'],
  arrived: [
    409,
    'trip_arrived',
    'The truck has arrived at delivery: an estimated arrival is no longer taken.',
  ],
  invalid: [422, 'validation_failed', 'Some fields are missing or not valid.'],
  not_arrived: [
    409,
    'not_arrived_at_delivery',
    'The truck has not arrived at delivery: no outcome is recorded yet.',
  ],
  already_recorded: [409, 'delivery_recorded', 'The delivery outcome is already recorded.'],
  settled: [
    409,
    'delivery_settled',
    'A handover or a release is recorded: the outcome is no longer corrected.',
  ],
  no_custody: [409, 'no_custody', 'No cargo is in custody on this trip.'],
  already_released: [409, 'already_released', 'This resource is already released.'],
  no_outcome: [
    409,
    'no_delivery_outcome',
    'No delivery outcome is recorded: the resource stays on the trip.',
  ],
  leg_under_way: [409, 'leg_under_way', 'A leg of this trip is still under way.'],
  custody_open: [
    409,
    'custody_open',
    'Cargo is still in custody: record its handover before releasing the resource.',
  ],
  not_assigned: [404, 'not_found', 'No such resource on this booking.'],
  on_hold: [
    409,
    'trip_on_hold',
    'Trucker operations has put this trip on hold. No milestone is recorded until it is resumed.',
  ],
};

function refuse(status: string, detail: Detail | Detail[] | null): never {
  if (status === 'refused') {
    // The first precondition that failed, by name; an eligibility reason comes as its cause.
    const { code, reason, ...rest } = (detail ?? {}) as Detail;
    throw new ApiError(
      409,
      'dispatch_refused',
      'This booking cannot be dispatched now. Nothing was changed.',
      {
        reason: code ?? null,
        ...rest,
        ...(reason ? { cause: reason } : {}),
      },
    );
  }
  if (status === 'invalid' && Array.isArray(detail)) {
    const problems = detail as { field: string; code: string }[];
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields: problems.map((problem) => problem.field),
      problems,
    });
  }
  if (status === 'invalid') {
    const single = (detail ?? {}) as Detail;
    const field = typeof single.field === 'string' ? single.field : 'body';
    const code = typeof single.code === 'string' ? single.code : 'invalid';
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields: [field],
      problems: [{ field, code }],
    });
  }
  const known = ERRORS[status] ?? ERRORS.not_found!;
  throw new ApiError(known[0], known[1], known[2], detail ? { trip: detail } : undefined);
}

@Injectable()
export class TripService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
  ) {}

  /** One transaction as the caller; an organisation of '' acts as the person alone (the driver). */
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
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async run(
    caller: Caller,
    organisationId: string,
    sql: string,
    values: (allow: boolean) => unknown[],
  ) {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: Detail | null }>(
        sql,
        values(allowFixtures),
      );
      return result.rows[0]!;
    });
  }

  async dispatch(caller: Caller, organisationId: string, bookingId: string, key: string) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.dispatch_booking($1, $2, $3)',
      (allow) => [bookingId, key, allow],
    );
    if (row.status === 'dispatched' || row.status === 'repeated')
      return {
        outcome: row.status === 'dispatched' ? 'dispatched' : 'already_dispatched',
        trip: row.detail,
      };
    return refuse(row.status, row.detail);
  }

  async milestoneByDriver(caller: Caller, bookingId: string, version: number, milestone: string) {
    const row = await this.run(
      caller,
      '',
      'SELECT status, detail FROM trucker.trip_milestone_by_driver($1, $2, $3)',
      () => [bookingId, version, milestone],
    );
    if (row.status === 'recorded') return { outcome: 'recorded', trip: row.detail };
    return refuse(row.status, row.detail);
  }

  async milestoneOnBehalf(
    caller: Caller,
    organisationId: string,
    bookingId: string,
    version: number,
    content: Detail,
  ) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.trip_milestone_on_behalf($1, $2, $3)',
      () => [bookingId, version, JSON.stringify(content)],
    );
    if (row.status === 'recorded') return { outcome: 'recorded', trip: row.detail };
    return refuse(row.status, row.detail);
  }

  async estimate(caller: Caller, organisationId: string, bookingId: string, arrivalAt: string) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.trip_estimate_state($1, $2)',
      () => [bookingId, JSON.stringify({ arrivalAt })],
    );
    if (row.status === 'stated') return { outcome: 'stated', trip: row.detail };
    return refuse(
      row.status,
      row.status === 'invalid' ? { field: 'arrivalAt', code: 'invalid' } : row.detail,
    );
  }

  /**
   * The driver (organisation ''), or an administrator of the carrier or of the shipper, reports
   * an exception on a trip (slice 17b, EXC-1). It is a case in the operations queue at once.
   */
  async reportException(
    caller: Caller,
    organisationId: string,
    bookingId: string,
    key: string,
    content: Detail,
  ) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.trip_exception_report($1, $2, $3)',
      () => [bookingId, key, JSON.stringify(content)],
    );
    if (row.status === 'reported' || row.status === 'repeated')
      return {
        outcome: row.status === 'reported' ? 'reported' : 'already_reported',
        case: row.detail,
      };
    return refuse(row.status, row.detail);
  }

  /** The delivery outcome (slice 18a): by the driver (organisation ''), or the carrier on behalf. */
  async delivery(
    caller: Caller,
    organisationId: string,
    bookingId: string,
    version: number,
    content: Detail,
  ) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.trip_delivery_record($1, $2, $3)',
      () => [bookingId, version, JSON.stringify(content)],
    );
    if (row.status === 'recorded') return { outcome: 'recorded', trip: row.detail };
    return refuse(row.status, row.detail);
  }

  /** The handover of cargo left on the vehicle, by the carrier's administrator. */
  async handover(caller: Caller, organisationId: string, bookingId: string, content: Detail) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.cargo_handover_record($1, $2)',
      () => [bookingId, JSON.stringify(content)],
    );
    if (row.status === 'recorded') return { outcome: 'handed_over', trip: row.detail };
    return refuse(row.status, row.detail);
  }

  /** Releases one resource from the trip, by the carrier's administrator. */
  async release(caller: Caller, organisationId: string, bookingId: string, role: string) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.resource_release_record($1, $2)',
      () => [bookingId, role],
    );
    if (row.status === 'released') return { outcome: 'released', trip: row.detail };
    return refuse(row.status, row.detail);
  }

  /** One command on the cargo of a booking (slice 18d): organisation '' acts as the driver. */
  async cargo(
    caller: Caller,
    organisationId: string,
    bookingId: string,
    key: string,
    command: Detail,
  ) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.cargo_command($1, $2, $3)',
      () => [bookingId, key, JSON.stringify(command)],
    );
    return cargoAnswer(row.status, row.detail);
  }

  /** The instruction authorities of a booking. */
  async authorities(caller: Caller, organisationId: string, bookingId: string) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.booking_authorities($1)',
      () => [bookingId],
    );
    if (row.status === 'ok') return row.detail;
    return refuse(row.status, null);
  }

  /** The cases where an organiser holds, or held, an authority. */
  async organiserCases(caller: Caller, organisationId: string) {
    const row = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.organiser_cargo_cases()',
      () => [],
    );
    if (row.status === 'ok') return { cases: row.detail };
    return refuse(row.status, null);
  }
}

const CARGO_DONE = new Set([
  'declared',
  'ended',
  'issued',
  'withdrawn',
  'offered',
  'approved',
  'declined',
  'started',
  'completed',
  'failed',
  'emergency',
  'confirmed',
  'rejected',
  'leg_updated',
  'disputed',
  'claimed',
  'recorded',
  'closed',
  'decided',
  'released',
]);

/** Maps the answer of a cargo command: the outcome and the cargo as the caller sees it. */
export function cargoAnswer(status: string, detail: unknown) {
  if (CARGO_DONE.has(status)) return { outcome: status, cargo: detail };
  if (status === 'invalid') {
    const list = Array.isArray(detail) ? detail : detail ? [detail] : [];
    const problems = list as { field: string; code: string }[];
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields: problems.map((problem) => problem.field),
      problems,
    });
  }
  const known = CARGO_ERRORS[status] ?? CARGO_ERRORS.not_found!;
  throw new ApiError(known[0], known[1], known[2], detail ? { detail } : undefined);
}
