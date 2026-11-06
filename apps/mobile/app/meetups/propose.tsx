/**
 * Propose a meetup and place the initiator's card hold (AAP 0.5.8, AAP 0.7.1 row 4, AAP 0.8.1).
 *
 * Reached from a traveler's profile as `/meetups/propose?recipientId=…`, it carries the proposal
 * rule: the gate, the three choices the contract accepts, and the initiator's hold.
 *
 * The proof gate is a gate and not a hint. `POST /meetups` refuses a caller without a valid proof
 * for the venue's city with `403 no_valid_proof`, so without one the screen renders the import
 * banner over no form and issues no venue request (AAP 0.5.8). A valid proof is
 * `MeDto.proof.status === 'valid'` with a `cityId`, and that city is the venue list's city and the
 * zone every time here is shown in: a device set elsewhere must not offer a start the venue and the
 * other traveler do not keep.
 *
 * The framing sentence is the experiment's single variable (AAP 0.1.1, AAP 0.5.7). Every other
 * label — headings, the start field, the deposit amounts, the neutral "Send proposal" control — is
 * identical for `social` and `punitive`, and no wording of this file's own adds a penalty or a seat
 * metaphor to one variant alone. A viewer with no assignment yet sees no framing line.
 *
 * The hold is placed by the API inside `POST /meetups`; this screen drives what the answer leaves
 * open. A hold that authorizes without customer action reads `held`, a `requires_action` hold runs
 * Stripe's own 3-D Secure challenge and then waits for the webhook that moves the deposit, and
 * `402 hold_failed` — which carries no meetup id (AAP 0.7.3) — recovers the meetup from
 * `GET /meetups?role=initiator&status=proposed` and offers the card step. The Payment Intent
 * client secret lives in a ref for the length of the flow, never in state, never rendered and never
 * logged, and no card number, expiry or CVC reaches this app: the card is entered inside Stripe's
 * own component (AAP 0.12.2).
 *
 * Nothing here filters a field: the counterpart arrives serialized at the caller's tier, so the row
 * shows what the payload carries and derives nothing (AAP 0.3.2, criterion 5). Reading and focus
 * order is the source order — recipient, venue, start, deposit, framing, safety notice, submit, then
 * the card and retry controls — and every failure is shown in a banner and spoken (AAP 0.5.8).
 *
 * Client-safe: no Node built-in, no `luxon` (a server dependency, AAP 0.4.1), no module-load effect.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
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
  VENUES_EMPTY,
} from '../../src/copy/strings';
import { CardSetup } from '../../src/payments/card-setup';
import type { CardSetupResult } from '../../src/payments/card-setup';
import { completeNextAction } from '../../src/payments/next-action';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { Banner, Button, Card, ListItem, Screen, TextField, announce } from '../../src/ui';

/** The navigator header's title, which is the page's visible heading (AAP 0.5.8). */
const SCREEN_TITLE = 'Propose a meetup';

/** Shown while a read the screen needs has not answered yet. */
const LOADING = 'Loading…';

/** Shown when the route reached this screen without the traveler it proposes to. */
const NO_RECIPIENT = 'Choose a traveler to propose a meetup to.';

/** The heading over the counterpart row. */
const RECIPIENT_HEADING = 'Meetup with';

/** The heading over the venue options, and that radio group's own name (AAP 0.5.8). */
const VENUE_HEADING = 'Partner venue';

/** The heading over the deposit options, and that radio group's own name. */
const DEPOSIT_HEADING = 'Deposit';

/** Neutral on purpose: identical for both variants, whose only variable is the framing line. */
const SUBMIT_LABEL = 'Send proposal';

/** The inline error of an unusable start; `422 starts_at_invalid` maps to the same sentence. */
const START_ERROR = `Choose a time in the next ${START_HORIZON_DAYS} days.`;

/** The status of a hold whose confirmation is still being read, and what it becomes after 2 min. */
const CONFIRMING = "We're confirming your card hold…";
const STILL_CONFIRMING = 'Still confirming — check Meetups shortly.';

/** Shown when a 3-D Secure challenge was abandoned or refused. */
const NOT_CONFIRMED = "Card confirmation wasn't completed.";

/** Stands in a query key whose read is disabled, so every hook stays unconditional. */
const NO_ID = '';

/** `YYYY-MM-DD HH:mm`, the only shape the start field accepts. */
const START_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/** How `Intl` reports one instant in a zone: 24-hour, zero-padded, no locale-dependent names. */
const ZONE_PART_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/** The wording a start is confirmed back in, in the city's own zone: `Fri 14 Nov, 19:00`. */
const START_LINE_FORMAT: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
};

/** The deposit is read again at this rate while it waits on Stripe, and the proposed list while a
 * lost hold answer is recovered; both windows bound how long the screen waits (AAP 0.3.2). */
const CONFIRM_POLL_MS = 2_000;
const CONFIRM_WINDOW_MS = 30_000;
const RECOVER_POLL_MS = 3_000;
const RECOVER_WINDOW_MS = 2 * MINUTE_MS;

/** The radio marker and its dot, in points: decoration that must not scale with the font size. */
const MARKER_SIZE = 20;
const MARKER_DOT_SIZE = 10;

/**
 * Keeps the browser's own outline off a focused option on web, where it would be painted over the
 * reserved 2 px band and the keyboard ring would be the browser's default rather than
 * `colors.focusRing` (WCAG 2.4.7). The value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

// --- The venue's city's own time (AAP 0.5.8) ----------------------------------------------------

/** A wall-clock reading in one zone: the fields {@link START_PATTERN} carries. */
interface ZonedParts {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
}

/** Zero-pads a field to two digits. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** The reading one zone shows at an instant, read with `Intl`. */
function zoneFields(date: Date, timeZone: string): ZonedParts & { readonly s: number } {
  const reading = (zone: string): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat('en-US', { ...ZONE_PART_OPTIONS, timeZone: zone }).formatToParts(date);

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = reading(timeZone);
  } catch {
    // A zone this runtime does not carry — a misconfigured city rather than a traveler's choice —
    // reads as UTC, the same fallback the meetup list's own time formatter takes, so one bad
    // configuration value cannot take the screen down.
    parts = reading('UTC');
  }

  const field = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return {
    y: field('year'),
    mo: field('month'),
    d: field('day'),
    h: field('hour'),
    mi: field('minute'),
    s: field('second'),
  };
}

/** The zone's UTC offset in milliseconds at one instant, as that instant's reading implies. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const at = zoneFields(new Date(instantMs), timeZone);
  return Date.UTC(at.y, at.mo - 1, at.d, at.h, at.mi, at.s) - instantMs;
}

/**
 * The instant a reading in `timeZone` names.
 *
 * The offset is applied twice on purpose: the first pass reads it at the guessed instant and the
 * second at the corrected one, which is what settles a reading close to a daylight-saving change. A
 * reading the zone never shows is left to {@link parseStart}, which refuses it rather than moving
 * it an hour.
 */
function zonedLocalToUtc(parts: ZonedParts, timeZone: string): Date {
  const guess = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return new Date(guess - zoneOffsetMs(first, timeZone));
}

/** The reading `timeZone` shows at `date`. */
function utcToZonedParts(date: Date, timeZone: string): ZonedParts {
  const at = zoneFields(date, timeZone);
  return { y: at.y, mo: at.mo, d: at.d, h: at.h, mi: at.mi };
}

/** A start as the field holds it: `YYYY-MM-DD HH:mm`, in the city's own time. */
function startTextFor(date: Date, timeZone: string): string {
  const at = utcToZonedParts(date, timeZone);
  return `${at.y}-${pad2(at.mo)}-${pad2(at.d)} ${pad2(at.h)}:${pad2(at.mi)}`;
}

/** A start as the screen confirms it back in the city's zone: `Fri 14 Nov, 19:00`; a zone this
 * runtime does not carry falls back to the field's own text rather than failing the render. */
function startLineFor(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...START_LINE_FORMAT, timeZone }).format(date);
  } catch {
    return startTextFor(date, timeZone);
  }
}

/** The next full hour plus one hour: the start the field opens with, well inside the horizon. */
function defaultStart(now: Date): Date {
  return new Date(Math.ceil(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
}

/**
 * The instant the field's text names, or null when it names none (AAP 0.5.8).
 *
 * A real calendar date is required, and the round trip through the zone is what checks it: an
 * entered `2026-02-30` would otherwise be silently rolled into March, and a reading a
 * daylight-saving jump skips has no instant of its own.
 */
function parseStart(text: string, timeZone: string): Date | null {
  const match = START_PATTERN.exec(text.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi] = match;
  if (
    y === undefined ||
    mo === undefined ||
    d === undefined ||
    h === undefined ||
    mi === undefined
  ) {
    return null;
  }
  const parts: ZonedParts = {
    y: Number(y),
    mo: Number(mo),
    d: Number(d),
    h: Number(h),
    mi: Number(mi),
  };

  const date = zonedLocalToUtc(parts, timeZone);
  const back = utcToZonedParts(date, timeZone);
  const same =
    back.y === parts.y &&
    back.mo === parts.mo &&
    back.d === parts.d &&
    back.h === parts.h &&
    back.mi === parts.mi;
  return same ? date : null;
}

/** Whether a start is one the API accepts: in the future, within `START_HORIZON_DAYS`. */
function isWithinHorizon(startsAt: Date, nowMs: number): boolean {
  const at = startsAt.getTime();
  return at > nowMs && at <= nowMs + START_HORIZON_DAYS * DAY_MS;
}

/**
 * The quick picks, each kept only when the start it produces is one the API accepts: a pick outside
 * `now < startsAt <= now + START_HORIZON_DAYS` is left out rather than filling the field with a
 * value the route answers `422 starts_at_invalid` for.
 */
function startPresets(
  now: Date,
  timeZone: string,
): { readonly testID: string; readonly label: string; readonly at: Date }[] {
  const today = utcToZonedParts(now, timeZone);
  const next = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1));
  const tomorrow = { y: next.getUTCFullYear(), mo: next.getUTCMonth() + 1, d: next.getUTCDate() };
  const inTwoHours = new Date(now.getTime() + 2 * HOUR_MS);
  const candidates = [
    { testID: 'propose-start-in-2h', label: 'In 2 hours', at: inTwoHours },
    {
      testID: 'propose-start-tomorrow-12',
      label: 'Tomorrow 12:00',
      at: zonedLocalToUtc({ ...tomorrow, h: 12, mi: 0 }, timeZone),
    },
    {
      testID: 'propose-start-tomorrow-19',
      label: 'Tomorrow 19:00',
      at: zonedLocalToUtc({ ...tomorrow, h: 19, mi: 0 }, timeZone),
    },
  ];
  return candidates.filter((preset) => isWithinHorizon(preset.at, now.getTime()));
}

// --- Reading the API's answers ------------------------------------------------------------------

/** The city a currently valid proof names, or `undefined` when the traveler has none (AAP 0.5.5). */
function proofCityIdOf(proof: MeDto['proof']): string | undefined {
  // Compared against the enum's own literal, so a renamed value fails the type check here rather
  // than leaving the gate quietly closed for every traveler.
  return proof.status === 'valid' && proof.cityId !== undefined && proof.cityId !== ''
    ? proof.cityId
    : undefined;
}

/** A profile's second line, built only from the fields the payload carries (AAP 0.3.2). */
function recipientSubtitleOf(profile: AnyTierProfile): string | undefined {
  const parts: string[] = [];
  if ('nickname' in profile && profile.nickname !== null) parts.push(profile.nickname);
  if ('bio' in profile && profile.bio !== null) parts.push(profile.bio);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** The code of a failed request, for `userMessageFor`: never the server's own prose (AAP 0.11.1). */
function errorCodeOf(error: unknown): ClientErrorCode {
  return isApiError(error) ? error.code : 'invalid_response';
}

/** What the initiator's own hold says to do next. */
type HoldStep = 'finish' | 'authenticate' | 'card' | 'recover';

/**
 * The step for the visible state of the initiator's hold (AAP 0.5.4): `requires_action` is the
 * 3-D Secure challenge, `failed` is the card step, and every other value — the `pending` a lost
 * answer leaves, and any state that is neither of the two — resolves by reading the meetup again
 * rather than by acting on a hold this client cannot place.
 */
function holdStepFor(hold: HoldView): HoldStep {
  switch (hold) {
    case 'held':
      return 'finish';
    case 'requires_action':
      return 'authenticate';
    case 'failed':
      return 'card';
    default:
      return 'recover';
  }
}

// --- The screen's own controls ------------------------------------------------------------------

/** Section headings' attributes: `role="heading"` is the platform's header trait, and `aria-level`
 * is what react-native-web reads to render a real `<h2>` rather than an unlevelled span. */
const SECTION_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
};

/** Props of {@link RadioOption}. */
interface RadioOptionProps {
  /** Visible name, which is also the option's accessible name. */
  label: string;
  /** Optional second line, such as a venue's address; part of the accessible name as well. */
  subtitle?: string;
  /** Whether this option is the group's current choice. */
  selected: boolean;
  /** Selects this option. */
  onPress: () => void;
  /** Forwarded to the pressable, so a test finds the option by its own id. */
  testID: string;
  /** Layout only — `flexGrow` for a chip in a row. Never a colour. */
  style?: StyleProp<ViewStyle>;
}

/**
 * One option of a single-choice group.
 *
 * The group is a `radiogroup` and each option a `radio`, which is the role the platform announces
 * together with its own selected state rather than leaving the choice to a colour (AAP 0.5.8). Both
 * spellings of that state are set on purpose: `aria-checked` is what react-native-web puts in the
 * DOM and what this React Native version reads on native, and `accessibilityState` is the pair the
 * AAP names. `aria-selected` is deliberately not set — it is not an attribute `role="radio"` may
 * carry. The option is built here rather than from `Button` or `ListItem` — the two the screen's
 * contract names for these choices — because neither primitive exposes a role or a selected state,
 * so a screen reader user would hear which venue or deposit is chosen from nothing at all.
 */
function RadioOption({
  label,
  subtitle,
  selected,
  onPress,
  testID,
  style,
}: RadioOptionProps): ReactElement {
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      role="radio"
      aria-checked={selected}
      accessibilityState={{ selected, checked: selected }}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.option,
        focused ? styles.optionFocused : null,
        pressed ? styles.optionPressed : null,
        webFocusRingReset,
        style,
      ]}
    >
      <View aria-hidden style={[styles.marker, selected ? styles.markerSelected : null]}>
        {selected ? <View style={styles.markerDot} /> : null}
      </View>
      <View style={styles.optionText}>
        <Text style={styles.optionLabel}>{label}</Text>
        {subtitle === undefined ? null : <Text style={styles.optionSubtitle}>{subtitle}</Text>}
      </View>
    </Pressable>
  );
}

/**
 * The safety notice a proposal and a lock both show before the commitment (AAP 0.5.4, 0.5.8,
 * 0.12.2). It renders above the submit control in reading order as well as layout, so a screen
 * reader meets the notice and its tips before the action, and it is shown again on the card step a
 * failed hold lands on, because that is still the same proposal. Its words are the fixed strings of
 * `src/copy/strings.ts`, never written out here.
 */
function SafetyNotice(): ReactElement {
  return (
    <Card testID="safety-notice" title={SAFETY_NOTICE}>
      <Text {...SECTION_HEADING} style={styles.cardHeading}>
        {SAFETY_TIPS_TITLE}
      </Text>
      <View style={styles.tips}>
        {SAFETY_TIPS.map((tip) => (
          <Text key={tip} style={styles.tip}>
            {tip}
          </Text>
        ))}
      </View>
    </Card>
  );
}

// --- The screen ---------------------------------------------------------------------------------

/** The container every branch below renders: the navigator header's title, then the notice. */
function Shell({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <Screen>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      {children}
    </Screen>
  );
}

/** The screen's steps; only one is rendered at a time (AAP 0.5.3, AAP 0.5.4). */
type Phase = 'form' | 'confirming' | 'recovering' | 'card' | 'unconfirmed';

/**
 * The proposal screen. It owns the counterpart read, the two choices a proposal needs and the whole
 * hold flow, and `src/state/meetup-store.ts` owns everything it caches.
 *
 * @returns The propose screen for the traveler named by `recipientId`.
 */
export default function ProposeScreen(): ReactElement {
  const params = useLocalSearchParams<{ recipientId?: string }>();
  const recipientId = params.recipientId ?? '';

  const me = useMe();
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: () => apiClient.listCities() });
  const recipient = useQuery({
    queryKey: queryKeys.user(recipientId),
    queryFn: () => apiClient.getUser(recipientId),
    enabled: recipientId !== '',
  });

  const proof = me.data?.proof;
  const cityId = proof === undefined ? undefined : proofCityIdOf(proof);
  const city = cities.data?.items.find((item) => item.id === cityId);

  // No venue request without a city a valid proof names: the read stays disabled and its sentinel
  // key is never fetched, so an unverified traveler costs the API nothing here (AAP 0.5.8).
  const venues = useQuery({
    queryKey: queryKeys.venues(cityId ?? NO_ID),
    queryFn: () => apiClient.listVenues(cityId ?? NO_ID),
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
  /**
   * The meetup this screen is driving, held in a ref as well as in state.
   *
   * The state is what the polled reads are keyed on and enabled by; the ref is what a callback
   * reads, because a step a poll just decided must act on the meetup that poll named and not on the
   * value the render that called it was closed over.
   */
  const meetupIdRef = useRef<string | null>(null);
  /** The current attempt's client secret. A bearer credential: a ref, never state or a log line. */
  const secretRef = useRef<string | null>(null);
  /** The secret a challenge was already run for, which bounds the flow to one per attempt. */
  const challengedRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const defaultedRef = useRef(false);
  const doneRef = useRef(false);

  const confirming = useQuery({
    queryKey: queryKeys.meetup(meetupId ?? NO_ID),
    queryFn: () => apiClient.getMeetup(meetupId ?? NO_ID),
    enabled: phase === 'confirming' && meetupId !== null && !authenticating,
    refetchInterval: phase === 'confirming' && meetupId !== null ? CONFIRM_POLL_MS : false,
  });

  const openProposals = useQuery({
    queryKey: queryKeys.meetups('initiator', 'proposed'),
    queryFn: () => apiClient.listMeetups({ role: 'initiator', status: 'proposed' }),
    enabled: phase === 'recovering' && !stopped,
    refetchInterval: phase === 'recovering' && !stopped ? RECOVER_POLL_MS : false,
  });

  /** Remembers the meetup the flow is driving, for both the reads and the callbacks. */
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

  /** Maps a failed hold request to the step that can still place it (AAP 0.3.2, AAP 0.5.4). */
  const applyFailure = useCallback(
    (code: ClientErrorCode): void => {
      if (code === 'hold_failed') {
        setPhase('card');
        return;
      }
      if (code === 'payment_unavailable' || code === 'hold_pending') {
        // The hold's own answer was lost and the API is recovering it: only reading the meetup
        // again can say what became of it (AAP 0.3.2).
        enterRecovering();
        return;
      }
      const id = meetupIdRef.current;
      if (code === 'not_proposed' && id !== null) {
        router.replace(`/meetups/${id}`);
        return;
      }
      setErrorCode(code);
      setPhase('form');
    },
    [enterRecovering],
  );

  /** Asks for the caller's own current attempt's secret and reads the hold again (AAP 0.5.4). */
  const retryHold = useCallback((): void => {
    const id = meetupIdRef.current;
    if (id === null) return;
    setErrorCode(null);
    setBusy(true);
    void (async () => {
      try {
        const retry = await apiClient.retryHold(id);
        secretRef.current = retry.clientSecret;
        challengedRef.current = null;
        setPhase('confirming');
      } catch (error) {
        applyFailure(errorCodeOf(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [applyFailure]);

  /** Runs the 3-D Secure challenge the hold is waiting on, once per attempt. */
  const authenticate = useCallback((): void => {
    const secret = secretRef.current;
    if (secret === null || challengedRef.current === secret) {
      // Nothing to challenge, or the challenge for this attempt already ran: the hold is waiting on
      // Stripe's webhook, which is what the read again is for.
      enterRecovering();
      return;
    }
    challengedRef.current = secret;
    setAuthenticating(true);
    void (async () => {
      const result = await completeNextAction(secret);
      setAuthenticating(false);
      // `succeeded` means Stripe holds the authorization; the meetup moves only when the API
      // processes the webhook, so the screen reads the deposit again instead of assuming a state.
      if (result.status !== 'succeeded') setPhase('unconfirmed');
    })();
  }, [enterRecovering]);

  /** Reads what the hold says next and takes that step (AAP 0.5.4). */
  const applyHold = useCallback(
    (hold: HoldView): void => {
      const step = holdStepFor(hold);
      if (step === 'finish') {
        finish();
        return;
      }
      if (step === 'card') {
        setPhase('card');
        return;
      }
      if (step === 'authenticate') {
        // A recovered hold carries no secret, so the current attempt's own is asked for rather than
        // guessed: the route creates no second authorization while one is `requires_action`.
        if (secretRef.current === null) retryHold();
        else authenticate();
        return;
      }
      enterRecovering();
    },
    [authenticate, enterRecovering, finish, retryHold],
  );

  // The deposit's own answer says what the flow does next, so every answer is applied. The step runs
  // one turn after the commit that delivered the answer rather than inside this effect's own body,
  // which is what keeps the effect from setting state in the render it was called for.
  const holdRead = confirming.data?.initiatorHold;
  useEffect(() => {
    if (phase !== 'confirming' || holdRead === undefined) return;
    const decide = setTimeout(() => {
      applyHold(holdRead);
    }, 0);
    return () => clearTimeout(decide);
  }, [applyHold, holdRead, phase]);

  // The proposed list is the recovery path for a hold answer that never arrived.
  const proposedItems = openProposals.data?.items;
  useEffect(() => {
    if (phase !== 'recovering' || proposedItems === undefined) return;
    const decide = setTimeout(() => {
      const mine = proposedItems.find((item) => item.counterpart.id === recipientId);
      if (mine === undefined) {
        // Gone from the open list: it locked, lapsed, was declined or was cancelled, and the meetup
        // list is where each of those states explains itself.
        router.replace('/meetups');
        return;
      }
      remember(mine.id);
      applyHold(mine.initiatorHold);
    }, 0);
    return () => clearTimeout(decide);
  }, [applyHold, phase, proposedItems, recipientId, remember]);

  // Polling is bounded: a challenge that never reports back falls through to the recovery read, and
  // a recovery that never resolves stops rather than holding the screen on a spinner for good.
  useEffect(() => {
    if (phase !== 'confirming' && phase !== 'recovering') return;
    if (phase === 'recovering' && stopped) return;
    const window = phase === 'confirming' ? CONFIRM_WINDOW_MS : RECOVER_WINDOW_MS;
    const timer = setTimeout(() => {
      if (phase === 'confirming') enterRecovering();
      else setStopped(true);
    }, window);
    return () => clearTimeout(timer);
  }, [enterRecovering, phase, stopped]);

  const recipientUnavailable =
    recipient.isError && errorCodeOf(recipient.error) === 'user_not_found';

  // The start field opens on a valid start rather than on the shape of one, so a traveler who
  // changes nothing still submits a time the API accepts. Once, because React 18 runs an effect
  // twice on mount in development, and only once the city — and so its zone — is known.
  useEffect(() => {
    if (defaultedRef.current || city === undefined) return;
    defaultedRef.current = true;
    setStartText(startTextFor(defaultStart(new Date()), city.timezone));
  }, [city]);

  const errorMessage = errorCode === null ? null : userMessageFor(errorCode);
  const gateMessage =
    recipientId === ''
      ? NO_RECIPIENT
      : recipientUnavailable
        ? userMessageFor('user_not_found')
        : null;

  // iOS has no live region to speak a banner, so the core flows' failures are announced as well as
  // shown (AAP 0.5.8). `announce` drops an immediate repeat and does nothing off iOS and Android.
  const announced = errorMessage ?? gateMessage;
  useEffect(() => {
    if (announced !== null) announce(announced);
  }, [announced]);

  /**
   * The one notice that stands where the form would, in the order the AAP checks them (AAP 0.5.8):
   * the own-profile read that carries the gate and the variant, the traveler this screen proposes
   * to, the valid proof whose city the venue list and every time here need, the city read that
   * names the zone, and a counterpart the API reports as gone.
   */
  const blocked: ReactElement | null = me.isError ? (
    <Banner
      tone="error"
      message={userMessageFor(errorCodeOf(me.error))}
      action={{ label: 'Try again', onPress: () => void me.refetch() }}
    />
  ) : me.data === undefined ? (
    <Text style={styles.body}>{LOADING}</Text>
  ) : recipientId === '' ? (
    <Banner
      testID="propose-no-recipient"
      tone="error"
      message={NO_RECIPIENT}
      action={{ label: 'Find travelers', onPress: () => router.replace('/discover') }}
    />
  ) : cityId === undefined ? (
    <Banner
      testID="proof-banner"
      tone="info"
      message={IMPORT_BANNER}
      action={{ label: 'Verify my stay', onPress: () => router.push('/proof/import') }}
    />
  ) : city === undefined ? (
    cities.isError ? (
      <Banner
        tone="error"
        message={userMessageFor(errorCodeOf(cities.error))}
        action={{ label: 'Try again', onPress: () => void cities.refetch() }}
      />
    ) : (
      <Text style={styles.body}>{LOADING}</Text>
    )
  ) : recipientUnavailable ? (
    <Banner
      testID="propose-recipient-error"
      tone="error"
      message={userMessageFor('user_not_found')}
    />
  ) : null;

  if (blocked !== null) {
    return <Shell>{blocked}</Shell>;
  }

  // The gate above has answered every state in which either of these is missing; repeating the test
  // is what tells the compiler that from here the form's data is present.
  if (me.data === undefined || city === undefined) {
    return (
      <Shell>
        <Text style={styles.body}>{LOADING}</Text>
      </Shell>
    );
  }

  const variant: Variant | null = me.data.variant;
  const framing = variant === null ? null : depositCopy(variant, depositCents);

  if (phase === 'card' || phase === 'unconfirmed') {
    const refused = phase === 'unconfirmed';
    return (
      <Shell>
        <Banner
          testID={refused ? 'propose-unconfirmed' : 'propose-hold-failed'}
          tone="error"
          message={refused ? NOT_CONFIRMED : userMessageFor('hold_failed')}
          {...(refused ? { action: { label: 'Try again', onPress: retryHold } } : {})}
        />
        {refused ? null : (
          <>
            {framing === null ? null : (
              <Text testID="deposit-copy" style={styles.framing}>
                {framing}
              </Text>
            )}
            <SafetyNotice />
            {/* Only a stored card changes anything: the hold is placed again, while a cancelled or
                failed attempt leaves the step as it is with its own notice on screen. */}
            <CardSetup
              onDone={(result: CardSetupResult) => {
                if (result.status === 'saved') retryHold();
              }}
            />
          </>
        )}
      </Shell>
    );
  }

  if (phase === 'confirming' || phase === 'recovering') {
    const gaveUp = phase === 'recovering' && stopped;
    return (
      <Shell>
        <Banner
          testID={gaveUp ? 'propose-still-confirming' : 'propose-confirming'}
          tone="info"
          message={gaveUp ? STILL_CONFIRMING : CONFIRMING}
          {...(gaveUp
            ? { action: { label: 'Go to Meetups', onPress: () => router.replace('/meetups') } }
            : {})}
        />
      </Shell>
    );
  }

  const now = new Date();
  const startsAt = parseStart(startText, city.timezone);
  const startValid = startsAt !== null && isWithinHorizon(startsAt, now.getTime());
  const canSubmit = venueId !== '' && startValid && !busy;
  // Only active partner venues may host a meetup; the route answers `422 venue_not_partner` for a
  // venue that is not one (AAP 0.12.2).
  const venueList = (venues.data?.items ?? []).filter((venue) => venue.isActivePartner);
  const profile = recipient.data;
  const subtitle = profile === undefined ? undefined : recipientSubtitleOf(profile);
  const recipientRow =
    profile === undefined
      ? null
      : { label: profile.handle, ...(subtitle === undefined ? {} : { subtitle }) };

  /** Sends the proposal, and recovers the meetup a `402` leaves hidden behind its own answer. */
  const submit = (): void => {
    // A second POST would be answered `409 meetup_exists`, and a double tap is the way to send one.
    if (!canSubmit || startsAt === null || submittingRef.current) return;
    submittingRef.current = true;
    setErrorCode(null);
    setBusy(true);
    void (async () => {
      try {
        const created = await apiClient.proposeMeetup({
          recipientId,
          venueId,
          startsAt: startsAt.toISOString(),
          depositCents,
        });
        secretRef.current = created.clientSecret;
        challengedRef.current = null;
        remember(created.meetupId);
        setPhase('confirming');
      } catch (error) {
        const code = errorCodeOf(error);
        if (code !== 'hold_failed') {
          applyFailure(code);
          return;
        }
        // The meetup exists, stays invisible to the recipient and carries no id in the answer
        // (AAP 0.7.3), so it is read back from the caller's own open proposals.
        try {
          const page = await apiClient.listMeetups({ role: 'initiator', status: 'proposed' });
          const mine = page.items.find((item) => item.counterpart.id === recipientId);
          if (mine === undefined) {
            setErrorCode('hold_failed');
            setPhase('form');
            return;
          }
          remember(mine.id);
          setPhase('card');
        } catch (listError) {
          setErrorCode(errorCodeOf(listError));
          setPhase('form');
        }
      } finally {
        submittingRef.current = false;
        setBusy(false);
      }
    })();
  };

  return (
    <Shell>
      {errorMessage === null ? null : <Banner tone="error" message={errorMessage} />}
      {errorCode === 'no_valid_proof' ? (
        <Banner
          testID="proof-banner"
          tone="info"
          message={IMPORT_BANNER}
          action={{ label: 'Verify my stay', onPress: () => router.push('/proof/import') }}
        />
      ) : null}
      {venues.isError || recipient.isError ? (
        <Banner
          tone="error"
          message={userMessageFor(errorCodeOf(venues.error ?? recipient.error))}
          action={{
            label: 'Try again',
            onPress: () => {
              void venues.refetch();
              void recipient.refetch();
            },
          }}
        />
      ) : null}

      {recipientRow === null ? null : (
        <View style={styles.section}>
          <Text {...SECTION_HEADING} style={styles.heading}>
            {RECIPIENT_HEADING}
          </Text>
          <ListItem
            testID="propose-recipient"
            label={recipientRow.label}
            {...(recipientRow.subtitle === undefined ? {} : { subtitle: recipientRow.subtitle })}
          />
        </View>
      )}

      <View style={styles.section}>
        <Text {...SECTION_HEADING} style={styles.heading}>
          {VENUE_HEADING}
        </Text>
        <View role="radiogroup" aria-label={VENUE_HEADING} style={styles.group}>
          {venueList.map((venue) => (
            <RadioOption
              key={venue.id}
              testID={`propose-venue-${venue.id}`}
              label={venue.name}
              subtitle={venue.address}
              selected={venue.id === venueId}
              onPress={() => setVenueId(venue.id)}
            />
          ))}
        </View>
        {venues.isSuccess && venueList.length === 0 ? (
          <Text style={styles.body}>{VENUES_EMPTY}</Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <TextField
          testID="propose-start"
          label={`Start (YYYY-MM-DD HH:mm, ${city.name} time)`}
          value={startText}
          onChangeText={setStartText}
          hint={`Times are in ${city.name} time.`}
          error={startText.trim() !== '' && !startValid ? START_ERROR : null}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="text"
          returnKeyType="done"
          onSubmitEditing={submit}
        />

        {startsAt === null || !startValid ? null : (
          <Text style={styles.confirm}>
            {`${startLineFor(startsAt, city.timezone)} in ${city.name}`}
          </Text>
        )}

        <View style={styles.chipRow}>
          {startPresets(now, city.timezone).map((preset) => (
            <Button
              key={preset.testID}
              variant="secondary"
              label={preset.label}
              testID={preset.testID}
              style={styles.chip}
              onPress={() => setStartText(startTextFor(preset.at, city.timezone))}
            />
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text {...SECTION_HEADING} style={styles.heading}>
          {DEPOSIT_HEADING}
        </Text>
        <View role="radiogroup" aria-label={DEPOSIT_HEADING} style={styles.chipRow}>
          {DEPOSIT_LEVELS_CENTS.map((cents) => (
            <RadioOption
              key={cents}
              testID={`propose-deposit-${cents}`}
              label={formatUsdWhole(cents)}
              selected={cents === depositCents}
              onPress={() => setDepositCents(cents)}
              style={styles.chip}
            />
          ))}
        </View>
      </View>

      {framing === null ? null : (
        <Text testID="deposit-copy" style={styles.framing}>
          {framing}
        </Text>
      )}

      <SafetyNotice />

      <Button
        testID="propose-submit"
        label={SUBMIT_LABEL}
        disabled={!canSubmit}
        busy={busy}
        onPress={submit}
      />
    </Shell>
  );
}

const styles = StyleSheet.create({
  // One gap step inside a section, under the larger step `Screen` puts between sections.
  section: { gap: spacing.sm },
  // `text` on `background` is a recorded pair at 17.21:1, at the title step of the shared type scale.
  heading: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  cardHeading: {
    ...typography.label,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  // `textMuted` on `background` is a recorded pair at 7.07:1.
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
  group: { gap: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { flexGrow: 1 },
  // The border is painted in every state, so the focus token only recolours the band the layout
  // already reserves (WCAG 2.4.7); its non-text pair is `focusRing` on `background` at 6.7:1.
  option: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: borderWidths.control,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingBlock: spacing.sm,
    paddingInline: spacing.lg,
  },
  optionFocused: { borderColor: colors.focusRing },
  optionPressed: { backgroundColor: colors.surface },
  // `primary` on `background` is a recorded non-text pair at 7.3:1, and the resting `border` on it
  // is recorded at 3.7:1, so the chosen option reads without its colour alone (WCAG 1.4.11).
  marker: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: borderWidths.control,
    height: MARKER_SIZE,
    justifyContent: 'center',
    width: MARKER_SIZE,
  },
  markerSelected: { borderColor: colors.primary },
  markerDot: {
    backgroundColor: colors.primary,
    borderRadius: radii.pill,
    height: MARKER_DOT_SIZE,
    width: MARKER_DOT_SIZE,
  },
  optionText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  optionLabel: {
    ...typography.label,
    color: colors.text,
    fontWeight: fontWeights.medium,
  },
  optionSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
  },
  confirm: {
    ...typography.body,
    color: colors.textMuted,
  },
  // The experiment's sentence, in the page's own text pair and the medium weight, so it reads as
  // the one piece of copy the deposit turns on.
  framing: {
    ...typography.body,
    color: colors.text,
    fontWeight: fontWeights.medium,
  },
  tips: { gap: spacing.sm },
  tip: {
    ...typography.body,
    color: colors.text,
  },
});
