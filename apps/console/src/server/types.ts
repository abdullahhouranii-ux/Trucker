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
