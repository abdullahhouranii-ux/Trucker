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
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { StaffService } from '../staff/staff.service.js';
import { PodService, type PodCaller, type PodFile } from './pod.service.js';

// Proof of delivery (slice 18b): the manifest, each file, the shipper's review, and reading a
// file. The same routes exist for the carrier's administrators (and the shipper's, for review
// and reading), for the assigned driver, and for operations.

interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
  rawBody?: Buffer;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

const declareBody = z.object({
  version: z.number().int().min(1),
  receiverName: z.union([z.string().max(400), z.null()]).optional(),
  receiverRole: z.union([z.string().max(400), z.null()]).optional(),
  receiverRemarks: z.union([z.string().max(4000), z.null()]).optional(),
  replacesReason: z.union([z.string().max(2000), z.null()]).optional(),
  capturedAt: z.string().max(40).optional(),
  reason: z
    .enum(['no_phone', 'no_signal', 'driver_unable', 'device_lost', 'paper_copy', 'other'])
    .optional(),
  note: z.union([z.string().max(2000), z.null()]).optional(),
  items: z
    .array(
      z.object({
        kind: z.enum(['signature', 'signed_document', 'delivery_note', 'cargo_photo', 'other']),
        mediaType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
        sizeBytes: z.number().int(),
        fingerprint: z.string().max(64),
        optional: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(10),
});
const reviewBody = z.object({
  podId: z.string().max(40),
  version: z.number().int().min(1),
  decision: z.enum(['accepted', 'more_evidence_requested']),
  note: z.union([z.string().max(4000), z.null()]).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'body'))),
    ];
    throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
      fields,
      problems: fields.map((field) => ({ field, code: 'invalid' })),
    });
  }
  return parsed.data;
}
const identifier = (value: string): string => {
  if (!UUID.test(value))
    throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  return value.toLowerCase();
};
function bearer(request: IncomingRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return /^Bearer ([A-Za-z0-9._-]+)$/.exec(header)?.[1];
}
async function callerOf(identity: IdentityService, request: IncomingRequest): Promise<PodCaller> {
  const auth = await identity.authenticate(bearer(request), request.requestId);
  return { tokenHash: auth.tokenHash, requestId: request.requestId };
}
/** The file's own bytes, and its type from Content-Type (one of PD-2's three). */
function fileOf(request: IncomingRequest, contentType: string | undefined) {
  const mediaType = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!MEDIA_TYPES.includes(mediaType))
    throw new ApiError(415, 'unsupported_media_type', 'Send a JPEG, PNG or PDF file.');
  return { mediaType, bytes: request.rawBody ?? Buffer.alloc(0) };
}
/** Files are sent privately, never cached, and never interpreted as another type. */
function send(response: ServerResponse, file: PodFile): void {
  response.statusCode = 200;
  response.setHeader('content-type', file.mediaType);
  response.setHeader('content-length', String(file.bytes.length));
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-disposition', 'inline');
  response.setHeader('x-pod-fingerprint', file.fingerprint);
  response.end(file.bytes);
}

/** The carrier's administrators capture on the driver's behalf; the shipper's review and read. */
@Controller('organisations/:organisationId/bookings/:bookingId/pod')
export class PodController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PodService) private readonly pods: PodService,
  ) {}

  @Post()
  @HttpCode(200)
  async declare(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    return this.pods.declare(
      caller,
      identifier(organisationId),
      identifier(bookingId),
      parse(declareBody, body),
    );
  }

  @Put('items/:itemId')
  @HttpCode(200)
  async receive(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Param('itemId') itemId: string,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    const { mediaType, bytes } = fileOf(request, contentType);
    return this.pods.receive(
      caller,
      identifier(organisationId),
      identifier(bookingId),
      identifier(itemId),
      mediaType,
      bytes,
    );
  }

  @Post('review')
  @HttpCode(200)
  async review(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    const { podId, version, decision, note } = parse(reviewBody, body);
    return this.pods.review(
      caller,
      identifier(organisationId),
      identifier(bookingId),
      identifier(podId),
      version,
      decision,
      note ?? null,
    );
  }

  @Get('items/:itemId/file')
  async file(
    @Param('organisationId') organisationId: string,
    @Param('bookingId') bookingId: string,
    @Param('itemId') itemId: string,
    @Req() request: IncomingRequest,
    @Res() response: ServerResponse,
  ) {
    const caller = await callerOf(this.identity, request);
    send(
      response,
      await this.pods.file(
        caller,
        identifier(organisationId),
        identifier(bookingId),
        identifier(itemId),
      ),
    );
  }
}

/** The assigned driver captures the proof as it happens. */
@Controller('me/driver/assignments/:bookingId/pod')
export class DriverPodController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PodService) private readonly pods: PodService,
  ) {}

  @Post()
  @HttpCode(200)
  async declare(
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    return this.pods.declare(caller, '', identifier(bookingId), parse(declareBody, body));
  }

  @Put('items/:itemId')
  @HttpCode(200)
  async receive(
    @Param('bookingId') bookingId: string,
    @Param('itemId') itemId: string,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await callerOf(this.identity, request);
    const { mediaType, bytes } = fileOf(request, contentType);
    return this.pods.receive(
      caller,
      '',
      identifier(bookingId),
      identifier(itemId),
      mediaType,
      bytes,
    );
  }

  @Get('items/:itemId/file')
  async file(
    @Param('bookingId') bookingId: string,
    @Param('itemId') itemId: string,
    @Req() request: IncomingRequest,
    @Res() response: ServerResponse,
  ) {
    const caller = await callerOf(this.identity, request);
    send(response, await this.pods.file(caller, '', identifier(bookingId), identifier(itemId)));
  }
}

/** Operations: a paper POD on the driver's behalf, and reading files (each view recorded). */
@Controller('staff/operations/bookings/:bookingId/pod')
export class StaffPodController {
  constructor(
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(PodService) private readonly pods: PodService,
  ) {}

  @Post()
  @HttpCode(200)
  async declare(
    @Param('bookingId') bookingId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.staff.authenticate(bearer(request), request.requestId);
    return this.pods.staffDeclare(caller, identifier(bookingId), parse(declareBody, body));
  }

  @Put('items/:itemId')
  @HttpCode(200)
  async receive(
    @Param('bookingId') bookingId: string,
    @Param('itemId') itemId: string,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.staff.authenticate(bearer(request), request.requestId);
    const { mediaType, bytes } = fileOf(request, contentType);
    return this.pods.receive(
      caller,
      null,
      identifier(bookingId),
      identifier(itemId),
      mediaType,
      bytes,
    );
  }

  @Get('items/:itemId/file')
  async file(
    @Param('bookingId') bookingId: string,
    @Param('itemId') itemId: string,
    @Req() request: IncomingRequest,
    @Res() response: ServerResponse,
  ) {
    const caller = await this.staff.authenticate(bearer(request), request.requestId);
    send(response, await this.pods.staffFile(caller, identifier(bookingId), identifier(itemId)));
  }
}
