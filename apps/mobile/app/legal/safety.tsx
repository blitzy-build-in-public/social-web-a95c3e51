/** The safety page (`/legal/safety`): the notice that a deposit is not a safety guarantee, and the five basic safety tips. */
import type { ReactElement } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { TextProps } from 'react-native';
import { Stack } from 'expo-router';
import { colors, fontWeights, spacing, typography } from '@tablemate/shared';

import { SAFETY_NOTICE, SAFETY_TIPS, SAFETY_TIPS_TITLE } from '../../src/copy/strings';
import { Banner, Card, Screen } from '../../src/ui';

const styles = StyleSheet.create({
  sectionTitle: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  list: { gap: spacing.sm },
  tip: { flexDirection: 'row', gap: spacing.sm },
  bullet: { ...typography.body, color: colors.text },
  tipText: { ...typography.body, color: colors.text, flex: 1 },
});
const TITLE = 'Safety';
const BULLET = '•';
type NativeDecoration = 'accessibilityElementsHidden' | 'importantForAccessibility';
type Hidden = Pick<TextProps, 'aria-hidden' | NativeDecoration>;
type Heading = TextProps & Readonly<{ 'aria-level': number }>;
const TIPS_HEADING: Heading = { role: 'heading', 'aria-level': 2, style: styles.sectionTitle };
const BULLET_IS_DECORATION: Hidden =
  Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no' };
const BULLET_TEXT = { ...BULLET_IS_DECORATION, style: styles.bullet };
export default function SafetyScreen(): ReactElement {
  return (
    <>
      <Stack.Screen options={{ title: TITLE }} />
      <Screen testID="legal-safety">
        <Banner tone="warning" message={SAFETY_NOTICE} testID="safety-page-notice" />
        <Card>
          <Text {...TIPS_HEADING}>{SAFETY_TIPS_TITLE}</Text>
          <View role="list" style={styles.list}>
            {SAFETY_TIPS.map((tip, index) => (
              <View key={index} role="listitem" style={styles.tip}>
                <Text {...BULLET_TEXT}>{BULLET}</Text>
                <Text style={styles.tipText}>{tip}</Text>
              </View>
            ))}
          </View>
        </Card>
      </Screen>
    </>
  );
}
