import { ConsoleHeader, Unavailable } from '../../../components/console-header.tsx';
import { CAPABILITY, REASONS, REVIEW_ERRORS } from '../../../components/review-text.ts';
import { revokeVerificationAction } from '../../../server/actions.ts';
import { requireStaff } from '../../../server/session.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DONE: Record<string, string> = {
  revoked:
    'The capability was withdrawn. The other capability, if the organisation holds one, is unchanged. The server confirmed it.',
  already_revoked: 'You had already withdrawn this capability. Nothing was recorded twice.',
};

export default async function WithdrawPage({ searchParams }: Props) {
  const search = await searchParams;
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/verification/withdraw" />
        </main>
      </>
    );
  }
  const organisation =
    typeof search.organisation === 'string' && UUID.test(search.organisation)
      ? search.organisation
      : '';
  const error =
    typeof search.error === 'string'
      ? (REVIEW_ERRORS[search.error] ?? REVIEW_ERRORS.refused)
      : null;
  const done = typeof search.done === 'string' ? DONE[search.done] : undefined;
  const capability =
    typeof search.capability === 'string' && search.capability in CAPABILITY
      ? search.capability
      : '';
  const admin = found.staff.privileges.includes('staff_admin');
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/verification/withdraw" />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow">
          <h1>Withdraw a verification</h1>
          <p>
            For a capability given by mistake. Each capability is withdrawn on its own: the shipper
            or the carrier capability, never both at once. New commercial actions under it are
            blocked from that moment; its history is kept and existing work is not cancelled. The
            organisation stops being verified only when it holds no capability any more. The staff
            member who gave the capability cannot withdraw it.
          </p>
          {error ? (
            <div className="notice notice-error" role="alert" id="review-error" tabIndex={-1}>
              <h2>{search.error === 'unconfirmed' ? 'Not confirmed' : 'Not recorded'}</h2>
              <p>{error}</p>
            </div>
          ) : null}
          {done && !error ? (
            <p className="notice notice-success" role="status" id="review-confirmation">
              {done}
            </p>
          ) : null}
          {!admin ? (
            <div className="notice notice-error" role="note" id="forbidden">
              <h2>You cannot do this</h2>
              <p>A verification is withdrawn by a staff administrator.</p>
            </div>
          ) : (
            <form className="form card" id="withdraw-form" action={revokeVerificationAction}>
              <div className="field">
                <label htmlFor="organisationId">Organisation identifier</label>
                <p className="field-hint" id="organisationId-hint">
                  Filled in when you come from an application. It is also in the audit entry of the
                  decision.
                </p>
                <input
                  id="organisationId"
                  name="organisationId"
                  type="text"
                  required
                  defaultValue={organisation}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="organisationId-hint"
                />
              </div>
              <div className="field">
                <label htmlFor="capability">Capability</label>
                <select id="capability" name="capability" required defaultValue={capability}>
                  <option value="">Choose</option>
                  {Object.entries(CAPABILITY).map(([code, name]) => (
                    <option value={code} key={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="reason">Reason</label>
                <select id="reason" name="reason" required defaultValue="">
                  <option value="">Choose</option>
                  {['verified_in_error', 'information_changed', 'other'].map((reason) => (
                    <option key={reason} value={reason}>
                      {REASONS[reason]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="note">Note to the organisation</label>
                <p className="field-hint" id="note-hint">
                  The organisation reads this. Required when the reason is “Other”.
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
              <button className="button button-primary" type="submit" id="withdraw-verification">
                Withdraw the capability
              </button>
            </form>
          )}
        </div>
      </main>
    </>
  );
}
