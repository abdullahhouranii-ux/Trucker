import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Caller } from '../assignment/assignment.service.js';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { TripService } from './trip.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const MILESTONES = [
  'departed_for_pickup',
  'arrived_at_pickup',
  'loading_started',
  'loaded_departed',
  'arrived_at_delivery',
  'unloading_started',
] as const;
// The database judges every value; these bound what reaches it.
const driverMilestoneBody = z.object({
  version: z.number().int().min(1),
  milestone: z.enum(MILESTONES),
});
const onBehalfBody = z.object({
  version: z.number().int().min(1),
  milestone: z.enum(MILESTONES),
  statedAt: z.string().max(40),
  reason: z.enum(['no_phone', 'no_signal', 'driver_unable', 'correction', 'other']),
  note: z.union([z.string().max(2000), z.null()]).optional(),
});
const estimateBody = z.object({ arrivalAt: z.string().max(40) });
const EXCEPTION_TYPES = [
  'delay',
  'breakdown',
  'accident',
  'cargo_damage_or_shortage',
  'refused_at_site',
  'receiver_absent',
  'document_problem',
  'road_closed',
  'safety_concern',
  'no_show',
  'other',
] as const;
const exceptionBody = z.object({
  type: z.enum(EXCEPTION_TYPES),
  description: z.string().max(4000),
});
function retryKey(key: string | undefined): string {
  if (!key || !RETRY_KEY.test(key))
    throw new ApiError(
      400,
      'retry_key_required',
      'Send an Idempotency-Key header of 16 to 128 letters, digits, dots, dashes or underscores.',
    );
  return key;
}

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

async function callerOf(identity: IdentityService, request: IncomingRequest): Promise<Caller> {
  const auth = await identity.authenticate(bearer(request), request.requestId);
  return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
}

/** The carrier: dispatch, milestones on the driver's behalf, the arrival estimate. */
@Controller('organisations/:organisationId/bookings/:bookingId')
export class TripController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(TripService) private readonly trips: TripService,
  ) {}

  @Post('dispatch')
  @HttpCode(200)
  async dispatch(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    if (!key || !RETRY_KEY.test(key))
      throw new ApiError(
        400,
        'retry_key_required',
        'Send an Idempotency-Key header of 16 to 128 letters, digits, dots, dashes or underscores.',
      );
    return this.trips.dispatch(caller, identifier(organisationId), identifier(bookingId), key);
  }

  @Post('milestones')
  @HttpCode(200)
  async onBehalf(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    const { version, ...content } = parse(onBehalfBody, body);
    return this.trips.milestoneOnBehalf(
      caller,
      identifier(organisationId),
      identifier(bookingId),
      version,
      content,
    );
  }

  @Post('exceptions')
  @HttpCode(200)
  async exception(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    const checked = retryKey(key);
    return this.trips.reportException(
      caller,
      identifier(organisationId),
      identifier(bookingId),
      checked,
      parse(exceptionBody, body),
    );
  }

  @Post('estimate')
  @HttpCode(200)
  async estimate(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    return this.trips.estimate(
      caller,
      identifier(organisationId),
      identifier(bookingId),
      parse(estimateBody, body).arrivalAt,
    );
  }
}

/** The driver: milestones as they happen, and the arrival estimate. */
@Controller('me/driver/assignments/:bookingId')
export class DriverTripController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(TripService) private readonly trips: TripService,
  ) {}

  @Post('milestones')
  @HttpCode(200)
  async milestone(
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    const { version, milestone } = parse(driverMilestoneBody, body);
    return this.trips.milestoneByDriver(caller, identifier(bookingId), version, milestone);
  }

  @Post('estimate')
  @HttpCode(200)
  async estimate(
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    return this.trips.estimate(
      caller,
      '',
      identifier(bookingId),
      parse(estimateBody, body).arrivalAt,
    );
  }

  @Post('exceptions')
  @HttpCode(200)
  async exception(
    @Param('bookingId') bookingId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    const checked = retryKey(key);
    return this.trips.reportException(
      caller,
      '',
      identifier(bookingId),
      checked,
      parse(exceptionBody, body),
    );
  }
}
