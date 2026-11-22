import { notFound, redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../../../web/src/components/form.tsx';
import { api } from '../../../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable } from '../../../../components/console-header.tsx';
import {
  at,
  CaseCard,
  DONE,
  ERRORS,
  REASONS,
  type OperationsCase,
} from '../../../../components/operations-view.tsx';
import {
  blockAction,
  holdAction,
  operationsMilestoneAction,
  withdrawMilestoneAction,
} from '../../../../server/operations-actions.ts';
import { requireStaff } from '../../../../server/session.ts';

// One booking for Trucker operations (slice 17b): block its dispatch or lift the block; once
// dispatched, put the trip on hold or resume it, record a milestone on the driver's behalf,
// withdraw one recorded by mistake, and handle its cases. Every step needs a note, which stays
// with operations; a block or hold also needs a reason, which the parties see. Times are UTC.

const MILESTONES: Record<string, string> = {
  departed_for_pickup: 'Left for pick-up',
  arrived_at_pickup: 'Arrived at pick-up',
  loading_started: 'Loading started',
  loaded_departed: 'Loaded and left',
  arrived_at_delivery: 'Arrived at delivery',
  unloading_started: 'Unloading started',
};
const BLOCKERS: Record<string, string> = {
  booking_cancelled: 'The booking is cancelled',
  not_confirmed: 'Not confirmed',
  fee_not_paid: "Trucker's fee not paid and verified",
  needs_reassignment: 'A resource must be reassigned',
  resource_occupied: 'A resource is on another trip',
  resource_overrunning: 'A resource is on another trip past its planned end',
  acknowledgement_missing: 'The driver has not acknowledged',
  operations_block: 'Blocked by operations',
};
const ON_BEHALF: Record<string, string> = {
  no_phone: 'The driver has no phone',
  no_signal: 'No signal',
  driver_unable: 'The driver cannot record it',
  correction: 'A correction',
  other: 'Other (explain in the note)',
};

interface Milestone {
  milestone: string;
  statedAt: string;
  recordedAt: string;
  basis: 'observed' | 'reported';
  about: string;
  enteredBy: string | null;
  enteredAs: 'driver' | 'carrier' | 'operations';
  reason: string | null;
  note: string | null;
  needsReview: boolean;
}
interface Detail {
  id: string;
  shipper: { legalName: string };
  carrier: { legalName: string };
  plannedReservation: { startAt: string; endAt: string };
  cancelled: boolean;
  confirmed: boolean;
  blockers: { code: string; role?: string; reason?: string }[];
  blocks: {
    reason: string;
    note: string;
    blockedAt: string;
    blockedBy: string;
    liftedAt: string | null;
    liftNote: string | null;
    liftedBy: string | null;
  }[];
  trip: {
    version: number;
    dispatchedAt: string;
    next: string | null;
    milestones: Milestone[];
    withdrawn: { milestone: string; statedAt: string; withdrawnAt: string; note: string }[];
    hold: { reason: string; heldAt: string; note: string; heldBy: string } | null;
    estimate: { arrivalAt: string; statedBy: string; statedAs: string } | null;
  } | null;
  cases: OperationsCase[];
  atRiskFrom: string[];
}
type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const Note = ({ id, label }: { id: string; label: string }) => (
  <div className="field">
    <label htmlFor={id}>{label}</label>
    <textarea id={id} name="note" rows={2} maxLength={1000} />
  </div>
);
const ReasonChoice = ({ id }: { id: string }) => (
  <div className="field">
    <label htmlFor={id}>Reason the parties see</label>
    <select id={id} name="reason">
      {Object.entries(REASONS).map(([code, label]) => (
        <option key={code} value={code}>
          {label}
        </option>
      ))}
    </select>
  </div>
);

export default async function OperationsBookingPage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const found = await requireStaff();
  if (found.state === 'unknown')
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref={`/operations/bookings/${id}`} />
        </main>
      </>
    );
  const search = await searchParams;
  const one = (name: string): string =>
    typeof search[name] === 'string' ? (search[name] as string) : '';
  const reply = await api<{ booking: Detail }>('GET', `/staff/operations/bookings/${id}`, {
    token: found.token,
  });
  if (!reply.ok && reply.status === 401) redirect('/sign-in?error=session_ended');
  if (!reply.ok && reply.status === 404) notFound();
  const error = one('error');
  const done = DONE[one('done')];
  const problems = error ? [{ message: ERRORS[error] ?? 'That was refused.' }] : [];
  const hidden = <input type="hidden" name="bookingId" value={id} />;
  const now = new Date().toISOString().slice(0, 16);
  const b = reply.ok ? reply.data.booking : null;
  const blockInForce = b?.blocks.find((item) => item.liftedAt === null) ?? null;
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/operations" />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow" data-state="operations-booking">
          <a className="button" href="/operations">
            Operations
          </a>
          <h1>Booking for operations</h1>
          <ErrorSummary title="There is a problem" problems={problems} />
          {done && problems.length === 0 ? (
            <p className="notice notice-success" role="status" id="operations-done">
              {done}
            </p>
          ) : null}
          {!b ? (
            <p role="alert" id="operations-unavailable">
              {!reply.ok && reply.status === 403
                ? 'This requires the operations privilege.'
                : 'The booking could not be read. Try again.'}
            </p>
          ) : (
            <>
              <ul className="evidence" id="booking-facts">
                <li>
                  Booking: <bdi dir="ltr">{b.id}</bdi>
                </li>
                <li>
                  Shipper: <bdi>{b.shipper.legalName}</bdi>. Carrier:{' '}
                  <bdi>{b.carrier.legalName}</bdi>
                </li>
                <li>
                  Planned: {at(b.plannedReservation.startAt)} to {at(b.plannedReservation.endAt)}
                </li>
                <li>{b.cancelled ? 'Cancelled' : b.confirmed ? 'Confirmed' : 'Not confirmed'}</li>
                {b.atRiskFrom.length > 0 ? (
                  <li id="at-risk">At risk from an overrunning trip: see the queue.</li>
                ) : null}
              </ul>

              {b.trip ? null : (
                <section className="section" id="dispatch" aria-labelledby="dispatch-title">
                  <h2 id="dispatch-title">Dispatch</h2>
                  {b.blockers.length === 0 ? (
                    <p>Nothing blocks dispatch.</p>
                  ) : (
                    <ul className="evidence" id="blockers">
                      {b.blockers.map((item, index) => (
                        <li key={index} data-blocker={item.code}>
                          {BLOCKERS[item.code] ?? item.code}
                          {item.role ? ` (${item.role})` : ''}
                          {item.code === 'operations_block' && item.reason
                            ? `: ${REASONS[item.reason]}`
                            : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                  {b.cancelled ? null : blockInForce ? (
                    <form className="form card" action={blockAction} id="lift-form">
                      {hidden}
                      <input type="hidden" name="block" value="false" />
                      <input type="hidden" name="anchor" value="dispatch" />
                      <p>
                        Blocked since {at(blockInForce.blockedAt)} by{' '}
                        <bdi>{blockInForce.blockedBy}</bdi>: {REASONS[blockInForce.reason]}.{' '}
                        <bdi>{blockInForce.note}</bdi>
                      </p>
                      <Note id="lift-note" label="Why the block is lifted (operations only)" />
                      <button className="button" type="submit" id="lift-block">
                        Lift the block
                      </button>
                    </form>
                  ) : (
                    <form className="form card" action={blockAction} id="block-form">
                      {hidden}
                      <input type="hidden" name="block" value="true" />
                      <input type="hidden" name="anchor" value="dispatch" />
                      <ReasonChoice id="block-reason" />
                      <Note id="block-note" label="Note (operations only)" />
                      <button className="button button-danger" type="submit" id="block-dispatch">
                        Block dispatch
                      </button>
                    </form>
                  )}
                </section>
              )}

              {b.trip ? (
                <section className="section" id="trip" aria-labelledby="trip-title">
                  <h2 id="trip-title">Trip</h2>
                  <p>Dispatched at {at(b.trip.dispatchedAt)}.</p>
                  {b.trip.milestones.length === 0 ? (
                    <p id="no-milestones">No milestone is recorded yet.</p>
                  ) : (
                    <ol className="evidence" id="milestones">
                      {b.trip.milestones.map((item) => (
                        <li key={item.milestone} data-milestone={item.milestone}>
                          {MILESTONES[item.milestone]}: {at(item.statedAt)},{' '}
                          {item.basis === 'observed'
                            ? 'recorded by the driver as it happened'
                            : `reported by ${item.enteredAs === 'operations' ? 'operations' : 'the carrier'}`}
                          {item.enteredBy ? (
                            <>
                              {' '}
                              (<bdi>{item.enteredBy}</bdi>)
                            </>
                          ) : null}
                          {item.reason ? `, ${ON_BEHALF[item.reason]}` : ''}
                          {item.note ? (
                            <>
                              : <bdi>{item.note}</bdi>
                            </>
                          ) : null}
                          {item.needsReview ? ' (marked for review)' : ''}
                        </li>
                      ))}
                    </ol>
                  )}
                  {b.trip.withdrawn.length > 0 ? (
                    <>
                      <h3>Withdrawn</h3>
                      <ul className="evidence" id="withdrawn">
                        {b.trip.withdrawn.map((item) => (
                          <li key={item.withdrawnAt + item.milestone}>
                            {MILESTONES[item.milestone]} ({at(item.statedAt)}), withdrawn at{' '}
                            {at(item.withdrawnAt)}: <bdi>{item.note}</bdi>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <p>
                    Estimated arrival:{' '}
                    {b.trip.estimate ? (
                      <>
                        {at(b.trip.estimate.arrivalAt)}, stated by{' '}
                        <bdi>{b.trip.estimate.statedBy}</bdi>
                      </>
                    ) : (
                      'none stated'
                    )}
                  </p>

                  <h3>Hold</h3>
                  {b.trip.hold ? (
                    <form className="form card" action={holdAction} id="resume-form">
                      {hidden}
                      <input type="hidden" name="hold" value="false" />
                      <input type="hidden" name="anchor" value="trip" />
                      <p id="hold-in-force">
                        On hold since {at(b.trip.hold.heldAt)} by <bdi>{b.trip.hold.heldBy}</bdi>:{' '}
                        {REASONS[b.trip.hold.reason]}. <bdi>{b.trip.hold.note}</bdi>
                      </p>
                      <Note id="resume-note" label="Why it is resumed (operations only)" />
                      <button className="button" type="submit" id="resume-trip">
                        Resume the trip
                      </button>
                    </form>
                  ) : (
                    <form className="form card" action={holdAction} id="hold-form">
                      {hidden}
                      <input type="hidden" name="hold" value="true" />
                      <input type="hidden" name="anchor" value="trip" />
                      <ReasonChoice id="hold-reason" />
                      <Note id="hold-note" label="Note (operations only)" />
                      <button className="button button-danger" type="submit" id="hold-trip">
                        Put the trip on hold
                      </button>
                    </form>
                  )}

                  {b.trip.next && !b.trip.hold ? (
                    <form
                      className="form card"
                      action={operationsMilestoneAction}
                      id="ops-milestone-form"
                    >
                      {hidden}
                      <input type="hidden" name="version" value={b.trip.version} />
                      <input type="hidden" name="milestone" value={b.trip.next} />
                      <input type="hidden" name="anchor" value="trip" />
                      <h3>Record on the driver&apos;s behalf</h3>
                      <p>
                        Next: <strong>{MILESTONES[b.trip.next]}</strong>. The parties see it was
                        reported by Trucker operations, not by whom.
                      </p>
                      <div className="field">
                        <label htmlFor="ops-stated-at">When it happened (UTC)</label>
                        <input
                          id="ops-stated-at"
                          name="statedAt"
                          type="datetime-local"
                          defaultValue={now}
                          max={now}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="ops-reason">Reason</label>
                        <select id="ops-reason" name="reason">
                          {Object.entries(ON_BEHALF).map(([code, label]) => (
                            <option key={code} value={code}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Note id="ops-note" label="Note (operations only; needed for Other)" />
                      <button className="button" type="submit" id="ops-record">
                        Record
                      </button>
                    </form>
                  ) : null}

                  {b.trip.milestones.length > 0 ? (
                    <form className="form card" action={withdrawMilestoneAction} id="withdraw-form">
                      {hidden}
                      <input type="hidden" name="version" value={b.trip.version} />
                      <input type="hidden" name="anchor" value="trip" />
                      <h3>Withdraw the latest milestone</h3>
                      <p>
                        Only when it was recorded by mistake:{' '}
                        <strong>
                          {MILESTONES[b.trip.milestones[b.trip.milestones.length - 1]!.milestone]}
                        </strong>
                        . It stays in the record as withdrawn, and the trip goes back one step.
                      </p>
                      <Note id="withdraw-note" label="Why it is withdrawn (operations only)" />
                      <button
                        className="button button-danger"
                        type="submit"
                        id="withdraw-milestone"
                      >
                        Withdraw it
                      </button>
                    </form>
                  ) : null}
                </section>
              ) : null}

              <section className="section" id="cases" aria-labelledby="cases-title">
                <h2 id="cases-title">Cases</h2>
                {b.cases.length === 0 ? (
                  <p id="no-cases">No case on this booking.</p>
                ) : (
                  <ol className="organisation-list">
                    {b.cases.map((item) => (
                      <CaseCard key={item.id} item={item} bookingId={b.id} />
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
