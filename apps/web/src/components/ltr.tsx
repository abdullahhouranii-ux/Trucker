import type { ReactNode } from 'react';

// References, plates, phone numbers, amounts, dates, times and time zones are always read
// left to right, also inside Arabic and Urdu text, and are kept together where space allows.
export function Ltr({ children }: { children: ReactNode }) {
  return (
    <bdi className="ltr" dir="ltr">
      {children}
    </bdi>
  );
}
