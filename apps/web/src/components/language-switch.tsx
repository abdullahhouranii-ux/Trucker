'use client';

import { usePathname } from 'next/navigation';
import { type Locale, localeNames, locales, pathInLocale } from '../i18n/config.ts';

// Links to the same page in each language. Plain links: they work without scripts. What a
// person has typed in a form is kept across the change by DraftKeeper.
export function LanguageSwitch({ locale, label }: { locale: Locale; label: string }) {
  const path = usePathname() ?? `/${locale}`;
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
