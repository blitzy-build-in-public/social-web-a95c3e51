/** The age gate at `/age-gate` (AAP 0.5.8, 0.7.1 row 1, 0.12.2): the 18+ confirmation and the terms
 * a traveler accepts before any feature route will answer them. */
import { useMutation } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MIN_TOUCH_TARGET, colors, fontWeights, spacing, typography } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { markConsented, signOut } from '../../src/auth/session';
import { queryClient, queryKeys } from '../../src/state/meetup-store';
import { AGE_GATE_CONFIRM, TERMS_SUMMARY, TERMS_VERSION } from '../../src/copy/strings';
import { Banner, Button, Card, ListItem, Screen, Switch, announce } from '../../src/ui';
const INTRO = 'Tablemate is for adults. Please confirm your age and read how deposits work.';
const TERMS_LABEL = 'Read the full terms';
const TERMS_LINK = { label: TERMS_LABEL, role: 'link', testID: 'age-gate-full-terms' } as const;
const CONTINUE_BUTTON = { label: 'Continue', testID: 'age-gate-submit' } as const;
const SIGN_OUT_BUTTON = { variant: 'secondary', testID: 'age-gate-sign-out' } as const;
const ERROR_BANNER = { tone: 'error', testID: 'age-gate-error' } as const;
function messageFor(error: unknown): string {
  return userMessageFor(isApiError(error) ? error.code : 'network_error');
}
export default function AgeGateScreen(): ReactElement {
  const [adult, setAdult] = useState(false);
  const mutation = useMutation({
    mutationFn: () => apiClient.postConsents({ adult: true, termsVersion: TERMS_VERSION }),
    onSuccess: async () => {
      markConsented();
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      router.replace('/discover');
    },
  });
  const failure = mutation.error === null ? null : messageFor(mutation.error);
  const pending = mutation.isPending;
  useEffect(() => {
    if (failure !== null) announce(failure);
  }, [failure]);
  const toggleAdult = () => setAdult((confirmed) => !confirmed);
  const submit = useCallback((): void => {
    if (!adult || pending) return;
    mutation.mutate();
  }, [adult, pending, mutation]);
  const leaveForSignOut = useCallback((): void => {
    void (async () => {
      try {
        await signOut();
      } finally {
        router.replace('/sign-in');
      }
    })();
  }, []);
  const termsLines = TERMS_SUMMARY.map((line) => (
    <Text key={line} style={styles.terms} children={line} />
  ));
  return (
    <>
      <Stack.Screen options={{ title: 'Before you start' }} />
      <Screen edges={['left', 'right', 'bottom']} testID="age-gate">
        <Text style={styles.body}>{INTRO}</Text>
        <Card testID="age-gate-terms" children={termsLines} />
        <ListItem {...TERMS_LINK} onPress={() => router.push('/legal/terms')} />
        <View style={styles.confirmRow}>
          <Text onPress={toggleAdult} style={styles.confirmLabel}>
            {AGE_GATE_CONFIRM}
          </Text>
          <Switch
            accessibilityLabel={AGE_GATE_CONFIRM}
            onValueChange={setAdult}
            testID="age-gate-adult"
            value={adult}
          />
        </View>
        {failure === null ? null : <Banner {...ERROR_BANNER} message={failure} />}
        <Button {...CONTINUE_BUTTON} onPress={submit} disabled={!adult} busy={pending} />
        <Button {...SIGN_OUT_BUTTON} label="Sign out" onPress={leaveForSignOut} />
        <Text style={styles.hint}>{"Not 18 yet? You can't use Tablemate, so sign out."}</Text>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body, color: colors.text },
  terms: { ...typography.body, color: colors.text },
  confirmRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET,
  },
  confirmLabel: {
    ...typography.label,
    fontWeight: fontWeights.medium,
    color: colors.text,
    flexShrink: 1,
  },
  hint: { ...typography.caption, color: colors.textMuted },
});
