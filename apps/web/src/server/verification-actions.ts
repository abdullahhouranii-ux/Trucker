'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, type ApiReply, type VerificationOverview } from './api.ts';
import { endSession, sessionToken } from './session.ts';

// Submitting and withdrawing an application for verification. As everywhere: each action ends
// in a redirect, problems travel as short codes in the address, what was typed stays in the
// browser draft, and nothing is reported as done unless the server confirmed it. A submission
// carries a retry key and the organisation's version, so the same details sent twice make one
// version of the application.

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
const DOCUMENT_TYPE = /^[a-z][a-z0-9_]{1,39}$/;

const unknown = (reply: Extract<ApiReply<unknown>, { ok: false }>): boolean =>
  reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable';

const page = (locale: Locale, id: string, values: Record<string, string> = {}): string => {
  const params = new URLSearchParams(values).toString();
  return `/${locale}/organisations/${id}/verification${params ? `?${params}` : ''}`;
};

/** The server's field problems as the short codes the page understands. */
function problemCodes(details: Record<string, unknown>): string {
  const problems = Array.isArray(details.problems)
    ? (details.problems as { field?: unknown; code?: unknown }[])
    : [];
  const codes = problems
    .filter((problem) => typeof problem.field === 'string' && typeof problem.code === 'string')
    .map((problem) => `${problem.field as string}:${problem.code as string}`)
    .filter((code) => /^[A-Za-z0-9_.:]{1,120}$/.test(code));
  return codes.length > 0 ? [...new Set(codes)].join(',') : 'evidence:invalid';
}

export async function submitVerificationAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const id = text(form, 'organisationId');
  if (!UUID.test(id)) redirect(`/${locale}/organisations?error=organisation_not_found`);
  const key = text(form, 'retryKey');
  const retryKey = RETRY_KEY.test(key) ? key : randomUUID();
  const back = (error: string): never => redirect(page(locale, id, { error, retry: retryKey }));

  const version = Number(text(form, 'version'));
  if (!Number.isInteger(version) || version < 1) back('organisation_changed');
  // One entry per document the page asked about. An optional document left empty is not sent.
  const types = form
    .getAll('documentType')
    .filter((value): value is string => typeof value === 'string' && DOCUMENT_TYPE.test(value));
  const evidence = types
    .map((documentType) => ({
      required: text(form, `ev-${documentType}-required`) === 'yes',
      entry: {
        documentType,
        documentNumber: text(form, `ev-${documentType}-documentNumber`),
        issuingCountry: text(form, `ev-${documentType}-issuingCountry`),
        issuedOn: text(form, `ev-${documentType}-issuedOn`) || null,
        expiresOn: text(form, `ev-${documentType}-expiresOn`) || null,
      },
    }))
    .filter(
      ({ required, entry }) =>
        required ||
        entry.documentNumber.trim() !== '' ||
        entry.issuedOn !== null ||
        entry.expiresOn !== null,
    )
    .map(({ entry }) => entry);
  const amendment = text(form, 'kind') === 'amendment';
  const proposed = amendment
    ? {
        legalName: text(form, 'proposedLegalName'),
        countryCode: text(form, 'proposedCountryCode'),
        registrationNumber: text(form, 'proposedRegistrationNumber'),
      }
    : undefined;

  const reply = await api<{ verification: VerificationOverview }>(
    'POST',
    `/organisations/${id}/verification/applications`,
    {
      token,
      retryKey,
      body: {
        version,
        declarationAccepted: text(form, 'declaration') === 'yes',
        declarationLanguage: locale,
        evidence,
        ...(proposed ? { proposed } : {}),
      },
    },
  );
  if (reply.ok) redirect(page(locale, id, { done: 'submitted' }));
  if (reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
  if (reply.status === 404) redirect(`/${locale}/organisations?error=organisation_not_found`);
  if (reply.code === 'registration_incomplete') redirect(`/${locale}/register`);
  if (unknown(reply)) back('submit_unconfirmed');
  back(reply.code === 'validation_failed' ? problemCodes(reply.details) : reply.code);
}

export async function withdrawVerificationAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const id = text(form, 'organisationId');
  const application = text(form, 'applicationId');
  if (!UUID.test(id) || !UUID.test(application))
    redirect(`/${locale}/organisations?error=organisation_not_found`);
  const key = text(form, 'retryKey');
  const reply = await api<{ verification: VerificationOverview }>(
    'POST',
    `/organisations/${id}/verification/applications/${application}/withdraw`,
    { token, retryKey: RETRY_KEY.test(key) ? key : randomUUID() },
  );
  if (reply.ok) redirect(page(locale, id, { done: 'withdrawn' }));
  if (reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
  if (reply.status === 404) redirect(`/${locale}/organisations?error=organisation_not_found`);
  redirect(page(locale, id, { error: unknown(reply) ? 'withdraw_unconfirmed' : reply.code }));
}
