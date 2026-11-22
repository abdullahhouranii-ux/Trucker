import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import {
  CarrierCommissionNotice,
  CommissionAcceptance,
  CommissionFacts,
} from '../../../../../../components/commission.tsx';
import { DraftKeeper } from '../../../../../../components/draft-keeper.tsx';
import { ErrorSummary } from '../../../../../../components/form.tsx';
import { CarrierFacts } from '../../../../../../components/publication-view.tsx';
import {
  QuotationFacts,
  QuotationFields,
  Standing,
  quotationProblems,
} from '../../../../../../components/quotation-view.tsx';
import { isLocale } from '../../../../../../i18n/config.ts';
import { getMessages } from '../../../../../../i18n/messages.ts';
import {
  api,
  type Catalogues,
  type CommissionLine,
  type CommissionView,
  type Country,
  type DiscoveryItem,
  type QuotationContext,
} from '../../../../../../server/api.ts';
import {
  reconfirmQuotationAction,
  reviseQuotationAction,
  submitQuotationAction,
  withdrawQuotationAction,
} from '../../../../../../server/quotation-actions.ts';
import { requirePerson } from '../../../../../../server/session.ts';

// One discovered shipment: the carrier projection, judged again by the server at this request.
// A shipment that is no longer discoverable answers exactly like one that never existed.

type Props = {
  params: Promise<{ locale: string; id: string; shipmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIGURE = /^[0-9]{1,13}(\.[0-9]{1,3})?$/;
const one = (value: string | string[] | undefined): string =>
  typeof value === 'string' ? value : '';

export default async function DiscoveredShipmentPage({ params, searchParams }: Props) {
  const { locale, id, shipmentId } = await params;
  const search = await searchParams;
  const qError = typeof search.qError === 'string' ? search.qError : '';
  const qDone = typeof search.qDone === 'string' ? search.qDone : undefined;
  const keyFor = (operation: string): string => {
    const value = search[`${operation}Retry`];
    return typeof value === 'string' && RETRY_KEY.test(value) ? value : randomUUID();
  };
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id) || !UUID.test(shipmentId)) notFound();
  const m = getMessages(locale);
  const t = m.disc;
  const person = await requirePerson(locale);
  // An unconfirmed session (the API gave no answer) is not an ended one: the requests below
  // either fail as unavailable, shown as such, or are refused with 401 and end it.
  const list = `/${locale}/organisations/${id}/discover`;
  const [reply, countries, catalogues, quoting, commission, commissions] = await Promise.all([
    api<{ shipment: DiscoveryItem }>(
      'GET',
      `/organisations/${id}/discovery/shipments/${shipmentId}`,
      {
        token: person.token,
      },
    ),
    api<{ countries: Country[] }>('GET', '/registration/countries', { token: person.token }),
    api<Catalogues>('GET', `/organisations/${id}/shipment-catalogues`, { token: person.token }),
    api<{ quotation: QuotationContext }>(
      'GET',
      `/organisations/${id}/discovery/shipments/${shipmentId}/quotation`,
      { token: person.token },
    ),
    api<CommissionView>('GET', `/organisations/${id}/shipments/${shipmentId}/commission`, {
      token: person.token,
    }),
    api<{ commissions: { quotations: CommissionLine[] } }>(
      'GET',
      `/organisations/${id}/commissions`,
      { token: person.token },
    ),
  ]);
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-list" href={list}>
        {t.backToList}
      </a>
    </div>
  );
  if (!reply.ok || !catalogues.ok) {
    const code = reply.ok ? 'unavailable' : reply.code;
    const message =
      code === 'not_found'
        ? t.errors.not_found
        : code === 'carrier_not_eligible' || code === 'too_many_requests'
          ? t.errors[code]
          : t.errors.unavailable;
    return (
      <div className="page page-narrow" data-state={`discovered-${code}`}>
        {back}
        <h1>{t.detailTitle}</h1>
        <ErrorSummary title={m.auth.errors.summary} problems={[{ message }]} />
      </div>
    );
  }
  const countryName = (code: string): string =>
    (countries.ok ? countries.data.countries : []).find((country) => country.code === code)?.name[
      locale
    ] ?? code;
  return (
    <div className="page page-narrow" data-state="discovered-shipment">
      {back}
      <h1>{t.detailTitle}</h1>
      <p className="notice" role="note" id="no-quotations">
        {t.noQuotations}
      </p>
      <CarrierFacts
        locale={locale}
        t={m.pub}
        view={reply.data.shipment.shipment}
        countryName={countryName}
        catalogues={catalogues.data}
        id="discovered"
      />
      <p id="free-text-note">{t.freeTextNote}</p>
      <QuotationSection
        locale={locale}
        m={m}
        organisationId={id}
        shipmentId={shipmentId}
        context={quoting.ok ? quoting.data.quotation : null}
        error={qError}
        done={qDone}
        keyFor={keyFor}
        commission={commission.ok ? commission.data.commission : null}
        contract={commission.ok ? (commission.data.contract ?? null) : null}
        lines={commissions.ok ? commissions.data.commissions.quotations : []}
        figures={
          FIGURE.test(one(search.cc)) && FIGURE.test(one(search.cn))
            ? { commission: one(search.cc), net: one(search.cn) }
            : null
        }
      />
    </div>
  );
}

function QuotationSection({
  locale,
  m,
  organisationId,
  shipmentId,
  context,
  error,
  done,
  keyFor,
  commission,
  contract,
  lines,
  figures,
}: {
  locale: 'en' | 'ar' | 'ur';
  m: ReturnType<typeof getMessages>;
  organisationId: string;
  shipmentId: string;
  context: QuotationContext | null;
  error: string;
  done: string | undefined;
  keyFor: (operation: string) => string;
  commission: CommissionView['commission'];
  contract: CommissionView['contract'];
  lines: CommissionLine[];
  figures: { commission: string; net: string } | null;
}) {
  const q = m.quo;
  const terms = context?.terms ?? null;
  const { errors, summary } = quotationProblems(q, error, terms, locale);
  const open = context?.quotations.find((item) => item.status === 'submitted');
  const latest = context?.quotations[0];
  const current = open?.versions[0];
  const ownLine = open ? lines.find((line) => line.quotationId === open.id) : undefined;
  const confirmation = done ? (q.done as Record<string, string>)[done] : undefined;
  const hidden = (operation: string, version?: number) => (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organisationId" value={organisationId} />
      <input type="hidden" name="shipmentId" value={shipmentId} />
      {open ? <input type="hidden" name="quotationId" value={open.id} /> : null}
      {version !== undefined ? <input type="hidden" name="version" value={version} /> : null}
      <input type="hidden" name="retryKey" value={keyFor(operation)} />
    </>
  );
  return (
    <section className="section" aria-labelledby="quotation-title" id="quotation">
      <h2 id="quotation-title">{q.carrierTitle}</h2>
      <p className="notice" role="note" id="no-commitment">
        {q.noCommitment}
      </p>
      <ErrorSummary title={m.auth.errors.summary} problems={summary} />
      {confirmation && summary.length === 0 ? (
        <p className="notice notice-success" role="status" id="quotation-confirmation">
          {confirmation}
        </p>
      ) : null}
      {!context ? (
        <p className="notice" role="note" id="quotation-unavailable">
          {q.errors.unavailable}
        </p>
      ) : !terms ? (
        <p className="notice" role="note" id="terms-missing">
          {q.termsMissing}
        </p>
      ) : (
        <>
          {commission ? (
            <CarrierCommissionNotice
              t={m.commission}
              terms={commission}
              contract={contract}
              contractsHref={`/${locale}/organisations/${organisationId}/contracts`}
            />
          ) : null}
          <p className="field-hint" id="inclusions-fictional">
            {q.inclusionsFictional}
          </p>
          {open && current ? (
            <div className="card" id="own-quotation" data-quotation={open.id}>
              <h3>{q.version.replace('{n}', String(open.currentVersion))}</h3>
              <Standing t={q} quotation={open} />
              <QuotationFacts
                t={q}
                locale={locale}
                terms={terms}
                version={current}
                id="own-quotation-facts"
              />
              {ownLine ? <CommissionFacts t={m.commission} line={ownLine} /> : null}
              {open.reconfirmationNeeded ? (
                <form className="form-inline" id="reconfirm-form" action={reconfirmQuotationAction}>
                  {hidden('reconfirm', open.currentVersion)}
                  <p>{q.reconfirmLead}</p>
                  <button className="button button-primary" type="submit" id="reconfirm-quotation">
                    {q.reconfirm}
                  </button>
                </form>
              ) : null}
              <form
                className="form-inline"
                id="withdraw-quotation-form"
                action={withdrawQuotationAction}
              >
                {hidden('withdraw', open.currentVersion)}
                <button className="button button-danger" type="submit" id="withdraw-quotation">
                  {q.withdraw}
                </button>
              </form>
            </div>
          ) : latest ? (
            <div className="card" id="ended-quotation" data-quotation={latest.id}>
              <h3>{q.version.replace('{n}', String(latest.currentVersion))}</h3>
              <Standing t={q} quotation={latest} />
            </div>
          ) : null}
          <h3 id="quotation-form-title">{open ? q.reviseTitle : q.submitTitle}</h3>
          <form
            className="form card"
            id={open ? 'revise-form' : 'quotation-form'}
            action={open ? reviseQuotationAction : submitQuotationAction}
            noValidate
          >
            {hidden(open ? 'revisions' : 'submit', open?.currentVersion)}
            <QuotationFields
              t={q}
              locale={locale}
              terms={terms}
              current={current}
              errors={errors}
              zone={context.pickupWindow.timeZone}
              deadline={context.quotationDeadline.local}
              window={context.pickupWindow}
            />
            {commission && figures ? (
              <CommissionAcceptance
                t={m.commission}
                commission={figures.commission}
                net={figures.net}
                currency={terms.currency}
              />
            ) : null}
            <button
              className="button button-primary"
              type="submit"
              id={open ? 'revise-quotation' : 'submit-quotation'}
            >
              {open ? q.revise : q.submit}
            </button>
          </form>
          <DraftKeeper
            key={`${open?.currentVersion ?? 0}-${Boolean(confirmation)}`}
            formId={open ? 'revise-form' : 'quotation-form'}
            scope={`q${open?.currentVersion ?? 0}`}
            overwrite
            clear={Boolean(confirmation)}
          />
        </>
      )}
    </section>
  );
}
