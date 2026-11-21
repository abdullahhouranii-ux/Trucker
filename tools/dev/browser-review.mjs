// Runs an existing browser suite against a disposable database, never the developer's data.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { developmentEnv, repoRoot } from './lib.mjs';
import { createTestDatabase } from '../../apps/api/dist/testing/test-database.js';

const target = process.argv[2];
if (!['web', 'console'].includes(target)) throw new Error('Choose web or console');
const env = developmentEnv();
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
process.env.DATABASE_URL = env.DATABASE_URL;
const database = await createTestDatabase();
try {
  const script = fileURLToPath(new URL(`../../apps/${target}/tests/browser.mjs`, import.meta.url));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: repoRoot,
      shell: false,
      stdio: 'inherit',
      env: {
        ...env,
        DATABASE_URL: database.url,
        ...(target === 'console' ? { TRUCKER_NEXT_BUILD_DIR: '.next-review' } : {}),
      },
    });
    child.once('error', reject);
    child.once('exit', (status) => resolve(status ?? 1));
  });
  process.exitCode = code;
} finally {
  await database.drop();
}
