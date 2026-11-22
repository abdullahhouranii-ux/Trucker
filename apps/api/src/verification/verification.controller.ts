import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import {
  VerificationService,
  type Caller,
  type VerificationOverview,
} from './verification.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (max: number) =>
  z
    .string()
    .transform((value) => value.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max));
const date = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => (value ?? '').trim())
  .pipe(z.string().regex(/^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$/))
  .transform((value) => (value === '' ? null : value));
const country = z.string().regex(/^$|^[A-Z]{2}$/);

const submissionBody = z.object({
  version: z.number().int().min(1),
  declarationAccepted: z.boolean(),
  declarationLanguage: z.enum(['en', 'ar', 'ur']),
  proposed: z
    .union([
      z.object({ legalName: text(200), countryCode: country, registrationNumber: text(60) }),
      z.null(),
    ])
    .optional()
    .transform((value) => value ?? null),
  capability: z
    .union([z.enum(['ship', 'carry_as_company', 'organise', 'carry_as_owner_operator']), z.null()])
    .optional()
    .transform((value) => value ?? null),
  service: z
    .union([
      z.object({
        countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(30),
        equipmentTypes: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/)).max(30),
      }),
      z.null(),
    ])
    .optional()
    .transform((value) => value ?? null),
  evidence: z
    .array(
      z.object({
        documentType: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
        documentNumber: text(80),
        issuingCountry: country,
        issuedOn: date,
        expiresOn: date,
      }),
    )
    .max(20),
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
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  return match?.[1];
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
 * Verification of one organisation, for its administrators. Nothing here decides anything:
 * decisions are made by staff through the staff routes.
 */
@Controller('organisations/:organisationId/verification')
export class VerificationController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(VerificationService) private readonly verification: VerificationService,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Get()
  async overview(
    @Param('organisationId') organisationId: string,
    @Req() request: IncomingRequest,
  ): Promise<{ verification: VerificationOverview }> {
    const caller = await this.caller(request);
    return { verification: await this.verification.overview(caller, identifier(organisationId)) };
  }

  @Post('applications')
  @HttpCode(201)
  async submit(
    @Param('organisationId') organisationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<{ verification: VerificationOverview }> {
    const caller = await this.caller(request);
    const { version, ...input } = parse(submissionBody, body);
    return {
      verification: await this.verification.submit(
        caller,
        identifier(organisationId),
        retryKey(key),
        version,
        input,
      ),
    };
  }

  @Post('applications/:id/withdraw')
  @HttpCode(200)
  async withdraw(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<{ verification: VerificationOverview }> {
    const caller = await this.caller(request);
    return {
      verification: await this.verification.withdraw(
        caller,
        identifier(organisationId),
        identifier(id),
        retryKey(key),
      ),
    };
  }
}
