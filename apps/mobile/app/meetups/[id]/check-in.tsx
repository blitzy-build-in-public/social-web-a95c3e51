/**
 * Check in at the venue: the witnessed check-in screen of AAP 0.5.8's "Meetups -> meetup -> Check
 * in", which sends the six digits the venue console shows with the device's coordinates to
 * `POST /meetups/:id/check-in` (AAP 0.5.4, 0.5.7).
 *
 * Three invariants hold here. The window is the server's: the span from `startsAt - 15 min` to
 * `startsAt + 45 min` is shown as text and the action stays available outside it, because the API
 * decides with `410 outside_window` and `422 outside_geofence`. The coordinates are read at submit
 * and live only inside the awaited call that sends them: no state, ref, cache, storage or log line
 * sees them (AAP 0.1.1, AAP 0.12.2). No failure shows the server's own text: every sentence comes
 * from the code's entry in `src/api/errors.ts`, the one place a code's copy lives (AAP 0.11.1).
 *
 * A code entered with no connection is held for at most `OFFLINE_CODE_RETENTION_MS` (60 s) by
 * `src/checkin/offline-code.ts`, which sends it on the next online signal and otherwise drops it;
 * the server accepts the current code step and one either side of it (AAP 0.5.7).
 *
 * The QR scanner is a sub-component rather than a file, because every file under `app/meetups/[id]/`
 * becomes a route. It renders on iOS and Android only — Safari and Firefox have no dependable
 * barcode API, so web keeps manual entry alone (AAP 0.3.4) — and `useCameraPermissions` is called
 * inside it, so no hook is ever called conditionally.
 *
 * Client-safe: `react`, `react-native`, `expo-router`, `expo-camera`, `@tanstack/react-query` and the
 * app's own client modules, with no Node built-in and no effect at module load.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeScanningResult } from 'expo-camera';
import {
  CHECK_IN_CLOSES_AFTER_MINUTES,
  CHECK_IN_OPENS_BEFORE_MINUTES,
  CODE_DIGITS,
  MINUTE_MS,
  colors,
  fontWeights,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type { CheckInResponse, MeetupDto } from '@tablemate/shared';

import { apiClient } from '../../../src/api/client';
import { isApiError, isNetworkError, userMessageFor } from '../../../src/api/errors';
import { LocationError, currentCoords } from '../../../src/checkin/location';
import { holdCode, isOnline } from '../../../src/checkin/offline-code';
import type { HeldCode } from '../../../src/checkin/offline-code';
import { queryClient, queryKeys, useMeetup } from '../../../src/state/meetup-store';
import { Banner, Button, Card, Screen, TextField, announce } from '../../../src/ui';

/** The navigator header's title, which is the page's only level-one heading. */
const SCREEN_TITLE = 'Check in';

/** The insets this pushed route claims: the navigator's header owns the top one. */
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;

/**
 * How often the device clock is re-read, in milliseconds. The window is measured in whole minutes
 * and the server decides acceptance, so a quarter-minute keeps the sentence honest without
 * re-rendering on every second (AAP 0.5.7).
 */
const CLOCK_TICK_MS = 15_000;

/** How long the city list — and so the venue's timezone — stays fresh, in milliseconds. */
const CITIES_STALE_TIME_MS = 60 * MINUTE_MS;

/** A venue check-in code, built from the contract's `CODE_DIGITS` so the two agree (AAP 0.5.7). */
const CODE_PATTERN = new RegExp(`^\\d{${CODE_DIGITS}}$`);

// This screen's own labels and sentences. Error copy belongs to `src/api/errors.ts`, the deposit,
// safety and notice strings to `@tablemate/shared` and `src/copy`, and the windows to the shared
// constants, so none of them is repeated here.
const CODE_LABEL = '6-digit venue code';
const CODE_HINT = "The code changes every minute; enter the one on the venue's screen now.";
const SUBMIT_LABEL = 'Check in';
const SUBMIT_HINT = `Enter the ${CODE_DIGITS} digits from the venue's screen`;
const SCAN_LABEL = "Scan the venue's QR code";
const SCANNER_LABEL = 'Camera viewfinder';
const CLOSE_SCANNER_LABEL = 'Close scanner';
const BACK_LABEL = 'Back to meetup';
const RETRY_LABEL = 'Try again';
const LOADING_NOTICE = 'Loading…';
const CHECKED_IN_TITLE = "You're checked in.";
const BOTH_CHECKED_IN_TEXT = "You're both checked in.";
const NOT_LOCKED_NOTICE = 'Check-in is available once the meetup is locked.';
const CLOSED_TEXT = 'Check-in has closed.';
const OFFLINE_NOTICE =
  "You're offline. We'll send this code when you reconnect (up to 60 seconds).";
const EXPIRED_NOTICE = "That code has expired. Enter the current code from the venue's screen.";
const CAMERA_DENIED_NOTICE = 'Camera access is off. You can type the code instead.';
const NOT_A_CODE_NOTICE = "That isn't a venue code.";
const CAMERA_STARTING_NOTICE = 'Starting the camera…';
const SCAN_FILLED_NOTICE = 'Venue code filled in.';
const LOCATION_DENIED_NOTICE = 'Location permission is needed to check in at the venue.';
const LOCATION_UNAVAILABLE_NOTICE = "We couldn't get your location. Try again at the venue.";

/** The instant check-in opens; the API allows the tolerance itself (AAP 0.5.7). */
function opensAtOf(startsAt: number): number {
  return startsAt - CHECK_IN_OPENS_BEFORE_MINUTES * MINUTE_MS;
}

/** The instant check-in closes, which is also when settlement runs (AAP 0.5.3, 0.5.7). */
function closesAtOf(startsAt: number): number {
  return startsAt + CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS;
}

/**
 * The window as one sentence (AAP 0.5.8), from the device clock alone: the server's own answer for a
 * submission outside the window is `410 outside_window`. The two roundings deliberately differ — up
 * before the window, so it never promises an opening earlier than the server will honour, and down
 * inside it, so it never claims more time than is left.
 */
function windowText(now: number, opensAt: number, closesAt: number): string {
  if (now < opensAt) {
    const remaining = opensAt - now;
    if (remaining < MINUTE_MS) return 'Check-in opens in less than a minute.';
    const minutes = Math.ceil(remaining / MINUTE_MS);
    return `Check-in opens in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  if (now <= closesAt) {
    const remaining = closesAt - now;
    if (remaining < MINUTE_MS) return 'Less than a minute left to check in.';
    const minutes = Math.floor(remaining / MINUTE_MS);
    return `${minutes} minute${minutes === 1 ? '' : 's'} left to check in.`;
  }
  return CLOSED_TEXT;
}

/** The two forms an instant is rendered in, the second for a runtime without `dateStyle`. */
const CITY_TIME_FORMATS = [
  { dateStyle: 'medium', timeStyle: 'short' },
  { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
] as const satisfies readonly Intl.DateTimeFormatOptions[];

/** The device's own zone name, or `''` where the runtime will not say. */
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/**
 * The meetup's start in the venue city's own zone, named so a traveler keeping another zone reads
 * the time the venue keeps (AAP 0.5.8). An unknown zone or an unsupported style falls back to the
 * device's zone, also named, and an unformattable value is returned as it arrived.
 */
function startTimeText(iso: string, timeZone: string | undefined): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return `Starts at ${iso}`;

  const zone = timeZone !== undefined && timeZone !== '' ? timeZone : deviceTimeZone();
  for (const format of CITY_TIME_FORMATS) {
    try {
      const rendered =
        zone === ''
          ? new Intl.DateTimeFormat('en', format).format(at)
          : new Intl.DateTimeFormat('en', { ...format, timeZone: zone }).format(at);
      return zone === '' ? `Starts at ${rendered}` : `Starts at ${rendered} (${zone})`;
    } catch {
      // An unsupported style or a zone this runtime does not carry: the next form.
    }
  }
  return `Starts at ${iso}`;
}

/** Keeps the field to the `CODE_DIGITS` (6) digits the console shows, pasted text included. */
function onlyDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, CODE_DIGITS);
}

/**
 * The sentence a failure shows (AAP 0.5.4, 0.5.8): a device position failure reads its own fixed
 * copy, an API failure reads the code's sentence from `src/api/errors.ts`, and anything else reads
 * the generic sentence that module owns — never the server's own text.
 */
function messageFor(error: unknown): string {
  if (error instanceof LocationError) {
    return error.code === 'location_denied' ? LOCATION_DENIED_NOTICE : LOCATION_UNAVAILABLE_NOTICE;
  }
  if (isApiError(error)) return userMessageFor(error.code);
  return userMessageFor('invalid_response');
}

/** The device clock, re-read on an interval and cleared on unmount (AAP 0.5.7). */
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

/** Props of {@link NativeScanner}. */
interface NativeScannerProps {
  /** Called with the six digits a QR symbol carried. */
  readonly onCode: (code: string) => void;
  /** Closes the scanner without a code. */
  readonly onClose: () => void;
}

/**
 * The venue's QR form, read with the camera on iOS and Android (AAP 0.3.4).
 *
 * The console's symbol encodes the bare six digits of the server's code
 * (`apps/venue-console/src/routes/VenueCode.tsx`), so exactly `CODE_DIGITS` digits are accepted and
 * anything else is reported with the scanner left open. The scanner fires continuously while a
 * symbol is in view, so the last payload handled is remembered and a repeat of it is dropped. The
 * permission is asked for once per mount, for a permission that is neither granted nor refused for
 * good; a refusal is rendered with the way back to typing rather than asked for again.
 */
function NativeScanner({ onCode, onClose }: NativeScannerProps): ReactElement {
  const [permission, requestPermission] = useCameraPermissions();
  const [invalid, setInvalid] = useState(false);
  const lastPayload = useRef<string | null>(null);
  const asked = useRef(false);

  // Asked once per mount, for the state a fresh permission is in: neither granted nor refused for
  // good. A permanent refusal is rendered as the notice below rather than asked again.
  useEffect(() => {
    if (permission === null || permission.granted || !permission.canAskAgain || asked.current) {
      return;
    }
    asked.current = true;
    void requestPermission().catch(() => undefined);
  }, [permission, requestPermission]);

  const handleScan = useCallback(
    (scan: BarcodeScanningResult): void => {
      const payload = scan.data.trim();
      if (payload === lastPayload.current) return;
      lastPayload.current = payload;

      if (CODE_PATTERN.test(payload)) {
        onCode(payload);
        return;
      }
      setInvalid(true);
      announce(NOT_A_CODE_NOTICE);
    },
    [onCode],
  );

  const viewfinder =
    permission === null ? (
      <Text style={styles.notice}>{CAMERA_STARTING_NOTICE}</Text>
    ) : permission.granted ? (
      <CameraView
        style={styles.camera}
        facing="back"
        accessibilityLabel={SCANNER_LABEL}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handleScan}
      />
    ) : (
      <Banner tone="error" message={CAMERA_DENIED_NOTICE} testID="checkin-camera-denied" />
    );

  return (
    <View style={styles.scanner}>
      {viewfinder}
      {invalid ? (
        <Banner tone="error" message={NOT_A_CODE_NOTICE} testID="checkin-scan-invalid" />
      ) : null}
      <Button
        label={CLOSE_SCANNER_LABEL}
        variant="secondary"
        testID="checkin-scan-close"
        onPress={onClose}
      />
    </View>
  );
}

/**
 * The check-in screen for one meetup.
 *
 * Three states gate the form, in this order: a read that failed, a caller who is already checked in,
 * and a meetup that is not `locked`. None of them rules on the server's behalf — the API still
 * decides every submission — and each one offers the way back to the meetup.
 *
 * @returns The witnessed check-in screen.
 */
export default function CheckInScreen(): ReactElement {
  const params = useLocalSearchParams<{ id: string }>();
  const meetupId = typeof params.id === 'string' ? params.id : '';
  const meetupQ = useMeetup(meetupId);

  // A public read that changes only when the pilot adds a city, so one answer an hour serves the
  // venue's timezone; its failure costs the start-time line and nothing else.
  const citiesQ = useQuery({
    queryKey: queryKeys.cities,
    queryFn: () => apiClient.listCities(),
    staleTime: CITIES_STALE_TIME_MS,
  });

  const [code, setCode] = useState('');
  const [result, setResult] = useState<CheckInResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [holding, setHolding] = useState(false);
  const [scanning, setScanning] = useState(false);

  // A ref as well as `busy`: two taps in one frame both read `busy` as false, and the second would
  // be answered by the API with `409 already_checked_in` instead of being ignored here.
  const inFlight = useRef(false);
  const held = useRef<HeldCode | null>(null);
  const announcedLoad = useRef<string | null>(null);

  const now = useDeviceClock(CLOCK_TICK_MS);

  // A held code is withdrawn when the screen goes away, so nothing is left waiting on connectivity.
  useEffect(
    () => () => {
      held.current?.cancel();
    },
    [],
  );

  // The one place a code may be sent from. The coordinates are read here, used for the 150 m test
  // and nothing else: they enter the request body and no other corner of the app (AAP 0.12.2).
  const sendCode = async (value: string): Promise<CheckInResponse> => {
    const coords = await currentCoords();
    return apiClient.checkIn(meetupId, { code: value, lat: coords.lat, lng: coords.lng });
  };

  /** Renders an accepted check-in, speaks it and refreshes every read it changes. */
  const succeed = (response: CheckInResponse): void => {
    setResult(response);
    setCode('');
    announce(
      response.bothCheckedIn ? `${CHECKED_IN_TITLE} ${BOTH_CHECKED_IN_TEXT}` : CHECKED_IN_TITLE,
    );
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll }),
    ]);
  };

  /** Shows and speaks one refusal, refreshing the read an already-checked-in answer describes. */
  const fail = (error: unknown): void => {
    const message = messageFor(error);
    setFailure(message);
    announce(message);
    if (isApiError(error) && error.code === 'already_checked_in') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) });
    }
  };

  /**
   * Holds the entered code until the device is online again (AAP 0.5.7). `holdCode` reports only how
   * the hold ended, so the accepted answer is captured in the closure below rather than taken from
   * its result: a code that was in the air is `submitted`, an expiry asks for the current code, and
   * a hold this screen withdrew reports nothing at all.
   */
  const holdAndWait = async (value: string): Promise<void> => {
    setHolding(true);
    setBusy(false);
    announce(OFFLINE_NOTICE);

    // Read through a function: the answer is assigned inside the callback `holdCode` runs later, and
    // reading the `let` directly would be narrowed to `null` rather than typed as the union.
    let answered: CheckInResponse | null = null;
    const captured = (): CheckInResponse | null => answered;

    const handle = holdCode(
      value,
      async (heldCode) => {
        answered = await sendCode(heldCode);
        return answered;
      },
      { isNetworkError },
    );
    held.current = handle;

    try {
      const outcome = await handle.result;
      if (outcome === 'submitted') {
        const response = captured();
        if (response !== null) succeed(response);
      } else if (outcome === 'expired') {
        setCode('');
        setFailure(EXPIRED_NOTICE);
        announce(EXPIRED_NOTICE);
      }
      // `cancelled`: a new code or an unmount withdrew the hold, and the screen says nothing.
    } catch (error) {
      fail(error);
    } finally {
      held.current = null;
      setHolding(false);
    }
  };

  /** Sends the entered code once per press, holding it offline instead of failing (AAP 0.5.7). */
  const submit = (): void => {
    const value = code;
    if (inFlight.current || value.length !== CODE_DIGITS) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);

    void (async () => {
      try {
        if (await isOnline()) {
          succeed(await sendCode(value));
        } else {
          await holdAndWait(value);
        }
      } catch (error) {
        // A request that never reached the API is held rather than reported as a failure.
        if (isNetworkError(error)) await holdAndWait(value);
        else fail(error);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };

  /** Keeps the field to six digits, and withdraws a code the device is holding while offline. */
  const onCodeChange = (text: string): void => {
    held.current?.cancel();
    setCode(onlyDigits(text));
  };

  /** Takes a scanned code into the field and closes the scanner. */
  const onScanned = (scanned: string): void => {
    setCode(scanned);
    setScanning(false);
    announce(SCAN_FILLED_NOTICE);
  };

  // Narrowed and derived once for the branches below: `null` is the read not having answered yet.
  const detail: MeetupDto | null = meetupQ.data ?? null;
  const startsAt = detail === null ? Number.NaN : Date.parse(detail.startsAt);
  const windowKnown = Number.isFinite(startsAt);
  const city =
    detail === null
      ? undefined
      : citiesQ.data?.items.find((item) => item.id === detail.venue.cityId);
  const startText =
    detail === null || !windowKnown ? null : startTimeText(detail.startsAt, city?.timezone);
  const timeLeft = windowKnown ? windowText(now, opensAtOf(startsAt), closesAtOf(startsAt)) : null;
  const loadMessage = detail === null && meetupQ.isError ? messageFor(meetupQ.error) : null;
  const errorMessage = failure ?? loadMessage;
  const canSubmit = code.length === CODE_DIGITS && !holding;

  // A failed read is announced once: a re-render over the same failed read would repeat the
  // sentence. A failed submission is announced where it happens instead, because pressing Check in
  // again can produce the same sentence (see `fail`).
  useEffect(() => {
    if (loadMessage === null) {
      announcedLoad.current = null;
      return;
    }
    if (announcedLoad.current === loadMessage) return;
    announcedLoad.current = loadMessage;
    announce(loadMessage);
  }, [loadMessage]);

  /** The way back to the meetup, wherever the form is not shown. */
  const backToMeetup = (
    <Button
      label={BACK_LABEL}
      variant="secondary"
      testID="checkin-back"
      onPress={() => {
        router.navigate(`/meetups/${meetupId}`);
      }}
    />
  );

  /** The form, in reading order: the window, the code, the scan, the action, the held notice. */
  const form = (
    <>
      {timeLeft === null ? null : (
        <Text testID="checkin-time-left" style={styles.timeLeft}>
          {timeLeft}
        </Text>
      )}
      {startText === null ? null : <Text style={styles.caption}>{startText}</Text>}

      <TextField
        label={CODE_LABEL}
        value={code}
        onChangeText={onCodeChange}
        hint={CODE_HINT}
        // Paste stays available: the primitive never hides the selection menu, and the field keeps
        // whatever digits arrive, however they were typed or pasted.
        inputMode="numeric"
        keyboardType="number-pad"
        maxLength={CODE_DIGITS}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        returnKeyType="done"
        onSubmitEditing={submit}
        testID="checkin-code"
      />

      {/* Web types the code: Safari and Firefox have no dependable barcode API (AAP 0.3.4). */}
      {Platform.OS === 'web' ? null : scanning ? (
        <NativeScanner onCode={onScanned} onClose={() => setScanning(false)} />
      ) : (
        <Button
          label={SCAN_LABEL}
          variant="secondary"
          testID="checkin-scan"
          onPress={() => setScanning(true)}
        />
      )}

      {/* Never disabled for being outside the client's window: the server decides that, and its
          `410 outside_window` arrives here and is announced like any other refusal (AAP 0.5.7). */}
      <Button
        label={SUBMIT_LABEL}
        testID="checkin-submit"
        onPress={submit}
        busy={busy}
        disabled={!canSubmit}
        hint={SUBMIT_HINT}
      />

      {holding ? <Banner tone="info" message={OFFLINE_NOTICE} testID="checkin-offline" /> : null}
    </>
  );

  return (
    <Screen edges={SCREEN_EDGES}>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />

      {errorMessage === null ? null : (
        <Banner
          tone="error"
          message={errorMessage}
          testID="checkin-error"
          {...(loadMessage === null
            ? {}
            : {
                action: {
                  label: RETRY_LABEL,
                  onPress: () => void meetupQ.refetch(),
                  testID: 'checkin-retry',
                },
              })}
        />
      )}

      {detail === null ? (
        // Nothing is rendered from a meetup that has not arrived: the banner above carries any
        // failure, and with no failure the read is still in flight.
        errorMessage === null ? (
          <Text style={styles.notice}>{LOADING_NOTICE}</Text>
        ) : null
      ) : detail.checkedIn ? (
        <Card title={CHECKED_IN_TITLE} testID="checkin-result">
          {backToMeetup}
        </Card>
      ) : detail.status !== 'locked' ? (
        <Card title={NOT_LOCKED_NOTICE} testID="checkin-not-locked">
          {backToMeetup}
        </Card>
      ) : result !== null ? (
        <Card title={CHECKED_IN_TITLE} testID="checkin-result">
          {result.bothCheckedIn ? BOTH_CHECKED_IN_TEXT : null}
          {backToMeetup}
        </Card>
      ) : (
        form
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  notice: {
    ...typography.body,
    color: colors.textMuted,
  },
  // The window is text, never colour alone (WCAG 1.4.1), and it carries no live region: one would
  // read a new count out every quarter-minute.
  timeLeft: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  caption: {
    ...typography.caption,
    color: colors.textMuted,
  },
  scanner: {
    gap: spacing.md,
  },
  // The viewfinder fills the column and keeps a square aspect, so it grows with the window and the
  // reader's font size rather than sitting at one fixed size.
  camera: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
});
