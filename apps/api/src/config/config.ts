import { z } from 'zod';

/**
 * Process configuration. Every value is validated once at start; the process refuses to run
 * when anything is missing or malformed. Problems name the key and the rule, never the value,
 * so a connection string or secret cannot leak into logs.
 */
const milliseconds = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// connection string'),
  /**
   * Connection string for the API's own database role, which owns nothing and cannot bypass
   * row security. DATABASE_URL is the migration role. When this is unset the API connects with
   * DATABASE_URL; if that role turns out to be privileged, organisation data stays closed
   * (and production refuses to start). See src/database/access.ts.
   */
  APP_DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// connection string')
    .optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Limit on establishing a connection. Does not bound a query on an open connection. */
  DB_CONNECT_TIMEOUT_MS: milliseconds(100, 60_000, 3_000),
  /** Server-side limit on any single statement issued by the API. */
  DB_STATEMENT_TIMEOUT_MS: milliseconds(100, 600_000, 5_000),
  /** Overall deadline for the readiness check, whatever the database is doing. */
  HEALTH_CHECK_TIMEOUT_MS: milliseconds(50, 30_000, 2_000),
  /** How long a migration run waits for another run to finish before giving up. */
  MIGRATION_LOCK_WAIT_MS: milliseconds(0, 3_600_000, 30_000),
  /** How long a migration statement waits for a table lock before failing. */
  MIGRATION_STATEMENT_LOCK_TIMEOUT_MS: milliseconds(100, 3_600_000, 10_000),
  MIGRATIONS_DIR: z.string().min(1).optional(),
  /**
   * How often bookings whose fee is overdue are lapsed (src/fee/fee-lapse.job.ts). 0 turns it
   * off. Unset: every minute, except under test, where the tests run it themselves.
   */
  FEE_LAPSE_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).optional(),

  /**
   * Key for the keyed hashes of one-time codes and for deriving session tokens. Development and
   * test fall back to a published value that protects nothing; production must set its own.
   */
  IDENTITY_SECRET: z.string().min(32).optional(),
  /**
   * How a one-time code reaches a person. No message supplier is chosen, so the only modes are
   * `none` (sign-in is closed) and `development-display` (the code is returned to a caller on
   * the same machine). The second is refused in production and with a remote database.
   */
  SIGN_IN_CODE_DELIVERY: z.enum(['none', 'development-display']).default('none'),
  /**
   * Which terms registration records. Only demonstration text exists; `demonstration` is
   * refused in production, so production registration stays closed until approved terms exist.
   */
  REGISTRATION_TERMS: z.enum(['none', 'demonstration']).default('none'),

  // The sign-in and session limits and the organisation creation limit are not configured
  // here: they are protected database settings (db/migrations/0004, `npm run db:settings`),
  // which the API's role can neither read nor change.

  // A development default that needs review before production, which must set it explicitly.
  /** How long a retry key is remembered. After that the same key is treated as new. */
  RETRY_KEY_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).optional(),
  /**
   * Whether fixture countries count as open for registration. `local-development` is refused
   * in production and with a remote database, and has no effect unless the database itself is
   * marked local-development or test (db/migrations/0003, trucker.environment).
   */
  COUNTRY_FIXTURES: z.enum(['none', 'local-development']).default('none'),
});

/** Published on purpose: it only exists so local development needs no setup. */
export const DEVELOPMENT_IDENTITY_SECRET = 'trucker-development-only-secret-not-for-production';

export const SECURITY_PERIOD_DEFAULTS = {
  RETRY_KEY_RETENTION_HOURS: 24,
} as const;
type PeriodKey = keyof typeof SECURITY_PERIOD_DEFAULTS;

/**
 * Settings the API used to read and no longer does. One that is still set would be ignored
 * silently, leaving an operator believing a limit applies that does not, so it is refused.
 */
export const MOVED_TO_DATABASE = [
  'SIGN_IN_CODE_TTL_SECONDS',
  'SIGN_IN_CODE_MAX_ATTEMPTS',
  'SIGN_IN_CODE_RESEND_WAIT_SECONDS',
  'SIGN_IN_CODE_MAX_PER_HOUR',
  'SESSION_IDLE_MINUTES',
  'SESSION_ABSOLUTE_HOURS',
  'ORGANISATION_CREATION_LIMIT',
] as const;

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function databaseIsLocal(url: string): boolean {
  try {
    return LOCAL_DATABASE_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

type Parsed = z.infer<typeof schema>;
export type AppConfig = Readonly<
  Omit<Parsed, PeriodKey | 'IDENTITY_SECRET'> &
    Record<PeriodKey, number> & { IDENTITY_SECRET: string }
>;

export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const RULE_BY_CODE: Record<string, string> = {
  invalid_type: 'is missing or has the wrong type',
  invalid_value: 'is not one of the allowed values',
  invalid_format: 'has an invalid format',
  too_small: 'is below the allowed minimum',
  too_big: 'is above the allowed maximum',
};

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(env);
  if (result.success) {
    const parsed = result.data;
    const production = parsed.NODE_ENV === 'production';
    const problems: string[] = [];
    for (const key of MOVED_TO_DATABASE) {
      if (env[key] !== undefined && env[key] !== '') {
        problems.push(
          `${key} is no longer read by the API: it is a protected database setting (npm run db:settings)`,
        );
      }
    }
    if (production) {
      if (!parsed.IDENTITY_SECRET) problems.push('IDENTITY_SECRET must be set in production');
      if (parsed.IDENTITY_SECRET === DEVELOPMENT_IDENTITY_SECRET) {
        problems.push('IDENTITY_SECRET must not be the published development value');
      }
      if (parsed.SIGN_IN_CODE_DELIVERY === 'development-display') {
        problems.push('SIGN_IN_CODE_DELIVERY must not be development-display in production');
      }
      if (parsed.REGISTRATION_TERMS === 'demonstration') {
        problems.push('REGISTRATION_TERMS must not be demonstration in production');
      }
      for (const key of Object.keys(SECURITY_PERIOD_DEFAULTS) as PeriodKey[]) {
        if (parsed[key] === undefined) {
          problems.push(
            `${key} must be set explicitly in production (the development default needs review)`,
          );
        }
      }
    }
    if (production && parsed.COUNTRY_FIXTURES !== 'none') {
      problems.push('COUNTRY_FIXTURES must not be set in production');
    }
    if (production && !parsed.APP_DATABASE_URL) {
      problems.push(
        'APP_DATABASE_URL must be set in production (the API must not use the migration role)',
      );
    }
    if (production && parsed.APP_DATABASE_URL === parsed.DATABASE_URL) {
      problems.push('APP_DATABASE_URL must differ from DATABASE_URL in production');
    }
    if (
      parsed.COUNTRY_FIXTURES === 'local-development' &&
      !databaseIsLocal(parsed.APP_DATABASE_URL ?? parsed.DATABASE_URL)
    ) {
      problems.push('COUNTRY_FIXTURES local-development needs a database on this machine');
    }
    if (
      parsed.SIGN_IN_CODE_DELIVERY === 'development-display' &&
      !databaseIsLocal(parsed.APP_DATABASE_URL ?? parsed.DATABASE_URL)
    ) {
      problems.push('SIGN_IN_CODE_DELIVERY development-display needs a database on this machine');
    }
    if (problems.length > 0) throw new ConfigError(problems);
    const periods = Object.fromEntries(
      (Object.keys(SECURITY_PERIOD_DEFAULTS) as PeriodKey[]).map((key) => [
        key,
        parsed[key] ?? SECURITY_PERIOD_DEFAULTS[key],
      ]),
    ) as Record<PeriodKey, number>;
    return Object.freeze({
      ...parsed,
      ...periods,
      IDENTITY_SECRET: parsed.IDENTITY_SECRET ?? DEVELOPMENT_IDENTITY_SECRET,
    });
  }
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    // Custom messages are written by us and contain no values; built-in ones are replaced.
    const rule =
      issue.code === 'invalid_format' && issue.message.startsWith('must be')
        ? issue.message
        : (RULE_BY_CODE[issue.code] ?? 'is invalid');
    return `${key} ${rule}`;
  });
  throw new ConfigError(problems);
}
