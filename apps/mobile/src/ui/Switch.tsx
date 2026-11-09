/**
 * The one switch primitive every screen places (AAP 0.5.8): the 18+ confirmation, the lodging-call consent, the
 * staying-visibility toggle and the operator registry's active-partner controls.
 *
 * Drawn from `@tablemate/shared` tokens alone, which react-native-web's own `Switch` cannot be: it sizes its track from
 * a fixed 20px height, paints its Material defaults for every prop a call site leaves out, leaves its `input` — the
 * element a pointer and the keyboard actually reach — at 40x20, and shows the browser's focus outline. Here one element
 * is the control, at least `MIN_TOUCH_TARGET` in both dimensions (44x44), with the track centred inside it.
 * One keyboard stop and one switch reach assistive technology: `role="switch"` becomes `accessibilityRole` on iOS and
 * Android and ARIA in the DOM on web, `aria-checked` carries the state on both, and `disabled` both blocks the toggle
 * and keeps the control out of the tab order. Enter and Space each toggle it: react-native-web's press responder
 * activates a non-native element on Enter, and the spacebar is handled here, its default suppressed so the page does not
 * scroll.
 * Five states are painted, all from tokens. The focus ring is the reserved `borderWidths.control` band, transparent
 * until a keyboard user reaches the control, so revealing it never moves the track (WCAG 2.4.7), and on web that band is
 * the whole indicator. The control carries no text, so `allowFontScaling` is untouched.
 */
import { useCallback, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import type { PressableStateCallbackType, StyleProp, ViewStyle } from 'react-native';
import {
  MIN_TOUCH_TARGET,
  borderWidths,
  colors,
  interactionOpacity,
  radii,
} from '@tablemate/shared';
/**
 * The caller owns the state — there is no uncontrolled mode — and passes the visible label it shows beside
 * the control as `accessibilityLabel`, so the name is the text a reader sees (WCAG 2.5.3).
 */
export interface SwitchProps {
  accessibilityLabel: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  testID?: string;
}

/**
 * The track is measured from tokens rather than fixed: the target less the band its focus ring reserves, and
 * half of that again in height. The thumb is the track's height less the gap it keeps inside it, so the
 * travel between the two states is whatever the track has left and no offset is written down.
 */
const TRACK_WIDTH = MIN_TOUCH_TARGET - borderWidths.control * 2;
const TRACK_HEIGHT = TRACK_WIDTH / 2;
const THUMB_SIZE = TRACK_HEIGHT - borderWidths.edge * 2;
/**
 * Space toggles the control on web: the press responder react-native-web installs treats the spacebar as a
 * key for buttons alone, and this control must not take a second role to earn it, so the handler suppresses
 * the key's default page scroll. React Native 0.76 declares no key event, so the web-only object is asserted
 * as the `link` rows of `ListItem` assert theirs; empty off web, which never reads it.
 */
const spaceKey = (
  toggle: () => void,
  disabled: boolean,
): {
  onKeyDown?: (event: { key?: string; repeat?: boolean; preventDefault?: () => void }) => void;
} =>
  Platform.OS !== 'web'
    ? {}
    : {
        onKeyDown: (event) => {
          if (disabled || event.key !== ' ' || event.repeat === true) return;
          event.preventDefault?.();
          toggle();
        },
      };

// The browser's own focus outline is kept off the band this control reserves for its focus ring, so the ring a
// keyboard user sees is the app's own; on web React Native declares no `outline` style, so the long form is asserted
// here and the value is empty off web, which never reads it.
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

const styles = StyleSheet.create({
  control: {
    alignItems: 'center',
    // The reserved band of the keyboard focus ring: the same width in every state, painted in no colour until a keyboard user focuses the control, which keeps the track still (WCAG 2.4.7).
    borderColor: 'transparent',
    borderRadius: radii.md,
    borderWidth: borderWidths.control,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
  },
  // The two pointer steps every other primitive paints, applied over the whole control.
  hovered: { opacity: interactionOpacity.hover },
  pressed: { opacity: interactionOpacity.pressed },
  focused: { borderColor: colors.focusRing },
  track: {
    alignItems: 'center',
    // The edge is painted in every state, so the disabled state never resizes the track.
    borderWidth: borderWidths.edge,
    borderRadius: radii.pill,
    flexDirection: 'row',
    height: TRACK_HEIGHT,
    padding: borderWidths.edge,
    width: TRACK_WIDTH,
  },
  // ON and OFF differ in the track's colour and in the end the thumb sits at, which the main axis resolves per writing direction.
  trackOn: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    justifyContent: 'flex-end',
  },
  trackOff: {
    backgroundColor: colors.border,
    borderColor: colors.border,
    justifyContent: 'flex-start',
  },
  trackDisabled: { backgroundColor: colors.surface, borderColor: colors.border },
  thumb: { borderRadius: radii.pill, height: THUMB_SIZE, width: THUMB_SIZE },
  thumbOn: { backgroundColor: colors.onPrimary },
  thumbDisabled: { backgroundColor: colors.textMuted },
});

export function Switch({
  accessibilityLabel,
  value,
  onValueChange,
  disabled = false,
  testID,
}: SwitchProps): JSX.Element {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const toggle = useCallback((): void => onValueChange(!value), [onValueChange, value]);
  // Hover is a web-only state: React Native 0.76 declares the pair and react-native-web forwards it; iOS and Android never fire it.
  const handleHoverIn = useCallback((): void => setHovered(true), []);
  const handleHoverOut = useCallback((): void => setHovered(false), []);

  return (
    <Pressable
      {...spaceKey(toggle, disabled)}
      aria-checked={value}
      aria-label={accessibilityLabel}
      disabled={disabled}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onPress={toggle}
      role="switch"
      style={({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
        styles.control,
        hovered && !disabled ? styles.hovered : null,
        pressed ? styles.pressed : null,
        focused ? styles.focused : null,
        webFocusRingReset,
      ]}
      {...(testID === undefined ? {} : { testID })}
    >
      <View
        style={[
          styles.track,
          value ? styles.trackOn : styles.trackOff,
          disabled ? styles.trackDisabled : null,
        ]}
      >
        <View style={[styles.thumb, disabled ? styles.thumbDisabled : styles.thumbOn]} />
      </View>
    </Pressable>
  );
}
