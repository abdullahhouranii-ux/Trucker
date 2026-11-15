import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import type { AcceptancePreview, Booking } from '../server/api.ts';

// A booking as both parties see it: the same figures for the shipper and the carrier. Amounts
// arrive as exact decimal text and are shown as they are; nothing here calculates money.

type B = Messages['book'];

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

/** The price, the fee and what each side pays or receives. */
export function MoneyFacts({
  t,
  currency,
  transportAmount,
  fee,
  shipperTotal,
  carrierNet,
}: {
  t: B;
  currency: string;
  transportAmount: string;
  fee: Booking['fee'];
  shipperTotal: string;
  carrierNet?: string;
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
        <div>
          <dt>{t.fee.replace('{percent}', percent(fee.basisPoints))}</dt>
          <dd data-money="fee">
            <Money amount={fee.amount} currency={currency} />, {t.feePayer[fee.payer]}
          </dd>
        </div>
        <div>
          <dt>{t.shipperTotal}</dt>
          <dd data-money="total">
            <Money amount={shipperTotal} currency={currency} />
          </dd>
        </div>
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

export function BookingCard({ t, locale, booking }: { t: B; locale: Locale; booking: Booking }) {
  const name = (party: Booking['shipper']): string => party.tradingName ?? party.legalName;
  return (
    <div className="card" data-booking={booking.id} data-status={booking.status}>
      <p className="chip">{t.status[booking.status]}</p>
      <p className="notice" role="note">
        {t.statusNote}
      </p>
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
      />
      <ul className="evidence">
        {booking.inclusions.map((item) => (
          <li key={item.code} data-included={item.included ? 'yes' : 'no'}>
            <bdi>{item.name[locale]}</bdi>: {item.included ? '✓' : '✗'}
          </li>
        ))}
      </ul>
      <p>{t.payment.replace('{n}', String(booking.paymentDueDays))}</p>
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
            <br />
            {t.plannedNote}
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
      <p>{t.payment.replace('{n}', String(preview.paymentDueDays ?? 0))}</p>
      {preview.assignmentDueAt ? (
        <p>
          {t.assignmentDue}: <InstantText at={preview.assignmentDueAt} />
        </p>
      ) : null}
      <p className="field-hint">{t.provisional}</p>
    </div>
  );
}
