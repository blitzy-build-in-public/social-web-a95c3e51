/**
 * The payment-card screen (`/profile/payment`): the saved-card step a meetup deposit needs
 * (AAP 0.1.1, AAP 0.3.4, AAP 0.5.4, AAP 0.8.1).
 *
 * `POST /v1/meetups` and `POST /v1/meetups/:id/accept` place a server-confirmed hold on a card saved
 * with Stripe and answer `402 hold_failed` without one, so a traveller can hold a proposal they
 * cannot send, or cannot lock, until a card is stored (AAP 0.3.3, AAP 0.7.3). The card is entered
 * inside Stripe's own PaymentSheet or Payment Element, chosen by the platform pair
 * `src/payments/card-setup` (AAP 0.3.4), and no card number, client secret, ephemeral key or customer
 * id reaches this file, the API or a log line (AAP 0.3.2, AAP 0.12.2).
 *
 * The explanation below is identical in both experiment arms on purpose: the deposit framing is the
 * experiment's single variable and belongs on deposit screens alone, through the shared
 * `depositCopy` (AAP 0.5.7, AAP 0.5.8). Social wording here would reach every traveller and leak that
 * arm into the punitive one, so this screen states both outcomes neutrally and never reads the
 * variant. `MeDto` carries no saved-card field, so the screen offers the setup step and never claims
 * a card is, or is not, already stored (AAP 0.5.4).
 */
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { colors, spacing, typography } from '@tablemate/shared';

import { CardSetup } from '../../src/payments/card-setup';
import type { CardSetupResult } from '../../src/payments/card-setup';
import { Banner, Card, ListItem, Screen, announce } from '../../src/ui';

/**
 * The safe-area edges this screen insets by. The Stack header owns the top inset, and the bottom one
 * is this route's own because the tabs are not mounted beneath a pushed stack screen.
 */
const SCREEN_EDGES = ['bottom', 'left', 'right'] as const;

/** The header title. The navigator's header is the screen's one heading, so `Screen` gets no title. */
const HEADER_TITLE = 'Payment card';

/** What a hold is, and both ways one ends, without the experiment's framing (see the module doc). */
const EXPLANATION =
  "When you propose or accept a meetup, a temporary hold for the deposit is placed on this card. The hold is released when you both check in, or if the meetup doesn't go ahead. It's captured only after a no-show or a late cancellation, as the terms describe.";

/** Where the card is entered, which is what a traveller wants to know before starting (AAP 0.3.2). */
const PRIVACY_NOTE = 'Your card details go straight to Stripe; Tablemate never sees them.';

/** The link to the terms the explanation refers to: `app/legal/terms.tsx`, a public route. */
const TERMS_LABEL = 'Read the terms';

/** Shown and spoken once Stripe has stored the card (AAP 0.3.3). */
const CARD_SAVED_MESSAGE = 'Your card is saved for meetup holds.';

/** The way back to the meetup whose hold failed, when the route was opened for one (AAP 0.5.4). */
const RETURN_LABEL = 'Back to your meetup';

/** The only path prefix `returnTo` may name, so the parameter can never redirect off-route. */
const MEETUP_PATH_PREFIX = '/meetups/';

/**
 * The meetup path this route was opened for, or null.
 *
 * A `returnTo`, such as `/profile/payment?returnTo=/meetups/<id>`, is how a proposal that answered
 * `402 hold_failed` brings the traveller back to retry its hold once a card is saved (AAP 0.5.4).
 */
function meetupReturnPath(returnTo: string | readonly string[] | undefined): string | null {
  return typeof returnTo === 'string' && returnTo.startsWith(MEETUP_PATH_PREFIX) ? returnTo : null;
}

/**
 * The saved-card step.
 *
 * `CardSetup` owns the control, the failure sentence and the unavailable notice, so this screen adds
 * no banner that would report the same failure twice and no second control.
 *
 * @returns The screen: the hold explanation with its terms link, the saved confirmation, the way back
 * to a meetup whose hold failed, and the setup control.
 */
export default function PaymentScreen(): ReactElement {
  const [saved, setSaved] = useState(false);
  const returnTo = meetupReturnPath(
    useLocalSearchParams<{ returnTo?: string | string[] }>().returnTo,
  );

  const openTerms = useCallback((): void => {
    router.push('/legal/terms');
  }, []);

  const backToMeetup = useCallback((): void => {
    if (returnTo === null) return;
    // Back to the meetup rather than a second copy of this screen in the history.
    router.replace(returnTo);
  }, [returnTo]);

  const handleDone = useCallback((result: CardSetupResult): void => {
    switch (result.status) {
      case 'saved':
        setSaved(true);
        // iOS has no live region for a banner to speak through, so the core flows announce their
        // outcome as well as render it (AAP 0.5.8).
        announce(CARD_SAVED_MESSAGE);
        return;
      case 'cancelled':
        // Stripe's sheet closing is the traveller changing their mind: the previous sentence is
        // withdrawn and nothing is said or shown.
        setSaved(false);
        return;
      case 'failed':
        // `CardSetup` renders the app's own sentence for the failure code in its error banner and
        // announces it, so a banner here would report one failure twice; a success sentence still on
        // screen would contradict it, so that is withdrawn too.
        setSaved(false);
        return;
    }
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: HEADER_TITLE }} />
      <Screen edges={SCREEN_EDGES} testID="payment">
        <Card testID="payment-explanation">
          <View style={styles.explanation}>
            <Text style={styles.body}>{EXPLANATION}</Text>
            <Text style={styles.body}>{PRIVACY_NOTE}</Text>
          </View>
        </Card>
        <ListItem label={TERMS_LABEL} onPress={openTerms} role="link" testID="payment-terms" />
        {saved ? (
          <Banner tone="success" message={CARD_SAVED_MESSAGE} testID="payment-saved" />
        ) : null}
        {saved && returnTo !== null ? (
          <ListItem
            label={RETURN_LABEL}
            onPress={backToMeetup}
            role="link"
            testID="payment-return"
          />
        ) : null}
        <CardSetup onDone={handleDone} />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  explanation: {
    gap: spacing.sm,
  },
  body: {
    color: colors.text,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
});
