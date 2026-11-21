import { useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { Alert, Button, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  ApiFailure,
  acceptShipmentQuotation,
  rejectShipmentQuotation,
  loadShipmentBookingPreview,
  type ShipmentBookingPreview,
  type FreightChoice,
  loadShipmentQuotationTerms,
  saveShipmentQuotationTerms,
  type createClient,
} from './client';
import { shipmentAcceptMessages, shipmentQuoteTermsMessages, type Language } from './messages';

export function ShipmentQuotationTermsPanel({
  org,
  shipment,
  token,
  request,
  language,
  busy,
  perform,
  onBooked,
}: {
  org: string;
  shipment: string;
  token: string;
  request: ReturnType<typeof createClient>;
  language: Language;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
  onBooked: () => void;
}) {
  const [context, setContext] = useState<Awaited<
    ReturnType<typeof loadShipmentQuotationTerms>
  > | null>(null);
  const [booking, setBooking] = useState<ShipmentBookingPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, FreightChoice>>({});
  const a = shipmentAcceptMessages[language];
  const [rejected, setRejected] = useState(false);
  const [currency, setCurrency] = useState('');
  const [feedback, setFeedback] = useState<'saved' | 'changed' | null>(null);
  const keys = useRef(new Map<string, string>());
  const t = shipmentQuoteTermsMessages[language];
  const direction = language === 'en' ? undefined : styles.rtl;
  const available = context && context.inclusionsAvailable && context.currencyChoices.length > 0;

  async function load() {
    const current = await loadShipmentQuotationTerms(request, org, token, shipment);
    setContext(current);
    try {
      setBooking(await loadShipmentBookingPreview(request, org, token, shipment));
    } catch (error) {
      if (!(error instanceof ApiFailure) || ![403, 404].includes(error.status)) throw error;
      setBooking(null);
    }
    setCurrency(current.terms?.currency ?? '');
  }

  async function save() {
    if (
      !context ||
      !available ||
      context.terms?.locked ||
      !context.currencyChoices.some(({ code }) => code === currency)
    )
      return;
    setFeedback(null);
    const version = context.terms?.version ?? 0;
    const signature = version + ':' + currency;
    let key = keys.current.get(signature);
    if (!key) {
      key = Crypto.randomUUID();
      keys.current.set(signature, key);
    }
    try {
      await saveShipmentQuotationTerms(request, org, token, shipment, version, currency, key);
    } catch (error) {
      if (
        error instanceof ApiFailure &&
        error.status === 409 &&
        error.code !== 'retry_key_conflict'
      ) {
        setFeedback('changed');
        return;
      }
      throw error;
    }
    await load();
    setFeedback('saved');
  }

  function confirmBooking(
    quotation: string,
    version: number,
    method: FreightChoice | undefined,
    amount?: string,
    currencyCode?: string,
  ) {
    const summary = [
      a.confirm,
      amount && [amount, currencyCode].filter(Boolean).join(' '),
      method && a.methods[method],
    ]
      .filter(Boolean)
      .join('\n');
    Alert.alert(a.accept, summary, [
      { text: a.cancel, style: 'cancel' },
      {
        text: a.accept,
        onPress: () =>
          void perform(async () => {
            const signature = ['accept', quotation, version, method].join(':');
            let key = keys.current.get(signature);
            if (!key) {
              key = Crypto.randomUUID();
              keys.current.set(signature, key);
            }
            const result = await acceptShipmentQuotation(
              request,
              org,
              token,
              quotation,
              version,
              key,
              method,
            );
            if (!result.booking?.id) throw new Error('Booking unconfirmed');
            setBooking({ booking: result.booking, acceptance: [] });
            onBooked();
            await load();
          }),
      },
    ]);
  }

  function confirmRejection(quotation: string, version: number) {
    Alert.alert(a.reject, a.rejectPrompt, [
      { text: a.cancel, style: 'cancel' },
      {
        text: a.reject,
        style: 'destructive',
        onPress: () =>
          void perform(async () => {
            setRejected(false);
            const signature = 'reject:' + quotation + ':' + version;
            let key = keys.current.get(signature);
            if (!key) {
              key = Crypto.randomUUID();
              keys.current.set(signature, key);
            }
            const reply = await rejectShipmentQuotation(
              request,
              org,
              token,
              quotation,
              version,
              key,
            );
            if (reply.outcome !== 'rejected' && reply.outcome !== 'already_rejected')
              throw new Error('Rejection unconfirmed');
            setContext((current) =>
              current
                ? {
                    ...current,
                    quotations: current.quotations.map((item) =>
                      item.id === quotation ? { ...item, status: 'rejected' } : item,
                    ),
                  }
                : null,
            );
            setRejected(true);
            await load();
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
            await load();
            setFeedback(null);
          })
        }
      />
      {context?.terms ? (
        <Text style={direction}>{t.current + ' · ' + context.terms.currency}</Text>
      ) : null}
      {context?.terms?.locked ? (
        <Text style={direction}>{t.locked}</Text>
      ) : context && !available ? (
        <Text style={direction}>{t.unavailable}</Text>
      ) : available && context ? (
        <>
          <View accessibilityRole="radiogroup">
            {context.currencyChoices.map(({ code }) => (
              <Pressable
                key={code}
                accessibilityRole="radio"
                accessibilityState={{ checked: currency === code, disabled: busy }}
                disabled={busy}
                style={[styles.option, currency === code && styles.selected]}
                onPress={() => {
                  if (feedback === 'saved') setFeedback(null);
                  setCurrency(code);
                }}
              >
                <Text style={direction}>{code}</Text>
              </Pressable>
            ))}
          </View>
          <Button
            title={t.save}
            disabled={
              busy || !currency || currency === context.terms?.currency || feedback === 'changed'
            }
            onPress={() => void perform(save)}
          />
        </>
      ) : null}
      {feedback ? (
        <Text accessibilityLiveRegion="polite" style={direction}>
          {t[feedback]}
        </Text>
      ) : null}
      {context ? (
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={direction}>
            {a.title}
          </Text>
          {booking?.booking ? (
            <Text accessibilityLiveRegion="polite" style={direction}>
              {a.booked + ' · ' + booking.booking.id}
            </Text>
          ) : null}
          {rejected ? (
            <Text accessibilityLiveRegion="polite" style={direction}>
              {a.rejectDone}
            </Text>
          ) : null}
          {context.quotations.length === 0 ? <Text style={direction}>{a.empty}</Text> : null}
          {context.quotations.map((quote) => {
            const current = quote.versions.find(
              (version) => version.versionNo === quote.currentVersion,
            );
            const preview = booking?.acceptance.find((item) => item.quotationId === quote.id);
            const methods = preview?.freight?.methods ?? [];
            const selected = choices[quote.id];
            const method = methods.length === 1 ? methods[0] : selected;
            const money = (label: string, amount: string | undefined) =>
              amount !== undefined ? (
                <Text style={direction}>
                  {label + ' · ' + amount + ' ' + (preview?.currency ?? current?.currency ?? '')}
                </Text>
              ) : null;
            return (
              <View style={styles.panel} key={quote.id}>
                <Text style={direction}>
                  {quote.carrier?.tradingName ?? quote.carrier?.legalName ?? quote.id.slice(0, 8)}
                </Text>
                <Text style={direction}>
                  {(a.states as Record<string, string>)[quote.status] ?? quote.status}
                </Text>
                {money(a.freight, preview?.transportAmount ?? current?.amount)}
                {preview?.fee?.payer === 'shipper' ? money(a.fee, preview.fee.amount) : null}
                {money(a.total, preview?.shipperTotal)}
                {preview?.terms?.demonstration ? <Text style={direction}>{a.demo}</Text> : null}
                {quote.status === 'submitted' &&
                !booking?.booking &&
                preview?.state === 'ok' &&
                preview.version === quote.currentVersion ? (
                  <>
                    {methods.length > 1 ? <Text style={direction}>{a.choose}</Text> : null}
                    {methods.map((choice) => (
                      <Pressable
                        key={choice}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: method === choice, disabled: busy }}
                        disabled={busy}
                        style={[styles.option, method === choice && styles.selected]}
                        onPress={() =>
                          setChoices((previous) => ({ ...previous, [quote.id]: choice }))
                        }
                      >
                        <Text style={direction}>{a.methods[choice]}</Text>
                      </Pressable>
                    ))}
                    <Button
                      title={a.accept}
                      disabled={
                        busy || (methods.length > 1 && (!method || !methods.includes(method)))
                      }
                      onPress={() =>
                        confirmBooking(
                          quote.id,
                          quote.currentVersion,
                          method,
                          preview.shipperTotal ?? current?.amount,
                          preview.currency ?? current?.currency,
                        )
                      }
                    />
                  </>
                ) : quote.status === 'submitted' && !booking?.booking ? (
                  <Text style={direction}>{a.unavailable}</Text>
                ) : null}
                {quote.status === 'submitted' && !booking?.booking && preview ? (
                  <Button
                    title={a.reject}
                    disabled={busy}
                    onPress={() => confirmRejection(quote.id, quote.currentVersion)}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { gap: 8, paddingVertical: 6 },
  option: { minHeight: 48, paddingHorizontal: 12, justifyContent: 'center' },
  selected: { backgroundColor: '#DBEAFE' },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
});
