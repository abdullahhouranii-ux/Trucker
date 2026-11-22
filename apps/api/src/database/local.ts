import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * Helpers for a database on the developer's own machine and for tests. Nothing here is used
 * by the running API, and every entry point refuses to act unless the safeguards below hold.
 */

/** Published on purpose: a login for the API's role on a local database only. */
export const LOCAL_APP_LOGIN = 'trucker_api_local';
export const LOCAL_APP_PASSWORD = 'trucker-api-local-only';
/** The exact value that must be set to load fixtures. Anything else is refused. */
export const FIXTURES_ACKNOWLEDGEMENT = 'local-development-only';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function databaseHostIsLocal(url: string | undefined): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url ?? '').hostname);
  } catch {
    return false;
  }
}

/** The connection string of the local API login for the same database as the owner's. */
export function appDatabaseUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = LOCAL_APP_LOGIN;
  url.password = LOCAL_APP_PASSWORD;
  return url.toString();
}

/**
 * Why fixtures may not be loaded, judged before the database is touched. Each is a separate
 * barrier; the database adds its own (trucker.environment and the country trigger).
 */
export function fixtureSafeguardProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test')
    problems.push('NODE_ENV must be development or test');
  if (env.TRUCKER_LOCAL_FIXTURES !== FIXTURES_ACKNOWLEDGEMENT)
    problems.push(`TRUCKER_LOCAL_FIXTURES must be exactly "${FIXTURES_ACKNOWLEDGEMENT}"`);
  if (!databaseHostIsLocal(env.DATABASE_URL))
    problems.push('DATABASE_URL must point at a database on this machine');
  return problems;
}

/** Creates the local API login if it is missing and makes it a member of trucker_app. */
export async function ensureLocalAppLogin(owner: Pick<pg.Pool, 'query'>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await owner.query(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOCAL_APP_LOGIN}') THEN
            CREATE ROLE ${LOCAL_APP_LOGIN} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
              PASSWORD '${LOCAL_APP_PASSWORD}';
          END IF;
        EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
        END $$`);
      const member = await owner.query<{ member: boolean }>(
        `SELECT pg_has_role('${LOCAL_APP_LOGIN}', 'trucker_app', 'MEMBER') AS member`,
      );
      if (!member.rows[0]?.member) await owner.query(`GRANT trucker_app TO ${LOCAL_APP_LOGIN}`);
      return;
    } catch (error) {
      // Several test databases on one server may do this at the same moment.
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Marks the database. The database refuses to leave production or to go back to unmarked. */
export async function markEnvironment(
  owner: Pick<pg.Pool, 'query'>,
  kind: 'local-development' | 'test',
): Promise<void> {
  await owner.query('UPDATE trucker.environment SET kind = $1, marked_at = now()', [kind]);
}

export function defaultFixturesFile(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../db/fixtures/local-development/countries.json',
  );
}

interface FixtureFile {
  countries: {
    code: string;
    registrationState: 'enabled' | 'closed';
    operatingState: 'enabled' | 'closed';
    timeZones: string[];
    name: { en: string; ar: string; ur: string };
  }[];
  lanes: { origin: string; destination: string; state: 'enabled' | 'closed'; transit: string[] }[];
  /** Demonstration only: not a statement of any legal requirement. */
  evidenceRequirements?: {
    country: string;
    capability: 'ship' | 'carry_as_company';
    documentType: string;
    required: boolean;
    name: { en: string; ar: string; ur: string };
  }[];
  /** Fictional catalogues: not a statement of what may be carried anywhere. */
  cargoCategories?: {
    code: string;
    excluded: boolean;
    name: { en: string; ar: string; ur: string };
  }[];
  equipmentTypes?: { code: string; name: { en: string; ar: string; ur: string } }[];
}

/**
 * Loads the fictional countries with their time zones, the fictional lanes between them and
 * the fictional evidence requirements.
 * The database itself refuses them unless it is marked for it.
 */
export async function loadCountryFixtures(
  owner: Pick<pg.Pool, 'query'>,
  file: string = defaultFixturesFile(),
): Promise<string[]> {
  const data = JSON.parse(await readFile(file, 'utf8')) as FixtureFile;
  for (const country of data.countries) {
    await owner.query(
      `INSERT INTO trucker.country (code, name_en, name_ar, name_ur, registration_state, operating_state, fixture)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (code) DO UPDATE
         SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, name_ur = EXCLUDED.name_ur,
             registration_state = EXCLUDED.registration_state,
             operating_state = EXCLUDED.operating_state`,
      [
        country.code,
        country.name.en,
        country.name.ar,
        country.name.ur,
        country.registrationState,
        country.operatingState,
      ],
    );
    for (const zone of country.timeZones) {
      await owner.query(
        `INSERT INTO trucker.country_time_zone (country_code, zone_name) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [country.code, zone],
      );
    }
  }
  for (const lane of data.lanes) {
    const saved = await owner.query<{ id: string }>(
      `INSERT INTO trucker.lane (origin_country, destination_country, state) VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT lane_once DO UPDATE SET state = EXCLUDED.state RETURNING id`,
      [lane.origin, lane.destination, lane.state],
    );
    const laneId = saved.rows[0]!.id;
    await owner.query('DELETE FROM trucker.lane_transit WHERE lane_id = $1', [laneId]);
    for (const [index, code] of lane.transit.entries()) {
      await owner.query(
        'INSERT INTO trucker.lane_transit (lane_id, position, country_code) VALUES ($1, $2, $3)',
        [laneId, index + 1, code],
      );
    }
  }
  for (const [index, requirement] of (data.evidenceRequirements ?? []).entries()) {
    await owner.query(
      `INSERT INTO trucker.evidence_requirement
         (country_code, capability, document_type, name_en, name_ar, name_ur, required, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (country_code, capability, document_type) DO UPDATE
         SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, name_ur = EXCLUDED.name_ur,
             required = EXCLUDED.required, position = EXCLUDED.position`,
      [
        requirement.country,
        requirement.capability,
        requirement.documentType,
        requirement.name.en,
        requirement.name.ar,
        requirement.name.ur,
        requirement.required,
        index + 1,
      ],
    );
  }
  for (const [index, category] of (data.cargoCategories ?? []).entries()) {
    await owner.query(
      `INSERT INTO trucker.cargo_category (code, name_en, name_ar, name_ur, excluded, position)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO UPDATE
         SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, name_ur = EXCLUDED.name_ur,
             excluded = EXCLUDED.excluded, position = EXCLUDED.position`,
      [
        category.code,
        category.name.en,
        category.name.ar,
        category.name.ur,
        category.excluded,
        index + 1,
      ],
    );
  }
  for (const [index, type] of (data.equipmentTypes ?? []).entries()) {
    await owner.query(
      `INSERT INTO trucker.equipment_type (code, name_en, name_ar, name_ur, position)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE
         SET name_en = EXCLUDED.name_en, name_ar = EXCLUDED.name_ar, name_ur = EXCLUDED.name_ur,
             position = EXCLUDED.position`,
      [type.code, type.name.en, type.name.ar, type.name.ur, index + 1],
    );
  }
  return data.countries.map((country) => country.code);
}
