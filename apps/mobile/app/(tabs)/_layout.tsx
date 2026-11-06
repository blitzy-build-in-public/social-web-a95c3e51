/**
 * The four traveler tabs — Discover, Meetups, Lodgings, Profile — and the header and tab bar every
 * one of them renders inside (AAP 0.5.8, AAP 0.8.1).
 */
import type { ReactElement } from 'react';
import { Tabs } from 'expo-router';
import { MIN_TOUCH_TARGET, borderWidths, colors, fontWeights, typography } from '@tablemate/shared';

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
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
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
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} options={tabOptions(tab)} />
      ))}
    </Tabs>
  );
}
