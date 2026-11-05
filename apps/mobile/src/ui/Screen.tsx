/**
 * `Screen` — the page container every Tablemate screen sits in (AAP 0.5.8, AAP 0.8.1).
 *
 * It owns three things and nothing else: the safe-area insets, so content is never drawn under the
 * notch, the status bar or the home indicator; the page's heading, rendered first so reading and
 * focus order begin with it; and the padded, evenly spaced column the screen's own content stacks
 * in. Colour, spacing and type come from the shared tokens in `packages/shared/src/ui-tokens.ts`,
 * and text is painted only in a pair recorded in `CONTRAST_PAIRS` — the `text`-on-`background`
 * page pair at 17.21:1, well over the AA minimum for normal text.
 *
 * No provider is mounted here: `apps/mobile/app/_layout.tsx` already wraps the router in
 * `GestureHandlerRootView` and `SafeAreaProvider`, and `SafeAreaView` insets by the area that
 * overlaps this view only, so the same container is correct at the root of a screen and below a
 * navigator header.
 */
import type { ReactElement, ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, type TextProps } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { colors, fontWeights, spacing, typography } from '@tablemate/shared';

/**
 * The insets a screen claims when the caller names none: all four, so a page that fills the window
 * clears the status bar, the home indicator and any side inset.
 */
const DEFAULT_EDGES: readonly Edge[] = ['top', 'right', 'bottom', 'left'];

/**
 * The heading's platform attributes.
 *
 * `role="heading"` is the whole contract on native: iOS maps it to `UIAccessibilityTraitHeader` and
 * Android to its own heading role, so VoiceOver and TalkBack announce the title as a heading.
 * `aria-level` is what react-native-web 0.19 reads to render a real `<h1>` rather than a span, and
 * React Native's own type declarations do not list it yet while `Text` spreads unlisted props onto
 * the host view, where the view config drops them. Naming the object as `TextProps` plus that one
 * attribute keeps the spread assignable and the level explicit instead of an untyped literal.
 */
const HEADING_ATTRIBUTES: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 1,
};

/**
 * Props of {@link Screen}.
 */
export interface ScreenProps {
  /** The screen's content, rendered in source order below the heading. */
  children: ReactNode;

  /**
   * The page heading. It is the screen's single top-level heading, so a screen passes a title once,
   * and a screen with no heading of its own passes none.
   */
  title?: string;

  /**
   * Whether the content scrolls, `true` by default so a long or keyboard-driven screen keeps every
   * field reachable. A screen that scrolls a list of its own passes `false` and owns the scrolling.
   */
  scroll?: boolean;

  /** The safe-area edges to inset by, all four by default. */
  edges?: readonly Edge[];

  /** Test identifier, forwarded to the container that fills the window. */
  testID?: string;
}

/**
 * Lays a screen out inside the safe area with an optional heading.
 *
 * The heading is rendered before the children, so the reading order a screen reader follows and the
 * tab order a keyboard follows both start at the page title; nothing here reorders or absolutely
 * repositions a child. Text keeps React Native's default `allowFontScaling`, and no dimension in
 * this file is fixed, so a reader's system font size scales the layout instead of clipping it.
 *
 * @param props - {@link ScreenProps}
 * @returns The container element for the screen.
 */
export function Screen({
  children,
  title,
  scroll = true,
  edges = DEFAULT_EDGES,
  testID,
}: ScreenProps): ReactElement {
  // A title of whitespace alone counts as no title: it would paint an empty heading element, which
  // an accessibility audit reports and a screen reader announces as nothing.
  const heading =
    title !== undefined && title.trim() !== '' ? (
      <Text {...HEADING_ATTRIBUTES} style={styles.title}>
        {title}
      </Text>
    ) : null;

  if (scroll) {
    return (
      <SafeAreaView style={styles.screen} edges={edges} testID={testID}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {heading}
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={edges} testID={testID}>
      <View style={[styles.content, styles.fill]}>
        {heading}
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    // One padding step on every side and the same step between the heading and each child, so
    // spacing comes from the gap rather than from margins each screen would have to apply itself.
    padding: spacing.lg,
    gap: spacing.lg,
  },
  fill: {
    flex: 1,
  },
  title: {
    color: colors.text,
    fontSize: typography.heading.fontSize,
    lineHeight: typography.heading.lineHeight,
    fontWeight: fontWeights.bold,
  },
});
