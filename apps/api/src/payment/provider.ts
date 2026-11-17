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
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
