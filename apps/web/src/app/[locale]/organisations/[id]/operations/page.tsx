import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { RecordOptions } from '../../../../../components/record-options.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import {
  api,
  type Booking,
  type Fleet,
  type Organisation,
  type ShipmentSummary,
} from '../../../../../server/api.ts';
import { requirePerson } from '../../../../../server/session.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = { id: string; cells: ReactNode[]; actions: { label: string; href: string }[] };

function OperationsTable({
  title,
  headers,
  rows,
  empty,
}: {
  title: string;
  headers: string[];
  rows: Row[];
  empty: string;
}) {
  if (!rows.length) return <p className="operations-empty">{empty}</p>;
  return (
    <table className="operations-table" role="table" aria-label={title}>
      <thead role="rowgroup">
        <tr role="row">
          {headers.map((label) => (
            <th key={label} scope="col" role="columnheader">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody role="rowgroup">
        {rows.map((row) => (
          <tr key={row.id} role="row">
            {row.cells.map((cell, index) => (
              <td key={headers[index]} role="cell">
                <span className="operations-cell-label" aria-hidden="true">
                  {headers[index]}
                </span>
                <span>{cell}</span>
              </td>
            ))}
            <td role="cell">
              <RecordOptions label={headers.at(-1)! + ' ' + row.id.slice(0, 8)}>
                {row.actions.map(({ label, href }) => (
                  <li key={href}>
                    <a className="button" href={href}>
                      {label}
                    </a>
                  </li>
                ))}
              </RecordOptions>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function OperationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ after?: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale) || !uuid.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.operationsWorkspace;
  const found = await requirePerson(locale);
  const options = { token: found.token };
  const base = '/organisations/' + id;
  const home = '/' + locale + base;
  const org = await api<{ organisation: Organisation }>('GET', base, options);
  if (!org.ok && org.status === 401) redirect('/' + locale + '/sign-in?error=session_ended');
  if (!org.ok && org.status === 404) notFound();
  if (!org.ok)
    return (
      <div className="page">
        <h1>{t.title}</h1>
        <p role="alert">{t.unavailable}</p>
      </div>
    );
  const { after: value } = await searchParams;
  const after = typeof value === 'string' && uuid.test(value) ? value : undefined;
  const [shipments, bookings, fleet] = await Promise.all([
    api<{ shipments: ShipmentSummary[]; nextAfter: string | null }>(
      'GET',
      base + '/shipments?status=all' + (after ? '&after=' + after : ''),
      options,
    ),
    api<{ bookings: Booking[] }>('GET', base + '/bookings', options),
    api<{ fleet: Fleet }>('GET', base + '/fleet', options),
  ]);
  if ([shipments, bookings, fleet].some((reply) => reply.status === 401))
    redirect('/' + locale + '/sign-in?error=session_ended');
  const region = new Intl.DisplayNames(locale, { type: 'region' });
  const country = (code: string | null) =>
    code && /^[A-Z]{2}$/.test(code) ? (region.of(code) ?? code) : '—';
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const open = (href: string) => ({ label: t.open, href });
  const shipmentRows: Row[] = shipments.ok
    ? shipments.data.shipments.map((item) => {
        const href = home + '/shipments/' + item.id;
        const state =
          item.status === 'draft'
            ? m.ship.statusDraft
            : item.status === 'discarded'
              ? m.ship.statusDiscarded
              : m.pub.status[item.status];
        const edits =
          item.status === 'draft'
            ? [{ label: m.ship.editTitle, href: href + '#edit-title' }]
            : item.status === 'published' || item.status === 'suspended'
              ? [{ label: m.pub.changeLink, href: href + '/change' }]
              : [];
        return {
          id: item.id,
          cells: [
            <bdi key="reference">
              {item.shipperReference || item.cargoDescription || item.id.slice(0, 8)}
            </bdi>,
            <span className="chip" key="state">
              {state}
            </span>,
            country(item.pickupCountry) + ' – ' + country(item.deliveryCountry),
          ],
          actions: [open(href), ...edits],
        };
      })
    : [];
  const bookingRows: Row[] = bookings.ok
    ? bookings.data.bookings.slice(0, 15).map((booking) => {
        const href = home + '/bookings/' + booking.id;
        const counterparty = booking.role === 'carrier' ? booking.shipper : booking.carrier;
        const dispatch =
          booking.role === 'carrier' &&
          booking.status === 'confirmed' &&
          !booking.trip &&
          booking.dispatch.ready;
        return {
          id: booking.id,
          cells: [
            <bdi key="name">{counterparty.tradingName || counterparty.legalName}</bdi>,
            <span className="chip" key="state">
              {m.book.status[booking.status]}
            </span>,
            date.format(new Date(booking.acceptedAt)),
          ],
          actions: [
            open(href),
            ...(dispatch ? [{ label: t.dispatchAction, href: href + '#dispatch-form' }] : []),
          ],
        };
      })
    : [];
  const fleetRows: Row[] = fleet.ok
    ? fleet.data.fleet.vehicles.slice(0, 15).map((vehicle) => {
        const href = home + '/fleet/vehicles/' + vehicle.id;
        return {
          id: vehicle.id,
          cells: [
            <bdi dir="ltr" key="plate">
              {vehicle.registrationNumber}
            </bdi>,
            m.fleet.kinds[vehicle.kind],
            <span className="chip" key="state">
              {vehicle.status === 'retired'
                ? m.fleet.retired
                : m.fleet.ownership[vehicle.ownership]}
            </span>,
          ],
          actions: [
            open(href),
            { label: m.fleet.documentsTitle, href: href + '#documents-title' },
            ...(vehicle.status === 'active' && fleet.data.fleet.open
              ? [{ label: m.fleet.addDocumentTitle, href: href + '#document-form-title' }]
              : []),
          ],
        };
      })
    : [];

  return (
    <div className="page operations-workspace">
      <header className="operations-masthead">
        <a href={home}>{t.back}</a>
        <h1>{t.title}</h1>
        <p>
          <bdi>{org.data.organisation.legalName}</bdi>
        </p>
      </header>
      <nav className="operations-section-nav" aria-label={t.title}>
        <a className="button" href="#operations-shipments">
          {t.shipments}
        </a>
        <a className="button" href="#operations-dispatch">
          {t.dispatch}
        </a>
        {fleet.ok ? (
          <a className="button" href="#operations-fleet">
            {t.fleet}
          </a>
        ) : null}
      </nav>

      <section
        className="operations-module"
        id="operations-shipments"
        aria-labelledby="operations-shipments-title"
      >
        <div className="operations-module-heading">
          <h2 id="operations-shipments-title">{t.shipments}</h2>
          {shipments.ok ? (
            <a className="button" href={home + '/shipments'}>
              {t.manageShipments}
            </a>
          ) : null}
        </div>
        {shipments.ok ? (
          <OperationsTable
            title={t.shipments}
            headers={[t.reference, t.state, t.route, t.actions]}
            rows={shipmentRows}
            empty={t.empty}
          />
        ) : (
          <p role="status">{t.unavailable}</p>
        )}
        {shipments.ok && (shipments.data.nextAfter || after) ? (
          <div className="form-inline">
            {after ? (
              <a className="button" href={home + '/operations#operations-shipments'}>
                {m.publicShipments.first}
              </a>
            ) : null}
            {shipments.data.nextAfter ? (
              <a
                className="button"
                href={
                  home + '/operations?after=' + shipments.data.nextAfter + '#operations-shipments'
                }
              >
                {m.publicShipments.more}
              </a>
            ) : null}
          </div>
        ) : null}
      </section>

      <section
        className="operations-module"
        id="operations-dispatch"
        aria-labelledby="operations-dispatch-title"
      >
        <div className="operations-module-heading">
          <h2 id="operations-dispatch-title">{t.dispatch}</h2>
          {bookings.ok ? (
            <a className="button" href={home + '/bookings'}>
              {t.manageBookings}
            </a>
          ) : null}
        </div>
        {bookings.ok ? (
          <OperationsTable
            title={t.dispatch}
            headers={[t.counterparty, t.state, t.booked, t.actions]}
            rows={bookingRows}
            empty={t.empty}
          />
        ) : (
          <p role="status">{t.unavailable}</p>
        )}
      </section>

      {fleet.ok || ![403, 404].includes(fleet.status) ? (
        <section
          className="operations-module"
          id="operations-fleet"
          aria-labelledby="operations-fleet-title"
        >
          <div className="operations-module-heading">
            <h2 id="operations-fleet-title">{t.fleet}</h2>
            {fleet.ok ? (
              <a className="button" href={home + '/fleet'}>
                {t.manageFleet}
              </a>
            ) : null}
          </div>
          {fleet.ok ? (
            <OperationsTable
              title={t.fleet}
              headers={[t.plate, t.vehicleType, t.state, t.actions]}
              rows={fleetRows}
              empty={t.empty}
            />
          ) : (
            <p role="status">{t.unavailable}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
