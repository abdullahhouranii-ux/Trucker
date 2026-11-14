import type { StaffAccount } from '../server/types.ts';

export function ConsoleHeader({ staff, current }: { staff?: StaffAccount; current?: string }) {
  const admin = staff?.privileges.includes('staff_admin') ?? false;
  const link = (href: string, label: string) => (
    <li>
      <a href={href} aria-current={current === href ? 'page' : undefined}>
        {label}
      </a>
    </li>
  );
  return (
    <header className="console-header">
      <a className="brand" href="/">
        Trucker staff console
      </a>
      {staff ? (
        <nav aria-label="Console">
          <ul>
            {link('/', 'My account')}
            {admin ? link('/staff', 'Staff accounts') : null}
            {admin ? link('/audit', 'Audit') : null}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}

/** Shown when the API did not answer. Nothing is claimed about the session. */
export function Unavailable({ retryHref }: { retryHref: string }) {
  return (
    <div className="page page-narrow" data-state="unavailable">
      <h1>This cannot be shown right now</h1>
      <div className="notice notice-error" role="alert">
        <h2>The service did not answer</h2>
        <p>
          Nothing is known about your session: it may still be active. Nothing was changed. Try
          again.
        </p>
      </div>
      <div className="form-inline">
        <a className="button" id="retry" href={retryHref}>
          Try again
        </a>
      </div>
    </div>
  );
}

const when = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
export const utc = when;
