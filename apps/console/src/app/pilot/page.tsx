import { redirect } from 'next/navigation';
import { ErrorSummary, Field } from '../../../../web/src/components/form.tsx';
import { api } from '../../../../web/src/server/api.ts';
import { ConsoleHeader, Unavailable, utc } from '../../components/console-header.tsx';
import { cancelInvitationAction, inviteParticipantAction } from '../../server/actions.ts';
import { requireStaff } from '../../server/session.ts';

// Pilot invitations (db/migrations/0042, DB-17). While invitations are required, only a person
// with an open invitation for their mobile number, or a driver invited by a carrier, can register.
// Nothing is sent from here: there is no message supplier, so staff tell the contact themselves.
// Times are in UTC.

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

interface Person {
  id: string;
  displayName: string;
}
interface Invitation {
  id: string;
  version: number;
  phone: string;
  organisationName: string;
  contactName: string;
  status: 'pending' | 'accepted' | 'cancelled' | 'expired';
  invitedAt: string;
  invitedBy: Person | null;
  expiresAt: string;
  acceptedAt: string | null;
  endedAt: string | null;
  endedBy: Person | null;
}
interface Pilot {
  required: boolean;
  validDays: number;
  invitations: Invitation[];
}

const DONE: Record<string, string> = {
  invited:
    'The invitation was recorded. Nothing was sent: tell the contact that they can now register with this number.',
  already_invited: 'This invitation was already recorded. Nothing more was made.',
  cancelled: 'The invitation was cancelled. The number can no longer use it to register.',
  already_cancelled: 'This invitation was already cancelled. Nothing changed.',
};
const ERRORS: Record<string, string> = {
  staff_privilege_required: 'Your account does not hold the privilege this needs.',
  validation_failed: 'Check what you entered.',
  invitation_open:
    'This number already has an open invitation. Cancel it before inviting the number again.',
  already_registered: 'Someone has already registered with this number. No invitation is needed.',
  invitation_not_open: 'This invitation is no longer open: it was taken, cancelled or has expired.',
  record_changed: 'The invitation changed since the page was loaded. Nothing was changed.',
  not_found: 'That invitation was not found.',
  unconfirmed:
    'It was not confirmed that this was done. It may have been. The list shows the present state. Trying again changes nothing twice.',
  refused: 'That was refused.',
};
const FIELD_ERRORS: Record<string, string> = {
  phone: 'Enter the mobile number with + and the country code, for example +968 9123 4567.',
  organisationName: 'Enter the organisation’s name.',
  contactName: 'Enter the name of the person invited.',
};
const STATUS: Record<Invitation['status'], string> = {
  pending: 'Open',
  accepted: 'Registered',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export default async function PilotPage({ searchParams }: Props) {
  const search = await searchParams;
  const found = await requireStaff();
  if (found.state === 'unknown') {
    return (
      <>
        <ConsoleHeader />
        <main id="main" tabIndex={-1}>
          <Unavailable retryHref="/pilot" />
        </main>
      </>
    );
  }
  const reply = await api<{ pilot: Pilot }>('GET', '/staff/pilot-invitations', {
    token: found.token,
  });
  if (!reply.ok && reply.status === 401) redirect('/sign-in?error=session_ended');
  if (!reply.ok) {
    const forbidden = reply.status === 403;
    return (
      <>
        <ConsoleHeader staff={found.staff} current="/pilot" />
        <main id="main" tabIndex={-1}>
          {forbidden ? (
            <div className="page page-narrow" data-state="forbidden">
              <h1>Pilot invitations</h1>
              <div className="notice notice-error" role="alert" id="forbidden">
                <h2>You cannot see this</h2>
                <p>
                  Pilot invitations are managed by staff administrators. Your account does not hold
                  that privilege. This attempt was recorded.
                </p>
              </div>
            </div>
          ) : (
            <Unavailable retryHref="/pilot" />
          )}
        </main>
      </>
    );
  }
  const pilot = reply.data.pilot;
  const code = typeof search.error === 'string' ? search.error : null;
  const fields =
    typeof search.fields === 'string'
      ? search.fields.split(',').filter((field) => field in FIELD_ERRORS)
      : [];
  const problems = code
    ? fields.length > 0
      ? fields.map((field) => ({ field, message: FIELD_ERRORS[field]! }))
      : [{ message: ERRORS[code] ?? ERRORS.refused! }]
    : [];
  const done = typeof search.done === 'string' ? DONE[search.done] : undefined;
  const open = pilot.invitations.filter((invitation) => invitation.status === 'pending');
  const ended = pilot.invitations.filter((invitation) => invitation.status !== 'pending');
  return (
    <>
      <ConsoleHeader staff={found.staff} current="/pilot" />
      <main id="main" tabIndex={-1}>
        <div className="page page-narrow">
          <h1>Pilot invitations</h1>
          <ErrorSummary title="There is a problem" problems={problems} />
          {done && !code ? (
            <p className="notice notice-success" role="status" id="pilot-confirmation">
              {done}
            </p>
          ) : null}
          <p id="pilot-rule" data-required={pilot.required ? 'true' : 'false'}>
            {pilot.required
              ? 'Registration needs an invitation. Only a person with an open invitation for their mobile number, or a driver invited by a carrier, can register.'
              : 'Registration does not need an invitation in this environment. Invitations are still recorded and taken when the person registers.'}{' '}
            An invitation lasts {pilot.validDays} {pilot.validDays === 1 ? 'day' : 'days'}.
          </p>

          <section aria-labelledby="invite-heading" id="invite">
            <h2 id="invite-heading">Invite a contact</h2>
            <p className="form-note">
              Nothing is sent from Trucker. After recording the invitation, tell the contact that
              they can register by signing in with this mobile number.
            </p>
            <form className="form" action={inviteParticipantAction}>
              <Field
                id="phone"
                label="Mobile number"
                hint="With + and the country code."
                error={fields.includes('phone') ? FIELD_ERRORS.phone : undefined}
              >
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  dir="ltr"
                  autoComplete="off"
                  maxLength={20}
                  required
                  aria-describedby={`phone-hint${fields.includes('phone') ? ' phone-error' : ''}`}
                  aria-invalid={fields.includes('phone') ? 'true' : undefined}
                />
              </Field>
              <Field
                id="organisationName"
                label="Organisation"
                error={
                  fields.includes('organisationName') ? FIELD_ERRORS.organisationName : undefined
                }
              >
                <input
                  id="organisationName"
                  name="organisationName"
                  type="text"
                  maxLength={200}
                  required
                  aria-describedby={
                    fields.includes('organisationName') ? 'organisationName-error' : undefined
                  }
                  aria-invalid={fields.includes('organisationName') ? 'true' : undefined}
                />
              </Field>
              <Field
                id="contactName"
                label="Name of the person invited"
                error={fields.includes('contactName') ? FIELD_ERRORS.contactName : undefined}
              >
                <input
                  id="contactName"
                  name="contactName"
                  type="text"
                  maxLength={200}
                  required
                  aria-describedby={
                    fields.includes('contactName') ? 'contactName-error' : undefined
                  }
                  aria-invalid={fields.includes('contactName') ? 'true' : undefined}
                />
              </Field>
              <button className="button button-primary" type="submit" data-action="invite">
                Record the invitation
              </button>
            </form>
          </section>

          <section aria-labelledby="open-heading">
            <h2 id="open-heading">Open invitations</h2>
            {open.length === 0 ? (
              <p id="no-open">No invitation is open.</p>
            ) : (
              <ul className="organisation-list record-collection" id="open-invitations">
                {open.map((invitation) => (
                  <InvitationCard key={invitation.id} invitation={invitation} cancellable />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="ended-heading">
            <h2 id="ended-heading">Taken, cancelled and expired</h2>
            {ended.length === 0 ? (
              <p id="no-ended">None yet.</p>
            ) : (
              <ul className="organisation-list record-collection" id="ended-invitations">
                {ended.map((invitation) => (
                  <InvitationCard key={invitation.id} invitation={invitation} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

function InvitationCard({
  invitation,
  cancellable = false,
}: {
  invitation: Invitation;
  cancellable?: boolean;
}) {
  return (
    <li
      className="card"
      id={`invitation-${invitation.id}`}
      data-status={invitation.status}
      data-phone={invitation.phone}
    >
      <h3>{invitation.organisationName}</h3>
      <div className="chips">
        <span className="chip" data-status={invitation.status}>
          {STATUS[invitation.status]}
        </span>
      </div>
      <dl className="facts">
        <div>
          <dt>Person invited</dt>
          <dd>{invitation.contactName}</dd>
        </div>
        <div>
          <dt>Mobile number</dt>
          <dd dir="ltr">{invitation.phone}</dd>
        </div>
        <div>
          <dt>Invited</dt>
          <dd>
            {utc(invitation.invitedAt)}
            {invitation.invitedBy ? ` by ${invitation.invitedBy.displayName}` : ''}
          </dd>
        </div>
        <div>
          <dt>{invitation.status === 'pending' ? 'Expires' : 'Was due to expire'}</dt>
          <dd>{utc(invitation.expiresAt)}</dd>
        </div>
        {invitation.acceptedAt ? (
          <div>
            <dt>Registered</dt>
            <dd>{utc(invitation.acceptedAt)}</dd>
          </div>
        ) : null}
        {invitation.status === 'cancelled' && invitation.endedAt ? (
          <div>
            <dt>Cancelled</dt>
            <dd>
              {utc(invitation.endedAt)}
              {invitation.endedBy ? ` by ${invitation.endedBy.displayName}` : ''}
            </dd>
          </div>
        ) : null}
      </dl>
      {cancellable ? (
        <form action={cancelInvitationAction}>
          <input type="hidden" name="invitationId" value={invitation.id} />
          <input type="hidden" name="version" value={invitation.version} />
          <button className="button button-danger" type="submit" data-action="cancel">
            Cancel the invitation
            <span className="visually-hidden"> for {invitation.organisationName}</span>
          </button>
        </form>
      ) : null}
    </li>
  );
}
