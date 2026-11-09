/**
 * The four traveler tabs — Discover, Meetups, Lodgings, Profile — and the header and tab bar every
 * one of them renders inside (AAP 0.5.8, AAP 0.8.1).
 */
import type { ReactElement } from 'react';
import { Tabs } from 'expo-router';
import { MIN_TOUCH_TARGET, borderWidths, colors, fontWeights, typography } from '@tablemate/shared';

import { NavButton, navigationHeaderOptions } from '../../src/ui';

const TABS = [
  { name: 'discover', label: 'Discover' },
  { name: 'meetups', label: 'Meetups' },
  { name: 'lodgings', label: 'Lodgings' },
  { name: 'profile', label: 'Profile' },
] as const;

export const unstable_settings = { initialRouteName: 'discover' };

const tabOptions = ({ name, label }: (typeof TABS)[number]) => ({
  title: label,
  tabBarLabel: label,
  tabBarAccessibilityLabel: label,
  tabBarButtonTestID: `tab-${name}`,
});

export default function TabsLayout(): ReactElement {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        // The tab screens are this navigator's roots: the chrome carries no back control here.
        ...navigationHeaderOptions('surface', { back: false }),
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: borderWidths.separator,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarIcon: () => null,
        tabBarIconStyle: { display: 'none' },
        tabBarLabelStyle: { ...typography.label, fontWeight: fontWeights.medium },
        tabBarItemStyle: { minHeight: MIN_TOUCH_TARGET },
        tabBarAllowFontScaling: true,
        // The bar's items are this app's own button, so they paint its focus ring rather than the
        // browser's outline. The framework hands its button the anchor target, the accessible name
        // it computed, the tab's role and selected state, its own label node and the item's
        // geometry; `hoverEffect` and `pressOpacity` are `PlatformPressable`'s own and are left
        // behind, together with the iOS large-content-viewer hints, which are a platform extra for
        // a label the bar already shows.
        tabBarButton: (props) => (
          <NavButton
            accessibilityLabel={props['aria-label']}
            androidRipple={props.android_ripple}
            href={props.href}
            onLongPress={props.onLongPress}
            onPress={props.onPress}
            role={props.role ?? 'tab'}
            selected={props['aria-selected']}
            style={props.style}
            testID={props.testID}
          >
            {props.children}
          </NavButton>
        ),
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} options={tabOptions(tab)} />
      ))}
    </Tabs>
  );
}
