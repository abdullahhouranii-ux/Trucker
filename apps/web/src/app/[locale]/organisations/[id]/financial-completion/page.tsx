import { notFound, redirect } from 'next/navigation';
import {
  BookingCompletionPanel,
  type ClosureStatus,
  type FinancialCompletion,
} from '../../../../../components/booking-completion.tsx';
import { financialNavigation } from '../../../../../components/booking-completion-labels.ts';
import { isLocale, type Locale } from '../../../../../i18n/config.ts';
import { api } from '../../../../../server/api.ts';
import { sendCompletion } from '../../../../../server/booking-completion.ts';
import { requirePerson } from '../../../../../server/session.ts';

export default async function OrganisationFinancialCompletion({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!isLocale(locale) || !uuid.test(id)) notFound();
  const language: Locale = locale;
  const session = await requirePerson(language);
  const booking = (await searchParams).booking;
  if (booking !== undefined && (typeof booking !== 'string' || !uuid.test(booking))) notFound();
  const paths = `/organisations/${id}`;
  const records = `${paths}/financial-completion`;
  const path = `${paths}/bookings/${booking ?? ''}/financial-completion`;
  const [list, financial, closure] = await Promise.all([
    api<{ bookingId: string; acceptedAt: string }[]>('GET', records, { token: session.token }),
    booking ? api<FinancialCompletion>('GET', path, { token: session.token }) : null,
    booking
      ? api<ClosureStatus>('GET', `${paths}/bookings/${booking}/closure`, { token: session.token })
      : null,
  ]);
  if ((!list.ok && list.status === 401) || (financial && !financial.ok && financial.status === 401))
    redirect(`/${language}/sign-in?error=session_ended`);
  if ((!list.ok && list.status === 404) || (financial && !financial.ok && financial.status === 404))
    notFound();
  async function submit(key: string, body: Record<string, unknown>) {
    'use server';
    const fresh = await requirePerson(language);
    return sendCompletion(path, fresh.token, key, body);
  }
  const t = financialNavigation[language];
  return (
    <div className="page page-narrow">
      <h1>{t.title}</h1>
      {!list.ok ? (
        <p role="alert">{t.unavailable}</p>
      ) : !list.data.length ? (
        <p>{t.empty}</p>
      ) : (
        <ul className="organisation-list record-collection">
          {list.data.map((item) => (
            <li className="card" key={item.bookingId}>
              <a
                href={`/${language}${records}?booking=${item.bookingId}`}
                className="button"
                aria-current={booking === item.bookingId ? 'page' : undefined}
              >
                <bdi dir="ltr">{item.bookingId}</bdi>
              </a>{' '}
              · <time dateTime={item.acceptedAt}>{item.acceptedAt.slice(0, 10)}</time>
            </li>
          ))}
        </ul>
      )}
      {financial?.ok ? (
        <BookingCompletionPanel
          financial={financial.data}
          closure={closure?.ok ? closure.data : null}
          locale={language}
          submit={submit}
        />
      ) : financial ? (
        <p role="alert">{t.unavailable}</p>
      ) : null}
    </div>
  );
}
