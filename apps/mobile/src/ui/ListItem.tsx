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
import {
  MIN_TOUCH_TARGET,
  borderWidths,
  colors,
  fontWeights,
  spacing,
  typography,
} from '@tablemate/shared';

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

  /**
   * Opt-in minimum width for the text column, in points / CSS px. Set, the row wraps and `trailing`
   * moves to a line of its own once it can no longer sit beside a column this wide, so a narrow row
   * stacks instead of squeezing `label` and `subtitle` into mid-token breaks. Omitted, the row is the
   * single-line row every other call site renders.
   */
  textMinWidth?: number;
}

/**
 * One row of a list.
 *
 * The row is a flex row of `leading`, a text column (`label`, then `subtitle`) and
 * `trailing`, never a fixed height: it grows with the reader's font size and both text lines
 * wrap instead of truncating, so scaled text stays readable. A pressable row is one
 * accessible element — its children are grouped under the row's accessible name, so `leading`
 * and `trailing` carry decoration and status text, never a control of their own.
 *
 * A caller that passes `textMinWidth` gets the wrapping variant that prop describes; every other
 * caller gets the single-line row unchanged.
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
  textMinWidth,
}: ListItemProps): JSX.Element {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  // The opt-in narrow-width rule: `flexWrap` on the row, a minimum width on the text column.
  // `trailing` keeps its intrinsic width either way (React Native's default `flexShrink` is 0), so
  // once the column can no longer hold `textMinWidth` beside it the trailing node takes a line of its
  // own and the column takes the whole row instead of absorbing the shortfall.
  const rowBase: StyleProp<ViewStyle> =
    textMinWidth === undefined ? styles.row : [styles.row, styles.rowWrapping];
  const textColumn: StyleProp<ViewStyle> = [
    styles.textColumn,
    textMinWidth === undefined ? null : { minWidth: textMinWidth },
  ];

  const children = (
    <>
      {leading}
      <View style={textColumn}>
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
      <View style={rowBase} testID={testID}>
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
    rowBase,
    hovered && !disabled ? styles.rowHovered : null,
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
      // Hover reaches this pair on web alone: React Native 0.76 declares it on `PressableProps`
      // and react-native-web forwards it to its hover hook, and neither iOS nor Android fires it.
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
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

/**
 * The rule between stacked rows. A hairline separator is one device pixel, which is what a
 * platform's own `StyleSheet.hairlineWidth` resolves to (react-native-web sets it to 1), so web
 * takes the tokens' `separator` step and native keeps the platform constant: the line rendered is
 * unchanged on both platforms, and the value now has a name in the design source.
 */
const separatorWidth = Platform.OS === 'web' ? borderWidths.separator : StyleSheet.hairlineWidth;

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
    borderWidth: borderWidths.control,
    // Separator hairline in the non-text border token (3.7:1 on the row background).
    borderBottomColor: colors.border,
    borderBottomWidth: separatorWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  // The wrapping variant the `textMinWidth` opt-in turns on: the row breaks between the text column
  // and `trailing` instead of squeezing the column below its own minimum.
  rowWrapping: {
    flexWrap: 'wrap',
  },
  // Disabled rows dim to `textMuted`, a measured pair, rather than dropping opacity, which
  // would put the text below every contrast record; the Pressable already refuses presses.
  textDisabled: {
    color: colors.textMuted,
  },
  // A row's own fill is the lightest token, so the palette offers one pointer step for both
  // states, and hover takes the same fill the press paints.
  rowHovered: {
    backgroundColor: colors.surface,
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
