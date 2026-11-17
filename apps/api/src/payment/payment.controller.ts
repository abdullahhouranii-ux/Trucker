import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { PaymentService, type Caller } from './payment.service.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './provider.js';
import { TestPaymentProvider } from './test-provider.js';

interface IncomingRequest {
  requestId?: string;
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /^[A-Za-z0-9_.:-]{1,200}$/;
const checkoutBody = z.object({ bookingId: z.string().regex(UUID) });
const completeBody = z.object({
  outcome: z.enum(['paid', 'declined']),
  /** Tests only: the stand-in takes the money but its notification is lost. */
  notify: z.boolean().optional(),
});

function bearer(request: IncomingRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return /^Bearer ([A-Za-z0-9._-]+)$/.exec(header)?.[1];
}
const notFound = (): never => {
  throw new ApiError(404, 'not_found', 'The requested resource was not found.');
};

/**
 * Online payment of Trucker's fee: the payer's checkout, the providers' notifications, and the
 * development stand-in's own pages (only when PAYMENT_PROVIDER is test).
 */
@Controller()
export class PaymentController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PaymentService) private readonly payments: PaymentService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Get('payments/options')
  options() {
    return this.payments.options();
  }

  @Post('organisations/:organisationId/fee-checkouts')
  async checkout(
    @Param('organisationId') organisationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    if (!UUID.test(organisationId)) notFound();
    const parsed = checkoutBody.safeParse(body);
    if (!parsed.success)
      throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
        fields: ['bookingId'],
      });
    if (!key || !RETRY_KEY.test(key))
      throw new ApiError(
        400,
        'retry_key_required',
        'Send an Idempotency-Key header of 16 to 128 letters, digits, dots, dashes or underscores.',
      );
    return this.payments.openCheckout(
      caller,
      organisationId.toLowerCase(),
      parsed.data.bookingId.toLowerCase(),
      key,
    );
  }

  /** A provider's notification. The body is read raw (configure-app.ts) for its signature. */
  @Post('payments/notifications/:provider')
  @HttpCode(200)
  notification(@Param('provider') provider: string, @Req() request: IncomingRequest) {
    return this.payments.receive(provider, request.rawBody, request.headers);
  }

  private standIn(): TestPaymentProvider {
    if (!(this.provider instanceof TestPaymentProvider)) notFound();
    return this.provider as TestPaymentProvider;
  }

  /** The stand-in's checkout, for its page in the web application. */
  @Get('payments/test/checkouts/:reference')
  testCheckout(@Param('reference') reference: string) {
    const view = REFERENCE.test(reference) ? this.standIn().view(reference) : null;
    if (!view) notFound();
    return { checkout: view };
  }

  /** The payer pays or declines on the stand-in's page; the stand-in then notifies, signed. */
  @Post('payments/test/checkouts/:reference/complete')
  @HttpCode(200)
  async testComplete(@Param('reference') reference: string, @Body() body: unknown) {
    const standIn = this.standIn();
    if (!REFERENCE.test(reference) || !standIn.view(reference)) notFound();
    const parsed = completeBody.safeParse(body);
    if (!parsed.success)
      throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
        fields: ['outcome'],
      });
    const notice = standIn.complete(reference, parsed.data.outcome);
    if (!notice)
      throw new ApiError(409, 'checkout_not_open', 'This checkout is no longer open.', {
        checkout: standIn.view(reference),
      });
    if (parsed.data.notify === false) return { outcome: parsed.data.outcome, notified: false };
    const received = await this.payments.receive('test', notice.body, notice.headers);
    return { outcome: parsed.data.outcome, notified: true, result: received.result };
  }
}
