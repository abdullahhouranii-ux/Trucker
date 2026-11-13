import type { ReactNode } from 'react';
import { FocusOnMount } from './focus-on-mount.tsx';

export interface Problem {
  /** The input the message belongs to, when it belongs to one. */
  field?: string;
  message: string;
}

// The summary takes focus when the page loads, so keyboard and screen-reader users start at
// the problem. Each entry links to its input.
export function ErrorSummary({ title, problems }: { title: string; problems: Problem[] }) {
  if (problems.length === 0) return null;
  return (
    <div className="notice notice-error" role="alert" tabIndex={-1} id="error-summary" autoFocus>
      <h2>{title}</h2>
      <ul>
        {problems.map((problem) => (
          <li key={problem.message}>
            {problem.field ? <a href={`#${problem.field}`}>{problem.message}</a> : problem.message}
          </li>
        ))}
      </ul>
      <FocusOnMount targetId="error-summary" />
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="field" data-invalid={error ? 'true' : undefined}>
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The ids an input should name in aria-describedby. */
export function describedBy(id: string, hasHint: boolean, hasError: boolean): string | undefined {
  const ids = [hasHint ? `${id}-hint` : null, hasError ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}
