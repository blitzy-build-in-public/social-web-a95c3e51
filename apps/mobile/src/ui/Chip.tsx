/**
 * The one selectable-chip primitive every Tablemate screen places (AAP 0.5.8): one option of a group in which at most
 * one is chosen — a city, a variant pairing, a queue category, a drink or a lodging kind.
 *
 * Six states are painted, each reachable on the platform that can produce it: default, hovered (a pointer, through
 * React Native's `onHoverIn`/`onHoverOut`, which react-native-web forwards and iOS and Android never fire), focused,
 * pressed, selected, and selected with focus. Selection is never colour alone: the chosen chip takes the `surface`
 * fill, the `primary` boundary and a bold `primary` label, and reports itself as chosen to assistive technology.
 *
 * Every pair the chip paints is one `ui-tokens.ts` records — `focusRing`/`surface` 6.04:1, `primary`/`surface`
 * 6.59:1, `border`/`surface` 3.34:1, `border`/`background` 3.7:1, `text`/`surface` 15.52:1 and `text`/`background`
 * 17.21:1. The selected fill is deliberately the soft `colors.surface` and not a filled `colors.primary`: a
 * `focusRing` boundary over a `primary` fill measures about 1.09:1 and is recorded nowhere, so a keyboard user could
 * not tell which of two chips in a group holds the choice while it is focused. The outline is the reserved
 * `borderWidths.control` band rather than an added one, which keeps the layout still when focus moves (WCAG 2.4.7),
 * and the target stays at least `MIN_TOUCH_TARGET` (AAP 0.5.8: 44x44) with `allowFontScaling` on (WCAG 1.4.4).
 *
 * `aria-checked` is the selected state's programmatic form: react-native-web writes it into the DOM for the
 * `role="radio"` this control carries, and React Native 0.76 maps `aria-checked` to `accessibilityState.checked` on
 * iOS and Android, so VoiceOver and TalkBack announce which option of the group is chosen. On web the control also
 * answers Space itself, because react-native-web answers Space only for a native button or a `role="button"`; Enter
 * stays with the press responder, so one press is never fired twice.
 */
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import type { ViewStyle } from 'react-native';
import {
  MIN_TOUCH_TARGET,
  borderWidths,
  colors,
  fontWeights,
  interactionOpacity,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';

/**
 * Props of {@link Chip}. `label` is both the visible text and the accessible name, so a caller
 * never needs a second name for assistive technology, and `selected` is the group's state rather
 * than the chip's own.
 */
export interface ChipProps {
  /** Visible text, and the accessible name of the control. */
  label: string;
  /** Whether this chip is its group's chosen option; reported to assistive technology as `aria-checked`. */
  selected: boolean;
  /** Invoked on press. */
  onPress: () => void;
  /** Test id, forwarded to the pressable (`data-testid` in the DOM on web). */
  testID?: string;
}

/**
 * Keeps the browser's own focus outline off a focused chip on web, where it would otherwise be
 * painted over the reserved 2 px band and the ring a keyboard user sees would be the browser's
 * default rather than `colors.focusRing` (WCAG 2.4.7). React Native 0.76 declares no `outline`
 * style, so the long form is asserted once here; react-native-web drops the `outline` shorthand as
 * an invalid short form. The value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

/** A keydown as react-native-web delivers it: only the fields this control reads are named. */
type WebKeyEvent = Readonly<{ key?: string; repeat?: boolean; preventDefault?: () => void }>;

/**
 * Space activates the chip on web, and only on web: react-native-web answers Space for a native
 * button or a `role="button"`, which a `role="radio"` control is not, so the key would otherwise do
 * nothing. Enter is left to the press responder, which already answers it, so a key held down
 * (`event.repeat`) and a released key never fire a second press. Off web the returned object is
 * empty, which is also what keeps an `onKeyDown` prop off the native pressable.
 */
function spaceActivates(activate: () => void): { onKeyDown?: (event: WebKeyEvent) => void } {
  if (Platform.OS !== 'web') return {};
  const onKeyDown = (event: WebKeyEvent): void => {
    if (event.repeat === true || (event.key !== ' ' && event.key !== 'Spacebar')) return;
    event.preventDefault?.();
    activate();
  };
  return { onKeyDown };
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderStyle: 'solid',
    borderWidth: borderWidths.control,
    borderColor: colors.border,
    borderRadius: radii.pill,
    backgroundColor: colors.background,
  },
  hovered: { backgroundColor: colors.surface },
  pressed: { opacity: interactionOpacity.pressed },
  selected: { backgroundColor: colors.surface, borderColor: colors.primary },
  focused: { borderColor: colors.focusRing },
  label: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  labelSelected: { color: colors.primary, fontWeight: fontWeights.bold },
});

/**
 * One selectable chip of a `role="radiogroup"` row. See {@link ChipProps} for the contract and the
 * module doc for the six painted states, the token-only styling and the accessibility guarantees.
 */
export function Chip({ label, selected, onPress, testID }: ChipProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  return (
    <Pressable
      {...spaceActivates(onPress)}
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      // `testID` renders as `data-testid`, so it is attached only when a caller supplies one rather
      // than as an explicit `undefined` prop.
      {...(testID === undefined ? {} : { testID })}
      // The press state comes from the style callback, which is what reaches the element on native
      // and on web alike; a selected chip keeps its own fill while held, so the hover fill is
      // painted only on the option that is not the group's choice.
      style={({ pressed }) => [
        styles.chip,
        hovered && !selected ? styles.hovered : null,
        pressed ? styles.pressed : null,
        selected ? styles.selected : null,
        focused ? styles.focused : null,
        webFocusRingReset,
      ]}
    >
      <Text style={[styles.label, selected ? styles.labelSelected : null]}>{label}</Text>
    </Pressable>
  );
}
