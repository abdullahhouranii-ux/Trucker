import { notFound, redirect } from 'next/navigation';
import { api } from '../../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../../components/console-header.tsx';
import { requireStaff } from '../../../server/session.ts';

type Props = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE: Record<string, string> = {
  published: 'Published',
  suspended: 'Published, suspended',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};
const CAUSE: Record<string, string> = {
  verification: 'Verification withdrawn or not allowing publication',
  route: 'Route not open',
};
const ACTION: Record<string, string> = {
  'shipment.created': 'Draft created',
  'shipment.copied': 'Draft made from a copy',
  'shipment.updated': 'Changed (no new version)',
  'shipment.published': 'Published',
  'shipment.version_created': 'Changed (new version)',
  'shipment.withdrawn': 'Withdrawn',
  'shipment.expired': 'Expired at its deadline',
  'shipment.republished': 'Published again',
  'shipment.suspended': 'Suspended',
  'shipment.suspension_ended': 'A cause of suspension ended',
};

interface Detail {
  shipment: Record<string, unknown> & { id: string; state: string };
  organisation: { id: string; legalName: string; status: string; countryCode: string };
  carrierView: Record<string, unknown>;
  versions: { versionNo: number; kind: string; createdAt: string }[];
  suspensions: {
    cause: string;
    startedAt: string;
    endedAt: string | null;
    endedBy: string | null;
  }[];
  history: { action: string; occurredAt: string; byStaff: boolean; bySystem: boolean }[];
}

export default async function ShipmentPage({ params }: Props) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const route = `/shipments/${id}`;
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref={route} />
        </main>
      </>
    );
  }
  const one = await api<Detail>('GET', `/staff/shipments/${id}`, { token: found.token });
  if (!one.ok && one.status === 401) redirect('/sign-in?error=session_ended');
  if (!one.ok && one.status === 404) notFound();
  if (!one.ok) {
    return (
      <>
        <ConsoleHeader staff={found.staff} current="/shipments" />
        <main id="main" tabIndex={-1}>
          {one.status === 403 ? (
            <div className="page page-narrow" data-state="forbidden">
              <h1>Published shipment</h1>
              <div className="notice notice-error" role="alert" id="forbidden">
                <h2>You cannot see this</h2>
                <p>Your account holds neither privilege. This attempt was recorded.</p>
              </div>
            </div>
          ) : (
            <Unavailable retryHref={route} />
          )}
        </main>
      </>
    );
  }
  const { shipment, organisation, carrierView, versions, suspensions, history } = one.data;
  const value = (name: string): string => {
    const raw = shipment[name];
    return raw === null || raw === undefined || raw === '' ? 'Not given' : String(raw);
  };
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/shipments" />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow">
          <div className="form-inline">
            <a className="button" href="/shipments">
              All published shipments
            </a>
          </div>
          <h1>{organisation.legalName}</h1>
          <p className="chip" id="shipment-state" data-state={shipment.state}>
            {STATE[shipment.state] ?? shipment.state}
          </p>
          <p>Read-only. No carrier can see this shipment yet in this environment.</p>
          <section className="section" aria-labelledby="record-title">
            <h2 id="record-title">The shipment</h2>
            <dl className="card facts" id="shipment-record">
              {(
                [
                  ['Shipper reference', 'shipper_reference'],
                  ['Cargo', 'cargo_description'],
                  ['Category', 'cargo_category'],
                  ['Equipment type', 'equipment_type'],
                  ['Gross weight (kg)', 'gross_weight_kg'],
                  ['Pick-up address', 'pickup_address'],
                  ['Pick-up area', 'pickup_area'],
                  ['Delivery address', 'delivery_address'],
                  ['Delivery area', 'delivery_area'],
                  ['Quotation deadline', 'deadline_at'],
                  ['Published version', 'published_version'],
                ] as const
              ).map(([label, name]) => (
                <div key={name}>
                  <dt>{label}</dt>
                  <dd>
                    {name === 'deadline_at' && shipment[name]
                      ? utc(String(shipment[name]))
                      : value(name)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="section" aria-labelledby="preview-title">
            <h2 id="preview-title">What carriers would see</h2>
            <pre className="card code-block" id="carrier-view">
              {JSON.stringify(carrierView, null, 2)}
            </pre>
          </section>
          <section className="section" aria-labelledby="suspensions-title">
            <h2 id="suspensions-title">Suspensions</h2>
            {suspensions.length === 0 ? <p id="no-suspensions">None.</p> : null}
            <ul className="evidence" id="suspensions">
              {suspensions.map((entry) => (
                <li key={`${entry.cause}-${entry.startedAt}`}>
                  {CAUSE[entry.cause] ?? entry.cause}: from {utc(entry.startedAt)}
                  {entry.endedAt ? ` to ${utc(entry.endedAt)} (${entry.endedBy})` : ', open'}
                </li>
              ))}
            </ul>
          </section>
          <section className="section" aria-labelledby="versions-title">
            <h2 id="versions-title">Versions</h2>
            <ul className="evidence" id="versions">
              {versions.map((version) => (
                <li key={version.versionNo}>
                  Version {version.versionNo}: {version.kind}, {utc(version.createdAt)}
                </li>
              ))}
            </ul>
          </section>
          <section className="section" aria-labelledby="history-title">
            <h2 id="history-title">History</h2>
            <ul className="evidence" id="history">
              {history.map((entry, index) => (
                <li key={`${entry.action}-${index}`} data-action={entry.action}>
                  {utc(entry.occurredAt)}: {ACTION[entry.action] ?? entry.action}
                  {entry.bySystem
                    ? ' (recorded by the system)'
                    : entry.byStaff
                      ? ' (by staff)'
                      : ''}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}
