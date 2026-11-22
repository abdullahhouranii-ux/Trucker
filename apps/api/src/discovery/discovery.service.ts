import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';

/**
 * Discovery, for a verified carrier (db/migrations/0009_carrier_discovery.sql). The database
 * decides at every request whether the caller may discover and which shipments it may see,
 * after its locks and with its own clock. Nothing is cached here: a cursor is a position in a
 * list, never a permission, and every page is judged again.
 *
 * What a carrier sees is the slice 10 projection and the shipment's identifier, nothing else.
 * The countries and equipment types used for matching are what the carrier declared and staff
 * decided: matching criteria, not verified vehicles, availability or permission to accept work.
 */

export interface Caller {
  readonly personId: string;
  readonly tokenHash: string;
  readonly requestId?: string | undefined;
}
export interface DiscoveryFilter {
  readonly pickupCountry?: string;
  readonly deliveryCountry?: string;
  readonly equipmentType?: string;
}
export interface DeclaredService {
  readonly kind: 'declared_matching_criteria';
  readonly countries: string[];
  readonly equipmentTypes: string[];
}
export interface DiscoveryItem {
  readonly id: string;
  /** The carrier projection of the latest published version (slice 10, PB-4). */
  readonly shipment: Record<string, unknown>;
  /** A newer version was published after this list was started (its position is kept). */
  readonly changedSinceStart: boolean;
}
export interface DiscoveryPage {
  readonly items: DiscoveryItem[];
  /** Opaque. Send it back, with the same filter, for the next page. */
  readonly next: string | null;
  readonly startedAt: string;
  readonly service: DeclaredService;
}

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', 'The requested resource was not found.');

/** A refusal every discovery answer shares. */
function refuse(status: string, detail: unknown): never {
  switch (status) {
    case 'unauthorized':
      throw new ApiError(401, 'unauthorized', 'Authentication is required.');
    case 'not_carrier':
      throw new ApiError(
        403,
        'carrier_not_eligible',
        'This organisation is not a verified carrier, so it cannot discover shipments.',
      );
    case 'rate_limited':
      throw new ApiError(
        429,
        'too_many_requests',
        'Too many discovery requests in the last minute. Wait a moment and try again.',
      );
    case 'invalid':
      throw new ApiError(422, 'validation_failed', 'Some filters are not valid.', {
        fields: [(detail as { field?: string } | null)?.field ?? 'filter'],
      });
    case 'cursor_invalid':
      throw new ApiError(
        400,
        'cursor_invalid',
        'This position in the list belongs to a different list. Start the list again.',
      );
    case 'cursor_expired':
      throw new ApiError(
        409,
        'cursor_expired',
        'This list was started too long ago. Start the list again.',
      );
    default:
      throw notFound();
  }
}

export const encodeCursor = (next: unknown): string =>
  Buffer.from(JSON.stringify(next), 'utf8').toString('base64url');
export function decodeCursor(cursor: string): unknown {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    return { v: 'unreadable' };
  }
}

@Injectable()
export class DiscoveryService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
  ) {}

  /** One transaction as the caller. Refusals are kept: the access log records them. */
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

  /** Whether the organisation may discover now, and the declared service in force. */
  status(
    caller: Caller,
    organisationId: string,
  ): Promise<{ mayDiscover: boolean; service: DeclaredService }> {
    return this.asCaller(caller, organisationId, async (client) => {
      const result = await client.query<{ status: string; detail: DeclaredService }>(
        'SELECT status, detail FROM trucker.discovery_status()',
      );
      const row = result.rows[0]!;
      if (row.status === 'unauthorized') refuse(row.status, null);
      if (row.status === 'not_found') throw notFound();
      return { mayDiscover: row.status === 'ok', service: row.detail };
    });
  }

  list(
    caller: Caller,
    organisationId: string,
    filter: DiscoveryFilter,
    cursor: string | null,
  ): Promise<DiscoveryPage> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{
        status: string;
        detail: {
          items: DiscoveryItem[];
          next: unknown;
          startedAt: string;
          service: DeclaredService;
        } | null;
      }>('SELECT status, detail FROM trucker.discover_shipments($1::jsonb, $2::jsonb, $3)', [
        JSON.stringify(filter),
        cursor === null ? null : JSON.stringify(decodeCursor(cursor)),
        allowFixtures,
      ]);
      const row = result.rows[0]!;
      if (row.status !== 'ok' || !row.detail) refuse(row.status, row.detail);
      return {
        items: row.detail.items,
        next: row.detail.next ? encodeCursor(row.detail.next) : null,
        startedAt: new Date(row.detail.startedAt).toISOString(),
        service: row.detail.service,
      };
    });
  }

  detail(caller: Caller, organisationId: string, shipmentId: string): Promise<DiscoveryItem> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{
        status: string;
        detail: { id: string; shipment: Record<string, unknown> } | null;
      }>('SELECT status, detail FROM trucker.discover_shipment($1, $2)', [
        shipmentId,
        allowFixtures,
      ]);
      const row = result.rows[0]!;
      if (row.status !== 'ok' || !row.detail) refuse(row.status, row.detail);
      return { ...row.detail, changedSinceStart: false };
    });
  }
}
