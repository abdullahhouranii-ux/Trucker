import { Ltr } from './ltr.tsx';
import { offsetText } from './shipment-form.tsx';
import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import type {
  Catalogues,
  CarrierPlace,
  CarrierView,
  PublicationRecord,
  Shipment,
} from '../server/api.ts';

type P = Messages['pub'];
const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const nameOf = (
  entries: { code: string; name: Record<Locale, string> }[],
  code: string | null,
  locale: Locale,
): string => (code ? (entries.find((entry) => entry.code === code)?.name[locale] ?? code) : '');

/** A wall-clock time at a place, with its zone and offset, read left to right. */
function LocalTime({ local, zone, offset }: { local: string; zone: string; offset: number }) {
  return (
    <Ltr>
      {local.replace('T', ' ')} ({zone}, {offsetText(offset)})
    </Ltr>
  );
}

/** The publication's own facts: version, deadline, the details given, and every version. */
export function PublicationFacts({
  locale,
  t,
  shipment,
  record,
  catalogues,
}: {
  locale: Locale;
  t: P;
  shipment: Shipment;
  record: PublicationRecord;
  catalogues: Catalogues;
}) {
  const p = shipment.publication;
  return (
    <section className="section" aria-labelledby="publication-title">
      <h2 id="publication-title">{t.factsTitle}</h2>
      <dl className="card facts" id="publication-facts">
        <div>
          <dt>{t.versionsTitle}</dt>
          <dd>{t.version.replace('{n}', String(p.publishedVersion))}</dd>
        </div>
        <div>
          <dt>{t.deadline}</dt>
          <dd>
            {p.quotationDeadline.local &&
            shipment.pickup.timeZone &&
            p.quotationDeadline.offsetMinutes !== null ? (
              <LocalTime
                local={p.quotationDeadline.local}
                zone={shipment.pickup.timeZone}
                offset={p.quotationDeadline.offsetMinutes}
              />
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt>{t.cargoCategory}</dt>
          <dd>{nameOf(catalogues.cargoCategories, p.cargoCategory, locale)}</dd>
        </div>
        <div>
          <dt>{t.equipmentType}</dt>
          <dd>{nameOf(catalogues.equipmentTypes, p.equipmentType, locale)}</dd>
        </div>
        <div>
          <dt>{t.dangerousGoods}</dt>
          <dd>{p.dangerousGoods ? t.dangerousYes : t.dangerousNo}</dd>
        </div>
        <div>
          <dt>{t.pickupArea}</dt>
          <dd>
            <bdi>{p.pickupArea}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t.deliveryArea}</dt>
          <dd>
            <bdi>{p.deliveryArea}</bdi>
          </dd>
        </div>
      </dl>
      <h3 id="versions-title">{t.versionsTitle}</h3>
      <ol className="evidence" id="published-versions" aria-labelledby="versions-title">
        {record.versions.map((version) => (
          <li key={version.versionNo} data-version={version.versionNo}>
            {t.version.replace('{n}', String(version.versionNo))}: {t.kind[version.kind]},{' '}
            <Ltr>{when(version.createdAt)}</Ltr>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What carriers would see, shown to the shipper with what it hides and what it cannot. */
export function CarrierPreview({
  locale,
  t,
  view,
  countryName,
  catalogues,
}: {
  locale: Locale;
  t: P;
  view: CarrierView;
  countryName: (code: string) => string;
  catalogues: Catalogues;
}) {
  const place = (title: string, value: CarrierPlace, id: string) => (
    <div>
      <dt>{title}</dt>
      <dd id={id}>
        <bdi>{value.area}</bdi>, <bdi>{countryName(value.countryCode)}</bdi>
        <br />
        {t.window}:{' '}
        <LocalTime
          local={value.from.local}
          zone={value.timeZone}
          offset={value.from.offsetMinutes}
        />{' '}
        –{' '}
        <LocalTime
          local={value.until.local}
          zone={value.timeZone}
          offset={value.until.offsetMinutes}
        />
      </dd>
    </div>
  );
  return (
    <section className="section" aria-labelledby="preview-title">
      <h2 id="preview-title">{t.previewTitle}</h2>
      <p className="notice" role="note" id="preview-lead">
        {t.previewLead}
      </p>
      <dl className="card facts" id="carrier-preview" data-state={view.state}>
        <div>
          <dt>{t.lane}</dt>
          <dd>
            <bdi>{countryName(view.lane.origin)}</bdi> {locale === 'en' ? '→' : '←'}{' '}
            <bdi>{countryName(view.lane.destination)}</bdi>
            {view.lane.transit.length > 0 ? (
              <>
                {' '}
                (<bdi>{view.lane.transit.map(countryName).join(', ')}</bdi>)
              </>
            ) : null}
          </dd>
        </div>
        {place(t.pickupArea, view.pickup, 'preview-pickup')}
        {place(t.deliveryArea, view.delivery, 'preview-delivery')}
        <div>
          <dt>{t.cargo}</dt>
          <dd id="preview-cargo">
            {nameOf(catalogues.cargoCategories, view.cargo.category, locale)}
            {view.cargo.description ? (
              <>
                : <bdi>{view.cargo.description}</bdi>
              </>
            ) : null}
            {view.cargo.grossWeightKg ? (
              <>
                , <Ltr>{view.cargo.grossWeightKg} kg</Ltr>
              </>
            ) : null}
            {view.cargo.pieces !== null ? (
              <>
                , <Ltr>{view.cargo.pieces}</Ltr>
              </>
            ) : null}
            {view.cargo.packaging ? (
              <>
                , <bdi>{view.cargo.packaging}</bdi>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t.equipmentType}</dt>
          <dd>
            {nameOf(catalogues.equipmentTypes, view.equipment.type, locale)}
            {view.equipment.notes ? (
              <>
                {' '}
                ({t.equipmentNotes}: <bdi>{view.equipment.notes}</bdi>)
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t.dangerousGoods}</dt>
          <dd>{view.dangerousGoods ? t.dangerousYes : t.dangerousNo}</dd>
        </div>
        <div>
          <dt>{t.deadline}</dt>
          <dd>
            <LocalTime
              local={view.quotationDeadline.local}
              zone={view.quotationDeadline.timeZone}
              offset={view.quotationDeadline.offsetMinutes}
            />
          </dd>
        </div>
        <div>
          <dt>{t.shipper}</dt>
          <dd>{t.verifiedShipper}</dd>
        </div>
      </dl>
      <p id="preview-hidden">{t.previewHidden}</p>
      <p className="notice notice-warning" role="note" id="preview-caution">
        {t.previewCaution}
      </p>
    </section>
  );
}
