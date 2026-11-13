'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, type Person } from './api.ts';
import {
  clearSignIn,
  endSession,
  readSignIn,
  sessionToken,
  startSession,
  writeSignIn,
} from './session.ts';

// Every action ends in a redirect. Problems travel as a short code in the address; values the
// person typed are kept in an HttpOnly cookie (sign-in) or by the browser draft (registration),
// never in the address.

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const localeOf = (form: FormData): Locale => {
  const value = text(form, 'locale');
  return isLocale(value) ? value : defaultLocale;
};
// The key is created when the form is rendered, so sending the same form twice is one request.
const retryKeyOf = (form: FormData): string => {
  const value = text(form, 'retryKey');
  return /^[A-Za-z0-9._-]{16,128}$/.test(value) ? value : randomUUID();
};
const query = (values: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values))
    if (value !== undefined) params.set(name, String(value));
  const result = params.toString();
  return result ? `?${result}` : '';
};

async function sendCode(locale: Locale, phone: string, retryKey: string): Promise<never> {
  const reply = await api<{ challengeId: string; developmentCode?: string }>(
    'POST',
    '/auth/code-requests',
    {
      body: { phone },
      retryKey,
    },
  );
  if (!reply.ok) {
    const back =
      reply.code === 'code_resend_too_soon' && (await readSignIn())?.challengeId
        ? 'sign-in/code'
        : 'sign-in';
    const error = reply.code === 'validation_failed' ? 'phone' : reply.code;
    const seconds =
      typeof reply.details.retryAfterSeconds === 'number'
        ? reply.details.retryAfterSeconds
        : undefined;
    redirect(`/${locale}/${back}${query({ error, seconds })}`);
  }
  await writeSignIn({
    phone,
    challengeId: reply.data.challengeId,
    ...(reply.data.developmentCode ? { developmentCode: reply.data.developmentCode } : {}),
  });
  redirect(`/${locale}/sign-in/code`);
}

export async function requestCodeAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const phone = text(form, 'phone').trim();
  // Keep what was typed so the form is not emptied by an error.
  await writeSignIn({ phone });
  if (!phone) redirect(`/${locale}/sign-in?error=phone`);
  await sendCode(locale, phone, retryKeyOf(form));
}

export async function resendCodeAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const progress = await readSignIn();
  if (!progress?.phone) redirect(`/${locale}/sign-in?error=no_challenge`);
  await sendCode(locale, progress.phone, retryKeyOf(form));
}

export async function verifyCodeAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const progress = await readSignIn();
  if (!progress?.challengeId) redirect(`/${locale}/sign-in?error=no_challenge`);
  const code = text(form, 'code').replace(/\s/g, '');
  if (!/^[0-9]{6}$/.test(code)) redirect(`/${locale}/sign-in/code?error=code_format`);
  const reply = await api<{ token: string; person: Person }>('POST', '/auth/code-verifications', {
    body: { challengeId: progress.challengeId, code },
    retryKey: retryKeyOf(form),
  });
  if (!reply.ok) {
    const left =
      typeof reply.details.attemptsRemaining === 'number'
        ? reply.details.attemptsRemaining
        : undefined;
    redirect(
      `/${locale}/sign-in/code${query({ error: reply.code === 'validation_failed' ? 'code_format' : reply.code, left })}`,
    );
  }
  await startSession(reply.data.token);
  await clearSignIn();
  redirect(`/${locale}/${reply.data.person.registrationComplete ? 'account' : 'register'}`);
}

export async function registerAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const displayName = text(form, 'displayName');
  const contactEmail = text(form, 'contactEmail');
  const problems: string[] = [];
  if (!displayName.trim()) problems.push('name');
  if (form.get('termsSeen') !== 'yes') problems.push('terms');
  if (problems.length > 0) redirect(`/${locale}/register${query({ error: problems.join(',') })}`);

  const reply = await api<{ person: Person }>('POST', '/me/registration', {
    token,
    body: {
      displayName,
      contactEmail,
      termsVersion: text(form, 'termsVersion'),
      termsLanguage: locale,
      termsSeen: true,
    },
  });
  if (!reply.ok) {
    if (reply.status === 401) {
      await endSession();
      redirect(`/${locale}/sign-in?error=session_ended`);
    }
    if (reply.code === 'validation_failed') {
      const names: Record<string, string> = {
        displayName: 'name',
        contactEmail: 'email',
        termsSeen: 'terms',
      };
      const fields = Array.isArray(reply.details.fields) ? (reply.details.fields as string[]) : [];
      redirect(
        `/${locale}/register${query({ error: fields.map((field) => names[field] ?? 'unavailable').join(',') })}`,
      );
    }
    redirect(`/${locale}/register${query({ error: reply.code })}`);
  }
  redirect(`/${locale}/account?done=registered`);
}

export async function signOutAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (token) await api('POST', '/auth/sign-out', { token });
  await endSession();
  redirect(`/${locale}`);
}

export async function endSessionAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const id = text(form, 'sessionId');
  if (/^[0-9a-f-]{36}$/i.test(id)) await api('DELETE', `/me/sessions/${id}`, { token });
  redirect(`/${locale}/account`);
}

export async function endOtherSessionsAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  await api('POST', '/me/sessions/revoke-others', { token });
  redirect(`/${locale}/account`);
}
