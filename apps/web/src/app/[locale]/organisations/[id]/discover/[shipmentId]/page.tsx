import { notFound, redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../../../components/form.tsx';
import { CarrierFacts } from '../../../../../../components/publication-view.tsx';
import { isLocale } from '../../../../../../i18n/config.ts';
import { getMessages } from '../../../../../../i18n/messages.ts';
import {
  api,
  type Catalogues,
  type Country,
  type DiscoveryItem,
} from '../../../../../../server/api.ts';
import { requirePerson } from '../../../../../../server/session.ts';

// One discovered shipment: the carrier projection, judged again by the server at this request.
// A shipment that is no longer discoverable answers exactly like one that never existed.

type Props = { params: Promise<{ locale: string; id: string; shipmentId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DiscoveredShipmentPage({ params }: Props) {
  const { locale, id, shipmentId } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id) || !UUID.test(shipmentId)) notFound();
  const m = getMessages(locale);
  const t = m.disc;
  const person = await requirePerson(locale);
  if (person.state !== 'signed-in') redirect(`/${locale}/sign-in?error=session_ended`);
  const list = `/${locale}/organisations/${id}/discover`;
  const [reply, countries, catalogues] = await Promise.all([
    api<{ shipment: DiscoveryItem }>(
      'GET',
      `/organisations/${id}/discovery/shipments/${shipmentId}`,
      {
        token: person.token,
      },
    ),
    api<{ countries: Country[] }>('GET', '/registration/countries', { token: person.token }),
    api<Catalogues>('GET', `/organisations/${id}/shipment-catalogues`, { token: person.token }),
  ]);
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-list" href={list}>
        {t.backToList}
      </a>
    </div>
  );
  if (!reply.ok || !catalogues.ok) {
    const code = reply.ok ? 'unavailable' : reply.code;
    const message =
      code === 'not_found'
        ? t.errors.not_found
        : code === 'carrier_not_eligible' || code === 'too_many_requests'
          ? t.errors[code]
          : t.errors.unavailable;
    return (
      <div className="page page-narrow" data-state={`discovered-${code}`}>
        {back}
        <h1>{t.detailTitle}</h1>
        <ErrorSummary title={m.auth.errors.summary} problems={[{ message }]} />
      </div>
    );
  }
  const countryName = (code: string): string =>
    (countries.ok ? countries.data.countries : []).find((country) => country.code === code)?.name[
      locale
    ] ?? code;
  return (
    <div className="page page-narrow" data-state="discovered-shipment">
      {back}
      <h1>{t.detailTitle}</h1>
      <p className="notice" role="note" id="no-quotations">
        {t.noQuotations}
      </p>
      <CarrierFacts
        locale={locale}
        t={m.pub}
        view={reply.data.shipment.shipment}
        countryName={countryName}
        catalogues={catalogues.data}
        id="discovered"
      />
      <p id="free-text-note">{t.freeTextNote}</p>
    </div>
  );
}
