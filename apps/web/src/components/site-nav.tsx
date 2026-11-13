'use client';

import { usePathname } from 'next/navigation';

// On the home page the links jump to its sections. On task pages (sign-in, registration,
// account) only the link to the account is shown, so the header stays short on a phone.
export function SiteNav({
  home,
  label,
  links,
  signIn,
}: {
  home: string;
  label: string;
  links: { href: string; text: string }[];
  signIn: string;
}) {
  const onHome = (usePathname() ?? home).replace(/\/$/, '') === home;
  return (
    <nav className="site-nav" aria-label={label}>
      <ul>
        {onHome
          ? links.map((link) => (
              <li key={link.href}>
                <a href={link.href}>{link.text}</a>
              </li>
            ))
          : null}
        <li>
          <a href={`${home}/sign-in`}>{signIn}</a>
        </li>
      </ul>
    </nav>
  );
}
