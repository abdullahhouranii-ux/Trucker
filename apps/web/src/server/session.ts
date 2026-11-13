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

export interface SignedIn {
  token: string;
  person: Person;
  session: Session;
}

/**
 * What is known about the visitor's session. "ended" is the server's own answer that the
 * session is no longer valid. "unknown" means the server did not answer, so nothing is known:
 * the session may well still be active, and it must not be reported as ended.
 */
export type SessionLookup =
  | ({ state: 'signed-in' } & SignedIn)
  | { state: 'none' }
  | { state: 'ended' }
  | { state: 'unknown'; token: string };

/** Does not change cookies, so pages may call it while rendering. */
export async function lookUpSession(): Promise<SessionLookup> {
  const token = await sessionToken();
  if (!token) return { state: 'none' };
  const reply = await api<{ person: Person; session: Session }>('GET', '/me', { token });
  if (reply.ok) return { state: 'signed-in', token, ...reply.data };
  return reply.status === 401 ? { state: 'ended' } : { state: 'unknown', token };
}

/** The signed-in person, or null when there is none or the server did not answer. */
export async function currentPerson(): Promise<SignedIn | null> {
  const found = await lookUpSession();
  return found.state === 'signed-in' ? found : null;
}

/**
 * For pages that need a signed-in person. Someone with no session, or one the server says has
 * ended, is sent to sign in. When the server does not answer, the page gets "unknown" and must
 * say so instead of claiming the session ended.
 */
export async function requirePerson(
  locale: Locale,
): Promise<({ state: 'signed-in' } & SignedIn) | { state: 'unknown'; token: string }> {
  const found = await lookUpSession();
  if (found.state === 'signed-in' || found.state === 'unknown') return found;
  redirect(`/${locale}/sign-in${found.state === 'ended' ? '?error=session_ended' : ''}`);
}
