import { notFound, redirect } from 'next/navigation';
import { isLocale } from '../../../i18n/config.ts';
import { getMessages } from '../../../i18n/messages.ts';
import { api, type OrganisationSummary } from '../../../server/api.ts';
import { lookUpSession } from '../../../server/session.ts';

export default async function OperationsEntry({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const t = m.operationsWorkspace;
  const person = await lookUpSession();
  if (person.state === 'none' || person.state === 'ended') {
    redirect('/' + locale + '/sign-in?destination=operations');
  }
  const result = await api<{ organisations: OrganisationSummary[] }>('GET', '/organisations', {
    token: person.token,
  });
  if (!result.ok && result.status === 401) redirect('/' + locale + '/sign-in?error=session_ended');
  const accounts = result.ok ? result.data.organisations : [];
  const root = '/' + locale + '/organisations';
  if (accounts.length === 1) redirect(root + '/' + accounts[0]!.id + '/operations');
  return (
    <div className="page operations-workspace">
      <header className="operations-masthead">
        <h1>{t.title}</h1>
        <p>{t.chooseCompany}</p>
      </header>
      {!result.ok ? (
        <p role="alert">{t.unavailable}</p>
      ) : accounts.length ? (
        <ul className="columns who">
          {accounts.map((account) => (
            <li className="card" key={account.id}>
              <h2>
                <bdi>{account.legalName}</bdi>
              </h2>
              <a className="button" href={root + '/' + account.id + '/operations'}>
                {t.openDashboard}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <a className="button" href={root}>
          {t.back}
        </a>
      )}
    </div>
  );
}
