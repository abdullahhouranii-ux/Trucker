import { notFound, redirect } from 'next/navigation';
import { api, type Booking } from '../../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../../components/console-header.tsx';
import { requireStaff } from '../../../server/session.ts';

/** Historical booking, by its own identifier rather than the shipment's latest booking. */
export default async function BookingRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const found = await requireStaff();
  if (found.state === 'unknown')
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref={`/bookings/${id}`} />
        </main>
      </>
    );
  const reply = await api<{ booking: Booking }>('GET', `/staff/bookings/${id}/detail`, {
    token: found.token,
  });
  if (!reply.ok && reply.status === 401) redirect('/sign-in?error=session_ended');
  if (!reply.ok && reply.status === 404) notFound();
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/bookings" />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow" data-state="booking-record">
          <a className="button" href="/bookings">
            Bookings
          </a>
          <h1>Booking record</h1>
          {!reply.ok ? (
            <p role="alert">
              {reply.status === 403
                ? 'This requires reviewer or administrator access.'
                : 'The record could not be read. Try again.'}
            </p>
          ) : (
            <>
              <p>Read-only historical record. Each view is audited.</p>
              <dl className="facts">
                <div>
                  <dt>Booking</dt>
                  <dd>
                    <bdi dir="ltr">{reply.data.booking.id}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{reply.data.booking.status.replace(/_/g, ' ')}</dd>
                </div>
                <div>
                  <dt>Shipper</dt>
                  <dd>
                    <bdi>{reply.data.booking.shipper.legalName}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>Carrier</dt>
                  <dd>
                    <bdi>{reply.data.booking.carrier.legalName}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>Original transport price</dt>
                  <dd>
                    <bdi dir="ltr">
                      {reply.data.booking.transportAmount} {reply.data.booking.currency}
                    </bdi>
                  </dd>
                </div>
                <div>
                  <dt>Accepted</dt>
                  <dd>{utc(reply.data.booking.acceptedAt)}</dd>
                </div>
              </dl>
              {reply.data.booking.cancellation ? (
                <section aria-labelledby="cancelled">
                  <h2 id="cancelled">Cancelled</h2>
                  <p>
                    {reply.data.booking.cancellation.party} —{' '}
                    {utc(reply.data.booking.cancellation.at)}
                  </p>
                  <p>{reply.data.booking.cancellation.reason.replace(/_/g, ' ')}</p>
                  {reply.data.booking.cancellation.note ? (
                    <p>
                      <bdi>{reply.data.booking.cancellation.note}</bdi>
                    </p>
                  ) : null}
                  <p>No cancellation charge was calculated or recorded.</p>
                </section>
              ) : null}
              <a className="button" href={`/shipments/${reply.data.booking.shipmentId}`}>
                Shipment and current booking
              </a>
            </>
          )}
        </div>
      </main>
    </>
  );
}
