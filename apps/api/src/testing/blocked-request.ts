import type pg from 'pg';

/**
 * For tests of what happens to a request that has to wait for a lock: a second connection
 * holds the lock, the test waits until the database itself reports the request as waiting,
 * the clock is moved, and the lock is released. Nothing depends on how long a step takes.
 *
 *   owner    the migration role's pool (given as a function: pools are opened in `before`)
 *   advance  moves the test clock
 */
export function blockedRequests(owner: () => pg.Pool, advance: (seconds: number) => Promise<void>) {
  /** Holds a lock in an open transaction of the migration role until released. */
  async function hold(statement: string, values: unknown[] = []): Promise<() => Promise<void>> {
    const client = await owner().connect();
    await client.query('BEGIN');
    await client.query(statement, values);
    return async () => {
      await client.query('COMMIT');
      client.release();
    };
  }
  /**
   * Resolves true once some other connection to this database is waiting for a lock, or false
   * as soon as `settled` says the work has already finished, so nothing keeps polling after it.
   */
  async function untilSomeoneWaits(settled: () => boolean = () => false): Promise<boolean> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (settled()) return false;
      const waiting = await owner().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE NOT l.granted AND a.datname = current_database() AND l.pid <> pg_backend_pid()`,
      );
      if (waiting.rows[0]!.n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('nothing started waiting for the lock');
  }
  /**
   * Runs work that must queue behind the lock, moves the clock while it waits, then lets it go.
   *
   * The work's outcome is captured in the same step that starts it, so there is never a moment
   * in which it can fail with nobody listening. (An earlier version listened only after
   * releasing the lock. If the refusal arrived first, Node reported an unhandled rejection and
   * failed the test although the database had done exactly what was expected.) Nothing is
   * swallowed: a failure is rethrown to the caller, which asserts on it.
   *
   * The work must actually wait. If it settles before the database reports it as waiting, that
   * is reported as such: its own error if it failed, a plain statement if it succeeded.
   */
  type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
  async function whileBlocked<T>(
    lock: [statement: string, values: unknown[]],
    work: () => Promise<T>,
    seconds: number,
    /** For the helper's own test: runs after the lock is released, before the outcome is read. */
    beforeLooking: () => Promise<void> = async () => undefined,
  ): Promise<T> {
    const release = await hold(...lock);
    let released = false;
    const letGo = async (): Promise<void> => {
      if (released) return;
      released = true;
      await release();
    };
    try {
      const outcome: Promise<Outcome<T>> = Promise.resolve()
        .then(work)
        .then(
          (value) => ({ ok: true, value }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        );
      let finished = false;
      void outcome.then(() => {
        finished = true;
      });
      if (!(await untilSomeoneWaits(() => finished))) {
        const early = await outcome;
        if (!early.ok) throw early.error;
        throw new Error('the work finished without waiting for the lock');
      }
      await advance(seconds);
      await letGo();
      await beforeLooking();
      const settled = await outcome;
      if (!settled.ok) throw settled.error;
      return settled.value;
    } finally {
      await letGo();
    }
  }
  const lockNumber = (phone: string): [string, unknown[]] => [
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [phone],
  ];
  const lockRow = (table: string, id: string): [string, unknown[]] => [
    `SELECT 1 FROM trucker.${table} WHERE id = $1 FOR UPDATE`,
    [id],
  ];

  return { whileBlocked, lockNumber, lockRow };
}
