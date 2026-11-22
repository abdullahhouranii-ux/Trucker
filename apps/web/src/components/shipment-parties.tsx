import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import { api, type ShipmentParties, type ShipmentPartiesView } from '../server/api.ts';
import { setShipmentPartiesAction } from '../server/authority-actions.ts';

type T = Messages['roles'];

/** The roles as sentences: who arranged it, for whom, and who pays what. */
export function PartiesList({
  t,
  parties,
  card = false,
}: {
  t: T;
  parties: ShipmentParties;
  card?: boolean;
}) {
  const named = (side: ShipmentParties['sender']): string =>
    side.is === 'customer' ? t.theCustomer : side.is === 'named' ? (side.name ?? '') : t.notNamed;
  return (
    <dl className={card ? 'card facts' : 'facts'} data-parties>
      {parties.organiser ? (
        <div>
          <dt>{t.organiser}</dt>
          <dd>
            <bdi>{parties.organiser.legalName}</bdi>
          </dd>
        </div>
      ) : null}
      <div>
        <dt>{t.customer}</dt>
        <dd>
          <bdi>{parties.customer.legalName}</bdi>
        </dd>
      </div>
      <div>
        <dt>{t.sender}</dt>
        <dd>
          <bdi>{named(parties.sender)}</bdi>
        </dd>
      </div>
      <div>
        <dt>{t.receiver}</dt>
        <dd>
          <bdi>{named(parties.receiver)}</bdi>
        </dd>
      </div>
      <div>
        <dt>{t.freightPayer}</dt>
        <dd>{t.payers[parties.freightPayer]}</dd>
      </div>
      <div>
        <dt>{t.feePayer}</dt>
        <dd>{t.payers[parties.feePayer]}</dd>
      </div>
    </dl>
  );
}

/**
 * The roles of one shipment, on its own page. An organiser with a customer's authority sets
 * them while the shipment is a draft; once it has been published they are fixed.
 */
export async function ShipmentPartiesSection({
  locale,
  t,
  organisationId,
  shipmentId,
  version,
  token,
  done,
  error,
}: {
  locale: Locale;
  t: T;
  organisationId: string;
  shipmentId: string;
  version: number;
  token: string;
  done: string | undefined;
  error: string | undefined;
}) {
  const reply = await api<ShipmentPartiesView>(
    'GET',
    `/organisations/${organisationId}/shipments/${shipmentId}/parties`,
    { token },
  );
  if (!reply.ok) return null;
  const { parties, editable, customers } = reply.data;
  // An account with no customer to arrange for sees its roles only once they say something.
  if (customers.length === 0 && !parties.organiser) return null;
  const errors = (error ?? '')
    .split(',')
    .filter((code) => code !== '')
    .map((code) => (t.errors as Record<string, string>)[code] ?? t.errors.invalid);
  return (
    <section className="section" aria-labelledby="roles-title" id="roles">
      <h2 id="roles-title">{t.title}</h2>
      {errors.length > 0 ? (
        <div className="notice notice-error" role="alert" id="roles-error">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : done ? (
        <p className="notice notice-success" role="status" id="roles-saved">
          {t.saved}
        </p>
      ) : null}
      <PartiesList t={t} parties={parties} />
      {editable && customers.length > 0 ? (
        <form className="form card" id="roles-form" action={setShipmentPartiesAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="organisationId" value={organisationId} />
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <input type="hidden" name="version" value={version} />
          <p>{t.lead}</p>
          <div className="field">
            <label htmlFor="customerAuthorityId">{t.customer}</label>
            <select
              id="customerAuthorityId"
              name="customerAuthorityId"
              defaultValue={parties.authorityId ?? ''}
            >
              <option value="">{t.ownShipment}</option>
              {customers.map((customer) => (
                <option value={customer.authorityId} key={customer.authorityId}>
                  {customer.legalName}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="receiverName">{t.receiverName}</label>
            <p className="field-hint" id="receiverName-hint">
              {t.receiverHint}
            </p>
            <input
              id="receiverName"
              name="receiverName"
              type="text"
              maxLength={200}
              aria-describedby="receiverName-hint"
              defaultValue={parties.receiver.is === 'named' ? (parties.receiver.name ?? '') : ''}
            />
          </div>
          <div className="field">
            <label htmlFor="freightPayer">{t.freightPayer}</label>
            <select id="freightPayer" name="freightPayer" defaultValue={parties.freightPayer}>
              {(['customer', 'sender', 'receiver'] as const).map((payer) => (
                <option value={payer} key={payer}>
                  {t.payers[payer]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="feePayer">{t.feePayer}</label>
            <p className="field-hint" id="feePayer-hint">
              {t.feePayerHint}
            </p>
            <select
              id="feePayer"
              name="feePayer"
              defaultValue={parties.feePayer}
              aria-describedby="feePayer-hint"
            >
              <option value="customer">{t.payers.customer}</option>
              <option value="organiser">{t.payers.organiser}</option>
            </select>
          </div>
          <button className="button button-primary" type="submit" id="save-roles">
            {t.save}
          </button>
        </form>
      ) : null}
      {!editable ? <p className="field-hint">{t.fixed}</p> : null}
    </section>
  );
}
