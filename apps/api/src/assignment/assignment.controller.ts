import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { StaffService } from '../staff/staff.service.js';
import { AssignmentService, type Caller } from './assignment.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const member = z.string().regex(UUID).nullable();
// The whole set the carrier wants. A member left null is unassigned.
const assignmentBody = z.object({
  version: z.number().int().min(0),
  truckId: member,
  trailerId: member,
  driverId: member,
});
const decisionBody = z.object({
  version: z.number().int().min(1),
  decision: z.enum(['accept', 'decline', 'withdraw']),
});
const acknowledgeBody = z.object({ version: z.number().int().min(1) });

function bearer(request: IncomingRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return /^Bearer ([A-Za-z0-9._-]+)$/.exec(header)?.[1];
}
const identifier = (value: string): string => {
  if (!UUID.test(value))
    throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  return value.toLowerCase();
};
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'body'))),
    ];
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields,
      problems: fields.map((field) => ({ field, code: 'invalid' })),
    });
  }
  return parsed.data;
}
const lower = (value: string | null): string | null =>
  value === null ? null : value.toLowerCase();

/**
 * A booking's resources. No route here dispatches, opens or closes occupancy, cancels,
 * releases, invoices or pays.
 */
@Controller('organisations/:organisationId')
export class AssignmentController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AssignmentService) private readonly assignments: AssignmentService,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Get('bookings/:bookingId')
  @Header('Cache-Control', 'no-store')
  async detail(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.assignments.detail(caller, identifier(organisationId), identifier(bookingId));
  }

  @Post('bookings/:bookingId/assignment')
  @HttpCode(200)
  async assign(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const input = parse(assignmentBody, body);
    return this.assignments.assign(caller, identifier(organisationId), identifier(bookingId), {
      version: input.version,
      truckId: lower(input.truckId),
      trailerId: lower(input.trailerId),
      driverId: lower(input.driverId),
    });
  }

  @Post('bookings/:bookingId/wait')
  @HttpCode(200)
  async wait(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.assignments.wait(caller, identifier(organisationId), identifier(bookingId));
  }

  @Post('substitutions/:substitutionId/decision')
  @HttpCode(200)
  async decide(
    @Param('organisationId') organisationId: string,
    @Param('substitutionId') substitutionId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const input = parse(decisionBody, body);
    return this.assignments.decide(
      caller,
      identifier(organisationId),
      identifier(substitutionId),
      input.version,
      input.decision,
    );
  }
}

/** The driver: their own assignments and their acknowledgement. */
@Controller('me/driver/assignments')
export class DriverAssignmentController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AssignmentService) private readonly assignments: AssignmentService,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: IncomingRequest) {
    return { assignments: await this.assignments.driverAssignments(await this.caller(request)) };
  }

  @Post(':bookingId/acknowledge')
  @HttpCode(200)
  async acknowledge(
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.assignments.acknowledge(
      caller,
      identifier(bookingId),
      parse(acknowledgeBody, body).version,
    );
  }
}

/** Staff: the bookings that need attention. Read-only. */
@Controller('staff/bookings')
export class AssignmentStaffController {
  constructor(
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(AssignmentService) private readonly assignments: AssignmentService,
  ) {}

  @Get('attention')
  @Header('Cache-Control', 'no-store')
  async attention(@Req() request: IncomingRequest) {
    const caller = await this.staff.authenticate(bearer(request), request.requestId);
    return { attention: await this.assignments.staffAttention(caller) };
  }
}
