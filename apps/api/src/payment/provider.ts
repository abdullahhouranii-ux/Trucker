/**
 * A payment provider, as Trucker needs one (ADR-001 G-10). Provider-neutral: a real provider
 * is an implementation of this interface, chosen and contracted separately. None is chosen; the
 * only implementation is a development stand-in (test-provider.ts) that moves no money.
 *
 * What counts as proof is narrow (R-12): a notification whose signature `verify` accepts, or
 * the answer to `status` asked by the server. A payer's return from the checkout is not proof.
 */
export interface CheckoutRequest {
  /** Trucker's checkout identifier. Also the idempotency key: asking twice opens one checkout. */
  readonly checkoutId: string;
  /** The reference the payer sees, as for a transfer. */
  readonly reference: string;
  /** Exact decimal text, in the currency's minor units. */
  readonly amount: string;
  readonly currency: string;
  /** The provider must refuse payment after this. */
  readonly expiresAt: Date;
}
export interface OpenedCheckout {
  readonly providerReference: string;
  /** Where the payer goes to pay; null when the caller builds the address itself. */
  readonly url: string | null;
}
/** What a provider says of a checkout, in Trucker's terms (payment_report's content). */
export interface ProviderReport {
  readonly status: 'paid' | 'failed' | 'expired';
  readonly providerReference: string;
  readonly transactionId?: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly paidAt?: string;
}
export interface VerifiedNotification {
  readonly notificationId: string;
  readonly report: ProviderReport;
}
export type CheckoutStatus = ProviderReport | { readonly status: 'open' | 'unknown' };

/** A refund of (part of) an online payment. The refund's identifier is the idempotency key. */
export interface RefundRequest {
  readonly refundId: string;
  readonly providerReference: string;
  readonly transactionId: string;
  readonly amount: string;
  readonly currency: string;
}
export interface RefundAnswer {
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly providerRefundReference: string;
  readonly reason?: string;
}

export interface PaymentProvider {
  readonly name: 'test';
  openCheckout(request: CheckoutRequest): Promise<OpenedCheckout>;
  /** The signed notification, or null when its signature, age or form is not accepted. */
  verify(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedNotification | null;
  /** Asked by the server, never by the payer. */
  status(providerReference: string): Promise<CheckoutStatus>;
  /** Asking again with the same refund identifier must reach the same refund, never a second. */
  refund(request: RefundRequest): Promise<RefundAnswer>;
  /** What the provider knows of a refund, by Trucker's identifier; unknown if it never had it. */
  refundStatus(refundId: string): Promise<RefundAnswer | { readonly status: 'unknown' }>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * The provider answered, and its answer is no: no checkout exists. Any other failure (a timeout,
 * a lost connection) leaves it unknown whether the provider opened one.
 */
export class ProviderRefused extends Error {}
