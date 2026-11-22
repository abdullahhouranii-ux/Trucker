import * as Crypto from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  confirmBrokerReceipt,
  loadBrokerCommissions,
  loadBrokerPayments,
  type BrokerPaymentRecord,
  type BrokerCommissions,
  type createClient,
} from './client';
import { brokerCommissionMessages, type Language } from './messages';

export function BrokerCommissionsPanel({
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
  const [records, setRecords] = useState<BrokerCommissions | null>(null);
  const [selected, setSelected] = useState<{
    bookingId: string;
    record: BrokerPaymentRecord | null;
  } | null>(null);
  const keys = useRef(new Map<string, string>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const t = brokerCommissionMessages[language];
  const direction = language === 'en' ? undefined : styles.rtl;
  async function load() {
    const result = await loadBrokerCommissions(request, org, token);
    if (mounted.current) setRecords(result);
  }
  async function openPayments(bookingId: string) {
    const record = await loadBrokerPayments(request, org, bookingId, token);
    if (mounted.current) setSelected({ bookingId, record });
  }
  function confirmReceipt(bookingId: string, paymentId: string) {
    Alert.alert(t.confirm, t.confirmPrompt, [
      { text: t.cancel, style: 'cancel' },
      {
        text: t.confirm,
        onPress: () =>
          void perform(async () => {
            const identity = bookingId + ':' + paymentId;
            const key = keys.current.get(identity) ?? Crypto.randomUUID();
            keys.current.set(identity, key);
            const reply = await confirmBrokerReceipt(
              request,
              org,
              bookingId,
              token,
              paymentId,
              key,
            );
            if (reply.paymentId !== paymentId) throw new Error('Unconfirmed payment identity');
            if (!mounted.current) return;
            setSelected((current) => {
              if (current?.bookingId !== bookingId || !current.record) return current;
              return {
                bookingId,
                record: {
                  ...current.record,
                  payments: current.record.payments.map((payment) =>
                    payment.id === paymentId ? { ...payment, status: 'confirm' } : payment,
                  ),
                },
              };
            });
          }),
      },
    ]);
  }
  return (
    <View style={styles.panel}>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void perform(load)}
        style={styles.button}
      >
        <Text style={[styles.buttonText, direction]}>{t.open}</Text>
      </Pressable>
      {records ? (
        <>
          <Text accessibilityRole="header" style={direction}>
            {t.booking}
          </Text>
          {records.bookings.length ? (
            records.bookings.map((item) => (
              <View key={item.bookingId} style={styles.row}>
                <Text style={direction}>{item.bookingId}</Text>
                <Text style={direction}>{item.commission + ' ' + item.currency}</Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void perform(() => openPayments(item.bookingId))}
                  style={styles.button}
                >
                  <Text style={[styles.buttonText, direction]}>{t.payments}</Text>
                </Pressable>
                {selected?.bookingId === item.bookingId ? (
                  selected.record?.payments.length ? (
                    selected.record.payments.map((payment) => (
                      <View key={payment.id} style={styles.panel}>
                        <Text style={direction}>
                          {payment.amount + ' ' + selected.record?.currency}
                        </Text>
                        <Text style={direction}>{t.reference + ' · ' + payment.reference}</Text>
                        {payment.status === 'confirm' ? (
                          <Text style={direction}>{t.confirmed}</Text>
                        ) : null}
                        {selected.record?.recordingOpen && payment.status === 'report' ? (
                          <Pressable
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={() => confirmReceipt(item.bookingId, payment.id)}
                            style={styles.button}
                          >
                            <Text style={[styles.buttonText, direction]}>{t.confirm}</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ))
                  ) : (
                    <Text style={direction}>{t.noPayments}</Text>
                  )
                ) : null}
              </View>
            ))
          ) : (
            <Text style={direction}>{t.empty}</Text>
          )}
          <Text accessibilityRole="header" style={direction}>
            {t.quotation}
          </Text>
          {records.quotations.length ? (
            records.quotations.map((item) => (
              <View key={item.quotationId} style={styles.row}>
                <Text style={direction}>{item.quotationId}</Text>
                <Text style={direction}>{item.commission + ' ' + item.currency}</Text>
              </View>
            ))
          ) : (
            <Text style={direction}>{t.empty}</Text>
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 10 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  row: { padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#C5CAD0' },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#0B4EA2',
  },
  buttonText: { color: '#fff', fontWeight: '600' },
});
