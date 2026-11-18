import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import type { StaffCaller } from '../staff/staff.service.js';
import type { FileStore } from '../storage/file-store.js';
import { DB_POOL, FILE_STORE } from '../tokens.js';

// Proof of delivery (slice 18b). The database decides who may do what and keeps each file's
// declaration and fingerprint; the file store keeps the bytes. A file is stored first and
// recorded second: if the database refuses it, the stored copy is removed, so no file is ever
// recorded without its bytes.

type Detail = Record<string, unknown>;

export interface PodCaller {
  readonly tokenHash: string;
  readonly requestId?: string | undefined;
}

const ERRORS: Record<string, [number, string, string]> = {
  unauthorized: [401, 'unauthorized', 'Authentication is required.'],
  forbidden: [
    403,
    'staff_privilege_required',
    'Your account does not hold the privilege this needs.',
  ],
  not_found: [404, 'not_found', 'The requested resource was not found.'],
  not_dispatched: [409, 'not_dispatched', 'This booking has not been dispatched.'],
  on_hold: [409, 'trip_on_hold', 'Trucker operations has put this trip on hold.'],
  no_outcome: [409, 'no_delivery_outcome', 'Record the delivery outcome before its proof.'],
  conflict: [409, 'record_changed', 'This changed since it was opened. Nothing was changed.'],
  pod_accepted: [409, 'pod_accepted', 'The proof of delivery is already accepted.'],
  evidence_missing: [
    422,
    'evidence_missing',
    'The evidence listed does not include what this outcome needs.',
  ],
  already_received_other: [
    409,
    'already_received',
    'A different file was already received for this item. Add a new version instead.',
  ],
  pod_closed: [409, 'pod_closed', 'This version is decided or replaced: add a new version.'],
  media_type_mismatch: [
    422,
    'media_type_mismatch',
    'The file type is not the one declared for this item.',
  ],
  fingerprint_mismatch: [
    422,
    'fingerprint_mismatch',
    'The file is not the one declared: its fingerprint differs. Nothing was recorded.',
  ],
  superseded: [409, 'pod_superseded', 'A newer version replaces this one. Review the newest.'],
  already_decided: [409, 'pod_already_decided', 'This version is already decided.'],
  not_ready: [
    409,
    'pod_not_ready',
    'Not every required item has arrived yet: it cannot be reviewed.',
  ],
};

function refuse(status: string, detail: unknown): never {
  if (status === 'invalid' && Array.isArray(detail)) {
    const problems = detail as { field: string; code: string }[];
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields: problems.map((problem) => problem.field),
      problems,
    });
  }
  const known = ERRORS[status] ?? ERRORS.not_found!;
  throw new ApiError(
    known[0],
    known[1],
    known[2],
    detail && !Array.isArray(detail) ? (detail as Detail) : undefined,
  );
}

const STORAGE_CLOSED = (): never => {
  throw new ApiError(
    503,
    'file_storage_closed',
    'File storage is not available here: no storage is configured.',
  );
};

export interface PodFile {
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly fingerprint: string;
}

@Injectable()
export class PodService {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
    @Inject(FILE_STORE) private readonly store: FileStore | null,
  ) {}

  /** One transaction as the caller; an organisation of '' acts as the person alone (the driver). */
  private async asCaller(
    caller: PodCaller,
    organisationId: string,
    sql: string,
    values: unknown[],
  ): Promise<{ status: string; detail: unknown }> {
    await this.access.requireBoundRole();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('trucker.session_token_hash', $1, true),
                set_config('trucker.organisation_id', $2, true),
                set_config('trucker.request_id', $3, true)`,
        [caller.tokenHash, organisationId, caller.requestId ?? ''],
      );
      const result = await client.query<{ status: string; detail: unknown }>(sql, values);
      await client.query('COMMIT');
      return result.rows[0]!;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async asStaff(sql: string, values: unknown[]) {
    return (await this.pool.query<{ status: string; detail: unknown }>(sql, values)).rows[0]!;
  }

  /** The manifest of a new version: by the driver (organisation '') or the carrier on behalf. */
  async declare(caller: PodCaller, organisationId: string, bookingId: string, content: Detail) {
    const row = await this.asCaller(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.pod_declare($1, $2)',
      [bookingId, JSON.stringify(content)],
    );
    if (row.status === 'declared') return { outcome: 'declared', pod: row.detail };
    return refuse(row.status, row.detail);
  }

  async staffDeclare(caller: StaffCaller, bookingId: string, content: Detail) {
    const row = await this.asStaff(
      'SELECT status, detail FROM trucker.staff_pod_declare($1, $2, $3, $4)',
      [caller.tokenHash, bookingId, JSON.stringify(content), caller.requestId ?? null],
    );
    if (row.status === 'declared') return { outcome: 'declared', pod: row.detail };
    return refuse(row.status, row.detail);
  }

  /**
   * One file of a version. Its fingerprint and size are computed here, on the bytes received;
   * the database compares them with the declaration (DI-402, AT-402).
   */
  async receive(
    caller: PodCaller | StaffCaller,
    organisationId: string | null,
    bookingId: string,
    itemId: string,
    mediaType: string,
    bytes: Buffer,
  ) {
    const store = this.store ?? STORAGE_CLOSED();
    if (bytes.length === 0)
      throw new ApiError(422, 'validation_failed', 'The file is empty.', {
        fields: ['file'],
        problems: [{ field: 'file', code: 'required' }],
      });
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    const key = await store.put(bytes);
    // What was found on the bytes stored: compared by the database with the declaration.
    const receipt = JSON.stringify({ fingerprint, bytes: bytes.length, mediaType, key });
    let row: { status: string; detail: unknown };
    try {
      row =
        organisationId === null
          ? await this.asStaff(
              'SELECT status, detail FROM trucker.staff_pod_receive($1, $2, $3, $4, $5)',
              [caller.tokenHash, bookingId, itemId, receipt, caller.requestId ?? null],
            )
          : await this.asCaller(
              caller,
              organisationId,
              'SELECT status, detail FROM trucker.pod_receive($1, $2, $3)',
              [bookingId, itemId, receipt],
            );
    } catch (error) {
      await store.remove(key).catch(() => undefined);
      throw error;
    }
    if (row.status !== 'received') await store.remove(key).catch(() => undefined);
    if (row.status === 'received' || row.status === 'already_received')
      return { outcome: row.status, fingerprint, pod: row.detail };
    return refuse(row.status, null);
  }

  /** The shipper's administrators accept a version or ask for more evidence (E-1). */
  async review(
    caller: PodCaller,
    organisationId: string,
    bookingId: string,
    podId: string,
    version: number,
    decision: string,
    note: string | null,
  ) {
    const row = await this.asCaller(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.pod_review_record($1, $2, $3, $4, $5)',
      [bookingId, podId, version, decision, note],
    );
    if (row.status === 'accepted' || row.status === 'more_evidence_requested')
      return { outcome: row.status, pod: row.detail };
    return refuse(row.status, row.detail);
  }

  private async read(detail: unknown): Promise<PodFile> {
    const store = this.store ?? STORAGE_CLOSED();
    const found = detail as { storageKey: string; mediaType: string; fingerprint: string };
    const bytes = await store.get(found.storageKey);
    // Recorded but not in the store: never shown as if it were there.
    if (bytes === null)
      throw new ApiError(
        503,
        'file_unavailable',
        'The file is recorded but cannot be read from storage now.',
      );
    return { bytes, mediaType: found.mediaType, fingerprint: found.fingerprint };
  }

  /** A party to the booking reads a file (AT-405). */
  async file(caller: PodCaller, organisationId: string, bookingId: string, itemId: string) {
    const row = await this.asCaller(
      caller,
      organisationId,
      'SELECT status, detail FROM trucker.pod_file($1, $2)',
      [bookingId, itemId],
    );
    if (row.status !== 'ok') refuse(row.status, null);
    return this.read(row.detail);
  }

  /** Operations reads a file; the view is recorded (AT-415). */
  async staffFile(caller: StaffCaller, bookingId: string, itemId: string) {
    const row = await this.asStaff(
      'SELECT status, detail FROM trucker.staff_pod_file($1, $2, $3, $4)',
      [caller.tokenHash, bookingId, itemId, caller.requestId ?? null],
    );
    if (row.status !== 'ok') refuse(row.status, null);
    return this.read(row.detail);
  }
}
