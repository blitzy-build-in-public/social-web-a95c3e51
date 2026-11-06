/**
 * The age gate at `/age-gate` (AAP 0.5.8, 0.7.1 row 1, 0.12.2): the 18+ confirmation and the terms
 * a traveler accepts before any feature route will answer them.
 *
 * Until `POST /v1/me/consents` records `ageConfirmedAt` and the accepted terms version, the API
 * refuses every traveler feature route with `403 age_gate_required`, so this is the one screen a
 * signed-in, unconsented session may be on. `app/_layout.tsx` owns who reaches it; the only two
 * navigations this file performs are the ones its own actions imply — a recorded consent, and
 * signing out.
 *
 * The terms are read before they are accepted: the three factual lines of `TERMS_SUMMARY` are
 * rendered in full and never collapsed, the full terms screen is one tap away, and only then does
 * the switch that accepts them appear (AAP 0.5.8). A failed confirmation is painted in a `Banner` —
 * whose live region speaks it on Android and web — and announced through `announce`, which is what
 * iOS has none of for a mounted notice.
 *
 * The copy comes from `src/copy/strings.ts`, so the version sent here is the one the API serves,
 * and the call goes through `apiClient`, so a `401` is the client's own single-flight refresh.
 */
import { useMutation } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Platform, StyleSheet, Switch, Text, View } from 'react-native';
import type { SwitchProps } from 'react-native';
import { MIN_TOUCH_TARGET, colors, fontWeights, spacing, typography } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { markConsented, signOut } from '../../src/auth/session';
import { queryClient, queryKeys } from '../../src/state/meetup-store';
import { AGE_GATE_CONFIRM, TERMS_SUMMARY, TERMS_VERSION } from '../../src/copy/strings';
import { Banner, Button, Card, ListItem, Screen, announce } from '../../src/ui';

// --- Constants -----------------------------------------------------------------------------------

/**
 * The safe-area edges this screen claims: the `(auth)` navigator's header owns the top inset, so
 * claiming it here as well would add its height twice. The sides and the bottom belong to the page.
 */
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;

/** The header title, which is also the page's heading (`app/(auth)/_layout.tsx` sets it too). */
const TITLE = 'Before you start';

/** What the traveler is agreeing to, in one line, before the terms themselves. */
const INTRO = 'Tablemate is for adults. Please confirm your age and read how deposits work.';

/** Opens the full terms, which are public and readable before any consent exists (AAP 0.5.8). */
const TERMS_LABEL = 'Read the full terms';
const TERMS_ROUTE = '/legal/terms';

/** The confirmation control, and the destination a recorded consent leads to. */
const CONTINUE_LABEL = 'Continue';
const DISCOVER_ROUTE = '/discover';

/** The way out for someone who is not 18, and the sentence that explains why it is there. */
const SIGN_OUT_LABEL = 'Sign out';
const SIGN_OUT_HINT = "Not 18 yet? You can't use Tablemate, so sign out.";
const SIGN_IN_ROUTE = '/sign-in';

/** The switch the e2e flows toggle, and the button they press (AAP 0.12.1). */
const ADULT_TEST_ID = 'age-gate-adult';
const SUBMIT_TEST_ID = 'age-gate-submit';

/**
 * The switch's two track colours: `border` when off and `primary` when on, with the thumb in
 * `onPrimary`. The palette holds no switch token, so each colour is one whose recorded
 * `NON_TEXT_CONTRAST_PAIRS` entry covers where it is painted — `border` on the page 3.7:1 and
 * `primary` on the page 7.3:1, both clear of the 3:1 non-text minimum (WCAG 1.4.11).
 */
const TRACK_COLOR = { false: colors.border, true: colors.primary } as const;

/**
 * The switch's role and state, on the platforms that need them stated.
 *
 * A native `Switch` is a switch control to VoiceOver and TalkBack, and its role and state are given
 * explicitly there. On web `react-native-web` 0.19 forwards these two props to the wrapper element
 * it draws around the control, where they make a nameless, non-activatable `role="switch"` the first
 * keyboard stop of the screen, in front of the real control (WCAG 2.1.1, 2.4.3); the DOM checkbox
 * it renders already carries `role="switch"`, the browser's own checked state and the visible label
 * as its accessible name, so on web they are withheld rather than duplicated.
 */
function switchRoleProps(checked: boolean): Partial<SwitchProps> {
  if (Platform.OS === 'web') return {};
  return { accessibilityRole: 'switch', accessibilityState: { checked } };
}

/**
 * The sentence a screen shows for a failure: the copy this app fixes for the API's code, and the
 * client's own network sentence for anything that is not an `ApiError` — a programming mistake
 * rather than an answer. Never the server's `message` text (AAP 0.11.1).
 */
function messageFor(error: unknown): string {
  return userMessageFor(isApiError(error) ? error.code : 'network_error');
}

/**
 * Before you start.
 *
 * @returns The 18+ confirmation and the terms a first-time traveler accepts, the two records
 * `POST /v1/me/consents` stores (AAP 0.5.4, 0.12.2).
 */
export default function AgeGateScreen(): ReactElement {
  const [adult, setAdult] = useState(false);

  const mutation = useMutation({
    // The body is the shared `ConsentsRequest` exactly: `adult` is the literal `true`, which is what
    // the API accepts, and the version is the one the traveler was shown.
    mutationFn: () => apiClient.postConsents({ adult: true, termsVersion: TERMS_VERSION }),
    onSuccess: async () => {
      // The store is told first, so the navigation gate lets the traveler out of this screen even
      // while the profile read is still in flight; then the own-profile read is refreshed, so the
      // consents `GET /me` returns are the ones just recorded, and the gate's screen is replaced
      // rather than stacked, so backing up from Discover cannot return here.
      markConsented();
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      router.replace(DISCOVER_ROUTE);
    },
  });

  const failure = mutation.error === null ? null : messageFor(mutation.error);
  const pending = mutation.isPending;

  // Each distinct failure is spoken once: a re-render over the same failed call repeats nothing, and
  // this is the announcement Android's live region carries and iOS has no equivalent of (AAP 0.5.8).
  useEffect(() => {
    if (failure !== null) announce(failure);
  }, [failure]);

  /** The label beside the switch toggles it, so the whole row is one target (AAP 0.5.8). */
  const toggleAdult = useCallback((): void => {
    setAdult((confirmed) => !confirmed);
  }, []);

  /**
   * Records the consent. Guarded rather than only disabled: a press that arrives while the control
   * is refusing one — a queued tap, a keyboard activation just as the state changes — sends nothing.
   */
  const submit = useCallback((): void => {
    if (!adult || pending) return;
    mutation.mutate();
  }, [adult, pending, mutation]);

  /** Ends the session and hands the traveler to sign-in, whatever the server or the teardown says. */
  const leaveForSignOut = useCallback((): void => {
    void (async () => {
      try {
        await signOut();
      } finally {
        router.replace(SIGN_IN_ROUTE);
      }
    })();
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: TITLE }} />
      <Screen edges={SCREEN_EDGES} testID="age-gate">
        <Text style={styles.body}>{INTRO}</Text>

        {/* The terms in full, never collapsed: these three lines are what the switch below accepts. */}
        <Card testID="age-gate-terms">
          {TERMS_SUMMARY.map((line) => (
            <Text key={line} style={styles.terms}>
              {line}
            </Text>
          ))}
        </Card>

        <ListItem
          label={TERMS_LABEL}
          onPress={() => router.push(TERMS_ROUTE)}
          role="link"
          testID="age-gate-full-terms"
        />

        <View style={styles.confirmRow}>
          {/* One row, one control: the `Switch` owns the accessible name, the checked state, the
              row's 44 pt target and the keyboard operation. A keyboard user toggles the setting
              there — Tab to the switch, Space to flip it — which is where WCAG 2.1.1 is
              satisfied, and is why the web flow stays fully keyboard-operable. The visible label is
              therefore a pointer-only convenience target: pressing it toggles the same state for a
              mouse or touch user, and it is not a control a keyboard or screen-reader user has to
              reach. It is a `Text` and deliberately not a `Pressable` with `accessibilityRole` or
              `role`, because a second control for one action would add a second stop to the tab
              order and a second same-named switch to the accessibility tree on web, where
              react-native-web makes the `switch` and `checkbox` roles focusable; every switch row
              in this app carries exactly one control, as `app/lodgings/claim.tsx` and
              `app/profile/stay.tsx` do. On web react-native-web therefore renders this label as a
              plain element carrying only a click handler, with no `tabindex` and no role, which is
              the intended consequence of that design rather than an oversight. */}
          <Text onPress={toggleAdult} style={styles.confirmLabel}>
            {AGE_GATE_CONFIRM}
          </Text>
          <Switch
            accessibilityLabel={AGE_GATE_CONFIRM}
            ios_backgroundColor={colors.border}
            onValueChange={setAdult}
            testID={ADULT_TEST_ID}
            thumbColor={colors.onPrimary}
            trackColor={TRACK_COLOR}
            value={adult}
            {...switchRoleProps(adult)}
          />
        </View>

        {failure === null ? null : (
          <Banner tone="error" message={failure} testID="age-gate-error" />
        )}

        {/* `busy` alone refuses the press while the request is in flight, so the button keeps its
            own colours and reads as running rather than as unavailable. */}
        <Button
          label={CONTINUE_LABEL}
          onPress={submit}
          disabled={!adult}
          busy={pending}
          testID={SUBMIT_TEST_ID}
        />

        <Button
          variant="secondary"
          label={SIGN_OUT_LABEL}
          onPress={leaveForSignOut}
          testID="age-gate-sign-out"
        />
        <Text style={styles.hint}>{SIGN_OUT_HINT}</Text>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typography.body,
    color: colors.text,
  },
  // The three terms lines stay ordinary body text: they are the page's content, not a notice, and
  // the card's own gap spaces them.
  terms: {
    ...typography.body,
    color: colors.text,
  },
  /**
   * The label and the switch on one row. The row keeps the 44 pt target and the label shrinks rather
   * than pushing the control off it, so an enlarged system font wraps the label instead of clipping it.
   */
  confirmRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET,
  },
  confirmLabel: {
    color: colors.text,
    flexShrink: 1,
    fontSize: typography.label.fontSize,
    fontWeight: fontWeights.medium,
    lineHeight: typography.label.lineHeight,
  },
  hint: {
    ...typography.caption,
    color: colors.textMuted,
  },
});
