'use client';
import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';

export default function ErrorPage({ reset }: { reset: () => void }) {
  const { locale } = useParams<{ locale: string }>();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const m =
    locale === 'ar'
      ? [
          'تعذر عرض الصفحة',
          'أعد المحاولة لعرض الحالة الحالية. لا تكرر أي عملية سابقة قبل التحقق من نتيجتها.',
          'حاول مجدداً',
        ]
      : locale === 'ur'
        ? [
            'صفحہ دکھایا نہیں جا سکا',
            'تازہ حالت دیکھنے کے لیے دوبارہ کوشش کریں۔ پچھلی کارروائی کا نتیجہ جانچے بغیر اسے نہ دہرائیں۔',
            'دوبارہ کوشش کریں',
          ]
        : [
            'This page could not be shown',
            'Try again to read the latest state. Check the outcome before repeating any earlier action.',
            'Try again',
          ];
  return (
    <div className="page page-narrow">
      <h1 ref={heading} tabIndex={-1}>
        {m[0]}
      </h1>
      <p role="alert">{m[1]}</p>
      <div>
        <button className="button button-primary" onClick={reset}>
          {m[2]}
        </button>
      </div>
    </div>
  );
}
