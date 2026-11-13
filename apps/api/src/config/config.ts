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

  // Security periods. The defaults are DEVELOPMENT DEFAULTS that need review before production:
  // production must set each one explicitly (docs/delivery/REGISTRATION_SLICE_4.md, section 4).
  SIGN_IN_CODE_TTL_SECONDS: z.coerce.number().int().min(30).max(900).optional(),
  SIGN_IN_CODE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).optional(),
  SIGN_IN_CODE_RESEND_WAIT_SECONDS: z.coerce.number().int().min(10).max(3600).optional(),
  SIGN_IN_CODE_MAX_PER_HOUR: z.coerce.number().int().min(1).max(30).optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).optional(),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(720).optional(),
});

/** Published on purpose: it only exists so local development needs no setup. */
export const DEVELOPMENT_IDENTITY_SECRET = 'trucker-development-only-secret-not-for-production';

export const SECURITY_PERIOD_DEFAULTS = {
  SIGN_IN_CODE_TTL_SECONDS: 300,
  SIGN_IN_CODE_MAX_ATTEMPTS: 5,
  SIGN_IN_CODE_RESEND_WAIT_SECONDS: 60,
  SIGN_IN_CODE_MAX_PER_HOUR: 5,
  SESSION_IDLE_MINUTES: 30,
  SESSION_ABSOLUTE_HOURS: 12,
} as const;
type PeriodKey = keyof typeof SECURITY_PERIOD_DEFAULTS;

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
    if (
      parsed.SIGN_IN_CODE_DELIVERY === 'development-display' &&
      !databaseIsLocal(parsed.DATABASE_URL)
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
