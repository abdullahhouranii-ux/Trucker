'use server';

import { redirect } from 'next/navigation';
import { api, type ApiReply } from '../../../web/src/server/api.ts';
import { endStaffSession, staffToken } from './session.ts';

// Trucker operations on trips (slice 17b). Every action ends in a redirect to the page it came
// from, with what happened. Nothing is reported as done unless the API confirmed it.

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const unknown = (reply: Extract<ApiReply<unknown>, { ok: false }>): boolean =>
  reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable';

/** Where to go back to: the queue, or one booking's page. */
const back = (form: FormData): string => {
  const booking = text(form, 'bookingId');
  return UUID.test(booking) ? `/operations/bookings/${booking}` : '/operations';
};

async function send(form: FormData, path: string | null, body: Record<string, unknown>) {
  const here = back(form);
  const join = (query: string) => `${here}?${query}#${text(form, 'anchor') || 'main'}`;
  const token = await staffToken();
  if (!token) redirect('/sign-in?error=session_ended');
  if (path === null) redirect(join('error=validation_failed'));
  const reply = await api<{ outcome: string }>('POST', path, { token, body });
  if (reply.ok) redirect(join(`done=${reply.data.outcome}`));
  if (reply.status === 401) {
    await endStaffSession();
    redirect('/sign-in?error=session_ended');
  }
  if (unknown(reply)) redirect(join('error=unconfirmed'));
  redirect(join(`error=${encodeURIComponent(reply.code)}`));
}

/** Acknowledge a case, record an action on it, or resolve it. */
export async function caseAction(form: FormData): Promise<void> {
  const id = text(form, 'caseId');
  const action = text(form, 'action');
  const note = text(form, 'note').trim();
  await send(
    form,
    UUID.test(id) && ['acknowledge', 'action', 'resolve'].includes(action)
      ? `/staff/operations/cases/${id}/action`
      : null,
    {
      version: Number(text(form, 'version')),
      action,
      note: note === '' ? null : note.slice(0, 2000),
    },
  );
}

/** Block a dispatch with a reason and a note, or lift the block with a note. */
export async function blockAction(form: FormData): Promise<void> {
  const id = text(form, 'bookingId');
  const block = text(form, 'block') === 'true';
  const reason = text(form, 'reason');
  await send(form, UUID.test(id) ? `/staff/operations/bookings/${id}/block` : null, {
    block,
    reason: block ? reason : null,
    note: text(form, 'note').trim().slice(0, 1000),
  });
}

/** Put a trip on hold, or resume it. */
export async function holdAction(form: FormData): Promise<void> {
  const id = text(form, 'bookingId');
  const hold = text(form, 'hold') === 'true';
  await send(form, UUID.test(id) ? `/staff/operations/bookings/${id}/hold` : null, {
    hold,
    reason: hold ? text(form, 'reason') : null,
    note: text(form, 'note').trim().slice(0, 1000),
  });
}

/** Record the next milestone on the driver's behalf. Times are entered in UTC. */
export async function operationsMilestoneAction(form: FormData): Promise<void> {
  const id = text(form, 'bookingId');
  const statedAt = text(form, 'statedAt');
  const note = text(form, 'note').trim();
  await send(
    form,
    UUID.test(id) && MINUTE.test(statedAt) ? `/staff/operations/bookings/${id}/milestones` : null,
    {
      version: Number(text(form, 'version')),
      milestone: text(form, 'milestone'),
      statedAt: `${statedAt}:00Z`,
      reason: text(form, 'reason'),
      note: note === '' ? null : note.slice(0, 500),
    },
  );
}

/** Withdraw the latest milestone, recorded by mistake. */
export async function withdrawMilestoneAction(form: FormData): Promise<void> {
  const id = text(form, 'bookingId');
  await send(form, UUID.test(id) ? `/staff/operations/bookings/${id}/milestones/withdraw` : null, {
    version: Number(text(form, 'version')),
    note: text(form, 'note').trim().slice(0, 1000),
  });
}

/** Open a booking by its identifier. */
export async function findBookingAction(form: FormData): Promise<void> {
  const id = text(form, 'booking').trim().toLowerCase();
  redirect(UUID.test(id) ? `/operations/bookings/${id}` : '/operations?error=not_found#find');
}

/** Record the delivery outcome on the driver's behalf, or correct it with a note (slice 18a). */
export async function operationsDeliveryAction(form: FormData): Promise<void> {
  const id = text(form, 'bookingId');
  const statedAt = text(form, 'statedAt');
  const receiverName = text(form, 'receiverName').trim();
  const remarks = text(form, 'remarks').trim();
  const note = text(form, 'note').trim();
  await send(
    form,
    UUID.test(id) && MINUTE.test(statedAt) ? `/staff/operations/bookings/${id}/delivery` : null,
    {
      version: Number(text(form, 'version')),
      outcome: text(form, 'outcome'),
      receiverName: receiverName === '' ? null : receiverName.slice(0, 200),
      remarks: remarks === '' ? null : remarks.slice(0, 2000),
      cargoRemains: text(form, 'cargoRemains') === 'true',
      statedAt: `${statedAt}:00Z`,
      reason: text(form, 'reason'),
      note: note === '' ? null : note.slice(0, 1000),
    },
  );
}

/** Record the handover of cargo left on the vehicle. */
export async function operationsHandoverAction(form: FormData): Promise<void> {
  const id = text(form, 'bookingId');
  const handedAt = text(form, 'handedAt');
  const note = text(form, 'note').trim();
  await send(
    form,
    UUID.test(id) && MINUTE.test(handedAt) ? `/staff/operations/bookings/${id}/handover` : null,
    {
      kind: text(form, 'kind'),
      handedBy: text(form, 'handedBy').trim().slice(0, 200),
      receivedBy: text(form, 'receivedBy').trim().slice(0, 200),
      handedAt: `${handedAt}:00Z`,
      place: text(form, 'place').trim().slice(0, 500),
      note: note === '' ? null : note.slice(0, 1000),
    },
  );
}

/** Release a resource; with custody open only as an operations release, with a note. */
export async function operationsReleaseAction(form: FormData): Promise<void> {
  const id = text(form, 'bookingId');
  const role = text(form, 'role');
  const note = text(form, 'note').trim();
  await send(
    form,
    UUID.test(id) && ['truck', 'trailer', 'driver'].includes(role)
      ? `/staff/operations/bookings/${id}/resources/${role}/release`
      : null,
    { override: text(form, 'override') === 'true', note: note === '' ? null : note.slice(0, 1000) },
  );
}
