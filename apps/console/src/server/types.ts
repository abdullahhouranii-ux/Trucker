export type Privilege = 'staff_admin' | 'reviewer';

export interface StaffAccount {
  id: string;
  email: string;
  displayName: string;
  status: 'invited' | 'active' | 'disabled';
  privileges: Privilege[];
  /** Whether this person also has a participant account, as declared. Never assumed. */
  participantLink: 'not_declared' | 'declared_none' | 'declared';
  participantPhone: string | null;
  enrolledAt: string | null;
  createdAt: string;
  recoveryCodesLeft: number;
  enrolmentLinkOpen: boolean;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actor: { id: string; email: string } | null;
  action: string;
  outcome: 'done' | 'refused';
  subject: { id: string; email: string } | null;
  requestId: string | null;
  detail: Record<string, unknown>;
}

/** What a form that shows something once hands back to the page. */
export interface LinkState {
  /** Shown once: the enrolment link to hand to the person. */
  link?: string;
  email?: string;
  expiresAt?: string;
  error?: string;
  /** Kept so that sending the same details again cannot create a second account. */
  retryKey?: string;
}
export interface EnrolState {
  step: 'password' | 'authenticator' | 'done' | 'invalid';
  email?: string;
  secret?: string;
  qr?: string;
  recoveryCodes?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// Organisation verification
// ---------------------------------------------------------------------------------------------
export interface QueueEntry {
  applicationId: string;
  organisationId: string;
  versionNo: number;
  kind: 'initial' | 'amendment';
  status: 'submitted' | 'claim_review';
  legalName: string;
  countryCode: string;
  submittedAt: string;
}
export interface ReviewEvidence {
  documentType: string;
  documentNumber: string;
  issuingCountry: string;
  issuedOn: string | null;
  expiresOn: string | null;
}
export interface ReviewVersion {
  id: string;
  versionNo: number;
  kind: 'initial' | 'amendment';
  status:
    'submitted' | 'claim_review' | 'withdrawn' | 'verified' | 'changes_requested' | 'rejected';
  legalName: string;
  countryCode: string;
  registrationNumber: string;
  decisionReason: string | null;
  decisionNote: string | null;
  submittedAt: string;
  decidedAt: string | null;
  evidence: ReviewEvidence[];
}
export interface ReviewDetail {
  application: ReviewVersion & {
    rowVersion: number;
    declarationKind: string;
    declarationVersion: string;
    declarationLanguage: string;
    claimRaised: boolean;
    claimRaisedByCaller: boolean;
  };
  organisation: {
    id: string;
    status: string;
    legalName: string;
    tradingName: string | null;
    countryCode: string;
    registrationNumber: string;
    address: string | null;
    contactName: string | null;
    createdAt: string;
    capability: {
      status: 'granted' | 'revoked';
      basis: string;
      grantedAt: string;
      grantedByCaller: boolean;
    } | null;
  };
  requirements: { documentType: string; name: string; required: boolean }[];
  earlier: ReviewVersion[];
  /** Whether another verified organisation holds this registration. Nothing about it is shown. */
  competing: boolean;
  independence: 'ok' | 'link_not_declared' | 'connected' | 'conflict_not_declared';
}
