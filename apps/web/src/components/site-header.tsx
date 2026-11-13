import { type Locale, localeNames, locales, pathInLocale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';

export function LanguageSwitch({
  locale,
  path,
  label,
}: {
  locale: Locale;
  path: string;
  label: string;
}) {
  return (
    <nav className="languages" aria-label={label}>
      <ul>
        {locales.map((target) => (
          <li key={target}>
            <a
              href={pathInLocale(path, target)}
              lang={target}
              hrefLang={target}
              aria-current={target === locale ? 'true' : undefined}
            >
              {localeNames[target]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SiteHeader({ locale, messages }: { locale: Locale; messages: Messages }) {
  const home = `/${locale}`;
  return (
    <header className="site-header">
      <a className="brand" href={home} lang="en" dir="ltr">
        Trucker
      </a>
      <nav className="site-nav" aria-label={messages.mainNav}>
        <ul>
          <li>
            <a href={`${home}#how-it-works`}>{messages.nav.how}</a>
          </li>
          <li>
            <a href={`${home}#who-it-is-for`}>{messages.nav.who}</a>
          </li>
          <li>
            <a href={`${home}#languages`}>{messages.nav.languages}</a>
          </li>
        </ul>
      </nav>
      <LanguageSwitch locale={locale} path={home} label={messages.language} />
    </header>
  );
}
