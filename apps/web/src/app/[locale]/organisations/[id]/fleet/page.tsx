import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../../components/draft-keeper.tsx';
import { EligibilityTag, fleetProblems } from '../../../../../components/fleet-view.tsx';
import { describedBy, ErrorSummary, Field } from '../../../../../components/form.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import { api, type Catalogues, type Country, type Fleet } from '../../../../../server/api.ts';
import {
  authoriseDriverAction,
  endAffiliationAction,
  inviteDriverAction,
  registerVehicleAction,
} from '../../../../../server/fleet-actions.ts';
import { requirePerson } from '../../../../../server/session.ts';

// The carrier's vehicles and drivers. Recording them reserves and assigns nothing; a
// registration is a claim of ownership until staff verify it.

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;

export default async function FleetPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  const search = await searchParams;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.fleet;
  const one = (name: string): string => {
    const value = search[name];
    return typeof value === 'string' ? value : '';
  };
  const keyFor = (operation: string): string => {
    const value = one(`${operation}Retry`);
    return RETRY_KEY.test(value) ? value : randomUUID();
  };
  const person = await requirePerson(locale);
  // An unconfirmed session is not an ended one: the requests fail as unavailable or with 401.
  const [reply, countries, catalogues] = await Promise.all([
    api<{ fleet: Fleet }>('GET', `/organisations/${id}/fleet`, { token: person.token }),
    api<{ countries: Country[] }>('GET', '/registration/countries', { token: person.token }),
    api<Catalogues>('GET', `/organisations/${id}/shipment-catalogues`, { token: person.token }),
  ]);
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (!reply.ok && reply.status === 404) notFound();
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-carrier" href={`/${locale}/organisations/${id}/carrier`}>
        {t.backToCarrier}
      </a>
    </div>
  );
  if (!reply.ok)
    return (
      <div className="page page-narrow" data-state={`fleet-${reply.code}`}>
        {back}
        <h1>{t.title}</h1>
        <ErrorSummary
          title={m.auth.errors.summary}
          problems={[
            {
              message:
                reply.code === 'carrier_not_eligible'
                  ? t.errors.carrier_not_eligible
                  : t.errors.unavailable,
            },
          ]}
        />
      </div>
    );
  const fleet = reply.data.fleet;
  const at = one('fAt');
  const { errors, summary } = fleetProblems(t, one('fError'));
  const errorsAt = (operation: string) => (at === operation ? errors : new Map<string, string>());
  const done = one('fDone');
  const confirmation = done ? (t.done as Record<string, string>)[done] : undefined;
  const categories = fleet.registers.categories ?? [];
  const equipment = catalogues.ok ? catalogues.data.equipmentTypes : [];
  const vehicleCountries = [
    ...new Set(
      (fleet.registers.documentTypes ?? [])
        .filter((type) => type.subject !== 'driver')
        .map((type) => type.country),
    ),
  ];
  const countryName = (code: string): string =>
    (countries.ok ? countries.data.countries.find((country) => country.code === code) : undefined)
      ?.name[locale] ?? code;
  const hidden = (operation: string) => (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organisationId" value={id} />
      <input type="hidden" name="retryKey" value={keyFor(operation)} />
    </>
  );
  const vehicleErrors = errorsAt('vehicle');
  const inviteErrors = errorsAt('invite');
  const select = (
    name: string,
    label: string,
    options: { value: string; label: string }[],
    hint?: string,
  ) => (
    <Field id={name} label={label} hint={hint} error={vehicleErrors.get(name)}>
      <select
        id={name}
        name={name}
        defaultValue=""
        data-draft
        aria-invalid={vehicleErrors.has(name) ? true : undefined}
        aria-describedby={describedBy(name, Boolean(hint), vehicleErrors.has(name))}
      >
        <option value="">{t.chooseOne}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div className="page page-narrow" data-state="fleet">
      {back}
      <h1>{t.title}</h1>
      <p className="notice" role="note" id="fleet-notice">
        {t.notice}
      </p>
      <ErrorSummary title={m.auth.errors.summary} problems={summary} />
      {confirmation && summary.length === 0 ? (
        <p className="notice notice-success" role="status" id="fleet-confirmation">
          {confirmation}
        </p>
      ) : null}
      {fleet.open ? (
        <p className="field-hint" id="fleet-fictional">
          {t.fictional}
        </p>
      ) : (
        <p className="notice" role="note" id="fleet-closed">
          {t.closed}
        </p>
      )}

      <section className="section" aria-labelledby="vehicles-title">
        <h2 id="vehicles-title">{t.vehiclesTitle}</h2>
        {fleet.vehicles.length === 0 ? (
          <p id="no-vehicles">{t.noVehicles}</p>
        ) : (
          <ol className="organisation-list" id="vehicle-list">
            {fleet.vehicles.map((vehicle) => (
              <li
                className="card organisation"
                key={vehicle.id}
                data-vehicle={vehicle.id}
                data-ownership={vehicle.ownership}
                data-status={vehicle.status}
              >
                <h3>
                  <bdi dir="ltr">{vehicle.registrationNumber}</bdi>
                </h3>
                <p>
                  {t.kinds[vehicle.kind]}
                  {', '}
                  <bdi>
                    {categories.find((item) => item.code === vehicle.category)?.name[locale] ??
                      vehicle.category}
                  </bdi>
                </p>
                {vehicle.status === 'retired' ? (
                  <p className="chip">{t.retired}</p>
                ) : (
                  <>
                    <p className="field-hint">{t.ownership[vehicle.ownership]}</p>
                    <EligibilityTag t={t} value={vehicle.eligibility} />
                  </>
                )}
                <a
                  className="button"
                  href={`/${locale}/organisations/${id}/fleet/vehicles/${vehicle.id}`}
                >
                  {t.openVehicle}
                </a>
              </li>
            ))}
          </ol>
        )}
        {fleet.open ? (
          <>
            <h3 id="vehicle-form-title">{t.registerTitle}</h3>
            <form className="form card" id="vehicle-form" action={registerVehicleAction}>
              {hidden('vehicle')}
              {select('kind', t.kind, [
                { value: 'truck', label: t.kinds.truck },
                { value: 'trailer', label: t.kinds.trailer },
              ])}
              {select(
                'category',
                t.category,
                categories.map((item) => ({
                  value: item.code,
                  label: `${item.name[locale]} (${t.kinds[item.kind]})`,
                })),
              )}
              {select(
                'equipmentType',
                t.equipmentType,
                equipment.map((item) => ({ value: item.code, label: item.name[locale] })),
              )}
              {select(
                'registrationCountry',
                t.registrationCountry,
                vehicleCountries.map((code) => ({ value: code, label: countryName(code) })),
              )}
              <Field
                id="registrationNumber"
                label={t.registrationNumber}
                hint={t.registrationHint}
                error={vehicleErrors.get('registrationNumber')}
              >
                <input
                  id="registrationNumber"
                  name="registrationNumber"
                  type="text"
                  dir="ltr"
                  autoComplete="off"
                  maxLength={30}
                  data-draft
                  aria-invalid={vehicleErrors.has('registrationNumber') ? true : undefined}
                  aria-describedby={describedBy(
                    'registrationNumber',
                    true,
                    vehicleErrors.has('registrationNumber'),
                  )}
                />
              </Field>
              <button className="button button-primary" type="submit" id="register-vehicle">
                {t.register}
              </button>
            </form>
          </>
        ) : null}
      </section>

      <section className="section" aria-labelledby="drivers-title">
        <h2 id="drivers-title">{t.driversTitle}</h2>
        <p className="field-hint" id="driver-documents-note">
          {t.driverDocumentsNote}
        </p>
        {fleet.drivers.length === 0 ? (
          <p id="no-drivers">{t.noDrivers}</p>
        ) : (
          <ol className="organisation-list" id="driver-list">
            {fleet.drivers.map((driver) => {
              const all = driver.authorisations?.some((item) => !item.vehicleId) ?? false;
              return (
                <li
                  className="card organisation"
                  key={driver.id}
                  data-driver={driver.id}
                  data-status={driver.status}
                >
                  <h3>
                    {driver.name ? <bdi>{driver.name}</bdi> : null}{' '}
                    <bdi dir="ltr">{driver.phone}</bdi>
                  </h3>
                  <p className="chip">{t.driverStatus[driver.status]}</p>
                  {driver.status === 'active' && driver.eligibility ? (
                    <>
                      <EligibilityTag t={t} value={driver.eligibility} />
                      <p className="field-hint" data-authorised={all ? 'all' : 'none'}>
                        {all ? t.authorisedAll : t.notAuthorised}
                      </p>
                      <form className="form-inline" action={authoriseDriverAction}>
                        {hidden('authorise')}
                        <input type="hidden" name="affiliationId" value={driver.id} />
                        <input type="hidden" name="granted" value={all ? 'no' : 'yes'} />
                        <button className="button" type="submit" data-authorise={driver.id}>
                          {all ? t.revokeAll : t.authoriseAll}
                        </button>
                      </form>
                    </>
                  ) : null}
                  {driver.status === 'active' || driver.status === 'invited' ? (
                    <form className="form-inline" action={endAffiliationAction}>
                      {hidden('end')}
                      <input type="hidden" name="affiliationId" value={driver.id} />
                      <input type="hidden" name="version" value={driver.version} />
                      <button className="button" type="submit" data-end={driver.id}>
                        {driver.status === 'active' ? t.endAffiliation : t.cancelInvitation}
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        <h3 id="invite-form-title">{t.inviteTitle}</h3>
        <form className="form card" id="invite-form" action={inviteDriverAction}>
          {hidden('invite')}
          <Field id="phone" label={t.phone} hint={t.phoneHint} error={inviteErrors.get('phone')}>
            <input
              id="phone"
              name="phone"
              type="tel"
              dir="ltr"
              autoComplete="off"
              maxLength={20}
              data-draft
              aria-invalid={inviteErrors.has('phone') ? true : undefined}
              aria-describedby={describedBy('phone', true, inviteErrors.has('phone'))}
            />
          </Field>
          <p className="field-hint" id="invite-note">
            {t.inviteNote}
          </p>
          <button className="button button-primary" type="submit" id="invite-driver">
            {t.invite}
          </button>
        </form>
      </section>
      {fleet.open ? (
        <DraftKeeper formId="vehicle-form" scope={`fleet-vehicle-${id}`} clear={done !== ''} />
      ) : null}
      <DraftKeeper formId="invite-form" scope={`fleet-invite-${id}`} clear={done !== ''} />
    </div>
  );
}
