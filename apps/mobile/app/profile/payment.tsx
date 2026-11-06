/**
 * The payment-card screen (`/profile/payment`): the saved-card step a meetup deposit needs
 * (AAP 0.1.1, AAP 0.3.4, AAP 0.5.4, AAP 0.8.1).
 */
import { useCallback, useState, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { colors, spacing, typography } from '@tablemate/shared';
import { CardSetup, type CardSetupResult } from '../../src/payments/card-setup';
import { Banner, Card, ListItem, Screen, announce } from '../../src/ui';

const HEADER_TITLE = 'Payment card';
const PRIVACY_NOTE = 'Your card details go straight to Stripe; Tablemate never sees them.';
const TERMS_LABEL = 'Read the terms';
const RETURN_LABEL = 'Back to your meetup';
const EXPLANATION =
  "When you propose or accept a meetup, a temporary hold for the deposit is placed on this card. The hold is released when you both check in, or if the meetup doesn't go ahead. It's captured only after a no-show or a late cancellation, as the terms describe.";

const CARD_SAVED_TEXT = 'Your card is saved for meetup holds.';

export default function PaymentScreen(): ReactElement {
  const [saved, setSaved] = useState(false);
  const { returnTo: given } = useLocalSearchParams<{ returnTo?: string | string[] }>();
  const path = typeof given === 'string' && given.startsWith('/meetups/') ? given : null;
  const openTerms = useCallback(() => router.push('/legal/terms'), []);
  const goBack = useCallback(() => void (path !== null && router.replace(path)), [path]);
  const back = { label: RETURN_LABEL, onPress: goBack, testID: 'payment-return' };
  const handleDone = useCallback((result: CardSetupResult): void => {
    setSaved(result.status === 'saved');
    if (result.status === 'saved') announce(CARD_SAVED_TEXT);
  }, []);
  return (
    <Screen edges={['bottom', 'left', 'right']} testID="payment">
      <Stack.Screen options={{ title: HEADER_TITLE }} />
      <Card testID="payment-explanation">
        <View style={styles.explanation}>
          <Text style={styles.body}>{EXPLANATION}</Text>
          <Text style={styles.body}>{PRIVACY_NOTE}</Text>
        </View>
      </Card>
      <ListItem label={TERMS_LABEL} onPress={openTerms} role="link" testID="payment-terms" />
      {saved ? <Banner message={CARD_SAVED_TEXT} testID="payment-saved" tone="success" /> : null}
      {saved && path !== null ? <ListItem {...back} role="link" /> : null}
      <CardSetup onDone={handleDone} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  explanation: { gap: spacing.sm },
  body: { ...typography.body, color: colors.text },
});
