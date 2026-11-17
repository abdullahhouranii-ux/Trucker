'use server';

import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, type ApiReply } from './api.ts';
import { endSession, sessionToken } from './session.ts';

// Online payment of Trucker's fee. The payer is sent to the provider's checkout; coming back
// from it proves nothing (R-12): the booking shows the fee paid only once the provider's signed
// notification has been recorded. Problems travel back as short codes.

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const localeOf = (form: FormData): Locale => {
  const value = text(form, 'locale');
  return isLocale(value) ? value : defaultLocale;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const REFERENCE = /^[A-Za-z0-9_.:-]{1,200}$/;
const CODE = /^[a-z_]{1,40}$/;
/** Only a booking or shipment page of this site is a place to come back to. */
const RETURN = /^\/(en|ar|ur)\/organisations\/[0-9a-f-]{36}\/(bookings|shipments)\/[0-9a-f-]{36}$/;
const unknown = (reply: Extract<ApiReply<unknown>, { ok: false }>): boolean =>
  reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable';
const returnOf = (form: FormData, locale: Locale): string => {
  const value = text(form, 'returnTo');
  return RETURN.test(value) ? value : `/${locale}/account`;
};

/** Opens a checkout with the payment provider, or resumes the one in progress. */
export async function payFeeOnlineAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const back = returnOf(form, locale);
  const organisationId = text(form, 'organisationId');
  const bookingId = text(form, 'bookingId');
  const key = text(form, 'retryKey');
  if (!UUID.test(organisationId) || !UUID.test(bookingId) || !RETRY_KEY.test(key))
    redirect(`${back}?payError=invalid#fee-payment`);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const reply = await api<{
    checkout: { provider: string; providerReference: string | null; url: string | null };
  }>('POST', `/organisations/${organisationId}/fee-checkouts`, {
    token,
    retryKey: key,
    body: { bookingId },
  });
  if (reply.ok) {
    const checkout = reply.data.checkout;
    // The stand-in's page is part of this site. A real provider's address would come from it.
    if (
      checkout.provider === 'test' &&
      checkout.providerReference &&
      REFERENCE.test(checkout.providerReference)
    )
      redirect(
        `/${locale}/payments/test/${checkout.providerReference}?return=${encodeURIComponent(back)}`,
      );
    redirect(`${back}?payError=online_payment_unavailable#fee-payment`);
  }
  if (reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
  if (
    unknown(reply) &&
    reply.code !== 'online_payment_unavailable' &&
    reply.code !== 'payment_provider_unavailable'
  )
    redirect(`${back}?payError=pay_unconfirmed#fee-payment`);
  redirect(`${back}?payError=${CODE.test(reply.code) ? reply.code : 'invalid'}#fee-payment`);
}

/** The stand-in's page: the payer pays or declines. No money moves. */
export async function standInCheckoutAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const back = returnOf(form, locale);
  const reference = text(form, 'reference');
  const outcome = text(form, 'outcome');
  if (!REFERENCE.test(reference) || !['paid', 'declined'].includes(outcome))
    redirect(`${back}?payment=closed#fee-payment`);
  const reply = await api<{ outcome: string }>(
    'POST',
    `/payments/test/checkouts/${reference}/complete`,
    { body: { outcome } },
  );
  if (reply.ok) redirect(`${back}?payment=${outcome}#fee-payment`);
  // Coming back says nothing either way: the booking page shows what was recorded.
  redirect(`${back}?payment=${reply.status === 409 ? 'closed' : 'returned'}#fee-payment`);
}
