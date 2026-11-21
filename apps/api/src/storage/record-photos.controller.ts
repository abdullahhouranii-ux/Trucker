import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Controller, Get, Header, Inject, Param, Put, Req, Res } from '@nestjs/common';
import type pg from 'pg';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import type { FileStore } from './file-store.js';
import { DB_POOL, FILE_STORE } from '../tokens.js';

interface PhotoRequest {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
  rawBody?: Buffer;
}
const root = 'organisations/:org/:kind/:record/photos';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missing = () => new ApiError(404, 'not_found', 'The record or photo was not found.');
const unavailable = () => new ApiError(503, 'file_storage_closed', 'Photo storage is unavailable.');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

@Controller()
export class RecordPhotosController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(FILE_STORE) private readonly store: FileStore | null,
  ) {}

  @Get(root)
  @Header('Cache-Control', 'private, no-store')
  async list(
    @Param('org') org: string,
    @Param('kind') kind: string,
    @Param('record') record: string,
    @Req() req: PhotoRequest,
  ) {
    return { photos: await this.read(org, kind, record, null, req) };
  }

  @Get(root + '/:photo')
  async download(
    @Param('org') org: string,
    @Param('kind') kind: string,
    @Param('record') record: string,
    @Param('photo') photo: string,
    @Req() req: PhotoRequest,
    @Res() res: ServerResponse,
  ) {
    const metadata = (await this.read(org, kind, record, photo, req)) as {
      storageKey: string;
      mediaType: string;
      fingerprint: string;
    };
    const bytes = await this.store?.get(metadata.storageKey);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.fingerprint)
      throw unavailable();
    res.setHeader('content-type', metadata.mediaType);
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.end(bytes);
  }

  @Put(root + '/:photo')
  async upload(
    @Param('org') org: string,
    @Param('kind') kind: string,
    @Param('record') record: string,
    @Param('photo') photo: string,
    @Req() req: PhotoRequest,
  ) {
    const client = await this.begin(org, kind, record, photo, req);
    let key: string | undefined;
    let commitStarted = false;
    let stored = false;
    try {
      const bytes = req.rawBody;
      const mime = req.headers['content-type'];
      if (
        !bytes ||
        !(
          (mime === 'image/png' && bytes.length > png.length && bytes.subarray(0, 8).equals(png)) ||
          (mime === 'image/jpeg' &&
            bytes.length >= 4 &&
            bytes[0] === 255 &&
            bytes[1] === 216 &&
            bytes[2] === 255)
        )
      ) {
        throw new ApiError(415, 'unsupported_media_type', 'Send a JPEG or PNG image.');
      }
      if (!this.store) throw unavailable();
      await this.query(client, kind, record, null, null);
      key = await this.store.put(bytes);
      const result = await this.query(client, kind, record, photo, {
        storageKey: key,
        mediaType: mime,
        size: bytes.length,
        fingerprint: createHash('sha256').update(bytes).digest('hex'),
      });
      stored = result.status === 'stored';
      commitStarted = true;
      await client.query('COMMIT');
      return { id: photo, outcome: stored ? 'stored' : 'already_stored' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      if (key && (!commitStarted || !stored)) await this.store?.remove(key).catch(() => undefined);
    }
  }

  private async read(
    org: string,
    kind: string,
    record: string,
    photo: string | null,
    req: PhotoRequest,
  ) {
    const client = await this.begin(org, kind, record, photo, req);
    try {
      const result = await this.query(client, kind, record, photo, null);
      await client.query('COMMIT');
      return result.detail;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async begin(
    org: string,
    kind: string,
    record: string,
    photo: string | null,
    req: PhotoRequest,
  ) {
    if (
      !['shipments', 'vehicles'].includes(kind) ||
      !uuid.test(org) ||
      !uuid.test(record) ||
      (photo !== null && !uuid.test(photo))
    )
      throw missing();
    const auth = req.headers.authorization;
    const token =
      typeof auth === 'string' ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(auth)?.[1] : undefined;
    if (!token) throw new ApiError(401, 'unauthorized', 'Authentication is required.');
    await this.access.requireBoundRole();
    const person = await this.identity.authenticate(token, req.requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('trucker.session_token_hash', $1, true), set_config('trucker.organisation_id', $2, true), set_config('trucker.request_id', $3, true)",
        [person.tokenHash, org, req.requestId ?? ''],
      );
      return client;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      throw error;
    }
  }

  private async query(
    client: pg.PoolClient,
    kind: string,
    record: string,
    photo: string | null,
    upload: Record<string, unknown> | null,
  ) {
    const { rows } = await client.query<{ status: string; detail: unknown }>(
      'SELECT status, detail FROM trucker.record_photos($1,$2,$3,$4)',
      [kind, record, photo, upload],
    );
    const result = rows[0]!;
    if (['ok', 'stored', 'repeated'].includes(result.status)) return result;
    if (result.status === 'unauthorized')
      throw new ApiError(401, 'unauthorized', 'Authentication is required.');
    if (result.status === 'limit')
      throw new ApiError(409, 'photo_limit', 'The record already has twelve photos.');
    if (result.status === 'conflict')
      throw new ApiError(409, 'record_changed', 'The record or photo has changed.');
    throw missing();
  }
}
