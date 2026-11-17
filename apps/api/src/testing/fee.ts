import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

/**
 * Tests only: Trucker's fee for a booking, settled the way staff settle it (slice 26): one
 * administrator records the transfer seen on the bank statement, a second approves it. Tests of
 * assignment and later stages use this so that confirmation still follows full assignment.
 */
export interface Reply {
  status: number;
  body: Record<string, unknown>;
  text: string;
}
export type Caller = (
  method: string,
  route: string,
  options?: { body?: unknown; token?: string; key?: string },
) => Promise<Reply>;

export interface FeeDue {
  bookingId: string;
  status: string;
  dueAt: string;
  amount: string;
  currency: string;
  reference: string;
}
export interface FeePayment {
  id: string;
  version: number;
  status: string;
  outcome: string | null;
}

export const retryKey = (): string => `fee-${randomBytes(12).toString('hex')}`;
export const statementLine = (): string => `STMT-${randomBytes(6).toString('hex').toUpperCase()}`;

/** The fee of a booking as the staff list of fees due shows it. */
export async function feeDue(call: Caller, staffToken: string, booking: string): Promise<FeeDue> {
  const reply = await call('GET', '/staff/fee-payments', { token: staffToken });
  assert.equal(reply.status, 200, reply.text);
  const due = (reply.body.fees as { due: FeeDue[] }).due.find((item) => item.bookingId === booking);
  assert.ok(due, `the fee of booking ${booking} is due`);
  return due;
}

export function recordReceipt(
  call: Caller,
  staffToken: string,
  receipt: Record<string, unknown>,
  key = retryKey(),
): Promise<Reply> {
  return call('POST', '/staff/fee-payments', { token: staffToken, key, body: receipt });
}

export function decideReceipt(
  call: Caller,
  staffToken: string,
  payment: Pick<FeePayment, 'id' | 'version'>,
  decision: 'approve' | 'reject',
  note?: string,
): Promise<Reply> {
  return call('POST', `/staff/fee-payments/${payment.id}/decision`, {
    token: staffToken,
    body: { version: payment.version, decision, ...(note === undefined ? {} : { note }) },
  });
}

/** A receipt that matches the fee exactly, as the statement would show it. */
export const matching = (due: FeeDue): Record<string, unknown> => ({
  reference: due.reference,
  amount: due.amount,
  currency: due.currency,
  valueDate: due.dueAt.slice(0, 10),
  statementReference: statementLine(),
});

/** Records and approves the exact fee, by two different administrators. */
export async function settleFee(
  call: Caller,
  recorder: string,
  approver: string,
  booking: string,
): Promise<Reply> {
  const due = await feeDue(call, recorder, booking);
  const recorded = await recordReceipt(call, recorder, matching(due));
  assert.equal(recorded.status, 201, recorded.text);
  const decided = await decideReceipt(
    call,
    approver,
    recorded.body.payment as FeePayment,
    'approve',
  );
  assert.equal(decided.status, 200, decided.text);
  return decided;
}
