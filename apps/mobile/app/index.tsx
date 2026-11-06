/**
 * The app's root route, `/`: the entry point a launch or a link that names no other path lands on,
 * and the route that decides which area the session belongs in (AAP 0.5.8).
 *
 * Every other route sits in a group or a folder — `(tabs)/discover.tsx` answers `/discover` and
 * `(auth)/sign-in.tsx` answers `/sign-in` — so Expo Router 4 opens the app at `/` on iOS and
 * Android, and nginx serves the web export there, with nothing behind it. The root layout corrects
 * a route only once the navigator has mounted, so without this file the app's first frames would be
 * the router's not-found screen.
 *
 * It decides nothing itself. Its branches are the root path's outcomes of the navigation gate in
 * `app/_layout.tsx`, which stays the one place the navigation rules are written down.
 *
 * Nothing here draws a screen, calls the API or holds a string: it decides where to go, and nothing
 * else.
 */
import type { ReactElement } from 'react';
import { Redirect, Stack } from 'expo-router';

import { useSession } from '../src/state/session-store';

/**
 * The one option this route sets on its own screen: no header.
 *
 * The route draws no screen of its own, so a header would be a bar over an empty page carrying the
 * route's name, "index". That is what is left on screen whenever the session stays unknown — an
 * offline start with a stored token, where the splash has been released and the retry notice
 * owns the frame — on the web and in a native build alike. Setting it here rather than in
 * `app/_layout.tsx` keeps the option with the route that needs it, which is how a route owns its
 * own header.
 */
const NO_HEADER = { headerShown: false };

/**
 * Sends the app root to the area the current session is allowed to be in.
 *
 * A `loading` session resolves nothing and draws nothing: the splash is still up, or the
 * unreachable-API notice is, and moving a traveler whose session is merely unknown would take them
 * off a route they are entitled to (AAP 0.5.8).
 *
 * These rules mirror the gate in `app/_layout.tsx`; keep the two identical.
 *
 * @returns The redirect for the session's area, or the header-less empty screen while the session
 * is unknown.
 */
export default function Index(): ReactElement | null {
  const session = useSession();

  if (session.status === 'loading') return <Stack.Screen options={NO_HEADER} />;
  if (session.status === 'signed_out') return <Redirect href="/sign-in" />;
  if (session.consented !== true) return <Redirect href="/age-gate" />;
  return <Redirect href="/discover" />;
}
