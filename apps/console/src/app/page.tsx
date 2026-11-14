import { ErrorSummary } from '../../../web/src/components/form.tsx';
import { ConsoleHeader, Unavailable, utc } from '../components/console-header.tsx';
import { signOutAction } from '../server/actions.ts';
import { requireStaff } from '../server/session.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const PRIVILEGE: Record<string, string> = {
  staff_admin: 'Staff administrator',
  reviewer: 'Reviewer',
};

export default async function HomePage({ searchParams }: Props) {
  const search = await searchParams;
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/" />
        </main>
      </>
    );
  }
  const { staff } = found;
  const problems =
    search.error === 'sign_out_unconfirmed'
      ? [
          {
            message:
              'It was not confirmed that you are signed out. Your session may still be active. Try again.',
          },
        ]
      : [];
  return (
    <>
      <ConsoleHeader staff={staff} current="/" />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow">
          <h1>My account</h1>
          <ErrorSummary title="There is a problem" problems={problems} />
          <dl className="card facts" id="my-account">
            <div>
              <dt>Name</dt>
              <dd>{staff.displayName}</dd>
            </div>
            <div>
              <dt>Work email</dt>
              <dd>{staff.email}</dd>
            </div>
            <div>
              <dt>Privileges</dt>
              <dd id="my-privileges">
                {staff.privileges.length > 0
                  ? staff.privileges.map((privilege) => PRIVILEGE[privilege]).join(', ')
                  : 'None. An administrator can grant them.'}
              </dd>
            </div>
            <div>
              <dt>Recovery codes left</dt>
              <dd id="recovery-left">{staff.recoveryCodesLeft} of 10</dd>
            </div>
            <div>
              <dt>This session ends</dt>
              <dd>{utc(found.sessionExpiresAt)} at the latest, sooner if left unused</dd>
            </div>
          </dl>
          {staff.recoveryCodesLeft <= 2 ? (
            <p className="notice" role="note" id="recovery-low">
              You have few recovery codes left. Ask another staff administrator for a new enrolment
              link to set up your account again and get new codes.
            </p>
          ) : null}
          <form className="form-inline" action={signOutAction}>
            <button className="button" type="submit" id="sign-out">
              Sign out
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
