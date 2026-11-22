'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, type ApiReply } from './api.ts';
import { endSession, sessionToken } from './session.ts';

// Quotations from the web pages. As everywhere: every action ends in a redirect, problems
// travel as short codes, nothing is reported as done unless the server confirmed it, and an
// answer that never arrived keeps the same retry key so sending again cannot apply twice. The
// amount is passed on as typed text: it is never turned into a binary number here.

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const localeOf = (form: FormData): Locale => {
  const value = text(form, 'locale');
  return isLocale(value) ? value : defaultLocale;
};
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{1,39}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TIME = /^[0-9]{2}:[0-9]{2}$/;

const unknown = (reply: Extract<ApiReply<unknown>, { ok: false }>): boolean =>
  reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable';

function problemCodes(details: Record<string, unknown>): string {
  const problems = Array.isArray(details.problems)
    ? (details.problems as {
        field?: unknown;
        code?: unknown;
        minutes?: unknown;
        minorUnits?: unknown;
      }[])
    : [];
  const codes = problems
    .filter((problem) => typeof problem.field === 'string' && typeof problem.code === 'string')
    .map((problem) => {
      const extra =
        typeof problem.minutes === 'number'
          ? `:${problem.minutes}`
          : typeof problem.minorUnits === 'number'
            ? `:${problem.minorUnits}`
            : '';
      return `${problem.field as string}:${problem.code as string}${extra}`;
    })
    .filter((code) => /^[A-Za-z0-9_.:]{1,120}$/.test(code));
  return codes.length > 0 ? [...new Set(codes)].join(',') : 'invalid';
}

interface Target {
  locale: Locale;
  token: string;
  organisationId: string;
  retryKey: string;
}
async function target(form: FormData): Promise<Target> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const organisationId = text(form, 'organisationId');
  if (!UUID.test(organisationId)) redirect(`/${locale}/organisations?error=organisation_not_found`);
  const key = text(form, 'retryKey');
  return { locale, token, organisationId, retryKey: RETRY_KEY.test(key) ? key : randomUUID() };
}
async function signedOut(locale: Locale): Promise<never> {
  await endSession();
  redirect(`/${locale}/sign-in?error=session_ended`);
}
const withQuery = (path: string, values: Record<string, string | undefined>): string => {
  const params = new URLSearchParams(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();
  return params ? `${path}?${params}` : path;
};

/** Date and time inputs as a local time at the pick-up place, or a problem code. */
function moment(form: FormData, prefix: string, field: string, problems: string[]) {
  const date = text(form, `${prefix}Date`).trim();
  const time = text(form, `${prefix}Time`).trim();
  if (date === '' && time === '') {
    problems.push(`${field}:required`);
    return { local: '' };
  }
  if (!DATE.test(date) || !TIME.test(time)) {
    problems.push(`${field}:time_invalid`);
    return { local: '' };
  }
  return { local: `${date}T${time}` };
}

/** The quotation form, in the shape the API takes. */
function quotationContent(form: FormData, problems: string[]) {
  const codes = form
    .getAll('inclusionCode')
    .filter((value): value is string => typeof value === 'string' && CODE.test(value));
  const inclusions: Record<string, boolean> = {};
  for (const code of codes) {
    const answer = text(form, `inc-${code}`);
    if (answer === 'yes') inclusions[code] = true;
    else if (answer === 'no') inclusions[code] = false;
    else problems.push(`inclusions.${code}:required`);
  }
  const amount = text(form, 'amount').trim();
  if (amount === '') problems.unshift('amount:required');
  return {
    amount,
    inclusions,
    validUntil: moment(form, 'validUntil', 'validUntil', problems),
    earliestPickup: moment(form, 'earliestPickup', 'earliestPickup', problems),
    notes: text(form, 'notes'),
  };
}

// The carrier --------------------------------------------------------------------------------
async function carrierCommand(
  form: FormData,
  operation: 'submit' | 'revisions' | 'reconfirm' | 'withdraw',
): Promise<void> {
  const { locale, token, organisationId, retryKey } = await target(form);
  const shipment = text(form, 'shipmentId');
  const quotation = text(form, 'quotationId');
  if (!UUID.test(shipment) || (operation !== 'submit' && !UUID.test(quotation)))
    redirect(`/${locale}/organisations/${organisationId}/discover?error=not_found`);
  const here = `/${locale}/organisations/${organisationId}/discover/${shipment}`;
  const back = (error: string, keep: boolean): never =>
    redirect(
      withQuery(here, { qError: error, ...(keep ? { [`${operation}Retry`]: retryKey } : {}) }) +
        '#quotation',
    );
  const problems: string[] = [];
  const version = Number(text(form, 'version'));
  let body: Record<string, unknown> = {};
  if (operation === 'submit' || operation === 'revisions') body = quotationContent(form, problems);
  if (operation !== 'submit') body.version = version;
  if (problems.length > 0) back(problems.join(','), true);
  const path =
    operation === 'submit'
      ? `/organisations/${organisationId}/discovery/shipments/${shipment}/quotations`
      : `/organisations/${organisationId}/quotations/${quotation}/${operation}`;
  const reply = await api<{ outcome: string }>('POST', path, { token, retryKey, body });
  if (reply.ok) redirect(withQuery(here, { qDone: reply.data.outcome }) + '#quotation');
  if (reply.status === 401) await signedOut(locale);
  if (unknown(reply)) back(`${operation}_unconfirmed`, true);
  if (reply.code === 'validation_failed') back(problemCodes(reply.details), true);
  back(reply.code, false);
}

export async function submitQuotationAction(form: FormData): Promise<void> {
  await carrierCommand(form, 'submit');
}
export async function reviseQuotationAction(form: FormData): Promise<void> {
  await carrierCommand(form, 'revisions');
}
export async function reconfirmQuotationAction(form: FormData): Promise<void> {
  await carrierCommand(form, 'reconfirm');
}
export async function withdrawQuotationAction(form: FormData): Promise<void> {
  await carrierCommand(form, 'withdraw');
}

// The shipper --------------------------------------------------------------------------------
async function shipperCommand(
  form: FormData,
  operation: 'terms' | 'reject' | 'accept',
): Promise<void> {
  const { locale, token, organisationId, retryKey } = await target(form);
  const shipment = text(form, 'shipmentId');
  const quotation = text(form, 'quotationId');
  if (!UUID.test(shipment) || (operation !== 'terms' && !UUID.test(quotation)))
    redirect(`/${locale}/organisations/${organisationId}/shipments?error=shipment_not_found`);
  const here = `/${locale}/organisations/${organisationId}/shipments/${shipment}/quotations`;
  const back = (error: string, keep: boolean): never =>
    redirect(
      withQuery(here, { qError: error, ...(keep ? { [`${operation}Retry`]: retryKey } : {}) }),
    );
  const version = Number(text(form, 'version'));
  const reply =
    operation === 'terms'
      ? await api<{ outcome: string }>(
          'POST',
          `/organisations/${organisationId}/shipments/${shipment}/quotation-terms`,
          { token, retryKey, body: { version, currency: text(form, 'currency') } },
        )
      : await api<{ outcome: string }>(
          'POST',
          `/organisations/${organisationId}/quotations/${quotation}/${operation}`,
          { token, retryKey, body: { version } },
        );
  if (reply.ok) redirect(withQuery(here, { qDone: reply.data.outcome }));
  if (reply.status === 401) await signedOut(locale);
  if (unknown(reply)) back(`${operation}_unconfirmed`, true);
  if (reply.code === 'validation_failed') back(problemCodes(reply.details), false);
  back(reply.code, false);
}

export async function setQuotationTermsAction(form: FormData): Promise<void> {
  await shipperCommand(form, 'terms');
}
export async function rejectQuotationAction(form: FormData): Promise<void> {
  await shipperCommand(form, 'reject');
}
/** Accepts one exact quotation version. Final: one booking, or a clear refusal. */
export async function acceptQuotationAction(form: FormData): Promise<void> {
  await shipperCommand(form, 'accept');
}
