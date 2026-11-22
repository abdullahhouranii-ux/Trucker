'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Field } from './form.tsx';
import { closureBlockerLabels } from './booking-completion-labels.ts';

export interface ClosureStatus {
  state: 'open' | 'closed' | 'review_required';
}

export interface ClosureQueueItem extends ClosureStatus {
  bookingId: string;
  closedAt: string | null;
  blockers: string[];
  ownerId: string | null;
  ownerName: string | null;
}

interface PaymentRecord {
  id: string;
  amount: string;
  reference: string;
  evidence: string;
  status: keyof typeof messages.en.payment;
  recordedAt: string;
  reviewer: string | null;
  history:
    | {
        kind: keyof typeof messages.en.payment;
        staffId: string | null;
        recordedAt: string;
        note: string | null;
        reference: string | null;
        evidence: string | null;
        actualAmount: string | null;
        actualCurrency: string | null;
      }[]
    | null;
}

export interface FinancialCompletion {
  bookingId: string;
  recordingOpen: boolean;
  blockers: string[] | null;
  obligations: {
    kind: 'freight' | 'commission';
    amount: string;
    currency: string;
    side: 'payer' | 'payee' | null;
    payments: PaymentRecord[];
  }[];
}

const messages = {
  en: {
    finance: 'Financial completion',
    closure: 'Operational closure',
    freight: 'Freight payment',
    commission: 'Organiser commission',
    due: 'Booked amount',
    amount: 'Amount',
    currency: 'Currency',
    reference: 'Payment reference',
    evidence: 'Evidence reference',
    statement: 'Statement line reference',
    note: 'Reason or review note',
    report: 'Record external payment',
    confirm: 'Confirm receipt',
    reject: 'Reject report',
    review: 'Record first review',
    reconcile: 'Reconcile against evidence',
    void: 'Void record',
    history: 'Record history',
    noRecords: 'No payments recorded.',
    open: 'Open',
    closed: 'Closed',
    review_required: 'Needs review',
    retry: 'Retry the same submission',
    unknown: 'The outcome is uncertain. Retry this submission to check it.',
    refused: 'This action was refused. Check the record and your permissions.',
    conflict: 'The action is unavailable in the current state. Refresh and check the record.',
    done: 'Recorded.',
    independent: 'An independent administrator must reconcile this review.',
    payment: {
      report: 'Reported',
      confirm: 'Receipt confirmed',
      reject: 'Rejected',
      review: 'Reviewed',
      match: 'Reconciled',
      discrepancy: 'Discrepancy',
      void: 'Voided',
    },
  },
  ar: {
    finance: 'الإقفال المالي',
    closure: 'الإقفال التشغيلي',
    freight: 'أجرة النقل',
    commission: 'عمولة المنظّم',
    due: 'المبلغ المثبّت في الحجز',
    amount: 'المبلغ',
    currency: 'العملة',
    reference: 'مرجع الدفعة',
    evidence: 'مرجع الإثبات',
    statement: 'مرجع بند الكشف',
    note: 'السبب أو ملاحظة المراجعة',
    report: 'تسجيل دفعة خارجية',
    confirm: 'تأكيد الاستلام',
    reject: 'رفض السجل',
    review: 'تسجيل المراجعة الأولى',
    reconcile: 'مطابقة الدفعة مع الإثبات',
    void: 'إبطال السجل',
    history: 'سجل الإجراءات',
    noRecords: 'لا توجد دفعات مسجّلة.',
    open: 'مفتوح',
    closed: 'مقفل',
    review_required: 'يحتاج إلى مراجعة',
    retry: 'إعادة إرسال الطلب نفسه',
    unknown: 'نتيجة الطلب غير مؤكدة. أعد إرسال الطلب نفسه للتحقق.',
    refused: 'رُفض الإجراء. تحقق من السجل وصلاحياتك.',
    conflict: 'الإجراء غير متاح في الحالة الحالية. حدّث الصفحة وراجع السجل.',
    done: 'تم التسجيل.',
    independent: 'يجب أن يطابق السجل مسؤول مستقل.',
    payment: {
      report: 'مسجّلة',
      confirm: 'مؤكدة الاستلام',
      reject: 'مرفوضة',
      review: 'تمت مراجعتها',
      match: 'مطابقة',
      discrepancy: 'فرق في المطابقة',
      void: 'مبطلة',
    },
  },
  ur: {
    finance: 'مالی تکمیل',
    closure: 'عملیاتی اختتام',
    freight: 'نقل و حمل کی ادائیگی',
    commission: 'منتظم کا کمیشن',
    due: 'بکنگ کی مقررہ رقم',
    amount: 'رقم',
    currency: 'کرنسی',
    reference: 'ادائیگی کا حوالہ',
    evidence: 'ثبوت کا حوالہ',
    statement: 'اسٹیٹمنٹ لائن کا حوالہ',
    note: 'وجہ یا جائزے کی تفصیل',
    report: 'بیرونی ادائیگی درج کریں',
    confirm: 'وصولی کی تصدیق کریں',
    reject: 'ریکارڈ مسترد کریں',
    review: 'ابتدائی جائزہ درج کریں',
    reconcile: 'ثبوت سے ادائیگی ملائیں',
    void: 'ریکارڈ کالعدم کریں',
    history: 'ریکارڈ کی تاریخ',
    noRecords: 'کوئی ادائیگی درج نہیں ہوئی۔',
    open: 'کھلا',
    closed: 'بند',
    review_required: 'جائزہ درکار ہے',
    retry: 'یہی درخواست دوبارہ بھیجیں',
    unknown: 'نتیجہ غیر یقینی ہے۔ جانچ کے لیے یہی درخواست دوبارہ بھیجیں۔',
    refused: 'درخواست مسترد ہوئی۔ ریکارڈ اور اجازت دیکھیں۔',
    conflict: 'اس حالت میں کارروائی دستیاب نہیں۔ صفحہ تازہ کر کے ریکارڈ دیکھیں۔',
    done: 'درج ہو گیا۔',
    independent: 'اس جائزے کا ملاپ ایک آزاد منتظم کرے گا۔',
    payment: {
      report: 'درج شدہ',
      confirm: 'وصولی کی تصدیق',
      reject: 'مسترد',
      review: 'جائزہ شدہ',
      match: 'مطابق',
      discrepancy: 'فرق',
      void: 'کالعدم',
    },
  },
};

type Locale = keyof typeof messages;
type Copy = typeof messages.en;
type Outcome = 'ok' | 'unknown' | 'conflict' | 'refused';
export type SubmitCompletion = (key: string, body: Record<string, unknown>) => Promise<Outcome>;

function Action({
  submit,
  fixed,
  label,
  copy,
  children,
}: {
  submit: SubmitCompletion;
  fixed: Record<string, unknown>;
  label: string;
  copy: Copy;
  children?: ReactNode;
}) {
  const router = useRouter();
  const pending = useRef<{ key: string; body: Record<string, unknown> } | null>(null);
  const busy = useRef(false);
  const [state, setState] = useState<Outcome | 'busy'>();
  const form = useRef<HTMLFormElement>(null);

  async function send() {
    if (!pending.current || busy.current) return;
    busy.current = true;
    setState('busy');
    const { key, body } = pending.current;
    let outcome: Outcome;
    try {
      outcome = await submit(key, body);
    } catch {
      outcome = 'unknown';
    }
    busy.current = false;
    if (outcome !== 'unknown') pending.current = null;
    setState(outcome);
    if (outcome === 'ok') {
      form.current?.reset();
      router.refresh();
    }
  }

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const fields = [...new FormData(event.currentTarget).entries()].filter(
      ([, value]) => value !== '',
    );
    pending.current = {
      key: crypto.randomUUID(),
      body: { ...Object.fromEntries(fields), ...fixed },
    };
    void send();
  }

  return (
    <form
      className="form"
      ref={form}
      onSubmit={start}
      data-completion-action={String(fixed.action ?? 'assign')}
    >
      <fieldset className="fieldset" disabled={state === 'busy' || state === 'unknown'}>
        {children}
        <button type="submit" className="button">
          {label}
        </button>
      </fieldset>
      <p role="status">
        {state && state !== 'busy' ? (state === 'ok' ? copy.done : copy[state]) : null}
      </p>
      {state === 'unknown' ? (
        <button type="button" className="button" onClick={() => void send()}>
          {copy.retry}
        </button>
      ) : null}
    </form>
  );
}

function TextInput({
  name,
  label,
  limit = 200,
  value,
  required = true,
}: {
  name: string;
  label: string;
  limit?: number;
  value?: string;
  required?: boolean;
}) {
  const id = useId();
  return (
    <Field id={id} label={label}>
      <input
        id={id}
        type="text"
        name={name}
        required={required}
        maxLength={limit}
        defaultValue={value}
        inputMode={name === 'amount' ? 'decimal' : 'text'}
      />
    </Field>
  );
}

export function BookingCompletionPanel({
  financial,
  closure,
  locale,
  submit,
  staffId,
}: {
  financial: FinancialCompletion | null;
  closure?: ClosureStatus | null;
  locale: Locale;
  submit: SubmitCompletion;
  staffId?: string;
}) {
  const t = messages[locale];
  if (!financial && !closure) return null;
  return (
    <section
      id="financial-completion"
      className="section"
      aria-labelledby="financial-completion-title"
    >
      <h2 id="financial-completion-title">{t.finance}</h2>
      {closure ? (
        <p>
          {t.closure} · {t[closure.state]}
        </p>
      ) : null}
      {staffId && financial?.blockers?.length ? (
        <ul>
          {financial.blockers.map((blocker) => (
            <li key={blocker}>{closureBlockerLabels[blocker] ?? blocker}</li>
          ))}
        </ul>
      ) : null}
      {financial?.obligations.map((obligation) => (
        <section key={obligation.kind} aria-label={t[obligation.kind]}>
          <h3>{t[obligation.kind]}</h3>
          <p>
            {t.due} ·{' '}
            <bdi dir="ltr">
              {obligation.amount} {obligation.currency}
            </bdi>
          </p>
          {obligation.payments.length ? (
            <ul className="evidence">
              {obligation.payments.map((payment) => {
                const fixed = { paymentId: payment.id };
                const reviewAvailable = ['confirm', 'discrepancy', 'match'].includes(
                  payment.status,
                );
                return (
                  <li key={payment.id}>
                    <p>
                      <bdi dir="ltr">
                        {payment.amount} {obligation.currency}
                      </bdi>{' '}
                      · {t.payment[payment.status]}
                    </p>
                    <p>
                      {t.reference} · <bdi>{payment.reference}</bdi>
                    </p>
                    <p>
                      {t.evidence} · <bdi>{payment.evidence}</bdi>
                    </p>
                    {payment.history?.length ? (
                      <details>
                        <summary>{t.history}</summary>
                        <ul>
                          {payment.history.map((entry, index) => (
                            <li key={index}>
                              {t.payment[entry.kind]} · <bdi>{entry.recordedAt}</bdi>
                              {entry.actualAmount && entry.actualCurrency ? (
                                <bdi dir="ltr">
                                  {' '}
                                  · {entry.actualAmount} {entry.actualCurrency}
                                </bdi>
                              ) : null}
                              {entry.note ? (
                                <p>
                                  <bdi>{entry.note}</bdi>
                                </p>
                              ) : null}
                              {entry.reference ? (
                                <p>
                                  {t.statement} · <bdi>{entry.reference}</bdi>
                                </p>
                              ) : null}
                              {entry.evidence ? (
                                <p>
                                  {t.evidence} · <bdi>{entry.evidence}</bdi>
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {!staffId && obligation.side === 'payee' && payment.status === 'report' ? (
                      <>
                        <Action
                          submit={submit}
                          fixed={{ ...fixed, action: 'confirm' }}
                          label={t.confirm}
                          copy={t}
                        />
                        <Action
                          submit={submit}
                          fixed={{ ...fixed, action: 'reject' }}
                          label={t.reject}
                          copy={t}
                        >
                          <TextInput name="note" label={t.note} limit={1000} />
                        </Action>
                      </>
                    ) : null}
                    {staffId && reviewAvailable ? (
                      <Action
                        submit={submit}
                        fixed={{ ...fixed, action: 'review' }}
                        label={t.review}
                        copy={t}
                      >
                        <TextInput name="note" label={t.note} limit={1000} />
                      </Action>
                    ) : null}
                    {staffId && payment.status === 'review' && payment.reviewer === staffId ? (
                      <p>{t.independent}</p>
                    ) : null}
                    {staffId && payment.status === 'review' && payment.reviewer !== staffId ? (
                      <>
                        <Action
                          submit={submit}
                          fixed={{ ...fixed, action: 'reconcile' }}
                          label={t.reconcile}
                          copy={t}
                        >
                          <TextInput name="amount" label={t.amount} value={payment.amount} />
                          <TextInput
                            name="currency"
                            label={t.currency}
                            value={obligation.currency}
                            limit={3}
                          />
                          <TextInput name="reference" label={t.statement} />
                          <TextInput name="evidence" label={t.evidence} />
                          <TextInput name="note" label={t.note} limit={1000} required={false} />
                        </Action>
                        <Action
                          submit={submit}
                          fixed={{ ...fixed, action: 'void' }}
                          label={t.void}
                          copy={t}
                        >
                          <TextInput name="note" label={t.note} limit={1000} />
                        </Action>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>{t.noRecords}</p>
          )}
          {financial.recordingOpen && !staffId && obligation.side === 'payer' ? (
            <Action
              submit={submit}
              fixed={{ action: 'report', kind: obligation.kind, currency: obligation.currency }}
              label={t.report}
              copy={t}
            >
              <TextInput name="amount" label={t.amount} />
              <TextInput name="reference" label={t.reference} />
              <TextInput name="evidence" label={t.evidence} />
            </Action>
          ) : null}
        </section>
      ))}
    </section>
  );
}

export function AssignClosure({ ownerId, submit }: { ownerId: string; submit: SubmitCompletion }) {
  return (
    <Action
      submit={submit}
      fixed={{ ownerId }}
      label="Assign closure follow-up to me"
      copy={messages.en}
    />
  );
}
