'use server';

import { createHash } from 'node:crypto';
import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, apiPutFile, type ApiReply, type TripPod } from './api.ts';
import { endSession, sessionToken } from './session.ts';

// Proof of delivery (slice 18b). A capture declares the version's manifest (each file's kind,
// type, size and fingerprint) and then sends each file; the API recomputes each fingerprint and
// refuses a file that differs. The fingerprint is computed here, on the bytes this server
// received from the browser: it proves the transfer to Trucker, not that the delivery happened
// (DI-405). Every action ends in a redirect; problems travel as short codes.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const KINDS = ['signature', 'signed_document', 'delivery_note', 'cargo_photo', 'other'] as const;
const TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_BYTES = 10 * 1024 * 1024;

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const localeOf = (form: FormData): Locale => {
  const value = text(form, 'locale');
  return isLocale(value) ? value : defaultLocale;
};
const unknown = (reply: Extract<ApiReply<unknown>, { ok: false }>): boolean =>
  reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable';
const files = (form: FormData, name: string): File[] =>
  form.getAll(name).filter((value): value is File => value instanceof File && value.size > 0);

/** Where the form came from and where its API routes are: the driver's page, or a booking. */
function place(form: FormData) {
  const locale = localeOf(form);
  const bookingId = text(form, 'bookingId');
  const organisationId = text(form, 'organisationId');
  const driver = text(form, 'driverView') === 'true';
  const valid = UUID.test(bookingId) && (driver || UUID.test(organisationId));
  return {
    valid,
    here: driver
      ? `/${locale}/driver`
      : `/${locale}/organisations/${organisationId}/bookings/${bookingId}`,
    anchor: driver ? 'assignments' : 'pod',
    route: driver
      ? `/me/driver/assignments/${bookingId}/pod`
      : `/organisations/${organisationId}/bookings/${bookingId}/pod`,
    locale,
  };
}

async function signedIn(locale: Locale): Promise<string> {
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  return token;
}
function back(at: ReturnType<typeof place>, values: Record<string, string>): never {
  redirect(`${at.here}?${new URLSearchParams(values).toString()}#${at.anchor}`);
}
async function ended(reply: { status: number }, locale: Locale): Promise<void> {
  if (reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
}

/** Sends one file for one item, after checking its type and size here first. */
async function sendFile(route: string, token: string, itemId: string, file: File) {
  const bytes = await file.arrayBuffer();
  return apiPutFile<{ outcome: string }>(`${route}/items/${itemId}`, {
    token,
    mediaType: file.type,
    bytes,
  });
}

/** Declares a version with the chosen files and sends them, in order. */
export async function podCaptureAction(form: FormData): Promise<void> {
  const at = place(form);
  if (!at.valid) back(at, { aError: 'invalid' });
  const token = await signedIn(at.locale);
  const chosen: { kind: (typeof KINDS)[number]; file: File }[] = [];
  for (const kind of KINDS)
    for (const file of files(form, `file-${kind}`)) chosen.push({ kind, file });
  if (chosen.length === 0 || chosen.length > 10) back(at, { aError: 'pod_files_needed' });
  if (chosen.some(({ file }) => !TYPES.includes(file.type) || file.size > MAX_BYTES))
    back(at, { aError: 'pod_file_rejected' });
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
  const optional = (name: string, max: number) => {
    const value = text(form, name).trim();
    return value === '' ? null : value.slice(0, max);
  };
  const capturedAt = text(form, 'capturedAt');
  const body: Record<string, unknown> = {
    version: Number.parseInt(text(form, 'version'), 10) || 1,
    receiverName: optional('receiverName', 200),
    receiverRole: optional('receiverRole', 200),
    receiverRemarks: optional('receiverRemarks', 2000),
    replacesReason: optional('replacesReason', 1000),
    items,
  };
  if (text(form, 'driverView') !== 'true') {
    body.reason = text(form, 'reason');
    body.note = optional('note', 1000);
    if (MINUTE.test(capturedAt)) body.capturedAt = `${capturedAt}:00Z`;
  }
  const declared = await api<{ pod: TripPod }>('POST', at.route, { token, body });
  if (!declared.ok) {
    await ended(declared, at.locale);
    if (unknown(declared)) back(at, { aError: 'pod_unconfirmed' });
    if (declared.code === 'evidence_missing' && typeof declared.details.missing === 'string')
      back(at, { aError: 'evidence_missing', aReason: declared.details.missing });
    back(at, { aError: declared.code === 'validation_failed' ? 'invalid' : declared.code });
  }
  const version = declared.data.pod.versions.at(-1)!;
  for (const [index, item] of version.items.entries()) {
    const sent = await sendFile(at.route, token, item.id, chosen[index]!.file);
    if (!sent.ok) {
      await ended(sent, at.locale);
      // The version stands; what did not arrive is shown as missing, to be sent again.
      back(at, { aError: unknown(sent) ? 'pod_upload_incomplete' : sent.code });
    }
  }
  back(at, { aDone: 'pod_captured' });
}

/** Sends again one file that did not arrive, for its item. */
export async function podSendAction(form: FormData): Promise<void> {
  const at = place(form);
  const itemId = text(form, 'itemId');
  const [file] = files(form, 'file');
  if (!at.valid || !UUID.test(itemId) || !file) back(at, { aError: 'pod_files_needed' });
  const token = await signedIn(at.locale);
  const sent = await sendFile(at.route, token, itemId, file!);
  if (!sent.ok) {
    await ended(sent, at.locale);
    back(at, { aError: unknown(sent) ? 'pod_upload_incomplete' : sent.code });
  }
  back(at, { aDone: 'pod_file_received' });
}

/** The shipper's administrator accepts the version or asks for more evidence (E-1). */
export async function podReviewAction(form: FormData): Promise<void> {
  const at = place(form);
  const podId = text(form, 'podId');
  const decision = text(form, 'decision');
  if (!at.valid || !UUID.test(podId) || !['accepted', 'more_evidence_requested'].includes(decision))
    back(at, { aError: 'invalid' });
  const token = await signedIn(at.locale);
  const note = text(form, 'note').trim();
  const reply = await api<{ outcome: string }>('POST', `${at.route}/review`, {
    token,
    body: {
      podId,
      version: Number.parseInt(text(form, 'version'), 10),
      decision,
      note: note === '' ? null : note.slice(0, 2000),
    },
  });
  if (!reply.ok) {
    await ended(reply, at.locale);
    back(at, {
      aError: unknown(reply)
        ? 'pod_review_unconfirmed'
        : reply.code === 'validation_failed'
          ? 'pod_note_needed'
          : reply.code,
    });
  }
  back(at, { aDone: `pod_${reply.data.outcome}` });
}
