import { redirect } from 'next/navigation';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import {
  ACCOUNT_KIND,
  APPLICATION_STATUS,
  CAPABILITY,
  REVIEW_ERRORS,
} from '../../components/review-text.ts';
import { requireStaff } from '../../server/session.ts';
import type { QueueEntry } from '../../server/types.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function VerificationQueuePage({ searchParams }: Props) {
  const search = await searchParams;
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/verification" />
        </main>
      </>
    );
  }
  const list = await api<{ applications: QueueEntry[] }>('GET', '/staff/verification', {
    token: found.token,
  });
  if (!list.ok && list.status === 401) redirect('/sign-in?error=session_ended');
  const error =
    typeof search.error === 'string'
      ? (REVIEW_ERRORS[search.error] ?? REVIEW_ERRORS.refused)
      : null;
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/verification" />
      <main id="main" tabIndex={-1}>
        {!list.ok ? (
          list.status === 403 ? (
            <div className="page page-narrow" data-state="forbidden">
              <h1>Verification</h1>
              <div className="notice notice-error" role="alert" id="forbidden">
                <h2>You cannot see this</h2>
                <p>
                  Applications are read and decided by reviewers. Your account does not hold that
                  privilege. This attempt was recorded.
                </p>
              </div>
            </div>
          ) : (
            <Unavailable retryHref="/verification" />
          )
        ) : (
          <div className="page page-narrow">
            <h1>Verification</h1>
            <p>
              Applications waiting for a decision, oldest first. Opening one is recorded. The
              evidence entries are what the applicant typed: demonstration data, not verified
              documents.
            </p>
            {error ? (
              <div className="notice notice-error" role="alert" id="queue-error">
                <p>{error}</p>
              </div>
            ) : null}
            {list.data.applications.length === 0 ? (
              <p id="queue-empty">Nothing is waiting for a decision.</p>
            ) : null}
            <ul className="organisation-list" id="queue">
              {list.data.applications.map((entry) => (
                <li
                  key={entry.applicationId}
                  className="card account"
                  data-status={entry.status}
                  data-application={entry.applicationId}
                >
                  <h2>{entry.legalName}</h2>
                  <p className="chip" data-account-kind={entry.accountKind}>
                    {ACCOUNT_KIND[entry.accountKind]}
                  </p>
                  <p className="chip">{APPLICATION_STATUS[entry.status]}</p>
                  <p>
                    {entry.kind === 'amendment'
                      ? `Change of legal identity (revalidates ${(entry.revalidates ?? [])
                          .map((cap) => CAPABILITY[cap])
                          .join(' and ')})`
                      : `${CAPABILITY[entry.capability]} verification`}
                    , version {entry.versionNo}, country {entry.countryCode}, submitted{' '}
                    {utc(entry.submittedAt)}
                  </p>
                  <div className="form-inline">
                    <a className="button" href={`/verification/${entry.applicationId}`}>
                      Open
                      <span className="visually-hidden">
                        {' '}
                        {entry.legalName}, version {entry.versionNo}
                      </span>
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}
