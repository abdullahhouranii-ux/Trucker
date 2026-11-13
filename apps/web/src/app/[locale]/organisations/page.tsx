import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../components/draft-keeper.tsx';
import { ErrorSummary } from '../../../components/form.tsx';
import { organisationProblems } from '../../../components/organisation-form.tsx';
import { Ltr } from '../../../components/ltr.tsx';
import { isLocale } from '../../../i18n/config.ts';
import { getMessages } from '../../../i18n/messages.ts';
import { api, type OrganisationSummary } from '../../../server/api.ts';
import { requirePerson } from '../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function OrganisationsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const t = m.org;
  const search = await searchParams;
  const { problems } = organisationProblems(
    typeof search.error === 'string' ? search.error : undefined,
    t,
    m.auth.errors.unavailable,
  );

  const found = await requirePerson(locale);
  const list =
    found.state === 'signed-in'
      ? await api<{ organisations: OrganisationSummary[] }>('GET', '/organisations', {
          token: found.token,
        })
      : undefined;
  if (found.state === 'signed-in' && !found.person.registrationComplete)
    redirect(`/${locale}/register`);
  if (list && !list.ok && list.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (!list?.ok) {
    // The server did not answer, or organisation data is closed here. Nothing is claimed.
    problems.push({
      message:
        list && !list.ok && list.code === 'organisation_access_closed'
          ? t.errors.organisation_access_closed
          : t.errors.organisation_unavailable,
    });
    return (
      <div className="page page-narrow" data-state="organisations-unavailable">
        <h1>{t.unavailableTitle}</h1>
        <ErrorSummary title={m.auth.errors.summary} problems={problems} />
        <div className="form-inline">
          <a className="button" href={`/${locale}/organisations`} id="retry-organisations">
            {t.retry}
          </a>
        </div>
      </div>
    );
  }
  const organisations = list.data.organisations;

  return (
    <div className="page page-narrow">
      <h1>{t.listTitle}</h1>
      <ErrorSummary title={m.auth.errors.summary} problems={problems} />
      <p>{t.listLead}</p>
      {organisations.length === 0 ? <p id="no-organisations">{t.none}</p> : null}
      <ul className="organisation-list">
        {organisations.map((organisation) => (
          <li key={organisation.id} className="card organisation">
            <h2>
              <bdi>{organisation.legalName}</bdi>
            </h2>
            <p className="chip chip-draft">
              {organisation.status === 'draft' ? t.statusDraft : t.statusOther}
            </p>
            <p>
              {t.registrationNumber}: <Ltr>{organisation.registrationNumber}</Ltr>
            </p>
            <a className="button" href={`/${locale}/organisations/${organisation.id}`}>
              {t.open}
              <span className="visually-hidden">
                {' '}
                <bdi>{organisation.legalName}</bdi>
              </span>
            </a>
          </li>
        ))}
      </ul>
      <div className="form-inline">
        <a
          className="button button-primary"
          href={`/${locale}/organisations/new`}
          id="create-organisation"
        >
          {t.createLink}
        </a>
        <a className="button" href={`/${locale}/account`}>
          {m.auth.account.title}
        </a>
      </div>
      <DraftKeeper formId="organisation-new-form" clear />
    </div>
  );
}
