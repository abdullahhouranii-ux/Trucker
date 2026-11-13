import pg from 'pg';
import {
  appDatabaseUrl,
  databaseHostIsLocal,
  ensureLocalAppLogin,
  fixtureSafeguardProblems,
  loadCountryFixtures,
  markEnvironment,
} from '../database/local.js';

/**
 * For a database on the developer's own machine. Run after migrations, as the migration role.
 *   app-role  creates the local login for the API's role and prints its connection string
 *   fixtures  marks the database local-development and loads the fictional countries
 * Both refuse a production NODE_ENV and a database that is not on this machine. `fixtures`
 * also needs TRUCKER_LOCAL_FIXTURES=local-development-only, and the database refuses the rows
 * unless it carries the mark, which a production database can never be given.
 */
async function main(command: string | undefined): Promise<number> {
  if (command !== 'app-role' && command !== 'fixtures') {
    console.error('usage: local-database <app-role|fixtures>');
    return 2;
  }
  const url = process.env.DATABASE_URL;
  const problems =
    command === 'fixtures'
      ? fixtureSafeguardProblems(process.env)
      : [
          ...(process.env.NODE_ENV === 'production' ? ['NODE_ENV must not be production'] : []),
          ...(databaseHostIsLocal(url)
            ? []
            : ['DATABASE_URL must point at a database on this machine']),
        ];
  if (problems.length > 0) {
    console.error(`refused:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    return 1;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    if (command === 'app-role') {
      await ensureLocalAppLogin(pool);
      // The password is the published local-only one, so printing it discloses nothing.
      console.log(`APP_DATABASE_URL=${appDatabaseUrl(url!)}`);
      return 0;
    }
    const mark = await pool.query<{ kind: string }>('SELECT kind FROM trucker.environment');
    const kind = mark.rows[0]?.kind;
    if (kind === 'production') {
      console.error('refused: this database is marked production');
      return 1;
    }
    if (kind === 'unmarked') await markEnvironment(pool, 'local-development');
    const codes = await loadCountryFixtures(pool);
    console.log(`fixture countries loaded (fictional): ${codes.join(', ')}`);
    return 0;
  } finally {
    await pool.end();
  }
}

main(process.argv[2]).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
