export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;
  readonly commissionFigures?: { commission: string; net: string };
  constructor(
    status: number,
    code: string,
    retryAfterSeconds?: number,
    commissionFigures?: { commission: string; net: string },
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.commissionFigures = commissionFigures;
  }
}

export function apiOrigin(value: string | undefined, development: boolean): string {
  if (!value) throw new Error('EXPO_PUBLIC_API_URL is required');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use an API origin without credentials or a path');
  if (url.protocol !== 'https:' && !(development && url.protocol === 'http:'))
    throw new Error('HTTPS is required outside development');
  return url.origin;
}

export function createClient(origin: string, fetcher: typeof fetch = fetch) {
  return async function request<T>(
    path: string,
    options: {
      token?: string;
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
      body?: unknown;
      bytes?: ArrayBuffer;
      mediaType?: string;
      key?: string;
      localDemoCode?: boolean;
    } = {},
  ): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
    let response: Response;
    try {
      response = await fetcher(origin + path, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(options.localDemoCode &&
          origin === 'http://127.0.0.1:3000' &&
          path === '/auth/code-requests'
            ? { 'x-trucker-development-code': 'local-visitor' }
            : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.key ? { 'idempotency-key': options.key } : {}),
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.bytes
            ? { 'content-type': options.mediaType ?? 'application/octet-stream' }
            : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.bytes ? { body: options.bytes } : {}),
        signal: AbortSignal.timeout(options.bytes ? 60000 : 15000),
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new ApiFailure(0, 'unconfirmed');
    }
    if (response.status === 204) return undefined as T;
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      details?: { retryAfterSeconds?: unknown; commission?: unknown; net?: unknown };
    } | null;
    if (!response.ok) {
      const wait = body?.details?.retryAfterSeconds;
      const retry =
        typeof wait === 'number' && Number.isSafeInteger(wait) && wait > 0 ? wait : undefined;
      const { commission, net } = body?.details ?? {};
      const figure = (value: unknown): value is string =>
        typeof value === 'string' && /^\d{1,13}(?:\.\d{1,3})?$/.test(value);
      const figures =
        body?.code === 'commission_acceptance_required' && figure(commission) && figure(net)
          ? { commission, net }
          : undefined;
      throw new ApiFailure(response.status, body?.code ?? 'unavailable', retry, figures);
    }
    if (body === null) throw new ApiFailure(0, 'unconfirmed');
    return body as T;
  };
}

type ShipmentPlace = {
  countryCode: string | null;
  address: string | null;
  timeZone?: string | null;
  accessNotes?: string | null;
  from?: { local: string | null; offsetMinutes: number | null };
  until?: { local: string | null; offsetMinutes: number | null };
};
export interface OrganisationShipment {
  id: string;
  shipperReference?: string | null;
  packaging?: string | null;
  equipmentNeeded?: string | null;
  status: string;
  version: number;
  cargoDescription: string | null;
  grossWeightKg: string | null;
  pieces: number | null;
  pickup: ShipmentPlace;
  delivery: ShipmentPlace;
}

export async function loadOrganisationShipment(
  request: ReturnType<typeof createClient>,
  organisationId: string,
  shipmentId: string,
  token: string,
) {
  const { shipment } = await request<{ shipment: OrganisationShipment }>(
    '/organisations/' +
      encodeURIComponent(organisationId) +
      '/shipments/' +
      encodeURIComponent(shipmentId),
    { token },
  );
  return shipment;
}

export async function loadEffectiveCapabilities(
  request: ReturnType<typeof createClient>,
  organisationId: string,
  token: string,
): Promise<string[]> {
  const reply = await request<{
    verification: { capabilities: { capability: string; effective: boolean }[] };
  }>('/organisations/' + encodeURIComponent(organisationId) + '/verification', { token });
  return reply.verification.capabilities
    .filter(({ effective }) => effective)
    .map(({ capability }) => capability);
}

export interface OrganisationShipmentPage {
  shipments: {
    id: string;
    shipperReference?: string | null;
    cargoDescription?: string | null;
    status: string;
  }[];
  nextAfter: string | null;
}

export function loadOrganisationShipments(
  request: ReturnType<typeof createClient>,
  organisationId: string,
  token: string,
  after?: string,
) {
  const query = new URLSearchParams({ status: 'all', ...(after ? { after } : {}) });
  return request<OrganisationShipmentPage>(
    '/organisations/' + organisationId + '/shipments?' + query,
    { token },
  );
}

export interface PublicShipmentPage {
  items: {
    id: string;
    origin: string;
    destination: string;
    equipment: Record<'en' | 'ar' | 'ur', string>;
    deadline: string;
  }[];
  next: string | null;
}

export interface Person {
  displayName: string | null;
  phoneMasked: string;
  registrationComplete: boolean;
}
export interface Session {
  id: string;
  current: boolean;
  expiresAt: string;
  lastUsedAt: string;
}
export interface Account {
  person: Person;
  session: Session;
}
export interface Organisation {
  id: string;
  legalName: string;
  status: string;
}
export interface Place {
  area?: string | null;
  countryCode?: string | null;
  country?: string | null;
}
export interface Assignment {
  bookingId: string;
  version: number;
  acknowledgedAt: string | null;
  carrier: { legalName: string };
  pickup: Place;
  delivery: Place;
  cargo: { description: string | null };
  truck: { registrationNumber: string } | null;
  trip?: {
    version: number;
    next: string | null;
    hold?: { reason: string } | null;
    estimate?: { arrivalAt: string; statedAt: string } | null;
    milestones: { milestone: string; statedAt: string }[];
    delivery?: {
      outcome: { outcome: string; version: number; receiverName: string | null } | null;
    };
    pod?: {
      state: string;
      versions: {
        version: number;
        state: string;
        items: { id: string; kind: string; fingerprint: string; received: boolean }[];
      }[];
    };
  };
}

export interface BookingSummary {
  closure: { state: 'open' | 'closed' | 'review_required' } | null;
  invoice: { id: string; recordedFee: string; currency: string } | null;
}

export async function loadBookingSummary(
  request: ReturnType<typeof createClient>,
  organisation: string,
  booking: string,
  token: string,
): Promise<BookingSummary> {
  const id = /^[0-9a-f-]{36}$/i;
  if (!id.test(organisation) || !id.test(booking)) throw new Error('Invalid booking identity');
  const path = `/organisations/${organisation}/bookings/${booking}`;
  async function scoped<T>(suffix: string): Promise<T | null> {
    try {
      return await request<T>(path + suffix, { token });
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) return null;
      throw error;
    }
  }
  const [closure, invoice] = await Promise.all([
    scoped<NonNullable<BookingSummary['closure']>>('/closure'),
    scoped<{ draft: BookingSummary['invoice'] }>('/fee-invoice-draft'),
  ]);
  return { closure, invoice: invoice?.draft ?? null };
}

export interface BookingDispute {
  id: string;
  description: string;
  events: { kind: string }[];
}

function bookingDisputesPath(org: string, booking: string): string {
  return (
    '/organisations/' +
    encodeURIComponent(org) +
    '/bookings/' +
    encodeURIComponent(booking) +
    '/disputes'
  );
}

export async function loadBookingDisputes(
  request: ReturnType<typeof createClient>,
  org: string,
  booking: string,
  token: string,
) {
  const result = await request<{ disputes: BookingDispute[] }>(bookingDisputesPath(org, booking), {
    token,
  });
  return result.disputes;
}

export function uploadDisputePhoto(
  request: ReturnType<typeof createClient>,
  org: string,
  booking: string,
  dispute: string,
  token: string,
  key: string,
  mediaType: 'image/jpeg' | 'image/png',
  bytes: ArrayBuffer,
) {
  return request(
    bookingDisputesPath(org, booking) + '/' + encodeURIComponent(dispute) + '/evidence',
    {
      token,
      method: 'PUT',
      key,
      mediaType,
      bytes,
    },
  );
}

type CommissionAmount = { currency: string; commission: string; role: 'carrier' | 'organiser' };
export interface BrokerCommissions {
  bookings: (CommissionAmount & { bookingId: string })[];
  quotations: (CommissionAmount & { quotationId: string })[];
}

export async function loadBrokerCommissions(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
) {
  const { commissions } = await request<{ commissions: BrokerCommissions }>(
    '/organisations/' + encodeURIComponent(org) + '/commissions',
    { token },
  );
  return {
    bookings: commissions.bookings.filter(({ role }) => role === 'organiser'),
    quotations: commissions.quotations.filter(({ role }) => role === 'organiser'),
  };
}

export interface BrokerPaymentRecord {
  recordingOpen: boolean;
  currency: string;
  payments: { id: string; amount: string; reference: string; status: string }[];
}
export async function loadBrokerPayments(
  request: ReturnType<typeof createClient>,
  org: string,
  booking: string,
  token: string,
): Promise<BrokerPaymentRecord | null> {
  const result = await request<{
    recordingOpen: boolean;
    obligations: (Omit<BrokerPaymentRecord, 'recordingOpen'> & {
      kind: string;
      side: string | null;
    })[];
  }>(
    '/organisations/' +
      encodeURIComponent(org) +
      '/bookings/' +
      encodeURIComponent(booking) +
      '/financial-completion',
    { token },
  );
  const commission = result.obligations.find(
    ({ kind, side }) => kind === 'commission' && side === 'payee',
  );
  return commission
    ? {
        recordingOpen: result.recordingOpen,
        currency: commission.currency,
        payments: commission.payments,
      }
    : null;
}

export function confirmBrokerReceipt(
  request: ReturnType<typeof createClient>,
  org: string,
  booking: string,
  token: string,
  paymentId: string,
  key: string,
) {
  return request<{ paymentId: string }>(
    '/organisations/' +
      encodeURIComponent(org) +
      '/bookings/' +
      encodeURIComponent(booking) +
      '/financial-completion',
    { token, method: 'POST', key, body: { action: 'confirm', paymentId } },
  );
}

export function recordPhotoPath(org: string, kind: 'shipments' | 'vehicles', record: string) {
  return (
    '/organisations/' +
    encodeURIComponent(org) +
    '/' +
    kind +
    '/' +
    encodeURIComponent(record) +
    '/photos'
  );
}

export interface ArrangedShipment {
  id: string;
  status: string;
  reference: string | null;
  parties: {
    customer: { legalName: string };
    organiser: { legalName: string } | null;
  };
}

export interface AuthorityOverview {
  arranged: ArrangedShipment[];
  organiser: boolean;
  authorities: {
    id: string;
    version: number;
    status: 'requested' | 'active' | 'declined' | 'ended';
    role: 'customer' | 'organiser';
    mayPublish: boolean;
    feePayerAgreed: boolean;
    customer: { legalName: string };
    organiser: { legalName: string };
  }[];
}

export async function loadAuthorities(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
) {
  const result = await request<{ overview: AuthorityOverview }>(
    '/organisations/' + encodeURIComponent(org) + '/authorities',
    { token },
  );
  return result.overview;
}

export function requestAuthority(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  customerCode: string,
) {
  return request<{ outcome: string }>(
    '/organisations/' + encodeURIComponent(org) + '/authorities',
    { token, method: 'POST', body: { customerCode } },
  );
}

export function endAuthority(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  id: string,
  version: number,
) {
  return request<{ outcome: string }>(
    '/organisations/' + encodeURIComponent(org) + '/authorities/' + encodeURIComponent(id) + '/end',
    { token, method: 'POST', body: { version } },
  );
}

export type AuthorityDecision =
  { decision: 'decline' } | { decision: 'accept'; mayPublish: boolean; feePayerAgreed: boolean };

export function decideAuthority(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  id: string,
  version: number,
  decision: AuthorityDecision,
) {
  return request<{ outcome: string }>(
    '/organisations/' +
      encodeURIComponent(org) +
      '/authorities/' +
      encodeURIComponent(id) +
      '/decision',
    { token, method: 'POST', body: { version, ...decision } },
  );
}

export interface CommissionContracts {
  organiser: boolean;
  limits: { maxBasisPoints: number; settlementMaxDays: number };
  contracts: {
    id: string;
    version: number;
    status: 'proposed' | 'active' | 'declined' | 'ended';
    role: 'organiser' | 'carrier';
    option: 'percentage' | 'fixed';
    basisPoints: number | null;
    amount: string | null;
    currency: string | null;
    settlementDays: number;
    organiser: { legalName: string };
    carrier: { legalName: string };
  }[];
}

type ContractProposal = { carrierCode: string; settlementDays: number } & (
  | { option: 'percentage'; basisPoints: number }
  | { option: 'fixed'; amount: string; currency: string }
);

const contractPath = (org: string) =>
  '/organisations/' + encodeURIComponent(org) + '/commission-contracts';

export async function loadCommissionContracts(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
) {
  return (await request<{ contracts: CommissionContracts }>(contractPath(org), { token }))
    .contracts;
}

export function proposeCommissionContract(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  body: ContractProposal,
) {
  return request<{ outcome: string }>(contractPath(org), { token, method: 'POST', body });
}

export function changeCommissionContract(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  id: string,
  version: number,
  action: 'accept' | 'decline' | 'end',
) {
  const body = action === 'end' ? { version } : { version, decision: action };
  return request<{ outcome: string }>(
    contractPath(org) +
      '/' +
      encodeURIComponent(id) +
      '/' +
      (action === 'end' ? 'end' : 'decision'),
    { token, method: 'POST', body },
  );
}

export interface ArrangedQuotation {
  id: string;
  standing: string;
  currentVersion: number;
  carrier?: { legalName: string; tradingName: string | null };
  versions: { versionNo: number; amount: string; currency: string }[];
}

export async function loadArrangedQuotations(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
) {
  const path =
    '/organisations/' +
    encodeURIComponent(org) +
    '/shipments/' +
    encodeURIComponent(shipment) +
    '/quotations';
  return (await request<{ quotations: { quotations: ArrangedQuotation[] } }>(path, { token }))
    .quotations.quotations;
}

type ShipmentRoleChoices = {
  customerAuthorityId: string | null;
  receiver: 'not_named' | { name: string };
  freightPayer: 'customer' | 'sender' | 'receiver';
  feePayer: 'customer' | 'organiser';
};

export interface ShipmentPartiesView {
  editable: boolean;
  parties: {
    authorityId: string | null;
    receiver: { is: 'customer' | 'named' | 'not_named'; name?: string };
    freightPayer: ShipmentRoleChoices['freightPayer'];
    feePayer: ShipmentRoleChoices['feePayer'];
  };
  customers: {
    authorityId: string;
    legalName: string;
    mayPublish: boolean;
    feePayerAgreed: boolean;
  }[];
}

const shipmentPartiesPath = (org: string, shipment: string) =>
  '/organisations/' +
  encodeURIComponent(org) +
  '/shipments/' +
  encodeURIComponent(shipment) +
  '/parties';

export function loadShipmentParties(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
) {
  return request<ShipmentPartiesView>(shipmentPartiesPath(org, shipment), { token });
}

export function saveShipmentParties(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
  version: number,
  choices: ShipmentRoleChoices,
) {
  return request<{ outcome: string }>(shipmentPartiesPath(org, shipment), {
    token,
    method: 'POST',
    body: { version, sender: 'customer', ...choices },
  });
}

export interface PublicationCatalogue {
  code: string;
  name: Record<'en' | 'ar' | 'ur', string>;
}

export interface PublicationInput {
  version: number;
  cargoCategory: string;
  equipmentType: string;
  dangerousGoods: boolean;
  pickupArea: string;
  deliveryArea: string;
  quotationDeadline: { local: string; offsetMinutes: number | null };
}

export function loadPublicationCatalogues(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
) {
  return request<{
    cargoCategories: PublicationCatalogue[];
    equipmentTypes: PublicationCatalogue[];
  }>('/organisations/' + encodeURIComponent(org) + '/shipment-catalogues', { token });
}

export function publishShipment(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
  key: string,
  body: PublicationInput,
) {
  return request<{ shipment: OrganisationShipment; outcome: string }>(
    '/organisations/' +
      encodeURIComponent(org) +
      '/shipments/' +
      encodeURIComponent(shipment) +
      '/publish',
    { token, method: 'POST', key, body },
  );
}

export function withdrawShipment(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
  key: string,
  version: number,
) {
  return request<{ shipment: OrganisationShipment; outcome: 'withdrawn' | 'already_withdrawn' }>(
    '/organisations/' +
      encodeURIComponent(org) +
      '/shipments/' +
      encodeURIComponent(shipment) +
      '/withdraw',
    { token, method: 'POST', key, body: { version } },
  );
}

export function localDemoAvailable(
  origin: string | undefined,
  development: boolean,
  enabled: string | undefined,
) {
  return development && enabled === '1' && origin === 'http://127.0.0.1:3000';
}

export async function signInLocalDemo(
  origin: string,
  development: boolean,
  enabled: string | undefined,
  key: () => string,
  fetcher: typeof fetch = fetch,
) {
  if (!localDemoAvailable(origin, development, enabled)) throw new Error('Local demo disabled');
  const request = createClient(origin, fetcher);
  const { challengeId, developmentCode } = await request<{
    challengeId: string;
    developmentCode?: string;
  }>('/auth/code-requests', {
    method: 'POST',
    key: key(),
    localDemoCode: true,
    body: { phone: '+999574021836' },
  });
  if (!developmentCode || !/^\d{6}$/.test(developmentCode))
    throw new ApiFailure(503, 'code_delivery_unavailable');
  return request<Account & { token: string }>('/auth/code-verifications', {
    method: 'POST',
    key: key(),
    body: { challengeId, code: developmentCode },
  });
}

export interface DraftPlaceInput {
  accessNotes?: string | null;
  countryCode: string;
  timeZone: string;
  address: string;
  from: { local: string; offsetMinutes: number | null };
  until: { local: string; offsetMinutes: number | null };
}

export interface ShipmentDraftInput {
  packaging?: string | null;
  equipmentNeeded?: string | null;
  shipperReference: string;
  cargoDescription: string;
  grossWeightKg: string;
  pieces: string;
  pickup: DraftPlaceInput;
  delivery: DraftPlaceInput;
}

export interface ShipmentCountry extends PublicationCatalogue {
  timeZones: string[];
}

export function loadShipmentCountries(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
) {
  return request<{ countries: ShipmentCountry[] }>(
    '/organisations/' + encodeURIComponent(org) + '/shipment-places',
    { token },
  );
}

export async function createShipmentDraft(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  key: string,
  body: ShipmentDraftInput,
) {
  return (
    await request<{ shipment: OrganisationShipment }>(
      '/organisations/' + encodeURIComponent(org) + '/shipments',
      { token, method: 'POST', key, body },
    )
  ).shipment;
}

export async function updateShipmentDraft(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
  version: number,
  key: string,
  body: ShipmentDraftInput,
) {
  const path =
    '/organisations/' + encodeURIComponent(org) + '/shipments/' + encodeURIComponent(shipment);
  return (
    await request<{ shipment: OrganisationShipment }>(path, {
      token,
      method: 'PATCH',
      key,
      body: { ...body, version },
    })
  ).shipment;
}

export interface MobileQuotationContext {
  fleetMatches: boolean;
  terms: { currency: string; minorUnits: number; inclusions: PublicationCatalogue[] } | null;
  pickupWindow: { timeZone: string; from: string; until: string };
  quotationDeadline: { local: string };
  freightMaxDueDays: number;
  quotations: { id: string; status: string }[];
}

export interface MobileQuotationInput {
  amount: string;
  inclusions: Record<string, boolean>;
  validUntil: { local: string; offsetMinutes?: number };
  earliestPickup: { local: string; offsetMinutes?: number };
  freight: { methods: ('cash_on_delivery' | 'bank_transfer')[]; dueDays: number | null };
  notes?: string;
  commissionAccepted?: { commission: string; net: string };
}

const discoveryQuotePath = (org: string, shipment: string) =>
  '/organisations/' +
  encodeURIComponent(org) +
  '/discovery/shipments/' +
  encodeURIComponent(shipment);

export async function loadMobileQuotation(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
) {
  return (
    await request<{ quotation: MobileQuotationContext }>(
      discoveryQuotePath(org, shipment) + '/quotation',
      { token },
    )
  ).quotation;
}

export function submitMobileQuotation(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
  key: string,
  body: MobileQuotationInput,
) {
  return request<{ quotation: { id: string; status: string } }>(
    discoveryQuotePath(org, shipment) + '/quotations',
    {
      token,
      method: 'POST',
      key,
      body,
    },
  );
}

export interface ShipmentQuotationTerms {
  currency: string;
  version: number;
  locked: boolean;
}

export async function loadShipmentQuotationTerms(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
) {
  const path =
    '/organisations/' + encodeURIComponent(org) + '/shipments/' + encodeURIComponent(shipment);
  return (
    await request<{
      quotations: {
        terms: ShipmentQuotationTerms | null;
        currencyChoices: { code: string; name: string }[];
        inclusionsAvailable: boolean;
        quotations: (ArrangedQuotation & { status: string })[];
      };
    }>(path + '/quotations', { token })
  ).quotations;
}

export function saveShipmentQuotationTerms(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
  version: number,
  currency: string,
  key: string,
) {
  const path =
    '/organisations/' + encodeURIComponent(org) + '/shipments/' + encodeURIComponent(shipment);
  return request<{ outcome: string }>(path + '/quotation-terms', {
    token,
    key,
    method: 'POST',
    body: { version, currency },
  });
}

export type FreightChoice = 'cash_on_delivery' | 'bank_transfer' | 'card_gateway';

export interface ShipmentBookingPreview {
  booking: { id: string; status: string } | null;
  acceptance: {
    quotationId: string;
    state: string;
    version?: number;
    currency?: string;
    transportAmount?: string;
    shipperTotal?: string;
    fee?: { amount: string; payer: string };
    freight?: { methods: FreightChoice[]; dueDays: number | null };
    terms?: { code: string; version: number; demonstration: boolean };
  }[];
}

export function loadShipmentBookingPreview(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  shipment: string,
) {
  return request<ShipmentBookingPreview>(
    '/organisations/' +
      encodeURIComponent(org) +
      '/shipments/' +
      encodeURIComponent(shipment) +
      '/booking',
    { token },
  );
}

export function acceptShipmentQuotation(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  quotation: string,
  version: number,
  key: string,
  freightMethod?: FreightChoice,
) {
  return request<{ booking: { id: string; status: string } }>(
    '/organisations/' +
      encodeURIComponent(org) +
      '/quotations/' +
      encodeURIComponent(quotation) +
      '/accept',
    { token, method: 'POST', key, body: { version, ...(freightMethod ? { freightMethod } : {}) } },
  );
}

export function rejectShipmentQuotation(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  quotation: string,
  version: number,
  key: string,
) {
  return request<{ outcome: 'rejected' | 'already_rejected' }>(
    '/organisations/' +
      encodeURIComponent(org) +
      '/quotations/' +
      encodeURIComponent(quotation) +
      '/reject',
    { token, method: 'POST', key, body: { version } },
  );
}

export type CarrierQuotation = ArrangedQuotation & {
  shipmentId: string;
  status: string;
  lane?: { origin: string; destination: string };
};

export async function loadCarrierQuotations(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
) {
  return (
    await request<{ quotations: CarrierQuotation[] }>(
      '/organisations/' + encodeURIComponent(org) + '/quotations',
      { token },
    )
  ).quotations;
}

export function withdrawCarrierQuotation(
  request: ReturnType<typeof createClient>,
  org: string,
  token: string,
  quotation: string,
  version: number,
  key: string,
) {
  return request<{ outcome: 'withdrawn' | 'already_withdrawn'; quotation: CarrierQuotation }>(
    '/organisations/' +
      encodeURIComponent(org) +
      '/quotations/' +
      encodeURIComponent(quotation) +
      '/withdraw',
    { token, method: 'POST', key, body: { version } },
  );
}

export function reportDriverEstimate(
  request: ReturnType<typeof createClient>,
  booking: string,
  token: string,
  arrivalAt: string,
) {
  return request<{ outcome: 'stated'; trip: NonNullable<Assignment['trip']> }>(
    '/me/driver/assignments/' + encodeURIComponent(booking) + '/estimate',
    { token, method: 'POST', body: { arrivalAt } },
  );
}
