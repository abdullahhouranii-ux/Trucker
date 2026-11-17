import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../web/src/components/form.tsx';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import { decideFeeAction, recordFeeAction } from '../../server/actions.ts';
import { requireStaff } from '../../server/session.ts';

// Trucker's fee (db/migrations/0024). A payer transfers the fee quoting the booking's reference.
// One administrator records the transfer as it appears on Trucker's bank statement; a different
// administrator approves or rejects it. A slip or a payer's message is never proof. Approval of
// a fee that is due confirms the booking when every resource is already assigned. Money for a
// booking that has ended, or paid twice, becomes a refund record. Times are in UTC.

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

interface Person {
  id: string;
  displayName: string;
}
interface Payment {
  id: string;
  version: number;
  bookingId: string;
  method: 'bank_transfer' | 'online';
  status: 'recorded' | 'approved' | 'rejected';
  outcome: 'settled' | 'refund_due' | null;
  amount: string;
  currency: string;
  valueDate: string;
  statementReference: string;
  note: string | null;
  reference: string;
  /** No one for an online payment: the provider's signed notification recorded it. */
  recordedBy: Person | null;
  recordedAt: string;
  decidedBy: Person | null;
  decidedAt: string | null;
  decisionNote: string | null;
}
interface Due {
  bookingId: string;
  status: 'due' | 'overdue';
  dueAt: string;
  amount: string;
  currency: string;
  reference: string;
  verifying: boolean;
  payer: string;
  payerOrganisation: { id: string; legalName: string } | null;
}
interface Refund {
  id: string;
  bookingId: string;
  reason: 'booking_ended' | 'duplicate_payment' | 'cancelled_after_payment';
  amount: string;
  currency: string;
  recordedAt: string;
  reference: string;
}
interface OnlineReview {
  id: string;
  result: 'mismatch' | 'unknown_checkout';
  kind: 'notification' | 'status_check';
  providerReference: string;
  transactionId: string | null;
  amount: string | null;
  currency: string | null;
  receivedAt: string;
  reference: string | null;
}
interface OpenCheckout {
  id: string;
  reference: string;
  amount: string;
  currency: string;
  status: string;
  expiresAt: string;
}
interface Overview {
  staffId: string;
  onlineReview: OnlineReview[];
  openCheckouts: OpenCheckout[];
  due: Due[];
  awaitingApproval: Payment[];
  decided: Payment[];
  refunds: Refund[];
}

const DONE: Record<string, string> = {
  recorded:
    'The transfer was recorded. It changes nothing until a different administrator approves it.',
  already_recorded: 'This transfer was already recorded. Nothing more was made.',
  approved: 'The transfer was approved.',
  approved_confirmed: 'The transfer was approved, and the booking is now confirmed.',
  rejected: 'The transfer was rejected. Its statement line can be recorded again.',
};
const ERRORS: Record<string, string> = {
  staff_privilege_required: 'Your account does not hold the privilege this needs.',
  different_person_required:
    'You recorded this transfer. A different administrator must approve or reject it.',
  receipt_already_decided: 'This transfer was already decided.',
  record_changed: 'The transfer changed since the page was loaded. Nothing was changed.',
  retry_key_conflict: 'This form was used for a different transfer. Reload the page.',
  not_found: 'That transfer was not found.',
  note_required: 'Say why the transfer is rejected.',
  unconfirmed:
    'It was not confirmed that this was done. It may have been. The lists show the present state. Trying again changes nothing twice.',
  refused: 'That was refused.',
};
const FIELDS: Record<string, [string, string]> = {
  'reference:unknown': ['reference', 'Reference: no fee has this reference.'],
  'reference:not_required': ['reference', 'Reference: nothing is due for this booking.'],
  'reference:invalid': ['reference', 'Reference: copy it from the bank statement.'],
  'amount:invalid': [
    'amount',
    'Amount: a positive amount with no more decimals than the currency.',
  ],
  'amount:mismatch': [
    'amount',
    'Amount: it must equal the fee exactly. A transfer that does not match is not recorded against the fee.',
  ],
  'currency:invalid': ['currency', 'Currency: the three-letter code on the statement.'],
  'currency:mismatch': ['currency', 'Currency: it must be the currency of the fee.'],
  'valueDate:invalid': ['valueDate', 'Value date: a date written YYYY-MM-DD.'],
  'valueDate:future': ['valueDate', 'Value date: it cannot be later than today.'],
  'statementReference:required': [
    'statementReference',
    'Statement line: the reference of the line on the bank statement.',
  ],
  'statementReference:already_recorded': [
    'statementReference',
    'Statement line: this line is already recorded against a fee.',
  ],
  'note:invalid': ['note', 'Note: at most 1000 characters.'],
};
const REFUND_REASON: Record<Refund['reason'], string> = {
  booking_ended: 'The booking had ended when this money was verified',
  duplicate_payment: 'Paid twice',
  cancelled_after_payment: 'The booking was cancelled after payment',
};
const at = (iso: string): string => utc(new Date(iso).toISOString());

function PaymentFacts({ payment }: { payment: Payment }) {
  return (
    <ul className="evidence">
      <li>
        Reference: <bdi dir="ltr">{payment.reference}</bdi>
      </li>
      <li>
        Amount:{' '}
        <bdi dir="ltr">
          {payment.amount} {payment.currency}
        </bdi>
        , value date {payment.valueDate}
      </li>
      <li>
        Statement line: <bdi dir="ltr">{payment.statementReference}</bdi>
      </li>
      <li>
        {payment.recordedBy ? (
          <>
            Recorded by <bdi>{payment.recordedBy.displayName}</bdi> at {at(payment.recordedAt)}
          </>
        ) : (
          <>
            Paid online: recorded from the provider&apos;s signed notice at {at(payment.recordedAt)}
          </>
        )}
      </li>
      {payment.note ? (
        <li>
          Note: <bdi>{payment.note}</bdi>
        </li>
      ) : null}
    </ul>
  );
}

export default async function FeesPage({ searchParams }: Props) {
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/fees" />
        </main>
      </>
    );
  }
  const search = await searchParams;
  const one = (name: string): string =>
    typeof search[name] === 'string' ? (search[name] as string) : '';
  const reply = await api<{ fees: Overview }>('GET', '/staff/fee-payments', { token: found.token });
  if (!reply.ok && reply.status === 401) redirect('/sign-in?error=session_ended');
  const done = DONE[one('done')];
  const error = one('error');
  const problems =
    error === 'validation_failed'
      ? one('fields')
          .split(',')
          .filter((code) => code !== '')
          .map((code) => {
            const entry = FIELDS[code];
            return entry ? { field: entry[0], message: entry[1] } : { message: ERRORS.refused! };
          })
      : error === 'note_required' && /^[0-9a-f-]{36}$/.test(one('payment'))
        ? [{ field: `reject-note-${one('payment')}`, message: ERRORS.note_required! }]
        : error !== ''
          ? [{ message: ERRORS[error] ?? ERRORS.refused! }]
          : [];
  const retry = /^[A-Za-z0-9._-]{16,128}$/.test(one('retry')) ? one('retry') : randomUUID();
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/fees" />
      <main id="main" tabIndex={-1}>
        <div className="page" data-state="fees">
          <h1>Fee payments</h1>
          <p>
            Payers transfer Trucker&apos;s fee quoting the booking&apos;s reference. Record a
            transfer only when it is on Trucker&apos;s bank statement: a transfer slip or a
            payer&apos;s message is not proof. A different administrator approves or rejects it.
            Approving a fee that is due confirms the booking when every resource is already
            assigned. Times are in UTC.
          </p>
          <ErrorSummary title="This was not done" problems={problems} />
          {done && problems.length === 0 ? (
            <p className="notice notice-success" role="status" id="fees-done">
              {done}
            </p>
          ) : null}
          {!reply.ok ? (
            <div className="notice notice-error" role="alert" id="fees-unavailable">
              {reply.status === 403
                ? 'Your account does not hold the privilege this needs. The attempt was recorded.'
                : 'This could not be read. Reload the page.'}
            </div>
          ) : (
            <>
              <section className="section" aria-labelledby="record-title">
                <h2 id="record-title">Record a transfer from the bank statement</h2>
                <form className="form card" id="record-form" action={recordFeeAction}>
                  <input type="hidden" name="retryKey" value={retry} />
                  <div className="field">
                    <label htmlFor="reference">Reference quoted on the transfer</label>
                    <p className="field-hint" id="reference-hint">
                      It starts with TF-, as shown in the list of fees due.
                    </p>
                    <input
                      id="reference"
                      name="reference"
                      type="text"
                      maxLength={40}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="reference-hint"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="amount">Amount received</label>
                    <p className="field-hint" id="amount-hint">
                      As on the statement, for example 30.00. For a fee that is due it must match
                      exactly.
                    </p>
                    <input
                      id="amount"
                      name="amount"
                      type="text"
                      inputMode="decimal"
                      maxLength={20}
                      autoComplete="off"
                      aria-describedby="amount-hint"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="currency">Currency</label>
                    <p className="field-hint" id="currency-hint">
                      The three-letter code, for example AED.
                    </p>
                    <input
                      id="currency"
                      name="currency"
                      type="text"
                      maxLength={3}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="currency-hint"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="valueDate">Value date</label>
                    <p className="field-hint" id="valueDate-hint">
                      The date on the statement, written YYYY-MM-DD.
                    </p>
                    <input
                      id="valueDate"
                      name="valueDate"
                      type="text"
                      inputMode="numeric"
                      maxLength={10}
                      autoComplete="off"
                      aria-describedby="valueDate-hint"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="statementReference">Statement line reference</label>
                    <p className="field-hint" id="statementReference-hint">
                      The bank&apos;s reference for this line. Each line is recorded once.
                    </p>
                    <input
                      id="statementReference"
                      name="statementReference"
                      type="text"
                      maxLength={100}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby="statementReference-hint"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="note">Note (optional)</label>
                    <textarea id="note" name="note" rows={2} maxLength={1000} />
                  </div>
                  <button className="button button-primary" type="submit" id="record-transfer">
                    Record the transfer
                  </button>
                </form>
              </section>

              <section className="section" aria-labelledby="approval-title">
                <h2 id="approval-title">Waiting for a second administrator</h2>
                {reply.data.fees.awaitingApproval.length === 0 ? (
                  <p id="approval-empty">No recorded transfer is waiting.</p>
                ) : (
                  <ol className="organisation-list" id="approval-list">
                    {reply.data.fees.awaitingApproval.map((payment) => (
                      <li className="card" key={payment.id} data-payment={payment.id}>
                        <PaymentFacts payment={payment} />
                        {payment.recordedBy?.id === reply.data.fees.staffId ? (
                          <p className="field-hint" data-own-record>
                            You recorded this transfer. A different administrator approves or
                            rejects it.
                          </p>
                        ) : (
                          <>
                            <form action={decideFeeAction}>
                              <input type="hidden" name="paymentId" value={payment.id} />
                              <input type="hidden" name="version" value={payment.version} />
                              <input type="hidden" name="decision" value="approve" />
                              <button
                                className="button button-primary"
                                type="submit"
                                aria-describedby={`payment-${payment.id}-ref`}
                              >
                                Approve the transfer
                              </button>
                              <span className="visually-hidden" id={`payment-${payment.id}-ref`}>
                                {payment.reference}
                              </span>
                            </form>
                            <form className="form" action={decideFeeAction}>
                              <input type="hidden" name="paymentId" value={payment.id} />
                              <input type="hidden" name="version" value={payment.version} />
                              <input type="hidden" name="decision" value="reject" />
                              <div className="field">
                                <label htmlFor={`reject-note-${payment.id}`}>
                                  Why it is rejected
                                </label>
                                <textarea
                                  id={`reject-note-${payment.id}`}
                                  name="note"
                                  rows={2}
                                  maxLength={1000}
                                />
                              </div>
                              <button
                                className="button button-danger"
                                type="submit"
                                aria-describedby={`payment-${payment.id}-ref`}
                              >
                                Reject the transfer
                              </button>
                            </form>
                          </>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="section" aria-labelledby="due-title">
                <h2 id="due-title">Fees due</h2>
                <p>Soonest deadline first. A fee unpaid at its deadline lapses the booking.</p>
                {reply.data.fees.due.length === 0 ? (
                  <p id="due-empty">No fee is due.</p>
                ) : (
                  <ol className="organisation-list" id="due-list">
                    {reply.data.fees.due.map((item) => (
                      <li
                        className="card"
                        key={item.bookingId}
                        data-fee-booking={item.bookingId}
                        data-fee-status={item.status}
                      >
                        <ul className="evidence">
                          <li>
                            Reference: <bdi dir="ltr">{item.reference}</bdi>
                          </li>
                          <li>
                            Amount:{' '}
                            <bdi dir="ltr">
                              {item.amount} {item.currency}
                            </bdi>
                          </li>
                          <li>
                            Payer: <bdi>{item.payerOrganisation?.legalName ?? item.payer}</bdi>
                          </li>
                          <li>
                            {item.status === 'overdue'
                              ? `Not paid by its deadline, ${at(item.dueAt)}. The booking is lapsing.`
                              : `Due by ${at(item.dueAt)}`}
                            {item.verifying ? '. A transfer is waiting for approval.' : ''}
                          </li>
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="section" aria-labelledby="online-review-title">
                <h2 id="online-review-title">Online payments to look into</h2>
                <p>
                  Signed notices that settled nothing: an amount or currency that differs from the
                  checkout, or a checkout Trucker does not know. Reconciliation comes in a later
                  release.
                </p>
                {reply.data.fees.onlineReview.length === 0 ? (
                  <p id="online-review-empty">Nothing to look into.</p>
                ) : (
                  <ol className="organisation-list" id="online-review-list">
                    {reply.data.fees.onlineReview.map((item) => (
                      <li className="card" key={item.id} data-review={item.result}>
                        <ul className="evidence">
                          <li>
                            {item.result === 'mismatch'
                              ? 'The amount or currency differs from the checkout'
                              : 'No checkout has this provider reference'}
                          </li>
                          <li>
                            Reference: <bdi dir="ltr">{item.reference ?? 'none'}</bdi>
                          </li>
                          <li>
                            Provider reference: <bdi dir="ltr">{item.providerReference}</bdi>
                          </li>
                          {item.amount ? (
                            <li>
                              Amount reported:{' '}
                              <bdi dir="ltr">
                                {item.amount} {item.currency}
                              </bdi>
                            </li>
                          ) : null}
                          <li>Received at {at(item.receivedAt)}</li>
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="section" aria-labelledby="open-checkouts-title">
                <h2 id="open-checkouts-title">Online payments in progress</h2>
                {reply.data.fees.openCheckouts.length === 0 ? (
                  <p id="open-checkouts-empty">No online payment is in progress.</p>
                ) : (
                  <ol className="organisation-list" id="open-checkouts-list">
                    {reply.data.fees.openCheckouts.map((item) => (
                      <li className="card" key={item.id} data-checkout={item.id}>
                        <ul className="evidence">
                          <li>
                            Reference: <bdi dir="ltr">{item.reference}</bdi>
                          </li>
                          <li>
                            Amount:{' '}
                            <bdi dir="ltr">
                              {item.amount} {item.currency}
                            </bdi>
                          </li>
                          <li>Open until {at(item.expiresAt)}</li>
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="section" aria-labelledby="refunds-title">
                <h2 id="refunds-title">Money to return</h2>
                <p>Refunds are recorded here. Processing them comes in a later release.</p>
                {reply.data.fees.refunds.length === 0 ? (
                  <p id="refunds-empty">Nothing to return.</p>
                ) : (
                  <ol className="organisation-list" id="refund-list">
                    {reply.data.fees.refunds.map((refund) => (
                      <li className="card" key={refund.id} data-refund={refund.reason}>
                        <ul className="evidence">
                          <li>
                            Reference: <bdi dir="ltr">{refund.reference}</bdi>
                          </li>
                          <li>
                            Amount:{' '}
                            <bdi dir="ltr">
                              {refund.amount} {refund.currency}
                            </bdi>
                          </li>
                          <li>{REFUND_REASON[refund.reason]}</li>
                          <li>Recorded at {at(refund.recordedAt)}</li>
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="section" aria-labelledby="decided-title">
                <h2 id="decided-title">Decided recently</h2>
                {reply.data.fees.decided.length === 0 ? (
                  <p id="decided-empty">Nothing decided yet.</p>
                ) : (
                  <ol className="organisation-list" id="decided-list">
                    {reply.data.fees.decided.map((payment) => (
                      <li
                        className="card"
                        key={payment.id}
                        data-payment={payment.id}
                        data-decision={payment.status}
                      >
                        <PaymentFacts payment={payment} />
                        <p>
                          {payment.status === 'rejected'
                            ? 'Rejected'
                            : payment.outcome === 'settled'
                              ? 'Approved: it settled the fee'
                              : 'Approved: to be returned'}{' '}
                          {payment.decidedBy ? (
                            <>
                              {' '}
                              by <bdi>{payment.decidedBy.displayName}</bdi>
                            </>
                          ) : null}
                          {payment.decidedAt ? ` at ${at(payment.decidedAt)}` : ''}
                          {payment.decisionNote ? (
                            <>
                              . <bdi>{payment.decisionNote}</bdi>
                            </>
                          ) : null}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}
