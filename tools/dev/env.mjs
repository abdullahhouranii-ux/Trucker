// Creates .env from .env.example if it does not exist. Never overwrites an existing .env.
import { copyFileSync, existsSync } from 'node:fs';
import { envExample, envFile } from './lib.mjs';

if (existsSync(envFile)) {
  console.log('.env already exists; left unchanged');
} else {
  copyFileSync(envExample, envFile);
  console.log('.env created from .env.example (local-only values)');
}
