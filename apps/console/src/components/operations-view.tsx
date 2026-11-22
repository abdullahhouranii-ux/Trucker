import { caseAction } from '../server/operations-actions.ts';
import { utc } from './console-header.tsx';

// What Trucker operations sees of trips and their cases (slice 17b). Notes written here stay
// with operations: the parties see that a case exists, its type and its state. Times are UTC.

export interface OperationsCase {
  id: string;
  bookingId: string;
  kind: 'exception' | 'overrun' | 'no_pickup_arrival';
  type: string | null;
  state: 'open' | 'acknowledged' | 'resolved';
  reportedAs: 'driver' | 'carrier' | 'shipper' | 'system';
  reportedBy: string | null;
  reportedAt: string;
  description: string | null;
  version: number;
  atRisk: string[];
  events: {
    action: 'acknowledged' | 'action' | 'resolved';
    at: string;
    note: string | null;
    by: string;
  }[];
}

export const at = (iso: string): string => utc(new Date(iso).toISOString());

export const REASONS: Record<string, string> = {
  safety_review: 'Safety review',
  document_concern: 'Document concern',
  suspected_fraud: 'Suspected fraud',
  other: 'Other',
};
export const TYPES: Record<string, string> = {
  delay: 'Delay',
  breakdown: 'Breakdown',
  accident: 'Accident',
  cargo_damage_or_shortage: 'Cargo damage or shortage',
  refused_at_site: 'Refused or blocked at a site',
  receiver_absent: 'Receiver absent',
  document_problem: 'Document problem',
  road_closed: 'Road closed',
  safety_concern: 'Safety concern',
  no_show: 'No-show',
  other: 'Other',
};
const KINDS: Record<string, string> = {
  overrun: 'A resource is still on this trip past its planned end',
  no_pickup_arrival: 'No arrival at pick-up by the end of the pick-up window',
};
const STATES: Record<OperationsCase['state'], string> = {
  open: 'Open: not yet acknowledged',
  acknowledged: 'Acknowledged: being handled',
  resolved: 'Resolved',
};
const AS: Record<OperationsCase['reportedAs'], string> = {
  driver: 'the driver',
  carrier: 'the carrier',
  shipper: 'the shipper',
  system: 'Trucker (seen automatically)',
};
const EVENTS: Record<string, string> = {
  acknowledged: 'Acknowledged',
  action: 'Action',
  resolved: 'Resolved',
};

export const DONE: Record<string, string> = {
  acknowledged: 'The case is acknowledged.',
  recorded: 'Recorded.',
  resolved: 'The case is resolved.',
  blocked: 'Dispatch is blocked. The parties see the reason, not the note.',
  lifted: 'The block is lifted.',
  held: 'The trip is on hold. No milestone is recorded until it is resumed.',
  resumed: 'The trip is resumed.',
  withdrawn: 'The milestone is withdrawn. It stays in the record, and the trip is back one step.',
};
export const ERRORS: Record<string, string> = {
  staff_privilege_required: 'Your account does not hold the operations privilege.',
  not_found: 'That was not found.',
  record_changed: 'This changed since the page was loaded. Nothing was changed.',
  case_not_open: 'This case is not open for that step. The page shows its present state.',
  already_blocked: 'A block is already in force on this dispatch.',
  not_blocked: 'No block is in force on this dispatch.',
  booking_dispatched: 'This booking has already been dispatched: a block comes too late.',
  booking_cancelled: 'This booking is cancelled.',
  already_held: 'This trip is already on hold.',
  not_held: 'This trip is not on hold.',
  not_dispatched: 'This booking has not been dispatched.',
  trip_on_hold: 'The trip is on hold: resume it before recording a milestone.',
  milestone_out_of_sequence: 'That is not the next milestone. Nothing was recorded.',
  nothing_to_withdraw: 'No milestone is recorded on this trip.',
  validation_failed:
    'Something is missing or not valid: every step except acknowledging needs a note, and a block or hold needs a reason.',
  unconfirmed:
    'It was not confirmed that this was done. It may have been. The page shows the present state.',
};

export function caseTitle(item: { kind: string; type: string | null }): string {
  return item.kind === 'exception' && item.type
    ? (TYPES[item.type] ?? item.type)
    : (KINDS[item.kind] ?? item.kind);
}

/** One case with its history and the step it allows. */
export function CaseCard({ item, bookingId }: { item: OperationsCase; bookingId?: string }) {
  const field = (name: string) => `${name}-${item.id}`;
  return (
    <li className="card" data-case={item.id} data-kind={item.kind} data-state={item.state}>
      <h3>{caseTitle(item)}</h3>
      <ul className="evidence">
        <li>
          Reported by {AS[item.reportedAs]}
          {item.reportedBy ? (
            <>
              {' '}
              (<bdi>{item.reportedBy}</bdi>)
            </>
          ) : null}{' '}
          at {at(item.reportedAt)}
        </li>
        <li data-case-state={item.state}>{STATES[item.state]}</li>
        {item.description ? (
          <li>
            Description: <bdi>{item.description}</bdi>
          </li>
        ) : null}
        {bookingId ? null : (
          <li>
            Booking:{' '}
            <a className="button" href={`/operations/bookings/${item.bookingId}`}>
              <bdi dir="ltr">{item.bookingId}</bdi>
            </a>
          </li>
        )}
        {item.atRisk.length > 0 ? (
          <li>
            Later bookings at risk:{' '}
            {item.atRisk.map((id, index) => (
              <span key={id}>
                {index > 0 ? ', ' : null}
                <a className="button" href={`/operations/bookings/${id}`}>
                  <bdi dir="ltr">{id.slice(0, 8)}</bdi>
                </a>
              </span>
            ))}
          </li>
        ) : null}
      </ul>
      {item.events.length > 0 ? (
        <ol className="evidence" data-case-history>
          {item.events.map((event, index) => (
            <li key={index}>
              {EVENTS[event.action]} by <bdi>{event.by}</bdi> at {at(event.at)}
              {event.note ? (
                <>
                  : <bdi>{event.note}</bdi>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {item.state === 'resolved' ? null : (
        <form className="form" action={caseAction}>
          <input type="hidden" name="caseId" value={item.id} />
          <input type="hidden" name="version" value={item.version} />
          {bookingId ? <input type="hidden" name="bookingId" value={bookingId} /> : null}
          {item.state === 'open' ? (
            <button
              className="button button-primary"
              type="submit"
              name="action"
              value="acknowledge"
            >
              Acknowledge
            </button>
          ) : (
            <>
              <div className="field">
                <label htmlFor={field('note')}>
                  What was done, or how it was resolved (seen by operations only)
                </label>
                <textarea id={field('note')} name="note" rows={2} maxLength={2000} />
              </div>
              <div className="form-inline">
                <button className="button" type="submit" name="action" value="action">
                  Record the action
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  name="action"
                  value="resolve"
                >
                  Resolve
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </li>
  );
}
