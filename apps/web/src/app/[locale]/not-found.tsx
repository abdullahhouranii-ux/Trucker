import { locale as currentLocale } from 'next/root-params';
import { defaultLocale, isLocale } from '../../i18n/config.ts';
import { getMessages } from '../../i18n/messages.ts';

// Shown for an unknown address under a known language.
export default async function NotFound() {
  const value = await currentLocale();
  const locale = typeof value === 'string' && isLocale(value) ? value : defaultLocale;
  const m = getMessages(locale);
  return (
    <div className="page">
      <section className="card not-found" aria-labelledby="not-found-title">
        <h1 id="not-found-title">{m.notFound.title}</h1>
        <p>{m.notFound.text}</p>
        <p>
          <a className="button" href={`/${locale}`}>
            {m.notFound.home}
          </a>
        </p>
      </section>
    </div>
  );
}
