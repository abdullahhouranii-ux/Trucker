'use client';
import { useEffect, useRef } from 'react';

export default function ErrorPage({ reset }: { reset: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <main id="main" tabIndex={-1}>
      <div className="page page-narrow">
        <h1 ref={heading} tabIndex={-1}>
          This page could not be shown
        </h1>
        <p role="alert">
          Read the latest state before repeating a decision or financial action. This page cannot
          confirm its outcome.
        </p>
        <div>
          <button className="button button-primary" onClick={reset}>
            Try again
          </button>
        </div>
        <a className="button" href="/">
          My account
        </a>
      </div>
    </main>
  );
}
