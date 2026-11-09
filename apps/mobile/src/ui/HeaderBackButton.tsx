/**
 * The web header's back control, drawn rather than loaded (AAP 0.5.8). A navigator's own control is an `Image` over a
 * bundled 96x96 PNG, so every header with a back entry makes an image request as soon as it renders; this draws the same
 * chevron with `react-native-svg`, already in the web bundle.
 *
 * Its accessible name and role are stated outright rather than left to the glyph, so assistive technology announces what
 * the default control announced — `Go back`, as a button — and a keyboard reaches it by Tab and activates it with Enter
 * or Space (WCAG 2.1 AA). Its focus ring is the reserved boundary band `Button` paints, so focusing it moves no layout.
 * {@link renderWebHeaderLeft} is what `./NavigationHeader` spreads into a web navigator's screen options, and only under
 * `Platform.OS === 'web'`: on iOS and Android the platform header keeps the control it has today.
 */
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';
import type { ViewProps, ViewStyle } from 'react-native';
import { Path, Svg } from 'react-native-svg';
import {
  MIN_TOUCH_TARGET,
  borderWidths,
  colors,
  interactionOpacity,
  radii,
  spacing,
} from '@tablemate/shared';
/**
 * The props a header hands its back control. Every field is optional, because the props are spread straight from
 * `expo-router`'s `Stack` and `Tabs` screen options, so a field this control does not read is tolerated and
 * ignored rather than declared; it draws its own glyph and paints its own states.
 */
export interface HeaderBackButtonProps {
  canGoBack?: boolean;
  /** The navigator's own go-back. Without it nothing is drawn: a back control that cannot navigate back is worse than no control. */
  onPress?: () => void;
  tintColor?: string;
  /** The navigator's label for the previous screen. Not read: the accessible name is fixed below. */
  label?: string;
}

// The name assistive technology announces, which is the name the platform's own back control announces on web.
const GO_BACK_NAME = 'Go back';

// The square the chevron is drawn in: 24, the size the header's own glyph renders at today (`spacing.xl`).
const GLYPH_SIZE = spacing.xl;

// The chevron in that box: a point at x 15 opening to y 4.5 and 19.5, so it sits centred and points the way the platform's own arrow points.
const CHEVRON = 'M15 4.5 L7.5 12 L15 19.5';
/** The chevron's weight, the 2-point stroke a control's own boundary paints. */
const CHEVRON_STROKE = borderWidths.control;

// The browser's own focus outline is kept off the band this control reserves for its focus ring, so the ring a
// keyboard user sees is the app's own; on web React Native declares no `outline` style, so the long form is asserted
// here and the value is empty off web, which never reads it.
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;
/**
 * Keeps the glyph out of the accessibility tree, so the control is announced once, under its own name. Native
 * reads a different prop per platform — `accessibilityElementsHidden` on iOS, `importantForAccessibility` on
 * Android — while react-native-web renders the ARIA attribute alone; the two React Native props are left off web
 * on purpose, because react-native-svg's web element would emit them into the DOM as invalid attributes, which
 * React reports as a warning on every render.
 */
const GLYPH_HIDDEN: Pick<
  ViewProps,
  'aria-hidden' | 'accessibilityElementsHidden' | 'importantForAccessibility'
> =
  Platform.OS === 'web'
    ? { 'aria-hidden': true }
    : { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no' };

const styles = StyleSheet.create({
  control: {
    alignItems: 'center',
    justifyContent: 'center',
    // The target stays at least `MIN_TOUCH_TARGET` (AAP 0.5.8: 44x44), which the glyph plus the padding reaches.
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: borderWidths.control,
    borderStyle: 'solid',
    borderColor: colors.border,
  },
  pressed: { opacity: interactionOpacity.pressed },
  // The ring is this reserved band rather than an added one, which is what keeps the layout still.
  focused: { borderColor: colors.focusRing },
});

export function HeaderBackButton(props: HeaderBackButtonProps): ReactElement | null {
  const { canGoBack, onPress, tintColor } = props;
  const [focused, setFocused] = useState(false);
  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);

  // A tab root holds no back entry and a header may pass no handler; both render nothing here.
  if (canGoBack !== true || onPress === undefined) return null;

  return (
    <Pressable
      role="button"
      aria-label={GO_BACK_NAME}
      onBlur={handleBlur}
      onFocus={handleFocus}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        pressed && styles.pressed,
        focused && styles.focused,
        webFocusRingReset,
      ]}
    >
      <Svg
        {...GLYPH_HIDDEN}
        height={GLYPH_SIZE}
        viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
        width={GLYPH_SIZE}
      >
        <Path
          d={CHEVRON}
          fill="none"
          stroke={tintColor ?? colors.text}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={CHEVRON_STROKE}
        />
      </Svg>
    </Pressable>
  );
}

/**
 * The `headerLeft` renderer the app's chrome hands every web navigator (AAP 0.5.8), so the navigator's own
 * image-backed control is never drawn there. Off web no such option is spread, which leaves the platform header
 * exactly as it is.
 */
export function renderWebHeaderLeft(props: HeaderBackButtonProps): ReactElement | null {
  return <HeaderBackButton {...props} />;
}
