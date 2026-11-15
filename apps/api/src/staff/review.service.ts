import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ApiError } from '../http/api-error.js';
import { DB_POOL } from '../tokens.js';
import type { StaffCaller } from './staff.service.js';

/**
 * Verification, the staff side: the queue, one application, the decision, and the withdrawal
 * of a verification given by mistake. Every rule is the database's
 * (db/migrations/0007_organisation_verification.sql): who holds which privilege, that a
 * reviewer is independent of the organisation and says so at each decision, that a competing
 * claim goes to someone else, and that a verification is withdrawn by a different
 * administrator. What a reviewer sees are entries the applicant declared, not documents.
 */

export interface QueueEntry {
  readonly applicationId: string;
  readonly organisationId: string;
  readonly versionNo: number;
  readonly kind: 'initial' | 'capability' | 'amendment';
  readonly status: 'submitted' | 'claim_review';
  readonly legalName: string;
  readonly countryCode: string;
  readonly submittedAt: string;
  readonly capability: 'ship' | 'carry_as_company';
  readonly revalidates: ('ship' | 'carry_as_company')[] | null;
}
export type Decision = 'verified' | 'changes_requested' | 'rejected';

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

/** Refusals common to the decision and the withdrawal. */
function refuse(status: string, detail: unknown): void {
  switch (status) {
    case 'unauthorized':
      throw unauthorized();
    case 'forbidden':
      throw forbidden();
    case 'not_found':
      throw notFound();
    case 'not_independent':
      throw new ApiError(
        409,
        'reviewer_not_independent',
        'You cannot decide this: your independence from the organisation is not established.',
        { reason: (detail as { reason?: string } | null)?.reason ?? 'unknown' },
      );
    case 'same_person':
      throw new ApiError(
        409,
        'different_person_required',
        'This must be done by a different staff member from the one who acted before.',
      );
    case 'invalid':
      throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
        fields: ['reason', 'note'],
      });
    default:
  }
}

@Injectable()
export class ReviewService {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  async queue(caller: StaffCaller): Promise<QueueEntry[]> {
    const allowed = await this.pool.query<{ status: string }>(
      'SELECT trucker.staff_require($1, $2, $3, $4) AS status',
      [caller.tokenHash, 'reviewer', 'staff.verification_queue', caller.requestId ?? null],
    );
    const status = allowed.rows[0]?.status;
    if (status === 'forbidden') throw forbidden();
    if (status !== 'ok') throw unauthorized();
    const result = await this.pool.query<{
      application_id: string;
      organisation_id: string;
      version_no: number;
      kind: QueueEntry['kind'];
      status: QueueEntry['status'];
      legal_name: string;
      country_code: string;
      submitted_at: Date;
      capability: QueueEntry['capability'];
      revalidates: QueueEntry['revalidates'];
    }>('SELECT * FROM trucker.staff_verification_queue($1)', [caller.tokenHash]);
    return result.rows.map((row) => ({
      applicationId: row.application_id,
      organisationId: row.organisation_id,
      versionNo: row.version_no,
      kind: row.kind,
      status: row.status,
      legalName: row.legal_name,
      countryCode: row.country_code,
      submittedAt: row.submitted_at.toISOString(),
      capability: row.capability,
      revalidates: row.revalidates,
    }));
  }

  /** One application. Each look is recorded. */
  async view(caller: StaffCaller, applicationId: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ status: string; detail: Record<string, unknown> }>(
      'SELECT status, detail FROM trucker.staff_verification_view($1, $2, $3)',
      [caller.tokenHash, applicationId, caller.requestId ?? null],
    );
    const row = result.rows[0]!;
    refuse(row.status, null);
    if (row.status !== 'ok') throw notFound();
    return row.detail;
  }

  async decide(
    caller: StaffCaller,
    applicationId: string,
    input: {
      version: number;
      decision: Decision;
      reason: string;
      note: string | null;
      noConflict: boolean;
    },
  ): Promise<{ outcome: 'decided' | 'already_decided' | 'claim_review' }> {
    const result = await this.pool.query<{ status: string; detail: unknown }>(
      'SELECT status, detail FROM trucker.staff_verification_decide($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        caller.tokenHash,
        applicationId,
        input.version,
        input.decision,
        input.reason,
        input.note,
        input.noConflict,
        caller.requestId ?? null,
      ],
    );
    const row = result.rows[0]!;
    refuse(row.status, row.detail);
    switch (row.status) {
      case 'decided':
        return { outcome: 'decided' };
      case 'repeated':
        return { outcome: 'already_decided' };
      case 'claim_review':
        return { outcome: 'claim_review' };
      case 'conflict':
        throw new ApiError(
          409,
          'application_changed',
          'The application changed since it was opened. Nothing was decided.',
        );
      default:
        throw new ApiError(
          409,
          'application_not_open',
          'This application is no longer open for a decision.',
        );
    }
  }

  async revoke(
    caller: StaffCaller,
    organisationId: string,
    input: {
      capability: 'ship' | 'carry_as_company';
      reason: string;
      note: string | null;
      noConflict: boolean;
    },
  ): Promise<{ outcome: 'revoked' | 'already_revoked' }> {
    const result = await this.pool.query<{ status: string; detail: unknown }>(
      'SELECT status, detail FROM trucker.staff_verification_revoke($1, $2, $3, $4, $5, $6, $7)',
      [
        caller.tokenHash,
        organisationId,
        input.capability,
        input.reason,
        input.note,
        input.noConflict,
        caller.requestId ?? null,
      ],
    );
    const row = result.rows[0]!;
    refuse(row.status, row.detail);
    if (row.status === 'revoked') return { outcome: 'revoked' };
    if (row.status === 'repeated') return { outcome: 'already_revoked' };
    throw new ApiError(
      409,
      'organisation_not_verified',
      'This organisation does not hold that capability.',
    );
  }

  /** The quotations on a published shipment, read-only. Each look is recorded. */
  async shipmentQuotations(
    caller: StaffCaller,
    shipmentId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ status: string; detail: Record<string, unknown> }>(
      'SELECT status, detail FROM trucker.staff_shipment_quotations($1, $2, $3)',
      [caller.tokenHash, shipmentId, caller.requestId ?? null],
    );
    const row = result.rows[0]!;
    if (row.status === 'forbidden') throw forbidden();
    if (row.status === 'not_found') throw notFound();
    if (row.status !== 'ok') throw unauthorized();
    return row.detail;
  }

  /** Who read a shipment's carrier projection: the access log, for staff only. */
  async carrierAccess(caller: StaffCaller, shipmentId: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ status: string; detail: Record<string, unknown> }>(
      'SELECT status, detail FROM trucker.staff_carrier_access($1, $2, $3)',
      [caller.tokenHash, shipmentId, caller.requestId ?? null],
    );
    const row = result.rows[0]!;
    if (row.status === 'forbidden') throw forbidden();
    if (row.status === 'not_found') throw notFound();
    if (row.status !== 'ok') throw unauthorized();
    return row.detail;
  }

  // ------------------------------------------------------------------------------------------
  // Published shipments, read-only, for reviewers and staff administrators. Each look is
  // recorded; what is due (an expiry, a suspension) is recorded first.
  // ------------------------------------------------------------------------------------------
  async shipments(caller: StaffCaller): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query<{ status: string; detail: Record<string, unknown>[] }>(
      'SELECT status, detail FROM trucker.staff_shipment_list($1, $2)',
      [caller.tokenHash, caller.requestId ?? null],
    );
    const row = result.rows[0]!;
    if (row.status === 'forbidden') throw forbidden();
    if (row.status !== 'ok') throw unauthorized();
    return row.detail;
  }

  async shipment(caller: StaffCaller, id: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ status: string; detail: Record<string, unknown> }>(
      'SELECT status, detail FROM trucker.staff_shipment_view($1, $2, $3)',
      [caller.tokenHash, id, caller.requestId ?? null],
    );
    const row = result.rows[0]!;
    if (row.status === 'forbidden') throw forbidden();
    if (row.status === 'not_found') throw notFound();
    if (row.status !== 'ok') throw unauthorized();
    return row.detail;
  }
}
