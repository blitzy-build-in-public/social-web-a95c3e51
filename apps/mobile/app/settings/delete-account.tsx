/**
 * Delete account (`/settings/delete-account`, AAP 0.5.8, AAP 0.8.1): the whole of the account
 * deletion a traveler performs, and the last screen of the safety basics (AAP 0.7.1 row 12).
 *
 * `DELETE /me` does all of the work (AAP 0.5.4) — it answers `202`, applies the cancellation rules to
 * every open meetup with `cancelReason = account_deleted`, deletes the lodging claims with their
 * booking details, revokes every session, and enqueues `account-erasure` — so none of that is decided
 * or replicated here, and this screen neither reads nor lists the traveler's meetups.
 *
 * The confirmation is two steps and inline, the pattern `app/users/[userId].tsx` uses for a block,
 * because react-native-web renders no `Alert` and an irreversible action may not rest on one: the
 * first press replaces itself with the final danger button, so one element carries
 * `delete-account-confirm` at a time and the e2e flows press it twice. The consequences come before
 * every confirm control, so the button cannot be reached without them (AAP 0.5.3, AAP 0.5.2).
 *
 * Nothing here logs — not a token, an id or the address — and the address never enters a URL.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { TextProps } from 'react-native';
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

/** The route's title in the navigator header, which is also the page's only level-1 heading. */
const TITLE = 'Delete account';

/** The root Stack's header owns the status-bar inset, so claiming `top` here would add it twice. */
const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

/** Where the deletion leaves the traveler. The address is never a parameter (AAP 0.5.4). */
const SIGN_IN_ROUTE = '/sign-in';

/** The mark in front of an item. It is decoration: the list and item roles carry the structure. */
const BULLET = '•';

/** The two steps of the inline confirmation. */
type Step = 'review' | 'confirm';

/**
 * What deleting the account does, one item per line (AAP 0.5.3 for the meetups and the claims, AAP
 * 0.5.2 for the erasure and the retained records). The free-cancellation boundary is the shared
 * `LATE_CANCEL_WINDOW_HOURS`, so the wording cannot drift from the rule the API enforces: a meetup
 * starting exactly that far away is still free, which is why it reads "or more".
 */
const CONSEQUENCES: readonly string[] = [
  "Meetups you've proposed or been invited to that aren't locked yet are cancelled.",
  `A locked meetup is cancelled for free if it starts in ${LATE_CANCEL_WINDOW_HOURS} hours or ` +
    'more. If it starts sooner, it counts as a late cancel and your deposit is forfeited.',
  'Meetups with an open dispute stay with our operators, who settle any deposit.',
  'Your lodging claims and booking details are deleted.',
  'Your profile, photo, messages and itinerary proofs are erased within 30 days.',
  'Pseudonymous payment and settlement records are kept, as our privacy policy describes.',
];

/** The card's heading, and the line that closes it. */
const CARD_TITLE = 'What happens when you delete your account';
const CLOSING_LINE = "You'll be signed out on every device. This can't be undone.";

/** The visible labels of the controls, each of which is also the control's accessible name. */
const REVIEW_LABEL = 'Delete my account';
const CONFIRM_LABEL = 'Permanently delete my account';
const CANCEL_LABEL = 'Cancel';

/** Spoken, and on web focused into, when the confirmation opens. */
const STEP_TWO_PROMPT = 'Press Permanently delete my account to confirm.';

/** Spoken once the account is gone, before the sign-in screen takes its place. */
const DELETED_NOTICE = 'Your account has been deleted.';

/**
 * Spoken for the refusal that says only that the session has ended, which the deletion's fence and a
 * session that ran out both produce, so it claims neither and leaves the traveller a way back to the
 * account if it still exists.
 */
const SESSION_ENDED_NOTICE =
  'Your session ended. Sign in again and delete your account if it still exists.';

/** The test ids the e2e flows use: one element carries the confirm id at a time (AAP 0.12.1). */
const CONFIRM_TEST_ID = 'delete-account-confirm';
const CANCEL_TEST_ID = 'delete-account-cancel';

/**
 * Removes the bullet from the accessibility tree, so a screen reader reads each item once. Native
 * reads a different prop per platform while react-native-web renders the ARIA attribute alone; the
 * two React Native props are left off web, where they would reach the DOM as invalid attributes.
 */
const BULLET_IS_DECORATION: Pick<
  TextProps,
  'aria-hidden' | 'accessibilityElementsHidden' | 'importantForAccessibility'
> =
  Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no' };

/**
 * The sentence this screen shows for a failure: the app's own copy for the code, the client's network
 * sentence when no envelope arrived, and for a `429` the wait it asked for appended, rounded up so it
 * is never understated. Never the server's `message` text (AAP 0.11.1).
 */
function failureMessage(error: unknown): string {
  if (!isApiError(error)) return userMessageFor('network_error');
  const message = userMessageFor(error.code);
  const seconds = error.retryAfterSeconds;
  // Only ever a hint: the header is unreadable cross-origin unless the answer exposes it (AAP 0.5.4).
  if (error.code !== 'rate_limited' || seconds === undefined || seconds <= 0) return message;

  const minutes = Math.ceil(seconds / 60);
  const wait =
    seconds < 60
      ? `${seconds} second${seconds === 1 ? '' : 's'}`
      : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${message} Try again in ${wait}.`;
}

/**
 * True for the `401 token_invalid` that ends a session — all the refusal proves. `DELETE /me` sets
 * `deletionRequestedAt`, whose fence refuses every bearer route with that code (AAP 0.5.3), and a
 * session that simply ran out is refused with it too (AAP 0.3.3, AAP 0.11.2). The client rotates once
 * on the code and, when the rotation is refused, signs the traveller out and rethrows this same
 * refusal (`../../src/api/client.ts`), so the two sources are indistinguishable here; only the
 * accepted `202` of `DELETE /me` (AAP 0.5.4) proves the deletion applied.
 */
function isSessionGone(error: unknown): boolean {
  return isApiError(error) && error.status === 401 && error.code === 'token_invalid';
}

/**
 * Moves keyboard focus to the confirmation's final control, which the first one has just become. The
 * controls are UI primitives and take no ref, so on web the control is found by the `data-testid`
 * react-native-web renders; off web there is nothing to focus and the opening is announced instead.
 * A render with no document — the web export's static pass — focuses nothing rather than throwing.
 */
function focusFinalConfirm(): void {
  if (Platform.OS !== 'web') return;
  try {
    document.querySelector<HTMLElement>(`[data-testid="${CONFIRM_TEST_ID}"]`)?.focus();
  } catch {
    // No document to focus in: nothing to do.
  }
}

/**
 * Account deletion.
 *
 * @returns The consequences of deleting the account, the two-step confirmation above the first
 * control's replacement, and whichever failure the last attempt met.
 */
export default function DeleteAccountScreen(): ReactElement {
  const [step, setStep] = useState<Step>('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept beside `busy` on purpose, because they are separate locks: the ref stops a second press
  // reaching the API before React has re-rendered, and `busy` shows the first press running.
  const inFlight = useRef(false);

  // Opening the confirmation is a state change of its own, so it is announced — the announcement iOS
  // has and Android's live region does not carry — and on web focus moves to the control that
  // completes the deletion, so the next Tab is the final action rather than the Cancel beside it.
  useEffect(() => {
    if (step !== 'confirm') return;
    announce(STEP_TWO_PROMPT);
    requestAnimationFrame(focusFinalConfirm);
  }, [step]);

  /**
   * Sends the deletion once (AAP 0.5.4).
   *
   * The route's `202` is the only proof it applied, so it alone announces `DELETED_NOTICE`; the
   * refusal that means the session has ended leaves the same way without claiming the deletion
   * (AAP 0.5.3). The local sign-out is deliberate: `DELETE /me` has already revoked every session and
   * refresh token of the account, so `signOut({ remote: false })` clears this device without a
   * `POST /auth/logout` that could only be refused. Any other failure leaves the confirmation open
   * with the button armed again; the guard stays closed once the screen is on its way out.
   */
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
        const message = failureMessage(caught);
        setError(message);
        announce(message);
      }
    }

    if (!confirmed && !sessionGone) {
      inFlight.current = false;
      setBusy(false);
      return;
    }

    await signOut({ remote: false });
    announce(confirmed ? DELETED_NOTICE : SESSION_ENDED_NOTICE);
    router.replace(SIGN_IN_ROUTE);
  }

  /** Opens the confirmation, which replaces the first control with the one that deletes the account. */
  function openConfirm(): void {
    setStep('confirm');
    setError(null);
  }

  /** Returns to the first step, clearing the failure that step's own control produced. */
  function cancelConfirm(): void {
    setStep('review');
    setError(null);
  }

  return (
    <>
      <Stack.Screen options={{ title: TITLE }} />
      <Screen edges={SCREEN_EDGES} testID="delete-account">
        {/* Rendered before every confirm control, in source order, so reading and focus order both
            meet the consequences first (AAP 0.5.3, AAP 0.5.2). */}
        <Card title={CARD_TITLE} testID="delete-account-consequences">
          {/* `role="list"` and `role="listitem"` render as a real <ul> with <li> children on web,
              whose implicit ARIA roles are list and listitem, and as the collection roles on iOS and
              Android. Keys are indexes: the list is the fixed set of `CONSEQUENCES`. */}
          <View role="list" style={styles.list}>
            {CONSEQUENCES.map((item, index) => (
              <View key={index} role="listitem" style={styles.item}>
                <Text {...BULLET_IS_DECORATION} style={styles.bullet}>
                  {BULLET}
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
          <Button
            label={REVIEW_LABEL}
            variant="secondary"
            testID={CONFIRM_TEST_ID}
            onPress={openConfirm}
          />
        ) : (
          <>
            <Button
              label={CONFIRM_LABEL}
              variant="danger"
              testID={CONFIRM_TEST_ID}
              busy={busy}
              onPress={() => void sendDeletion()}
            />
            <Button
              label={CANCEL_LABEL}
              variant="secondary"
              testID={CANCEL_TEST_ID}
              disabled={busy}
              onPress={cancelConfirm}
            />
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  list: {
    // The gap between the items rather than a margin on each, so the last one adds no space.
    gap: spacing.sm,
  },
  item: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  // `text` on the card's `background` fill: a `CONTRAST_PAIRS` record at 17.21:1.
  bullet: {
    ...typography.body,
    color: colors.text,
  },
  // The item takes the row's remaining width and wraps there, so a long sentence never pushes the
  // bullet off the line.
  itemText: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  closing: {
    ...typography.body,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
});
