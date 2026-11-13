import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../components/draft-keeper.tsx';
import { describedBy, ErrorSummary, Field, type Problem } from '../../../components/form.tsx';
import { isLocale } from '../../../i18n/config.ts';
import { fill } from '../../../i18n/format.ts';
import { getMessages } from '../../../i18n/messages.ts';
import { requestCodeAction } from '../../../server/actions.ts';
import { currentPerson, readSignIn } from '../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignInPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const t = m.auth.signIn;
  const errors = m.auth.errors;
  const search = await searchParams;
  const error = typeof search.error === 'string' ? search.error : undefined;

  const current = await currentPerson();
  if (current && error !== 'session_ended')
    redirect(`/${locale}/${current.person.registrationComplete ? 'account' : 'register'}`);

  const problems: Problem[] = [];
  if (error === 'phone') problems.push({ field: 'phone', message: errors.phone });
  else if (error === 'code_resend_too_soon') {
    problems.push({
      message: fill(errors.code_resend_too_soon, {
        seconds: typeof search.seconds === 'string' ? search.seconds : '60',
      }),
    });
  } else if (error && error in errors)
    problems.push({ message: errors[error as keyof typeof errors] });
  else if (error) problems.push({ message: errors.unavailable });
  const phoneError = error === 'phone' ? errors.phone : undefined;
  const done = typeof search.done === 'string' ? search.done : undefined;
  const progress = await readSignIn();

  return (
    <div className="page page-narrow">
      <h1>{t.title}</h1>
      <ErrorSummary title={errors.summary} problems={problems} />
      {done === 'signed_out' ? (
        <p className="notice notice-success" role="status" id="signed-out-confirmed">
          {m.auth.account.signedOut}
        </p>
      ) : null}
      {done === 'signed_out_local' ? (
        <p className="notice" role="status" id="signed-out-local">
          {m.auth.account.signedOutLocal}
        </p>
      ) : null}
      <p>{t.lead}</p>
      <form className="form card" id="sign-in-form" action={requestCodeAction} noValidate>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="retryKey" value={randomUUID()} />
        <Field id="phone" label={t.phoneLabel} hint={t.phoneHint} error={phoneError}>
          <input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            required
            data-draft
            defaultValue={progress?.phone ?? ''}
            aria-invalid={phoneError ? true : undefined}
            aria-describedby={describedBy('phone', true, Boolean(phoneError))}
          />
        </Field>
        <p className="form-note">{t.phoneNote}</p>
        <button className="button button-primary" type="submit">
          {t.submit}
        </button>
      </form>
      <DraftKeeper formId="sign-in-form" />
    </div>
  );
}
