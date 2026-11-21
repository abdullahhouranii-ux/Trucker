import { useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { Alert, Button, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  ApiFailure,
  loadMobileQuotation,
  submitMobileQuotation,
  type MobileQuotationContext,
  type MobileQuotationInput,
  type Organisation,
  type createClient,
} from './client';
import { mobileQuoteMessages, type Language } from './messages';

const wallClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const validOffset = (value: string) =>
  !value || (/^[+-]?\d{1,4}$/.test(value) && Math.abs(Number(value)) <= 1440);

export function MobileQuotationPanel({
  shipment,
  organisations,
  token,
  request,
  language,
  busy,
  perform,
}: {
  shipment: string;
  organisations: Organisation[];
  token: string;
  request: ReturnType<typeof createClient>;
  language: Language;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<{
    org: string;
    context: MobileQuotationContext;
  } | null>(null);
  const [amount, setAmount] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [validOffsetValue, setValidOffsetValue] = useState('');
  const [earliest, setEarliest] = useState('');
  const [pickupOffset, setPickupOffset] = useState('');
  const [inclusions, setInclusions] = useState<Record<string, boolean>>({});
  const [cash, setCash] = useState(false);
  const [bank, setBank] = useState(false);
  const [days, setDays] = useState('');
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState(false);
  const [commission, setCommission] = useState<{
    commission: string;
    net: string;
    signature: string;
  } | null>(null);
  const keys = useRef(new Map<string, string>());
  const t = mobileQuoteMessages[language];
  const rtl = language === 'en' ? undefined : styles.rtl;
  const context = selection?.context;
  const terms = context?.terms;
  const existing = context?.quotations.some((quote) => quote.status === 'submitted');
  const bankDays = /^\d{1,3}$/.test(days) ? Number(days) : -1;
  const decimals = amount.split('.')[1]?.length ?? 0;
  const ready =
    terms &&
    /^\d{1,13}(?:\.\d{1,3})?$/.test(amount) &&
    /[1-9]/.test(amount) &&
    decimals <= terms.minorUnits &&
    terms.inclusions.every(({ code }) => typeof inclusions[code] === 'boolean') &&
    wallClock.test(validUntil) &&
    wallClock.test(earliest) &&
    validOffset(validOffsetValue) &&
    validOffset(pickupOffset) &&
    (cash || bank) &&
    (!bank || (bankDays >= 0 && bankDays <= (context?.freightMaxDueDays ?? 0)));

  async function choose(org: string) {
    setSelection(null);
    setProblem('');
    setDone(false);
    setCommission(null);
    setInclusions({});
    try {
      const result = await loadMobileQuotation(request, org, token, shipment);
      setAmount('');
      setValidUntil(result.quotationDeadline.local);
      setValidOffsetValue('');
      setEarliest(result.pickupWindow.from);
      setPickupOffset('');
      setCash(false);
      setBank(false);
      setDays('');
      setSelection({ org, context: result });
    } catch (error) {
      if (error instanceof ApiFailure && (error.status === 403 || error.status === 404)) {
        setProblem(t.unavailable);
        return;
      }
      throw error;
    }
  }
  function confirm() {
    if (!selection || !ready) return;
    const methods: MobileQuotationInput['freight']['methods'] = [];
    if (cash) methods.push('cash_on_delivery');
    if (bank) methods.push('bank_transfer');
    const time = (local: string, offset: string) => ({
      local,
      ...(offset ? { offsetMinutes: Number(offset) } : {}),
    });
    const base: MobileQuotationInput = {
      amount,
      inclusions,
      validUntil: time(validUntil, validOffsetValue),
      earliestPickup: time(earliest, pickupOffset),
      freight: { methods, dueDays: bank ? bankDays : null },
    };
    const signature = JSON.stringify([selection.org, base]);
    const figures =
      commission?.signature === signature
        ? { commission: commission.commission, net: commission.net }
        : null;
    const body = figures ? { ...base, commissionAccepted: figures } : base;
    Alert.alert(
      t.submit,
      figures
        ? t.commission +
            ' ' +
            figures.commission +
            ' · ' +
            t.net +
            ' ' +
            figures.net +
            ' ' +
            (terms?.currency ?? '')
        : t.confirm,
      [
        { text: t.cancel, style: 'cancel' },
        {
          text: t.submit,
          onPress: () =>
            void perform(async () => {
              const retryScope = JSON.stringify([selection.org, body]);
              let key = keys.current.get(retryScope);
              if (!key) {
                key = Crypto.randomUUID();
                keys.current.set(retryScope, key);
              }
              try {
                const reply = await submitMobileQuotation(
                  request,
                  selection.org,
                  token,
                  shipment,
                  key,
                  body,
                );
                if (!reply.quotation?.id) throw new Error('Quotation not confirmed');
                setProblem('');
                setCommission(null);
                setDone(true);
              } catch (error) {
                if (error instanceof ApiFailure && error.code === 'fleet_mismatch') {
                  setSelection(null);
                  setProblem(t.mismatch);
                  return;
                }
                if (error instanceof ApiFailure && error.commissionFigures) {
                  setCommission({ ...error.commissionFigures, signature });
                  setProblem(t.reviewCommission);
                  return;
                }
                throw error;
              }
            }),
        },
      ],
    );
  }
  const field = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    maxLength: number,
  ) => (
    <View style={styles.group}>
      <Text style={rtl}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCorrect={false}
        editable={!busy}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
      />
    </View>
  );
  const toggle = (label: string, value: boolean, change: (value: boolean) => void) => (
    <View style={styles.group}>
      <Text style={rtl}>{label}</Text>
      <Switch accessibilityLabel={label} disabled={busy} value={value} onValueChange={change} />
    </View>
  );
  return (
    <View style={styles.group}>
      <Button title={open ? t.close : t.open} disabled={busy} onPress={() => setOpen(!open)} />
      {open ? (
        <>
          <Text style={rtl}>{t.company}</Text>
          {organisations.map((org) => (
            <Button
              key={org.id}
              title={org.legalName}
              disabled={busy}
              onPress={() => void perform(() => choose(org.id))}
            />
          ))}
          {problem ? (
            <Text accessibilityRole="alert" style={rtl}>
              {problem}
            </Text>
          ) : null}
          {done ? (
            <Text accessibilityLiveRegion="polite" style={rtl}>
              {t.done}
            </Text>
          ) : null}
          {context && !done ? (
            !context.fleetMatches ? (
              <Text style={rtl}>{t.mismatch}</Text>
            ) : existing ? (
              <Text style={rtl}>{t.existing}</Text>
            ) : !terms ? (
              <Text style={rtl}>{t.noTerms}</Text>
            ) : (
              <>
                {field(t.amount + ' · ' + terms.currency, amount, setAmount, 20)}
                <Text style={rtl}>{t.zone + ' · ' + context.pickupWindow.timeZone}</Text>
                <Text style={rtl}>{t.deadline + ' · ' + context.quotationDeadline.local}</Text>
                <Text style={rtl}>
                  {t.window +
                    ' · ' +
                    context.pickupWindow.from +
                    ' – ' +
                    context.pickupWindow.until}
                </Text>
                {field(t.valid, validUntil, setValidUntil, 16)}
                {field(t.validOffset, validOffsetValue, setValidOffsetValue, 5)}
                {field(t.pickup, earliest, setEarliest, 16)}
                {field(t.pickupOffset, pickupOffset, setPickupOffset, 5)}
                {terms.inclusions.map((entry) => (
                  <View key={entry.code} style={styles.group}>
                    <Text style={rtl}>{entry.name[language]}</Text>
                    <Button
                      title={(inclusions[entry.code] === true ? '✓ ' : '') + t.yes}
                      disabled={busy}
                      onPress={() => setInclusions((items) => ({ ...items, [entry.code]: true }))}
                    />
                    <Button
                      title={(inclusions[entry.code] === false ? '✓ ' : '') + t.no}
                      disabled={busy}
                      onPress={() => setInclusions((items) => ({ ...items, [entry.code]: false }))}
                    />
                  </View>
                ))}
                {toggle(t.cash, cash, setCash)}
                {toggle(t.bank, bank, setBank)}
                {bank ? field(t.days + ' · ' + context.freightMaxDueDays, days, setDays, 3) : null}
                <Button title={t.submit} disabled={busy || !ready} onPress={confirm} />
              </>
            )
          ) : null}
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  group: { gap: 8, paddingVertical: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#64748b',
    borderRadius: 8,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
});
