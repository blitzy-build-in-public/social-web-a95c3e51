/** Report a problem: files a report through `POST /meetups/:id/dispute` with a reason of up to REASON_MAX_CHARS (500) characters and a kind. */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import {
  DISPUTE_RESOLUTION_DAYS,
  MIN_TOUCH_TARGET,
  REASON_MAX_CHARS,
  borderWidths,
  colors,
  fontWeights,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type { DisputeKind, DisputeRequest, MeetupDto } from '@tablemate/shared';

import { apiClient } from '../../../src/api/client';
import { isApiError, userMessageFor } from '../../../src/api/errors';
import type { ClientErrorCode } from '../../../src/api/errors';
import { REASON_FIELD_LABEL, remainingCharsText } from '../../../src/copy/strings';
import { queryClient, queryKeys, useMeetup } from '../../../src/state/meetup-store';
import { Banner, Button, Card, Screen, TextField, announce } from '../../../src/ui';

const SCREEN_TITLE = 'Report a problem';
const KIND_QUESTION = 'What happened?';
const KIND_LABELS = {
  venue_unavailable: "The venue couldn't witness our check-in",
  other: 'Something else',
} as const satisfies Record<DisputeKind, string>;
const KIND_ORDER: readonly DisputeKind[] = ['venue_unavailable', 'other'];
const KIND_TEST_IDS = {
  venue_unavailable: 'dispute-kind-venue_unavailable',
  other: 'dispute-kind-other',
} as const satisfies Record<DisputeKind, string>;
const OPEN_REPORT_EXPLANATION =
  'An open report keeps the meetup locked, so you can still check in, and pauses settlement until an operator decides.';
const VENUE_UNAVAILABLE_EXPLANATION =
  "If the venue couldn't witness your check-in, an operator can close the meetup with no deposit taken.";
const RESOLUTION_NOTICE = `An operator will review this within ${DISPUTE_RESOLUTION_DAYS} days.`;
const SUBMIT_HINT = 'Describe the problem first';
const BACK_LABEL = 'Back to meetup';
const ERROR_BANNER = { tone: 'error', testID: 'dispute-error' } as const;
const BACK_BUTTON = { label: BACK_LABEL, variant: 'secondary', testID: 'dispute-back' } as const;
const SUBMIT_BUTTON = {
  label: 'Send report',
  hint: SUBMIT_HINT,
  testID: 'dispute-submit',
} as const;
const REASON_FIELD = {
  label: REASON_FIELD_LABEL,
  multiline: true,
  maxLength: REASON_MAX_CHARS,
  autoCapitalize: 'sentences',
  testID: 'dispute-reason',
} as const;
type WebKeyEvent = Readonly<{ key?: string; repeat?: boolean; preventDefault?: () => void }>;
type KindOptionProps = Readonly<{ kind: DisputeKind; selected: boolean; onSelect: () => void }>;
/** Space chooses the option: react-native-web fires no press for Space off a native button. */
function selectOnSpace(event: WebKeyEvent, onSelect: () => void): void {
  if (event.repeat === true || (event.key !== ' ' && event.key !== 'Spacebar')) return;
  event.preventDefault?.();
  onSelect();
}

function KindOption({ kind, selected, onSelect }: KindOptionProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const labelStyle = [styles.optionLabel, selected ? styles.optionLabelSelected : null];
  const spaceKey: { onKeyDown?: (event: WebKeyEvent) => void } =
    Platform.OS === 'web' ? { onKeyDown: (event) => selectOnSpace(event, onSelect) } : {};
  return (
    <Pressable
      {...spaceKey}
      role="radio"
      aria-checked={selected}
      onPress={onSelect}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      // Hover is a web state: React Native declares the pair on `PressableProps` and react-native-web forwards it to its hover hook, while iOS and Android never fire it.
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      testID={KIND_TEST_IDS[kind]}
      style={({ pressed }) => [
        styles.option,
        hovered ? styles.optionHovered : null,
        pressed ? styles.optionPressed : null,
        selected ? styles.optionSelected : null,
        focused ? styles.optionFocused : null,
        Platform.OS === 'web' ? ({ outlineStyle: 'none' } as ViewStyle) : {},
      ]}
    >
      <Text style={labelStyle} children={KIND_LABELS[kind]} />
      {selected ? <Text aria-hidden style={styles.marker} children="Selected" /> : null}
    </Pressable>
  );
}
function messageFor(error: unknown): string {
  return isApiError(error) ? userMessageFor(error.code) : userMessageFor('invalid_response');
}
export default function DisputeScreen(): ReactElement {
  const meetupId = useLocalSearchParams<{ id: string }>().id ?? '';
  const meetup = useMeetup(meetupId);
  const [kind, setKind] = useState<DisputeKind>('other');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<ClientErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const trimmedReason = reason.trim();
  const reasonEmpty = trimmedReason.length === 0;
  const loadMessage = meetup.data === undefined && meetup.isError ? messageFor(meetup.error) : null;
  const announcedLoad = useRef<string | null>(null);
  useEffect(() => {
    if (announcedLoad.current === loadMessage) return;
    announcedLoad.current = loadMessage;
    if (loadMessage !== null) announce(loadMessage);
  }, [loadMessage]);
  const errorMessage = failure === null ? loadMessage : userMessageFor(failure);
  const refreshMeetup = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll }),
    ]);
  };
  const submit = (): void => {
    if (inFlight.current || reasonEmpty || busy) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    void (async () => {
      try {
        const body: DisputeRequest = { reason: trimmedReason, kind };
        await apiClient.fileDispute(meetupId, body);
        setSubmitted(true);
        announce(RESOLUTION_NOTICE);
        await refreshMeetup();
      } catch (error) {
        const code = isApiError(error) ? error.code : 'invalid_response';
        announce(userMessageFor(code));
        setFailure(code);
        if (code === 'dispute_open') await refreshMeetup();
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };
  const kindProps = (value: DisputeKind) => ({ kind: value, onSelect: () => setKind(value) });
  const venueText = { style: styles.explanation, children: VENUE_UNAVAILABLE_EXPLANATION };
  const refetch = () => void meetup.refetch();
  const retryAction = { label: 'Try again', onPress: refetch, testID: 'dispute-retry' };
  const retry = loadMessage === null ? {} : { action: retryAction };
  const loading = errorMessage === null ? <Text style={styles.notice} children="Loading…" /> : null;
  const goBack = () => void router.navigate(`/meetups/${meetupId}`);
  const back = <Button {...BACK_BUTTON} onPress={goBack} />;
  const form = (
    <>
      <Text style={styles.groupLabel}>{KIND_QUESTION}</Text>
      <View role="radiogroup" aria-label={KIND_QUESTION} style={styles.options}>
        {KIND_ORDER.map((option) => (
          <KindOption key={option} {...kindProps(option)} selected={kind === option} />
        ))}
      </View>
      <Text style={styles.explanation}>{OPEN_REPORT_EXPLANATION}</Text>
      {kind === 'venue_unavailable' ? <Text {...venueText} /> : null}
      <TextField
        {...REASON_FIELD}
        value={reason}
        onChangeText={setReason}
        hint={remainingCharsText(reason, REASON_MAX_CHARS)}
      />
      <Button {...SUBMIT_BUTTON} onPress={submit} disabled={reasonEmpty} busy={busy} />
    </>
  );
  const detail: MeetupDto | null = meetup.data ?? null;
  return (
    <Screen>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      {errorMessage === null ? null : (
        <Banner {...ERROR_BANNER} message={errorMessage} {...retry} />
      )}
      {detail === null ? (
        loading
      ) : submitted ? (
        <Card title={RESOLUTION_NOTICE} testID="dispute-submitted" children={back} />
      ) : detail.disputeOpen ? (
        <Card title="A problem report is already open." testID="dispute-open" children={back} />
      ) : (
        form
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  notice: { ...typography.body, color: colors.textMuted },
  groupLabel: { ...typography.label, color: colors.text, fontWeight: fontWeights.bold },
  options: { gap: spacing.sm },
  option: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    gap: spacing.xs,
    paddingBlock: spacing.sm,
    paddingInline: spacing.md,
    borderWidth: borderWidths.control,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
  },
  optionHovered: { backgroundColor: colors.surface },
  optionPressed: { backgroundColor: colors.surface },
  optionSelected: { borderColor: colors.primary },
  optionFocused: { borderColor: colors.focusRing },
  optionLabel: { ...typography.label, color: colors.text },
  optionLabelSelected: { color: colors.primary, fontWeight: fontWeights.bold },
  marker: { ...typography.caption, color: colors.primary, fontWeight: fontWeights.medium },
  explanation: { ...typography.body, color: colors.text },
});
