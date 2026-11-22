import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { ApiError } from '../http/api-error.js';
import { APP_CONFIG, DB_POOL } from '../tokens.js';
import { maskPhone } from './phone.js';
import { codePepper, hashToken, sessionToken } from './secrets.js';
import { DEMONSTRATION_TERMS_VERSION, type TermsLanguage } from './terms.js';

/**
 * Sign-in, sessions and registration. The API's database role has no right on the identity
 * tables: every operation here is one call to a database function that runs as the tables'
 * owner (db/migrations/0004_identity_hardening.sql). The functions create and compare the
 * one-time codes, read the limits from a protected settings row and read the time from the
 * database's own clock, so nothing this service sends can loosen a limit or move time.
 */

export interface CodeRequestResult {
  readonly challengeId: string;
  readonly expiresAt: string;
  readonly resendAvailableAt: string;
  /** Present only when codes are displayed for local development and the caller is local. */
  readonly developmentCode?: string;
}

export interface PersonView {
  readonly id: string;
  readonly phoneMasked: string;
  readonly displayName: string | null;
  readonly contactEmail: string | null;
  readonly registrationComplete: boolean;
}

export interface SessionView {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
}

export interface SignInResult {
  readonly token: string;
  readonly session: SessionView;
  readonly person: PersonView;
}

export interface Authenticated {
  readonly personId: string;
  readonly sessionId: string;
  /** Hash of the bearer token: what the database functions take to find the caller. */
  readonly tokenHash: string;
}

interface AccountRow {
  person_id: string;
  phone_e164: string;
  display_name: string | null;
  contact_email: string | null;
  registration_completed_at: Date | null;
  session_id: string;
  session_created_at: Date;
  session_last_used_at: Date;
  session_expires_at: Date;
}

const unauthorized = (): ApiError =>
  new ApiError(401, 'unauthorized', 'Authentication is required.');

function personView(row: AccountRow): PersonView {
  return {
    id: row.person_id,
    phoneMasked: maskPhone(row.phone_e164),
    displayName: row.display_name,
    contactEmail: row.contact_email,
    registrationComplete: row.registration_completed_at !== null,
  };
}

function sessionView(row: AccountRow): SessionView {
  return {
    id: row.session_id,
    createdAt: row.session_created_at.toISOString(),
    lastUsedAt: row.session_last_used_at.toISOString(),
    expiresAt: row.session_expires_at.toISOString(),
    current: true,
  };
}

@Injectable()
export class IdentityService {
  private readonly pepper: string;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.pepper = codePepper(config.IDENTITY_SECRET);
  }

  /** The caller's own person and session, or nothing when the session is no longer live. */
  private async account(tokenHash: string): Promise<AccountRow | undefined> {
    const found = await this.pool.query<AccountRow>('SELECT * FROM trucker.my_account($1)', [
      tokenHash,
    ]);
    return found.rows[0];
  }

  /**
   * Creates a one-time code for a mobile number. The answer is the same whether or not the
   * number belongs to anyone, so it cannot be used to find out who is registered.
   * Repeating the request with the same retry key returns the same challenge and sends nothing.
   * The database creates the code. It hands it back only when asked to and only in a database
   * marked local-development or test; in any other database it creates nothing.
   */
  async requestCode(
    phone: string,
    retryKey: string,
    callerIsLocal: boolean,
  ): Promise<CodeRequestResult> {
    const closed = new ApiError(
      503,
      'code_delivery_unavailable',
      'Sign-in codes cannot be sent in this environment.',
    );
    if (this.config.SIGN_IN_CODE_DELIVERY === 'none') throw closed;
    const reveal = this.config.SIGN_IN_CODE_DELIVERY === 'development-display' && callerIsLocal;
    const result = await this.pool.query<{
      status: 'created' | 'repeated' | 'too_soon' | 'too_many' | 'closed';
      challenge_id: string;
      expires_at: Date;
      resend_available_at: Date;
      retry_after_seconds: number | null;
      development_code: string | null;
    }>('SELECT * FROM trucker.sign_in_request_code($1, $2, $3, $4)', [
      phone,
      retryKey,
      this.pepper,
      reveal,
    ]);
    const row = result.rows[0]!;
    switch (row.status) {
      case 'closed':
        throw closed;
      case 'too_soon':
        throw new ApiError(
          429,
          'code_resend_too_soon',
          'A code was sent a moment ago. Wait before asking again.',
          { retryAfterSeconds: row.retry_after_seconds },
        );
      case 'too_many':
        throw new ApiError(
          429,
          'too_many_code_requests',
          'Too many codes were requested for this number.',
          { retryAfterSeconds: row.retry_after_seconds },
        );
      default:
        return {
          challengeId: row.challenge_id,
          expiresAt: row.expires_at.toISOString(),
          resendAvailableAt: row.resend_available_at.toISOString(),
          ...(reveal && row.development_code ? { developmentCode: row.development_code } : {}),
        };
    }
  }

  /**
   * Exchanges a correct code for a session. A code works once. Repeating the same request
   * (same retry key, same code) shortly afterwards returns the same session instead of an
   * error, so a lost response can be retried safely. Any other reuse is refused.
   */
  async verifyCode(
    challengeId: string,
    code: string,
    retryKey: string,
    requestId?: string,
  ): Promise<SignInResult> {
    // The session to create if the code is right. Its token is derived, never stored.
    const proposedId = randomUUID();
    const proposedToken = sessionToken(this.config.IDENTITY_SECRET, proposedId);
    const result = await this.pool.query<{
      status: 'signed_in' | 'repeated' | 'incorrect' | 'used' | 'replaced' | 'expired' | 'locked';
      attempts_remaining: number | null;
      session_id: string | null;
    }>('SELECT * FROM trucker.sign_in_verify_code($1, $2, $3, $4, $5, $6, $7)', [
      challengeId,
      code,
      retryKey,
      this.pepper,
      proposedId,
      hashToken(proposedToken),
      requestId ?? null,
    ]);
    const row = result.rows[0]!;
    switch (row.status) {
      case 'incorrect':
        throw new ApiError(
          400,
          'code_incorrect',
          'That code is not correct.',
          row.attempts_remaining === null
            ? undefined
            : { attemptsRemaining: row.attempts_remaining },
        );
      case 'used':
        throw new ApiError(409, 'code_already_used', 'That code has already been used.');
      case 'replaced':
        throw new ApiError(410, 'code_replaced', 'A newer code was sent. Use the newest code.');
      case 'expired':
        throw new ApiError(410, 'code_expired', 'That code has expired. Ask for a new one.');
      case 'locked':
        throw new ApiError(429, 'code_locked', 'Too many incorrect attempts. Ask for a new code.');
      default: {
        const token =
          row.status === 'signed_in'
            ? proposedToken
            : sessionToken(this.config.IDENTITY_SECRET, row.session_id!);
        const account = await this.account(hashToken(token));
        // Ended between the two statements: the code is spent and there is no session.
        if (!account)
          throw new ApiError(409, 'code_already_used', 'That code has already been used.');
        return { token, session: sessionView(account), person: personView(account) };
      }
    }
  }

  /**
   * Resolves a bearer token to a person: one statement. The database ends and records a
   * session that is past its idle period or its absolute limit. An unknown or ended token and
   * a missing one get the same answer: the caller learns nothing about why.
   */
  async authenticate(token: string | undefined, requestId?: string): Promise<Authenticated> {
    if (!token || token.length > 200) throw unauthorized();
    const tokenHash = hashToken(token);
    const result = await this.pool.query<{
      status: 'ok' | 'unknown' | 'expired';
      person_id: string | null;
      session_id: string | null;
    }>('SELECT * FROM trucker.session_check($1, $2)', [tokenHash, requestId ?? null]);
    const row = result.rows[0]!;
    if (row.status === 'expired')
      throw new ApiError(401, 'session_expired', 'Your session has ended. Sign in again.');
    if (row.status !== 'ok' || !row.person_id || !row.session_id) throw unauthorized();
    return { personId: row.person_id, sessionId: row.session_id, tokenHash };
  }

  async me(auth: Authenticated): Promise<{ person: PersonView; session: SessionView }> {
    const account = await this.account(auth.tokenHash);
    if (!account) throw unauthorized();
    return { person: personView(account), session: sessionView(account) };
  }

  /**
   * Completes registration: a name, an optional contact e-mail, and a record of the terms text
   * shown. Only demonstration terms exist. Repeating the request changes nothing.
   */
  async completeRegistration(
    auth: Authenticated,
    input: {
      displayName: string;
      contactEmail: string | null;
      termsVersion: string;
      termsLanguage: TermsLanguage;
    },
    requestId?: string,
  ): Promise<PersonView> {
    const closed = new ApiError(
      503,
      'registration_closed',
      'Registration is not open: approved terms do not exist yet.',
    );
    if (this.config.REGISTRATION_TERMS !== 'demonstration') throw closed;
    if (input.termsVersion !== DEMONSTRATION_TERMS_VERSION) {
      throw new ApiError(
        409,
        'terms_version_changed',
        'The terms shown are out of date. Read the current text.',
        {
          currentVersion: DEMONSTRATION_TERMS_VERSION,
        },
      );
    }
    const result = await this.pool.query<{ status: string }>(
      'SELECT trucker.complete_registration($1, $2, $3, $4, $5, $6) AS status',
      [
        auth.tokenHash,
        input.displayName,
        input.contactEmail,
        input.termsVersion,
        input.termsLanguage,
        requestId ?? null,
      ],
    );
    const status = result.rows[0]?.status;
    if (status === 'closed') throw closed;
    if (status === 'not_invited')
      throw new ApiError(
        403,
        'invitation_required',
        'Registration is by invitation during the pilot. This number has no open invitation.',
      );
    const account = status === 'unauthorized' ? undefined : await this.account(auth.tokenHash);
    if (!account) throw unauthorized();
    return personView(account);
  }

  /** The caller's own open sessions, newest first. */
  async listSessions(auth: Authenticated): Promise<SessionView[]> {
    const rows = await this.pool.query<{
      id: string;
      created_at: Date;
      last_used_at: Date;
      expires_at: Date;
      current: boolean;
    }>('SELECT * FROM trucker.my_sessions($1)', [auth.tokenHash]);
    return rows.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      current: row.current,
    }));
  }

  /**
   * Ends one of the caller's own sessions. A session of another person is answered exactly
   * like one that does not exist.
   */
  async revokeSession(auth: Authenticated, sessionId: string, requestId?: string): Promise<void> {
    const result = await this.pool.query<{ status: string }>(
      'SELECT trucker.revoke_my_session($1, $2, $3) AS status',
      [auth.tokenHash, sessionId, requestId ?? null],
    );
    const status = result.rows[0]?.status;
    if (status === 'unauthorized') throw unauthorized();
    if (status !== 'revoked')
      throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  }

  /** Ends every other session of the caller and reports how many were ended. */
  async revokeOtherSessions(auth: Authenticated, requestId?: string): Promise<number> {
    const result = await this.pool.query<{ ended: number | null }>(
      'SELECT trucker.revoke_my_other_sessions($1, $2) AS ended',
      [auth.tokenHash, requestId ?? null],
    );
    const ended = result.rows[0]?.ended;
    if (ended === null || ended === undefined) throw unauthorized();
    return ended;
  }
}
