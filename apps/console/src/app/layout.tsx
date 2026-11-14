import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '../../../web/src/design/tokens.css';
import '../../../web/src/styles/site.css';
import '../styles/console.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Trucker staff console',
  description: 'For Trucker staff only.',
  robots: { index: false, follow: false },
};

// The console is in English only: the language staff work in is not decided.
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>
        <a className="skip-link" href="#main">
          Skip to the content
        </a>
        {process.env.NEXT_PUBLIC_TRUCKER_STAGE === 'production' ? null : (
          <div className="environment" role="note">
            <p>Development build. Not a live service. Staff accounts here are test accounts.</p>
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
