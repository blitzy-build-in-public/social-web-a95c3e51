/**
 * The navigation chrome's own button: the four bottom tab items (AAP 0.5.8). The stack header's back control is drawn
 * by `./HeaderBackButton`, which the web layouts spread into their screen options the same way this one is handed to
 * the tab bar.
 *
 * react-navigation paints its own chrome with `PlatformPressable`, which on web is an anchor that falls back to the
 * browser's focus outline, so a screen showing both its chrome and this app's controls carries two different focus
 * treatments; handing the navigators this button instead gives the chrome the one every app control paints. The
 * `Button` primitive cannot serve here: a tab item carries `role="tab"` with `aria-selected`, is an anchor (`href`) on
 * web and renders react-navigation's own label node as its children. Nothing here imports a navigation package,
 * because `apps/mobile` declares none: the framework's props are read as plain values.
 *
 * Rest, hovered, focused and pressed are painted, each from a `@tablemate/shared` token alone, and the band is
 * reserved in all four, so the ring appearing moves nothing (WCAG 2.4.7).
 */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';
import type {
  GestureResponderEvent,
  PressableAndroidRippleConfig,
  PressableStateCallbackType,
  Role,
  StyleProp,
  ViewStyle,
} from 'react-native';
import {
  MIN_TOUCH_TARGET,
  borderWidths,
  colors,
  interactionOpacity,
  spacing,
} from '@tablemate/shared';

/**
 * Props of {@link NavButton}. Every one of them is already a value react-navigation hands its tab
 * bar's own button — the item's `href`, `role`, `aria-selected`, label node and press handlers — so
 * the bar is wired up by naming the fields it supplies and nothing else.
 */
export interface NavButtonProps {
  /**
   * The framework's own label node, rendered inside the pressable. A tab item passes
   * react-navigation's label, so its type role, colour and font scaling stay the framework's.
   */
  children?: ReactNode;
  /**
   * The anchor target on web. react-native-web renders the control as a real `<a>`, which is what
   * keeps the `Ctrl`-click and middle-click "open in a new tab" gestures, while a plain click is
   * handled in-app. React Native drops it on iOS and Android, where a tab item is not an anchor.
   */
  href?: string | undefined;
  /** Role announced for the control: `tab`, the role react-navigation gives a bar item on web. */
  role: Role;
  /**
   * Rendered as `aria-selected`, which React Native maps to `accessibilityState.selected` on iOS
   * and Android. The bar passes the item's own focused state.
   */
  selected?: boolean | undefined;
  /** Accessible name, rendered as `aria-label` and as `accessibilityLabel` off web. */
  accessibilityLabel?: string | undefined;
  /** Test handle, forwarded to the pressable (`data-testid` in the DOM on web). */
  testID?: string | undefined;
  /**
   * Invoked on press. The bar always supplies one at runtime — the item's own press handler — but
   * the framework's types leave it optional, so this one does too: without it the control keeps its
   * role, its label and its `href`, and on web the anchor navigates itself.
   */
  onPress?: ((event: GestureResponderEvent) => void) | undefined;
  /** Invoked on a long press, which a tab item uses to jump back to its first screen. */
  onLongPress?: ((event: GestureResponderEvent) => void) | null | undefined;
  /**
   * Android ripple configuration, forwarded as `android_ripple`. React Native declares this prop
   * nullable, as it does `onLongPress`, so both are taken here exactly as the framework hands them
   * over rather than narrowed at every call site.
   */
  androidRipple?: PressableAndroidRippleConfig | null | undefined;
  /**
   * The caller's layout, applied last: a tab item hands over the framework's own geometry (its
   * `flex`, `padding`, `borderRadius` and background), which is what keeps the bar's layout still.
   */
  style?: StyleProp<ViewStyle>;
}

/**
 * The fields of the DOM click a web press carries. react-native-web hands `onPress` the browser's
 * own click event, whose modifier keys and button decide whether the app or the browser acts on
 * it; React Native's event type declares none of them, and off web the event carries none.
 */
type WebClick = {
  readonly altKey?: boolean;
  readonly button?: number;
  readonly ctrlKey?: boolean;
  readonly currentTarget?: { readonly target?: string } | null;
  readonly defaultPrevented?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly preventDefault?: () => void;
};

/**
 * True for the one click the app handles itself: the left button, no modifier key, and an anchor
 * with no `target` (or `target="_self"`). Every other click belongs to the browser — a new tab, a
 * download — so the app leaves its navigation alone. This is the rule expo-router's own `<Link>`
 * applies (`useLinkToPathProps`), kept here because a navigator hands this button its `href` and
 * `onPress` rather than a `Link`.
 */
const isPlainSelfClick = (click: WebClick): boolean =>
  click.defaultPrevented !== true &&
  click.metaKey !== true &&
  click.ctrlKey !== true &&
  click.altKey !== true &&
  click.shiftKey !== true &&
  (click.button === undefined || click.button === 0) &&
  (click.currentTarget == null ||
    click.currentTarget.target === undefined ||
    click.currentTarget.target === '' ||
    click.currentTarget.target === '_self');

/**
 * Keeps the browser's own focus outline off the chrome on web, where it would otherwise be painted
 * over the reserved 2 px band and the ring a keyboard user sees would be the browser's default
 * rather than `colors.focusRing` (WCAG 2.4.7). React Native 0.76 declares no `outline` style, so
 * the long form is asserted once here; react-native-web drops the `outline` shorthand as an
 * invalid short form. The value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    // Reserved focus ring: 2 px painted transparent until the control takes keyboard focus, so
    // revealing the ring never moves its contents. Transparent rather than a fill, because the bar
    // behind the control already paints `colors.surface`, which a band in that fill could only
    // double. A tab item's own `padding`, `flex` and background arrive in `style` and are applied
    // over this.
    borderColor: 'transparent',
    borderStyle: 'solid',
    borderWidth: borderWidths.control,
    flexDirection: 'row',
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
  },
  // The ring is this reserved band rather than an added one, which is what keeps the layout still.
  focused: { borderColor: colors.focusRing },
  // The chrome's own fill is the lightest token there is — the tab bar's `colors.surface` and the
  // header's page — so the pointer steps are the token's opacity ones, the same pair every other
  // control whose fill cannot darken any further paints.
  hovered: { opacity: interactionOpacity.hover },
  pressed: { opacity: interactionOpacity.pressed },
});

/**
 * One piece of navigation chrome, painted as an app control. See {@link NavButtonProps} for the
 * contract and the module doc for the focus treatment it carries.
 */
export function NavButton({
  children,
  href,
  role,
  selected,
  accessibilityLabel,
  testID,
  onPress,
  onLongPress,
  androidRipple,
  style,
}: NavButtonProps): JSX.Element {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const handleBlur = useCallback(() => setFocused(false), []);
  const handleFocus = useCallback(() => setFocused(true), []);
  // Hover is a web state: React Native 0.76 declares the pair on `PressableProps` and
  // react-native-web forwards it to its hover hook, while iOS and Android never fire it, which is
  // what a state only a pointer can reach should do.
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  // A plain click is handled in-app and the anchor's own navigation is cancelled, which is what
  // react-navigation's `PlatformPressable` does for the same reason: without it the tab bar and
  // the header's back control would each load the whole app again instead of routing to the
  // screen. Every other click stays the browser's, which is what `href` is there for.
  const handlePress = useCallback(
    (event: GestureResponderEvent): void => {
      if (onPress === undefined) return;
      if (Platform.OS !== 'web' || href === undefined) {
        onPress(event);
        return;
      }
      const click = event as unknown as WebClick;
      if (!isPlainSelfClick(click)) return;
      click.preventDefault?.();
      onPress(event);
    },
    [href, onPress],
  );
  return (
    <Pressable
      android_ripple={androidRipple}
      onBlur={handleBlur}
      onFocus={handleFocus}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onLongPress={onLongPress}
      onPress={handlePress}
      role={role}
      // `href`, `aria-label`, `aria-selected` and `testID` are attached only when a caller supplies
      // one: an absent `href` has to leave the control a plain element rather than an anchor, and
      // an absent `aria-selected` has to leave a `link` without a tab-only state.
      {...(accessibilityLabel === undefined ? {} : { 'aria-label': accessibilityLabel })}
      {...(href === undefined ? {} : { href })}
      {...(selected === undefined ? {} : { 'aria-selected': selected })}
      {...(testID === undefined ? {} : { testID })}
      style={({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
        styles.base,
        hovered && styles.hovered,
        pressed && styles.pressed,
        focused && styles.focused,
        webFocusRingReset,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}
