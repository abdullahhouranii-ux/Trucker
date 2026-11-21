import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { hashToken } from '../identity/secrets.js';
import { DB_POOL, FILE_STORE } from '../tokens.js';
import type { FileStore } from '../storage/file-store.js';

interface DisputeRequest {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
  rawBody?: Buffer;
}

const uuid = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
const note = z.string().trim().min(1).max(4000);
const dispute = { disputeId: uuid };
const command = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('open'),
    kind: z.enum([
      'damage',
      'shortage',
      'delay',
      'undeliverable',
      'waiting_storage_return',
      'freight_commission',
      'pod',
    ]),
    description: note,
    requestedOutcome: note,
    amount: z
      .string()
      .regex(/^\d{1,12}(?:\.\d{1,6})?$/)
      .optional(),
    scope: z.string().trim().min(1).max(1000).optional(),
    financial: z.boolean().optional(),
    podVersionId: uuid.optional(),
    tripMilestoneId: uuid.optional(),
    relatedDisputeId: uuid.optional(),
    organisationId: uuid.optional(),
    note: note.max(1000).optional(),
  }),
  z.strictObject({
    ...dispute,
    action: z.enum([
      'reply',
      'counterclaim',
      'request_information',
      'internal_note',
      'close',
      'release',
    ]),
    note,
  }),
  z.strictObject({
    ...dispute,
    action: z.literal('propose'),
    note,
    counterclaimTerms: note.optional(),
  }),
  z.strictObject({ ...dispute, action: z.literal('assign'), assigneeId: uuid, note }),
  z.strictObject({ ...dispute, action: z.literal('external'), reference: note.max(1000), note }),
  z.strictObject({
    ...dispute,
    action: z.enum(['accept', 'reject']),
    proposalId: z.string().regex(/^[1-9]\d{0,18}$/),
  }),
  z.strictObject({ ...dispute, action: z.literal('withdraw') }),
]);

@Controller()
export class DisputesController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
    @Inject(FILE_STORE) private readonly fileStore: FileStore | null,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  @Get('organisations/:org/bookings/:booking/disputes')
  read(@Param('org') org: string, @Param('booking') booking: string, @Req() req: DisputeRequest) {
    return this.run(org, booking, req);
  }

  @Post('organisations/:org/bookings/:booking/disputes')
  @HttpCode(200)
  change(
    @Param('org') org: string,
    @Param('booking') booking: string,
    @Req() req: DisputeRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.run(org, booking, req, { key, body });
  }

  @Get('staff/operations/disputes')
  async queue(@Req() req: DisputeRequest) {
    const auth = req.headers.authorization;
    const token =
      typeof auth === 'string' ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(auth)?.[1] : undefined;
    if (!token) throw new ApiError(401, 'unauthorized', 'Authentication is required.');
    await this.access.requireBoundRole();
    const result = await this.pool.query<{ status: string; detail: unknown }>(
      'SELECT status, detail FROM trucker.staff_dispute_queue($1, $2)',
      [hashToken(token), req.requestId ?? null],
    );
    const row = result.rows[0]!;
    if (row.status === 'ok') return row.detail;
    if (row.status === 'forbidden')
      throw new ApiError(403, 'forbidden', 'Operations privilege is required.');
    throw new ApiError(401, 'unauthorized', 'Authentication is required.');
  }

  @Get('staff/operations/bookings/:booking/disputes')
  readStaff(@Param('booking') booking: string, @Req() req: DisputeRequest) {
    return this.run(null, booking, req);
  }

  @Post('staff/operations/bookings/:booking/disputes')
  @HttpCode(200)
  changeStaff(
    @Param('booking') booking: string,
    @Req() req: DisputeRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    return this.run(null, booking, req, { key, body });
  }

  @Put('organisations/:org/bookings/:booking/disputes/:disputeId/evidence')
  @HttpCode(200)
  upload(
    @Param('org') org: string,
    @Param('booking') booking: string,
    @Param('disputeId') disputeId: string,
    @Req() req: DisputeRequest,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.run(org, booking, req, undefined, { disputeId, key });
  }

  @Put('staff/operations/bookings/:booking/disputes/:disputeId/evidence')
  @HttpCode(200)
  uploadStaff(
    @Param('booking') booking: string,
    @Param('disputeId') disputeId: string,
    @Req() req: DisputeRequest,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return this.run(null, booking, req, undefined, { disputeId, key });
  }

  @Get('organisations/:org/bookings/:booking/disputes/:disputeId/evidence/:evidenceId')
  file(
    @Param('org') org: string,
    @Param('booking') booking: string,
    @Param('disputeId') disputeId: string,
    @Param('evidenceId') evidenceId: string,
    @Req() req: DisputeRequest,
    @Res() res: ServerResponse,
  ) {
    return this.download(org, booking, disputeId, evidenceId, req, res);
  }

  @Get('staff/operations/bookings/:booking/disputes/:disputeId/evidence/:evidenceId')
  fileStaff(
    @Param('booking') booking: string,
    @Param('disputeId') disputeId: string,
    @Param('evidenceId') evidenceId: string,
    @Req() req: DisputeRequest,
    @Res() res: ServerResponse,
  ) {
    return this.download(null, booking, disputeId, evidenceId, req, res);
  }

  private async download(
    org: string | null,
    booking: string,
    disputeId: string,
    evidenceId: string,
    req: DisputeRequest,
    res: ServerResponse,
  ) {
    if (!uuid.safeParse(disputeId).success || !/^[1-9]\d{0,18}$/.test(evidenceId)) {
      throw new ApiError(404, 'not_found', 'The requested resource was not found.');
    }
    const evidence = (await this.run(org, booking, req, undefined, undefined, {
      disputeId,
      evidenceId,
    })) as {
      storageKey: string;
      mediaType: string;
      fingerprint: string;
    };
    const bytes = await this.fileStore?.get(evidence.storageKey);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== evidence.fingerprint) {
      throw new ApiError(
        503,
        'file_unavailable',
        'The recorded evidence could not be read with its original fingerprint.',
      );
    }
    res.setHeader('content-type', evidence.mediaType);
    res.setHeader('content-length', bytes.length);
    res.setHeader('content-disposition', 'attachment');
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-evidence-fingerprint', evidence.fingerprint);
    res.end(bytes);
  }

  private async run(
    org: string | null,
    booking: string,
    req: DisputeRequest,
    mutation?: { key: string | undefined; body: unknown },
    upload?: { key: string | undefined; disputeId: string },
    download?: { evidenceId: string; disputeId: string },
  ) {
    if (!uuid.safeParse(booking).success || (org !== null && !uuid.safeParse(org).success)) {
      throw new ApiError(404, 'not_found', 'The requested resource was not found.');
    }
    const auth = req.headers.authorization;
    const token =
      typeof auth === 'string' ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(auth)?.[1] : undefined;
    if (!token) throw new ApiError(401, 'unauthorized', 'Authentication is required.');
    const parsed = mutation ? command.safeParse(mutation.body) : undefined;
    if (mutation && (!parsed?.success || !/^[A-Za-z0-9._-]{16,128}$/.test(mutation.key ?? ''))) {
      throw new ApiError(422, 'validation_failed', 'Check the dispute fields and retry key.');
    }
    await this.access.requireBoundRole();
    const person = org === null ? null : await this.identity.authenticate(token, req.requestId);
    const client = await this.pool.connect();
    let storageKey: string | undefined;
    try {
      await client.query('BEGIN');
      if (person) {
        await client.query(
          `SELECT set_config('trucker.session_token_hash', $1, true),
                  set_config('trucker.organisation_id', $2, true),
                  set_config('trucker.request_id', $3, true)`,
          [person.tokenHash, org, req.requestId ?? ''],
        );
      }
      let content: unknown = parsed?.success ? parsed.data : null;
      if (download) content = { action: 'read_evidence', ...download };
      if (upload) {
        const bytes = req.rawBody;
        const header = req.headers['content-type'];
        const mediaType =
          typeof header === 'string' ? header.split(';')[0]?.trim().toLowerCase() : '';
        if (!mediaType || !['image/jpeg', 'image/png', 'application/pdf'].includes(mediaType)) {
          throw new ApiError(415, 'unsupported_media_type', 'Send a JPEG, PNG or PDF file.');
        }
        if (
          !bytes?.length ||
          !uuid.safeParse(upload.disputeId).success ||
          !/^[A-Za-z0-9._-]{16,128}$/.test(upload.key ?? '')
        ) {
          throw new ApiError(422, 'validation_failed', 'Check the file and retry key.');
        }
        if (!this.fileStore)
          throw new ApiError(503, 'file_storage_closed', 'File storage is unavailable.');
        storageKey = await this.fileStore.put(bytes);
        content = {
          action: 'evidence',
          disputeId: upload.disputeId,
          mediaType,
          storageKey,
          size: bytes.length,
          fingerprint: createHash('sha256').update(bytes).digest('hex'),
        };
      }
      const result = await client.query<{ status: string; detail: unknown }>(
        'SELECT status, detail FROM trucker.booking_disputes($1, $2, $3, $4, $5)',
        [
          booking,
          person ? null : hashToken(token),
          req.requestId ?? null,
          mutation?.key ?? upload?.key ?? null,
          content === null ? null : JSON.stringify(content),
        ],
      );
      await client.query('COMMIT');
      const row = result.rows[0]!;
      // A failed COMMIT acknowledgement leaves storage in place, since the event may exist.
      if (storageKey && row.status !== 'ok')
        await this.fileStore?.remove(storageKey).catch(() => undefined);
      if (row.status === 'ok' || row.status === 'replayed') return row.detail;
      switch (row.status) {
        case 'unauthorized':
          throw new ApiError(401, 'unauthorized', 'Authentication is required.');
        case 'forbidden':
          throw new ApiError(403, 'forbidden', 'Your account cannot perform this dispute action.');
        case 'invalid':
          throw new ApiError(422, 'validation_failed', 'Check the dispute fields.');
        case 'conflict':
          throw new ApiError(
            409,
            'dispute_conflict',
            'This command conflicts with the current dispute or a previous request. Check the timeline.',
          );
        default:
          throw new ApiError(404, 'not_found', 'The requested resource was not found.');
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
