import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { AuthorityService, type Caller } from './authority.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const version = z.number().int().min(1);
const requestBody = z.object({ customerCode: z.string().max(40) });
const decisionBody = z.object({
  version,
  decision: z.enum(['accept', 'decline']),
  mayPublish: z.boolean().optional(),
  feePayerAgreed: z.boolean().optional(),
});
const endBody = z.object({ version });
const named = z.union([z.enum(['customer', 'not_named']), z.object({ name: z.string().max(200) })]);
const partiesBody = z.object({
  version,
  customerAuthorityId: z.union([z.string().regex(UUID), z.null()]),
  sender: named,
  receiver: named,
  freightPayer: z.enum(['customer', 'sender', 'receiver']),
  feePayer: z.enum(['customer', 'organiser']),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '')))]
    .filter((name) => name !== '')
    .sort();
  throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', { fields });
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

/**
 * Authority between a customer and an organiser, and the roles of a shipment. No route here
 * accepts a quotation, sets a price or a commission, or records a payment.
 */
@Controller('organisations/:organisationId')
export class AuthorityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorityService) private readonly authorities: AuthorityService,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Get('authorities')
  async overview(@Param('organisationId') organisationId: string, @Req() request: IncomingRequest) {
    const caller = await this.caller(request);
    return { overview: await this.authorities.overview(caller, identifier(organisationId)) };
  }

  @Post('authorities')
  @HttpCode(201)
  async request(
    @Param('organisationId') organisationId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.authorities.request(
      caller,
      identifier(organisationId),
      parse(requestBody, body).customerCode,
    );
  }

  @Post('authorities/:authorityId/decision')
  @HttpCode(200)
  async decide(
    @Param('organisationId') organisationId: string,
    @Param('authorityId') authorityId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version: seen, ...content } = parse(decisionBody, body);
    return this.authorities.decide(
      caller,
      identifier(organisationId),
      identifier(authorityId),
      seen,
      content,
    );
  }

  @Post('authorities/:authorityId/end')
  @HttpCode(200)
  async end(
    @Param('organisationId') organisationId: string,
    @Param('authorityId') authorityId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.authorities.end(
      caller,
      identifier(organisationId),
      identifier(authorityId),
      parse(endBody, body).version,
    );
  }

  @Get('shipments/:shipmentId/parties')
  async parties(
    @Param('organisationId') organisationId: string,
    @Param('shipmentId') shipmentId: string,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.authorities.parties(caller, identifier(organisationId), identifier(shipmentId));
  }

  @Post('shipments/:shipmentId/parties')
  @HttpCode(200)
  async setParties(
    @Param('organisationId') organisationId: string,
    @Param('shipmentId') shipmentId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version: seen, ...content } = parse(partiesBody, body);
    return this.authorities.setParties(
      caller,
      identifier(organisationId),
      identifier(shipmentId),
      seen,
      content,
    );
  }
}
