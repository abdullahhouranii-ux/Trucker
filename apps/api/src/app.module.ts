import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from './config/config.js';
import { createPool } from './database/pool.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { IdentityController } from './identity/identity.controller.js';
import { IdentityService, type Clock } from './identity/identity.service.js';
import { APP_CONFIG, CLOCK, DB_POOL } from './tokens.js';

@Injectable()
class PoolLifecycle implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Configuration, database pool, health, and identity (sign-in by one-time code, sessions,
 * registration). Other business modules are gated on recorded decisions
 * (docs/specs/STAGE_3_ARCHITECTURE.md, section 11) and are not scaffolded.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig, clock: Clock = () => new Date()): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, IdentityController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DB_POOL, useFactory: () => createPool(config) },
        { provide: CLOCK, useValue: clock },
        PoolLifecycle,
        HealthService,
        IdentityService,
      ],
    };
  }
}
