/**
 * The one selectable-chip primitive every screen places (AAP 0.5.8): one option of a group in which at most one is
 * chosen — a city, a variant pairing, a queue category, a drink or a lodging kind.
 *
 * Six states are painted, hover being pointer-only. Selection is never colour alone: the chosen chip takes the `surface`
 * fill, the `primary` boundary and a bold `primary` label, and reports itself as chosen. That fill is the soft
 * `colors.surface` rather than a filled `primary`, because a `focusRing` boundary over a `primary` fill measures about
 * 1.09:1 and is recorded nowhere, so a keyboard user could not tell which of two chips holds the choice while focused.
 * On web the control answers Space itself, since react-native-web answers Space only for a native button or a
 * `role="button"`; Enter stays with the press responder, so one press is never fired twice.
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

export interface ChipProps {
  label: string;
  /** Whether this chip is its group's chosen option; reported to assistive technology as `aria-checked`. */
  selected: boolean;
  onPress: () => void;
  testID?: string;
}

// The browser's own focus outline is kept off the band this control reserves for its focus ring, so the ring a
// keyboard user sees is the app's own; on web React Native declares no `outline` style, so the long form is asserted
// here and the value is empty off web, which never reads it.
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;
/** A keydown as react-native-web delivers it: only the fields this control reads are named. */
type WebKeyEvent = Readonly<{ key?: string; repeat?: boolean; preventDefault?: () => void }>;

// Space activates the chip on web, and only on web: react-native-web answers Space for a native button or a
// `role="button"`, which a `role="radio"` control is not, so the key would otherwise do nothing. Enter stays
// with the press responder, so one press is never fired twice.
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
      {...(testID === undefined ? {} : { testID })}
      // The press state comes from the style callback, which is what reaches the element on native and on web alike.
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
