import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';

/**
 * Shipment drafts: private to one organisation, never published. The API's database role may
 * read drafts of the organisation a request selected and may write nothing: creating,
 * changing and discarding are database functions (db/migrations/0005_shipment_drafts.sql)
 * that establish for themselves who is asking, take their locks, read the database's clock
 * and only then decide. Limits, the page size and the time are the database's; nothing sent
 * from here can loosen them.
 */

export interface Caller {
  readonly personId: string;
  readonly tokenHash: string;
  readonly requestId?: string | undefined;
}

export interface WindowEndInput {
  readonly local: string | null;
  readonly offsetMinutes: number | null;
}
export interface PlaceInput {
  readonly address: string | null;
  readonly countryCode: string | null;
  readonly timeZone: string | null;
  readonly accessNotes: string | null;
  readonly from: WindowEndInput;
  readonly until: WindowEndInput;
}
export interface ShipmentInput {
  readonly shipperReference: string | null;
  readonly cargoDescription: string | null;
  /** Kilograms, as a decimal string, so that no rounding happens on the way. */
  readonly grossWeightKg: string | null;
  readonly pieces: string | null;
  readonly packaging: string | null;
  readonly equipmentNeeded: string | null;
  readonly pickup: PlaceInput;
  readonly delivery: PlaceInput;
}

export interface WindowEndView {
  /** The wall-clock time as typed, `YYYY-MM-DDTHH:MM`. */
  readonly local: string | null;
  /** Offset from UTC in minutes at that time in the place's zone; null when not resolved. */
  readonly offsetMinutes: number | null;
  /** The instant, when the place has a zone and the time resolves there. */
  readonly at: string | null;
  /** Both offsets, when this time occurs twice in the place's zone; otherwise null. */
  readonly offsetChoices: number[] | null;
}
export interface PlaceView {
  readonly address: string | null;
  readonly countryCode: string | null;
  readonly timeZone: string | null;
  readonly accessNotes: string | null;
  readonly from: WindowEndView;
  readonly until: WindowEndView;
}
export interface RouteView {
  readonly status: 'unknown' | 'open' | 'closed';
  /** Always `configuration`: configured availability only, not legal clearance. */
  readonly basis: 'configuration';
  readonly transit: string[];
  readonly reasons: {
    part: 'origin' | 'destination' | 'lane' | 'transit';
    code: string;
    country?: string;
    position?: number;
  }[];
}
export interface ShipmentView {
  readonly id: string;
  readonly status: 'draft' | 'discarded';
  readonly version: number;
  readonly shipperReference: string | null;
  readonly cargoDescription: string | null;
  readonly grossWeightKg: string | null;
  readonly pieces: number | null;
  readonly packaging: string | null;
  readonly equipmentNeeded: string | null;
  readonly pickup: PlaceView;
  readonly delivery: PlaceView;
  readonly route: RouteView;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly discardedAt: string | null;
}
export interface ShipmentSummary {
  readonly id: string;
  readonly status: 'draft' | 'discarded';
  readonly version: number;
  readonly shipperReference: string | null;
  readonly cargoDescription: string | null;
  readonly pickupCountry: string | null;
  readonly deliveryCountry: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface PlaceOption {
  readonly code: string;
  readonly name: { en: string; ar: string; ur: string };
  readonly fixture: boolean;
  readonly timeZones: string[];
}
export interface HistoryEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly actorPersonId: string;
  readonly requestId: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

interface DraftRow {
  id: string;
  status: 'draft' | 'discarded';
  version: number;
  shipper_reference: string | null;
  cargo_description: string | null;
  gross_weight_kg: string | null;
  pieces: number | null;
  packaging: string | null;
  equipment_needed: string | null;
  pickup_address: string | null;
  pickup_country: string | null;
  pickup_time_zone: string | null;
  pickup_access_notes: string | null;
  pickup_from_local: string | null;
  pickup_from_offset_minutes: number | null;
  pickup_from_at: Date | null;
  pickup_until_local: string | null;
  pickup_until_offset_minutes: number | null;
  pickup_until_at: Date | null;
  delivery_address: string | null;
  delivery_country: string | null;
  delivery_time_zone: string | null;
  delivery_access_notes: string | null;
  delivery_from_local: string | null;
  delivery_from_offset_minutes: number | null;
  delivery_from_at: Date | null;
  delivery_until_local: string | null;
  delivery_until_offset_minutes: number | null;
  delivery_until_at: Date | null;
  created_at: Date;
  updated_at: Date;
  discarded_at: Date | null;
  route: RouteView;
  choices: Record<string, number[]>;
}

const LOCAL = `'YYYY-MM-DD"T"HH24:MI'`;
/** One draft with its route check, read under row security. $1 is the draft, $2 fixtures. */
const DRAFT = `
  SELECT d.id, d.status, d.version, d.shipper_reference, d.cargo_description,
         trim_scale(d.gross_weight_kg)::text AS gross_weight_kg, d.pieces, d.packaging,
         d.equipment_needed,
         d.pickup_address, d.pickup_country, d.pickup_time_zone, d.pickup_access_notes,
         to_char(d.pickup_from_local, ${LOCAL}) AS pickup_from_local,
         d.pickup_from_offset_minutes, d.pickup_from_at,
         to_char(d.pickup_until_local, ${LOCAL}) AS pickup_until_local,
         d.pickup_until_offset_minutes, d.pickup_until_at,
         d.delivery_address, d.delivery_country, d.delivery_time_zone, d.delivery_access_notes,
         to_char(d.delivery_from_local, ${LOCAL}) AS delivery_from_local,
         d.delivery_from_offset_minutes, d.delivery_from_at,
         to_char(d.delivery_until_local, ${LOCAL}) AS delivery_until_local,
         d.delivery_until_offset_minutes, d.delivery_until_at,
         d.created_at, d.updated_at, d.discarded_at,
         trucker.route_check(d.pickup_country, d.delivery_country, $2) AS route,
         trucker.offset_choices(d.id) AS choices
  FROM trucker.shipment_draft d WHERE d.id = $1`;

const end = (
  local: string | null,
  offset: number | null,
  at: Date | null,
  choices: number[] | null,
): WindowEndView => ({
  local,
  offsetMinutes: offset,
  at: at ? at.toISOString() : null,
  offsetChoices: choices,
});

const view = (row: DraftRow): ShipmentView => ({
  id: row.id,
  status: row.status,
  version: row.version,
  shipperReference: row.shipper_reference,
  cargoDescription: row.cargo_description,
  grossWeightKg: row.gross_weight_kg,
  pieces: row.pieces,
  packaging: row.packaging,
  equipmentNeeded: row.equipment_needed,
  pickup: {
    address: row.pickup_address,
    countryCode: row.pickup_country,
    timeZone: row.pickup_time_zone,
    accessNotes: row.pickup_access_notes,
    from: end(
      row.pickup_from_local,
      row.pickup_from_offset_minutes,
      row.pickup_from_at,
      row.choices['pickup.from'] ?? null,
    ),
    until: end(
      row.pickup_until_local,
      row.pickup_until_offset_minutes,
      row.pickup_until_at,
      row.choices['pickup.until'] ?? null,
    ),
  },
  delivery: {
    address: row.delivery_address,
    countryCode: row.delivery_country,
    timeZone: row.delivery_time_zone,
    accessNotes: row.delivery_access_notes,
    from: end(
      row.delivery_from_local,
      row.delivery_from_offset_minutes,
      row.delivery_from_at,
      row.choices['delivery.from'] ?? null,
    ),
    until: end(
      row.delivery_until_local,
      row.delivery_until_offset_minutes,
      row.delivery_until_at,
      row.choices['delivery.until'] ?? null,
    ),
  },
  route: row.route,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  discardedAt: row.discarded_at ? row.discarded_at.toISOString() : null,
});

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', 'The requested resource was not found.');
const unauthorized = (): ApiError =>
  new ApiError(401, 'unauthorized', 'Authentication is required.');
const keyConflict = (): ApiError =>
  new ApiError(
    409,
    'retry_key_conflict',
    'This retry key was already used for a different request.',
  );

interface Problem {
  field: string;
  code: string;
  offsets?: number[];
}
/** Problems found by the database, by field. The first entry of `fields` leads the summary. */
const invalid = (problems: Problem[]): ApiError =>
  new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
    fields: problems.map((problem) => problem.field),
    problems,
  });

@Injectable()
export class ShipmentService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
  ) {}

  /**
   * One transaction in which the database knows who is asking and for which organisation.
   * The settings are local to the transaction, so nothing is left on the pooled connection.
   */
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

  private async read(
    client: pg.PoolClient,
    id: string,
    allowFixtures: boolean,
  ): Promise<ShipmentView | undefined> {
    const found = await client.query<DraftRow>(DRAFT, [id, allowFixtures]);
    return found.rows[0] ? view(found.rows[0]) : undefined;
  }

  /** Countries a place may be in, with the time zones configured for each. */
  async placeOptions(caller: Caller, organisationId: string): Promise<PlaceOption[]> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const visible = await client.query('SELECT 1 FROM trucker.organisation WHERE id = $1', [
        organisationId,
      ]);
      if (visible.rowCount === 0) throw notFound();
      const found = await client.query<{
        code: string;
        name_en: string;
        name_ar: string;
        name_ur: string;
        fixture: boolean;
        zones: string[];
      }>(
        `SELECT c.code, c.name_en, c.name_ar, c.name_ur, c.fixture,
                coalesce((SELECT array_agg(z.zone_name ORDER BY z.zone_name)
                          FROM trucker.country_time_zone z WHERE z.country_code = c.code), '{}') AS zones
         FROM trucker.country c WHERE NOT c.fixture OR $1 ORDER BY c.code`,
        [allowFixtures],
      );
      return found.rows.map((row) => ({
        code: row.code,
        name: { en: row.name_en, ar: row.name_ar, ur: row.name_ur },
        fixture: row.fixture,
        timeZones: row.zones,
      }));
    });
  }

  /**
   * Creates a draft. Sent again with the same retry key and the same content, it answers
   * with the draft made the first time, read as it is now under the same access rules.
   */
  async create(
    caller: Caller,
    organisationId: string,
    retryKey: string,
    input: ShipmentInput,
  ): Promise<ShipmentView> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{
        status: string;
        draft_id: string | null;
        detail: unknown;
      }>('SELECT * FROM trucker.create_shipment_draft($1, $2::jsonb, $3)', [
        retryKey,
        JSON.stringify(input),
        allowFixtures,
      ]);
      const row = result.rows[0]!;
      switch (row.status) {
        case 'unauthorized':
          throw unauthorized();
        case 'not_found':
          throw notFound();
        case 'key_conflict':
          throw keyConflict();
        case 'invalid':
          throw invalid(row.detail as Problem[]);
        case 'limit':
          throw new ApiError(
            409,
            'shipment_limit_reached',
            'This organisation has as many open drafts as it may.',
            { limit: (row.detail as { limit: number }).limit },
          );
        default: {
          const draft = await this.read(client, row.draft_id!, allowFixtures);
          if (!draft) throw notFound();
          return draft;
        }
      }
    });
  }

  /**
   * One page of the organisation's drafts, in order of creation, newest first. That order
   * never changes, so a draft that is changed or discarded while the list is being read is
   * neither repeated nor skipped. `after` is the last draft of the page before.
   */
  async list(
    caller: Caller,
    organisationId: string,
    status: 'draft' | 'discarded' | 'all',
    after: string | null,
  ): Promise<{ shipments: ShipmentSummary[]; nextAfter: string | null }> {
    return this.asCaller(caller, organisationId, async (client) => {
      const visible = await client.query('SELECT 1 FROM trucker.organisation WHERE id = $1', [
        organisationId,
      ]);
      if (visible.rowCount === 0) throw notFound();
      let rows: {
        id: string;
        status: 'draft' | 'discarded';
        version: number;
        shipper_reference: string | null;
        cargo_description: string | null;
        pickup_country: string | null;
        delivery_country: string | null;
        created_at: Date;
        updated_at: Date;
        more: boolean;
      }[];
      try {
        await client.query('SAVEPOINT listing');
        rows = (
          await client.query('SELECT * FROM trucker.list_shipment_drafts($1, $2)', [status, after])
        ).rows;
      } catch (error) {
        if ((error as { code?: string }).code === 'TR010')
          throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
            fields: ['after'],
          });
        throw error;
      }
      const last = rows[rows.length - 1];
      return {
        shipments: rows.map((row) => ({
          id: row.id,
          status: row.status,
          version: row.version,
          shipperReference: row.shipper_reference,
          cargoDescription: row.cargo_description,
          pickupCountry: row.pickup_country,
          deliveryCountry: row.delivery_country,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        })),
        nextAfter: last?.more ? last.id : null,
      };
    });
  }

  /** One draft. One of another organisation answers exactly like one that does not exist. */
  async get(caller: Caller, organisationId: string, id: string): Promise<ShipmentView> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const draft = await this.read(client, id, allowFixtures);
      if (!draft) throw notFound();
      return draft;
    });
  }

  /**
   * Changes a draft made against `expectedVersion`.
   *   updated          the change was made
   *   already_applied  this very request (same key, same content) was applied earlier, so it
   *                    is not applied again. A lost answer can therefore be asked for again.
   * A change made against a version that is no longer current is refused with the current
   * draft, and nothing is saved.
   */
  async update(
    caller: Caller,
    organisationId: string,
    id: string,
    expectedVersion: number,
    retryKey: string,
    input: ShipmentInput,
  ): Promise<{
    shipment: ShipmentView;
    outcome: 'updated' | 'already_applied';
    appliedVersion: number;
  }> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{
        status: string;
        version: number | null;
        detail: unknown;
      }>('SELECT * FROM trucker.update_shipment_draft($1, $2, $3, $4::jsonb, $5)', [
        id,
        expectedVersion,
        retryKey,
        JSON.stringify(input),
        allowFixtures,
      ]);
      const row = result.rows[0]!;
      if (row.status === 'unauthorized') throw unauthorized();
      if (row.status === 'not_found') throw notFound();
      if (row.status === 'key_conflict') throw keyConflict();
      if (row.status === 'invalid') throw invalid(row.detail as Problem[]);
      const draft = await this.read(client, id, allowFixtures);
      if (!draft) throw notFound();
      if (row.status === 'discarded')
        throw new ApiError(
          409,
          'shipment_discarded',
          'This draft was discarded and cannot be changed.',
          {
            current: draft,
          },
        );
      if (row.status === 'conflict')
        throw new ApiError(
          409,
          'shipment_changed',
          'The draft was changed since it was opened. Nothing was saved.',
          { current: draft },
        );
      return {
        shipment: draft,
        outcome: row.status === 'repeated' ? 'already_applied' : 'updated',
        appliedVersion: row.version!,
      };
    });
  }

  /**
   * Discards a draft. The record and its history are kept. A draft that is already discarded
   * is answered as such, and nothing more is written.
   */
  async discard(
    caller: Caller,
    organisationId: string,
    id: string,
    expectedVersion: number,
    retryKey: string,
  ): Promise<{ shipment: ShipmentView; outcome: 'discarded' | 'already_discarded' }> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string; version: number | null }>(
        'SELECT * FROM trucker.discard_shipment_draft($1, $2, $3)',
        [id, expectedVersion, retryKey],
      );
      const row = result.rows[0]!;
      if (row.status === 'unauthorized') throw unauthorized();
      if (row.status === 'not_found') throw notFound();
      if (row.status === 'key_conflict') throw keyConflict();
      const draft = await this.read(client, id, allowFixtures);
      if (!draft) throw notFound();
      if (row.status === 'conflict')
        throw new ApiError(
          409,
          'shipment_changed',
          'The draft was changed since it was opened. Nothing was discarded.',
          { current: draft },
        );
      return {
        shipment: draft,
        outcome: row.status === 'discarded' ? 'discarded' : 'already_discarded',
      };
    });
  }

  /** The draft's history, for administrators of its organisation. */
  async history(caller: Caller, organisationId: string, id: string): Promise<HistoryEntry[]> {
    return this.asCaller(caller, organisationId, async (client) => {
      const visible = await client.query('SELECT 1 FROM trucker.shipment_draft WHERE id = $1', [
        id,
      ]);
      if (visible.rowCount === 0) throw notFound();
      const found = await client.query<{
        id: string;
        occurred_at: Date;
        action: string;
        actor_person_id: string;
        request_id: string | null;
        before_values: unknown;
        after_values: unknown;
      }>(
        `SELECT id, occurred_at, action, actor_person_id, request_id, before_values, after_values
         FROM trucker.audit_entry WHERE record_id = $1 AND record_type = 'shipment_draft'
         ORDER BY occurred_at, id`,
        [id],
      );
      return found.rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at.toISOString(),
        action: row.action,
        actorPersonId: row.actor_person_id,
        requestId: row.request_id,
        before: row.before_values,
        after: row.after_values,
      }));
    });
  }
}
