import { notFound, redirect } from 'next/navigation';
import { ContractTerms } from '../../../../../components/commission.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import { api, type ContractsOverview } from '../../../../../server/api.ts';
import {
  decideContractAction,
  endContractAction,
  proposeContractAction,
} from '../../../../../server/authority-actions.ts';
import { requirePerson } from '../../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Commission contracts. An organiser proposes one to a carrier by its account code; the
 * carrier accepts or declines; either side ends it. Its terms never change once proposed.
 */
export default async function ContractsPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.contracts;
  const search = await searchParams;
  const one = (name: string): string | undefined =>
    typeof search[name] === 'string' ? (search[name] as string) : undefined;
  const person = await requirePerson(locale);
  const reply =
    person.state === 'signed-in'
      ? await api<{ contracts: ContractsOverview }>(
          'GET',
          `/organisations/${id}/commission-contracts`,
          { token: person.token },
        )
      : undefined;
  if (reply && !reply.ok && reply.status === 401)
    redirect(`/${locale}/sign-in?error=session_ended`);
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-organisation" href={`/${locale}/organisations/${id}`}>
        {m.roles.back}
      </a>
    </div>
  );
  if (!reply?.ok) {
    return (
      <div className="page page-narrow" data-state="contracts-unavailable">
        {back}
        <h1>{t.pageTitle}</h1>
        <p className="notice notice-error" role="alert">
          {t.errors.unavailable}
        </p>
      </div>
    );
  }
  const overview = reply.data.contracts;
  const errors = (one('cError') ?? '')
    .split(',')
    .filter((code) => code !== '')
    .map((code) => (t.errors as Record<string, string>)[code] ?? t.errors.invalid);
  const done = one('cDone');
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organisationId" value={id} />
    </>
  );
  return (
    <div className="page page-narrow" data-state="contracts">
      {back}
      <h1>{t.pageTitle}</h1>
      {errors.length > 0 ? (
        <div className="notice notice-error" role="alert" id="contract-error">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : done ? (
        <p className="notice notice-success" role="status" id="contract-done">
          {(t.done as Record<string, string>)[done] ?? t.saved}
        </p>
      ) : null}
      <p>{t.pageLead}</p>

      <section className="section" aria-labelledby="contract-code-title">
        <h2 id="contract-code-title">{m.roles.codeTitle}</h2>
        <p>{t.codeLead}</p>
        <p className="card">
          <bdi dir="ltr" id="account-code">
            {overview.accountCode}
          </bdi>
        </p>
      </section>

      {overview.organiser ? (
        <section className="section" aria-labelledby="propose-title">
          <h2 id="propose-title">{t.proposeTitle}</h2>
          <form className="form card" id="propose-form" action={proposeContractAction}>
            {hidden}
            <div className="field">
              <label htmlFor="carrierCode">{t.carrierCode}</label>
              <p className="field-hint" id="carrierCode-hint">
                {t.carrierCodeHint}
              </p>
              <input
                id="carrierCode"
                name="carrierCode"
                type="text"
                dir="ltr"
                autoComplete="off"
                maxLength={40}
                aria-describedby="carrierCode-hint"
              />
            </div>
            <div className="field">
              <label htmlFor="contractOption">{t.option}</label>
              <select id="contractOption" name="contractOption" defaultValue="percentage">
                <option value="percentage">{m.commission.options.percentage}</option>
                <option value="fixed">{m.commission.options.fixed}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="contractPercent">{m.commission.percent}</label>
              <p className="field-hint" id="contractPercent-hint">
                {m.commission.percentHint}
              </p>
              <input
                id="contractPercent"
                name="contractPercent"
                type="text"
                inputMode="decimal"
                dir="ltr"
                maxLength={5}
                aria-describedby="contractPercent-hint"
              />
            </div>
            <div className="field">
              <label htmlFor="contractAmount">{m.commission.amount}</label>
              <p className="field-hint" id="contractAmount-hint">
                {m.commission.amountHint}
              </p>
              <input
                id="contractAmount"
                name="contractAmount"
                type="text"
                inputMode="decimal"
                dir="ltr"
                maxLength={20}
                aria-describedby="contractAmount-hint"
              />
            </div>
            <div className="field">
              <label htmlFor="contractCurrency">{m.commission.currency}</label>
              <input
                id="contractCurrency"
                name="contractCurrency"
                type="text"
                dir="ltr"
                maxLength={3}
              />
            </div>
            <div className="field">
              <label htmlFor="settlementDays">{t.settlementDays}</label>
              <p className="field-hint" id="settlementDays-hint">
                {t.settlementDaysHint}
              </p>
              <input
                id="settlementDays"
                name="settlementDays"
                type="text"
                inputMode="numeric"
                dir="ltr"
                maxLength={2}
                aria-describedby="settlementDays-hint"
              />
            </div>
            <p className="field-hint">{t.earningNote}</p>
            <button className="button button-primary" type="submit" id="propose-contract">
              {t.propose}
            </button>
          </form>
        </section>
      ) : null}

      <section className="section" aria-labelledby="contracts-title">
        <h2 id="contracts-title">{t.listTitle}</h2>
        {overview.contracts.length === 0 ? (
          <p id="no-contracts">{t.none}</p>
        ) : (
          <ol className="evidence" id="contracts">
            {overview.contracts.map((item) => (
              <li
                className="card organisation"
                key={item.id}
                data-contract={item.id}
                data-status={item.status}
                data-role={item.role}
              >
                <h3>
                  <bdi>
                    {item.role === 'carrier' ? item.organiser.legalName : item.carrier.legalName}
                  </bdi>
                </h3>
                <p className="chip">{t.status[item.status]}</p>
                <p>{item.role === 'carrier' ? t.asCarrier : t.asOrganiser}</p>
                <ContractTerms t={m.commission} tc={t} contract={item} />
                {item.status === 'proposed' && item.role === 'carrier' ? (
                  <form className="form-inline" action={decideContractAction}>
                    {hidden}
                    <input type="hidden" name="contractId" value={item.id} />
                    <input type="hidden" name="version" value={item.version} />
                    <button
                      className="button button-primary"
                      type="submit"
                      name="decision"
                      value="accept"
                      data-accept
                    >
                      {t.accept}
                    </button>
                    <button
                      className="button"
                      type="submit"
                      name="decision"
                      value="decline"
                      data-decline
                    >
                      {t.decline}
                    </button>
                  </form>
                ) : null}
                {item.status === 'active' || item.status === 'proposed' ? (
                  <form action={endContractAction}>
                    {hidden}
                    <input type="hidden" name="contractId" value={item.id} />
                    <input type="hidden" name="version" value={item.version} />
                    <button className="button button-danger" type="submit" data-end>
                      {item.status === 'proposed' && item.role === 'organiser' ? t.withdraw : t.end}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
