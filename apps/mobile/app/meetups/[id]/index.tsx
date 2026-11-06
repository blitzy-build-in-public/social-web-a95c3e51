/**
 * The meetup detail screen: one meetup, the recipient's Accept and lock, the initiator's card-hold
 * retry, cancellation, the settlement result, and the ways on to check-in, chat, the day plan and a
 * report (AAP 0.5.3, AAP 0.5.4, AAP 0.5.8, AAP 0.7.1 rows 4 and 6).
 *
 * The screen decides no rule of its own. `MeetupDto.nextAction` names the step the caller has, the
 * API's `lateCancel` — never the device clock — says whether a cancellation forfeits, and every
 * payment outcome is the server's. It filters no profile field either: the counterpart arrives
 * serialized at the caller's disclosure tier, because disclosure is enforced at field level by the
 * API (AAP 0.3.2, criterion 5). The framing sentence is the deposit screens' single variable — the
 * viewer's own `social` or `punitive` string with this meetup's amount — while every other label
 * reads the same for both variants (AAP 0.1.1). And a client secret lives in a parameter or a local
 * variable that reaches only `completeNextAction`: never state, never the query cache, never
 * storage and never a log line (AAP 0.5.4).
 *
 * This is the WCAG 2.1 AA "lock" flow: the framing line and the safety notice render above the
 * accept control, every failure is announced as well as shown, and each control is a button whose
 * visible label is its accessible name. One state-dependent view renders at a time, so the
 * saved-card panel never doubles a `deposit-copy` or a `safety-notice`.
 *
 * Client-safe: `react`, `react-native`, `expo-router`, `@tanstack/react-query`, `@tablemate/shared`
 * and the app's own modules, with no Node built-in, no DOM global and no effect at module load.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  CHECK_IN_CLOSES_AFTER_MINUTES,
  DISPUTE_FILING_WINDOW_HOURS,
  HOUR_MS,
  LOCK_LOST_COPY,
  MINUTE_MS,
  SUGGESTIONS_SETTLED_ELIGIBLE_HOURS,
  colors,
  depositCopy,
  fontWeights,
  formatUsdWhole,
  isDepositLevel,
  spacing,
  typography,
} from '@tablemate/shared';
import type { AnyTierProfile, HoldView, MeetupDto, MeetupStatus, Variant } from '@tablemate/shared';

import { apiClient } from '../../../src/api/client';
import { isApiError, userMessageFor } from '../../../src/api/errors';
import {
  SAFETY_NOTICE,
  SAFETY_TIPS,
  SAFETY_TIPS_TITLE,
  TABLE_CREDIT_NOTICE,
} from '../../../src/copy/strings';
import { CardSetup } from '../../../src/payments/card-setup';
import type { CardSetupResult } from '../../../src/payments/card-setup';
import { completeNextAction } from '../../../src/payments/next-action';
import { queryClient, queryKeys, useMe, useMeetup } from '../../../src/state/meetup-store';
import { Avatar, Banner, Button, Card, ListItem, Screen, announce } from '../../../src/ui';
import type { BannerTone } from '../../../src/ui';

// --- Fixed values -------------------------------------------------------------------------------

/** The navigator header's title, which is the page's only level-one heading. */
const SCREEN_TITLE = 'Meetup';

/**
 * The safe-area edges this screen claims: the navigator's header owns the top inset, and a route
 * pushed above the tabs has no tab bar to own the bottom one.
 */
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;

/** How long the city list — and so the venue's timezone — stays fresh, in milliseconds. */
const CITIES_STALE_TIME_MS = 60 * MINUTE_MS;

/** How often the device clock is re-read when nothing on screen depends on the second. */
const CLOCK_TICK_MS = MINUTE_MS;

/**
 * How often it is re-read while the cancellation panel is open: the free/late boundary is
 * `startsAt - 2 h`, and the sentence has to change as that instant passes (AAP 0.5.3).
 */
const CLOCK_FAST_TICK_MS = 1_000;

/**
 * How long a completed meetup stays eligible for day-plan ideas past its check-in window:
 * settlement runs at `startsAt + 45 min`, and the route serves a `completed` meetup for
 * `SUGGESTIONS_SETTLED_ELIGIBLE_HOURS` (24) hours after that (AAP 0.7.3).
 */
const SUGGESTIONS_ELIGIBLE_FOR_MS =
  CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS + SUGGESTIONS_SETTLED_ELIGIBLE_HOURS * HOUR_MS;

/**
 * The two waits this screen runs (AAP 0.3.2, AAP 0.5.4). `next_action` follows an authorization the
 * traveller just gave: Stripe holds the money, but the meetup changes only when the API processes
 * `payment_intent.amount_capturable_updated`. `hold_recovery` is `409 hold_pending` or
 * `503 payment_unavailable`, where Stripe's answer to a hold was lost and the API is recovering it
 * under its original key at a moment the client cannot know.
 */
type PollKind = 'next_action' | 'hold_recovery';

/** Each wait's interval, and how long it keeps asking before it gives up. */
const POLL_SPECS = {
  next_action: { intervalMs: 2_000, maxMs: 30_000 },
  hold_recovery: { intervalMs: 3_000, maxMs: 120_000 },
} satisfies Record<PollKind, { readonly intervalMs: number; readonly maxMs: number }>;

/** The recipient's two deposit controls, and the step that confirms a card (AAP 0.5.8). */
const ACCEPT_LABEL = 'Accept and lock';
const DECLINE_LABEL = 'Decline';
const CONFIRM_HOLD_LABEL = 'Confirm your card';

/** The cancellation controls (AAP 0.5.8). */
const CANCEL_LABEL = 'Cancel meetup';
const KEEP_LABEL = 'Keep meetup';

/** Every onward link's label (AAP 0.5.8). */
const CHECK_IN_LABEL = 'Check in';
const CHAT_LABEL = 'Chat';
const SUGGESTIONS_LABEL = 'Plan the day';
const DISPUTE_LABEL = 'Report a problem';
const CREDIT_LABEL = 'View Table Credit';

/** The read's two controls, its missing-meetup sentence, and its loading line. */
const TRY_AGAIN_LABEL = 'Try again';
const BACK_TO_MEETUPS_LABEL = 'Back to meetups';
const NOT_FOUND_MESSAGE = "This meetup isn't available.";
const LOADING = 'Loading…';

/**
 * What the screen says back to the traveller. Every line is neutral between the two framing variants
 * and states nothing the server did not just confirm (AAP 0.1.1, AAP 0.5.8).
 */
const LOCKED_NOTICE = 'Meetup locked.';
const HOLD_PLACED_NOTICE = 'Your card hold is placed.';
const HOLD_RECOVERY_NOTICE = "We're confirming your card hold…";
const CONFIRMATION_CANCELLED_NOTICE = 'Card confirmation was cancelled. You can try again.';
const SLOW_NOTICE = 'This is taking longer than usual. Pull to refresh or try again later.';
const DECLINED_NOTICE = 'Proposal declined.';
const CANCEL_FREE_NOTICE = 'Meetup cancelled. Your hold is released.';
const CANCEL_LATE_NOTICE = 'Meetup cancelled late. Your deposit hold is being captured.';

/** The two sentences the cancellation panel shows before anything is cancelled (AAP 0.5.3). */
const CANCEL_PLAIN_STATEMENT = 'Cancel this meetup? Both card holds will be released.';
const CANCEL_LATE_STATEMENT =
  'Cancelling now counts as a late cancellation: your deposit hold will be captured and your counterpart receives Table Credit.';

/** The settlement lines of AAP 0.5.8, identical for both variants. */
const RESULT_FORFEIT_TEXT =
  "Your deposit hold was captured because you didn't check in or cancelled late.";
const RESULT_CREDIT_TEXT =
  "Your counterpart didn't make it. You receive Table Credit equal to the deposit.";

/** Shown in the header while a report on the meetup is open (AAP 0.5.3). */
const DISPUTE_OPEN_TEXT = 'A problem report is open';

/**
 * The word each lifecycle value shows (AAP 0.5.3). `satisfies` fails the type check when a status
 * is added to the enum, rather than rendering it as a blank line.
 */
export const STATUS_TEXT = {
  proposed: 'Proposed',
  locked: 'Locked',
  declined: 'Declined',
  lapsed: 'Expired without a reply',
  cancelled: 'Cancelled',
  completed: 'Completed',
  forfeited: 'Forfeited',
  unattended: 'Nobody checked in',
  lock_lost: 'Card hold ended',
  no_fault: 'Closed with no deposit taken',
} satisfies Record<MeetupStatus, string>;

/** The caller's own card hold (AAP 0.3.2). Only the framing sentence varies between variants. */
export const HOLD_TEXT = {
  none: 'Your card hold: not started',
  pending: 'Your card hold: being confirmed',
  requires_action: 'Your card hold: waiting for your bank',
  held: 'Your card hold: held',
  failed: 'Your card hold: not placed',
  released: 'Your card hold: released',
  captured: 'Your card hold: captured',
  expired: 'Your card hold: ended',
  refunded: 'Your card hold: refunded',
} satisfies Record<HoldView, string>;

/**
 * What each final status that ends the meetup on its own says (AAP 0.5.3, AAP 0.5.8). A `forfeited`
 * meetup is worded per side where it is rendered, and a `lock_lost` one shows the shared notice.
 */
const RESULT_TEXT = {
  declined: 'This proposal was declined.',
  lapsed: 'This proposal expired before it was accepted.',
  cancelled: 'This meetup was cancelled.',
  completed: 'You both checked in. Your holds are released.',
  unattended: 'Neither of you checked in. Both holds are released.',
  no_fault: 'An operator closed this meetup. No deposit was taken.',
} satisfies Record<
  Exclude<MeetupStatus, 'proposed' | 'locked' | 'forfeited' | 'lock_lost'>,
  string
>;

// --- Pure helpers -------------------------------------------------------------------------------

/** The caller's own deposit of a meetup: the side `MeetupDto.role` names (AAP 0.5.4). */
function ownHoldOf(meetup: MeetupDto): HoldView {
  return meetup.role === 'initiator' ? meetup.initiatorHold : meetup.recipientHold;
}

/** The other side's deposit, which is what tells a won forfeit from a lost one (AAP 0.5.7). */
function counterpartHoldOf(meetup: MeetupDto): HoldView {
  return meetup.role === 'initiator' ? meetup.recipientHold : meetup.initiatorHold;
}

/**
 * The deposit as the copy prints it (AAP 0.5.7). `POST /meetups` accepts the three deposit levels
 * alone, so the guard narrows rather than covering a case a view can reach; a value outside them,
 * which no stored meetup holds, is printed in cents rather than throwing inside a render.
 */
export function depositText(cents: number): string {
  return isDepositLevel(cents) ? formatUsdWhole(cents) : `${cents} cents`;
}

/** The two forms an instant is rendered in, the second for a runtime without `dateStyle`. */
const CITY_FORMATS = [
  { dateStyle: 'medium', timeStyle: 'short' },
  { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
] as const satisfies readonly Intl.DateTimeFormatOptions[];

/**
 * Renders an instant in the venue city's zone (AAP 0.5.8). The zone is the city's, because the
 * meeting is at the venue: a device set to another zone must not show a time the venue and the
 * other traveller do not keep. A zone this runtime does not carry, and a style it does not
 * implement, both fall through to the device's own zone, which is named so a time is never
 * presented as the venue's when it is not. An unformattable value is returned as it arrived.
 */
export function formatInCity(iso: string, timeZone: string | undefined): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;

  if (timeZone !== undefined) {
    for (const format of CITY_FORMATS) {
      try {
        return new Intl.DateTimeFormat('en', { ...format, timeZone }).format(at);
      } catch {
        // An unsupported style or an unknown zone: try the next form, then the device's zone.
      }
    }
  }

  for (const format of CITY_FORMATS) {
    try {
      const rendered = new Intl.DateTimeFormat('en', format).format(at);
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return zone === undefined || zone === '' ? rendered : `${rendered} (${zone})`;
    } catch {
      // The next form.
    }
  }
  return iso;
}

/**
 * Whether a fresh payload answers what a poll was waiting for (AAP 0.3.2, AAP 0.5.4): a
 * `next_action` poll waits for the meetup to lock or for the caller's own hold to leave
 * `requires_action`, and a `hold_recovery` poll for that hold to leave `pending`.
 */
export function pollIsSatisfied(kind: PollKind, meetup: MeetupDto): boolean {
  const own = ownHoldOf(meetup);
  return kind === 'next_action'
    ? meetup.status === 'locked' || own !== 'requires_action'
    : own !== 'pending';
}

/**
 * What the meetup says about itself once it has settled (AAP 0.5.8), or null while it is still open
 * or when the result is worded elsewhere: a forfeit reads differently per side, and a won one shows
 * the Table Credit sentence with the credit notice instead.
 */
export function resultTextFor(meetup: MeetupDto): string | null {
  switch (meetup.status) {
    case 'proposed':
    case 'locked':
    case 'lock_lost':
      return null;
    case 'forfeited':
      return ownHoldOf(meetup) === 'captured' ? RESULT_FORFEIT_TEXT : null;
    default:
      return RESULT_TEXT[meetup.status];
  }
}

/** Whether this settlement went the viewer's way: the counterpart's hold was captured (AAP 0.5.7). */
export function wonTableCredit(meetup: MeetupDto): boolean {
  return (
    meetup.status === 'forfeited' &&
    ownHoldOf(meetup) === 'released' &&
    counterpartHoldOf(meetup) === 'captured'
  );
}

/** Whether a problem may still be reported (AAP 0.5.3): while locked, or inside the 24-hour window. */
export function disputeReportable(meetup: MeetupDto, now: number): boolean {
  if (meetup.status === 'locked') return true;
  if (
    meetup.status !== 'completed' &&
    meetup.status !== 'forfeited' &&
    meetup.status !== 'unattended'
  ) {
    return false;
  }
  return now <= Date.parse(meetup.startsAt) + DISPUTE_FILING_WINDOW_HOURS * HOUR_MS;
}

/** One onward link: its test handle, its label and the route it opens (AAP 0.5.8). */
export interface MeetupLink {
  readonly testID: string;
  readonly label: string;
  readonly href: string;
}

/**
 * The links this meetup offers, in reading order. Check-in is offered while the meetup is locked and
 * is not already the screen's primary control, so `meetup-check-in` exists exactly once; chat opens
 * once both seats are held; the day plan is served while locked or for 24 hours past a completion;
 * a report is offered where the filing window allows one and none is open. A start `Date` cannot
 * parse leaves the time-dependent links off, because the server — not this comparison — decides
 * what it will serve (AAP 0.5.3, AAP 0.5.8).
 */
export function onwardLinks(meetup: MeetupDto, now: number): readonly MeetupLink[] {
  const links: MeetupLink[] = [];
  const suggestionsUntil = Date.parse(meetup.startsAt) + SUGGESTIONS_ELIGIBLE_FOR_MS;

  if (meetup.status === 'locked' && meetup.nextAction !== 'check_in') {
    links.push({
      testID: 'meetup-check-in',
      label: CHECK_IN_LABEL,
      href: `/meetups/${meetup.id}/check-in`,
    });
  }
  if (meetup.status === 'locked' || meetup.status === 'completed') {
    links.push({ testID: 'meetup-chat', label: CHAT_LABEL, href: `/meetups/${meetup.id}/chat` });
  }
  if (meetup.status === 'locked' || (meetup.status === 'completed' && now <= suggestionsUntil)) {
    links.push({
      testID: 'meetup-suggestions',
      label: SUGGESTIONS_LABEL,
      href: `/meetups/${meetup.id}/suggestions`,
    });
  }
  if (!meetup.disputeOpen && disputeReportable(meetup, now)) {
    links.push({
      testID: 'meetup-dispute',
      label: DISPUTE_LABEL,
      href: `/meetups/${meetup.id}/dispute`,
    });
  }
  if (wonTableCredit(meetup)) {
    links.push({ testID: 'meetup-credit', label: CREDIT_LABEL, href: '/profile/credit' });
  }
  return links;
}

/**
 * Whether the device clock puts this cancellation past its free window (AAP 0.5.3): `lateCancelFrom`
 * is `startsAt - 2 h`, and a cancel exactly at that instant is still free, which is why the test is
 * `>` and not `>=`. A proposal that lapses was never locked, so cancelling it is free whatever the
 * clock says. The comparison only chooses the wording of the panel; the server decides the outcome.
 */
export function cancelIsLate(meetup: MeetupDto, now: number): boolean {
  return meetup.status === 'locked' && now > Date.parse(meetup.lateCancelFrom);
}

/** The code an error carries, or the one an unreadable answer reads as (AAP 0.5.4, AAP 0.11.1). */
function errorCodeOf(error: unknown): string {
  return isApiError(error) ? error.code : 'invalid_response';
}

// --- Views --------------------------------------------------------------------------------------

/**
 * The device clock, re-read on an interval (AAP 0.5.3): once when the screen mounts and then every
 * `intervalMs`. The server still decides every outcome; this value only chooses which sentence the
 * traveller reads before they press anything.
 */
function useDeviceClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);

  return now;
}

/**
 * The framing sentence of the deposit screens (AAP 0.1.1, AAP 0.5.7). It renders the viewer's own
 * variant's string with this meetup's amount, and nothing at all when the viewer has no assignment
 * yet or the amount is not an accepted deposit level: this screen invents no deposit copy.
 */
function DepositCopyLine({
  variant,
  depositCents,
}: {
  readonly variant: Variant | null;
  readonly depositCents: number;
}): ReactElement | null {
  if (variant === null || !isDepositLevel(depositCents)) return null;

  return (
    <Text testID="deposit-copy" style={styles.emphasis}>
      {depositCopy(variant, depositCents)}
    </Text>
  );
}

/**
 * The safety notice shown before every proposal and every lock (AAP 0.5.8, AAP 0.12.2): what the
 * hold is not, then the five tips as one list. It renders above the accept control, which the
 * reachability flows assert on every platform.
 */
function SafetyNotice(): ReactElement {
  return (
    <Card testID="safety-notice">
      <Text style={styles.body}>{SAFETY_NOTICE}</Text>
      <Text style={styles.emphasis}>{SAFETY_TIPS_TITLE}</Text>
      <View role="list" style={styles.tips}>
        {SAFETY_TIPS.map((tip) => (
          <View key={tip} role="listitem">
            <Text style={styles.muted}>{tip}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}

/**
 * The saved-card step of a deposit that failed or has to be retried (AAP 0.5.3): the framing line
 * and the safety notice stay in front of the traveller, then the card step. The card itself is
 * entered inside Stripe's own component and never reaches this screen's code (AAP 0.12.2); where
 * the build has no publishable key, `CardSetup` says so and disables its control rather than
 * pretending a card can be added (AAP 0.11.2).
 */
function CardRetryPanel({
  variant,
  depositCents,
  onCardDone,
}: {
  readonly variant: Variant | null;
  readonly depositCents: number;
  readonly onCardDone: (result: CardSetupResult) => void;
}): ReactElement {
  return (
    <View style={styles.block} testID="meetup-card-panel">
      <DepositCopyLine variant={variant} depositCents={depositCents} />
      <SafetyNotice />
      <CardSetup onDone={onCardDone} />
    </View>
  );
}

/**
 * The recipient's Accept and lock block, in the order the flow has to read: the framing line, the
 * safety notice, then the two controls, so the notice renders above `meetup-accept` (AAP 0.5.8).
 */
function AcceptActions({
  variant,
  depositCents,
  busy,
  onAccept,
  onDecline,
}: {
  readonly variant: Variant | null;
  readonly depositCents: number;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}): ReactElement {
  return (
    <View style={styles.block}>
      <DepositCopyLine variant={variant} depositCents={depositCents} />
      <SafetyNotice />
      <Button label={ACCEPT_LABEL} testID="meetup-accept" busy={busy} onPress={onAccept} />
      <Button
        label={DECLINE_LABEL}
        variant="secondary"
        testID="meetup-decline"
        disabled={busy}
        onPress={onDecline}
      />
    </View>
  );
}

/**
 * The two-step cancellation, inline because React Native Web's `Alert` cannot be relied on across
 * the three platforms (AAP 0.5.3). Past `lateCancelFrom` the panel states what a late cancellation
 * costs, with the framing line beside it; that boundary is the device clock's estimate, and the
 * notice shown afterwards quotes the server's own answer instead (AAP 0.5.8).
 */
function CancelPanel({
  late,
  variant,
  depositCents,
  busy,
  onConfirm,
  onKeep,
}: {
  readonly late: boolean;
  readonly variant: Variant | null;
  readonly depositCents: number;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onKeep: () => void;
}): ReactElement {
  return (
    <Card testID="meetup-cancel-panel">
      <Text style={styles.body}>{late ? CANCEL_LATE_STATEMENT : CANCEL_PLAIN_STATEMENT}</Text>
      {late ? <DepositCopyLine variant={variant} depositCents={depositCents} /> : null}
      <Button
        label={CANCEL_LABEL}
        variant="danger"
        testID="meetup-cancel-confirm"
        busy={busy}
        onPress={onConfirm}
      />
      <Button
        label={KEEP_LABEL}
        variant="secondary"
        testID="meetup-cancel-keep"
        disabled={busy}
        onPress={onKeep}
      />
    </Card>
  );
}

/** What happened to the money, once it is settled (AAP 0.5.8), in the neutral voice both share. */
function ResultBlock({ meetup }: { readonly meetup: MeetupDto }): ReactElement | null {
  const result = resultTextFor(meetup);
  const credit = wonTableCredit(meetup);
  if (result === null && !credit) return null;

  return (
    <Card testID="meetup-result">
      {result === null ? null : <Text style={styles.body}>{result}</Text>}
      {credit ? (
        <>
          <Text style={styles.body}>{RESULT_CREDIT_TEXT}</Text>
          <Text style={styles.muted}>{TABLE_CREDIT_NOTICE}</Text>
        </>
      ) : null}
    </Card>
  );
}

/**
 * Where this meetup leads next (AAP 0.5.8). Each row is one link whose visible label is its
 * accessible name, at the minimum touch target, and each is offered only where the route would
 * serve it.
 */
function OnwardLinks({
  meetup,
  now,
}: {
  readonly meetup: MeetupDto;
  readonly now: number;
}): ReactElement | null {
  const links = onwardLinks(meetup, now);
  if (links.length === 0) return null;

  return (
    <View style={styles.block}>
      {links.map((link) => (
        <ListItem
          key={link.testID}
          testID={link.testID}
          role="link"
          label={link.label}
          onPress={() => router.push(link.href)}
        />
      ))}
    </View>
  );
}

/**
 * The row that names the other traveller. Nothing here is filtered or guessed: a field this payload
 * does not carry is a field the API did not release at the viewer's tier, and the photo is asked
 * for only where the payload reported one (AAP 0.3.2, AAP 0.5.4, criterion 5).
 */
function CounterpartRow({ counterpart }: { readonly counterpart: AnyTierProfile }): ReactElement {
  const nickname = 'nickname' in counterpart ? counterpart.nickname : null;
  const hasPhoto = 'hasPhoto' in counterpart && counterpart.hasPhoto;

  return (
    <ListItem
      testID="meetup-counterpart"
      role="link"
      label={`@${counterpart.handle}`}
      {...(nickname === null || nickname === '' ? {} : { subtitle: nickname })}
      leading={
        <Avatar
          avatarSeed={counterpart.avatarSeed}
          handle={counterpart.handle}
          decorative
          {...(hasPhoto ? { userId: counterpart.id, hasPhoto: true } : {})}
        />
      }
      onPress={() => router.push(`/users/${counterpart.id}`)}
    />
  );
}

/**
 * The one control this meetup offers the caller, by `nextAction` (AAP 0.5.4). `accept` is the
 * recipient's block; `confirm_hold` repeats the caller's own accept or hold, which is how a
 * traveller who left during 3-D Secure finishes it, because a `MeetupDto` carries no client secret;
 * `retry_hold` is the saved-card step, which a failed hold also opens through `cardPanel`; and
 * `check_in` is the way to the venue's code. The saved-card panel replaces the action block rather
 * than joining it, so one deposit step renders one `deposit-copy` and one `safety-notice`.
 */
function PrimaryAction({
  meetup,
  variant,
  busy,
  cardPanel,
  onAccept,
  onDecline,
  onDepositStep,
  onCardDone,
}: {
  readonly meetup: MeetupDto;
  readonly variant: Variant | null;
  readonly busy: boolean;
  readonly cardPanel: boolean;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
  readonly onDepositStep: () => void;
  readonly onCardDone: (result: CardSetupResult) => void;
}): ReactElement | null {
  if (cardPanel || meetup.nextAction === 'retry_hold') {
    return (
      <CardRetryPanel
        variant={variant}
        depositCents={meetup.depositCents}
        onCardDone={onCardDone}
      />
    );
  }

  switch (meetup.nextAction) {
    case 'accept':
      // `accept` is the recipient's step: the route answers `403 not_recipient` to the initiator.
      return meetup.role === 'recipient' && meetup.status === 'proposed' ? (
        <AcceptActions
          variant={variant}
          depositCents={meetup.depositCents}
          busy={busy}
          onAccept={onAccept}
          onDecline={onDecline}
        />
      ) : null;
    case 'confirm_hold':
      return (
        <Button
          label={CONFIRM_HOLD_LABEL}
          testID="meetup-confirm-hold"
          busy={busy}
          onPress={onDepositStep}
        />
      );
    case 'check_in':
      return (
        <Button
          label={CHECK_IN_LABEL}
          testID="meetup-check-in"
          onPress={() => router.push(`/meetups/${meetup.id}/check-in`)}
        />
      );
    case 'none':
      return null;
    default:
      // `retry_hold` is answered by the saved-card panel above.
      return null;
  }
}

// --- The screen ---------------------------------------------------------------------------------

/** A sentence the screen shows above its content, with the tone it is shown in. */
interface Notice {
  readonly message: string;
  readonly tone: BannerTone;
}

/**
 * The meetup detail screen: where the meetup stands, who it is with, and the one deposit step the
 * caller has — the recipient's Accept and lock, the initiator's hold retry, or nothing but the way
 * on to the venue.
 *
 * `GET /meetups/:id` is read from here alone. On the recipient's first read the API records
 * `recipientViewedAt` and emits `proposal_viewed`, which is a funnel step, so this read is never
 * prefetched from anywhere else (AAP 0.5.4, AAP 0.5.7).
 *
 * @returns The meetup screen for the route's id.
 */
export default function MeetupDetailScreen(): ReactElement {
  const params = useLocalSearchParams<{ id: string }>();
  const meetupId = typeof params.id === 'string' ? params.id : '';

  const meetupQ = useMeetup(meetupId);
  const meQ = useMe();
  // A public read that changes only when the pilot adds a city, so one answer an hour serves the
  // venue's timezone; its failure costs the city-local time and nothing else.
  const citiesQ = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    staleTime: CITIES_STALE_TIME_MS,
  });

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cardPanel, setCardPanel] = useState(false);
  const [poll, setPoll] = useState<PollKind | null>(null);
  const inFlight = useRef(false);

  // A second's resolution only while the cancellation panel is open, where a free cancellation
  // becomes a forfeit to the second; a minute serves every other line here (AAP 0.5.3).
  const now = useDeviceClock(cancelConfirm ? CLOCK_FAST_TICK_MS : CLOCK_TICK_MS);

  const meetup = meetupQ.data;
  const variant = meQ.data?.variant ?? null;

  // A poll asks the API again on an interval and stops as soon as the fresh payload answers what it
  // was waiting for. Its answer is fetched through the cache, so the screen re-renders with the
  // server's own serialization, and no staleness is allowed to stand in for the request itself.
  useEffect(() => {
    if (poll === null || meetupId === '') return;

    const spec = POLL_SPECS[poll];
    let live = true;

    const tick = (): void => {
      void (async () => {
        try {
          const fresh = await queryClient.fetchQuery<MeetupDto>({
            queryKey: queryKeys.meetup(meetupId),
            queryFn: () => apiClient.getMeetup(meetupId),
            staleTime: 0,
          });
          if (live && pollIsSatisfied(poll, fresh)) setPoll(null);
        } catch {
          // A failed poll leaves the next tick as its retry and the next payload as its answer.
        }
      })();
    };

    const interval = setInterval(tick, spec.intervalMs);
    const deadline = setTimeout(() => {
      if (!live) return;
      setPoll(null);
      setNotice({ message: SLOW_NOTICE, tone: 'info' });
      announce(SLOW_NOTICE);
    }, spec.maxMs);

    return () => {
      live = false;
      clearInterval(interval);
      clearTimeout(deadline);
    };
  }, [meetupId, poll]);

  const notFound = meetupQ.isError && errorCodeOf(meetupQ.error) === 'meetup_not_found';
  const readErrorMessage =
    meetupQ.isError && !notFound ? userMessageFor(errorCodeOf(meetupQ.error)) : null;

  // iOS has no live region to speak a banner and Android's own does not cover one already mounted,
  // so the read's failure is announced as well as shown (AAP 0.5.8).
  useEffect(() => {
    if (notFound) {
      announce(NOT_FOUND_MESSAGE);
      return;
    }
    if (readErrorMessage !== null) announce(readErrorMessage);
  }, [notFound, readErrorMessage]);

  /** Shows a refusal's own sentence, visibly and to a screen reader (AAP 0.5.8). */
  function showError(code: string): void {
    const message = userMessageFor(code);
    setErrorMessage(message);
    announce(message);
  }

  /** Shows a status sentence, visibly and to a screen reader (AAP 0.5.8). */
  function showNotice(message: string, tone: BannerTone = 'info'): void {
    setNotice({ message, tone });
    announce(message);
  }

  /** Refetches this meetup and every list that may hold it (AAP 0.5.4). */
  async function reloadMeetup(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll });
  }

  /**
   * Runs the challenge a hold is waiting on, then waits for the API to say what changed
   * (AAP 0.3.4). The secret is a parameter on purpose: it never becomes state, never enters the
   * query cache, never reaches storage and is never logged (AAP 0.5.4).
   */
  async function completeChallenge(clientSecret: string): Promise<void> {
    const result = await completeNextAction(clientSecret);
    if (result.status === 'succeeded') {
      // Stripe holds the authorization; the meetup changes only when the API processes the webhook,
      // so the screen asks again rather than assuming the lock (AAP 0.3.3).
      showNotice(HOLD_RECOVERY_NOTICE);
      setPoll('next_action');
      return;
    }
    if (result.status === 'cancelled') {
      showNotice(CONFIRMATION_CANCELLED_NOTICE);
      return;
    }
    showError('hold_failed');
  }

  /** Turns a refused accept or hold into what the screen shows (AAP 0.3.2, AAP 0.5.4). */
  function handleDepositFailure(error: unknown): void {
    const code = errorCodeOf(error);
    switch (code) {
      case 'hold_failed':
        // The meetup is unchanged and the retry is allowed, so the saved-card step takes the place
        // of the control that just failed (AAP 0.5.3).
        showError(code);
        setCardPanel(true);
        return;
      case 'hold_pending':
      case 'payment_unavailable':
        // Stripe's answer was lost and the API is recovering it under its original key: this side's
        // hold reads `pending` until it has, and no new card is needed to recover.
        showNotice(HOLD_RECOVERY_NOTICE);
        setPoll('hold_recovery');
        return;
      case 'proposal_lapsed':
      case 'not_proposed':
      case 'not_recipient':
      case 'not_initiator':
        showError(code);
        void reloadMeetup();
        return;
      default:
        showError(code);
    }
  }

  /**
   * Runs one step of the screen under the guard every step shares: one at a time, `busy` while it
   * runs, the previous outcome cleared as it starts, and a refusal turned into what the screen shows
   * by the caller's own handler. `busy` and the single-flight ref are separate locks on purpose —
   * the ref stops a second press reaching the API, and `busy` shows the first one running.
   */
  async function runStep(
    step: () => Promise<void>,
    onFailure: (error: unknown) => void = handleDepositFailure,
  ): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErrorMessage(null);
    setNotice(null);

    try {
      await step();
    } catch (error) {
      onFailure(error);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** The recipient locks their own hold (AAP 0.5.4). */
  async function runAccept(): Promise<void> {
    await runStep(async () => {
      setCardPanel(false);
      const answer = await apiClient.acceptMeetup(meetupId);
      if (answer.status === 'locked') {
        showNotice(LOCKED_NOTICE, 'success');
      } else {
        // 3-D Secure is pending: the hold authorizes once the traveller has answered the bank.
        await completeChallenge(answer.clientSecret);
      }
      await reloadMeetup();
    });
  }

  /** The initiator retries their own hold, which only this side may do (AAP 0.5.4). */
  async function runHold(): Promise<void> {
    await runStep(async () => {
      setCardPanel(false);
      const answer = await apiClient.retryHold(meetupId);
      switch (answer.initiatorHold) {
        case 'requires_action':
          await completeChallenge(answer.clientSecret);
          break;
        case 'pending':
          showNotice(HOLD_RECOVERY_NOTICE);
          setPoll('hold_recovery');
          break;
        case 'failed':
          showError('hold_failed');
          setCardPanel(true);
          break;
        case 'held':
          // The proposal becomes visible to the recipient at this moment, with the deadline the
          // fresh read below then renders (AAP 0.5.3).
          showNotice(HOLD_PLACED_NOTICE, 'success');
          break;
        default:
          // Every other value is answered by that same fresh read.
          break;
      }
      await reloadMeetup();
    });
  }

  /** Runs the deposit step the caller's own side owns (AAP 0.5.4). */
  function runDepositStep(): void {
    if (meetup === undefined) return;
    void (meetup.role === 'recipient' ? runAccept() : runHold());
  }

  /** The recipient refuses a proposal (AAP 0.5.4). */
  async function runDecline(): Promise<void> {
    await runStep(async () => {
      await apiClient.declineMeetup(meetupId);
      showNotice(DECLINED_NOTICE);
      await reloadMeetup();
    });
  }

  /**
   * Cancels the meetup: free at or before `startsAt - 2 h`, a forfeit after it (AAP 0.5.3). Which of
   * the two happened is the server's answer — `CancelResponse.lateCancel` is what the notice quotes,
   * never the device clock's estimate that chose the words of the panel.
   */
  async function runCancel(): Promise<void> {
    await runStep(
      async () => {
        const answer = await apiClient.cancelMeetup(meetupId);
        showNotice(
          answer.lateCancel ? CANCEL_LATE_NOTICE : CANCEL_FREE_NOTICE,
          answer.lateCancel ? 'warning' : 'info',
        );
        setCancelConfirm(false);
        await reloadMeetup();
        // A forfeit moves the counterpart's Table Credit balance and this traveller's counters.
        await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      },
      (error) => {
        showError(errorCodeOf(error));
        void reloadMeetup();
      },
    );
  }

  /**
   * Called once the saved-card step ends (AAP 0.5.3). The API learns of a saved card from the
   * `setup_intent.succeeded` webhook, so the hold is retried here rather than assumed: only `saved`
   * runs the deposit step again, and a failure has already been shown by the step itself.
   */
  function handleCardDone(result: CardSetupResult): void {
    if (result.status !== 'saved') return;
    setCardPanel(false);
    runDepositStep();
  }

  const cityZone = citiesQ.data?.items.find((city) => city.id === meetup?.venue.cityId)?.timezone;
  const ownHold = meetup === undefined ? null : ownHoldOf(meetup);
  const lockLostOwnHold = ownHold === 'captured' || ownHold === 'refunded';
  const cancelable =
    meetup !== undefined && (meetup.status === 'proposed' || meetup.status === 'locked');
  const late = meetup !== undefined && cancelIsLate(meetup, now);
  const respondBy =
    meetup !== undefined && meetup.status === 'proposed' && meetup.recipientDeadline !== null
      ? `Respond by ${formatInCity(meetup.recipientDeadline, cityZone)}`
      : null;

  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Screen edges={SCREEN_EDGES} testID="meetup-detail">
        {/* The notices come first, so the live region stands at the top of the reading order. */}
        {errorMessage === null ? null : (
          <Banner tone="error" message={errorMessage} testID="meetup-error" />
        )}
        {notice === null ? null : (
          <Banner tone={notice.tone} message={notice.message} testID="meetup-notice" />
        )}

        {meetupQ.isPending ? <Text style={styles.muted}>{LOADING}</Text> : null}

        {notFound ? (
          <Card testID="meetup-not-found">
            <Text style={styles.body}>{NOT_FOUND_MESSAGE}</Text>
            <Button
              label={BACK_TO_MEETUPS_LABEL}
              variant="secondary"
              testID="meetup-back"
              onPress={() => router.push('/meetups')}
            />
          </Card>
        ) : null}

        {readErrorMessage === null ? null : (
          <Banner
            tone="error"
            message={readErrorMessage}
            action={{
              label: TRY_AGAIN_LABEL,
              onPress: () => {
                void meetupQ.refetch();
              },
              testID: 'meetup-retry',
            }}
            testID="meetup-read-error"
          />
        )}

        {meetup === undefined ? null : (
          <>
            {/* Where it stands, then who it is with, then the terms of the hold: the order AAP
                0.5.8 sets, each block a surface of its own. */}
            <Card testID="meetup-summary">
              <Text testID="meetup-status" style={styles.status}>
                {STATUS_TEXT[meetup.status]}
              </Text>
            </Card>

            <CounterpartRow counterpart={meetup.counterpart} />

            <Card testID="meetup-terms">
              <Text style={styles.venue}>{meetup.venue.name}</Text>
              <Text style={styles.muted}>{meetup.venue.address}</Text>
              <Text style={styles.muted}>{formatInCity(meetup.startsAt, cityZone)}</Text>
              <Text style={styles.muted}>{depositText(meetup.depositCents)}</Text>
              {respondBy === null ? null : <Text style={styles.muted}>{respondBy}</Text>}
              <Text style={styles.muted}>{HOLD_TEXT[ownHoldOf(meetup)]}</Text>
              {meetup.disputeOpen ? <Text style={styles.muted}>{DISPUTE_OPEN_TEXT}</Text> : null}
            </Card>

            {meetup.status === 'lock_lost' ? (
              <Banner
                tone="info"
                title={STATUS_TEXT.lock_lost}
                message={lockLostOwnHold ? LOCK_LOST_COPY.refunded : LOCK_LOST_COPY.released}
                testID="lock-lost-notice"
              />
            ) : null}

            <PrimaryAction
              meetup={meetup}
              variant={variant}
              busy={busy}
              cardPanel={cardPanel}
              onAccept={() => {
                void runAccept();
              }}
              onDecline={() => {
                void runDecline();
              }}
              onDepositStep={runDepositStep}
              onCardDone={handleCardDone}
            />

            {cancelable ? (
              cancelConfirm ? (
                <CancelPanel
                  late={late}
                  variant={variant}
                  depositCents={meetup.depositCents}
                  busy={busy}
                  onConfirm={() => {
                    void runCancel();
                  }}
                  onKeep={() => setCancelConfirm(false)}
                />
              ) : (
                <Button
                  label={CANCEL_LABEL}
                  variant="secondary"
                  testID="meetup-cancel"
                  disabled={busy}
                  onPress={() => setCancelConfirm(true)}
                />
              )
            ) : null}

            <ResultBlock meetup={meetup} />
            <OnwardLinks meetup={meetup} now={now} />
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  // The column every action and link block stacks in; the screen's own gap separates the blocks.
  block: { gap: spacing.md },
  // The status word, one step above body text: `text` on the page background, 17.21:1.
  status: {
    color: colors.text,
    fontSize: typography.title.fontSize,
    lineHeight: typography.title.lineHeight,
    fontWeight: fontWeights.bold,
  },
  venue: {
    color: colors.text,
    fontSize: typography.label.fontSize,
    lineHeight: typography.label.lineHeight,
    fontWeight: fontWeights.medium,
  },
  // The framing sentence, and the safety notice's heading: bold label type in the `text` pair.
  emphasis: {
    color: colors.text,
    fontSize: typography.label.fontSize,
    lineHeight: typography.label.lineHeight,
    fontWeight: fontWeights.bold,
  },
  body: {
    color: colors.text,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
  // Secondary information — the address, the terms, the tips — in the muted pair (7.07:1).
  muted: {
    color: colors.textMuted,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
  tips: { gap: spacing.xs },
});
