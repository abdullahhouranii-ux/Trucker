import {
  WorkspaceGroups,
  type WorkspaceGroup,
} from '../../../web/src/components/workspace-groups.tsx';
import type { StaffAccount } from '../server/types.ts';

export function ConsoleHeader({ staff, current }: { staff?: StaffAccount; current?: string }) {
  const admin = staff?.privileges.includes('staff_admin') ?? false;
  const reviewer = staff?.privileges.includes('reviewer') ?? false;
  const operations = staff?.privileges.includes('operations') ?? false;
  function links(...items: Array<readonly [string, string, boolean]>): WorkspaceGroup['links'] {
    return items.filter(([, , allowed]) => allowed).map(([href, label]) => [href, label]);
  }
  const groups: WorkspaceGroup[] = [
    { links: [['/', 'My account']] },
    {
      label: 'Freight operations',
      links: links(
        ['/shipments', 'Published shipments', reviewer || admin],
        ['/bookings', 'Bookings', reviewer || admin],
        ['/fleet', 'Fleet', reviewer || admin],
        ['/operations', 'Operations', operations],
      ),
    },
    {
      label: 'Verification and staff',
      links: links(
        ['/verification', 'Verification', reviewer],
        ['/verification/withdraw', 'Withdraw a verification', admin],
        ['/staff', 'Staff accounts', admin],
        ['/audit', 'Audit', admin],
      ),
    },
    {
      label: 'Finance',
      links: links(
        ['/finance', 'Financial settings', admin],
        ['/fees', 'Fee payments', admin],
        ['/refunds', 'Refunds', admin],
      ),
    },
  ];
  return (
    <header className={`console-header${staff ? ' console-workspace workspace-rail' : ''}`}>
      <a className="brand" href="/">
        Trucker staff console
      </a>
      {staff ? <p className="console-identity">{staff.displayName}</p> : null}
      {staff ? (
        <nav aria-label="Console">
          <WorkspaceGroups
            groups={groups}
            idPrefix="staff-workspace"
            isCurrent={(href) => current === href}
          />
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
