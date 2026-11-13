import type pg from 'pg';

/**
 * A clock tests can move. The identity rules read the time from the database
 * (trucker.clock_now), which lets it be fixed only in a database marked "test"; the few
 * things the API still times itself read the same instant from here. Moving it writes the
 * new instant to the database as the migration role: the API's role cannot.
 */
export interface TestClock {
  /** The API's clock. */
  readonly clock: () => Date;
  /** Fixes the database's clock at the current instant. Call once the database is marked test. */
  start(owner: Pick<pg.Pool, 'query'>): Promise<void>;
  advance(seconds: number): Promise<void>;
}

export function createTestClock(startAt: Date = new Date()): TestClock {
  let now = startAt;
  let owner: Pick<pg.Pool, 'query'> | undefined;
  const write = async (): Promise<void> => {
    if (!owner) throw new Error('the test clock was not started');
    await owner.query(
      `INSERT INTO trucker.test_clock (singleton, fixed_at) VALUES (true, $1)
       ON CONFLICT (singleton) DO UPDATE SET fixed_at = EXCLUDED.fixed_at`,
      [now],
    );
  };
  return {
    clock: () => new Date(now),
    async start(pool) {
      owner = pool;
      await write();
    },
    async advance(seconds) {
      now = new Date(now.getTime() + seconds * 1000);
      await write();
    },
  };
}
