import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../components/draft-keeper.tsx';
import { describedBy, ErrorSummary, Field, type Problem } from '../../../components/form.tsx';
import { Ltr } from '../../../components/ltr.tsx';
import { isLocale } from '../../../i18n/config.ts';
import { fill } from '../../../i18n/format.ts';
import { getMessages } from '../../../i18n/messages.ts';
import { registerAction } from '../../../server/actions.ts';
import { api, type Terms } from '../../../server/api.ts';
import { requirePerson } from '../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RegisterPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const t = m.auth.register;
  const errors = m.auth.errors;
  const { person } = await requirePerson(locale);
  if (person.registrationComplete) redirect(`/${locale}/account`);

  const terms = await api<Terms>('GET', `/registration/terms?language=${locale}`);
  const search = await searchParams;
  const codes = typeof search.error === 'string' ? search.error.split(',') : [];
  const fieldOf: Record<string, string> = {
    name: 'displayName',
    email: 'contactEmail',
    terms: 'termsSeen',
  };
  const problems: Problem[] = codes.map((code) => {
    const message = code in errors ? errors[code as keyof typeof errors] : errors.unavailable;
    return fieldOf[code] ? { field: fieldOf[code], message } : { message };
  });
  if (!terms.ok) problems.push({ message: errors.unavailable });
  const has = (code: string): boolean => codes.includes(code);

  return (
    <div className="page page-narrow">
      <h1>{t.title}</h1>
      <ErrorSummary title={errors.summary} problems={problems} />
      <p>
        {t.lead} <Ltr>{person.phoneMasked}</Ltr>
      </p>
      <form className="form card" id="register-form" action={registerAction} noValidate>
        <input type="hidden" name="locale" value={locale} />
        <Field
          id="displayName"
          label={t.nameLabel}
          hint={t.nameHint}
          error={has('name') ? errors.name : undefined}
        >
          <input
            id="displayName"
            name="displayName"
            type="text"
            autoComplete="name"
            maxLength={120}
            required
            data-draft
            aria-invalid={has('name') ? true : undefined}
            aria-describedby={describedBy('displayName', true, has('name'))}
          />
        </Field>
        <Field
          id="contactEmail"
          label={t.emailLabel}
          hint={t.emailHint}
          error={has('email') ? errors.email : undefined}
        >
          <input
            id="contactEmail"
            name="contactEmail"
            type="email"
            inputMode="email"
            autoComplete="email"
            dir="ltr"
            maxLength={254}
            data-draft
            aria-invalid={has('email') ? true : undefined}
            aria-describedby={describedBy('contactEmail', true, has('email'))}
          />
        </Field>
        {terms.ok ? (
          <section className="terms" aria-labelledby="terms-title">
            <h2 id="terms-title">{terms.data.title}</h2>
            <p className="terms-notice">{terms.data.notice}</p>
            {terms.data.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            <p className="form-note">
              {fill(t.termsVersion, { version: '' })}
              <Ltr>{terms.data.version}</Ltr>
            </p>
            <input type="hidden" name="termsVersion" value={terms.data.version} />
            <div className="check" data-invalid={has('terms') ? 'true' : undefined}>
              <input
                id="termsSeen"
                name="termsSeen"
                type="checkbox"
                value="yes"
                required
                data-draft
                aria-invalid={has('terms') ? true : undefined}
                aria-describedby={has('terms') ? 'termsSeen-error' : undefined}
              />
              <label htmlFor="termsSeen">{t.termsSeen}</label>
            </div>
            {has('terms') ? (
              <p className="field-error" id="termsSeen-error">
                {errors.terms}
              </p>
            ) : null}
          </section>
        ) : null}
        <button className="button button-primary" type="submit" disabled={!terms.ok}>
          {t.submit}
        </button>
      </form>
      <DraftKeeper formId="register-form" />
    </div>
  );
}
