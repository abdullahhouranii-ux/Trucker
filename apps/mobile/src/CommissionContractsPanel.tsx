import { useState } from 'react';
import { Alert, Button, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  changeCommissionContract,
  loadCommissionContracts,
  proposeCommissionContract,
  type CommissionContracts,
  type createClient,
} from './client';
import { contractMessages, type Language } from './messages';

export function CommissionContractsPanel({
  org,
  token,
  language,
  busy,
  request,
  perform,
}: {
  org: string;
  token: string;
  language: Language;
  busy: boolean;
  request: ReturnType<typeof createClient>;
  perform: (work: () => Promise<void>) => Promise<void>;
}) {
  const [overview, setOverview] = useState<CommissionContracts | null>(null);
  const [carrierCode, setCarrierCode] = useState('');
  const [option, setOption] = useState<'percentage' | 'fixed'>('percentage');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('');
  const [days, setDays] = useState('');
  const t = contractMessages[language];
  const rtl = language === 'en' ? undefined : styles.rtl;
  async function load() {
    setOverview(await loadCommissionContracts(request, org, token));
  }
  function confirm(label: string, command: () => Promise<unknown>) {
    Alert.alert(label, t.confirm, [
      { text: t.cancel, style: 'cancel' },
      {
        text: label,
        onPress: () =>
          void perform(async () => {
            await command();
            await load();
          }),
      },
    ]);
  }
  const basisPoints = /^\d{1,3}(?:\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : 0;
  const settlementDays = /^\d{1,2}$/.test(days) ? Number(days) : 0;
  const terms =
    option === 'percentage'
      ? ({ option, basisPoints } as const)
      : ({ option, amount: value, currency: currency.trim().toUpperCase() } as const);
  const validValue =
    option === 'percentage'
      ? basisPoints > 0 && basisPoints <= (overview?.limits.maxBasisPoints ?? 0)
      : /^\d+(?:\.\d{1,3})?$/.test(value) &&
        Number(value) > 0 &&
        /^[A-Z]{3}$/.test(currency.trim().toUpperCase());
  const field = (
    label: string,
    text: string,
    change: (text: string) => void,
    maxLength: number,
    keyboardType: 'default' | 'decimal-pad' | 'number-pad' = 'default',
  ) => (
    <View style={styles.field}>
      <Text style={rtl}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={styles.input}
        keyboardType={keyboardType}
        autoCorrect={false}
        editable={!busy}
        maxLength={maxLength}
        value={text}
        onChangeText={change}
      />
    </View>
  );

  return (
    <View style={styles.panel}>
      <Button title={t.title} disabled={busy} onPress={() => void perform(load)} />
      {overview?.organiser ? (
        <View style={styles.panel}>
          {field(t.carrier, carrierCode, setCarrierCode, 40)}
          <Button
            title={option === 'percentage' ? t.fixed : t.percent}
            disabled={busy}
            onPress={() => {
              setOption(option === 'percentage' ? 'fixed' : 'percentage');
              setValue('');
            }}
          />
          {field(option === 'percentage' ? t.percent : t.fixed, value, setValue, 20, 'decimal-pad')}
          {option === 'fixed' ? field(t.currency, currency, setCurrency, 3) : null}
          {field(t.days, days, setDays, 2, 'number-pad')}
          <Text style={rtl}>{t.freight}</Text>
          <Button
            title={t.propose}
            disabled={
              busy ||
              !carrierCode.trim() ||
              !validValue ||
              settlementDays < 1 ||
              settlementDays > overview.limits.settlementMaxDays
            }
            onPress={() =>
              confirm(t.propose, async () => {
                await proposeCommissionContract(request, org, token, {
                  carrierCode: carrierCode.trim(),
                  settlementDays,
                  ...terms,
                });
                setCarrierCode('');
              })
            }
          />
        </View>
      ) : null}
      {overview?.contracts.length === 0 ? <Text style={rtl}>{t.empty}</Text> : null}
      {overview?.contracts.map((item) => {
        const change = (action: 'accept' | 'decline' | 'end', label: string) =>
          confirm(label, () =>
            changeCommissionContract(request, org, token, item.id, item.version, action),
          );
        const proposed = item.status === 'proposed';
        const contractValue =
          item.option === 'percentage'
            ? new Intl.NumberFormat(language, {
                style: 'percent',
                maximumFractionDigits: 2,
              }).format((item.basisPoints ?? 0) / 10000)
            : [item.amount, item.currency].join(' ');
        const endLabel = proposed ? t.withdraw : t.end;
        return (
          <View key={item.id} style={styles.panel}>
            <Text style={rtl}>
              {item.role === 'carrier' ? item.organiser.legalName : item.carrier.legalName}
            </Text>
            <Text style={rtl}>{t.states[item.status]}</Text>
            <Text style={rtl}>{contractValue}</Text>
            <Text style={rtl}>{t.days + ' · ' + item.settlementDays}</Text>
            <Text style={rtl}>{t.freight}</Text>
            {proposed && item.role === 'carrier' ? (
              <>
                <Button
                  title={t.accept}
                  disabled={busy}
                  onPress={() => change('accept', t.accept)}
                />
                <Button
                  title={t.decline}
                  disabled={busy}
                  onPress={() => change('decline', t.decline)}
                />
              </>
            ) : null}
            {item.status === 'active' || (proposed && item.role === 'organiser') ? (
              <Button title={endLabel} disabled={busy} onPress={() => change('end', endLabel)} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { gap: 8, paddingVertical: 8 },
  field: { gap: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#64748b',
    borderRadius: 8,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
});
