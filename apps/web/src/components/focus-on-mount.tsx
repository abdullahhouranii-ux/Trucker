'use client';

import { useEffect } from 'react';

// Moves focus to an element when it appears, for example an error summary after a form is
// refused. The `autofocus` attribute alone is not enough: after a form action the page is
// updated in place, and the browser applies `autofocus` only on a full page load.
export function FocusOnMount({ targetId }: { targetId: string }) {
  useEffect(() => {
    document.getElementById(targetId)?.focus();
  }, [targetId]);
  return null;
}
