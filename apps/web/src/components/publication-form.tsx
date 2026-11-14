import { describedBy, Field, type Problem } from './form.tsx';
import { offsetText } from './shipment-form.tsx';
import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import type { Catalogues, CatalogueEntry, Shipment } from '../server/api.ts';

type P = Messages['pub'];

/** Fields of publication, as `field` in the codes the actions put in the address. */
const PUBLICATION_FIELDS: Record<string, string> = {
  cargoCategory: 'cargoCategory',
  equipmentType: 'equipmentType',
  dangerousGoods: 'dangerousGoods-no',
  'pickup.area': 'pickupArea',
  'delivery.area': 'deliveryArea',
  quotationDeadline: 'deadlineDate',
};
const REASONS = [
  'required',
  'not_accepted',
  'unknown',
  'length',
  'invalid',
  'in_past',
  'too_soon',
  'after_pickup',
  'needs_pickup_zone',
  'time_invalid',
  'time_incomplete',
  'time_does_not_exist',
  'time_ambiguous',
] as const;

/** Whether a code in the address belongs to publication rather than to the draft's fields. */
export function isPublicationCode(part: string, t: P): boolean {
  const [field = '', reason = ''] = part.split(':');
  if (reason === '') return field in t.errors;
  return field in PUBLICATION_FIELDS || field === 'route';
}

export interface PublicationProblems {
  errors: Map<string, string>;
  /** Both offsets when the deadline's time occurs twice at the pick-up place. */
  deadlineOffsets: number[] | undefined;
  problems: Problem[];
  codes: Set<string>;
}

/** Turns publication codes into field errors and page messages. */
export function publicationProblems(
  parts: string[],
  t: P,
  values: Record<string, string> = {},
): PublicationProblems {
  const errors = new Map<string, string>();
  const problems: Problem[] = [];
  const codes = new Set<string>();
  let deadlineOffsets: number[] | undefined;
  const label: Record<string, string> = {
    cargoCategory: t.cargoCategory,
    equipmentType: t.equipmentType,
    'dangerousGoods-no': t.dangerousGoods,
    pickupArea: t.pickupArea,
    deliveryArea: t.deliveryArea,
    deadlineDate: t.deadline,
  };
  for (const part of parts) {
    const [field = '', reason = '', ...rest] = part.split(':');
    if (reason === '') {
      let message: string = t.errors[field as keyof P['errors']] ?? t.errors.unavailable;
      for (const [name, value] of Object.entries(values))
        message = message.replace(`{${name}}`, value);
      codes.add(field);
      if (!problems.some((problem) => problem.message === message)) problems.push({ message });
      continue;
    }
    if (field === 'route') {
      problems.push({ message: t.errors.not_open });
      continue;
    }
    const input = PUBLICATION_FIELDS[field];
    if (!input) continue;
    const known = (REASONS as readonly string[]).includes(reason)
      ? (reason as (typeof REASONS)[number])
      : reason === 'required_to_publish'
        ? 'required'
        : 'invalid';
    let message: string = t.errors[known];
    if (known === 'too_soon') message = message.replace('{minutes}', rest[0] ?? '');
    if (known === 'time_ambiguous') {
      const offsets = rest.map(Number).filter((offset) => Number.isInteger(offset));
      if (offsets.length === 2) deadlineOffsets = offsets;
    }
    if (!errors.has(input)) {
      errors.set(input, message);
      problems.push({ field: input, message: `${label[input]}: ${message}` });
    }
  }
  return { errors, deadlineOffsets, problems, codes };
}

function CatalogueSelect({
  id,
  label,
  locale,
  t,
  entries,
  value,
  error,
}: {
  id: string;
  label: string;
  locale: Locale;
  t: P;
  entries: CatalogueEntry[];
  value: string | null;
  error: string | undefined;
}) {
  // A value the shipment already has stays selectable even if it is no longer offered.
  const options =
    value && !entries.some((entry) => entry.code === value)
      ? [...entries, { code: value, name: { en: value, ar: value, ur: value } }]
      : entries;
  return (
    <Field id={id} label={label} error={error}>
      <select
        id={id}
        name={id}
        required
        data-draft
        defaultValue={value ?? ''}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, false, Boolean(error))}
      >
        <option value="">{t.chooseOne}</option>
        {options.map((entry) => (
          <option key={entry.code} value={entry.code}>
            {entry.name[locale]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The details publication needs beyond the draft. */
export function PublicationFields({
  locale,
  t,
  catalogues,
  current,
  problems,
  deadlineOnly = false,
}: {
  locale: Locale;
  t: P;
  catalogues: Catalogues;
  current: Shipment;
  problems: PublicationProblems;
  /** Only the deadline: for publishing an expired shipment again. */
  deadlineOnly?: boolean;
}) {
  const { errors } = problems;
  const p = current.publication;
  const zone = current.pickup.timeZone;
  const deadlineError = errors.get('deadlineDate');
  const [date = '', time = ''] = (deadlineOnly ? '' : (p.quotationDeadline.local ?? '')).split('T');
  const offsets =
    problems.deadlineOffsets ??
    (deadlineOnly ? undefined : (p.quotationDeadline.offsetChoices ?? undefined));
  const text = (id: string, label: string, value: string | null, hint?: string) => (
    <Field id={id} label={label} hint={hint} error={errors.get(id)}>
      <input
        id={id}
        name={id}
        type="text"
        dir="auto"
        maxLength={120}
        data-draft
        defaultValue={value ?? ''}
        aria-invalid={errors.has(id) ? true : undefined}
        aria-describedby={describedBy(id, Boolean(hint), errors.has(id))}
      />
    </Field>
  );
  return (
    <>
      {deadlineOnly ? null : (
        <>
          <CatalogueSelect
            id="cargoCategory"
            label={t.cargoCategory}
            locale={locale}
            t={t}
            entries={catalogues.cargoCategories}
            value={p.cargoCategory}
            error={errors.get('cargoCategory')}
          />
          <CatalogueSelect
            id="equipmentType"
            label={t.equipmentType}
            locale={locale}
            t={t}
            entries={catalogues.equipmentTypes}
            value={p.equipmentType}
            error={errors.get('equipmentType')}
          />
          <fieldset
            className="fieldset"
            aria-describedby={`dangerousGoods-hint${errors.has('dangerousGoods-no') ? ' dangerousGoods-error' : ''}`}
            data-invalid={errors.has('dangerousGoods-no') ? 'true' : undefined}
          >
            <legend>{t.dangerousGoods}</legend>
            <p className="field-hint" id="dangerousGoods-hint">
              {t.dangerousHint}
            </p>
            {(['no', 'yes'] as const).map((answer) => (
              <div className="check" key={answer}>
                <input
                  id={`dangerousGoods-${answer}`}
                  name="dangerousGoods"
                  type="radio"
                  value={answer}
                  data-draft
                  defaultChecked={
                    p.dangerousGoods === null ? false : p.dangerousGoods === (answer === 'yes')
                  }
                />
                <label htmlFor={`dangerousGoods-${answer}`}>
                  {answer === 'yes' ? t.dangerousYes : t.dangerousNo}
                </label>
              </div>
            ))}
            {errors.has('dangerousGoods-no') ? (
              <p className="field-error" id="dangerousGoods-error">
                {errors.get('dangerousGoods-no')}
              </p>
            ) : null}
          </fieldset>
          {text('pickupArea', t.pickupArea, p.pickupArea, t.areaHint)}
          {text('deliveryArea', t.deliveryArea, p.deliveryArea, t.areaHint)}
        </>
      )}
      <fieldset className="fieldset" data-invalid={deadlineError ? 'true' : undefined}>
        <legend>{t.deadline}</legend>
        <p className="field-hint" id="deadline-hint">
          {zone ? t.deadlineHint.replace('{zone}', zone) : t.deadlineNoZone}
        </p>
        <div className="field-pair">
          <div className="field">
            <label htmlFor="deadlineDate">{t.date}</label>
            <input
              id="deadlineDate"
              name="deadlineDate"
              type="text"
              dir="ltr"
              inputMode="numeric"
              maxLength={10}
              data-draft
              defaultValue={date}
              aria-invalid={deadlineError ? true : undefined}
              aria-describedby={`deadline-hint${deadlineError ? ' deadlineDate-error' : ''}`}
            />
          </div>
          <div className="field">
            <label htmlFor="deadlineTime">{t.time}</label>
            <input
              id="deadlineTime"
              name="deadlineTime"
              type="text"
              dir="ltr"
              inputMode="numeric"
              maxLength={5}
              data-draft
              defaultValue={time}
              aria-invalid={deadlineError ? true : undefined}
              aria-describedby={`deadline-hint${deadlineError ? ' deadlineDate-error' : ''}`}
            />
          </div>
        </div>
        {deadlineError ? (
          <p className="field-error" id="deadlineDate-error">
            {deadlineError}
          </p>
        ) : null}
        {offsets ? (
          <Field id="deadlineOffset" label={t.offsetChoice}>
            <select id="deadlineOffset" name="deadlineOffset" data-draft defaultValue="">
              <option value="">{t.offsetChoose}</option>
              {offsets.map((offset) => (
                <option key={offset} value={offset}>
                  {offsetText(offset)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </fieldset>
    </>
  );
}
