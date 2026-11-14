'use client';

import { useEffect } from 'react';

// Keeps what a person has typed in a form while they change language or reload, by saving it
// in this browser tab only (sessionStorage). Nothing is sent anywhere. One-time codes and
// anything else not marked with data-draft are never saved. `clear` removes a finished draft.
// `scope` ties a draft to one state of a record (its version): a draft made against an older
// state is ignored. `overwrite` puts the draft over values the page already shows, for forms
// that edit a saved record. `fallbackScope` names the state a draft was typed against when the
// record has since been changed by someone else: that draft is carried over to the new state,
// so that nothing typed is lost, and `carriedField` names a hidden input that then records
// which state it was typed against, for as long as that draft lives.
export function DraftKeeper({
  formId,
  clear = false,
  scope = '',
  overwrite = false,
  fallbackScope,
  carriedField,
}: {
  formId: string;
  clear?: boolean;
  scope?: string;
  overwrite?: boolean;
  fallbackScope?: string;
  carriedField?: string;
}) {
  useEffect(() => {
    const storageKey = `trucker-draft:${formId}${scope ? `:${scope}` : ''}`;
    let storage: Storage;
    try {
      storage = window.sessionStorage;
      // A finished draft is removed; what is typed from now on is kept again.
      if (clear) storage.removeItem(storageKey);
      if (fallbackScope && fallbackScope !== scope) {
        const earlierKey = `trucker-draft:${formId}:${fallbackScope}`;
        const earlier = storage.getItem(earlierKey);
        if (earlier !== null && !clear && storage.getItem(storageKey) === null) {
          let carried = earlier;
          if (carriedField) {
            try {
              carried = JSON.stringify({
                ...(JSON.parse(earlier) as Record<string, string | boolean>),
                [carriedField]: fallbackScope,
              });
            } catch {
              // an unreadable draft is carried as it is and ignored below
            }
          }
          storage.setItem(storageKey, carried);
        }
        storage.removeItem(earlierKey);
      }
    } catch {
      return; // storage is unavailable: the form simply does not keep a draft
    }
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    type DraftField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const fields = (): DraftField[] => [...form.querySelectorAll<DraftField>('[data-draft]')];
    try {
      const saved = JSON.parse(storage.getItem(storageKey) ?? '{}') as Record<
        string,
        string | boolean
      >;
      for (const field of fields()) {
        const value = saved[field.name];
        if (field instanceof HTMLInputElement && field.type === 'checkbox') {
          if (typeof value === 'boolean') field.checked = value;
        } else if (typeof value === 'string' && (overwrite || field.value === '')) {
          field.value = value;
        }
      }
    } catch {
      // an unreadable draft is ignored
    }
    const save = (): void => {
      const values: Record<string, string | boolean> = {};
      for (const field of fields()) {
        values[field.name] =
          field instanceof HTMLInputElement && field.type === 'checkbox'
            ? field.checked
            : field.value;
      }
      try {
        storage.setItem(storageKey, JSON.stringify(values));
      } catch {
        // storage is full or blocked: nothing to do
      }
    };
    form.addEventListener('input', save);
    form.addEventListener('change', save);
    return () => {
      form.removeEventListener('input', save);
      form.removeEventListener('change', save);
    };
  }, [formId, clear, scope, overwrite, fallbackScope, carriedField]);
  return null;
}
