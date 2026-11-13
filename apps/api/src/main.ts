import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigError, loadConfig, type AppConfig } from './config/config.js';

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

const app = await NestFactory.create(AppModule.register(config));
app.enableShutdownHooks();
await app.listen(config.PORT);
