'use client';

import { useActionState } from 'react';
import { createStaffAction, issueLinkAction } from '../server/actions.ts';
import type { LinkState } from '../server/types.ts';

const ERRORS: Record<string, string> = {
  declaration_missing:
    'Say whether this person also has a participant account. It must be declared either way.',
  validation_failed:
    'Check the email, the name and the mobile number. A mobile number starts with + and the country code.',
  staff_email_taken: 'A staff account with this email already exists.',
  staff_privilege_required: 'Your account does not hold the privilege this needs.',
  staff_self_action: 'This cannot be done to your own account. Another administrator must do it.',
  staff_account_disabled: 'This account is disabled. Enable it first.',
  not_found: 'That account was not found.',
  unconfirmed:
    'It was not confirmed that this was done. It may have been. Try again: nothing is created twice.',
  refused: 'That was refused.',
};

function LinkOnce({ state, id }: { state: LinkState; id: string }) {
  if (!state.link) return null;
  return (
    <div className="notice notice-success" role="status" id={id}>
      <h3>Enrolment link for {state.email}</h3>
      <p>
        Give this link to that person over a channel you trust. It works once and expires on{' '}
        {state.expiresAt?.slice(0, 16).replace('T', ' ')} UTC. It is shown only now: it is not
        stored and cannot be shown again. Anyone who has it can take over the account.
      </p>
      <code className="link-once" data-link>
        {state.link}
      </code>
    </div>
  );
}
function Refusal({ state, id }: { state: LinkState; id: string }) {
  if (!state.error) return null;
  return (
    <div className="notice notice-error" role="alert" id={id}>
      <p>{ERRORS[state.error] ?? ERRORS.refused}</p>
    </div>
  );
}

export function CreateStaffForm() {
  const [state, action, pending] = useActionState(createStaffAction, {});
  return (
    <section className="section" aria-labelledby="create-title">
      <h2 id="create-title">Add a staff account</h2>
      <LinkOnce state={state} id="created-link" />
      <Refusal state={state} id="create-error" />
      <form className="form card" id="create-form" action={action}>
        <input type="hidden" name="retryKey" value={state.retryKey ?? ''} />
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" name="email" type="email" dir="ltr" maxLength={254} required />
        </div>
        <div className="field">
          <label htmlFor="displayName">Name</label>
          <input id="displayName" name="displayName" type="text" maxLength={120} required />
        </div>
        <fieldset className="choice">
          <legend>Does this person also have a Trucker participant account?</legend>
          <p className="field-hint">
            This is recorded as your declaration. It decides which applications they may never
            review. It is never assumed.
          </p>
          <label>
            <input type="radio" name="participantLink" value="declared_none" required />
            No, they have none
          </label>
          <label>
            <input type="radio" name="participantLink" value="declared" />
            Yes, with the mobile number below
          </label>
        </fieldset>
        <div className="field">
          <label htmlFor="participantPhone">Their participant mobile number (only if yes)</label>
          <input
            id="participantPhone"
            name="participantPhone"
            type="tel"
            dir="ltr"
            maxLength={20}
            aria-describedby="participantPhone-hint"
          />
          <p className="field-hint" id="participantPhone-hint">
            With + and the country code.
          </p>
        </div>
        <p className="form-note">
          The account has no privileges until you grant them, and cannot sign in until its owner has
          used the enrolment link.
        </p>
        <button className="button button-primary" type="submit" disabled={pending}>
          Add the account
        </button>
      </form>
    </section>
  );
}

export function IssueLinkForm({ staffId, email }: { staffId: string; email: string }) {
  const [state, action, pending] = useActionState(issueLinkAction, {});
  return (
    <>
      <form action={action}>
        <input type="hidden" name="staffId" value={staffId} />
        <button className="button" type="submit" disabled={pending} data-action="issue-link">
          New enrolment link
          <span className="visually-hidden"> for {email}</span>
        </button>
      </form>
      <LinkOnce state={state} id={`issued-link-${staffId}`} />
      <Refusal state={state} id={`issue-error-${staffId}`} />
    </>
  );
}
