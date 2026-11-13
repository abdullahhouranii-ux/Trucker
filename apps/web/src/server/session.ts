import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Locale } from '../i18n/config.ts';
import { api, type Person, type Session } from './api.ts';

const SESSION_COOKIE = 'trucker_session';
const SIGN_IN_COOKIE = 'trucker_sign_in';

// HttpOnly: page scripts cannot read these. SameSite=Lax: not sent on cross-site form posts.
// Secure everywhere except plain-http local development.
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NEXT_PUBLIC_TRUCKER_STAGE === 'production',
  path: '/',
};

/** What the sign-in pages remember between the two steps. Never the session token. */
export interface SignInProgress {
  phone: string;
  challengeId?: string;
  developmentCode?: string;
}

export async function readSignIn(): Promise<SignInProgress | null> {
  const raw = (await cookies()).get(SIGN_IN_COOKIE)?.value;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SignInProgress;
    return typeof value.phone === 'string' ? value : null;
  } catch {
    return null;
  }
}

export async function writeSignIn(progress: SignInProgress): Promise<void> {
  (await cookies()).set(SIGN_IN_COOKIE, JSON.stringify(progress), {
    ...cookieOptions,
    maxAge: 15 * 60,
  });
}

export async function clearSignIn(): Promise<void> {
  (await cookies()).delete(SIGN_IN_COOKIE);
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** A session cookie without a lifetime: it ends with the browser; the API enforces the real limits. */
export async function startSession(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions);
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The signed-in person, or null. Does not change cookies, so pages may call it while rendering. */
export async function currentPerson(): Promise<{
  token: string;
  person: Person;
  session: Session;
} | null> {
  const token = await sessionToken();
  if (!token) return null;
  const reply = await api<{ person: Person; session: Session }>('GET', '/me', { token });
  return reply.ok ? { token, ...reply.data } : null;
}

/** For pages that need a signed-in person: anyone else is sent to sign in. */
export async function requirePerson(
  locale: Locale,
): Promise<{ token: string; person: Person; session: Session }> {
  const current = await currentPerson();
  if (current) return current;
  const hadSession = (await sessionToken()) !== undefined;
  redirect(`/${locale}/sign-in${hadSession ? '?error=session_ended' : ''}`);
}
