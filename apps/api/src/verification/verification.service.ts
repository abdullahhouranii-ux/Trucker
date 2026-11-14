import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';

/**
 * Organisation verification, the applicant's side. An administrator submits the organisation
 * with evidence entries; each submission is a numbered version that is never changed
 * afterwards. Staff decide through their own routes (src/staff/review.service.ts).
 *
 * The evidence entries are what the applicant typed. They are not verified documents, no
 * file is held, and the requirements they answer are demonstration data: no real country's
 * requirement has been approved. A capability granted on them never allows publication in a
 * production database. The API's role writes nothing here itself: submission and withdrawal
 * are database functions (db/migrations/0007_organisation_verification.sql).
 */

/** The wording of the declaration of authority is demonstration text, like the terms. */
export const DEMONSTRATION_DECLARATION_VERSION = 'demonstration-declaration-1';

export interface Caller {
  readonly personId: string;
  readonly tokenHash: string;
  readonly requestId?: string | undefined;
}

export interface EvidenceInput {
  readonly documentType: string;
  readonly documentNumber: string;
  readonly issuingCountry: string;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
}
export interface SubmissionInput {
  readonly declarationAccepted: boolean;
  readonly declarationLanguage: 'en' | 'ar' | 'ur';
  /** Only for a verified organisation: the legal identity it asks to change to. */
  readonly proposed: {
    legalName: string;
    countryCode: string;
    registrationNumber: string;
  } | null;
  readonly evidence: EvidenceInput[];
}

export interface RequirementView {
  readonly documentType: string;
  readonly name: { en: string; ar: string; ur: string };
  readonly required: boolean;
}
export interface ApplicationView {
  readonly id: string;
  readonly versionNo: number;
  readonly kind: 'initial' | 'amendment';
  readonly status:
    'submitted' | 'claim_review' | 'withdrawn' | 'verified' | 'changes_requested' | 'rejected';
  readonly legalName: string;
  readonly countryCode: string;
  readonly registrationNumber: string;
  readonly submittedAt: string;
  readonly withdrawnAt: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly decisionNote: string | null;
  /** Always demonstration: declared by the applicant, not verified documents. */
  readonly evidenceKind: 'declared_demonstration';
  readonly evidence: EvidenceInput[];
}
export interface VerificationOverview {
  readonly organisation: {
    id: string;
    status: string;
    version: number;
    legalName: string;
    countryCode: string;
    registrationNumber: string;
  };
  /** Empty when nothing can be verified for this country: no requirement exists. */
  readonly requirements: RequirementView[];
  /** Newest first. */
  readonly applications: ApplicationView[];
  readonly capability: {
    capability: 'ship';
    status: 'granted' | 'revoked';
    basis: 'demonstration';
    grantedAt: string;
    revokedAt: string | null;
    revokeReason: string | null;
    revokeNote: string | null;
  } | null;
  /** Whether a new version may be submitted now, and of which kind. */
  readonly maySubmit: 'initial' | 'amendment' | null;
  /** The server's answer for later slices. Nothing can be published in this one. */
  readonly mayPublish: boolean;
}

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', 'The requested resource was not found.');
const unauthorized = (): ApiError =>
  new ApiError(401, 'unauthorized', 'Authentication is required.');

@Injectable()
export class VerificationService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
  ) {}

  /** One transaction in which the database knows who is asking, about which organisation. */
  private async asCaller<T>(
    caller: Caller,
    organisationId: string,
    work: (client: pg.PoolClient, allowFixtures: boolean) => Promise<T>,
  ): Promise<T> {
    const access = await this.access.requireBoundRole();
    const allowFixtures = this.access.fixturesAllowed(access);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('trucker.session_token_hash', $1, true),
                set_config('trucker.organisation_id', $2, true),
                set_config('trucker.request_id', $3, true)`,
        [caller.tokenHash, organisationId, caller.requestId ?? ''],
      );
      const result = await work(client, allowFixtures);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async read(
    client: pg.PoolClient,
    organisationId: string,
    allowFixtures: boolean,
  ): Promise<VerificationOverview> {
    // Row security: only an administrator of the selected organisation sees its applications.
    const org = await client.query<{
      id: string;
      status: string;
      version: number;
      legal_name: string;
      country_code: string;
      registration_number: string;
      requested_capability: string;
      admin: boolean;
      may_publish: boolean;
    }>(
      `SELECT id, status, version, legal_name, country_code, registration_number,
              requested_capability, trucker.is_admin(id) AS admin,
              trucker.organisation_may_publish() AS may_publish
       FROM trucker.organisation WHERE id = $1`,
      [organisationId],
    );
    const organisation = org.rows[0];
    if (!organisation) throw notFound();
    if (!organisation.admin) throw new ApiError(403, 'forbidden', 'This action is not allowed.');
    const requirements = await client.query<{
      document_type: string;
      name_en: string;
      name_ar: string;
      name_ur: string;
      required: boolean;
    }>(
      `SELECT r.document_type, r.name_en, r.name_ar, r.name_ur, r.required
       FROM trucker.evidence_requirement r JOIN trucker.country c ON c.code = r.country_code
       WHERE r.country_code = $1 AND r.capability = $2 AND (NOT c.fixture OR $3)
       ORDER BY r.position, r.document_type`,
      [organisation.country_code, organisation.requested_capability, allowFixtures],
    );
    const applications = await client.query<{
      id: string;
      version_no: number;
      kind: ApplicationView['kind'];
      status: ApplicationView['status'];
      legal_name: string;
      country_code: string;
      registration_number: string;
      submitted_at: Date;
      withdrawn_at: Date | null;
      decided_at: Date | null;
      decision_reason: string | null;
      decision_note: string | null;
      evidence: EvidenceInput[];
    }>(
      `SELECT a.id, a.version_no, a.kind, a.status, a.legal_name, a.country_code,
              a.registration_number, a.submitted_at, a.withdrawn_at, a.decided_at,
              a.decision_reason, a.decision_note,
              coalesce((SELECT jsonb_agg(jsonb_build_object(
                  'documentType', e.document_type, 'documentNumber', e.document_number,
                  'issuingCountry', e.issuing_country,
                  'issuedOn', to_char(e.issued_on, 'YYYY-MM-DD'),
                  'expiresOn', to_char(e.expires_on, 'YYYY-MM-DD')) ORDER BY e.document_type)
                FROM trucker.verification_evidence e WHERE e.application_id = a.id), '[]'::jsonb) AS evidence
       FROM trucker.verification_application a WHERE a.organisation_id = $1
       ORDER BY a.version_no DESC`,
      [organisationId],
    );
    const capability = await client.query<{
      status: 'granted' | 'revoked';
      granted_at: Date;
      revoked_at: Date | null;
      revoke_reason: string | null;
      revoke_note: string | null;
    }>(
      `SELECT status, granted_at, revoked_at, revoke_reason, revoke_note
       FROM trucker.organisation_capability WHERE organisation_id = $1 AND capability = 'ship'`,
      [organisationId],
    );
    const open = applications.rows.some(
      (row) => row.status === 'submitted' || row.status === 'claim_review',
    );
    const held = capability.rows[0];
    return {
      organisation: {
        id: organisation.id,
        status: organisation.status,
        version: organisation.version,
        legalName: organisation.legal_name,
        countryCode: organisation.country_code,
        registrationNumber: organisation.registration_number,
      },
      requirements: requirements.rows.map((row) => ({
        documentType: row.document_type,
        name: { en: row.name_en, ar: row.name_ar, ur: row.name_ur },
        required: row.required,
      })),
      applications: applications.rows.map((row) => ({
        id: row.id,
        versionNo: row.version_no,
        kind: row.kind,
        status: row.status,
        legalName: row.legal_name,
        countryCode: row.country_code,
        registrationNumber: row.registration_number,
        submittedAt: row.submitted_at.toISOString(),
        withdrawnAt: row.withdrawn_at ? row.withdrawn_at.toISOString() : null,
        decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
        decisionReason: row.decision_reason,
        decisionNote: row.decision_note,
        evidenceKind: 'declared_demonstration',
        evidence: row.evidence,
      })),
      capability: held
        ? {
            capability: 'ship',
            status: held.status,
            basis: 'demonstration',
            grantedAt: held.granted_at.toISOString(),
            revokedAt: held.revoked_at ? held.revoked_at.toISOString() : null,
            revokeReason: held.revoke_reason,
            revokeNote: held.revoke_note,
          }
        : null,
      maySubmit:
        open || requirements.rows.length === 0
          ? null
          : organisation.status === 'verified'
            ? 'amendment'
            : ['draft', 'changes_requested', 'rejected', 'verification_withdrawn'].includes(
                  organisation.status,
                )
              ? 'initial'
              : null,
      mayPublish: organisation.may_publish,
    };
  }

  overview(caller: Caller, organisationId: string): Promise<VerificationOverview> {
    return this.asCaller(caller, organisationId, (client, allowFixtures) =>
      this.read(client, organisationId, allowFixtures),
    );
  }

  /** Submits a new application version. The same request sent twice makes one version. */
  submit(
    caller: Caller,
    organisationId: string,
    retryKey: string,
    expectedVersion: number,
    input: SubmissionInput,
  ): Promise<VerificationOverview> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const content = {
        declaration: {
          accepted: input.declarationAccepted,
          version: DEMONSTRATION_DECLARATION_VERSION,
          language: input.declarationLanguage,
        },
        ...(input.proposed ? { proposed: input.proposed } : {}),
        evidence: input.evidence,
      };
      const result = await client.query<{ status: string; detail: unknown }>(
        'SELECT status, detail FROM trucker.submit_verification($1, $2, $3::jsonb, $4)',
        [retryKey, expectedVersion, JSON.stringify(content), allowFixtures],
      );
      const row = result.rows[0]!;
      switch (row.status) {
        case 'submitted':
        case 'repeated':
          return this.read(client, organisationId, allowFixtures);
        case 'unauthorized':
          throw unauthorized();
        case 'not_found':
          throw notFound();
        case 'conflict':
          throw new ApiError(
            409,
            'organisation_changed',
            'The organisation was changed since this form was opened. Nothing was submitted.',
          );
        case 'not_open':
          throw new ApiError(
            409,
            'verification_not_open',
            'An application is already under review, or the organisation cannot apply in its present state.',
          );
        case 'closed':
          throw new ApiError(
            409,
            'verification_closed',
            'Verification is not available for this country: no evidence requirement exists for it.',
          );
        case 'key_conflict':
          throw new ApiError(
            409,
            'retry_key_conflict',
            'This retry key was already used for a different request.',
          );
        default: {
          const problems = (row.detail ?? []) as { field: string; code: string }[];
          throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
            fields: problems.map((problem) => problem.field),
            problems,
          });
        }
      }
    });
  }

  /** Withdraws the open application. The organisation returns to where it was. */
  withdraw(
    caller: Caller,
    organisationId: string,
    applicationId: string,
    retryKey: string,
  ): Promise<VerificationOverview> {
    return this.asCaller(caller, organisationId, async (client, allowFixtures) => {
      const result = await client.query<{ status: string }>(
        'SELECT status FROM trucker.withdraw_verification($1, $2)',
        [applicationId, retryKey],
      );
      switch (result.rows[0]!.status) {
        case 'withdrawn':
        case 'repeated':
          return this.read(client, organisationId, allowFixtures);
        case 'unauthorized':
          throw unauthorized();
        case 'not_open':
          throw new ApiError(
            409,
            'verification_not_open',
            'This application is no longer under review, so it cannot be withdrawn.',
          );
        case 'key_conflict':
          throw new ApiError(
            409,
            'retry_key_conflict',
            'This retry key was already used for a different request.',
          );
        default:
          throw notFound();
      }
    });
  }
}
