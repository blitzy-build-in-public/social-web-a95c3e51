/**
 * The Table Credit balance (`/profile/credit`, AAP 0.5.8, AAP 0.8.1).
 *
 * Table Credit is what the attendee of a meetup receives when the other party does not show up:
 * the absent party's hold is captured and the attendee is credited the same amount (AAP 0.5.7). The
 * balance is the grants less the reversing voids of `TableCreditEntry` (AAP 0.5.2), and the API
 * owns it: this screen renders `MeDto.tableCreditCents` from `GET /me` and never adds a figure up
 * of its own (AAP 0.5.4, AAP 0.11.1). Settlement moves the balance, and
 * `src/state/meetup-store.ts` already invalidates that read whenever a meetup reaches a final
 * status, so no polling lives here.
 *
 * Three things are on the page and nothing else: the balance in large type, the sentence that says
 * what Table Credit is, and the link to the terms. There is deliberately no control that spends,
 * transfers or redeems it — venue redemption is out of scope for this pilot (AAP 0.7.2), so the
 * figure is stated and explained, not acted on.
 *
 * The notice is the app's own copy from `src/copy/strings.ts`, which holds the exact sentence of
 * AAP 0.5.8 once and is read here rather than retyped. The zero-balance line states the settlement
 * rule rather than the deposit framing, so it reads the same whichever experiment variant the
 * traveler was assigned: the framing copy belongs to the deposit screens alone (AAP 0.5.7).
 *
 * Reading, focus and heading order follow source order. A read in flight shows one line; a failed
 * read shows the error banner with the retry that re-runs it, and the failure is spoken once per
 * distinct code. Nothing here logs: no field of `MeDto` reaches a log line or a crash report
 * (AAP 0.11.1).
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Text } from 'react-native';
import { router, Stack } from 'expo-router';
import { colors, fontWeights, formatUsdWhole, typography } from '@tablemate/shared';

import { isApiError, userMessageFor } from '../../src/api/errors';
import { TABLE_CREDIT_NOTICE } from '../../src/copy/strings';
import { useMe } from '../../src/state/meetup-store';
import { Banner, Card, ListItem, Screen, announce } from '../../src/ui';

/**
 * The safe-area edges this screen claims: the navigator's header owns the top inset and the window
 * owns the sides, so claiming the vertical pair here would add their height twice.
 */
const SCREEN_EDGES = ['left', 'right'] as const;

/** Shown while `GET /me` is in flight. */
const LOADING_TEXT = 'Loading…';

/**
 * The navigator header's title, which is also the page's only level-1 heading.
 *
 * The header owns that heading: react-navigation renders this title as the page's `h1` on the web
 * and as the screen's own title on iOS and Android, so a second heading of the same level inside
 * the content would announce the same words twice. The screen's own name for the figure is the
 * card's headline below.
 */
const NAV_TITLE = 'Table Credit';

/** The balance card's headline, so the figure is named rather than bare. */
const BALANCE_TITLE = 'Your Table Credit';

/** The retry the error banner offers, which re-runs the failed read. */
const RETRY_LABEL = 'Try again';

/** The link to the terms, where the hold, forfeit and Table Credit rules are spelled out. */
const TERMS_LABEL = 'Read the terms';
const TERMS_PATH = '/legal/terms';

/**
 * The zero-balance line. It states the rule that creates credit — the other attendee not showing
 * up — in neutral words, so it holds for both experiment variants (AAP 0.5.7), and it is shown in
 * addition to the notice, never instead of it.
 */
const ZERO_BALANCE_TEXT =
  "You'll receive Table Credit if someone doesn't show up to a meetup you attended.";

/**
 * The navigator header. Expo Router reads it from the rendered tree to title this route, and it
 * renders nothing of its own; declaring it once keeps the header identical while the read is in
 * flight, after it failed and after it succeeded, because a failed read should still name the
 * page it failed to draw.
 */
const HEADER = <Stack.Screen options={{ title: NAV_TITLE }} />;

/**
 * The code of a failed read: the API's own code, or this client's answer that was not the error
 * envelope (an empty or non-JSON body), which is the only case with no code of its own.
 */
function errorCodeOf(error: unknown): string {
  return isApiError(error) ? error.code : 'invalid_response';
}

/**
 * The balance in the copy's own `10 USD` style (AAP 0.5.7, AAP 0.5.8).
 *
 * A whole-dollar balance goes through the shared formatter, which refuses anything else; a balance
 * that is not whole — a void reversing a grant the platform had already reduced, say — is the one
 * case that prints cents, because a balance is never rounded away. Formatting only, never a
 * computed total.
 */
function creditText(cents: number): string {
  return cents % 100 === 0 ? formatUsdWhole(cents) : `${(cents / 100).toFixed(2)} USD`;
}

/**
 * The Table Credit balance screen.
 *
 * @returns The balance card with its notice and the link to the terms, the busy line while the read
 * is in flight, or the error banner with the retry when it failed.
 */
export default function TableCreditScreen(): JSX.Element {
  const me = useMe();
  const errorCode = me.isError ? errorCodeOf(me.error) : null;

  // The failure is announced once per distinct code: a re-render over the same failed read would
  // otherwise repeat the sentence, and a recovery clears the code so the next failure speaks again.
  const announcedCode = useRef<string | null>(null);
  useEffect(() => {
    if (errorCode === null) {
      announcedCode.current = null;
      return;
    }
    if (announcedCode.current === errorCode) return;
    announcedCode.current = errorCode;
    announce(userMessageFor(errorCode));
  }, [errorCode]);

  if (errorCode !== null) {
    return (
      <>
        {HEADER}
        <Screen edges={SCREEN_EDGES} testID="profile-credit">
          <Banner
            tone="error"
            message={userMessageFor(errorCode)}
            action={{
              label: RETRY_LABEL,
              onPress: () => void me.refetch(),
              testID: 'profile-credit-retry',
            }}
            testID="profile-credit-error"
          />
        </Screen>
      </>
    );
  }

  const profile = me.data;
  if (profile === undefined) {
    return (
      <>
        {HEADER}
        <Screen edges={SCREEN_EDGES} testID="profile-credit">
          <Text style={styles.body}>{LOADING_TEXT}</Text>
        </Screen>
      </>
    );
  }

  const cents = profile.tableCreditCents;
  const amount = creditText(cents);

  return (
    <>
      {HEADER}
      <Screen edges={SCREEN_EDGES} testID="profile-credit">
        <Card title={BALANCE_TITLE} testID="profile-credit-balance">
          {/* The figure carries its own accessible name, so the amount is never read as a bare
              number the way its large type, which conveys no meaning on its own, would be. */}
          <Text
            accessibilityLabel={`Table Credit balance: ${amount}`}
            accessibilityRole="text"
            style={styles.amount}
          >
            {amount}
          </Text>
          <Text style={styles.body}>{TABLE_CREDIT_NOTICE}</Text>
          {cents === 0 ? <Text style={styles.body}>{ZERO_BALANCE_TEXT}</Text> : null}
        </Card>
        <ListItem
          label={TERMS_LABEL}
          onPress={() => {
            router.push(TERMS_PATH);
          }}
          role="link"
          testID="profile-credit-terms"
        />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  amount: {
    ...typography.display,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  body: {
    color: colors.text,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
});
