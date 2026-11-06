/**
 * The "check your email" notice (`/check-email`, AAP 0.5.8, AAP 0.8.1).
 *
 * The sign-in screen hands off here once `POST /auth/magic-link` has answered. The API answers `202`
 * for every address so accounts cannot be enumerated (AAP 0.5.4), and the mailer sends the one
 * sentence that carries the link (AAP 0.3.2), so this screen's job is to say what to do with it:
 * the link works once, it expires in `MAGIC_LINK_TTL_MINUTES` (AAP 0.5.2), and it is opened on the
 * device whose session is wanted.
 *
 * There is deliberately no resend control. A resend needs the address, and the address is not in
 * this URL by contract — the sign-in screen passes no parameter — so the screen offers the way back
 * to sign-in instead, where a fresh link is requested.
 *
 * Nothing here reads the session, calls the API or routes on arrival: the exchange happens on
 * `/auth/verify`, and the gate in `apps/mobile/app/_layout.tsx` owns every move that follows
 * (AAP 0.5.8).
 */
import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { TextProps } from 'react-native';
import { router, Stack } from 'expo-router';
import { MAGIC_LINK_TTL_MINUTES, colors, fontWeights, typography } from '@tablemate/shared';

import { Button, Card, Screen } from '../../src/ui';

/**
 * The safe-area edges this screen claims: the `(auth)` stack shows a header of its own, which owns
 * the top inset, and the window owns the sides, so claiming the vertical pair here would add their
 * height twice.
 */
const SCREEN_EDGES = ['left', 'right'] as const;

/** The navigator header's title, and the page's own name for the state it describes. */
const PAGE_TITLE = 'Check your email';

/** The address itself is never shown: this screen is told nothing about it (AAP 0.5.4). */
const SENT_NOTICE = "We've emailed you a sign-in link.";

/**
 * The link's lifetime, built from the shared constant so the copy cannot drift from what the API
 * enforces. `MAGIC_LINK_TTL_MINUTES` is already whole minutes, so it prints as it stands.
 */
const EXPIRY_NOTICE = `The link works once and expires in ${MAGIC_LINK_TTL_MINUTES} minutes.`;

/** A magic link is followed, not typed in, so it signs in the browser or app that opens it. */
const DEVICE_NOTICE = 'Open it on this device to sign in.';

/** What to try before asking for another link: the mail may have been filed away as spam. */
const MISSING_NOTICE = "Didn't get it? Check your spam folder, or use a different email.";

/** The screen's one action, which returns to sign-in for a fresh link. */
const CHANGE_EMAIL_LABEL = 'Use a different email';
const SIGN_IN_PATH = '/sign-in';

/**
 * The message heading's platform attributes, the pair `Screen` asserts for a page title:
 * `accessibilityRole="header"` is iOS's header trait and Android's heading role, and `aria-level` is
 * what react-native-web 0.19 reads to render a real `<h1>` rather than an unlevelled span. The
 * message is the page's heading here because it is the whole screen, which is why `Screen` is given
 * no title of its own: the header bar's words are not repeated in the page body.
 */
const MESSAGE_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  accessibilityRole: 'header',
  'aria-level': 1,
};

/**
 * The navigator header. Expo Router reads it from the rendered tree to title this route, and it
 * renders nothing of its own.
 */
const HEADER = <Stack.Screen options={{ title: PAGE_TITLE }} />;

/**
 * Tells the traveler that a sign-in link has been sent and what to do with it.
 *
 * Reading, focus and heading order follow source order: the message, its two conditions, the advice
 * for a mail that has not arrived, then the way back to sign-in. The screen's test handles are
 * `check-email` on the container and `check-email-change` on that way back, which the web
 * walk-through of the sign-in flow uses to assert the hand-off.
 *
 * @returns The notice, the lifetime it states, and the one control that leaves it.
 */
export default function CheckEmailScreen(): ReactElement {
  return (
    <>
      {HEADER}
      <Screen edges={SCREEN_EDGES} testID="check-email">
        <Card>
          <Text {...MESSAGE_HEADING} style={styles.heading}>
            {SENT_NOTICE}
          </Text>
          <Text style={styles.body}>{EXPIRY_NOTICE}</Text>
          <Text style={styles.body}>{DEVICE_NOTICE}</Text>
        </Card>
        <Text style={styles.muted}>{MISSING_NOTICE}</Text>
        <Button
          label={CHANGE_EMAIL_LABEL}
          onPress={() => {
            router.replace(SIGN_IN_PATH);
          }}
          testID="check-email-change"
          variant="secondary"
        />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  heading: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  // `text` on the card's `background` fill is a recorded pair at 17.21:1, and `textMuted` on it at
  // 7.07:1, so both readings clear AA normal text.
  body: {
    ...typography.body,
    color: colors.text,
  },
  muted: {
    ...typography.body,
    color: colors.textMuted,
  },
});
