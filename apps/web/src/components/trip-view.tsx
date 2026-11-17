import type { Messages } from '../i18n/messages.ts';
import type { Trip } from '../server/api.ts';
import { InstantText } from './booking-view.tsx';

// What a trip shows its parties (slice 17a): when it was dispatched, the milestones recorded
// in order, and the latest arrival estimate. A milestone entered for the driver says who
// entered it, for whom and why, and that its time is reported rather than observed (E-4).
// Trucker collects no location: every time here was stated by a person.

type T = Messages['trip'];

export function TripFacts({ t, trip }: { t: T; trip: Trip }) {
  return (
    <div id="trip-facts" data-milestones={trip.milestones.length} data-next={trip.next ?? 'none'}>
      <p className="field-hint">{t.noLocation}</p>
      <p id="trip-dispatched">
        {t.dispatchedAt}: <InstantText at={trip.dispatchedAt} />
      </p>
      {trip.late ? (
        <p className="notice" id="trip-late">
          {t.late}
        </p>
      ) : null}
      <h3 id="trip-milestones-title">{t.milestonesTitle}</h3>
      {trip.milestones.length === 0 ? (
        <p id="trip-no-milestones">{t.noMilestones}</p>
      ) : (
        <ol className="evidence" id="trip-milestones" aria-labelledby="trip-milestones-title">
          {trip.milestones.map((item) => (
            <li
              key={item.milestone}
              data-milestone={item.milestone}
              data-basis={item.basis}
              data-review={item.needsReview ? 'yes' : 'no'}
            >
              <strong>{t.milestones[item.milestone]}</strong>: <InstantText at={item.statedAt} />
              <br />
              {item.basis === 'observed' ? (
                <span className="field-hint">{t.observed}</span>
              ) : (
                <span className="field-hint">
                  {t.reportedBy
                    .replace('{by}', item.enteredBy ?? '')
                    .replace('{about}', item.about)}
                  {item.reason ? ` (${t.reason}: ${t.reasons[item.reason]})` : null}
                </span>
              )}
              {item.note ? (
                <>
                  <br />
                  {t.noteLabel}: <bdi>{item.note}</bdi>
                </>
              ) : null}
              {item.needsReview ? <p className="notice">{t.needsReview}</p> : null}
            </li>
          ))}
        </ol>
      )}
      <h3>{t.estimateTitle}</h3>
      {trip.estimate ? (
        <p id="trip-estimate" data-stated-as={trip.estimate.statedAs}>
          <InstantText at={trip.estimate.arrivalAt} />
          <br />
          <span className="field-hint">
            {t.statedBy
              .replace('{by}', trip.estimate.statedBy)
              .replace('{as}', t.statedAs[trip.estimate.statedAs])}{' '}
            <InstantText at={trip.estimate.statedAt} />
          </span>
        </p>
      ) : (
        <p id="trip-estimate" data-stated-as="none">
          {t.noEstimate}
        </p>
      )}
    </div>
  );
}

/** A minute in UTC for a datetime-local field: the page says the time is UTC. */
export const utcMinute = (at: Date): string => at.toISOString().slice(0, 16);
