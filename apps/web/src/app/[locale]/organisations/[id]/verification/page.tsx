import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../../components/draft-keeper.tsx';
import { DeclarationField, EvidenceFields } from '../../../../../components/evidence-fields.tsx';
import { describedBy, ErrorSummary, Field, type Problem } from '../../../../../components/form.tsx';
import { Ltr } from '../../../../../components/ltr.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { fill } from '../../../../../i18n/format.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import {
  api,
  type Country,
  type VerificationApplication,
  type VerificationOverview,
} from '../../../../../server/api.ts';
import { requirePerson } from '../../../../../server/session.ts';
import {
  submitVerificationAction,
  withdrawVerificationAction,
} from '../../../../../server/verification-actions.ts';

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export default async function VerificationPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.verify;
  const search = await searchParams;
  const error = typeof search.error === 'string' ? search.error : '';
  const done = typeof search.done === 'string' ? search.done : undefined;
  const retryKey =
    typeof search.retry === 'string' && RETRY_KEY.test(search.retry) ? search.retry : randomUUID();

  const found = await requirePerson(locale);
  const [one, countries] =
    found.state === 'signed-in'
      ? await Promise.all([
          api<{ verification: VerificationOverview }>('GET', `/organisations/${id}/verification`, {
            token: found.token,
          }),
          api<{ countries: Country[] }>('GET', '/registration/countries', { token: found.token }),
        ])
      : [undefined, undefined];
  if (one && !one.ok && one.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (one && !one.ok && one.status === 404) notFound();
  if (!one?.ok) {
    return (
      <div className="page page-narrow" data-state="verification-unavailable">
        <h1>{m.org.unavailableTitle}</h1>
        <ErrorSummary
          title={m.auth.errors.summary}
          problems={[{ message: t.errors.unavailable }]}
        />
        <div className="form-inline">
          <a
            className="button"
            id="retry-verification"
            href={`/${locale}/organisations/${id}/verification`}
          >
            {m.org.retry}
          </a>
          <a className="button" href={`/${locale}/organisations`}>
            {m.org.backToList}
          </a>
        </div>
      </div>
    );
  }
  const v = one.data.verification;
  const open = countries?.ok ? countries.data.countries : [];
  const countryName = (code: string): string =>
    open.find((country) => country.code === code)?.name[locale] ?? code;
  const allRequirements = [
    ...v.requirements,
    ...v.requirementsFor.ship,
    ...v.requirementsFor.carry_as_company,
  ];
  const requirementName = (type: string): string =>
    allRequirements.find((item) => item.documentType === type)?.name[locale] ?? type;

  // Problems arrive as "field:code" pairs, or as one page-level code.
  const problems: Problem[] = [];
  const invalid = new Map<string, string>();
  const note = (field: string | undefined, message: string): void => {
    if (field) invalid.set(field, message);
    if (!problems.some((problem) => problem.message === message))
      problems.push(field ? { field, message } : { message });
  };
  for (const part of error.split(',').filter(Boolean)) {
    const [field = '', code = ''] = part.split(':');
    const entry =
      /^evidence\.([a-z][a-z0-9_]*)\.(documentNumber|issuingCountry|issuedOn|expiresOn)$/.exec(
        field,
      );
    if (entry) {
      const [, type = '', input = ''] = entry;
      const key =
        input === 'documentNumber' || input === 'issuingCountry'
          ? input
          : code === 'date_in_future' || code === 'date_order'
            ? code
            : 'date_invalid';
      note(`ev-${type}-${input}`, fill(t.errors[key], { name: requirementName(type) }));
    } else if (field === 'declaration') note('declaration', t.errors.declaration);
    else if (field === 'evidence') note(undefined, t.errors.evidence);
    else if (field === 'proposed.legalName')
      note(
        'proposedLegalName',
        code === 'nothing_changed' ? t.errors.nothing_changed : t.errors.proposedLegalName,
      );
    else if (field === 'proposed.registrationNumber')
      note('proposedRegistrationNumber', t.errors.proposedRegistrationNumber);
    else if (field === 'proposed.countryCode')
      note('proposedCountryCode', t.errors.proposedCountryCode);
    else if (part in t.errors) note(undefined, t.errors[part as keyof typeof t.errors]);
    else note(undefined, m.auth.errors.unavailable);
  }

  const latest = v.applications[0];
  const underReview =
    latest && (latest.status === 'submitted' || latest.status === 'claim_review')
      ? latest
      : undefined;
  const amendmentOpen = underReview?.kind === 'amendment';
  const status = v.organisation.status as keyof typeof t.status;
  const statusText = t.status[status] ?? v.organisation.status;
  const nextText = amendmentOpen
    ? t.next.amendment
    : underReview?.status === 'claim_review'
      ? t.next.claim_review
      : (t.next[status as keyof typeof t.next] ?? '');
  // The last decision that explains the present state.
  const decided = v.applications.find((item) => item.decidedAt !== null);
  const showDecision =
    decided &&
    !underReview &&
    (status === 'changes_requested' || status === 'rejected') &&
    decided.id === latest?.id;
  const reason = (code: string | null): string =>
    code ? (t.reasons[code as keyof typeof t.reasons] ?? code) : '';
  const confirmation =
    done === 'submitted' ? t.doneSubmitted : done === 'withdrawn' ? t.doneWithdrawn : undefined;
  const formId = `verification-form-${v.organisation.id}`;
  const amendment = v.maySubmit === 'amendment';
  const closed = v.requirements.length === 0;
  const has = (field: string): boolean => invalid.has(field);

  const evidenceList = (application: VerificationApplication) => (
    <ul className="evidence">
      {application.evidence.map((entry) => (
        <li key={entry.documentType}>
          <bdi>{requirementName(entry.documentType)}</bdi>: <Ltr>{entry.documentNumber}</Ltr>,{' '}
          <bdi>{countryName(entry.issuingCountry)}</bdi>
          {entry.issuedOn ? (
            <>
              , {t.issuedShort}: <Ltr>{entry.issuedOn}</Ltr>
            </>
          ) : null}
          {entry.expiresOn ? (
            <>
              , {t.expiresShort}: <Ltr>{entry.expiresOn}</Ltr>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="page page-narrow">
      <div className="form-inline">
        <a className="button" id="back-to-organisation" href={`/${locale}/organisations/${id}`}>
          {t.back}
        </a>
      </div>
      <h1>
        {t.title}: <bdi>{v.organisation.legalName}</bdi>
      </h1>
      <p>{t.lead}</p>
      <p className="notice notice-warning" role="note" id="demonstration-notice">
        {t.demoNotice}
      </p>
      <ErrorSummary title={m.auth.errors.summary} problems={problems} />
      {confirmation && problems.length === 0 ? (
        <p className="notice notice-success" role="status" id="verification-confirmation">
          {confirmation}
        </p>
      ) : null}

      <section className="section" aria-labelledby="status-title">
        <h2 id="status-title">{t.statusTitle}</h2>
        <div className="notice" role="note" id="verification-status" data-status={status}>
          <h3>{statusText}</h3>
          {nextText ? <p>{nextText}</p> : null}
          {showDecision ? (
            <dl className="facts" id="decision">
              <div>
                <dt>{t.reasonLabel}</dt>
                <dd>{reason(decided.decisionReason)}</dd>
              </div>
              {decided.decisionNote ? (
                <div>
                  <dt>{t.noteLabel}</dt>
                  <dd>
                    <bdi>{decided.decisionNote}</bdi>
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {status === 'verification_withdrawn' && v.capability?.revokeReason ? (
            <dl className="facts" id="decision">
              <div>
                <dt>{t.reasonLabel}</dt>
                <dd>{reason(v.capability.revokeReason)}</dd>
              </div>
              {v.capability.revokeNote ? (
                <div>
                  <dt>{t.noteLabel}</dt>
                  <dd>
                    <bdi>{v.capability.revokeNote}</bdi>
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <p id="publication-check">
            {t.publishLabel}: {v.mayPublish ? t.publishYes : t.publishNo}
          </p>
        </div>
        {underReview ? (
          <form className="form-inline" id="withdraw-form" action={withdrawVerificationAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organisationId" value={v.organisation.id} />
            <input type="hidden" name="applicationId" value={underReview.id} />
            <input type="hidden" name="retryKey" value={retryKey} />
            <button className="button" type="submit" id="withdraw-application">
              {t.withdraw}
            </button>
          </form>
        ) : null}
      </section>

      {v.maySubmit && closed ? (
        <p className="notice" role="note" id="verification-closed">
          {t.closed}
        </p>
      ) : null}
      {v.maySubmit && !closed ? (
        <section className="section" aria-labelledby="submit-title">
          <h2 id="submit-title">{amendment ? t.amendTitle : t.submitTitle}</h2>
          <form className="form card" id={formId} action={submitVerificationAction} noValidate>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organisationId" value={v.organisation.id} />
            <input type="hidden" name="version" value={v.organisation.version} />
            <input type="hidden" name="retryKey" value={retryKey} />
            <input type="hidden" name="kind" value={amendment ? 'amendment' : 'initial'} />
            {amendment ? (
              <fieldset className="fieldset">
                <legend>{t.identityTitle}</legend>
                <Field
                  id="proposedLegalName"
                  label={m.org.legalName}
                  hint={m.org.legalNameHint}
                  error={invalid.get('proposedLegalName')}
                >
                  <input
                    id="proposedLegalName"
                    name="proposedLegalName"
                    type="text"
                    dir="auto"
                    maxLength={200}
                    required
                    data-draft
                    defaultValue={v.organisation.legalName}
                    aria-invalid={has('proposedLegalName') ? true : undefined}
                    aria-describedby={describedBy(
                      'proposedLegalName',
                      true,
                      has('proposedLegalName'),
                    )}
                  />
                </Field>
                <Field
                  id="proposedCountryCode"
                  label={m.org.country}
                  error={invalid.get('proposedCountryCode')}
                >
                  <select
                    id="proposedCountryCode"
                    name="proposedCountryCode"
                    required
                    data-draft
                    defaultValue={v.organisation.countryCode}
                    aria-invalid={has('proposedCountryCode') ? true : undefined}
                    aria-describedby={describedBy(
                      'proposedCountryCode',
                      false,
                      has('proposedCountryCode'),
                    )}
                  >
                    {open.map((country) => (
                      <option key={country.code} value={country.code}>
                        {country.name[locale]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  id="proposedRegistrationNumber"
                  label={m.org.registrationNumber}
                  hint={m.org.registrationNumberHint}
                  error={invalid.get('proposedRegistrationNumber')}
                >
                  <input
                    id="proposedRegistrationNumber"
                    name="proposedRegistrationNumber"
                    type="text"
                    dir="ltr"
                    maxLength={60}
                    required
                    data-draft
                    defaultValue={v.organisation.registrationNumber}
                    aria-invalid={has('proposedRegistrationNumber') ? true : undefined}
                    aria-describedby={describedBy(
                      'proposedRegistrationNumber',
                      true,
                      has('proposedRegistrationNumber'),
                    )}
                  />
                </Field>
              </fieldset>
            ) : (
              <dl className="facts" id="submission-identity">
                <div>
                  <dt>{m.org.legalName}</dt>
                  <dd>
                    <bdi>{v.organisation.legalName}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{m.org.country}</dt>
                  <dd>
                    <bdi>{countryName(v.organisation.countryCode)}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{m.org.registrationNumber}</dt>
                  <dd>
                    <Ltr>{v.organisation.registrationNumber}</Ltr>
                  </dd>
                </div>
              </dl>
            )}
            <h3>{t.evidenceTitle}</h3>
            <p>{t.evidenceLead}</p>
            <EvidenceFields
              locale={locale}
              t={t}
              requirements={v.requirements}
              previous={latest?.evidence ?? []}
              countries={open}
              defaultCountry={v.organisation.countryCode}
              invalid={invalid}
            />
            <DeclarationField t={t} invalid={invalid} />
            <button className="button button-primary" type="submit" id="submit-verification">
              {amendment ? t.submitAmend : t.submit}
            </button>
          </form>
          <DraftKeeper
            key={`${v.organisation.version}-${Boolean(confirmation)}`}
            formId={formId}
            scope={`v${v.organisation.version}`}
            overwrite
            clear={Boolean(confirmation)}
          />
        </section>
      ) : null}

      {v.mayApply.ship === 'capability' ? (
        <section className="section" aria-labelledby="shipper-title">
          <h2 id="shipper-title">{t.shipperApplyTitle}</h2>
          <p>{t.shipperApplyLead}</p>
          <form
            className="form card"
            id={`shipper-form-${v.organisation.id}`}
            action={submitVerificationAction}
            noValidate
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organisationId" value={v.organisation.id} />
            <input type="hidden" name="version" value={v.organisation.version} />
            <input type="hidden" name="retryKey" value={retryKey} />
            <input type="hidden" name="kind" value="capability" />
            <input type="hidden" name="capability" value="ship" />
            <h3>{t.evidenceTitle}</h3>
            <p>{t.evidenceLead}</p>
            <EvidenceFields
              locale={locale}
              t={t}
              requirements={v.requirementsFor.ship}
              previous={v.applications.find((item) => item.capability === 'ship')?.evidence ?? []}
              countries={open}
              defaultCountry={v.organisation.countryCode}
              invalid={invalid}
            />
            <DeclarationField t={t} invalid={invalid} />
            <button className="button button-primary" type="submit" id="submit-shipper">
              {t.submit}
            </button>
          </form>
        </section>
      ) : null}

      <p>
        <a className="button" id="open-carrier" href={`/${locale}/organisations/${id}/carrier`}>
          {t.carrierLink}
        </a>
      </p>

      <section className="section" aria-labelledby="versions-title">
        <h2 id="versions-title">{t.versionsTitle}</h2>
        {v.applications.length === 0 ? <p id="no-versions">{t.noVersions}</p> : null}
        <ul className="organisation-list" id="versions">
          {v.applications.map((application) => (
            <li
              className="card organisation"
              key={application.id}
              data-version={application.versionNo}
            >
              <h3>
                {fill(t.version, { n: application.versionNo })}:{' '}
                {application.kind === 'amendment'
                  ? t.kindAmendment
                  : application.capability === 'carry_as_company'
                    ? t.kindCarrier
                    : application.kind === 'capability'
                      ? t.kindShipper
                      : t.kindInitial}
              </h3>
              {application.revalidates ? (
                <p className="field-hint" data-revalidates={application.revalidates.join(' ')}>
                  {t.revalidates}:{' '}
                  {application.revalidates.map((cap) => t.capabilityName[cap]).join(', ')}
                </p>
              ) : null}
              <p className="chip">{t.status[application.status]}</p>
              <dl className="facts">
                <div>
                  <dt>{m.org.legalName}</dt>
                  <dd>
                    <bdi>{application.legalName}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{m.org.country}</dt>
                  <dd>
                    <bdi>{countryName(application.countryCode)}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{m.org.registrationNumber}</dt>
                  <dd>
                    <Ltr>{application.registrationNumber}</Ltr>
                  </dd>
                </div>
                <div>
                  <dt>{t.submittedAt}</dt>
                  <dd>
                    <Ltr>{when(application.submittedAt)}</Ltr>
                  </dd>
                </div>
                {application.decidedAt ? (
                  <div>
                    <dt>{t.decidedAt}</dt>
                    <dd>
                      <Ltr>{when(application.decidedAt)}</Ltr>
                    </dd>
                  </div>
                ) : null}
                {application.decisionReason ? (
                  <div>
                    <dt>{t.reasonLabel}</dt>
                    <dd>{reason(application.decisionReason)}</dd>
                  </div>
                ) : null}
                {application.decisionNote ? (
                  <div>
                    <dt>{t.noteLabel}</dt>
                    <dd>
                      <bdi>{application.decisionNote}</bdi>
                    </dd>
                  </div>
                ) : null}
              </dl>
              <p className="field-hint">{t.evidenceDeclared}</p>
              {evidenceList(application)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
