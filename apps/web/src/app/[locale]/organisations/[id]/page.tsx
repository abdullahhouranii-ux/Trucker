import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../components/draft-keeper.tsx';
import { ErrorSummary } from '../../../../components/form.tsx';
import {
  OrganisationFields,
  organisationProblems,
} from '../../../../components/organisation-form.tsx';
import { Ltr } from '../../../../components/ltr.tsx';
import { isLocale } from '../../../../i18n/config.ts';
import { getMessages } from '../../../../i18n/messages.ts';
import { api, type Country, type Organisation } from '../../../../server/api.ts';
import { updateOrganisationAction } from '../../../../server/organisation-actions.ts';
import { requirePerson } from '../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OrganisationPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.org;
  const search = await searchParams;
  const error = typeof search.error === 'string' ? search.error : undefined;
  const done = typeof search.done === 'string' ? search.done : undefined;
  const { invalid, problems } = organisationProblems(error, t, m.auth.errors.unavailable);

  const found = await requirePerson(locale);
  const [one, countries] =
    found.state === 'signed-in'
      ? await Promise.all([
          api<{ organisation: Organisation }>('GET', `/organisations/${id}`, {
            token: found.token,
          }),
          api<{ countries: Country[] }>('GET', '/registration/countries', { token: found.token }),
        ])
      : [undefined, undefined];
  if (one && !one.ok && one.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  // Not the caller's organisation, or none at all: the same page either way.
  if (one && !one.ok && one.status === 404) notFound();
  if (!one?.ok) {
    problems.push({
      message:
        one && !one.ok && one.code === 'organisation_access_closed'
          ? t.errors.organisation_access_closed
          : t.errors.organisation_unavailable,
    });
    return (
      <div className="page page-narrow" data-state="organisations-unavailable">
        <h1>{t.unavailableTitle}</h1>
        <ErrorSummary title={m.auth.errors.summary} problems={problems} />
        <div className="form-inline">
          <a className="button" id="retry-organisations" href={`/${locale}/organisations/${id}`}>
            {t.retry}
          </a>
          <a className="button" href={`/${locale}/organisations`}>
            {t.backToList}
          </a>
        </div>
      </div>
    );
  }
  const organisation = one.data.organisation;
  const draft = organisation.status === 'draft';
  const verified = organisation.status === 'verified';
  // Under review nothing can be changed; a verified identity changes only by amendment.
  const editable = ['draft', 'changes_requested', 'rejected', 'verification_withdrawn'].includes(
    organisation.status,
  );
  const statusText = draft
    ? t.statusDraft
    : (m.verify.status[organisation.status as keyof typeof m.verify.status] ?? organisation.status);
  const open = countries?.ok ? countries.data.countries : [];
  // The organisation's own country stays selectable even if it has since closed.
  const choices = open.some((country) => country.code === organisation.countryCode)
    ? open
    : [
        ...open,
        {
          code: organisation.countryCode,
          name: {
            en: organisation.countryCode,
            ar: organisation.countryCode,
            ur: organisation.countryCode,
          },
          fixture: false,
        },
      ];
  const countryName =
    open.find((country) => country.code === organisation.countryCode)?.name[locale] ??
    organisation.countryCode;
  const confirmation = done === 'created' ? t.created : done === 'saved' ? t.saved : undefined;
  const formId = `organisation-form-${organisation.id}`;
  // A finished save, or values changed by someone else, end the draft kept in this tab.
  const dropDraft = Boolean(confirmation) || error === 'organisation_changed';

  return (
    <div className="page page-narrow">
      <div className="form-inline">
        <a className="button" href={`/${locale}/organisations`}>
          {t.backToList}
        </a>
      </div>
      <h1>
        <bdi>{organisation.legalName}</bdi>
      </h1>
      <ErrorSummary title={m.auth.errors.summary} problems={problems} />
      {confirmation && problems.length === 0 ? (
        <p className="notice notice-success" role="status" id="organisation-confirmation">
          {confirmation}
        </p>
      ) : null}
      <div className="form-inline">
        <a
          className="button"
          id="open-shipments"
          href={`/${locale}/organisations/${organisation.id}/shipments`}
        >
          {t.shipmentsLink}
        </a>
        <a
          className="button"
          id="open-verification"
          href={`/${locale}/organisations/${organisation.id}/verification`}
        >
          {m.verify.link}
        </a>
        <a
          className="button"
          id="open-authorities"
          href={`/${locale}/organisations/${organisation.id}/authorities`}
        >
          {m.roles.link}
        </a>
        <a
          className="button"
          id="open-cargo-cases"
          href={`/${locale}/organisations/${organisation.id}/cargo-cases`}
        >
          {m.cargo.casesTitle}
        </a>
        <a
          className="button"
          id="open-contracts"
          href={`/${locale}/organisations/${organisation.id}/contracts`}
        >
          {m.contracts.link}
        </a>
        <a
          className="button"
          id="open-carrier-page"
          href={`/${locale}/organisations/${organisation.id}/carrier`}
        >
          {t.carrierLink}
        </a>
        <a
          className="button"
          id="open-bookings"
          href={`/${locale}/organisations/${organisation.id}/bookings`}
        >
          {m.book.link}
        </a>
      </div>
      <div className="notice" role="note" id="organisation-status">
        <h2>
          {t.statusLabel}: {statusText}
        </h2>
        {draft ? <p>{t.draftNotice}</p> : null}
        {verified ? <p>{t.verifiedNotice}</p> : null}
        {!editable && !verified ? <p>{t.lockedNotice}</p> : null}
      </div>
      <section className="section" aria-labelledby="details-title">
        <h2 id="details-title">{t.detailsTitle}</h2>
        <dl className="card facts" id="organisation-facts">
          <div>
            <dt>{t.legalName}</dt>
            <dd>
              <bdi>{organisation.legalName}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t.tradingName}</dt>
            <dd>{organisation.tradingName ? <bdi>{organisation.tradingName}</bdi> : t.notGiven}</dd>
          </div>
          <div>
            <dt>{t.country}</dt>
            <dd>
              <bdi>{countryName}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t.registrationNumber}</dt>
            <dd>
              <Ltr>{organisation.registrationNumber}</Ltr>
            </dd>
          </div>
          <div>
            <dt>{t.address}</dt>
            <dd>{organisation.address ? <bdi>{organisation.address}</bdi> : t.notGiven}</dd>
          </div>
          <div>
            <dt>{t.contactName}</dt>
            <dd>{organisation.contactName ? <bdi>{organisation.contactName}</bdi> : t.notGiven}</dd>
          </div>
          {verified ? null : (
            <div>
              <dt>{t.capabilityLabel}</dt>
              <dd>{t.capabilityShip}</dd>
            </div>
          )}
          <div>
            <dt>{t.role}</dt>
            <dd>{t.roleAdmin}</dd>
          </div>
        </dl>
      </section>
      {editable || verified ? (
        <section className="section" aria-labelledby="edit-title">
          <h2 id="edit-title">{t.editTitle}</h2>
          <form className="form card" id={formId} action={updateOrganisationAction} noValidate>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organisationId" value={organisation.id} />
            <input type="hidden" name="version" value={organisation.version} />
            <OrganisationFields
              locale={locale}
              t={t}
              countries={choices}
              current={organisation}
              invalid={invalid}
            />
            <button className="button button-primary" type="submit">
              {t.submitSave}
            </button>
          </form>
        </section>
      ) : null}
      <DraftKeeper formId="organisation-new-form" clear />
      {editable || verified ? (
        <DraftKeeper
          key={`${organisation.version}-${dropDraft}`}
          formId={formId}
          scope={`v${organisation.version}`}
          overwrite
          clear={dropDraft}
        />
      ) : null}
    </div>
  );
}
