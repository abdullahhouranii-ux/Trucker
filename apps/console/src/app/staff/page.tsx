import { redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../web/src/components/form.tsx';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import { CreateStaffForm, IssueLinkForm } from '../../components/link-forms.tsx';
import {
  setParticipantLinkAction,
  setPrivilegeAction,
  setStatusAction,
} from '../../server/actions.ts';
import { requireStaff } from '../../server/session.ts';
import type { Privilege, StaffAccount } from '../../server/types.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const DONE: Record<string, string> = {
  granted: 'The privilege was granted. The server confirmed it.',
  removed: 'The privilege was removed. The server confirmed it.',
  disabled: 'The account was disabled and its sessions ended. The server confirmed it.',
  enabled: 'The account was enabled. The server confirmed it.',
  declared: 'The declaration was recorded. The server confirmed it.',
  unchanged: 'Nothing needed changing: it was already so.',
};
const ERRORS: Record<string, string> = {
  staff_privilege_required: 'Your account does not hold the privilege this needs.',
  staff_self_action: 'This cannot be done to your own account. Another administrator must do it.',
  staff_account_disabled: 'This account is disabled.',
  validation_failed: 'Check what you entered. A mobile number starts with + and the country code.',
  not_found: 'That account was not found.',
  unconfirmed:
    'It was not confirmed that this was done. It may have been. The list shows the present state. Trying again changes nothing twice.',
  refused: 'That was refused.',
};
const STATUS: Record<StaffAccount['status'], string> = {
  invited: 'Invited, not yet set up',
  active: 'Active',
  disabled: 'Disabled',
};
const PRIVILEGES: [Privilege, string][] = [
  ['staff_admin', 'Staff administrator'],
  ['reviewer', 'Reviewer'],
];
const LINK: Record<StaffAccount['participantLink'], string> = {
  not_declared: 'Not declared. This is not the same as having none.',
  declared_none: 'Declared: has no participant account',
  declared: 'Declared: has a participant account',
};

export default async function StaffPage({ searchParams }: Props) {
  const search = await searchParams;
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/staff" />
        </main>
      </>
    );
  }
  const list = await api<{ accounts: StaffAccount[] }>('GET', '/staff/accounts', {
    token: found.token,
  });
  if (!list.ok && list.status === 401) redirect('/sign-in?error=session_ended');
  const error = typeof search.error === 'string' ? (ERRORS[search.error] ?? ERRORS.refused) : null;
  const done = typeof search.done === 'string' ? DONE[search.done] : undefined;
  if (!list.ok) {
    const forbidden = list.status === 403;
    return (
      <>
        <ConsoleHeader staff={found.staff} current="/staff" />
        <main id="main" tabIndex={-1}>
          {forbidden ? (
            <div className="page page-narrow" data-state="forbidden">
              <h1>Staff accounts</h1>
              <div className="notice notice-error" role="alert" id="forbidden">
                <h2>You cannot see this</h2>
                <p>
                  Staff accounts are managed by staff administrators. Your account does not hold
                  that privilege. This attempt was recorded.
                </p>
              </div>
            </div>
          ) : (
            <Unavailable retryHref="/staff" />
          )}
        </main>
      </>
    );
  }
  const me = found.staff.id;
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/staff" />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow">
          <h1>Staff accounts</h1>
          <ErrorSummary title="There is a problem" problems={error ? [{ message: error }] : []} />
          {done && !error ? (
            <p className="notice notice-success" role="status" id="staff-confirmation">
              {done}
            </p>
          ) : null}
          <p>
            You can change other people&apos;s accounts, never your own. Everything done here, and
            every refused attempt, is recorded in the audit list.
          </p>
          <ul className="organisation-list" id="staff-list">
            {list.data.accounts.map((account) => {
              const own = account.id === me;
              return (
                <li
                  key={account.id}
                  className="card account"
                  id={`account-${account.id}`}
                  data-email={account.email}
                >
                  <h3>
                    {account.displayName}
                    {own ? ' (you)' : ''}
                  </h3>
                  <p>{account.email}</p>
                  <div className="chips">
                    <span className="chip" data-status={account.status}>
                      {STATUS[account.status]}
                    </span>
                    {PRIVILEGES.filter(([privilege]) => account.privileges.includes(privilege)).map(
                      ([privilege, label]) => (
                        <span
                          className="chip chip-draft"
                          key={privilege}
                          data-privilege={privilege}
                        >
                          {label}
                        </span>
                      ),
                    )}
                  </div>
                  <dl className="facts">
                    <div>
                      <dt>Participant account</dt>
                      <dd data-link={account.participantLink}>
                        {LINK[account.participantLink]}
                        {account.participantPhone ? `: ${account.participantPhone}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Set up</dt>
                      <dd>{account.enrolledAt ? utc(account.enrolledAt) : 'Not yet'}</dd>
                    </div>
                  </dl>
                  {own ? (
                    <p className="form-note">
                      Another staff administrator must make any change to your account.
                    </p>
                  ) : (
                    <>
                      <div className="account-actions">
                        {PRIVILEGES.map(([privilege, label]) => {
                          const held = account.privileges.includes(privilege);
                          return (
                            <form action={setPrivilegeAction} key={privilege}>
                              <input type="hidden" name="staffId" value={account.id} />
                              <input type="hidden" name="privilege" value={privilege} />
                              <input type="hidden" name="granted" value={held ? 'false' : 'true'} />
                              <button
                                className="button"
                                type="submit"
                                data-action={`${held ? 'remove' : 'grant'}-${privilege}`}
                              >
                                {held ? 'Remove' : 'Grant'} {label.toLowerCase()}
                                <span className="visually-hidden">
                                  {' '}
                                  {held ? 'from' : 'to'} {account.email}
                                </span>
                              </button>
                            </form>
                          );
                        })}
                        <form action={setStatusAction}>
                          <input type="hidden" name="staffId" value={account.id} />
                          <input
                            type="hidden"
                            name="status"
                            value={account.status === 'disabled' ? 'enabled' : 'disabled'}
                          />
                          <button
                            className={`button${account.status === 'disabled' ? '' : ' button-danger'}`}
                            type="submit"
                            data-action={account.status === 'disabled' ? 'enable' : 'disable'}
                          >
                            {account.status === 'disabled' ? 'Enable' : 'Disable'} the account
                            <span className="visually-hidden"> of {account.email}</span>
                          </button>
                        </form>
                        {account.status === 'disabled' ? null : (
                          <IssueLinkForm staffId={account.id} email={account.email} />
                        )}
                      </div>
                      <details>
                        <summary>Change the participant-account declaration</summary>
                        <form className="form" action={setParticipantLinkAction}>
                          <input type="hidden" name="staffId" value={account.id} />
                          <fieldset className="choice">
                            <legend>Does {account.email} also have a participant account?</legend>
                            <label>
                              <input
                                type="radio"
                                name="participantLink"
                                value="declared_none"
                                defaultChecked={account.participantLink === 'declared_none'}
                                required
                              />
                              No, they have none
                            </label>
                            <label>
                              <input
                                type="radio"
                                name="participantLink"
                                value="declared"
                                defaultChecked={account.participantLink === 'declared'}
                              />
                              Yes, with the mobile number below
                            </label>
                          </fieldset>
                          <div className="field">
                            <label htmlFor={`phone-${account.id}`}>
                              Their participant mobile number (only if yes)
                            </label>
                            <input
                              id={`phone-${account.id}`}
                              name="participantPhone"
                              type="tel"
                              dir="ltr"
                              maxLength={20}
                              defaultValue={account.participantPhone ?? ''}
                            />
                          </div>
                          <button className="button" type="submit" data-action="declare">
                            Record the declaration
                          </button>
                        </form>
                      </details>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <CreateStaffForm />
        </div>
      </main>
    </>
  );
}
