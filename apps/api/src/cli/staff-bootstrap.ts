import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Creates the first staff administrator. Run once by an operator, as the migration role
 * (DATABASE_URL):
 *
 *   staff-bootstrap <work email> <display name>
 *
 * It creates an account that cannot sign in yet and prints an enrolment link, valid for a
 * limited time and usable once, with which that person sets a password and an authenticator.
 * It refuses when an enrolled, active administrator exists, and it never changes an existing
 * administrator's credentials. Run again before enrolment, it replaces the link.
 * Every run, refused or not, is recorded in the staff audit list.
 *
 * The link is printed once and stored nowhere: only its hash is kept. Hand it to the person
 * over a channel you trust. CONSOLE_ORIGIN is where the staff console is served.
 */
async function main(args: string[]): Promise<number> {
  const [email, ...nameParts] = args;
  const displayName = nameParts.join(' ').trim();
  if (!email || displayName === '') {
    console.error('usage: staff-bootstrap <work email> <display name>');
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set (the migration role)');
    return 1;
  }
  const origin = process.env.CONSOLE_ORIGIN ?? 'http://localhost:3200';
  const token = randomBytes(32).toString('base64url');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const result = await pool.query<{
      status: string;
      staff_id: string | null;
      link_expires_at: Date | null;
    }>('SELECT * FROM trucker.bootstrap_staff_admin($1, $2, $3)', [
      email,
      displayName,
      createHash('sha256').update(token).digest('hex'),
    ]);
    const row = result.rows[0]!;
    if (row.status === 'administrator_exists') {
      console.error(
        'Refused: an active staff administrator already exists. New accounts are created in the console. This command never resets an existing administrator.',
      );
      return 1;
    }
    if (row.status === 'email_taken') {
      console.error('Refused: a staff account with this email already exists.');
      return 1;
    }
    if (row.status !== 'created' && row.status !== 'reissued') {
      console.error('Refused: the email or the name is not valid.');
      return 1;
    }
    console.log(
      JSON.stringify({
        status: row.status,
        staffId: row.staff_id,
        linkExpiresAt: row.link_expires_at?.toISOString(),
        enrolmentLink: `${origin.replace(/\/$/, '')}/enrol#${token}`,
      }),
    );
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
