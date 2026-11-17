import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../web/src/components/form.tsx';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import {
  decideRefundAction,
  reconcileAction,
  refundOutcomeAction,
  requestRefundAction,
  submitRefundAction,
} from '../../server/actions.ts';
import { requireStaff } from '../../server/session.ts';

// Refunds of Trucker's fee and reconciliation (db/migrations/0026). Money owed back is requested
// by one administrator and approved by another, then submitted: to the payment provider, or as a
// bank transfer that a different administrator confirms from Trucker's bank statement. A request
// may be for part of what is owed; requests never add up to more than the payment. Reconciliation
// is recorded by someone who had no hand in the payment or the refund; a correction replaces an
// entry and the replaced entry stays. Nothing here moves money: there is no real provider and
// bank transfers are made outside Trucker. Times are in UTC.

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

interface Person {
  id: string;
  displayName: string;
}
type Reason = 'booking_ended' | 'duplicate_payment' | 'cancelled_after_payment';
interface Owed {
  id: string;
  bookingId: string;
  reason: Reason;
  amount: string;
  currency: string;
  refunded: string;
  inProgress: string;
  remaining: string;
  recordedAt: string;
  method: 'bank_transfer' | 'online';
  reference: string;
}
interface HistoryItem {
  event: string;
  at: string;
  by: Person | null;
  detail: Record<string, unknown>;
}
interface RefundRequest {
  id: string;
  version: number;
  method: 'provider' | 'bank_transfer';
  amount: string;
  currency: string;
  status: 'requested' | 'approved' | 'submitted' | 'completed' | 'failed' | 'withdrawn';
  note: string;
  reference: string;
  requestedBy: Person;
  approvedBy: Person | null;
  submittedBy: Person | null;
  completedBy: Person | null;
  bankReference: string | null;
  providerRefundReference: string | null;
  failureReason: string | null;
  withdrawalNote: string | null;
  reconciliation: { outcome: 'matched' | 'discrepancy'; at: string } | null;
  history: HistoryItem[];
}
interface Payment {
  id: string;
  method: 'bank_transfer' | 'online';
  amount: string;
  currency: string;
  valueDate: string;
  statementReference: string;
  reference: string;
  recordedBy: Person | null;
  decidedBy: Person | null;
  decidedAt: string | null;
}
interface Entry {
  id: string;
  subjectType: 'payment' | 'refund';
  subjectId: string;
  source: 'bank_statement' | 'provider_report';
  sourceReference: string;
  amount: string;
  currency: string;
  expectedAmount: string;
  reference: string | null;
  outcome: 'matched' | 'discrepancy';
  note: string | null;
  supersedes: string | null;
  reconciledBy: Person;
  reconciledAt: string;
}
interface Overview {
  staffId: string;
  owed: Owed[];
  open: RefundRequest[];
  ended: RefundRequest[];
  toReconcile: { payments: Payment[]; refunds: RefundRequest[] };
  discrepancies: Entry[];
}

const DONE: Record<string, string> = {
  requested:
    'The refund was requested. It changes nothing until a different administrator approves it.',
  already_requested: 'This refund was already requested. Nothing more was made.',
  approved: 'The refund was approved. It can now be submitted.',
  withdrawn:
    'The request was withdrawn. It stays on record, and the amount can be requested again.',
  submitted_submitted:
    'The transfer was recorded as sent. A different administrator confirms it from the bank statement.',
  submitted_pending:
    'The provider received the refund and has not finished it. Its answer is checked again.',
  submitted_completed: 'The provider reported the refund as completed.',
  submitted_failed:
    'The provider refused the refund. Nothing was returned, and the amount can be requested again.',
  submitted_repeated: 'The provider had already answered. Nothing changed.',
  submitted_contradicted:
    'The provider now reports something different from its earlier answer. It was recorded and not applied. Look into it.',
  completed: 'The refund is confirmed on the bank statement.',
  failed: 'The refund was recorded as failed. The amount can be requested again.',
  reconciled_matched: 'Recorded: the statement or report matches.',
  reconciled_discrepancy:
    'Recorded as a discrepancy. It stays listed until a correction replaces it.',
  already_recorded: 'This was already recorded. Nothing more was made.',
};
const ERRORS: Record<string, string> = {
  staff_privilege_required: 'Your account does not hold the privilege this needs.',
  different_person_required:
    'This step is taken by a different administrator from the one who took the step before.',
  independent_person_required:
    'You had a hand in this payment or refund. Someone who did not records its reconciliation.',
  refund_not_open: 'This refund is no longer open for that. The lists show the present state.',
  record_changed: 'The refund changed since the page was loaded. Nothing was changed.',
  retry_key_conflict: 'This form was used for something different. Reload the page.',
  already_reconciled:
    'This is already reconciled. To correct it, record a correction that names the entry.',
  refund_unconfirmed:
    'It is not confirmed that the provider received the refund. It stays submitted. Ask the provider again: Trucker sends the same refund identifier.',
  online_payment_unavailable:
    'Online payment is not available here, so the provider cannot be asked.',
  not_found: 'That was not found.',
  unconfirmed:
    'It was not confirmed that this was done. It may have been. The lists show the present state. Trying again changes nothing twice.',
  refused: 'That was refused.',
};
// Field problems, by the form they belong to: the id of each field is the name plus the item.
const FIELDS: Record<string, [string, string]> = {
  'refundId:unknown': ['amount', 'That refund was not found. Reload the page.'],
  'amount:invalid': [
    'amount',
    'Amount: a positive amount with no more decimals than the currency.',
  ],
  'amount:exceeds_owed': [
    'amount',
    'Amount: more than is left to return. Requests never add up to more than the payment.',
  ],
  'method:invalid': ['method', 'How: choose the provider or a bank transfer.'],
  'method:not_online': [
    'method',
    'How: this payment was not made online, so the provider cannot return it.',
  ],
  'note:required': ['note', 'Reason: say why this is returned.'],
  'subjectId:unknown': ['amount', 'That was not found. Reload the page.'],
  'source:invalid': ['source', 'Source: the bank statement or the provider’s report.'],
  'sourceReference:required': ['sourceReference', 'Line or report reference: where this is shown.'],
  'currency:invalid': ['currency', 'Currency: the three-letter code.'],
  'note:invalid': ['note', 'Note: at most 1000 characters.'],
  'supersedes:invalid': ['note', 'That entry cannot be corrected. Reload the page.'],
};
const REASON: Record<Reason, string> = {
  booking_ended: 'The booking had ended when this money was verified',
  duplicate_payment: 'Paid twice',
  cancelled_after_payment: 'The booking was cancelled after payment',
};
const STATUS: Record<RefundRequest['status'], string> = {
  requested: 'Requested: waiting for a second administrator',
  approved: 'Approved: to be submitted',
  submitted: 'Submitted',
  completed: 'Completed',
  failed: 'Failed',
  withdrawn: 'Withdrawn',
};
const EVENT: Record<string, string> = {
  requested: 'Requested',
  approved: 'Approved',
  withdrawn: 'Withdrawn',
  submitted: 'Submitted',
  resubmitted: 'Provider asked again',
  provider_answered: 'Provider answered',
  completed: 'Completed',
  failed: 'Failed',
};
const at = (iso: string): string => utc(new Date(iso).toISOString());

function RequestFacts({ request }: { request: RefundRequest }) {
  return (
    <>
      <ul className="evidence">
        <li>
          Reference: <bdi dir="ltr">{request.reference}</bdi>
        </li>
        <li>
          Amount:{' '}
          <bdi dir="ltr">
            {request.amount} {request.currency}
          </bdi>
          , {request.method === 'provider' ? 'through the payment provider' : 'by bank transfer'}
        </li>
        <li data-refund-status={request.status}>{STATUS[request.status]}</li>
        <li>
          Reason: <bdi>{request.note}</bdi>
        </li>
        {request.bankReference ? (
          <li>
            Transfer reference: <bdi dir="ltr">{request.bankReference}</bdi>
          </li>
        ) : null}
        {request.providerRefundReference ? (
          <li>
            Provider refund reference: <bdi dir="ltr">{request.providerRefundReference}</bdi>
          </li>
        ) : null}
        {request.failureReason ? (
          <li>
            Why it failed: <bdi>{request.failureReason}</bdi>
          </li>
        ) : null}
        {request.withdrawalNote ? (
          <li>
            Why it was withdrawn: <bdi>{request.withdrawalNote}</bdi>
          </li>
        ) : null}
        {request.reconciliation ? (
          <li>
            Reconciled: {request.reconciliation.outcome === 'matched' ? 'matches' : 'discrepancy'}{' '}
            at {at(request.reconciliation.at)}
          </li>
        ) : null}
      </ul>
      <details>
        <summary>History</summary>
        <ol className="evidence" data-refund-history>
          {request.history.map((item, index) => (
            <li key={index} data-event={item.event}>
              {EVENT[item.event] ?? item.event} at {at(item.at)}
              {item.by ? (
                <>
                  {' '}
                  by <bdi>{item.by.displayName}</bdi>
                </>
              ) : (
                ' (from the provider)'
              )}
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}

function WithdrawForm({ request }: { request: RefundRequest }) {
  return (
    <form className="form" action={decideRefundAction}>
      <input type="hidden" name="refundRequestId" value={request.id} />
      <input type="hidden" name="version" value={request.version} />
      <input type="hidden" name="decision" value="withdraw" />
      <div className="field">
        <label htmlFor={`withdraw-note-${request.id}`}>Why it is withdrawn</label>
        <textarea id={`withdraw-note-${request.id}`} name="note" rows={2} maxLength={1000} />
      </div>
      <button
        className="button button-danger"
        type="submit"
        aria-describedby={`request-${request.id}-ref`}
      >
        Withdraw the request
      </button>
    </form>
  );
}

function ReconcileForm({
  subjectType,
  subjectId,
  retry,
  supersedes,
}: {
  subjectType: 'payment' | 'refund';
  subjectId: string;
  retry: string;
  supersedes?: string;
}) {
  const id = (name: string): string => `${name}-${subjectId}`;
  return (
    <form className="form" action={reconcileAction}>
      <input type="hidden" name="retryKey" value={retry} />
      <input type="hidden" name="subjectType" value={subjectType} />
      <input type="hidden" name="subjectId" value={subjectId} />
      {supersedes ? <input type="hidden" name="supersedes" value={supersedes} /> : null}
      <fieldset className="choice" id={id('source')}>
        <legend>Where it is shown</legend>
        <label>
          <input type="radio" name="source" value="bank_statement" defaultChecked /> Trucker&apos;s
          bank statement
        </label>
        <label>
          <input type="radio" name="source" value="provider_report" /> The provider&apos;s report
        </label>
      </fieldset>
      <div className="field">
        <label htmlFor={id('sourceReference')}>Line or report reference</label>
        <input
          id={id('sourceReference')}
          name="sourceReference"
          type="text"
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="field">
        <label htmlFor={id('amount')}>Amount shown</label>
        <input
          id={id('amount')}
          name="amount"
          type="text"
          inputMode="decimal"
          maxLength={20}
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label htmlFor={id('currency')}>Currency shown</label>
        <input
          id={id('currency')}
          name="currency"
          type="text"
          maxLength={3}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="field">
        <label htmlFor={id('note')}>
          {supersedes ? 'What the correction corrects' : 'Note (needed when it does not match)'}
        </label>
        <textarea id={id('note')} name="note" rows={2} maxLength={1000} />
      </div>
      <button className="button button-primary" type="submit">
        {supersedes ? 'Record the correction' : 'Record the reconciliation'}
      </button>
    </form>
  );
}

export default async function RefundsPage({ searchParams }: Props) {
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/refunds" />
        </main>
      </>
    );
  }
  const search = await searchParams;
  const one = (name: string): string =>
    typeof search[name] === 'string' ? (search[name] as string) : '';
  const reply = await api<{ refunds: Overview }>('GET', '/staff/refunds', { token: found.token });
  if (!reply.ok && reply.status === 401) redirect('/sign-in?error=session_ended');
  const done = DONE[one('done')];
  const error = one('error');
  const uuid = /^[0-9a-f-]{36}$/;
  const item = uuid.test(one('owed'))
    ? one('owed')
    : uuid.test(one('subject'))
      ? one('subject')
      : '';
  const request = uuid.test(one('request')) ? one('request') : '';
  const problems =
    error === 'validation_failed'
      ? one('fields')
          .split(',')
          .filter((code) => code !== '')
          .map((code) => {
            const entry = FIELDS[code];
            return entry
              ? { field: item ? `${entry[0]}-${item}` : undefined, message: entry[1] }
              : { message: ERRORS.refused! };
          })
      : error === 'withdraw_note' && request
        ? [{ field: `withdraw-note-${request}`, message: 'Say why the request is withdrawn.' }]
        : error === 'bank_reference' && request
          ? [
              {
                field: `bank-reference-${request}`,
                message: 'Transfer reference: the reference of the transfer you made.',
              },
            ]
          : error === 'statement_line' && request
            ? [
                {
                  field: `statement-line-${request}`,
                  message:
                    'Statement line: the line on Trucker’s bank statement that shows the transfer left.',
                },
              ]
            : error === 'failure_note' && request
              ? [{ field: `failure-note-${request}`, message: 'Say why the transfer failed.' }]
              : error !== ''
                ? [{ message: ERRORS[error] ?? ERRORS.refused! }]
                : [];
  const retry = /^[A-Za-z0-9._-]{16,128}$/.test(one('retry')) ? one('retry') : randomUUID();
  const me = reply.ok ? reply.data.refunds.staffId : '';
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/refunds" />
      <main id="main" tabIndex={-1}>
        <div className="page" data-state="refunds">
          <h1>Refunds</h1>
          <p>
            Money owed back is requested by one administrator and approved by another, then
            submitted. A bank transfer is made outside Trucker and confirmed from Trucker&apos;s
            bank statement by a different administrator. Requests never add up to more than the
            payment. Reconciliation is recorded by someone who had no hand in the payment or the
            refund. Times are in UTC.
          </p>
          <p className="notice" id="refunds-limitation">
            Development only: there is no real payment provider, and no money moves.
          </p>
          <ErrorSummary title="This was not done" problems={problems} />
          {done && problems.length === 0 ? (
            <p className="notice notice-success" role="status" id="refunds-done">
              {done}
            </p>
          ) : null}
          {!reply.ok ? (
            <div className="notice notice-error" role="alert" id="refunds-unavailable">
              {reply.status === 403
                ? 'Your account does not hold the privilege this needs. The attempt was recorded.'
                : 'This could not be read. Reload the page.'}
            </div>
          ) : (
            <>
              <section className="section" aria-labelledby="owed-title">
                <h2 id="owed-title">Money to return</h2>
                {reply.data.refunds.owed.length === 0 ? (
                  <p id="owed-empty">Nothing is left to request.</p>
                ) : (
                  <ol className="organisation-list" id="owed-list">
                    {reply.data.refunds.owed.map((owed) => (
                      <li className="card" key={owed.id} data-owed={owed.id}>
                        <ul className="evidence">
                          <li>
                            Reference: <bdi dir="ltr">{owed.reference}</bdi>
                          </li>
                          <li>
                            Owed:{' '}
                            <bdi dir="ltr">
                              {owed.amount} {owed.currency}
                            </bdi>
                            . Returned{' '}
                            <bdi dir="ltr">
                              {owed.refunded} {owed.currency}
                            </bdi>
                            , in progress{' '}
                            <bdi dir="ltr">
                              {owed.inProgress} {owed.currency}
                            </bdi>
                            , left{' '}
                            <bdi dir="ltr" data-remaining>
                              {owed.remaining} {owed.currency}
                            </bdi>
                          </li>
                          <li>{REASON[owed.reason]}</li>
                          <li>
                            Paid {owed.method === 'online' ? 'online' : 'by bank transfer'}; owed
                            since {at(owed.recordedAt)}
                          </li>
                        </ul>
                        <form className="form" action={requestRefundAction}>
                          <input
                            type="hidden"
                            name="retryKey"
                            value={item === owed.id ? retry : randomUUID()}
                          />
                          <input type="hidden" name="refundId" value={owed.id} />
                          <div className="field">
                            <label htmlFor={`amount-${owed.id}`}>Amount to return</label>
                            <p className="field-hint" id={`amount-${owed.id}-hint`}>
                              All that is left, or part of it.
                            </p>
                            <input
                              id={`amount-${owed.id}`}
                              name="amount"
                              type="text"
                              inputMode="decimal"
                              maxLength={20}
                              autoComplete="off"
                              defaultValue={owed.remaining}
                              aria-describedby={`amount-${owed.id}-hint`}
                            />
                          </div>
                          <fieldset className="choice" id={`method-${owed.id}`}>
                            <legend>How</legend>
                            {owed.method === 'online' ? (
                              <label>
                                <input type="radio" name="method" value="provider" defaultChecked />{' '}
                                Back through the payment provider
                              </label>
                            ) : null}
                            <label>
                              <input
                                type="radio"
                                name="method"
                                value="bank_transfer"
                                defaultChecked={owed.method !== 'online'}
                              />{' '}
                              A bank transfer made by staff
                            </label>
                          </fieldset>
                          <div className="field">
                            <label htmlFor={`note-${owed.id}`}>Reason</label>
                            <textarea
                              id={`note-${owed.id}`}
                              name="note"
                              rows={2}
                              maxLength={1000}
                            />
                          </div>
                          <button className="button button-primary" type="submit">
                            Request the refund
                          </button>
                        </form>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="section" aria-labelledby="open-title">
                <h2 id="open-title">Refunds in progress</h2>
                {reply.data.refunds.open.length === 0 ? (
                  <p id="open-empty">No refund is in progress.</p>
                ) : (
                  <ol className="organisation-list" id="open-list">
                    {reply.data.refunds.open.map((item) => (
                      <li className="card" key={item.id} data-refund-request={item.id}>
                        <span className="visually-hidden" id={`request-${item.id}-ref`}>
                          {item.reference} {item.amount} {item.currency}
                        </span>
                        <RequestFacts request={item} />
                        {item.status === 'requested' ? (
                          item.requestedBy.id === me ? (
                            <p className="field-hint" data-own-request>
                              You asked for this refund. A different administrator approves it.
                            </p>
                          ) : (
                            <form action={decideRefundAction}>
                              <input type="hidden" name="refundRequestId" value={item.id} />
                              <input type="hidden" name="version" value={item.version} />
                              <input type="hidden" name="decision" value="approve" />
                              <button
                                className="button button-primary"
                                type="submit"
                                aria-describedby={`request-${item.id}-ref`}
                              >
                                Approve the refund
                              </button>
                            </form>
                          )
                        ) : null}
                        {item.status === 'approved' ? (
                          <form className="form" action={submitRefundAction}>
                            <input type="hidden" name="refundRequestId" value={item.id} />
                            <input type="hidden" name="version" value={item.version} />
                            {item.method === 'bank_transfer' ? (
                              <div className="field">
                                <label htmlFor={`bank-reference-${item.id}`}>
                                  Reference of the transfer you made
                                </label>
                                <p className="field-hint" id={`bank-reference-${item.id}-hint`}>
                                  Make the transfer in the bank first. Record it here once it is
                                  sent.
                                </p>
                                <input
                                  id={`bank-reference-${item.id}`}
                                  name="bankReference"
                                  type="text"
                                  maxLength={100}
                                  autoComplete="off"
                                  spellCheck={false}
                                  aria-describedby={`bank-reference-${item.id}-hint`}
                                />
                              </div>
                            ) : null}
                            <button
                              className="button button-primary"
                              type="submit"
                              aria-describedby={`request-${item.id}-ref`}
                            >
                              {item.method === 'provider'
                                ? 'Send to the provider'
                                : 'Record the transfer as sent'}
                            </button>
                          </form>
                        ) : null}
                        {item.status === 'submitted' && item.method === 'provider' ? (
                          <form action={submitRefundAction}>
                            <input type="hidden" name="refundRequestId" value={item.id} />
                            <input type="hidden" name="version" value={item.version} />
                            <p className="field-hint">
                              Waiting for the provider. Asking again sends the same refund
                              identifier.
                            </p>
                            <button
                              className="button"
                              type="submit"
                              aria-describedby={`request-${item.id}-ref`}
                            >
                              Ask the provider again
                            </button>
                          </form>
                        ) : null}
                        {item.status === 'submitted' && item.method === 'bank_transfer' ? (
                          item.submittedBy?.id === me ? (
                            <p className="field-hint" data-own-submission>
                              You sent this transfer. A different administrator confirms it from the
                              bank statement.
                            </p>
                          ) : (
                            <>
                              <form className="form" action={refundOutcomeAction}>
                                <input type="hidden" name="refundRequestId" value={item.id} />
                                <input type="hidden" name="version" value={item.version} />
                                <input type="hidden" name="outcome" value="completed" />
                                <div className="field">
                                  <label htmlFor={`statement-line-${item.id}`}>
                                    Statement line showing the transfer left
                                  </label>
                                  <input
                                    id={`statement-line-${item.id}`}
                                    name="statementReference"
                                    type="text"
                                    maxLength={100}
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </div>
                                <button
                                  className="button button-primary"
                                  type="submit"
                                  aria-describedby={`request-${item.id}-ref`}
                                >
                                  Confirm the refund
                                </button>
                              </form>
                              <form className="form" action={refundOutcomeAction}>
                                <input type="hidden" name="refundRequestId" value={item.id} />
                                <input type="hidden" name="version" value={item.version} />
                                <input type="hidden" name="outcome" value="failed" />
                                <div className="field">
                                  <label htmlFor={`failure-note-${item.id}`}>
                                    Why the transfer failed
                                  </label>
                                  <textarea
                                    id={`failure-note-${item.id}`}
                                    name="note"
                                    rows={2}
                                    maxLength={1000}
                                  />
                                </div>
                                <button
                                  className="button button-danger"
                                  type="submit"
                                  aria-describedby={`request-${item.id}-ref`}
                                >
                                  Record it as failed
                                </button>
                              </form>
                            </>
                          )
                        ) : null}
                        {item.status === 'requested' || item.status === 'approved' ? (
                          <WithdrawForm request={item} />
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="section" aria-labelledby="reconcile-title">
                <h2 id="reconcile-title">To reconcile</h2>
                <p>
                  Approved payments and completed refunds, against Trucker&apos;s bank statement or
                  the provider&apos;s report. It matches when the amount and currency agree;
                  otherwise it is a discrepancy, with a note.
                </p>
                {reply.data.refunds.toReconcile.payments.length === 0 &&
                reply.data.refunds.toReconcile.refunds.length === 0 ? (
                  <p id="reconcile-empty">Nothing is waiting.</p>
                ) : (
                  <ol className="organisation-list" id="reconcile-list">
                    {reply.data.refunds.toReconcile.payments.map((payment) => {
                      const involved = [payment.recordedBy?.id, payment.decidedBy?.id].includes(me);
                      return (
                        <li className="card" key={payment.id} data-reconcile-payment={payment.id}>
                          <ul className="evidence">
                            <li>
                              Payment: <bdi dir="ltr">{payment.reference}</bdi>,{' '}
                              {payment.method === 'online' ? 'online' : 'bank transfer'}
                            </li>
                            <li>
                              Amount:{' '}
                              <bdi dir="ltr">
                                {payment.amount} {payment.currency}
                              </bdi>
                              , value date {payment.valueDate}
                            </li>
                            <li>
                              Recorded line: <bdi dir="ltr">{payment.statementReference}</bdi>
                            </li>
                          </ul>
                          {involved ? (
                            <p className="field-hint" data-not-independent>
                              You had a hand in this payment. Someone who did not reconciles it.
                            </p>
                          ) : (
                            <ReconcileForm
                              subjectType="payment"
                              subjectId={payment.id}
                              retry={item === payment.id ? retry : randomUUID()}
                            />
                          )}
                        </li>
                      );
                    })}
                    {reply.data.refunds.toReconcile.refunds.map((refund) => {
                      const involved = [
                        refund.requestedBy.id,
                        refund.approvedBy?.id,
                        refund.submittedBy?.id,
                        refund.completedBy?.id,
                      ].includes(me);
                      return (
                        <li className="card" key={refund.id} data-reconcile-refund={refund.id}>
                          <span className="visually-hidden" id={`request-${refund.id}-ref`}>
                            {refund.reference}
                          </span>
                          <RequestFacts request={refund} />
                          {involved ? (
                            <p className="field-hint" data-not-independent>
                              You had a hand in this refund. Someone who did not reconciles it.
                            </p>
                          ) : (
                            <ReconcileForm
                              subjectType="refund"
                              subjectId={refund.id}
                              retry={item === refund.id ? retry : randomUUID()}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>

              <section className="section" aria-labelledby="discrepancies-title">
                <h2 id="discrepancies-title">Discrepancies</h2>
                <p>A correction replaces an entry. The replaced entry stays on record.</p>
                {reply.data.refunds.discrepancies.length === 0 ? (
                  <p id="discrepancies-empty">No discrepancy is open.</p>
                ) : (
                  <ol className="organisation-list" id="discrepancy-list">
                    {reply.data.refunds.discrepancies.map((entry) => (
                      <li className="card" key={entry.id} data-discrepancy={entry.id}>
                        <ul className="evidence">
                          <li>
                            {entry.subjectType === 'payment' ? 'Payment' : 'Refund'}:{' '}
                            <bdi dir="ltr">{entry.reference ?? ''}</bdi>
                          </li>
                          <li>
                            Expected <bdi dir="ltr">{entry.expectedAmount}</bdi>; shown{' '}
                            <bdi dir="ltr">
                              {entry.amount} {entry.currency}
                            </bdi>{' '}
                            on{' '}
                            {entry.source === 'bank_statement'
                              ? 'the bank statement'
                              : 'the provider’s report'}
                            , <bdi dir="ltr">{entry.sourceReference}</bdi>
                          </li>
                          <li>
                            Note: <bdi>{entry.note}</bdi>
                          </li>
                          <li>
                            Recorded by <bdi>{entry.reconciledBy.displayName}</bdi> at{' '}
                            {at(entry.reconciledAt)}
                            {entry.supersedes ? ', correcting an earlier entry' : ''}
                          </li>
                        </ul>
                        <ReconcileForm
                          subjectType={entry.subjectType}
                          subjectId={entry.subjectId}
                          supersedes={entry.id}
                          retry={item === entry.subjectId ? retry : randomUUID()}
                        />
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="section" aria-labelledby="ended-title">
                <h2 id="ended-title">Ended recently</h2>
                {reply.data.refunds.ended.length === 0 ? (
                  <p id="ended-empty">No refund has ended yet.</p>
                ) : (
                  <ol className="organisation-list" id="ended-list">
                    {reply.data.refunds.ended.map((item) => (
                      <li className="card" key={item.id} data-refund-request={item.id}>
                        <RequestFacts request={item} />
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
