'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { api, type ApiReply } from '../../../web/src/server/api.ts';
import {
  dropTicket,
  endStaffSession,
  keepTicket,
  staffToken,
  startStaffSession,
  ticket,
} from './session.ts';
import type { EnrolState, LinkState, StaffAccount } from './types.ts';

// Nothing is reported as done unless the API confirmed it. When no answer comes back the
// page says the outcome is not known. Every change here can be asked for again safely: the
// API applies it once.

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const LINK_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const origin = (): string =>
  (process.env.CONSOLE_ORIGIN ?? 'http://localhost:3200').replace(/\/$/, '');

/** No answer, an unreadable answer or a server fault: nothing is known about the outcome. */
const unknown = (reply: Extract<ApiReply<unknown>, { ok: false }>): boolean =>
  reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable';

// ---------------------------------------------------------------------------------------------
// Sign-in and sign-out
// ---------------------------------------------------------------------------------------------
export async function signInAction(form: FormData): Promise<void> {
  const reply = await api<{ ticket: string }>('POST', '/staff/sign-in', {
    body: { email: text(form, 'email'), password: text(form, 'password') },
  });
  if (reply.ok) {
    await keepTicket(reply.data.ticket);
    redirect('/sign-in/code');
  }
  redirect(`/sign-in?error=${unknown(reply) ? 'unavailable' : 'refused'}`);
}

export async function signInCodeAction(form: FormData): Promise<void> {
  const held = await ticket();
  if (!held) redirect('/sign-in?error=expired');
  const reply = await api<{ token: string }>('POST', '/staff/sign-in/code', {
    body: { ticket: held, code: text(form, 'code') },
  });
  if (reply.ok) {
    await startStaffSession(reply.data.token);
    redirect('/');
  }
  if (reply.code === 'staff_sign_in_expired') {
    await dropTicket();
    redirect('/sign-in?error=expired');
  }
  redirect(`/sign-in/code?error=${unknown(reply) ? 'unconfirmed' : 'code'}`);
}

export async function signOutAction(): Promise<void> {
  const token = await staffToken();
  if (!token) redirect('/sign-in');
  const reply = await api<unknown>('POST', '/staff/sign-out', { token });
  // Ended now, or already ended: either way the server confirmed there is no session.
  if (reply.ok || reply.status === 401) {
    await endStaffSession();
    redirect('/sign-in?done=signed_out');
  }
  redirect('/?error=sign_out_unconfirmed');
}

// ---------------------------------------------------------------------------------------------
// Enrolment. The link's secret arrives from the page's address fragment, which browsers do
// not send to servers, and travels onward in request bodies only.
// ---------------------------------------------------------------------------------------------
export async function enrolStateAction(token: string): Promise<EnrolState> {
  if (!LINK_TOKEN.test(token)) return { step: 'invalid' };
  const reply = await api<{ email: string }>('POST', '/staff/enrolment/state', { body: { token } });
  if (reply.ok) return { step: 'password', email: reply.data.email };
  return unknown(reply) ? { step: 'password', error: 'unavailable' } : { step: 'invalid' };
}

export async function enrolBeginAction(previous: EnrolState, form: FormData): Promise<EnrolState> {
  const token = text(form, 'token');
  const password = text(form, 'password');
  const email = previous.email;
  if (password.length < 12 || password.length > 128)
    return { step: 'password', email, error: 'password_length' };
  if (password !== text(form, 'passwordAgain'))
    return { step: 'password', email, error: 'password_mismatch' };
  const reply = await api<{ email: string; secret: string; otpauthUri: string }>(
    'POST',
    '/staff/enrolment/begin',
    { body: { token, password } },
  );
  if (reply.ok) {
    return {
      step: 'authenticator',
      email: reply.data.email,
      secret: reply.data.secret,
      qr: await QRCode.toString(reply.data.otpauthUri, { type: 'svg', margin: 1 }),
    };
  }
  if (reply.code === 'validation_failed')
    return { step: 'password', email, error: 'password_weak' };
  if (unknown(reply)) return { step: 'password', email, error: 'unavailable' };
  return { step: 'invalid' };
}

export async function enrolCompleteAction(
  previous: EnrolState,
  form: FormData,
): Promise<EnrolState> {
  const reply = await api<{ recoveryCodes: string[] }>('POST', '/staff/enrolment/complete', {
    body: { token: text(form, 'token'), code: text(form, 'code') },
  });
  if (reply.ok)
    return { step: 'done', email: previous.email, recoveryCodes: reply.data.recoveryCodes };
  if (reply.code === 'staff_code_refused' || reply.code === 'validation_failed')
    return { ...previous, step: 'authenticator', error: 'code' };
  if (unknown(reply)) return { ...previous, step: 'authenticator', error: 'unconfirmed' };
  return { step: 'invalid' };
}

// ---------------------------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------------------------
async function signedIn(): Promise<string> {
  const token = await staffToken();
  if (!token) redirect('/sign-in?error=session_ended');
  return token;
}
async function sessionEnded(): Promise<never> {
  await endStaffSession();
  redirect('/sign-in?error=session_ended');
}
/** The code to show for a refusal of a change. */
const refusal = (reply: Extract<ApiReply<unknown>, { ok: false }>): string =>
  unknown(reply)
    ? 'unconfirmed'
    : [
          'staff_privilege_required',
          'staff_self_action',
          'staff_account_disabled',
          'staff_email_taken',
          'validation_failed',
          'not_found',
        ].includes(reply.code)
      ? reply.code
      : 'refused';

export async function createStaffAction(previous: LinkState, form: FormData): Promise<LinkState> {
  const token = await signedIn();
  const key = text(form, 'retryKey');
  const retryKey = RETRY_KEY.test(key) ? key : randomUUID();
  const declared = text(form, 'participantLink');
  if (declared !== 'declared' && declared !== 'declared_none')
    return { error: 'declaration_missing', retryKey };
  const reply = await api<{ account: StaffAccount; enrolmentToken: string; linkExpiresAt: string }>(
    'POST',
    '/staff/accounts',
    {
      token,
      retryKey,
      body: {
        email: text(form, 'email'),
        displayName: text(form, 'displayName'),
        participantLink: declared,
        participantPhone: declared === 'declared' ? text(form, 'participantPhone') : null,
      },
    },
  );
  if (reply.ok) {
    revalidatePath('/staff');
    return {
      link: `${origin()}/enrol#${reply.data.enrolmentToken}`,
      email: reply.data.account.email,
      expiresAt: reply.data.linkExpiresAt,
    };
  }
  if (reply.status === 401) await sessionEnded();
  // The same key goes back to the form: sending the same details again creates nothing more.
  return { error: refusal(reply), retryKey };
}

export async function issueLinkAction(previous: LinkState, form: FormData): Promise<LinkState> {
  const token = await signedIn();
  const id = text(form, 'staffId');
  if (!UUID.test(id)) return { error: 'not_found' };
  const reply = await api<{ account: StaffAccount; enrolmentToken: string; linkExpiresAt: string }>(
    'POST',
    `/staff/accounts/${id}/enrolment`,
    { token },
  );
  if (reply.ok) {
    revalidatePath('/staff');
    return {
      link: `${origin()}/enrol#${reply.data.enrolmentToken}`,
      email: reply.data.account.email,
      expiresAt: reply.data.linkExpiresAt,
    };
  }
  if (reply.status === 401) await sessionEnded();
  return { error: refusal(reply) };
}

async function change(id: string, route: string, body: unknown, done: string): Promise<never> {
  const token = await signedIn();
  if (!UUID.test(id)) redirect('/staff?error=not_found');
  const reply = await api<{ outcome: 'changed' | 'unchanged' }>(
    'POST',
    `/staff/accounts/${id}/${route}`,
    { token, body },
  );
  if (reply.ok)
    redirect(`/staff?done=${reply.data.outcome === 'changed' ? done : 'unchanged'}#account-${id}`);
  if (reply.status === 401) await sessionEnded();
  redirect(`/staff?error=${refusal(reply)}#account-${id}`);
}

export async function setStatusAction(form: FormData): Promise<void> {
  const status = text(form, 'status') === 'enabled' ? 'enabled' : 'disabled';
  await change(text(form, 'staffId'), 'status', { status }, status);
}

export async function setPrivilegeAction(form: FormData): Promise<void> {
  const granted = text(form, 'granted') === 'true';
  await change(
    text(form, 'staffId'),
    'privileges',
    { privilege: text(form, 'privilege'), granted },
    granted ? 'granted' : 'removed',
  );
}

export async function setParticipantLinkAction(form: FormData): Promise<void> {
  const declared = text(form, 'participantLink');
  await change(
    text(form, 'staffId'),
    'participant-link',
    {
      participantLink: declared,
      participantPhone: declared === 'declared' ? text(form, 'participantPhone') : null,
    },
    'declared',
  );
}

// ---------------------------------------------------------------------------------------------
// Organisation verification
// ---------------------------------------------------------------------------------------------
const REVIEW_REFUSALS = [
  'staff_privilege_required',
  'reviewer_not_independent',
  'different_person_required',
  'application_changed',
  'application_not_open',
  'organisation_not_verified',
  'validation_failed',
  'not_found',
];
const reviewRefusal = (reply: Extract<ApiReply<unknown>, { ok: false }>): string => {
  if (unknown(reply)) return 'unconfirmed';
  if (reply.code === 'reviewer_not_independent') {
    const reason = reply.details.reason;
    return typeof reason === 'string' && /^[a-z_]{1,40}$/.test(reason) ? reason : 'connected';
  }
  return REVIEW_REFUSALS.includes(reply.code) ? reply.code : 'refused';
};

export async function decideVerificationAction(form: FormData): Promise<void> {
  const token = await signedIn();
  const id = text(form, 'applicationId');
  if (!UUID.test(id)) redirect('/verification?error=not_found');
  // One choice carries the decision and its reason, so the two always belong together.
  const [decision = '', reason = ''] = text(form, 'decision').split(':');
  if (!decision || !reason) redirect(`/verification/${id}?error=decision_missing`);
  const note = text(form, 'note').trim();
  const version = text(form, 'version');
  const reply = await api<{ outcome: 'decided' | 'already_decided' | 'claim_review' }>(
    'POST',
    `/staff/verification/${id}/decision`,
    {
      token,
      body: {
        version: Number(version),
        decision,
        reason,
        note: note === '' ? null : note,
        noConflict: text(form, 'noConflict') === 'yes',
      },
    },
  );
  if (reply.ok) redirect(`/verification/${id}?done=${reply.data.outcome}`);
  if (reply.status === 401) await sessionEnded();
  const code = reviewRefusal(reply);
  // With no answer the outcome is unknown. What was sent goes back with the page, so that the
  // same request can be sent again: the API recognises it and records nothing twice. The note
  // is not carried in the address; the API does not compare it.
  const sent = /^[0-9]{1,9}$/.test(version) ? `&sent=${version}.${decision}:${reason}` : '';
  redirect(`/verification/${id}?error=${code}${code === 'unconfirmed' ? sent : ''}`);
}

export async function revokeVerificationAction(form: FormData): Promise<void> {
  const token = await signedIn();
  const id = text(form, 'organisationId').trim();
  const back = `/verification/withdraw?organisation=${UUID.test(id) ? id : ''}`;
  if (!UUID.test(id)) redirect(`${back}&error=not_found`);
  const note = text(form, 'note').trim();
  const reply = await api<{ outcome: 'revoked' | 'already_revoked' }>(
    'POST',
    `/staff/verification/organisations/${id}/revoke`,
    {
      token,
      body: {
        capability: text(form, 'capability'),
        reason: text(form, 'reason'),
        note: note === '' ? null : note,
        noConflict: text(form, 'noConflict') === 'yes',
      },
    },
  );
  if (reply.ok) redirect(`${back}&done=${reply.data.outcome}`);
  if (reply.status === 401) await sessionEnded();
  redirect(`${back}&error=${reviewRefusal(reply)}`);
}
