/**
 * The four traveler tabs — Discover, Meetups, Lodgings, Profile — and the header and tab bar every
 * one of them renders inside (AAP 0.5.8, AAP 0.8.1).
 *
 * The bar carries labels and no icons. No icon set is declared for this app (AAP 0.4.1), and React
 * Navigation's own fallback for a tab without one is a "missing icon" glyph, so `tabBarIcon` paints
 * nothing and its empty container is collapsed: the label alone is the tab. Neither the tab set nor
 * the order is conditioned on the caller's proof status — a traveler without a valid proof keeps all
 * four tabs, and each screen changes its own content instead (AAP 0.5.8).
 *
 * Colour comes from `packages/shared/src/ui-tokens.ts` and only from pairs that file records, so
 * every foreground here is a measured one:
 *
 *   - the active label: `primary` on `surface`, 6.59:1, in `CONTRAST_PAIRS`; the header title:
 *     `text` on `surface`, 15.52:1, also in `CONTRAST_PAIRS`;
 *   - inactive label: `textMuted` on `surface`, 6.38:1, also in `CONTRAST_PAIRS`, because an
 *     unselected tab's label is text and needs the same 4.5:1 as a selected one;
 *   - the bar's top rule: `border` on `surface`, 3.34:1, in `NON_TEXT_CONTRAST_PAIRS`.
 *
 * Selection is therefore never colour alone: each tab button keeps React Navigation's own `tab` role
 * and `aria-selected` state (AAP 0.5.8).
 */
import type { ReactElement } from 'react';
import { Tabs } from 'expo-router';
import { MIN_TOUCH_TARGET, borderWidths, colors, fontWeights, typography } from '@tablemate/shared';

/**
 * The tabs in tab-bar order: each route file under `app/(tabs)/`, its label, and — derived from
 * `name` — the test id of its button, `tab-discover`, `tab-meetups`, `tab-lodgings`, `tab-profile`,
 * on the button itself so the web DOM carries `data-testid` and a native test id is what Maestro
 * reads (AAP 0.12.1 criterion 8).
 *
 * One table keeps the four rows the plan names in one place, and `name` is also the route the tab
 * switches to, so a renamed route file cannot leave a tab pointing elsewhere. The order is the array
 * order: Expo Router keeps the order its layout declares.
 */
const TABS = [
  { name: 'discover', label: 'Discover' },
  { name: 'meetups', label: 'Meetups' },
  { name: 'lodgings', label: 'Lodgings' },
  { name: 'profile', label: 'Profile' },
] as const;

/**
 * The surface the header and the tab bar paint, so the two bands frame the page rather than being
 * part of it: the screens paint `background` (AAP 0.5.8), and the pairs above are the ones measured
 * against this token.
 */
const BAR_BACKGROUND = colors.surface;

/**
 * `title` on each screen is the header's text, and the header is therefore where the page's single
 * level-one heading comes from — `HeaderTitle` renders `role="heading"` at `aria-level="1"` — so the
 * four screens render `Screen` without a `title` of their own.
 *
 * The document title is not set from here: Expo Router mounts its forked `NavigationContainer` with
 * `documentTitle: { enabled: false }`, so no screen option reaches `document.title` and the web
 * export keeps the title `app.config.ts` names. The header heading is what every tab announces.
 *
 * `unstable_settings` makes Discover the tab the group enters on when a deep link such as
 * `/meetups/<id>` brings the tabs back into view; Expo Router's own root layout does the same for
 * the group.
 */
export const unstable_settings = { initialRouteName: 'discover' };

/**
 * Renders the tab navigator the four traveler tabs hang from.
 *
 * @returns The tab navigator, with the header and tab bar styled from the shared tokens.
 */
export default function TabsLayout(): ReactElement {
  return (
    <Tabs
      screenOptions={{
        // The screens own their content only: the header is the page's heading, and the root Stack
        // hands the `(tabs)` group `headerShown: false`, so exactly one header is visible.
        headerShown: true,
        headerStyle: { backgroundColor: BAR_BACKGROUND },
        headerTintColor: colors.text,
        headerTitleStyle: {
          color: colors.text,
          fontSize: typography.title.fontSize,
          lineHeight: typography.title.lineHeight,
          fontWeight: fontWeights.bold,
        },
        tabBarStyle: {
          backgroundColor: BAR_BACKGROUND,
          borderTopColor: colors.border,
          borderTopWidth: borderWidths.separator,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        // Labels alone: nothing to draw, and the container a drawn icon would occupy is collapsed.
        tabBarIcon: () => null,
        tabBarIconStyle: { display: 'none' },
        // `label` is the smallest type role a control label may use (ui-tokens: `caption` never is
        // one), and font scaling stays on so the label follows the reader's system font size.
        tabBarLabelStyle: {
          fontSize: typography.label.fontSize,
          lineHeight: typography.label.lineHeight,
          fontWeight: fontWeights.medium,
        },
        tabBarItemStyle: { minHeight: MIN_TOUCH_TARGET },
        tabBarAllowFontScaling: true,
      }}
    >
      {TABS.map(({ name, label }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title: label,
            tabBarLabel: label,
            tabBarAccessibilityLabel: label,
            tabBarButtonTestID: `tab-${name}`,
          }}
        />
      ))}
    </Tabs>
  );
}
