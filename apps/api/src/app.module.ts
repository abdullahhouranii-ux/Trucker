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
import { DiscoveryController } from './discovery/discovery.controller.js';
import { DiscoveryService } from './discovery/discovery.service.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { IdentityController } from './identity/identity.controller.js';
import { IdentityService } from './identity/identity.service.js';
import { OrganisationController } from './organisation/organisation.controller.js';
import { OrganisationService } from './organisation/organisation.service.js';
import { ShipmentController } from './shipment/shipment.controller.js';
import { ShipmentService } from './shipment/shipment.service.js';
import {
  DriverController,
  FleetController,
  FleetStaffController,
} from './fleet/fleet.controller.js';
import { AuthorityController } from './authority/authority.controller.js';
import { AuthorityService } from './authority/authority.service.js';
import { BookingController, BookingStaffController } from './booking/booking.controller.js';
import { BookingService } from './booking/booking.service.js';
import {
  AssignmentController,
  AssignmentStaffController,
  DriverAssignmentController,
} from './assignment/assignment.controller.js';
import { AssignmentService } from './assignment/assignment.service.js';
import { FleetService } from './fleet/fleet.service.js';
import { QuotationController } from './quotation/quotation.controller.js';
import { QuotationService } from './quotation/quotation.service.js';
import { ReviewService } from './staff/review.service.js';
import { StaffController } from './staff/staff.controller.js';
import { StaffService } from './staff/staff.service.js';
import { VerificationController } from './verification/verification.controller.js';
import { VerificationService } from './verification/verification.service.js';
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
 * registration), draft organisations, private shipment drafts and staff accounts. Other business modules are gated on recorded decisions
 * (docs/specs/STAGE_3_ARCHITECTURE.md, section 11) and are not scaffolded.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig, clock: Clock = () => new Date()): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        DiscoveryController,
        HealthController,
        IdentityController,
        OrganisationController,
        QuotationController,
        AssignmentController,
        AssignmentStaffController,
        DriverAssignmentController,
        AuthorityController,
        BookingController,
        BookingStaffController,
        FleetController,
        DriverController,
        FleetStaffController,
        ShipmentController,
        StaffController,
        VerificationController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DB_POOL, useFactory: () => createPool(config) },
        { provide: CLOCK, useValue: clock },
        PoolLifecycle,
        HealthService,
        IdentityService,
        AccessGuard,
        OrganisationService,
        ShipmentService,
        DiscoveryService,
        QuotationService,
        AssignmentService,
        AuthorityService,
        BookingService,
        FleetService,
        StaffService,
        ReviewService,
        VerificationService,
      ],
    };
  }
}
