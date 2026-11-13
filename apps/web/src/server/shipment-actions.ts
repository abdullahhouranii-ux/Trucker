'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, type ApiReply, type Shipment } from './api.ts';
import { endSession, sessionToken } from './session.ts';

// Shipment drafts: save a new one, change one, discard one. Each action ends in a redirect,
// and problems travel as short codes in the address. What was typed is kept by the browser
// draft, never put in the address.
//
// Nothing is reported as done unless the server confirmed it. Every request carries a retry
// key that the form keeps: when no answer comes back the page says the outcome is not known,
// and sending the same details again with the same key cannot save them twice. A change or a
// discard also carries the version it was made against; when someone else changed the draft
// meanwhile, nothing is saved and the person's own input stays in the form.

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
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TIME = /^[0-9]{2}:[0-9]{2}$/;
const TEXT_FIELDS = [
  'shipperReference',
  'cargoDescription',
  'grossWeightKg',
  'pieces',
  'packaging',
  'equipmentNeeded',
] as const;
const PLACE_FIELDS = ['address', 'countryCode', 'timeZone', 'accessNotes', 'from', 'until'];

const query = (values: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values))
    if (value !== undefined) params.set(name, String(value));
  const result = params.toString();
  return result ? `?${result}` : '';
};

interface WindowEndInput {
  local: string | null;
  offsetMinutes: number | null;
}
/** One end of a window from its date and time inputs, or the problem with them. */
function windowEnd(
  form: FormData,
  prefix: string,
  field: string,
  problems: string[],
): WindowEndInput {
  const date = text(form, `${prefix}Date`).trim();
  const time = text(form, `${prefix}Time`).trim();
  if (date === '' && time === '') return { local: null, offsetMinutes: null };
  if (date === '' || time === '') {
    problems.push(`${field}:time_incomplete`);
    return { local: null, offsetMinutes: null };
  }
  if (!DATE.test(date) || !TIME.test(time)) {
    problems.push(`${field}:time_invalid`);
    return { local: null, offsetMinutes: null };
  }
  // The choice between two offsets is sent only when the form asked for it.
  const chosen = text(form, `${prefix}Offset`);
  return {
    local: `${date}T${time}`,
    offsetMinutes: /^-?[0-9]{1,4}$/.test(chosen) ? Number(chosen) : null,
  };
}

function place(form: FormData, name: 'pickup' | 'delivery', problems: string[]) {
  return {
    address: text(form, `${name}Address`),
    countryCode: text(form, `${name}Country`),
    timeZone: text(form, `${name}Zone`),
    accessNotes: text(form, `${name}AccessNotes`),
    from: windowEnd(form, `${name}From`, `${name}.from`, problems),
    until: windowEnd(form, `${name}Until`, `${name}.until`, problems),
  };
}

/** What the form holds, in the shape the API takes, and the problems seen without asking it. */
function content(form: FormData): { body: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  const body: Record<string, unknown> = Object.fromEntries(
    TEXT_FIELDS.map((name) => [name, text(form, name)]),
  );
  body.pickup = place(form, 'pickup', problems);
  body.delivery = place(form, 'delivery', problems);
  return { body, problems };
}

/** A problem the API reported, as `field:code` with the two offsets of an ambiguous time. */
function problemCode(problem: { field?: unknown; code?: unknown; offsets?: unknown }): string {
  const parts = String(problem.field ?? '').split('.');
  const field =
    (parts[0] === 'pickup' || parts[0] === 'delivery') && PLACE_FIELDS.includes(parts[1] ?? '')
      ? `${parts[0]}.${parts[1]}`
      : (TEXT_FIELDS as readonly string[]).includes(parts[0] ?? '')
        ? parts[0]!
        : '';
  const code =
    typeof problem.code === 'string' && /^[a-z_]+$/.test(problem.code) ? problem.code : 'invalid';
  if (field === '') return code === 'empty' ? 'empty' : 'invalid';
  const offsets =
    code === 'time_ambiguous' && Array.isArray(problem.offsets)
      ? problem.offsets.filter((offset): offset is number => Number.isInteger(offset))
      : [];
  return [field, code, ...offsets].join(':');
}

/** The code to show for a refusal. */
function refusal(reply: Extract<ApiReply<unknown>, { ok: false }>, unconfirmed: string): string {
  if (reply.code === 'validation_failed') {
    const problems = Array.isArray(reply.details.problems)
      ? (reply.details.problems as { field?: unknown; code?: unknown; offsets?: unknown }[])
      : [];
    const codes = [...new Set(problems.map(problemCode))];
    return codes.length > 0 ? codes.join(',') : unconfirmed;
  }
  // No answer, an unreadable answer, or a server fault: nothing is known about the outcome.
  if (reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable')
    return reply.code === 'organisation_access_closed' ? reply.code : unconfirmed;
  return reply.code;
}

interface Target {
  locale: Locale;
  token: string;
  organisationId: string;
  retryKey: string;
}
/** Who is asking, about which organisation, with which retry key. */
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

export async function createShipmentAction(form: FormData): Promise<void> {
  const { locale, token, organisationId, retryKey } = await target(form);
  const base = `/${locale}/organisations/${organisationId}/shipments`;
  const back = (error: string, extra: Record<string, string | number | undefined> = {}): never =>
    redirect(`${base}/new${query({ error, retry: retryKey, ...extra })}`);

  const { body, problems } = content(form);
  if (problems.length > 0) back(problems.join(','));

  const reply = await api<{ shipment: Shipment }>(
    'POST',
    `/organisations/${organisationId}/shipments`,
    { token, retryKey, body },
  );
  if (reply.ok) redirect(`${base}/${reply.data.shipment.id}?done=created`);
  if (reply.status === 401) await signedOut(locale);
  if (reply.status === 404) redirect(`/${locale}/organisations?error=organisation_not_found`);
  // A key that was used for other details is not offered again.
  if (reply.code === 'retry_key_conflict') redirect(`${base}/new?error=retry_key_conflict`);
  back(refusal(reply, 'create_unconfirmed'), {
    limit: typeof reply.details.limit === 'number' ? reply.details.limit : undefined,
  });
}

export async function updateShipmentAction(form: FormData): Promise<void> {
  const { locale, token, organisationId, retryKey } = await target(form);
  const base = `/${locale}/organisations/${organisationId}/shipments`;
  const id = text(form, 'shipmentId');
  if (!UUID.test(id)) redirect(`${base}?error=shipment_not_found`);
  const version = Number(text(form, 'version'));
  const back = (error: string): never =>
    redirect(`${base}/${id}${query({ error, retry: retryKey })}`);

  const { body, problems } = content(form);
  if (problems.length > 0) back(problems.join(','));
  if (!Number.isInteger(version) || version < 1) redirect(`${base}/${id}?error=shipment_changed`);

  const reply = await api<{ shipment: Shipment; outcome: 'updated' | 'already_applied' }>(
    'PATCH',
    `/organisations/${organisationId}/shipments/${id}`,
    { token, retryKey, body: { ...body, version } },
  );
  if (reply.ok)
    redirect(`${base}/${id}?done=${reply.data.outcome === 'updated' ? 'saved' : 'already'}`);
  if (reply.status === 401) await signedOut(locale);
  if (reply.status === 404) redirect(`${base}?error=shipment_not_found`);
  // Someone else changed the draft. Nothing was saved; the page keeps what was typed against
  // the version it was typed for, and a new attempt gets a new key.
  if (reply.code === 'shipment_changed')
    redirect(`${base}/${id}${query({ error: 'shipment_changed', base: version })}`);
  if (reply.code === 'shipment_discarded' || reply.code === 'retry_key_conflict')
    redirect(`${base}/${id}?error=${reply.code}`);
  back(refusal(reply, 'save_unconfirmed'));
}

export async function discardShipmentAction(form: FormData): Promise<void> {
  const { locale, token, organisationId, retryKey } = await target(form);
  const base = `/${locale}/organisations/${organisationId}/shipments`;
  const id = text(form, 'shipmentId');
  if (!UUID.test(id)) redirect(`${base}?error=shipment_not_found`);
  const version = Number(text(form, 'version'));
  if (!Number.isInteger(version) || version < 1)
    redirect(`${base}/${id}?error=shipment_changed_discard`);

  const reply = await api<{ shipment: Shipment }>(
    'POST',
    `/organisations/${organisationId}/shipments/${id}/discard`,
    { token, retryKey, body: { version } },
  );
  // Discarded now, or already discarded before: either way the server confirmed it.
  if (reply.ok) redirect(`${base}/${id}?done=discarded`);
  if (reply.status === 401) await signedOut(locale);
  if (reply.status === 404) redirect(`${base}?error=shipment_not_found`);
  if (reply.code === 'shipment_changed') redirect(`${base}/${id}?error=shipment_changed_discard`);
  if (reply.code === 'retry_key_conflict') redirect(`${base}/${id}?error=retry_key_conflict`);
  const code = refusal(reply, 'discard_unconfirmed');
  redirect(
    `${base}/${id}${query({
      error: code === 'invalid' ? 'discard_unconfirmed' : code,
      discardRetry: retryKey,
    })}`,
  );
}
