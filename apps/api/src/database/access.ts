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
  return {
    rowSecurityBinds: problems.length === 0,
    problems,
    environment: mark.rows[0]?.kind ?? 'unmarked',
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
 * Production does not start on a guess. The role must be bound by row security and the
 * database must have been marked production, which is possible only when it holds no fixture
 * data and can never be undone.
 */
export function productionStartProblems(access: DatabaseAccess): string[] {
  const problems = [...access.problems];
  if (access.environment !== 'production') {
    problems.push(
      `the database is marked "${access.environment}", not "production" (mark it once, deliberately, before the first production start)`,
    );
  }
  return problems;
}
