import { notFound, redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../../components/form.tsx';
import { Ltr } from '../../../../../components/ltr.tsx';
import { shipmentProblems } from '../../../../../components/shipment-form.tsx';
import { ShipmentUnavailable } from '../../../../../components/shipment-unavailable.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import {
  api,
  type Organisation,
  type PlaceOption,
  type ShipmentSummary,
} from '../../../../../server/api.ts';
import { requirePerson } from '../../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export default async function ShipmentsPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.ship;
  const search = await searchParams;
  const LISTS = [
    'draft',
    'published',
    'expired',
    'withdrawn',
    'booking_cancelled',
    'discarded',
  ] as const;
  const status: (typeof LISTS)[number] = LISTS.find((name) => name === search.status) ?? 'draft';
  const after = typeof search.after === 'string' && UUID.test(search.after) ? search.after : null;
  const { problems } = shipmentProblems(
    typeof search.error === 'string' ? search.error : undefined,
    t,
    m.auth.errors.unavailable,
  );
  const here = `/${locale}/organisations/${id}/shipments`;
  const filter = status === 'draft' ? '' : `?status=${status}`;

  const found = await requirePerson(locale);
  const base = `/organisations/${id}`;
  const [organisation, list, places] =
    found.state === 'signed-in'
      ? await Promise.all([
          api<{ organisation: Organisation }>('GET', base, { token: found.token }),
          api<{ shipments: ShipmentSummary[]; nextAfter: string | null }>(
            'GET',
            `${base}/shipments?status=${status}${after ? `&after=${after}` : ''}`,
            { token: found.token },
          ),
          api<{ countries: PlaceOption[] }>('GET', `${base}/shipment-places`, {
            token: found.token,
          }),
        ])
      : [undefined, undefined, undefined];
  for (const reply of [organisation, list, places]) {
    if (reply && !reply.ok && reply.status === 401)
      redirect(`/${locale}/sign-in?error=session_ended`);
    // Not the caller's organisation, or none at all: the same page either way.
    if (reply && !reply.ok && reply.status === 404) notFound();
  }
  // A place in the list that no longer exists: start again from the newest.
  if (list && !list.ok && list.code === 'validation_failed' && after) redirect(`${here}${filter}`);
  if (!organisation?.ok || !list?.ok || !places?.ok) {
    return (
      <ShipmentUnavailable
        m={m}
        reply={[organisation, list, places].find((reply) => reply && !reply.ok)}
        problems={problems}
        retryHref={`${here}${filter}`}
        backHref={`/${locale}/organisations/${id}`}
      />
    );
  }
  const { shipments, nextAfter } = list.data;
  const names = new Map(places.data.countries.map((country) => [country.code, country]));
  const country = (code: string | null) =>
    code ? <bdi>{names.get(code)?.name[locale] ?? code}</bdi> : t.notChosen;

  return (
    <div className="page page-narrow">
      <div className="form-inline">
        <a className="button" href={`/${locale}/organisations/${id}`}>
          {t.backToOrganisation}
        </a>
      </div>
      <h1>{t.listTitle}</h1>
      <ErrorSummary title={m.auth.errors.summary} problems={problems} />
      <p>
        {t.forOrganisation}: <bdi>{organisation.data.organisation.legalName}</bdi>
      </p>
      <p>{t.listLead}</p>
      {places.data.countries.some((place) => place.fixture) ? (
        <p className="notice notice-development" role="note" id="fixture-notice">
          {t.fixtureNotice}
        </p>
      ) : null}
      <nav className="form-inline" aria-label={t.listTitle}>
        <a
          className="button"
          id="filter-open"
          href={here}
          aria-current={status === 'draft' ? 'page' : undefined}
        >
          {t.filterOpen}
        </a>
        {(['published', 'expired', 'withdrawn', 'booking_cancelled'] as const).map((name) => (
          <a
            key={name}
            className="button"
            id={`filter-${name}`}
            href={`${here}?status=${name}`}
            aria-current={status === name ? 'page' : undefined}
          >
            {name === 'published'
              ? m.pub.filterPublished
              : name === 'expired'
                ? m.pub.filterExpired
                : name === 'booking_cancelled'
                  ? m.pub.filterBookingCancelled
                  : m.pub.filterWithdrawn}
          </a>
        ))}
        <a
          className="button"
          id="filter-discarded"
          href={`${here}?status=discarded`}
          aria-current={status === 'discarded' ? 'page' : undefined}
        >
          {t.filterDiscarded}
        </a>
      </nav>
      <p className="form-note">{t.orderNote}</p>
      {shipments.length === 0 ? (
        <p id="no-shipments">
          {status === 'discarded' ? t.noneDiscarded : status === 'draft' ? t.none : m.pub.noneHere}
        </p>
      ) : null}
      <ul className="organisation-list" id="shipment-list">
        {shipments.map((shipment) => {
          const title = shipment.shipperReference ?? shipment.cargoDescription;
          return (
            <li key={shipment.id} className="card organisation" data-shipment={shipment.id}>
              <h2>
                {shipment.shipperReference ? (
                  <Ltr>{shipment.shipperReference}</Ltr>
                ) : shipment.cargoDescription ? (
                  <bdi className="clamp">{shipment.cargoDescription}</bdi>
                ) : (
                  t.untitled
                )}
              </h2>
              <p className="chip chip-draft" data-state={shipment.status}>
                {shipment.status === 'draft'
                  ? t.statusDraft
                  : shipment.status === 'discarded'
                    ? t.statusDiscarded
                    : m.pub.status[shipment.status]}
              </p>
              {shipment.shipperReference && shipment.cargoDescription ? (
                <p>
                  <bdi className="clamp">{shipment.cargoDescription}</bdi>
                </p>
              ) : null}
              <p>
                {t.from}: {country(shipment.pickupCountry)}
                <br />
                {t.to}: {country(shipment.deliveryCountry)}
              </p>
              <p className="form-note">
                {t.created}: <Ltr>{when(shipment.createdAt)}</Ltr>
                <br />
                {t.changed}: <Ltr>{when(shipment.updatedAt)}</Ltr>
              </p>
              <a className="button" href={`${here}/${shipment.id}`}>
                {t.open}
                <span className="visually-hidden">
                  {' '}
                  <bdi>{title ?? t.untitled}</bdi>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      <div className="form-inline">
        {nextAfter ? (
          <a
            className="button"
            id="older-shipments"
            href={`${here}?${status === 'draft' ? '' : `status=${status}&`}after=${nextAfter}`}
          >
            {t.nextPage}
          </a>
        ) : null}
        {after ? (
          <a className="button" id="newest-shipments" href={`${here}${filter}`}>
            {t.firstPage}
          </a>
        ) : null}
        {status === 'draft' ? (
          <a className="button button-primary" id="create-shipment" href={`${here}/new`}>
            {t.createLink}
          </a>
        ) : null}
      </div>
    </div>
  );
}
