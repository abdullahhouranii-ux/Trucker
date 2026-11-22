'use server';

import { redirect } from 'next/navigation';
import { createHash } from 'node:crypto';
import { api, apiPutFile, type ApiReply } from '../../../web/src/server/api.ts';
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

async function send(
  form: FormData,
  path: string | null,
  body: Record<string, unknown>,
  retryKey?: string,
  donePrefix = '',
) {
  const here = back(form);
  const join = (query: string) => `${here}?${query}#${text(form, 'anchor') || 'main'}`;
  const token = await staffToken();
  if (!token) redirect('/sign-in?error=session_ended');
  if (path === null) redirect(join('error=validation_failed'));
  const reply = await api<{ outcome: string }>('POST', path!, {
    token,
    body,
    ...(retryKey ? { retryKey } : {}),
  });
  if (reply.ok) redirect(join(`done=${donePrefix}${reply.data.outcome}`));
  if (reply.status === 401) {
    await endStaffSession();
    redirect('/sign-in?error=session_ended');
  }
  if (unknown(reply))
    redirect(join(`error=unconfirmed${retryKey ? `&key=${encodeURIComponent(retryKey)}` : ''}`));
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
      ...shortfall(form),
    },
  );
}

/** What fell short and why (slice 18d): sent whenever cargo stays on the vehicle. */
function shortfall(form: FormData): Record<string, unknown> {
  const short = ['partly_delivered', 'refused', 'not_delivered'].includes(text(form, 'outcome'));
  if (!short && text(form, 'cargoRemains') !== 'true') return {};
  const optional = (name: string) => text(form, name).trim().slice(0, 1000) || null;
  return {
    shortfall: {
      reason: text(form, 'shortfallReason'),
      refusalReason: optional('refusalReason'),
      location: text(form, 'shortfallLocation').trim().slice(0, 500),
      cargoCondition: text(form, 'cargoCondition').trim().slice(0, 1000),
      quantityUnit: text(form, 'quantityUnit').trim().slice(0, 40),
      quantityDelivered: text(form, 'quantityDelivered').trim().slice(0, 12),
      quantityRemaining: text(form, 'quantityRemaining').trim().slice(0, 12),
      contactAttempts: Number.parseInt(text(form, 'contactAttempts') || '0', 10),
      contactNote: optional('contactNote'),
      evidenceNote: optional('evidenceNote'),
    },
  };
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
      quantity: text(form, 'quantity').trim().slice(0, 12),
      condition: text(form, 'condition').trim().slice(0, 1000),
      handedByStanding: text(form, 'handedByStanding').trim().slice(0, 300),
      receivedByStanding: text(form, 'receivedByStanding').trim().slice(0, 300),
      evidenceNote: text(form, 'evidenceNote').trim().slice(0, 1000) || null,
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

const CARGO = [
  'authority_order',
  'close_case',
  'record_liability',
  'decide_claim',
  'release_hold',
  'confirm_receipt',
];
const RETRY = /^[A-Za-z0-9._-]{16,128}$/;

/**
 * Operations on undeliverable cargo (slice 18d): an authority's instruction, a receipt, the
 * final liability from its source, a claim decided, a hold released, the case closed. Each
 * form carries its retry key, so an answer that never arrived is not acted on twice.
 */
export async function operationsCargoAction(form: FormData): Promise<void> {
  const id = text(form, 'bookingId');
  const command = text(form, 'submitCommand') || text(form, 'command');
  const retry = text(form, 'retryKey');
  const optional = (name: string, max: number) => text(form, name).trim().slice(0, max) || null;
  const body: Record<string, unknown> = { command };
  switch (command) {
    case 'authority_order':
      Object.assign(body, {
        order: optional('order', 2000),
        allowedActions: form.getAll('allowedActions').filter((value) => typeof value === 'string'),
      });
      break;
    case 'close_case':
      Object.assign(body, { note: optional('note', 2000) });
      break;
    case 'record_liability':
      Object.assign(body, {
        costId: text(form, 'costId'),
        liability: text(form, 'liability'),
        source: text(form, 'source'),
        reference: optional('reference', 500),
      });
      break;
    case 'decide_claim':
      Object.assign(body, {
        claimId: text(form, 'claimId'),
        decision: text(form, 'decision'),
        source: text(form, 'source'),
        reference: optional('reference', 500),
      });
      break;
    case 'release_hold':
      Object.assign(body, { holdId: text(form, 'holdId'), note: optional('note', 2000) });
      break;
    default:
      Object.assign(body, {
        handoverId: text(form, 'handoverId'),
        state: text(form, 'state'),
        reference: optional('reference', 500),
      });
  }
  await send(
    form,
    UUID.test(id) && CARGO.includes(command) && RETRY.test(retry)
      ? `/staff/operations/bookings/${id}/cargo`
      : null,
    body,
    retry,
    'cargo_',
  );
}

/**
 * A paper proof of delivery uploaded on the driver's behalf (slice 18b): the manifest first,
 * then each file. The fingerprint is computed on the bytes this server received.
 */
export async function operationsPodAction(form: FormData): Promise<void> {
  const id = text(form, 'bookingId');
  const here = `/operations/bookings/${id}`;
  function go(query: string): never {
    redirect(`${here}?${query}#pod`);
  }
  const token = await staffToken();
  if (!token) redirect('/sign-in?error=session_ended');
  const chosen = ['signature', 'signed_document', 'delivery_note', 'cargo_photo', 'other'].flatMap(
    (kind) =>
      form
        .getAll(`file-${kind}`)
        .filter((value): value is File => value instanceof File && value.size > 0)
        .map((file) => ({ kind, file })),
  );
  const capturedAt = text(form, 'capturedAt');
  if (!UUID.test(id) || chosen.length === 0 || chosen.length > 10 || !MINUTE.test(capturedAt))
    go('error=validation_failed');
  const items = await Promise.all(
    chosen.map(async ({ kind, file }) => ({
      kind,
      mediaType: file.type,
      sizeBytes: file.size,
      fingerprint: createHash('sha256')
        .update(Buffer.from(await file.arrayBuffer()))
        .digest('hex'),
    })),
  );
  const note = text(form, 'note').trim();
  const replaces = text(form, 'replacesReason').trim();
  const declared = await api<{ pod: { versions: { items: { id: string }[] }[] } }>(
    'POST',
    `/staff/operations/bookings/${id}/pod`,
    {
      token,
      body: {
        version: Number.parseInt(text(form, 'version'), 10) || 1,
        reason: text(form, 'reason'),
        note: note === '' ? null : note.slice(0, 1000),
        capturedAt: `${capturedAt}:00Z`,
        receiverName: text(form, 'receiverName').trim().slice(0, 200) || null,
        replacesReason: replaces === '' ? null : replaces.slice(0, 1000),
        items,
      },
    },
  );
  if (!declared.ok) {
    if (declared.status === 401) {
      await endStaffSession();
      redirect('/sign-in?error=session_ended');
    }
    go(unknown(declared) ? 'error=unconfirmed' : `error=${encodeURIComponent(declared.code)}`);
  }
  const version = declared.data.pod.versions.at(-1)!;
  for (const [index, item] of version.items.entries()) {
    const file = chosen[index]!.file;
    const sent = await apiPutFile(`/staff/operations/bookings/${id}/pod/items/${item.id}`, {
      token: token!,
      mediaType: file.type,
      bytes: await file.arrayBuffer(),
    });
    if (!sent.ok)
      go(unknown(sent) ? 'error=unconfirmed' : `error=${encodeURIComponent(sent.code)}`);
  }
  go('done=pod_captured');
}
