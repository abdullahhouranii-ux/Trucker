import 'server-only';

// Calls to the Trucker API, made only from the web server. The browser never talks to the API
// and never holds the session token: it is kept in an HttpOnly cookie on this application.
const base = (): string => process.env.TRUCKER_API_URL ?? 'http://localhost:3000';

export type ApiReply<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; details: Record<string, unknown> };

export async function api<T>(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  options: {
    body?: unknown;
    token?: string;
    retryKey?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiReply<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.retryKey) headers['idempotency-key'] = options.retryKey;
  let response: Response;
  try {
    response = await fetch(base() + path, {
      method,
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, code: 'unavailable', details: {} };
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, status: response.status, code: 'unavailable', details: {} };
  }
  if (response.ok) return { ok: true, status: response.status, data: parsed as T };
  const body = parsed as { code?: unknown; details?: unknown };
  return {
    ok: false,
    status: response.status,
    code: typeof body.code === 'string' ? body.code : 'unavailable',
    details:
      typeof body.details === 'object' && body.details !== null
        ? (body.details as Record<string, unknown>)
        : {},
  };
}

export interface Person {
  id: string;
  phoneMasked: string;
  displayName: string | null;
  contactEmail: string | null;
  registrationComplete: boolean;
}
export interface Session {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}
export interface Terms {
  kind: 'demonstration';
  version: string;
  language: string;
  title: string;
  notice: string;
  paragraphs: string[];
}

export interface Organisation {
  id: string;
  kind: 'company' | 'individual';
  status: string;
  requestedCapability: string;
  legalName: string;
  tradingName: string | null;
  countryCode: string;
  registrationNumber: string;
  address: string | null;
  contactName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
/** One entry of the organisation chooser. */
export interface OrganisationSummary {
  id: string;
  status: string;
  legalName: string;
  registrationNumber: string;
  createdAt: string;
}
export interface Country {
  code: string;
  name: { en: string; ar: string; ur: string };
  fixture: boolean;
}

/** One end of a pick-up or delivery window. */
export interface WindowEnd {
  /** The time on the clock at the place, as typed: `YYYY-MM-DDTHH:MM`. */
  local: string | null;
  offsetMinutes: number | null;
  /** The instant, known only when the place has a time zone. */
  at: string | null;
  /** Both offsets, when this time occurs twice at the place. */
  offsetChoices: number[] | null;
}
export interface ShipmentPlace {
  address: string | null;
  countryCode: string | null;
  timeZone: string | null;
  accessNotes: string | null;
  from: WindowEnd;
  until: WindowEnd;
}
export interface RouteCheck {
  status: 'unknown' | 'open' | 'closed';
  /** Configured availability only. Not legal clearance. */
  basis: 'configuration';
  transit: string[];
  reasons: {
    part: 'origin' | 'destination' | 'lane' | 'transit';
    code: string;
    country?: string;
  }[];
}
export type ShipmentState =
  | 'draft'
  | 'discarded'
  | 'published'
  | 'suspended'
  | 'withdrawn'
  | 'expired'
  | 'awarded'
  | 'booking_cancelled';
export interface ShipmentPublication {
  cargoCategory: string | null;
  equipmentType: string | null;
  dangerousGoods: boolean | null;
  pickupArea: string | null;
  deliveryArea: string | null;
  /** In the pick-up place's time zone. */
  quotationDeadline: WindowEnd;
  publishedVersion: number | null;
  publicationCycle: string | null;
  publishedAt: string | null;
  withdrawnAt: string | null;
  expiredAt: string | null;
  suspendedFor: ('verification' | 'route')[];
  copiedFrom: string | null;
}
export interface Shipment {
  id: string;
  /** The state now: a published shipment with an open suspension is `suspended`. */
  status: ShipmentState;
  version: number;
  shipperReference: string | null;
  cargoDescription: string | null;
  /** Kilograms, as a decimal string. */
  grossWeightKg: string | null;
  pieces: number | null;
  packaging: string | null;
  equipmentNeeded: string | null;
  pickup: ShipmentPlace;
  delivery: ShipmentPlace;
  route: RouteCheck;
  createdAt: string;
  updatedAt: string;
  discardedAt: string | null;
  publication: ShipmentPublication;
}
export interface ShipmentSummary {
  id: string;
  status: ShipmentState;
  version: number;
  shipperReference: string | null;
  cargoDescription: string | null;
  pickupCountry: string | null;
  deliveryCountry: string | null;
  createdAt: string;
  updatedAt: string;
  publishedVersion: number | null;
  quotationDeadlineAt: string | null;
}
/** A country a place can be in, with the time zones configured for it. */
export interface PlaceOption extends Country {
  timeZones: string[];
}

/** One evidence entry: what the applicant typed. No file is held and nothing is verified. */
export interface EvidenceEntry {
  documentType: string;
  documentNumber: string;
  issuingCountry: string;
  issuedOn: string | null;
  expiresOn: string | null;
}
export interface VerificationRequirement {
  documentType: string;
  name: { en: string; ar: string; ur: string };
  required: boolean;
}
export type ApplicationStatus =
  'submitted' | 'claim_review' | 'withdrawn' | 'verified' | 'changes_requested' | 'rejected';
export interface VerificationApplication {
  id: string;
  versionNo: number;
  kind: 'initial' | 'capability' | 'amendment';
  capability: Capability;
  /** For an amendment: the capabilities it revalidates on the proposed identity. */
  revalidates: Capability[] | null;
  service: DeclaredService | null;
  status: ApplicationStatus;
  legalName: string;
  countryCode: string;
  registrationNumber: string;
  submittedAt: string;
  withdrawnAt: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  decisionNote: string | null;
  evidenceKind: 'declared_demonstration';
  evidence: EvidenceEntry[];
}
export interface VerificationOverview {
  organisation: {
    id: string;
    kind: 'company' | 'individual';
    status: string;
    version: number;
    legalName: string;
    countryCode: string;
    registrationNumber: string;
  };
  requirements: VerificationRequirement[];
  /** Newest first. */
  applications: VerificationApplication[];
  capability: {
    status: 'granted' | 'revoked';
    basis: 'demonstration';
    grantedAt: string;
    revokedAt: string | null;
    revokeReason: string | null;
    revokeNote: string | null;
  } | null;
  maySubmit: 'initial' | 'amendment' | null;
  mayPublish: boolean;
  mayDiscover: boolean;
  requirementsFor: Record<Capability, VerificationRequirement[]>;
  capabilities: CapabilityState[];
  mayApply: Record<Capability, 'initial' | 'capability' | 'service_change' | null>;
}

export type Capability = 'ship' | 'carry_as_company' | 'organise' | 'carry_as_owner_operator';
/** Declared by the carrier and decided by staff: matching criteria for discovery only. Not
 * verified vehicles, availability or permission to accept work. */
export interface DeclaredService {
  kind: 'declared_matching_criteria';
  countries: string[];
  equipmentTypes: string[];
}
export interface CapabilityState {
  capability: Capability;
  status: 'granted' | 'revoked';
  basis: 'demonstration';
  effective: boolean;
  grantedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  revokeNote: string | null;
  service: DeclaredService | null;
}
/** One shipment a carrier may discover: its identifier and the carrier projection. */
export interface DiscoveryItem {
  id: string;
  shipment: CarrierView;
  changedSinceStart: boolean;
}
export interface DiscoveryPage {
  items: DiscoveryItem[];
  next: string | null;
  startedAt: string;
  service: DeclaredService;
}

/** A fictional catalogue entry (cargo category or equipment type). */
export interface CatalogueEntry {
  code: string;
  name: { en: string; ar: string; ur: string };
}
export interface Catalogues {
  cargoCategories: CatalogueEntry[];
  equipmentTypes: CatalogueEntry[];
}
/** What carriers would see. Shown to the shipper as a preview only: no carrier can read it. */
export interface CarrierView {
  lane: { origin: string; destination: string; transit: string[] };
  pickup: CarrierPlace;
  delivery: CarrierPlace;
  cargo: {
    category: string;
    description: string | null;
    grossWeightKg: string | null;
    pieces: number | null;
    packaging: string | null;
  };
  equipment: { type: string; notes: string | null };
  dangerousGoods: boolean;
  quotationDeadline: { local: string; offsetMinutes: number; at: string; timeZone: string };
  shipper: 'verified_shipper';
  publishedVersion: number;
  state: ShipmentState;
}
export interface CarrierPlace {
  countryCode: string;
  area: string;
  timeZone: string;
  from: { local: string; offsetMinutes: number; at: string };
  until: { local: string; offsetMinutes: number; at: string };
}
export interface PublicationRecord {
  versions: {
    versionNo: number;
    kind: 'published' | 'changed' | 'republished';
    createdAt: string;
  }[];
  suspensions: {
    cause: 'verification' | 'route';
    startedAt: string;
    endedAt: string | null;
    endedBy: string | null;
  }[];
  carrierView: CarrierView | null;
}

/** The currency and inclusions every quotation on a shipment uses. Fictional registers only. */
export interface QuotationTerms {
  currency: string;
  minorUnits: number;
  version: number;
  inclusions: { code: string; name: { en: string; ar: string; ur: string } }[];
  locked: boolean;
}
export interface QuotationMoment {
  local: string;
  offsetMinutes: number;
  at: string;
  timeZone: string;
}
export interface QuotationVersion {
  versionNo: number;
  kind: 'submitted' | 'revised' | 'reconfirmed';
  /** Exact, written with the currency's minor units. Never a binary number. */
  amount: string;
  currency: string;
  minorUnits: number;
  inclusions: Record<string, boolean>;
  validUntil: QuotationMoment;
  earliestPickup: QuotationMoment;
  notes: string | null;
  shipmentVersion: number;
  createdAt: string;
}
export type QuotationStanding =
  | 'current'
  | 'needs_reconfirmation'
  | 'carrier_not_eligible'
  | 'shipment_suspended'
  | 'expired'
  | 'shipment_closed'
  | 'withdrawn'
  | 'rejected'
  | 'closed'
  | 'accepted'
  | 'not_selected';
export interface Quotation {
  id: string;
  shipmentId: string;
  status:
    'submitted' | 'withdrawn' | 'rejected' | 'expired' | 'closed' | 'accepted' | 'not_selected';
  standing: QuotationStanding;
  currentVersion: number;
  reconfirmationNeeded: boolean;
  shipmentVersion: number;
  closedReason: string | null;
  createdAt: string;
  versions: QuotationVersion[];
  carrier?: {
    id: string;
    legalName: string;
    tradingName: string | null;
    verified: boolean;
    accountKind?: 'company' | 'individual';
  };
  lane?: { origin: string; destination: string };
}
export interface QuotationContext {
  terms: QuotationTerms | null;
  pickupWindow: { timeZone: string; from: string; until: string };
  quotationDeadline: { at: string; local: string; timeZone: string };
  quotations: Quotation[];
}
export interface ShipmentQuotations {
  terms: QuotationTerms | null;
  currencyChoices: { code: string; minorUnits: number; name: string }[];
  inclusionsAvailable: boolean;
  quotations: Quotation[];
}

// Fleet and drivers (slice 13) ----------------------------------------------------------------
export type FleetEligibility =
  | 'eligible'
  | 'not_found'
  | 'carrier_not_eligible'
  | 'ownership_not_verified'
  | 'not_operating_controller'
  | 'suspended'
  | 'document_missing'
  | 'document_expired'
  | 'document_expires_in_window'
  | 'equipment_mismatch'
  | 'not_affiliated'
  | 'vehicle_not_found'
  | 'not_authorised'
  | 'licence_class_not_covering';
export interface FleetDocument {
  id: string;
  type: string;
  country: string;
  status: 'submitted' | 'accepted' | 'rejected';
  expiryDate: string;
  licenceClasses: string[];
  submittedAt: string;
  reason?: string;
  /** Present only for the document's own holder: a carrier never sees a driver's numbers. */
  documentNumber?: string;
  issuingCountry?: string;
}
export interface FleetVehicle {
  id: string;
  kind: 'truck' | 'trailer';
  category: string;
  equipmentType: string;
  registrationCountry: string;
  registrationNumber: string;
  status: 'active' | 'retired';
  ownership: 'claimed' | 'verified' | 'rejected';
  version: number;
  eligibility: FleetEligibility;
  documents: FleetDocument[];
}
export interface FleetDriver {
  id: string;
  status: 'invited' | 'active' | 'declined' | 'cancelled' | 'ended';
  phone: string;
  version: number;
  name?: string;
  eligibility?: FleetEligibility;
  documents?: FleetDocument[];
  authorisations?: { id: string; vehicleId?: string }[];
}
type Named = { en: string; ar: string; ur: string };
export interface FleetRegisters {
  categories?: { code: string; kind: 'truck' | 'trailer'; name: Named }[];
  documentTypes?: {
    country: string;
    subject: 'truck' | 'trailer' | 'driver';
    code: string;
    required: boolean;
    carriesLicence: boolean;
    name: Named;
  }[];
  licenceClasses?: { country: string; code: string; name: Named }[];
}
export interface Fleet {
  open: boolean;
  vehicles: FleetVehicle[];
  drivers: FleetDriver[];
  registers: FleetRegisters;
}
export interface DriverSide {
  open: boolean;
  invitations: {
    id: string;
    version: number;
    invitedAt: string;
    carrier: { legalName: string; tradingName: string | null };
  }[];
  affiliation: {
    id: string;
    version: number;
    country: string;
    eligibility: FleetEligibility;
    carrier: { legalName: string; tradingName: string | null };
  } | null;
  documents: FleetDocument[];
  registers: FleetRegisters;
}

// Acceptance and booking (slice 14) -----------------------------------------------------------
export interface BookingFee {
  payer: 'shipper' | 'carrier';
  basisPoints: number;
  rounding: 'half_up';
  /** Exact decimal text, never a binary number. */
  amount: string;
}
export interface BookingTerms {
  code: string;
  version: number;
  demonstration: boolean;
  contentHash: string;
}
export type LocalisedName = { code: string; en: string; ar: string; ur: string };
export interface AssignedVehicle {
  registrationCountry: string;
  registrationNumber: string;
  /** Only for the carrier and staff. */
  id?: string;
  category?: LocalisedName;
  equipmentType?: string;
}
export interface AssignedSet {
  truck: AssignedVehicle | null;
  trailer: AssignedVehicle | null;
  driver: { name: string; affiliationId?: string } | null;
}
export type DispatchBlockerCode =
  | 'booking_cancelled'
  | 'not_confirmed'
  | 'needs_reassignment'
  | 'resource_occupied'
  | 'resource_overrunning'
  | 'acknowledgement_missing';
export interface DispatchBlocker {
  code: DispatchBlockerCode;
  /** The shipper is not shown which resource, or why. */
  role?: 'truck' | 'trailer' | 'driver';
  reason?: string;
}
export interface BookingSubstitution {
  id: string;
  status: string;
  version: number;
  proposedAt: string;
  differences: {
    role: 'truck' | 'trailer';
    change: 'category' | 'added' | 'removed';
    from?: LocalisedName;
    to?: LocalisedName;
  }[];
  proposed: AssignedSet;
}
export interface BookingSite {
  pickup: { address: string | null; accessNotes: string | null };
  delivery: { address: string | null; accessNotes: string | null };
}
export interface Booking {
  id: string;
  /** Confirmed is a fact about the past. Whether dispatch is possible now is `dispatch`. */
  status: 'awaiting_resources' | 'confirmed' | 'cancelled';
  cancellation?: {
    party: 'shipper' | 'carrier';
    at: string;
    reason: string;
    note: string | null;
    chargeBasis: 'none_recorded';
  } | null;
  confirmedAt: string | null;
  /** Vehicles the carrier replaced after confirmation with ones of the same category. */
  vehicleChanges?: {
    at: string;
    changes: {
      role: 'truck' | 'trailer';
      from: AssignedVehicle | null;
      to: AssignedVehicle | null;
    }[];
  }[];
  overdue: boolean;
  waitDecision: { decidedAt: string } | null;
  assignmentVersion: number;
  dispatch: { ready: boolean; blockers: DispatchBlocker[] };
  needsReassignment: boolean;
  atRisk: boolean;
  acknowledgedAt: string | null;
  /** The carrier always; the shipper once the booking is confirmed. */
  resources: AssignedSet | null;
  substitution: BookingSubstitution | null;
  /** The carrier only, once the booking is confirmed. */
  site: BookingSite | null;
  shipmentId: string;
  quotationId: string;
  quotationVersion: number;
  shipper: { id: string; legalName: string; tradingName: string | null };
  carrier: { id: string; legalName: string; tradingName: string | null };
  currency: string;
  transportAmount: string;
  fee: BookingFee;
  shipperTotal: string;
  carrierNet: string;
  paymentDueDays: number;
  terms: BookingTerms;
  inclusions: { code: string; included: boolean; name: { en: string; ar: string; ur: string } }[];
  assignment: { dueAt: string; hours: number; leadHours: number };
  plannedReservation: { startAt: string; endAt: string };
  acceptedAt: string;
  role?: 'shipper' | 'carrier';
}
export type AcceptanceState =
  | 'ok'
  | 'closed'
  | 'already_awarded'
  | 'shipment_not_open'
  | 'not_open'
  | 'reconfirmation_needed'
  | 'carrier_not_eligible'
  | 'shipment_suspended'
  | 'assignment_deadline_passed';
export interface AcceptancePreview {
  quotationId: string;
  state: AcceptanceState;
  version?: number;
  currency?: string;
  transportAmount?: string;
  fee?: BookingFee;
  shipperTotal?: string;
  paymentDueDays?: number;
  terms?: BookingTerms;
  assignmentDueAt?: string | null;
}
export interface BookingOverview {
  open: boolean;
  booking: Booking | null;
  acceptance: AcceptancePreview[];
}

// Assignment, reservation and confirmation (slice 15) ------------------------------------------
export interface AssignmentCandidates {
  vehicles: {
    id: string;
    kind: 'truck' | 'trailer';
    registrationCountry: string;
    registrationNumber: string;
    category: LocalisedName;
    equipmentType: string;
    requiresTrailer: boolean;
    /** "eligible", or the first reason it cannot be assigned to this booking now. */
    state: string;
  }[];
  drivers: { affiliationId: string; name: string; state: string }[];
}
export interface BookingDetail {
  open: boolean;
  booking: Booking;
  /** The carrier's own resources, while it is a verified carrier. */
  candidates: AssignmentCandidates | null;
}
interface AssignmentPlace {
  countryCode: string;
  area: string | null;
  from: { at: string };
  until: { at: string };
}
export interface DriverAssignment {
  bookingId: string;
  version: number;
  carrier: { legalName: string; tradingName: string | null };
  pickup: AssignmentPlace;
  delivery: AssignmentPlace;
  cargo: { description: string | null; grossWeightKg: string | null; pieces: number | null };
  plannedReservation: { startAt: string; endAt: string };
  truck: AssignedVehicle | null;
  trailer: AssignedVehicle | null;
  acknowledgedAt: string | null;
}

/** The roles of a shipment. Names only: no contact detail of any party is held. */
export interface ShipmentParties {
  organiser: { id: string; legalName: string; kind: string } | null;
  authorityId: string | null;
  customer: { id: string; legalName: string; kind: string };
  sender: { is: 'customer' | 'named' | 'not_named'; name?: string };
  receiver: { is: 'customer' | 'named' | 'not_named'; name?: string };
  freightPayer: 'customer' | 'sender' | 'receiver';
  feePayer: 'customer' | 'organiser';
  feeAgreement: 'own_act' | 'authority' | null;
}
export interface CommissionTerms {
  option: 'percentage' | 'fixed' | 'contract';
  basisPoints: number | null;
  amount: string | null;
  currency: string | null;
}
export interface CommissionContract {
  id: string;
  version: number;
  status: 'proposed' | 'active' | 'declined' | 'ended';
  role: 'organiser' | 'carrier';
  option: 'percentage' | 'fixed';
  basisPoints: number | null;
  amount: string | null;
  currency: string | null;
  earningCondition: 'freight_receipt_recorded';
  settlementDays: number;
  endedBy: 'organiser' | 'carrier' | null;
  organiser: { legalName: string };
  carrier: { legalName: string };
}
export interface ContractsOverview {
  accountCode: string;
  organiser: boolean;
  carrier: boolean;
  contracts: CommissionContract[];
}
export interface CommissionView {
  commission: CommissionTerms | null;
  contract?: CommissionContract | null;
  arranged?: boolean;
  editable?: boolean;
}
export interface CommissionLine {
  quotationId?: string;
  bookingId?: string;
  role: 'carrier' | 'organiser';
  currency: string;
  shippingPrice: string;
  commission: string;
  net: string;
}
export interface ShipmentPartiesView {
  parties: ShipmentParties;
  editable: boolean;
  customers: {
    authorityId: string;
    legalName: string;
    mayPublish: boolean;
    feePayerAgreed: boolean;
  }[];
}
export interface AuthorityItem {
  id: string;
  version: number;
  status: 'requested' | 'active' | 'declined' | 'ended';
  role: 'customer' | 'organiser';
  mayPublish: boolean;
  feePayerAgreed: boolean;
  customer: { legalName: string; kind: string };
  organiser: { legalName: string; kind: string };
}
export interface AuthorityOverview {
  accountCode: string;
  organiser: boolean;
  authorities: AuthorityItem[];
  arranged: { id: string; status: string; reference: string | null; parties: ShipmentParties }[];
}
