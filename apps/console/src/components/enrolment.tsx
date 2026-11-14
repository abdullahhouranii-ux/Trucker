'use client';

import { useActionState, useEffect, useState } from 'react';
import { enrolBeginAction, enrolCompleteAction, enrolStateAction } from '../server/actions.ts';
import type { EnrolState } from '../server/types.ts';

const ERRORS: Record<string, string> = {
  password_length: 'Enter a password of 12 to 128 characters.',
  password_mismatch: 'The two passwords are not the same.',
  password_weak:
    'That password cannot be used. Choose one of at least 12 characters that is not your email.',
  code: 'That code was not accepted. Enter the six digits your authenticator shows now.',
  unavailable: 'The service did not answer. Nothing was saved. Try again.',
  unconfirmed:
    'It was not confirmed that your account is set up. Enter the code again. If the link is then refused, try signing in: the first attempt may have worked.',
};

function Problem({ code }: { code: string | undefined }) {
  if (!code) return null;
  return (
    <div className="notice notice-error" role="alert" id="enrol-error">
      <h2>There is a problem</h2>
      <p>{ERRORS[code] ?? ERRORS.unavailable}</p>
    </div>
  );
}

// The link's secret is in the address fragment, which the browser keeps to itself. It is
// read here and sent only in request bodies.
export function Enrolment() {
  const [token, setToken] = useState<string | null>(null);
  const [link, setLink] = useState<EnrolState | null>(null);
  const [begun, begin, beginning] = useActionState(enrolBeginAction, { step: 'password' });
  const [completed, complete, completing] = useActionState(enrolCompleteAction, {
    step: 'authenticator',
  });

  useEffect(() => {
    const value = window.location.hash.slice(1);
    setToken(value);
    let current = true;
    void enrolStateAction(value).then((state) => {
      if (current) setLink(state);
    });
    return () => {
      current = false;
    };
  }, []);

  const invalid =
    link?.step === 'invalid' || begun.step === 'invalid' || completed.step === 'invalid';
  if (invalid) {
    return (
      <div className="notice notice-error" role="alert" id="enrol-invalid">
        <h2>This link cannot be used</h2>
        <p>
          It may have expired, been used already or been replaced by a newer one. Ask a staff
          administrator for a new link.
        </p>
      </div>
    );
  }
  if (token === null || link === null) return <p role="status">Checking the link…</p>;

  if (completed.step === 'done' && completed.recoveryCodes) {
    return (
      <section className="section" aria-labelledby="codes-title" id="enrol-done">
        <p className="notice notice-success" role="status">
          Your account is set up. The server confirmed it.
        </p>
        <h2 id="codes-title">Your recovery codes</h2>
        <p>
          Keep these somewhere safe and private. Each one signs you in once, in place of your
          authenticator, together with your password. They are shown only now and cannot be shown
          again.
        </p>
        <ul className="codes" id="recovery-codes">
          {completed.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className="form-inline">
          <a className="button button-primary" id="to-sign-in" href="/sign-in">
            I have saved them. Go to sign-in
          </a>
        </div>
      </section>
    );
  }

  if (begun.step === 'authenticator' && begun.secret) {
    const shown = completed.error ? completed : begun;
    return (
      <section className="section" aria-labelledby="authenticator-title" id="enrol-authenticator">
        <Problem code={completed.error} />
        <h2 id="authenticator-title">Add Trucker to your authenticator app</h2>
        <p>
          Scan this with an authenticator app on your phone, or type the key into it. Then enter the
          six-digit code the app shows. Your account works only after that.
        </p>
        {begun.qr ? (
          <div
            className="qr"
            role="img"
            aria-label="QR code for your authenticator app. The key below is the same thing in letters."
            dangerouslySetInnerHTML={{ __html: begun.qr }}
          />
        ) : null}
        <p>
          Key:{' '}
          <span className="secret" id="authenticator-key">
            {begun.secret.replace(/(.{4})/g, '$1 ').trim()}
          </span>
        </p>
        <form className="form card" id="enrol-code-form" action={complete}>
          <input type="hidden" name="token" value={token} />
          <div className="field" data-invalid={shown.error === 'code' ? 'true' : undefined}>
            <label htmlFor="code">Code from your authenticator app</label>
            <input
              id="code"
              name="code"
              type="text"
              dir="ltr"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              required
            />
          </div>
          <button className="button button-primary" type="submit" disabled={completing}>
            Finish
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="section" aria-labelledby="password-title" id="enrol-password">
      <Problem code={begun.error ?? link.error} />
      <h2 id="password-title">Choose a password</h2>
      <p>
        For <strong id="enrol-email">{begun.email ?? link.email}</strong>. Use at least 12
        characters. A long phrase you can remember is better than a short complicated one.
      </p>
      <form className="form card" id="enrol-password-form" action={begin}>
        <input type="hidden" name="token" value={token} />
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="passwordAgain">Password again</label>
          <input
            id="passwordAgain"
            name="passwordAgain"
            type="password"
            autoComplete="new-password"
            maxLength={128}
            required
          />
        </div>
        <button className="button button-primary" type="submit" disabled={beginning}>
          Continue
        </button>
      </form>
    </section>
  );
}
