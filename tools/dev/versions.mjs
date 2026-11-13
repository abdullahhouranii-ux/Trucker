// Prints the exact runtime versions used by a verification run, so that every run records
// what it actually ran on. Node.js and PostgreSQL are major-version selections, not exact pins.
import pg from 'pg';
import { probe } from './lib.mjs';

const npm = probe('npm', ['--version']);
const npmVersion = npm.ok ? npm.output : 'unknown';
console.log(`node ${process.version}`);
console.log(`npm ${npmVersion}`);
console.log(`platform ${process.platform} ${process.arch}`);

if (!process.env.DATABASE_URL) {
  console.log('postgresql (DATABASE_URL not set)');
} else {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    const result = await client.query('SHOW server_version');
    console.log(`postgresql ${result.rows[0].server_version}`);
  } finally {
    await client.end();
  }
}
