import { redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../web/src/components/form.tsx';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable } from '../../components/console-header.tsx';
import {
  at,
  CaseCard,
  caseTitle,
  DONE,
  ERRORS,
  REASONS,
  type OperationsCase,
} from '../../components/operations-view.tsx';
import { findBookingAction } from '../../server/operations-actions.ts';
import { requireStaff } from '../../server/session.ts';

// The operations queue (slice 17b): every case not yet resolved, oldest first, with the blocks
// and holds in force. Cases are reported by the parties or seen by Trucker (an overrun, no
// arrival at pick-up); neither of the latter has any automatic consequence. Times are UTC.

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
interface Queue {
  open: OperationsCase[];
  resolved: OperationsCase[];
  blocks: { bookingId: string; reason: string; blockedAt: string }[];
  holds: { bookingId: string; reason: string; heldAt: string }[];
}

export default async function OperationsPage({ searchParams }: Props) {
  const found = await requireStaff();
  if (found.state === 'unknown')
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/operations" />
        </main>
      </>
    );
  const search = await searchParams;
  const one = (name: string): string =>
    typeof search[name] === 'string' ? (search[name] as string) : '';
  const reply = await api<{ operations: Queue }>('GET', '/staff/operations', {
    token: found.token,
  });
  if (!reply.ok && reply.status === 401) redirect('/sign-in?error=session_ended');
  const error = one('error');
  const done = DONE[one('done')];
  const problems = error ? [{ message: ERRORS[error] ?? 'That was refused.' }] : [];
  const bookingLink = (id: string) => (
    <a className="button" href={`/operations/bookings/${id}`}>
      <bdi dir="ltr">{id}</bdi>
    </a>
  );
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/operations" />
      <main id="main" tabIndex={-1}>
        <div className="page" data-state="operations">
          <h1>Operations</h1>
          <p>
            Problems on trips, reported by the driver, the carrier or the shipper, or seen by
            Trucker. Acknowledge each case, record what you do, and resolve it. Notes stay with
            operations: the parties see that a case exists, its type and its state. Times are in
            UTC.
          </p>
          <ErrorSummary title="There is a problem" problems={problems} />
          {done && problems.length === 0 ? (
            <p className="notice notice-success" role="status" id="operations-done">
              {done}
            </p>
          ) : null}
          <section className="section" id="find" aria-labelledby="find-title">
            <h2 id="find-title">Open a booking</h2>
            <form className="form-inline" action={findBookingAction}>
              <div className="field">
                <label htmlFor="find-booking">Booking identifier</label>
                <input
                  id="find-booking"
                  name="booking"
                  type="text"
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                />
              </div>
              <button className="button" type="submit" id="find-submit">
                Open
              </button>
            </form>
          </section>
          {!reply.ok ? (
            <p role="alert" id="operations-unavailable">
              {reply.status === 403
                ? 'This requires the operations privilege.'
                : 'The queue could not be read. Try again.'}
            </p>
          ) : (
            <>
              <section className="section" aria-labelledby="open-title">
                <h2 id="open-title">Open cases ({reply.data.operations.open.length})</h2>
                {reply.data.operations.open.length === 0 ? (
                  <p id="no-open-cases">No case is open.</p>
                ) : (
                  <ol className="organisation-list" id="open-cases">
                    {reply.data.operations.open.map((item) => (
                      <CaseCard key={item.id} item={item} />
                    ))}
                  </ol>
                )}
              </section>
              <section className="section" aria-labelledby="blocks-title">
                <h2 id="blocks-title">Dispatches blocked</h2>
                {reply.data.operations.blocks.length === 0 ? (
                  <p>None.</p>
                ) : (
                  <ul className="evidence" id="blocks">
                    {reply.data.operations.blocks.map((item) => (
                      <li key={item.bookingId}>
                        {bookingLink(item.bookingId)}: {REASONS[item.reason]}, since{' '}
                        {at(item.blockedAt)}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="section" aria-labelledby="holds-title">
                <h2 id="holds-title">Trips on hold</h2>
                {reply.data.operations.holds.length === 0 ? (
                  <p>None.</p>
                ) : (
                  <ul className="evidence" id="holds">
                    {reply.data.operations.holds.map((item) => (
                      <li key={item.bookingId}>
                        {bookingLink(item.bookingId)}: {REASONS[item.reason]}, since{' '}
                        {at(item.heldAt)}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="section" aria-labelledby="resolved-title">
                <h2 id="resolved-title">Recently resolved</h2>
                {reply.data.operations.resolved.length === 0 ? (
                  <p>None.</p>
                ) : (
                  <ul className="evidence" id="resolved-cases">
                    {reply.data.operations.resolved.map((item) => (
                      <li key={item.id}>
                        {caseTitle(item)}, reported at {at(item.reportedAt)}:{' '}
                        {bookingLink(item.bookingId)}
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
