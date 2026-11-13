import { describedBy, Field } from './form.tsx';
import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import type { Country, Organisation } from '../server/api.ts';

/** The fields of an organisation, for creating one and for changing a draft. */
export function OrganisationFields({
  locale,
  t,
  countries,
  current,
  invalid,
}: {
  locale: Locale;
  t: Messages['org'];
  countries: Country[];
  current?: Organisation;
  invalid: Set<string>;
}) {
  const error = (name: keyof Messages['org']['errors']): string | undefined =>
    invalid.has(name) ? t.errors[name] : undefined;
  return (
    <>
      <Field id="legalName" label={t.legalName} hint={t.legalNameHint} error={error('legalName')}>
        <input
          id="legalName"
          name="legalName"
          type="text"
          dir="auto"
          autoComplete="organization"
          maxLength={200}
          required
          data-draft
          defaultValue={current?.legalName ?? ''}
          aria-invalid={invalid.has('legalName') ? true : undefined}
          aria-describedby={describedBy('legalName', true, invalid.has('legalName'))}
        />
      </Field>
      <Field id="tradingName" label={t.tradingName} error={error('tradingName')}>
        <input
          id="tradingName"
          name="tradingName"
          type="text"
          dir="auto"
          maxLength={200}
          data-draft
          defaultValue={current?.tradingName ?? ''}
          aria-invalid={invalid.has('tradingName') ? true : undefined}
          aria-describedby={describedBy('tradingName', false, invalid.has('tradingName'))}
        />
      </Field>
      <Field id="countryCode" label={t.country} hint={t.countryNote} error={error('countryCode')}>
        <select
          id="countryCode"
          name="countryCode"
          required
          data-draft
          defaultValue={current?.countryCode ?? ''}
          aria-invalid={invalid.has('countryCode') ? true : undefined}
          aria-describedby={describedBy('countryCode', true, invalid.has('countryCode'))}
        >
          <option value="">{t.countryChoose}</option>
          {countries.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name[locale]}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="registrationNumber"
        label={t.registrationNumber}
        hint={t.registrationNumberHint}
        error={error('registrationNumber')}
      >
        <input
          id="registrationNumber"
          name="registrationNumber"
          type="text"
          dir="ltr"
          maxLength={60}
          required
          data-draft
          defaultValue={current?.registrationNumber ?? ''}
          aria-invalid={invalid.has('registrationNumber') ? true : undefined}
          aria-describedby={describedBy(
            'registrationNumber',
            true,
            invalid.has('registrationNumber'),
          )}
        />
      </Field>
      <Field id="address" label={t.address} error={error('address')}>
        <textarea
          id="address"
          name="address"
          dir="auto"
          maxLength={500}
          rows={3}
          data-draft
          defaultValue={current?.address ?? ''}
          aria-invalid={invalid.has('address') ? true : undefined}
          aria-describedby={describedBy('address', false, invalid.has('address'))}
        />
      </Field>
      <Field id="contactName" label={t.contactName} error={error('contactName')}>
        <input
          id="contactName"
          name="contactName"
          type="text"
          dir="auto"
          autoComplete="name"
          maxLength={120}
          data-draft
          defaultValue={current?.contactName ?? ''}
          aria-invalid={invalid.has('contactName') ? true : undefined}
          aria-describedby={describedBy('contactName', false, invalid.has('contactName'))}
        />
      </Field>
    </>
  );
}

const FIELD_NAMES = [
  'legalName',
  'tradingName',
  'countryCode',
  'registrationNumber',
  'address',
  'contactName',
] as const;

/** Splits the error codes in the address into field problems and page problems. */
export function organisationProblems(
  code: string | undefined,
  t: Messages['org'],
  fallback: string,
  values: Record<string, string> = {},
): { invalid: Set<string>; problems: { field?: string; message: string }[] } {
  const invalid = new Set<string>();
  const problems: { field?: string; message: string }[] = [];
  for (const part of (code ?? '').split(',').filter(Boolean)) {
    if ((FIELD_NAMES as readonly string[]).includes(part)) {
      invalid.add(part);
      problems.push({ field: part, message: t.errors[part as (typeof FIELD_NAMES)[number]] });
    } else if (part in t.errors) {
      let message: string = t.errors[part as keyof typeof t.errors];
      for (const [name, value] of Object.entries(values))
        message = message.replace(`{${name}}`, value);
      problems.push({ message });
    } else problems.push({ message: fallback });
  }
  return { invalid, problems };
}
