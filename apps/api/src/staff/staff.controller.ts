import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { ReviewService, type QueueEntry } from './review.service.js';
import {
  StaffService,
  type AuditEntry,
  type StaffCaller,
  type StaffView,
} from './staff.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_TOKEN = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/);

const email = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(3)
      .max(254)
      .regex(/^[^@\s]+@[^@\s]+$/),
  );
// A password is taken exactly as typed: no trimming and no rewriting.
const password = z.string().min(1).max(128);
const code = z.string().min(1).max(40);
const participantLink = z
  .object({
    participantLink: z.enum(['declared_none', 'declared']),
    participantPhone: z
      .union([z.string(), z.null()])
      .optional()
      .transform((value) => (value ?? '').replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^$|^\+[1-9][0-9]{6,14}$/))
      .transform((value) => (value === '' ? null : value)),
  })
  .refine((value) => (value.participantLink === 'declared') === (value.participantPhone !== null), {
    path: ['participantPhone'],
  });

const tokenBody = z.object({ token: SECRET_TOKEN });
const beginBody = z.object({ token: SECRET_TOKEN, password: z.string().min(12).max(128) });
const completeBody = z.object({ token: SECRET_TOKEN, code });
const signInBody = z.object({ email, password });
const signInCodeBody = z.object({ ticket: SECRET_TOKEN, code });
const createBody = z
  .object({
    email,
    displayName: z
      .string()
      .transform((value) => value.normalize('NFC').replace(/\s+/g, ' ').trim())
      .pipe(z.string().min(1).max(120)),
  })
  .and(participantLink);
const statusBody = z.object({ status: z.enum(['enabled', 'disabled']) });
const note = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => (value ?? '').normalize('NFC').trim())
  .pipe(z.string().max(1000))
  .transform((value) => (value === '' ? null : value));
const decisionBody = z.object({
  version: z.number().int().min(1),
  decision: z.enum(['verified', 'changes_requested', 'rejected']),
  reason: z.string().regex(/^[a-z_]{2,40}$/),
  note,
  noConflict: z.boolean(),
});
const revokeBody = z.object({
  reason: z.string().regex(/^[a-z_]{2,40}$/),
  note,
  noConflict: z.boolean(),
});
const privilegeBody = z.object({
  privilege: z.enum(['staff_admin', 'reviewer']),
  granted: z.boolean(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(body)'))];
  throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', { fields });
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

/**
 * Staff routes, for the staff console only. A participant's token opens none of them and a
 * staff token opens no participant route: they are looked up in different tables. Every
 * route that acts for a signed-in staff member authenticates first; the database then checks
 * the privilege again for itself.
 */
@Controller('staff')
export class StaffController {
  constructor(
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(ReviewService) private readonly review: ReviewService,
  ) {}

  private caller(request: IncomingRequest): Promise<StaffCaller> {
    return this.staff.authenticate(bearer(request), request.requestId);
  }

  // The enrolment token travels in the body, never in the address, so it is not written to
  // access logs here.
  @Post('enrolment/state')
  @HttpCode(200)
  enrolmentState(@Body() body: unknown): Promise<{ email: string }> {
    return this.staff.enrolmentState(parse(tokenBody, body).token);
  }

  @Post('enrolment/begin')
  @HttpCode(200)
  enrolmentBegin(
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ email: string; secret: string; otpauthUri: string }> {
    const input = parse(beginBody, body);
    return this.staff.enrolmentBegin(input.token, input.password, request.requestId);
  }

  @Post('enrolment/complete')
  @HttpCode(200)
  enrolmentComplete(
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ recoveryCodes: string[] }> {
    const input = parse(completeBody, body);
    return this.staff.enrolmentComplete(input.token, input.code, request.requestId);
  }

  @Post('sign-in')
  @HttpCode(200)
  signIn(@Body() body: unknown, @Req() request: IncomingRequest): Promise<{ ticket: string }> {
    const input = parse(signInBody, body);
    return this.staff.signInPassword(input.email, input.password, request.requestId);
  }

  @Post('sign-in/code')
  @HttpCode(200)
  signInCode(
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ token: string; staff: StaffView }> {
    const input = parse(signInCodeBody, body);
    return this.staff.signInCode(input.ticket, input.code, request.requestId);
  }

  @Get('me')
  async me(
    @Req() request: IncomingRequest,
  ): Promise<{ staff: StaffView; sessionExpiresAt: string }> {
    const caller = await this.caller(request);
    return this.staff.me(caller.tokenHash);
  }

  @Post('sign-out')
  @HttpCode(204)
  async signOut(@Req() request: IncomingRequest): Promise<void> {
    await this.staff.signOut(await this.caller(request));
  }

  @Get('accounts')
  async accounts(@Req() request: IncomingRequest): Promise<{ accounts: StaffView[] }> {
    return { accounts: await this.staff.list(await this.caller(request)) };
  }

  @Post('accounts')
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<{ account: StaffView; enrolmentToken: string; linkExpiresAt: string }> {
    const caller = await this.caller(request);
    if (!key || !RETRY_KEY.test(key))
      throw new ApiError(
        400,
        'retry_key_required',
        'Send an Idempotency-Key header of 16 to 128 letters, digits, dots, dashes or underscores.',
      );
    return this.staff.create(caller, key, parse(createBody, body));
  }

  @Post('accounts/:id/enrolment')
  @HttpCode(200)
  async issueEnrolment(
    @Param('id') id: string,
    @Req() request: IncomingRequest,
  ): Promise<{ account: StaffView; enrolmentToken: string; linkExpiresAt: string }> {
    return this.staff.issueEnrolment(await this.caller(request), identifier(id));
  }

  @Post('accounts/:id/status')
  @HttpCode(200)
  async setStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ account: StaffView; outcome: 'changed' | 'unchanged' }> {
    const caller = await this.caller(request);
    return this.staff.setStatus(caller, identifier(id), parse(statusBody, body).status);
  }

  @Post('accounts/:id/privileges')
  @HttpCode(200)
  async setPrivilege(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ account: StaffView; outcome: 'changed' | 'unchanged' }> {
    const caller = await this.caller(request);
    const input = parse(privilegeBody, body);
    return this.staff.setPrivilege(caller, identifier(id), input.privilege, input.granted);
  }

  @Post('accounts/:id/participant-link')
  @HttpCode(200)
  async setParticipantLink(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ account: StaffView; outcome: 'changed' | 'unchanged' }> {
    const caller = await this.caller(request);
    const input = parse(participantLink, body);
    return this.staff.setParticipantLink(
      caller,
      identifier(id),
      input.participantLink,
      input.participantPhone,
    );
  }

  @Get('audit')
  async audit(
    @Query('after') after: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<{ entries: AuditEntry[]; nextAfter: string | null }> {
    const caller = await this.caller(request);
    if (after !== undefined && !/^[0-9]{1,18}$/.test(after))
      throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
        fields: ['after'],
      });
    return this.staff.audit(caller, after ?? null);
  }
  // ------------------------------------------------------------------------------------------
  // Verification. The reviewer privilege is checked by the database in each call.
  // ------------------------------------------------------------------------------------------
  @Get('shipments')
  async shipmentList(
    @Req() request: IncomingRequest,
  ): Promise<{ shipments: Record<string, unknown>[] }> {
    return { shipments: await this.review.shipments(await this.caller(request)) };
  }

  @Get('shipments/:id')
  async shipmentView(
    @Param('id') id: string,
    @Req() request: IncomingRequest,
  ): Promise<Record<string, unknown>> {
    return this.review.shipment(await this.caller(request), identifier(id));
  }

  @Get('verification')
  async verificationQueue(
    @Req() request: IncomingRequest,
  ): Promise<{ applications: QueueEntry[] }> {
    return { applications: await this.review.queue(await this.caller(request)) };
  }

  @Get('verification/:id')
  async verificationView(
    @Param('id') id: string,
    @Req() request: IncomingRequest,
  ): Promise<Record<string, unknown>> {
    return this.review.view(await this.caller(request), identifier(id));
  }

  @Post('verification/:id/decision')
  @HttpCode(200)
  async verificationDecide(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ outcome: 'decided' | 'already_decided' | 'claim_review' }> {
    const caller = await this.caller(request);
    return this.review.decide(caller, identifier(id), parse(decisionBody, body));
  }

  @Post('verification/organisations/:organisationId/revoke')
  @HttpCode(200)
  async verificationRevoke(
    @Param('organisationId') organisationId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ outcome: 'revoked' | 'already_revoked' }> {
    const caller = await this.caller(request);
    return this.review.revoke(caller, identifier(organisationId), parse(revokeBody, body));
  }
}
