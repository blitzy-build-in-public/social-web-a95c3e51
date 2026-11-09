/**
 * Card — the app's content surface, optionally pressable (AAP 0.5.8).
 *
 * A static card groups a headline, an optional right-aligned `trailing` slot and any `children`; a pressable one is
 * the same surface as a keyboard- and screen-reader-operable button, painting the pressed, hover, focus and disabled
 * states `Button` and `ListItem` already paint, with that border band as the visible focus ring on web, where
 * `webFocusRingReset` keeps the browser's own outline off it.
 *
 * Interactive children (a `Button`, a link, a text field) belong in a static card: a pressable card is itself one
 * button, and a control nested inside another control cannot be reached by keyboard and is ambiguous to a screen
 * reader, so a pressable `Card` is never rendered inside another pressable one. `CONTRAST_PAIRS` records the title
 * and subtitle pairs this file paints, and `NON_TEXT_CONTRAST_PAIRS` its border and focus-ring pairs.
 */
import { Children, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  borderWidths,
  colors,
  fontWeights,
  MIN_TOUCH_TARGET,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';

/**
 * Every slot is optional: an absent, empty or `false` one renders nothing, so a card never shows a
 * blank line where it has no content.
 */
interface CardBaseProps {
  title?: string;
  subtitle?: string;
  children?: ReactNode;
  trailing?: ReactNode;
  testID?: string;
  /**
   * Forwarded to the surface, so a caller can stretch a card inside a flex row — a card filling the
   * cell it sits in is as tall as its tallest sibling, which is what lets the rows below share one
   * line. Layout only — `flex`, `minHeight`, `alignSelf` — because the colours belong to the card's
   * own states.
   */
  style?: StyleProp<ViewStyle>;
}

/**
 * An absent slot, `false` and an empty string render nothing — an empty `Text` would otherwise leave a
 * blank line — while `0` is a real value.
 */
function isPresent(value: ReactNode): boolean {
  return value !== null && value !== undefined && value !== false && value !== '';
}

/**
 * React Native refuses a bare string or number outside a `<Text>`, and either slot may be given one, so
 * each such child is wrapped in the card's body text; `muted` paints that text in the muted token.
 */
function asSlotContent(value: ReactNode, muted: boolean): ReactNode {
  return Children.map(value, (child) =>
    typeof child === 'string' || typeof child === 'number' ? (
      <Text style={[styles.bodyText, muted ? styles.muted : null]}>{child}</Text>
    ) : (
      child
    ),
  );
}

/** The props a card that behaves as a button adds. */
interface CardPressableProps {
  onPress: () => void;
  /**
   * It has to contain the card's visible text — its title, subtitle and trailing content, in the order
   * they are shown — so that someone who reads the card hears the same words in its name (WCAG 2.5.3,
   * Label in Name). Build it from the strings the card renders: "Hold a seat at the table 10 USD —
   * open the proposal", not a bare "Open". axe-core's `label-content-name-mismatch` check joins a
   * card's text nodes without the space between them, so it reports every card whose visible text spans
   * more than one element whatever its name; exclude that check by name for cards.
   */
  label: string;
  disabled?: boolean;
}

/**
 * The union makes a pressable card without a `label` a type error rather than an unnamed button
 * (WCAG 4.1.2 — name, role, value), so the requirement cannot be lost in a later edit. The static arm
 * refuses `label` and `disabled` outright (`never`), because a union member otherwise absorbs any
 * property another member declares: without that, a `label` on a static card would compile and then be
 * dropped silently instead of pointing the caller at the missing `onPress`.
 */
export type CardProps =
  | (CardBaseProps & { onPress?: undefined; label?: never; disabled?: never })
  | (CardBaseProps & CardPressableProps);

/**
 * The card has no fixed height: it grows with its content and with the reader's system font size.
 */
export function Card(props: CardProps): ReactElement {
  const { title, subtitle, children, trailing, testID, style } = props;
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Only a pressable card can be disabled, and only a disabled one mutes: a static card has no
  // disabled state, so its own text keeps the colours it paints by default.
  const muted = props.onPress !== undefined && props.disabled === true;
  const hasHeader = Boolean(title || subtitle) || isPresent(trailing);
  const header = (
    <View style={styles.header}>
      <View style={styles.headline}>
        {title ? <Text style={[styles.title, muted ? styles.muted : null]}>{title}</Text> : null}
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {isPresent(trailing) ? (
        <View style={styles.trailing}>{asSlotContent(trailing, muted)}</View>
      ) : null}
    </View>
  );
  const body = isPresent(children) ? asSlotContent(children, muted) : null;
  if (props.onPress === undefined) {
    return (
      <View style={[styles.card, style]} testID={testID}>
        {hasHeader ? header : null}
        {body}
      </View>
    );
  }
  const { onPress, label, disabled } = props;
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      // Hover reaches this pair on web alone: React Native 0.76 declares it on `PressableProps` and
      // react-native-web forwards it to its hover hook, and neither iOS nor Android fires it.
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      testID={testID}
      style={({ pressed }) => [
        styles.card,
        styles.pressable,
        disabled && styles.disabled,
        hovered && !disabled && styles.hovered,
        focused && styles.focused,
        pressed && styles.pressed,
        webFocusRingReset,
        style,
      ]}
    >
      {hasHeader ? header : null}
      {body}
    </Pressable>
  );
}

/**
 * Keeps the browser's own focus outline off a focused pressable card on web, where it would be painted
 * over the band the card's own border reserves and the ring a keyboard user sees would be the browser's
 * default rather than `colors.focusRing` (WCAG 2.4.7). React Native 0.76 declares no `outline` style, so
 * the long form is asserted once here; react-native-web drops the `outline` shorthand as an invalid
 * short form. A static card is not focusable, so it never applies this.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.md,
    borderWidth: borderWidths.edge,
    gap: spacing.md,
    padding: spacing.lg,
  },
  pressable: {
    minHeight: MIN_TOUCH_TARGET,
  },
  // The disabled state Button and ListItem already paint, from tokens whose pairs are recorded. The
  // card keeps its border, so the state reads as dimmed rather than as a different shape.
  disabled: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  // The border is painted in every state, so turning it into the focus ring below moves nothing, and
  // on web the reset on the pressable leaves that blue band as the ring.
  focused: {
    borderColor: colors.focusRing,
  },
  // A card's own fill is the lightest token, so the palette offers one pointer step for both states,
  // and hover takes the same fill the press paints.
  hovered: {
    backgroundColor: colors.surface,
  },
  pressed: {
    backgroundColor: colors.surface,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  headline: {
    flex: 1,
  },
  trailing: {
    alignItems: 'flex-end',
  },
  title: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
  },
  bodyText: {
    ...typography.body,
    color: colors.text,
  },
  // The card's own text while disabled: `textMuted` on the `surface` fill that state paints, the same
  // colour ListItem dims its rows to.
  muted: {
    color: colors.textMuted,
  },
});
