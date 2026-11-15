import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import {
  ShipmentService,
  type Caller,
  type CatalogueEntry,
  type HistoryEntry,
  type PlaceOption,
  type PublicationInput,
  type PublicationRecord,
  type ShipmentInput,
  type ShipmentSummary,
  type ShipmentView,
} from './shipment.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Everything in a draft is optional. Text is kept as typed, in any script: only surrounding
// space is removed and the Unicode form normalised. An empty text is nothing.
const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => (value ?? '').normalize('NFC').trim())
    .pipe(z.string().max(max))
    .transform((value) => (value === '' ? null : value));

/** Gross weight in kilograms: more than nothing, at most 100,000, to the gram. */
const weight = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => (value === null || value === undefined ? '' : String(value).trim()))
  .pipe(
    z.string().refine((value) => {
      if (value === '') return true;
      if (!/^[0-9]{1,6}(\.[0-9]{1,3})?$/.test(value)) return false;
      const number = Number(value);
      return number > 0 && number <= 100_000;
    }),
  )
  // One spelling for one amount, so that the same weight sent twice is the same request.
  .transform((value) => (value === '' ? null : String(Number(value))));

/** Whole pieces: 1 to 100,000. */
const pieces = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => (value === null || value === undefined ? '' : String(value).trim()))
  .pipe(
    z.string().refine((value) => {
      if (value === '') return true;
      if (!/^[0-9]{1,6}$/.test(value)) return false;
      const number = Number(value);
      return number >= 1 && number <= 100_000;
    }),
  )
  .transform((value) => (value === '' ? null : String(Number(value))));

/** A wall-clock time as typed, and the offset chosen when that time occurs twice. */
const windowEnd = z
  .object({
    local: z
      .union([z.string(), z.null()])
      .optional()
      .transform((value) => (value ?? '').trim())
      .pipe(z.string().regex(/^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/))
      .transform((value) => (value === '' ? null : value)),
    offsetMinutes: z
      .union([z.number().int().min(-1080).max(1080), z.null()])
      .optional()
      .transform((value) => value ?? null),
  })
  .optional()
  .transform((value) => value ?? { local: null, offsetMinutes: null });

const place = z
  .object({
    address: optionalText(500),
    countryCode: z
      .union([z.string(), z.null()])
      .optional()
      .transform((value) => value ?? '')
      .pipe(z.string().regex(/^$|^[A-Z]{2}$/))
      .transform((value) => (value === '' ? null : value)),
    timeZone: z
      .union([z.string(), z.null()])
      .optional()
      .transform((value) => value ?? '')
      .pipe(z.string().max(64))
      .transform((value) => (value === '' ? null : value)),
    accessNotes: optionalText(1000),
    from: windowEnd,
    until: windowEnd,
  })
  .optional()
  .transform(
    (value) =>
      value ?? {
        address: null,
        countryCode: null,
        timeZone: null,
        accessNotes: null,
        from: { local: null, offsetMinutes: null },
        until: { local: null, offsetMinutes: null },
      },
  );

const contentFields = {
  shipperReference: optionalText(64),
  cargoDescription: optionalText(2000),
  grossWeightKg: weight,
  pieces,
  packaging: optionalText(200),
  equipmentNeeded: optionalText(500),
  pickup: place,
  delivery: place,
};
const createBody = z.object(contentFields);
const updateBody = z.object({ ...contentFields, version: z.number().int().min(1) });
const discardBody = z.object({ version: z.number().int().min(1) });

/** A catalogue code: absent, empty or a code. Anything else is refused at the field. */
const code = z
  .union([z.string().regex(/^$|^[a-z][a-z0-9_]{1,39}$/), z.null()])
  .optional()
  .transform((value) => (value ? value : null));
const publicationFields = {
  cargoCategory: code,
  equipmentType: code,
  // Required to publish, so absent stays absent: the database names it.
  dangerousGoods: z
    .union([z.boolean(), z.null()])
    .optional()
    .transform((value) => value ?? null),
  pickupArea: optionalText(120),
  deliveryArea: optionalText(120),
  quotationDeadline: windowEnd,
};
const publicationBody = z.object(publicationFields);
const publishBody = z.object({ ...publicationFields, version: z.number().int().min(1) });
const changeBody = z.object({
  ...contentFields,
  publication: publicationBody,
  version: z.number().int().min(1),
});
const republishBody = z.object({ quotationDeadline: windowEnd, version: z.number().int().min(1) });
const LIST_STATES = [
  'draft',
  'discarded',
  'published',
  'withdrawn',
  'expired',
  'booking_cancelled',
  'all',
] as const;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(body)'))];
  throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
    fields,
    problems: fields.map((field) => ({
      field,
      code: field === 'grossWeightKg' || field === 'pieces' ? 'out_of_range' : 'invalid',
    })),
  });
}

function bearer(request: IncomingRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  return match?.[1];
}

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', 'The requested resource was not found.');
/** Anything that is not an identifier is answered like a record that does not exist. */
const identifier = (value: string): string => {
  if (!UUID.test(value)) throw notFound();
  return value.toLowerCase();
};
const retryKey = (key: string | undefined): string => {
  if (!key || !RETRY_KEY.test(key))
    throw new ApiError(
      400,
      'retry_key_required',
      'Send an Idempotency-Key header of 16 to 128 letters, digits, dots, dashes or underscores.',
    );
  return key;
};

/**
 * Shipments of one organisation: drafts and their publication. There is no route here through
 * which a carrier reads a shipment, asks for or gives a quotation, books or takes payment: none
 * of that exists. What carriers would see is a preview for the shipper only.
 */
@Controller('organisations/:organisationId')
export class ShipmentController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ShipmentService) private readonly shipments: ShipmentService,
  ) {}

  /** The session is checked before anything else is read, including stored retries. */
  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Get('shipment-places')
  async places(
    @Param('organisationId') organisationId: string,
    @Req() request: IncomingRequest,
  ): Promise<{ countries: PlaceOption[] }> {
    const caller = await this.caller(request);
    return { countries: await this.shipments.placeOptions(caller, identifier(organisationId)) };
  }

  @Post('shipments')
  @HttpCode(201)
  async create(
    @Param('organisationId') organisationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<{ shipment: ShipmentView }> {
    const caller = await this.caller(request);
    const input: ShipmentInput = parse(createBody, body);
    return {
      shipment: await this.shipments.create(
        caller,
        identifier(organisationId),
        retryKey(key),
        input,
      ),
    };
  }

  @Get('shipments')
  async list(
    @Param('organisationId') organisationId: string,
    @Query('status') status: string | undefined,
    @Query('after') after: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<{ shipments: ShipmentSummary[]; nextAfter: string | null }> {
    const caller = await this.caller(request);
    const wanted = status ?? 'draft';
    const invalid = (field: string): ApiError =>
      new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
        fields: [field],
      });
    if (!(LIST_STATES as readonly string[]).includes(wanted)) throw invalid('status');
    if (after !== undefined && !UUID.test(after)) throw invalid('after');
    return this.shipments.list(
      caller,
      identifier(organisationId),
      wanted as (typeof LIST_STATES)[number],
      after?.toLowerCase() ?? null,
    );
  }

  @Get('shipments/:id')
  async get(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Req() request: IncomingRequest,
  ): Promise<{ shipment: ShipmentView }> {
    const caller = await this.caller(request);
    return {
      shipment: await this.shipments.get(caller, identifier(organisationId), identifier(id)),
    };
  }

  @Patch('shipments/:id')
  async update(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<{
    shipment: ShipmentView;
    outcome: 'updated' | 'already_applied';
    appliedVersion: number;
  }> {
    const caller = await this.caller(request);
    const { version, ...input } = parse(updateBody, body);
    return this.shipments.update(
      caller,
      identifier(organisationId),
      identifier(id),
      version,
      retryKey(key),
      input,
    );
  }

  @Post('shipments/:id/discard')
  @HttpCode(200)
  async discard(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ): Promise<{ shipment: ShipmentView; outcome: 'discarded' | 'already_discarded' }> {
    const caller = await this.caller(request);
    const { version } = parse(discardBody, body);
    return this.shipments.discard(
      caller,
      identifier(organisationId),
      identifier(id),
      version,
      retryKey(key),
    );
  }

  @Get('shipments/:id/history')
  async history(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Req() request: IncomingRequest,
  ): Promise<{ entries: HistoryEntry[] }> {
    const caller = await this.caller(request);
    return {
      entries: await this.shipments.history(caller, identifier(organisationId), identifier(id)),
    };
  }

  @Get('shipment-catalogues')
  async catalogues(
    @Param('organisationId') organisationId: string,
    @Req() request: IncomingRequest,
  ): Promise<{ cargoCategories: CatalogueEntry[]; equipmentTypes: CatalogueEntry[] }> {
    const caller = await this.caller(request);
    return this.shipments.catalogues(caller, identifier(organisationId));
  }

  @Post('shipments/:id/publish')
  @HttpCode(200)
  async publish(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version, ...details } = parse(publishBody, body);
    return this.shipments.publish(
      caller,
      identifier(organisationId),
      identifier(id),
      version,
      retryKey(key),
      details as PublicationInput,
    );
  }

  @Post('shipments/:id/published-changes')
  @HttpCode(200)
  async change(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version, publication, ...input } = parse(changeBody, body);
    return this.shipments.change(
      caller,
      identifier(organisationId),
      identifier(id),
      version,
      retryKey(key),
      input,
      publication as PublicationInput,
    );
  }

  @Post('shipments/:id/withdraw')
  @HttpCode(200)
  async withdraw(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version } = parse(discardBody, body);
    return this.shipments.withdraw(
      caller,
      identifier(organisationId),
      identifier(id),
      version,
      retryKey(key),
    );
  }

  @Post('shipments/:id/republish')
  @HttpCode(200)
  async republish(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const { version, quotationDeadline } = parse(republishBody, body);
    return this.shipments.republish(
      caller,
      identifier(organisationId),
      identifier(id),
      version,
      retryKey(key),
      quotationDeadline,
    );
  }

  @Post('shipments/:id/copy')
  @HttpCode(201)
  async copy(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.shipments.copy(caller, identifier(organisationId), identifier(id), retryKey(key));
  }

  @Get('shipments/:id/publication')
  async publication(
    @Param('organisationId') organisationId: string,
    @Param('id') id: string,
    @Req() request: IncomingRequest,
  ): Promise<{ publication: PublicationRecord }> {
    const caller = await this.caller(request);
    return {
      publication: await this.shipments.publication(
        caller,
        identifier(organisationId),
        identifier(id),
      ),
    };
  }
}
