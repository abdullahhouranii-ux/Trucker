import { redirect } from 'next/navigation';
import { ErrorSummary, Field } from '../../../../web/src/components/form.tsx';
import { ConsoleHeader } from '../../components/console-header.tsx';
import { signInAction } from '../../server/actions.ts';
import { lookUpStaff } from '../../server/session.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const ERRORS: Record<string, string> = {
  refused:
    'Email or password not accepted, or sign-in is locked for a while after several wrong attempts. Check both and try again later.',
  expired: 'Sign-in took too long. Start again.',
  session_ended: 'Your session has ended. Sign in again.',
  unavailable: 'The service did not answer. Nothing was changed. Try again.',
};

export default async function SignInPage({ searchParams }: Props) {
  const search = await searchParams;
  const error = typeof search.error === 'string' ? ERRORS[search.error] : undefined;
  const found = await lookUpStaff();
  if (found.state === 'signed-in') redirect('/');
  return (
    <>
      <ConsoleHeader />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow">
          <h1>Staff sign-in</h1>
          <ErrorSummary title="There is a problem" problems={error ? [{ message: error }] : []} />
          {search.done === 'signed_out' && !error ? (
            <p className="notice notice-success" role="status" id="signed-out">
              You are signed out. The server confirmed it.
            </p>
          ) : null}
          <p>
            For Trucker staff only. Sign-in takes two steps: your work email and password, then a
            code from your authenticator app.
          </p>
          <form className="form card" id="sign-in-form" action={signInAction}>
            <Field id="email" label="Work email">
              <input
                id="email"
                name="email"
                type="email"
                dir="ltr"
                autoComplete="username"
                maxLength={254}
                required
              />
            </Field>
            <Field id="password" label="Password">
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                maxLength={128}
                required
              />
            </Field>
            <button className="button button-primary" type="submit">
              Continue
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
