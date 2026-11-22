import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { ApiError } from '../http/api-error.js';
import {
  hashToken,
  staffPepper,
  staffSessionIdFor,
  staffSessionToken,
} from '../identity/secrets.js';
import { APP_CONFIG, DB_POOL } from '../tokens.js';

/**
 * Staff accounts, sign-in and administration. Staff are separate from participants: other
 * tables, other sessions, other functions. The API's database role has no right on any staff
 * table. Each operation here is one call to a database function
 * (db/migrations/0006_staff_identity.sql) that establishes who is asking, checks the
 * privilege, reads the database's clock and records what it did or refused. Passwords,
 * authenticator secrets and recovery codes are checked inside the database and never come
 * back, except the secret and the recovery codes once, to the person enrolling.
 *
 * No staff session exists without a correct authenticator or recovery code after a correct
 * password. There is no setting that changes this.
 */

export type Privilege = 'staff_admin' | 'reviewer' | 'operations';
export type ParticipantLink = 'not_declared' | 'declared_none' | 'declared';

export interface StaffView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: 'invited' | 'active' | 'disabled';
  readonly privileges: Privilege[];
  /** Whether this person also has a participant account, as declared. Never assumed. */
  readonly participantLink: ParticipantLink;
  readonly participantPhone: string | null;
  readonly enrolledAt: string | null;
  readonly createdAt: string;
  readonly recoveryCodesLeft: number;
  readonly enrolmentLinkOpen: boolean;
}
export interface StaffCaller {
  readonly tokenHash: string;
  readonly staffId: string;
  readonly privileges: Privilege[];
  readonly requestId?: string | undefined;
}
export interface AuditEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: { id: string; email: string } | null;
  readonly action: string;
  readonly outcome: 'done' | 'refused';
  readonly subject: { id: string; email: string } | null;
  readonly requestId: string | null;
  readonly detail: Record<string, unknown>;
}

interface StaffRow {
  staff_id: string;
  email: string;
  display_name: string;
  status: StaffView['status'];
  privileges: Privilege[];
  participant_link: ParticipantLink;
  participant_phone: string | null;
  enrolled_at: Date | null;
  created_at: Date;
  recovery_codes_left: number;
  link_open: boolean;
}

const view = (row: StaffRow): StaffView => ({
  id: row.staff_id,
  email: row.email,
  displayName: row.display_name,
  status: row.status,
  privileges: row.privileges,
  participantLink: row.participant_link,
  participantPhone: row.participant_phone,
  enrolledAt: row.enrolled_at ? row.enrolled_at.toISOString() : null,
  createdAt: row.created_at.toISOString(),
  recoveryCodesLeft: row.recovery_codes_left,
  enrolmentLinkOpen: row.link_open,
});

const unauthorized = (): ApiError =>
  new ApiError(401, 'unauthorized', 'Authentication is required.');
const forbidden = (): ApiError =>
  new ApiError(
    403,
    'staff_privilege_required',
    'Your account does not hold the privilege this needs.',
  );
const notFound = (): ApiError =>
  new ApiError(404, 'not_found', 'The requested resource was not found.');
const invalid = (fields: string[]): ApiError =>
  new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', { fields });
const invalidLink = (): ApiError =>
  new ApiError(
    410,
    'enrolment_link_invalid',
    'This enrolment link cannot be used. It may have expired, been used or been replaced.',
  );

/** A new secret for a link or a ticket. Only its hash is stored. */
const newToken = (): string => randomBytes(32).toString('base64url');

const STAFF_COLUMNS = `staff_id, email, display_name, status, privileges, participant_link,
  participant_phone, enrolled_at, created_at, recovery_codes_left, link_open`;

@Injectable()
export class StaffService {
  private readonly pepper: string;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.pepper = staffPepper(config.IDENTITY_SECRET);
  }

  /** Resolves a bearer token to a staff member, or refuses. Never accepts a participant token. */
  async authenticate(token: string | undefined, requestId?: string): Promise<StaffCaller> {
    if (!token) throw unauthorized();
    const tokenHash = hashToken(token);
    const result = await this.pool.query<{
      status: string;
      staff_id: string | null;
      privileges: Privilege[] | null;
    }>('SELECT status, staff_id, privileges FROM trucker.staff_session_check($1, $2)', [
      tokenHash,
      requestId ?? null,
    ]);
    const row = result.rows[0];
    if (!row || row.status !== 'ok' || !row.staff_id) throw unauthorized();
    return { tokenHash, staffId: row.staff_id, privileges: row.privileges ?? [], requestId };
  }

  // ------------------------------------------------------------------------------------------
  // Enrolment
  // ------------------------------------------------------------------------------------------

  async enrolmentState(token: string): Promise<{ email: string }> {
    const result = await this.pool.query<{ status: string; email: string | null }>(
      'SELECT * FROM trucker.staff_enrol_state($1)',
      [hashToken(token)],
    );
    const row = result.rows[0]!;
    if (row.status !== 'open' || !row.email) throw invalidLink();
    return { email: row.email };
  }

  /** Sets the password to be and returns the authenticator secret, to be shown once. */
  async enrolmentBegin(
    token: string,
    password: string,
    requestId?: string,
  ): Promise<{ email: string; secret: string; otpauthUri: string }> {
    const result = await this.pool.query<{
      status: string;
      email: string | null;
      secret: string | null;
    }>('SELECT * FROM trucker.staff_enrol_begin($1, $2, $3, $4)', [
      hashToken(token),
      password,
      this.pepper,
      requestId ?? null,
    ]);
    const row = result.rows[0]!;
    if (row.status === 'weak_password') throw invalid(['password']);
    if (row.status !== 'ok' || !row.email || !row.secret) throw invalidLink();
    const label = encodeURIComponent(`Trucker staff:${row.email}`);
    return {
      email: row.email,
      secret: row.secret,
      otpauthUri: `otpauth://totp/${label}?secret=${row.secret}&issuer=${encodeURIComponent('Trucker staff')}&algorithm=SHA1&digits=6&period=30`,
    };
  }

  /** Proves the authenticator works. Only then is the account usable. Codes are shown once. */
  async enrolmentComplete(
    token: string,
    code: string,
    requestId?: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const result = await this.pool.query<{ status: string; recovery_codes: string[] | null }>(
      'SELECT * FROM trucker.staff_enrol_complete($1, $2, $3, $4)',
      [hashToken(token), code, this.pepper, requestId ?? null],
    );
    const row = result.rows[0]!;
    if (row.status === 'wrong_code')
      throw new ApiError(400, 'staff_code_refused', 'That code was not accepted.');
    if (row.status === 'not_started')
      throw new ApiError(409, 'enrolment_not_started', 'Set a password first.');
    if (row.status !== 'ok' || !row.recovery_codes) throw invalidLink();
    return { recoveryCodes: row.recovery_codes };
  }

  // ------------------------------------------------------------------------------------------
  // Sign-in
  // ------------------------------------------------------------------------------------------

  /** Step one. A ticket is not a session and opens nothing but step two, for a short time. */
  async signInPassword(
    email: string,
    password: string,
    requestId?: string,
  ): Promise<{ ticket: string }> {
    const ticket = newToken();
    const result = await this.pool.query<{ status: string }>(
      'SELECT * FROM trucker.staff_sign_in_password($1, $2, $3, $4, $5)',
      [email, password, this.pepper, hashToken(ticket), requestId ?? null],
    );
    if (result.rows[0]?.status !== 'continue')
      throw new ApiError(
        401,
        'staff_sign_in_refused',
        'Email or password not accepted, or sign-in is locked for a while.',
      );
    return { ticket };
  }

  /** Step two: the only place a staff session comes from. */
  async signInCode(
    ticket: string,
    code: string,
    requestId?: string,
  ): Promise<{ token: string; staff: StaffView }> {
    const sessionId = staffSessionIdFor(this.config.IDENTITY_SECRET, ticket);
    const token = staffSessionToken(this.config.IDENTITY_SECRET, sessionId);
    const result = await this.pool.query<{ status: string }>(
      'SELECT status FROM trucker.staff_sign_in_verify($1, $2, $3, $4, $5, $6)',
      [hashToken(ticket), code, this.pepper, sessionId, hashToken(token), requestId ?? null],
    );
    const status = result.rows[0]?.status;
    if (status === 'expired')
      throw new ApiError(410, 'staff_sign_in_expired', 'Sign-in took too long. Start again.');
    if (status !== 'ok')
      throw new ApiError(401, 'staff_code_refused', 'That code was not accepted.');
    const me = await this.me(hashToken(token));
    return { token, staff: me.staff };
  }

  async me(tokenHash: string): Promise<{ staff: StaffView; sessionExpiresAt: string }> {
    const result = await this.pool.query<StaffRow & { session_expires_at: Date }>(
      `SELECT (m.account).*, m.session_expires_at FROM trucker.staff_me($1) m`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) throw unauthorized();
    return { staff: view(row), sessionExpiresAt: row.session_expires_at.toISOString() };
  }

  async signOut(caller: StaffCaller): Promise<void> {
    const result = await this.pool.query<{ status: string }>(
      'SELECT trucker.staff_sign_out($1, $2) AS status',
      [caller.tokenHash, caller.requestId ?? null],
    );
    if (result.rows[0]?.status !== 'signed_out') throw unauthorized();
  }

  // ------------------------------------------------------------------------------------------
  // Administration
  // ------------------------------------------------------------------------------------------

  /** For reads: asks the database whether the privilege is held; a refusal is recorded there. */
  private async require(caller: StaffCaller, privilege: Privilege, action: string): Promise<void> {
    const result = await this.pool.query<{ status: string }>(
      'SELECT trucker.staff_require($1, $2, $3, $4) AS status',
      [caller.tokenHash, privilege, action, caller.requestId ?? null],
    );
    const status = result.rows[0]?.status;
    if (status === 'forbidden') throw forbidden();
    if (status !== 'ok') throw unauthorized();
  }

  async list(caller: StaffCaller): Promise<StaffView[]> {
    await this.require(caller, 'staff_admin', 'staff.list');
    const result = await this.pool.query<StaffRow>(
      `SELECT ${STAFF_COLUMNS} FROM trucker.staff_list($1)`,
      [caller.tokenHash],
    );
    return result.rows.map(view);
  }

  private async one(caller: StaffCaller, id: string): Promise<StaffView> {
    const result = await this.pool.query<StaffRow>(
      `SELECT ${STAFF_COLUMNS} FROM trucker.staff_list($1) WHERE staff_id = $2`,
      [caller.tokenHash, id],
    );
    const row = result.rows[0];
    if (!row) throw notFound();
    return view(row);
  }

  /** What every administration function may answer besides its own outcomes. */
  private refuse(status: string): void {
    switch (status) {
      case 'unauthorized':
        throw unauthorized();
      case 'forbidden':
        throw forbidden();
      case 'not_found':
        throw notFound();
      case 'self':
        throw new ApiError(
          409,
          'staff_self_action',
          'This cannot be done to your own account. Another administrator must do it.',
        );
      case 'last_administrator':
        throw new ApiError(
          409,
          'last_administrator',
          'This would leave no active administrator. Nothing was changed.',
        );
      default:
    }
  }

  /** Creates an invited account. The enrolment token is returned once and stored nowhere. */
  async create(
    caller: StaffCaller,
    retryKey: string,
    input: {
      email: string;
      displayName: string;
      participantLink: 'declared_none' | 'declared';
      participantPhone: string | null;
    },
  ): Promise<{ account: StaffView; enrolmentToken: string; linkExpiresAt: string }> {
    const enrolmentToken = newToken();
    const result = await this.pool.query<{
      status: string;
      staff_id: string | null;
      link_expires_at: Date | null;
    }>('SELECT * FROM trucker.staff_create($1, $2, $3, $4, $5, $6, $7, $8)', [
      caller.tokenHash,
      retryKey,
      input.email,
      input.displayName,
      input.participantLink,
      input.participantPhone,
      hashToken(enrolmentToken),
      caller.requestId ?? null,
    ]);
    const row = result.rows[0]!;
    this.refuse(row.status);
    if (row.status === 'email_taken')
      throw new ApiError(409, 'staff_email_taken', 'A staff account with this email exists.');
    if ((row.status !== 'created' && row.status !== 'repeated') || !row.staff_id)
      throw invalid(['email', 'displayName', 'participantLink', 'participantPhone']);
    return {
      account: await this.one(caller, row.staff_id),
      enrolmentToken,
      linkExpiresAt: row.link_expires_at!.toISOString(),
    };
  }

  async issueEnrolment(
    caller: StaffCaller,
    id: string,
  ): Promise<{ account: StaffView; enrolmentToken: string; linkExpiresAt: string }> {
    const enrolmentToken = newToken();
    const result = await this.pool.query<{ status: string; link_expires_at: Date | null }>(
      'SELECT * FROM trucker.staff_issue_enrolment($1, $2, $3, $4)',
      [caller.tokenHash, id, hashToken(enrolmentToken), caller.requestId ?? null],
    );
    const row = result.rows[0]!;
    this.refuse(row.status);
    if (row.status === 'disabled')
      throw new ApiError(409, 'staff_account_disabled', 'This account is disabled.');
    if (row.status !== 'issued') throw notFound();
    return {
      account: await this.one(caller, id),
      enrolmentToken,
      linkExpiresAt: row.link_expires_at!.toISOString(),
    };
  }

  private async change(
    caller: StaffCaller,
    id: string,
    sql: string,
    values: unknown[],
    fields: string[],
  ): Promise<{ account: StaffView; outcome: 'changed' | 'unchanged' }> {
    const result = await this.pool.query<{ status: string }>(sql, values);
    const status = result.rows[0]!.status;
    this.refuse(status);
    if (status !== 'changed' && status !== 'unchanged') throw invalid(fields);
    return { account: await this.one(caller, id), outcome: status };
  }

  setStatus(caller: StaffCaller, id: string, status: 'enabled' | 'disabled') {
    return this.change(
      caller,
      id,
      'SELECT trucker.staff_set_status($1, $2, $3, $4) AS status',
      [caller.tokenHash, id, status, caller.requestId ?? null],
      ['status'],
    );
  }

  setPrivilege(caller: StaffCaller, id: string, privilege: Privilege, granted: boolean) {
    return this.change(
      caller,
      id,
      'SELECT trucker.staff_set_privilege($1, $2, $3, $4, $5) AS status',
      [caller.tokenHash, id, privilege, granted, caller.requestId ?? null],
      ['privilege'],
    );
  }

  setParticipantLink(
    caller: StaffCaller,
    id: string,
    link: 'declared_none' | 'declared',
    phone: string | null,
  ) {
    return this.change(
      caller,
      id,
      'SELECT trucker.staff_set_participant_link($1, $2, $3, $4, $5) AS status',
      [caller.tokenHash, id, link, phone, caller.requestId ?? null],
      ['participantLink', 'participantPhone'],
    );
  }

  async audit(
    caller: StaffCaller,
    after: string | null,
  ): Promise<{ entries: AuditEntry[]; nextAfter: string | null }> {
    await this.require(caller, 'staff_admin', 'staff.audit_list');
    const result = await this.pool.query<{
      id: string;
      occurred_at: Date;
      actor_staff_id: string | null;
      actor_email: string | null;
      action: string;
      outcome: 'done' | 'refused';
      subject_staff_id: string | null;
      subject_email: string | null;
      request_id: string | null;
      detail: Record<string, unknown>;
      more: boolean;
    }>('SELECT * FROM trucker.staff_audit_list($1, $2)', [caller.tokenHash, after]);
    const entries = result.rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      actor: row.actor_staff_id ? { id: row.actor_staff_id, email: row.actor_email ?? '' } : null,
      action: row.action,
      outcome: row.outcome,
      subject: row.subject_staff_id
        ? { id: row.subject_staff_id, email: row.subject_email ?? '' }
        : null,
      requestId: row.request_id,
      detail: row.detail,
    }));
    const last = result.rows.at(-1);
    return { entries, nextAfter: last?.more ? last.id : null };
  }
}
