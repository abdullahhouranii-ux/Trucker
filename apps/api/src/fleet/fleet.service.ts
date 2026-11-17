import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import type { StaffCaller } from '../staff/staff.service.js';
import { DB_POOL } from '../tokens.js';

/**
 * Fleet and drivers (db/migrations/0012_fleet.sql). A carrier company records trucks, trailers
 * and drivers; a driver joins by accepting an invitation in their own account; staff decide
 * ownership claims and documents. Ownership, operating control, document approval and
 * availability are separate: nothing here reserves, assigns or books anything. Every rule is
 * the database's; this service maps its answers to HTTP.
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
  not_carrier: [403, 'carrier_not_eligible', 'This organisation is not a verified carrier now.'],
  closed: [
    409,
    'fleet_closed',
    'Fleet records are not available here: no document or category register exists.',
  ],
  exists: [409, 'fleet_record_exists', 'This record already exists in your fleet.'],
  limit: [409, 'fleet_limit', 'A limit for fleet records has been reached.'],
  owner_limit: [
    409,
    'owner_fleet_limit',
    'A truck owner account holds one truck and one trailer. Retire the current one first.',
  ],
  owner_only: [
    409,
    'owner_is_only_driver',
    'The owner is the only driver of a truck owner account.',
  ],
  not_individual: [409, 'not_a_personal_account', 'Only a truck owner account can do this.'],
  affiliated_elsewhere: [
    409,
    'driver_affiliation_exists',
    'You already work with a carrier. Leave it before driving for your own account.',
  ],
  conflict: [
    409,
    'fleet_record_changed',
    'The record changed since it was opened. Nothing was changed.',
  ],
  key_conflict: [
    409,
    'retry_key_conflict',
    'This retry key was already used for a different request.',
  ],
  affiliation_exists: [
    409,
    'driver_affiliation_exists',
    'You already work with a carrier. Leave it before accepting another invitation.',
  ],
  not_affiliated: [409, 'driver_not_affiliated', 'You are not working with a carrier now.'],
  not_open: [409, 'fleet_decision_not_open', 'This is not waiting for a decision.'],
  ownership_conflict: [
    409,
    'ownership_conflict',
    'Another claim on this registration is already verified. This claim cannot be verified.',
  ],
};

function refuse(status: string, detail: unknown): never {
  if (status === 'invalid') {
    const problems = (Array.isArray(detail) ? detail : []) as { field: string; code: string }[];
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields: problems.map((problem) => problem.field),
      problems,
      ...(Array.isArray(detail) ? {} : ((detail as Detail | null) ?? {})),
    });
  }
  if (status === 'not_independent')
    throw new ApiError(
      409,
      'reviewer_not_independent',
      'You cannot decide this: your independence from the organisation is not established.',
      { reason: (detail as { reason?: string } | null)?.reason ?? 'unknown' },
    );
  const known = ERRORS[status] ?? ERRORS.not_found!;
  throw new ApiError(known[0], known[1], known[2]);
}

@Injectable()
export class FleetService {
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

  /** Runs one database function and maps anything but the listed outcomes to an error. */
  private async run(
    client: pg.PoolClient | pg.Pool,
    sql: string,
    values: unknown[],
    outcomes: Record<string, string>,
  ): Promise<{ outcome: string; detail: unknown }> {
    const result = await client.query<{ status: string; detail?: unknown }>(sql, values);
    const row = result.rows[0]!;
    const outcome = outcomes[row.status];
    if (outcome === undefined) refuse(row.status, row.detail ?? null);
    return { outcome, detail: row.detail ?? null };
  }

  // The carrier ------------------------------------------------------------------------------
  overview(caller: Caller, organisationId: string): Promise<Detail> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const { detail } = await this.run(
        client,
        'SELECT status, detail FROM trucker.fleet_overview($1)',
        [allowFixtures],
        { ok: 'ok' },
      );
      return detail as Detail;
    });
  }

  registerVehicle(caller: Caller, organisationId: string, key: string, input: Detail) {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const { outcome, detail } = await this.run(
        client,
        'SELECT status, detail FROM trucker.register_vehicle($1, $2, $3)',
        [key, JSON.stringify(input), allowFixtures],
        { registered: 'registered', repeated: 'already_registered' },
      );
      return { outcome, vehicle: detail };
    });
  }

  retireVehicle(
    caller: Caller,
    organisationId: string,
    vehicleId: string,
    version: number,
    key: string,
  ) {
    return this.asCaller(caller, organisationId, async (client) => {
      const { outcome } = await this.run(
        client,
        'SELECT status FROM trucker.retire_vehicle($1, $2, $3)',
        [vehicleId, version, key],
        { retired: 'retired', already_retired: 'already_retired' },
      );
      return { outcome };
    });
  }

  submitVehicleDocument(
    caller: Caller,
    organisationId: string,
    vehicleId: string,
    key: string,
    input: Detail,
  ) {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const { outcome } = await this.run(
        client,
        'SELECT status, detail FROM trucker.submit_vehicle_document($1, $2, $3, $4)',
        [vehicleId, key, JSON.stringify(input), allowFixtures],
        { submitted: 'submitted', repeated: 'already_submitted' },
      );
      return { outcome };
    });
  }

  inviteDriver(caller: Caller, organisationId: string, key: string, phone: string) {
    return this.asCaller(caller, organisationId, async (client) => {
      const { outcome } = await this.run(
        client,
        'SELECT status, detail FROM trucker.invite_driver($1, $2)',
        [key, JSON.stringify({ phone })],
        { invited: 'invited', repeated: 'already_invited' },
      );
      return { outcome };
    });
  }

  /** The owner of a truck owner account becomes its driver. */
  becomeOwnDriver(caller: Caller, organisationId: string) {
    return this.asCaller(caller, organisationId, async (client) => {
      const { outcome } = await this.run(
        client,
        'SELECT status FROM trucker.become_own_driver()',
        [],
        {
          affiliated: 'affiliated',
          exists: 'already_affiliated',
        },
      );
      return { outcome };
    });
  }

  endAffiliation(caller: Caller, organisationId: string, id: string, version: number, key: string) {
    return this.asCaller(caller, organisationId, async (client) => {
      const { outcome } = await this.run(
        client,
        'SELECT status FROM trucker.end_driver_affiliation($1, $2, $3)',
        [id, version, key],
        { ended: 'ended', already_ended: 'already_ended' },
      );
      return { outcome };
    });
  }

  setAuthorisation(
    caller: Caller,
    organisationId: string,
    affiliationId: string,
    key: string,
    input: { vehicleId: string | null; granted: boolean },
  ) {
    return this.asCaller(caller, organisationId, async (client) => {
      const { outcome } = await this.run(
        client,
        'SELECT status FROM trucker.set_driver_authorisation($1, $2, $3)',
        [affiliationId, key, JSON.stringify(input)],
        { changed: 'changed', unchanged: 'unchanged' },
      );
      return { outcome };
    });
  }

  // The driver -------------------------------------------------------------------------------
  driverOverview(caller: Caller): Promise<Detail> {
    return this.asCaller(caller, '', async (client, allowFixtures) => {
      const { detail } = await this.run(
        client,
        'SELECT status, detail FROM trucker.driver_overview($1)',
        [allowFixtures],
        { ok: 'ok' },
      );
      return detail as Detail;
    });
  }

  respond(
    caller: Caller,
    id: string,
    version: number,
    key: string,
    decision: 'accept' | 'decline',
  ) {
    return this.asCaller(caller, '', async (client) => {
      const { outcome } = await this.run(
        client,
        'SELECT status FROM trucker.respond_driver_invitation($1, $2, $3, $4)',
        [id, version, key, decision],
        { accepted: 'accepted', declined: 'declined', already_answered: 'already_answered' },
      );
      return { outcome };
    });
  }

  leave(caller: Caller, id: string, version: number, key: string) {
    return this.asCaller(caller, '', async (client) => {
      const { outcome } = await this.run(
        client,
        'SELECT status FROM trucker.leave_driver_affiliation($1, $2, $3)',
        [id, version, key],
        { ended: 'ended', already_ended: 'already_ended' },
      );
      return { outcome };
    });
  }

  submitDriverDocument(caller: Caller, key: string, input: Detail) {
    return this.asCaller(caller, '', async (client, allowFixtures) => {
      const { outcome } = await this.run(
        client,
        'SELECT status, detail FROM trucker.submit_driver_document($1, $2, $3)',
        [key, JSON.stringify(input), allowFixtures],
        { submitted: 'submitted', repeated: 'already_submitted' },
      );
      return { outcome };
    });
  }

  // Staff ------------------------------------------------------------------------------------
  async staffQueue(caller: StaffCaller): Promise<Detail> {
    const { detail } = await this.run(
      this.pool,
      'SELECT status, detail FROM trucker.staff_fleet_queue($1, $2)',
      [caller.tokenHash, caller.requestId ?? null],
      { ok: 'ok' },
    );
    return detail as Detail;
  }

  async staffDecide(
    caller: StaffCaller,
    subject: 'ownership' | 'document',
    id: string,
    input: { version: number; decision: string; reason: string; noConflict: boolean },
  ) {
    const fn =
      subject === 'ownership' ? 'staff_decide_vehicle_ownership' : 'staff_decide_fleet_document';
    const { outcome } = await this.run(
      this.pool,
      `SELECT status, detail FROM trucker.${fn}($1, $2, $3, $4, $5, $6, $7)`,
      [
        caller.tokenHash,
        id,
        input.version,
        input.decision,
        input.reason,
        input.noConflict,
        caller.requestId ?? null,
      ],
      { decided: 'decided', repeated: 'already_decided' },
    );
    return { outcome };
  }

  async staffSuspend(
    caller: StaffCaller,
    input: { subject: 'vehicle' | 'driver'; id: string; suspended: boolean; reason: string | null },
  ) {
    const { outcome } = await this.run(
      this.pool,
      'SELECT status FROM trucker.staff_set_fleet_suspension($1, $2, $3, $4, $5, $6)',
      [
        caller.tokenHash,
        input.subject,
        input.id,
        input.suspended,
        input.reason,
        caller.requestId ?? null,
      ],
      { changed: 'changed', unchanged: 'unchanged' },
    );
    return { outcome };
  }
}
