import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigError, loadConfig, type AppConfig } from './config/config.js';
import { AccessGuard, productionStartProblems } from './database/access.js';
import { configureApp } from './http/configure-app.js';
import { jsonLogger } from './http/logger.js';

let config: AppConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const app = configureApp(await NestFactory.create(AppModule.register(config)), jsonLogger);
app.enableShutdownHooks();
if (config.NODE_ENV === 'production') {
  // Production does not serve with a database role that row security does not bind, nor
  // against a database that was not deliberately marked production.
  let problems: string[];
  try {
    problems = productionStartProblems(await app.get(AccessGuard).inspect());
  } catch {
    problems = [
      'the database role and environment mark could not be read (are migrations applied?)',
    ];
  }
  if (problems.length > 0) {
    console.error(
      `Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    await app.close();
    process.exit(1);
  }
}
await app.listen(config.PORT);
