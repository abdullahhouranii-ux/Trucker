import { notFound } from 'next/navigation';
import { Icon, type IconName } from '../../components/icons.tsx';
import { Ltr } from '../../components/ltr.tsx';
import { type Step, Steps } from '../../components/steps.tsx';
import { isLocale } from '../../i18n/config.ts';
import { getMessages } from '../../i18n/messages.ts';
import { api, type PublicShipmentPage } from '../../server/api.ts';
import { sessionToken } from '../../server/session.ts';

type HomeProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ shipmentAfter?: string }>;
};

const whoIcons: IconName[] = ['box', 'truck', 'key'];

export default async function HomePage({ params, searchParams }: HomeProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = getMessages(locale);
  const { shipmentAfter } = await searchParams;
  const after = typeof shipmentAfter === 'string' ? shipmentAfter : undefined;
  const path = after ? '/public/shipments?after=' + encodeURIComponent(after) : '/public/shipments';
  const [board, token] = await Promise.all([api<PublicShipmentPage>('GET', path), sessionToken()]);
  const countries = new Intl.DisplayNames(locale, { type: 'region' });
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  // An illustration of how a trip reads. The places and times are examples, not data.
  const times = ['06:40 Asia/Dubai', '11:15 Asia/Dubai', '12:05 Asia/Riyadh'];
  const steps: Step[] = m.example.steps.map((title, index) => {
    if (index < 3) return { title, state: 'signed', detail: <Ltr>{times[index]}</Ltr> };
    if (index === 3) {
      return {
        title,
        state: 'next',
        detail: (
          <>
            {m.example.window} <Ltr>08:00 to 12:00</Ltr>
          </>
        ),
      };
    }
    return { title, state: 'later' };
  });

  return (
    <div className="page">
      <section className="section" id="published-shipments" aria-labelledby="published-title">
        <h1 id="published-title">{m.publicShipments.title}</h1>
        <div className="operations-module-heading">
          <p>{m.publicShipments.fleetRule}</p>
          <a className="button button-primary" href={'/' + locale + '/operations'}>
            {m.operationsWorkspace.openDashboard}
          </a>
        </div>
        {!board.ok ? (
          <p role="status">{m.publicShipments.unavailable}</p>
        ) : board.data.items.length === 0 ? (
          <p role="status">{m.publicShipments.empty}</p>
        ) : (
          <ul className="freight-board">
            {board.data.items.map((item) => (
              <li className="card" key={item.id}>
                <h2>
                  {countries.of(item.origin)} – {countries.of(item.destination)}
                </h2>
                <p>{item.equipment[locale]}</p>
                <p>
                  {m.publicShipments.deadline}{' '}
                  <time dateTime={item.deadline}>{date.format(new Date(item.deadline))} UTC</time>
                </p>
                {token ? (
                  <a className="button" href={'/' + locale + '/shipments/' + item.id + '/quote'}>
                    {m.publicShipments.openQuotation}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div className="hero-actions">
          <a
            className="button"
            href={token ? '/' + locale + '/organisations' : '/' + locale + '/sign-in'}
          >
            {token ? m.publicShipments.accounts : m.nav.signIn}
          </a>
          {after ? (
            <a className="button" href={'/' + locale + '#published-shipments'}>
              {m.publicShipments.first}
            </a>
          ) : null}
          {board.ok && board.data.next ? (
            <a
              className="button"
              href={'/' + locale + '?shipmentAfter=' + board.data.next + '#published-shipments'}
            >
              {m.publicShipments.more}
            </a>
          ) : null}
        </div>
      </section>
      <section className="hero" aria-labelledby="hero-title">
        <div className="plate hero-main">
          <h2 id="hero-title">{m.hero.title}</h2>
          <p>{m.hero.lead}</p>
          <div className="hero-actions">
            <a className="button hero-sign-in" href={`/${locale}/sign-in`}>
              {m.nav.signIn}
            </a>
            <a className="button button-on-dark" href="#how-it-works">
              {m.hero.action}
            </a>
          </div>
        </div>
        <section className="card hero-example" aria-labelledby="example-title">
          <header>
            <h2 id="example-title">{m.example.title}</h2>
            <span>{m.example.label}</span>
          </header>
          <Steps steps={steps} signedLabel={m.example.signed} />
          <p className="hero-example-note">{m.example.note}</p>
        </section>
      </section>

      <section className="section" id="how-it-works" aria-labelledby="how-title" tabIndex={-1}>
        <h2 id="how-title">{m.how.title}</h2>
        <ol className="columns how">
          {m.how.items.map((item, index) => (
            <li key={item.title}>
              <span className="plate plate-green how-number" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <h3>
                  <span className="visually-hidden">{index + 1}. </span>
                  {item.title}
                </h3>
                <p>{item.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="section" id="who-it-is-for" aria-labelledby="who-title" tabIndex={-1}>
        <h2 id="who-title">{m.who.title}</h2>
        <ul className="columns who">
          {m.who.items.map((item, index) => (
            <li key={item.title} className="card">
              <span className="who-icon">
                <Icon name={whoIcons[index] ?? 'box'} />
              </span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="section" id="languages" aria-labelledby="languages-title" tabIndex={-1}>
        <h2 id="languages-title">{m.languages.title}</h2>
        <p>{m.languages.lead}</p>
        <ul className="columns signs">
          <li className="plate sign" lang="en" dir="ltr">
            <p>Next stop</p>
            <p>Riyadh, gate 2</p>
          </li>
          <li className="plate sign" lang="ar" dir="rtl">
            <p>المحطة التالية</p>
            <p>
              الرياض، البوابة <Ltr>2</Ltr>
            </p>
          </li>
          <li className="plate sign" lang="ur" dir="rtl">
            <p>اگلا اسٹاپ</p>
            <p>
              ریاض، گیٹ <Ltr>2</Ltr>
            </p>
          </li>
        </ul>
      </section>
    </div>
  );
}
