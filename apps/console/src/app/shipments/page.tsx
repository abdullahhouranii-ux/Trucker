import { redirect } from 'next/navigation';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import { requireStaff } from '../../server/session.ts';

interface Entry {
  id: string;
  organisationId: string;
  legalName: string;
  state: 'published' | 'suspended' | 'withdrawn' | 'expired';
  publishedVersion: number;
  pickupCountry: string;
  deliveryCountry: string;
  deadlineAt: string;
  publishedAt: string;
}
const STATE: Record<Entry['state'], string> = {
  published: 'Published',
  suspended: 'Published, suspended',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

// Read-only. Reviewers and staff administrators. Each look is recorded, and anything due (an
// expiry or a suspension) is recorded before the list is shown.
export default async function ShipmentsPage() {
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/shipments" />
        </main>
      </>
    );
  }
  const list = await api<{ shipments: Entry[] }>('GET', '/staff/shipments', {
    token: found.token,
  });
  if (!list.ok && list.status === 401) redirect('/sign-in?error=session_ended');
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/shipments" />
      <main id="main" tabIndex={-1}>
        {!list.ok ? (
          list.status === 403 ? (
            <div className="page page-narrow" data-state="forbidden">
              <h1>Published shipments</h1>
              <div className="notice notice-error" role="alert" id="forbidden">
                <h2>You cannot see this</h2>
                <p>
                  Published shipments are read by reviewers and staff administrators. Your account
                  holds neither privilege. This attempt was recorded.
                </p>
              </div>
            </div>
          ) : (
            <Unavailable retryHref="/shipments" />
          )
        ) : (
          <div className="page page-narrow">
            <h1>Published shipments</h1>
            <p>
              Read-only, newest publication first. Opening one is recorded. No carrier can see any
              shipment yet in this environment.
            </p>
            {list.data.shipments.length === 0 ? (
              <p id="shipments-empty">Nothing has been published.</p>
            ) : null}
            <ul className="organisation-list" id="shipments">
              {list.data.shipments.map((entry) => (
                <li
                  key={entry.id}
                  className="card account"
                  data-shipment={entry.id}
                  data-state={entry.state}
                >
                  <h2>{entry.legalName}</h2>
                  <p className="chip">{STATE[entry.state]}</p>
                  <p>
                    {entry.pickupCountry} to {entry.deliveryCountry}, version{' '}
                    {entry.publishedVersion}. Published {utc(entry.publishedAt)}. Quotation deadline{' '}
                    {utc(entry.deadlineAt)}.
                  </p>
                  <div className="form-inline">
                    <a className="button" href={`/shipments/${entry.id}`}>
                      Open
                      <span className="visually-hidden">
                        {' '}
                        {entry.legalName}, published {utc(entry.publishedAt)}
                      </span>
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}
