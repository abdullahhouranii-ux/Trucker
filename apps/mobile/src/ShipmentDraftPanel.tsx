import { useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { Button, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  createShipmentDraft,
  ApiFailure,
  loadOrganisationShipment,
  updateShipmentDraft,
  loadShipmentCountries,
  type DraftPlaceInput,
  type OrganisationShipment,
  type ShipmentCountry,
  type createClient,
} from './client';
import { shipmentDraftMessages, type Language } from './messages';

type PlaceFields = {
  countryCode: string;
  timeZone: string;
  address: string;
  from: string;
  until: string;
  fromOffset: string;
  untilOffset: string;
};
const emptyPlace: PlaceFields = {
  countryCode: '',
  timeZone: '',
  address: '',
  from: '',
  until: '',
  fromOffset: '',
  untilOffset: '',
};
const wallClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const validOffset = (value: string) =>
  !value || (/^[+-]?\d{1,4}$/.test(value) && Math.abs(Number(value)) <= 1080);
const placeReady = (place: PlaceFields) =>
  place.countryCode &&
  place.timeZone &&
  place.address.trim() &&
  wallClock.test(place.from.trim()) &&
  wallClock.test(place.until.trim()) &&
  validOffset(place.fromOffset.trim()) &&
  validOffset(place.untilOffset.trim());
const placeInput = (place: PlaceFields): DraftPlaceInput => ({
  countryCode: place.countryCode,
  timeZone: place.timeZone,
  address: place.address.trim(),
  from: {
    local: place.from.trim(),
    offsetMinutes: place.fromOffset.trim() ? Number(place.fromOffset) : null,
  },
  until: {
    local: place.until.trim(),
    offsetMinutes: place.untilOffset.trim() ? Number(place.untilOffset) : null,
  },
});

export function ShipmentDraftPanel({
  org,
  token,
  request,
  language,
  busy,
  perform,
  draftId,
  onSaved,
}: {
  org: string;
  token: string;
  request: ReturnType<typeof createClient>;
  language: Language;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
  draftId?: string;
  onSaved: (shipment: OrganisationShipment, label: string) => void;
}) {
  const [source, setSource] = useState<OrganisationShipment | null>(null);
  const [conflict, setConflict] = useState(false);
  const [countries, setCountries] = useState<ShipmentCountry[] | null>(null);
  const [reference, setReference] = useState('');
  const [cargo, setCargo] = useState('');
  const [weight, setWeight] = useState('');
  const [pieces, setPieces] = useState('');
  const [pickup, setPickup] = useState(emptyPlace);
  const [delivery, setDelivery] = useState(emptyPlace);
  const attempts = useRef(new Map<string, string>());
  const t = shipmentDraftMessages[language];
  const rtl = language === 'en' ? undefined : styles.rtl;
  const suppliedWeightValid =
    !weight ||
    (/^\d{1,6}(?:\.\d{1,3})?$/.test(weight) && Number(weight) > 0 && Number(weight) <= 100000);
  const suppliedPiecesValid =
    !pieces || (/^\d{1,6}$/.test(pieces) && Number(pieces) >= 1 && Number(pieces) <= 100000);
  const draftPlaceValid = (place: PlaceFields) => {
    const validEnd = (time: string, offset: string) =>
      time.trim() ? wallClock.test(time.trim()) && validOffset(offset.trim()) : !offset.trim();
    return validEnd(place.from, place.fromOffset) && validEnd(place.until, place.untilOffset);
  };
  const ready =
    suppliedWeightValid &&
    suppliedPiecesValid &&
    (draftId
      ? Boolean(source) && draftPlaceValid(pickup) && draftPlaceValid(delivery)
      : cargo.trim() && weight && placeReady(pickup) && placeReady(delivery));

  async function open() {
    const catalog = await loadShipmentCountries(request, org, token);
    if (draftId) {
      const current = await loadOrganisationShipment(request, org, draftId, token);
      if (current.status !== 'draft') throw new ApiFailure(409, 'shipment_not_draft');
      const loadPlace = (place: OrganisationShipment['pickup']): PlaceFields => ({
        countryCode: place.countryCode ?? '',
        timeZone: place.timeZone ?? '',
        address: place.address ?? '',
        from: place.from?.local ?? '',
        until: place.until?.local ?? '',
        fromOffset: place.from?.offsetMinutes?.toString() ?? '',
        untilOffset: place.until?.offsetMinutes?.toString() ?? '',
      });
      setSource(current);
      setReference(current.shipperReference ?? '');
      setCargo(current.cargoDescription ?? '');
      setWeight(current.grossWeightKg ?? '');
      setPieces(current.pieces?.toString() ?? '');
      setPickup(loadPlace(current.pickup));
      setDelivery(loadPlace(current.delivery));
    }
    setConflict(false);
    setCountries(catalog.countries);
  }

  const field = (
    label: string,
    value: string,
    setValue: (value: string) => void,
    maxLength: number,
  ) => (
    <View style={styles.fields}>
      <Text style={rtl}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={setValue}
        editable={!busy}
        maxLength={maxLength}
        autoCorrect={false}
        style={styles.input}
      />
    </View>
  );
  const radio = (key: string, title: string, selected: boolean, change: () => void) => (
    <Pressable
      key={key}
      disabled={busy}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: busy }}
      style={[styles.option, selected && styles.selected]}
      onPress={change}
    >
      <Text style={rtl}>{title}</Text>
    </Pressable>
  );
  const place = (title: string, value: PlaceFields, setValue: (value: PlaceFields) => void) => {
    const zones = countries?.find((country) => country.code === value.countryCode)?.timeZones ?? [];
    return (
      <View style={styles.fields}>
        <Text accessibilityRole="header" style={rtl}>
          {title}
        </Text>
        <Text style={rtl}>{t.country}</Text>
        <View accessibilityRole="radiogroup">
          {countries?.map((country) =>
            radio(country.code, country.name[language], country.code === value.countryCode, () =>
              setValue({
                ...value,
                countryCode: country.code,
                timeZone: country.timeZones.length === 1 ? country.timeZones[0]! : '',
              }),
            ),
          )}
        </View>
        {zones.length ? <Text style={rtl}>{t.zone}</Text> : null}
        <View accessibilityRole="radiogroup">
          {zones.map((zone) =>
            radio(zone, zone, zone === value.timeZone, () =>
              setValue({ ...value, timeZone: zone }),
            ),
          )}
        </View>
        {field(t.address, value.address, (address) => setValue({ ...value, address }), 500)}
        {field(t.from, value.from, (from) => setValue({ ...value, from }), 16)}
        {field(
          t.fromOffset,
          value.fromOffset,
          (fromOffset) => setValue({ ...value, fromOffset }),
          5,
        )}
        {field(t.until, value.until, (until) => setValue({ ...value, until }), 16)}
        {field(
          t.untilOffset,
          value.untilOffset,
          (untilOffset) => setValue({ ...value, untilOffset }),
          5,
        )}
      </View>
    );
  };

  async function save() {
    if (!ready) return;
    const body = {
      shipperReference: reference.trim(),
      cargoDescription: cargo.trim(),
      grossWeightKg: weight,
      pieces,
      packaging: source?.packaging,
      equipmentNeeded: source?.equipmentNeeded,
      pickup: { ...placeInput(pickup), accessNotes: source?.pickup.accessNotes },
      delivery: { ...placeInput(delivery), accessNotes: source?.delivery.accessNotes },
    };
    const signature = JSON.stringify([source?.version, body]);
    let key = attempts.current.get(signature);
    if (!key) {
      key = Crypto.randomUUID();
      attempts.current.set(signature, key);
    }
    let shipment;
    try {
      shipment = source
        ? await updateShipmentDraft(request, org, token, source.id, source.version, key, body)
        : await createShipmentDraft(request, org, token, key, body);
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'shipment_changed') {
        setConflict(true);
        return;
      }
      throw error;
    }
    if (!shipment.id || shipment.status !== 'draft' || (draftId && shipment.id !== draftId))
      throw new Error('Draft save unconfirmed');
    onSaved(shipment, body.shipperReference || body.cargoDescription || shipment.id);
    setSource(null);
    setConflict(false);
    attempts.current.clear();
    setCountries(null);
    setReference('');
    setCargo('');
    setWeight('');
    setPieces('');
    setPickup(emptyPlace);
    setDelivery(emptyPlace);
  }

  return (
    <View style={styles.fields}>
      <Button
        title={draftId ? t.edit : t.open}
        disabled={busy}
        onPress={() => void perform(open)}
      />
      {conflict ? (
        <Text accessibilityRole="alert" style={rtl}>
          {t.conflict}
        </Text>
      ) : null}
      {countries?.length === 0 && !draftId ? <Text style={rtl}>{t.noCountries}</Text> : null}
      {countries && (countries.length > 0 || draftId) ? (
        <>
          {field(t.reference, reference, setReference, 64)}
          {field(t.cargo, cargo, setCargo, 2000)}
          {field(t.weight, weight, setWeight, 10)}
          {field(t.pieces, pieces, setPieces, 6)}
          {place(t.pickup, pickup, setPickup)}
          {place(t.delivery, delivery, setDelivery)}
          <Button
            title={t.save}
            disabled={busy || !ready || conflict}
            onPress={() => void perform(save)}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fields: { gap: 8, paddingVertical: 6 },
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
