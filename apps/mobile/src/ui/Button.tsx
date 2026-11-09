/**
 * The one action-button primitive every Tablemate screen places (AAP 0.5.8): a screen's primary action, a secondary
 * action beside it, or a destructive one.
 *
 * Its accessible name is always the visible label: `role` and `aria-label` reach
 * `accessibilityRole`/`accessibilityLabel`/`accessibilityState` on iOS and Android and ARIA in the DOM on web, and a
 * `busy` button keeps its label while reporting itself as both busy and disabled. Six states are painted — default,
 * hovered, focused, pressed, disabled and busy/loading — and a disabled or busy control can hold neither hover nor
 * focus, so it paints neither.
 *
 * Every value comes from `@tablemate/shared`, and each pair used here is recorded in its `CONTRAST_PAIRS` or
 * `NON_TEXT_CONTRAST_PAIRS` (WCAG 2.1 AA for sign-in, proposal, lock and check-in). The border is painted in every
 * state, so the keyboard focus ring cannot shift the layout (WCAG 2.4.7), and on web that band is the whole focus
 * indicator, because `webFocusRingReset` suppresses the user-agent outline the browser would paint over it. The
 * target stays at least `MIN_TOUCH_TARGET` (AAP 0.5.8: 44x44) with no fixed height and `allowFontScaling` on, so the
 * label follows the system font size (WCAG 1.4.4).
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
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
import type { ColorToken } from '@tablemate/shared';

/**
 * The three button roles. `primary` is the screen's main action, `secondary` an alternative
 * offered beside it, `danger` an irreversible or data-destroying action.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger';

/**
 * Props of {@link Button}. `label` is both the visible text and the accessible name, so a caller
 * never needs a second name for assistive technology; `disabled` and `busy` each block the press and
 * are reported to assistive technology, `busy` adding a spinner beside the still-visible label; and
 * `style` carries layout only — margin, `alignSelf`, `flex` — because the colours belong to the
 * variant.
 */
export interface ButtonProps {
  /** Visible text, and the accessible name of the control. */
  label: string;
  /** Invoked on press. Never called while `disabled` or `busy`. */
  onPress: () => void;
  /** Role of the action. Defaults to `primary`. */
  variant?: ButtonVariant;
  /** Renders the disabled state, blocks the press and is announced as dimmed. */
  disabled?: boolean;
  /** Shows a spinner beside the label and blocks the press while an action is in flight. */
  busy?: boolean;
  /** Native accessibility hint. Not used on web, which has no ARIA equivalent. */
  hint?: string;
  /** Test id, forwarded to the pressable (`data-testid` in the DOM on web). */
  testID?: string;
  /** Layout only — margin, `alignSelf`, `flex`. Never a colour. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Keeps the browser's own focus outline off a focused button on web, where it would otherwise be
 * painted over the reserved 2 px band and the ring a keyboard user sees would be the browser's
 * default rather than `colors.focusRing` (WCAG 2.4.7). React Native 0.76 declares no `outline`
 * style, so the long form is asserted once here; react-native-web drops the `outline` shorthand as
 * an invalid short form. The value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

const styles = StyleSheet.create({
  base: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: borderWidths.control,
    borderStyle: 'solid',
  },
  label: {
    flexShrink: 1,
    fontSize: typography.label.fontSize,
    lineHeight: typography.label.lineHeight,
    fontWeight: fontWeights.bold,
    textAlign: 'center',
  },
  primary: { backgroundColor: colors.primary, borderColor: colors.primary },
  secondary: { backgroundColor: colors.background, borderColor: colors.border },
  danger: { backgroundColor: colors.danger, borderColor: colors.danger },
  primaryLabel: { color: colors.onPrimary },
  secondaryLabel: { color: colors.text },
  dangerLabel: { color: colors.onDanger },
  disabled: { backgroundColor: colors.surface, borderColor: colors.border },
  disabledLabel: { color: colors.textMuted },
  // The ring is this reserved band rather than an added one, which is what keeps the layout still:
  // React Native 0.76 exposes no outline style of its own and `webFocusRingReset` keeps the
  // browser's focus outline off the band on web, so the band is the ring a keyboard user sees.
  focused: { borderColor: colors.focusRing },
  pressedFilled: { opacity: interactionOpacity.pressed },
  pressedOutlined: { backgroundColor: colors.surface },
  // How each variant answers the pointer: a filled one dims by the token's `hover` opacity, which
  // is the step above its press, and the outlined one — whose own fill is already the lightest
  // token — takes the `surface` fill its press paints.
  hoveredFilled: { opacity: interactionOpacity.hover },
  hoveredOutlined: { backgroundColor: colors.surface },
});

/**
 * What a variant supplies. `labelToken` names the label colour, so the spinner can take the same
 * one without a second table; the pairs are `onPrimary`/`primary`, `text`/`background` and
 * `onDanger`/`danger`.
 */
interface VariantSpec {
  readonly container: StyleProp<ViewStyle>;
  readonly label: StyleProp<TextStyle>;
  readonly labelToken: ColorToken;
  readonly hovered: StyleProp<ViewStyle>;
  readonly pressed: StyleProp<ViewStyle>;
}

const VARIANTS: Record<ButtonVariant, VariantSpec> = {
  primary: {
    container: styles.primary,
    label: styles.primaryLabel,
    labelToken: 'onPrimary',
    hovered: styles.hoveredFilled,
    pressed: styles.pressedFilled,
  },
  secondary: {
    container: styles.secondary,
    label: styles.secondaryLabel,
    labelToken: 'text',
    hovered: styles.hoveredOutlined,
    pressed: styles.pressedOutlined,
  },
  danger: {
    container: styles.danger,
    label: styles.dangerLabel,
    labelToken: 'onDanger',
    hovered: styles.hoveredFilled,
    pressed: styles.pressedFilled,
  },
};

/**
 * An accessible action button. See {@link ButtonProps} for the contract and the module doc for the
 * accessibility and contrast guarantees.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  hint,
  testID,
  style,
}: ButtonProps) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);
  // Hover is a web state: React Native 0.76 declares the pair on `PressableProps` and
  // react-native-web forwards it to its hover hook, while iOS and Android never fire it, which is
  // what a state only a pointer can reach should do.
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const variantSpec = VARIANTS[variant];
  // A busy button refuses presses exactly as a disabled one does, while keeping the variant's
  // colours so the action still reads as running rather than as unavailable.
  const inactive = disabled || busy;
  // An inactive control is unfocusable, and web takes focus off it without firing a blur event, so
  // the flags above would otherwise stay set: a ring or a hover fill painted on a control nothing is
  // pointing at, and painted again the moment an edit re-enables the button. The clear rides a 0 ms
  // timer because `react-hooks/set-state-in-effect` refuses a synchronous state update in an effect
  // body; the cancellable timer is this codebase's answer to that rule (`app/meetups/propose.tsx`),
  // and a button that re-activates before the tick keeps the state it has.
  useEffect(() => {
    if (!inactive) return undefined;
    const clear = setTimeout(() => {
      setFocused(false);
      setHovered(false);
    }, 0);
    return () => clearTimeout(clear);
  }, [inactive]);
  const spinnerColor = disabled ? colors.textMuted : colors[variantSpec.labelToken];
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={inactive}
      aria-busy={busy}
      disabled={inactive}
      onPress={onPress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      // `hint` has no ARIA equivalent and `testID` renders as `data-testid`, so each is attached
      // only when a caller supplies one rather than as an explicit `undefined` prop.
      {...(hint === undefined ? {} : { accessibilityHint: hint })}
      {...(testID === undefined ? {} : { testID })}
      style={({ pressed }) => [
        styles.base,
        variantSpec.container,
        hovered && !inactive && variantSpec.hovered,
        disabled && styles.disabled,
        pressed && variantSpec.pressed,
        focused && !inactive && styles.focused,
        webFocusRingReset,
        style,
      ]}
    >
      {busy ? <ActivityIndicator aria-hidden color={spinnerColor} size="small" /> : null}
      <Text style={[styles.label, variantSpec.label, disabled && styles.disabledLabel]}>
        {label}
      </Text>
    </Pressable>
  );
}
