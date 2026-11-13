import type { Locale } from './config.ts';
import ar from './messages/ar.json';
import en from './messages/en.json';
import ur from './messages/ur.json';

// English is the reference catalogue. The other catalogues must have the same shape;
// messages.test.ts checks this, and the type below makes a missing key a compile error.
export type Messages = typeof en;

const catalogues: Record<Locale, Messages> = { en, ar, ur };

export function getMessages(locale: Locale): Messages {
  return catalogues[locale];
}
