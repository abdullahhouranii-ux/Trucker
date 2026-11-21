import { RecordPhotos } from '../../../../../../../components/record-photos.tsx';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { DraftKeeper } from '../../../../../../../components/draft-keeper.tsx';
import {
  DocumentFields,
  DocumentList,
  EligibilityTag,
  fleetProblems,
} from '../../../../../../../components/fleet-view.tsx';
import { ErrorSummary } from '../../../../../../../components/form.tsx';
import { isLocale } from '../../../../../../../i18n/config.ts';
import { getMessages } from '../../../../../../../i18n/messages.ts';
import { api, type Country, type Fleet } from '../../../../../../../server/api.ts';
import {
  retireVehicleAction,
  submitVehicleDocumentAction,
} from '../../../../../../../server/fleet-actions.ts';
import { requirePerson } from '../../../../../../../server/session.ts';

// One vehicle of the carrier: its ownership claim, its documents and whether it is eligible now.

type Props = {
  params: Promise<{ locale: string; id: string; vehicleId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY_KEY = /^[A-Za-z0-9._-]{16,128}$/;

export default async function VehiclePage({ params, searchParams }: Props) {
  const { locale, id, vehicleId } = await params;
  const search = await searchParams;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id) || !UUID.test(vehicleId)) notFound();
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
  const [reply, countries] = await Promise.all([
    api<{ fleet: Fleet }>('GET', `/organisations/${id}/fleet`, { token: person.token }),
    api<{ countries: Country[] }>('GET', '/registration/countries', { token: person.token }),
  ]);
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (!reply.ok && reply.status === 404) notFound();
  const list = `/${locale}/organisations/${id}/fleet`;
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-fleet" href={list}>
        {t.backToFleet}
      </a>
    </div>
  );
  if (!reply.ok)
    return (
      <div className="page page-narrow" data-state={`vehicle-${reply.code}`}>
        {back}
        <h1>{t.vehicleTitle}</h1>
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
  const vehicle = fleet.vehicles.find((item) => item.id === vehicleId.toLowerCase());
  if (!vehicle) notFound();
  const { errors, summary } = fleetProblems(t, one('fError'));
  const done = one('fDone');
  const confirmation = done ? (t.done as Record<string, string>)[done] : undefined;
  const types = (fleet.registers.documentTypes ?? []).filter(
    (type) => type.country === vehicle.registrationCountry && type.subject === vehicle.kind,
  );
  const category =
    (fleet.registers.categories ?? []).find((item) => item.code === vehicle.category)?.name[
      locale
    ] ?? vehicle.category;
  const hidden = (operation: string) => (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="organisationId" value={id} />
      <input type="hidden" name="vehicleId" value={vehicle.id} />
      <input type="hidden" name="retryKey" value={keyFor(operation)} />
    </>
  );
  return (
    <div className="page page-narrow" data-state="vehicle" data-status={vehicle.status}>
      {back}
      <h1>
        {t.vehicleTitle} <bdi dir="ltr">{vehicle.registrationNumber}</bdi>
      </h1>
      <ErrorSummary title={m.auth.errors.summary} problems={summary} />
      {confirmation && summary.length === 0 ? (
        <p className="notice notice-success" role="status" id="fleet-confirmation">
          {confirmation}
        </p>
      ) : null}
      <section className="card" id="vehicle-facts" data-ownership={vehicle.ownership}>
        <p>
          {t.kinds[vehicle.kind]}
          {', '}
          <bdi>{category}</bdi>
        </p>
        {vehicle.status === 'retired' ? (
          <p className="chip" id="vehicle-retired">
            {t.retired}
          </p>
        ) : (
          <>
            <p className="notice" role="note" id="ownership-note">
              {t.ownership[vehicle.ownership]}
            </p>
            <EligibilityTag t={t} value={vehicle.eligibility} id="vehicle-eligibility" />
          </>
        )}
      </section>
      <section className="section" aria-labelledby="documents-title">
        <h2 id="documents-title">{t.documentsTitle}</h2>
        <DocumentList
          t={t}
          locale={locale}
          documents={vehicle.documents}
          types={types}
          id="document-list"
        />
        {vehicle.status === 'active' && fleet.open ? (
          <>
            <h3 id="document-form-title">{t.addDocumentTitle}</h3>
            <p className="field-hint" id="fleet-fictional">
              {t.fictional}
            </p>
            <form className="form card" id="document-form" action={submitVehicleDocumentAction}>
              {hidden('document')}
              <DocumentFields
                t={t}
                locale={locale}
                types={types}
                countries={countries.ok ? countries.data.countries : []}
                licenceClasses={[]}
                errors={errors}
                submit={
                  <button className="button button-primary" type="submit" id="submit-document">
                    {t.submitDocument}
                  </button>
                }
              />
            </form>
            <DraftKeeper
              formId="document-form"
              scope={`fleet-document-${vehicle.id}`}
              clear={done !== ''}
            />
          </>
        ) : null}
      </section>
      <RecordPhotos
        endpoint={'/' + locale + '/files/record-photos/' + id + '/vehicles/' + vehicleId}
        copy={m.recordPhotos}
        editable={vehicle.status === 'active'}
      />
      {vehicle.status === 'active' ? (
        <form className="form-inline" id="retire-form" action={retireVehicleAction}>
          {hidden('retire')}
          <input type="hidden" name="version" value={vehicle.version} />
          <button className="button" type="submit" id="retire-vehicle">
            {t.retire}
          </button>
        </form>
      ) : null}
    </div>
  );
}
