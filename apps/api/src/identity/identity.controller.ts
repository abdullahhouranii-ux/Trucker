import {
  Body,
  Controller,
  Delete,
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
import {
  IdentityService,
  type Authenticated,
  type CodeRequestResult,
  type PersonView,
  type SessionView,
  type SignInResult,
} from './identity.service.js';
import { normalizePhone } from './phone.js';
import { demonstrationTerms, isTermsLanguage, TERMS_LANGUAGES, type TermsText } from './terms.js';

interface IncomingRequest {
  requestId?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const codeRequestBody = z.object({ phone: z.string().min(1).max(40) });
const verificationBody = z.object({
  challengeId: z.string().regex(UUID),
  code: z.string().regex(/^[0-9]{6}$/),
});
const registrationBody = z.object({
  displayName: z
    .string()
    .transform((value) => value.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1).max(120)),
  contactEmail: z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z.union([
        z.literal(''),
        z
          .string()
          .max(254)
          .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
      ]),
    )
    .optional(),
  termsVersion: z.string().min(1).max(64),
  termsLanguage: z.enum(TERMS_LANGUAGES),
  termsSeen: z.literal(true),
});

/** Validates a body and reports which fields are wrong, never their values. */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? 'body')))];
  throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', { fields });
}

function retryKey(value: string | undefined): string {
  if (!value || !RETRY_KEY.test(value)) {
    throw new ApiError(
      400,
      'retry_key_required',
      'An Idempotency-Key header of 16 to 128 safe characters is required.',
    );
  }
  return value;
}

function bearer(request: IncomingRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  return match?.[1];
}

@Controller()
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  private authenticate(request: IncomingRequest): Promise<Authenticated> {
    return this.identity.authenticate(bearer(request), request.requestId);
  }

  /** Step 1 of sign-in. Answers the same way for known and unknown numbers. */
  @Post('auth/code-requests')
  @HttpCode(202)
  async requestCode(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<CodeRequestResult> {
    const input = parse(codeRequestBody, body);
    const phone = normalizePhone(input.phone);
    if (!phone)
      throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
        fields: ['phone'],
      });
    const local = LOCAL_ADDRESSES.has(request.socket?.remoteAddress ?? '');
    return this.identity.requestCode(phone, retryKey(key), local);
  }

  /** Step 2 of sign-in: a correct code becomes a session. */
  @Post('auth/code-verifications')
  @HttpCode(200)
  async verifyCode(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<SignInResult> {
    const input = parse(verificationBody, body);
    return this.identity.verifyCode(
      input.challengeId,
      input.code,
      retryKey(key),
      request.requestId,
    );
  }

  @Get('registration/terms')
  terms(@Query('language') language: string | undefined): TermsText {
    if (!isTermsLanguage(language)) {
      throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
        fields: ['language'],
      });
    }
    return demonstrationTerms(language);
  }

  @Get('me')
  async me(@Req() request: IncomingRequest): Promise<{ person: PersonView; session: SessionView }> {
    return this.identity.me(await this.authenticate(request));
  }

  @Post('me/registration')
  @HttpCode(200)
  async register(
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<{ person: PersonView }> {
    const auth = await this.authenticate(request);
    const input = parse(registrationBody, body);
    const person = await this.identity.completeRegistration(
      auth,
      {
        displayName: input.displayName,
        contactEmail: input.contactEmail ? input.contactEmail : null,
        termsVersion: input.termsVersion,
        termsLanguage: input.termsLanguage,
      },
      request.requestId,
    );
    return { person };
  }

  @Get('me/sessions')
  async sessions(@Req() request: IncomingRequest): Promise<{ sessions: SessionView[] }> {
    return { sessions: await this.identity.listSessions(await this.authenticate(request)) };
  }

  @Post('me/sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@Req() request: IncomingRequest): Promise<{ revoked: number }> {
    const auth = await this.authenticate(request);
    return { revoked: await this.identity.revokeOtherSessions(auth, request.requestId) };
  }

  /** Ends one of the caller's sessions. Ending the current one signs the caller out. */
  @Delete('me/sessions/:id')
  @HttpCode(204)
  async revoke(@Param('id') id: string, @Req() request: IncomingRequest): Promise<void> {
    const auth = await this.authenticate(request);
    if (!UUID.test(id))
      throw new ApiError(404, 'not_found', 'The requested resource was not found.');
    await this.identity.revokeSession(auth, id, request.requestId);
  }

  @Post('auth/sign-out')
  @HttpCode(204)
  async signOut(@Req() request: IncomingRequest): Promise<void> {
    const auth = await this.authenticate(request);
    await this.identity.revokeSession(auth, auth.sessionId, request.requestId);
  }
}
