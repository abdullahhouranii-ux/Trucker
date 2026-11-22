export interface FeeInvoiceDraftResponse {
  draft: {
    id: string;
    bookingId: string;
    recordedFee: string;
    currency: string;
    paidAt: string;
    preparedAt: string;
    status: 'pending_issuer_and_tax';
  } | null;
}

const text = {
  en: {
    title: 'Platform fee invoice preparation',
    pending: 'Pending issuer and tax validation',
    paid: 'Fee payment recorded',
    reference: 'Draft reference',
  },
  ar: {
    title: 'إعداد فاتورة رسوم المنصة',
    pending: 'بانتظار التحقق من المصدِر والمعالجة الضريبية',
    paid: 'دفعة الرسوم المسجّلة',
    reference: 'مرجع المسودة',
  },
  ur: {
    title: 'پلیٹ فارم فیس کی انوائس کی تیاری',
    pending: 'جاری کنندہ اور ٹیکس کی تصدیق باقی ہے',
    paid: 'درج شدہ فیس کی ادائیگی',
    reference: 'مسودے کا حوالہ',
  },
};

/** An internal draft only: nothing is issued or sent, and no tax is calculated. */
export function FeeInvoiceDraftPanel({
  draft,
  locale,
}: {
  draft: FeeInvoiceDraftResponse['draft'];
  locale: keyof typeof text;
}) {
  if (!draft) return null;
  const t = text[locale];
  return (
    <section className="section" aria-labelledby="fee-invoice-draft-title">
      <h2 id="fee-invoice-draft-title">{t.title}</h2>
      <p>{t.pending}</p>
      <p>
        {t.reference} · <bdi dir="ltr">{draft.id}</bdi>
      </p>
      <p>
        {t.paid} ·{' '}
        <bdi dir="ltr">
          {draft.recordedFee} {draft.currency}
        </bdi>
      </p>
    </section>
  );
}
