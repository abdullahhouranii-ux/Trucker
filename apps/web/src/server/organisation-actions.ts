'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, type ApiReply, type Organisation } from './api.ts';
import { endSession, sessionToken } from './session.ts';

// Each action ends in a redirect, and problems travel as short codes in the address. What was
// typed is kept by the browser draft, never put in the address.
//
// A create or save is reported as done only when the server confirmed it. When the server does
// not answer, the outcome is unknown and the page says so. Trying again is safe: a create
// carries a retry key, so the same details sent twice make one organisation, and a save
// carries the version it was made against.

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
const FIELDS = [
  'legalName',
  'tradingName',
  'countryCode',
  'registrationNumber',
  'address',
  'contactName',
] as const;

const details = (form: FormData): Record<(typeof FIELDS)[number], string> =>
  Object.fromEntries(FIELDS.map((name) => [name, text(form, name)])) as Record<
    (typeof FIELDS)[number],
    string
  >;

/** Problems that can be told without asking the server. */
function missing(values: Record<string, string>): string[] {
  return ['legalName', 'countryCode', 'registrationNumber'].filter(
    (name) => (values[name] ?? '').trim() === '',
  );
}

const query = (values: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values))
    if (value !== undefined) params.set(name, String(value));
  const result = params.toString();
  return result ? `?${result}` : '';
};

/** The code to show for a refusal: field names for invalid input, else the server's code. */
function refusal(reply: Extract<ApiReply<unknown>, { ok: false }>, unconfirmed: string): string {
  if (reply.code === 'validation_failed') {
    const fields = Array.isArray(reply.details.fields) ? (reply.details.fields as string[]) : [];
    const known = fields.filter((field) => (FIELDS as readonly string[]).includes(field));
    return known.length > 0 ? known.join(',') : unconfirmed;
  }
  // No answer, an unreadable answer, or a server fault: nothing is known about the outcome.
  if (reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable') {
    return reply.code === 'organisation_registration_closed' ||
      reply.code === 'organisation_access_closed'
      ? reply.code
      : unconfirmed;
  }
  return reply.code;
}

export async function createOrganisationAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const key = text(form, 'retryKey');
  const retryKey = RETRY_KEY.test(key) ? key : randomUUID();
  const values = details(form);
  const back = (error: string, extra: Record<string, string | number | undefined> = {}): never =>
    redirect(`/${locale}/organisations/new${query({ error, retry: retryKey, ...extra })}`);

  const absent = missing(values);
  if (absent.length > 0) back(absent.join(','));

  const reply = await api<{ organisation: Organisation }>('POST', '/organisations', {
    token,
    retryKey,
    body: values,
  });
  if (reply.ok) redirect(`/${locale}/organisations/${reply.data.organisation.id}?done=created`);
  if (reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
  if (reply.code === 'registration_incomplete') redirect(`/${locale}/register`);
  back(refusal(reply, 'create_unconfirmed'), {
    limit: typeof reply.details.limit === 'number' ? reply.details.limit : undefined,
  });
}

export async function updateOrganisationAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const id = text(form, 'organisationId');
  if (!UUID.test(id)) redirect(`/${locale}/organisations?error=organisation_not_found`);
  const version = Number(text(form, 'version'));
  const values = details(form);
  const back = (error: string): never =>
    redirect(`/${locale}/organisations/${id}${query({ error })}`);

  const absent = missing(values);
  if (absent.length > 0) back(absent.join(','));
  if (!Number.isInteger(version) || version < 1) back('organisation_changed');

  const reply = await api<{ organisation: Organisation }>('PATCH', `/organisations/${id}`, {
    token,
    body: { ...values, version },
  });
  if (reply.ok) redirect(`/${locale}/organisations/${id}?done=saved`);
  if (reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
  if (reply.status === 404) redirect(`/${locale}/organisations?error=organisation_not_found`);
  back(refusal(reply, 'save_unconfirmed'));
}
