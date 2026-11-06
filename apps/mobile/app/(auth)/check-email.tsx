/** The "check your email" notice (`/check-email`, AAP 0.5.8, AAP 0.8.1). */
import type { ReactElement } from 'react';
import { StyleSheet, Text, type TextProps } from 'react-native';
import { router, Stack } from 'expo-router';
import { MAGIC_LINK_TTL_MINUTES, colors, fontWeights, typography } from '@tablemate/shared';

import { Button, Card, Screen } from '../../src/ui';

const SCREEN_EDGES = ['left', 'right'] as const;
const PAGE_TITLE = 'Check your email';
const SENT_NOTICE = "We've emailed you a sign-in link.";
const EXPIRY_NOTICE = `The link works once and expires in ${MAGIC_LINK_TTL_MINUTES} minutes.`;
const DEVICE_NOTICE = 'Open it on this device to sign in.';
const MISSING_NOTICE = "Didn't get it? Check your spam folder, or use a different email.";
const CHANGE_EMAIL_LABEL = 'Use a different email';
const SIGN_IN_PATH = '/sign-in';
// `accessibilityRole="header"` is iOS's header trait and Android's heading role, and `aria-level`
// is what react-native-web 0.19 reads to render a real `<h1>` rather than an unlevelled span.
const MESSAGE_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  accessibilityRole: 'header',
  'aria-level': 1,
};
const HEADER = <Stack.Screen options={{ title: PAGE_TITLE }} />;
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
          onPress={() => router.replace(SIGN_IN_PATH)}
          testID="check-email-change"
          variant="secondary"
        />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  heading: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.textMuted },
});
