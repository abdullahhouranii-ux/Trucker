import { RecordOptions } from '../../../../web/src/components/record-options.tsx';
import { redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../web/src/components/form.tsx';
import { api } from '../../../../web/src/server/api.ts';
import type { ClosureQueueItem } from '../../../../web/src/components/booking-completion.tsx';
import { closureBlockerLabels } from '../../../../web/src/components/booking-completion-labels.ts';
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
  /** Undeliverable cargo not closed (slice 18d): escalated and overdue first. */
  cargo?: {
    bookingId: string;
    caseId: string;
    cargoClass: string;
    responseDueAt: string;
    overdue: boolean;
    escalatedAt: string | null;
    onVehicle: string | number;
    openInstruction: string | null;
    heldCosts: number;
  }[];
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
  const disputes = reply.ok
    ? await api<
        {
          id: string;
          bookingId: string;
          kind: string;
          openedAt: string;
          state: string;
          assignee: string | null;
          held: boolean;
        }[]
      >('GET', '/staff/operations/disputes', { token: found.token })
    : null;
  const closureQueue = reply.ok
    ? await api<ClosureQueueItem[]>('GET', '/staff/operations/closure', { token: found.token })
    : null;
  const disputeState = one('disputeState');
  const disputeOwner = one('disputeOwner');
  const disputeStates: Record<string, string> = {
    open: 'Open',
    assign: 'In review',
    request_information: 'Awaiting information',
    propose: 'Proposal sent',
    agreement: 'Agreement recorded',
    withdraw: 'Withdrawn',
    close: 'Closed without agreement',
    external: 'Reported external decision',
  };
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
          <section className="workspace-overview-hero" aria-labelledby="operations-title">
            <h1 id="operations-title">Operations</h1>
            <p>
              Problems on trips, reported by the driver, the carrier or the shipper, or seen by
              Trucker. Acknowledge each case, record what you do, and resolve it. Notes stay with
              operations: the parties see that a case exists, its type and its state. Times are in
              UTC.
            </p>
          </section>
          {reply.ok ? (
            <section className="ops-summary" aria-label="Queue summary">
              {[
                ['Open cases', reply.data.operations.open.length, '#open-title'],
                ['Cargo cases', reply.data.operations.cargo?.length ?? 0, '#cargo-title'],
                ['Active holds', reply.data.operations.holds.length, '#holds-title'],
                ['Dispatch blocks', reply.data.operations.blocks.length, '#blocks-title'],
              ].map(([label, count, href]) => (
                <a className="card ops-metric" href={String(href)} key={String(label)}>
                  <span>{label}</span>
                  <strong>{count}</strong>
                </a>
              ))}
            </section>
          ) : null}
          {closureQueue?.ok ? (
            <section className="section" aria-labelledby="booking-closure-queue-title">
              <h2 id="booking-closure-queue-title">Operational closure queue</h2>
              {closureQueue.data.length ? (
                <ul className="organisation-list record-collection">
                  {closureQueue.data.map((item) => (
                    <li className="card" key={item.bookingId}>
                      <h3>
                        <bdi>{item.bookingId}</bdi>
                      </h3>
                      <RecordOptions label={`Actions for ${item.bookingId}`}>
                        <li>
                          <a
                            className="button"
                            href={`/operations/bookings/${item.bookingId}#operational-closure`}
                          >
                            Review operational closure
                          </a>
                        </li>
                      </RecordOptions>
                      <p>
                        {item.ownerName ?? 'Unassigned'} ·{' '}
                        {item.state === 'review_required' ? 'Needs review' : 'Open'}
                      </p>
                      {item.blockers.length ? (
                        <ul>
                          {item.blockers.map((blocker) => (
                            <li key={blocker}>{closureBlockerLabels[blocker] ?? blocker}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>Ready for the next closure check.</p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>There are no bookings awaiting operational closure.</p>
              )}
            </section>
          ) : null}
          {disputes?.ok ? (
            <section className="section" aria-labelledby="dispute-queue-title">
              <h2 id="dispute-queue-title">Booking disputes</h2>
              <form method="get" className="form-inline">
                <label>
                  State{' '}
                  <select name="disputeState" defaultValue={disputeState}>
                    <option value="">All states</option>
                    {Object.entries(disputeStates).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Owner{' '}
                  <select name="disputeOwner" defaultValue={disputeOwner}>
                    <option value="">All owners</option>
                    <option value="unassigned">Unassigned</option>
                    {[
                      ...new Set(
                        disputes.data.flatMap((item) => (item.assignee ? [item.assignee] : [])),
                      ),
                    ].map((id) => (
                      <option key={id} value={id}>
                        {id === found.staff.id ? 'Assigned to me' : id}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="button">
                  Filter disputes
                </button>
              </form>
              <ul className="organisation-list record-collection">
                {disputes.data
                  .filter(
                    (item) =>
                      (!disputeState || item.state === disputeState) &&
                      (!disputeOwner || (item.assignee ?? 'unassigned') === disputeOwner),
                  )
                  .map((item) => (
                    <li className="card" key={item.id}>
                      <h3>{item.kind.replaceAll('_', ' ')}</h3>
                      <p>
                        {disputeStates[item.state]}
                        {' · '}
                        {at(item.openedAt)}
                        {item.held ? ' · Settlement eligibility on hold' : ''}
                      </p>
                      <RecordOptions label={`Actions for dispute ${item.id}`}>
                        <li>
                          <a
                            className="button"
                            href={`/operations/bookings/${item.bookingId}#${item.id}`}
                          >
                            Review dispute
                          </a>
                        </li>
                      </RecordOptions>
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
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
                  <ol className="organisation-list record-collection" id="open-cases">
                    {reply.data.operations.open.map((item) => (
                      <CaseCard key={item.id} item={item} />
                    ))}
                  </ol>
                )}
              </section>
              <section className="section" aria-labelledby="cargo-title">
                <h2 id="cargo-title">Cargo not delivered</h2>
                {(reply.data.operations.cargo ?? []).length === 0 ? (
                  <p>None.</p>
                ) : (
                  <ul className="evidence" id="cargo-cases">
                    {(reply.data.operations.cargo ?? []).map((item) => (
                      <li
                        key={item.caseId}
                        data-escalated={item.escalatedAt ? 'true' : 'false'}
                        data-overdue={item.overdue ? 'true' : 'false'}
                      >
                        {bookingLink(item.bookingId)}:{' '}
                        {item.escalatedAt
                          ? `escalated ${at(item.escalatedAt)}`
                          : item.overdue
                            ? 'instructions overdue'
                            : `instructions due ${at(item.responseDueAt)}`}
                        ; {item.cargoClass.replace('_', ' ')}; on the vehicle{' '}
                        <bdi>{String(item.onVehicle)}</bdi>
                        {item.openInstruction ? `; instruction ${item.openInstruction}` : ''}
                        {item.heldCosts > 0 ? `; ${item.heldCosts} hold(s) in force` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="section" aria-labelledby="blocks-title">
                <h2 id="blocks-title">Dispatches blocked</h2>
                {reply.data.operations.blocks.length === 0 ? (
                  <p>None.</p>
                ) : (
                  <ul className="evidence" id="blocks">
                    {reply.data.operations.blocks.map((item) => (
                      <li className="card" key={item.bookingId}>
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
                      <li className="card" key={item.bookingId}>
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
