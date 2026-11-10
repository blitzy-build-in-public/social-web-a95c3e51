/**
 * `Screen` — the page container every screen sits in (AAP 0.5.8).
 *
 * It owns four things and nothing else: the safe-area insets, so content is never drawn under the notch, the status bar
 * or the home indicator; the page's heading, rendered first so reading and focus order begin with it; the padded,
 * evenly spaced column the content stacks in, centred and capped at the layout tokens' widest content column; and the
 * page's `main` landmark with the skip link that reaches it (WCAG 2.4.1), which is the app's only landmark —
 * `apps/mobile/app/_layout.tsx` marks nothing as `main` — named {@link MAIN_LANDMARK_LABEL}.
 * No provider is mounted here: `apps/mobile/app/_layout.tsx` already wraps the router in `GestureHandlerRootView` and
 * `SafeAreaProvider`, and `SafeAreaView` insets by the overlapping area only.
 */
import { useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextProps,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import {
  borderWidths,
  colors,
  fontWeights,
  layout,
  MIN_TOUCH_TARGET,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import { MAIN_LANDMARK_LABEL, SKIP_TO_CONTENT } from '../copy/strings';
/** The insets a screen claims when the caller names none: all four, so a page that fills the window clears every edge. */
const DEFAULT_EDGES: readonly Edge[] = ['top', 'right', 'bottom', 'left'];
/**
 * The heading's platform attributes. It is the screen's top-level heading, so it is announced as one on both
 * platforms rather than as emphasised text.
 */
const HEADING_ATTRIBUTES: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 1,
};
/**
 * The content region's platform attributes: it is the page's `main` landmark, under the name
 * {@link MAIN_LANDMARK_LABEL}, so a screen reader user reaches the content from the landmark list.
 */
const CONTENT_ATTRIBUTES: ViewProps =
  Platform.OS === 'web'
    ? { role: 'main', 'aria-label': MAIN_LANDMARK_LABEL, tabIndex: -1 }
    : { role: 'main', 'aria-label': MAIN_LANDMARK_LABEL };
/**
 * The DOM half of a react-native-web host view: react-native-web 0.19 hands a view's ref the browser element
 * itself, which is the only member of it this module reads.
 */
interface WebFocusable {
  focus(): void;
}

type ContentNode = View | ScrollView;
/**
 * The web key event fields this module reads: react-native-web forwards the browser's own event, while React
 * Native declares no key events at all.
 */
type KeyEvent = Readonly<{ key?: string; preventDefault?: () => void }>;
function isActivationKey(event: KeyEvent): boolean {
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
}

// The browser's own focus outline is kept off the band this control reserves for its focus ring, so the ring a
// keyboard user sees is the app's own; on web React Native declares no `outline` style, so the long form is asserted
// here and the value is empty off web, which never reads it.
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

export interface ScreenProps {
  children: ReactNode;
  /**
   * The page heading: the screen's single top-level heading, so a screen passes a title once and a screen with no
   * heading of its own passes none.
   */
  title?: string;
  /**
   * Whether the content scrolls, `true` by default so every field of a long or keyboard-driven screen stays
   * reachable. A screen that scrolls a list of its own passes `false` and owns the scrolling.
   */
  scroll?: boolean;
  edges?: readonly Edge[];
  testID?: string;
}

/** Lays a screen out inside the safe area with an optional heading. */
export function Screen({
  children,
  title,
  scroll = true,
  edges = DEFAULT_EDGES,
  testID,
}: ScreenProps): ReactElement {
  const [skipLinkFocused, setSkipLinkFocused] = useState(false);

  // The content region's element, which is what the skip link reaches: both branches hand their node to this
  // one ref and only one branch renders at a time, so at most one node is ever held.
  const contentHandle = useRef<WebFocusable | null>(null);
  const setContentHandle = useCallback((node: ContentNode | null): void => {
    // The node *is* the browser element on web (see `WebFocusable`); on native it is a host view, which nothing here reads.
    contentHandle.current = node as (View & WebFocusable) | null;
  }, []);
  const focusContent = useCallback((): void => contentHandle.current?.focus(), []);

  // The move is made as the activation key comes back up, and the browser's own activation of that key is taken
  // from it instead, so a keystroke moves focus exactly once and only at the end — and the skip link's own press
  // is never left to the browser, which would reload the page instead of moving focus.
  const skipLinkKeys: {
    onKeyDown?: (event: KeyEvent) => void;
    onKeyUp?: (event: KeyEvent) => void;
  } =
    Platform.OS === 'web'
      ? {
          onKeyDown: (event) => {
            if (isActivationKey(event)) event.preventDefault?.();
          },
          onKeyUp: (event) => {
            if (!isActivationKey(event)) return;
            event.preventDefault?.();
            focusContent();
          },
        }
      : {};

  // The skip link is the container's first child, so it is the screen content's first Tab stop. While the keyboard
  // holds focus here it is laid out in the flow and takes its own space above the content region, so the region
  // starts under its bottom edge and the pill can never cover a line of content at any scroll offset; at rest it is
  // out of the flow and clipped to a single pixel, painting nothing.
  const skipLink =
    Platform.OS === 'web' ? (
      <Pressable
        {...skipLinkKeys}
        role="button"
        aria-label={SKIP_TO_CONTENT}
        onBlur={() => setSkipLinkFocused(false)}
        onFocus={() => setSkipLinkFocused(true)}
        onPress={focusContent}
        style={[
          skipLinkFocused ? styles.skipLinkRevealed : styles.skipLinkHidden,
          webFocusRingReset,
        ]}
        testID="skip-to-content"
      >
        <Text style={styles.skipLinkLabel}>{SKIP_TO_CONTENT}</Text>
      </Pressable>
    ) : null;

  // A title of whitespace alone counts as none: it would paint an empty heading element, which an audit reports and a screen reader announces as nothing.
  const heading =
    title !== undefined && title.trim() !== '' ? (
      <Text {...HEADING_ATTRIBUTES} style={styles.title}>
        {title}
      </Text>
    ) : null;

  if (scroll) {
    return (
      <SafeAreaView style={styles.screen} edges={edges} testID={testID}>
        {skipLink}
        <ScrollView
          {...CONTENT_ATTRIBUTES}
          ref={setContentHandle}
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
      {skipLink}
      <View {...CONTENT_ATTRIBUTES} ref={setContentHandle} style={[styles.content, styles.fill]}>
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
    // One padding step on every side and the same step between the heading and each child, so spacing comes from the gap rather than from margins each screen applies itself.
    padding: spacing.lg,
    gap: spacing.lg,
    // The column keeps a readable measure at a wide viewport instead of stretching with it: centred in whatever
    // the screen was given and never past the layout tokens' widest content column.
    alignSelf: 'center',
    maxWidth: layout.maxContentWidth,
    width: '100%',
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
  // At rest the skip link is out of the flow, clipped to a single pixel and hung one padding step in from the
  // content's own edge, so it paints nothing and shifts nothing while it waits for the keyboard: still in the tab
  // order and still in the accessibility tree, where `display: none` would take the link out of both and leave the
  // page with no bypass.
  skipLinkHidden: {
    position: 'absolute',
    left: spacing.lg,
    top: spacing.sm,
    zIndex: 1,
    height: 1,
    overflow: 'hidden',
    width: 1,
  },
  // Focused it is the pill an outlined control paints: the `surface` fill under `primary` text (6.59:1), and the
  // boundary is the app's ring rather than the neutral `border`, because the pill is only on screen while the
  // keyboard is on it. It holds focus in the flow, where the content region below starts under the pill's bottom
  // edge plus one spacing step, so the pill can never cover a line of content at any scroll offset; hugging its own
  // label keeps it the width of the words it shows instead of stretching across the container.
  skipLinkRevealed: {
    alignSelf: 'flex-start',
    marginBottom: spacing.md,
    marginLeft: spacing.lg,
    marginTop: spacing.sm,
    backgroundColor: colors.surface,
    borderColor: colors.focusRing,
    borderRadius: radii.md,
    borderWidth: borderWidths.control,
    // The pill is a control in its own right while it is on screen, so it holds the shared minimum touch-target
    // height (AAP 0.5.8: at least 44x44).
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  skipLinkLabel: {
    color: colors.primary,
    fontSize: typography.label.fontSize,
    fontWeight: fontWeights.medium,
    lineHeight: typography.label.lineHeight,
  },
});
