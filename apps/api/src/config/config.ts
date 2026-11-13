import { z } from 'zod';

/**
 * Process configuration. Every value is validated once at start; the process refuses to run
 * when anything is missing or malformed. Problems name the key and the rule, never the value,
 * so a connection string or secret cannot leak into logs.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// connection string'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(3000),
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
