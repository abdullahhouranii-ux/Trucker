import { notFound } from 'next/navigation';
import { InstantText } from '../../../../../components/booking-view.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import { api } from '../../../../../server/api.ts';
import { standInCheckoutAction } from '../../../../../server/payment-actions.ts';

// The development stand-in for a payment provider's checkout page. It moves no money and asks
// for no card. A real provider's page is the provider's own; this one exists only when the API
// runs with PAYMENT_PROVIDER=test, and answers "not found" otherwise.

type Props = {
  params: Promise<{ locale: string; reference: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const REFERENCE = /^[A-Za-z0-9_.:-]{1,200}$/;
const RETURN = /^\/(en|ar|ur)\/organisations\/[0-9a-f-]{36}\/(bookings|shipments)\/[0-9a-f-]{36}$/;

interface StandInCheckout {
  providerReference: string;
  reference: string;
  amount: string;
  currency: string;
  expiresAt: string;
  status: 'open' | 'paid' | 'failed' | 'expired';
}

export default async function StandInCheckoutPage({ params, searchParams }: Props) {
  const { locale, reference } = await params;
  if (!isLocale(locale) || !REFERENCE.test(reference)) notFound();
  const search = await searchParams;
  const back = typeof search.return === 'string' && RETURN.test(search.return) ? search.return : '';
  const t = getMessages(locale).payTest;
  const reply = await api<{ checkout: StandInCheckout }>(
    'GET',
    `/payments/test/checkouts/${reference}`,
  );
  if (!reply.ok && reply.status === 404) notFound();
  if (!reply.ok)
    return (
      <div className="page page-narrow" data-state="stand-in-unavailable">
        <h1>{t.title}</h1>
        <p className="notice notice-error" role="alert">
          {t.unavailable}
        </p>
      </div>
    );
  const checkout = reply.data.checkout;
  const open = checkout.status === 'open';
  return (
    <div className="page page-narrow" data-state="stand-in-checkout" data-status={checkout.status}>
      <h1>{t.title}</h1>
      <p className="notice" role="note" id="stand-in-notice">
        {t.notice}
      </p>
      <dl className="facts">
        <div>
          <dt>{t.amount}</dt>
          <dd id="stand-in-amount">
            <bdi dir="ltr">
              {checkout.amount} {checkout.currency}
            </bdi>
          </dd>
        </div>
        <div>
          <dt>{t.reference}</dt>
          <dd>
            <bdi dir="ltr">{checkout.reference}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t.expires}</dt>
          <dd>
            <InstantText at={checkout.expiresAt} />
          </dd>
        </div>
      </dl>
      {open ? (
        <div className="form-inline">
          <form action={standInCheckoutAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="reference" value={checkout.providerReference} />
            <input type="hidden" name="returnTo" value={back} />
            <input type="hidden" name="outcome" value="paid" />
            <button className="button button-primary" type="submit" id="stand-in-pay">
              {t.pay}
            </button>
          </form>
          <form action={standInCheckoutAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="reference" value={checkout.providerReference} />
            <input type="hidden" name="returnTo" value={back} />
            <input type="hidden" name="outcome" value="declined" />
            <button className="button" type="submit" id="stand-in-decline">
              {t.decline}
            </button>
          </form>
        </div>
      ) : (
        <p id="stand-in-closed">{t.closed}</p>
      )}
      {back ? (
        <div className="form-inline">
          <a className="button" href={back} id="stand-in-back">
            {t.back}
          </a>
        </div>
      ) : null}
    </div>
  );
}
