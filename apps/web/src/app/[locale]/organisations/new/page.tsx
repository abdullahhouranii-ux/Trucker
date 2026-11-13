import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../components/draft-keeper.tsx';
import { ErrorSummary } from '../../../../components/form.tsx';
import {
  OrganisationFields,
  organisationProblems,
} from '../../../../components/organisation-form.tsx';
import { isLocale } from '../../../../i18n/config.ts';
import { getMessages } from '../../../../i18n/messages.ts';
import { api, type Country } from '../../../../server/api.ts';
import { createOrganisationAction } from '../../../../server/organisation-actions.ts';
import { requirePerson } from '../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;

export default async function NewOrganisationPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const t = m.org;
  const search = await searchParams;
  const { invalid, problems } = organisationProblems(
    typeof search.error === 'string' ? search.error : undefined,
    t,
    m.auth.errors.unavailable,
    {
      limit:
        typeof search.limit === 'string' && /^[0-9]{1,4}$/.test(search.limit) ? search.limit : '',
    },
  );
  // After a refusal the same key comes back, so trying again cannot create a second
  // organisation if the first attempt did reach the server.
  const retryKey =
    typeof search.retry === 'string' && RETRY_KEY.test(search.retry) ? search.retry : randomUUID();

  const found = await requirePerson(locale);
  if (found.state === 'signed-in' && !found.person.registrationComplete)
    redirect(`/${locale}/register`);
  const countries =
    found.state === 'signed-in'
      ? await api<{ countries: Country[] }>('GET', '/registration/countries', {
          token: found.token,
        })
      : undefined;
  if (countries && !countries.ok && countries.status === 401)
    redirect(`/${locale}/sign-in?error=session_ended`);
  if (!countries?.ok) {
    problems.push({
      message:
        countries && !countries.ok && countries.code === 'organisation_access_closed'
          ? t.errors.organisation_access_closed
          : t.errors.organisation_unavailable,
    });
    return (
      <div className="page page-narrow" data-state="organisations-unavailable">
        <h1>{t.unavailableTitle}</h1>
        <ErrorSummary title={m.auth.errors.summary} problems={problems} />
        <div className="form-inline">
          <a
            className="button"
            id="retry-organisations"
            href={`/${locale}/organisations/new?retry=${retryKey}`}
          >
            {t.retry}
          </a>
          <a className="button" href={`/${locale}/organisations`}>
            {t.backToList}
          </a>
        </div>
      </div>
    );
  }
  const open = countries.data.countries;

  if (open.length === 0) {
    return (
      <div className="page page-narrow" data-state="registration-closed">
        <h1>{t.newTitle}</h1>
        <div className="notice" role="status" id="registration-closed">
          <h2>{t.closedTitle}</h2>
          <p>{t.closed}</p>
        </div>
        <div className="form-inline">
          <a className="button" href={`/${locale}/organisations`}>
            {t.backToList}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      <h1>{t.newTitle}</h1>
      <ErrorSummary title={m.auth.errors.summary} problems={problems} />
      <p>{t.newLead}</p>
      <p className="form-note">{t.shipperOnly}</p>
      {open.some((country) => country.fixture) ? (
        <p className="notice notice-development" role="note" id="fixture-notice">
          {t.fixtureNotice}
        </p>
      ) : null}
      <form
        className="form card"
        id="organisation-new-form"
        action={createOrganisationAction}
        noValidate
      >
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="retryKey" value={retryKey} />
        <OrganisationFields locale={locale} t={t} countries={open} invalid={invalid} />
        <button className="button button-primary" type="submit">
          {t.submitCreate}
        </button>
      </form>
      <div className="form-inline">
        <a className="button" href={`/${locale}/organisations`}>
          {t.backToList}
        </a>
      </div>
      <DraftKeeper formId="organisation-new-form" />
    </div>
  );
}
