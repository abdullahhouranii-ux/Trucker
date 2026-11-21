import { useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { Alert, Button, StyleSheet, Text, View } from 'react-native';
import {
  loadCarrierQuotations,
  withdrawCarrierQuotation,
  type CarrierQuotation,
  type createClient,
} from './client';
import { carrierQuotesMessages, shipmentAcceptMessages, type Language } from './messages';

export function CarrierQuotationsPanel({
  org,
  token,
  request,
  language,
  busy,
  perform,
}: {
  org: string;
  token: string;
  request: ReturnType<typeof createClient>;
  language: Language;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
}) {
  const [quotes, setQuotes] = useState<CarrierQuotation[] | null>(null);
  const [notice, setNotice] = useState(false);
  const keys = useRef(new Map<string, string>());
  const t = carrierQuotesMessages[language];
  const states: Record<string, string> = shipmentAcceptMessages[language].states;
  const rtl = language === 'en' ? undefined : styles.rtl;

  function confirm(quote: CarrierQuotation) {
    Alert.alert(t.withdraw, t.prompt, [
      { text: t.cancel, style: 'cancel' },
      {
        text: t.withdraw,
        style: 'destructive',
        onPress: () =>
          void perform(async () => {
            setNotice(false);
            const signature = quote.id + ':' + quote.currentVersion;
            let key = keys.current.get(signature);
            if (!key) {
              key = Crypto.randomUUID();
              keys.current.set(signature, key);
            }
            const reply = await withdrawCarrierQuotation(
              request,
              org,
              token,
              quote.id,
              quote.currentVersion,
              key,
            );
            if (reply.quotation.id !== quote.id || reply.quotation.status !== 'withdrawn')
              throw new Error('Withdrawal unconfirmed');
            setQuotes(
              (current) =>
                current?.map((item) => (item.id === quote.id ? reply.quotation : item)) ?? null,
            );
            setNotice(true);
          }),
      },
    ]);
  }

  return (
    <View style={styles.panel}>
      <Button
        title={t.open}
        disabled={busy}
        onPress={() =>
          void perform(async () => {
            setQuotes(await loadCarrierQuotations(request, org, token));
            setNotice(false);
          })
        }
      />
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={rtl}>
          {t.done}
        </Text>
      ) : null}
      {quotes?.length === 0 ? <Text style={rtl}>{t.empty}</Text> : null}
      {quotes?.map((quote) => {
        const current = quote.versions.find((item) => item.versionNo === quote.currentVersion);
        return (
          <View key={quote.id} style={styles.card}>
            {quote.lane ? (
              <Text style={rtl}>{quote.lane.origin + ' – ' + quote.lane.destination}</Text>
            ) : null}
            <Text selectable style={rtl}>
              {quote.shipmentId}
            </Text>
            <Text style={rtl}>{states[quote.status] ?? quote.status}</Text>
            {current ? <Text style={rtl}>{current.amount + ' ' + current.currency}</Text> : null}
            {quote.status === 'submitted' ? (
              <Button title={t.withdraw} disabled={busy} onPress={() => confirm(quote)} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { gap: 8, paddingVertical: 8 },
  card: { gap: 8, padding: 12, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8 },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
});
