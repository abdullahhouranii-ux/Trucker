'use client';

import { useEffect } from 'react';

// Keeps what a person has typed in a form while they change language or reload, by saving it
// in this browser tab only (sessionStorage). Nothing is sent anywhere. One-time codes and
// anything else not marked with data-draft are never saved. `clear` removes a finished draft.
export function DraftKeeper({ formId, clear = false }: { formId: string; clear?: boolean }) {
  useEffect(() => {
    const storageKey = `trucker-draft:${formId}`;
    let storage: Storage;
    try {
      storage = window.sessionStorage;
      if (clear) {
        storage.removeItem(storageKey);
        return;
      }
    } catch {
      return; // storage is unavailable: the form simply does not keep a draft
    }
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    const fields = (): (HTMLInputElement | HTMLTextAreaElement)[] => [
      ...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-draft]'),
    ];
    try {
      const saved = JSON.parse(storage.getItem(storageKey) ?? '{}') as Record<
        string,
        string | boolean
      >;
      for (const field of fields()) {
        const value = saved[field.name];
        if (field instanceof HTMLInputElement && field.type === 'checkbox') {
          if (typeof value === 'boolean') field.checked = value;
        } else if (typeof value === 'string' && field.value === '') {
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
  }, [formId, clear]);
  return null;
}
