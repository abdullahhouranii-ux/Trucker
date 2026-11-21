'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Field } from './form.tsx';

export interface DisputeEvent {
  id: string;
  kind: string;
  organisationId: string | null;
  recordedAt: string;
  staffId: string | null;
  data: Record<string, unknown>;
}
export interface BookingDisputes {
  held: boolean;
  tripMilestones: { id: string; kind: string; recordedAt: string }[];
  disputes: {
    id: string;
    openedFor: string;
    openedAt: string;
    kind: string;
    description: string;
    requestedOutcome: string;
    amount: string | null;
    currency: string;
    scope: string | null;
    podVersionId: string | null;
    tripMilestoneId: string | null;
    relatedDisputeId: string | null;
    hold: { id: string; releasedAt: string | null; releaseReason: string | null } | null;
    events: DisputeEvent[];
  }[];
}
export type DisputeSubmission = (
  key: string,
  command: Record<string, unknown>,
) => Promise<'ok' | 'unknown' | 'conflict' | 'refused'>;

const copy = {
  en: {
    attachment: 'Shared evidence file (JPEG, PNG or PDF, up to 10 MB)',
    download: 'Download evidence',
    milestone: 'Trip event (optional)',
    related: 'Related dispute (optional)',
    title: 'Booking disputes',
    counterclaimTerms: 'Terms that settle the counterclaim',
    accept: 'Accept proposal',
    reject: 'Reject proposal',
    withdraw: 'Withdraw dispute',
    release: 'Release this hold',
    open: 'Open a dispute',
    kind: 'Type',
    description: 'Describe your claim',
    outcome: 'Requested outcome',
    amount: 'Disputed amount (optional)',
    scope: 'Disputed item (optional)',
    financial: 'Financial dispute with scope still under review',
    pod: 'Proof of delivery version (optional)',
    active: 'Settlement eligibility on hold',
    released: 'Settlement hold released',
    pending: 'Scope under review',
    none: 'No disputes on this booking.',
    note: 'Message or supporting information',
    send: 'Submit',
    unknown: 'The outcome is uncertain. Refresh the timeline to check, or retry the same request.',
    retry: 'Retry the same request',
    check: 'Check timeline',
    refused: 'The request was refused. Check the fields and your permissions.',
    conflict:
      'The case or proposal changed, or this action is currently unavailable. Check the timeline.',
    done: 'Recorded.',
    confirm: 'I agree to the terms of this version for my organisation.',
    withdrawal: 'Withdrawing ends this case. Other claims and holds may remain active.',
    openedFor: 'Opened for',
    assignee: 'Operations staff ID',
    externalRef: 'External authority and decision reference',
    unassigned: 'An operations owner has not yet been assigned.',
    owner: 'Operations owner assigned',
    finance:
      'An agreement records obligations for later processing. Payments are handled separately.',
    types: [
      'Damage',
      'Shortage',
      'Delay',
      'Unable to deliver',
      'Waiting, storage or return',
      'Freight or commission',
      'Proof of delivery',
    ],
    events: [
      'Opened',
      'In review',
      'Awaiting information',
      'Internal note',
      'Party or staff reply',
      'Counterclaim',
      'Settlement proposal',
      'Accepted',
      'Rejected',
      'Agreement recorded',
      'Withdrawn',
      'Closed without agreement',
      'Reported external decision',
      'Hold released',
    ],
  },
  ar: {
    attachment: 'ملف دليل مشترك (JPEG أو PNG أو PDF، حتى 10 ميغابايت)',
    download: 'تنزيل الدليل',
    milestone: 'حدث الرحلة (اختياري)',
    related: 'نزاع مرتبط (اختياري)',
    title: 'نزاعات الحجز',
    counterclaimTerms: 'بنود تسوية المطالبة المقابلة',
    accept: 'قبول المقترح',
    reject: 'رفض المقترح',
    withdraw: 'سحب النزاع',
    release: 'تحرير هذا الحجز المالي',
    open: 'فتح نزاع',
    kind: 'النوع',
    description: 'صف مطالبتك',
    outcome: 'النتيجة المطلوبة',
    amount: 'المبلغ محل النزاع (اختياري)',
    scope: 'البند محل النزاع (اختياري)',
    financial: 'نزاع مالي لا يزال نطاقه قيد المراجعة',
    pod: 'نسخة إثبات التسليم (اختياري)',
    active: 'أهلية التسوية معلّقة',
    released: 'حُرّر الحجز المالي',
    pending: 'النطاق قيد المراجعة',
    none: 'لا توجد نزاعات على هذا الحجز.',
    note: 'رسالة أو معلومات داعمة',
    send: 'إرسال',
    unknown: 'النتيجة غير مؤكدة. حدّث السجل للتحقق أو أعد إرسال الطلب نفسه.',
    retry: 'إعادة إرسال الطلب نفسه',
    check: 'التحقق من السجل',
    refused: 'رُفض الطلب. تحقق من الحقول والصلاحيات.',
    conflict: 'تغيّرت الحالة أو المقترح، أو أن الإجراء غير متاح حالياً. تحقق من السجل.',
    done: 'تم التسجيل.',
    confirm: 'أوافق باسم مؤسستي على شروط هذه النسخة.',
    withdrawal: 'السحب ينهي هذه الحالة. قد تبقى مطالبات وحجوزات أخرى قائمة.',
    openedFor: 'فُتح لصالح',
    assignee: 'معرّف موظف العمليات',
    externalRef: 'الجهة الخارجية ومرجع القرار',
    unassigned: 'لم يُعيّن مسؤول متابعة بعد.',
    owner: 'عُيّن مسؤول متابعة',
    finance: 'يسجل الاتفاق التزامات تُعالج لاحقاً. تُعالج المدفوعات بصورة مستقلة.',
    types: [
      'تلف',
      'نقص',
      'تأخير',
      'تعذر التسليم',
      'انتظار أو تخزين أو إعادة',
      'أجرة النقل أو العمولة',
      'إثبات التسليم',
    ],
    events: [
      'مفتوح',
      'قيد المراجعة',
      'بانتظار معلومات',
      'ملاحظة داخلية',
      'رد من طرف أو موظف',
      'مطالبة مقابلة',
      'مقترح تسوية',
      'مقبول',
      'مرفوض',
      'اتفاق مسجل',
      'مسحوب',
      'مغلق دون اتفاق',
      'بلاغ عن قرار خارجي',
      'تحرير الحجز المالي',
    ],
  },
  ur: {
    attachment: 'مشترکہ ثبوت کی فائل (JPEG، PNG یا PDF، 10 MB تک)',
    download: 'ثبوت ڈاؤن لوڈ کریں',
    milestone: 'سفر کا واقعہ (اختیاری)',
    related: 'متعلقہ تنازع (اختیاری)',
    title: 'بکنگ کے تنازعات',
    counterclaimTerms: 'جوابی دعوے کے تصفیے کی شرائط',
    accept: 'تجویز قبول کریں',
    reject: 'تجویز مسترد کریں',
    withdraw: 'تنازع واپس لیں',
    release: 'یہ مالی روک ہٹائیں',
    open: 'تنازع درج کریں',
    kind: 'قسم',
    description: 'اپنا دعویٰ بیان کریں',
    outcome: 'مطلوبہ نتیجہ',
    amount: 'متنازع رقم (اختیاری)',
    scope: 'متنازع مد (اختیاری)',
    financial: 'مالی تنازع جس کا دائرہ زیرِ جائزہ ہے',
    pod: 'ثبوتِ ترسیل کا نسخہ (اختیاری)',
    active: 'تصفیے کی اہلیت معطل ہے',
    released: 'مالی روک ہٹا دی گئی',
    pending: 'دائرہ زیرِ جائزہ ہے',
    none: 'اس بکنگ پر کوئی تنازع درج نہیں ہے۔',
    note: 'پیغام یا معاون معلومات',
    send: 'جمع کریں',
    unknown: 'نتیجہ غیر یقینی ہے۔ ریکارڈ دوبارہ دیکھیں یا یہی درخواست دوبارہ بھیجیں۔',
    retry: 'وہی درخواست دوبارہ بھیجیں',
    check: 'ریکارڈ دیکھیں',
    refused: 'درخواست مسترد ہوئی۔ خانے اور اختیارات چیک کریں۔',
    conflict: 'کیس یا تجویز بدل گئی ہے، یا یہ کارروائی فی الحال دستیاب نہیں۔ ریکارڈ دیکھیں۔',
    done: 'درج ہو گیا۔',
    confirm: 'میں اپنی تنظیم کی جانب سے اس نسخے کی شرائط قبول کرتا ہوں۔',
    withdrawal: 'واپسی سے یہ کیس ختم ہو جائے گا۔ دیگر دعوے اور روک برقرار رہ سکتی ہیں۔',
    openedFor: 'جس کی جانب سے کھولا گیا',
    assignee: 'عملے کا شناختی نمبر',
    externalRef: 'بیرونی ادارہ اور فیصلے کا حوالہ',
    unassigned: 'ابھی کوئی ذمہ دار مقرر نہیں ہے۔',
    owner: 'ذمہ دار مقرر ہو گیا ہے',
    finance: 'معاہدے میں بعد میں کارروائی کے لیے ذمہ داریاں درج ہوتی ہیں۔ ادائیگی الگ عمل ہے۔',
    types: [
      'نقصان',
      'کمی',
      'تاخیر',
      'ترسیل ناممکن',
      'انتظار، ذخیرہ یا واپسی',
      'کرایہ یا کمیشن',
      'ثبوتِ ترسیل',
    ],
    events: [
      'کھلا',
      'زیرِ جائزہ',
      'معلومات کا انتظار',
      'اندرونی نوٹ',
      'فریق یا عملے کا جواب',
      'جوابی دعویٰ',
      'تصفیے کی تجویز',
      'قبول',
      'مسترد',
      'معاہدہ درج',
      'واپس لیا گیا',
      'معاہدے کے بغیر بند',
      'بیرونی فیصلے کی اطلاع',
      'مالی روک ہٹا دی گئی',
    ],
  },
};

const kinds = [
  'damage',
  'shortage',
  'delay',
  'undeliverable',
  'waiting_storage_return',
  'freight_commission',
  'pod',
];
const eventKinds = [
  'open',
  'assign',
  'request_information',
  'internal_note',
  'reply',
  'counterclaim',
  'propose',
  'accept',
  'reject',
  'agreement',
  'withdraw',
  'close',
  'external',
  'release',
];
const terminal = ['agreement', 'withdraw', 'close', 'external'];

function CommandForm({
  children,
  fixed,
  submit,
  t,
  label,
}: {
  children?: ReactNode;
  fixed: Record<string, unknown>;
  submit: DisputeSubmission;
  t: typeof copy.en;
  label?: string;
}) {
  const router = useRouter();
  const pending = useRef<{ key: string; body: Record<string, unknown> } | null>(null);
  const requestInFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<'ok' | 'unknown' | 'conflict' | 'refused' | 'busy'>();
  async function send() {
    if (!pending.current || requestInFlight.current) return;
    requestInFlight.current = true;
    setResult('busy');
    const { key, body } = pending.current;
    let outcome: Awaited<ReturnType<DisputeSubmission>>;
    try {
      outcome = await submit(key, body);
    } catch {
      outcome = 'unknown';
    } finally {
      requestInFlight.current = false;
    }
    if (outcome !== 'unknown') pending.current = null;
    setResult(outcome);
    if (outcome === 'ok') {
      formRef.current?.reset();
      router.refresh();
    }
  }
  function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const body: Record<string, unknown> = { ...fixed };
    for (const [name, value] of new FormData(event.currentTarget)) {
      if (typeof value === 'string' && value.trim() && name !== 'confirm')
        body[name] = name === 'financial' ? true : value;
    }
    if (body.action !== 'assign') delete body.assigneeId;
    if (body.action !== 'external') delete body.reference;
    if (body.action !== 'propose') delete body.counterclaimTerms;
    pending.current = { key: crypto.randomUUID(), body };
    void send();
  }
  return (
    <form
      ref={formRef}
      onSubmit={begin}
      className="form"
      data-dispute-command={String(fixed.action ?? 'reply')}
    >
      <fieldset className="fieldset" disabled={result === 'busy' || result === 'unknown'}>
        {children}
        <button className="button" type="submit">
          {label ?? t.send}
        </button>
      </fieldset>
      <div role="status" aria-live="polite">
        {result && result !== 'busy' ? (result === 'ok' ? t.done : t[result]) : null}
      </div>
      {result === 'conflict' || result === 'unknown' ? (
        <button className="button" type="button" onClick={() => router.refresh()}>
          {t.check}
        </button>
      ) : null}
      {result === 'unknown' ? (
        <button className="button" type="button" onClick={() => void send()}>
          {t.retry}
        </button>
      ) : null}
    </form>
  );
}

function TextField({
  label,
  name,
  required = false,
  maxLength = 1000,
}: {
  label: string;
  name: string;
  required?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <Field label={label} id={id}>
      <input type="text" name={name} id={id} required={required} maxLength={maxLength} />
    </Field>
  );
}

function DisputeCheckbox({
  name,
  label,
  required,
}: {
  name: string;
  label: string;
  required?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="dispute-checkbox">
      <input id={id} name={name} type="checkbox" required={required} />
      {label}
    </label>
  );
}

export function DisputePanel({
  view,
  submit,
  locale,
  org,
  currency,
  parties,
  canRelease,
  bookingId,
  podVersions = [],
}: {
  view: BookingDisputes;
  submit: DisputeSubmission;
  locale: keyof typeof copy;
  org?: string;
  currency?: string;
  parties?: { id: string; label: string }[];
  canRelease?: boolean;
  bookingId: string;
  podVersions?: { id: string; version: number }[];
}) {
  const t = copy[locale];
  const staff = org === undefined;
  const label = (action: string) => t.events[eventKinds.indexOf(action)] ?? action;
  return (
    <section id="disputes" className="section" aria-labelledby="disputes-title">
      <h2 id="disputes-title">{t.title}</h2>
      {view.disputes.length ? null : <p>{t.none}</p>}
      {view.disputes.map((d) => {
        const end = d.events.find((event) => terminal.includes(event.kind));
        const proposal = d.events.findLast((event) => event.kind === 'propose');
        const lastCounterclaim = d.events.findLastIndex((event) => event.kind === 'counterclaim');
        const agreedProposal = d.events.find(
          (event) => event.kind === 'propose' && event.id === end?.data.proposalId,
        );
        const agreementCoversCounterclaims =
          lastCounterclaim < 0 ||
          (agreedProposal !== undefined &&
            d.events.indexOf(agreedProposal) > lastCounterclaim &&
            typeof agreedProposal.data.counterclaimTerms === 'string' &&
            agreedProposal.data.counterclaimTerms.trim().length > 0);
        const answered = d.events.some(
          (event) =>
            event.organisationId === org &&
            (event.kind === 'accept' || event.kind === 'reject') &&
            event.data.proposalId === proposal?.id,
        );
        const owner = d.events.findLast((event) => event.kind === 'assign');
        const stage =
          end ??
          d.events.findLast((event) =>
            ['assign', 'request_information', 'propose'].includes(event.kind),
          );
        const fixed = { disputeId: d.id };
        const evidenceRoot = `${staff ? '' : '/' + locale}/files/disputes/${bookingId}/${d.id}`;
        const evidenceQuery = org ? '?org=' + encodeURIComponent(org) : '';
        return (
          <article key={d.id} className="panel" id={d.id}>
            <h3>{t.types[kinds.indexOf(d.kind)]}</h3>
            <p>
              {label(stage?.kind ?? 'open')} · {owner ? t.owner : t.unassigned}
            </p>
            {staff && owner ? (
              <p>
                <bdi>{String(owner.data.assigneeId)}</bdi>
              </p>
            ) : null}
            <p>
              <bdi>{d.description}</bdi>
            </p>
            <p>
              {t.outcome} · <bdi>{d.requestedOutcome}</bdi>
            </p>
            {staff ? (
              <p>
                {t.openedFor} ·{' '}
                <bdi>
                  {parties?.find((party) => party.id === d.openedFor)?.label ?? d.openedFor}
                </bdi>
              </p>
            ) : null}
            {d.podVersionId ? (
              <p>
                {t.pod} ·{' '}
                <bdi>
                  {podVersions.find(({ id }) => id === d.podVersionId)?.version ?? d.podVersionId}
                </bdi>
              </p>
            ) : null}
            {d.tripMilestoneId ? (
              <p>
                {t.milestone} ·{' '}
                <bdi>
                  {view.tripMilestones.find(({ id }) => id === d.tripMilestoneId)?.recordedAt}
                </bdi>
              </p>
            ) : null}
            {d.relatedDisputeId ? (
              <p>
                <a href={'#' + d.relatedDisputeId}>{t.related}</a>
              </p>
            ) : null}
            {d.hold ? (
              <p>
                {d.hold.releasedAt ? t.released : t.active}
                {' · '}
                {d.scope ?? (d.amount === null ? t.pending : '')}
                {d.amount ? (
                  <>
                    {' '}
                    <bdi>
                      {d.amount} {d.currency}
                    </bdi>
                  </>
                ) : null}
              </p>
            ) : null}
            <ol className="evidence">
              {d.events.map((event) => (
                <li key={event.id}>
                  <strong>
                    {event.kind === 'evidence' ? (
                      <a href={evidenceRoot + '/' + event.id + evidenceQuery}>{t.download}</a>
                    ) : (
                      label(event.kind)
                    )}
                  </strong>{' '}
                  <time dateTime={event.recordedAt}>
                    <bdi>
                      {new Date(event.recordedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
                    </bdi>
                  </time>
                  {typeof event.data.counterclaimTerms === 'string' ? (
                    <p>
                      {t.counterclaimTerms} <bdi>{event.data.counterclaimTerms}</bdi>
                    </p>
                  ) : null}
                  {typeof event.data.note === 'string' ? (
                    <p>
                      <bdi>{event.data.note}</bdi>
                    </p>
                  ) : null}
                  {typeof event.data.reference === 'string' ? (
                    <p>
                      <bdi>{event.data.reference}</bdi>
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
            {proposal && !end ? <p>{t.finance}</p> : null}
            {proposal && !staff && !end && !answered ? (
              <div key={proposal.id}>
                <CommandForm
                  fixed={{ ...fixed, action: 'accept', proposalId: proposal.id }}
                  submit={submit}
                  t={t}
                  label={t.accept}
                >
                  <DisputeCheckbox name="confirm" label={t.confirm} required />
                </CommandForm>
                <CommandForm
                  fixed={{ ...fixed, action: 'reject', proposalId: proposal.id }}
                  submit={submit}
                  t={t}
                  label={t.reject}
                />
              </div>
            ) : null}
            {!end ? (
              <details>
                <summary>{t.send}</summary>
                <EvidenceForm endpoint={evidenceRoot + evidenceQuery} t={t} />
                <CommandForm fixed={fixed} submit={submit} t={t}>
                  <label>
                    {t.kind}{' '}
                    <select name="action" defaultValue="reply">
                      {(staff
                        ? [
                            'reply',
                            'assign',
                            'request_information',
                            'internal_note',
                            'propose',
                            'close',
                            'external',
                          ]
                        : org === d.openedFor
                          ? ['reply']
                          : ['reply', 'counterclaim']
                      ).map((action) => (
                        <option key={action} value={action}>
                          {label(action)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t.note}
                    <textarea name="note" required maxLength={4000} />
                  </label>
                  {staff ? (
                    <>
                      <TextField label={t.assignee} name="assigneeId" />
                      <TextField label={t.externalRef} name="reference" />
                      {lastCounterclaim >= 0 ? (
                        <label>
                          {t.counterclaimTerms}
                          <textarea name="counterclaimTerms" maxLength={4000} />
                        </label>
                      ) : null}
                    </>
                  ) : null}
                </CommandForm>
                {!staff && org === d.openedFor ? (
                  <CommandForm
                    fixed={{ ...fixed, action: 'withdraw' }}
                    submit={submit}
                    t={t}
                    label={t.withdraw}
                  >
                    <p>{t.withdrawal}</p>
                  </CommandForm>
                ) : null}
              </details>
            ) : null}
            {staff &&
            canRelease &&
            d.hold &&
            !d.hold.releasedAt &&
            ((end?.kind === 'agreement' && agreementCoversCounterclaims) ||
              (end?.kind === 'withdraw' && lastCounterclaim < 0)) ? (
              <CommandForm
                fixed={{ ...fixed, action: 'release' }}
                submit={submit}
                t={t}
                label={t.release}
              >
                <label>
                  {t.note}
                  <textarea name="note" required maxLength={1000} />
                </label>
              </CommandForm>
            ) : null}
          </article>
        );
      })}
      {!staff || parties?.length ? (
        <details>
          <summary>{t.open}</summary>
          <CommandForm fixed={{ action: 'open' }} submit={submit} t={t} label={t.open}>
            {staff ? (
              <label>
                {t.openedFor}
                <select name="organisationId" required>
                  {parties?.map((party) => (
                    <option key={party.id} value={party.id}>
                      {party.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              {t.kind}
              <select name="kind" required>
                {kinds.map((kind, index) => (
                  <option key={kind} value={kind}>
                    {t.types[index]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.description}
              <textarea name="description" required maxLength={4000} />
            </label>
            <label>
              {t.outcome}
              <textarea name="requestedOutcome" required maxLength={4000} />
            </label>
            <TextField label={currency ? t.amount + ' · ' + currency : t.amount} name="amount" />
            <TextField label={t.scope} name="scope" />
            <DisputeCheckbox name="financial" label={t.financial} />
            {view.tripMilestones.length ? (
              <label>
                {t.milestone}
                <select name="tripMilestoneId">
                  <option value="">—</option>
                  {view.tripMilestones.map(({ id, recordedAt }, n) => (
                    <option key={id} value={id}>
                      {n + 1} · {recordedAt.replace('T', ' ').slice(0, 16)} UTC
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {view.disputes.length ? (
              <label>
                {t.related}
                <select name="relatedDisputeId">
                  <option value="">—</option>
                  {view.disputes.map(({ id, kind, openedAt }) => (
                    <option key={id} value={id}>
                      {t.types[kinds.indexOf(kind)]} · {openedAt.replace('T', ' ').slice(0, 16)} UTC
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {podVersions.length ? (
              <label>
                {t.pod}
                <select name="podVersionId">
                  <option value="">—</option>
                  {podVersions.map(({ id, version }) => (
                    <option key={id} value={id}>
                      {version}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {staff ? <TextField label={t.note} name="note" required /> : null}
          </CommandForm>
        </details>
      ) : null}
    </section>
  );
}

function EvidenceForm({ endpoint, t }: { endpoint: string; t: typeof copy.en }) {
  const fileId = useId();
  const router = useRouter();
  const pending = useRef<{ key: string; file: File } | null>(null);
  const [state, setState] = useState<'busy' | 'unknown' | 'refused' | 'ok'>();
  const form = useRef<HTMLFormElement>(null);
  async function upload() {
    if (!pending.current || state === 'busy') return;
    const { key, file } = pending.current;
    setState('busy');
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'idempotency-key': key, 'content-type': file.type },
        body: file,
      });
      if (response.status >= 500) {
        setState('unknown');
        return;
      }
      pending.current = null;
      setState(response.ok ? 'ok' : 'refused');
      if (response.ok) {
        form.current?.reset();
        router.refresh();
      }
    } catch {
      setState('unknown');
    }
  }
  return (
    <form
      data-dispute-evidence
      ref={form}
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        const file = new FormData(event.currentTarget).get('file');
        if (!(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024) {
          setState('refused');
          return;
        }
        pending.current = { key: crypto.randomUUID(), file };
        void upload();
      }}
    >
      <fieldset className="fieldset" disabled={state === 'busy' || state === 'unknown'}>
        <Field id={fileId} label={t.attachment}>
          <input
            id={fileId}
            className="dispute-file"
            type="file"
            name="file"
            required
            accept="image/jpeg,image/png,application/pdf"
          />
        </Field>
        <button className="button" type="submit">
          {t.send}
        </button>
      </fieldset>
      <div role="status">
        {state && state !== 'busy' ? (state === 'ok' ? t.done : t[state]) : null}
      </div>
      {state === 'unknown' ? (
        <>
          <button className="button" type="button" onClick={() => router.refresh()}>
            {t.check}
          </button>
          <button className="button" type="button" onClick={() => void upload()}>
            {t.retry}
          </button>
        </>
      ) : null}
    </form>
  );
}
