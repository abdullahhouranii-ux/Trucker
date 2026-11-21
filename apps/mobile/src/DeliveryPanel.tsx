import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Assignment, createClient } from './client';
import { messages, type Language } from './messages';

const copy = {
  en: {
    title: 'Delivery outcome',
    outcomes: [
      'Delivered in full',
      'Delivered with remarks',
      'Partly delivered',
      'Refused',
      'Not delivered',
    ],
    receiver: 'Receiver name',
    remarks: 'Remarks',
    place: 'Where is the remaining cargo?',
    condition: 'Cargo condition',
    delivered: 'Quantity delivered',
    remaining: 'Quantity remaining',
    unit: 'Quantity unit',
    contact: 'Contact attempts (number)',
    reason: 'Reason',
    refusal: 'Explain the shortfall or refusal',
    submit: 'Record delivery outcome',
    reasons: [
      'Wrong address',
      'Receiver absent',
      'Site not ready',
      'Site closed',
      'Receiver refused',
      'Cargo damaged',
      'Other',
    ],
    warning:
      'This records the delivery outcome only. It does not release the truck or settle any money.',
  },
  ar: {
    title: 'نتيجة التسليم',
    outcomes: [
      'تم التسليم كاملاً',
      'تم التسليم مع ملاحظات',
      'تسليم جزئي',
      'رفض الاستلام',
      'لم يتم التسليم',
    ],
    receiver: 'اسم المستلم',
    remarks: 'ملاحظات',
    place: 'أين توجد البضاعة المتبقية؟',
    condition: 'حالة البضاعة',
    delivered: 'الكمية المسلمة',
    remaining: 'الكمية المتبقية',
    unit: 'وحدة الكمية',
    contact: 'عدد محاولات الاتصال',
    reason: 'السبب',
    refusal: 'اشرح النقص أو رفض الاستلام',
    submit: 'تسجيل نتيجة التسليم',
    reasons: [
      'عنوان خاطئ',
      'المستلم غير موجود',
      'الموقع غير جاهز',
      'الموقع مغلق',
      'رفض المستلم',
      'تلف البضاعة',
      'أخرى',
    ],
    warning: 'يسجل هذا الإجراء نتيجة التسليم فقط، ولا يحرر الشاحنة أو يسوي أي مبلغ.',
  },
  ur: {
    title: 'ترسیل کا نتیجہ',
    outcomes: [
      'مکمل ترسیل',
      'ملاحظات کے ساتھ ترسیل',
      'جزوی ترسیل',
      'وصولی سے انکار',
      'ترسیل نہیں ہوئی',
    ],
    receiver: 'وصول کنندہ کا نام',
    remarks: 'ملاحظات',
    place: 'باقی سامان کہاں ہے؟',
    condition: 'سامان کی حالت',
    delivered: 'ترسیل شدہ مقدار',
    remaining: 'باقی مقدار',
    unit: 'مقدار کی اکائی',
    contact: 'رابطے کی کوششوں کی تعداد',
    reason: 'وجہ',
    refusal: 'کمی یا انکار کی وضاحت',
    submit: 'ترسیل کا نتیجہ درج کریں',
    reasons: [
      'غلط پتہ',
      'وصول کنندہ غیر حاضر',
      'سائٹ تیار نہیں',
      'سائٹ بند',
      'وصول کنندہ نے انکار کیا',
      'سامان کو نقصان',
      'دیگر',
    ],
    warning: 'یہ صرف ترسیل کا نتیجہ درج کرتا ہے۔ گاڑی آزاد نہیں ہوتی اور رقم ادا نہیں ہوتی۔',
  },
};
const outcomes = [
  'delivered_in_full',
  'delivered_with_remarks',
  'partly_delivered',
  'refused',
  'not_delivered',
];
const reasons = [
  'wrong_address',
  'receiver_absent',
  'site_not_ready',
  'site_closed',
  'receiver_refused',
  'cargo_damaged',
  'other',
];
export function DeliveryPanel({
  assignment,
  token,
  request,
  language,
  busy,
  perform,
  refresh,
}: {
  assignment: Assignment;
  token: string;
  request: ReturnType<typeof createClient>;
  language: Language;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [outcome, setOutcome] = useState('delivered_in_full');
  const [reason, setReason] = useState('receiver_refused');
  const [values, setValues] = useState<Record<string, string>>({ contact: '0' });
  const m = copy[language];
  const direction = language === 'en' ? undefined : styles.rtl;
  if (!assignment.trip || assignment.trip.delivery?.outcome || assignment.trip.hold) return null;
  const shortfall = ['partly_delivered', 'refused', 'not_delivered'].includes(outcome);
  const input = (key: keyof typeof m, numeric = false) => (
    <View key={key} style={styles.field}>
      <Text style={[styles.label, direction]}>{m[key] as string}</Text>
      <TextInput
        accessibilityLabel={m[key] as string}
        editable={!busy}
        value={values[key] ?? ''}
        onChangeText={(value) => setValues((old) => ({ ...old, [key]: value }))}
        maxLength={numeric ? 20 : 1000}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        style={[styles.input, !numeric && direction]}
      />
    </View>
  );
  const delivered = ['delivered_in_full', 'delivered_with_remarks', 'partly_delivered'].includes(
    outcome,
  );
  const valid =
    (!delivered || !!values.receiver?.trim()) &&
    (!shortfall ||
      ['place', 'condition', 'delivered', 'remaining', 'unit', 'refusal'].every(
        (key) => !!values[key]?.trim(),
      ));
  async function submit() {
    await request(`/me/driver/assignments/${assignment.bookingId}/delivery`, {
      token,
      method: 'POST',
      body: {
        version: 0,
        outcome,
        receiverName: delivered ? values.receiver : null,
        remarks: values.remarks || null,
        cargoRemains: shortfall,
        ...(shortfall
          ? {
              shortfall: {
                reason,
                refusalReason: values.refusal,
                location: values.place,
                cargoCondition: values.condition,
                quantityUnit: values.unit,
                quantityDelivered: values.delivered,
                quantityRemaining: values.remaining,
                contactAttempts: Number(values.contact),
                contactNote: null,
                evidenceNote: null,
              },
            }
          : {}),
      },
    });
    await refresh();
  }
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={[styles.title, direction]}>
        {m.title}
      </Text>
      <Text style={[styles.label, direction]}>{m.warning}</Text>
      {outcomes.map((value, index) => (
        <Pressable
          key={value}
          disabled={busy}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === outcome, disabled: busy }}
          onPress={() => setOutcome(value)}
          style={[styles.choice, value === outcome && styles.selected]}
        >
          <Text style={[styles.label, direction]}>
            {value === outcome ? '● ' : '○ '}
            {m.outcomes[index]}
          </Text>
        </Pressable>
      ))}
      {delivered ? input('receiver') : null}
      {input('remarks')}
      {shortfall ? (
        <>
          <Text style={[styles.label, direction]}>{m.reason}</Text>
          {reasons.map((value, index) => (
            <Pressable
              key={value}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ checked: value === reason }}
              onPress={() => setReason(value)}
              style={[styles.choice, value === reason && styles.selected]}
            >
              <Text style={[styles.label, direction]}>{m.reasons[index]}</Text>
            </Pressable>
          ))}
          {input('refusal')}
          {input('place')}
          {input('condition')}
          {input('delivered', true)}
          {input('remaining', true)}
          {input('unit')}
          {input('contact', true)}
        </>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || !valid }}
        disabled={busy || !valid}
        style={[styles.submit, (!valid || busy) && styles.disabled]}
        onPress={() =>
          Alert.alert(m.title, m.warning, [
            { text: messages[language].cancel, style: 'cancel' },
            { text: m.submit, onPress: () => void perform(submit) },
          ])
        }
      >
        <Text style={[styles.buttonText, direction]}>{m.submit}</Text>
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    padding: 20,
    gap: 14,
    borderRadius: 20,
    backgroundColor: '#FFF',
    borderWidth: 1,
    borderColor: '#C5CAD0',
  },
  title: { color: '#1F2328', fontSize: 24, lineHeight: 38, fontWeight: '700' },
  label: { color: '#1F2328', fontSize: 16, lineHeight: 28 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  field: { gap: 6 },
  input: {
    minHeight: 52,
    borderColor: '#6B737C',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 17,
    color: '#1F2328',
  },
  choice: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: '#6B737C', borderRadius: 12 },
  selected: { backgroundColor: '#E3ECF8', borderColor: '#0B4EA2' },
  submit: {
    minHeight: 52,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#0B4EA2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 17, lineHeight: 28, fontWeight: '600', color: '#FFF' },
  disabled: { backgroundColor: '#4A525C' },
});
