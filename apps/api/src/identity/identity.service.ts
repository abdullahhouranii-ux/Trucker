import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { AppConfig } from '../config/config.js';
import { ApiError } from '../http/api-error.js';
import { APP_CONFIG, CLOCK, DB_POOL } from '../tokens.js';
import { maskPhone } from './phone.js';
import { generateCode, hashCode, hashToken, sameHash, sessionToken } from './secrets.js';
import { DEMONSTRATION_TERMS_VERSION, type TermsLanguage } from './terms.js';

export type Clock = () => Date;

/** A repeated sign-in request is answered again only for this long after the code was used. */
const VERIFY_RETRY_WINDOW_MS = 2 * 60_000;
/** The "last used" time of a session is rewritten at most this often. */
const LAST_USED_RESOLUTION_MS = 60_000;

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
}

interface ChallengeRow {
  id: string;
  phone_e164: string;
  code_hash: string;
  created_at: Date;
  expires_at: Date;
  failed_attempts: number;
  superseded_at: Date | null;
  consumed_at: Date | null;
  verify_key: string | null;
  session_id: string | null;
}

interface SessionRow {
  id: string;
  person_id: string;
  created_at: Date;
  last_used_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

interface PersonRow {
  id: string;
  phone_e164: string;
  display_name: string | null;
  contact_email: string | null;
  registration_completed_at: Date | null;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ApiError };

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Runs work in one transaction. The work reports failure as a value so its writes still commit. */
  private async transaction<T>(work: (client: pg.PoolClient) => Promise<Outcome<T>>): Promise<T> {
    const client = await this.pool.connect();
    let outcome: Outcome<T>;
    try {
      await client.query('BEGIN');
      outcome = await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private idleLimitMs(): number {
    return this.config.SESSION_IDLE_MINUTES * 60_000;
  }

  private sessionView(row: SessionRow, currentId: string): SessionView {
    const idleEnd = row.last_used_at.getTime() + this.idleLimitMs();
    return {
      id: row.id,
      createdAt: row.created_at.toISOString(),
      lastUsedAt: row.last_used_at.toISOString(),
      expiresAt: new Date(Math.min(idleEnd, row.absolute_expires_at.getTime())).toISOString(),
      current: row.id === currentId,
    };
  }

  private personView(row: PersonRow): PersonView {
    return {
      id: row.id,
      phoneMasked: maskPhone(row.phone_e164),
      displayName: row.display_name,
      contactEmail: row.contact_email,
      registrationComplete: row.registration_completed_at !== null,
    };
  }

  private async record(
    client: pg.PoolClient | pg.Pool,
    kind: string,
    personId: string | null,
    sessionId: string | null,
    requestId: string | undefined,
  ): Promise<void> {
    await client.query(
      `INSERT INTO trucker.identity_event (occurred_at, kind, person_id, session_id, request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [this.clock(), kind, personId, sessionId, requestId ?? null],
    );
  }

  /**
   * Creates a one-time code for a mobile number. The answer is the same whether or not the
   * number belongs to anyone, so it cannot be used to find out who is registered.
   * Repeating the request with the same retry key returns the same challenge and sends nothing.
   */
  async requestCode(
    phone: string,
    retryKey: string,
    callerIsLocal: boolean,
  ): Promise<CodeRequestResult> {
    if (this.config.SIGN_IN_CODE_DELIVERY === 'none') {
      throw new ApiError(
        503,
        'code_delivery_unavailable',
        'Sign-in codes cannot be sent in this environment.',
      );
    }
    const now = this.clock();
    const waitMs = this.config.SIGN_IN_CODE_RESEND_WAIT_SECONDS * 1000;
    const view = (
      row: Pick<ChallengeRow, 'id' | 'created_at' | 'expires_at'>,
      code?: string,
    ): CodeRequestResult => ({
      challengeId: row.id,
      expiresAt: row.expires_at.toISOString(),
      resendAvailableAt: new Date(row.created_at.getTime() + waitMs).toISOString(),
      ...(code !== undefined && callerIsLocal ? { developmentCode: code } : {}),
    });

    return this.transaction<CodeRequestResult>(async (client) => {
      // One request at a time per number, so the limits below cannot be raced.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [phone]);

      const repeated = await client.query<ChallengeRow>(
        `SELECT id, created_at, expires_at FROM trucker.sign_in_challenge WHERE phone_e164 = $1 AND request_key = $2`,
        [phone, retryKey],
      );
      if (repeated.rows[0]) return { ok: true, value: view(repeated.rows[0]) };

      const recent = await client.query<{ created_at: Date }>(
        `SELECT created_at FROM trucker.sign_in_challenge
         WHERE phone_e164 = $1 AND created_at > $2 ORDER BY created_at DESC`,
        [phone, new Date(now.getTime() - 3_600_000)],
      );
      const latest = recent.rows[0];
      if (latest && now.getTime() - latest.created_at.getTime() < waitMs) {
        const retryAfterSeconds = Math.ceil(
          (latest.created_at.getTime() + waitMs - now.getTime()) / 1000,
        );
        return {
          ok: false,
          error: new ApiError(
            429,
            'code_resend_too_soon',
            'A code was sent a moment ago. Wait before asking again.',
            {
              retryAfterSeconds,
            },
          ),
        };
      }
      if (recent.rows.length >= this.config.SIGN_IN_CODE_MAX_PER_HOUR) {
        const oldest = recent.rows[recent.rows.length - 1] as { created_at: Date };
        const retryAfterSeconds = Math.ceil(
          (oldest.created_at.getTime() + 3_600_000 - now.getTime()) / 1000,
        );
        return {
          ok: false,
          error: new ApiError(
            429,
            'too_many_code_requests',
            'Too many codes were requested for this number.',
            {
              retryAfterSeconds,
            },
          ),
        };
      }

      // Only the newest code can be used.
      await client.query(
        `UPDATE trucker.sign_in_challenge SET superseded_at = $2
         WHERE phone_e164 = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
        [phone, now],
      );
      const code = generateCode();
      const created = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
      const id = (created.rows[0] as { id: string }).id;
      const expiresAt = new Date(now.getTime() + this.config.SIGN_IN_CODE_TTL_SECONDS * 1000);
      await client.query(
        `INSERT INTO trucker.sign_in_challenge (id, phone_e164, code_hash, request_key, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, phone, hashCode(this.config.IDENTITY_SECRET, id, code), retryKey, now, expiresAt],
      );
      // The only delivery mode besides `none` is display to a local caller. Nothing is logged.
      return { ok: true, value: view({ id, created_at: now, expires_at: expiresAt }, code) };
    });
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
    const now = this.clock();
    const secret = this.config.IDENTITY_SECRET;
    const incorrect = (details?: Record<string, unknown>): Outcome<SignInResult> => ({
      ok: false,
      error: new ApiError(400, 'code_incorrect', 'That code is not correct.', details),
    });

    return this.transaction<SignInResult>(async (client) => {
      const found = await client.query<ChallengeRow>(
        `SELECT id, phone_e164, code_hash, created_at, expires_at, failed_attempts, superseded_at,
                consumed_at, verify_key, session_id
         FROM trucker.sign_in_challenge WHERE id = $1 FOR UPDATE`,
        [challengeId],
      );
      const challenge = found.rows[0];
      if (!challenge) return incorrect();
      const matches = sameHash(challenge.code_hash, hashCode(secret, challenge.id, code));

      if (challenge.consumed_at) {
        const sameRequest =
          matches &&
          challenge.verify_key === retryKey &&
          now.getTime() - challenge.consumed_at.getTime() <= VERIFY_RETRY_WINDOW_MS;
        if (sameRequest && challenge.session_id) {
          const again = await this.signInView(client, challenge.session_id);
          if (again) return { ok: true, value: again };
        }
        return {
          ok: false,
          error: new ApiError(409, 'code_already_used', 'That code has already been used.'),
        };
      }
      if (challenge.superseded_at) {
        return {
          ok: false,
          error: new ApiError(410, 'code_replaced', 'A newer code was sent. Use the newest code.'),
        };
      }
      if (challenge.expires_at.getTime() <= now.getTime()) {
        return {
          ok: false,
          error: new ApiError(410, 'code_expired', 'That code has expired. Ask for a new one.'),
        };
      }
      const locked: Outcome<SignInResult> = {
        ok: false,
        error: new ApiError(429, 'code_locked', 'Too many incorrect attempts. Ask for a new code.'),
      };
      if (challenge.failed_attempts >= this.config.SIGN_IN_CODE_MAX_ATTEMPTS) return locked;

      if (!matches) {
        const attempts = challenge.failed_attempts + 1;
        await client.query(
          'UPDATE trucker.sign_in_challenge SET failed_attempts = $2 WHERE id = $1',
          [challenge.id, attempts],
        );
        if (attempts >= this.config.SIGN_IN_CODE_MAX_ATTEMPTS) {
          await this.record(client, 'code_locked', null, null, requestId);
          return locked;
        }
        return incorrect({ attemptsRemaining: this.config.SIGN_IN_CODE_MAX_ATTEMPTS - attempts });
      }

      const person = await client.query<{ id: string }>(
        `INSERT INTO trucker.person (phone_e164) VALUES ($1)
         ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164 RETURNING id`,
        [challenge.phone_e164],
      );
      const personId = (person.rows[0] as { id: string }).id;
      const created = await client.query<{ id: string }>('SELECT gen_random_uuid() AS id');
      const sessionId = (created.rows[0] as { id: string }).id;
      const token = sessionToken(secret, sessionId);
      await client.query(
        `INSERT INTO trucker.session (id, person_id, token_hash, created_at, last_used_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $4, $5)`,
        [
          sessionId,
          personId,
          hashToken(token),
          now,
          new Date(now.getTime() + this.config.SESSION_ABSOLUTE_HOURS * 3_600_000),
        ],
      );
      await client.query(
        `UPDATE trucker.sign_in_challenge SET consumed_at = $2, verify_key = $3, session_id = $4 WHERE id = $1`,
        [challenge.id, now, retryKey, sessionId],
      );
      await this.record(client, 'signed_in', personId, sessionId, requestId);
      const view = await this.signInView(client, sessionId);
      if (!view) throw new Error('the session just created was not found');
      return { ok: true, value: view };
    });
  }

  private async signInView(client: pg.PoolClient, sessionId: string): Promise<SignInResult | null> {
    const session = await client.query<SessionRow>(
      `SELECT id, person_id, created_at, last_used_at, absolute_expires_at, revoked_at
       FROM trucker.session WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
    const row = session.rows[0];
    if (!row) return null;
    const person = await client.query<PersonRow>(
      `SELECT id, phone_e164, display_name, contact_email, registration_completed_at FROM trucker.person WHERE id = $1`,
      [row.person_id],
    );
    return {
      token: sessionToken(this.config.IDENTITY_SECRET, row.id),
      session: this.sessionView(row, row.id),
      person: this.personView(person.rows[0] as PersonRow),
    };
  }

  /**
   * Resolves a bearer token to a person. An idle or over-age session is closed here, recorded,
   * and refused. Every failure gives the same answer: the caller learns nothing about why.
   */
  async authenticate(token: string | undefined, requestId?: string): Promise<Authenticated> {
    const refuse = (code: string, message: string): Outcome<Authenticated> => ({
      ok: false,
      error: new ApiError(401, code, message),
    });
    const unknown = refuse('unauthorized', 'Authentication is required.');
    if (!token || token.length > 200) throw (unknown as { error: ApiError }).error;
    const now = this.clock();

    return this.transaction<Authenticated>(async (client) => {
      const found = await client.query<SessionRow>(
        `SELECT id, person_id, created_at, last_used_at, absolute_expires_at, revoked_at
         FROM trucker.session WHERE token_hash = $1 FOR UPDATE`,
        [hashToken(token)],
      );
      const session = found.rows[0];
      if (!session || session.revoked_at) return unknown;
      const expire = async (
        reason: 'idle_expired' | 'absolute_expired',
      ): Promise<Outcome<Authenticated>> => {
        await client.query(
          'UPDATE trucker.session SET revoked_at = $2, revoked_reason = $3 WHERE id = $1',
          [session.id, now, reason],
        );
        await this.record(client, 'session_expired', session.person_id, session.id, requestId);
        return refuse('session_expired', 'Your session has ended. Sign in again.');
      };
      if (session.absolute_expires_at.getTime() <= now.getTime()) return expire('absolute_expired');
      if (now.getTime() - session.last_used_at.getTime() >= this.idleLimitMs())
        return expire('idle_expired');
      if (now.getTime() - session.last_used_at.getTime() >= LAST_USED_RESOLUTION_MS) {
        await client.query('UPDATE trucker.session SET last_used_at = $2 WHERE id = $1', [
          session.id,
          now,
        ]);
      }
      return { ok: true, value: { personId: session.person_id, sessionId: session.id } };
    });
  }

  async me(auth: Authenticated): Promise<{ person: PersonView; session: SessionView }> {
    const person = await this.pool.query<PersonRow>(
      `SELECT id, phone_e164, display_name, contact_email, registration_completed_at FROM trucker.person WHERE id = $1`,
      [auth.personId],
    );
    const session = await this.pool.query<SessionRow>(
      `SELECT id, person_id, created_at, last_used_at, absolute_expires_at, revoked_at FROM trucker.session WHERE id = $1`,
      [auth.sessionId],
    );
    return {
      person: this.personView(person.rows[0] as PersonRow),
      session: this.sessionView(session.rows[0] as SessionRow, auth.sessionId),
    };
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
    if (this.config.REGISTRATION_TERMS !== 'demonstration') {
      throw new ApiError(
        503,
        'registration_closed',
        'Registration is not open: approved terms do not exist yet.',
      );
    }
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
    const now = this.clock();
    return this.transaction<PersonView>(async (client) => {
      const locked = await client.query<PersonRow>(
        `SELECT id, phone_e164, display_name, contact_email, registration_completed_at
         FROM trucker.person WHERE id = $1 FOR UPDATE`,
        [auth.personId],
      );
      const person = locked.rows[0] as PersonRow;
      if (person.registration_completed_at) return { ok: true, value: this.personView(person) };
      await client.query(
        `INSERT INTO trucker.terms_acceptance (person_id, terms_kind, version, language, accepted_at)
         VALUES ($1, 'demonstration', $2, $3, $4) ON CONFLICT ON CONSTRAINT terms_acceptance_once DO NOTHING`,
        [auth.personId, input.termsVersion, input.termsLanguage, now],
      );
      const updated = await client.query<PersonRow>(
        `UPDATE trucker.person SET display_name = $2, contact_email = $3, registration_completed_at = $4
         WHERE id = $1 RETURNING id, phone_e164, display_name, contact_email, registration_completed_at`,
        [auth.personId, input.displayName, input.contactEmail, now],
      );
      await this.record(client, 'registration_completed', auth.personId, auth.sessionId, requestId);
      return { ok: true, value: this.personView(updated.rows[0] as PersonRow) };
    });
  }

  /** The caller's own open sessions, newest first. */
  async listSessions(auth: Authenticated): Promise<SessionView[]> {
    const now = this.clock();
    const rows = await this.pool.query<SessionRow>(
      `SELECT id, person_id, created_at, last_used_at, absolute_expires_at, revoked_at
       FROM trucker.session
       WHERE person_id = $1 AND revoked_at IS NULL AND absolute_expires_at > $2 AND last_used_at > $3
       ORDER BY created_at DESC, id`,
      [auth.personId, now, new Date(now.getTime() - this.idleLimitMs())],
    );
    return rows.rows.map((row) => this.sessionView(row, auth.sessionId));
  }

  /**
   * Ends one of the caller's own sessions. A session of another person is answered exactly
   * like one that does not exist.
   */
  async revokeSession(auth: Authenticated, sessionId: string, requestId?: string): Promise<void> {
    const own = sessionId === auth.sessionId;
    const result = await this.pool.query(
      `UPDATE trucker.session SET revoked_at = $3, revoked_reason = $4
       WHERE id = $1 AND person_id = $2 AND revoked_at IS NULL`,
      [sessionId, auth.personId, this.clock(), own ? 'signed_out' : 'revoked_by_person'],
    );
    if (result.rowCount === 0)
      throw new ApiError(404, 'not_found', 'The requested resource was not found.');
    await this.record(
      this.pool,
      own ? 'signed_out' : 'session_revoked',
      auth.personId,
      sessionId,
      requestId,
    );
  }

  /** Ends every other session of the caller and reports how many were ended. */
  async revokeOtherSessions(auth: Authenticated, requestId?: string): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE trucker.session SET revoked_at = $3, revoked_reason = 'revoked_by_person'
       WHERE person_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id`,
      [auth.personId, auth.sessionId, this.clock()],
    );
    for (const row of result.rows) {
      await this.record(this.pool, 'session_revoked', auth.personId, row.id, requestId);
    }
    return result.rows.length;
  }
}
