import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../components/draft-keeper.tsx';
import {
  DocumentFields,
  DocumentList,
  EligibilityTag,
  fleetProblems,
} from '../../../components/fleet-view.tsx';
import { ErrorSummary } from '../../../components/form.tsx';
import { isLocale } from '../../../i18n/config.ts';
import { getMessages } from '../../../i18n/messages.ts';
import { api, type Country, type DriverSide } from '../../../server/api.ts';
import {
  leaveAffiliationAction,
  respondInvitationAction,
  submitDriverDocumentAction,
} from '../../../server/fleet-actions.ts';
import { requirePerson } from '../../../server/session.ts';

// The driver's own page, made for a phone: invitations sent to their number, the carrier they
// drive for, and their documents. Nothing here assigns work.

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;

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
  const [reply, countries] = await Promise.all([
    api<{ driver: DriverSide }>('GET', '/me/driver', { token: person.token }),
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
  const done = one('fDone');
  const confirmation = done ? (t.done as Record<string, string>)[done] : undefined;
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
