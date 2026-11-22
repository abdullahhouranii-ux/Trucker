import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { ApiError } from '../http/api-error.js';
import { APP_CONFIG, DB_POOL } from '../tokens.js';

export type EnvironmentKind = 'unmarked' | 'local-development' | 'test' | 'production';

export interface DatabaseAccess {
  /** The role cannot bypass row security: not a superuser, no BYPASSRLS, owns nothing. */
  readonly rowSecurityBinds: boolean;
  readonly problems: readonly string[];
  readonly environment: EnvironmentKind;
  /** The protected security settings have been recorded as reviewed for production. */
  readonly settingsReviewed: boolean;
  /** An approved version of the financial settings, not a development default, is in force. */
  readonly financialSettingsApproved: boolean;
  /** This connection to the database is encrypted, as the server itself reports it. */
  readonly connectionEncrypted: boolean;
  /** The server is set never to write statement parameters to its log. */
  readonly parametersKeptOutOfLogs: boolean;
}

/**
 * What the API's database role may do, read from the database itself. Row security protects
 * organisation data only when the API's role is bound by it, so this is checked rather than
 * assumed: a superuser, a role with BYPASSRLS, or the owner of the tables would see every
 * organisation whatever the policies say.
 */
export async function inspectAccess(pool: Pick<pg.Pool, 'query'>): Promise<DatabaseAccess> {
  const role = await pool.query<{
    superuser: boolean;
    bypass: boolean;
    member: boolean;
    owned: number;
    may_create: boolean;
  }>(
    `SELECT r.rolsuper AS superuser,
            r.rolbypassrls AS bypass,
            pg_has_role(current_user, 'trucker_app', 'MEMBER') AS member,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'trucker' AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS owned,
            has_schema_privilege(current_user, 'trucker', 'CREATE') AS may_create
     FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const found = role.rows[0];
  const problems: string[] = [];
  if (!found) problems.push('the database role could not be read');
  else {
    if (found.superuser) problems.push('the database role is a superuser');
    if (found.bypass) problems.push('the database role has BYPASSRLS');
    if (found.owned > 0) problems.push('the database role owns tables in the trucker schema');
    if (found.may_create)
      problems.push('the database role may create objects in the trucker schema');
    if (!found.member) problems.push('the database role is not a member of trucker_app');
  }
  const mark = await pool.query<{ kind: EnvironmentKind }>('SELECT kind FROM trucker.environment');
  const reviewed = await pool.query<{ reviewed: boolean | null }>(
    'SELECT trucker.security_settings_reviewed() AS reviewed',
  );
  const financial = await pool.query<{ ready: boolean | null }>(
    'SELECT trucker.financial_settings_ready() AS ready',
  );
  // The key for one-time codes and the codes people type travel to the database as statement
  // parameters. Both gates are read from the server, for this connection and this role.
  const transport = await pool.query<{
    encrypted: boolean;
    in_statements: string | null;
    on_error: string | null;
  }>(
    `SELECT coalesce((SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()), false) AS encrypted,
            current_setting('log_parameter_max_length', true) AS in_statements,
            current_setting('log_parameter_max_length_on_error', true) AS on_error`,
  );
  return {
    rowSecurityBinds: problems.length === 0,
    problems,
    environment: mark.rows[0]?.kind ?? 'unmarked',
    settingsReviewed: reviewed.rows[0]?.reviewed === true,
    financialSettingsApproved: financial.rows[0]?.ready === true,
    connectionEncrypted: transport.rows[0]?.encrypted === true,
    parametersKeptOutOfLogs:
      transport.rows[0]?.in_statements === '0' && transport.rows[0]?.on_error === '0',
  };
}

/**
 * Keeps organisation data closed unless the API's role is bound by row security. A good
 * answer is remembered; a bad or missing one is asked again, so the API recovers once an
 * operator fixes the role or applies the migrations.
 */
@Injectable()
export class AccessGuard {
  private confirmed: DatabaseAccess | undefined;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async inspect(): Promise<DatabaseAccess> {
    if (this.confirmed) return this.confirmed;
    const access = await inspectAccess(this.pool);
    if (access.rowSecurityBinds) this.confirmed = access;
    return access;
  }

  /** Throws 503 unless organisation data may be served. */
  async requireBoundRole(): Promise<DatabaseAccess> {
    let access: DatabaseAccess;
    try {
      access = await this.inspect();
    } catch {
      throw new ApiError(
        503,
        'organisation_access_closed',
        'Organisation data is not available: the database is not ready.',
      );
    }
    if (!access.rowSecurityBinds) {
      throw new ApiError(
        503,
        'organisation_access_closed',
        'Organisation data is closed: the API is connected with a database role that row security does not bind.',
      );
    }
    return access;
  }

  /** Fixture countries count only when asked for here and the database itself is so marked. */
  fixturesAllowed(access: DatabaseAccess): boolean {
    return (
      this.config.COUNTRY_FIXTURES === 'local-development' &&
      this.config.NODE_ENV !== 'production' &&
      (access.environment === 'local-development' || access.environment === 'test')
    );
  }
}

/**
 * Production does not start on a guess. The role must be bound by row security, the
 * database must have been marked production, which is possible only when it holds no fixture
 * data and can never be undone, the limits it enforces must have been reviewed, the
 * connection must be encrypted and the server must not log statement parameters.
 */
export function productionStartProblems(access: DatabaseAccess): string[] {
  const problems = [...access.problems];
  if (access.environment !== 'production') {
    problems.push(
      `the database is marked "${access.environment}", not "production" (mark it once, deliberately, before the first production start)`,
    );
  }
  if (!access.connectionEncrypted) {
    problems.push(
      'the connection to the database is not encrypted (the key for one-time codes and the codes themselves travel on it)',
    );
  }
  if (!access.parametersKeptOutOfLogs) {
    problems.push(
      'the database server may write statement parameters to its log: log_parameter_max_length and log_parameter_max_length_on_error must both be 0 for the API role',
    );
  }
  if (!access.settingsReviewed) {
    problems.push(
      'the security settings in the database are development defaults that have not been recorded as reviewed for production (npm run db:settings)',
    );
  }
  if (!access.financialSettingsApproved) {
    problems.push(
      'no approved version of the financial settings is in force: only the development default is (draft one in the staff console and have a second administrator approve it)',
    );
  }
  return problems;
}
