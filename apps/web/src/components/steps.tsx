import type { ReactNode } from 'react';
import { Icon } from './icons.tsx';

export type StepState = 'signed' | 'next' | 'later';
export type Step = { title: string; detail?: ReactNode; state: StepState };

// Numbered milestone steps. The number is the position in the trip. State is always shown
// with words, never by colour alone.
export function Steps({ steps, signedLabel }: { steps: Step[]; signedLabel: string }) {
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className="step"
          data-state={step.state}
          aria-current={step.state === 'next' ? 'step' : undefined}
        >
          <span className="step-number" aria-hidden="true">
            {index + 1}
          </span>
          <div className="step-body">
            <p className="step-title">
              <span className="visually-hidden">{index + 1}. </span>
              {step.title}
            </p>
            {step.detail ? <p className="step-detail">{step.detail}</p> : null}
          </div>
          {step.state === 'signed' ? (
            <span className="chip chip-ok">
              <Icon name="check" />
              {signedLabel}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
