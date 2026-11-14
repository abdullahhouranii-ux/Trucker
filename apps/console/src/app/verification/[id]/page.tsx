import { notFound, redirect } from 'next/navigation';
import { api } from '../../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../../components/console-header.tsx';
import {
  APPLICATION_STATUS,
  DECISIONS,
  ORGANISATION_STATUS,
  REASONS,
  REVIEW_ERRORS,
} from '../../../components/review-text.ts';
import { decideVerificationAction } from '../../../server/actions.ts';
import { requireStaff } from '../../../server/session.ts';
import type { ReviewDetail, ReviewVersion } from '../../../server/types.ts';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DONE: Record<string, string> = {
  decided: 'The decision was recorded. The server confirmed it.',
  already_decided: 'You had already recorded this decision. Nothing was recorded twice.',
  claim_review:
    'Another verified organisation holds this registration, so nothing was verified. The application now waits for a different staff member who is both an administrator and a reviewer. The applicant is told only that it needs further review.',
};
const BLOCKED: Record<string, string> = {
  link_not_declared:
    'It is not recorded whether you have a participant account. That is not the same as having none. Until an administrator records your declaration you cannot decide.',
  connected:
    'Your declared participant account is connected with this organisation, so you cannot decide about it.',
};

function Evidence({ version, names }: { version: ReviewVersion; names: Map<string, string> }) {
  if (version.evidence.length === 0) return <p>No evidence entries.</p>;
  return (
    <ul className="evidence">
      {version.evidence.map((entry) => (
        <li key={entry.documentType}>
          <strong>{names.get(entry.documentType) ?? entry.documentType}</strong>: number{' '}
          {entry.documentNumber}, issued in {entry.issuingCountry}
          {entry.issuedOn ? `, issued ${entry.issuedOn}` : ''}
          {entry.expiresOn ? `, expires ${entry.expiresOn}` : ''}
        </li>
      ))}
    </ul>
  );
}

export default async function ApplicationPage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const search = await searchParams;
  const found = await requireStaff();
  const route = `/verification/${id}`;
  // What a request whose answer was lost sent: "<version>.<decision>:<reason>".
  const sentMatch =
    search.error === 'unconfirmed' && typeof search.sent === 'string'
      ? /^([0-9]{1,9})\.([a-z_]{1,40}):([a-z_]{1,40})$/.exec(search.sent)
      : null;
  const sent = sentMatch
    ? { version: sentMatch[1]!, decision: sentMatch[2]!, reason: sentMatch[3]! }
    : null;
  const retryHref = sent
    ? `${route}?error=unconfirmed&sent=${sent.version}.${sent.decision}:${sent.reason}`
    : route;
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref={retryHref} />
        </main>
      </>
    );
  }
  const one = await api<ReviewDetail>('GET', `/staff/verification/${id}`, { token: found.token });
  if (!one.ok && one.status === 401) redirect('/sign-in?error=session_ended');
  if (!one.ok && one.status === 404) notFound();
  if (!one.ok) {
    return (
      <>
        <ConsoleHeader staff={found.staff} current="/verification" />
        <main id="main" tabIndex={-1}>
          {one.status === 403 ? (
            <div className="page page-narrow" data-state="forbidden">
              <h1>Application</h1>
              <div className="notice notice-error" role="alert" id="forbidden">
                <h2>You cannot see this</h2>
                <p>
                  Applications are read and decided by reviewers. Your account does not hold that
                  privilege. This attempt was recorded.
                </p>
              </div>
            </div>
          ) : (
            <Unavailable retryHref={retryHref} />
          )}
        </main>
      </>
    );
  }
  const { application, organisation, requirements, earlier, competing, independence } = one.data;
  const names = new Map(requirements.map((item) => [item.documentType, item.name]));
  const admin = found.staff.privileges.includes('staff_admin');
  const open = application.status === 'submitted' || application.status === 'claim_review';
  const claim = application.status === 'claim_review';
  const blocked = !open
    ? null
    : independence !== 'ok'
      ? (BLOCKED[independence] ?? BLOCKED.connected)
      : claim && application.claimRaisedByCaller
        ? 'You raised this claim, so a different staff member must decide it.'
        : claim && !admin
          ? 'A competing claim is decided by a staff member who is both an administrator and a reviewer. Your account is not an administrator.'
          : null;
  const error =
    typeof search.error === 'string'
      ? (REVIEW_ERRORS[search.error] ?? REVIEW_ERRORS.refused)
      : null;
  const done = typeof search.done === 'string' ? DONE[search.done] : undefined;
  const missing = requirements
    .filter(
      (item) =>
        item.required && !application.evidence.some((e) => e.documentType === item.documentType),
    )
    .map((item) => item.name);

  return (
    <>
      <ConsoleHeader staff={found.staff} current="/verification" />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow">
          <div className="form-inline">
            <a className="button" href="/verification">
              All waiting applications
            </a>
          </div>
          <h1>{application.legalName}</h1>
          <p className="chip" id="application-status" data-status={application.status}>
            {APPLICATION_STATUS[application.status]}
          </p>
          {error ? (
            <div className="notice notice-error" role="alert" id="review-error" tabIndex={-1}>
              <h2>{search.error === 'unconfirmed' ? 'Not confirmed' : 'Not recorded'}</h2>
              <p>{error}</p>
            </div>
          ) : null}
          {sent ? (
            <section className="section" aria-labelledby="resend-title">
              <h2 id="resend-title">Send the same decision again</h2>
              <p>
                You sent: {DECISIONS.find(([key]) => key === sent.decision)?.[1] ?? sent.decision},
                reason “{REASONS[sent.reason] ?? sent.reason}”. If it was recorded, sending it again
                records nothing more and confirms it. If it was not, it is recorded now.
              </p>
              <form className="form card" id="resend-form" action={decideVerificationAction}>
                <input type="hidden" name="applicationId" value={application.id} />
                <input type="hidden" name="version" value={sent.version} />
                <input type="hidden" name="decision" value={`${sent.decision}:${sent.reason}`} />
                <div className="check">
                  <input
                    id="resendNoConflict"
                    name="noConflict"
                    type="checkbox"
                    value="yes"
                    required
                  />
                  <label htmlFor="resendNoConflict">
                    I declare that I have no connection with this organisation or with the people
                    acting for it
                  </label>
                </div>
                <button className="button button-primary" type="submit" id="resend-decision">
                  Send the same decision again
                </button>
              </form>
            </section>
          ) : null}
          {done && !error ? (
            <p className="notice notice-success" role="status" id="review-confirmation">
              {done}
            </p>
          ) : null}
          <p className="notice notice-warning" role="note" id="demonstration-notice">
            Demonstration only. The entries below are what the applicant typed. No document was
            uploaded or checked, and the requirements are fictional test data. A verification
            recorded here does not allow publication in production.
          </p>

          <section className="section" aria-labelledby="submitted-title">
            <h2 id="submitted-title">
              {application.kind === 'amendment'
                ? `Proposed change of legal identity, version ${application.versionNo}`
                : `Submitted for verification, version ${application.versionNo}`}
            </h2>
            <dl className="card facts" id="application-facts">
              <div>
                <dt>Legal name</dt>
                <dd>{application.legalName}</dd>
              </div>
              <div>
                <dt>Country</dt>
                <dd>{application.countryCode}</dd>
              </div>
              <div>
                <dt>Registration number</dt>
                <dd>{application.registrationNumber}</dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>{utc(application.submittedAt)}</dd>
              </div>
              <div>
                <dt>Declaration of authority</dt>
                <dd>
                  Accepted in “{application.declarationLanguage}”, wording{' '}
                  {application.declarationVersion} ({application.declarationKind})
                </dd>
              </div>
              {application.decidedAt ? (
                <div>
                  <dt>Decided</dt>
                  <dd>
                    {utc(application.decidedAt)}:{' '}
                    {REASONS[application.decisionReason ?? ''] ?? application.decisionReason}
                    {application.decisionNote ? `. Note: ${application.decisionNote}` : ''}
                  </dd>
                </div>
              ) : null}
            </dl>
            <h3>Evidence entries (declared, not verified)</h3>
            <Evidence version={application} names={names} />
            {missing.length > 0 ? (
              <p id="missing-evidence">Required and not given: {missing.join(', ')}.</p>
            ) : null}
          </section>

          <section className="section" aria-labelledby="organisation-title">
            <h2 id="organisation-title">The organisation as it stands</h2>
            <dl className="card facts" id="organisation-facts">
              <div>
                <dt>Status</dt>
                <dd>{ORGANISATION_STATUS[organisation.status] ?? organisation.status}</dd>
              </div>
              <div>
                <dt>Legal name</dt>
                <dd>{organisation.legalName}</dd>
              </div>
              <div>
                <dt>Trading name</dt>
                <dd>{organisation.tradingName ?? 'Not given'}</dd>
              </div>
              <div>
                <dt>Country and registration number</dt>
                <dd>
                  {organisation.countryCode}, {organisation.registrationNumber}
                </dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd>{organisation.address ?? 'Not given'}</dd>
              </div>
              <div>
                <dt>Contact person</dt>
                <dd>{organisation.contactName ?? 'Not given'}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{utc(organisation.createdAt)}</dd>
              </div>
            </dl>
            {organisation.status === 'verified' && admin ? (
              <div className="form-inline">
                <a
                  className="button"
                  id="withdraw-link"
                  href={`/verification/withdraw?organisation=${organisation.id}`}
                >
                  Withdraw this organisation’s verification
                </a>
              </div>
            ) : null}
          </section>

          {competing && open ? (
            <div className="notice notice-warning" role="note" id="competing">
              <h2>Competing registration claim</h2>
              <p>
                Another verified organisation holds this country and registration number. Nothing
                about it is shown here and nothing happens to it. This application cannot be
                verified as routine: recording “Verify” sends it to a different staff member who is
                both an administrator and a reviewer.
              </p>
            </div>
          ) : null}

          {open ? (
            <section className="section" aria-labelledby="decision-title">
              <h2 id="decision-title">Decision</h2>
              {blocked ? (
                <div className="notice notice-error" role="note" id="decision-blocked">
                  <h3>You cannot decide this application</h3>
                  <p>{blocked}</p>
                </div>
              ) : (
                <form className="form card" id="decision-form" action={decideVerificationAction}>
                  <input type="hidden" name="applicationId" value={application.id} />
                  <input type="hidden" name="version" value={application.rowVersion} />
                  <div className="field">
                    <label htmlFor="decision">Decision and reason</label>
                    <select id="decision" name="decision" required defaultValue="">
                      <option value="">Choose</option>
                      {DECISIONS.map(([decision, label, reasons]) => (
                        <optgroup key={decision} label={label}>
                          {reasons.map((reason) => (
                            <option key={reason} value={`${decision}:${reason}`}>
                              {label}: {REASONS[reason]}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="note">Note to the applicant</label>
                    <p className="field-hint" id="note-hint">
                      The applicant reads this. Required when the reason is “Other”.
                    </p>
                    <textarea
                      id="note"
                      name="note"
                      rows={3}
                      maxLength={1000}
                      aria-describedby="note-hint"
                    />
                  </div>
                  <div className="check">
                    <input id="noConflict" name="noConflict" type="checkbox" value="yes" required />
                    <label htmlFor="noConflict">
                      I declare that I have no connection with this organisation or with the people
                      acting for it
                    </label>
                  </div>
                  <button className="button button-primary" type="submit" id="record-decision">
                    Record the decision
                  </button>
                </form>
              )}
            </section>
          ) : null}

          <section className="section" aria-labelledby="earlier-title">
            <h2 id="earlier-title">Earlier versions</h2>
            {earlier.length === 0 ? <p id="no-earlier">None.</p> : null}
            <ul className="organisation-list" id="earlier">
              {earlier.map((version) => (
                <li key={version.id} className="card account" data-version={version.versionNo}>
                  <h3>
                    Version {version.versionNo}: {APPLICATION_STATUS[version.status]}
                  </h3>
                  <p>
                    {version.legalName}, {version.countryCode}, {version.registrationNumber}.
                    Submitted {utc(version.submittedAt)}
                    {version.decidedAt ? `, decided ${utc(version.decidedAt)}` : ''}
                    {version.decisionReason
                      ? `: ${REASONS[version.decisionReason] ?? version.decisionReason}`
                      : ''}
                    {version.decisionNote ? `. Note: ${version.decisionNote}` : ''}
                  </p>
                  <Evidence version={version} names={names} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}
