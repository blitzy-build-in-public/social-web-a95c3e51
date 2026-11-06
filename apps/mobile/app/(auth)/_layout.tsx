/**
 * The auth route group: sign-in, the "check your email" notice and the age gate in one stack
 * (AAP 0.5.8, AAP 0.8.1).
 *
 * Gating lives in `apps/mobile/app/_layout.tsx`, which routes a session to the screen it may be on:
 * signed out to `/sign-in`, signed in with consents unrecorded to `/age-gate`, and consented out of
 * this group to `/discover`. Nothing here reads the session, calls the API or redirects, so the
 * gate keeps one owner and one rule set.
 *
 * The group owns its own headers because the root layout mounts `(auth)` with `headerShown: false`.
 * A group never appears in a URL, so these screens answer `/sign-in`, `/check-email` and
 * `/age-gate`. Header and page colours are the `text`-on-`background` pair recorded in
 * `CONTRAST_PAIRS` at 17.21:1, well over the AA minimum for normal text; every value below comes
 * from the shared tokens and no colour is written here.
 */
import { Stack } from 'expo-router';
import { colors, fontWeights, typography } from '@tablemate/shared';

/**
 * Hosts the three auth screens in a native stack, with the header shown so each screen's own title
 * is the heading the navigator announces.
 *
 * The age gate hides the back control and disables the swipe-back gesture: it is the one auth
 * screen a signed-in, unconsented traveler reaches, and a back control there would offer a route
 * the root gate bounces straight back. The gate still decides; this removes the affordance only.
 *
 * @returns The stack every screen in the `(auth)` group renders inside.
 */
export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: {
          fontSize: typography.title.fontSize,
          fontWeight: fontWeights.bold,
        },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
      <Stack.Screen name="check-email" options={{ title: 'Check your email' }} />
      <Stack.Screen
        name="age-gate"
        options={{ title: 'Before you start', gestureEnabled: false, headerBackVisible: false }}
      />
    </Stack>
  );
}
