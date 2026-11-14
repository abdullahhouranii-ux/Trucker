import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api } from '../../../web/src/server/api.ts';
import type { StaffAccount } from './types.ts';

// The staff session lives in an HttpOnly cookie on the console's own origin. It is not sent
// on any cross-site request (SameSite=Strict). Page scripts cannot read it. It has no
// lifetime of its own: the API enforces the idle and absolute limits.
const SESSION_COOKIE = 'trucker_staff_session';
const TICKET_COOKIE = 'trucker_staff_ticket';
const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NEXT_PUBLIC_TRUCKER_STAGE === 'production',
  path: '/',
};

export async function staffToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}
export async function startStaffSession(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions);
  jar.delete(TICKET_COOKIE);
}
export async function endStaffSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Between the password and the code: proof of the first step, for five minutes. */
export async function ticket(): Promise<string | undefined> {
  return (await cookies()).get(TICKET_COOKIE)?.value;
}
export async function keepTicket(value: string): Promise<void> {
  (await cookies()).set(TICKET_COOKIE, value, { ...cookieOptions, maxAge: 300 });
}
export async function dropTicket(): Promise<void> {
  (await cookies()).delete(TICKET_COOKIE);
}

export interface SignedIn {
  state: 'signed-in';
  token: string;
  staff: StaffAccount;
  sessionExpiresAt: string;
}
/**
 * What is known about the visitor's staff session. "unknown" means the API did not answer:
 * nothing is known, and the session must not be reported as ended.
 */
export type StaffLookup = SignedIn | { state: 'none' } | { state: 'ended' } | { state: 'unknown' };

export async function lookUpStaff(): Promise<StaffLookup> {
  const token = await staffToken();
  if (!token) return { state: 'none' };
  const reply = await api<{ staff: StaffAccount; sessionExpiresAt: string }>('GET', '/staff/me', {
    token,
  });
  if (reply.ok) return { state: 'signed-in', token, ...reply.data };
  return reply.status === 401 ? { state: 'ended' } : { state: 'unknown' };
}

/** For pages that need a signed-in staff member. */
export async function requireStaff(): Promise<SignedIn | { state: 'unknown' }> {
  const found = await lookUpStaff();
  if (found.state === 'signed-in' || found.state === 'unknown') return found;
  redirect(`/sign-in${found.state === 'ended' ? '?error=session_ended' : ''}`);
}
