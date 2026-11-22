import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { StaffService } from '../staff/staff.service.js';
import { FleetService, type Caller } from './fleet.service.js';

interface IncomingRequest {
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{1,39}$/;

const vehicleBody = z.object({
  kind: z.string().max(20),
  category: z.string().max(40),
  equipmentType: z.string().max(40),
  registrationCountry: z.string().max(2),
  registrationNumber: z.string().max(40),
});
const documentBody = z.object({
  type: z.string().regex(CODE),
  documentNumber: z.string().max(200),
  issuingCountry: z.string().max(2),
  issueDate: z.union([z.string().max(10), z.null()]).optional(),
  expiryDate: z.string().max(10),
  licenceClasses: z.array(z.string().regex(CODE)).max(20).optional(),
});
const versioned = z.object({ version: z.number().int().min(1) });
const inviteBody = z.object({ phone: z.string().max(20) });
const authorisationBody = z.object({
  vehicleId: z.union([z.string().regex(UUID), z.null()]),
  granted: z.boolean(),
});
const respondBody = z.object({
  version: z.number().int().min(1),
  decision: z.enum(['accept', 'decline']),
});
const decisionBody = z.object({
  version: z.number().int().min(1),
  decision: z.string().max(20),
  reason: z.string().max(40),
  noConflict: z.boolean(),
});
const suspensionBody = z.object({
  subject: z.enum(['vehicle', 'driver']),
  id: z.string().regex(UUID),
  suspended: z.boolean(),
  reason: z.union([z.string().max(40), z.null()]).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(body)'))];
  throw new ApiError(422, 'validation_failed', 'Some fields are missing or not valid.', {
    fields,
    problems: fields.map((field) => ({ field, code: 'invalid' })),
  });
}
function bearer(request: IncomingRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  return /^Bearer ([A-Za-z0-9._-]+)$/.exec(header)?.[1];
}
const identifier = (value: string): string => {
  if (!UUID.test(value))
    throw new ApiError(404, 'not_found', 'The requested resource was not found.');
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
const documentInput = (body: unknown): Record<string, unknown> => {
  const input = parse(documentBody, body);
  return {
    type: input.type,
    documentNumber: input.documentNumber.normalize('NFC').trim(),
    issuingCountry: input.issuingCountry,
    ...(input.issueDate ? { issueDate: input.issueDate } : {}),
    expiryDate: input.expiryDate,
    licenceClasses: input.licenceClasses ?? [],
  };
};

/** The carrier's fleet, under its own organisation. No reservation or assignment route exists. */
@Controller('organisations/:organisationId/fleet')
export class FleetController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(FleetService) private readonly fleet: FleetService,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async overview(@Param('organisationId') organisationId: string, @Req() request: IncomingRequest) {
    return {
      fleet: await this.fleet.overview(await this.caller(request), identifier(organisationId)),
    };
  }

  @Post('vehicles')
  @HttpCode(201)
  async registerVehicle(
    @Param('organisationId') organisationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.registerVehicle(
      caller,
      identifier(organisationId),
      retryKey(key),
      parse(vehicleBody, body),
    );
  }

  @Post('vehicles/:vehicleId/retire')
  @HttpCode(200)
  async retireVehicle(
    @Param('organisationId') organisationId: string,
    @Param('vehicleId') vehicleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.retireVehicle(
      caller,
      identifier(organisationId),
      identifier(vehicleId),
      parse(versioned, body).version,
      retryKey(key),
    );
  }

  @Post('vehicles/:vehicleId/documents')
  @HttpCode(201)
  async submitVehicleDocument(
    @Param('organisationId') organisationId: string,
    @Param('vehicleId') vehicleId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.submitVehicleDocument(
      caller,
      identifier(organisationId),
      identifier(vehicleId),
      retryKey(key),
      documentInput(body),
    );
  }

  @Post('drivers')
  @HttpCode(201)
  async inviteDriver(
    @Param('organisationId') organisationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.inviteDriver(
      caller,
      identifier(organisationId),
      retryKey(key),
      parse(inviteBody, body).phone.trim(),
    );
  }

  @Post('drivers/self')
  @HttpCode(200)
  async becomeOwnDriver(
    @Param('organisationId') organisationId: string,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.becomeOwnDriver(caller, identifier(organisationId));
  }

  @Post('drivers/:affiliationId/end')
  @HttpCode(200)
  async endAffiliation(
    @Param('organisationId') organisationId: string,
    @Param('affiliationId') affiliationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.endAffiliation(
      caller,
      identifier(organisationId),
      identifier(affiliationId),
      parse(versioned, body).version,
      retryKey(key),
    );
  }

  @Post('drivers/:affiliationId/authorisations')
  @HttpCode(200)
  async setAuthorisation(
    @Param('organisationId') organisationId: string,
    @Param('affiliationId') affiliationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const input = parse(authorisationBody, body);
    return this.fleet.setAuthorisation(
      caller,
      identifier(organisationId),
      identifier(affiliationId),
      retryKey(key),
      { vehicleId: input.vehicleId?.toLowerCase() ?? null, granted: input.granted },
    );
  }
}

/** The driver's own side: invitations to their number, their carrier, their documents. */
@Controller('me/driver')
export class DriverController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(FleetService) private readonly fleet: FleetService,
  ) {}

  private async caller(request: IncomingRequest): Promise<Caller> {
    const auth = await this.identity.authenticate(bearer(request), request.requestId);
    return { personId: auth.personId, tokenHash: auth.tokenHash, requestId: request.requestId };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async overview(@Req() request: IncomingRequest) {
    return { driver: await this.fleet.driverOverview(await this.caller(request)) };
  }

  @Post('invitations/:affiliationId/respond')
  @HttpCode(200)
  async respond(
    @Param('affiliationId') affiliationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    const input = parse(respondBody, body);
    return this.fleet.respond(
      caller,
      identifier(affiliationId),
      input.version,
      retryKey(key),
      input.decision,
    );
  }

  @Post('affiliations/:affiliationId/leave')
  @HttpCode(200)
  async leave(
    @Param('affiliationId') affiliationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.leave(
      caller,
      identifier(affiliationId),
      parse(versioned, body).version,
      retryKey(key),
    );
  }

  @Post('documents')
  @HttpCode(201)
  async submitDocument(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.submitDriverDocument(caller, retryKey(key), documentInput(body));
  }
}

/** Staff: what waits for a decision, the decisions, and suspensions. */
@Controller('staff/fleet')
export class FleetStaffController {
  constructor(
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(FleetService) private readonly fleet: FleetService,
  ) {}

  private caller(request: IncomingRequest) {
    return this.staff.authenticate(bearer(request), request.requestId);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async queue(@Req() request: IncomingRequest) {
    return { fleet: await this.fleet.staffQueue(await this.caller(request)) };
  }

  @Post('vehicles/:vehicleId/ownership')
  @HttpCode(200)
  async decideOwnership(
    @Param('vehicleId') vehicleId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.staffDecide(
      caller,
      'ownership',
      identifier(vehicleId),
      parse(decisionBody, body),
    );
  }

  @Post('documents/:documentId/decision')
  @HttpCode(200)
  async decideDocument(
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ) {
    const caller = await this.caller(request);
    return this.fleet.staffDecide(
      caller,
      'document',
      identifier(documentId),
      parse(decisionBody, body),
    );
  }

  @Post('suspensions')
  @HttpCode(200)
  async suspend(@Body() body: unknown, @Req() request: IncomingRequest) {
    const caller = await this.caller(request);
    const input = parse(suspensionBody, body);
    return this.fleet.staffSuspend(caller, {
      subject: input.subject,
      id: input.id.toLowerCase(),
      suspended: input.suspended,
      reason: input.reason ?? null,
    });
  }
}
