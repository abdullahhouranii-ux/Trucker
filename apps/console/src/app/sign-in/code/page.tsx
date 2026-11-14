import { redirect } from 'next/navigation';
import { ErrorSummary, Field } from '../../../../../web/src/components/form.tsx';
import { ConsoleHeader } from '../../../components/console-header.tsx';
import { signInCodeAction } from '../../../server/actions.ts';
import { ticket } from '../../../server/session.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const ERRORS: Record<string, string> = {
  code: 'That code was not accepted. Enter the code your authenticator shows now. Each code works once.',
  unconfirmed:
    'It was not confirmed that you are signed in. Enter the code again: nothing is done twice.',
};

export default async function SignInCodePage({ searchParams }: Props) {
  const search = await searchParams;
  const error = typeof search.error === 'string' ? ERRORS[search.error] : undefined;
  if (!(await ticket())) redirect('/sign-in');
  return (
    <>
      <ConsoleHeader />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow">
          <h1>Enter your code</h1>
          <ErrorSummary title="There is a problem" problems={error ? [{ message: error }] : []} />
          <form className="form card" id="code-form" action={signInCodeAction}>
            <Field
              id="code"
              label="Code from your authenticator app"
              hint="Six digits. If you cannot use your authenticator, enter one of your recovery codes instead. A recovery code works once."
            >
              <input
                id="code"
                name="code"
                type="text"
                dir="ltr"
                inputMode="text"
                autoComplete="one-time-code"
                maxLength={40}
                required
                aria-describedby="code-hint"
              />
            </Field>
            <button className="button button-primary" type="submit">
              Sign in
            </button>
          </form>
          <div className="form-inline">
            <a className="button" href="/sign-in">
              Start again
            </a>
          </div>
        </div>
      </main>
    </>
  );
}
