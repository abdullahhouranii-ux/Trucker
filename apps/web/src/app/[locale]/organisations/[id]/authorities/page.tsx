import { notFound, redirect } from 'next/navigation';
import { PartiesList } from '../../../../../components/shipment-parties.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import { api, type AuthorityOverview } from '../../../../../server/api.ts';
import {
  decideAuthorityAction,
  endAuthorityAction,
  requestAuthorityAction,
} from '../../../../../server/authority-actions.ts';
import { requirePerson } from '../../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authority between a customer and an organiser. A customer accepts or ends what an organiser
 * may do in its name and sees every shipment arranged for it; an organiser asks a customer by
 * its account code.
 */
export default async function AuthoritiesPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.roles;
  const search = await searchParams;
  const one = (name: string): string | undefined =>
    typeof search[name] === 'string' ? (search[name] as string) : undefined;
  const person = await requirePerson(locale);
  const reply =
    person.state === 'signed-in'
      ? await api<{ overview: AuthorityOverview }>('GET', `/organisations/${id}/authorities`, {
          token: person.token,
        })
      : undefined;
  if (reply && !reply.ok && reply.status === 401)
    redirect(`/${locale}/sign-in?error=session_ended`);
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-organisation" href={`/${locale}/organisations/${id}`}>
        {t.back}
      </a>
    </div>
  );
  if (!reply?.ok) {
    return (
      <div className="page page-narrow" data-state="authorities-unavailable">
        {back}
        <h1>{t.pageTitle}</h1>
        <p className="notice notice-error" role="alert">
          {t.errors.unavailable}
        </p>
      </div>
    );
  }
  const overview = reply.data.overview;
  const error = one('aError');
  const done = one('aDone');
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organisationId" value={id} />
    </>
  );
  return (
    <div className="page page-narrow" data-state="authorities">
      {back}
      <h1>{t.pageTitle}</h1>
      {error ? (
        <p className="notice notice-error" role="alert" id="authority-error">
          {(t.errors as Record<string, string>)[error] ?? t.errors.invalid}
        </p>
      ) : done ? (
        <p className="notice notice-success" role="status" id="authority-done">
          {(t.done as Record<string, string>)[done] ?? t.saved}
        </p>
      ) : null}
      <p>{t.pageLead}</p>

      <section className="section" aria-labelledby="code-title">
        <h2 id="code-title">{t.codeTitle}</h2>
        <p>{t.codeLead}</p>
        <p className="card">
          <bdi dir="ltr" id="account-code">
            {overview.accountCode}
          </bdi>
        </p>
      </section>

      {overview.organiser ? (
        <section className="section" aria-labelledby="request-title">
          <h2 id="request-title">{t.requestTitle}</h2>
          <form className="form card" id="request-form" action={requestAuthorityAction}>
            {hidden}
            <div className="field">
              <label htmlFor="customerCode">{t.customerCode}</label>
              <p className="field-hint" id="customerCode-hint">
                {t.customerCodeHint}
              </p>
              <input
                id="customerCode"
                name="customerCode"
                type="text"
                dir="ltr"
                autoComplete="off"
                maxLength={40}
                aria-describedby="customerCode-hint"
              />
            </div>
            <button className="button button-primary" type="submit" id="request-authority">
              {t.request}
            </button>
          </form>
        </section>
      ) : null}

      <section className="section" aria-labelledby="authorities-title">
        <h2 id="authorities-title">{t.listTitle}</h2>
        {overview.authorities.length === 0 ? (
          <p id="no-authorities">{t.none}</p>
        ) : (
          <ol className="evidence" id="authorities">
            {overview.authorities.map((item) => (
              <li
                className="card organisation"
                key={item.id}
                data-authority={item.id}
                data-status={item.status}
                data-role={item.role}
              >
                <h3>
                  <bdi>
                    {item.role === 'customer' ? item.organiser.legalName : item.customer.legalName}
                  </bdi>
                </h3>
                <p className="chip">{t.status[item.status]}</p>
                <p>{item.role === 'customer' ? t.asCustomer : t.asOrganiser}</p>
                {item.status === 'active' ? (
                  <ul>
                    <li>{item.mayPublish ? t.allowsPublish : t.noPublish}</li>
                    <li>{item.feePayerAgreed ? t.allowsFee : t.noFee}</li>
                  </ul>
                ) : null}
                {item.status === 'requested' && item.role === 'customer' ? (
                  <form className="form" action={decideAuthorityAction}>
                    {hidden}
                    <input type="hidden" name="authorityId" value={item.id} />
                    <input type="hidden" name="version" value={item.version} />
                    <div className="check">
                      <input id={`publish-${item.id}`} name="mayPublish" type="checkbox" />
                      <label htmlFor={`publish-${item.id}`}>{t.mayPublish}</label>
                    </div>
                    <div className="check">
                      <input id={`fee-${item.id}`} name="feePayerAgreed" type="checkbox" />
                      <label htmlFor={`fee-${item.id}`}>{t.feePayerAgreed}</label>
                    </div>
                    <div className="form-inline">
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
                    </div>
                  </form>
                ) : null}
                {item.status === 'active' ||
                (item.status === 'requested' && item.role === 'organiser') ? (
                  <form action={endAuthorityAction}>
                    {hidden}
                    <input type="hidden" name="authorityId" value={item.id} />
                    <input type="hidden" name="version" value={item.version} />
                    <button className="button button-danger" type="submit" data-end>
                      {t.end}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="section" aria-labelledby="arranged-title">
        <h2 id="arranged-title">{t.arrangedTitle}</h2>
        {overview.arranged.length === 0 ? (
          <p id="no-arranged">{t.noneArranged}</p>
        ) : (
          <div id="arranged">
            {overview.arranged.map((item) => (
              <div className="section" key={item.id} data-arranged={item.id}>
                <h3>
                  {t.shipment} <bdi>{item.reference ?? item.id.slice(0, 8)}</bdi>
                </h3>
                <PartiesList t={t} parties={item.parties} card />
                <div className="form-inline">
                  <a
                    className="button"
                    href={`/${locale}/organisations/${id}/shipments/${item.id}/quotations`}
                  >
                    {t.openQuotations}
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
