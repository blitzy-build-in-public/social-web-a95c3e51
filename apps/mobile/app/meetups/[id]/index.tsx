/** The meetup detail screen: Accept and lock, the card-hold retry, cancellation, the settlement result, and the ways on to check-in, chat, the day plan and a report. */
import { useEffect, useRef, useState, type ComponentProps, type ReactElement } from 'react';
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
import { serverNow } from '../../../src/api/server-clock';
import {
  BOTH_CHECKED_IN_NOTICE,
  CHECKED_IN_NOTICE,
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

const SCREEN_TITLE = 'Meetup';
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;
const CITIES_STALE_TIME_MS = 60 * MINUTE_MS;
const CLOCK_FAST_TICK_MS = 1_000;
const SUGGESTIONS_ELIGIBLE_FOR_MS =
  CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS + SUGGESTIONS_SETTLED_ELIGIBLE_HOURS * HOUR_MS;
type PollKind = 'next_action' | 'hold_recovery';
const POLL_SPECS = {
  next_action: { intervalMs: 2_000, maxMs: 30_000 },
  hold_recovery: { intervalMs: 3_000, maxMs: 120_000 },
} satisfies Record<PollKind, { readonly intervalMs: number; readonly maxMs: number }>;

const styles = StyleSheet.create({
  block: { gap: spacing.md },
  status: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  venue: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  emphasis: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.textMuted },
  tips: { gap: spacing.xs },
});

const STATUS_LINE = { testID: 'meetup-status', style: styles.status };
const COPY = {
  accept: 'Accept and lock',
  decline: 'Decline',
  checkIn: 'Check in',
  chat: 'Chat',
  dayPlan: 'Plan the day',
  dispute: 'Report a problem',
  credit: 'View Table Credit',
  missing: "This meetup isn't available.",
  locked: 'Meetup locked.',
  holdPlaced: 'Your card hold is placed.',
  holdRecovery: "We're confirming your card hold…",
  confirmationCancelled: 'Card confirmation was cancelled. You can try again.',
  slow: 'This is taking longer than usual. Pull to refresh or try again later.',
  cancelFree: 'Meetup cancelled. Your hold is released.',
  cancelLate: 'Meetup cancelled late. Your deposit hold is being captured.',
  cancelPlain: 'Cancel this meetup? Both card holds will be released.',
  cancelLateStatement:
    'Cancelling now counts as a late cancellation: your deposit hold will be captured and your counterpart receives Table Credit.',
  resultForfeit: "Your deposit hold was captured because you didn't check in or cancelled late.",
  resultCredit: "Your counterpart didn't make it. You receive Table Credit equal to the deposit.",
  counterpartCheckedIn: (handle: string): string => `@${handle} is checked in.`,
  counterpartPending: (handle: string): string => `Waiting for @${handle} to check in.`,
  disputeOpen: 'A problem report is open',
} as const;
const CANCEL_CONFIRM = { label: 'Cancel meetup', variant: 'danger' as const };
const CANCEL_BUTTON = { ...CANCEL_CONFIRM, testID: 'meetup-cancel-confirm' };
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
const INFO_TONE = { tone: 'info' as const };
const ERROR_BANNER = { tone: 'error' as const, testID: 'meetup-error' };
const READ_ERROR = { tone: 'error' as const, testID: 'meetup-read-error' };
const LOCK_LOST = { ...INFO_TONE, title: STATUS_TEXT.lock_lost, testID: 'lock-lost-notice' };
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
type ResultStatus = Exclude<MeetupStatus, 'proposed' | 'locked' | 'forfeited' | 'lock_lost'>;
const RESULT_TEXT = {
  declined: 'This proposal was declined.',
  lapsed: 'This proposal expired before it was accepted.',
  cancelled: 'This meetup was cancelled.',
  completed: 'You both checked in. Your holds are released.',
  unattended: 'Neither of you checked in. Both holds are released.',
  no_fault: 'An operator closed this meetup. No deposit was taken.',
} satisfies Record<ResultStatus, string>;
const ownHoldOf = (meetup: MeetupDto): HoldView =>
  meetup.role === 'initiator' ? meetup.initiatorHold : meetup.recipientHold;
const counterpartHoldOf = (meetup: MeetupDto): HoldView =>
  meetup.role === 'initiator' ? meetup.recipientHold : meetup.initiatorHold;
export const depositText = (cents: number): string =>
  isDepositLevel(cents) ? formatUsdWhole(cents) : `${cents} cents`;
const CITY_FORMATS = [
  { dateStyle: 'medium', timeStyle: 'short' },
  { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
] as const satisfies readonly Intl.DateTimeFormatOptions[];
/**
 * Formats a meetup instant the way this screen shows it: in the venue's zone and labelled with that
 * zone, or -- while the city is not known yet -- in the device's zone, labelled with the same zone.
 * The label is what stops a traveler reading a venue-local time as their own.
 *
 * @param iso - The instant to show, as an ISO 8601 timestamp from the API.
 * @param timeZone - The venue city's IANA zone, or nothing while `GET /cities` has not answered.
 * @returns The labelled instant, or `iso` when it cannot be parsed or no zone renders.
 */
export function formatInCity(iso: string, timeZone: string | undefined): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const suffix = zone === undefined || zone === '' ? '' : ` (${zone})`;
  const render = (options: Intl.DateTimeFormatOptions, tail: string): string | null => {
    for (const format of CITY_FORMATS) {
      try {
        return `${new Intl.DateTimeFormat('en', { ...format, ...options }).format(at)}${tail}`;
      } catch {}
    }
    return null;
  };
  const named =
    timeZone === undefined || timeZone === '' ? null : render({ timeZone }, ` (${timeZone})`);
  return named ?? render({}, suffix) ?? iso;
}
export function pollIsSatisfied(kind: PollKind, meetup: MeetupDto): boolean {
  const own = ownHoldOf(meetup);
  return kind === 'next_action'
    ? meetup.status === 'locked' || own !== 'requires_action'
    : own !== 'pending';
}
export const resultTextFor = (meetup: MeetupDto): string | null => {
  const { status } = meetup;
  if (status === 'proposed' || status === 'locked' || status === 'lock_lost') return null;
  if (status === 'forfeited') return ownHoldOf(meetup) === 'captured' ? COPY.resultForfeit : null;
  return RESULT_TEXT[status];
};
export const wonTableCredit = (meetup: MeetupDto): boolean =>
  meetup.status === 'forfeited' &&
  ownHoldOf(meetup) === 'released' &&
  counterpartHoldOf(meetup) === 'captured';
export const disputeReportable = (meetup: MeetupDto, now: number): boolean => {
  const { status } = meetup;
  if (status === 'locked') return true;
  if (status !== 'completed' && status !== 'forfeited' && status !== 'unattended') return false;
  return now <= Date.parse(meetup.startsAt) + DISPUTE_FILING_WINDOW_HOURS * HOUR_MS;
};
/** One line about the counterpart's check-in, and the testID a check reads it by. */
export type CheckInSignal = { readonly testID: string; readonly text: string };

/**
 * The counterpart's check-in as the summary card states it, or null when the card has nothing to add.
 *
 * Both attendees read the same two facts off the meetup (AAP 0.5.4, 0.5.7), so the sentence names
 * whichever side is missing: the counterpart's once they are in, the wait once the caller is and
 * they are not, and the shared pair notice once both are. A final status states nothing here,
 * because the result card below already explains the outcome.
 */
export function counterpartCheckInSignal(meetup: MeetupDto): CheckInSignal | null {
  if (meetup.status !== 'locked') return null;
  const { handle } = meetup.counterpart;
  if (meetup.checkedIn && meetup.counterpartCheckedIn) {
    return { testID: 'meetup-both-checked-in', text: BOTH_CHECKED_IN_NOTICE };
  }
  if (meetup.counterpartCheckedIn) {
    return { testID: 'meetup-counterpart-checked-in', text: COPY.counterpartCheckedIn(handle) };
  }
  if (meetup.checkedIn) {
    return { testID: 'meetup-counterpart-pending', text: COPY.counterpartPending(handle) };
  }
  return null;
}
export type MeetupLink = { readonly testID: string; readonly label: string; readonly href: string };
const link = (testID: string, label: string, href: string): MeetupLink => ({ testID, label, href });
export function onwardLinks(meetup: MeetupDto, now: number): readonly MeetupLink[] {
  const { id, status, nextAction, disputeOpen, checkedIn } = meetup;
  const until = Date.parse(meetup.startsAt) + SUGGESTIONS_ELIGIBLE_FOR_MS;
  const checkIn = status === 'locked' && !checkedIn && nextAction !== 'check_in';
  const chat = status === 'locked' || status === 'completed';
  const plan = status === 'locked' || (status === 'completed' && now <= until);
  const links: MeetupLink[] = [];
  if (checkIn) links.push(link('meetup-check-in', COPY.checkIn, `/meetups/${id}/check-in`));
  if (chat) links.push(link('meetup-chat', COPY.chat, `/meetups/${id}/chat`));
  if (plan) links.push(link('meetup-suggestions', COPY.dayPlan, `/meetups/${id}/suggestions`));
  if (!disputeOpen && disputeReportable(meetup, now)) {
    links.push(link('meetup-dispute', COPY.dispute, `/meetups/${id}/dispute`));
  }
  if (wonTableCredit(meetup)) links.push(link('meetup-credit', COPY.credit, '/profile/credit'));
  return links;
}
/** A cancel exactly at `lateCancelFrom` is still free: the test is `>` and not `>=`. */
export const cancelIsLate = (meetup: MeetupDto, now: number): boolean =>
  meetup.status === 'locked' && now > Date.parse(meetup.lateCancelFrom);
const errorCodeOf = (error: unknown): string =>
  isApiError(error) ? error.code : 'invalid_response';
/**
 * The instant this screen compares its time-dependent terms against (AAP 0.5.3). The
 * late-cancellation boundary and the dispute-filing window are the API's decisions, so the instant
 * they are compared with here is the server's, re-estimated from each response's `Date` header
 * (AAP 0.3.2, 0.5.1).
 *
 * The tick only re-renders the screen; the reading itself comes from `serverNow()` at every render,
 * so an offset a response records after this screen mounted takes effect at once and a device clock
 * that is hours out cannot move either statement. Before any response has been read the offset is
 * zero and `serverNow()` answers the device clock.
 */
function useServerClock(intervalMs: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return serverNow();
}
type DepositProps = { readonly variant: Variant | null; readonly depositCents: number };
type BusyProps = DepositProps & { readonly busy: boolean };
const DEPOSIT_LINE = { testID: 'deposit-copy', style: styles.emphasis };
function DepositCopyLine({ variant, depositCents }: DepositProps): ReactElement | null {
  if (variant === null || !isDepositLevel(depositCents)) return null;
  return <Text {...DEPOSIT_LINE}>{depositCopy(variant, depositCents)}</Text>;
}
const tipItem = (tip: string): ReactElement => (
  <View key={tip} role="listitem" children={<Text style={styles.muted}>{tip}</Text>} />
);
const SafetyNotice = (): ReactElement => (
  <Card testID="safety-notice">
    <Text style={styles.body}>{SAFETY_NOTICE}</Text>
    <Text style={styles.emphasis}>{SAFETY_TIPS_TITLE}</Text>
    <View role="list" style={styles.tips}>
      {SAFETY_TIPS.map(tipItem)}
    </View>
  </Card>
);
type CardRetryProps = DepositProps & { readonly onCardDone: (result: CardSetupResult) => void };
const CardRetryPanel = (props: CardRetryProps): ReactElement => (
  <View style={styles.block} testID="meetup-card-panel">
    <DepositCopyLine variant={props.variant} depositCents={props.depositCents} />
    <SafetyNotice />
    <CardSetup onDone={props.onCardDone} />
  </View>
);
type AcceptProps = BusyProps & { readonly onAccept: () => void; readonly onDecline: () => void };
const DECLINE = { label: COPY.decline, variant: 'secondary' as const, testID: 'meetup-decline' };
const AcceptActions = (props: AcceptProps): ReactElement => (
  <View style={styles.block}>
    <DepositCopyLine variant={props.variant} depositCents={props.depositCents} />
    <SafetyNotice />
    <Button label={COPY.accept} testID="meetup-accept" busy={props.busy} onPress={props.onAccept} />
    <Button {...DECLINE} disabled={props.busy} onPress={props.onDecline} />
  </View>
);
type CancelBase = BusyProps & { readonly late: boolean };
type CancelPanelProps = CancelBase & { readonly confirm: () => void; readonly keep: () => void };
const KEEP = { label: 'Keep meetup', variant: 'secondary' as const };
const CancelPanel = (props: CancelPanelProps): ReactElement => (
  <Card testID="meetup-cancel-panel">
    <Text style={styles.body}>{props.late ? COPY.cancelLateStatement : COPY.cancelPlain}</Text>
    {props.late && <DepositCopyLine variant={props.variant} depositCents={props.depositCents} />}
    <Button {...CANCEL_BUTTON} busy={props.busy} onPress={props.confirm} />
    <Button {...KEEP} testID="meetup-cancel-keep" disabled={props.busy} onPress={props.keep} />
  </Card>
);
function linkRow({ testID, label, href }: MeetupLink): ComponentProps<typeof ListItem> {
  return { testID, label, role: 'link', onPress: () => router.push(href) };
}
function counterpartRow(counterpart: AnyTierProfile): ComponentProps<typeof ListItem> {
  const { id, handle, avatarSeed } = counterpart;
  const nickname = 'nickname' in counterpart ? counterpart.nickname : null;
  const photo =
    'hasPhoto' in counterpart && counterpart.hasPhoto ? { userId: id, hasPhoto: true } : {};
  return {
    testID: 'meetup-counterpart',
    role: 'link' as const,
    label: `@${handle}`,
    ...(nickname === null || nickname === '' ? {} : { subtitle: nickname }),
    leading: <Avatar avatarSeed={avatarSeed} handle={handle} decorative {...photo} />,
    onPress: () => router.push(`/users/${id}`),
  };
}
const CONFIRM_HOLD = { label: 'Confirm your card', testID: 'meetup-confirm-hold' } as const;
type PrimaryProps = AcceptProps & { readonly meetup: MeetupDto; readonly cardPanel: boolean } & {
  readonly onDepositStep: () => void;
  readonly onCardDone: (result: CardSetupResult) => void;
};
function PrimaryAction(props: PrimaryProps): ReactElement | null {
  const { meetup, variant, busy, cardPanel, onAccept, onDecline, onDepositStep, onCardDone } =
    props;
  const { id, nextAction, role, status } = meetup;
  const depositCents = props.depositCents;
  const accept = { variant, depositCents, busy, onAccept, onDecline };
  const checkIn = () => void router.push(`/meetups/${id}/check-in`);
  if (cardPanel || nextAction === 'retry_hold') {
    return <CardRetryPanel variant={variant} depositCents={depositCents} onCardDone={onCardDone} />;
  }
  switch (nextAction) {
    case 'accept':
      return role === 'recipient' && status === 'proposed' ? <AcceptActions {...accept} /> : null;
    case 'confirm_hold':
      return <Button {...CONFIRM_HOLD} busy={busy} onPress={onDepositStep} />;
    case 'check_in':
      return <Button label={COPY.checkIn} testID="meetup-check-in" onPress={checkIn} />;
    case 'none':
    default:
      return null;
  }
}
type Notice = { readonly message: string; readonly tone: BannerTone };
export default function MeetupDetailScreen(): ReactElement {
  const params = useLocalSearchParams<{ id: string }>();
  const meetupId = typeof params.id === 'string' ? params.id : '';
  const meetupQ = useMeetup(meetupId);
  const meQ = useMe();
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
  const now = useServerClock(cancelConfirm ? CLOCK_FAST_TICK_MS : MINUTE_MS);
  const meetup = meetupQ.data;
  const variant = meQ.data?.variant ?? null;
  useEffect(() => {
    if (poll === null || meetupId === '') return;
    let live = true;
    const tick = (): void => {
      void queryClient
        .fetchQuery<MeetupDto>({
          queryKey: queryKeys.meetup(meetupId),
          queryFn: () => apiClient.getMeetup(meetupId),
          staleTime: 0,
        })
        .then((fresh) => (live && pollIsSatisfied(poll, fresh) ? setPoll(null) : undefined))
        .catch(() => undefined);
    };
    const interval = setInterval(tick, POLL_SPECS[poll].intervalMs);
    const deadline = setTimeout(() => {
      if (!live) return;
      setPoll(null);
      setNotice({ message: COPY.slow, tone: 'info' });
      announce(COPY.slow);
    }, POLL_SPECS[poll].maxMs);
    return () => {
      live = false;
      clearInterval(interval);
      clearTimeout(deadline);
    };
  }, [meetupId, poll]);
  const notFound = meetupQ.isError && errorCodeOf(meetupQ.error) === 'meetup_not_found';
  const readError =
    meetupQ.isError && !notFound ? userMessageFor(errorCodeOf(meetupQ.error)) : null;
  useEffect(() => {
    if (notFound) announce(COPY.missing);
    else if (readError !== null) announce(readError);
  }, [notFound, readError]);
  function showError(code: string): void {
    const message = userMessageFor(code);
    setErrorMessage(message);
    announce(message);
  }
  function showNotice(message: string, tone: BannerTone = 'info'): void {
    setNotice({ message, tone });
    announce(message);
  }
  async function reloadMeetup(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll });
  }
  async function completeChallenge(clientSecret: string): Promise<void> {
    const result = await completeNextAction(clientSecret);
    if (result.status === 'succeeded') {
      showNotice(COPY.holdRecovery);
      setPoll('next_action');
      return;
    }
    if (result.status === 'cancelled') showNotice(COPY.confirmationCancelled);
    else showError('hold_failed');
  }
  function handleDepositFailure(error: unknown): void {
    const code = errorCodeOf(error);
    if (code === 'hold_failed') {
      showError(code);
      setCardPanel(true);
    } else if (['hold_pending', 'payment_unavailable'].includes(code)) {
      showNotice(COPY.holdRecovery);
      setPoll('hold_recovery');
    } else {
      showError(code);
      if (['proposal_lapsed', 'not_proposed', 'not_recipient', 'not_initiator'].includes(code)) {
        void reloadMeetup();
      }
    }
  }
  const runStep = async (step: () => Promise<void>, onFailure = handleDepositFailure) => {
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
  };
  const runAccept = () =>
    runStep(async () => {
      setCardPanel(false);
      const answer = await apiClient.acceptMeetup(meetupId);
      if (answer.status === 'locked') showNotice(COPY.locked, 'success');
      else await completeChallenge(answer.clientSecret);
      await reloadMeetup();
    });
  const runHold = () =>
    runStep(async () => {
      setCardPanel(false);
      const answer = await apiClient.retryHold(meetupId);
      const hold = answer.initiatorHold;
      if (hold === 'requires_action') await completeChallenge(answer.clientSecret);
      else if (hold === 'pending') {
        showNotice(COPY.holdRecovery);
        setPoll('hold_recovery');
      } else if (hold === 'failed') {
        showError('hold_failed');
        setCardPanel(true);
      } else if (hold === 'held') showNotice(COPY.holdPlaced, 'success');
      await reloadMeetup();
    });
  const runDepositStep = (): void => {
    if (meetup !== undefined) void (meetup.role === 'recipient' ? runAccept() : runHold());
  };
  const runDecline = () =>
    runStep(async () => {
      await apiClient.declineMeetup(meetupId);
      showNotice('Proposal declined.');
      await reloadMeetup();
    });
  async function runCancel(): Promise<void> {
    await runStep(
      async () => {
        const answer = await apiClient.cancelMeetup(meetupId);
        const charged = answer.lateCancel;
        showNotice(charged ? COPY.cancelLate : COPY.cancelFree, charged ? 'warning' : 'info');
        setCancelConfirm(false);
        await Promise.all([
          reloadMeetup(),
          queryClient.invalidateQueries({ queryKey: queryKeys.me }),
        ]);
      },
      (error) => {
        showError(errorCodeOf(error));
        void reloadMeetup();
      },
    );
  }
  function handleCardDone(result: CardSetupResult): void {
    if (result.status !== 'saved') return;
    setCardPanel(false);
    runDepositStep();
  }
  const cityZone = citiesQ.data?.items.find((city) => city.id === meetup?.venue.cityId)?.timezone;
  const ownHoldLost = meetup !== undefined && ['captured', 'refunded'].includes(ownHoldOf(meetup));
  const lockLost = ownHoldLost ? LOCK_LOST_COPY.refunded : LOCK_LOST_COPY.released;
  const cancelable = meetup?.status === 'proposed' || meetup?.status === 'locked';
  const late = meetup !== undefined && cancelIsLate(meetup, now);
  const deadline = meetup?.status === 'proposed' ? meetup.recipientDeadline : null;
  const respondBy = deadline === null ? null : `Respond by ${formatInCity(deadline, cityZone)}`;
  const refetch = (): void => void meetupQ.refetch();
  const retry = { label: 'Try again', onPress: refetch, testID: 'meetup-retry' };
  const back = { label: 'Back to meetups', variant: 'secondary' as const, testID: 'meetup-back' };
  const cancel = { label: 'Cancel meetup', variant: 'secondary' as const, testID: 'meetup-cancel' };
  const toRow = (item: MeetupLink): ReactElement => (
    <ListItem key={item.testID} {...linkRow(item)} />
  );
  const onward = meetup === undefined ? [] : onwardLinks(meetup, now).map(toRow);
  const checkInSignal = meetup === undefined ? null : counterpartCheckInSignal(meetup);
  const resultText = meetup === undefined ? null : resultTextFor(meetup);
  const credit = meetup === undefined ? false : wonTableCredit(meetup);
  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Screen edges={SCREEN_EDGES} testID="meetup-detail">
        {errorMessage !== null && <Banner {...ERROR_BANNER} message={errorMessage} />}
        {notice !== null && <Banner {...notice} testID="meetup-notice" />}
        {meetupQ.isPending && <Text style={styles.muted} children="Loading…" />}
        {notFound && (
          <Card testID="meetup-not-found">
            <Text style={styles.body}>{COPY.missing}</Text>
            <Button {...back} onPress={() => void router.push('/meetups')} />
          </Card>
        )}
        {readError !== null && <Banner {...READ_ERROR} message={readError} action={retry} />}
        {meetup !== undefined && (
          <>
            <Card testID="meetup-summary">
              <Text {...STATUS_LINE}>{STATUS_TEXT[meetup.status]}</Text>
              {meetup.checkedIn && (
                <Text testID="meetup-checked-in" style={styles.muted}>
                  {CHECKED_IN_NOTICE}
                </Text>
              )}
              {checkInSignal !== null && (
                <Text testID={checkInSignal.testID} style={styles.muted}>
                  {checkInSignal.text}
                </Text>
              )}
            </Card>
            <ListItem {...counterpartRow(meetup.counterpart)} />
            <Card testID="meetup-terms">
              <Text style={styles.venue}>{meetup.venue.name}</Text>
              <Text style={styles.muted}>{meetup.venue.address}</Text>
              <Text style={styles.muted}>{formatInCity(meetup.startsAt, cityZone)}</Text>
              <Text style={styles.muted}>{depositText(meetup.depositCents)}</Text>
              {respondBy !== null && <Text style={styles.muted}>{respondBy}</Text>}
              <Text style={styles.muted}>{HOLD_TEXT[ownHoldOf(meetup)]}</Text>
              {meetup.disputeOpen && <Text style={styles.muted}>{COPY.disputeOpen}</Text>}
            </Card>
            {meetup.status === 'lock_lost' && <Banner {...LOCK_LOST} message={lockLost} />}
            <PrimaryAction
              meetup={meetup}
              variant={variant}
              depositCents={meetup.depositCents}
              busy={busy}
              cardPanel={cardPanel}
              onAccept={() => void runAccept()}
              onDecline={() => void runDecline()}
              onDepositStep={runDepositStep}
              onCardDone={handleCardDone}
            />
            {cancelable &&
              (cancelConfirm ? (
                <CancelPanel
                  late={late}
                  variant={variant}
                  depositCents={meetup.depositCents}
                  busy={busy}
                  confirm={() => void runCancel()}
                  keep={() => setCancelConfirm(false)}
                />
              ) : (
                <Button {...cancel} disabled={busy} onPress={() => setCancelConfirm(true)} />
              ))}
            {(resultText !== null || credit) && (
              <Card testID="meetup-result">
                {resultText !== null && <Text style={styles.body}>{resultText}</Text>}
                {credit && <Text style={styles.body}>{COPY.resultCredit}</Text>}
                {credit && <Text style={styles.muted}>{TABLE_CREDIT_NOTICE}</Text>}
              </Card>
            )}
            {onward.length > 0 && <View style={styles.block}>{onward}</View>}
          </>
        )}
      </Screen>
    </>
  );
}
