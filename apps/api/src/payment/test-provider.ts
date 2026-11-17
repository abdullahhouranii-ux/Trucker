import { randomBytes } from 'node:crypto';
import {
  ProviderRefused,
  type CheckoutRequest,
  type CheckoutStatus,
  type OpenedCheckout,
  type PaymentProvider,
  type ProviderReport,
  type RefundAnswer,
  type RefundRequest,
  type VerifiedNotification,
} from './provider.js';
import { SIGNATURE_HEADER, sign, signatureValid } from './signature.js';

/**
 * A development stand-in for a payment provider. It moves no money and asks for no card: its
 * checkout page (in the web application) offers "pay" and "decline" buttons, and it then sends a
 * signed notification exactly as a provider would. Its checkouts live in this process only, so
 * a restart forgets them; a status check then answers "unknown" and the booking waits for its
 * deadline. Refused in production (config.ts).
 */
interface Session {
  readonly providerReference: string;
  readonly checkoutId: string;
  readonly reference: string;
  readonly amount: string;
  readonly currency: string;
  readonly expiresAt: Date;
  status: 'open' | 'paid' | 'failed';
  transactionId?: string;
  paidAt?: Date;
}
export interface TestCheckoutView {
  providerReference: string;
  reference: string;
  amount: string;
  currency: string;
  expiresAt: string;
  status: 'open' | 'paid' | 'failed' | 'expired';
}
export interface SignedNotice {
  body: Buffer;
  headers: Record<string, string>;
}

const token = (prefix: string): string => `${prefix}_${randomBytes(10).toString('hex')}`;

export class TestPaymentProvider implements PaymentProvider {
  readonly name = 'test' as const;
  private readonly sessions = new Map<string, Session>();
  private readonly byCheckout = new Map<string, string>();
  /**
   * Tests only: how the stand-in misbehaves. `lose-next-answer` opens the checkout and then
   * fails as if the answer were lost; `refuse-next` refuses to open one; `outage` answers nothing.
   */
  trouble: 'none' | 'lose-next-answer' | 'refuse-next' | 'fail-next-refund' | 'outage' = 'none';
  private readonly refunds = new Map<
    string,
    RefundAnswer & { transactionId: string; amount: string }
  >();

  constructor(
    private readonly secret: string,
    private readonly clock: () => Date,
  ) {}

  async openCheckout(request: CheckoutRequest): Promise<OpenedCheckout> {
    if (this.trouble === 'outage') throw new Error('the stand-in is unreachable');
    if (this.trouble === 'refuse-next') {
      this.trouble = 'none';
      throw new ProviderRefused('the stand-in refused the checkout');
    }
    const known = this.byCheckout.get(request.checkoutId);
    if (known) return { providerReference: known, url: null };
    const providerReference = token('tchk');
    this.sessions.set(providerReference, {
      providerReference,
      checkoutId: request.checkoutId,
      reference: request.reference,
      amount: request.amount,
      currency: request.currency,
      expiresAt: request.expiresAt,
      status: 'open',
    });
    this.byCheckout.set(request.checkoutId, providerReference);
    if (this.trouble === 'lose-next-answer') {
      this.trouble = 'none';
      throw new Error('the answer was lost');
    }
    return { providerReference, url: null };
  }

  /** Tests only: how many checkouts the stand-in holds for a fee reference. */
  checkoutsFor(reference: string): number {
    return [...this.sessions.values()].filter((session) => session.reference === reference).length;
  }

  private state(session: Session): TestCheckoutView['status'] {
    return session.status === 'open' && this.clock() >= session.expiresAt
      ? 'expired'
      : session.status;
  }

  /** What the stand-in's checkout page shows. */
  view(providerReference: string): TestCheckoutView | null {
    const session = this.sessions.get(providerReference);
    if (!session) return null;
    return {
      providerReference,
      reference: session.reference,
      amount: session.amount,
      currency: session.currency,
      expiresAt: session.expiresAt.toISOString(),
      status: this.state(session),
    };
  }

  /**
   * The payer pays or declines on the stand-in's page. Returns the signed notification the
   * stand-in sends, or null when the checkout is not open (paid, declined or expired).
   */
  complete(providerReference: string, outcome: 'paid' | 'declined'): SignedNotice | null {
    const session = this.sessions.get(providerReference);
    if (!session || this.state(session) !== 'open') return null;
    if (outcome === 'paid') {
      session.status = 'paid';
      session.transactionId = token('ttx');
      session.paidAt = this.clock();
    } else {
      session.status = 'failed';
    }
    return this.notice(session);
  }

  /** The signed notification for a checkout's present state. Tests use it to send it again. */
  notice(session: Session | string): SignedNotice | null {
    const found = typeof session === 'string' ? this.sessions.get(session) : session;
    if (!found || found.status === 'open') return null;
    const body = Buffer.from(
      JSON.stringify({
        id: token('tevt'),
        type: found.status === 'paid' ? 'checkout.paid' : 'checkout.failed',
        checkout: found.providerReference,
        transaction: found.transactionId ?? null,
        amount: found.amount,
        currency: found.currency,
        paidAt: found.paidAt?.toISOString() ?? null,
      }),
    );
    return { body, headers: { [SIGNATURE_HEADER]: sign(this.secret, body, this.clock()) } };
  }

  verify(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedNotification | null {
    const header = headers[SIGNATURE_HEADER];
    if (
      !signatureValid(
        this.secret,
        rawBody,
        typeof header === 'string' ? header : undefined,
        this.clock(),
      )
    )
      return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const event = parsed as Record<string, unknown>;
    const types: Record<string, ProviderReport['status']> = {
      'checkout.paid': 'paid',
      'checkout.failed': 'failed',
      'checkout.expired': 'expired',
    };
    const status = typeof event.type === 'string' ? types[event.type] : undefined;
    if (typeof event.id !== 'string' || typeof event.checkout !== 'string' || !status) return null;
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' ? value : undefined;
    return {
      notificationId: `test:${event.id}`,
      report: {
        status,
        providerReference: event.checkout,
        ...(text(event.transaction) ? { transactionId: text(event.transaction)! } : {}),
        ...(text(event.amount) ? { amount: text(event.amount)! } : {}),
        ...(text(event.currency) ? { currency: text(event.currency)! } : {}),
        ...(text(event.paidAt) ? { paidAt: text(event.paidAt)! } : {}),
      },
    };
  }

  async refund(request: RefundRequest): Promise<RefundAnswer> {
    if (this.trouble === 'outage') throw new Error('the stand-in is unreachable');
    const known = this.refunds.get(request.refundId);
    if (known) return this.answer(known);
    const session = this.sessions.get(request.providerReference);
    const minor = (value: string): number => Math.round(Number(value) * 1000);
    const already = [...this.refunds.values()]
      .filter((item) => item.transactionId === request.transactionId && item.status === 'succeeded')
      .reduce((sum, item) => sum + minor(item.amount), 0);
    let status: RefundAnswer['status'] = 'succeeded';
    let reason: string | undefined;
    if (!session || session.status !== 'paid' || session.transactionId !== request.transactionId) {
      status = 'failed';
      reason = 'no such payment';
    } else if (
      request.currency !== session.currency ||
      already + minor(request.amount) > minor(session.amount)
    ) {
      status = 'failed';
      reason = 'more than was paid';
    } else if (this.trouble === 'fail-next-refund') {
      this.trouble = 'none';
      status = 'failed';
      reason = 'declined by the stand-in';
    }
    const record = {
      status,
      providerRefundReference: token('tref'),
      ...(reason ? { reason } : {}),
      transactionId: request.transactionId,
      amount: request.amount,
    };
    this.refunds.set(request.refundId, record);
    if (this.trouble === 'lose-next-answer') {
      this.trouble = 'none';
      throw new Error('the answer was lost');
    }
    return this.answer(record);
  }

  private answer(record: RefundAnswer): RefundAnswer {
    return {
      status: record.status,
      providerRefundReference: record.providerRefundReference,
      ...(record.reason ? { reason: record.reason } : {}),
    };
  }

  async refundStatus(refundId: string): Promise<RefundAnswer | { readonly status: 'unknown' }> {
    if (this.trouble === 'outage') throw new Error('the stand-in is unreachable');
    const known = this.refunds.get(refundId);
    return known ? this.answer(known) : { status: 'unknown' };
  }

  /** Tests only: how much the stand-in has paid back on a transaction. */
  refundedOn(transactionId: string): number {
    return (
      [...this.refunds.values()]
        .filter((item) => item.transactionId === transactionId && item.status === 'succeeded')
        .reduce((sum, item) => sum + Math.round(Number(item.amount) * 1000), 0) / 1000
    );
  }

  async status(providerReference: string): Promise<CheckoutStatus> {
    if (this.trouble === 'outage') throw new Error('the stand-in is unreachable');
    const session = this.sessions.get(providerReference);
    if (!session) return { status: 'unknown' };
    const state = this.state(session);
    if (state === 'open') return { status: 'open' };
    if (state === 'paid')
      return {
        status: 'paid',
        providerReference,
        transactionId: session.transactionId!,
        amount: session.amount,
        currency: session.currency,
        paidAt: session.paidAt!.toISOString(),
      };
    return { status: state, providerReference };
  }
}
