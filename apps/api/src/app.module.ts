import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from './config/config.js';
import { AccessGuard } from './database/access.js';
import { createPool } from './database/pool.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { IdentityController } from './identity/identity.controller.js';
import { IdentityService } from './identity/identity.service.js';
import { OrganisationController } from './organisation/organisation.controller.js';
import { OrganisationService } from './organisation/organisation.service.js';
import { APP_CONFIG, CLOCK, DB_POOL, type Clock } from './tokens.js';

@Injectable()
class PoolLifecycle implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Configuration, database pool, health, identity (sign-in by one-time code, sessions,
 * registration) and draft organisations. Other business modules are gated on recorded decisions
 * (docs/specs/STAGE_3_ARCHITECTURE.md, section 11) and are not scaffolded.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig, clock: Clock = () => new Date()): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, IdentityController, OrganisationController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DB_POOL, useFactory: () => createPool(config) },
        { provide: CLOCK, useValue: clock },
        PoolLifecycle,
        HealthService,
        IdentityService,
        AccessGuard,
        OrganisationService,
      ],
    };
  }
}
