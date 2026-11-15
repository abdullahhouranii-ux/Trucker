import { notFound, redirect } from 'next/navigation';
import { BookingCard } from '../../../../../components/booking-view.tsx';
import { ErrorSummary } from '../../../../../components/form.tsx';
import { isLocale } from '../../../../../i18n/config.ts';
import { getMessages } from '../../../../../i18n/messages.ts';
import { api, type Booking } from '../../../../../server/api.ts';
import { requirePerson } from '../../../../../server/session.ts';

// The organisation's bookings, as shipper or as carrier, newest first. Both sides see the same
// figures. Each opens on its own page, where resources are assigned and decisions are made.

type Props = { params: Promise<{ locale: string; id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BookingsPage({ params }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  if (!UUID.test(id)) notFound();
  const m = getMessages(locale);
  const t = m.book;
  const person = await requirePerson(locale);
  // An unconfirmed session is not an ended one: the request fails as unavailable or with 401.
  const reply = await api<{ bookings: Booking[] }>('GET', `/organisations/${id}/bookings`, {
    token: person.token,
  });
  if (!reply.ok && reply.status === 401) redirect(`/${locale}/sign-in?error=session_ended`);
  if (!reply.ok && reply.status === 404) notFound();
  return (
    <div className="page page-narrow" data-state="bookings">
      <div className="form-inline">
        <a className="button" id="back-to-organisation" href={`/${locale}/organisations/${id}`}>
          {t.back}
        </a>
      </div>
      <h1>{t.title}</h1>
      {!reply.ok ? (
        <ErrorSummary title={m.auth.errors.summary} problems={[{ message: t.unavailable }]} />
      ) : reply.data.bookings.length === 0 ? (
        <p id="no-bookings">{t.noBookings}</p>
      ) : (
        <ol className="organisation-list" id="booking-list">
          {reply.data.bookings.map((booking) => (
            <li key={booking.id}>
              <BookingCard
                t={t}
                a={m.asg}
                locale={locale}
                booking={booking}
                href={`/${locale}/organisations/${id}/bookings/${booking.id}`}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
