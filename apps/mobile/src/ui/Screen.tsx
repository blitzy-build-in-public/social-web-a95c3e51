/**
 * `Screen` — the page container every Tablemate screen sits in (AAP 0.5.8, AAP 0.8.1).
 *
 * It owns four things and nothing else: the safe-area insets, so content is never drawn under the
 * notch, the status bar or the home indicator; the page's heading, rendered first so reading and
 * focus order begin with it; the padded, evenly spaced column the screen's own content stacks in,
 * centred and capped at the layout tokens' widest content column, so a paragraph keeps a readable
 * measure instead of stretching with a wide viewport; and the page's `main` landmark with the skip
 * link that reaches it, so a keyboard or screen-reader user bypasses the navigator chrome every
 * screen repeats instead of tabbing through it (WCAG 2.4.1). The landmark is the app's only one —
 * `apps/mobile/app/_layout.tsx` marks nothing as `main` — and it is named {@link MAIN_LANDMARK_LABEL}
 * for the landmark list a screen reader reads.
 * Colour, spacing and type come from the shared tokens in `packages/shared/src/ui-tokens.ts`, and
 * text is painted only in a pair recorded in `CONTRAST_PAIRS` — the `text`-on-`background` page pair
 * at 17.21:1, well over the AA minimum for normal text, and the skip link's `primary`-on-`surface`
 * pair at 6.59:1.
 *
 * No provider is mounted here: `apps/mobile/app/_layout.tsx` already wraps the router in
 * `GestureHandlerRootView` and `SafeAreaProvider`, and `SafeAreaView` insets by the area that
 * overlaps this view only, so the same container is correct at the root of a screen and below a
 * navigator header.
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
 * The content region's platform attributes: it is the page's `main` landmark, under the name
 * {@link MAIN_LANDMARK_LABEL}, so a screen reader user reaches the page's content from the landmark
 * list.
 *
 * `tabIndex: -1` is the web half alone. It makes the region programmatically focusable, which is
 * what the skip link's `focus()` call needs, without adding a tab stop of its own, and iOS and
 * Android have no such attribute to take. React Native declares all three members on `ViewProps`
 * (`role`, `aria-label` and `tabIndex`), so this needs no locally named type.
 */
const CONTENT_ATTRIBUTES: ViewProps =
  Platform.OS === 'web'
    ? { role: 'main', 'aria-label': MAIN_LANDMARK_LABEL, tabIndex: -1 }
    : { role: 'main', 'aria-label': MAIN_LANDMARK_LABEL };

/**
 * The DOM half of a react-native-web host view. react-native-web 0.19 hands a view's ref the browser
 * element itself — `View` merges its host node into the ref it is given, and `ScrollView` passes the
 * node it renders through — so the one member this module reaches for is the element's own `focus()`.
 * React Native's `View` carries `focus` through its own `NativeMethods`, but `ScrollView` is declared
 * as a plain component whose type has none, and the content region is one or the other, so the handle
 * is typed here rather than read off the shared props.
 */
interface WebFocusable {
  /** Moves keyboard focus to the element. */
  focus(): void;
}

/** Either component a screen's content region is, both a DOM element when react-native-web renders. */
type ContentNode = View | ScrollView;

/**
 * The web key event fields this module reads. react-native-web forwards the browser's own event,
 * while React Native declares no key events at all, so the shape is named here.
 */
type KeyEvent = Readonly<{ key?: string; preventDefault?: () => void }>;

/** Whether a key event is one of the two keys a button answers to. */
function isActivationKey(event: KeyEvent): boolean {
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
}

/**
 * Keeps the browser's own focus outline off the revealed skip link on web, where it would otherwise
 * be painted outside the ring the pill paints from the tokens (WCAG 2.4.7). React Native 0.76
 * declares no `outline` style, so the long form is asserted once here; the value is empty off web,
 * which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

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
 * The content region is the page's `main` landmark and the skip link's target; the link itself is
 * taken out of the flow in both of its states, so revealing it on focus never moves the content
 * below it.
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
  const [skipLinkFocused, setSkipLinkFocused] = useState(false);

  // The content region's element, for the one call the skip link makes. Both branches hand their
  // node to this one ref and only one branch renders at a time, so at most one node is ever held.
  const contentHandle = useRef<WebFocusable | null>(null);
  const setContentHandle = useCallback((node: ContentNode | null): void => {
    // The node *is* the browser element on web (see `WebFocusable`), which is the only member read
    // of it; on native it is a host view, and nothing there reads the handle.
    contentHandle.current = node as (View & WebFocusable) | null;
  }, []);
  const focusContent = useCallback((): void => contentHandle.current?.focus(), []);

  // The move is made as the activation key comes back up, and the browser's own activation of that
  // key is taken from it instead, so a keystroke moves focus exactly once and only at the end.
  //
  // Both halves are load-bearing. react-native-web renders this control as a real `<button>`, so what
  // activates it is the browser's own click of the key — on the down stroke for Enter and on the
  // release for Space — and the app releases focus from the control a keyboard press arrived on when
  // that press ends (`app/_layout.tsx`). A move made by the click Enter draws from the down stroke is
  // therefore undone before the key comes up, while the release is the last thing a keystroke
  // delivers, so the move made there is the one that lasts. `preventDefault` on the way down leaves
  // the release as the only activation, of either key.
  // A `role="link"` control cannot serve here at all: react-native-web withholds its press from one,
  // and the app blurs a focused link on the Enter's down stroke, before the release could reach it.
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

  // The skip link is the container's first child, so it is the screen content's first Tab stop, and
  // it paints nothing until a keyboard reaches it.
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
          styles.skipLink,
          skipLinkFocused ? styles.skipLinkRevealed : styles.skipLinkHidden,
          webFocusRingReset,
        ]}
        testID="skip-to-content"
      >
        <Text style={styles.skipLinkLabel}>{SKIP_TO_CONTENT}</Text>
      </Pressable>
    ) : null;

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
    // One padding step on every side and the same step between the heading and each child, so
    // spacing comes from the gap rather than from margins each screen would have to apply itself.
    padding: spacing.lg,
    gap: spacing.lg,
    // The column keeps a readable measure at a wide viewport instead of stretching with it: it is
    // centred in whatever the screen was given and never grows past the layout tokens' widest
    // content column, so a paragraph does not run the full width of a desktop window.
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
  // The skip link is out of the flow in both of its states — absolutely positioned over the top of
  // the content region — so revealing it shifts nothing below it. It sits one padding step in from
  // the content's own edge, which is where a keyboard user looks for it, and above the content it
  // covers, so the revealed pill is never painted under another element.
  skipLink: {
    position: 'absolute',
    left: spacing.lg,
    top: spacing.sm,
    zIndex: 1,
  },
  // At rest it is a single clipped pixel: still in the tab order and still in the accessibility
  // tree, where `display: none` would take the link out of both and leave the page with no bypass.
  skipLinkHidden: {
    height: 1,
    overflow: 'hidden',
    width: 1,
  },
  // Focused it is the same pill an outlined control paints: the `surface` fill under `primary` text
  // (6.59:1). The boundary is the app's ring, not the neutral `border`: the pill is only ever on
  // screen while the keyboard is on it, so the band a control paints on focus (`colors.focusRing`,
  // 6.04:1 on that fill) is the boundary to paint, exactly as `Button` does (WCAG 2.4.7).
  skipLinkRevealed: {
    backgroundColor: colors.surface,
    borderColor: colors.focusRing,
    borderRadius: radii.md,
    borderWidth: borderWidths.control,
    // The pill is a control in its own right while it is on screen, so it holds the shared minimum
    // touch-target height: 2 + 8 + 24 + 8 + 2 of the label's line box already reaches it, and this
    // keeps it there if the type role ever changes (AAP 0.5.8: at least 44x44).
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
