import { useState } from 'react';
import { Button, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  loadOrganisationShipment,
  loadShipmentParties,
  saveShipmentParties,
  type ShipmentPartiesView,
  type createClient,
} from './client';
import { shipmentRoleMessages, type Language } from './messages';

type Freight = ShipmentPartiesView['parties']['freightPayer'];
type Fee = ShipmentPartiesView['parties']['feePayer'];
const freightOptions = ['customer', 'sender', 'receiver'] as const;
const feeOptions = ['customer', 'organiser'] as const;

export function ShipmentRolesPanel({
  org,
  shipment,
  token,
  language,
  busy,
  request,
  perform,
}: {
  org: string;
  shipment: string;
  token: string;
  language: Language;
  busy: boolean;
  request: ReturnType<typeof createClient>;
  perform: (work: () => Promise<void>) => Promise<void>;
}) {
  const [record, setRecord] = useState<{ version: number; view: ShipmentPartiesView } | null>(null);
  const [customer, setCustomer] = useState<string | null>(null);
  const [receiver, setReceiver] = useState('');
  const [freight, setFreight] = useState<Freight>('customer');
  const [fee, setFee] = useState<Fee>('customer');
  const [saved, setSaved] = useState(false);
  const t = shipmentRoleMessages[language];
  const rtl = language === 'en' ? undefined : styles.rtl;

  async function load() {
    const current = await loadOrganisationShipment(request, org, shipment, token);
    const view = await loadShipmentParties(request, org, token, shipment);
    setRecord({ version: current.version, view });
    setCustomer(view.parties.authorityId);
    setReceiver(view.parties.receiver.is === 'named' ? (view.parties.receiver.name ?? '') : '');
    setFreight(view.parties.freightPayer);
    setFee(view.parties.feePayer);
  }
  function radio(
    label: string,
    selected: boolean,
    choose: () => void,
    key: string,
    unavailable = false,
  ) {
    return (
      <Pressable
        key={key}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected, disabled: busy || unavailable }}
        disabled={busy || unavailable}
        onPress={() => {
          setSaved(false);
          choose();
        }}
        style={[styles.option, selected && styles.selected]}
      >
        <Text style={rtl}>{label}</Text>
      </Pressable>
    );
  }

  const chosen = record?.view.customers.find(({ authorityId }) => authorityId === customer);
  const feeAgreementPending =
    customer !== null && fee === 'customer' && chosen?.feePayerAgreed !== true;
  return (
    <View style={styles.panel}>
      <Button
        title={t.load}
        disabled={busy}
        onPress={() =>
          void perform(async () => {
            await load();
            setSaved(false);
          })
        }
      />
      {saved ? (
        <Text style={rtl} accessibilityLiveRegion="polite">
          {t.saved}
        </Text>
      ) : null}
      {record?.view.editable ? (
        <>
          <Text style={rtl}>{t.customer}</Text>
          <View accessibilityRole="radiogroup">
            {radio(
              t.own,
              customer === null,
              () => {
                setCustomer(null);
                setFee('customer');
              },
              'own',
            )}
            {record.view.customers.map((item) =>
              radio(
                item.legalName,
                item.authorityId === customer,
                () => setCustomer(item.authorityId),
                item.authorityId,
              ),
            )}
          </View>
          <Text style={rtl}>{t.receiver}</Text>
          <TextInput
            accessibilityLabel={t.receiver}
            editable={!busy}
            maxLength={200}
            value={receiver}
            onChangeText={(value) => {
              setSaved(false);
              setReceiver(value);
            }}
            style={[styles.input, rtl]}
          />
          <Text style={rtl}>{t.freight}</Text>
          <View accessibilityRole="radiogroup">
            {freightOptions.map((item) =>
              radio(t.payers[item], freight === item, () => setFreight(item), item),
            )}
          </View>
          <Text style={rtl}>{t.fee}</Text>
          <View accessibilityRole="radiogroup">
            {feeOptions.map((item) =>
              radio(
                t.payers[item],
                fee === item,
                () => setFee(item),
                item,
                item === 'organiser' && customer === null,
              ),
            )}
          </View>
          {feeAgreementPending ? <Text style={rtl}>{t.noFeeAuthority}</Text> : null}
          <Button
            title={t.save}
            disabled={busy || (customer !== null && !chosen)}
            onPress={() =>
              void perform(async () => {
                const name = receiver.normalize('NFC').trim();
                await saveShipmentParties(request, org, token, shipment, record.version, {
                  customerAuthorityId: customer,
                  receiver: name ? { name } : 'not_named',
                  freightPayer: freight,
                  feePayer: fee,
                });
                await load();
                setSaved(true);
              })
            }
          />
        </>
      ) : record ? (
        <Text style={rtl}>{t.fixed}</Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { gap: 8, paddingVertical: 8 },
  option: { minHeight: 48, padding: 10, justifyContent: 'center' },
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
