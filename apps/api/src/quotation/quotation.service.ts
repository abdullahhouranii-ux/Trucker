import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';

/**
 * Quotations (db/migrations/0010_quotations.sql). A carrier that can discover a shipment
 * quotes an exact amount in the shipment's currency, answers every inclusion of the shipment's
 * terms, and gives a validity and the earliest pick-up it can meet. The shipper compares and may
 * reject. Nothing is accepted, booked, invoiced or paid, and no fee exists. Every rule is the
 * database's; this service maps its answers to HTTP.
 */

export interface Caller {
  readonly personId: string;
  readonly tokenHash: string;
  readonly requestId?: string | undefined;
}
export interface WindowInput {
  readonly local: string;
  readonly offsetMinutes?: number | undefined;
}
export interface QuotationInput {
  readonly amount: string;
  readonly inclusions: Record<string, boolean>;
  readonly validUntil: WindowInput;
  readonly earliestPickup: WindowInput;
  readonly notes: string | null;
  readonly commissionAccepted?: { readonly commission: string; readonly net: string };
}
export type QuotationView = Record<string, unknown> & { id: string };

const ERRORS: Record<string, [number, string, string]> = {
  unauthorized: [401, 'unauthorized', 'Authentication is required.'],
  not_found: [404, 'not_found', 'The requested resource was not found.'],
  not_carrier: [403, 'carrier_not_eligible', 'This organisation is not a verified carrier now.'],
  not_eligible: [
    403,
    'carrier_not_eligible',
    'This organisation may not quote for this shipment now: its carrier capability or declared service does not cover it.',
  ],
  rate_limited: [
    429,
    'too_many_requests',
    'Too many requests in the last minute. Try again shortly.',
  ],
  terms_missing: [
    409,
    'quotation_terms_missing',
    'The shipper has not set the currency and inclusions for quotations yet.',
  ],
  exists: [
    409,
    'quotation_exists',
    'This organisation already has an open quotation for this shipment.',
  ],
  limit: [409, 'quotation_limit', 'A limit for quotations has been reached.'],
  not_open: [409, 'quotation_not_open', 'This quotation is no longer open.'],
  suspended: [
    409,
    'shipment_suspended',
    'The shipment is suspended. Its quotations cannot be changed until it resumes; they still expire on time.',
  ],
  conflict: [
    409,
    'quotation_changed',
    'The quotation changed since it was opened. Nothing was changed.',
  ],
  not_needed: [409, 'reconfirmation_not_needed', 'This quotation does not need to be reconfirmed.'],
  revise_required: [
    409,
    'revision_required',
    'The shipment changed so that this quotation no longer fits it. Revise it instead.',
  ],
  locked: [
    409,
    'quotation_terms_locked',
    'The currency and inclusions cannot change once a quotation exists.',
  ],
  closed: [
    409,
    'quotation_terms_closed',
    'Quotations are not available here: no currency or inclusion register exists.',
  ],
  key_conflict: [
    409,
    'retry_key_conflict',
    'This retry key was already used for a different request.',
  ],
  not_open_shipment: [
    409,
    'shipment_not_open',
    'Quotation terms can be set only on an open shipment.',
  ],
};

/**
 * Runs a command that writes a quotation version. What the carrier accepted of the commission
 * is given to the database for this transaction only; the database refuses the version unless
 * it is exactly what follows from the price. The acceptance is not part of the quotation's
 * content, so a retry of the same quotation is recognised whether or not it repeats it.
 */
async function withCommission<T>(
  client: pg.PoolClient,
  input: QuotationInput,
  work: (content: Omit<QuotationInput, 'commissionAccepted'>) => Promise<T>,
): Promise<T> {
  const { commissionAccepted, ...content } = input;
  await client.query("SELECT set_config('trucker.commission_accepted', $1, true)", [
    commissionAccepted ? `${commissionAccepted.commission}|${commissionAccepted.net}` : '',
  ]);
  try {
    return await work(content);
  } catch (error) {
    const { code, detail } = error as { code?: string; detail?: string };
    if (code === 'TR010') {
      const [commission, net] = (detail ?? '').split('|');
      throw new ApiError(
        409,
        'commission_acceptance_required',
        'This shipment carries an organiser commission. Accept the commission and your net earnings to send the quotation.',
        { commission, net },
      );
    }
    if (code === 'TR011')
      throw new ApiError(
        409,
        'commission_currency',
        'The organiser commission is a fixed amount in another currency. Quote in that currency.',
        { currency: detail },
      );
    if (code === 'TR012')
      throw new ApiError(
        409,
        'commission_leaves_nothing',
        'The price does not cover the organiser commission.',
      );
    throw error;
  }
}

function refuse(status: string, detail: unknown): never {
  if (status === 'invalid') {
    const problems = (Array.isArray(detail) ? detail : []) as { field: string; code: string }[];
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields: problems.map((problem) => problem.field),
      problems,
    });
  }
  const known = ERRORS[status] ?? ERRORS.not_found!;
  throw new ApiError(
    known[0],
    known[1],
    known[2],
    status === 'limit' ? (detail as Record<string, unknown>) : undefined,
  );
}

@Injectable()
export class QuotationService {
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

  private async mine(client: pg.PoolClient, allowFixtures: boolean): Promise<QuotationView[]> {
    const result = await client.query<{ status: string; detail: QuotationView[] }>(
      'SELECT status, detail FROM trucker.my_quotations($1)',
      [allowFixtures],
    );
    const row = result.rows[0]!;
    if (row.status !== 'ok') refuse(row.status, null);
    return row.detail;
  }
  private async one(client: pg.PoolClient, allowFixtures: boolean, id: string) {
    const found = (await this.mine(client, allowFixtures)).find((item) => item.id === id);
    if (!found) refuse('not_found', null);
    return found;
  }

  // ------------------------------------------------------------------------------------------
  // The carrier
  // ------------------------------------------------------------------------------------------
  context(caller: Caller, organisationId: string, shipmentId: string) {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: Record<string, unknown> }>(
        'SELECT status, detail FROM trucker.quotation_context($1, $2)',
        [shipmentId, allowFixtures],
      );
      const row = result.rows[0]!;
      if (row.status !== 'ok') refuse(row.status, null);
      return row.detail;
    });
  }

  list(caller: Caller, organisationId: string): Promise<QuotationView[]> {
    return this.asCaller(caller, organisationId, (client, allowFixtures) =>
      this.mine(client, allowFixtures),
    );
  }

  submit(
    caller: Caller,
    organisationId: string,
    shipmentId: string,
    retryKey: string,
    input: QuotationInput,
  ): Promise<{ outcome: 'submitted' | 'already_submitted'; quotation: QuotationView }> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await withCommission(client, input, (content) =>
        client.query<{
          status: string;
          quotation_id: string | null;
          detail: unknown;
        }>(
          'SELECT status, quotation_id, detail FROM trucker.submit_quotation($1, $2, $3::jsonb, $4)',
          [shipmentId, retryKey, JSON.stringify(content), allowFixtures],
        ),
      );
      const row = result.rows[0]!;
      if (row.status !== 'submitted' && row.status !== 'repeated') refuse(row.status, row.detail);
      return {
        outcome: row.status === 'submitted' ? 'submitted' : 'already_submitted',
        quotation: await this.one(client, allowFixtures, row.quotation_id!),
      };
    });
  }

  revise(
    caller: Caller,
    organisationId: string,
    quotationId: string,
    retryKey: string,
    version: number,
    input: QuotationInput,
  ): Promise<{ outcome: 'revised' | 'already_revised'; quotation: QuotationView }> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await withCommission(client, input, (content) =>
        client.query<{ status: string; detail: unknown }>(
          'SELECT status, detail FROM trucker.revise_quotation($1, $2, $3, $4::jsonb, $5)',
          [quotationId, version, retryKey, JSON.stringify(content), allowFixtures],
        ),
      );
      const row = result.rows[0]!;
      if (row.status !== 'revised' && row.status !== 'repeated') refuse(row.status, row.detail);
      return {
        outcome: row.status === 'revised' ? 'revised' : 'already_revised',
        quotation: await this.one(client, allowFixtures, quotationId),
      };
    });
  }

  reconfirm(
    caller: Caller,
    organisationId: string,
    quotationId: string,
    retryKey: string,
    version: number,
  ): Promise<{ outcome: 'reconfirmed' | 'already_reconfirmed'; quotation: QuotationView }> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: unknown }>(
        'SELECT status, detail FROM trucker.reconfirm_quotation($1, $2, $3, $4)',
        [quotationId, version, retryKey, allowFixtures],
      );
      const row = result.rows[0]!;
      if (row.status !== 'reconfirmed' && row.status !== 'repeated') refuse(row.status, row.detail);
      return {
        outcome: row.status === 'reconfirmed' ? 'reconfirmed' : 'already_reconfirmed',
        quotation: await this.one(client, allowFixtures, quotationId),
      };
    });
  }

  withdraw(
    caller: Caller,
    organisationId: string,
    quotationId: string,
    retryKey: string,
    version: number,
  ): Promise<{ outcome: 'withdrawn' | 'already_withdrawn'; quotation: QuotationView }> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string }>(
        'SELECT status FROM trucker.withdraw_quotation($1, $2, $3)',
        [quotationId, version, retryKey],
      );
      const row = result.rows[0]!;
      if (row.status !== 'withdrawn' && row.status !== 'repeated') refuse(row.status, null);
      return {
        outcome: row.status === 'withdrawn' ? 'withdrawn' : 'already_withdrawn',
        quotation: await this.one(client, allowFixtures, quotationId),
      };
    });
  }

  // ------------------------------------------------------------------------------------------
  // The shipper
  // ------------------------------------------------------------------------------------------
  private async forShipment(client: pg.PoolClient, allowFixtures: boolean, shipmentId: string) {
    const result = await client.query<{ status: string; detail: Record<string, unknown> }>(
      'SELECT status, detail FROM trucker.shipment_quotations($1, $2)',
      [shipmentId, allowFixtures],
    );
    const row = result.rows[0]!;
    if (row.status !== 'ok') refuse(row.status, null);
    return row.detail;
  }

  shipmentQuotations(caller: Caller, organisationId: string, shipmentId: string) {
    return this.asCaller(caller, organisationId, (client, allowFixtures) =>
      this.forShipment(client, allowFixtures, shipmentId),
    );
  }

  setTerms(
    caller: Caller,
    organisationId: string,
    shipmentId: string,
    retryKey: string,
    version: number,
    currency: string,
  ) {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; detail: unknown }>(
        'SELECT status, detail FROM trucker.set_quotation_terms($1, $2, $3, $4::jsonb, $5)',
        [shipmentId, version, retryKey, JSON.stringify({ currency }), allowFixtures],
      );
      const row = result.rows[0]!;
      if (row.status !== 'set' && row.status !== 'repeated')
        refuse(row.status === 'not_open' ? 'not_open_shipment' : row.status, row.detail);
      return {
        outcome: row.status === 'set' ? 'set' : 'already_set',
        quotations: await this.forShipment(client, allowFixtures, shipmentId),
      };
    });
  }

  reject(
    caller: Caller,
    organisationId: string,
    quotationId: string,
    retryKey: string,
    version: number,
  ) {
    return this.asCaller(caller, organisationId, async (client) => {
      const result = await client.query<{ status: string }>(
        'SELECT status FROM trucker.reject_quotation($1, $2, $3)',
        [quotationId, version, retryKey],
      );
      const row = result.rows[0]!;
      if (row.status !== 'rejected' && row.status !== 'repeated') refuse(row.status, null);
      return { outcome: row.status === 'rejected' ? 'rejected' : 'already_rejected' };
    });
  }
}
