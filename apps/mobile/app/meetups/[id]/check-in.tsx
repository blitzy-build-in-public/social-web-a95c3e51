/** Check in at the venue (AAP 0.5.8): the console's six digits and the device's coordinates go to
 * `POST /meetups/:id/check-in` (AAP 0.5.4, 0.5.7), where the server's own window decides. */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { BarcodeScanningResult, CameraViewProps } from 'expo-camera';
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

const SCREEN_TITLE = 'Check in';
const CODE_PATTERN = new RegExp(`^\\d{${CODE_DIGITS}}$`);
const CHECKED_IN_TITLE = "You're checked in.";
const BOTH_CHECKED_IN_TEXT = "You're both checked in.";
const OFFLINE_NOTICE =
  "You're offline. We'll send this code when you reconnect (up to 60 seconds).";
const EXPIRED_NOTICE = "That code has expired. Enter the current code from the venue's screen.";
const NOT_LOCKED_NOTICE = 'Check-in is available once the meetup is locked.';
const NOT_A_CODE_NOTICE = "That isn't a venue code.";
const LOADING_NOTICE = 'Loading…';
const OPENING_SOON = 'Check-in opens in less than a minute.';
const CLOSING_SOON = 'Less than a minute left to check in.';
const CAMERA_STARTING_NOTICE = 'Starting the camera…';
const CAMERA_DENIED_NOTICE = 'Camera access is off. You can type the code instead.';
const SUBMIT_HINT = `Enter the ${CODE_DIGITS} digits from the venue's screen`;
const SCAN_LABEL = "Scan the venue's QR code";
const LOCATION_DENIED_NOTICE = 'Location permission is needed to check in at the venue.';
const LOCATION_UNAVAILABLE_NOTICE = "We couldn't get your location. Try again at the venue.";
const SCAN_PROPS = { label: SCAN_LABEL, variant: 'secondary', testID: 'checkin-scan' } as const;
const CLOSE_PROPS = { label: 'Close scanner', testID: 'checkin-scan-close' } as const;
const SUBMIT_PROPS = { label: 'Check in', hint: SUBMIT_HINT, testID: 'checkin-submit' } as const;
const RETRY_PROPS = { label: 'Try again', testID: 'checkin-retry' } as const;
const BAD_CODE = <Banner tone="error" message={NOT_A_CODE_NOTICE} testID="checkin-scan-invalid" />;
const CAMERA_PROPS: Partial<CameraViewProps> = {
  facing: 'back',
  accessibilityLabel: 'Camera viewfinder',
  barcodeScannerSettings: { barcodeTypes: ['qr'] },
};
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
type NativeScannerProps = Readonly<{ onCode: (code: string) => void; onClose: () => void }>;
function NativeScanner({ onCode, onClose }: NativeScannerProps): ReactElement {
  const [permission, requestPermission] = useCameraPermissions();
  const [invalid, setInvalid] = useState(false);
  const lastPayload = useRef<string | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    const undecided = permission !== null && !permission.granted && permission.canAskAgain;
    if (!undecided || asked.current) return;
    asked.current = true;
    void requestPermission().catch(() => undefined);
  }, [permission, requestPermission]);
  const handleScan = (scan: BarcodeScanningResult): void => {
    const payload = scan.data.trim();
    if (payload === lastPayload.current) return;
    lastPayload.current = payload;
    if (CODE_PATTERN.test(payload)) onCode(payload);
    else {
      setInvalid(true);
      announce(NOT_A_CODE_NOTICE);
    }
  };
  return (
    <View style={styles.scanner}>
      {permission === null ? (
        <Text style={styles.notice}>{CAMERA_STARTING_NOTICE}</Text>
      ) : permission.granted ? (
        <CameraView style={styles.camera} {...CAMERA_PROPS} onBarcodeScanned={handleScan} />
      ) : (
        <Banner tone="error" message={CAMERA_DENIED_NOTICE} testID="checkin-camera-denied" />
      )}
      {invalid ? BAD_CODE : null}
      <Button {...CLOSE_PROPS} variant="secondary" onPress={onClose} />
    </View>
  );
}
type OutcomeProps = { title: string; testID: string; note?: string | null; onBack: () => void };
const OutcomeCard = ({ title, testID, note, onBack }: OutcomeProps): ReactElement => (
  <Card title={title} testID={testID}>
    {note ?? null}
    <Button label="Back to meetup" variant="secondary" testID="checkin-back" onPress={onBack} />
  </Card>
);
export default function CheckInScreen(): ReactElement {
  const params = useLocalSearchParams<{ id: string }>();
  const meetupId = typeof params.id === 'string' ? params.id : '';
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
  const [scanning, setScanning] = useState(false);
  const inFlight = useRef(false);
  const held = useRef<HeldCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => held.current?.cancel(), []);
  const detail: MeetupDto | null = meetupQ.data ?? null;
  const startsAt = detail === null ? Number.NaN : Date.parse(detail.startsAt);
  const known = Number.isFinite(startsAt);
  const city = citiesQ.data?.items.find((item) => item.id === detail?.venue.cityId);
  const startText = known && detail ? startTimeText(detail.startsAt, city?.timezone) : null;
  const left = known ? windowText(now, startsAt) : null;
  const loadMessage = detail === null && meetupQ.isError ? messageFor(meetupQ.error) : null;
  const errorMessage = failure ?? loadMessage;
  const canSubmit = code.length === CODE_DIGITS && !holding;
  const both = result !== null && result.bothCheckedIn ? BOTH_CHECKED_IN_TEXT : null;
  useEffect(() => {
    if (loadMessage !== null) announce(loadMessage);
  }, [loadMessage]);
  const sendCode = async (value: string): Promise<CheckInResponse> =>
    apiClient.checkIn(meetupId, { code: value, ...(await currentCoords()) });
  const succeed = (resp: CheckInResponse): void => {
    setResult(resp);
    setCode('');
    announce(resp.bothCheckedIn ? `${CHECKED_IN_TITLE} ${BOTH_CHECKED_IN_TEXT}` : CHECKED_IN_TITLE);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll }),
    ]);
  };
  const fail = (error: unknown): void => {
    const message = messageFor(error);
    setFailure(message);
    announce(message);
    if (isApiError(error) && error.code === 'already_checked_in')
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
    setScanning(false);
    announce('Venue code filled in.');
  };
  const retry = (): void => void meetupQ.refetch();
  const bannerProps = loadMessage === null ? {} : { action: { ...RETRY_PROPS, onPress: retry } };
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
      {Platform.OS === 'web' ? null : scanning ? (
        <NativeScanner onCode={onScanned} onClose={() => setScanning(false)} />
      ) : (
        <Button {...SCAN_PROPS} onPress={() => setScanning(true)} />
      )}
      <Button {...SUBMIT_PROPS} onPress={submit} busy={busy} disabled={!canSubmit} />
      {holding ? <Banner tone="info" message={OFFLINE_NOTICE} testID="checkin-offline" /> : null}
    </>
  );
  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      {errorMessage === null ? null : (
        <Banner tone="error" message={errorMessage} testID="checkin-error" {...bannerProps} />
      )}
      {detail === null ? (
        errorMessage === null ? (
          <Text style={styles.notice}>{LOADING_NOTICE}</Text>
        ) : null
      ) : detail.checkedIn ? (
        <OutcomeCard title={CHECKED_IN_TITLE} testID="checkin-result" onBack={back} />
      ) : detail.status !== 'locked' ? (
        <OutcomeCard title={NOT_LOCKED_NOTICE} testID="checkin-not-locked" onBack={back} />
      ) : result !== null ? (
        <OutcomeCard title={CHECKED_IN_TITLE} testID="checkin-result" note={both} onBack={back} />
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
  scanner: { gap: spacing.md },
  camera: { width: '100%', aspectRatio: 1, borderRadius: radii.md, overflow: 'hidden' },
});
