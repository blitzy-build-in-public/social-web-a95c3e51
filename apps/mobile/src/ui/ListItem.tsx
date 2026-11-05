/**
 * The list row every list screen is built from: traveler discovery, meetups, the lodging
 * directory and Profile settings (AAP 0.5.8).
 *
 * Given `onPress` the row is a control — a `link` for rows that navigate, a `button`
 * otherwise — announced once, under an accessible name that is the row's own visible text:
 * label, then subtitle, then whatever `trailing` shows. Enter and Space activate a `button`
 * row, and Enter activates a `link` row. Without `onPress` the row is plain content with no
 * role at all.
 *
 * The row deliberately sets no `aria-label`. A name written from the label and subtitle
 * cannot contain the row's other visible text (WCAG 2.5.3, Label in Name), and the platform's
 * grouping of the row's own text already names it completely: VoiceOver and TalkBack read
 * one row, and react-native-web exposes one element whose browser-computed name is the
 * visible text. Every call site therefore keeps `trailing` to text that belongs in the name
 * and marks decoration `aria-hidden`.
 *
 * Every colour, space and type size comes from `@tablemate/shared` tokens: the text pairs
 * are `CONTRAST_PAIRS` records and the separator and focus ring are `NON_TEXT_CONTRAST_PAIRS`
 * records, so no pair is painted that has not been measured. On web the reserved band is the
 * focus ring a keyboard user sees, because `webFocusRingReset` keeps the browser's own outline
 * off a pressable row; a row without `onPress` is not focusable and carries no such reset.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PressableStateCallbackType, StyleProp, ViewStyle } from 'react-native';
import { MIN_TOUCH_TARGET, colors, fontWeights, spacing, typography } from '@tablemate/shared';

/**
 * Props of {@link ListItem}.
 */
export interface ListItemProps {
  /** Visible primary text, always part of the row's accessible name. */
  label: string;
  /** Optional second line, announced after the label. */
  subtitle?: string;
  /** Node before the text column, such as an `Avatar`; never a second control. */
  leading?: ReactNode;
  /** Node after the text column: a rank, a guest count, a status word. */
  trailing?: ReactNode;
  /** Makes the row an activatable control; omitted, the row is plain content. */
  onPress?: () => void;
  /** Role announced for a control: `link` when the row navigates, else `button`. */
  role?: 'button' | 'link';
  /** Marks the control unavailable; a row without `onPress` ignores it. */
  disabled?: boolean;
  /** Test handle, forwarded to the root element (`traveler-<id>`, `lodging-<id>`, ...). */
  testID?: string;
}

/**
 * One row of a list.
 *
 * The row is a flex row of `leading`, a text column (`label`, then `subtitle`) and
 * `trailing`, never a fixed height: it grows with the reader's font size and both text lines
 * wrap instead of truncating, so scaled text stays readable. A pressable row is one
 * accessible element — its children are grouped under the row's accessible name, so `leading`
 * and `trailing` carry decoration and status text, never a control of their own.
 */
export function ListItem({
  label,
  subtitle,
  leading,
  trailing,
  onPress,
  role = 'button',
  disabled = false,
  testID,
}: ListItemProps): JSX.Element {
  const [focused, setFocused] = useState(false);

  const children = (
    <>
      {leading}
      <View style={styles.textColumn}>
        <Text style={[styles.label, disabled ? styles.textDisabled : null]}>{label}</Text>
        {subtitle ? (
          <Text style={[styles.subtitle, disabled ? styles.textDisabled : null]}>{subtitle}</Text>
        ) : null}
      </View>
      {trailing}
    </>
  );

  if (onPress === undefined) {
    return (
      <View style={styles.row} testID={testID}>
        {children}
      </View>
    );
  }

  const activate: () => void = onPress;

  // react-native-web withholds `onPress` from an element whose role is `link`, assuming the
  // browser activates a link itself (PressResponder's key-up handler skips `role="link"`,
  // `a`, `button`, `input`, `select` and `textarea`). A row is a `div` with no href, so Enter
  // would do nothing at all: a link row therefore activates on Enter itself, on web only,
  // because the platform's responder already covers a `button` row and React Native has no
  // key events.
  const linkKeys: { onKeyDown?: (event: { key?: string; repeat?: boolean }) => void } =
    Platform.OS === 'web' && role === 'link'
      ? {
          onKeyDown: (event) => {
            if (!disabled && event.key === 'Enter' && event.repeat !== true) {
              activate();
            }
          },
        }
      : {};

  const rowStyle = ({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
    styles.row,
    pressed && !disabled ? styles.rowPressed : null,
    focused ? styles.rowFocused : null,
    webFocusRingReset,
  ];

  return (
    <Pressable
      {...linkKeys}
      aria-disabled={disabled}
      disabled={disabled}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onPress={activate}
      role={role}
      style={rowStyle}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

/**
 * Keeps the browser's own focus outline off a focused pressable row on web, where it would
 * otherwise be painted over the reserved 2 px band and the ring a keyboard user sees would be the
 * browser's default rather than `colors.focusRing` (WCAG 2.4.7). React Native 0.76 declares no
 * `outline` style, so the long form is asserted once here; react-native-web drops the `outline`
 * shorthand as an invalid short form. The value is empty off web, which never reads it, and a row
 * without `onPress` is not focusable so it never applies this.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    // A list row spans its container. React Native stretches it in a column already;
    // react-native-web would otherwise leave a row the platform renders as an inline-level
    // `<button>` shrunk to its content.
    alignSelf: 'stretch',
    backgroundColor: colors.background,
    // Reserved focus ring: 2px painted in the row's own background until the row takes
    // keyboard focus, so revealing the ring never moves the row's contents. A pressable row keeps
    // the browser's own outline off it on web, which leaves this band as the ring there.
    borderColor: colors.background,
    borderWidth: 2,
    // Separator hairline in the non-text border token (3.7:1 on the row background).
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  // Disabled rows dim to `textMuted`, a measured pair, rather than dropping opacity, which
  // would put the text below every contrast record; the Pressable already refuses presses.
  textDisabled: {
    color: colors.textMuted,
  },
  rowPressed: {
    backgroundColor: colors.surface,
  },
  rowFocused: {
    borderBottomColor: colors.focusRing,
    borderColor: colors.focusRing,
  },
  textColumn: {
    // `minWidth: 0` lets the column shrink instead of pushing `trailing` off the row on web,
    // where a flex item's automatic minimum size is its content.
    flex: 1,
    gap: spacing.xs,
    minWidth: 0,
  },
  label: {
    color: colors.text,
    fontSize: typography.label.fontSize,
    fontWeight: fontWeights.medium,
    lineHeight: typography.label.lineHeight,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: typography.body.fontSize,
    lineHeight: typography.body.lineHeight,
  },
});
