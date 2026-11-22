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
import {
  DiscoveryController,
  PublicShipmentsController,
} from './discovery/discovery.controller.js';
import { RecordPhotosController } from './storage/record-photos.controller.js';
import { BookingCompletionController } from './trip/booking-completion.controller.js';
import { DisputesController } from './trip/disputes.controller.js';
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
import {
  DriverTripController,
  OrganiserCargoController,
  TripController,
} from './trip/trip.controller.js';
import { TripService } from './trip/trip.service.js';
import { DriverPodController, PodController, StaffPodController } from './trip/pod.controller.js';
import { PodService } from './trip/pod.service.js';
import { LocalFileStore } from './storage/file-store.js';
import { FleetService } from './fleet/fleet.service.js';
import { QuotationController } from './quotation/quotation.controller.js';
import { QuotationService } from './quotation/quotation.service.js';
import { FeeLapseJob } from './fee/fee-lapse.job.js';
import { DEVELOPMENT_PAYMENT_TEST_SECRET } from './config/config.js';
import { PaymentController } from './payment/payment.controller.js';
import { PaymentService } from './payment/payment.service.js';
import { PAYMENT_PROVIDER } from './payment/provider.js';
import { TestPaymentProvider } from './payment/test-provider.js';
import { FeeService } from './staff/fee.service.js';
import { RefundService } from './staff/refund.service.js';
import { InvitationService } from './staff/invitation.service.js';
import { OperationsService } from './staff/operations.service.js';
import { TripWatchJob } from './trip/trip-watch.job.js';
import { FinanceService } from './staff/finance.service.js';
import { ReviewService } from './staff/review.service.js';
import { StaffController } from './staff/staff.controller.js';
import { StaffService } from './staff/staff.service.js';
import { VerificationController } from './verification/verification.controller.js';
import { VerificationService } from './verification/verification.service.js';
import { APP_CONFIG, CLOCK, DB_POOL, FILE_STORE, type Clock } from './tokens.js';

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
        PublicShipmentsController,
        DisputesController,
        BookingCompletionController,
        RecordPhotosController,
        HealthController,
        IdentityController,
        OrganisationController,
        QuotationController,
        AssignmentController,
        AssignmentStaffController,
        DriverAssignmentController,
        TripController,
        DriverTripController,
        OrganiserCargoController,
        PodController,
        DriverPodController,
        StaffPodController,
        AuthorityController,
        BookingController,
        BookingStaffController,
        FleetController,
        DriverController,
        FleetStaffController,
        ShipmentController,
        StaffController,
        VerificationController,
        PaymentController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DB_POOL, useFactory: () => createPool(config) },
        { provide: CLOCK, useValue: clock },
        {
          // Proof-of-delivery files: a development stand-in on this machine, or closed (D-011).
          provide: FILE_STORE,
          useValue:
            config.FILE_STORAGE === 'local' && config.FILE_STORAGE_DIR
              ? new LocalFileStore(config.FILE_STORAGE_DIR)
              : null,
        },
        {
          provide: PAYMENT_PROVIDER,
          useValue:
            config.PAYMENT_PROVIDER === 'test'
              ? new TestPaymentProvider(
                  config.PAYMENT_TEST_SECRET ?? DEVELOPMENT_PAYMENT_TEST_SECRET,
                  clock,
                )
              : null,
        },
        PaymentService,
        PoolLifecycle,
        HealthService,
        IdentityService,
        AccessGuard,
        OrganisationService,
        ShipmentService,
        DiscoveryService,
        QuotationService,
        AssignmentService,
        TripService,
        PodService,
        AuthorityService,
        BookingService,
        FleetService,
        StaffService,
        ReviewService,
        FinanceService,
        FeeService,
        RefundService,
        InvitationService,
        OperationsService,
        TripWatchJob,
        FeeLapseJob,
        VerificationService,
      ],
    };
  }
}
