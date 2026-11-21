export interface FeeInvoiceDraftResponse {
  draft: {
    id: string;
    bookingId: string;
    recordedFee: string;
    currency: string;
    paidAt: string;
    preparedAt: string;
    status: 'pending_issuer_and_tax';
    illustration: { ratePercent: number; vat: string; gross: string } | null;
  } | null;
}

const text = {
  en: {
    title: 'Platform fee invoice preparation',
    pending: 'Pending issuer and tax validation',
    paid: 'Fee payment recorded',
    reference: 'Draft reference',
    illustration: 'Illustration only · Oman standard VAT',
    vat: 'Illustrative VAT',
    gross: 'Illustrative total',
  },
  ar: {
    title: 'إعداد فاتورة رسوم المنصة',
    pending: 'بانتظار التحقق من المصدِر والمعالجة الضريبية',
    paid: 'دفعة الرسوم المسجّلة',
    reference: 'مرجع المسودة',
    illustration: 'مثال حسابي · النسبة القياسية في عُمان',
    vat: 'الضريبة في المثال',
    gross: 'الإجمالي في المثال',
  },
  ur: {
    title: 'پلیٹ فارم فیس کی انوائس کی تیاری',
    pending: 'جاری کنندہ اور ٹیکس کی تصدیق باقی ہے',
    paid: 'درج شدہ فیس کی ادائیگی',
    reference: 'مسودے کا حوالہ',
    illustration: 'صرف مثال · عمان کی معیاری شرح',
    vat: 'مثالی ٹیکس',
    gross: 'مثالی کل رقم',
  },
};

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
      {draft.illustration ? (
        <>
          <h3>
            {t.illustration} · <bdi dir="ltr">{draft.illustration.ratePercent}%</bdi>
          </h3>
          <p>
            {t.vat} ·{' '}
            <bdi dir="ltr">
              {draft.illustration.vat} {draft.currency}
            </bdi>
          </p>
          <p>
            {t.gross} ·{' '}
            <bdi dir="ltr">
              {draft.illustration.gross} {draft.currency}
            </bdi>
          </p>
        </>
      ) : null}
    </section>
  );
}
