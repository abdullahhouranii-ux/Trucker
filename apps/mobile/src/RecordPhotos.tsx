import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { recordPhotoPath, type createClient } from './client';
import { disputePhotoMessages, type Language } from './messages';

type Photo = { id: string; uri: string; mime: 'image/jpeg' | 'image/png' };

const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const photoTooLarge: Record<Language, string> = {
  en: 'Choose a JPEG or PNG up to 5 MB.',
  ar: 'اختر صورة JPEG أو PNG بحجم لا يتجاوز 5 ميجابايت.',
  ur: '5 MB تک کی JPEG یا PNG تصویر منتخب کریں۔',
};

export function RecordPhotos({
  org,
  record,
  kind,
  token,
  origin,
  editable,
  language,
  request,
  busy,
  perform,
}: {
  org: string;
  record: string;
  kind: 'shipments' | 'vehicles';
  token: string;
  origin: string;
  editable: boolean;
  language: Language;
  busy: boolean;
  request: ReturnType<typeof createClient>;
  perform: (work: () => Promise<void>) => Promise<void>;
}) {
  const [photos, setPhotos] = useState<{ id: string }[] | null>(null);
  const [pending, setPending] = useState<Photo | null>(null);
  const [status, setStatus] = useState<'invalid' | 'sent' | null>(null);
  const uri = useRef<string | null>(null);
  const mounted = useRef(false);
  // Shipment and vehicle photos are at most 5 MB (22 November 2026); dispute evidence keeps 10 MB.
  const t = { ...disputePhotoMessages[language], invalid: photoTooLarge[language] };
  const path = recordPhotoPath(org, kind, record);
  const title =
    kind === 'vehicles'
      ? { en: 'Vehicle photos', ar: 'صور المركبة', ur: 'گاڑی کی تصاویر' }[language]
      : { en: 'Shipment photos', ar: 'صور الشحنة', ur: 'شپمنٹ کی تصاویر' }[language];
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearFile(uri.current);
    };
  }, []);

  async function list() {
    const result = await request<{ photos: { id: string }[] }>(path, { token });
    if (mounted.current) setPhotos(result.photos);
  }
  async function choose() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['image/jpeg', 'image/png'],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const file = result.assets[0];
    if (!file) return;
    if (
      !mounted.current ||
      !file.size ||
      file.size > PHOTO_MAX_BYTES ||
      (file.mimeType !== 'image/jpeg' && file.mimeType !== 'image/png')
    ) {
      clearFile(file.uri);
      if (mounted.current) setStatus('invalid');
      return;
    }
    clearFile(uri.current);
    uri.current = file.uri;
    setPending({ id: Crypto.randomUUID(), uri: file.uri, mime: file.mimeType });
    setStatus(null);
  }
  async function upload() {
    if (!pending) return;
    const bytes = await new File(pending.uri).arrayBuffer();
    const result = await request<{ id: string }>(path + '/' + pending.id, {
      token,
      method: 'PUT',
      mediaType: pending.mime,
      bytes,
    });
    if (result.id !== pending.id) throw new Error('Photo upload unconfirmed');
    if (!mounted.current) return;
    clearFile(uri.current);
    uri.current = null;
    setPending(null);
    setPhotos((previous) =>
      previous?.some(({ id }) => id === result.id)
        ? previous
        : [...(previous ?? []), { id: result.id }],
    );
    setStatus('sent');
  }

  const action = (label: string, work: () => Promise<void>) => (
    <Pressable
      accessibilityRole="button"
      style={styles.button}
      disabled={busy}
      onPress={() => void perform(work)}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.panel}>
      {action(title, list)}
      {photos?.map(({ id }) => (
        <Image
          key={id}
          accessibilityLabel={title}
          source={{ uri: origin + path + '/' + id, headers: { Authorization: 'Bearer ' + token } }}
          resizeMode="contain"
          style={styles.preview}
        />
      ))}
      {editable ? action(t.choose, choose) : null}
      {editable && pending ? (
        <>
          <Image
            accessibilityLabel={t.preview}
            source={{ uri: pending.uri }}
            resizeMode="contain"
            style={styles.preview}
          />
          {action(t.send, upload)}
        </>
      ) : null}
      {status ? <Text accessibilityLiveRegion="polite">{t[status]}</Text> : null}
    </View>
  );
}
function clearFile(uri: string | null) {
  if (uri) {
    try {
      new File(uri).delete();
    } catch {
      /* Cache was already cleared. */
    }
  }
}
const styles = StyleSheet.create({
  panel: { gap: 8 },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    padding: 12,
    backgroundColor: '#0B4EA2',
    borderRadius: 12,
  },
  label: { color: '#fff', fontWeight: '600' },
  preview: { width: '100%', height: 180 },
});
