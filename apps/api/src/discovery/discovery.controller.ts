import { Controller, Get, Header, Inject, Param, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import {
  DiscoveryService,
  type Caller,
  type DeclaredService,
  type DiscoveryFilter,
  type DiscoveryItem,
  type DiscoveryPage,
} from './discovery.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const code = (pattern: RegExp) =>
  z
    .string()
    .optional()
    .transform((value) => (value ?? '').trim())
    .pipe(z.string().regex(pattern))
    .transform((value) => (value === '' ? undefined : value));
const listQuery = z
  .object({
    pickupCountry: code(/^$|^[A-Z]{2}$/),
    deliveryCountry: code(/^$|^[A-Z]{2}$/),
    equipmentType: code(/^$|^[a-z][a-z0-9_]{1,39}$/),
    cursor: z
      .union([z.string().regex(/^[A-Za-z0-9_-]{1,2000}$/), z.literal('')])
      .optional()
      .transform((value) => (value ? value : null)),
  })
  .strict();

function bearer(request: IncomingRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  return match?.[1];
}
const identifier = (value: string): string => {
  if (!UUID.test(value))
    throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  return value.toLowerCase();
};

/**
 * Discovery for a verified carrier: the shipments it is eligible for, and one of them. Every
 * answer is for this request only and is never to be stored by a cache.
 */
@Controller('organisations/:organisationId/discovery')
export class DiscoveryController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  async status(
    @Param('organisationId') organisationId: string,
    @Req() request: IncomingRequest,
  ): Promise<{ discovery: { mayDiscover: boolean; service: DeclaredService } }> {
    const caller = await this.caller(request);
    return { discovery: await this.discovery.status(caller, identifier(organisationId)) };
  }

  @Get('shipments')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  async list(
    @Param('organisationId') organisationId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: IncomingRequest,
  ): Promise<DiscoveryPage> {
    const caller = await this.caller(request);
    const parsed = listQuery.safeParse(query);
    if (!parsed.success) {
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'query')),
      ];
      throw new ApiError(422, 'validation_failed', 'Some filters are not valid.', { fields });
    }
    const { cursor, ...rest } = parsed.data;
    const filter: DiscoveryFilter = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    );
    return this.discovery.list(caller, identifier(organisationId), filter, cursor);
  }

  @Get('shipments/:shipmentId')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  async detail(
    @Param('organisationId') organisationId: string,
    @Param('shipmentId') shipmentId: string,
    @Req() request: IncomingRequest,
  ): Promise<{ shipment: DiscoveryItem }> {
    const caller = await this.caller(request);
    return {
      shipment: await this.discovery.detail(
        caller,
        identifier(organisationId),
        identifier(shipmentId),
      ),
    };
  }
}
