import { describedBy, Field } from './form.tsx';
import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import type { Country, EvidenceEntry, VerificationRequirement } from '../server/api.ts';

/**
 * One fieldset per document a requirement asks about, with what the last version said so a
 * correction is not a retyping. The entries are declared by the applicant, never verified.
 */
export function EvidenceFields({
  locale,
  t,
  requirements,
  previous,
  countries,
  defaultCountry,
  invalid,
}: {
  locale: Locale;
  t: Messages['verify'];
  requirements: VerificationRequirement[];
  previous: EvidenceEntry[];
  countries: Country[];
  defaultCountry: string;
  invalid: Map<string, string>;
}) {
  const has = (field: string): boolean => invalid.has(field);
  return (
    <>
      {requirements.map((requirement) => {
        const type = requirement.documentType;
        const number = `ev-${type}-documentNumber`;
        const issuer = `ev-${type}-issuingCountry`;
        const issued = `ev-${type}-issuedOn`;
        const expires = `ev-${type}-expiresOn`;
        const before = previous.find((entry) => entry.documentType === type);
        return (
          <fieldset className="fieldset" key={type} id={`ev-${type}`}>
            <legend>
              <bdi>{requirement.name[locale]}</bdi> (
              {requirement.required ? t.required : t.optional})
            </legend>
            <input type="hidden" name="documentType" value={type} />
            <input
              type="hidden"
              name={`ev-${type}-required`}
              value={requirement.required ? 'yes' : 'no'}
            />
            <Field id={number} label={t.documentNumber} error={invalid.get(number)}>
              <input
                id={number}
                name={number}
                type="text"
                dir="ltr"
                maxLength={80}
                required={requirement.required}
                data-draft
                defaultValue={before?.documentNumber ?? ''}
                aria-invalid={has(number) ? true : undefined}
                aria-describedby={describedBy(number, false, has(number))}
              />
            </Field>
            <Field id={issuer} label={t.issuingCountry} error={invalid.get(issuer)}>
              <select
                id={issuer}
                name={issuer}
                data-draft
                defaultValue={before?.issuingCountry ?? defaultCountry}
                aria-invalid={has(issuer) ? true : undefined}
                aria-describedby={describedBy(issuer, false, has(issuer))}
              >
                {countries.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name[locale]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="field-pair">
              <Field id={issued} label={t.issuedOn} error={invalid.get(issued)}>
                <input
                  id={issued}
                  name={issued}
                  type="date"
                  dir="ltr"
                  data-draft
                  defaultValue={before?.issuedOn ?? ''}
                  aria-invalid={has(issued) ? true : undefined}
                  aria-describedby={describedBy(issued, false, has(issued))}
                />
              </Field>
              <Field id={expires} label={t.expiresOn} error={invalid.get(expires)}>
                <input
                  id={expires}
                  name={expires}
                  type="date"
                  dir="ltr"
                  data-draft
                  defaultValue={before?.expiresOn ?? ''}
                  aria-invalid={has(expires) ? true : undefined}
                  aria-describedby={describedBy(expires, false, has(expires))}
                />
              </Field>
            </div>
          </fieldset>
        );
      })}
    </>
  );
}

/** The declaration of authority, with its error. */
export function DeclarationField({
  t,
  invalid,
}: {
  t: Messages['verify'];
  invalid: Map<string, string>;
}) {
  const has = invalid.has('declaration');
  return (
    <>
      <h3>{t.declarationTitle}</h3>
      <p id="declaration-text">{t.declarationText}</p>
      <div className="check" data-invalid={has ? 'true' : undefined}>
        <input
          id="declaration"
          name="declaration"
          type="checkbox"
          value="yes"
          required
          aria-invalid={has ? true : undefined}
          aria-describedby={has ? 'declaration-text declaration-error' : 'declaration-text'}
        />
        <label htmlFor="declaration">{t.declarationCheck}</label>
      </div>
      {has ? (
        <p className="field-error" id="declaration-error">
          {t.errors.declaration}
        </p>
      ) : null}
    </>
  );
}
