import { notFound } from 'next/navigation';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import { api, type OrganisationSummary, type QuotationContext } from '../../../../../server/api.ts';
import { requirePerson } from '../../../../../server/session.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ChooseQuotationAccount({
  params,
}: {
  params: Promise<{ locale: string; shipmentId: string }>;
}) {
  const { locale, shipmentId } = await params;
  if (!isLocale(locale) || !uuid.test(shipmentId)) notFound();

  const m = getMessages(locale);
  const t = m.publicShipments;
  const person = await requirePerson(locale);
  const organisations = await api<{ organisations: OrganisationSummary[] }>(
    'GET',
    '/organisations',
    {
      token: person.token,
    },
  );

  const choices = organisations.ok
    ? await Promise.all(
        organisations.data.organisations
          .filter((organisation) => organisation.status === 'verified')
          .map(async (organisation) => ({
            organisation,
            context: await api<{ quotation: QuotationContext }>(
              'GET',
              '/organisations/' +
                organisation.id +
                '/discovery/shipments/' +
                shipmentId +
                '/quotation',
              { token: person.token },
            ),
          })),
      )
    : [];
  const available = choices.filter(({ context }) => context.ok);
  const hasError =
    !organisations.ok ||
    choices.some(({ context }) => !context.ok && ![403, 404].includes(context.status));

  return (
    <div className="page page-narrow">
      <a className="button" href={'/' + locale + '#published-shipments'}>
        {t.title}
      </a>
      <h1>{t.chooseAccount}</h1>
      {hasError ? <p role="status">{m.auth.errors.unavailable}</p> : null}
      {!hasError && available.length === 0 ? <p role="status">{t.noQuoteAccounts}</p> : null}
      <ul className="organisation-list">
        {available.map(({ organisation, context }) => (
          <li className="card" key={organisation.id}>
            <h2>{organisation.legalName}</h2>
            {context.ok && context.data.quotation.fleetMatches && context.data.quotation.terms ? (
              <a
                className="button"
                href={
                  '/' +
                  locale +
                  '/organisations/' +
                  organisation.id +
                  '/discover/' +
                  shipmentId +
                  '#quotation'
                }
              >
                {t.openQuotation}
              </a>
            ) : (
              <p>
                {context.ok && context.data.quotation.fleetMatches
                  ? m.quo.termsMissing
                  : m.quo.errors.fleet_mismatch}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
