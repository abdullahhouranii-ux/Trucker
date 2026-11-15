import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { StaffService } from '../staff/staff.service.js';
import { BookingService, type Caller } from './booking.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const versioned = z.object({ version: z.number().int().min(1) });

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

/**
 * Acceptance and bookings. No route assigns, reserves, confirms, cancels, invoices or pays.
 */
@Controller('organisations/:organisationId')
export class BookingController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(BookingService) private readonly bookings: BookingService,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Post('quotations/:quotationId/accept')
  @HttpCode(200)
  async accept(
    @Param('organisationId') organisationId: string,
    @Param('quotationId') quotationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const parsed = versioned.safeParse(body);
    if (!parsed.success)
      throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
        fields: ['version'],
        problems: [{ field: 'version', code: 'invalid' }],
      });
    if (!key || !RETRY_KEY.test(key))
      throw new ApiError(
        400,
        'retry_key_required',
        'Send an Idempotency-Key header of 16 to 128 letters, digits, dots, dashes or underscores.',
      );
    return this.bookings.accept(
      caller,
      identifier(organisationId),
      identifier(quotationId),
      parsed.data.version,
      key,
    );
  }

  @Get('shipments/:shipmentId/booking')
  @Header('Cache-Control', 'no-store')
  async overview(
    @Param('organisationId') organisationId: string,
    @Param('shipmentId') shipmentId: string,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.bookings.overview(caller, identifier(organisationId), identifier(shipmentId));
  }

  @Get('bookings')
  @Header('Cache-Control', 'no-store')
  async list(@Param('organisationId') organisationId: string, @Req() request: IncomingRequest) {
    const caller = await this.caller(request);
    return { bookings: await this.bookings.list(caller, identifier(organisationId)) };
  }
}

@Controller('staff/shipments')
export class BookingStaffController {
  constructor(
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(BookingService) private readonly bookings: BookingService,
  ) {}

  @Get(':id/booking')
  async booking(@Param('id') id: string, @Req() request: IncomingRequest) {
    const caller = await this.staff.authenticate(bearer(request), request.requestId);
    return this.bookings.staffBooking(caller, identifier(id));
  }
}
