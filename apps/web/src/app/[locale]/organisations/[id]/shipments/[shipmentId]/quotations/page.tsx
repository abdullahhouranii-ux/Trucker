import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../../../../components/form.tsx';
import {
  QuotationFacts,
  Standing,
  quotationProblems,
} from '../../../../../../../components/quotation-view.tsx';
import { isLocale } from '../../../../../../../i18n/config.ts';
import { getMessages } from '../../../../../../../i18n/messages.ts';
import { api, type Quotation, type ShipmentQuotations } from '../../../../../../../server/api.ts';
import {
  rejectQuotationAction,
  setQuotationTermsAction,
} from '../../../../../../../server/quotation-actions.ts';
import { requirePerson } from '../../../../../../../server/session.ts';

// The quotations on one of the organisation's shipments: the currency and inclusions they all
// use, and each carrier's current quotation side by side. The shipper may reject one. Nothing
// is accepted or booked in this version.

type Props = {
  params: Promise<{ locale: string; id: string; shipmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;

/** Exact order of two amounts written with the same minor units: no binary number involved. */
const cents = (amount: string): bigint => BigInt(amount.replace('.', ''));
const order = (a: Quotation, b: Quotation): number => {
  const openA = a.status === 'submitted' ? 0 : 1;
  const openB = b.status === 'submitted' ? 0 : 1;
  if (openA !== openB) return openA - openB;
  const x = cents(a.versions[0]!.amount);
  const y = cents(b.versions[0]!.amount);
  return x < y ? -1 : x > y ? 1 : 0;
};

export default async function ShipmentQuotationsPage({ params, searchParams }: Props) {
  const { locale, id, shipmentId } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id) || !UUID.test(shipmentId)) notFound();
  const m = getMessages(locale);
  const q = m.quo;
  const search = await searchParams;
  const qError = typeof search.qError === 'string' ? search.qError : '';
  const qDone = typeof search.qDone === 'string' ? search.qDone : undefined;
  const keyFor = (operation: string): string => {
    const value = search[`${operation}Retry`];
    return typeof value === 'string' && RETRY_KEY.test(value) ? value : randomUUID();
  };
  const person = await requirePerson(locale);
  // An unconfirmed session (the API gave no answer) is not an ended one: the requests below
  // either fail as unavailable, shown as such, or are refused with 401 and end it.
  const shipmentPath = `/${locale}/organisations/${id}/shipments/${shipmentId}`;
  const reply = await api<{ quotations: ShipmentQuotations }>(
    'GET',
    `/organisations/${id}/shipments/${shipmentId}/quotations`,
    { token: person.token },
  );
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (!reply.ok && reply.status === 404) notFound();
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-shipment" href={shipmentPath}>
        {q.backToShipment}
      </a>
    </div>
  );
  if (!reply.ok) {
    return (
      <div className="page page-narrow" data-state="quotations-unavailable">
        {back}
        <h1>{q.title}</h1>
        <ErrorSummary
          title={m.auth.errors.summary}
          problems={[{ message: q.errors.unavailable }]}
        />
      </div>
    );
  }
  const data = reply.data.quotations;
  const terms = data.terms;
  const { errors, summary } = quotationProblems(q, qError, terms, locale);
  const confirmation = qDone ? (q.done as Record<string, string>)[qDone] : undefined;
  const sorted = [...data.quotations].sort(order);
  const hidden = (operation: string) => (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organisationId" value={id} />
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <input type="hidden" name="retryKey" value={keyFor(operation)} />
    </>
  );
  const closed = data.currencyChoices.length === 0 || !data.inclusionsAvailable;

  return (
    <div className="page page-narrow" data-state="shipment-quotations">
      {back}
      <h1>{q.title}</h1>
      <p className="notice" role="note" id="no-commitment">
        {q.noCommitmentShipper}
      </p>
      <ErrorSummary title={m.auth.errors.summary} problems={summary} />
      {confirmation && summary.length === 0 ? (
        <p className="notice notice-success" role="status" id="quotation-confirmation">
          {confirmation}
        </p>
      ) : null}

      <section className="section" aria-labelledby="terms-title">
        <h2 id="terms-title">{q.termsTitle}</h2>
        <p>{q.termsLead}</p>
        {terms ? (
          <dl
            className="card facts"
            id="quotation-terms"
            data-locked={terms.locked ? 'true' : 'false'}
          >
            <div>
              <dt>{q.currency}</dt>
              <dd>
                <bdi>{terms.currency}</bdi>
              </dd>
            </div>
            <div>
              <dt>{q.inclusionsTitle}</dt>
              <dd>
                <ul className="evidence">
                  {terms.inclusions.map((item) => (
                    <li key={item.code}>
                      <bdi>{item.name[locale]}</bdi>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
        ) : null}
        <p className="field-hint" id="inclusions-fictional">
          {q.inclusionsFictional}
        </p>
        {terms?.locked ? (
          <p className="notice" role="note" id="terms-locked">
            {q.termsLocked}
          </p>
        ) : closed ? (
          <p className="notice" role="note" id="terms-closed">
            {q.errors.quotation_terms_closed}
          </p>
        ) : (
          <form className="form card" id="terms-form" action={setQuotationTermsAction}>
            {hidden('terms')}
            <input type="hidden" name="version" value={terms?.version ?? 0} />
            <div className="field" data-invalid={errors.has('currency') ? 'true' : undefined}>
              <label htmlFor="currency">{q.currency}</label>
              <select id="currency" name="currency" defaultValue={terms?.currency ?? ''}>
                <option value="">{q.chooseCurrency}</option>
                {data.currencyChoices.map((choice) => (
                  <option key={choice.code} value={choice.code}>
                    {choice.code}
                  </option>
                ))}
              </select>
              {errors.has('currency') ? (
                <p className="field-error" id="currency-error">
                  {errors.get('currency')}
                </p>
              ) : null}
            </div>
            <button className="button button-primary" type="submit" id="save-terms">
              {q.setTerms}
            </button>
          </form>
        )}
      </section>

      <section className="section" aria-labelledby="received-title">
        <h2 id="received-title">{q.receivedTitle}</h2>
        {sorted.length === 0 ? <p id="no-quotations">{q.noQuotations}</p> : null}
        <p className="field-hint" id="comparison-note">
          {q.comparisonNote}
        </p>
        <ol className="organisation-list" id="quotation-list">
          {sorted.map((quotation) => {
            const current = quotation.versions[0]!;
            return (
              <li
                className="card organisation"
                key={quotation.id}
                data-quotation={quotation.id}
                data-amount={current.amount}
              >
                <h3>
                  <bdi>{quotation.carrier?.tradingName ?? quotation.carrier?.legalName}</bdi>
                </h3>
                <p className="field-hint">
                  {quotation.carrier?.verified ? q.carrierVerified : q.carrierNotVerified}
                </p>
                <Standing t={q} quotation={quotation} />
                <QuotationFacts
                  t={q}
                  locale={locale}
                  terms={terms}
                  version={current}
                  id={`facts-${quotation.id}`}
                />
                <p className="field-hint">
                  {q.version.replace('{n}', String(quotation.currentVersion))}
                  {quotation.versions.length > 1
                    ? ` (${q.earlierCount.replace('{n}', String(quotation.versions.length - 1))})`
                    : ''}
                </p>
                {quotation.status === 'submitted' ? (
                  <form className="form-inline" action={rejectQuotationAction}>
                    {hidden('reject')}
                    <input type="hidden" name="quotationId" value={quotation.id} />
                    <input type="hidden" name="version" value={quotation.currentVersion} />
                    <button className="button" type="submit" data-reject={quotation.id}>
                      {q.reject}
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
