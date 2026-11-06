/**
 * The Table Credit balance (`/profile/credit`, AAP 0.5.8, AAP 0.8.1).
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Text } from 'react-native';
import { router, Stack } from 'expo-router';
import { colors, fontWeights, formatUsdWhole, typography } from '@tablemate/shared';

import { isApiError, userMessageFor } from '../../src/api/errors';
import { TABLE_CREDIT_NOTICE } from '../../src/copy/strings';
import { useMe } from '../../src/state/meetup-store';
import { Banner, Card, ListItem, Screen, announce } from '../../src/ui';

const SCREEN_EDGES = ['left', 'right'] as const;
const LOADING_TEXT = 'Loading…';

const ZERO_BALANCE_TEXT =
  "You'll receive Table Credit if someone doesn't show up to a meetup you attended.";
const HEADER = <Stack.Screen options={{ title: 'Table Credit' }} />;

export default function TableCreditScreen(): JSX.Element {
  const me = useMe();
  const errorCode = me.isError ? (isApiError(me.error) ? me.error.code : 'invalid_response') : null;
  // The failure is spoken once per distinct code, and the code is cleared when it recovers.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (announced.current === errorCode) return;
    announced.current = errorCode;
    if (errorCode !== null) announce(userMessageFor(errorCode));
  }, [errorCode]);
  const cents = me.data?.tableCreditCents ?? 0;
  const amount = cents % 100 === 0 ? formatUsdWhole(cents) : `${(cents / 100).toFixed(2)} USD`;
  const retryNow = (): void => void me.refetch();
  const retry = { label: 'Try again', onPress: retryNow, testID: 'profile-credit-retry' };
  const failed = (notice: string): JSX.Element => (
    <>
      {HEADER}
      <Banner tone="error" message={notice} action={retry} testID="profile-credit-error" />
    </>
  );
  const body =
    errorCode !== null ? (
      failed(userMessageFor(errorCode))
    ) : me.data === undefined ? (
      <Text style={styles.body}>{LOADING_TEXT}</Text>
    ) : (
      <>
        {HEADER}
        <Card title="Your Table Credit" testID="profile-credit-balance">
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
          label="Read the terms"
          onPress={() => router.push('/legal/terms')}
          role="link"
          testID="profile-credit-terms"
        />
      </>
    );
  return (
    <Screen edges={SCREEN_EDGES} testID="profile-credit">
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  amount: { ...typography.display, color: colors.text, fontWeight: fontWeights.bold },
  body: { color: colors.text, ...typography.body },
});
