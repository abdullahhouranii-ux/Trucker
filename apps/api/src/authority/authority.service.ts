import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';

/** Who is asking, as the database will verify it: the hash of the bearer token. */
export interface Caller {
  readonly personId: string;
  readonly tokenHash: string;
  readonly requestId: string | undefined;
}
type Detail = Record<string, unknown>;

const ERRORS: Record<string, [number, string, string]> = {
  unauthorized: [401, 'unauthorized', 'Authentication is required.'],
  not_found: [404, 'not_found', 'The requested resource was not found.'],
  not_organiser: [403, 'organiser_not_eligible', 'This account is not a verified organiser now.'],
  // The same answer whether the code names nothing, this account, or an unverified account.
  no_account: [404, 'account_code_not_found', 'No account can be asked with this code.'],
  conflict: [409, 'record_changed', 'The record changed since it was opened. Nothing was changed.'],
  not_draft: [
    409,
    'shipment_roles_fixed',
    'The roles of a shipment are fixed once it has been published.',
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
  throw new ApiError(known[0], known[1], known[2]);
}

/**
 * Authority from a customer to an organiser, and the roles of a shipment. Every rule is the
 * database's; this only carries the request to it and names the outcome.
 */
@Injectable()
export class AuthorityService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
  ) {}

  /** One transaction as the caller. Definite refusals are kept, so their records persist. */
  private async run(
    caller: Caller,
    organisationId: string,
    sql: string,
    values: unknown[],
    outcomes: Record<string, string>,
  ): Promise<{ outcome: string; detail: unknown }> {
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
      const result = await client.query<{ status: string; detail?: unknown }>(sql, values);
      await client.query('COMMIT');
      const row = result.rows[0]!;
      const outcome = outcomes[row.status];
      if (outcome === undefined) refuse(row.status, row.detail ?? null);
      return { outcome, detail: row.detail ?? null };
    } catch (error) {
      if (!(error instanceof ApiError)) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async overview(caller: Caller, organisationId: string): Promise<Detail> {
    const { detail } = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.authority_overview()',
      [],
      { ok: 'ok' },
    );
    return detail as Detail;
  }

  async request(caller: Caller, organisationId: string, code: string) {
    const { outcome, detail } = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.request_authority($1)',
      [code],
      { requested: 'requested', exists: 'already_requested' },
    );
    return { outcome, authority: detail };
  }

  async decide(caller: Caller, organisationId: string, id: string, version: number, body: Detail) {
    const { outcome, detail } = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.decide_authority($1, $2, $3)',
      [id, version, JSON.stringify(body)],
      { accepted: 'accepted', declined: 'declined', already_decided: 'already_decided' },
    );
    return { outcome, authority: detail };
  }

  async end(caller: Caller, organisationId: string, id: string, version: number) {
    const { outcome, detail } = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.end_authority($1, $2)',
      [id, version],
      { ended: 'ended', already_ended: 'already_ended' },
    );
    return { outcome, authority: detail };
  }

  async parties(caller: Caller, organisationId: string, shipmentId: string): Promise<Detail> {
    const { detail } = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.shipment_parties($1)',
      [shipmentId],
      { ok: 'ok' },
    );
    return detail as Detail;
  }

  async setCommission(
    caller: Caller,
    organisationId: string,
    shipmentId: string,
    version: number,
    body: Detail,
  ) {
    const { detail } = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.set_shipment_commission($1, $2, $3)',
      [shipmentId, version, JSON.stringify(body)],
      { saved: 'saved' },
    );
    return { outcome: 'saved', commission: detail };
  }

  /** The commission terms of a shipment, and the figures for a price when one is given. */
  async commissionTerms(
    caller: Caller,
    organisationId: string,
    shipmentId: string,
    amount: string,
    currency: string,
  ): Promise<Detail> {
    const { detail } = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.shipment_commission_terms($1, $2, $3)',
      [shipmentId, amount, currency],
      { ok: 'ok' },
    );
    return detail as Detail;
  }

  async commissions(caller: Caller, organisationId: string): Promise<Detail> {
    const { detail } = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.commission_overview()',
      [],
      { ok: 'ok' },
    );
    return detail as Detail;
  }

  async setParties(
    caller: Caller,
    organisationId: string,
    shipmentId: string,
    version: number,
    body: Detail,
  ) {
    const { detail } = await this.run(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.set_shipment_parties($1, $2, $3)',
      [shipmentId, version, JSON.stringify(body)],
      { saved: 'saved' },
    );
    return { outcome: 'saved', parties: detail };
  }
}
