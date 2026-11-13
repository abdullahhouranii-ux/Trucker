// Local development database in Docker:
//   node tools/dev/db.mjs up      start and wait until it accepts connections
//   node tools/dev/db.mjs down    stop; data is kept
//   node tools/dev/db.mjs reset   stop, delete the data volume, start again
//   node tools/dev/db.mjs status  show the container state
import { composeFile, probe, run } from './lib.mjs';

const compose = ['compose', '-f', composeFile];
const action = process.argv[2];

if (!probe('docker', ['compose', 'version']).ok) {
  console.error('Docker with the compose plugin is not available on this machine.');
  console.error(
    'Install Docker, or use a PostgreSQL 16 server you run yourself (see .env.example).',
  );
  process.exit(1);
}

const steps = {
  up: [[...compose, 'up', '-d', '--wait']],
  down: [[...compose, 'down']],
  reset: [
    [...compose, 'down', '--volumes'],
    [...compose, 'up', '-d', '--wait'],
  ],
  status: [[...compose, 'ps']],
}[action];

if (!steps) {
  console.error('usage: node tools/dev/db.mjs <up|down|reset|status>');
  process.exit(2);
}
for (const args of steps) {
  const code = run('docker', args);
  if (code !== 0) process.exit(code);
}
