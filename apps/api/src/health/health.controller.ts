import { Controller, Get, Inject, Res } from '@nestjs/common';
import { HealthService, type ReadinessChecks } from './health.service.js';

interface StatusSetter {
  status(code: number): unknown;
}

/**
 * Health endpoints keep their own response bodies, also on failure: infrastructure reads them.
 * They are the one exception to the standard error body (http/api-error.ts).
 */
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
  async ready(
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<{ status: 'ready' | 'not_ready'; checks: ReadinessChecks }> {
    const checks = await this.health.check();
    if (checks.database !== 'ok' || checks.migrations !== 'ok') {
      response.status(503);
      return { status: 'not_ready', checks };
    }
    return { status: 'ready', checks };
  }
}
