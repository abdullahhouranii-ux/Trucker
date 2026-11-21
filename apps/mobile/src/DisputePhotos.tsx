import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import {
  loadBookingDisputes,
  uploadDisputePhoto,
  type BookingDispute,
  type createClient,
} from './client';
import { disputePhotoMessages, type Language } from './messages';

const terminal = ['agreement', 'withdraw', 'close', 'external'];

type Photo = { disputeId: string; uri: string; mime: 'image/jpeg' | 'image/png'; key: string };

export function DisputePhotos({
  org,
  booking,
  token,
  request,
  language,
  busy,
  perform,
}: {
  org: string;
  booking: string;
  token: string;
  request: ReturnType<typeof createClient>;
  language: Language;
  busy: boolean;
  perform: (work: () => Promise<void>) => Promise<void>;
}) {
  const [disputes, setDisputes] = useState<BookingDispute[] | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [error, setError] = useState(false);
  const [sent, setSent] = useState(false);
  const cached = useRef(new Set<string>());
  const active = useRef(true);
  const copy = disputePhotoMessages[language];
  const direction = language === 'en' ? undefined : styles.rtl;

  useEffect(() => {
    active.current = true;
    const files = cached.current;
    return () => {
      active.current = false;
      for (const uri of files) remove(uri);
    };
  }, []);

  async function refresh() {
    const rows = await loadBookingDisputes(request, org, booking, token);
    if (active.current) setDisputes(rows);
  }

  async function choose(disputeId: string) {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['image/jpeg', 'image/png'],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    if (
      !active.current ||
      !asset.size ||
      asset.size > 10 * 1024 * 1024 ||
      (asset.mimeType !== 'image/jpeg' && asset.mimeType !== 'image/png')
    ) {
      remove(asset.uri);
      if (active.current) setError(true);
      return;
    }
    if (photo) {
      remove(photo.uri);
      cached.current.delete(photo.uri);
    }
    cached.current.add(asset.uri);
    setError(false);
    setSent(false);
    setPhoto({ disputeId, uri: asset.uri, mime: asset.mimeType, key: Crypto.randomUUID() });
  }

  async function send() {
    if (!photo) return;
    const bytes = await new File(photo.uri).arrayBuffer();
    await uploadDisputePhoto(
      request,
      org,
      booking,
      photo.disputeId,
      token,
      photo.key,
      photo.mime,
      bytes,
    );
    if (!active.current) return;
    remove(photo.uri);
    cached.current.delete(photo.uri);
    setPhoto(null);
    setSent(true);
  }

  const button = (label: string, work: () => Promise<void>) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={() => void perform(work)}
      style={styles.button}
    >
      <Text style={[styles.buttonText, direction]}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.panel}>
      {button(copy.open, refresh)}
      {sent ? (
        <Text accessibilityLiveRegion="polite" style={direction}>
          {copy.sent}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={direction}>
          {copy.invalid}
        </Text>
      ) : null}
      {disputes?.length === 0 ? <Text style={direction}>{copy.empty}</Text> : null}
      {disputes?.map((dispute) => (
        <View style={styles.panel} key={dispute.id}>
          <Text style={direction}>{dispute.description}</Text>
          {dispute.events.some(({ kind }) => terminal.includes(kind)) ? (
            <Text style={direction}>{copy.closed}</Text>
          ) : (
            button(copy.choose, () => choose(dispute.id))
          )}
          {photo?.disputeId === dispute.id &&
          !dispute.events.some(({ kind }) => terminal.includes(kind)) ? (
            <>
              <Image
                source={{ uri: photo.uri }}
                accessibilityLabel={copy.preview}
                style={styles.preview}
                resizeMode="contain"
              />
              {button(copy.send, send)}
            </>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function remove(uri: string) {
  try {
    new File(uri).delete();
  } catch {
    /* Cache may already have been cleared. */
  }
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  preview: { width: '100%', height: 180 },
  button: {
    backgroundColor: '#0B4EA2',
    borderRadius: 12,
    padding: 12,
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonText: { color: '#fff', fontWeight: '600' },
});
