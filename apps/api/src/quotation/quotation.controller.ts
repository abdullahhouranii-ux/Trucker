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
import { QuotationService, type Caller, type QuotationInput } from './quotation.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const moment = z.object({
  local: z.string().max(20),
  offsetMinutes: z.number().int().min(-1440).max(1440).optional(),
});
// The amount stays a string end to end: it is never turned into a binary number.
const content = z.object({
  amount: z.string().max(20),
  // The commission and the net the carrier accepts, on a shipment that carries a commission.
  commissionAccepted: z
    .object({ commission: z.string().max(20), net: z.string().max(20) })
    .optional(),
  inclusions: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), z.boolean()),
  validUntil: moment,
  earliestPickup: moment,
  notes: z
    .union([z.string().max(2000), z.null()])
    .optional()
    .transform((value) => {
      const trimmed = (value ?? '').normalize('NFC').trim();
      return trimmed === '' ? null : trimmed;
    }),
});
const versioned = z.object({ version: z.number().int().min(1) });
const revision = content.extend({ version: z.number().int().min(1) });
const reconfirmation = z.object({
  version: z.number().int().min(1),
  commissionAccepted: content.shape.commissionAccepted,
});
const termsBody = z.object({
  version: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(body)'))];
  throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
    fields,
    problems: fields.map((field) => ({ field, code: 'invalid' })),
  });
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
const retryKey = (key: string | undefined): string => {
  if (!key || !RETRY_KEY.test(key))
    throw new ApiError(
      400,
      'retry_key_required',
      'Send an Idempotency-Key header of 16 to 128 letters, digits, dots, dashes or underscores.',
    );
  return key;
};

/**
 * Quotations: the carrier's routes under its own organisation, the shipper's under its
 * shipments. No acceptance, booking, fee or payment route exists.
 */
@Controller('organisations/:organisationId')
export class QuotationController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(QuotationService) private readonly quotations: QuotationService,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  // The carrier -------------------------------------------------------------------------------
  @Get('discovery/shipments/:shipmentId/quotation')
  @Header('Cache-Control', 'no-store')
  async context(
    @Param('organisationId') organisationId: string,
    @Param('shipmentId') shipmentId: string,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return {
      quotation: await this.quotations.context(
        caller,
        identifier(organisationId),
        identifier(shipmentId),
      ),
    };
  }

  @Post('discovery/shipments/:shipmentId/quotations')
  @HttpCode(201)
  async submit(
    @Param('organisationId') organisationId: string,
    @Param('shipmentId') shipmentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const input = parse(content, body) as QuotationInput;
    return this.quotations.submit(
      caller,
      identifier(organisationId),
      identifier(shipmentId),
      retryKey(key),
      input,
    );
  }

  @Get('quotations')
  @Header('Cache-Control', 'no-store')
  async list(@Param('organisationId') organisationId: string, @Req() request: IncomingRequest) {
    const caller = await this.caller(request);
    return { quotations: await this.quotations.list(caller, identifier(organisationId)) };
  }

  @Post('quotations/:quotationId/revisions')
  @HttpCode(200)
  async revise(
    @Param('organisationId') organisationId: string,
    @Param('quotationId') quotationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version, ...input } = parse(revision, body);
    return this.quotations.revise(
      caller,
      identifier(organisationId),
      identifier(quotationId),
      retryKey(key),
      version,
      input as QuotationInput,
    );
  }

  @Post('quotations/:quotationId/reconfirm')
  @HttpCode(200)
  async reconfirm(
    @Param('organisationId') organisationId: string,
    @Param('quotationId') quotationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version, commissionAccepted } = parse(reconfirmation, body);
    return this.quotations.reconfirm(
      caller,
      identifier(organisationId),
      identifier(quotationId),
      retryKey(key),
      version,
      commissionAccepted,
    );
  }

  @Post('quotations/:quotationId/withdraw')
  @HttpCode(200)
  async withdraw(
    @Param('organisationId') organisationId: string,
    @Param('quotationId') quotationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version } = parse(versioned, body);
    return this.quotations.withdraw(
      caller,
      identifier(organisationId),
      identifier(quotationId),
      retryKey(key),
      version,
    );
  }

  // The shipper -------------------------------------------------------------------------------
  @Get('shipments/:shipmentId/quotations')
  @Header('Cache-Control', 'no-store')
  async forShipment(
    @Param('organisationId') organisationId: string,
    @Param('shipmentId') shipmentId: string,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return {
      quotations: await this.quotations.shipmentQuotations(
        caller,
        identifier(organisationId),
        identifier(shipmentId),
      ),
    };
  }

  @Post('shipments/:shipmentId/quotation-terms')
  @HttpCode(200)
  async setTerms(
    @Param('organisationId') organisationId: string,
    @Param('shipmentId') shipmentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version, currency } = parse(termsBody, body);
    return this.quotations.setTerms(
      caller,
      identifier(organisationId),
      identifier(shipmentId),
      retryKey(key),
      version,
      currency,
    );
  }

  @Post('quotations/:quotationId/reject')
  @HttpCode(200)
  async reject(
    @Param('organisationId') organisationId: string,
    @Param('quotationId') quotationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version } = parse(versioned, body);
    return this.quotations.reject(
      caller,
      identifier(organisationId),
      identifier(quotationId),
      retryKey(key),
      version,
    );
  }
}
