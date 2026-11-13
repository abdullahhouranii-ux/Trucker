import type { Locale } from '../i18n/config.ts';
import type { Messages } from '../i18n/messages.ts';
import { LanguageSwitch } from './language-switch.tsx';
import { SiteNav } from './site-nav.tsx';

export function SiteHeader({ locale, messages }: { locale: Locale; messages: Messages }) {
  const home = `/${locale}`;
  return (
    <header className="site-header">
      <a className="brand" href={home} lang="en" dir="ltr">
        Trucker
      </a>
      <SiteNav
        home={home}
        label={messages.mainNav}
        signIn={messages.nav.signIn}
        links={[
          { href: `${home}#how-it-works`, text: messages.nav.how },
          { href: `${home}#who-it-is-for`, text: messages.nav.who },
          { href: `${home}#languages`, text: messages.nav.languages },
        ]}
      />
      <LanguageSwitch locale={locale} label={messages.language} />
    </header>
  );
}
