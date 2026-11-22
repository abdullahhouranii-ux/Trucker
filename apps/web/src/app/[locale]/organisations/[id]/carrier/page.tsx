import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../../components/draft-keeper.tsx';
import { DeclarationField, EvidenceFields } from '../../../../../components/evidence-fields.tsx';
import { ErrorSummary, type Problem } from '../../../../../components/form.tsx';
import { Ltr } from '../../../../../components/ltr.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { fill } from '../../../../../i18n/format.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import {
  api,
  type Catalogues,
  type Country,
  type VerificationOverview,
} from '../../../../../server/api.ts';
import { requirePerson } from '../../../../../server/session.ts';
import {
  submitVerificationAction,
  withdrawVerificationAction,
} from '../../../../../server/verification-actions.ts';

// The carrier capability of one organisation: its state, the service it declared, and the
// application to become a carrier or to change the declared service. The declared service is
// matching criteria for discovery only: not verified vehicles, availability or permission to
// accept work (CB-3). Every decision is made by staff.

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export default async function CarrierPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.carrier;
  const tv = m.verify;
  const search = await searchParams;
  const error = typeof search.error === 'string' ? search.error : '';
  const done = typeof search.done === 'string' ? search.done : undefined;
  const retryKey =
    typeof search.retry === 'string' && RETRY_KEY.test(search.retry) ? search.retry : randomUUID();

  const found = await requirePerson(locale);
  const [one, countries, catalogues] =
    found.state === 'signed-in'
      ? await Promise.all([
          api<{ verification: VerificationOverview }>('GET', `/organisations/${id}/verification`, {
            token: found.token,
          }),
          api<{ countries: Country[] }>('GET', '/registration/countries', { token: found.token }),
          api<Catalogues>('GET', `/organisations/${id}/shipment-catalogues`, {
            token: found.token,
          }),
        ])
      : [undefined, undefined, undefined];
  if (one && !one.ok && one.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (one && !one.ok && one.status === 404) notFound();
  if (!one?.ok) {
    return (
      <div className="page page-narrow" data-state="carrier-unavailable">
        <h1>{m.org.unavailableTitle}</h1>
        <ErrorSummary
          title={m.auth.errors.summary}
          problems={[{ message: tv.errors.unavailable }]}
        />
        <div className="form-inline">
          <a className="button" id="retry-carrier" href={`/${locale}/organisations/${id}/carrier`}>
            {m.org.retry}
          </a>
          <a className="button" href={`/${locale}/organisations/${id}`}>
            {t.back}
          </a>
        </div>
      </div>
    );
  }
  const v = one.data.verification;
  const open = countries?.ok ? countries.data.countries : [];
  const equipment = catalogues?.ok ? catalogues.data.equipmentTypes : [];
  const countryName = (code: string): string =>
    open.find((country) => country.code === code)?.name[locale] ?? code;
  const equipmentName = (code: string): string =>
    equipment.find((entry) => entry.code === code)?.name[locale] ?? code;
  const requirements = v.requirementsFor.carry_as_company;
  const requirementName = (type: string): string =>
    requirements.find((item) => item.documentType === type)?.name[locale] ?? type;

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
      note(`ev-${type}-${input}`, fill(tv.errors[key], { name: requirementName(type) }));
    } else if (field === 'service.countries')
      note(
        'service-countries',
        code === 'nothing_changed' ? t.errors.nothing_changed : t.errors.countries,
      );
    else if (field === 'service.equipmentTypes') note('service-equipment', t.errors.equipment);
    else if (field === 'declaration') note('declaration', tv.errors.declaration);
    else if (field === 'evidence') note(undefined, tv.errors.evidence);
    else if (part in tv.errors) note(undefined, tv.errors[part as keyof typeof tv.errors]);
    else note(undefined, m.auth.errors.unavailable);
  }

  const carrierApps = v.applications.filter(
    (application) =>
      application.capability === 'carry_as_company' ||
      (application.revalidates ?? []).includes('carry_as_company'),
  );
  const latest = carrierApps[0];
  const anyOpen = v.applications.find(
    (item) => item.status === 'submitted' || item.status === 'claim_review',
  );
  const underReview =
    latest && (latest.status === 'submitted' || latest.status === 'claim_review')
      ? latest
      : undefined;
  const grant = v.capabilities.find((item) => item.capability === 'carry_as_company');
  const state = underReview
    ? 'under_review'
    : grant?.status === 'granted'
      ? grant.effective
        ? 'granted'
        : 'not_effective'
      : grant?.status === 'revoked'
        ? 'revoked'
        : 'none';
  const applying = v.mayApply.carry_as_company;
  const service = grant?.status === 'granted' ? grant.service : null;
  const chosenCountries = new Set(service?.countries ?? latest?.service?.countries ?? []);
  const chosenEquipment = new Set(service?.equipmentTypes ?? latest?.service?.equipmentTypes ?? []);
  const confirmation =
    done === 'submitted' ? tv.doneSubmitted : done === 'withdrawn' ? tv.doneWithdrawn : undefined;
  const formId = `carrier-form-${v.organisation.id}`;

  const serviceFacts = (
    list: { countries: string[]; equipmentTypes: string[] },
    idBase: string,
  ) => (
    <dl className="facts" id={idBase}>
      <div>
        <dt>{t.countries}</dt>
        <dd>
          <bdi>{list.countries.map(countryName).join(', ')}</bdi>
        </dd>
      </div>
      <div>
        <dt>{t.equipment}</dt>
        <dd>
          <bdi>{list.equipmentTypes.map(equipmentName).join(', ')}</bdi>
        </dd>
      </div>
    </dl>
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
        {tv.demoNotice}
      </p>
      <p className="notice" role="note" id="matching-note">
        {t.matchingNote}
      </p>
      <ErrorSummary title={m.auth.errors.summary} problems={problems} />
      {confirmation && problems.length === 0 ? (
        <p className="notice notice-success" role="status" id="carrier-confirmation">
          {confirmation}
        </p>
      ) : null}

      <section className="section" aria-labelledby="carrier-status-title">
        <h2 id="carrier-status-title">{t.statusTitle}</h2>
        <div className="notice" role="note" id="carrier-status" data-state={state}>
          <h3>{t.state[state]}</h3>
          {service ? (
            <>
              <h4>{t.serviceTitle}</h4>
              {serviceFacts(service, 'declared-service')}
            </>
          ) : null}
          {grant?.status === 'revoked' && grant.revokeReason ? (
            <p id="carrier-revoked-reason">
              {tv.reasonLabel}:{' '}
              {tv.reasons[grant.revokeReason as keyof typeof tv.reasons] ?? grant.revokeReason}
            </p>
          ) : null}
        </div>
        {v.mayDiscover ? (
          <p>
            <a
              className="button button-primary"
              id="open-discovery"
              href={`/${locale}/organisations/${id}/discover`}
            >
              {t.discoverLink}
            </a>{' '}
            <a className="button" id="open-fleet" href={`/${locale}/organisations/${id}/fleet`}>
              {m.fleet.link}
            </a>
          </p>
        ) : null}
        {underReview ? (
          <form className="form-inline" id="withdraw-form" action={withdrawVerificationAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organisationId" value={v.organisation.id} />
            <input type="hidden" name="applicationId" value={underReview.id} />
            <input type="hidden" name="retryKey" value={retryKey} />
            <input type="hidden" name="returnTo" value="carrier" />
            <button className="button" type="submit" id="withdraw-application">
              {tv.withdraw}
            </button>
          </form>
        ) : null}
      </section>

      {!applying && !anyOpen && requirements.length === 0 ? (
        <p className="notice" role="note" id="carrier-closed">
          {tv.closed}
        </p>
      ) : null}
      {!applying && anyOpen && !underReview ? (
        <p className="notice" role="note" id="carrier-waiting">
          {t.waiting}
        </p>
      ) : null}
      {applying ? (
        <section className="section" aria-labelledby="carrier-apply-title">
          <h2 id="carrier-apply-title">
            {applying === 'service_change' ? t.changeTitle : t.applyTitle}
          </h2>
          <p>{applying === 'service_change' ? t.changeLead : t.applyLead}</p>
          <form className="form card" id={formId} action={submitVerificationAction} noValidate>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organisationId" value={v.organisation.id} />
            <input type="hidden" name="version" value={v.organisation.version} />
            <input type="hidden" name="retryKey" value={retryKey} />
            <input
              type="hidden"
              name="kind"
              value={applying === 'initial' ? 'initial' : 'capability'}
            />
            <input type="hidden" name="capability" value="carry_as_company" />
            <input type="hidden" name="returnTo" value="carrier" />
            <fieldset
              className="fieldset"
              id="service-countries"
              tabIndex={-1}
              aria-describedby={
                invalid.has('service-countries') ? 'service-countries-error' : undefined
              }
              data-invalid={invalid.has('service-countries') ? 'true' : undefined}
            >
              <legend>{t.countriesLegend}</legend>
              {invalid.has('service-countries') ? (
                <p className="field-error" id="service-countries-error">
                  {invalid.get('service-countries')}
                </p>
              ) : null}
              {open.map((country) => (
                <div className="check" key={country.code}>
                  <input
                    id={`service-country-${country.code}`}
                    name="serviceCountry"
                    type="checkbox"
                    value={country.code}
                    defaultChecked={chosenCountries.has(country.code)}
                  />
                  <label htmlFor={`service-country-${country.code}`}>{country.name[locale]}</label>
                </div>
              ))}
            </fieldset>
            <fieldset
              className="fieldset"
              id="service-equipment"
              tabIndex={-1}
              aria-describedby={
                invalid.has('service-equipment') ? 'service-equipment-error' : undefined
              }
              data-invalid={invalid.has('service-equipment') ? 'true' : undefined}
            >
              <legend>{t.equipmentLegend}</legend>
              {invalid.has('service-equipment') ? (
                <p className="field-error" id="service-equipment-error">
                  {invalid.get('service-equipment')}
                </p>
              ) : null}
              {equipment.map((entry) => (
                <div className="check" key={entry.code}>
                  <input
                    id={`service-equipment-${entry.code}`}
                    name="serviceEquipment"
                    type="checkbox"
                    value={entry.code}
                    defaultChecked={chosenEquipment.has(entry.code)}
                  />
                  <label htmlFor={`service-equipment-${entry.code}`}>{entry.name[locale]}</label>
                </div>
              ))}
            </fieldset>
            <h3>{tv.evidenceTitle}</h3>
            <p>{tv.evidenceLead}</p>
            <EvidenceFields
              locale={locale}
              t={tv}
              requirements={requirements}
              previous={latest?.evidence ?? []}
              countries={open}
              defaultCountry={v.organisation.countryCode}
              invalid={invalid}
            />
            <DeclarationField t={tv} invalid={invalid} />
            <button className="button button-primary" type="submit" id="submit-carrier">
              {applying === 'service_change' ? t.submitChange : t.submit}
            </button>
          </form>
          <DraftKeeper
            key={`${v.organisation.version}-${Boolean(confirmation)}`}
            formId={formId}
            scope={`c${v.organisation.version}`}
            overwrite
            clear={Boolean(confirmation)}
          />
        </section>
      ) : null}

      <section className="section" aria-labelledby="carrier-versions-title">
        <h2 id="carrier-versions-title">{t.versionsTitle}</h2>
        {carrierApps.length === 0 ? <p id="no-carrier-versions">{tv.noVersions}</p> : null}
        <ul className="organisation-list" id="carrier-versions">
          {carrierApps.map((application) => (
            <li
              className="card organisation"
              key={application.id}
              data-version={application.versionNo}
            >
              <h3>
                {fill(tv.version, { n: application.versionNo })}:{' '}
                {application.kind === 'amendment' ? tv.kindAmendment : tv.kindCarrier}
              </h3>
              <p className="chip">{tv.status[application.status]}</p>
              <dl className="facts">
                <div>
                  <dt>{tv.submittedAt}</dt>
                  <dd>
                    <Ltr>{when(application.submittedAt)}</Ltr>
                  </dd>
                </div>
                {application.decisionReason ? (
                  <div>
                    <dt>{tv.reasonLabel}</dt>
                    <dd>
                      {tv.reasons[application.decisionReason as keyof typeof tv.reasons] ??
                        application.decisionReason}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {application.service
                ? serviceFacts(application.service, `service-${application.versionNo}`)
                : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
