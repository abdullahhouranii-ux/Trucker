import type { ReactNode } from 'react';
import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import type { Country, FleetDocument, FleetEligibility, FleetRegisters } from '../server/api.ts';
import { describedBy, Field } from './form.tsx';

// Shared pieces of the fleet and driver pages. Nothing here reserves or assigns anything: the
// eligibility shown is the answer at this moment, for this moment.

type F = Messages['fleet'];
type DocumentType = NonNullable<FleetRegisters['documentTypes']>[number];

/** Problem codes from the address, as field errors and summary messages. */
export function fleetProblems(
  t: F,
  error: string,
): { errors: Map<string, string>; summary: { field?: string; message: string }[] } {
  const errors = new Map<string, string>();
  const summary: { field?: string; message: string }[] = [];
  const e = t.errors as Record<string, string>;
  for (const part of error.split(',').filter(Boolean)) {
    const [field = '', code = ''] = part.split(':');
    const message = code === '' ? undefined : e[`${field}_${code}`];
    if (message) {
      errors.set(field, message);
      if (!summary.some((item) => item.message === message)) summary.push({ field, message });
    } else {
      const page = e[part] ?? (code === '' ? e.unavailable! : e.invalid!);
      if (!summary.some((item) => item.message === page)) summary.push({ message: page });
    }
  }
  return { errors, summary };
}

export function EligibilityTag({ t, value, id }: { t: F; value: FleetEligibility; id?: string }) {
  return (
    <p className="field-hint" id={id} data-eligibility={value}>
      <span className="chip">{value === 'eligible' ? t.eligibleNow : t.notEligibleNow}</span>{' '}
      {value === 'eligible' ? null : (t.eligibility as Record<string, string>)[value]}
    </p>
  );
}

const nameOf = (types: DocumentType[], code: string, locale: Locale): string =>
  types.find((type) => type.code === code)?.name[locale] ?? code;

export function DocumentList({
  t,
  locale,
  documents,
  types,
  id,
}: {
  t: F;
  locale: Locale;
  documents: FleetDocument[];
  types: DocumentType[];
  id: string;
}) {
  if (documents.length === 0) return <p id={`${id}-none`}>{t.noDocuments}</p>;
  return (
    <ul className="evidence" id={id}>
      {documents.map((document) => (
        <li key={document.id} data-document={document.type} data-status={document.status}>
          <bdi>{nameOf(types, document.type, locale)}</bdi>
          {document.documentNumber ? (
            <>
              {' '}
              <bdi dir="ltr">{document.documentNumber}</bdi>
            </>
          ) : null}
          : <span className="chip">{t.documentStatus[document.status]}</span>{' '}
          {t.expires.replace('{date}', '')}
          <bdi dir="ltr">{document.expiryDate}</bdi>
        </li>
      ))}
    </ul>
  );
}

function DateInput({ id, value, invalid }: { id: string; value?: string; invalid: boolean }) {
  return (
    <input
      id={id}
      name={id}
      type="text"
      dir="ltr"
      inputMode="numeric"
      maxLength={10}
      placeholder="YYYY-MM-DD"
      data-draft
      defaultValue={value ?? ''}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy(id, true, invalid)}
    />
  );
}

/** The fields of one document. The form element and its hidden inputs belong to the page. */
export function DocumentFields({
  t,
  locale,
  types,
  countries,
  licenceClasses,
  errors,
  submit,
}: {
  t: F;
  locale: Locale;
  types: DocumentType[];
  countries: Country[];
  licenceClasses: NonNullable<FleetRegisters['licenceClasses']>;
  errors: Map<string, string>;
  submit: ReactNode;
}) {
  const licence = types.some((type) => type.carriesLicence);
  return (
    <>
      <Field id="type" label={t.documentType} error={errors.get('type')}>
        <select id="type" name="type" defaultValue="" data-draft>
          <option value="">{t.chooseOne}</option>
          {types.map((type) => (
            <option key={type.code} value={type.code}>
              {type.name[locale]}
            </option>
          ))}
        </select>
      </Field>
      <Field id="documentNumber" label={t.documentNumber} error={errors.get('documentNumber')}>
        <input
          id="documentNumber"
          name="documentNumber"
          type="text"
          dir="ltr"
          autoComplete="off"
          maxLength={60}
          data-draft
          aria-invalid={errors.has('documentNumber') ? true : undefined}
          aria-describedby={describedBy('documentNumber', false, errors.has('documentNumber'))}
        />
      </Field>
      <Field id="issuingCountry" label={t.issuingCountry} error={errors.get('issuingCountry')}>
        <select id="issuingCountry" name="issuingCountry" defaultValue="" data-draft>
          <option value="">{t.chooseOne}</option>
          {countries.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name[locale]}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="expiryDate"
        label={t.expiryDate}
        hint={t.dateHint}
        error={errors.get('expiryDate')}
      >
        <DateInput id="expiryDate" invalid={errors.has('expiryDate')} />
      </Field>
      <Field id="issueDate" label={t.issueDate} hint={t.issueHint} error={errors.get('issueDate')}>
        <DateInput id="issueDate" invalid={errors.has('issueDate')} />
      </Field>
      {licence ? (
        <fieldset
          className="fieldset"
          id="licenceClasses"
          tabIndex={-1}
          data-invalid={errors.has('licenceClasses') ? 'true' : undefined}
        >
          <legend>{t.licenceClasses}</legend>
          <p className="field-hint">{t.licenceHint}</p>
          {errors.has('licenceClasses') ? (
            <p className="field-error" id="licenceClasses-error">
              {errors.get('licenceClasses')}
            </p>
          ) : null}
          {licenceClasses.map((item) => (
            <div className="check" key={item.code}>
              <input
                id={`licenceClass-${item.code}`}
                name="licenceClass"
                type="checkbox"
                value={item.code}
                data-draft
              />
              <label htmlFor={`licenceClass-${item.code}`}>{item.name[locale]}</label>
            </div>
          ))}
        </fieldset>
      ) : null}
      {submit}
    </>
  );
}
