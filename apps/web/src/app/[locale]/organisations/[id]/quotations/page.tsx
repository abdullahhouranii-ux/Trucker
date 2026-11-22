import { notFound, redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../../components/form.tsx';
import { AmountText, Standing } from '../../../../../components/quotation-view.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import { api, type Quotation } from '../../../../../server/api.ts';
import { requirePerson } from '../../../../../server/session.ts';

// The carrier's own quotations on every shipment, newest first, each judged now.

type Props = { params: Promise<{ locale: string; id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MyQuotationsPage({ params }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const q = m.quo;
  const person = await requirePerson(locale);
  // An unconfirmed session (the API gave no answer) is not an ended one: the requests below
  // either fail as unavailable, shown as such, or are refused with 401 and end it.
  const reply = await api<{ quotations: Quotation[] }>('GET', `/organisations/${id}/quotations`, {
    token: person.token,
  });
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (!reply.ok && reply.status === 404) notFound();
  return (
    <div className="page page-narrow" data-state="my-quotations">
      <div className="form-inline">
        <a
          className="button"
          id="back-to-discovery"
          href={`/${locale}/organisations/${id}/discover`}
        >
          {q.backToDiscovery}
        </a>
      </div>
      <h1>{q.myTitle}</h1>
      {!reply.ok ? (
        <ErrorSummary
          title={m.auth.errors.summary}
          problems={[{ message: q.errors.unavailable }]}
        />
      ) : reply.data.quotations.length === 0 ? (
        <p id="no-quotations">{q.noQuotationsMine}</p>
      ) : (
        <ol className="organisation-list" id="my-quotation-list">
          {reply.data.quotations.map((quotation) => (
            <li className="card organisation" key={quotation.id} data-quotation={quotation.id}>
              <h3>
                <AmountText version={quotation.versions[0]!} />
              </h3>
              <Standing t={q} quotation={quotation} />
              <p>{q.version.replace('{n}', String(quotation.currentVersion))}</p>
              <a
                className="button"
                href={`/${locale}/organisations/${id}/discover/${quotation.shipmentId}#quotation`}
              >
                {q.openShipment}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
