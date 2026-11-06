/**
 * The `/ops` area's layout: the operator gate, and on web the bar its three screens share
 * (AAP 0.3.2, AAP 0.5.8).
 *
 * The area is web only — the dashboard reuses the app's magic-link sign-in and its operator role,
 * and the phone builds carry no operator surface — so a native deep link goes to the tabs. The gate
 * is presentation, never authorization: every `/v1/admin/*` route answers `403 operator_only` to a
 * caller whose role is not `operator`, and that answer is the authority. The root layout's own gate
 * leaves `/ops` to this file, so a visitor without a session is sent to `/discover`, and forwarded
 * from there to sign-in.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PressableProps, ViewStyle } from 'react-native';
import { Link, Redirect, Stack, usePathname } from 'expo-router';
import type { Href } from 'expo-router';
import {
  MIN_TOUCH_TARGET,
  borderWidths,
  colors,
  fontWeights,
  interactionOpacity,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';

import { useSession } from '../../src/state/session-store';

/** The widest the bar's contents grow before the window's own margins take over. */
const MAX_CONTENT_WIDTH = 1200;

/** The four destinations, in the order they are rendered: the area's three screens, then the app. */
const NAV_ITEMS = [
  { label: 'Dashboard', href: '/ops' },
  { label: 'Queues', href: '/ops/queues' },
  { label: 'Registry', href: '/ops/registry' },
  { label: 'Back to app', href: '/discover' },
] as const;

/**
 * The attribute that marks the page on show, typed the way `Screen` types its heading level: React
 * Native 0.76 does not declare `aria-current`, while react-native-web forwards it to the anchor it
 * renders for a link.
 */
const CURRENT_PAGE: PressableProps & Readonly<{ 'aria-current': 'page' }> = {
  'aria-current': 'page',
};

/**
 * One navigation link: a real anchor the router intercepts for a client-side navigation, so Enter,
 * the context menu and copying the address keep the browser's own behaviour.
 *
 * The border is painted in every state, so the keyboard focus ring cannot shift the layout
 * (WCAG 2.4.7) and `webFocusRingReset` leaves `colors.focusRing` as the ring a keyboard user sees.
 * The current page is marked by weight, an underline and its colour together, never by colour alone.
 */
function NavLink({
  label,
  href,
  active,
}: {
  readonly label: string;
  readonly href: Href;
  readonly active: boolean;
}): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  // A flattened object rather than an array or a callback: `Link`'s `asChild` merges the child's
  // style into its own with an object spread, which drops either of the other two forms.
  const style = StyleSheet.flatten<ViewStyle>([
    styles.link,
    hovered && styles.linkHovered,
    pressed && styles.linkPressed,
    focused && styles.linkFocused,
    webFocusRingReset,
  ]);

  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityRole="link"
        {...(active ? CURRENT_PAGE : {})}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={style}
      >
        <Text style={[styles.label, active && styles.labelActive]}>{label}</Text>
      </Pressable>
    </Link>
  );
}

/**
 * Renders the operator area: the gate above, and for an operator on web the bar and the Stack its
 * three screens sit in. Each screen sets its own `<Stack.Screen options={{ title }} />`, which the
 * router uses as the browser document title.
 *
 * `useSession` and `usePathname` run in every branch, so the hooks order is stable. A `loading`
 * session renders nothing, because the root layout holds the splash until bootstrap settles.
 *
 * The gate is presentation only: every `/v1/admin/*` route answers `403 operator_only` to a caller
 * whose role is not `operator`, and that answer — not this check — is the authority (AAP 0.3.2).
 *
 * @returns The operator area, or null while the session is still unknown.
 */
export default function OpsLayout(): ReactElement | null {
  const session = useSession();
  const pathname = usePathname();

  if (session.status === 'loading') return null;
  if (Platform.OS !== 'web') return <Redirect href="/discover" />;
  if (session.status !== 'signed_in' || session.role !== 'operator') {
    return <Redirect href="/discover" />;
  }

  return (
    <View style={styles.screen}>
      <View role="navigation" aria-label="Operator" style={styles.nav} testID="ops-nav">
        <View style={styles.navItems}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.href}
              label={item.label}
              href={item.href}
              active={pathname === item.href}
            />
          ))}
        </View>
      </View>
      <View style={styles.content}>
        <Stack screenOptions={{ headerShown: false }} />
      </View>
    </View>
  );
}

/**
 * Keeps the browser's own focus outline off a focused link on web, where it would be painted over
 * the 2 px band the link reserves and the ring a keyboard user sees would be the browser's default
 * rather than `colors.focusRing` (WCAG 2.4.7). React Native 0.76 declares no `outline` style, so the
 * long form is asserted once here; the value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

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
    maxWidth: MAX_CONTENT_WIDTH,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    width: '100%',
  },
  content: { alignSelf: 'center', flex: 1, maxWidth: MAX_CONTENT_WIDTH, width: '100%' },
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
  // The whole control dims while pressed, the step Button and Card paint, because the palette holds
  // no second fill for a link resting on the bar's own `surface`.
  linkPressed: { opacity: interactionOpacity.pressed },
  linkFocused: { borderColor: colors.focusRing },
  label: {
    color: colors.text,
    fontSize: typography.label.fontSize,
    fontWeight: fontWeights.medium,
    lineHeight: typography.label.lineHeight,
  },
  labelActive: {
    color: colors.primary,
    fontWeight: fontWeights.bold,
    textDecorationLine: 'underline',
  },
});
