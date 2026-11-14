import type { ReactNode } from 'react';
import { describedBy, Field, type Problem } from './form.tsx';
import { Ltr } from './ltr.tsx';
import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import type { PlaceOption, Shipment, ShipmentPlace, WindowEnd } from '../server/api.ts';

type T = Messages['ship'];
type PlaceName = 'pickup' | 'delivery';
type EndName = 'from' | 'until';

/** What the address said went wrong, sorted for the form. */
export interface ShipmentProblems {
  /** Message by input id. */
  errors: Map<string, string>;
  /** Both offsets of each time that occurs twice, by `pickup.from` and so on. */
  ambiguous: Map<string, number[]>;
  problems: Problem[];
  /** Page-level codes that were recognised. */
  codes: Set<string>;
}

const capital = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
/** The input a reported field belongs to. */
function inputOf(field: string): string | undefined {
  const [first, second] = field.split('.');
  if (first !== 'pickup' && first !== 'delivery') return first;
  switch (second) {
    case 'address':
      return `${first}Address`;
    case 'countryCode':
      return `${first}Country`;
    case 'timeZone':
      return `${first}Zone`;
    case 'accessNotes':
      return `${first}AccessNotes`;
    case 'from':
      return `${first}FromDate`;
    case 'until':
      return `${first}UntilDate`;
    default:
      return undefined;
  }
}

/** The label of an input, for the summary of problems. */
function labelOf(input: string, t: T): string {
  const plain: Record<string, string> = {
    shipperReference: t.shipperReference,
    cargoDescription: t.cargoDescription,
    grossWeightKg: t.grossWeightKg,
    pieces: t.pieces,
    packaging: t.packaging,
    equipmentNeeded: t.equipmentNeeded,
  };
  if (plain[input]) return plain[input];
  const section = input.startsWith('pickup') ? t.sectionPickup : t.sectionDelivery;
  const rest = input.replace(/^(pickup|delivery)/, '');
  const part: Record<string, string> = {
    Address: t.address,
    Country: t.country,
    Zone: t.timeZone,
    AccessNotes: t.accessNotes,
    FromDate: t.windowFrom,
    UntilDate: t.windowUntil,
  };
  return `${section}, ${part[rest] ?? rest}`;
}

const FIELD_CODES = [
  'length',
  'invalid',
  'country_unavailable',
  'zone_not_configured',
  'zone_needs_country',
  'time_invalid',
  'time_incomplete',
  'time_does_not_exist',
  'time_ambiguous',
  'window_order',
  'delivery_before_pickup',
  'required_to_publish',
  'in_past',
] as const;

/** Splits the codes in the address into field problems and page problems. */
export function shipmentProblems(
  code: string | undefined,
  t: T,
  fallback: string,
  values: Record<string, string> = {},
): ShipmentProblems {
  const errors = new Map<string, string>();
  const ambiguous = new Map<string, number[]>();
  const problems: Problem[] = [];
  const codes = new Set<string>();
  for (const part of (code ?? '').split(',').filter(Boolean)) {
    const [field = '', reason = '', ...rest] = part.split(':');
    const input = reason === '' ? undefined : inputOf(field);
    if (input && labelOf(input, t)) {
      const message =
        reason === 'out_of_range' && (input === 'grossWeightKg' || input === 'pieces')
          ? t.errors[input]
          : (FIELD_CODES as readonly string[]).includes(reason)
            ? t.errors[reason as (typeof FIELD_CODES)[number]]
            : t.errors.invalid;
      if (reason === 'time_ambiguous') {
        const offsets = rest.map(Number).filter((offset) => Number.isInteger(offset));
        if (offsets.length === 2) ambiguous.set(field, offsets);
      }
      if (!errors.has(input)) {
        errors.set(input, message);
        problems.push({ field: input, message: `${labelOf(input, t)}: ${message}` });
      }
    } else if (reason === '' && field in t.errors) {
      let message: string = t.errors[field as keyof T['errors']];
      for (const [name, value] of Object.entries(values))
        message = message.replace(`{${name}}`, value);
      codes.add(field);
      problems.push({ message });
    } else if (!problems.some((problem) => problem.message === fallback))
      problems.push({ message: fallback });
  }
  return { errors, ambiguous, problems, codes };
}

/** An offset from UTC as it is written, kept left to right inside any text. */
export const offsetText = (minutes: number): string => {
  const size = Math.abs(minutes);
  const hours = String(Math.floor(size / 60)).padStart(2, '0');
  const rest = String(size % 60).padStart(2, '0');
  return `⁦UTC${minutes < 0 ? '-' : '+'}${hours}:${rest}⁩`;
};

function TextField({
  id,
  label,
  hint,
  errors,
  value,
  maxLength,
  rows,
  ltr = false,
  numeric = false,
  suffix,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  errors: Map<string, string>;
  value: string;
  maxLength: number;
  rows?: number;
  ltr?: boolean;
  numeric?: boolean;
  suffix?: string;
}) {
  const error = errors.get(id);
  const shared = {
    id,
    name: id,
    dir: ltr ? 'ltr' : 'auto',
    maxLength,
    'data-draft': true,
    defaultValue: value,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy(id, Boolean(hint), Boolean(error)),
  } as const;
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {rows ? (
        <textarea {...shared} rows={rows} />
      ) : suffix ? (
        <span className="input-unit">
          <input {...shared} type="text" inputMode={numeric ? 'decimal' : undefined} />
          <span aria-hidden="true">{suffix}</span>
        </span>
      ) : (
        <input {...shared} type="text" inputMode={numeric ? 'numeric' : undefined} />
      )}
    </Field>
  );
}

function WindowEndFields({
  place,
  end,
  t,
  label,
  current,
  errors,
  choices,
}: {
  place: PlaceName;
  end: EndName;
  t: T;
  label: string;
  current: WindowEnd | undefined;
  errors: Map<string, string>;
  /** Both offsets when this time occurs twice: the choice is then asked for. */
  choices: number[] | undefined;
}) {
  const prefix = `${place}${capital(end)}`;
  const dateId = `${prefix}Date`;
  const timeId = `${prefix}Time`;
  const offsetId = `${prefix}Offset`;
  const error = errors.get(dateId);
  const [date = '', time = ''] = (current?.local ?? '').split('T');
  const described = describedBy(dateId, false, Boolean(error));
  return (
    <div className="window-end" data-invalid={error ? 'true' : undefined}>
      <div className="field-pair">
        <div className="field">
          <label htmlFor={dateId}>
            {label}: {t.date}
          </label>
          <input
            id={dateId}
            name={dateId}
            type="text"
            dir="ltr"
            inputMode="numeric"
            maxLength={10}
            data-draft
            defaultValue={date}
            aria-invalid={error ? true : undefined}
            aria-describedby={described}
          />
        </div>
        <div className="field">
          <label htmlFor={timeId}>
            {label}: {t.time}
          </label>
          <input
            id={timeId}
            name={timeId}
            type="text"
            dir="ltr"
            inputMode="numeric"
            maxLength={5}
            data-draft
            defaultValue={time}
            aria-invalid={error ? true : undefined}
            aria-describedby={described}
          />
        </div>
      </div>
      {error ? (
        <p className="field-error" id={`${dateId}-error`}>
          {error}
        </p>
      ) : null}
      {choices ? (
        <Field id={offsetId} label={`${label}: ${t.offsetChoice}`}>
          <select
            id={offsetId}
            name={offsetId}
            data-draft
            defaultValue={
              current?.offsetMinutes !== null &&
              current?.offsetMinutes !== undefined &&
              choices.includes(current.offsetMinutes)
                ? String(current.offsetMinutes)
                : ''
            }
          >
            <option value="">{t.offsetChoose}</option>
            {choices.map((offset) => (
              <option key={offset} value={offset}>
                {t.offsetOption.replace('{offset}', offsetText(offset))}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
    </div>
  );
}

function PlaceFields({
  place,
  locale,
  t,
  title,
  places,
  current,
  problems,
}: {
  place: PlaceName;
  locale: Locale;
  t: T;
  title: string;
  places: PlaceOption[];
  current: ShipmentPlace | undefined;
  problems: ShipmentProblems;
}) {
  const { errors, ambiguous } = problems;
  const countryId = `${place}Country`;
  const zoneId = `${place}Zone`;
  const choices = (end: EndName): number[] | undefined =>
    ambiguous.get(`${place}.${end}`) ?? current?.[end].offsetChoices ?? undefined;
  return (
    <fieldset className="fieldset" id={`${place}-fields`}>
      <legend>{title}</legend>
      <TextField
        id={`${place}Address`}
        label={t.address}
        errors={errors}
        value={current?.address ?? ''}
        maxLength={500}
        rows={3}
      />
      <Field id={countryId} label={t.country} error={errors.get(countryId)}>
        <select
          id={countryId}
          name={countryId}
          data-draft
          defaultValue={current?.countryCode ?? ''}
          aria-invalid={errors.has(countryId) ? true : undefined}
          aria-describedby={describedBy(countryId, false, errors.has(countryId))}
        >
          <option value="">{t.countryChoose}</option>
          {places.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name[locale]}
            </option>
          ))}
        </select>
      </Field>
      <Field id={zoneId} label={t.timeZone} hint={t.timeZoneHint} error={errors.get(zoneId)}>
        <select
          id={zoneId}
          name={zoneId}
          dir="ltr"
          data-draft
          defaultValue={current?.timeZone ?? ''}
          aria-invalid={errors.has(zoneId) ? true : undefined}
          aria-describedby={describedBy(zoneId, true, errors.has(zoneId))}
        >
          <option value="">{t.timeZoneChoose}</option>
          {places
            .filter((country) => country.timeZones.length > 0)
            .map((country) => (
              <optgroup key={country.code} label={country.name[locale]}>
                {country.timeZones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </Field>
      <p className="field-hint" id={`${place}-time-hint`}>
        {t.dateHint
          .split(/(\{date\}|\{time\})/)
          .map((part) =>
            part === '{date}' ? (
              <Ltr key={part}>2026-07-01</Ltr>
            ) : part === '{time}' ? (
              <Ltr key={part}>09:30</Ltr>
            ) : (
              part
            ),
          )}
      </p>
      <WindowEndFields
        place={place}
        end="from"
        t={t}
        label={t.windowFrom}
        current={current?.from}
        errors={errors}
        choices={choices('from')}
      />
      <WindowEndFields
        place={place}
        end="until"
        t={t}
        label={t.windowUntil}
        current={current?.until}
        errors={errors}
        choices={choices('until')}
      />
      <TextField
        id={`${place}AccessNotes`}
        label={t.accessNotes}
        errors={errors}
        value={current?.accessNotes ?? ''}
        maxLength={1000}
        rows={3}
      />
    </fieldset>
  );
}

/** The fields of a shipment draft, for saving a new one and for changing one. */
export function ShipmentFields({
  locale,
  t,
  places,
  current,
  problems,
}: {
  locale: Locale;
  t: T;
  places: PlaceOption[];
  current?: Shipment;
  problems: ShipmentProblems;
}) {
  const { errors } = problems;
  return (
    <>
      <fieldset className="fieldset" id="cargo-fields">
        <legend>{t.sectionCargo}</legend>
        <p className="field-hint">{t.rulesNote}</p>
        <TextField
          id="shipperReference"
          label={t.shipperReference}
          errors={errors}
          value={current?.shipperReference ?? ''}
          maxLength={64}
          ltr
        />
        <TextField
          id="cargoDescription"
          label={t.cargoDescription}
          errors={errors}
          value={current?.cargoDescription ?? ''}
          maxLength={2000}
          rows={4}
        />
        <TextField
          id="grossWeightKg"
          label={t.grossWeightKg}
          hint={t.grossWeightHint}
          errors={errors}
          value={current?.grossWeightKg ?? ''}
          maxLength={12}
          ltr
          numeric
          suffix={t.kilograms}
        />
        <TextField
          id="pieces"
          label={t.pieces}
          hint={t.piecesHint}
          errors={errors}
          value={
            current?.pieces === null || current?.pieces === undefined ? '' : String(current.pieces)
          }
          maxLength={7}
          ltr
          numeric
        />
        <TextField
          id="packaging"
          label={t.packaging}
          errors={errors}
          value={current?.packaging ?? ''}
          maxLength={200}
        />
        <TextField
          id="equipmentNeeded"
          label={t.equipmentNeeded}
          errors={errors}
          value={current?.equipmentNeeded ?? ''}
          maxLength={500}
          rows={2}
        />
      </fieldset>
      <PlaceFields
        place="pickup"
        locale={locale}
        t={t}
        title={t.sectionPickup}
        places={places}
        current={current?.pickup}
        problems={problems}
      />
      <PlaceFields
        place="delivery"
        locale={locale}
        t={t}
        title={t.sectionDelivery}
        places={places}
        current={current?.delivery}
        problems={problems}
      />
    </>
  );
}
