import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../components/draft-keeper.tsx';
import { Ltr } from '../../../components/ltr.tsx';
import { isLocale } from '../../../i18n/config.ts';
import { getMessages } from '../../../i18n/messages.ts';
import {
  endOtherSessionsAction,
  endSessionAction,
  signOutAction,
} from '../../../server/actions.ts';
import { api, type Session } from '../../../server/api.ts';
import { requirePerson } from '../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Times are shown in UTC with the zone named, because no place is attached to a session.
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export default async function AccountPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const t = m.auth.account;
  const { token, person } = await requirePerson(locale);
  if (!person.registrationComplete) redirect(`/${locale}/register`);
  const list = await api<{ sessions: Session[] }>('GET', '/me/sessions', { token });
  const sessions = list.ok ? list.data.sessions : [];
  const done = (await searchParams).done === 'registered';

  return (
    <div className="page page-narrow">
      <h1>{t.title}</h1>
      {done ? (
        <p className="notice notice-success" role="status">
          {t.registered}
        </p>
      ) : null}
      <dl className="card facts">
        <div>
          <dt>{t.name}</dt>
          <dd>
            <bdi>{person.displayName}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t.phone}</dt>
          <dd>
            <Ltr>{person.phoneMasked}</Ltr>
          </dd>
        </div>
        <div>
          <dt>{t.email}</dt>
          <dd>{person.contactEmail ? <Ltr>{person.contactEmail}</Ltr> : t.none}</dd>
        </div>
      </dl>

      <section className="section" aria-labelledby="sessions-title">
        <h2 id="sessions-title">{t.sessionsTitle}</h2>
        <p>{t.sessionsLead}</p>
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id} className="card session">
              {session.current ? <p className="chip chip-ok">{t.current}</p> : null}
              <dl className="facts">
                <div>
                  <dt>{t.started}</dt>
                  <dd>
                    <Ltr>{when(session.createdAt)}</Ltr>
                  </dd>
                </div>
                <div>
                  <dt>{t.lastUsed}</dt>
                  <dd>
                    <Ltr>{when(session.lastUsedAt)}</Ltr>
                  </dd>
                </div>
                <div>
                  <dt>{t.ends}</dt>
                  <dd>
                    <Ltr>{when(session.expiresAt)}</Ltr>
                  </dd>
                </div>
              </dl>
              {session.current ? null : (
                <form action={endSessionAction}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="sessionId" value={session.id} />
                  <button className="button" type="submit">
                    {t.endSession}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
        <div className="form-inline">
          {sessions.length > 1 ? (
            <form action={endOtherSessionsAction}>
              <input type="hidden" name="locale" value={locale} />
              <button className="button" type="submit">
                {t.endOthers}
              </button>
            </form>
          ) : null}
          <form action={signOutAction}>
            <input type="hidden" name="locale" value={locale} />
            <button className="button button-primary" type="submit">
              {t.signOut}
            </button>
          </form>
        </div>
      </section>
      <DraftKeeper formId="register-form" clear />
      <DraftKeeper formId="sign-in-form" clear />
    </div>
  );
}
