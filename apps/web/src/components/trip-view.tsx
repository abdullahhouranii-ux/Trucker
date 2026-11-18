import type { Messages } from '../i18n/messages.ts';
import type { ExceptionType, Trip } from '../server/api.ts';
import { Field } from './form.tsx';
import { InstantText } from './booking-view.tsx';

// What a trip shows its parties (slice 17a): when it was dispatched, the milestones recorded
// in order, and the latest arrival estimate. A milestone entered for the driver says who
// entered it, for whom and why, and that its time is reported rather than observed (E-4).
// Trucker collects no location: every time here was stated by a person.

type T = Messages['trip'];

export function TripFacts({ t, trip }: { t: T; trip: Trip }) {
  return (
    <div id="trip-facts" data-milestones={trip.milestones.length} data-next={trip.next ?? 'none'}>
      {trip.hold ? (
        <p className="notice notice-error" id="trip-hold" data-reason={trip.hold.reason}>
          {t.hold.replace('{reason}', t.operationsReasons[trip.hold.reason])}{' '}
          <span className="field-hint">
            {t.heldSince} <InstantText at={trip.hold.heldAt} />
          </span>
        </p>
      ) : null}
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
                  {item.enteredAs === 'operations'
                    ? t.enteredByOperations.replace('{about}', item.about)
                    : t.reportedBy
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
      {trip.withdrawn && trip.withdrawn.length > 0 ? (
        <>
          <h3 id="trip-withdrawn-title">{t.withdrawnTitle}</h3>
          <p className="field-hint">{t.withdrawnLead}</p>
          <ul className="evidence" id="trip-withdrawn" aria-labelledby="trip-withdrawn-title">
            {trip.withdrawn.map((item) => (
              <li key={item.withdrawnAt + item.milestone} data-withdrawn={item.milestone}>
                <s>{t.milestones[item.milestone]}</s>: <InstantText at={item.statedAt} /> (
                {t.withdrawnAt} <InstantText at={item.withdrawnAt} />)
              </li>
            ))}
          </ul>
        </>
      ) : null}
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
      <TripCases t={t} trip={trip} />
    </div>
  );
}

/** The problems reported on a trip: the type and state; the description only to its side. */
function TripCases({ t, trip }: { t: T; trip: Trip }) {
  const cases = trip.cases ?? [];
  return (
    <>
      <h3 id="trip-cases-title">{t.casesTitle}</h3>
      {cases.length === 0 ? (
        <p id="trip-no-cases">{t.noCases}</p>
      ) : (
        <ul className="evidence" id="trip-cases" aria-labelledby="trip-cases-title">
          {cases.map((item) => (
            <li
              key={item.id}
              data-case={item.kind}
              data-state={item.state}
              data-type={item.type ?? ''}
            >
              <strong>
                {item.kind === 'exception' && item.type
                  ? t.exceptionTypes[item.type]
                  : t.caseKinds[item.kind as 'overrun' | 'no_pickup_arrival']}
              </strong>
              <br />
              <span className="field-hint">
                {t.caseLine.replace('{as}', t.reportedAs[item.reportedAs])},{' '}
                <InstantText at={item.reportedAt} />. {t.state}: {t.caseStates[item.state]}
              </span>
              {item.description ? (
                <>
                  <br />
                  <bdi>{item.description}</bdi>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const TYPES: ExceptionType[] = [
  'delay',
  'breakdown',
  'accident',
  'cargo_damage_or_shortage',
  'refused_at_site',
  'receiver_absent',
  'document_problem',
  'road_closed',
  'safety_concern',
  'no_show',
  'other',
];

/** Reporting a problem on a trip. The retry key makes a repeated or retried report one case. */
export function ReportProblem({
  t,
  id,
  action,
  hidden,
  retryKey,
}: {
  t: T;
  id: string;
  action: (form: FormData) => Promise<void>;
  hidden: React.ReactNode;
  retryKey: string;
}) {
  return (
    <form action={action} id={id} className="form card">
      {hidden}
      <input type="hidden" name="retryKey" value={retryKey} />
      <h3>{t.reportTitle}</h3>
      <p className="notice" data-emergency="yes">
        {t.emergency}
      </p>
      <p className="field-hint">{t.reportLead}</p>
      <Field id={`${id}-type`} label={t.exceptionType}>
        <select id={`${id}-type`} name="type" required>
          {TYPES.map((code) => (
            <option key={code} value={code}>
              {t.exceptionTypes[code]}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${id}-description`} label={t.description}>
        <textarea id={`${id}-description`} name="description" maxLength={2000} required />
      </Field>
      <button className="button" type="submit" data-report={id}>
        {t.report}
      </button>
    </form>
  );
}

/** A minute in UTC for a datetime-local field: the page says the time is UTC. */
export const utcMinute = (at: Date): string => at.toISOString().slice(0, 16);

type D = Messages['delivery'];

/** The delivery outcome, custody and releases (slice 18a). */
export function DeliveryFacts({
  d,
  t,
  delivery,
  roles,
}: {
  d: D;
  t: T;
  delivery: NonNullable<Trip['delivery']>;
  roles: Record<string, string>;
}) {
  const line = (item: NonNullable<NonNullable<Trip['delivery']>['outcome']>) => (
    <>
      <strong>{d.outcomes[item.outcome]}</strong>: <InstantText at={item.statedAt} />
      <br />
      <span className="field-hint">
        {item.basis === 'observed'
          ? d.recordedByDriver
          : item.enteredAs === 'operations'
            ? d.enteredByOperations.replace('{about}', item.about)
            : t.reportedBy.replace('{by}', item.enteredBy ?? '').replace('{about}', item.about)}
        {item.reason ? ` (${t.reason}: ${t.reasons[item.reason]})` : null}
      </span>
      {item.receiverName ? (
        <>
          <br />
          {d.receiver}: <bdi>{item.receiverName}</bdi>
        </>
      ) : null}
      {item.remarks ? (
        <>
          <br />
          {d.remarks}: <bdi>{item.remarks}</bdi>
        </>
      ) : null}
      {item.note ? (
        <>
          <br />
          {t.noteLabel}: <bdi>{item.note}</bdi>
        </>
      ) : null}
    </>
  );
  return (
    <div id="delivery-facts" data-outcome={delivery.outcome?.outcome ?? 'none'}>
      <h3 id="delivery-title">{d.title}</h3>
      {delivery.outcome ? (
        <p id="delivery-outcome">{line(delivery.outcome)}</p>
      ) : (
        <p id="delivery-none">{d.none}</p>
      )}
      {delivery.earlier.length > 0 ? (
        <>
          <p className="field-hint">{d.earlier}</p>
          <ul className="evidence" id="delivery-earlier">
            {delivery.earlier.map((item) => (
              <li key={item.version}>
                <s>{d.outcomes[item.outcome]}</s>: <InstantText at={item.statedAt} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {delivery.custody ? (
        delivery.custody.handover ? (
          <p id="custody" data-custody="closed">
            <strong>{d.custodyClosed}</strong>: {d.handoverKinds[delivery.custody.handover.kind]},{' '}
            <InstantText at={delivery.custody.handover.handedAt} />
            <br />
            {d.handedBy}: <bdi>{delivery.custody.handover.handedBy}</bdi>. {d.receivedBy}:{' '}
            <bdi>{delivery.custody.handover.receivedBy}</bdi>. {d.place}:{' '}
            <bdi>{delivery.custody.handover.place}</bdi>
          </p>
        ) : (
          <p className="notice" id="custody" data-custody="open">
            {d.custodyOpen}
          </p>
        )
      ) : null}
      {delivery.releases && delivery.releases.length > 0 ? (
        <>
          <h4>{d.releasesTitle}</h4>
          <ul className="evidence" id="releases">
            {delivery.releases.map((item) => (
              <li key={item.role} data-released={item.role}>
                {roles[item.role]}:{' '}
                {item.releasedAs === 'operations' ? d.releasedByOperations : d.released}{' '}
                <InstantText at={item.releasedAt} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

const OUTCOMES = [
  'delivered_in_full',
  'delivered_with_remarks',
  'partly_delivered',
  'refused',
  'not_delivered',
] as const;

/** Recording the outcome: by the driver as it happens, or on the driver's behalf. */
export function DeliveryForm({
  d,
  t,
  id,
  action,
  hidden,
  onBehalf,
}: {
  d: D;
  t: T;
  id: string;
  action: (form: FormData) => Promise<void>;
  hidden: React.ReactNode;
  onBehalf: boolean;
}) {
  const now = utcMinute(new Date());
  return (
    <form action={action} id={id} className="form card">
      {hidden}
      <input type="hidden" name="version" value="0" />
      <h3>{onBehalf ? d.onBehalfTitle : d.recordTitle}</h3>
      <p className="field-hint">{d.recordLead}</p>
      <Field id={`${id}-outcome`} label={d.outcome}>
        <select id={`${id}-outcome`} name="outcome" required>
          {OUTCOMES.map((code) => (
            <option key={code} value={code}>
              {d.outcomes[code]}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${id}-receiver`} label={d.receiverName}>
        <input id={`${id}-receiver`} name="receiverName" type="text" maxLength={200} />
      </Field>
      <Field id={`${id}-remarks`} label={d.remarksField}>
        <textarea id={`${id}-remarks`} name="remarks" maxLength={2000} />
      </Field>
      <div className="field">
        <label>
          <input type="checkbox" name="cargoRemains" value="true" /> {d.cargoRemainsField}
        </label>
      </div>
      {onBehalf ? (
        <>
          <Field id={`${id}-at`} label={t.statedAt}>
            <input
              id={`${id}-at`}
              name="statedAt"
              type="datetime-local"
              defaultValue={now}
              max={now}
              required
            />
          </Field>
          <Field id={`${id}-reason`} label={t.reason}>
            <select id={`${id}-reason`} name="reason" required>
              {(['no_phone', 'no_signal', 'driver_unable', 'correction', 'other'] as const).map(
                (code) => (
                  <option key={code} value={code}>
                    {t.reasons[code]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field id={`${id}-note`} label={t.note}>
            <textarea id={`${id}-note`} name="note" maxLength={500} />
          </Field>
        </>
      ) : null}
      <button className="button button-primary" type="submit" data-record-delivery={id}>
        {d.record}
      </button>
    </form>
  );
}

/** The carrier records the handover of cargo left on the vehicle. */
export function HandoverForm({
  d,
  action,
  hidden,
}: {
  d: D;
  action: (form: FormData) => Promise<void>;
  hidden: React.ReactNode;
}) {
  const now = utcMinute(new Date());
  return (
    <form action={action} id="handover-form" className="form card">
      {hidden}
      <h3>{d.handoverTitle}</h3>
      <Field id="handover-kind" label={d.handoverKind}>
        <select id="handover-kind" name="kind" required>
          {(['returned_to_shipper', 'delivered_elsewhere', 'replacement_vehicle'] as const).map(
            (code) => (
              <option key={code} value={code}>
                {d.handoverKinds[code]}
              </option>
            ),
          )}
        </select>
      </Field>
      <Field id="handover-by" label={d.handedBy}>
        <input id="handover-by" name="handedBy" type="text" maxLength={200} required />
      </Field>
      <Field id="handover-to" label={d.receivedBy}>
        <input id="handover-to" name="receivedBy" type="text" maxLength={200} required />
      </Field>
      <Field id="handover-at" label={d.handedAt}>
        <input
          id="handover-at"
          name="handedAt"
          type="datetime-local"
          defaultValue={now}
          max={now}
          required
        />
      </Field>
      <Field id="handover-place" label={d.place}>
        <input id="handover-place" name="place" type="text" maxLength={500} required />
      </Field>
      <Field id="handover-note" label={d.note}>
        <textarea id="handover-note" name="note" maxLength={1000} />
      </Field>
      <button className="button" type="submit" id="record-handover">
        {d.recordHandover}
      </button>
    </form>
  );
}
