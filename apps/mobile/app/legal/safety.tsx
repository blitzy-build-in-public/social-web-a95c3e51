/**
 * The safety page (`/legal/safety`): the notice that a deposit is not a safety guarantee, and the
 * five basic safety tips (AAP 0.5.8, AAP 0.12.2).
 *
 * The same two constants stand on Propose, on Accept and lock and here, so the wording cannot drift
 * between them: the notice, the tips heading and the five tips are read from `src/copy/strings.ts`
 * and rendered verbatim — never re-worded, re-ordered or added to on this screen. The page is
 * public, because the root gate admits the whole `legal` area to a signed-out visitor and the age
 * gate links here before consent exists (AAP 0.5.8), so it reads no API, session or cached state.
 */
import type { ReactElement } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { TextProps } from 'react-native';
import { Stack } from 'expo-router';
import { colors, fontWeights, spacing, typography } from '@tablemate/shared';

import { SAFETY_NOTICE, SAFETY_TIPS, SAFETY_TIPS_TITLE } from '../../src/copy/strings';
import { Banner, Card, Screen } from '../../src/ui';

/** The route's title in the navigator header and, below it, the page's own one level-1 heading. */
const TITLE = 'Safety';

/** The mark in front of a tip. It is decoration: the list and item roles carry the structure. */
const BULLET = '•';

/**
 * The tips heading's attributes. `role="heading"` is the whole contract on native, where iOS maps
 * it to the header trait and Android to its own heading role, and with `aria-level` it is what
 * react-native-web 0.19 reads to render the `<h2>` under the page's `<h1>` that `Screen` renders.
 * React Native's `TextProps` does not list the attribute yet while `Text` spreads unlisted props
 * onto the host view, where the view config drops them, so the object is named as `TextProps` plus
 * that one attribute instead of an untyped literal.
 */
const TIPS_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
};

/**
 * Removes the bullet from the accessibility tree, so a screen reader reads each tip once.
 *
 * Native reads a different prop per platform — `accessibilityElementsHidden` on iOS,
 * `importantForAccessibility` on Android — while react-native-web renders the ARIA attribute alone.
 * The two React Native props are left off web on purpose, as the UI primitives do for their own
 * decoration: react-native-web would emit them into the DOM as invalid attributes.
 */
const BULLET_IS_DECORATION: Pick<
  TextProps,
  'aria-hidden' | 'accessibilityElementsHidden' | 'importantForAccessibility'
> =
  Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no' };

/**
 * The safety notice and the basic safety tips.
 *
 * The notice comes first, in the `warning` tone, which paints `warning` on the `surface` fill — a
 * `CONTRAST_PAIRS` record at 6.39:1 — and renders the visible status word "Warning" beside it, so
 * the caution never rests on colour alone (WCAG 1.4.1). The tips follow under their own level-2
 * heading, inside one card, as a list of five items in the order the request gives them. No
 * dimension is fixed, so a reader's system font size scales the page rather than clipping it.
 *
 * @returns The safety page.
 */
export default function SafetyScreen(): ReactElement {
  return (
    <>
      <Stack.Screen options={{ title: TITLE }} />
      {/* The navigator header carries this route's title, and react-navigation's header title is a
          level-1 heading on web, so the page exposes two of them, this screen's own heading below
          included. Both stand, against the one-level-1-heading-per-page guideline: hiding the header
          would take away the back control, and a hand-built header title would replace the platform's
          own header text styling on iOS and Android. */}
      <Screen title={TITLE} testID="legal-safety">
        <Banner tone="warning" message={SAFETY_NOTICE} testID="safety-page-notice" />
        <Card>
          <Text {...TIPS_HEADING} style={styles.sectionTitle}>
            {SAFETY_TIPS_TITLE}
          </Text>
          {/* `role="list"` and `role="listitem"` are rendered as a real <ul> with five <li> children
              on web, whose implicit ARIA roles are list and listitem, and as the collection roles on
              iOS and Android. Keys are indexes: the list is the fixed set of `SAFETY_TIPS`. */}
          <View role="list" style={styles.list}>
            {SAFETY_TIPS.map((tip, index) => (
              <View key={index} role="listitem" style={styles.tip}>
                <Text {...BULLET_IS_DECORATION} style={styles.bullet}>
                  {BULLET}
                </Text>
                <Text style={styles.tipText}>{tip}</Text>
              </View>
            ))}
          </View>
        </Card>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  // `text` on the card's `background` fill: a `CONTRAST_PAIRS` record at 17.21:1.
  sectionTitle: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  list: {
    // The gap between the tips rather than a margin on each, so the last one adds no space.
    gap: spacing.sm,
  },
  tip: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  bullet: {
    ...typography.body,
    color: colors.text,
  },
  // The tip takes the row's remaining width and wraps there, so a long tip never pushes the bullet
  // off the line.
  tipText: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
});
