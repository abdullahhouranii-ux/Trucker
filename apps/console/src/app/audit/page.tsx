import { redirect } from 'next/navigation';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import { requireStaff } from '../../server/session.ts';
import type { AuditEntry } from '../../server/types.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const ACTIONS: Record<string, string> = {
  'staff.bootstrap': 'First administrator created by the operator command',
  'staff.enrolled': 'Account set up with a password and an authenticator',
  'staff.enrolment_issue': 'Enrolment link issued',
  'staff.enrolment_ended': 'Enrolment link ended',
  'staff.sign_in': 'Sign-in',
  'staff.sign_out': 'Sign-out',
  'staff.session_ended': 'Session ended',
  'staff.locked': 'Sign-in locked after wrong attempts',
  'staff.create': 'Account created',
  'staff.status': 'Account enabled or disabled',
  'staff.privilege.grant': 'Privilege granted',
  'staff.privilege.remove': 'Privilege removed',
  'staff.participant_link': 'Participant-account declaration recorded',
  'staff.list': 'Staff accounts viewed',
  'staff.audit_list': 'Audit list viewed',
};

const detail = (entry: AuditEntry): string =>
  Object.entries(entry.detail)
    .map(([name, value]) => `${name.replaceAll('_', ' ')}: ${String(value).replaceAll('_', ' ')}`)
    .join('; ');

export default async function AuditPage({ searchParams }: Props) {
  const search = await searchParams;
  const after =
    typeof search.after === 'string' && /^[0-9]{1,18}$/.test(search.after) ? search.after : null;
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/audit" />
        </main>
      </>
    );
  }
  const list = await api<{ entries: AuditEntry[]; nextAfter: string | null }>(
    'GET',
    `/staff/audit${after ? `?after=${after}` : ''}`,
    { token: found.token },
  );
  if (!list.ok && list.status === 401) redirect('/sign-in?error=session_ended');
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/audit" />
      <main id="main" tabIndex={-1}>
        {!list.ok ? (
          list.status === 403 ? (
            <div className="page page-narrow" data-state="forbidden">
              <h1>Audit</h1>
              <div className="notice notice-error" role="alert" id="forbidden">
                <h2>You cannot see this</h2>
                <p>
                  The audit list is read by staff administrators. Your account does not hold that
                  privilege. This attempt was recorded.
                </p>
              </div>
            </div>
          ) : (
            <Unavailable retryHref="/audit" />
          )
        ) : (
          <div className="page page-narrow">
            <h1>Audit</h1>
            <p>
              Everything staff did and every refused attempt, newest first. Entries cannot be
              changed or removed. No password, code or link is ever recorded.
            </p>
            <ul className="audit" id="audit-list">
              {list.data.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="card"
                  data-outcome={entry.outcome}
                  data-action={entry.action}
                >
                  <dl>
                    <div>
                      <dt>When</dt>
                      <dd>{utc(entry.occurredAt)}</dd>
                    </div>
                    <div>
                      <dt>What</dt>
                      <dd>
                        {ACTIONS[entry.action] ?? entry.action}:{' '}
                        <strong>{entry.outcome === 'done' ? 'done' : 'refused'}</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>By</dt>
                      <dd>{entry.actor?.email ?? 'Nobody signed in'}</dd>
                    </div>
                    <div>
                      <dt>About</dt>
                      <dd>{entry.subject?.email ?? 'No account'}</dd>
                    </div>
                    {Object.keys(entry.detail).length > 0 ? (
                      <div>
                        <dt>Detail</dt>
                        <dd>{detail(entry)}</dd>
                      </div>
                    ) : null}
                  </dl>
                </li>
              ))}
            </ul>
            <div className="form-inline">
              {list.data.nextAfter ? (
                <a
                  className="button"
                  id="older-entries"
                  href={`/audit?after=${list.data.nextAfter}`}
                >
                  Older entries
                </a>
              ) : null}
              {after ? (
                <a className="button" id="newest-entries" href="/audit">
                  Back to the newest
                </a>
              ) : null}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
