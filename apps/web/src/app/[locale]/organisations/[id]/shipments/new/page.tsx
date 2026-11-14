import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../../../components/draft-keeper.tsx';
import { ErrorSummary } from '../../../../../../components/form.tsx';
import { ShipmentFields, shipmentProblems } from '../../../../../../components/shipment-form.tsx';
import { ShipmentUnavailable } from '../../../../../../components/shipment-unavailable.tsx';
import { isLocale } from '../../../../../../i18n/config.ts';
import { getMessages } from '../../../../../../i18n/messages.ts';
import { api, type PlaceOption } from '../../../../../../server/api.ts';
import { createShipmentAction } from '../../../../../../server/shipment-actions.ts';
import { requirePerson } from '../../../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewShipmentPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.ship;
  const search = await searchParams;
  const found = shipmentProblems(
    typeof search.error === 'string' ? search.error : undefined,
    t,
    m.auth.errors.unavailable,
    {
      limit:
        typeof search.limit === 'string' && /^[0-9]{1,5}$/.test(search.limit) ? search.limit : '',
    },
  );
  // After a refusal the same key comes back, so sending the same details again cannot save a
  // second draft if the first attempt did reach the server.
  const retryKey =
    typeof search.retry === 'string' && RETRY_KEY.test(search.retry) ? search.retry : randomUUID();
  const list = `/${locale}/organisations/${id}/shipments`;

  const person = await requirePerson(locale);
  const places =
    person.state === 'signed-in'
      ? await api<{ countries: PlaceOption[] }>('GET', `/organisations/${id}/shipment-places`, {
          token: person.token,
        })
      : undefined;
  if (places && !places.ok && places.status === 401)
    redirect(`/${locale}/sign-in?error=session_ended`);
  if (places && !places.ok && places.status === 404) notFound();
  if (!places?.ok) {
    return (
      <ShipmentUnavailable
        m={m}
        reply={places}
        problems={found.problems}
        retryHref={`${list}/new?retry=${retryKey}`}
        backHref={`/${locale}/organisations/${id}`}
      />
    );
  }
  const formId = `shipment-new-form-${id}`;

  return (
    <div className="page page-narrow">
      <div className="form-inline">
        <a className="button" href={list}>
          {t.backToList}
        </a>
      </div>
      <h1>{t.newTitle}</h1>
      <ErrorSummary title={m.auth.errors.summary} problems={found.problems} />
      <p>{t.newLead}</p>
      {places.data.countries.some((place) => place.fixture) ? (
        <p className="notice notice-development" role="note" id="fixture-notice">
          {t.fixtureNotice}
        </p>
      ) : null}
      <form className="form card" id={formId} action={createShipmentAction} noValidate>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="organisationId" value={id} />
        <input type="hidden" name="retryKey" value={retryKey} />
        <ShipmentFields locale={locale} t={t} places={places.data.countries} problems={found} />
        <button className="button button-primary" type="submit">
          {t.submitCreate}
        </button>
      </form>
      <DraftKeeper formId={formId} />
    </div>
  );
}
