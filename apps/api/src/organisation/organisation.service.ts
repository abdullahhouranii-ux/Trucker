import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { APP_CONFIG, CLOCK, DB_POOL, type Clock } from '../tokens.js';

export interface OrganisationInput {
  readonly legalName: string;
  readonly tradingName: string | null;
  readonly countryCode: string;
  readonly registrationNumber: string;
  readonly address: string | null;
  readonly contactName: string | null;
}

export interface OrganisationView extends OrganisationInput {
  readonly id: string;
  readonly status: string;
  readonly requestedCapability: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the chooser shows: enough to tell organisations apart, and no more. */
export interface OrganisationSummary {
  readonly id: string;
  readonly status: string;
  readonly legalName: string;
  readonly registrationNumber: string;
  readonly createdAt: string;
}

export interface CountryView {
  readonly code: string;
  readonly name: { readonly en: string; readonly ar: string; readonly ur: string };
  readonly fixture: boolean;
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

/** Who is asking, as the database will verify it: the hash of the bearer token. */
export interface Caller {
  readonly personId: string;
  readonly tokenHash: string;
  readonly requestId: string | undefined;
}

interface OrganisationRow {
  id: string;
  status: string;
  requested_capability: string;
  legal_name: string;
  trading_name: string | null;
  country_code: string;
  registration_number: string;
  address: string | null;
  contact_name: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, status, requested_capability, legal_name, trading_name, country_code,
  registration_number, address, contact_name, version, created_at, updated_at`;

const view = (row: OrganisationRow): OrganisationView => ({
  id: row.id,
  status: row.status,
  requestedCapability: row.requested_capability,
  legalName: row.legal_name,
  tradingName: row.trading_name,
  countryCode: row.country_code,
  registrationNumber: row.registration_number,
  address: row.address,
  contactName: row.contact_name,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', 'The requested resource was not found.');

/** Errors raised on purpose by trucker.create_organisation, by their SQLSTATE. */
function creationError(error: unknown): ApiError | undefined {
  const { code, detail } = error as { code?: string; detail?: string };
  if (code === '42501') return new ApiError(401, 'unauthorized', 'Authentication is required.');
  if (code === 'TR001')
    return new ApiError(403, 'registration_incomplete', 'Finish registration first.');
  if (code === 'TR002')
    return new ApiError(
      409,
      'organisation_limit_reached',
      'You have created as many organisations as one person may.',
      // The limit is a protected database setting; the function reports the one it applied.
      { limit: Number(detail) },
    );
  if (code === 'TR003')
    return new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields: ['countryCode'],
    });
  return undefined;
}

@Injectable()
export class OrganisationService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AccessGuard) private readonly access: AccessGuard,
  ) {}

  /**
   * One transaction in which the database knows who is asking and about which organisation.
   * The settings are local to the transaction, so nothing is left on the pooled connection
   * for the next request, whether the work succeeds, fails or times out.
   */
  private async asCaller<T>(
    caller: Caller,
    organisationId: string | null,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('trucker.session_token_hash', $1, true),
                set_config('trucker.organisation_id', $2, true),
                set_config('trucker.request_id', $3, true)`,
        [caller.tokenHash, organisationId ?? '', caller.requestId ?? ''],
      );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Makes one organisation the subject of the rest of the transaction. Row security then
   * shows that organisation only, and only if the caller is a member of it.
   */
  private async select(client: pg.PoolClient, organisationId: string): Promise<void> {
    await client.query(`SELECT set_config('trucker.organisation_id', $1, true)`, [organisationId]);
  }

  private async openCountries(
    client: Pick<pg.PoolClient, 'query'>,
    allowFixtures: boolean,
  ): Promise<CountryView[]> {
    const found = await client.query<{
      code: string;
      name_en: string;
      name_ar: string;
      name_ur: string;
      fixture: boolean;
    }>(
      `SELECT code, name_en, name_ar, name_ur, fixture FROM trucker.country
       WHERE registration_state = 'enabled' AND (NOT fixture OR $1) ORDER BY code`,
      [allowFixtures],
    );
    return found.rows.map((row) => ({
      code: row.code,
      name: { en: row.name_en, ar: row.name_ar, ur: row.name_ur },
      fixture: row.fixture,
    }));
  }

  /** Countries in which an organisation may be registered now. Empty means registration is closed. */
  async countries(): Promise<CountryView[]> {
    const access = await this.access.requireBoundRole();
    return this.openCountries(this.pool, this.access.fixturesAllowed(access));
  }

  /**
   * Creates a draft organisation with the caller as its first administrator. The caller is
   * authenticated before this is reached; here the database checks again who is asking, and
   * only then is a stored retry looked up. A retry is answered by reading the organisation
   * itself under the same access rules as any read, so a stored key can never hand back data
   * the caller may not see now.
   */
  async create(
    caller: Caller,
    retryKey: string,
    input: OrganisationInput,
  ): Promise<OrganisationView> {
    const access = await this.access.requireBoundRole();
    const allowFixtures = this.access.fixturesAllowed(access);
    const now = this.clock();
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const retainedSince = new Date(
      now.getTime() - this.config.RETRY_KEY_RETENTION_HOURS * 3_600_000,
    );

    return this.asCaller(caller, null, async (client) => {
      const who = await client.query<{ person: string | null }>(
        'SELECT trucker.request_person() AS person',
      );
      if (who.rows[0]?.person !== caller.personId)
        throw new ApiError(401, 'unauthorized', 'Authentication is required.');

      // The same key sent twice at once is handled one after the other.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `retry:${caller.personId}:${retryKey}`,
      ]);
      const stored = await client.query<{
        request_hash: string;
        record_id: string;
        created_at: Date;
      }>(
        `SELECT request_hash, record_id, created_at FROM trucker.retry_key
         WHERE key = $1 AND operation = 'organisation.create'`,
        [retryKey],
      );
      const previous = stored.rows[0];
      if (previous && previous.created_at.getTime() > retainedSince.getTime()) {
        if (previous.request_hash !== requestHash)
          throw new ApiError(
            409,
            'retry_key_conflict',
            'This retry key was already used for a different request.',
          );
        // The stored key only points at a record. It is read by selecting it, like any
        // organisation: a caller who is no longer a member sees nothing.
        await this.select(client, previous.record_id);
        const again = await client.query<OrganisationRow>(
          `SELECT ${COLUMNS} FROM trucker.organisation WHERE id = $1`,
          [previous.record_id],
        );
        if (!again.rows[0]) throw notFound();
        return view(again.rows[0]);
      }
      if (previous) await client.query('DELETE FROM trucker.retry_key WHERE key = $1', [retryKey]);

      if ((await this.openCountries(client, allowFixtures)).length === 0)
        throw new ApiError(
          503,
          'organisation_registration_closed',
          'No country is open for registration in this environment.',
        );

      let createdId: string;
      try {
        // A savepoint, so a refusal by the function leaves the transaction usable.
        await client.query('SAVEPOINT creating');
        const created = await client.query<{ id: string }>(
          'SELECT trucker.create_organisation($1, $2, $3, $4, $5, $6, $7) AS id',
          [
            input.legalName,
            input.tradingName,
            input.countryCode,
            input.registrationNumber,
            input.address,
            input.contactName,
            allowFixtures,
          ],
        );
        createdId = created.rows[0]!.id;
      } catch (error) {
        const refused = creationError(error);
        if (refused) throw refused;
        throw error;
      }
      await client.query(
        `INSERT INTO trucker.retry_key (person_id, key, operation, request_hash, record_id, created_at)
         VALUES ($1, $2, 'organisation.create', $3, $4, $5)`,
        [caller.personId, retryKey, requestHash, createdId, now],
      );
      await this.select(client, createdId);
      const fresh = await client.query<OrganisationRow>(
        `SELECT ${COLUMNS} FROM trucker.organisation WHERE id = $1`,
        [createdId],
      );
      return view(fresh.rows[0]!);
    });
  }

  /**
   * The chooser: every organisation the caller belongs to, newest first, with only what is
   * needed to tell them apart. This is the one path that crosses organisations, so it runs
   * with no organisation selected and through a database function made for it; the tables
   * themselves show nothing to such a request.
   */
  async list(caller: Caller): Promise<OrganisationSummary[]> {
    await this.access.requireBoundRole();
    return this.asCaller(caller, null, async (client) => {
      const found = await client.query<{
        id: string;
        status: string;
        legal_name: string;
        registration_number: string;
        created_at: Date;
      }>(
        'SELECT id, status, legal_name, registration_number, created_at FROM trucker.my_organisations()',
      );
      return found.rows.map((row) => ({
        id: row.id,
        status: row.status,
        legalName: row.legal_name,
        registrationNumber: row.registration_number,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  /** One organisation. One the caller does not belong to answers exactly like one that does not exist. */
  async get(caller: Caller, id: string): Promise<OrganisationView> {
    await this.access.requireBoundRole();
    return this.asCaller(caller, id, async (client) => {
      const found = await client.query<OrganisationRow>(
        `SELECT ${COLUMNS} FROM trucker.organisation WHERE id = $1`,
        [id],
      );
      if (!found.rows[0]) throw notFound();
      return view(found.rows[0]);
    });
  }

  /**
   * Changes a draft organisation. The caller sends the version they last saw; if someone else
   * saved in between, nothing is written and the current values are returned with the refusal.
   */
  async update(
    caller: Caller,
    id: string,
    expectedVersion: number,
    input: OrganisationInput,
  ): Promise<OrganisationView> {
    const access = await this.access.requireBoundRole();
    const allowFixtures = this.access.fixturesAllowed(access);
    return this.asCaller(caller, id, async (client) => {
      // Read first without a lock: a row lock is allowed only on rows the caller may change,
      // so locking straight away could not tell "not yours" from "no longer a draft".
      const seen = await client.query<OrganisationRow>(
        `SELECT ${COLUMNS} FROM trucker.organisation WHERE id = $1`,
        [id],
      );
      if (!seen.rows[0]) throw notFound();
      if (seen.rows[0].status !== 'draft')
        throw new ApiError(
          409,
          'organisation_not_editable',
          'This organisation can no longer be changed here.',
        );
      const locked = await client.query<OrganisationRow>(
        `SELECT ${COLUMNS} FROM trucker.organisation WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = locked.rows[0];
      // Visible but not lockable: a member who is not an administrator.
      if (!current) throw new ApiError(403, 'forbidden', 'This action is not allowed.');
      if (current.version !== expectedVersion)
        throw new ApiError(
          409,
          'organisation_changed',
          'The organisation was changed by someone else. Nothing was saved.',
          { current: view(current) },
        );
      if (
        input.countryCode !== current.country_code &&
        !(await this.openCountries(client, allowFixtures)).some(
          (country) => country.code === input.countryCode,
        )
      )
        throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
          fields: ['countryCode'],
        });
      const changed = await client.query<OrganisationRow>(
        `UPDATE trucker.organisation
         SET legal_name = $2, trading_name = $3, country_code = $4, registration_number = $5,
             address = $6, contact_name = $7, version = version + 1
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [
          id,
          input.legalName,
          input.tradingName,
          input.countryCode,
          input.registrationNumber,
          input.address,
          input.contactName,
        ],
      );
      // Row security refused the change: a member who is not an administrator.
      if (!changed.rows[0]) throw new ApiError(403, 'forbidden', 'This action is not allowed.');
      return view(changed.rows[0]);
    });
  }

  /** The organisation's audit history, for its administrators. */
  async history(caller: Caller, id: string): Promise<HistoryEntry[]> {
    await this.access.requireBoundRole();
    return this.asCaller(caller, id, async (client) => {
      const visible = await client.query('SELECT 1 FROM trucker.organisation WHERE id = $1', [id]);
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
         FROM trucker.audit_entry WHERE organisation_id = $1 ORDER BY occurred_at, id`,
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
