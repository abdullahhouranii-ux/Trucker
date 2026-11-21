import type { ReactNode } from 'react';

export function RecordOptions({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="record-options">
      <summary className="button">
        <span aria-hidden="true">⋯</span>
        <span className="visually-hidden">{label}</span>
      </summary>
      <ul className="record-options-links">{children}</ul>
    </details>
  );
}
