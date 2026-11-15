import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../../../../components/draft-keeper.tsx';
import { ErrorSummary } from '../../../../../../../components/form.tsx';
import {
  isPublicationCode,
  PublicationFields,
  publicationProblems,
} from '../../../../../../../components/publication-form.tsx';
import {
  ShipmentFields,
  shipmentProblems,
} from '../../../../../../../components/shipment-form.tsx';
import { ShipmentUnavailable } from '../../../../../../../components/shipment-unavailable.tsx';
import { isLocale } from '../../../../../../../i18n/config.ts';
import { getMessages } from '../../../../../../../i18n/messages.ts';
import {
  api,
  type Catalogues,
  type PlaceOption,
  type Shipment,
} from '../../../../../../../server/api.ts';
import { changePublishedShipmentAction } from '../../../../../../../server/shipment-actions.ts';
import { requirePerson } from '../../../../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string; id: string; shipmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Changing a published shipment: every field of the draft and of publication, in one form.
// A change to what carriers would see, the deadline or the dangerous-goods answer becomes a
// new published version; the server decides which, and the page says what it decided.
export default async function ChangePublishedPage({ params, searchParams }: Props) {
  const { locale, id, shipmentId } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id) || !UUID.test(shipmentId)) notFound();
  const m = getMessages(locale);
  const search = await searchParams;
  const one = (name: string): string | undefined => {
    const value = search[name];
    return typeof value === 'string' ? value : undefined;
  };
  const parts = (one('error') ?? '').split(',').filter(Boolean);
  // A page-level code the draft already knows (a conflict, say) stays with the draft.
  const pubParts = parts.filter(
    (part) => isPublicationCode(part, m.pub) && !(part in m.ship.errors),
  );
  const found = shipmentProblems(
    parts.filter((part) => !pubParts.includes(part)).join(','),
    m.ship,
    m.auth.errors.unavailable,
  );
  const pubFound = publicationProblems(pubParts, m.pub);
  const retry = one('published-changesRetry');
  const retryKey = retry && RETRY_KEY.test(retry) ? retry : randomUUID();
  const shipmentHref = `/${locale}/organisations/${id}/shipments/${shipmentId}`;

  const person = await requirePerson(locale);
  const base = `/organisations/${id}`;
  const [one1, places, catalogueReply] =
    person.state === 'signed-in'
      ? await Promise.all([
          api<{ shipment: Shipment }>('GET', `${base}/shipments/${shipmentId}`, {
            token: person.token,
          }),
          api<{ countries: PlaceOption[] }>('GET', `${base}/shipment-places`, {
            token: person.token,
          }),
          api<Catalogues>('GET', `${base}/shipment-catalogues`, { token: person.token }),
        ])
      : [undefined, undefined, undefined];
  for (const reply of [one1, places, catalogueReply]) {
    if (reply && !reply.ok && reply.status === 401)
      redirect(`/${locale}/sign-in?error=session_ended`);
    if (reply && !reply.ok && reply.status === 404) notFound();
  }
  if (!one1?.ok || !places?.ok || !catalogueReply?.ok) {
    return (
      <ShipmentUnavailable
        m={m}
        reply={[one1, places, catalogueReply].find((reply) => reply && !reply.ok)}
        problems={[...found.problems, ...pubFound.problems]}
        retryHref={`${shipmentHref}/change${retry ? `?published-changesRetry=${retry}` : ''}`}
        backHref={shipmentHref}
      />
    );
  }
  const shipment = one1.data.shipment;
  // Only a published shipment is changed here; anything else goes back to its own page.
  if (shipment.status !== 'published' && shipment.status !== 'suspended')
    redirect(`${shipmentHref}?error=shipment_not_published`);
  const formId = `published-change-form-${shipment.id}`;
  return (
    <div className="page page-narrow">
      <div className="form-inline">
        <a className="button" id="back-to-shipment" href={shipmentHref}>
          {m.pub.backToShipment}
        </a>
      </div>
      <h1>{m.pub.changeTitle}</h1>
      <p>{m.pub.changeLead}</p>
      <ErrorSummary
        title={m.auth.errors.summary}
        problems={[...found.problems, ...pubFound.problems]}
      />
      <p className="form-note">{m.pub.previewCaution}</p>
      <form className="form card" id={formId} action={changePublishedShipmentAction} noValidate>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="organisationId" value={id} />
        <input type="hidden" name="shipmentId" value={shipment.id} />
        <input type="hidden" name="version" value={shipment.version} />
        <input type="hidden" name="retryKey" value={retryKey} />
        <ShipmentFields
          locale={locale}
          t={m.ship}
          places={places.data.countries}
          current={shipment}
          problems={found}
        />
        <PublicationFields
          locale={locale}
          t={m.pub}
          catalogues={catalogueReply.data}
          current={shipment}
          problems={pubFound}
        />
        <button className="button button-primary" type="submit" id="save-published-change">
          {m.pub.submitChange}
        </button>
      </form>
      <DraftKeeper formId={formId} scope={`v${shipment.version}`} overwrite />
    </div>
  );
}
