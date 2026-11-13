// Runs a command with the values from .env added to the environment:
//   node tools/dev/with-env.mjs npm run db:migrate
// Values already set in the real environment win over .env.
import { developmentEnv, run } from './lib.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node tools/dev/with-env.mjs <command> [arguments]');
  process.exit(2);
}
process.exit(run(command, args, { env: developmentEnv() }));
