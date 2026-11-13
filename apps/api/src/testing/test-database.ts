import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Creates an empty database for one test file and drops it afterwards, so tests never share
 * state and never touch a developer's working database. Needs DATABASE_URL to point at any
 * database on a server where the role may create databases.
 */
export interface TestDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

export function adminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set to run database tests');
  }
  return url;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = adminUrl();
  const name = `trucker_test_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const target = new URL(admin);
  target.pathname = `/${name}`;
  return {
    url: target.toString(),
    async drop() {
      const dropper = new pg.Client({ connectionString: admin });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
