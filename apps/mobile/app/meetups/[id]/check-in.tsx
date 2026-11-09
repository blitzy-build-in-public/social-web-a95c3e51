/** Check in at the venue: the console's six digits and the device's coordinates go to `POST /meetups/:id/check-in`, where the server's own window decides. The code is typed, or read off the venue's QR form by `src/checkin/venue-scanner` — the camera on iOS and Android and nothing at all in the browser, so manual entry is the guaranteed path on every browser. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  CHECK_IN_CLOSES_AFTER_MINUTES,
  CHECK_IN_OPENS_BEFORE_MINUTES,
  CODE_DIGITS,
  MINUTE_MS,
  colors,
  fontWeights,
  isFinalMeetupStatus,
  spacing,
  typography,
} from '@tablemate/shared';
import type { CheckInResponse, MeetupDto } from '@tablemate/shared';

import { apiClient } from '../../../src/api/client';
import { isApiError, isNetworkError, userMessageFor } from '../../../src/api/errors';
import { serverNow } from '../../../src/api/server-clock';
import { LocationError, currentCoords } from '../../../src/checkin/location';
import { holdCode, isOnline } from '../../../src/checkin/offline-code';
import type { HeldCode } from '../../../src/checkin/offline-code';
import { VenueScanner } from '../../../src/checkin/venue-scanner';
import {
  BOTH_CHECKED_IN_NOTICE,
  CHECKED_IN_NOTICE,
  CHECK_IN_CLOSED_NOTICE,
  VENUE_CODE_FILLED_NOTICE,
} from '../../../src/copy/strings';
import { queryClient, queryKeys, useMeetup } from '../../../src/state/meetup-store';
import {
  Banner,
  Button,
  Card,
  Screen,
  TextField,
  announce,
  useAppNoticeMessage,
} from '../../../src/ui';

const SCREEN_TITLE = 'Check in';
const OFFLINE_NOTICE =
  "You're offline. We'll send this code when you reconnect (up to 60 seconds).";
const EXPIRED_NOTICE = "That code has expired. Enter the current code from the venue's screen.";
const NOT_LOCKED_NOTICE = 'Check-in is available once the meetup is locked.';
const LOADING_NOTICE = 'Loading…';
const OPENING_SOON = 'Check-in opens in less than a minute.';
const CLOSING_SOON = 'Less than a minute left to check in.';
const SUBMIT_HINT = `Enter the ${CODE_DIGITS} digits from the venue's screen`;
const LOCATION_DENIED_NOTICE = 'Location permission is needed to check in at the venue.';
const LOCATION_UNAVAILABLE_NOTICE = "We couldn't get your location. Try again at the venue.";
const SUBMIT_PROPS = { label: 'Check in', hint: SUBMIT_HINT, testID: 'checkin-submit' } as const;
const RETRY_PROPS = { label: 'Try again', testID: 'checkin-retry' } as const;
const RESULT_FOCUS_TEST_ID = 'checkin-result-focus';
const FIELD_MODES = { inputMode: 'numeric', keyboardType: 'number-pad' } as const;
const FIELD_AUTO = { autoComplete: 'one-time-code', textContentType: 'oneTimeCode' } as const;
function windowText(now: number, startsAt: number): string {
  const opensAt = startsAt - CHECK_IN_OPENS_BEFORE_MINUTES * MINUTE_MS;
  const closesAt = startsAt + CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS;
  const opening = now < opensAt;
  const remaining = (opening ? opensAt : closesAt) - now;
  if (!opening && remaining < 0) return 'Check-in has closed.';
  if (remaining < MINUTE_MS) return opening ? OPENING_SOON : CLOSING_SOON;
  const minutes = opening ? Math.ceil(remaining / MINUTE_MS) : Math.floor(remaining / MINUTE_MS);
  return opening
    ? `Check-in opens in ${minutes} minute${minutes === 1 ? '' : 's'}.`
    : `${minutes} minute${minutes === 1 ? '' : 's'} left to check in.`;
}
const CITY_TIME_FORMATS = [
  { dateStyle: 'medium', timeStyle: 'short' },
  { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
] as const satisfies readonly Intl.DateTimeFormatOptions[];
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}
function startTimeText(iso: string, timeZone: string | undefined): string {
  const at = new Date(iso);
  const zone = timeZone !== undefined && timeZone !== '' ? timeZone : deviceTimeZone();
  for (const format of CITY_TIME_FORMATS) {
    try {
      const rendered =
        zone === ''
          ? new Intl.DateTimeFormat('en', format).format(at)
          : new Intl.DateTimeFormat('en', { ...format, timeZone: zone }).format(at);
      return zone === '' ? `Starts at ${rendered}` : `Starts at ${rendered} (${zone})`;
    } catch {
      continue;
    }
  }
  return `Starts at ${iso}`;
}

const onlyDigits = (value: string): string => value.replace(/\D/g, '').slice(0, CODE_DIGITS);
function messageFor(error: unknown): string {
  if (!(error instanceof LocationError))
    return isApiError(error) ? userMessageFor(error.code) : userMessageFor('invalid_response');
  return error.code === 'location_denied' ? LOCATION_DENIED_NOTICE : LOCATION_UNAVAILABLE_NOTICE;
}
/** Moves focus to the outcome card on the web: submitting destroys the button that had focus and the browser falls back to the document body, leaving a keyboard user at the top of the page. The card's container carries the result sentence as its accessible name, so the reading and tab order continue there. Native needs nothing: the platform keeps focus and `announce()` reports the result. */
function focusOutcome(): void {
  if (Platform.OS !== 'web') return;
  try {
    document.querySelector<HTMLElement>(`[data-testid="${RESULT_FOCUS_TEST_ID}"]`)?.focus();
  } catch {
    // No document to focus in: nothing to do.
  }
}
type OutcomeProps = { title: string; testID: string; note?: string | null; onBack: () => void };
/** The outcome card's wrapper, the programmatically focusable group: `tabIndex={-1}` puts it in the DOM without adding it to the tab order and `accessibilityLabel` names it. The card is wrapped rather than made focusable itself, because a control nested in a control cannot be reached by keyboard. */
const OutcomeCard = ({ title, testID, note, onBack }: OutcomeProps): ReactElement => (
  <View testID={RESULT_FOCUS_TEST_ID} tabIndex={-1} role="group" accessibilityLabel={title}>
    <Card title={title} testID={testID}>
      {note ?? null}
      <Button label="Back to meetup" variant="secondary" testID="checkin-back" onPress={onBack} />
    </Card>
  </View>
);
export default function CheckInScreen(): ReactElement {
  const params = useLocalSearchParams<{ id: string }>();
  const meetupId = typeof params.id === 'string' ? params.id : '';
  const noticeMessage = useAppNoticeMessage();
  const meetupQ = useMeetup(meetupId);
  const citiesQ = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    staleTime: 60 * MINUTE_MS,
  });
  const [code, setCode] = useState('');
  const [result, setResult] = useState<CheckInResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  const inFlight = useRef(false);
  const held = useRef<HeldCode | null>(null);
  // The tick only re-renders this screen; the reading comes from `serverNow()` at every render, so an offset recorded after this screen mounted takes effect at once.
  const [, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => held.current?.cancel(), []);
  const detail: MeetupDto | null = meetupQ.data ?? null;
  const startsAt = detail === null ? Number.NaN : Date.parse(detail.startsAt);
  const known = Number.isFinite(startsAt);
  const city = citiesQ.data?.items.find((item) => item.id === detail?.venue.cityId);
  const startText = known && detail ? startTimeText(detail.startsAt, city?.timezone) : null;
  const left = known ? windowText(serverNow(), startsAt) : null;
  const loadMessage = detail === null && meetupQ.isError ? messageFor(meetupQ.error) : null;
  const errorMessage = failure ?? loadMessage;
  const canSubmit = code.length === CODE_DIGITS && !holding;
  const both = result !== null && result.bothCheckedIn ? BOTH_CHECKED_IN_NOTICE : null;
  // The three states whose card stands in place of the form, derived here so the effect runs exactly when the form is replaced — and once for a screen that opens straight onto an outcome.
  const outcomeShown =
    detail !== null && (result !== null || detail.checkedIn || detail.status !== 'locked');
  useEffect(() => {
    if (!outcomeShown) return;
    requestAnimationFrame(focusOutcome);
  }, [outcomeShown]);
  useEffect(() => {
    if (loadMessage !== null) announce(loadMessage);
  }, [loadMessage]);
  const sendCode = async (value: string): Promise<CheckInResponse> =>
    apiClient.checkIn(meetupId, { code: value, ...(await currentCoords()) });
  const succeed = (resp: CheckInResponse): void => {
    setResult(resp);
    setCode('');
    announce(
      resp.bothCheckedIn ? `${CHECKED_IN_NOTICE} ${BOTH_CHECKED_IN_NOTICE}` : CHECKED_IN_NOTICE,
    );
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll }),
    ]);
  };
  /** Takes a `409 not_locked` refusal back to the meetup's own state: the route answers it for every status other than `locked`, so only a fresh read of the meetup, forced past the cache with `staleTime: 0`, tells an unlocked meetup from one that has already reached a final status. */
  const resolveNotLocked = async (): Promise<void> => {
    const fresh = await queryClient
      .fetchQuery({
        queryKey: queryKeys.meetup(meetupId),
        queryFn: () => apiClient.getMeetup(meetupId),
        staleTime: 0,
      })
      .catch(() => null);
    if (fresh === null || !isFinalMeetupStatus(fresh.status)) return;
    setFailure(null);
    announce(CHECK_IN_CLOSED_NOTICE);
  };
  const fail = (error: unknown): void => {
    const message = messageFor(error);
    setFailure(message);
    announce(message);
    if (!isApiError(error)) return;
    if (error.code === 'not_locked') {
      void resolveNotLocked();
      return;
    }
    if (error.code === 'already_checked_in')
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) });
  };
  const submit = (): void => {
    if (inFlight.current || code.length !== CODE_DIGITS) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    void (async () => {
      const answered: { value: CheckInResponse | null } = { value: null };
      const send = async (held: string): Promise<void> => {
        answered.value = await sendCode(held);
      };
      const offline = async (): Promise<void> => {
        setHolding(true);
        setBusy(false);
        announce(OFFLINE_NOTICE);
        held.current = holdCode(code, send, { isNetworkError });
        const outcome = await held.current.result.catch(fail);
        if (outcome === 'submitted' && answered.value !== null) succeed(answered.value);
        else if (outcome === 'expired') {
          setCode('');
          setFailure(EXPIRED_NOTICE);
          announce(EXPIRED_NOTICE);
        }
      };
      try {
        if (await isOnline()) succeed(await sendCode(code));
        else await offline();
      } catch (error) {
        if (isNetworkError(error)) await offline();
        else fail(error);
      } finally {
        held.current = null;
        setHolding(false);
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };
  const onCodeChange = (text: string): void => {
    held.current?.cancel();
    setCode(onlyDigits(text));
  };
  const onScanned = (scanned: string): void => {
    setCode(scanned);
    announce(VENUE_CODE_FILLED_NOTICE);
  };
  const retry = (): void => void meetupQ.refetch();
  const bannerProps =
    loadMessage === null
      ? {}
      : { action: { ...RETRY_PROPS, onPress: retry, busy: meetupQ.isFetching } };
  const back = (): void => void router.navigate(`/meetups/${meetupId}`);
  const form = (
    <>
      {left === null ? null : (
        <Text testID="checkin-time-left" style={styles.timeLeft}>
          {left}
        </Text>
      )}
      {startText === null ? null : <Text style={styles.caption}>{startText}</Text>}
      <TextField
        label="6-digit venue code"
        value={code}
        onChangeText={onCodeChange}
        hint="The code changes every minute; enter the one on the venue's screen now."
        {...FIELD_MODES}
        maxLength={CODE_DIGITS}
        {...FIELD_AUTO}
        returnKeyType="done"
        onSubmitEditing={submit}
        testID="checkin-code"
      />
      <VenueScanner onCode={onScanned} />
      <Button {...SUBMIT_PROPS} onPress={submit} busy={busy} disabled={!canSubmit} />
      {holding ? <Banner tone="info" message={OFFLINE_NOTICE} testID="checkin-offline" /> : null}
    </>
  );
  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      {detail === null ? null : (
        <View style={styles.venueBlock}>
          <Text testID="checkin-venue" style={styles.venue}>
            {detail.venue.name}
          </Text>
          <Text testID="checkin-venue-address" style={styles.venueAddress}>
            {detail.venue.address}
          </Text>
        </View>
      )}
      {errorMessage === null ? null : (
        <Banner tone="error" message={errorMessage} testID="checkin-error" {...bannerProps} />
      )}
      {detail === null ? (
        errorMessage === null && noticeMessage === null ? (
          <Text style={styles.notice}>{LOADING_NOTICE}</Text>
        ) : null
      ) : result !== null ? (
        <OutcomeCard title={CHECKED_IN_NOTICE} testID="checkin-result" note={both} onBack={back} />
      ) : detail.checkedIn ? (
        <OutcomeCard title={CHECKED_IN_NOTICE} testID="checkin-result" onBack={back} />
      ) : detail.status !== 'locked' ? (
        <OutcomeCard
          title={isFinalMeetupStatus(detail.status) ? CHECK_IN_CLOSED_NOTICE : NOT_LOCKED_NOTICE}
          testID="checkin-not-locked"
          onBack={back}
        />
      ) : (
        form
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  notice: { ...typography.body, color: colors.textMuted },
  timeLeft: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  caption: { ...typography.caption, color: colors.textMuted },
  venueBlock: { gap: spacing.xs },
  venue: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  venueAddress: { ...typography.body, color: colors.textMuted },
});
