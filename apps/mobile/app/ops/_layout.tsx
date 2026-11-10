/** The `/ops` area's layout: the operator gate, and on web the bar its three screens share. */
import { useState, type ReactElement } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Link, Redirect, Stack, usePathname, type Href } from 'expo-router';
import {
  MIN_TOUCH_TARGET,
  borderWidths,
  colors,
  fontWeights,
  interactionOpacity,
  layout,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';

import { useSession } from '../../src/state/session-store';

const NAV_ITEMS: readonly NavItem[] = [
  { href: '/ops', label: 'Dashboard' },
  { href: '/ops/queues', label: 'Queues' },
  { href: '/ops/registry', label: 'Registry' },
  { href: '/discover', label: 'Back to app' },
];
const CURRENT_PAGE = { 'aria-current': 'page' } as const;

type NavItem = { readonly href: Href; readonly label: string };
type NavLinkProps = { readonly item: NavItem; readonly path: string };

function NavLink({ item, path }: NavLinkProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const active = item.href === path;
  const focus = { onBlur: () => setFocused(false), onFocus: () => setFocused(true) };
  const hover = { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) };
  const press = { onPressIn: () => setPressed(true), onPressOut: () => setPressed(false) };
  const link = { accessibilityRole: 'link' as const, ...(active ? CURRENT_PAGE : {}) };
  const base = [styles.link, webFocusRingReset];
  const layers = [hovered && styles.linkHovered, pressed && styles.linkPressed];
  const ring = focused && styles.linkFocused;
  const style = StyleSheet.flatten<ViewStyle>([...base, ...layers, ring]);
  return (
    <Link href={item.href} asChild>
      <Pressable {...focus} {...hover} {...link} {...press} style={style}>
        <Text style={[styles.label, active && styles.labelActive]}>{item.label}</Text>
      </Pressable>
    </Link>
  );
}

export default function OpsLayout(): ReactElement | null {
  const session = useSession();
  const pathname = usePathname();
  const away = <Redirect href="/discover" />;
  if (session.status === 'loading') return null;
  if (Platform.OS !== 'web') return away;
  if (session.status !== 'signed_in' || session.role !== 'operator') return away;
  return (
    <View style={styles.screen}>
      <View role="navigation" aria-label="Operator" style={styles.nav} testID="ops-nav">
        <View style={styles.navItems}>
          {NAV_ITEMS.map((item) => (
            <NavLink item={item} key={item.label} path={pathname} />
          ))}
        </View>
      </View>
      <View style={styles.content}>
        <Stack screenOptions={{ headerShown: false }} />
      </View>
    </View>
  );
}

const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;
const ACTIVE_LABEL = { color: colors.primary, fontWeight: fontWeights.bold } as const;
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  nav: {
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: borderWidths.separator,
  },
  navItems: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    maxWidth: layout.maxContentWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    width: '100%',
  },
  content: { alignSelf: 'center', flex: 1, maxWidth: layout.maxContentWidth, width: '100%' },
  link: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radii.sm,
    borderWidth: borderWidths.control,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  linkHovered: { backgroundColor: colors.background },
  linkPressed: { opacity: interactionOpacity.pressed },
  linkFocused: { borderColor: colors.focusRing },
  label: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  labelActive: { ...typography.label, ...ACTIVE_LABEL, textDecorationLine: 'underline' },
});
