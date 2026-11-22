import { notFound, redirect } from 'next/navigation';
import { ErrorSummary } from '../../../../../components/form.tsx';
import { Ltr } from '../../../../../components/ltr.tsx';
import { offsetText } from '../../../../../components/shipment-form.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import {
  api,
  type Catalogues,
  type Country,
  type DiscoveryPage,
} from '../../../../../server/api.ts';
import { requirePerson } from '../../../../../server/session.ts';

// Shipments this carrier may discover, judged by the server at this request. Nothing here is
// kept between requests: a page is a fresh answer, and "next" is a position, not a permission.
// Matching uses the service the carrier declared and staff decided: matching criteria, not
// verified vehicles, availability or permission to accept work. No quotation exists yet.

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY = /^[A-Z]{2}$/;
const EQUIPMENT = /^[a-z][a-z0-9_]{1,39}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2000}$/;

export default async function DiscoverPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.disc;
  const search = await searchParams;
  const pick = (name: string, pattern: RegExp): string | undefined => {
    const value = search[name];
    return typeof value === 'string' && pattern.test(value) ? value : undefined;
  };
  const filter = {
    pickupCountry: pick('pickupCountry', COUNTRY),
    deliveryCountry: pick('deliveryCountry', COUNTRY),
    equipmentType: pick('equipmentType', EQUIPMENT),
  };
  const cursor = pick('cursor', CURSOR);
  const query = (extra: Record<string, string | undefined> = {}): string => {
    const values = Object.entries({ ...filter, ...extra }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    return new URLSearchParams(values).toString();
  };
  const here = `/${locale}/organisations/${id}/discover`;

  const person = await requirePerson(locale);
  if (person.state !== 'signed-in') redirect(`/${locale}/sign-in?error=session_ended`);
  const [reply, countries, catalogues] = await Promise.all([
    api<DiscoveryPage>('GET', `/organisations/${id}/discovery/shipments?${query({ cursor })}`, {
      token: person.token,
    }),
    api<{ countries: Country[] }>('GET', '/registration/countries', { token: person.token }),
    api<Catalogues>('GET', `/organisations/${id}/shipment-catalogues`, { token: person.token }),
  ]);
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (!reply.ok && reply.status === 404) notFound();
  const countryName = (code: string): string =>
    (countries.ok ? countries.data.countries : []).find((country) => country.code === code)?.name[
      locale
    ] ?? code;
  const equipmentName = (code: string): string =>
    (catalogues.ok ? catalogues.data.equipmentTypes : []).find((entry) => entry.code === code)
      ?.name[locale] ?? code;
  const categoryName = (code: string): string =>
    (catalogues.ok ? catalogues.data.cargoCategories : []).find((entry) => entry.code === code)
      ?.name[locale] ?? code;

  const header = (
    <>
      <div className="form-inline">
        <a className="button" id="back-to-organisation" href={`/${locale}/organisations/${id}`}>
          {t.back}
        </a>
      </div>
      <h1>{t.title}</h1>
      <p>{t.lead}</p>
      <p className="notice" role="note" id="matching-note">
        {m.carrier.matchingNote}
      </p>
      <p className="notice" role="note" id="no-quotations">
        {t.noQuotations}
      </p>
    </>
  );

  if (!reply.ok) {
    const code = reply.code;
    const known = ['carrier_not_eligible', 'too_many_requests', 'cursor_invalid', 'cursor_expired'];
    const message = known.includes(code)
      ? t.errors[code as keyof typeof t.errors]
      : t.errors.unavailable;
    return (
      <div className="page" data-state={`discovery-${known.includes(code) ? code : 'unavailable'}`}>
        {header}
        <ErrorSummary title={m.auth.errors.summary} problems={[{ message }]} />
        <div className="form-inline">
          {code === 'carrier_not_eligible' ? (
            <a className="button" id="open-carrier" href={`/${locale}/organisations/${id}/carrier`}>
              {t.toCarrier}
            </a>
          ) : (
            <a className="button" id="restart-list" href={`${here}?${query()}`}>
              {t.restart}
            </a>
          )}
        </div>
      </div>
    );
  }

  const page = reply.data;
  const select = (
    name: 'pickupCountry' | 'deliveryCountry' | 'equipmentType',
    label: string,
    options: { code: string; name: string }[],
  ) => (
    <div className="field">
      <label htmlFor={`filter-${name}`}>{label}</label>
      <select id={`filter-${name}`} name={name} defaultValue={filter[name] ?? ''}>
        <option value="">{t.any}</option>
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );
  const countryOptions = page.service.countries.map((code) => ({ code, name: countryName(code) }));
  const time = (value: { local: string; offsetMinutes: number }, zone: string) => (
    <Ltr>
      {value.local.replace('T', ' ')} ({zone}, {offsetText(value.offsetMinutes)})
    </Ltr>
  );

  return (
    <div className="page" data-state="discovery-list">
      {header}
      <section className="section" aria-labelledby="filter-title">
        <h2 id="filter-title">{t.filterTitle}</h2>
        <form className="form card filters" id="discovery-filter" method="get" action={here}>
          {select('pickupCountry', t.pickupCountry, countryOptions)}
          {select('deliveryCountry', t.deliveryCountry, countryOptions)}
          {select(
            'equipmentType',
            t.equipmentType,
            page.service.equipmentTypes.map((code) => ({ code, name: equipmentName(code) })),
          )}
          <div className="form-inline">
            <button className="button button-primary" type="submit" id="apply-filter">
              {t.apply}
            </button>
            <a className="button" href={here} id="clear-filter">
              {t.clear}
            </a>
          </div>
        </form>
      </section>
      <section className="section" aria-labelledby="results-title">
        <h2 id="results-title">{t.resultsTitle}</h2>
        {page.items.length === 0 ? (
          <p className="notice" role="status" id="discovery-empty">
            {cursor ? t.endOfList : t.empty}
          </p>
        ) : null}
        <ol className="organisation-list" id="discovery-list">
          {page.items.map((item) => {
            const s = item.shipment;
            return (
              <li className="card organisation" key={item.id} data-shipment={item.id}>
                <h3>
                  <bdi>{countryName(s.lane.origin)}</bdi> {locale === 'en' ? '→' : '←'}{' '}
                  <bdi>{countryName(s.lane.destination)}</bdi>
                </h3>
                {item.changedSinceStart ? (
                  <p className="chip" data-changed="true">
                    {t.changed}
                  </p>
                ) : null}
                <dl className="facts">
                  <div>
                    <dt>{m.pub.pickupArea}</dt>
                    <dd>
                      <bdi>{s.pickup.area}</bdi>, {time(s.pickup.from, s.pickup.timeZone)}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.pub.deliveryArea}</dt>
                    <dd>
                      <bdi>{s.delivery.area}</bdi>, {time(s.delivery.from, s.delivery.timeZone)}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.pub.cargo}</dt>
                    <dd>
                      {categoryName(s.cargo.category)}
                      {s.cargo.grossWeightKg ? (
                        <>
                          , <Ltr>{s.cargo.grossWeightKg} kg</Ltr>
                        </>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.pub.equipmentType}</dt>
                    <dd>{equipmentName(s.equipment.type)}</dd>
                  </div>
                  <div>
                    <dt>{m.pub.deadline}</dt>
                    <dd>{time(s.quotationDeadline, s.quotationDeadline.timeZone)}</dd>
                  </div>
                </dl>
                <a className="button" href={`${here}/${item.id}`} data-open={item.id}>
                  {t.open}
                </a>
              </li>
            );
          })}
        </ol>
        <div className="form-inline">
          {page.next ? (
            <a className="button" id="next-page" href={`${here}?${query({ cursor: page.next })}`}>
              {t.next}
            </a>
          ) : null}
          {cursor ? (
            <a className="button" id="restart-list" href={`${here}?${query()}`}>
              {t.restart}
            </a>
          ) : null}
        </div>
      </section>
    </div>
  );
}
