import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import { AccessGuard } from '../database/access.js';
import { ApiError } from '../http/api-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { hashToken } from '../identity/secrets.js';
import { DB_POOL } from '../tokens.js';

interface Request {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const reference = z.string().trim().min(1).max(200);
const note = z.string().trim().min(1).max(1000);
const amount = z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const retryKey = z.string().regex(/^[A-Za-z0-9._-]{16,128}$/);
const paymentCommand = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('report'),
    kind: z.enum(['freight', 'commission']),
    amount,
    currency,
    reference,
    evidence: reference,
  }),
  z.strictObject({ action: z.literal('confirm'), paymentId: uuid }),
  z.strictObject({ action: z.enum(['reject', 'review', 'void']), paymentId: uuid, note }),
  z.strictObject({
    action: z.literal('reconcile'),
    paymentId: uuid,
    amount,
    currency,
    reference,
    evidence: reference,
    note: note.optional(),
  }),
]);
const assignment = z.strictObject({ ownerId: uuid });

function identifier(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new ApiError(404, 'not_found', 'The booking was not found.');
  return parsed.data;
}

function bearer(request: Request): string {
  const header = request.headers.authorization;
  const token =
    typeof header === 'string' ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(header)?.[1] : undefined;
  if (!token) throw new ApiError(401, 'unauthorized', 'Authentication is required.');
  return token;
}

interface Result {
  status: string;
  detail: unknown;
}
function result(row: Result | undefined) {
  switch (row?.status) {
    case 'ok':
      return row.detail;
    case 'unauthorized':
      throw new ApiError(401, 'unauthorized', 'Authentication is required.');
    case 'forbidden':
      throw new ApiError(
        403,
        'forbidden',
        'This action requires the appropriate privilege and an independent reviewer.',
      );
    case 'not_found':
      throw new ApiError(404, 'not_found', 'The booking or record was not found.');
    case 'invalid':
      throw new ApiError(422, 'validation_failed', 'Check the financial or closure fields.');
    case 'conflict':
      throw new ApiError(
        409,
        'record_changed',
        'The action is unavailable in the current state or conflicts with an existing record.',
      );
    default:
      throw new Error('Unexpected booking completion result');
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown, key: unknown) {
  const parsed = schema.safeParse(body);
  const retry = retryKey.safeParse(key);
  if (!parsed.success || !retry.success)
    throw new ApiError(422, 'validation_failed', 'Check the submitted fields and retry key.');
  return { data: parsed.data, key: retry.data };
}

@Controller()
export class BookingCompletionController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(AccessGuard) private readonly access: AccessGuard,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  @Get('organisations/:org/bookings/:booking/fee-invoice-draft')
  partyInvoiceDraft(
    @Param('org') org: string,
    @Param('booking') booking: string,
    @Req() req: Request,
  ) {
    return this.party(
      req,
      identifier(org),
      'SELECT * FROM trucker.read_fee_invoice_draft($1,NULL,$2)',
      [identifier(booking), req.requestId ?? null],
    );
  }

  @Get('staff/operations/bookings/:booking/fee-invoice-draft')
  staffInvoiceDraft(@Param('booking') booking: string, @Req() req: Request) {
    return this.staff(req, 'SELECT * FROM trucker.read_fee_invoice_draft($3,$1,$2)', [
      identifier(booking),
    ]);
  }

  @Get('organisations/:org/financial-completion')
  partyFinancialList(@Param('org') org: string, @Req() req: Request) {
    return this.party(req, identifier(org), 'SELECT * FROM trucker.booking_financial_list()', []);
  }

  @Get('organisations/:org/bookings/:booking/financial-completion')
  partyFinancial(
    @Param('org') org: string,
    @Param('booking') booking: string,
    @Req() req: Request,
  ) {
    return this.party(
      req,
      identifier(org),
      'SELECT * FROM trucker.booking_financial($1,NULL,$2,NULL,NULL)',
      [identifier(booking), req.requestId ?? null],
    );
  }

  @Post('organisations/:org/bookings/:booking/financial-completion')
  @HttpCode(200)
  partyPayment(
    @Param('org') org: string,
    @Param('booking') booking: string,
    @Req() req: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(paymentCommand, body, key);
    return this.party(
      req,
      identifier(org),
      'SELECT * FROM trucker.booking_financial($1,NULL,$2,$3,$4)',
      [identifier(booking), req.requestId ?? null, input.key, JSON.stringify(input.data)],
    );
  }

  @Get('staff/operations/bookings/:booking/financial-completion')
  async staffFinancial(@Param('booking') booking: string, @Req() req: Request) {
    return this.staff(req, 'SELECT * FROM trucker.booking_financial($3,$1,$2,NULL,NULL)', [
      identifier(booking),
    ]);
  }

  @Post('staff/operations/bookings/:booking/financial-completion')
  @HttpCode(200)
  staffPayment(
    @Param('booking') booking: string,
    @Req() req: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(paymentCommand, body, key);
    return this.staff(req, 'SELECT * FROM trucker.booking_financial($3,$1,$2,$4,$5)', [
      identifier(booking),
      input.key,
      JSON.stringify(input.data),
    ]);
  }

  @Get('organisations/:org/bookings/:booking/closure')
  partyClosure(@Param('org') org: string, @Param('booking') booking: string, @Req() req: Request) {
    return this.party(req, identifier(org), 'SELECT * FROM trucker.booking_closure_for_party($1)', [
      identifier(booking),
    ]);
  }

  @Get('staff/operations/closure')
  queue(@Req() req: Request) {
    return this.staff(req, 'SELECT * FROM trucker.staff_booking_closure($1,$2,NULL,NULL,NULL)', []);
  }

  @Get('staff/operations/bookings/:booking/closure')
  staffClosure(@Param('booking') booking: string, @Req() req: Request) {
    return this.staff(req, 'SELECT * FROM trucker.staff_booking_closure($1,$2,$3,NULL,NULL)', [
      identifier(booking),
    ]);
  }

  @Post('staff/operations/bookings/:booking/closure')
  @HttpCode(200)
  assign(
    @Param('booking') booking: string,
    @Req() req: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(assignment, body, key);
    return this.staff(req, 'SELECT * FROM trucker.staff_booking_closure($1,$2,$3,$4,$5)', [
      identifier(booking),
      input.data.ownerId,
      input.key,
    ]);
  }

  private async staff(req: Request, sql: string, values: unknown[]) {
    const tokenHash = hashToken(bearer(req));
    await this.access.requireBoundRole();
    const rows = await this.pool.query<Result>(sql, [tokenHash, req.requestId ?? null, ...values]);
    return result(rows.rows[0]);
  }

  private async party(req: Request, org: string, sql: string, values: unknown[]) {
    const token = bearer(req);
    await this.access.requireBoundRole();
    const auth = await this.identity.authenticate(token, req.requestId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('trucker.session_token_hash',$1,true),
                set_config('trucker.organisation_id',$2,true),
                set_config('trucker.request_id',$3,true)`,
        [auth.tokenHash, org, req.requestId ?? ''],
      );
      const rows = await client.query<Result>(sql, values);
      await client.query('COMMIT');
      return result(rows.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
