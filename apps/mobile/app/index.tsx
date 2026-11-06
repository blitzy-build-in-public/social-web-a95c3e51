/**
 * The app's root route, `/`: the entry point a launch or a link that names no other path lands on,
 * and the route that decides which area the session belongs in (AAP 0.5.8).
 */
import type { ReactElement } from 'react';
import { Redirect, Stack } from 'expo-router';

import { useSession } from '../src/state/session-store';

const NO_HEADER = { headerShown: false };

export default function Index(): ReactElement | null {
  const session = useSession();
  if (session.status === 'loading') return <Stack.Screen options={NO_HEADER} />;
  if (session.status === 'signed_out') return <Redirect href="/sign-in" />;
  if (session.consented !== true) return <Redirect href="/age-gate" />;
  return <Redirect href="/discover" />;
}
