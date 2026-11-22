import { redirect } from 'next/navigation';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import { requireStaff } from '../../server/session.ts';

// Bookings that need someone's attention: an assignment deadline missed, a resource that no
// longer meets a requirement, a resource still out past its planned end, or a substitution
// waiting for the shipper. Read-only: nothing here cancels, reassigns or releases anything.
// The consistency check lists records that contradict each other; it should be empty.

interface Item {
  id: string;
  shipmentId: string;
  status: string;
  shipper: { legalName: string };
  carrier: { legalName: string };
  assignmentDueAt: string;
  overdue: boolean;
  waitDecision: { decidedAt: string } | null;
  needsReassignment: boolean;
  atRisk: boolean;
  substitutionOpen: boolean;
  blockers: { code: string; role?: string; reason?: string }[];
}
interface Attention {
  bookings: Item[];
  consistency: { code: string; booking: string; record: string }[];
}
const words = (code: string): string => code.replace(/_/g, ' ');

export default async function BookingsPage() {
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/bookings" />
        </main>
      </>
    );
  }
  const reply = await api<{ attention: Attention }>('GET', '/staff/bookings/attention', {
    token: found.token,
  });
  if (!reply.ok && reply.status === 401) redirect('/sign-in?error=session_ended');
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/bookings" />
      <main id="main" tabIndex={-1}>
        <div className="page" data-state="bookings">
          <h1>Bookings needing attention</h1>
          <p>
            Read-only. Nothing is cancelled, reassigned or released from here, and nothing happens
            to a booking automatically. Each look at this page is recorded.
          </p>
          {!reply.ok ? (
            <div className="notice notice-error" role="alert" id="attention-unavailable">
              {reply.status === 403
                ? 'Your account does not hold the privilege this needs. The attempt was recorded.'
                : 'This could not be read. Reload the page.'}
            </div>
          ) : (
            <>
              {reply.data.attention.bookings.length === 0 ? (
                <p id="no-attention">No booking needs attention now.</p>
              ) : (
                <ol className="organisation-list record-collection" id="attention-list">
                  {reply.data.attention.bookings.map((item) => (
                    <li className="card" key={item.id} data-booking={item.id}>
                      <h2>
                        <a href={`/bookings/${item.id}`}>
                          {item.shipper.legalName} with {item.carrier.legalName}
                        </a>
                      </h2>
                      <p>
                        {words(item.status)}. Resources due by {utc(item.assignmentDueAt)}.
                      </p>
                      <ul className="evidence">
                        {item.overdue ? (
                          <li data-flag="overdue">
                            The assignment deadline has passed
                            {item.waitDecision
                              ? `; the shipper decided to wait on ${utc(item.waitDecision.decidedAt)}`
                              : '; the shipper has not recorded a decision'}
                            .
                          </li>
                        ) : null}
                        {item.needsReassignment ? (
                          <li data-flag="needs-reassignment">
                            A resource no longer meets a requirement and must be reassigned by the
                            carrier.
                          </li>
                        ) : null}
                        {item.atRisk ? (
                          <li data-flag="at-risk">
                            A resource is still out past the planned end of an earlier booking.
                          </li>
                        ) : null}
                        {item.substitutionOpen ? (
                          <li data-flag="substitution">
                            A substitution is waiting for the shipper&apos;s decision.
                          </li>
                        ) : null}
                      </ul>
                      <p className="field-hint">
                        Dispatch now:{' '}
                        {item.blockers.length === 0
                          ? 'nothing blocks it'
                          : item.blockers
                              .map((blocker) =>
                                words(
                                  [blocker.code, blocker.role, blocker.reason]
                                    .filter(Boolean)
                                    .join(' '),
                                ),
                              )
                              .join('; ')}
                        .
                      </p>
                    </li>
                  ))}
                </ol>
              )}
              <section className="section" aria-labelledby="consistency-title">
                <h2 id="consistency-title">Consistency check</h2>
                {reply.data.attention.consistency.length === 0 ? (
                  <p id="consistency-clean">
                    No assignment, reservation or occupancy record contradicts another.
                  </p>
                ) : (
                  <ul className="evidence" id="consistency-list">
                    {reply.data.attention.consistency.map((item) => (
                      <li key={`${item.code}-${item.record}`}>
                        {words(item.code)}: booking {item.booking}, record {item.record}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
