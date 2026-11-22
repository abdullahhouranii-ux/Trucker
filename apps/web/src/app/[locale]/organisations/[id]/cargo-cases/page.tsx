import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { CargoPanel } from '../../../../../components/cargo-panel.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import { api, type TripCargo } from '../../../../../server/api.ts';
import { cargoAction } from '../../../../../server/assignment-actions.ts';
import { requirePerson } from '../../../../../server/session.ts';

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRY = /^[A-Za-z0-9._-]{16,128}$/;

interface OrganiserCase {
  bookingId: string;
  shipper: string | null;
  delivery: string | null;
  currency: string;
  cargo: TripCargo;
}

/**
 * Undeliverable cargo on bookings an organiser arranged, where the customer gave it a mandate
 * (slice 18d). The organiser instructs only within the mandate in force; the server checks it
 * again at every step.
 */
export default async function CargoCasesPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const c = m.cargo;
  const search = await searchParams;
  const one = (name: string): string =>
    typeof search[name] === 'string' ? (search[name] as string) : '';
  const person = await requirePerson(locale);
  const reply =
    person.state === 'signed-in'
      ? await api<{ cases: OrganiserCase[] }>('GET', `/organisations/${id}/cargo-cases`, {
          token: person.token,
        })
      : undefined;
  if (reply && !reply.ok && reply.status === 401)
    redirect(`/${locale}/sign-in?error=session_ended`);
  const back = (
    <div className="form-inline">
      <a className="button" id="back-to-organisation" href={`/${locale}/organisations/${id}`}>
        {m.roles.back}
      </a>
    </div>
  );
  if (!reply?.ok) {
    return (
      <div className="page page-narrow" data-state="cargo-cases-unavailable">
        {back}
        <h1>{c.casesTitle}</h1>
        <p className="notice notice-error" role="alert">
          {m.roles.errors.unavailable}
        </p>
      </div>
    );
  }
  const error = one('aError');
  const done = one('aDone');
  const cargoKey = (): string =>
    error === 'cargo_unconfirmed' && RETRY.test(one('aKey')) ? one('aKey') : randomUUID();
  const now = Date.now();
  return (
    <div className="page page-narrow" data-state="cargo-cases">
      {back}
      <h1>{c.casesTitle}</h1>
      {error ? (
        <p className="notice notice-error" role="alert" id="cargo-error">
          {(c.errors as Record<string, string>)[error] ??
            (m.asg.errors as Record<string, string>)[error] ??
            m.asg.errors.invalid}
        </p>
      ) : done.startsWith('cargo_') ? (
        <p className="notice notice-success" role="status" id="cargo-done">
          {(c.done as Record<string, string>)[done.slice('cargo_'.length)]}
        </p>
      ) : null}
      {reply.data.cases.length === 0 ? <p id="cargo-cases-none">{c.casesNone}</p> : null}
      <div className="record-collection">
        {reply.data.cases.map((item) => {
          // Whether this organisation's mandate covers anything now; the server decides again.
          const inForce = (item.cargo.authorities ?? []).some(
            (authority) =>
              authority.holderRole === 'organiser' &&
              authority.endedAt === null &&
              (authority.validUntil === null || new Date(authority.validUntil).getTime() > now),
          );
          return (
            <section key={item.bookingId} className="card" data-booking={item.bookingId}>
              <h2>
                {c.openBooking}: <bdi>{item.shipper ?? ''}</bdi>
                {item.delivery ? (
                  <>
                    {' '}
                    (<bdi>{item.delivery}</bdi>)
                  </>
                ) : null}
              </h2>
              <CargoPanel
                c={c}
                cargo={item.cargo}
                side="organiser"
                action={cargoAction}
                retryKey={cargoKey}
                canInstruct={inForce}
                hidden={
                  <>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="organisationId" value={id} />
                    <input type="hidden" name="bookingId" value={item.bookingId} />
                    <input type="hidden" name="returnTo" value="cases" />
                  </>
                }
              />
            </section>
          );
        })}
      </div>
    </div>
  );
}
