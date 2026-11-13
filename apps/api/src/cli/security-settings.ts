import pg from 'pg';
import {
  parseSettingChanges,
  readSecuritySettings,
  writeSecuritySettings,
} from '../database/settings.js';

/**
 * The protected security settings: code lifetime, attempts, resend wait, codes per hour,
 * session idle period and absolute limit, organisations per person. They live in the database
 * and are enforced there; the API cannot read or change them. Run as the migration role
 * (DATABASE_URL).
 *   show                                   prints the current values as JSON
 *   set name=value ...                     changes values; withdraws the production review
 *   set name=value ... --reviewed-for-production
 *                                          changes values and records that the resulting
 *                                          set was reviewed for production
 * Each value has an allowed range, enforced by the table.
 */
async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command !== 'show' && command !== 'set') {
    console.error('usage: security-settings show | set name=value ... [--reviewed-for-production]');
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set (the migration role)');
    return 1;
  }
  const reviewed = rest.includes('--reviewed-for-production');
  const pairs = rest.filter((arg) => arg !== '--reviewed-for-production');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    if (command === 'show') {
      console.log(JSON.stringify(await readSecuritySettings(pool)));
      return 0;
    }
    const changes = parseSettingChanges(pairs);
    if (pairs.length === 0 && !reviewed) {
      console.error('nothing to change');
      return 2;
    }
    console.log(JSON.stringify(await writeSecuritySettings(pool, changes, reviewed)));
    return 0;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
