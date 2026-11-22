import {
  FeeInvoiceDraftPanel,
  type FeeInvoiceDraftResponse,
} from '../../../../../web/src/components/fee-invoice-draft.tsx';
import {
  BookingCompletionPanel,
  type FinancialCompletion,
} from '../../../../../web/src/components/booking-completion.tsx';
import { Field } from '../../../../../web/src/components/form.tsx';
import { api } from '../../../../../web/src/server/api.ts';
import { sendCompletion } from '../../../../../web/src/server/booking-completion.ts';
import { ConsoleHeader } from '../../../components/console-header.tsx';
import { requireStaff, staffToken } from '../../../server/session.ts';

export default async function FinancialCompletionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const found = await requireStaff();
  const booking = (await searchParams).booking;
  const id = typeof booking === 'string' && /^[0-9a-f-]{36}$/i.test(booking) ? booking : '';
  const path = `/staff/operations/bookings/${id}/financial-completion`;
  const permitted = found.state === 'signed-in' && found.staff.privileges.includes('staff_admin');
  const [financial, invoice] =
    permitted && id
      ? await Promise.all([
          api<FinancialCompletion>('GET', path, { token: found.token }),
          api<FeeInvoiceDraftResponse>(
            'GET',
            `/staff/operations/bookings/${id}/fee-invoice-draft`,
            { token: found.token },
          ),
        ])
      : [null, null];
  async function submit(key: string, body: Record<string, unknown>) {
    'use server';
    return sendCompletion(path, await staffToken(), key, body);
  }
  return (
    <>
      <ConsoleHeader
        {...(found.state === 'signed-in' ? { staff: found.staff } : {})}
        current="/finance"
      />
      <main id="main" tabIndex={-1} className="page page-narrow">
        <h1>Booking financial records</h1>
        <a className="button" href="/finance">
          Back to finance
        </a>
        {permitted ? (
          <>
            <form method="get" className="form-inline">
              <Field id="booking" label="Booking identifier">
                <input id="booking" name="booking" type="text" required defaultValue={id} />
              </Field>
              <button type="submit" className="button">
                Find booking
              </button>
            </form>
            {financial?.ok ? (
              <p>
                <a className="button" href={`/operations/bookings/${id}#operational-closure`}>
                  Review operational closure
                </a>
              </p>
            ) : null}
            {invoice?.ok ? <FeeInvoiceDraftPanel draft={invoice.data.draft} locale="en" /> : null}
            {financial?.ok ? (
              <BookingCompletionPanel
                financial={financial.data}
                locale="en"
                submit={submit}
                staffId={found.staff.id}
              />
            ) : null}
            {booking && !financial?.ok ? (
              <p role="alert">The booking financial record is unavailable.</p>
            ) : null}
          </>
        ) : (
          <p role="alert">An active staff administrator session is required.</p>
        )}
      </main>
    </>
  );
}
