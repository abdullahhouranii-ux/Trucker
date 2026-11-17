'use server';

import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api } from './api.ts';
import { endSession, sessionToken } from './session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const localeOf = (form: FormData): Locale => {
  const value = text(form, 'locale');
  return isLocale(value) ? value : defaultLocale;
};
const version = (form: FormData): number => Number.parseInt(text(form, 'version'), 10) || 0;

/**
 * Sends one command and returns to `here` with its outcome or the reason it was refused. An
 * answer that never arrived is reported as not confirmed: each command here is safe to send
 * again, because the server answers a repeat with what it already holds.
 */
async function send(
  form: FormData,
  path: string | null,
  body: Record<string, unknown>,
  here: string,
  names: { done: string; error: string },
): Promise<never> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const back = (name: string, value: string): never =>
    redirect(`${here}?${name}=${encodeURIComponent(value)}`);
  if (path === null) back(names.error, 'not_found');
  const reply = await api<{ outcome: string }>('POST', path!, { token, body });
  if (reply.ok) back(names.done, reply.data.outcome);
  if (!reply.ok && reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
  if (!reply.ok && (reply.status === 0 || reply.status >= 500)) back(names.error, 'unconfirmed');
  if (!reply.ok && reply.code === 'validation_failed') {
    const problems = Array.isArray(reply.details.problems)
      ? (reply.details.problems as { field: string; code: string }[])
      : [];
    back(names.error, problems.map((p) => `${p.field}_${p.code}`).join(',') || 'invalid');
  }
  return back(names.error, reply.ok ? 'unconfirmed' : reply.code);
}

const page = (form: FormData): { org: string; here: string } => {
  const org = text(form, 'organisationId');
  return { org, here: `/${localeOf(form)}/organisations/${org}/authorities` };
};
const NAMES = { done: 'aDone', error: 'aError' };

export async function requestAuthorityAction(form: FormData): Promise<void> {
  const { org, here } = page(form);
  await send(
    form,
    UUID.test(org) ? `/organisations/${org}/authorities` : null,
    { customerCode: text(form, 'customerCode').trim().slice(0, 40) },
    here,
    NAMES,
  );
}

export async function decideAuthorityAction(form: FormData): Promise<void> {
  const { org, here } = page(form);
  const id = text(form, 'authorityId');
  const accept = text(form, 'decision') === 'accept';
  await send(
    form,
    UUID.test(org) && UUID.test(id) ? `/organisations/${org}/authorities/${id}/decision` : null,
    {
      version: version(form),
      decision: accept ? 'accept' : 'decline',
      ...(accept
        ? {
            mayPublish: form.get('mayPublish') === 'on',
            feePayerAgreed: form.get('feePayerAgreed') === 'on',
          }
        : {}),
    },
    here,
    NAMES,
  );
}

export async function endAuthorityAction(form: FormData): Promise<void> {
  const { org, here } = page(form);
  const id = text(form, 'authorityId');
  await send(
    form,
    UUID.test(org) && UUID.test(id) ? `/organisations/${org}/authorities/${id}/end` : null,
    { version: version(form) },
    here,
    NAMES,
  );
}

/** The roles of a draft shipment: who it is for, who receives it, and who pays what. */
export async function setShipmentPartiesAction(form: FormData): Promise<void> {
  const org = text(form, 'organisationId');
  const shipment = text(form, 'shipmentId');
  const customer = text(form, 'customerAuthorityId');
  const receiver = text(form, 'receiverName').normalize('NFC').trim().slice(0, 200);
  await send(
    form,
    UUID.test(org) && UUID.test(shipment)
      ? `/organisations/${org}/shipments/${shipment}/parties`
      : null,
    {
      version: version(form),
      customerAuthorityId: UUID.test(customer) ? customer : null,
      sender: 'customer',
      receiver: receiver === '' ? 'not_named' : { name: receiver },
      freightPayer: text(form, 'freightPayer'),
      feePayer: text(form, 'feePayer'),
    },
    `/${localeOf(form)}/organisations/${org}/shipments/${shipment}`,
    { done: 'rolesDone', error: 'rolesError' },
  );
}
