import { useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { Alert, Button, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  ApiFailure,
  loadOrganisationShipment,
  loadPublicationCatalogues,
  publishShipment,
  type OrganisationShipment,
  type PublicationInput,
  type createClient,
} from './client';
import { shipmentPublishMessages, type Language } from './messages';

export function ShipmentPublishPanel({
  org,
  shipment,
  token,
  request,
  language,
  busy,
  perform,
  onPublished,
}: {
  org: string;
  shipment: string;
  token: string;
  request: ReturnType<typeof createClient>;
  language: Language;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
  onPublished: (shipment: OrganisationShipment) => void;
}) {
  const [draft, setDraft] = useState<OrganisationShipment | null>(null);
  const [catalogues, setCatalogues] = useState<Awaited<
    ReturnType<typeof loadPublicationCatalogues>
  > | null>(null);
  const [cargoCategory, setCargoCategory] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [dangerousGoods, setDangerousGoods] = useState<boolean | null>(null);
  const [pickupArea, setPickupArea] = useState('');
  const [deliveryArea, setDeliveryArea] = useState('');
  const [deadline, setDeadline] = useState('');
  const [offset, setOffset] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const t = shipmentPublishMessages[language];
  const rtl = language === 'en' ? undefined : styles.rtl;
  const offsetMinutes = offset.trim() === '' ? null : Number(offset);
  const validOffset =
    offsetMinutes === null ||
    (/^[+-]?\d{1,4}$/.test(offset.trim()) &&
      Number.isInteger(offsetMinutes) &&
      Math.abs(offsetMinutes) <= 1080);
  const ready =
    draft?.status === 'draft' &&
    !!cargoCategory &&
    !!equipmentType &&
    dangerousGoods !== null &&
    !!pickupArea.trim() &&
    !!deliveryArea.trim() &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(deadline.trim()) &&
    validOffset;

  async function open() {
    const [record, choices] = await Promise.all([
      loadOrganisationShipment(request, org, shipment, token),
      loadPublicationCatalogues(request, org, token),
    ]);
    setDraft(record);
    setCatalogues(choices);
    setProblem(null);
    if (record.status !== 'draft') onPublished(record);
  }

  function confirm() {
    if (!draft || !ready || dangerousGoods === null) return;
    const body: PublicationInput = {
      version: draft.version,
      cargoCategory,
      equipmentType,
      dangerousGoods,
      pickupArea: pickupArea.trim(),
      deliveryArea: deliveryArea.trim(),
      quotationDeadline: { local: deadline.trim(), offsetMinutes },
    };
    Alert.alert(t.send, t.confirm, [
      { text: t.cancel, style: 'cancel' },
      {
        text: t.send,
        onPress: () =>
          void perform(async () => {
            setProblem(null);
            const serialized = JSON.stringify(body);
            if (attempt.current?.body !== serialized)
              attempt.current = { body: serialized, key: Crypto.randomUUID() };
            try {
              const result = await publishShipment(
                request,
                org,
                token,
                shipment,
                attempt.current.key,
                body,
              );
              if (result.shipment.id !== shipment || result.shipment.status === 'draft')
                throw new Error('Publication unconfirmed');
              onPublished(result.shipment);
            } catch (error) {
              if (
                error instanceof ApiFailure &&
                error.status !== 401 &&
                error.status >= 400 &&
                error.status < 500
              ) {
                setProblem(error.code === 'shipment_changed' ? t.changed : t.refused);
                return;
              }
              throw error;
            }
          }),
      },
    ]);
  }
  const option = (key: string, label: string, selected: boolean, choose: () => void) => (
    <Pressable
      key={key}
      disabled={busy}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: busy }}
      style={[styles.option, selected && styles.selected]}
      onPress={choose}
    >
      <Text style={rtl}>{label}</Text>
    </Pressable>
  );
  const input = (
    label: string,
    value: string,
    change: (value: string) => void,
    maxLength: number,
  ) => (
    <View style={styles.field}>
      <Text style={rtl}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={change}
        editable={!busy}
        maxLength={maxLength}
        autoCorrect={false}
        style={styles.input}
      />
    </View>
  );

  return (
    <View style={styles.field}>
      <Button title={t.prepare} disabled={busy} onPress={() => void perform(open)} />
      {catalogues && draft?.status === 'draft' ? (
        <>
          <Text style={rtl}>{t.cargo}</Text>
          <View accessibilityRole="radiogroup">
            {catalogues.cargoCategories.map((entry) =>
              option(entry.code, entry.name[language], cargoCategory === entry.code, () =>
                setCargoCategory(entry.code),
              ),
            )}
          </View>
          <Text style={rtl}>{t.equipment}</Text>
          <View accessibilityRole="radiogroup">
            {catalogues.equipmentTypes.map((entry) =>
              option(entry.code, entry.name[language], equipmentType === entry.code, () =>
                setEquipmentType(entry.code),
              ),
            )}
          </View>
          <Text style={rtl}>{t.dangerous}</Text>
          <View accessibilityRole="radiogroup">
            {option('no', t.no, dangerousGoods === false, () => setDangerousGoods(false))}
            {option('yes', t.yes, dangerousGoods === true, () => setDangerousGoods(true))}
          </View>
          {input(t.pickup, pickupArea, setPickupArea, 120)}
          {input(t.delivery, deliveryArea, setDeliveryArea, 120)}
          {input(t.deadline, deadline, setDeadline, 16)}
          <Text style={rtl}>{t.zone + ' ' + (draft.pickup.timeZone ?? '—')}</Text>
          {input(t.offset, offset, setOffset, 5)}
          {problem ? (
            <Text accessibilityRole="alert" style={rtl}>
              {problem}
            </Text>
          ) : null}
          <Button title={t.send} disabled={busy || !ready} onPress={confirm} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 8, paddingVertical: 6 },
  option: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 12 },
  selected: { backgroundColor: '#DBEAFE' },
  input: {
    borderWidth: 1,
    borderColor: '#64748b',
    borderRadius: 8,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  rtl: { writingDirection: 'rtl', textAlign: 'right' },
});
