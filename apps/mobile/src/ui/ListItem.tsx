/**
 * The list row every list screen is built from: traveler discovery, meetups, the lodging directory and Profile settings
 * (AAP 0.5.8).
 *
 * Given `onPress` the row is a control — a `link` for rows that navigate, a `button` otherwise — announced once, under an
 * accessible name that is the row's own visible text. The row deliberately sets no `aria-label`, because a name written
 * from the label and subtitle cannot contain the row's other visible text (WCAG 2.5.3), so every call site keeps
 * `trailing` to text that belongs in the name and marks decoration `aria-hidden`. On web the reserved band is the ring,
 * and a row without `onPress` is not focusable and carries no reset.
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

export interface ListItemProps {
  label: string;
  subtitle?: string;
  /** Node before the text column, such as an `Avatar`; never a second control. */
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  role?: 'button' | 'link';
  disabled?: boolean;
  testID?: string;
  /**
   * Opt-in minimum width for the text column. Set, the row wraps and `trailing` moves to a line of its own
   * once it can no longer sit beside a column that wide.
   */
  textMinWidth?: number;
}

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
  // The opt-in narrow-width rule: `flexWrap` on the row, a minimum width on the text column. `trailing`
  // keeps its intrinsic width (React Native's default `flexShrink` is 0).
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
  // react-native-web withholds `onPress` from an element whose role is `link`, assuming the browser
  // activates a link itself, so a row that navigates handles Enter here. The row is a `div` with no href.
  // A `button` row is left to the press responder.
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
      // Hover reaches this pair on web alone: React Native 0.76 declares it on `PressableProps` and
      // react-native-web forwards it; neither iOS nor Android fires it.
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

// The browser's own focus outline is kept off the band this control reserves for its focus ring, so the ring a
// keyboard user sees is the app's own; on web React Native declares no `outline` style, so the long form is asserted
// here and the value is empty off web, which never reads it.
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

// The rule between stacked rows: a separator hairline is one device pixel, which is what a platform's own
// `StyleSheet.hairlineWidth` resolves to (react-native-web sets it to 1).
const separatorWidth = Platform.OS === 'web' ? borderWidths.separator : StyleSheet.hairlineWidth;

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    // A list row spans its container: React Native stretches it in a column already, while
    // react-native-web would otherwise leave it shrunk to its content.
    alignSelf: 'stretch',
    backgroundColor: colors.background,
    // Reserved focus ring: 2px painted in the row's own background until the row takes keyboard focus, so
    // revealing the ring never moves the row's contents.
    borderColor: colors.background,
    borderWidth: borderWidths.control,
    // Separator hairline in the non-text border token (3.7:1 on the row background).
    borderBottomColor: colors.border,
    borderBottomWidth: separatorWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    // The reserved band takes 2px where a card's own edge takes 1px, so the padding drops by that pixel
    // and every row's content edge lands in the same padded column.
    paddingHorizontal: spacing.lg - (borderWidths.control - borderWidths.edge),
    paddingVertical: spacing.sm,
  },
  // The wrapping variant the `textMinWidth` opt-in turns on: the row breaks between the text column and `trailing`.
  rowWrapping: {
    flexWrap: 'wrap',
  },
  // Disabled rows dim to `textMuted`, a measured pair, rather than dropping opacity, which would put the text below every contrast record.
  textDisabled: {
    color: colors.textMuted,
  },
  // A row's own fill is the lightest token, so one pointer step serves both states; hover takes the fill the press paints.
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
    // `minWidth: 0` lets the column shrink instead of pushing `trailing` off the row on web.
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
