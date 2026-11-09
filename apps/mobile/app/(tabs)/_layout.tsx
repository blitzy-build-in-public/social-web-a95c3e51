/** The four traveler tabs — Discover, Meetups, Lodgings, Profile — and the header and tab bar every one of them renders inside. */
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
        // The bar's items are this app's own button, so they paint its focus ring rather than the browser's outline; `hoverEffect`, `pressOpacity` and the iOS large-content-viewer hints are deliberately not spread.
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
