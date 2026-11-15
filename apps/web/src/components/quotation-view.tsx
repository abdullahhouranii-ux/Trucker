import { describedBy, Field } from './form.tsx';
import { Ltr } from './ltr.tsx';
import { offsetText } from './shipment-form.tsx';
import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import type {
  Quotation,
  QuotationMoment,
  QuotationTerms,
  QuotationVersion,
} from '../server/api.ts';

type Q = Messages['quo'];

/** A time at the pick-up place, with its zone and offset, read left to right. */
export function MomentText({ value }: { value: QuotationMoment }) {
  return (
    <Ltr>
      {value.local.replace('T', ' ')} ({value.timeZone}, {offsetText(value.offsetMinutes)})
    </Ltr>
  );
}

/** An amount exactly as the server wrote it, with its currency, read left to right. */
export function AmountText({ version }: { version: QuotationVersion }) {
  return (
    <Ltr>
      {version.amount} {version.currency}
    </Ltr>
  );
}

const inclusionName = (terms: QuotationTerms | null, code: string, locale: Locale): string =>
  terms?.inclusions.find((item) => item.code === code)?.name[locale] ?? code;

/** One version of a quotation as facts. */
export function QuotationFacts({
  t,
  locale,
  terms,
  version,
  id,
}: {
  t: Q;
  locale: Locale;
  terms: QuotationTerms | null;
  version: QuotationVersion;
  id: string;
}) {
  return (
    <dl className="facts" id={id} data-version={version.versionNo}>
      <div>
        <dt>{t.amount}</dt>
        <dd data-amount={version.amount}>
          <AmountText version={version} />
        </dd>
      </div>
      {Object.entries(version.inclusions).map(([code, included]) => (
        <div key={code} data-inclusion={code}>
          <dt>
            <bdi>{inclusionName(terms, code, locale)}</bdi>
          </dt>
          <dd>{included ? t.included : t.notIncluded}</dd>
        </div>
      ))}
      <div>
        <dt>{t.validUntil}</dt>
        <dd>
          <MomentText value={version.validUntil} />
        </dd>
      </div>
      <div>
        <dt>{t.earliestPickup}</dt>
        <dd>
          <MomentText value={version.earliestPickup} />
        </dd>
      </div>
      {version.notes ? (
        <div>
          <dt>{t.notes}</dt>
          <dd>
            <bdi>{version.notes}</bdi>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Where a quotation stands, as text and as a data attribute for checks. */
export function Standing({ t, quotation }: { t: Q; quotation: Quotation }) {
  return (
    <p className="chip" data-standing={quotation.standing}>
      {t.standing[quotation.standing]}
    </p>
  );
}

/** Date and time inputs for a moment at the pick-up place. */
function MomentFields({
  name,
  legend,
  hint,
  t,
  value,
  error,
}: {
  name: 'validUntil' | 'earliestPickup';
  legend: string;
  hint: string;
  t: Q;
  value: string;
  error: string | undefined;
}) {
  const [date = '', time = ''] = value.split('T');
  const describe = `${name}-hint${error ? ` ${name}Date-error` : ''}`;
  return (
    <fieldset className="fieldset" data-invalid={error ? 'true' : undefined}>
      <legend>{legend}</legend>
      <p className="field-hint" id={`${name}-hint`}>
        {hint}
      </p>
      <div className="field-pair">
        <div className="field">
          <label htmlFor={`${name}Date`}>{t.date}</label>
          <input
            id={`${name}Date`}
            name={`${name}Date`}
            type="text"
            dir="ltr"
            inputMode="numeric"
            maxLength={10}
            placeholder="YYYY-MM-DD"
            data-draft
            defaultValue={date}
            aria-invalid={error ? true : undefined}
            aria-describedby={describe}
          />
        </div>
        <div className="field">
          <label htmlFor={`${name}Time`}>{t.time}</label>
          <input
            id={`${name}Time`}
            name={`${name}Time`}
            type="text"
            dir="ltr"
            inputMode="numeric"
            maxLength={5}
            placeholder="HH:MM"
            data-draft
            defaultValue={time}
            aria-invalid={error ? true : undefined}
            aria-describedby={describe}
          />
        </div>
      </div>
      {error ? (
        <p className="field-error" id={`${name}Date-error`}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** The fields of a quotation: amount, an answer for every inclusion, validity, pick-up, notes. */
export function QuotationFields({
  t,
  locale,
  terms,
  current,
  errors,
  zone,
  deadline,
  window,
}: {
  t: Q;
  locale: Locale;
  terms: QuotationTerms;
  current: QuotationVersion | undefined;
  errors: Map<string, string>;
  zone: string;
  deadline: string;
  window: { from: string; until: string };
}) {
  const fill = (template: string, values: Record<string, string | number>): string =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, String(value)),
      template,
    );
  return (
    <>
      <Field
        id="amount"
        label={`${t.amount} (${terms.currency})`}
        hint={fill(t.amountHint, { currency: terms.currency, n: terms.minorUnits })}
        error={errors.get('amount')}
      >
        <input
          id="amount"
          name="amount"
          type="text"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          maxLength={16}
          data-draft
          defaultValue={current?.amount ?? ''}
          aria-invalid={errors.has('amount') ? true : undefined}
          aria-describedby={describedBy('amount', true, errors.has('amount'))}
        />
      </Field>
      <p className="field-hint" id="tax-note">
        {t.taxNote}
      </p>
      <fieldset className="fieldset" id="inclusions">
        <legend>{t.inclusionsTitle}</legend>
        <p className="field-hint">{t.inclusionsLead}</p>
        {terms.inclusions.map((item) => {
          const field = `inc-${item.code}`;
          const error = errors.get(field);
          const answered = current?.inclusions[item.code];
          return (
            <fieldset
              className="fieldset"
              key={item.code}
              id={field}
              tabIndex={-1}
              data-invalid={error ? 'true' : undefined}
              aria-describedby={error ? `${field}-error` : undefined}
            >
              <input type="hidden" name="inclusionCode" value={item.code} />
              <legend>
                <bdi>{item.name[locale]}</bdi>
              </legend>
              {error ? (
                <p className="field-error" id={`${field}-error`}>
                  {error}
                </p>
              ) : null}
              {(['yes', 'no'] as const).map((answer) => (
                <div className="check" key={answer}>
                  <input
                    id={`${field}-${answer}`}
                    name={field}
                    type="radio"
                    value={answer}
                    data-draft
                    defaultChecked={
                      answered === undefined ? false : answered === (answer === 'yes')
                    }
                  />
                  <label htmlFor={`${field}-${answer}`}>
                    {answer === 'yes' ? t.included : t.notIncluded}
                  </label>
                </div>
              ))}
            </fieldset>
          );
        })}
      </fieldset>
      <MomentFields
        name="validUntil"
        legend={t.validUntil}
        hint={fill(t.validUntilHint, { zone, deadline: deadline.replace('T', ' ') })}
        t={t}
        value={current?.validUntil.local ?? ''}
        error={errors.get('validUntilDate')}
      />
      <MomentFields
        name="earliestPickup"
        legend={t.earliestPickup}
        hint={fill(t.earliestPickupHint, {
          zone,
          from: window.from.replace('T', ' '),
          until: window.until.replace('T', ' '),
        })}
        t={t}
        value={current?.earliestPickup.local ?? ''}
        error={errors.get('earliestPickupDate')}
      />
      <Field id="notes" label={t.notes} hint={t.notesHint} error={errors.get('notes')}>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={1000}
          dir="auto"
          data-draft
          defaultValue={current?.notes ?? ''}
          aria-invalid={errors.has('notes') ? true : undefined}
          aria-describedby={describedBy('notes', true, errors.has('notes'))}
        />
      </Field>
    </>
  );
}

/** Problem codes from the address, as field errors and summary messages. */
export function quotationProblems(
  t: Q,
  error: string,
  terms: QuotationTerms | null,
  locale: Locale,
): { errors: Map<string, string>; summary: { field?: string; message: string }[] } {
  const errors = new Map<string, string>();
  const summary: { field?: string; message: string }[] = [];
  const add = (field: string | undefined, message: string) => {
    if (field) errors.set(field, message);
    if (!summary.some((item) => item.message === message))
      summary.push(field ? { field, message } : { message });
  };
  const e = t.errors as Record<string, string>;
  for (const part of error.split(',').filter(Boolean)) {
    const [field = '', code = '', extra = ''] = part.split(':');
    const inclusion = /^inclusions\.([a-z][a-z0-9_]*)$/.exec(field);
    if (inclusion) {
      const code1 = inclusion[1]!;
      add(
        `inc-${code1}`,
        e.inclusion_required!.replace('{name}', inclusionName(terms, code1, locale)),
      );
    } else if (field === 'inclusions') add('inclusions', e.inclusions_unknown!);
    else if (field === 'amount')
      add('amount', (e[`amount_${code}`] ?? e.amount_invalid!).replace('{n}', extra));
    else if (field === 'validUntil')
      add(
        'validUntilDate',
        (e[`validUntil_${code}`] ?? e.validUntil_required!).replace('{n}', extra),
      );
    else if (field === 'earliestPickup')
      add('earliestPickupDate', e[`earliestPickup_${code}`] ?? e.earliestPickup_required!);
    else if (field === 'notes') add('notes', e.notes_length!);
    else if (field === 'currency') add('currency', e.currency_unavailable!);
    else add(undefined, e[part] ?? e.unavailable!);
  }
  return { errors, summary };
}
