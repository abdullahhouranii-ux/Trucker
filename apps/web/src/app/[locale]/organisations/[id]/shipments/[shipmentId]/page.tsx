import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../../../components/draft-keeper.tsx';
import { ErrorSummary } from '../../../../../../components/form.tsx';
import { Ltr } from '../../../../../../components/ltr.tsx';
import {
  offsetText,
  ShipmentFields,
  shipmentProblems,
} from '../../../../../../components/shipment-form.tsx';
import { ShipmentUnavailable } from '../../../../../../components/shipment-unavailable.tsx';
import { isLocale } from '../../../../../../i18n/config.ts';
import { getMessages } from '../../../../../../i18n/messages.ts';
import {
  api,
  type PlaceOption,
  type Shipment,
  type ShipmentPlace,
  type WindowEnd,
} from '../../../../../../server/api.ts';
import {
  discardShipmentAction,
  updateShipmentAction,
} from '../../../../../../server/shipment-actions.ts';
import { requirePerson } from '../../../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string; id: string; shipmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export default async function ShipmentPage({ params, searchParams }: Props) {
  const { locale, id, shipmentId } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id) || !UUID.test(shipmentId)) notFound();
  const m = getMessages(locale);
  const t = m.ship;
  const search = await searchParams;
  const one = (name: string): string | undefined => {
    const value = search[name];
    return typeof value === 'string' ? value : undefined;
  };
  const error = one('error');
  const done = one('done');
  const found = shipmentProblems(error, t, m.auth.errors.unavailable);
  const key = (name: string): string => {
    const value = one(name);
    return value && RETRY_KEY.test(value) ? value : randomUUID();
  };
  const list = `/${locale}/organisations/${id}/shipments`;
  const here = `${list}/${shipmentId}`;

  // The keys of an attempt whose outcome is not known stay with the page, so that trying
  // again after the connection returns asks for the same change, not for a second one.
  const kept = ['retry', 'discardRetry']
    .filter((name) => RETRY_KEY.test(one(name) ?? ''))
    .map((name) => `${name}=${one(name)}`);
  const retryHref = kept.length > 0 ? `${here}?${kept.join('&')}` : here;

  const person = await requirePerson(locale);
  const base = `/organisations/${id}`;
  const [draft, places] =
    person.state === 'signed-in'
      ? await Promise.all([
          api<{ shipment: Shipment }>('GET', `${base}/shipments/${shipmentId}`, {
            token: person.token,
          }),
          api<{ countries: PlaceOption[] }>('GET', `${base}/shipment-places`, {
            token: person.token,
          }),
        ])
      : [undefined, undefined];
  for (const reply of [draft, places]) {
    if (reply && !reply.ok && reply.status === 401)
      redirect(`/${locale}/sign-in?error=session_ended`);
    // Not a draft of the caller's organisation, or none at all: the same page either way.
    if (reply && !reply.ok && reply.status === 404) notFound();
  }
  if (!draft?.ok || !places?.ok) {
    return (
      <ShipmentUnavailable
        m={m}
        reply={[draft, places].find((reply) => reply && !reply.ok)}
        problems={found.problems}
        retryHref={retryHref}
        backHref={`/${locale}/organisations/${id}`}
      />
    );
  }
  const shipment = draft.data.shipment;
  const open = shipment.status === 'draft';
  // A country or zone the draft already has stays selectable even if it is no longer offered.
  const choices: PlaceOption[] = places.data.countries.map((country) => ({
    ...country,
    timeZones: [...country.timeZones],
  }));
  for (const place of [shipment.pickup, shipment.delivery]) {
    if (!place.countryCode) continue;
    let country = choices.find((entry) => entry.code === place.countryCode);
    if (!country) {
      const code = place.countryCode;
      country = { code, name: { en: code, ar: code, ur: code }, fixture: false, timeZones: [] };
      choices.push(country);
    }
    if (place.timeZone && !country.timeZones.includes(place.timeZone))
      country.timeZones.push(place.timeZone);
  }
  const countryName = (code: string): string =>
    choices.find((country) => country.code === code)?.name[locale] ?? code;

  const confirmation =
    done === 'created'
      ? t.createdDone
      : done === 'saved'
        ? t.savedDone
        : done === 'already'
          ? t.alreadyDone
          : done === 'discarded' && !open
            ? t.discardedDone
            : undefined;
  // Someone else changed the draft while this person was typing. What they typed was kept
  // against the version they started from, and is carried over to the current one.
  const startedFrom = Number(one('base'));
  const conflict =
    open && (found.codes.has('shipment_changed') || found.codes.has('overwrite_not_chosen'));
  const fallbackScope =
    conflict && Number.isInteger(startedFrom) && startedFrom >= 1 && startedFrom < shipment.version
      ? `v${startedFrom}`
      : undefined;
  const formId = `shipment-form-${shipment.id}`;
  const dropDraft = Boolean(confirmation) || one('drop') === '1';

  const end = (value: WindowEnd, place: ShipmentPlace) =>
    value.local ? (
      <>
        <Ltr>{value.local.replace('T', ' ')}</Ltr>{' '}
        {value.offsetMinutes !== null && place.timeZone ? (
          <Ltr>
            ({place.timeZone}, {offsetText(value.offsetMinutes)})
          </Ltr>
        ) : (
          <span className="form-note">({t.noZone})</span>
        )}
      </>
    ) : (
      t.notGiven
    );
  const text = (value: string | null) => (value ? <bdi>{value}</bdi> : t.notGiven);
  const placeFacts = (place: ShipmentPlace, title: string, name: string) => (
    <>
      <h3 id={`${name}-facts-title`}>{title}</h3>
      <dl className="card facts" id={`${name}-facts`} aria-labelledby={`${name}-facts-title`}>
        <div>
          <dt>{t.address}</dt>
          <dd>{text(place.address)}</dd>
        </div>
        <div>
          <dt>{t.country}</dt>
          <dd>{place.countryCode ? <bdi>{countryName(place.countryCode)}</bdi> : t.notGiven}</dd>
        </div>
        <div>
          <dt>{t.timeZone}</dt>
          <dd>{place.timeZone ? <Ltr>{place.timeZone}</Ltr> : t.notGiven}</dd>
        </div>
        <div>
          <dt>{t.windowFrom}</dt>
          <dd>{end(place.from, place)}</dd>
        </div>
        <div>
          <dt>{t.windowUntil}</dt>
          <dd>{end(place.until, place)}</dd>
        </div>
        <div>
          <dt>{t.accessNotes}</dt>
          <dd>{text(place.accessNotes)}</dd>
        </div>
      </dl>
    </>
  );
  const route = shipment.route;
  const reason = (entry: Shipment['route']['reasons'][number]): string => {
    const country = entry.country ? countryName(entry.country) : '';
    if (entry.part === 'origin') return t.reasonOrigin.replace('{country}', country);
    if (entry.part === 'destination') return t.reasonDestination.replace('{country}', country);
    if (entry.part === 'transit') return t.reasonTransit.replace('{country}', country);
    return entry.code === 'lane_closed' ? t.reasonLaneClosed : t.reasonLaneMissing;
  };

  return (
    <div className="page page-narrow">
      <div className="form-inline">
        <a className="button" href={list}>
          {t.backToList}
        </a>
      </div>
      <h1>
        {shipment.shipperReference ? (
          <Ltr>{shipment.shipperReference}</Ltr>
        ) : shipment.cargoDescription ? (
          <bdi className="clamp">{shipment.cargoDescription}</bdi>
        ) : (
          t.untitled
        )}
      </h1>
      <ErrorSummary title={m.auth.errors.summary} problems={found.problems} />
      {confirmation && found.problems.length === 0 ? (
        <p className="notice notice-success" role="status" id="shipment-confirmation">
          {confirmation}
        </p>
      ) : null}
      <div className="notice" role="note" id="shipment-status">
        <h2>
          {t.statusLabel}: {open ? t.statusDraft : t.statusDiscarded}
        </h2>
        <p>{open ? t.draftNotice : t.discardedNotice}</p>
      </div>
      {conflict ? (
        <div className="notice notice-warning" role="note" id="shipment-conflict">
          <h2>{t.conflictTitle}</h2>
          <p>{t.conflictLead}</p>
          <p>{t.conflictKeep}</p>
          <a className="button" id="drop-changes" href={`${here}?drop=1`}>
            {t.conflictDrop}
          </a>
        </div>
      ) : null}
      <section className="section" aria-labelledby="route-title">
        <h2 id="route-title">{t.routeTitle}</h2>
        <div className="card route" id="shipment-route" data-route={route.status}>
          <p className="route-status">
            {route.status === 'open'
              ? t.routeOpen
              : route.status === 'closed'
                ? t.routeClosed
                : t.routeUnknown}
          </p>
          {route.reasons.length > 0 ? (
            <ul>
              {route.reasons.map((entry, index) => (
                <li key={`${entry.part}-${entry.country ?? ''}-${index}`}>{reason(entry)}</li>
              ))}
            </ul>
          ) : null}
          {route.status === 'open' && route.transit.length > 0 ? (
            <p>
              {t.routeTransit}: <bdi>{route.transit.map(countryName).join(', ')}</bdi>
            </p>
          ) : null}
          {route.status !== 'unknown' ? <p className="form-note">{t.routeBasis}</p> : null}
          {route.status === 'closed' ? <p className="form-note">{t.routeDraftSaved}</p> : null}
        </div>
      </section>
      <section className="section" aria-labelledby="details-title">
        <h2 id="details-title">{t.detailsTitle}</h2>
        <dl className="card facts" id="shipment-facts">
          <div>
            <dt>{t.shipperReference}</dt>
            <dd>
              {shipment.shipperReference ? <Ltr>{shipment.shipperReference}</Ltr> : t.notGiven}
            </dd>
          </div>
          <div>
            <dt>{t.cargoDescription}</dt>
            <dd>{text(shipment.cargoDescription)}</dd>
          </div>
          <div>
            <dt>{t.grossWeightKg}</dt>
            <dd>
              {shipment.grossWeightKg ? (
                <>
                  <Ltr>{shipment.grossWeightKg}</Ltr> {t.kilograms}
                </>
              ) : (
                t.notGiven
              )}
            </dd>
          </div>
          <div>
            <dt>{t.pieces}</dt>
            <dd>{shipment.pieces !== null ? <Ltr>{shipment.pieces}</Ltr> : t.notGiven}</dd>
          </div>
          <div>
            <dt>{t.packaging}</dt>
            <dd>{text(shipment.packaging)}</dd>
          </div>
          <div>
            <dt>{t.equipmentNeeded}</dt>
            <dd>{text(shipment.equipmentNeeded)}</dd>
          </div>
          <div>
            <dt>{t.created}</dt>
            <dd>
              <Ltr>{when(shipment.createdAt)}</Ltr>
            </dd>
          </div>
          <div>
            <dt>{t.changed}</dt>
            <dd>
              <Ltr>{when(shipment.updatedAt)}</Ltr>
            </dd>
          </div>
        </dl>
        {placeFacts(shipment.pickup, t.sectionPickup, 'pickup')}
        {placeFacts(shipment.delivery, t.sectionDelivery, 'delivery')}
      </section>
      {open ? (
        <section className="section" aria-labelledby="edit-title">
          <h2 id="edit-title">{t.editTitle}</h2>
          {choices.some((place) => place.fixture) ? (
            <p className="notice notice-development" role="note" id="fixture-notice">
              {t.fixtureNotice}
            </p>
          ) : null}
          <form className="form card" id={formId} action={updateShipmentAction} noValidate>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organisationId" value={id} />
            <input type="hidden" name="shipmentId" value={shipment.id} />
            <input type="hidden" name="version" value={shipment.version} />
            <input type="hidden" name="retryKey" value={key('retry')} />
            <ShipmentFields
              locale={locale}
              t={t}
              places={choices}
              current={shipment}
              problems={found}
            />
            {/* Set in this browser when what the form holds was typed against an earlier
                version. The action then saves only on the explicit overwrite choice. */}
            <input type="hidden" name="carriedFrom" data-draft defaultValue={fallbackScope ?? ''} />
            {conflict ? (
              <button
                className="button button-danger"
                type="submit"
                name="intent"
                value="overwrite"
                id="overwrite-shipment"
              >
                {t.overwrite}
              </button>
            ) : (
              <button className="button button-primary" type="submit" id="save-shipment">
                {t.submitSave}
              </button>
            )}
          </form>
        </section>
      ) : null}
      {open ? (
        <section className="section" aria-labelledby="discard-title">
          <h2 id="discard-title">{t.discard}</h2>
          <form className="form card" id="discard-form" action={discardShipmentAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="organisationId" value={id} />
            <input type="hidden" name="shipmentId" value={shipment.id} />
            <input type="hidden" name="version" value={shipment.version} />
            <input type="hidden" name="retryKey" value={key('discardRetry')} />
            <p>{t.discardNote}</p>
            <button className="button button-danger" type="submit" id="discard-shipment">
              {t.discard}
            </button>
          </form>
        </section>
      ) : null}
      {done === 'created' ? <DraftKeeper formId={`shipment-new-form-${id}`} clear /> : null}
      {open ? (
        <DraftKeeper
          key={`${shipment.version}-${dropDraft}-${fallbackScope ?? ''}`}
          formId={formId}
          scope={`v${shipment.version}`}
          overwrite
          clear={dropDraft}
          {...(fallbackScope ? { fallbackScope, carriedField: 'carriedFrom' } : {})}
        />
      ) : null}
    </div>
  );
}
