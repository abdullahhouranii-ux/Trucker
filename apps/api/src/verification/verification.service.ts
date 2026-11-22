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
  /** For an organisation that is not verified, or a verified one applying for another capability. */
  readonly capability: Capability | null;
  /** The carrier's declared service: matching criteria only (CB-3). */
  readonly service: ServiceInput | null;
}

export type Capability = 'ship' | 'carry_as_company' | 'organise' | 'carry_as_owner_operator';
const CARRIER: readonly string[] = ['carry_as_company', 'carry_as_owner_operator'];
/** Which capability which kind of account may hold: the database's rule, repeated for the page. */
const ALLOWED: Record<string, readonly Capability[]> = {
  company: ['ship', 'carry_as_company', 'organise'],
  individual: ['organise', 'carry_as_owner_operator'],
};
export interface ServiceInput {
  readonly countries: string[];
  readonly equipmentTypes: string[];
}
/** Declared by the carrier and decided by staff. Matching criteria for discovery only: not
 * verified vehicles, not availability, not permission to accept work. */
export interface ServiceView extends ServiceInput {
  readonly kind: 'declared_matching_criteria';
}
export interface CapabilityView {
  readonly capability: Capability;
  readonly status: 'granted' | 'revoked';
  readonly basis: 'demonstration';
  /** Granted, and resting on the organisation's present legal identity. */
  readonly effective: boolean;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
  readonly revokeNote: string | null;
  readonly service: ServiceView | null;
}

export interface RequirementView {
  readonly documentType: string;
  readonly name: { en: string; ar: string; ur: string };
  readonly required: boolean;
}
export interface ApplicationView {
  readonly id: string;
  readonly versionNo: number;
  readonly kind: 'initial' | 'capability' | 'amendment';
  readonly capability: Capability;
  /** For an amendment: every capability it revalidates on the proposed identity. */
  readonly revalidates: Capability[] | null;
  readonly service: ServiceView | null;
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
    readonly kind: string;
    id: string;
    status: string;
    version: number;
    legalName: string;
    countryCode: string;
    registrationNumber: string;
  };
  /** Empty when nothing can be verified for this country: no requirement exists. For the
   * application `maySubmit` names: the requested capability, or for an amendment every
   * capability held. */
  readonly requirements: RequirementView[];
  /** The evidence asked for when applying for each capability with the present identity. */
  readonly requirementsFor: Record<Capability, RequirementView[]>;
  /** Every capability held or once held. */
  readonly capabilities: CapabilityView[];
  /** What may be applied for now, per capability: a first verification, an added capability,
   * or a new declared service for a carrier. */
  readonly mayApply: Record<Capability, 'initial' | 'capability' | 'service_change' | null>;
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
  readonly mayPublish: boolean;
  /** Whether the organisation may discover shipments as a carrier now. */
  readonly mayDiscover: boolean;
}

/** The declared service of one application, as the applicant may read it. */
const SERVICE_OF = (application: string): string => `CASE WHEN EXISTS (
    SELECT 1 FROM trucker.carrier_service_country s WHERE s.application_id = ${application})
  THEN jsonb_build_object('kind', 'declared_matching_criteria',
    'countries', (SELECT jsonb_agg(s.country_code ORDER BY s.country_code)
                  FROM trucker.carrier_service_country s WHERE s.application_id = ${application}),
    'equipmentTypes', coalesce((SELECT jsonb_agg(s.equipment_type ORDER BY s.equipment_type)
                  FROM trucker.carrier_service_equipment s WHERE s.application_id = ${application}), '[]'::jsonb))
  END`;

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
      kind: string;
      admin: boolean;
      may_publish: boolean;
    }>(
      `SELECT id, status, version, legal_name, country_code, registration_number,
              requested_capability, kind, trucker.is_admin(id) AS admin,
              trucker.organisation_may_publish() AS may_publish
       FROM trucker.organisation WHERE id = $1`,
      [organisationId],
    );
    const organisation = org.rows[0];
    if (!organisation) throw notFound();
    if (!organisation.admin) throw new ApiError(403, 'forbidden', 'This action is not allowed.');
    const requirementsOf = async (capabilities: string[]): Promise<RequirementView[]> => {
      if (capabilities.length === 0) return [];
      const found = await client.query<{
        document_type: string;
        name_en: string;
        name_ar: string;
        name_ur: string;
        required: boolean;
      }>(
        `SELECT DISTINCT ON (r.document_type) r.document_type, r.name_en, r.name_ar, r.name_ur,
                bool_or(r.required) OVER (PARTITION BY r.document_type) AS required,
                min(r.position) OVER (PARTITION BY r.document_type) AS ord
         FROM trucker.evidence_requirement r JOIN trucker.country c ON c.code = r.country_code
         WHERE r.country_code = $1 AND r.capability = ANY ($2) AND (NOT c.fixture OR $3)
         ORDER BY r.document_type, r.capability`,
        [organisation.country_code, capabilities, allowFixtures],
      );
      // Every capability asked for must have a requirement, or nothing can be verified.
      const covered = await client.query<{ n: number }>(
        `SELECT count(DISTINCT r.capability)::int AS n FROM trucker.evidence_requirement r
         WHERE r.country_code = $1 AND r.capability = ANY ($2)`,
        [organisation.country_code, capabilities],
      );
      if (covered.rows[0]!.n < capabilities.length) return [];
      return found.rows
        .map((row) => ({
          documentType: row.document_type,
          name: { en: row.name_en, ar: row.name_ar, ur: row.name_ur },
          required: row.required,
          ord: (row as unknown as { ord: number }).ord,
        }))
        .sort((a, b) => a.ord - b.ord || a.documentType.localeCompare(b.documentType))
        .map((row) => ({ documentType: row.documentType, name: row.name, required: row.required }));
    };
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
      capability: Capability;
      revalidates: Capability[] | null;
      service: ServiceView | null;
    }>(
      `SELECT a.id, a.version_no, a.kind, a.status, a.legal_name, a.country_code,
              a.registration_number, a.submitted_at, a.withdrawn_at, a.decided_at,
              a.decision_reason, a.decision_note, a.capability, a.revalidates,
              ${SERVICE_OF('a.id')} AS service,
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
      capability: Capability;
      status: 'granted' | 'revoked';
      granted_at: Date;
      revoked_at: Date | null;
      revoke_reason: string | null;
      revoke_note: string | null;
    }>(
      `SELECT c.capability, c.status, c.granted_at, c.revoked_at, c.revoke_reason, c.revoke_note
       FROM trucker.organisation_capability c WHERE c.organisation_id = $1
       ORDER BY c.capability`,
      [organisationId],
    );
    const discovery = await client.query<{ status: string; detail: ServiceView }>(
      'SELECT status, detail FROM trucker.discovery_status()',
    );
    const open = applications.rows.some(
      (row) => row.status === 'submitted' || row.status === 'claim_review',
    );
    const held = capability.rows.find((row) => row.capability === 'ship');
    const granted = capability.rows.filter((row) => row.status === 'granted');
    const requirementsFor = {
      ship: await requirementsOf(['ship']),
      carry_as_company: await requirementsOf(['carry_as_company']),
      organise: await requirementsOf(['organise']),
      carry_as_owner_operator: await requirementsOf(['carry_as_owner_operator']),
    };
    const amendmentRequirements = await requirementsOf(granted.map((row) => row.capability));
    const verified = organisation.status === 'verified';
    const reopenable = [
      'draft',
      'changes_requested',
      'rejected',
      'verification_withdrawn',
    ].includes(organisation.status);
    const applyFor = (cap: Capability): 'initial' | 'capability' | 'service_change' | null => {
      if (!(ALLOWED[organisation.kind] ?? []).includes(cap)) return null;
      if (open || requirementsFor[cap].length === 0) return null;
      if (reopenable) return 'initial';
      if (!verified) return null;
      const grant = capability.rows.find((row) => row.capability === cap);
      if (grant?.status === 'granted') return CARRIER.includes(cap) ? 'service_change' : null;
      return 'capability';
    };
    const ownService =
      discovery.rows[0]!.detail.countries.length > 0 ? discovery.rows[0]!.detail : null;
    return {
      organisation: {
        id: organisation.id,
        kind: organisation.kind,
        status: organisation.status,
        version: organisation.version,
        legalName: organisation.legal_name,
        countryCode: organisation.country_code,
        registrationNumber: organisation.registration_number,
      },
      requirements: verified
        ? amendmentRequirements
        : (requirementsFor[organisation.requested_capability as Capability] ?? []),
      requirementsFor,
      capabilities: capability.rows.map((row) => ({
        capability: row.capability,
        status: row.status,
        basis: 'demonstration' as const,
        effective: CARRIER.includes(row.capability)
          ? discovery.rows[0]!.status === 'ok'
          : organisation.may_publish,
        grantedAt: row.granted_at.toISOString(),
        revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
        revokeReason: row.revoke_reason,
        revokeNote: row.revoke_note,
        service: CARRIER.includes(row.capability) && row.status === 'granted' ? ownService : null,
      })),
      mayApply: {
        ship: applyFor('ship'),
        carry_as_company: applyFor('carry_as_company'),
        organise: applyFor('organise'),
        carry_as_owner_operator: applyFor('carry_as_owner_operator'),
      },
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
        capability: row.capability,
        revalidates: row.revalidates,
        service: row.service,
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
      maySubmit: open
        ? null
        : verified
          ? granted.length > 0 && amendmentRequirements.length > 0
            ? 'amendment'
            : null
          : reopenable &&
              (requirementsFor[organisation.requested_capability as Capability] ?? []).length > 0
            ? 'initial'
            : null,
      mayPublish: organisation.may_publish,
      mayDiscover: discovery.rows[0]!.status === 'ok',
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
        ...(input.capability ? { capability: input.capability } : {}),
        ...(input.service ? { service: input.service } : {}),
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
