'use server';

import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, type ApiReply } from './api.ts';
import { endSession, sessionToken } from './session.ts';

// Assignment, substitution decisions, the shipper's wait and the driver's acknowledgement.
// Every action ends in a redirect and problems travel as short codes. None of these commands
// needs a retry key: each states what should be so, and sending it again when it already is so
// changes nothing. When an answer never arrives the page says so and shows what now stands.

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const localeOf = (form: FormData): Locale => {
  const value = text(form, 'locale');
  return isLocale(value) ? value : defaultLocale;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD = /^[a-z_]{1,40}$/;
const unknown = (reply: Extract<ApiReply<unknown>, { ok: false }>): boolean =>
  reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable';
const withQuery = (path: string, values: Record<string, string | undefined>): string => {
  const params = new URLSearchParams(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();
  return params ? `${path}?${params}` : path;
};
const member = (form: FormData, name: string): string | null | undefined => {
  const value = text(form, name);
  if (value === '') return null;
  return UUID.test(value) ? value : undefined;
};

async function command(
  form: FormData,
  options: {
    operation: string;
    path: string | null;
    here: string;
    anchor: string;
    body?: Record<string, unknown>;
  },
): Promise<never> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const back = (error: string, extra: Record<string, string | undefined> = {}): never =>
    redirect(withQuery(options.here, { aError: error, ...extra }) + `#${options.anchor}`);
  if (options.path === null) back('invalid');
  const reply = await api<{ outcome: string }>('POST', options.path!, {
    token,
    ...(options.body ? { body: options.body } : {}),
  });
  if (reply.ok) redirect(withQuery(options.here, { aDone: reply.data.outcome }));
  if (reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
  if (unknown(reply)) back(`${options.operation}_unconfirmed`);
  if (reply.code === 'validation_failed') back('invalid');
  // Which resource, and why: two short words from a fixed vocabulary.
  const role = reply.details.role;
  const reason = reply.details.reason;
  return back(reply.code, {
    aRole: typeof role === 'string' && WORD.test(role) ? role : undefined,
    aReason: typeof reason === 'string' && WORD.test(reason) ? reason : undefined,
  });
}

const bookingPage = (
  form: FormData,
): { here: string; organisationId: string | null; bookingId: string | null } => {
  const organisationId = text(form, 'organisationId');
  const bookingId = text(form, 'bookingId');
  const valid = UUID.test(organisationId) && UUID.test(bookingId);
  return {
    here: valid
      ? `/${localeOf(form)}/organisations/${organisationId}/bookings/${bookingId}`
      : `/${localeOf(form)}/account`,
    organisationId: valid ? organisationId : null,
    bookingId: valid ? bookingId : null,
  };
};

/** The carrier sets the whole assigned set. */
export async function assignResourcesAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const truckId = member(form, 'truckId');
  const trailerId = member(form, 'trailerId');
  const driverId = member(form, 'driverId');
  const version = Number(text(form, 'version'));
  const valid =
    organisationId !== null &&
    truckId !== undefined &&
    trailerId !== undefined &&
    driverId !== undefined &&
    Number.isInteger(version) &&
    version >= 0;
  await command(form, {
    operation: 'assign',
    path: valid ? `/organisations/${organisationId}/bookings/${bookingId}/assignment` : null,
    here,
    anchor: 'assign',
    body: { version, truckId, trailerId, driverId },
  });
}

/** The shipper accepts or declines a proposed substitution; the carrier withdraws it. */
export async function decideSubstitutionAction(form: FormData): Promise<void> {
  const { here, organisationId } = bookingPage(form);
  const substitutionId = text(form, 'substitutionId');
  const decision = text(form, 'decision');
  const version = Number(text(form, 'version'));
  const valid =
    organisationId !== null &&
    UUID.test(substitutionId) &&
    ['accept', 'decline', 'withdraw'].includes(decision) &&
    Number.isInteger(version) &&
    version >= 1;
  await command(form, {
    operation: 'decide',
    path: valid
      ? `/organisations/${organisationId}/substitutions/${substitutionId}/decision`
      : null,
    here,
    anchor: 'substitution',
    body: { version, decision },
  });
}

/** The shipper records a decision to wait after a missed assignment deadline. */
export async function waitForCarrierAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  await command(form, {
    operation: 'wait',
    path: organisationId ? `/organisations/${organisationId}/bookings/${bookingId}/wait` : null,
    here,
    anchor: 'state',
  });
}

/** The driver acknowledges the assignment they were shown. */
export async function acknowledgeAssignmentAction(form: FormData): Promise<void> {
  const bookingId = text(form, 'bookingId');
  const version = Number(text(form, 'version'));
  const valid = UUID.test(bookingId) && Number.isInteger(version) && version >= 1;
  await command(form, {
    operation: 'acknowledge',
    path: valid ? `/me/driver/assignments/${bookingId}/acknowledge` : null,
    here: `/${localeOf(form)}/driver`,
    anchor: 'assignments',
    body: { version },
  });
}
