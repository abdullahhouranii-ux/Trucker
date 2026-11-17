import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import type { StaffCaller } from '../staff/staff.service.js';
import { DB_POOL } from '../tokens.js';

/**
 * Acceptance and booking (db/migrations/0013_bookings.sql). The shipper's administrator accepts
 * one exact quotation version; one booking is created with an immutable snapshot of price, fee
 * and terms. A booking starts as "awaiting resources": nothing here assigns, reserves or
 * confirms. Commercial values are development defaults. Every rule is the database's.
 */

export interface Caller {
  readonly personId: string;
  readonly tokenHash: string;
  readonly requestId?: string | undefined;
}
type Detail = Record<string, unknown>;

const ERRORS: Record<string, [number, string, string]> = {
  unauthorized: [401, 'unauthorized', 'Authentication is required.'],
  forbidden: [
    403,
    'staff_privilege_required',
    'Your account does not hold the privilege this needs.',
  ],
  not_found: [404, 'not_found', 'The requested resource was not found.'],
  closed: [
    409,
    'booking_closed',
    'Acceptance is not available here: the commercial terms are not approved for this environment.',
  ],
  already_awarded: [409, 'shipment_already_awarded', 'This shipment is already awarded.'],
  shipment_not_open: [409, 'shipment_not_open', 'This shipment is not open for acceptance.'],
  not_open: [409, 'quotation_not_open', 'This quotation is no longer open.'],
  conflict: [
    409,
    'quotation_changed',
    'The quotation changed since it was opened. Nothing was accepted.',
  ],
  reconfirmation_needed: [
    409,
    'quotation_needs_reconfirmation',
    'The shipment changed after this quotation was made. The carrier must confirm or revise it first.',
  ],
  carrier_not_eligible: [
    409,
    'quotation_carrier_not_eligible',
    'The carrier may not carry this shipment now, so its quotation cannot be accepted.',
  ],
  shipment_suspended: [
    409,
    'shipment_suspended',
    'The shipment is suspended. Nothing can be accepted.',
  ],
  assignment_deadline_passed: [
    409,
    'assignment_deadline_passed',
    'The pick-up is too soon: the time the carrier needs to assign resources has already passed. No booking was created.',
  ],
  key_conflict: [
    409,
    'retry_key_conflict',
    'This retry key was already used for a different request.',
  ],
};
function refuse(status: string): never {
  const known = ERRORS[status] ?? ERRORS.not_found!;
  throw new ApiError(known[0], known[1], known[2]);
}

@Injectable()
export class BookingService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
  ) {}

  /** One transaction as the caller. Definite refusals are kept: an expiry found is recorded. */
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

  accept(
    caller: Caller,
    organisationId: string,
    quotationId: string,
    version: number,
    key: string,
    freightMethod: string | null,
  ) {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: Detail }>(
        'SELECT status, detail FROM trucker.accept_quotation($1, $2, $3, $4, $5)',
        [quotationId, version, key, freightMethod, allowFixtures],
      );
      const row = result.rows[0]!;
      if (row.status === 'freight_method') {
        const problems = (Array.isArray(row.detail) ? row.detail : []) as {
          field: string;
          code: string;
        }[];
        throw new ApiError(
          422,
          'validation_failed',
          'Choose how the freight will be paid, from the methods this quotation offers.',
          { fields: ['freightMethod'], problems },
        );
      }
      if (row.status === 'accepted') return { outcome: 'accepted', booking: row.detail };
      if (row.status === 'repeated') return { outcome: 'already_accepted', booking: row.detail };
      return refuse(row.status);
    });
  }

  overview(caller: Caller, organisationId: string, shipmentId: string): Promise<Detail> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: Detail }>(
        'SELECT status, detail FROM trucker.booking_overview($1, $2)',
        [shipmentId, allowFixtures],
      );
      const row = result.rows[0]!;
      if (row.status !== 'ok') refuse(row.status);
      return row.detail;
    });
  }

  list(caller: Caller, organisationId: string): Promise<Detail[]> {
    return this.asCaller(caller, organisationId, async (client) => {
      const result = await client.query<{ status: string; detail: Detail[] }>(
        'SELECT status, detail FROM trucker.organisation_bookings()',
      );
      const row = result.rows[0]!;
      if (row.status !== 'ok') refuse(row.status);
      return row.detail;
    });
  }

  async staffBooking(caller: StaffCaller, shipmentId: string): Promise<Detail> {
    const result = await this.pool.query<{ status: string; detail: Detail }>(
      'SELECT status, detail FROM trucker.staff_shipment_booking($1, $2, $3)',
      [caller.tokenHash, shipmentId, caller.requestId ?? null],
    );
    const row = result.rows[0]!;
    if (row.status !== 'ok') refuse(row.status);
    return row.detail;
  }
}
