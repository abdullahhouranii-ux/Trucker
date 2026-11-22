import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';
import type { StaffCaller } from './staff.service.js';

/**
 * Trucker operations on trips (db/migrations/0029_exceptions.sql, slice 17b). Only staff who
 * hold the operations privilege: the queue of cases, acknowledging, acting on and resolving them,
 * blocking a dispatch, holding and resuming a trip, recording a milestone on the driver's behalf
 * and withdrawing one recorded by mistake. The database decides every rule and records who,
 * when and why; this service maps its answers to HTTP.
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
  conflict: [409, 'record_changed', 'This changed since it was opened. Nothing was changed.'],
  not_open: [409, 'case_not_open', 'This case is not open for that step.'],
  already_blocked: [409, 'already_blocked', 'A block is already in force on this dispatch.'],
  not_blocked: [409, 'not_blocked', 'No block is in force on this dispatch.'],
  already_dispatched: [409, 'booking_dispatched', 'This booking has already been dispatched.'],
  cancelled: [409, 'booking_cancelled', 'This booking is cancelled.'],
  already_held: [409, 'already_held', 'This trip is already on hold.'],
  not_held: [409, 'not_held', 'This trip is not on hold.'],
  not_dispatched: [409, 'not_dispatched', 'This booking has not been dispatched.'],
  on_hold: [
    409,
    'trip_on_hold',
    'This trip is on hold. No milestone is recorded until it is resumed.',
  ],
  out_of_sequence: [
    409,
    'milestone_out_of_sequence',
    'That is not the next milestone of this trip. Nothing was recorded.',
  ],
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
  custody_open: [
    409,
    'custody_open',
    'Cargo is still in custody: record its handover before releasing the resource.',
  ],
  not_assigned: [404, 'not_found', 'No such resource on this booking.'],
  nothing_to_withdraw: [409, 'nothing_to_withdraw', 'No milestone is recorded on this trip.'],
};

function refuse(status: string, detail: unknown): never {
  if (status === 'invalid') {
    const list = Array.isArray(detail) ? detail : detail ? [detail] : [];
    const problems = list as { field: string; code: string }[];
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields: problems.map((problem) => problem.field),
      problems,
    });
  }
  const known = ERRORS[status] ?? ERRORS.not_found!;
  throw new ApiError(known[0], known[1], known[2], detail ? { record: detail } : undefined);
}

@Injectable()
export class OperationsService {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  private async run(sql: string, values: unknown[]) {
    return (await this.pool.query<{ status: string; detail: Detail | null }>(sql, values)).rows[0]!;
  }

  async queue(caller: StaffCaller): Promise<Detail> {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_operations_queue($1, $2)',
      [caller.tokenHash, caller.requestId ?? null],
    );
    if (row.status !== 'ok') refuse(row.status, null);
    return row.detail!;
  }

  async booking(caller: StaffCaller, bookingId: string): Promise<Detail> {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_operations_booking($1, $2, $3)',
      [caller.tokenHash, bookingId, caller.requestId ?? null],
    );
    if (row.status !== 'ok') refuse(row.status, null);
    return row.detail!;
  }

  async caseAct(
    caller: StaffCaller,
    caseId: string,
    version: number,
    action: 'acknowledge' | 'action' | 'resolve',
    note: string | null,
  ) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_case_act($1, $2, $3, $4, $5, $6)',
      [caller.tokenHash, caseId, version, action, note, caller.requestId ?? null],
    );
    if (!['acknowledged', 'recorded', 'resolved'].includes(row.status))
      refuse(row.status, row.detail);
    return { outcome: row.status, case: row.detail };
  }

  async block(
    caller: StaffCaller,
    bookingId: string,
    block: boolean,
    reason: string | null,
    note: string,
  ) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_dispatch_block($1, $2, $3, $4, $5, $6)',
      [caller.tokenHash, bookingId, block, reason, note, caller.requestId ?? null],
    );
    if (row.status !== 'blocked' && row.status !== 'lifted') refuse(row.status, row.detail);
    return { outcome: row.status, booking: row.detail };
  }

  async hold(
    caller: StaffCaller,
    bookingId: string,
    hold: boolean,
    reason: string | null,
    note: string,
  ) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_trip_hold($1, $2, $3, $4, $5, $6)',
      [caller.tokenHash, bookingId, hold, reason, note, caller.requestId ?? null],
    );
    if (row.status !== 'held' && row.status !== 'resumed') refuse(row.status, row.detail);
    return { outcome: row.status, booking: row.detail };
  }

  async milestoneOnBehalf(
    caller: StaffCaller,
    bookingId: string,
    version: number,
    content: Detail,
  ) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_milestone_on_behalf($1, $2, $3, $4, $5)',
      [caller.tokenHash, bookingId, version, JSON.stringify(content), caller.requestId ?? null],
    );
    if (row.status !== 'recorded') refuse(row.status, row.detail);
    return { outcome: 'recorded', trip: row.detail };
  }

  async withdraw(caller: StaffCaller, bookingId: string, version: number, note: string) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_milestone_withdraw($1, $2, $3, $4, $5)',
      [caller.tokenHash, bookingId, version, note, caller.requestId ?? null],
    );
    if (row.status !== 'withdrawn') refuse(row.status, row.detail);
    return { outcome: 'withdrawn', trip: row.detail };
  }

  async delivery(caller: StaffCaller, bookingId: string, version: number, content: Detail) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_delivery_record($1, $2, $3, $4, $5)',
      [caller.tokenHash, bookingId, version, JSON.stringify(content), caller.requestId ?? null],
    );
    if (row.status !== 'recorded') refuse(row.status, row.detail);
    return { outcome: 'recorded', trip: row.detail };
  }

  async handover(caller: StaffCaller, bookingId: string, content: Detail) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_cargo_handover($1, $2, $3, $4)',
      [caller.tokenHash, bookingId, JSON.stringify(content), caller.requestId ?? null],
    );
    if (row.status !== 'recorded') refuse(row.status, row.detail);
    return { outcome: 'handed_over', trip: row.detail };
  }

  async release(
    caller: StaffCaller,
    bookingId: string,
    role: string,
    override: boolean,
    note: string | null,
  ) {
    const row = await this.run(
      'SELECT status, detail FROM trucker.staff_resource_release($1, $2, $3, $4, $5, $6)',
      [caller.tokenHash, bookingId, role, override, note, caller.requestId ?? null],
    );
    if (row.status !== 'released') refuse(row.status, row.detail);
    return { outcome: 'released', trip: row.detail };
  }
}
