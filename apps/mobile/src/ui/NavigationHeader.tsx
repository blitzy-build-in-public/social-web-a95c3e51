/**
 * `NavigationHeader` — the app's navigation-header chrome in one place: the tint, the title style
 * and the separator every navigator paints, plus the back control a pushed screen shows (AAP 0.5.8).
 *
 * A navigator paints its own defaults where an option is absent, and those defaults are not this
 * design: `@react-navigation/elements` takes the header band's separator from the navigation
 * theme's `rgb(216, 216, 216)` and its title from its own `styles.title` — 18px at weight 500 in the
 * theme's text colour `rgb(28, 28, 30)` — so a screen that sets no header option shows a title that
 * is not the app's own 20/700/`rgb(28, 27, 25)` bar, and neither library value appears in
 * `packages/shared/src/ui-tokens.ts`. The root Stack, the `(auth)` group and the tab navigator
 * therefore take every header option from {@link navigationHeaderOptions}, which is built from the
 * tokens alone, so no library default reaches the chrome on any of them and the three cannot drift
 * apart.
 *
 * The back control is the app's own drawn one — `./HeaderBackButton`'s {@link renderWebHeaderLeft},
 * which the web navigators take from here rather than from the library, whose control measures 30x30
 * with a 10px radius and draws a downscaled PNG. A screen never names it: the chrome spreads it, and
 * a screen that closes its way out — the age gate — overrides `headerLeft` with nothing of its own.
 */
import type { ReactElement } from 'react';
import { Platform } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { borderWidths, colors, fontWeights, typography } from '@tablemate/shared';
import type { ColorToken } from '@tablemate/shared';

import { renderWebHeaderLeft } from './HeaderBackButton';

/** The label a platform that draws one shows beside the back glyph. */
const BACK_TITLE = 'Back';

/**
 * The header band's style as a navigator declares it. `@react-navigation/native-stack` narrows
 * `headerStyle` to a background colour, because its own native header honours that one property,
 * while the header `@react-navigation/elements` renders — the one on web, and the one the tab
 * navigator uses everywhere — reads the band's boundary width and colour out of the same option,
 * which is what carries the separator to `HeaderBackground`.
 */
type HeaderBandStyle = StyleProp<{ backgroundColor?: string }>;

/**
 * The header title's style as a navigator declares it, narrowed the same way: a native header honours
 * a font size, weight, family and colour, while the rendered title applies the whole style object it
 * is given, `lineHeight` included.
 */
type HeaderTitleStyle = StyleProp<
  Pick<TextStyle, 'fontFamily' | 'fontSize' | 'fontWeight'> & { color?: string }
>;

/**
 * The header options one navigator spreads: the title style, the tint, the separator and, where the
 * navigator pushes screens, the back control.
 */
export interface NavigationHeaderChrome {
  readonly headerBackTitle: string;
  /** The back control, left out of a navigator whose screens are roots. */
  readonly headerLeft?: (props: {
    canGoBack?: boolean;
    onPress?: () => void;
  }) => ReactElement | null;
  readonly headerStyle: HeaderBandStyle;
  readonly headerTintColor: string;
  readonly headerTitleStyle: HeaderTitleStyle;
}

/**
 * What a caller decides about the chrome it spreads.
 */
export interface NavigationHeaderChoices {
  /**
   * Whether this navigator's screens are pushed onto a previous one and so carry a back control.
   * A navigator whose screens are roots — the tab navigator — takes the chrome without one at all,
   * because a header-left element that renders nothing still costs the title its gutter: a navigator
   * gives a left-aligned title a 4px start margin whenever a header-left element is present, in place
   * of the 16px one, which would pull every tab title to the viewport edge.
   */
  readonly back?: boolean;
}

/**
 * The header options the root Stack, the `(auth)` group and the tab navigator spread, derived from
 * the tokens alone. `background` names the band's own token — `background` for the root and `(auth)`
 * stacks, `surface` for the tab navigator — so each stack keeps the header it had while every value
 * it paints has one home in the design source.
 */
export function navigationHeaderOptions(
  background: ColorToken,
  { back = true }: NavigationHeaderChoices = {},
): NavigationHeaderChrome {
  // Each assertion below is the design value the rendered header applies and the declared type omits:
  // the band's separator (see `HeaderBandStyle`) and the type role's line height (see
  // `HeaderTitleStyle`). Leaving either out would put the navigation theme's own `rgb(216, 216, 216)`
  // hairline on the band and the library's own 18px title in it, neither of which is a token of this
  // design.
  const headerStyle = {
    backgroundColor: colors[background],
    borderBottomColor: colors.border,
    borderBottomWidth: borderWidths.separator,
  } as HeaderBandStyle;
  const headerTitleStyle = {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  } as HeaderTitleStyle;
  const chrome: NavigationHeaderChrome = {
    headerBackTitle: BACK_TITLE,
    headerStyle,
    headerTintColor: colors.text,
    headerTitleStyle,
  };
  // Off web the platform header keeps the control it has today, and no option, component or request
  // changes there.
  if (!back || Platform.OS !== 'web') return chrome;
  return { ...chrome, headerLeft: renderWebHeaderLeft };
}
