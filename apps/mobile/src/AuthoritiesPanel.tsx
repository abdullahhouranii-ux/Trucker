import { useState } from 'react';
import { Alert, Button, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  loadAuthorities,
  loadArrangedQuotations,
  type ArrangedQuotation,
  decideAuthority,
  type AuthorityDecision,
  requestAuthority,
  endAuthority,
  type AuthorityOverview,
  type createClient,
} from './client';
import {
  arrangedShipmentMessages,
  authorityDecisionMessages,
  brokerAuthorityMessages,
  type Language,
} from './messages';

export function AuthoritiesPanel({
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
  const [overview, setOverview] = useState<AuthorityOverview | null>(null);
  const [options, setOptions] = useState<
    Record<string, { mayPublish: boolean; feePayerAgreed: boolean }>
  >({});
  const [quotes, setQuotes] = useState<{ shipment: string; items: ArrangedQuotation[] } | null>(
    null,
  );
  const [customerCode, setCustomerCode] = useState('');
  const t = brokerAuthorityMessages[language];
  const d = authorityDecisionMessages[language];
  const a = arrangedShipmentMessages[language];
  const state = (status: string) => (a.states as Record<string, string>)[status] ?? status;
  const rtl = language === 'en' ? undefined : styles.rtl;
  async function load() {
    setOverview(await loadAuthorities(request, org, token));
    setQuotes(null);
  }

  return (
    <View style={styles.panel}>
      <Button title={t.load} disabled={busy} onPress={() => void perform(load)} />
      {overview?.organiser ? (
        <>
          <Text style={rtl}>{t.code}</Text>
          <TextInput
            accessibilityLabel={t.code}
            autoCapitalize="characters"
            autoCorrect={false}
            value={customerCode}
            onChangeText={setCustomerCode}
            editable={!busy}
            maxLength={40}
            style={styles.input}
          />
          <Button
            title={t.send}
            disabled={busy || !customerCode.trim()}
            onPress={() =>
              void perform(async () => {
                await requestAuthority(request, org, token, customerCode.trim());
                setCustomerCode('');
                await load();
              })
            }
          />
        </>
      ) : null}
      {overview?.authorities.length === 0 ? <Text style={rtl}>{d.empty}</Text> : null}
      {overview?.authorities.map((item) => {
        const versionKey = item.id + ':' + item.version;
        const terms = options[versionKey] ?? { mayPublish: false, feePayerAgreed: false };
        const decide = (decision: AuthorityDecision) => {
          const accepting = decision.decision === 'accept';
          const label = accepting ? d.accept : d.decline;
          Alert.alert(label, accepting ? d.acceptPrompt : d.declinePrompt, [
            { text: t.cancel, style: 'cancel' },
            {
              text: label,
              onPress: () =>
                void perform(async () => {
                  await decideAuthority(request, org, token, item.id, item.version, decision);
                  await load();
                }),
            },
          ]);
        };
        return (
          <View key={item.id} style={styles.panel}>
            <Text style={rtl}>
              {item.role === 'customer' ? item.organiser.legalName : item.customer.legalName}
            </Text>
            <Text style={rtl}>{t.state[item.status]}</Text>
            {item.status === 'active' ? (
              <>
                <Text style={rtl}>{item.mayPublish ? t.publish : t.noPublish}</Text>
                <Text style={rtl}>{item.feePayerAgreed ? t.fee : t.noFee}</Text>
              </>
            ) : null}
            {item.status === 'requested' && item.role === 'customer' ? (
              <>
                <Text style={rtl}>{d.publish}</Text>
                <Switch
                  accessibilityLabel={d.publish}
                  value={terms.mayPublish}
                  disabled={busy}
                  onValueChange={(mayPublish) =>
                    setOptions((current) => ({
                      ...current,
                      [versionKey]: { ...terms, mayPublish },
                    }))
                  }
                />
                <Text style={rtl}>{d.fee}</Text>
                <Switch
                  accessibilityLabel={d.fee}
                  value={terms.feePayerAgreed}
                  disabled={busy}
                  onValueChange={(feePayerAgreed) =>
                    setOptions((current) => ({
                      ...current,
                      [versionKey]: { ...terms, feePayerAgreed },
                    }))
                  }
                />
                <Button
                  title={d.accept}
                  disabled={busy}
                  onPress={() => decide({ decision: 'accept', ...terms })}
                />
                <Button
                  title={d.decline}
                  disabled={busy}
                  onPress={() => decide({ decision: 'decline' })}
                />
              </>
            ) : null}
            {item.status === 'active' ||
            (item.status === 'requested' && item.role === 'organiser') ? (
              <Button
                title={t.end}
                disabled={busy}
                onPress={() =>
                  Alert.alert(t.end, t.prompt, [
                    { text: t.cancel, style: 'cancel' },
                    {
                      text: t.end,
                      style: 'destructive',
                      onPress: () =>
                        void perform(async () => {
                          await endAuthority(request, org, token, item.id, item.version);
                          await load();
                        }),
                    },
                  ])
                }
              />
            ) : null}
          </View>
        );
      })}
      {overview ? (
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={rtl}>
            {a.title}
          </Text>
          {!overview.arranged.length ? <Text style={rtl}>{a.empty}</Text> : null}
          {overview.arranged.map((shipment) => (
            <View key={shipment.id} style={styles.panel}>
              <Text style={rtl}>{shipment.reference || shipment.id.slice(0, 8)}</Text>
              <Text style={rtl}>{state(shipment.status)}</Text>
              <Text style={rtl}>{a.customer + ' · ' + shipment.parties.customer.legalName}</Text>
              {shipment.parties.organiser ? (
                <Text style={rtl}>
                  {a.organiser + ' · ' + shipment.parties.organiser.legalName}
                </Text>
              ) : null}
              <Button
                title={a.quotations}
                disabled={busy}
                onPress={() =>
                  void perform(async () => {
                    setQuotes(null);
                    setQuotes({
                      shipment: shipment.id,
                      items: await loadArrangedQuotations(request, org, token, shipment.id),
                    });
                  })
                }
              />
              {quotes?.shipment === shipment.id ? (
                <>
                  {!quotes.items.length ? <Text style={rtl}>{a.noQuotations}</Text> : null}
                  {quotes.items.map((quote) => {
                    const version = quote.versions.find(
                      ({ versionNo }) => versionNo === quote.currentVersion,
                    );
                    return (
                      <View key={quote.id} style={styles.panel}>
                        <Text style={rtl}>
                          {quote.carrier?.tradingName || quote.carrier?.legalName || a.carrier}
                        </Text>
                        <Text style={rtl}>{state(quote.standing)}</Text>
                        {version ? (
                          <Text style={rtl}>{version.amount + ' ' + version.currency}</Text>
                        ) : null}
                      </View>
                    );
                  })}
                </>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8, paddingVertical: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#64748b',
    borderRadius: 8,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
});
