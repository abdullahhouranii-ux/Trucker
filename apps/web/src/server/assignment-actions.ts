'use server';

import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, type ApiReply } from './api.ts';
import { endSession, sessionToken } from './session.ts';

// Assignment, substitution decisions, the shipper's wait and the driver's acknowledgement.
// Every action ends in a redirect and problems travel as short codes. None of these commands
// needs a retry key: each states what should be so, and sending it again when it already is so
// changes nothing. When an answer never arrives the page says so and shows what now stands.

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const localeOf = (form: FormData): Locale => {
  const value = text(form, 'locale');
  return isLocale(value) ? value : defaultLocale;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD = /^[a-z_]{1,40}$/;
const unknown = (reply: Extract<ApiReply<unknown>, { ok: false }>): boolean =>
  reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable';
const withQuery = (path: string, values: Record<string, string | undefined>): string => {
  const params = new URLSearchParams(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();
  return params ? `${path}?${params}` : path;
};
const member = (form: FormData, name: string): string | null | undefined => {
  const value = text(form, name);
  if (value === '') return null;
  return UUID.test(value) ? value : undefined;
};

async function command(
  form: FormData,
  options: {
    operation: string;
    path: string | null;
    here: string;
    anchor: string;
    body?: Record<string, unknown>;
    /** Dispatch only: the same key is sent again when an answer never arrived. */
    retryKey?: string;
  },
): Promise<never> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const back = (error: string, extra: Record<string, string | undefined> = {}): never =>
    redirect(withQuery(options.here, { aError: error, ...extra }) + `#${options.anchor}`);
  if (options.path === null) back('invalid');
  const reply = await api<{ outcome: string }>('POST', options.path!, {
    token,
    ...(options.body ? { body: options.body } : {}),
    ...(options.retryKey ? { retryKey: options.retryKey } : {}),
  });
  if (reply.ok) redirect(withQuery(options.here, { aDone: reply.data.outcome }));
  if (reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
  if (unknown(reply)) back(`${options.operation}_unconfirmed`, { aKey: options.retryKey });
  if (reply.code === 'validation_failed') back('invalid');
  // Which resource, and why: two short words from a fixed vocabulary.
  const role = reply.details.role;
  const reason = reply.details.reason;
  const cause = reply.details.cause;
  return back(reply.code, {
    aRole: typeof role === 'string' && WORD.test(role) ? role : undefined,
    aReason: typeof reason === 'string' && WORD.test(reason) ? reason : undefined,
    aCause: typeof cause === 'string' && WORD.test(cause) ? cause : undefined,
  });
}

const bookingPage = (
  form: FormData,
): { here: string; organisationId: string | null; bookingId: string | null } => {
  const organisationId = text(form, 'organisationId');
  const bookingId = text(form, 'bookingId');
  const valid = UUID.test(organisationId) && UUID.test(bookingId);
  return {
    here: valid
      ? `/${localeOf(form)}/organisations/${organisationId}/bookings/${bookingId}`
      : `/${localeOf(form)}/account`,
    organisationId: valid ? organisationId : null,
    bookingId: valid ? bookingId : null,
  };
};

/** The carrier sets the whole assigned set. */
export async function assignResourcesAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const truckId = member(form, 'truckId');
  const trailerId = member(form, 'trailerId');
  const driverId = member(form, 'driverId');
  const version = Number(text(form, 'version'));
  const valid =
    organisationId !== null &&
    truckId !== undefined &&
    trailerId !== undefined &&
    driverId !== undefined &&
    Number.isInteger(version) &&
    version >= 0;
  await command(form, {
    operation: 'assign',
    path: valid ? `/organisations/${organisationId}/bookings/${bookingId}/assignment` : null,
    here,
    anchor: 'assign',
    body: { version, truckId, trailerId, driverId },
  });
}

/** The shipper accepts or declines a proposed substitution; the carrier withdraws it. */
export async function decideSubstitutionAction(form: FormData): Promise<void> {
  const { here, organisationId } = bookingPage(form);
  const substitutionId = text(form, 'substitutionId');
  const decision = text(form, 'decision');
  const version = Number(text(form, 'version'));
  const valid =
    organisationId !== null &&
    UUID.test(substitutionId) &&
    ['accept', 'decline', 'withdraw'].includes(decision) &&
    Number.isInteger(version) &&
    version >= 1;
  await command(form, {
    operation: 'decide',
    path: valid
      ? `/organisations/${organisationId}/substitutions/${substitutionId}/decision`
      : null,
    here,
    anchor: 'substitution',
    body: { version, decision },
  });
}

/** The shipper records a decision to wait after a missed assignment deadline. */
export async function waitForCarrierAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  await command(form, {
    operation: 'wait',
    path: organisationId ? `/organisations/${organisationId}/bookings/${bookingId}/wait` : null,
    here,
    anchor: 'state',
  });
}

/** The driver acknowledges the assignment they were shown. */
export async function acknowledgeAssignmentAction(form: FormData): Promise<void> {
  const bookingId = text(form, 'bookingId');
  const version = Number(text(form, 'version'));
  const valid = UUID.test(bookingId) && Number.isInteger(version) && version >= 1;
  await command(form, {
    operation: 'acknowledge',
    path: valid ? `/me/driver/assignments/${bookingId}/acknowledge` : null,
    here: `/${localeOf(form)}/driver`,
    anchor: 'assignments',
    body: { version },
  });
}

/** Cancellation is idempotent for the booking; an unconfirmed answer can be retried. */
export async function cancelBookingAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const version = Number(text(form, 'version'));
  const reason = text(form, 'reason');
  const note = text(form, 'note');
  const valid =
    organisationId !== null &&
    Number.isInteger(version) &&
    version >= 0 &&
    WORD.test(reason) &&
    note.length <= 2000;
  await command(form, {
    operation: 'cancel',
    path: valid ? `/organisations/${organisationId}/bookings/${bookingId}/cancel` : null,
    here,
    anchor: 'cancel-booking',
    body: { version, reason, note },
  });
}

// Slice 17a: dispatch, milestones and the estimate. Times entered on a page are UTC.
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const instant = (form: FormData, name: string): string | null => {
  const value = text(form, name);
  return MINUTE.test(value) && !Number.isNaN(Date.parse(`${value}:00Z`)) ? `${value}:00Z` : null;
};
const MILESTONES = [
  'departed_for_pickup',
  'arrived_at_pickup',
  'loading_started',
  'loaded_departed',
  'arrived_at_delivery',
  'unloading_started',
];
const REASONS = ['no_phone', 'no_signal', 'driver_unable', 'correction', 'other'];

/** The carrier dispatches. A retry key makes a repeated press, or a retry, one dispatch. */
export async function dispatchBookingAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const retryKey = text(form, 'retryKey');
  await command(form, {
    operation: 'dispatch',
    path:
      organisationId && UUID.test(retryKey)
        ? `/organisations/${organisationId}/bookings/${bookingId}/dispatch`
        : null,
    here,
    anchor: 'trip',
    retryKey,
  });
}

/** The carrier records a milestone the driver could not record. */
export async function recordMilestoneOnBehalfAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const version = Number(text(form, 'version'));
  const milestone = text(form, 'milestone');
  const reason = text(form, 'reason');
  const note = text(form, 'note').trim();
  const statedAt = instant(form, 'statedAt');
  const valid =
    organisationId !== null &&
    Number.isInteger(version) &&
    version >= 1 &&
    MILESTONES.includes(milestone) &&
    REASONS.includes(reason) &&
    statedAt !== null &&
    note.length <= 500;
  await command(form, {
    operation: 'milestone',
    path: valid ? `/organisations/${organisationId}/bookings/${bookingId}/milestones` : null,
    here,
    anchor: 'trip',
    body: { version, milestone, statedAt, reason, ...(note ? { note } : {}) },
  });
}

/** The carrier states the estimated arrival. */
export async function stateEstimateAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const arrivalAt = instant(form, 'arrivalAt');
  await command(form, {
    operation: 'estimate',
    path:
      organisationId && arrivalAt
        ? `/organisations/${organisationId}/bookings/${bookingId}/estimate`
        : null,
    here,
    anchor: 'trip',
    body: { arrivalAt },
  });
}

/** The driver records the next milestone as it happens. */
export async function driverMilestoneAction(form: FormData): Promise<void> {
  const bookingId = text(form, 'bookingId');
  const version = Number(text(form, 'version'));
  const milestone = text(form, 'milestone');
  const valid =
    UUID.test(bookingId) &&
    Number.isInteger(version) &&
    version >= 1 &&
    MILESTONES.includes(milestone);
  await command(form, {
    operation: 'milestone',
    path: valid ? `/me/driver/assignments/${bookingId}/milestones` : null,
    here: `/${localeOf(form)}/driver`,
    anchor: 'assignments',
    body: { version, milestone },
  });
}

/** The driver states the estimated arrival. */
export async function driverEstimateAction(form: FormData): Promise<void> {
  const bookingId = text(form, 'bookingId');
  const arrivalAt = instant(form, 'arrivalAt');
  await command(form, {
    operation: 'estimate',
    path: UUID.test(bookingId) && arrivalAt ? `/me/driver/assignments/${bookingId}/estimate` : null,
    here: `/${localeOf(form)}/driver`,
    anchor: 'assignments',
    body: { arrivalAt },
  });
}

// Slice 17b: a problem reported on a trip. The retry key makes a retried report one case.
const EXCEPTION_TYPES = [
  'delay',
  'breakdown',
  'accident',
  'cargo_damage_or_shortage',
  'refused_at_site',
  'receiver_absent',
  'document_problem',
  'road_closed',
  'safety_concern',
  'no_show',
  'other',
];
const problem = (form: FormData) => {
  const type = text(form, 'type');
  const description = text(form, 'description').trim();
  const retryKey = text(form, 'retryKey');
  return {
    valid:
      EXCEPTION_TYPES.includes(type) &&
      description.length >= 1 &&
      description.length <= 2000 &&
      UUID.test(retryKey),
    body: { type, description },
    retryKey,
  };
};

/** The carrier's or the shipper's administrator reports a problem on the trip. */
export async function reportProblemAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const { valid, body, retryKey } = problem(form);
  await command(form, {
    operation: 'report',
    path:
      organisationId && valid
        ? `/organisations/${organisationId}/bookings/${bookingId}/exceptions`
        : null,
    here,
    anchor: 'trip',
    body,
    retryKey,
  });
}

/** The driver reports a problem on the trip. */
export async function driverReportProblemAction(form: FormData): Promise<void> {
  const bookingId = text(form, 'bookingId');
  const { valid, body, retryKey } = problem(form);
  await command(form, {
    operation: 'report',
    path: UUID.test(bookingId) && valid ? `/me/driver/assignments/${bookingId}/exceptions` : null,
    here: `/${localeOf(form)}/driver`,
    anchor: 'assignments',
    body,
    retryKey,
  });
}

// Slice 18a: the delivery outcome, the handover of cargo left on the vehicle, and releases.
const OUTCOMES = [
  'delivered_in_full',
  'delivered_with_remarks',
  'partly_delivered',
  'refused',
  'not_delivered',
];
const outcomeBody = (form: FormData, onBehalf: boolean) => {
  const outcome = text(form, 'outcome');
  const receiverName = text(form, 'receiverName').trim();
  const remarks = text(form, 'remarks').trim();
  const note = text(form, 'note').trim();
  const statedAt = instant(form, 'statedAt');
  const reason = text(form, 'reason');
  const body: Record<string, unknown> = {
    version: Number(text(form, 'version')),
    outcome,
    receiverName: receiverName === '' ? null : receiverName.slice(0, 200),
    remarks: remarks === '' ? null : remarks.slice(0, 2000),
    cargoRemains: text(form, 'cargoRemains') === 'true',
  };
  if (onBehalf)
    Object.assign(body, { statedAt, reason, note: note === '' ? null : note.slice(0, 500) });
  const valid =
    OUTCOMES.includes(outcome) && (!onBehalf || (statedAt !== null && REASONS.includes(reason)));
  return { valid, body };
};

/** The carrier's administrator records the outcome on the driver's behalf. */
export async function recordDeliveryAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const { valid, body } = outcomeBody(form, true);
  await command(form, {
    operation: 'delivery',
    path:
      organisationId && valid
        ? `/organisations/${organisationId}/bookings/${bookingId}/delivery`
        : null,
    here,
    anchor: 'trip',
    body,
  });
}

/** The driver records the outcome as it happens. */
export async function driverDeliveryAction(form: FormData): Promise<void> {
  const bookingId = text(form, 'bookingId');
  const { valid, body } = outcomeBody(form, false);
  await command(form, {
    operation: 'delivery',
    path: UUID.test(bookingId) && valid ? `/me/driver/assignments/${bookingId}/delivery` : null,
    here: `/${localeOf(form)}/driver`,
    anchor: 'assignments',
    body,
  });
}

/** The carrier's administrator records the handover of cargo left on the vehicle. */
export async function recordHandoverAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const handedAt = instant(form, 'handedAt');
  const note = text(form, 'note').trim();
  await command(form, {
    operation: 'handover',
    path:
      organisationId && handedAt
        ? `/organisations/${organisationId}/bookings/${bookingId}/handover`
        : null,
    here,
    anchor: 'trip',
    body: {
      kind: text(form, 'kind'),
      handedBy: text(form, 'handedBy').trim().slice(0, 200),
      receivedBy: text(form, 'receivedBy').trim().slice(0, 200),
      handedAt,
      place: text(form, 'place').trim().slice(0, 500),
      note: note === '' ? null : note.slice(0, 1000),
    },
  });
}

/** The carrier's administrator releases one resource from the trip. */
export async function releaseResourceAction(form: FormData): Promise<void> {
  const { here, organisationId, bookingId } = bookingPage(form);
  const role = text(form, 'role');
  await command(form, {
    operation: 'release',
    path:
      organisationId && ['truck', 'trailer', 'driver'].includes(role)
        ? `/organisations/${organisationId}/bookings/${bookingId}/resources/${role}/release`
        : null,
    here,
    anchor: 'trip',
  });
}
