import localFont from 'next/font/local';

// Only the scripts used by Trucker, self-hosted at build time. No font CDN or runtime fetch.
export const latinFont = localFont({
  src: [
    {
      path: '../../../../node_modules/@fontsource/barlow/files/barlow-latin-400-normal.woff2',
      weight: '400',
    },
    {
      path: '../../../../node_modules/@fontsource/barlow/files/barlow-latin-500-normal.woff2',
      weight: '500',
    },
    {
      path: '../../../../node_modules/@fontsource/barlow/files/barlow-latin-600-normal.woff2',
      weight: '600',
    },
    {
      path: '../../../../node_modules/@fontsource/barlow/files/barlow-latin-700-normal.woff2',
      weight: '700',
    },
  ],
  variable: '--font-barlow',
  display: 'swap',
  preload: false,
});
export const arabicFont = localFont({
  src: [
    {
      path: '../../../../node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff2',
      weight: '400',
    },
    {
      path: '../../../../node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-500-normal.woff2',
      weight: '500',
    },
    {
      path: '../../../../node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-600-normal.woff2',
      weight: '600',
    },
    {
      path: '../../../../node_modules/@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-700-normal.woff2',
      weight: '700',
    },
  ],
  variable: '--font-arabic',
  display: 'swap',
  preload: false,
});
