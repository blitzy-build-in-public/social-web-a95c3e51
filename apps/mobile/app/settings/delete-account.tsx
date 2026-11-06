/**
 * Delete account (`/settings/delete-account`, AAP 0.5.8, AAP 0.8.1): the whole of the account
 * deletion a traveler performs, and the last screen of the safety basics (AAP 0.7.1 row 12).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Platform, StyleSheet, Text, View, type TextProps } from 'react-native';
import { Stack, router } from 'expo-router';
import {
  LATE_CANCEL_WINDOW_HOURS,
  colors,
  fontWeights,
  spacing,
  typography,
} from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { signOut } from '../../src/auth/session';
import { Banner, Button, Card, Screen, announce } from '../../src/ui';

const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;
const SIGN_IN_ROUTE = '/sign-in';
type Step = 'review' | 'confirm';
const CONSEQUENCES: readonly string[] = [
  "Meetups you've proposed or been invited to that aren't locked yet are cancelled.",
  `A locked meetup is cancelled for free if it starts in ${LATE_CANCEL_WINDOW_HOURS} hours or ` +
    'more. If it starts sooner, it counts as a late cancel and your deposit is forfeited.',
  'Meetups with an open dispute stay with our operators, who settle any deposit.',
  'Your lodging claims and booking details are deleted.',
  'Your profile, photo, messages and itinerary proofs are erased within 30 days.',
  'Pseudonymous payment and settlement records are kept, as our privacy policy describes.',
];
const CARD_TITLE = 'What happens when you delete your account';
const CLOSING_LINE = "You'll be signed out on every device. This can't be undone.";
/** The refusal that proves only that the session ended (AAP 0.5.3, AAP 0.3.3). */
const SESSION_ENDED_NOTICE =
  'Your session ended. Sign in again and delete your account if it still exists.';
const CONFIRM_TEST_ID = 'delete-account-confirm';
const CONTROLS = {
  review: { label: 'Delete my account', variant: 'secondary', testID: CONFIRM_TEST_ID },
  delete: { label: 'Permanently delete my account', variant: 'danger', testID: CONFIRM_TEST_ID },
  cancel: { label: 'Cancel', variant: 'secondary', testID: 'delete-account-cancel' },
} as const;
const BULLET_IS_DECORATION: Pick<
  TextProps,
  'aria-hidden' | 'accessibilityElementsHidden' | 'importantForAccessibility'
> =
  Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no' };
function failureMessage(error: unknown): string {
  if (!isApiError(error)) return userMessageFor('network_error');
  const message = userMessageFor(error.code);
  const seconds = error.retryAfterSeconds;
  if (error.code !== 'rate_limited' || seconds === undefined || seconds <= 0) return message;
  const minutes = Math.ceil(seconds / 60);
  const wait =
    seconds < 60
      ? `${seconds} second${seconds === 1 ? '' : 's'}`
      : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${message} Try again in ${wait}.`;
}
function isSessionGone(error: unknown): boolean {
  return isApiError(error) && error.status === 401 && error.code === 'token_invalid';
}
function focusFinalConfirm(): void {
  if (Platform.OS !== 'web') return;
  try {
    document.querySelector<HTMLElement>(`[data-testid="${CONFIRM_TEST_ID}"]`)?.focus();
  } catch {
    // No document to focus in: nothing to do.
  }
}
export default function DeleteAccountScreen(): ReactElement {
  const [step, setStep] = useState<Step>('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (step !== 'confirm') return;
    announce('Press Permanently delete my account to confirm.');
    requestAnimationFrame(focusFinalConfirm);
  }, [step]);
  async function sendDeletion(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let confirmed = false;
    let sessionGone = false;
    try {
      await apiClient.deleteMe();
      confirmed = true;
    } catch (caught) {
      sessionGone = isSessionGone(caught);
      if (!sessionGone) {
        inFlight.current = false;
        setBusy(false);
        const message = failureMessage(caught);
        setError(message);
        announce(message);
        return;
      }
    }
    await signOut({ remote: false });
    announce(confirmed ? 'Your account has been deleted.' : SESSION_ENDED_NOTICE);
    router.replace(SIGN_IN_ROUTE);
  }
  function toStep(next: Step): void {
    setStep(next);
    setError(null);
  }
  return (
    <>
      <Stack.Screen options={{ title: 'Delete account' }} />
      <Screen edges={SCREEN_EDGES} testID="delete-account">
        <Card title={CARD_TITLE} testID="delete-account-consequences">
          <View role="list" style={styles.list}>
            {CONSEQUENCES.map((item) => (
              <View key={item} role="listitem" style={styles.item}>
                <Text {...BULLET_IS_DECORATION} style={styles.bullet}>
                  {'•'}
                </Text>
                <Text style={styles.itemText}>{item}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.closing}>{CLOSING_LINE}</Text>
        </Card>
        {error === null ? null : (
          <Banner tone="error" message={error} testID="delete-account-error" />
        )}
        {step === 'review' ? (
          <Button {...CONTROLS.review} onPress={() => toStep('confirm')} />
        ) : (
          <>
            <Button {...CONTROLS.delete} busy={busy} onPress={() => void sendDeletion()} />
            <Button {...CONTROLS.cancel} disabled={busy} onPress={() => toStep('review')} />
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  item: { flexDirection: 'row', gap: spacing.sm },
  bullet: { ...typography.body, color: colors.text },
  itemText: { ...typography.body, color: colors.text, flex: 1 },
  closing: { ...typography.body, color: colors.text, fontWeight: fontWeights.bold },
});
