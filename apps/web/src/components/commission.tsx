import { fill } from '../i18n/format.ts';
import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import {
  api,
  type CommissionContract,
  type CommissionLine,
  type CommissionTerms,
  type CommissionView,
} from '../server/api.ts';
import { setShipmentCommissionAction } from '../server/authority-actions.ts';
import { FeePaymentFacts, PaymentNotice, PayOnline } from './booking-view.tsx';
import { Ltr } from './ltr.tsx';

type T = Messages['commission'];
type TC = Messages['contracts'];

/** Basis points as a percentage, without a rounding error: 750 is 7.5, 1000 is 10. */
export const percentText = (basisPoints: number): string =>
  `${Math.floor(basisPoints / 100)}${
    basisPoints % 100 === 0
      ? ''
      : `.${String(basisPoints % 100)
          .padStart(2, '0')
          .replace(/0$/, '')}`
  }`;

/** The commission as one phrase: "10% of the shipping price" or "100.00 XTS". */
export function CommissionPhrase({ t, terms }: { t: T; terms: CommissionTerms }) {
  if (terms.option === 'contract') return <>{t.isContract}</>;
  return terms.option === 'percentage' ? (
    <>{fill(t.isPercentage, { percent: percentText(terms.basisPoints ?? 0) })}</>
  ) : (
    <Ltr>
      {terms.amount} {terms.currency}
    </Ltr>
  );
}

/**
 * The organiser's commission on a shipment it arranges for a customer, on the shipment's own
 * page. Set while the shipment is a draft; fixed once it has been published. An account that
 * is the customer of the shipment is never shown this section: the API gives it nothing.
 */
export async function CommissionSection({
  locale,
  t,
  book,
  payment,
  organisationId,
  shipmentId,
  version,
  token,
  done,
  error,
}: {
  locale: Locale;
  t: T;
  /** For Trucker's fee, when the organiser pays it. */
  book: Messages['book'];
  /** Whether the fee can be paid online here, and what came back from the provider's page. */
  payment?: { online: boolean; returned: string; error: string };
  organisationId: string;
  shipmentId: string;
  version: number;
  token: string;
  done: string | undefined;
  error: string | undefined;
}) {
  const reply = await api<CommissionView>(
    'GET',
    `/organisations/${organisationId}/shipments/${shipmentId}/commission`,
    { token },
  );
  if (!reply.ok || !reply.data.arranged) return null;
  const { commission, editable, limits } = reply.data;
  // Options the settings in force offer, and the one already chosen, if any.
  const offered = (['none', 'percentage', 'fixed', 'contract'] as const).filter(
    (option) =>
      option === 'none' ||
      option === commission?.option ||
      (limits?.options ?? []).includes(option),
  );
  const errors = (error ?? '')
    .split(',')
    .filter((code) => code !== '')
    .map((code) => (t.errors as Record<string, string>)[code] ?? t.errors.invalid);
  return (
    <section className="section" aria-labelledby="commission-title" id="commission">
      <h2 id="commission-title">{t.title}</h2>
      {errors.length > 0 ? (
        <div className="notice notice-error" role="alert" id="commission-error">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : done ? (
        <p className="notice notice-success" role="status" id="commission-saved">
          {t.saved}
        </p>
      ) : null}
      <p id="commission-current" data-option={commission?.option ?? 'none'}>
        {commission ? <CommissionPhrase t={t} terms={commission} /> : t.none}
      </p>
      {reply.data.bookedPrice ? (
        <div className="card" id="booked-price">
          <h3>{t.bookedTitle}</h3>
          <p className="field-hint">{t.bookedLead}</p>
          <ul>
            <li data-money="transport">
              {t.bookedShipping}:{' '}
              <Ltr>
                {reply.data.bookedPrice.shippingPrice} {reply.data.bookedPrice.currency}
              </Ltr>
            </li>
            {reply.data.bookedPrice.commission ? (
              <li data-money="commission">
                {t.commissionLine}:{' '}
                <Ltr>
                  {reply.data.bookedPrice.commission.amount} {reply.data.bookedPrice.currency}
                </Ltr>
              </li>
            ) : null}
            <li data-money="net">
              {t.netCarrier}:{' '}
              <Ltr>
                {reply.data.bookedPrice.net} {reply.data.bookedPrice.currency}
              </Ltr>
            </li>
            {reply.data.bookedPrice.fee ? (
              <li data-money="fee">
                {t.feeYouPay}:{' '}
                <Ltr>
                  {reply.data.bookedPrice.fee.amount} {reply.data.bookedPrice.currency}
                </Ltr>
              </li>
            ) : null}
          </ul>
          <FeePaymentFacts t={book} fee={reply.data.feePayment} />
          {reply.data.feePayment?.bookingId && payment ? (
            <>
              <PaymentNotice
                t={book}
                fee={reply.data.feePayment}
                payment={payment.returned}
                payError={payment.error}
              />
              <PayOnline
                t={book}
                locale={locale}
                fee={reply.data.feePayment}
                online={payment.online}
                organisationId={organisationId}
                bookingId={reply.data.feePayment.bookingId}
                returnTo={`/${locale}/organisations/${organisationId}/shipments/${shipmentId}`}
              />
            </>
          ) : null}
        </div>
      ) : null}
      {editable ? (
        <form className="form card" id="commission-form" action={setShipmentCommissionAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="organisationId" value={organisationId} />
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <input type="hidden" name="version" value={version} />
          <p>{t.lead}</p>
          <div className="field">
            <label htmlFor="commissionOption">{t.option}</label>
            <select
              id="commissionOption"
              name="commissionOption"
              defaultValue={commission?.option ?? 'none'}
            >
              {offered.map((option) => (
                <option value={option} key={option}>
                  {t.options[option]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="commissionPercent">{t.percent}</label>
            <p className="field-hint" id="commissionPercent-hint">
              {fill(t.percentHint, { max: percentText(limits?.maxBasisPoints ?? 0) })}
            </p>
            <input
              id="commissionPercent"
              name="commissionPercent"
              type="text"
              inputMode="decimal"
              dir="ltr"
              maxLength={5}
              aria-describedby="commissionPercent-hint"
              defaultValue={
                commission?.option === 'percentage' ? percentText(commission.basisPoints ?? 0) : ''
              }
            />
          </div>
          <div className="field">
            <label htmlFor="commissionAmount">{t.amount}</label>
            <p className="field-hint" id="commissionAmount-hint">
              {t.amountHint}
            </p>
            <input
              id="commissionAmount"
              name="commissionAmount"
              type="text"
              inputMode="decimal"
              dir="ltr"
              maxLength={20}
              aria-describedby="commissionAmount-hint"
              defaultValue={commission?.option === 'fixed' ? (commission.amount ?? '') : ''}
            />
          </div>
          <div className="field">
            <label htmlFor="commissionCurrency">{t.currency}</label>
            <p className="field-hint" id="commissionCurrency-hint">
              {t.currencyHint}
            </p>
            <input
              id="commissionCurrency"
              name="commissionCurrency"
              type="text"
              dir="ltr"
              maxLength={3}
              aria-describedby="commissionCurrency-hint"
              defaultValue={commission?.option === 'fixed' ? (commission.currency ?? '') : ''}
            />
          </div>
          <button className="button button-primary" type="submit" id="save-commission">
            {t.save}
          </button>
        </form>
      ) : (
        <p className="field-hint">{t.fixed}</p>
      )}
    </section>
  );
}

/** The terms of one commission contract, as a list (a grid overflows inside a card at large text). */
export function ContractTerms({ t, tc, contract }: { t: T; tc: TC; contract: CommissionContract }) {
  return (
    <ul data-contract-terms={contract.id}>
      <li>
        {tc.commission}: <CommissionPhrase t={t} terms={contract} />
      </li>
      <li>
        {tc.earned}: {tc.earningConditions[contract.earningCondition]}
      </li>
      <li>
        {tc.settlementDays}: {fill(tc.days, { n: contract.settlementDays })}
      </li>
    </ul>
  );
}

/** What a carrier is told before it prices a shipment that carries a commission. */
export function CarrierCommissionNotice({
  t,
  terms,
  contract,
  contractsHref,
}: {
  t: T;
  terms: CommissionTerms;
  contract?: CommissionContract | null;
  contractsHref: string;
}) {
  if (terms.option === 'contract')
    return contract ? (
      <p className="notice" role="note" id="commission-terms" data-option="contract">
        {t.carrierContract} <CommissionPhrase t={t} terms={contract} />. {t.carrierNote}
      </p>
    ) : (
      <div className="notice notice-error" role="note" id="commission-terms" data-option="contract">
        <p>{t.carrierNoContract}</p>
        <a className="button" href={contractsHref} id="open-contracts">
          {t.openContracts}
        </a>
      </div>
    );
  return (
    <p className="notice" role="note" id="commission-terms" data-option={terms.option}>
      {t.carrierLead} <CommissionPhrase t={t} terms={terms} />. {t.carrierNote}
    </p>
  );
}

/**
 * The carrier's acceptance of the exact figures for the price it sent. Shown after the server
 * refused the quotation for want of it and named the figures; they travel back with the form.
 */
export function CommissionAcceptance({
  t,
  commission,
  net,
  currency,
}: {
  t: T;
  commission: string;
  net: string;
  currency: string;
}) {
  return (
    <div className="check" id="commission-acceptance">
      <input type="hidden" name="commissionFigure" value={commission} />
      <input type="hidden" name="netFigure" value={net} />
      <input
        id="commissionAccept"
        name="commissionAccept"
        type="checkbox"
        aria-describedby="commissionAccept-hint"
      />
      <label htmlFor="commissionAccept">{fill(t.accept, { commission, net, currency })}</label>
      <p className="field-hint" id="commissionAccept-hint">
        {t.acceptHint}
      </p>
    </div>
  );
}

/** The commission and the net of the carrier's own quotation, beside its price. */
export function CommissionFacts({ t, line }: { t: T; line: CommissionLine }) {
  return (
    <dl className="facts" id="own-quotation-commission">
      <div>
        <dt>{t.commissionLine}</dt>
        <dd data-commission={line.commission}>
          <Ltr>
            {line.commission} {line.currency}
          </Ltr>
        </dd>
      </div>
      <div>
        <dt>{t.netLine}</dt>
        <dd data-net={line.net}>
          <Ltr>
            {line.net} {line.currency}
          </Ltr>
        </dd>
      </div>
    </dl>
  );
}
