/**
 * The navigation chrome's own button: the four bottom tab items (AAP 0.5.8); the stack header's back control is
 * `./HeaderBackButton`.
 *
 * react-navigation paints its chrome with `PlatformPressable`, an anchor on web that falls back to the browser's focus
 * outline, so handing the navigators this button gives the chrome the one focus treatment every app control paints.
 * `Button` cannot serve here: a tab item carries `role="tab"` with `aria-selected`, is an anchor with `href` on web, and
 * renders react-navigation's own label node as its children. Nothing here imports a navigation package, because
 * `apps/mobile` declares none.
 * Rest, hovered, focused and pressed are painted from tokens alone, the band reserved in all four, so the ring appearing
 * moves nothing (WCAG 2.4.7).
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

export interface NavButtonProps {
  /** The framework's own label node, rendered inside the pressable, so its type role, colour and font scaling stay the framework's. */
  children?: ReactNode;
  /** The anchor target on web, which is what keeps the Ctrl-click and middle-click "open in a new tab" gestures; React Native drops it on iOS and Android. */
  href?: string | undefined;
  role: Role;
  /** Rendered as `aria-selected`, which React Native maps to `accessibilityState.selected` on iOS and Android. */
  selected?: boolean | undefined;
  accessibilityLabel?: string | undefined;
  testID?: string | undefined;
  /** The bar always supplies one at runtime; the framework's types leave it optional, so this one does too — without it the control keeps its role, label and `href`, and on web the anchor navigates itself. */
  onPress?: ((event: GestureResponderEvent) => void) | undefined;
  onLongPress?: ((event: GestureResponderEvent) => void) | null | undefined;
  androidRipple?: PressableAndroidRippleConfig | null | undefined;
  /** The caller's layout, applied last: a tab item hands over the framework's own geometry, which keeps the bar's layout still. */
  style?: StyleProp<ViewStyle>;
}

/** The fields of the DOM click a web press carries, whose modifier keys and button decide whether the app or the browser
 * acts on it. */
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
 * True for the one click the app handles itself: the left button, no modifier key, and an anchor with no
 * `target` (or `target="_self"`). Every other click belongs to the browser, so the app leaves its
 * navigation alone — the rule expo-router's own `<Link>` applies in `useLinkToPathProps`.
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

// The browser's own focus outline is kept off the band this control reserves for its focus ring, so the ring a
// keyboard user sees is the app's own; on web React Native declares no `outline` style, so the long form is asserted
// here and the value is empty off web, which never reads it.
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    // Reserved focus ring: 2 px painted transparent until the control takes keyboard focus, so revealing the
    // ring never moves its contents. Transparent rather than a fill, because the bar behind the control
    // already paints `colors.surface`, which a band in that fill could only double.
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
  // The chrome's own fill is the lightest token there is, so the pointer steps are the token's opacity ones,
  // the pair every other control whose fill cannot darken further paints.
  hovered: { opacity: interactionOpacity.hover },
  pressed: { opacity: interactionOpacity.pressed },
});

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
  // Hover is a web-only state: React Native 0.76 declares the pair and react-native-web forwards it to its hover hook; iOS and Android never fire it.
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  // A plain click is handled in-app and the anchor's own navigation is cancelled, as react-navigation's
  // `PlatformPressable` does for the same reason: without it the chrome would load the whole app again
  // instead of routing. Every other click stays the browser's.
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
