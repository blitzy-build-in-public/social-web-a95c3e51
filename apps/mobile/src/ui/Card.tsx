/**
 * Card — the app's content surface, optionally pressable (AAP 0.5.8).
 *
 * A static card groups a headline, an optional right-aligned `trailing` slot and any `children`.
 * A pressable card is the same surface as a keyboard- and screen-reader-operable button: it takes
 * `role="button"` with the accessible name its `label` carries, is at least `MIN_TOUCH_TARGET`
 * tall, paints a pressed background, takes the `surface` fill on hover, swaps its border to the
 * focus token while focused, and while disabled paints that fill and edge with a muted title and
 * body — the state Button and ListItem already paint. That border band is the visible focus ring on
 * web, because `webFocusRingReset` keeps the browser's own outline off the pressable; a static card
 * is not focusable, carries no such reset and has no hover or disabled state to paint.
 *
 * Put interactive children (a `Button`, a link, a text field) in a *static* card: a pressable card
 * is itself one button, and a control nested inside another control cannot be reached by keyboard
 * and is ambiguous to a screen reader. For the same reason a pressable `Card` is never rendered
 * inside another pressable one.
 *
 * Colour, spacing, radius and type all come from `@tablemate/shared`'s tokens: `CONTRAST_PAIRS`
 * records the title and subtitle pairs this file paints, and `NON_TEXT_CONTRAST_PAIRS` records its
 * border and focus-ring pairs. No literal colour is written here.
 */
import { Children, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
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
 * The content every card carries, pressable or not. Every slot is optional: an absent, empty or
 * `false` one renders nothing, so a card never shows a blank line where it has no content.
 */
interface CardBaseProps {
  /** The headline. */
  title?: string;
  /** A secondary line under the headline, in the muted text token. */
  subtitle?: string;
  /** The body, rendered under the headline block. */
  children?: ReactNode;
  /** A right-aligned slot beside the headline, such as an amount or a status. */
  trailing?: ReactNode;
  /** Forwarded to the surface, so a test can find it. */
  testID?: string;
}

/**
 * Whether a slot holds anything to render. An absent slot, `false` and an empty string render
 * nothing — an empty `Text` would otherwise leave a blank line — while `0` is a real value.
 */
function isPresent(value: ReactNode): boolean {
  return value !== null && value !== undefined && value !== false && value !== '';
}

/**
 * React Native refuses a bare string or number outside a `<Text>`, and either slot may be given one,
 * so each such child is wrapped in the card's body text; elements pass through untouched. `muted`
 * paints that wrapped text in the muted token, so a bare string follows the card's own state.
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

/**
 * The props a card that behaves as a button adds.
 */
interface CardPressableProps {
  /** Runs on a press: a tap, a mouse click, or Enter or Space while the card is focused. */
  onPress: () => void;
  /**
   * The button's accessible name. It has to contain the card's visible text — its title, subtitle
   * and trailing content, in the order they are shown — so that someone who reads the card hears
   * the same words in its name (WCAG 2.5.3, Label in Name). Build it from the strings the card
   * renders: "Hold a seat at the table 10 USD — open the proposal", not a bare "Open".
   *
   * axe-core's `label-content-name-mismatch` check joins a card's text nodes without the space
   * between them, so it reports every card whose visible text spans more than one element whatever
   * its name; exclude that check by name for cards. The rule above is the one to follow.
   */
  label: string;
  /** Blocks the press, and reports the card to assistive technology as disabled. */
  disabled?: boolean;
}

/**
 * A card is either static or pressable, and a pressable one must be named.
 *
 * The union makes a pressable card without a `label` a type error rather than an unnamed button
 * (WCAG 4.1.2 — name, role, value), so the requirement cannot be lost in a later edit. The static
 * arm refuses `label` and `disabled` outright (`never`), because a union member otherwise absorbs
 * any property another member declares: without that, a `label` on a static card would compile and
 * then be dropped silently instead of pointing the caller at the missing `onPress`.
 */
export type CardProps =
  | (CardBaseProps & { onPress?: undefined; label?: never; disabled?: never })
  | (CardBaseProps & CardPressableProps);

/**
 * Renders a content surface, and a button when `onPress` is given.
 *
 * The card has no fixed height: it grows with its content and with the reader's system font size.
 */
export function Card(props: CardProps): ReactElement {
  const { title, subtitle, children, trailing, testID } = props;
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
      <View style={styles.card} testID={testID}>
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
      // Hover reaches this pair on web alone: React Native 0.76 declares it on `PressableProps`
      // and react-native-web forwards it to its hover hook, and neither iOS nor Android fires it.
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
      ]}
    >
      {hasHeader ? header : null}
      {body}
    </Pressable>
  );
}

/**
 * Keeps the browser's own focus outline off a focused pressable card on web, where it would
 * otherwise be painted over the band the card's own border reserves and the ring a keyboard user
 * sees would be the browser's default rather than `colors.focusRing` (WCAG 2.4.7). React Native
 * 0.76 declares no `outline` style, so the long form is asserted once here; react-native-web drops
 * the `outline` shorthand as an invalid short form. The value is empty off web, which never reads
 * it, and a static card is not focusable so it never applies this.
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
  // The disabled state Button and ListItem already paint, from tokens whose pairs are recorded:
  // the `surface` fill with it, `textMuted` on `surface` 6.38:1 and `border` on `surface` 3.34:1.
  // The card keeps its border, so the state reads as dimmed rather than as a different shape.
  disabled: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  // The border is painted in every state, so turning it into the focus ring below moves nothing,
  // and on web the reset on the pressable leaves that blue band as the ring.
  focused: {
    borderColor: colors.focusRing,
  },
  // A card's own fill is the lightest token, so the palette offers one pointer step for both
  // states, and hover takes the same fill the press paints.
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
  // A bare string the caller put in a slot instead of a <Text>.
  bodyText: {
    ...typography.body,
    color: colors.text,
  },
  // The card's own text while disabled: `textMuted` on the `surface` fill that state paints, a
  // recorded pair at 6.38:1, and the colour ListItem dims its rows to.
  muted: {
    color: colors.textMuted,
  },
});
