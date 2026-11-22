import { latinFont, arabicFont } from '../../design/fonts.ts';
import '../../design/tokens.css';
import '../../styles/site.css';
import '../../styles/experience.css';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { EnvironmentBanner } from '../../components/environment-banner.tsx';
import { SiteHeader } from '../../components/site-header.tsx';
import { WorkspaceNav } from '../../components/workspace-nav.tsx';
import { direction, isLocale, locales } from '../../i18n/config.ts';
import { getMessages } from '../../i18n/messages.ts';

// Only the three designed languages exist. Any other first path segment is not found.
export const dynamicParams = false;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

type Props = { children: ReactNode; params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Pick<Props, 'params'>): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const messages = getMessages(locale);
  return { title: messages.meta.title, description: messages.meta.description };
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getMessages(locale);
  return (
    <html
      lang={locale}
      dir={direction(locale)}
      className={`${latinFont.variable} ${arabicFont.variable}`}
    >
      <body>
        <a className="skip-link" href="#main">
          {messages.skip}
        </a>
        <EnvironmentBanner messages={messages} />
        <SiteHeader locale={locale} messages={messages} />
        <WorkspaceNav locale={locale} />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <footer className="site-footer">
          <p>{messages.footer.note}</p>
        </footer>
      </body>
    </html>
  );
}
