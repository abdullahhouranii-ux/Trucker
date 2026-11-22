import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { ApiFailure, type Assignment, type createClient } from './client';
import type { Language } from './messages';

const copy = {
  en: {
    title: 'Delivery evidence',
    signature: 'Choose signed document',
    photo: 'Choose cargo photo',
    send: 'Upload evidence',
    reason: 'Why is more evidence being added?',
    invalid: 'Choose JPEG, PNG or PDF, up to 10 MB.',
    local:
      'Chosen files stay on this screen only. Upload needs a connection; selecting a file is not proof it reached the server.',
  },
  ar: {
    title: 'إثبات التسليم',
    signature: 'اختيار مستند موقّع',
    photo: 'اختيار صورة البضاعة',
    send: 'رفع الإثبات',
    reason: 'سبب إضافة إثبات جديد',
    invalid: 'اختر JPEG أو PNG أو PDF بحد أقصى 10 ميجابايت.',
    local:
      'اختيار الملف لا يعني وصوله للخادم. الملفات المختارة مؤقتة لهذه الشاشة، والرفع يحتاج إلى اتصال.',
  },
  ur: {
    title: 'ترسیل کا ثبوت',
    signature: 'دستخط شدہ دستاویز منتخب کریں',
    photo: 'سامان کی تصویر منتخب کریں',
    send: 'ثبوت اپ لوڈ کریں',
    reason: 'مزید ثبوت کی وجہ',
    invalid: 'JPEG، PNG یا PDF منتخب کریں، زیادہ سے زیادہ 10 MB۔',
    local:
      'فائل منتخب کرنے کا مطلب سرور تک پہنچنا نہیں۔ منتخب فائلیں اس اسکرین تک عارضی ہیں، اپ لوڈ کے لیے کنکشن ضروری ہے۔',
  },
};
type Chosen = {
  kind: string;
  uri: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  fingerprint: string;
};
export function EvidencePanel({
  assignment,
  token,
  request,
  language,
  busy,
  perform,
  refresh,
}: {
  assignment: Assignment;
  token: string;
  request: ReturnType<typeof createClient>;
  language: Language;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const cache = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const uri of cache.current) {
        try {
          new File(uri).delete();
        } catch {
          /* Already removed by the operating system. */
        }
      }
    },
    [],
  );
  const m = copy[language];
  const rtl = language !== 'en';
  const direction = rtl ? styles.rtl : undefined;
  const state = assignment.trip?.pod?.state;
  if (!assignment.trip?.delivery?.outcome) return null;
  const canUpload = !['accepted', 'ready_for_review'].includes(state ?? '');
  const outcome = assignment.trip.delivery.outcome.outcome;
  const resume = state === 'upload_incomplete';
  const needsSigned = ['delivered_in_full', 'delivered_with_remarks', 'partly_delivered'].includes(
    outcome,
  );
  const needsPhoto = ['partly_delivered', 'refused', 'not_delivered'].includes(outcome);
  const canSend =
    chosen.length > 0 &&
    (resume ||
      ((!needsSigned || chosen.some((item) => item.kind === 'signed_document')) &&
        (!needsPhoto || chosen.some((item) => item.kind === 'cargo_photo')) &&
        (state !== 'more_evidence_requested' || reason.trim().length > 0)));
  async function pick(kind: string) {
    const result = await DocumentPicker.getDocumentAsync({
      type:
        kind === 'cargo_photo'
          ? ['image/jpeg', 'image/png']
          : ['image/jpeg', 'image/png', 'application/pdf'],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (asset) cache.current.add(asset.uri);
    if (
      !asset ||
      !asset.size ||
      asset.size > 10 * 1024 * 1024 ||
      !['image/jpeg', 'image/png', 'application/pdf'].includes(asset.mimeType ?? '')
    ) {
      setInvalid(true);
      return;
    }
    const bytes = await new File(asset.uri).arrayBuffer();
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
    const fingerprint = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    setChosen((previous) => [
      ...previous.filter((item) => item.kind !== kind),
      {
        kind,
        uri: asset.uri,
        name: asset.name,
        mediaType: asset.mimeType!,
        sizeBytes: bytes.byteLength,
        fingerprint,
      },
    ]);
    setInvalid(false);
  }
  async function upload() {
    // Refresh before declaring: the previous declaration may have succeeded with its reply lost.
    const reply = await request<{ assignments: Assignment[] }>('/me/driver/assignments', { token });
    const current = reply.assignments.find((item) => item.bookingId === assignment.bookingId);
    if (!current) throw new ApiFailure(404, 'not_found');
    const route = `/me/driver/assignments/${assignment.bookingId}/pod`;
    let latest = current.trip?.pod?.versions.at(-1);
    if (!latest || latest.state === 'more_evidence_requested') {
      const declared = await request<{ pod: NonNullable<NonNullable<Assignment['trip']>['pod']> }>(
        route,
        {
          token,
          method: 'POST',
          body: {
            version: (latest?.version ?? 0) + 1,
            receiverName: current.trip?.delivery?.outcome?.receiverName ?? null,
            replacesReason: reason || null,
            items: chosen.map(({ kind, mediaType, sizeBytes, fingerprint }) => ({
              kind,
              mediaType,
              sizeBytes,
              fingerprint,
            })),
          },
        },
      );
      latest = declared.pod.versions.at(-1);
    }
    if (!latest || latest.state === 'accepted') {
      await refresh();
      return;
    }
    for (const file of chosen) {
      const item = latest.items.find(
        (entry) => entry.kind === file.kind && entry.fingerprint === file.fingerprint,
      );
      if (!item) throw new ApiFailure(409, 'manifest_changed');
      if (!item.received)
        await request(`${route}/items/${item.id}`, {
          token,
          method: 'PUT',
          bytes: await new File(file.uri).arrayBuffer(),
          mediaType: file.mediaType,
        });
    }
    await refresh();
    setChosen([]);
    for (const uri of cache.current) {
      try {
        new File(uri).delete();
      } catch {
        /* Already removed by the operating system. */
      }
    }
    cache.current.clear();
  }
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={[styles.title, direction]}>
        {m.title}
      </Text>
      <Text style={[styles.body, direction]}>{m.local}</Text>
      {invalid ? (
        <Text accessibilityRole="alert" style={[styles.body, direction]}>
          {m.invalid}
        </Text>
      ) : null}
      {chosen.map((file) => (
        <View key={file.kind}>
          {file.mediaType.startsWith('image/') ? (
            <Image
              accessibilityLabel={file.name}
              source={{ uri: file.uri }}
              resizeMode="contain"
              style={styles.preview}
            />
          ) : null}
          <Text style={[styles.body, direction]}>{file.name}</Text>
        </View>
      ))}
      {canUpload ? (
        <>
          {[
            ['signed_document', m.signature],
            ['cargo_photo', m.photo],
          ].map(([kind, label]) => (
            <Pressable
              key={kind}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              onPress={() => void perform(() => pick(kind))}
              style={styles.button}
            >
              <Text style={[styles.buttonText, direction]}>{label}</Text>
            </Pressable>
          ))}
          {state === 'more_evidence_requested' ? (
            <>
              <Text style={[styles.body, direction]}>{m.reason}</Text>
              <TextInput
                accessibilityLabel={m.reason}
                value={reason}
                onChangeText={setReason}
                maxLength={1000}
                multiline
                style={[styles.input, direction]}
              />
            </>
          ) : null}
          {canSend ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              accessibilityState={{ disabled: busy }}
              onPress={() => void perform(upload)}
              style={styles.button}
            >
              <Text style={[styles.buttonText, direction]}>{m.send}</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    padding: 20,
    gap: 14,
    backgroundColor: '#FFF',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#C5CAD0',
  },
  title: { color: '#1F2328', fontSize: 24, lineHeight: 38, fontWeight: '700' },
  body: { color: '#4A525C', fontSize: 16, lineHeight: 28 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  preview: { width: '100%', height: 180 },
  button: {
    minHeight: 52,
    backgroundColor: '#0B4EA2',
    padding: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  buttonText: { color: '#FFF', fontSize: 17, lineHeight: 28, fontWeight: '600' },
  input: {
    minHeight: 80,
    padding: 12,
    borderColor: '#6B737C',
    borderWidth: 1,
    borderRadius: 12,
    fontSize: 17,
    color: '#1F2328',
  },
});
