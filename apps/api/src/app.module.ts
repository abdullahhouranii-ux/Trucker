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
import { APP_CONFIG, DB_POOL } from './tokens.js';

@Injectable()
class PoolLifecycle implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Foundation slice only: configuration, database pool, health. Business modules are gated on
 * recorded decisions (docs/specs/STAGE_3_ARCHITECTURE.md, section 11) and are not scaffolded.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DB_POOL, useFactory: () => createPool(config) },
        PoolLifecycle,
        HealthService,
      ],
    };
  }
}
