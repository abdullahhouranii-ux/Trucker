import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { describedBy, ErrorSummary, Field, type Problem } from '../../../../components/form.tsx';
import { Ltr } from '../../../../components/ltr.tsx';
import { isLocale } from '../../../../i18n/config.ts';
import { fill } from '../../../../i18n/format.ts';
import { getMessages } from '../../../../i18n/messages.ts';
import { resendCodeAction, verifyCodeAction } from '../../../../server/actions.ts';
import { readSignIn } from '../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Shows a filled message with one left-to-right island in place of a placeholder.
function WithIsland({ template, name, value }: { template: string; name: string; value: string }) {
  const [before, after] = template.split(`{${name}}`);
  return (
    <>
      {before}
      <Ltr>{value}</Ltr>
      {after}
    </>
  );
}

export default async function CodePage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const t = m.auth.code;
  const errors = m.auth.errors;
  const progress = await readSignIn();
  if (!progress?.challengeId) redirect(`/${locale}/sign-in?error=no_challenge`);
  const search = await searchParams;
  const error = typeof search.error === 'string' ? search.error : undefined;

  const problems: Problem[] = [];
  let codeError: string | undefined;
  if (error === 'code_incorrect') {
    codeError =
      errors.code_incorrect +
      (typeof search.left === 'string'
        ? ` ${fill(errors.attemptsRemaining, { n: search.left })}`
        : '');
    problems.push({ field: 'code', message: codeError });
  } else if (error === 'code_format') {
    codeError = errors.code_format;
    problems.push({ field: 'code', message: codeError });
  } else if (error === 'code_resend_too_soon') {
    problems.push({
      message: fill(errors.code_resend_too_soon, {
        seconds: typeof search.seconds === 'string' ? search.seconds : '60',
      }),
    });
  } else if (error && error in errors)
    problems.push({ message: errors[error as keyof typeof errors] });
  else if (error) problems.push({ message: errors.unavailable });

  // The number is shown with its middle hidden, as a reminder and not as a disclosure.
  const masked = `${progress.phone.replace(/[^+0-9٠-٩۰-۹]/g, '').slice(0, 4)}•••••${progress.phone.replace(/\s/g, '').slice(-2)}`;

  return (
    <div className="page page-narrow">
      <h1>{t.title}</h1>
      <ErrorSummary title={errors.summary} problems={problems} />
      <p>
        <WithIsland template={t.lead} name="phone" value={masked} />
      </p>
      {progress.developmentCode ? (
        <div className="notice notice-development" role="note">
          <h2>{t.developmentTitle}</h2>
          <p>
            <WithIsland template={t.developmentText} name="code" value={progress.developmentCode} />
          </p>
        </div>
      ) : null}
      <form className="form card" action={verifyCodeAction} noValidate>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="retryKey" value={randomUUID()} />
        <Field id="code" label={t.codeLabel} hint={t.codeHint} error={codeError}>
          <input
            id="code"
            name="code"
            className="input-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            maxLength={6}
            required
            aria-invalid={codeError ? true : undefined}
            aria-describedby={describedBy('code', true, Boolean(codeError))}
          />
        </Field>
        <button className="button button-primary" type="submit">
          {t.submit}
        </button>
      </form>
      <form className="form-inline" action={resendCodeAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="retryKey" value={randomUUID()} />
        <button className="button" type="submit">
          {t.resend}
        </button>
        <a className="button" href={`/${locale}/sign-in`}>
          {t.changeNumber}
        </a>
        <p className="form-note">{t.resendNote}</p>
      </form>
    </div>
  );
}
