import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { HealthService, type ReadinessChecks } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Liveness: the process is running. Never touches the database. */
  @Get('live')
  live(): { status: 'live' } {
    return { status: 'live' };
  }

  /** Readiness: safe to receive traffic. 503 names the failing check without internal detail. */
  @Get('ready')
  async ready(): Promise<{ status: 'ready'; checks: ReadinessChecks }> {
    const checks = await this.health.check();
    if (checks.database !== 'ok' || checks.migrations !== 'ok') {
      throw new ServiceUnavailableException({ status: 'not_ready', checks });
    }
    return { status: 'ready', checks };
  }
}
