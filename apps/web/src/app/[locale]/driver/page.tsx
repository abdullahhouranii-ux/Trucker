import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { InstantText } from '../../../components/booking-view.tsx';
import { DraftKeeper } from '../../../components/draft-keeper.tsx';
import {
  DocumentFields,
  DocumentList,
  EligibilityTag,
  fleetProblems,
} from '../../../components/fleet-view.tsx';
import { ErrorSummary, Field } from '../../../components/form.tsx';
import {
  DeliveryFacts,
  DeliveryForm,
  ReportProblem,
  TripFacts,
  utcMinute,
} from '../../../components/trip-view.tsx';
import { isLocale } from '../../../i18n/config.ts';
import { getMessages } from '../../../i18n/messages.ts';
import { api, type Country, type DriverAssignment, type DriverSide } from '../../../server/api.ts';
import {
  acknowledgeAssignmentAction,
  driverDeliveryAction,
  driverEstimateAction,
  driverReportProblemAction,
  driverMilestoneAction,
} from '../../../server/assignment-actions.ts';
import {
  leaveAffiliationAction,
  respondInvitationAction,
  submitDriverDocumentAction,
} from '../../../server/fleet-actions.ts';
import { requirePerson } from '../../../server/session.ts';

// The driver's own page, made for a phone: invitations sent to their number, the carrier they
// drive for, their documents, and the assignments their carrier has given them, which they
// acknowledge here. A driver is shown areas and times, never a price; from dispatch (slice 17a)
// also the addresses, access notes and the shipper's name, and records the trip's milestones.

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DriverPage({ params, searchParams }: Props) {
  const { locale } = await params;
  const search = await searchParams;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const t = m.fleet;
  const one = (name: string): string => {
    const value = search[name];
    return typeof value === 'string' ? value : '';
  };
  const keyFor = (operation: string): string => {
    const value = one(`${operation}Retry`);
    return RETRY_KEY.test(value) ? value : randomUUID();
  };
  const person = await requirePerson(locale);
  const [reply, assigned, countries] = await Promise.all([
    api<{ driver: DriverSide }>('GET', '/me/driver', { token: person.token }),
    api<{ assignments: DriverAssignment[] }>('GET', '/me/driver/assignments', {
      token: person.token,
    }),
    api<{ countries: Country[] }>('GET', '/registration/countries', { token: person.token }),
  ]);
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-account" href={`/${locale}/account`}>
        {t.backToAccount}
      </a>
    </div>
  );
  if (!reply.ok)
    return (
      <div className="page page-narrow" data-state="driver-unavailable">
        {back}
        <h1>{t.driverTitle}</h1>
        <ErrorSummary
          title={m.auth.errors.summary}
          problems={[{ message: t.errors.unavailable }]}
        />
      </div>
    );
  const side = reply.data.driver;
  const { errors, summary } = fleetProblems(t, one('fError'));
  const a = m.asg;
  const assignmentError = one('aError');
  if (assignmentError)
    summary.push({
      message: (a.errors as Record<string, string>)[assignmentError] ?? a.errors.invalid,
    });
  const done = one('fDone');
  const confirmation = done
    ? (t.done as Record<string, string>)[done]
    : (a.done as Record<string, string>)[one('aDone')];
  const types = (side.registers.documentTypes ?? []).filter((type) => type.subject === 'driver');
  const nameOf = (carrier: { legalName: string; tradingName: string | null }): string =>
    carrier.tradingName ?? carrier.legalName;
  const hidden = (operation: string) => (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="retryKey" value={keyFor(operation)} />
    </>
  );
  return (
    <div className="page page-narrow" data-state="driver">
      {back}
      <h1>{t.driverTitle}</h1>
      <p>{t.driverLead}</p>
      <ErrorSummary title={m.auth.errors.summary} problems={summary} />
      {confirmation && summary.length === 0 ? (
        <p className="notice notice-success" role="status" id="fleet-confirmation">
          {confirmation}
        </p>
      ) : null}

      <section className="section" aria-labelledby="carrier-title">
        <h2 id="carrier-title">{t.carrierTitle}</h2>
        {side.affiliation ? (
          <div className="card" id="driver-affiliation">
            <p>
              {t.worksWith.split('{carrier}')[0]}
              <bdi>{nameOf(side.affiliation.carrier)}</bdi>
              {t.worksWith.split('{carrier}')[1]}
            </p>
            <EligibilityTag t={t} value={side.affiliation.eligibility} id="driver-eligibility" />
            <form className="form-inline" action={leaveAffiliationAction}>
              {hidden('leave')}
              <input type="hidden" name="affiliationId" value={side.affiliation.id} />
              <input type="hidden" name="version" value={side.affiliation.version} />
              <button className="button" type="submit" id="leave-carrier">
                {t.leave}
              </button>
            </form>
          </div>
        ) : (
          <p id="no-carrier">{t.noCarrier}</p>
        )}
      </section>

      <section className="section" aria-labelledby="assignments-title" id="assignments">
        <h2 id="assignments-title">{a.driver.title}</h2>
        {!assigned.ok ? (
          <p id="assignments-unavailable">{a.errors.unavailable}</p>
        ) : assigned.data.assignments.length === 0 ? (
          <p id="no-assignments">{a.driver.none}</p>
        ) : (
          <ol className="organisation-list" id="assignment-list">
            {assigned.data.assignments.map((item) => (
              <li className="card" key={item.bookingId} data-assignment={item.bookingId}>
                <dl className="facts">
                  <div>
                    <dt>{a.driver.carrier}</dt>
                    <dd>
                      <bdi>{nameOf(item.carrier)}</bdi>
                    </dd>
                  </div>
                  <div>
                    <dt>{a.driver.from}</dt>
                    <dd>
                      <bdi>{item.pickup.area}</bdi> ({item.pickup.countryCode})
                    </dd>
                  </div>
                  <div>
                    <dt>{a.driver.pickupWindow}</dt>
                    <dd>
                      <InstantText at={item.pickup.from.at} /> –{' '}
                      <InstantText at={item.pickup.until.at} />
                    </dd>
                  </div>
                  <div>
                    <dt>{a.driver.to}</dt>
                    <dd>
                      <bdi>{item.delivery.area}</bdi> ({item.delivery.countryCode})
                    </dd>
                  </div>
                  <div>
                    <dt>{a.driver.deliveryWindow}</dt>
                    <dd>
                      <InstantText at={item.delivery.from.at} /> –{' '}
                      <InstantText at={item.delivery.until.at} />
                    </dd>
                  </div>
                  <div>
                    <dt>{a.driver.cargo}</dt>
                    <dd>
                      <bdi>{item.cargo.description}</bdi>
                    </dd>
                  </div>
                  {(['truck', 'trailer'] as const).map((kind) =>
                    item[kind] ? (
                      <div key={kind}>
                        <dt>{a.roles[kind]}</dt>
                        <dd>
                          <bdi dir="ltr">
                            {item[kind]!.registrationCountry} {item[kind]!.registrationNumber}
                          </bdi>
                        </dd>
                      </div>
                    ) : null,
                  )}
                </dl>
                {item.trip ? (
                  <div data-trip={item.trip.id}>
                    {item.shipper ? (
                      <p data-shipper="yes">
                        {m.trip.shipper}: <bdi>{nameOf(item.shipper)}</bdi>
                      </p>
                    ) : null}
                    {item.site ? (
                      <dl className="facts">
                        {(['pickup', 'delivery'] as const).map((place) => (
                          <div key={place}>
                            <dt>{a[place]}</dt>
                            <dd data-site={place}>
                              <bdi>{item.site![place].address}</bdi>
                              <br />
                              {a.accessNotes}:{' '}
                              <bdi>{item.site![place].accessNotes ?? a.noAccessNotes}</bdi>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    <TripFacts t={m.trip} trip={item.trip} />
                    {item.trip.delivery ? (
                      <DeliveryFacts
                        d={m.delivery}
                        t={m.trip}
                        delivery={item.trip.delivery}
                        roles={a.roles}
                      />
                    ) : null}
                    {item.trip.milestones.some(
                      (entry) => entry.milestone === 'arrived_at_delivery',
                    ) &&
                    !item.trip.delivery?.outcome &&
                    !item.trip.hold ? (
                      <DeliveryForm
                        d={m.delivery}
                        t={m.trip}
                        id={`delivery-${item.bookingId}`}
                        action={driverDeliveryAction}
                        hidden={
                          <>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="bookingId" value={item.bookingId} />
                          </>
                        }
                        onBehalf={false}
                      />
                    ) : null}
                    {item.trip.next && !item.trip.hold ? (
                      <form className="form-inline" action={driverMilestoneAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="bookingId" value={item.bookingId} />
                        <input type="hidden" name="version" value={item.trip.version} />
                        <input type="hidden" name="milestone" value={item.trip.next} />
                        <button
                          className="button button-primary"
                          type="submit"
                          data-record-milestone={item.trip.next}
                        >
                          {m.trip.record}: {m.trip.milestones[item.trip.next]}
                        </button>
                      </form>
                    ) : item.trip.next ? null : (
                      <p data-trip-complete="yes">{m.trip.complete}</p>
                    )}
                    {item.trip.milestones.some(
                      (entry) => entry.milestone === 'arrived_at_delivery',
                    ) ? null : (
                      <form className="form card" action={driverEstimateAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="bookingId" value={item.bookingId} />
                        <Field id={`estimate-${item.bookingId}`} label={m.trip.estimateLabel}>
                          <input
                            id={`estimate-${item.bookingId}`}
                            name="arrivalAt"
                            type="datetime-local"
                            min={utcMinute(new Date())}
                            required
                          />
                        </Field>
                        <button className="button" type="submit" data-state-estimate="yes">
                          {m.trip.stateEstimate}
                        </button>
                      </form>
                    )}
                    <ReportProblem
                      t={m.trip}
                      id={`report-${item.bookingId}`}
                      action={driverReportProblemAction}
                      hidden={
                        <>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="bookingId" value={item.bookingId} />
                        </>
                      }
                      retryKey={UUID_KEY.test(one('aKey')) ? one('aKey') : randomUUID()}
                    />
                  </div>
                ) : (
                  <p className="field-hint">{a.driver.note}</p>
                )}
                {item.trip ? null : item.acknowledgedAt ? (
                  <p data-acknowledged="yes">{a.driver.acknowledged}</p>
                ) : (
                  <form className="form-inline" action={acknowledgeAssignmentAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="bookingId" value={item.bookingId} />
                    <input type="hidden" name="version" value={item.version} />
                    <button
                      className="button button-primary"
                      type="submit"
                      data-acknowledge={item.bookingId}
                    >
                      {a.driver.acknowledge}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="section" aria-labelledby="invitations-title">
        <h2 id="invitations-title">{t.invitationsTitle}</h2>
        {side.invitations.length === 0 ? (
          <p id="no-invitations">{t.noInvitations}</p>
        ) : (
          <ol className="organisation-list" id="invitation-list">
            {side.invitations.map((invitation) => (
              <li className="card organisation" key={invitation.id} data-invitation={invitation.id}>
                <p>
                  {t.invitationFrom.split('{carrier}')[0]}
                  <bdi>{nameOf(invitation.carrier)}</bdi>
                  {t.invitationFrom.split('{carrier}')[1]}
                </p>
                <form className="form-inline" action={respondInvitationAction}>
                  {hidden('respond')}
                  <input type="hidden" name="affiliationId" value={invitation.id} />
                  <input type="hidden" name="version" value={invitation.version} />
                  <button
                    className="button button-primary"
                    type="submit"
                    name="decision"
                    value="accept"
                    data-accept={invitation.id}
                  >
                    {t.accept}
                  </button>
                  <button
                    className="button"
                    type="submit"
                    name="decision"
                    value="decline"
                    data-decline={invitation.id}
                  >
                    {t.decline}
                  </button>
                </form>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="section" aria-labelledby="documents-title">
        <h2 id="documents-title">{t.myDocumentsTitle}</h2>
        <p className="field-hint" id="my-documents-note">
          {t.myDocumentsNote}
        </p>
        <DocumentList
          t={t}
          locale={locale}
          documents={side.documents}
          types={types}
          id="document-list"
        />
        {side.affiliation && side.open ? (
          <>
            <h3 id="document-form-title">{t.addDocumentTitle}</h3>
            <p className="field-hint" id="fleet-fictional">
              {t.fictional}
            </p>
            <form className="form card" id="document-form" action={submitDriverDocumentAction}>
              {hidden('document')}
              <DocumentFields
                t={t}
                locale={locale}
                types={types}
                countries={countries.ok ? countries.data.countries : []}
                licenceClasses={side.registers.licenceClasses ?? []}
                errors={errors}
                submit={
                  <button className="button button-primary" type="submit" id="submit-document">
                    {t.submitDocument}
                  </button>
                }
              />
            </form>
            <DraftKeeper formId="document-form" scope="driver-document" clear={done !== ''} />
          </>
        ) : side.affiliation ? null : (
          <p id="need-carrier">{t.needCarrier}</p>
        )}
      </section>
    </div>
  );
}
