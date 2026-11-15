'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { defaultLocale, isLocale, type Locale } from '../i18n/config.ts';
import { api, type ApiReply } from './api.ts';
import { endSession, sessionToken } from './session.ts';

// Fleet and drivers from the web pages. As everywhere: every action ends in a redirect,
// problems travel as short codes, nothing is reported as done unless the server confirmed it,
// and an answer that never arrived keeps the same retry key so sending again cannot apply twice.

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
const CODE = /^[a-z][a-z0-9_]{1,39}$/;

const unknown = (reply: Extract<ApiReply<unknown>, { ok: false }>): boolean =>
  reply.status === 0 || reply.status >= 500 || reply.code === 'unavailable';

function problemCodes(details: Record<string, unknown>): string {
  const problems = Array.isArray(details.problems)
    ? (details.problems as { field?: unknown; code?: unknown }[])
    : [];
  const codes = problems
    .filter((problem) => typeof problem.field === 'string' && typeof problem.code === 'string')
    .map((problem) => `${problem.field as string}:${problem.code as string}`)
    .filter((code) => /^[A-Za-z0-9_.:]{1,120}$/.test(code));
  return codes.length > 0 ? [...new Set(codes)].join(',') : 'invalid';
}
const withQuery = (path: string, values: Record<string, string | undefined>): string => {
  const params = new URLSearchParams(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();
  return params ? `${path}?${params}` : path;
};

/** A document form in the shape the API takes. */
function documentContent(form: FormData): Record<string, unknown> {
  const issue = text(form, 'issueDate').trim();
  return {
    type: text(form, 'type'),
    documentNumber: text(form, 'documentNumber'),
    issuingCountry: text(form, 'issuingCountry'),
    ...(issue === '' ? {} : { issueDate: issue }),
    expiryDate: text(form, 'expiryDate').trim(),
    licenceClasses: form
      .getAll('licenceClass')
      .filter((value): value is string => typeof value === 'string' && CODE.test(value)),
  };
}

/** What a document form lacks, found before anything is sent. */
function documentProblems(form: FormData): string[] {
  const problems: string[] = [];
  if (text(form, 'type') === '') problems.push('type:unavailable');
  if (text(form, 'documentNumber').trim() === '') problems.push('documentNumber:required');
  if (text(form, 'issuingCountry') === '') problems.push('issuingCountry:unavailable');
  if (text(form, 'expiryDate').trim() === '') problems.push('expiryDate:required');
  return problems;
}

/**
 * Sends one command and redirects. `operation` names the retry key in the address and the
 * "not confirmed" message; `anchor` is where a refused form is on the page.
 */
async function command(
  form: FormData,
  options: {
    operation: string;
    path: (ids: { organisationId: string }) => string | null;
    here: (locale: Locale, organisationId: string) => string;
    body: Record<string, unknown>;
    anchor?: string;
    problems?: string[];
  },
): Promise<never> {
  const locale = localeOf(form);
  const token = await sessionToken();
  if (!token) redirect(`/${locale}/sign-in?error=session_ended`);
  const organisationId = text(form, 'organisationId');
  const key = text(form, 'retryKey');
  const retryKey = RETRY_KEY.test(key) ? key : randomUUID();
  const here = options.here(locale, organisationId);
  const anchor = options.anchor ? `#${options.anchor}` : '';
  const back = (error: string, keep: boolean): never =>
    redirect(
      withQuery(here, {
        fError: error,
        fAt: options.operation,
        ...(keep ? { [`${options.operation}Retry`]: retryKey } : {}),
      }) + anchor,
    );
  const path = options.path({ organisationId });
  if (path === null) back('not_found', false);
  if (options.problems && options.problems.length > 0) back(options.problems.join(','), true);
  const reply = await api<{ outcome: string }>('POST', path!, {
    token,
    retryKey,
    body: options.body,
  });
  if (reply.ok) redirect(withQuery(here, { fDone: reply.data.outcome }));
  if (reply.status === 401) {
    await endSession();
    redirect(`/${locale}/sign-in?error=session_ended`);
  }
  if (unknown(reply)) back(`${options.operation}_unconfirmed`, true);
  if (reply.code === 'validation_failed') back(problemCodes(reply.details), true);
  return back(reply.code, false);
}

const fleetPage = (locale: Locale, organisationId: string): string =>
  `/${locale}/organisations/${organisationId}/fleet`;
const organisation = (form: FormData): string | null => {
  const id = text(form, 'organisationId');
  return UUID.test(id) ? id : null;
};
const within =
  (form: FormData, rest: (organisationId: string) => string | null) => (): string | null => {
    const id = organisation(form);
    return id === null ? null : rest(id);
  };
const version = (form: FormData): number => Number(text(form, 'version'));

// The carrier --------------------------------------------------------------------------------
export async function registerVehicleAction(form: FormData): Promise<void> {
  const problems: string[] = [];
  for (const field of ['kind', 'category', 'equipmentType', 'registrationCountry'])
    if (text(form, field) === '') problems.push(`${field}:required`);
  if (text(form, 'registrationNumber').trim() === '') problems.push('registrationNumber:invalid');
  await command(form, {
    operation: 'vehicle',
    path: within(form, (id) => `/organisations/${id}/fleet/vehicles`),
    here: fleetPage,
    anchor: 'vehicle-form',
    problems,
    body: {
      kind: text(form, 'kind'),
      category: text(form, 'category'),
      equipmentType: text(form, 'equipmentType'),
      registrationCountry: text(form, 'registrationCountry'),
      registrationNumber: text(form, 'registrationNumber').slice(0, 40),
    },
  });
}

export async function inviteDriverAction(form: FormData): Promise<void> {
  await command(form, {
    operation: 'invite',
    path: within(form, (id) => `/organisations/${id}/fleet/drivers`),
    here: fleetPage,
    anchor: 'invite-form',
    body: { phone: text(form, 'phone').replace(/[\s-]/g, '').slice(0, 20) },
  });
}

export async function endAffiliationAction(form: FormData): Promise<void> {
  const affiliation = text(form, 'affiliationId');
  await command(form, {
    operation: 'end',
    path: within(form, (id) =>
      UUID.test(affiliation) ? `/organisations/${id}/fleet/drivers/${affiliation}/end` : null,
    ),
    here: fleetPage,
    body: { version: version(form) },
  });
}

/** Authorises a driver for every vehicle of the carrier, or takes that back. */
export async function authoriseDriverAction(form: FormData): Promise<void> {
  const affiliation = text(form, 'affiliationId');
  await command(form, {
    operation: 'authorise',
    path: within(form, (id) =>
      UUID.test(affiliation)
        ? `/organisations/${id}/fleet/drivers/${affiliation}/authorisations`
        : null,
    ),
    here: fleetPage,
    body: { vehicleId: null, granted: text(form, 'granted') === 'yes' },
  });
}

const vehiclePage =
  (vehicle: string) =>
  (locale: Locale, organisationId: string): string =>
    `/${locale}/organisations/${organisationId}/fleet/vehicles/${vehicle}`;

export async function retireVehicleAction(form: FormData): Promise<void> {
  const vehicle = text(form, 'vehicleId');
  await command(form, {
    operation: 'retire',
    path: within(form, (id) =>
      UUID.test(vehicle) ? `/organisations/${id}/fleet/vehicles/${vehicle}/retire` : null,
    ),
    here: UUID.test(vehicle) ? vehiclePage(vehicle) : fleetPage,
    body: { version: version(form) },
  });
}

export async function submitVehicleDocumentAction(form: FormData): Promise<void> {
  const vehicle = text(form, 'vehicleId');
  await command(form, {
    operation: 'document',
    path: within(form, (id) =>
      UUID.test(vehicle) ? `/organisations/${id}/fleet/vehicles/${vehicle}/documents` : null,
    ),
    here: UUID.test(vehicle) ? vehiclePage(vehicle) : fleetPage,
    anchor: 'document-form',
    problems: documentProblems(form),
    body: documentContent(form),
  });
}

// The driver ---------------------------------------------------------------------------------
const driverPage = (locale: Locale): string => `/${locale}/driver`;

export async function respondInvitationAction(form: FormData): Promise<void> {
  const invitation = text(form, 'affiliationId');
  const decision = text(form, 'decision') === 'accept' ? 'accept' : 'decline';
  await command(form, {
    operation: 'respond',
    path: () => (UUID.test(invitation) ? `/me/driver/invitations/${invitation}/respond` : null),
    here: driverPage,
    body: { version: version(form), decision },
  });
}

export async function leaveAffiliationAction(form: FormData): Promise<void> {
  const affiliation = text(form, 'affiliationId');
  await command(form, {
    operation: 'leave',
    path: () => (UUID.test(affiliation) ? `/me/driver/affiliations/${affiliation}/leave` : null),
    here: driverPage,
    body: { version: version(form) },
  });
}

export async function submitDriverDocumentAction(form: FormData): Promise<void> {
  await command(form, {
    operation: 'document',
    path: () => '/me/driver/documents',
    here: driverPage,
    anchor: 'document-form',
    problems: documentProblems(form),
    body: documentContent(form),
  });
}
