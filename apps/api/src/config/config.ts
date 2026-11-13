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
});

export type AppConfig = Readonly<z.infer<typeof schema>>;

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
    return Object.freeze(result.data);
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
