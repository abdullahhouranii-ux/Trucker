// Languages the product is designed in. Arabic and Urdu are written right to left.
export const locales = ['en', 'ar', 'ur'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function direction(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'en' ? 'ltr' : 'rtl';
}

// Each language is always named in its own language and script.
export const localeNames: Record<Locale, string> = { en: 'English', ar: 'العربية', ur: 'اردو' };

// The same page in another language: swaps the first path segment and keeps the rest.
export function pathInLocale(path: string, target: Locale): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const first = segments[0];
  const rest = first !== undefined && isLocale(first) ? segments.slice(1) : segments;
  return '/' + [target, ...rest].join('/');
}
