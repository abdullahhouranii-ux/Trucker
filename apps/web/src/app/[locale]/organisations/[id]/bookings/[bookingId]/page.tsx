import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../../../components/draft-keeper.tsx';
import {
  BookingCard,
  InstantText,
  PaymentNotice,
  PayOnline,
} from '../../../../../../components/booking-view.tsx';
import { ErrorSummary, Field } from '../../../../../../components/form.tsx';
import { ReportProblem, TripFacts, utcMinute } from '../../../../../../components/trip-view.tsx';
import { direction, isLocale, type Locale } from '../../../../../../i18n/config.ts';
import { getMessages, type Messages } from '../../../../../../i18n/messages.ts';
import {
  api,
  type AssignedSet,
  type AssignedVehicle,
  type AssignmentCandidates,
  type BookingDetail,
  type PaymentOptions,
} from '../../../../../../server/api.ts';
import {
  assignResourcesAction,
  cancelBookingAction,
  decideSubstitutionAction,
  dispatchBookingAction,
  recordMilestoneOnBehalfAction,
  reportProblemAction,
  stateEstimateAction,
  waitForCarrierAction,
} from '../../../../../../server/assignment-actions.ts';
import { requirePerson } from '../../../../../../server/session.ts';

// One booking, for its shipper or its carrier. The carrier assigns its resources here; the
// shipper decides on a proposed substitution and may record that it will wait. What each side
// is shown of the other's details depends on whether the booking is confirmed. Nothing on
// this page invoices or pays. From slice 17a the carrier dispatches here; once dispatched the
// booking shows its trip, and cancelling or changing resources is no longer offered.

type Props = {
  params: Promise<{ locale: string; id: string; bookingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
type A = Messages['asg'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Points from the earlier value to the later one in the reading direction of the page. */
const arrow = (locale: Locale) => (direction(locale) === 'rtl' ? ' ← ' : ' → ');

const plate = (vehicle: AssignedVehicle) => (
  <bdi dir="ltr">
    {vehicle.registrationCountry} {vehicle.registrationNumber}
  </bdi>
);

/** The assigned or proposed set, as far as this party is shown it. */
function SetFacts({ a, set, id }: { a: A; set: AssignedSet; id: string }) {
  const rows: ['truck' | 'trailer' | 'driver', React.ReactNode][] = [
    ['truck', set.truck ? plate(set.truck) : null],
    ['trailer', set.trailer ? plate(set.trailer) : null],
    ['driver', set.driver ? <bdi>{set.driver.name}</bdi> : null],
  ];
  return (
    <dl className="facts" id={id}>
      {rows.map(([role, value]) => (
        <div key={role}>
          <dt>{a.roles[role]}</dt>
          <dd data-member={role} data-assigned={value ? 'yes' : 'no'}>
            {value ?? a.none}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default async function BookingPage({ params, searchParams }: Props) {
  const { locale, id, bookingId } = await params;
  const search = await searchParams;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id) || !UUID.test(bookingId)) notFound();
  const m = getMessages(locale);
  const a = m.asg;
  const one = (name: string): string => {
    const value = search[name];
    return typeof value === 'string' ? value : '';
  };
  const person = await requirePerson(locale);
  // An unconfirmed session is not an ended one: the request fails as unavailable or with 401.
  const reply = await api<BookingDetail>('GET', `/organisations/${id}/bookings/${bookingId}`, {
    token: person.token,
  });
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (!reply.ok && reply.status === 404) notFound();
  const options = await api<PaymentOptions>('GET', '/payments/options');
  const online = options.ok && options.data.online;
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-bookings" href={`/${locale}/organisations/${id}/bookings`}>
        {a.backToBookings}
      </a>
    </div>
  );
  if (!reply.ok)
    return (
      <div className="page page-narrow" data-state="booking-unavailable">
        {back}
        <h1>{a.title}</h1>
        <ErrorSummary
          title={m.auth.errors.summary}
          problems={[{ message: a.errors.unavailable }]}
        />
      </div>
    );
  const { booking, candidates } = reply.data;
  const role = booking.role === 'carrier' ? 'carrier' : 'shipper';
  const confirmed = booking.status === 'confirmed';
  const cancelled = booking.status === 'cancelled';
  const trip = booking.trip ?? null;
  const ct = m.cancel;
  const tt = m.trip;

  // A refusal names, where it can, which resource and why, in words this page already has.
  const reasonText = (reason: string): string | undefined =>
    (a.reasons as Record<string, string>)[reason] ??
    (m.fleet.eligibility as Record<string, string>)[reason];
  const error = one('aError');
  const problems: { message: string }[] = [];
  if (error) {
    const message = (a.errors as Record<string, string>)[error] ?? a.errors.invalid;
    const roleName = (a.roles as Record<string, string>)[one('aRole')];
    const reason = reasonText(one('aReason'));
    if (error === 'dispatch_refused') {
      // Why dispatch was refused: the first precondition that failed.
      const code = one('aReason');
      const why =
        (tt.refusals as Record<string, string>)[code] ??
        (a.blockers as Record<string, string>)[code];
      const cause =
        code === 'operations_block'
          ? (tt.operationsReasons as Record<string, string>)[one('aCause')]
          : reasonText(one('aCause'));
      const parts = [
        message,
        why,
        roleName
          ? `${roleName}${cause ? `: ${cause}` : ''}`
          : code === 'operations_block'
            ? cause
            : null,
      ];
      problems.push({ message: parts.filter(Boolean).join(' ') });
    } else
      problems.push({
        message: roleName && reason ? `${message} ${roleName}: ${reason}` : message,
      });
  }
  const done = one('aDone');
  const confirmation = done ? (a.done as Record<string, string>)[done] : undefined;
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organisationId" value={id} />
      <input type="hidden" name="bookingId" value={booking.id} />
    </>
  );

  return (
    <div className="page page-narrow" data-state="booking" data-role={role}>
      {back}
      <h1>{a.title}</h1>
      <ErrorSummary title={m.auth.errors.summary} problems={problems} />
      {confirmation && problems.length === 0 ? (
        <p className="notice notice-success" role="status" id="assignment-confirmation">
          {confirmation}
        </p>
      ) : null}
      <BookingCard t={m.book} a={a} locale={locale} booking={booking} />
      <PaymentNotice
        t={m.book}
        fee={booking.feePayment}
        payment={one('payment')}
        payError={one('payError')}
      />
      <PayOnline
        t={m.book}
        locale={locale}
        fee={booking.feePayment}
        online={online}
        organisationId={id}
        bookingId={booking.id}
        returnTo={`/${locale}/organisations/${id}/bookings/${booking.id}`}
      />
      {booking.cancellation ? (
        <section className="section" id="cancellation-record" aria-labelledby="cancellation-title">
          <h2 id="cancellation-title">{ct.status}</h2>
          <p>
            {ct.party}:{' '}
            {booking.cancellation.party === 'platform'
              ? ct.byPlatform
              : m.book.asRole[booking.cancellation.party]}
          </p>
          <p>
            {ct.at}: <InstantText at={booking.cancellation.at} />
          </p>
          <p>
            {ct.reason}: {(ct.reasons as Record<string, string>)[booking.cancellation.reason]}
          </p>
          {booking.cancellation.note ? (
            <p>
              <bdi>{booking.cancellation.note}</bdi>
            </p>
          ) : null}
          {role === 'shipper' ? (
            <a
              className="button"
              href={`/${locale}/organisations/${id}/shipments/${booking.shipmentId}`}
            >
              {ct.again}
            </a>
          ) : null}
        </section>
      ) : null}
      {reply.data.open && !trip && (!cancelled || error === 'cancel_unconfirmed') ? (
        <section className="section" id="cancel-booking" aria-labelledby="cancel-title">
          <h2 id="cancel-title">{ct.title}</h2>
          <p>{ct.warning}</p>
          <form action={cancelBookingAction} id="cancel-booking-form" className="form card">
            {hidden}
            <input type="hidden" name="version" value={booking.assignmentVersion} />
            <Field id="cancel-reason" label={ct.reason}>
              <select id="cancel-reason" name="reason" data-draft required>
                {(role === 'shipper'
                  ? [
                      'shipment_no_longer_needed',
                      'dates_changed',
                      'carrier_did_not_assign',
                      'other',
                    ]
                  : ['resource_unavailable', 'cannot_meet_window', 'other']
                ).map((code) => (
                  <option key={code} value={code}>
                    {(ct.reasons as Record<string, string>)[code]}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="cancel-note" label={ct.note}>
              <textarea id="cancel-note" name="note" data-draft maxLength={2000} />
            </Field>
            <button type="submit" className="button button-danger" id="cancel-booking-submit">
              {cancelled ? ct.confirm : ct.submit}
            </button>
          </form>
        </section>
      ) : null}

      <DraftKeeper
        formId="cancel-booking-form"
        scope={`${id}:${bookingId}`}
        clear={cancelled}
        overwrite
      />

      <section className="section" aria-labelledby="state-title" id="state">
        <h2 id="state-title">{a.stateTitle}</h2>
        {booking.waitDecision ? (
          <p id="wait-recorded">
            {a.waitRecorded} <InstantText at={booking.waitDecision.decidedAt} />
          </p>
        ) : null}
        {role === 'shipper' && booking.overdue && !booking.waitDecision ? (
          <form action={waitForCarrierAction}>
            {hidden}
            <p className="field-hint">{a.waitNote}</p>
            <button className="button" type="submit" id="wait-for-carrier">
              {a.wait}
            </button>
          </form>
        ) : null}
        {trip ? null : <h3>{a.dispatchTitle}</h3>}
        {trip ? null : booking.dispatch.ready ? (
          <p id="dispatch" data-ready="yes">
            {a.dispatchReady}
          </p>
        ) : (
          <div id="dispatch" data-ready="no">
            <p>{a.dispatchBlocked}</p>
            <ul className="evidence">
              {booking.dispatch.blockers.map((blocker, index) => (
                <li key={index} data-blocker={blocker.code}>
                  {a.blockers[blocker.code]}
                  {blocker.code === 'operations_block' && blocker.reason
                    ? `: ${(tt.operationsReasons as Record<string, string>)[blocker.reason] ?? ''}`
                    : null}
                  {blocker.role ? (
                    <>
                      {' '}
                      {a.roles[blocker.role]}
                      {blocker.reason && reasonText(blocker.reason)
                        ? `: ${reasonText(blocker.reason)}`
                        : null}
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {trip || (role === 'carrier' && !cancelled && booking.dispatch.ready) ? (
        <section className="section" aria-labelledby="trip-title" id="trip">
          <h2 id="trip-title">{tt.title}</h2>
          {trip ? (
            <>
              <TripFacts t={tt} trip={trip} />
              {role === 'carrier' ? <CarrierTripForms t={tt} trip={trip} hidden={hidden} /> : null}
              <ReportProblem
                t={tt}
                id="report-problem"
                action={reportProblemAction}
                hidden={hidden}
                retryKey={UUID.test(one('aKey')) ? one('aKey') : randomUUID()}
              />
            </>
          ) : (
            <form action={dispatchBookingAction} id="dispatch-form">
              {hidden}
              <input
                type="hidden"
                name="retryKey"
                value={UUID.test(one('aKey')) ? one('aKey') : randomUUID()}
              />
              <p>{tt.dispatchLead}</p>
              {booking.dispatchFrom ? (
                <p className="field-hint" id="dispatch-from">
                  {tt.dispatchFrom} <InstantText at={booking.dispatchFrom} />
                </p>
              ) : null}
              <button className="button button-primary" type="submit" id="dispatch-booking">
                {tt.dispatch}
              </button>
            </form>
          )}
        </section>
      ) : null}

      <section className="section" aria-labelledby="resources-title">
        <h2 id="resources-title">{a.resourcesTitle}</h2>
        {booking.resources ? (
          <>
            <SetFacts a={a} set={booking.resources} id="resources" />
            {booking.resources.driver ? (
              <p
                className="field-hint"
                id="acknowledgement"
                data-given={booking.acknowledgedAt ? 'yes' : 'no'}
              >
                {booking.acknowledgedAt ? a.acknowledged : a.notAcknowledged}
              </p>
            ) : null}
          </>
        ) : (
          <p id="resources-hidden">{a.resourcesHidden}</p>
        )}
        {booking.vehicleChanges && booking.vehicleChanges.length > 0 ? (
          <>
            <h3 id="vehicle-changes-title">{a.changesTitle}</h3>
            <p className="field-hint">{a.changesNote}</p>
            <ol className="evidence" id="vehicle-changes" aria-labelledby="vehicle-changes-title">
              {booking.vehicleChanges.flatMap((entry, index) =>
                entry.changes.map((change) => (
                  <li key={`${index}-${change.role}`} data-change={change.role}>
                    <InstantText at={entry.at} />: {a.roles[change.role]}{' '}
                    {change.from ? plate(change.from) : a.none}
                    {arrow(locale as Locale)}
                    {change.to ? plate(change.to) : a.none}
                  </li>
                )),
              )}
            </ol>
          </>
        ) : null}
      </section>

      {booking.substitution ? (
        <section className="section" aria-labelledby="substitution-title" id="substitution">
          <h2 id="substitution-title">{a.substitutionTitle}</h2>
          <p>{role === 'shipper' ? a.substitutionShipper : a.substitutionCarrier}</p>
          <ul className="evidence" id="substitution-differences">
            {booking.substitution.differences.map((item, index) => (
              <li key={index} data-difference={`${item.role}-${item.change}`}>
                {a.roles[item.role]}: {a.changes[item.change]}
                {item.from ? (
                  <>
                    {' '}
                    (<bdi>{item.from[locale as Locale]}</bdi>
                    {item.to ? (
                      <>
                        {arrow(locale as Locale)}
                        <bdi>{item.to[locale as Locale]}</bdi>
                      </>
                    ) : null}
                    )
                  </>
                ) : item.to ? (
                  <>
                    {' '}
                    (<bdi>{item.to[locale as Locale]}</bdi>)
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <SetFacts a={a} set={booking.substitution.proposed} id="substitution-proposed" />
          <form className="form-inline" action={decideSubstitutionAction}>
            {hidden}
            <input type="hidden" name="substitutionId" value={booking.substitution.id} />
            <input type="hidden" name="version" value={booking.substitution.version} />
            {role === 'shipper' ? (
              <>
                <button
                  className="button button-primary"
                  type="submit"
                  name="decision"
                  value="accept"
                  id="accept-substitution"
                >
                  {a.acceptSubstitution}
                </button>
                <button
                  className="button"
                  type="submit"
                  name="decision"
                  value="decline"
                  id="decline-substitution"
                >
                  {a.declineSubstitution}
                </button>
              </>
            ) : (
              <button
                className="button"
                type="submit"
                name="decision"
                value="withdraw"
                id="withdraw-substitution"
              >
                {a.withdrawSubstitution}
              </button>
            )}
          </form>
        </section>
      ) : null}

      {booking.site ? (
        <section className="section" aria-labelledby="site-title" id="site">
          <h2 id="site-title">{a.siteTitle}</h2>
          <p className="field-hint">{a.siteNote}</p>
          <dl className="facts">
            {(['pickup', 'delivery'] as const).map((place) => (
              <div key={place}>
                <dt>{a[place]}</dt>
                <dd data-site={place}>
                  <bdi>{booking.site![place].address}</bdi>
                  <br />
                  {a.accessNotes}: <bdi>{booking.site![place].accessNotes ?? a.noAccessNotes}</bdi>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {role === 'carrier' && !cancelled && !trip ? (
        <section className="section" aria-labelledby="assign-title" id="assign">
          <h2 id="assign-title">{a.assignTitle}</h2>
          {candidates && !booking.substitution ? (
            <AssignForm
              a={a}
              m={m}
              locale={locale}
              candidates={candidates}
              current={booking.resources}
              version={booking.assignmentVersion}
              confirmed={confirmed}
              hidden={hidden}
            />
          ) : (
            <p id="cannot-assign">
              {booking.substitution ? a.substitutionCarrier : a.cannotAssign}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** Three choices: the whole set the carrier wants. A resource that cannot be assigned says why. */
function AssignForm({
  a,
  m,
  locale,
  candidates,
  current,
  version,
  confirmed,
  hidden,
}: {
  a: A;
  m: Messages;
  locale: Locale;
  candidates: AssignmentCandidates;
  current: AssignedSet | null;
  version: number;
  confirmed: boolean;
  hidden: React.ReactNode;
}) {
  const why = (state: string): string =>
    state === 'eligible'
      ? ''
      : ` (${(a.reasons as Record<string, string>)[state] ?? (m.fleet.eligibility as Record<string, string>)[state] ?? state})`;
  const vehicles = (kind: 'truck' | 'trailer') =>
    candidates.vehicles
      .filter((vehicle) => vehicle.kind === kind)
      .map((vehicle) => ({
        value: vehicle.id,
        label: `${vehicle.registrationCountry} ${vehicle.registrationNumber}, ${vehicle.category[locale]}${why(vehicle.state)}`,
        // The one already assigned stays selectable whatever has happened to it since.
        usable: vehicle.state === 'eligible' || vehicle.id === current?.[kind]?.id,
      }));
  const drivers = candidates.drivers.map((driver) => ({
    value: driver.affiliationId,
    label: `${driver.name}${why(driver.state)}`,
    usable: driver.state === 'eligible' || driver.affiliationId === current?.driver?.affiliationId,
  }));
  const choice = (
    name: string,
    label: string,
    options: { value: string; label: string; usable: boolean }[],
    selected: string,
    hint?: string,
  ) => (
    <Field id={name} label={label} hint={hint}>
      <select
        id={name}
        name={name}
        defaultValue={selected}
        aria-describedby={hint ? `${name}-hint` : undefined}
      >
        <option value="">{a.noneOption}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={!option.usable}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <form action={assignResourcesAction} id="assign-form">
      {hidden}
      <input type="hidden" name="version" value={version} />
      <p>{confirmed ? a.assignLeadConfirmed : a.assignLead}</p>
      {choice('truckId', a.roles.truck, vehicles('truck'), current?.truck?.id ?? '')}
      {choice(
        'trailerId',
        a.roles.trailer,
        vehicles('trailer'),
        current?.trailer?.id ?? '',
        a.trailerHint,
      )}
      {choice('driverId', a.roles.driver, drivers, current?.driver?.affiliationId ?? '')}
      <button className="button button-primary" type="submit" id="save-assignment">
        {a.save}
      </button>
    </form>
  );
}

/** The carrier, once dispatched: a milestone on the driver's behalf, and the estimate. */
function CarrierTripForms({
  t,
  trip,
  hidden,
}: {
  t: Messages['trip'];
  trip: NonNullable<BookingDetail['booking']['trip']>;
  hidden: React.ReactNode;
}) {
  const now = utcMinute(new Date());
  const arrived = trip.milestones.some((item) => item.milestone === 'arrived_at_delivery');
  return (
    <>
      {trip.next && !trip.hold ? (
        <form action={recordMilestoneOnBehalfAction} id="on-behalf-form" className="form card">
          {hidden}
          <h3>{t.onBehalfTitle}</h3>
          <p className="field-hint">{t.onBehalfLead}</p>
          <input type="hidden" name="version" value={trip.version} />
          <input type="hidden" name="milestone" value={trip.next} />
          <p id="on-behalf-next">
            {t.next}: <strong>{t.milestones[trip.next]}</strong>
          </p>
          <Field id="on-behalf-at" label={t.statedAt}>
            <input
              id="on-behalf-at"
              name="statedAt"
              type="datetime-local"
              defaultValue={now}
              max={now}
              required
            />
          </Field>
          <Field id="on-behalf-reason" label={t.reason}>
            <select id="on-behalf-reason" name="reason" required>
              {(['no_phone', 'no_signal', 'driver_unable', 'correction', 'other'] as const).map(
                (code) => (
                  <option key={code} value={code}>
                    {t.reasons[code]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field id="on-behalf-note" label={t.note}>
            <textarea id="on-behalf-note" name="note" maxLength={500} />
          </Field>
          <button className="button" type="submit" id="record-on-behalf">
            {t.recordOnBehalf}
          </button>
        </form>
      ) : trip.next ? null : (
        <p id="trip-complete">{t.complete}</p>
      )}
      {arrived ? null : (
        <form action={stateEstimateAction} id="estimate-form" className="form card">
          {hidden}
          <Field id="estimate-at" label={t.estimateLabel}>
            <input id="estimate-at" name="arrivalAt" type="datetime-local" min={now} required />
          </Field>
          <button className="button" type="submit" id="state-estimate">
            {t.stateEstimate}
          </button>
        </form>
      )}
    </>
  );
}
