import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../components/draft-keeper.tsx';
import { ErrorSummary, type Problem } from '../../../components/form.tsx';
import { Ltr } from '../../../components/ltr.tsx';
import { isLocale, type Locale } from '../../../i18n/config.ts';
import { fill } from '../../../i18n/format.ts';
import { getMessages } from '../../../i18n/messages.ts';
import {
  endOtherSessionsAction,
  endSessionAction,
  signOutAction,
  signOutLocallyAction,
} from '../../../server/actions.ts';
import { api, type Session } from '../../../server/api.ts';
import { requirePerson } from '../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Times are shown in UTC with the zone named, because no place is attached to a session.
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const REVOCATION_ERRORS = [
  'sign_out_unconfirmed',
  'end_session_unconfirmed',
  'end_others_unconfirmed',
  'session_not_found',
] as const;

/** Sign out again, or as a last resort remove the sign-in from this browser only. */
function SignOutChoices({
  locale,
  labels,
  offerLocal,
}: {
  locale: Locale;
  labels: { signOut: string; signOutLocal: string; signOutLocalNote: string };
  offerLocal: boolean;
}) {
  return (
    <>
      <form action={signOutAction}>
        <input type="hidden" name="locale" value={locale} />
        <button className="button button-primary" type="submit" id="sign-out">
          {labels.signOut}
        </button>
      </form>
      {offerLocal ? (
        <form action={signOutLocallyAction}>
          <input type="hidden" name="locale" value={locale} />
          <button
            className="button"
            type="submit"
            id="sign-out-local"
            aria-describedby="sign-out-local-note"
          >
            {labels.signOutLocal}
          </button>
          <p className="form-note" id="sign-out-local-note">
            {labels.signOutLocalNote}
          </p>
        </form>
      ) : null}
    </>
  );
}

export default async function AccountPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const t = m.auth.account;
  const errors = m.auth.errors;
  const search = await searchParams;
  const error = typeof search.error === 'string' ? search.error : undefined;
  const done = typeof search.done === 'string' ? search.done : undefined;
  const problems: Problem[] = [];
  const revocationError = REVOCATION_ERRORS.find((code) => code === error);
  if (revocationError) problems.push({ message: errors[revocationError] });
  else if (error) problems.push({ message: errors.unavailable });

  const found = await requirePerson(locale);
  if (found.state === 'unknown') {
    // The server did not answer. Nothing is known about the session, so nothing is claimed:
    // the person may retry, sign out again, or remove the sign-in from this browser only.
    problems.push({ message: errors.account_unavailable });
    return (
      <div className="page page-narrow" data-state="account-unavailable">
        <h1>{t.unavailableTitle}</h1>
        <ErrorSummary title={errors.summary} problems={problems} />
        <div className="form-inline">
          <a className="button" href={`/${locale}/account`} id="retry-account">
            {t.retry}
          </a>
          <SignOutChoices locale={locale} labels={t} offerLocal />
        </div>
      </div>
    );
  }
  const { token, person } = found;
  if (!person.registrationComplete) redirect(`/${locale}/register`);
  const list = await api<{ sessions: Session[] }>('GET', '/me/sessions', { token });
  const sessions = list.ok ? list.data.sessions : [];
  if (!list.ok) problems.push({ message: errors.account_unavailable });
  const count =
    typeof search.count === 'string' && /^[0-9]{1,4}$/.test(search.count) ? search.count : '0';
  const confirmation =
    done === 'registered'
      ? t.registered
      : done === 'session_ended'
        ? t.sessionEnded
        : done === 'others_ended'
          ? fill(t.othersEnded, { n: count })
          : undefined;

  return (
    <div className="page page-narrow">
      <h1>{t.title}</h1>
      <ErrorSummary title={errors.summary} problems={problems} />
      {confirmation && problems.length === 0 ? (
        <p className="notice notice-success" role="status" id="account-confirmation">
          {confirmation}
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

      <section className="section" aria-labelledby="organisations-title">
        <h2 id="organisations-title">{t.organisations}</h2>
        <p>{m.org.listLead}</p>
        <div className="form-inline">
          <a className="button" href={`/${locale}/organisations`} id="open-organisations">
            {t.organisations}
          </a>
        </div>
      </section>

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
          <SignOutChoices
            locale={locale}
            labels={t}
            offerLocal={revocationError === 'sign_out_unconfirmed'}
          />
        </div>
      </section>
      <DraftKeeper formId="register-form" clear />
      <DraftKeeper formId="sign-in-form" clear />
    </div>
  );
}
