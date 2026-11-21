'use client';
import { useParams } from 'next/navigation';

export default function Loading() {
  const { locale } = useParams<{ locale: string }>();
  const text =
    locale === 'ar'
      ? 'جارٍ تحميل مساحة العمل…'
      : locale === 'ur'
        ? 'کام کی جگہ لوڈ ہو رہی ہے…'
        : 'Loading your workspace…';
  return (
    <div className="page page-narrow" aria-busy="true">
      <p role="status">{text}</p>
      <div className="loading-placeholder" aria-hidden="true" />
    </div>
  );
}
