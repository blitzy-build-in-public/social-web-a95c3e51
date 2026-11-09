/**
 * The one switch primitive every Tablemate screen places (AAP 0.5.8): the 18+ confirmation, the
 * lodging-call consent, the staying-visibility toggle and the operator registry's active-partner
 * controls.
 *
 * It is drawn from `@tablemate/shared` tokens alone. react-native-web's own `Switch` cannot be: it
 * sizes its track from a fixed `20px` height, paints the colours of its own Material defaults
 * (`#009688` for an ON thumb, `#939393`/`#FAFAFA` OFF, `#D5D5D5`/`#BDBDBD` disabled) for every prop
 * a call site leaves out, leaves its `input` — the element a pointer and the keyboard actually reach
 * — at 40x20, and shows the browser's focus outline. Here one element is the control, at least
 * `MIN_TOUCH_TARGET` in both dimensions (AAP 0.5.8: 44x44), with the track centred inside it.
 *
 * One keyboard stop and one switch reach assistive technology: `role="switch"` becomes
 * `accessibilityRole="switch"` on iOS and Android (React Native 0.76) and ARIA in the DOM on web
 * (react-native-web 0.19), `aria-checked` carries the state on both, and `disabled` both blocks the
 * toggle and keeps the control out of the tab order. Enter and Space each toggle it:
 * react-native-web's press responder activates a non-native element on Enter, and the spacebar —
 * which the browser gives to a button alone — is handled here, its default suppressed so the page
 * does not scroll.
 *
 * Five states are painted, all of them from tokens: default, hovered, focused, pressed and disabled.
 * ON is `primary` with an `onPrimary` thumb (the recorded 7.3:1 pair); OFF is `border` with the same
 * thumb, 3.71:1 over its track, above the 3:1 the `NON_TEXT_CONTRAST_PAIRS` records keep. The
 * disabled state follows `Button`: a `surface` fill, a `border` edge and a `textMuted` thumb. The
 * focus ring is the reserved `borderWidths.control` band, transparent until a keyboard user reaches
 * the control, so revealing it never moves the track (WCAG 2.4.7); on web that band is the whole
 * indicator, because `webFocusRingReset` keeps the user-agent outline off it. Hover and press dim
 * the control by `interactionOpacity.hover` and `interactionOpacity.pressed`, the two steps the
 * other primitives paint. The control carries no text and fixes no text size, so `allowFontScaling`
 * and the reader's own font size are untouched.
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
 * Props of {@link Switch}. The caller owns the state — there is no uncontrolled mode — and keeps its
 * visible label beside the control, passing the same words as `accessibilityLabel` so the control's
 * accessible name is the text a reader sees (WCAG 2.5.3).
 */
export interface SwitchProps {
  /** Accessible name of the control; the visible label the caller shows beside it. */
  accessibilityLabel: string;
  /** Current state: `true` ON, `false` OFF. */
  value: boolean;
  /** Called with the next state on every toggle. Never called while `disabled`. */
  onValueChange: (next: boolean) => void;
  /** Blocks the toggle, keeps the control out of the tab order and announces it as unavailable. */
  disabled?: boolean;
  /** Test handle, forwarded to the control (`age-gate-adult`, `claim-consent`, ...). */
  testID?: string;
}

/**
 * The track the platform's own switch draws, measured from tokens rather than fixed: the target less
 * the band its keyboard focus ring reserves, and half of that again in height.
 *
 * The thumb is the track's height less the gap it keeps inside the track, so the travel between the
 * two states is whatever the track has left — no offset is written down.
 */
const TRACK_WIDTH = MIN_TOUCH_TARGET - borderWidths.control * 2;
const TRACK_HEIGHT = TRACK_WIDTH / 2;
const THUMB_SIZE = TRACK_HEIGHT - borderWidths.edge * 2;

/**
 * Space toggles the control on web. The press responder react-native-web installs treats the
 * spacebar as a key for buttons alone, and this control must not take a second role to earn it, so
 * the handler is added here and suppresses the key's default page scroll. React Native 0.76 declares
 * no key event, so the web-only object is asserted the way the `link` rows of `ListItem` assert
 * theirs; the value is empty off web, which never reads it.
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

/**
 * Keeps the browser's own focus outline off a focused control on web, where it would otherwise be
 * painted over the reserved band and the ring a keyboard user sees would be the browser's default
 * rather than `colors.focusRing` (WCAG 2.4.7). React Native 0.76 declares no `outline` style, so the
 * long form is asserted once here; react-native-web drops the `outline` shorthand as an invalid
 * short form. The value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

const styles = StyleSheet.create({
  control: {
    alignItems: 'center',
    // The reserved band of the keyboard focus ring: always the same width, and painted in no colour
    // until a keyboard user focuses the control, which is what keeps the track still (WCAG 2.4.7).
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
    // The edge is painted in every state — the fill's own colour when the control is live, the
    // border token when it is not — so the disabled state never resizes the track.
    borderWidth: borderWidths.edge,
    borderRadius: radii.pill,
    flexDirection: 'row',
    height: TRACK_HEIGHT,
    padding: borderWidths.edge,
    width: TRACK_WIDTH,
  },
  // ON and OFF differ in the track's colour and in the end the thumb sits at, which the main axis
  // resolves per writing direction.
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

/**
 * An accessible switch. See {@link SwitchProps} for the contract, and the module doc for the target
 * size, the palette and the keyboard guarantees it makes.
 */
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
  // Hover is a web state: React Native 0.76 declares the pair on `PressableProps` and
  // react-native-web forwards it to its hover hook, while iOS and Android never fire it, which is
  // what a state only a pointer can reach should do.
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
      // `testID` renders as `data-testid`, so it is attached only when a caller supplies one rather
      // than as an explicit `undefined` prop.
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
