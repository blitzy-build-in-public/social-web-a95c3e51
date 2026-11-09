/** Propose a meetup and place the initiator's card hold (AAP 0.5.8, AAP 0.7.1 row 4, AAP 0.8.1). */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextProps, ViewStyle } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  DAY_MS,
  DEFAULT_DEPOSIT_CENTS,
  DEPOSIT_LEVELS_CENTS,
  HOUR_MS,
  MINUTE_MS,
  MIN_TOUCH_TARGET,
  START_HORIZON_DAYS,
  borderWidths,
  colors,
  depositCopy,
  fontWeights,
  formatUsdWhole,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type { AnyTierProfile, DepositCents, HoldView, MeDto, Variant } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import type { ClientErrorCode } from '../../src/api/errors';
import {
  IMPORT_BANNER,
  SAFETY_NOTICE,
  SAFETY_TIPS,
  SAFETY_TIPS_TITLE,
  travelerSubtitle,
  VENUES_EMPTY,
} from '../../src/copy/strings';
import { CardSetup } from '../../src/payments/card-setup';
import type { CardSetupResult } from '../../src/payments/card-setup';
import { completeNextAction } from '../../src/payments/next-action';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { Avatar, Banner, Button, Card, ListItem, Screen, TextField, announce } from '../../src/ui';

const NO_RECIPIENT = 'Choose a traveler to propose a meetup to.';
const NO_VENUE = 'Choose a partner venue.';
const VENUE_HEADING = 'Partner venue';
const DEPOSIT_HEADING = 'Deposit';
const SUBMIT = 'Send proposal';
const START_ERROR = `Choose a time in the next ${START_HORIZON_DAYS} days.`;
const START_EMPTY = 'Choose a start time.';
const START_FORMAT = 'Enter the time as YYYY-MM-DD HH:mm.';
const START_PAST = 'Choose a time in the future.';
const STILL_CONFIRMING = 'Still confirming — check Meetups shortly.';
const NOT_CONFIRMED = "Card confirmation wasn't completed.";
const START_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const ZONE_DATE = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
const ZONE_CLOCK = { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' } as const;
const LINE_DATE = { weekday: 'short', day: 'numeric', month: 'short' } as const;
const ZONE_PARTS: Intl.DateTimeFormatOptions = { ...ZONE_DATE, ...ZONE_CLOCK, second: '2-digit' };
const START_LINE: Intl.DateTimeFormatOptions = { ...LINE_DATE, ...ZONE_CLOCK };
const POLL_MS = { confirm: 2_000, recover: 3_000 };
const WINDOW_MS = { confirm: 30_000, recover: 2 * MINUTE_MS };
const MARKER_SIZES = { ring: 20, dot: 10 };
const CONTROL_OUTLINE = { borderColor: colors.border, borderWidth: borderWidths.control };
const START_BASE = { autoCapitalize: 'none' as const, autoCorrect: false } as const;
const START_KEYS = { inputMode: 'text' as const, returnKeyType: 'done' as const };
const ROW_CENTER = { alignItems: 'center' as const, alignSelf: 'stretch' as const };
const OPTION_BOX = { ...CONTROL_OUTLINE, ...ROW_CENTER, backgroundColor: colors.background };
const OPTION_SHAPE = { borderRadius: radii.md, flexDirection: 'row' as const, gap: spacing.md };
const OPTION_PAD = { paddingBlock: spacing.sm, paddingInline: spacing.lg };
const OPTION_SIZE = { minHeight: MIN_TOUCH_TARGET, ...OPTION_PAD };
const MARKER_CENTER = { alignItems: 'center' as const, justifyContent: 'center' as const };
const MARKER_BOX = { ...CONTROL_OUTLINE, ...MARKER_CENTER, borderRadius: radii.pill };
const DOT_BOX = { borderRadius: radii.pill, backgroundColor: colors.primary };
type ZonedParts = Readonly<{ y: number; mo: number; d: number; h: number; mi: number }>;
const pad2 = (value: number): string => (value < 10 ? `0${value}` : String(value));
function zoneFields(date: Date, timeZone: string): ZonedParts & { readonly s: number } {
  const read = (zone: string): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat('en-US', { ...ZONE_PARTS, timeZone: zone }).formatToParts(date);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = read(timeZone);
  } catch {
    parts = read('UTC');
  }
  const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const fields = { y: at('year'), mo: at('month'), d: at('day'), h: at('hour'), mi: at('minute') };
  return { ...fields, s: at('second') };
}
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const at = zoneFields(new Date(instantMs), timeZone);
  return Date.UTC(at.y, at.mo - 1, at.d, at.h, at.mi, at.s) - instantMs;
}
function zonedLocalToUtc(parts: ZonedParts, timeZone: string): Date {
  const guess = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi);
  return new Date(guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone));
}
const utcToZonedParts = (date: Date, timeZone: string): ZonedParts => zoneFields(date, timeZone);
function startTextFor(date: Date, timeZone: string): string {
  const at = utcToZonedParts(date, timeZone);
  return `${at.y}-${pad2(at.mo)}-${pad2(at.d)} ${pad2(at.h)}:${pad2(at.mi)}`;
}
function startLineFor(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...START_LINE, timeZone }).format(date);
  } catch {
    return startTextFor(date, timeZone);
  }
}
const nextHour = (at: Date): Date => new Date(Math.ceil(at.getTime() / HOUR_MS + 1) * HOUR_MS);
function parseStart(text: string, timeZone: string): Date | null {
  const [, y = '', mo = '', d = '', h = '', mi = ''] = START_PATTERN.exec(text.trim()) ?? [];
  const date = zonedLocalToUtc({ y: +y, mo: +mo, d: +d, h: +h, mi: +mi }, timeZone);
  return startTextFor(date, timeZone) === text.trim() ? date : null;
}
const isWithinHorizon = (startsAt: Date, nowMs: number): boolean =>
  startsAt.getTime() > nowMs && startsAt.getTime() <= nowMs + START_HORIZON_DAYS * DAY_MS;
/**
 * What the start field says about the text it holds: an empty field, text that is not
 * `YYYY-MM-DD HH:mm`, a time that has already passed and a time beyond {@link START_HORIZON_DAYS}
 * each name the one thing to change, and a time the API would accept says nothing (AAP 0.5.4
 * `422 starts_at_invalid`, AAP 0.5.8).
 */
function startMessage(text: string, startsAt: Date | null, nowMs: number): string | null {
  if (text.trim() === '') return START_EMPTY;
  if (startsAt === null) return START_FORMAT;
  if (startsAt.getTime() <= nowMs) return START_PAST;
  return isWithinHorizon(startsAt, nowMs) ? null : START_ERROR;
}
type StartPreset = Readonly<{ testID: string; label: string; at: Date }>;
function startPresets(now: Date, timeZone: string): readonly StartPreset[] {
  const today = utcToZonedParts(now, timeZone);
  const tomorrow = utcToZonedParts(new Date(Date.UTC(today.y, today.mo - 1, today.d + 1)), 'UTC');
  const at = (h: number, mi: number): Date => zonedLocalToUtc({ ...tomorrow, h, mi }, timeZone);
  const inTwoHours = new Date(now.getTime() + 2 * HOUR_MS);
  return [
    { testID: 'propose-start-in-2h', label: 'In 2 hours', at: inTwoHours },
    { testID: 'propose-start-tomorrow-12', label: 'Tomorrow 12:00', at: at(12, 0) },
    { testID: 'propose-start-tomorrow-19', label: 'Tomorrow 19:00', at: at(19, 0) },
  ].filter((preset) => isWithinHorizon(preset.at, now.getTime()));
}
const rowOf = (
  p: AnyTierProfile,
): { readonly label: string; readonly subtitle: string; readonly leading: ReactElement } => {
  const fields = ['nickname' in p ? p.nickname : null, 'bio' in p ? p.bio : null];
  const described = fields.filter((field) => field !== null).join(' · ');
  // A viewer below the tier that releases the nickname and bio gets the shared traveler subtitle
  // instead, so the same person reads the same way here and in the Discover list (AAP 0.5.4, 0.5.8).
  return {
    label: p.handle,
    subtitle: described === '' ? travelerSubtitle(p) : described,
    leading: <Avatar avatarSeed={p.avatarSeed} handle={p.handle} decorative />,
  };
};
const errorCodeOf = (error: unknown): ClientErrorCode =>
  isApiError(error) ? error.code : 'invalid_response';
type HoldSteps = Partial<Record<HoldView, 'finish' | 'authenticate' | 'card' | 'recover'>> &
  Record<'held' | 'requires_action' | 'failed', 'finish' | 'authenticate' | 'card' | 'recover'>;
const HOLD_STEP: HoldSteps = { held: 'finish', requires_action: 'authenticate', failed: 'card' };

type SectionHeading = TextProps & { 'aria-level': number };
const SECTION_HEADING: SectionHeading = { role: 'heading', 'aria-level': 2 };
const LoadingLine = (): ReactElement => <Text style={styles.body} children="Loading…" />;
const VERIFY_ACTION = { label: 'Verify my stay', onPress: () => router.push('/proof/import') };
const PROOF_BANNER = (
  <Banner testID="proof-banner" tone="info" message={IMPORT_BANNER} action={VERIFY_ACTION} />
);
interface RadioProps {
  label: string;
  note?: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
  style?: StyleProp<ViewStyle>;
}
interface WebKeyEvent {
  readonly key?: string;
  readonly repeat?: boolean;
  readonly preventDefault?: () => void;
}
/** react-native-web answers Space only for a native button or role="button", so a radio takes it. */
function spaceActivates(activate: () => void): { onKeyDown?: (event: WebKeyEvent) => void } {
  if (Platform.OS !== 'web') return {};
  return {
    onKeyDown: (event) => {
      if (event.repeat === true) return;
      if (event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault?.();
      activate();
    },
  };
}
function RadioOption({ label, note, selected, onPress, testID, style }: RadioProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...spaceActivates(onPress)}
      role="radio"
      aria-checked={selected}
      accessibilityState={{ selected, checked: selected }}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      // Hover is a web state: React Native 0.76 declares the pair on `PressableProps` and
      // react-native-web forwards it to its hover hook, while iOS and Android never fire it.
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.option,
        hovered ? styles.optionHovered : null,
        focused ? styles.optionFocused : null,
        pressed ? styles.optionPressed : null,
        Platform.OS === 'web' ? ({ outlineStyle: 'none' } as ViewStyle) : {},
        style,
      ]}
    >
      <View aria-hidden style={[styles.marker, selected ? styles.markerSelected : null]}>
        {selected ? <View style={styles.markerDot} /> : null}
      </View>
      <View style={styles.optionText}>
        <Text style={styles.optionLabel}>{label}</Text>
        {note === undefined ? null : <Text style={styles.optionSubtitle}>{note}</Text>}
      </View>
    </Pressable>
  );
}
type KeyedRow = RadioProps & { readonly key: string | number };
const toOption = ({ key, ...row }: KeyedRow): ReactElement => <RadioOption key={key} {...row} />;
const DepositCopy = ({ copy }: { copy: string | null }): ReactElement | null =>
  copy === null ? null : <Text testID="deposit-copy" style={styles.framing} children={copy} />;
const tipRow = (tip: string): ReactElement => (
  <Text key={tip} style={styles.tip}>
    {tip}
  </Text>
);
const SafetyNotice = (): ReactElement => (
  <Card testID="safety-notice" title={SAFETY_NOTICE}>
    <Text {...SECTION_HEADING} style={styles.cardHeading} children={SAFETY_TIPS_TITLE} />
    <View style={styles.tips}>{SAFETY_TIPS.map(tipRow)}</View>
  </Card>
);
const Shell = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <Screen>
    <Stack.Screen options={{ title: 'Propose a meetup' }} />
    {children}
  </Screen>
);
type Phase = 'form' | 'confirming' | 'recovering' | 'card' | 'unconfirmed';
export default function ProposeScreen(): ReactElement {
  const { recipientId = '' } = useLocalSearchParams<{ recipientId?: string }>();
  const me = useMe();
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const recipient = useQuery({
    queryKey: queryKeys.user(recipientId),
    queryFn: () => apiClient.getUser(recipientId),
    enabled: recipientId !== '',
  });
  const proof: MeDto['proof'] | undefined = me.data?.proof;
  const cityId = proof?.status === 'valid' && proof.cityId ? proof.cityId : undefined;
  const city = cities.data?.items.find((item) => item.id === cityId);
  const venues = useQuery({
    queryKey: queryKeys.venues(cityId ?? ''),
    queryFn: () => apiClient.listVenues(cityId ?? ''),
    enabled: cityId !== undefined,
  });
  const [phase, setPhase] = useState<Phase>('form');
  const [stopped, setStopped] = useState(false);
  const [meetupId, setMeetupId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [errorCode, setErrorCode] = useState<ClientErrorCode | null>(null);
  const [venueId, setVenueId] = useState('');
  const [startText, setStartText] = useState('');
  const [depositCents, setDepositCents] = useState<DepositCents>(DEFAULT_DEPOSIT_CENTS);
  const meetupIdRef = useRef<string | null>(null);
  const secretRef = useRef<string | null>(null);
  const challengedRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const defaultedRef = useRef(false);
  const doneRef = useRef(false);
  const confirming = useQuery({
    queryKey: queryKeys.meetup(meetupId ?? ''),
    queryFn: () => apiClient.getMeetup(meetupId ?? ''),
    enabled: phase === 'confirming' && meetupId !== null && !authenticating,
    refetchInterval: phase === 'confirming' && meetupId !== null ? POLL_MS.confirm : false,
  });
  const openProposals = useQuery({
    queryKey: queryKeys.meetups('initiator', 'proposed'),
    queryFn: () => apiClient.listMeetups({ role: 'initiator', status: 'proposed' }),
    enabled: phase === 'recovering' && !stopped,
    refetchInterval: phase === 'recovering' && !stopped ? POLL_MS.recover : false,
  });
  const remember = useCallback((id: string): void => {
    meetupIdRef.current = id;
    setMeetupId(id);
  }, []);
  const finish = useCallback((): void => {
    const id = meetupIdRef.current;
    if (id === null || doneRef.current) return;
    doneRef.current = true;
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll });
    void queryClient.invalidateQueries({ queryKey: queryKeys.meetup(id) });
    router.replace(`/meetups/${id}`);
  }, []);
  const enterRecovering = useCallback((): void => {
    setStopped(false);
    setPhase('recovering');
  }, []);
  const applyFailure = useCallback(
    (code: ClientErrorCode): void => {
      if (code === 'hold_failed') return setPhase('card');
      if (code === 'payment_unavailable' || code === 'hold_pending') return enterRecovering();
      if (code === 'not_proposed' && meetupIdRef.current !== null)
        return void router.replace(`/meetups/${meetupIdRef.current}`);
      setErrorCode(code);
      setPhase('form');
    },
    [enterRecovering],
  );
  const acceptSecret = useCallback((secret: string): void => {
    secretRef.current = secret;
    challengedRef.current = null;
    setPhase('confirming');
  }, []);
  const retryHold = useCallback((): void => {
    const id = meetupIdRef.current;
    if (id === null) return;
    setErrorCode(null);
    setBusy(true);
    void apiClient
      .retryHold(id)
      .then((retry) => acceptSecret(retry.clientSecret))
      .catch((error: unknown) => applyFailure(errorCodeOf(error)))
      .finally(() => setBusy(false));
  }, [acceptSecret, applyFailure]);
  const authenticate = useCallback((): void => {
    const secret = secretRef.current;
    if (secret === null || challengedRef.current === secret) return void enterRecovering();
    challengedRef.current = secret;
    setAuthenticating(true);
    void completeNextAction(secret).then((result) => {
      setAuthenticating(false);
      if (result.status !== 'succeeded') setPhase('unconfirmed');
    });
  }, [enterRecovering]);
  const applyHold = useCallback(
    (hold: HoldView): void => {
      const step = HOLD_STEP[hold] ?? 'recover';
      if (step === 'finish') finish();
      else if (step === 'card') setPhase('card');
      else if (step === 'authenticate' && secretRef.current === null) retryHold();
      else if (step === 'authenticate') authenticate();
      else enterRecovering();
    },
    [authenticate, enterRecovering, finish, retryHold],
  );
  const holdRead = confirming.data?.initiatorHold;
  useEffect(() => {
    if (phase !== 'confirming' || holdRead === undefined) return;
    const decide = setTimeout(() => applyHold(holdRead), 0);
    return () => clearTimeout(decide);
  }, [applyHold, holdRead, phase]);
  const proposedItems = openProposals.data?.items;
  useEffect(() => {
    if (phase !== 'recovering' || proposedItems === undefined) return;
    const decide = setTimeout(() => {
      const mine = proposedItems.find((item) => item.counterpart.id === recipientId);
      if (mine === undefined) return void router.replace('/meetups');
      remember(mine.id);
      applyHold(mine.initiatorHold);
    }, 0);
    return () => clearTimeout(decide);
  }, [applyHold, phase, proposedItems, recipientId, remember]);
  useEffect(() => {
    if (phase !== 'confirming' && phase !== 'recovering') return;
    if (phase === 'recovering' && stopped) return;
    const giveUp = (): void => {
      if (phase === 'confirming') enterRecovering();
      else setStopped(true);
    };
    const t = setTimeout(giveUp, phase === 'confirming' ? WINDOW_MS.confirm : WINDOW_MS.recover);
    return () => clearTimeout(t);
  }, [enterRecovering, phase, stopped]);
  const noRecipient = recipientId === '';
  const gone = recipient.isError && errorCodeOf(recipient.error) === 'user_not_found';
  useEffect(() => {
    if (defaultedRef.current || city === undefined) return;
    defaultedRef.current = true;
    setStartText(startTextFor(nextHour(new Date()), city.timezone));
  }, [city]);
  const errorMessage = errorCode === null ? null : userMessageFor(errorCode);
  const notFound = userMessageFor('user_not_found');
  const readsCopy = userMessageFor(errorCodeOf(venues.error ?? recipient.error));
  // One sentence, spoken in the precedence the banners render in (AAP 0.5.8): an unverified caller
  // sees the import banner alone, which needs no announcement of a state the screen is not in.
  const announced =
    errorMessage ?? (gone ? notFound : noRecipient && cityId !== undefined ? NO_RECIPIENT : null);
  useEffect(() => {
    if (announced !== null) announce(announced);
  }, [announced]);
  const refetchReads = (): void => void Promise.all([venues.refetch(), recipient.refetch()]);
  const retryMe = { label: 'Try again', onPress: () => void me.refetch() };
  const retryCities = { label: 'Try again', onPress: () => void cities.refetch() };
  const retryReads = { label: 'Try again', onPress: refetchReads };
  const retryHoldAction = { label: 'Try again', onPress: retryHold };
  const find = { label: 'Find travelers', onPress: () => router.replace('/discover') };
  const toMeetups = { label: 'Go to Meetups', onPress: () => router.replace('/meetups') };
  // The states that stand before the form, in the order the caller has to be told them: the recipient
  // read is settled before the caller's own proof, and the missing-recipient notice waits for the
  // city reads. An unverified caller is owed the import banner rather than an action that reaches no
  // traveler, and an unresolvable recipient is owed the error the reader is alerted to (AAP 0.5.8).
  const blocked: ReactElement | null = me.isError ? (
    <Banner tone="error" message={userMessageFor(errorCodeOf(me.error))} action={retryMe} />
  ) : me.data === undefined ? (
    <LoadingLine />
  ) : gone ? (
    <>
      <Banner
        testID="propose-recipient-error"
        tone="error"
        message={notFound}
        // The action is offered only where /discover lists travelers: an unverified caller finds the
        // import banner there, which is the dead end this branch exists to keep off the screen.
        {...(cityId === undefined ? {} : { action: find })}
      />
      {cityId === undefined ? PROOF_BANNER : null}
    </>
  ) : cityId === undefined ? (
    PROOF_BANNER
  ) : city === undefined && !cities.isError ? (
    <LoadingLine />
  ) : city === undefined ? (
    <Banner tone="error" message={userMessageFor(errorCodeOf(cities.error))} action={retryCities} />
  ) : noRecipient ? (
    <Banner testID="propose-no-recipient" tone="error" message={NO_RECIPIENT} action={find} />
  ) : null;
  if (blocked !== null) return <Shell>{blocked}</Shell>;
  if (me.data === undefined || city === undefined) return <Shell>{<LoadingLine />}</Shell>;
  const variant: Variant | null = me.data.variant;
  const copy = variant === null ? null : depositCopy(variant, depositCents);
  const onCardSaved = (result: CardSetupResult): void => {
    if (result.status === 'saved') retryHold();
  };
  if (phase === 'card' || phase === 'unconfirmed') {
    const refused = phase === 'unconfirmed';
    const banner = refused
      ? { testID: 'propose-unconfirmed', message: NOT_CONFIRMED, action: retryHoldAction }
      : { testID: 'propose-hold-failed', message: userMessageFor('hold_failed') };
    const card = (
      <>
        <DepositCopy copy={copy} />
        <SafetyNotice />
        <CardSetup onDone={onCardSaved} />
      </>
    );
    return (
      <Shell>
        <Banner tone="error" {...banner} />
        {refused ? null : card}
      </Shell>
    );
  }
  if (phase === 'confirming' || phase === 'recovering') {
    const gaveUp = phase === 'recovering' && stopped;
    const banner = gaveUp
      ? { testID: 'propose-still-confirming', message: STILL_CONFIRMING, action: toMeetups }
      : { testID: 'propose-confirming', message: "We're confirming your card hold…" };
    return <Shell>{<Banner tone="info" {...banner} />}</Shell>;
  }
  const now = new Date();
  const startsAt = parseStart(startText, city.timezone);
  const startValid = startsAt !== null && isWithinHorizon(startsAt, now.getTime());
  const ready = venueId !== '' && startValid && !busy;
  const venueList = (venues.data?.items ?? []).filter((venue) => venue.isActivePartner);
  const noVenues = venues.isSuccess && venueList.length === 0;
  const row = recipient.data === undefined ? null : rowOf(recipient.data);
  const readsFailed = venues.isError || recipient.isError;
  const startLine = startValid && startsAt !== null ? startLineFor(startsAt, city.timezone) : null;
  const sent = startLine === null ? null : `${startLine} in ${city.name}`;
  const venueRows = venueList.map(({ id, name, address }) => ({
    key: id,
    testID: `propose-venue-${id}`,
    label: name,
    note: address,
    selected: id === venueId,
    onPress: () => setVenueId(id),
  }));
  const presetRows = startPresets(now, city.timezone).map((preset) => ({
    key: preset.testID,
    label: preset.label,
    testID: preset.testID,
    variant: 'secondary' as const,
    style: styles.chip,
    onPress: () => setStartText(startTextFor(preset.at, city.timezone)),
  }));
  const depositRows = DEPOSIT_LEVELS_CENTS.map((cents) => ({
    key: cents,
    testID: `propose-deposit-${cents}`,
    label: formatUsdWhole(cents),
    selected: cents === depositCents,
    onPress: () => setDepositCents(cents),
    style: styles.chip,
  }));
  const send = (): void => {
    if (!ready || startsAt === null || submittingRef.current) return;
    submittingRef.current = true;
    setErrorCode(null);
    setBusy(true);
    const proposal = { recipientId, venueId, startsAt: startsAt.toISOString(), depositCents };
    void (async () => {
      try {
        const created = await apiClient.proposeMeetup(proposal);
        remember(created.meetupId);
        acceptSecret(created.clientSecret);
      } catch (error) {
        const code = errorCodeOf(error);
        if (code !== 'hold_failed') applyFailure(code);
        else {
          try {
            const page = await apiClient.listMeetups({ role: 'initiator', status: 'proposed' });
            const mine = page.items.find((item) => item.counterpart.id === recipientId);
            if (mine === undefined) setErrorCode('hold_failed');
            else remember(mine.id);
            setPhase(mine === undefined ? 'form' : 'card');
          } catch (listError) {
            setErrorCode(errorCodeOf(listError));
            setPhase('form');
          }
        }
      } finally {
        submittingRef.current = false;
        setBusy(false);
      }
    })();
  };
  const startLabel = `Start (YYYY-MM-DD HH:mm, ${city.name} time)`;
  const startHint = `Times are in ${city.name} time.`;
  const startError = startMessage(startText, startsAt, now.getTime());
  const startValue = { value: startText, onChangeText: setStartText };
  const startField = { ...START_BASE, ...START_KEYS, ...startValue, testID: 'propose-start' };
  const startInput = { ...startField, onSubmitEditing: send };
  return (
    <Shell>
      {errorMessage === null ? null : <Banner tone="error" message={errorMessage} />}
      {errorCode === 'no_valid_proof' ? PROOF_BANNER : null}
      {readsFailed ? <Banner tone="error" message={readsCopy} action={retryReads} /> : null}
      {row === null ? null : (
        <View style={styles.section}>
          <Text {...SECTION_HEADING} style={styles.heading} children="Meetup with" />
          <ListItem testID="propose-recipient" {...row} />
        </View>
      )}
      <View style={styles.section}>
        <Text {...SECTION_HEADING} style={styles.heading} children={VENUE_HEADING} />
        <View {...VENUE_GROUP} style={styles.group}>
          {venueRows.map(toOption)}
        </View>
        {noVenues ? <Text style={styles.body}>{VENUES_EMPTY}</Text> : null}
        {venueList.length > 0 && venueId === '' ? (
          <Text style={styles.body}>{NO_VENUE}</Text>
        ) : null}
      </View>
      <View style={styles.section}>
        <TextField {...startInput} label={startLabel} hint={startHint} error={startError} />
        {sent === null ? null : <Text style={styles.confirm}>{sent}</Text>}
        <View style={styles.chipRow}>
          {presetRows.map(({ key, ...row }) => (
            <Button key={key} {...row} />
          ))}
        </View>
      </View>
      <View style={styles.section}>
        <Text {...SECTION_HEADING} style={styles.heading} children={DEPOSIT_HEADING} />
        <View {...DEPOSIT_GROUP} style={styles.chipRow}>
          {depositRows.map(toOption)}
        </View>
      </View>
      <DepositCopy copy={copy} />
      <SafetyNotice />
      <Button testID="propose-submit" label={SUBMIT} disabled={!ready} busy={busy} onPress={send} />
    </Shell>
  );
}
const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  heading: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  cardHeading: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.textMuted },
  group: { gap: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  // `flexBasis: 0` is what makes same-type siblings equal: with `flexGrow` alone each chip keeps its
  // own text width as a base, so the free space is shared on top of unequal bases and a row that wraps
  // at a narrow width reads as columns of different widths (AAP 0.5.8).
  chip: { flexBasis: 0, flexGrow: 1 },
  option: { ...OPTION_BOX, ...OPTION_SHAPE, ...OPTION_SIZE },
  optionHovered: { backgroundColor: colors.surface },
  optionFocused: { borderColor: colors.focusRing },
  optionPressed: { backgroundColor: colors.surface },
  marker: { ...MARKER_BOX, height: MARKER_SIZES.ring, width: MARKER_SIZES.ring },
  markerSelected: { borderColor: colors.primary },
  markerDot: { ...DOT_BOX, height: MARKER_SIZES.dot, width: MARKER_SIZES.dot },
  optionText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  optionLabel: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  optionSubtitle: { ...typography.caption, color: colors.textMuted },
  confirm: { ...typography.body, color: colors.textMuted },
  framing: { ...typography.body, color: colors.text, fontWeight: fontWeights.medium },
  tips: { gap: spacing.sm },
  tip: { ...typography.body, color: colors.text },
});
const RADIO_GROUP = { role: 'radiogroup' } as const;
const VENUE_GROUP = { ...RADIO_GROUP, 'aria-label': VENUE_HEADING };
const DEPOSIT_GROUP = { ...RADIO_GROUP, 'aria-label': DEPOSIT_HEADING };
