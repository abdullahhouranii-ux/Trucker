import { DriverEstimatePanel } from './src/DriverEstimatePanel';
import { CarrierQuotationsPanel } from './src/CarrierQuotationsPanel';
import { ShipmentQuotationTermsPanel } from './src/ShipmentQuotationTermsPanel';
import { MobileQuotationPanel } from './src/MobileQuotationPanel';
import { ShipmentDraftPanel } from './src/ShipmentDraftPanel';
import { ShipmentPublishPanel } from './src/ShipmentPublishPanel';
import { ShipmentRolesPanel } from './src/ShipmentRolesPanel';
import { CommissionContractsPanel } from './src/CommissionContractsPanel';
import { AuthoritiesPanel } from './src/AuthoritiesPanel';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { StatusBar } from 'expo-status-bar';
import {
  ApiFailure,
  apiOrigin,
  localDemoAvailable,
  signInLocalDemo,
  createClient,
  loadEffectiveCapabilities,
  loadBookingSummary,
  loadOrganisationShipment,
  loadOrganisationShipments,
  withdrawShipment,
  type OrganisationShipment,
  type BookingSummary,
  type PublicShipmentPage,
  type Account,
  type Assignment,
  type Organisation,
  type Session,
} from './src/client';
import {
  localDemoMessages,
  driverDemoMessages,
  messages,
  publicShipmentMessages,
  shipmentDetailsMessages,
  shipmentWithdrawalMessages,
  type Language,
} from './src/messages';
import { BrokerCommissionsPanel } from './src/BrokerCommissionsPanel';
import { DisputePhotos } from './src/DisputePhotos';
import { RecordPhotos } from './src/RecordPhotos';
import { EvidencePanel } from './src/EvidencePanel';
import { DeliveryPanel } from './src/DeliveryPanel';

const LOCAL_DEMO = process.env.EXPO_PUBLIC_TRUCKER_LOCAL_DEMO;
const TOKEN_KEY = 'trucker.participant.session.v1';
let request: ReturnType<typeof createClient> | undefined;
let origin: string | undefined;
try {
  origin = apiOrigin(process.env.EXPO_PUBLIC_API_URL, __DEV__);
  request = createClient(origin);
} catch {
  /* Configuration is shown, never silently sent to another server. */
}
type Tab = 'home' | 'trips' | 'accounts' | 'account';
type Terms = {
  version: string;
  language: string;
  title: string;
  notice: string;
  paragraphs: string[];
};
const milestoneNames = {
  en: [
    'Depart for pickup',
    'Arrive at pickup',
    'Start loading',
    'Loaded · depart',
    'Arrive at delivery',
    'Start unloading',
  ],
  ar: [
    'الانطلاق للتحميل',
    'الوصول للتحميل',
    'بدء التحميل',
    'اكتمال التحميل والانطلاق',
    'الوصول للتسليم',
    'بدء التفريغ',
  ],
  ur: [
    'پک اپ کے لیے روانگی',
    'پک اپ پر پہنچ گئے',
    'لوڈنگ شروع',
    'لوڈ مکمل، روانگی',
    'ترسیل پر پہنچ گئے',
    'ان لوڈنگ شروع',
  ],
};
const milestoneCodes = [
  'departed_for_pickup',
  'arrived_at_pickup',
  'loading_started',
  'loaded_departed',
  'arrived_at_delivery',
  'unloading_started',
];

function Product() {
  const [language, setLanguage] = useState<Language>('ar');
  const m = messages[language];
  const rtl = language !== 'en';
  const [token, setToken] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [board, setBoard] = useState<PublicShipmentPage | null>(null);
  const [boardState, setBoardState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const boardRequest = useRef(0);
  const loadBoard = useCallback(async (after?: string) => {
    const id = ++boardRequest.current;
    setBoardState('loading');
    try {
      if (!request) throw new Error('API unavailable');
      const path = after
        ? '/public/shipments?after=' + encodeURIComponent(after)
        : '/public/shipments';
      const page = await request<PublicShipmentPage>(path);
      if (id !== boardRequest.current) return;
      setBoard((previous) =>
        after && previous ? { items: [...previous.items, ...page.items], next: page.next } : page,
      );
      setBoardState('ready');
    } catch {
      if (id === boardRequest.current) setBoardState('failed');
    }
  }, []);
  useEffect(() => {
    if (tab === 'home') void loadBoard();
  }, [tab, loadBoard]);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const [restoreError, setRestoreError] = useState<'expired' | 'unknown' | null>(null);
  const displayError = error || (restoreError ? m[restoreError] : '');
  const [notice, setNotice] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [terms, setTerms] = useState<Terms | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [trips, setTrips] = useState<Assignment[]>([]);
  const [organisations, setOrganisations] = useState<Organisation[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState(false);
  const [description, setDescription] = useState('');
  const [problemType, setProblemType] = useState('delay');
  const [org, setOrg] = useState<Organisation | null>(null);
  const [brokerOrg, setBrokerOrg] = useState<{ orgId: string; token: string } | null>(null);
  const [fleetOrg, setFleetOrg] = useState<{ orgId: string; token: string } | null>(null);
  const orgId = org?.id;
  useEffect(() => {
    setBrokerOrg(null);
    setFleetOrg(null);
    if (!request || !token || !orgId) return;
    let active = true;
    void loadEffectiveCapabilities(request, orgId, token)
      .then((capabilities) => {
        if (active && capabilities.includes('organise')) setBrokerOrg({ orgId, token });
        if (active && capabilities.includes('carry_as_company')) setFleetOrg({ orgId, token });
      })
      .catch(() => {
        // The company screens remain available if verification cannot be read.
      });
    return () => {
      active = false;
    };
  }, [orgId, token]);
  const [records, setRecords] = useState<{ id: string; label: string; status: string }[]>([]);
  const fleetLabel = { en: 'Fleet', ar: 'الأسطول', ur: 'بیڑا' }[language];
  const [recordKind, setRecordKind] = useState<'shipments' | 'bookings' | 'vehicles'>('shipments');
  const [recordsAfter, setRecordsAfter] = useState<string | null>(null);
  const recordsEpoch = useRef(0);
  const [shipmentDetails, setShipmentDetails] = useState<{
    orgId: string;
    shipment: OrganisationShipment;
  } | null>(null);
  const [bookingSummary, setBookingSummary] = useState<{
    orgId: string;
    bookingId: string;
    summary: BookingSummary;
  } | null>(null);
  const mutation = useRef(false);
  const epoch = useRef(0);
  const keys = useRef(new Map<string, string>());
  const keyFor = (value: string) => {
    if (!keys.current.has(value)) keys.current.set(value, Crypto.randomUUID());
    return keys.current.get(value)!;
  };
  const textStyle = rtl ? s.rtl : undefined;
  const currentTrip = trips.find((trip) => trip.bookingId === selected);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (problem) {
        setProblem(false);
        return true;
      }
      if (selected) {
        setSelected(null);
        return true;
      }
      if (org) {
        setOrg(null);
        setBookingSummary(null);
        recordsEpoch.current++;
        setShipmentDetails(null);
        setRecordsAfter(null);
        setRecords([]);
        return true;
      }
      if (tab !== 'home') {
        setTab('home');
        return true;
      }
      if (challenge && !token) {
        setChallenge(null);
        setCode('');
        return true;
      }
      return false;
    });
    return () => listener.remove();
  }, [problem, selected, org, tab, challenge, token]);

  const forget = useCallback(async () => {
    epoch.current++;
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setAccount(null);
    setTrips([]);
    setOrganisations([]);
    setSessions([]);
    recordsEpoch.current++;
    setShipmentDetails(null);
    setRecordsAfter(null);
    setRecords([]);
    setOrg(null);
    setBookingSummary(null);
    setSelected(null);
    setChallenge(null);
    setCode('');
    keys.current.clear();
  }, []);

  const refresh = useCallback(async (sessionToken: string) => {
    if (!request) return;
    const generation = ++epoch.current;
    const me = await request<Account>('/me', { token: sessionToken });
    if (generation !== epoch.current) return;
    setAccount(me);
    if (!me.person.registrationComplete) return;
    const [a, o, ss] = await Promise.all([
      request<{ assignments: Assignment[] }>('/me/driver/assignments', { token: sessionToken }),
      request<{ organisations: Organisation[] }>('/organisations', { token: sessionToken }),
      request<{ sessions: Session[] }>('/me/sessions', { token: sessionToken }),
    ]);
    if (generation !== epoch.current) return;
    setTrips(a.assignments);
    setOrganisations(o.organisations);
    setSessions(ss.sessions);
  }, []);

  async function enterDemo(destination: 'home' | 'trips') {
    if (!origin || !localDemoAvailable(origin, __DEV__, LOCAL_DEMO)) return;
    const reply = await signInLocalDemo(origin, __DEV__, LOCAL_DEMO, Crypto.randomUUID);
    await SecureStore.setItemAsync(TOKEN_KEY, reply.token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    setToken(reply.token);
    setAccount(reply);
    setChallenge(null);
    setCode('');
    setTab(destination);
    await refresh(reply.token);
  }

  async function perform(work: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    setRestoreError(null);
    setNotice('');
    try {
      await work();
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.status === 401) {
        await forget();
        setError(m.expired);
      } else if (
        failure instanceof ApiFailure &&
        (failure.code === 'code_resend_too_soon' || failure.code === 'too_many_code_requests')
      ) {
        const seconds = failure.retryAfterSeconds;
        setError(
          seconds
            ? m.codeWait.replace('{seconds}', seconds.toLocaleString(language))
            : m.codeWaitUnknown,
        );
      } else if (failure instanceof ApiFailure && failure.code === 'code_delivery_unavailable') {
        setError(m.codeDeliveryUnavailable);
      } else if (failure instanceof ApiFailure && failure.code === 'code_incorrect') {
        setError(m.codeIncorrect);
      } else if (
        failure instanceof ApiFailure &&
        ['code_replaced', 'code_expired', 'code_locked', 'code_already_used'].includes(failure.code)
      ) {
        setChallenge(null);
        setCode('');
        setError(m.codeRestart);
      } else if (failure instanceof ApiFailure && failure.status >= 400 && failure.status < 500) {
        setError(m.error);
      } else {
        setError(m.unknown);
      }
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const saved = await SecureStore.getItemAsync(TOKEN_KEY);
        if (!mounted) return;
        if (saved) {
          setToken(saved);
          await refresh(saved);
        }
      } catch (failure) {
        const expired = failure instanceof ApiFailure && failure.status === 401;
        if (expired) await forget();
        if (mounted) setRestoreError(expired ? 'expired' : 'unknown');
      } finally {
        if (mounted) setRestoring(false);
      }
    })();
    return () => {
      mounted = false;
      epoch.current++;
    };
  }, [refresh, forget]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && token) void perform(() => refresh(token));
    });
    return () => listener.remove();
  });
  useEffect(() => {
    setAccepted(false);
    setTerms(null);
    if (!account || account.person.registrationComplete || !request) return;
    let active = true;
    void request<Terms>(`/registration/terms?language=${language}`)
      .then((value) => {
        if (active) setTerms(value);
      })
      .catch(() => {
        if (active) setError(m.unknown);
      });
    return () => {
      active = false;
    };
  }, [account?.person.registrationComplete, language, m.unknown]);

  const confirm = (work: () => Promise<void>) =>
    Alert.alert(m.confirmation, m.limit, [
      { text: m.cancel, style: 'cancel' },
      { text: m.send, onPress: () => void perform(work) },
    ]);
  const button = (label: string, onPress: () => void, secondary = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        pressed && s.pressed,
        busy && s.disabled,
      ]}
    >
      <Text style={[s.buttonText, secondary && s.secondaryText, textStyle]}>{label}</Text>
    </Pressable>
  );
  const title = (value: string) => (
    <Text accessibilityRole="header" style={[s.heading, textStyle]}>
      {value}
    </Text>
  );
  const body = (value: string) => <Text style={[s.body, textStyle]}>{value}</Text>;
  const card = (children: ReactNode) => <View style={s.card}>{children}</View>;
  const field = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    numeric = false,
    multiline = false,
  ) => (
    <View style={s.field}>
      <Text style={[s.label, textStyle]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        editable={!busy}
        keyboardType={numeric ? 'phone-pad' : 'default'}
        autoComplete={label === m.code ? 'one-time-code' : label === m.phone ? 'tel' : 'off'}
        maxLength={multiline ? 2000 : 120}
        multiline={multiline}
        style={[s.input, multiline && s.multiline, numeric ? s.ltr : textStyle]}
      />
    </View>
  );

  function applyShipment(orgId: string, shipment: OrganisationShipment) {
    setShipmentDetails({ orgId, shipment });
    setRecords((current) =>
      current.map((item) =>
        item.id === shipment.id ? { ...item, status: shipment.status } : item,
      ),
    );
  }

  function confirmWithdrawal(orgId: string, shipment: OrganisationShipment) {
    if (!request || !token) return;
    const client = request;
    const t = shipmentWithdrawalMessages[language];
    Alert.alert(t.action, t.confirmation, [
      { text: m.cancel, style: 'cancel' },
      {
        text: t.action,
        style: 'destructive',
        onPress: () =>
          void perform(async () => {
            const key = keyFor('withdraw:' + orgId + ':' + shipment.id + ':' + shipment.version);
            const result = await withdrawShipment(
              client,
              orgId,
              token,
              shipment.id,
              key,
              shipment.version,
            );
            if (result.shipment.id !== shipment.id || result.shipment.status !== 'withdrawn')
              throw new Error('Withdrawal unconfirmed');
            applyShipment(orgId, result.shipment);
            setNotice(t.done);
          }),
      },
    ]);
  }

  async function loadRecords(
    value: Organisation,
    kind: 'shipments' | 'bookings' | 'vehicles',
    after?: string,
  ) {
    if (!request || !token) return;
    const generation = ++recordsEpoch.current;
    if (kind === 'shipments') {
      const page = await loadOrganisationShipments(request, value.id, token, after);
      if (generation !== recordsEpoch.current) return;
      const items = page.shipments.map((item) => ({
        id: item.id,
        label: item.shipperReference || item.cargoDescription || item.id,
        status: item.status,
      }));
      setRecords((previous) =>
        after
          ? [...new Map([...previous, ...items].map((item) => [item.id, item])).values()]
          : items,
      );
      setRecordsAfter(page.nextAfter);
    } else if (kind === 'vehicles') {
      const page = await request<{
        fleet: { vehicles: { id: string; registrationNumber: string; status: string }[] };
      }>('/organisations/' + value.id + '/fleet', { token });
      if (generation !== recordsEpoch.current) return;
      setRecords(
        page.fleet.vehicles.map((vehicle) => ({
          id: vehicle.id,
          label: vehicle.registrationNumber,
          status: vehicle.status,
        })),
      );
      setRecordsAfter(null);
    } else {
      const page = await request<{ bookings: { id: string; state?: string; status?: string }[] }>(
        '/organisations/' + value.id + '/bookings',
        { token },
      );
      if (generation !== recordsEpoch.current) return;
      setRecords(
        page.bookings.map((item) => ({
          id: item.id,
          label: item.id,
          status: item.state ?? item.status ?? '',
        })),
      );
      setShipmentDetails(null);
      setRecordsAfter(null);
    }
    setOrg(value);
    if (!after) {
      setBookingSummary(null);
      setShipmentDetails(null);
    }
    setRecordKind(kind);
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="dark" />
      <View style={s.header}>
        <Text accessibilityRole="header" style={s.brand}>
          Trucker<Text style={s.brandDot}> /</Text>
        </Text>
        <View style={s.languages}>
          {(['en', 'ar', 'ur'] as Language[]).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: language === value }}
              accessibilityLabel={value === 'en' ? 'English' : value === 'ar' ? 'العربية' : 'اردو'}
              onPress={() => setLanguage(value)}
              style={[s.language, language === value && s.languageActive]}
            >
              <Text style={[s.languageText, language === value && s.languageSelected]}>
                {value === 'en' ? 'EN' : value === 'ar' ? 'عربي' : 'اردو'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Text style={[s.environment, textStyle]}>{m.development}</Text>
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            token || tab === 'home' ? (
              <RefreshControl
                refreshing={busy || (tab === 'home' && boardState === 'loading')}
                onRefresh={() => {
                  if (tab === 'home') void loadBoard();
                  if (token) void perform(() => refresh(token));
                }}
                accessibilityLabel={m.refresh}
              />
            ) : undefined
          }
        >
          {tab === 'home' ? (
            <View style={s.card}>
              {title(publicShipmentMessages[language].title)}
              {body(publicShipmentMessages[language].fleetRule)}
              {board?.items.map((item) => (
                <View key={item.id} style={s.card}>
                  {body(item.origin + ' – ' + item.destination)}
                  {body(item.equipment[language])}
                  {body(
                    publicShipmentMessages[language].deadline +
                      ' ' +
                      new Date(item.deadline).toLocaleString(language),
                  )}
                  {token && request && organisations.length ? (
                    <MobileQuotationPanel
                      key={item.id}
                      shipment={item.id}
                      organisations={organisations}
                      token={token}
                      request={request}
                      language={language}
                      busy={busy}
                      perform={perform}
                    />
                  ) : null}
                </View>
              ))}
              {boardState === 'loading' ? (
                <ActivityIndicator accessibilityLabel={m.loading} />
              ) : null}
              {boardState === 'failed' ? (
                <>
                  {body(publicShipmentMessages[language].unavailable)}
                  {button(m.retry, () => void loadBoard(), true)}
                </>
              ) : null}
              {boardState === 'ready' && board?.items.length === 0
                ? body(publicShipmentMessages[language].empty)
                : null}
              {boardState === 'ready' && board?.next
                ? button(
                    publicShipmentMessages[language].more,
                    () => void loadBoard(board.next!),
                    true,
                  )
                : null}
            </View>
          ) : null}
          {restoring ? (
            <ActivityIndicator accessibilityLabel={m.loading} size="large" color="#0B4EA2" />
          ) : null}
          {displayError ? (
            <View style={s.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
              {body(displayError)}
              {token ? button(m.retry, () => void perform(() => refresh(token)), true) : null}
            </View>
          ) : null}
          {notice ? (
            <View style={s.success} accessibilityLiveRegion="polite">
              {body(notice)}
            </View>
          ) : null}
          {!request ? (
            card(body(m.notConfigured))
          ) : !token && !restoring ? (
            <>
              {title(m.welcome)}
              {body(m.intro)}
              {card(
                <>
                  {title(m.signIn)}
                  {origin && localDemoAvailable(origin, __DEV__, LOCAL_DEMO) ? (
                    <>
                      {button(
                        localDemoMessages[language],
                        () => void perform(() => enterDemo('home')),
                      )}
                      {button(
                        driverDemoMessages[language],
                        () => void perform(() => enterDemo('trips')),
                        true,
                      )}
                    </>
                  ) : null}
                  {!challenge ? (
                    <>
                      {field(m.phone, phone, setPhone, true)}
                      {button(
                        m.sendCode,
                        () =>
                          void perform(async () => {
                            const reply = await request!<{ challengeId: string }>(
                              '/auth/code-requests',
                              { method: 'POST', key: keyFor(`phone:${phone}`), body: { phone } },
                            );
                            keys.current.delete(`phone:${phone}`);
                            setChallenge(reply.challengeId);
                          }),
                      )}
                    </>
                  ) : (
                    <>
                      {field(m.code, code, setCode, true)}
                      {button(
                        m.verify,
                        () =>
                          void perform(async () => {
                            const reply = await request!<Account & { token: string }>(
                              '/auth/code-verifications',
                              {
                                method: 'POST',
                                key: keyFor(`code:${challenge}:${code}`),
                                body: { challengeId: challenge, code },
                              },
                            );
                            await SecureStore.setItemAsync(TOKEN_KEY, reply.token, {
                              keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
                            });
                            setToken(reply.token);
                            setAccount(reply);
                            setCode('');
                            await refresh(reply.token);
                          }),
                      )}
                      {button(
                        m.back,
                        () => {
                          setChallenge(null);
                          setCode('');
                          keys.current.clear();
                        },
                        true,
                      )}
                    </>
                  )}
                  {body(m.noSupplier)}
                </>,
              )}
            </>
          ) : token && account && !account.person.registrationComplete ? (
            <>
              {title(m.register)}
              {field(m.name, name, setName)}
              {terms ? (
                card(
                  <>
                    {title(terms.title)}
                    {body(terms.notice)}
                    {terms.paragraphs.map((paragraph) => (
                      <Text key={paragraph} style={[s.body, textStyle]}>
                        {paragraph}
                      </Text>
                    ))}
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: accepted }}
                      onPress={() => setAccepted(!accepted)}
                      style={s.check}
                    >
                      {body(`${accepted ? '☑' : '☐'} ${m.terms}`)}
                    </Pressable>
                    {accepted &&
                      button(
                        m.register,
                        () =>
                          void perform(async () => {
                            await request!('/me/registration', {
                              token,
                              method: 'POST',
                              body: {
                                displayName: name,
                                termsVersion: terms.version,
                                termsLanguage: language,
                                termsSeen: true,
                              },
                            });
                            await refresh(token);
                          }),
                      )}
                  </>,
                )
              ) : (
                <ActivityIndicator accessibilityLabel={m.loading} />
              )}
              {button(
                m.signOut,
                () =>
                  void perform(async () => {
                    await request!('/auth/sign-out', { token, method: 'POST' });
                    await forget();
                  }),
                true,
              )}
            </>
          ) : token && account ? (
            <>
              {tab === 'home' ? (
                <>
                  {title(account.person.displayName ?? m.welcome)}
                  {body(m.intro)}
                  <View style={s.metricRow}>
                    {card(
                      <>
                        {title(String(trips.length))}
                        {body(m.trips)}
                      </>,
                    )}
                    {card(
                      <>
                        {title(String(organisations.length))}
                        {body(m.accounts)}
                      </>,
                    )}
                  </View>
                  {button(m.trips, () => {
                    setTab('trips');
                    setSelected(null);
                  })}
                  {button(m.accounts, () => setTab('accounts'), true)}
                  {card(body(m.note))}
                </>
              ) : null}
              {tab === 'trips' ? (
                <>
                  {title(currentTrip ? m.details : m.trips)}
                  {currentTrip ? (
                    <>
                      {button(
                        m.back,
                        () => {
                          setSelected(null);
                          setProblem(false);
                        },
                        true,
                      )}
                      {card(
                        <>
                          {title(
                            `${currentTrip.pickup.area ?? currentTrip.pickup.countryCode ?? '—'} → ${currentTrip.delivery.area ?? currentTrip.delivery.countryCode ?? '—'}`,
                          )}
                          {body(currentTrip.carrier.legalName)}
                          {body(currentTrip.cargo.description ?? '—')}
                          {body(currentTrip.truck?.registrationNumber ?? '—')}
                          {body(currentTrip.bookingId)}
                          {currentTrip.trip?.hold ? body(m.held) : null}
                          {currentTrip.trip?.pod
                            ? body(`${m.version}: ${currentTrip.trip.pod.state}`)
                            : null}
                        </>,
                      )}
                      {!currentTrip.acknowledgedAt
                        ? button(m.acknowledge, () =>
                            confirm(async () => {
                              await request!(
                                `/me/driver/assignments/${currentTrip.bookingId}/acknowledge`,
                                { token, method: 'POST', body: { version: currentTrip.version } },
                              );
                              await refresh(token);
                              setNotice(m.confirmed);
                            }),
                          )
                        : null}
                      {currentTrip.trip?.milestones.map((step, index) =>
                        card(
                          <View key={`${step.milestone}-${index}`}>
                            {body(
                              `✓ ${milestoneNames[language][milestoneCodes.indexOf(step.milestone)] ?? step.milestone}`,
                            )}
                            {body(step.statedAt)}
                          </View>,
                        ),
                      )}
                      {currentTrip.trip?.next && !currentTrip.trip.hold
                        ? button(
                            `${m.next}: ${milestoneNames[language][milestoneCodes.indexOf(currentTrip.trip.next)] ?? currentTrip.trip.next}`,
                            () =>
                              confirm(async () => {
                                await request!(
                                  `/me/driver/assignments/${currentTrip.bookingId}/milestones`,
                                  {
                                    token,
                                    method: 'POST',
                                    body: {
                                      version: currentTrip.trip!.version,
                                      milestone: currentTrip.trip!.next,
                                    },
                                  },
                                );
                                await refresh(token);
                                setNotice(m.confirmed);
                              }),
                          )
                        : null}
                      {currentTrip.trip ? (
                        <DriverEstimatePanel
                          key={currentTrip.bookingId + ':eta'}
                          assignment={currentTrip}
                          token={token}
                          request={request}
                          language={language}
                          busy={busy}
                          perform={perform}
                          refresh={() => refresh(token)}
                        />
                      ) : null}
                      {request ? (
                        <DeliveryPanel
                          key={`delivery-${currentTrip.bookingId}`}
                          assignment={currentTrip}
                          token={token}
                          request={request}
                          language={language}
                          busy={busy}
                          perform={perform}
                          refresh={() => refresh(token)}
                        />
                      ) : null}
                      {request ? (
                        <EvidencePanel
                          key={currentTrip.bookingId}
                          assignment={currentTrip}
                          token={token}
                          request={request}
                          language={language}
                          busy={busy}
                          perform={perform}
                          refresh={() => refresh(token)}
                        />
                      ) : null}
                      {button(m.problem, () => setProblem(!problem), true)}
                      {problem
                        ? card(
                            <>
                              {title(m.problem)}
                              {body(m.problemType)}
                              <View style={s.wrap}>
                                {['delay', 'breakdown', 'accident', 'safety_concern', 'other'].map(
                                  (type) => (
                                    <Pressable
                                      key={type}
                                      accessibilityRole="radio"
                                      accessibilityState={{ checked: type === problemType }}
                                      onPress={() => setProblemType(type)}
                                      style={[s.language, type === problemType && s.languageActive]}
                                    >
                                      <Text
                                        style={[
                                          s.languageText,
                                          type === problemType && s.languageSelected,
                                        ]}
                                      >
                                        {type.replaceAll('_', ' ')}
                                      </Text>
                                    </Pressable>
                                  ),
                                )}
                              </View>
                              {field(m.description, description, setDescription, false, true)}
                              {description.trim()
                                ? button(m.send, () =>
                                    confirm(async () => {
                                      await request!(
                                        `/me/driver/assignments/${currentTrip.bookingId}/exceptions`,
                                        {
                                          token,
                                          method: 'POST',
                                          key: keyFor(
                                            `problem:${currentTrip.bookingId}:${problemType}:${description}`,
                                          ),
                                          body: { type: problemType, description },
                                        },
                                      );
                                      await refresh(token);
                                      setProblem(false);
                                      setDescription('');
                                      setNotice(m.confirmed);
                                    }),
                                  )
                                : null}
                            </>,
                          )
                        : null}
                    </>
                  ) : trips.length ? (
                    trips.map((trip) => (
                      <View key={trip.bookingId}>
                        {card(
                          <>
                            {body(trip.carrier.legalName)}
                            {title(
                              `${trip.pickup.area ?? trip.pickup.countryCode ?? '—'} → ${trip.delivery.area ?? trip.delivery.countryCode ?? '—'}`,
                            )}
                            {body(trip.cargo.description ?? '—')}
                            {button(m.details, () => {
                              setSelected(trip.bookingId);
                              setProblem(false);
                            })}
                          </>,
                        )}
                      </View>
                    ))
                  ) : (
                    card(body(m.nothing))
                  )}
                </>
              ) : null}
              {tab === 'accounts' ? (
                <>
                  {title(org?.legalName ?? m.accounts)}
                  {org ? (
                    <CarrierQuotationsPanel
                      key={org.id + ':carrier-quotes'}
                      org={org.id}
                      token={token}
                      request={request!}
                      language={language}
                      busy={busy}
                      perform={perform}
                    />
                  ) : null}
                  {org ? (
                    <AuthoritiesPanel
                      key={org.id + ':authorities'}
                      org={org.id}
                      token={token}
                      language={language}
                      busy={busy}
                      request={request!}
                      perform={perform}
                    />
                  ) : null}
                  {org &&
                  ((brokerOrg?.orgId === org.id && brokerOrg.token === token) ||
                    (fleetOrg?.orgId === org.id && fleetOrg.token === token)) ? (
                    <CommissionContractsPanel
                      key={org.id + ':contracts'}
                      org={org.id}
                      token={token}
                      language={language}
                      busy={busy}
                      request={request!}
                      perform={perform}
                    />
                  ) : null}
                  {brokerOrg?.orgId === orgId && brokerOrg?.token === token ? (
                    <>
                      {body(m.brokerAccount)}
                      <BrokerCommissionsPanel
                        key={brokerOrg.orgId + ':commissions'}
                        org={brokerOrg.orgId}
                        token={token}
                        language={language}
                        busy={busy}
                        request={request!}
                        perform={perform}
                      />
                    </>
                  ) : null}
                  {org ? (
                    <>
                      {button(
                        m.back,
                        () => {
                          setOrg(null);
                          setBookingSummary(null);
                          recordsEpoch.current++;
                          setShipmentDetails(null);
                          setRecordsAfter(null);
                          setRecords([]);
                        },
                        true,
                      )}
                      <View style={s.wrap}>
                        {button(
                          m.shipments,
                          () => void perform(() => loadRecords(org, 'shipments')),
                          recordKind !== 'shipments',
                        )}
                        {button(
                          m.booking,
                          () => void perform(() => loadRecords(org, 'bookings')),
                          recordKind !== 'bookings',
                        )}
                        {fleetOrg?.orgId === org.id && fleetOrg.token === token
                          ? button(
                              fleetLabel,
                              () => void perform(() => loadRecords(org, 'vehicles')),
                              recordKind !== 'vehicles',
                            )
                          : null}
                      </View>
                      {recordKind === 'shipments' ? (
                        <ShipmentDraftPanel
                          key={org.id}
                          org={org.id}
                          token={token}
                          request={request!}
                          language={language}
                          busy={busy}
                          perform={perform}
                          onSaved={(shipment, label) => {
                            setRecords((current) => [
                              { id: shipment.id, label, status: shipment.status },
                              ...current.filter((item) => item.id !== shipment.id),
                            ]);
                            setShipmentDetails({ orgId: org.id, shipment });
                          }}
                        />
                      ) : null}
                      {records.length
                        ? records.map((record) => (
                            <View key={record.id}>
                              {card(
                                <>
                                  {title(record.label)}
                                  {body(`${m.status}: ${record.status}`)}
                                  {body(record.id)}
                                  {recordKind === 'shipments'
                                    ? button(
                                        shipmentDetailsMessages[language].open,
                                        () =>
                                          void perform(async () => {
                                            const generation = recordsEpoch.current;
                                            const shipment = await loadOrganisationShipment(
                                              request!,
                                              org.id,
                                              record.id,
                                              token,
                                            );
                                            if (generation === recordsEpoch.current)
                                              setShipmentDetails({ orgId: org.id, shipment });
                                          }),
                                        true,
                                      )
                                    : null}
                                  {recordKind === 'shipments' &&
                                  shipmentDetails?.orgId === org.id &&
                                  shipmentDetails.shipment.id === record.id ? (
                                    <View>
                                      {[
                                        [
                                          shipmentDetailsMessages[language].cargo,
                                          shipmentDetails.shipment.cargoDescription,
                                        ],
                                        [
                                          shipmentDetailsMessages[language].pickup,
                                          [
                                            shipmentDetails.shipment.pickup.countryCode,
                                            shipmentDetails.shipment.pickup.address,
                                          ]
                                            .filter(Boolean)
                                            .join(' · '),
                                        ],
                                        [
                                          shipmentDetailsMessages[language].delivery,
                                          [
                                            shipmentDetails.shipment.delivery.countryCode,
                                            shipmentDetails.shipment.delivery.address,
                                          ]
                                            .filter(Boolean)
                                            .join(' · '),
                                        ],
                                        [
                                          shipmentDetailsMessages[language].weight,
                                          shipmentDetails.shipment.grossWeightKg === null
                                            ? null
                                            : new Intl.NumberFormat(language, {
                                                style: 'unit',
                                                unit: 'kilogram',
                                              }).format(
                                                Number(shipmentDetails.shipment.grossWeightKg),
                                              ),
                                        ],
                                        [
                                          shipmentDetailsMessages[language].pieces,
                                          shipmentDetails.shipment.pieces?.toLocaleString(language),
                                        ],
                                      ].map(([label, value]) =>
                                        value ? (
                                          <View key={label}>{body(label + ': ' + value)}</View>
                                        ) : null,
                                      )}
                                      {record.status === 'draft' &&
                                      brokerOrg?.orgId === org.id &&
                                      brokerOrg.token === token ? (
                                        <ShipmentRolesPanel
                                          key={org.id + ':' + record.id + ':roles'}
                                          org={org.id}
                                          shipment={record.id}
                                          token={token}
                                          language={language}
                                          busy={busy}
                                          request={request!}
                                          perform={perform}
                                        />
                                      ) : null}
                                      {shipmentDetails.shipment.status === 'draft' ? (
                                        <ShipmentDraftPanel
                                          key={org.id + ':' + record.id + ':edit'}
                                          draftId={record.id}
                                          org={org.id}
                                          token={token}
                                          request={request!}
                                          language={language}
                                          busy={busy}
                                          perform={perform}
                                          onSaved={(shipment, label) => {
                                            setShipmentDetails({ orgId: org.id, shipment });
                                            setRecords((items) =>
                                              items.map((item) =>
                                                item.id === shipment.id
                                                  ? { ...item, label, status: shipment.status }
                                                  : item,
                                              ),
                                            );
                                          }}
                                        />
                                      ) : null}
                                      {record.status === 'draft' ? (
                                        <ShipmentPublishPanel
                                          key={org.id + ':' + record.id + ':publish'}
                                          org={org.id}
                                          shipment={record.id}
                                          token={token}
                                          request={request!}
                                          language={language}
                                          busy={busy}
                                          perform={perform}
                                          onPublished={(shipment) =>
                                            applyShipment(org.id, shipment)
                                          }
                                        />
                                      ) : null}
                                      {['published', 'suspended'].includes(
                                        shipmentDetails.shipment.status,
                                      )
                                        ? button(
                                            shipmentWithdrawalMessages[language].action,
                                            () =>
                                              confirmWithdrawal(org.id, shipmentDetails.shipment),
                                            true,
                                          )
                                        : null}
                                      {['published', 'awarded'].includes(
                                        shipmentDetails.shipment.status,
                                      ) ? (
                                        <ShipmentQuotationTermsPanel
                                          key={org.id + ':' + record.id + ':quote-terms'}
                                          org={org.id}
                                          shipment={record.id}
                                          token={token}
                                          request={request!}
                                          language={language}
                                          busy={busy}
                                          perform={perform}
                                          onBooked={() =>
                                            applyShipment(org.id, {
                                              ...shipmentDetails.shipment,
                                              status: 'awarded',
                                            })
                                          }
                                        />
                                      ) : null}
                                      <RecordPhotos
                                        key={org.id + ':' + record.id}
                                        org={org.id}
                                        record={record.id}
                                        kind="shipments"
                                        token={token}
                                        request={request!}
                                        origin={origin!}
                                        editable={['draft', 'published'].includes(record.status)}
                                        language={language}
                                        busy={busy}
                                        perform={perform}
                                      />
                                    </View>
                                  ) : null}
                                  {recordKind === 'vehicles' ? (
                                    <RecordPhotos
                                      key={org.id + ':' + record.id}
                                      org={org.id}
                                      record={record.id}
                                      kind="vehicles"
                                      token={token}
                                      request={request!}
                                      origin={origin!}
                                      editable={record.status === 'active'}
                                      language={language}
                                      busy={busy}
                                      perform={perform}
                                    />
                                  ) : null}
                                  {recordKind === 'bookings'
                                    ? button(
                                        m.bookingDetails,
                                        () =>
                                          void perform(async () => {
                                            const generation = epoch.current;
                                            const summary = await loadBookingSummary(
                                              request!,
                                              org.id,
                                              record.id,
                                              token,
                                            );
                                            if (generation === epoch.current)
                                              setBookingSummary({
                                                orgId: org.id,
                                                bookingId: record.id,
                                                summary,
                                              });
                                          }),
                                        true,
                                      )
                                    : null}
                                  {recordKind === 'bookings' &&
                                  bookingSummary?.orgId === org.id &&
                                  bookingSummary.bookingId === record.id ? (
                                    <>
                                      {bookingSummary.summary.closure
                                        ? body(
                                            m.closureStates[bookingSummary.summary.closure.state],
                                          )
                                        : null}
                                      {bookingSummary.summary.invoice ? (
                                        <>
                                          {body(m.invoiceDraft)}
                                          {body(
                                            bookingSummary.summary.invoice.recordedFee +
                                              ' ' +
                                              bookingSummary.summary.invoice.currency,
                                          )}
                                        </>
                                      ) : null}
                                      <DisputePhotos
                                        key={org.id + ':' + record.id}
                                        org={org.id}
                                        booking={record.id}
                                        token={token}
                                        request={request!}
                                        language={language}
                                        busy={busy}
                                        perform={perform}
                                      />
                                      {!bookingSummary.summary.closure &&
                                      !bookingSummary.summary.invoice
                                        ? body(m.nothing)
                                        : null}
                                    </>
                                  ) : null}
                                </>,
                              )}
                            </View>
                          ))
                        : card(body(m.nothing))}
                      {recordKind === 'shipments' && recordsAfter
                        ? button(
                            publicShipmentMessages[language].more,
                            () => {
                              const after = recordsAfter;
                              void perform(() => loadRecords(org, 'shipments', after));
                            },
                            true,
                          )
                        : null}
                    </>
                  ) : organisations.length ? (
                    organisations.map((value) => (
                      <View key={value.id}>
                        {card(
                          <>
                            {title(value.legalName)}
                            {body(`${m.status}: ${value.status}`)}
                            {button(
                              m.shipments,
                              () => void perform(() => loadRecords(value, 'shipments')),
                              true,
                            )}
                            {button(
                              m.booking,
                              () => void perform(() => loadRecords(value, 'bookings')),
                              true,
                            )}
                          </>,
                        )}
                      </View>
                    ))
                  ) : (
                    card(body(m.nothing))
                  )}
                </>
              ) : null}
              {tab === 'account' ? (
                <>
                  {title(m.account)}
                  {card(
                    <>
                      {title(account.person.displayName ?? '—')}
                      {body(account.person.phoneMasked)}
                    </>,
                  )}
                  {title(m.sessions)}
                  {sessions.map((session) => (
                    <View key={session.id}>
                      {card(
                        <>
                          {body(session.expiresAt)}
                          {button(
                            m.end,
                            () =>
                              confirm(async () => {
                                await request!(`/me/sessions/${session.id}`, {
                                  token,
                                  method: 'DELETE',
                                });
                                if (session.current) await forget();
                                else await refresh(token);
                              }),
                            true,
                          )}
                        </>,
                      )}
                    </View>
                  ))}
                  {button(
                    m.signOut,
                    () =>
                      void perform(async () => {
                        await request!('/auth/sign-out', { token, method: 'POST' });
                        await forget();
                      }),
                    true,
                  )}
                </>
              ) : null}
            </>
          ) : !restoring && token ? (
            card(
              <>
                {body(m.unknown)}
                {button(m.retry, () => void perform(() => refresh(token)))}
              </>,
            )
          ) : null}
          {busy ? <ActivityIndicator accessibilityLabel={m.loading} color="#0B4EA2" /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
      {token && account?.person.registrationComplete ? (
        <View accessibilityRole="tablist" style={[s.tabs, rtl && s.reverse]}>
          {(['home', 'trips', 'accounts', 'account'] as Tab[]).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === value }}
              onPress={() => {
                setTab(value);
                setSelected(null);
                setProblem(false);
              }}
              style={[s.tab, tab === value && s.tabActive]}
            >
              <Text style={[s.tabText, textStyle, tab === value && s.tabSelected]}>{m[value]}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Product />
    </SafeAreaProvider>
  );
}
const s = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1, backgroundColor: '#F3F5F8' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: '#FFF',
    gap: 12,
    flexWrap: 'wrap',
  },
  brand: { color: '#1F2328', fontSize: 30, fontWeight: '800', letterSpacing: -1 },
  brandDot: { color: '#0B6B4A' },
  languages: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  language: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#E3ECF8',
    justifyContent: 'center',
    alignItems: 'center',
  },
  languageActive: { backgroundColor: '#0B4EA2' },
  languageText: { color: '#0B4EA2', fontSize: 15, fontWeight: '600' },
  languageSelected: { color: '#FFF' },
  environment: {
    backgroundColor: '#FFF3B8',
    color: '#1F2328',
    paddingHorizontal: 20,
    paddingVertical: 8,
    fontSize: 13,
    lineHeight: 21,
  },
  content: { padding: 20, gap: 18, paddingBottom: 32 },
  heading: { fontSize: 25, lineHeight: 39, fontWeight: '700', color: '#1F2328', flexShrink: 1 },
  body: { fontSize: 16, lineHeight: 28, color: '#4A525C', flexShrink: 1 },
  rtl: { textAlign: 'right', writingDirection: 'rtl' },
  ltr: { textAlign: 'left', writingDirection: 'ltr' },
  card: {
    padding: 20,
    gap: 14,
    backgroundColor: '#FFF',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#C5CAD0',
    flexShrink: 1,
  },
  button: {
    minHeight: 52,
    backgroundColor: '#0B4EA2',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#0B4EA2',
  },
  secondary: { backgroundColor: '#FFF' },
  buttonText: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 28,
    textAlign: 'center',
  },
  secondaryText: { color: '#0B4EA2' },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.6 },
  field: { gap: 8 },
  label: { fontSize: 16, fontWeight: '600', color: '#1F2328', lineHeight: 26 },
  input: {
    minHeight: 54,
    padding: 14,
    borderWidth: 1.5,
    borderColor: '#6B737C',
    borderRadius: 12,
    backgroundColor: '#FFF',
    color: '#1F2328',
    fontSize: 18,
  },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  error: {
    backgroundColor: '#FBE4E2',
    borderColor: '#B3261E',
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  success: {
    backgroundColor: '#DFF0E7',
    borderColor: '#0B6B4A',
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderColor: '#36545A',
    backgroundColor: '#123139',
    padding: 8,
    gap: 4,
  },
  tab: {
    flex: 1,
    minWidth: 65,
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
    padding: 8,
  },
  tabActive: { backgroundColor: '#214951', borderColor: '#83DFCC' },
  tabText: {
    fontSize: 13,
    lineHeight: 22,
    fontWeight: '600',
    color: '#D5E7E2',
    textAlign: 'center',
  },
  tabSelected: { color: '#FFFFFF' },
  reverse: { flexDirection: 'row-reverse' },
  wrap: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  metricRow: { gap: 12 },
  check: { minHeight: 48, padding: 8 },
});
