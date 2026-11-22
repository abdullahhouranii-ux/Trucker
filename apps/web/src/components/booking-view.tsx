import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import type {
  AcceptancePreview,
  Booking,
  BookingPrice,
  BookingTerms,
  FeePayment,
} from '../server/api.ts';

// A booking as both parties see it: the same figures for the shipper and the carrier. Amounts
// arrive as exact decimal text and are shown as they are; nothing here calculates money.

type B = Messages['book'];
type A = Messages['asg'];

/** An instant, written in UTC. */
export function InstantText({ at }: { at: string }) {
  const text = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  return (
    <bdi dir="ltr">
      <time dateTime={at}>{text} UTC</time>
    </bdi>
  );
}
const percent = (basisPoints: number): string => String(basisPoints / 100);
const Money = ({ amount, currency }: { amount: string; currency: string }) => (
  <bdi dir="ltr">
    {amount} {currency}
  </bdi>
);

/**
 * The price, and of the fee, the commission and the totals what the database gave this role
 * (D-11): the shipper sees its fee and total, the carrier the commission and its net.
 */
export function MoneyFacts({
  t,
  currency,
  transportAmount,
  fee,
  shipperTotal,
  carrierNet,
  commission,
}: {
  t: B;
  currency: string;
  transportAmount: string;
  fee?: Booking['fee'];
  shipperTotal?: string;
  carrierNet?: string;
  commission?: BookingPrice['commission'];
}) {
  return (
    <>
      <dl className="facts">
        <div>
          <dt>{t.transport}</dt>
          <dd data-money="transport">
            <Money amount={transportAmount} currency={currency} />
          </dd>
        </div>
        {fee ? (
          <div>
            <dt>{t.fee.replace('{percent}', percent(fee.basisPoints))}</dt>
            <dd data-money="fee">
              <Money amount={fee.amount} currency={currency} />, {t.feePayer[fee.payer]}
            </dd>
          </div>
        ) : null}
        {shipperTotal ? (
          <div>
            <dt>{t.shipperTotal}</dt>
            <dd data-money="total">
              <Money amount={shipperTotal} currency={currency} />
            </dd>
          </div>
        ) : null}
        {commission ? (
          <div>
            <dt>{t.commissionLine}</dt>
            <dd data-money="commission">
              <Money amount={commission.amount} currency={currency} />
            </dd>
          </div>
        ) : null}
        {carrierNet ? (
          <div>
            <dt>{t.carrierNet}</dt>
            <dd data-money="net">
              <Money amount={carrierNet} currency={currency} />
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="field-hint">{t.taxNote}</p>
    </>
  );
}

/** How and when the freight is paid to the carrier, as fixed on the booking. */
export function FreightLine({
  t,
  freight,
  dueDays,
}: {
  t: B;
  freight: BookingPrice['freight'];
  dueDays: number | null;
}) {
  if (!freight.method)
    return <p data-freight="none">{t.payment.replace('{n}', String(dueDays ?? 0))}</p>;
  return (
    <p data-freight={freight.method}>
      {freight.method === 'cash_on_delivery'
        ? t.paymentCod
        : t.paymentAfterProof
            .replace('{method}', t.freightMethod[freight.method])
            .replace('{n}', String(freight.dueDays ?? 0))}
      {freight.payer ? ` ${t.freightPayer[freight.payer]}` : ''}
    </p>
  );
}

/**
 * Trucker's fee. The payer is shown what to pay, the reference to quote and the deadline; the
 * other parties see only whether it is settled. A slip or a message is not proof: staff check
 * the money on Trucker's bank statement. Nothing is shown when no fee is due.
 */
export function FeePaymentFacts({ t, fee }: { t: B; fee: FeePayment | null | undefined }) {
  if (!fee || fee.status === 'not_required') return null;
  const f = t.feePayment;
  const open = fee.status === 'due' || fee.status === 'overdue';
  return (
    <div className="fee-payment" data-fee-status={fee.status}>
      <p>
        <strong>{f.title}</strong>: <span data-fee-state>{f.status[fee.status]}</span>
      </p>
      <dl className="facts">
        {fee.amount && fee.currency ? (
          <div>
            <dt>{f.amount}</dt>
            <dd data-fee-amount>
              <Money amount={fee.amount} currency={fee.currency} />
            </dd>
          </div>
        ) : null}
        {fee.reference ? (
          <div>
            <dt>{f.reference}</dt>
            <dd>
              <bdi dir="ltr" data-fee-reference>
                {fee.reference}
              </bdi>
            </dd>
          </div>
        ) : null}
        {open && fee.dueAt ? (
          <div>
            <dt>{f.dueBy}</dt>
            <dd data-fee-due>
              <InstantText at={fee.dueAt} />
            </dd>
          </div>
        ) : null}
        {fee.paidAt ? (
          <div>
            <dt>{f.paidAt}</dt>
            <dd>
              <InstantText at={fee.paidAt} />
            </dd>
          </div>
        ) : null}
      </dl>
      {open && fee.reference ? <p className="field-hint">{f.howToPay}</p> : null}
      {open && !fee.reference ? <p className="field-hint">{f.notPayer}</p> : null}
      {fee.verifying ? (
        <p className="notice" role="note" data-fee-verifying>
          {f.verifying}
        </p>
      ) : null}
      {fee.refunds && fee.refunds.length > 0 ? (
        <ul className="evidence" data-fee-refunds>
          {fee.refunds.map((refund) => (
            <li key={refund.id} data-refund={refund.reason}>
              {f.refund[refund.reason]}: <Money amount={refund.amount} currency={refund.currency} />{' '}
              ({f.refundPending})
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Which terms version applies. Only demonstration terms exist. */
function TermsLine({ t, terms }: { t: B; terms: BookingTerms }) {
  return (
    <p
      data-terms={`${terms.code}-${terms.version}`}
      data-demonstration={String(terms.demonstration)}
    >
      {t.terms.replace('{n}', String(terms.version))}
      <br />
      <span className="field-hint">{t.termsNote}</span>
    </p>
  );
}

/** What needs someone's attention on a booking, said plainly. Nothing here is automatic. */
export function BookingFlags({ a, booking }: { a: A; booking: Booking }) {
  const flags: [string, string][] = [];
  if (booking.overdue) flags.push(['overdue', a.overdue]);
  if (booking.needsReassignment) flags.push(['needs-reassignment', a.blockers.needs_reassignment]);
  if (booking.atRisk) flags.push(['at-risk', a.blockers.resource_overrunning]);
  if (flags.length === 0) return null;
  return (
    <ul className="evidence" data-flags={flags.map(([name]) => name).join(' ')}>
      {flags.map(([name, message]) => (
        <li key={name} data-flag={name}>
          {message}
        </li>
      ))}
    </ul>
  );
}

export function BookingCard({
  t,
  a,
  locale,
  booking,
  href,
}: {
  t: B;
  a: A;
  locale: Locale;
  booking: Booking;
  /** Where the booking can be opened, when the card is in a list. */
  href?: string;
}) {
  const name = (party: Booking['shipper']): string => party.tradingName ?? party.legalName;
  const confirmed = booking.status === 'confirmed';
  return (
    <div className="card" data-booking={booking.id} data-status={booking.status}>
      <p className="chip">{t.status[booking.status]}</p>
      <p className="notice" role="note">
        {booking.status === 'cancelled'
          ? t.cancelledNote
          : confirmed
            ? a.confirmedNote
            : booking.status === 'awaiting_fee'
              ? t.awaitingFeeNote
              : t.statusNote}
      </p>
      <BookingFlags a={a} booking={booking} />
      {booking.role ? <p className="field-hint">{t.asRole[booking.role]}</p> : null}
      <dl className="facts">
        <div>
          <dt>{t.shipper}</dt>
          <dd>
            <bdi>{name(booking.shipper)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t.carrier}</dt>
          <dd>
            <bdi>{name(booking.carrier)}</bdi>
          </dd>
        </div>
      </dl>
      <MoneyFacts
        t={t}
        currency={booking.currency}
        transportAmount={booking.transportAmount}
        fee={booking.fee}
        shipperTotal={booking.shipperTotal}
        carrierNet={booking.carrierNet}
        commission={booking.price.commission}
      />
      <FeePaymentFacts t={t} fee={booking.feePayment} />
      <ul className="evidence">
        {booking.inclusions.map((item) => (
          <li key={item.code} data-included={item.included ? 'yes' : 'no'}>
            <bdi>{item.name[locale]}</bdi>: {item.included ? '✓' : '✗'}
          </li>
        ))}
      </ul>
      {booking.status !== 'cancelled' ? (
        <FreightLine t={t} freight={booking.price.freight} dueDays={booking.paymentDueDays} />
      ) : null}
      <TermsLine t={t} terms={booking.terms} />
      <dl className="facts">
        <div>
          <dt>{t.assignmentDue}</dt>
          <dd data-assignment-due>
            <InstantText at={booking.assignment.dueAt} />
          </dd>
        </div>
        <div>
          <dt>{t.planned}</dt>
          <dd>
            <InstantText at={booking.plannedReservation.startAt} /> –{' '}
            <InstantText at={booking.plannedReservation.endAt} />
            {confirmed || booking.assignmentVersion === 0 ? (
              <>
                <br />
                {confirmed ? a.plannedReserved : t.plannedNote}
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t.acceptedAt}</dt>
          <dd>
            <InstantText at={booking.acceptedAt} />,{' '}
            {t.quotationVersion.replace('{n}', String(booking.quotationVersion))}
          </dd>
        </div>
      </dl>
      <p className="field-hint">{t.provisional}</p>
      {href ? (
        <p>
          <a className="button" href={href} data-open-booking={booking.id}>
            {a.open}
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** What accepting would fix, or why it cannot be accepted now. */
export function AcceptanceFacts({ t, preview }: { t: B; preview: AcceptancePreview }) {
  if (preview.state !== 'ok' || !preview.fee || !preview.currency)
    return (
      <p className="field-hint" data-acceptance={preview.state}>
        {t.cannotAccept[preview.state === 'ok' ? 'closed' : preview.state]}
      </p>
    );
  return (
    <div data-acceptance="ok">
      <h4>{t.acceptTitle}</h4>
      <MoneyFacts
        t={t}
        currency={preview.currency}
        transportAmount={preview.transportAmount ?? ''}
        fee={preview.fee}
        shipperTotal={preview.shipperTotal ?? ''}
      />
      {preview.freight ? (
        <div data-freight-offer={preview.freight.methods.join(' ')}>
          <p>{t.offeredTitle}</p>
          <ul>
            {preview.freight.methods.map((method) => (
              <li key={method}>
                {method === 'cash_on_delivery'
                  ? t.paymentCod
                  : t.paymentAfterProof
                      .replace('{method}', t.freightMethod[method])
                      .replace('{n}', String(preview.freight?.dueDays ?? 0))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.terms ? <TermsLine t={t} terms={preview.terms} /> : null}
      {preview.assignmentDueAt ? (
        <p>
          {t.assignmentDue}: <InstantText at={preview.assignmentDueAt} />
        </p>
      ) : null}
      <p className="field-hint">{t.provisional}</p>
    </div>
  );
}
