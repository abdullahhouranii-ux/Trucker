import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { hashToken } from '../identity/secrets.js';
import {
  OrganisationService,
  type Caller,
  type CountryView,
  type HistoryEntry,
  type OrganisationInput,
  type OrganisationSummary,
  type OrganisationView,
} from './organisation.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Text is kept as typed, in any script. Only surrounding space is removed and the Unicode
// form is normalised, so the same name typed twice compares equal.
const text = (max: number) =>
  z
    .string()
    .transform((value) => value.normalize('NFC').trim())
    .pipe(z.string().min(1).max(max));
const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => (value ?? '').normalize('NFC').trim())
    .pipe(z.string().max(max))
    .transform((value) => (value === '' ? null : value));

const organisationFields = {
  legalName: text(200),
  tradingName: optionalText(200),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  registrationNumber: text(60),
  address: optionalText(500),
  contactName: optionalText(120),
};
const createBody = z.object(organisationFields);
const updateBody = z.object({ ...organisationFields, version: z.number().int().min(1) });

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
  const match = /^Bearer ([A-Za-z0-9._-]{1,200})$/.exec(header);
  return match?.[1];
}

const organisationId = (id: string): string => {
  // Not a well-formed identifier: answered like any organisation the caller cannot see.
  if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  return id.toLowerCase();
};

@Controller()
export class OrganisationController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(OrganisationService) private readonly organisations: OrganisationService,
  ) {}

  /**
   * Every organisation endpoint starts here: the session is checked (revoked, idle and
   * expired sessions are refused) before anything else is read, including stored retries.
   */
  private async caller(request: IncomingRequest): Promise<Caller> {
    const token = bearer(request);
    const auth = await this.identity.authenticate(token, request.requestId);
    return { personId: auth.personId, tokenHash: hashToken(token!), requestId: request.requestId };
  }

  /** Countries open for registration. Signed-in people only. */
  @Get('registration/countries')
  async countries(@Req() request: IncomingRequest): Promise<{ countries: CountryView[] }> {
    await this.caller(request);
    return { countries: await this.organisations.countries() };
  }

  @Post('organisations')
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<{ organisation: OrganisationView }> {
    const caller = await this.caller(request);
    if (!key || !RETRY_KEY.test(key))
      throw new ApiError(
        400,
        'retry_key_required',
        'Send an Idempotency-Key header of 16 to 128 letters, digits, dots, dashes or underscores.',
      );
    const input: OrganisationInput = parse(createBody, body);
    return { organisation: await this.organisations.create(caller, key, input) };
  }

  @Get('organisations')
  async list(@Req() request: IncomingRequest): Promise<{ organisations: OrganisationSummary[] }> {
    const caller = await this.caller(request);
    return { organisations: await this.organisations.list(caller) };
  }

  @Get('organisations/:id')
  async get(
    @Param('id') id: string,
    @Req() request: IncomingRequest,
  ): Promise<{ organisation: OrganisationView }> {
    const caller = await this.caller(request);
    return { organisation: await this.organisations.get(caller, organisationId(id)) };
  }

  @Patch('organisations/:id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ organisation: OrganisationView }> {
    const caller = await this.caller(request);
    const { version, ...input } = parse(updateBody, body);
    return {
      organisation: await this.organisations.update(caller, organisationId(id), version, input),
    };
  }

  @Get('organisations/:id/history')
  async history(
    @Param('id') id: string,
    @Req() request: IncomingRequest,
  ): Promise<{ entries: HistoryEntry[] }> {
    const caller = await this.caller(request);
    return { entries: await this.organisations.history(caller, organisationId(id)) };
  }
}
