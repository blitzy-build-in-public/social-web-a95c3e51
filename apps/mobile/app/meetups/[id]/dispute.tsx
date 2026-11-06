/**
 * Report a problem: the dispute screen of AAP 0.5.8's "Meetups -> meetup -> Report a problem",
 * which files a report through `POST /meetups/:id/dispute` with a reason of up to
 * REASON_MAX_CHARS (500) characters and a kind (AAP 0.5.4).
 *
 * The kind is the pilot's addition to the contract's free-text body (AAP 0.7.3): `venue_unavailable`
 * marks the penalty-free exit when the venue could not witness the check-in, and `other` — the
 * default — is everything else. Filing leaves the meetup `locked`, so both attendees can still
 * check in, and pauses settlement until an operator decides within DISPUTE_RESOLUTION_DAYS (5) days
 * (AAP 0.5.3). The screen says both before the traveler writes anything.
 *
 * The screen decides nothing about whether a report is allowed: the API answers `409 not_locked` for
 * a meetup still `proposed`, `409 dispute_window_closed` past the filing window and `409
 * dispute_open` while one is already open, and every sentence shown for those is the code's own from
 * `src/api/errors.ts` rather than a second copy written here. The already-open state is read from
 * `MeetupDto.disputeOpen`, so a report filed on another device replaces the form too, and no text
 * the server sends is ever displayed (AAP 0.11.1).
 *
 * The two options are one radio group, spelled `role="radio"` with `aria-checked` — the React Native
 * 0.76 aliases — and not the older `accessibilityRole`/`accessibilityState` pair, which
 * react-native-web 0.19 does not translate into the DOM, leaving the checked state unreported on
 * web. Each option is at least MIN_TOUCH_TARGET (44) tall, is focusable on web, and takes Enter and
 * Space both, because that responder answers Enter for any element but Space only for a button.
 *
 * Client-safe: `react`, `react-native`, `expo-router`, the app's own client modules and
 * `@tablemate/shared`, with no Node built-in, no DOM global and no effect at module load. No part of
 * the reason is logged.
 */
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
import { queryClient, queryKeys, useMeetup } from '../../../src/state/meetup-store';
import { Banner, Button, Card, Screen, TextField, announce } from '../../../src/ui';

/** The screen's name: the navigation header's title and the page's own heading. */
const SCREEN_TITLE = 'Report a problem';

/** The group's visible label, and the accessible name of the radio group it heads. */
const KIND_QUESTION = 'What happened?';

/** What each kind says, keyed by the shared enum, so a kind added to it fails to compile here. */
const KIND_LABELS = {
  venue_unavailable: "The venue couldn't witness our check-in",
  other: 'Something else',
} as const satisfies Record<DisputeKind, string>;

/**
 * The order the options appear in: the penalty-free case first, since that is what a traveler whose
 * venue could not witness them is looking for, and `other`, the contract's default, second.
 */
const KIND_ORDER: readonly DisputeKind[] = ['venue_unavailable', 'other'];

/** The test ids the reachability walks fill, exactly as the contract fixes them. */
const KIND_TEST_IDS = {
  venue_unavailable: 'dispute-kind-venue_unavailable',
  other: 'dispute-kind-other',
} as const satisfies Record<DisputeKind, string>;

/**
 * The visible word beside the chosen option: a state is never carried by colour alone (WCAG 1.4.1),
 * and it is hidden from assistive technology because the option already reports itself checked.
 */
const SELECTED_MARKER = 'Selected';

/**
 * This screen's own copy. The fixed deposit, safety and notice strings of AAP 0.5.8 belong to
 * `@tablemate/shared` and `src/copy`, and every error sentence belongs to `src/api/errors.ts`; what
 * is left is this form's wording, which no other screen shows.
 */
const OPEN_REPORT_EXPLANATION =
  'An open report keeps the meetup locked, so you can still check in, and pauses settlement until an operator decides.';
const VENUE_UNAVAILABLE_EXPLANATION =
  "If the venue couldn't witness your check-in, an operator can close the meetup with no deposit taken.";
const ALREADY_OPEN_NOTICE = 'A problem report is already open.';
const RESOLUTION_NOTICE = `An operator will review this within ${DISPUTE_RESOLUTION_DAYS} days.`;
const REASON_LABEL = 'Describe the problem';
const SUBMIT_LABEL = 'Send report';
/** What the disabled action waits for: a disabled button takes no focus and no hint of its own. */
const SUBMIT_HINT = 'Describe the problem first';
const BACK_LABEL = 'Back to meetup';
const LOADING_NOTICE = 'Loading…';
const RETRY_LABEL = 'Try again';

/**
 * The three fields of a `keydown` event this screen reads. React Native declares no key event, so
 * the web-only handler below is typed here rather than reached for through a cast.
 */
interface WebKeyEvent {
  readonly key?: string;
  readonly repeat?: boolean;
  readonly preventDefault?: () => void;
}

/**
 * Keeps the browser's own focus outline off a focused option on web, where it would be painted over
 * the band the option's border reserves and the ring a keyboard user sees would be the browser's
 * default rather than `colors.focusRing` (WCAG 2.4.7). React Native 0.76 declares no `outline`
 * style, so the long form is asserted once; the value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

/** Props of {@link KindOption}. */
interface KindOptionProps {
  /** Which kind this option chooses. */
  readonly kind: DisputeKind;
  /** Whether this is the chosen one; it is what `aria-checked` and the marker report. */
  readonly selected: boolean;
  /** Chooses this option. Called on a press, and on Space or Enter on web. */
  readonly onSelect: () => void;
}

/**
 * One option of the kind group: a radio that reports its own checked state and shows a visible
 * marker while chosen.
 *
 * The option keeps a token border in every state — `border` at rest, `primary` while chosen,
 * `focusRing` while focused, each a recorded pair — so revealing the chosen or focused state never
 * moves the row's contents.
 */
function KindOption({ kind, selected, onSelect }: KindOptionProps): ReactElement {
  const [focused, setFocused] = useState(false);

  // react-native-web's press responder fires on Enter for any element but on Space only for a
  // native `button` or `role="button"`, so this option takes Space itself. Enter is left to the
  // responder, which would otherwise fire the press twice. Native has no key events and no Space
  // to handle.
  const spaceKey: { onKeyDown?: (event: WebKeyEvent) => void } =
    Platform.OS === 'web'
      ? {
          onKeyDown: (event) => {
            if (event.repeat === true) return;
            if (event.key !== ' ' && event.key !== 'Spacebar') return;
            // Space would otherwise scroll the page behind the option.
            event.preventDefault?.();
            onSelect();
          },
        }
      : {};

  return (
    <Pressable
      {...spaceKey}
      role="radio"
      aria-checked={selected}
      onPress={onSelect}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      testID={KIND_TEST_IDS[kind]}
      style={[
        styles.option,
        selected ? styles.optionSelected : null,
        focused ? styles.optionFocused : null,
        webFocusRingReset,
      ]}
    >
      <Text style={[styles.optionLabel, selected ? styles.optionLabelSelected : null]}>
        {KIND_LABELS[kind]}
      </Text>
      {selected ? (
        <Text aria-hidden style={styles.marker}>
          {SELECTED_MARKER}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** The sentence a failed read shows: the code's own sentence, or the generic one for anything else. */
function messageFor(error: unknown): string {
  return isApiError(error) ? userMessageFor(error.code) : userMessageFor('invalid_response');
}

/**
 * The report screen for one meetup.
 *
 * The route parameter names the meetup; a malformed deep link can leave it absent, and `useMeetup`
 * refuses an empty id rather than reading `/meetups//`. The kind starts at `other`, the contract's
 * own default (AAP 0.5.4), and the reason is sent trimmed, so a report of spaces alone is refused
 * by the disabled action rather than by the API's `400 invalid_field`.
 *
 * @returns The report-a-problem screen.
 */
export default function DisputeScreen(): ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const meetupId = id ?? '';
  const meetup = useMeetup(meetupId);

  const [kind, setKind] = useState<DisputeKind>('other');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<ClientErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref as well as `busy`: two taps in one frame both read `busy` as false, and the second report
  // would then be refused by the API with `409 dispute_open` instead of by this screen.
  const inFlight = useRef(false);

  const trimmedReason = reason.trim();
  const reasonEmpty = trimmedReason.length === 0;

  // The failed read is the one failure an effect can announce exactly once: a re-render over the
  // same failed read would otherwise repeat the sentence. A failed submit is announced where it
  // happens instead (see `submit`), because pressing Send again can produce the same sentence.
  const loadFailed = meetup.data === undefined && meetup.isError;
  const loadMessage = loadFailed ? messageFor(meetup.error) : null;
  const announcedLoad = useRef<string | null>(null);

  useEffect(() => {
    if (loadMessage === null) {
      announcedLoad.current = null;
      return;
    }
    if (announcedLoad.current === loadMessage) return;
    announcedLoad.current = loadMessage;
    announce(loadMessage);
  }, [loadMessage]);

  const failureMessage = failure === null ? null : userMessageFor(failure);
  const errorMessage = failureMessage ?? loadMessage;

  /**
   * Refreshes the meetup and every list that may hold it, so the screen renders the server's own
   * serialization of the report (AAP 0.5.4) rather than a state assembled here.
   */
  const refreshMeetup = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.meetup(meetupId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.meetupsAll }),
    ]);
  };

  /** Files the report, once per press. */
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
        const message = userMessageFor(code);
        announce(message);
        setFailure(code);
        // A report already open on the server is a state this screen renders rather than an error
        // to retry: the read is refreshed so the form gives way to the open-report notice.
        if (code === 'dispute_open') await refreshMeetup();
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };

  const retryLoad = (): void => {
    void meetup.refetch();
  };

  /** The way back to the meetup, wherever the form is not shown. */
  const backToMeetup = (
    <Button
      label={BACK_LABEL}
      variant="secondary"
      testID="dispute-back"
      onPress={() => {
        router.navigate(`/meetups/${meetupId}`);
      }}
    />
  );

  /** The form, once the meetup is known and no report is open yet. */
  const form = (
    <>
      <Text style={styles.groupLabel}>{KIND_QUESTION}</Text>
      {/* One group with one name: VoiceOver, TalkBack and the DOM all read the question before
          either option, and no option repeats it. */}
      <View role="radiogroup" aria-label={KIND_QUESTION} style={styles.options}>
        {KIND_ORDER.map((option) => (
          <KindOption
            key={option}
            kind={option}
            selected={kind === option}
            onSelect={() => setKind(option)}
          />
        ))}
      </View>

      <Text style={styles.explanation}>{OPEN_REPORT_EXPLANATION}</Text>
      {kind === 'venue_unavailable' ? (
        <Text style={styles.explanation}>{VENUE_UNAVAILABLE_EXPLANATION}</Text>
      ) : null}

      {/* The count is the field's own hint, so it stays visible and stays bound to the input rather
          than floating beside it; `maxLength` keeps the reason inside the limit the API validates. */}
      <TextField
        label={REASON_LABEL}
        value={reason}
        onChangeText={setReason}
        hint={`${reason.length} / ${REASON_MAX_CHARS}`}
        multiline
        maxLength={REASON_MAX_CHARS}
        autoCapitalize="sentences"
        testID="dispute-reason"
      />

      <Button
        label={SUBMIT_LABEL}
        onPress={submit}
        disabled={reasonEmpty}
        busy={busy}
        hint={SUBMIT_HINT}
        testID="dispute-submit"
      />
    </>
  );

  // Narrowed once for the branches below: `null` is the read not having answered yet.
  const detail: MeetupDto | null = meetup.data ?? null;

  return (
    <Screen title={SCREEN_TITLE}>
      {/* The header names the route and carries the back affordance; the Screen's own title is the
          page's heading, which is what a web heading structure and a screen reader's outline read. */}
      <Stack.Screen options={{ title: SCREEN_TITLE }} />

      {errorMessage === null ? null : (
        <Banner
          tone="error"
          message={errorMessage}
          testID="dispute-error"
          {...(loadMessage === null
            ? {}
            : { action: { label: RETRY_LABEL, onPress: retryLoad, testID: 'dispute-retry' } })}
        />
      )}

      {detail === null ? (
        // Nothing is rendered from a meetup that has not arrived: the banner above carries any
        // failure, and with no failure the read is still in flight.
        errorMessage === null ? (
          <Text style={styles.notice}>{LOADING_NOTICE}</Text>
        ) : null
      ) : submitted ? (
        <Card title={RESOLUTION_NOTICE} testID="dispute-submitted">
          {backToMeetup}
        </Card>
      ) : detail.disputeOpen ? (
        <Card title={ALREADY_OPEN_NOTICE} testID="dispute-open">
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
    color: colors.textMuted,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
  groupLabel: {
    ...typography.label,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  options: {
    gap: spacing.sm,
  },
  // The border is painted in every state, so choosing an option or focusing one moves nothing: it
  // is `border` at rest (3.7:1 on the page), `primary` while chosen, `focusRing` while focused.
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
  optionSelected: {
    borderColor: colors.primary,
  },
  optionFocused: {
    borderColor: colors.focusRing,
  },
  optionLabel: {
    ...typography.label,
    color: colors.text,
  },
  optionLabelSelected: {
    color: colors.primary,
    fontWeight: fontWeights.bold,
  },
  // A visible word, not a colour: the chosen option says so in the caption step.
  marker: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: fontWeights.medium,
  },
  explanation: {
    ...typography.body,
    color: colors.text,
  },
});
