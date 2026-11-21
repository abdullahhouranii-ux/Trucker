import { useState } from 'react';
import { Alert, Button, StyleSheet, Text, TextInput, View } from 'react-native';
import { reportDriverEstimate, type Assignment, type createClient } from './client';
import { driverEstimateMessages, type Language } from './messages';

export function DriverEstimatePanel({
  assignment,
  token,
  language,
  request,
  busy,
  perform,
  refresh,
}: {
  assignment: Assignment;
  token: string;
  language: Language;
  request: ReturnType<typeof createClient>;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [minutes, setMinutes] = useState('');
  const [saved, setSaved] = useState(false);
  const t = driverEstimateMessages[language];
  const rtl = language === 'en' ? undefined : styles.rtl;
  const trip = assignment.trip;
  if (!trip) return null;
  const arrived = trip.milestones.some(({ milestone }) => milestone === 'arrived_at_delivery');
  const canReport = !arrived && !trip.delivery?.outcome;
  const digits = minutes
    .trim()
    .replace(/[٠-٩۰-۹]/g, (digit) =>
      String(digit.charCodeAt(0) - (digit >= '۰' ? 0x06f0 : 0x0660)),
    );
  const duration = /^\d{1,5}$/.test(digits) ? Number(digits) : 0;
  const valid = duration >= 1 && duration <= 43200;
  const label = (arrivalAt: string) => new Date(arrivalAt).toLocaleString(language);

  function confirm() {
    if (!valid) return;
    const arrivalAt = new Date(Date.now() + duration * 60000).toISOString();
    Alert.alert(t.title, t.confirm + '\n' + label(arrivalAt), [
      { text: t.cancel, style: 'cancel' },
      {
        text: t.save,
        onPress: () =>
          void perform(async () => {
            setSaved(false);
            const result = await reportDriverEstimate(
              request,
              assignment.bookingId,
              token,
              arrivalAt,
            );
            if (Date.parse(result.trip.estimate?.arrivalAt ?? '') !== Date.parse(arrivalAt))
              throw new Error('Arrival estimate unconfirmed');
            setMinutes('');
            await refresh();
            setSaved(true);
          }),
      },
    ]);
  }
  return (
    <View style={styles.panel}>
      {trip.estimate ? (
        <Text style={rtl}>{t.title + ' · ' + label(trip.estimate.arrivalAt)}</Text>
      ) : null}
      {canReport ? (
        <>
          <Text style={rtl}>{t.minutes}</Text>
          <TextInput
            accessibilityLabel={t.minutes}
            keyboardType="number-pad"
            maxLength={5}
            style={styles.input}
            editable={!busy}
            value={minutes}
            onChangeText={(text) => {
              setSaved(false);
              setMinutes(text);
            }}
          />
          <Button title={t.save} disabled={busy || !valid} onPress={confirm} />
        </>
      ) : null}
      {saved ? (
        <Text accessibilityLiveRegion="polite" style={rtl}>
          {t.saved}
        </Text>
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
