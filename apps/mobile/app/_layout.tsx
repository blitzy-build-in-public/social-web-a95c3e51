import 'react-native-get-random-values';

/**
 * The traveler app's root: the providers every screen sits in, the session bootstrap, the navigation
 * gate and the one Stack the route tree hangs from (AAP 0.5.8, AAP 0.6.2, AAP 0.8.1).
 *
 * `bootstrap()` runs once on mount and connects the chat socket itself, so nothing here opens one. Its
 * `unavailable` answer — the API could not be reached while a refresh token is stored — is not a
 * sign-out: the notice below says so and offers the retry (AAP 0.3.2, AAP 0.11.2).
 *
 * The gate is the client half of the API's own guards and never gates on proof status: a traveler
 * without a valid proof keeps every tab, and each screen changes its own content by
 * `MeDto.proof.status` (AAP 0.5.8).
 *
 * Nothing here logs: not the share intent's URI, not a file path, not a session field (AAP 0.11.1).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, usePathname, useRootNavigationState, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { colors, spacing } from '@tablemate/shared';

import { userMessageFor } from '../src/api/errors';
import { bootstrap } from '../src/auth/session';
import type { BootstrapResult } from '../src/auth/session';
import { registerForNotifications } from '../src/notifications/register';
import { PaymentsProvider } from '../src/payments/card-setup';
import { bindRealtimeInvalidation, queryClient } from '../src/state/meetup-store';
import { useSession } from '../src/state/session-store';
import type { SessionSnapshot } from '../src/state/session-store';
import { Banner, announce } from '../src/ui';

/**
 * The splash is held from this module's body, as that function's own documentation requires, and
 * released by the effect in {@link RootLayout} once the session is known. A build that cannot hold
 * it — a reload, the single-page web export — only loses the held first frame.
 */
void SplashScreen.preventAutoHideAsync().catch(() => {
  // Nothing to report and nothing to retry: the app is simply not holding the first frame.
});

/**
 * Whether this is the device proving benchmark build, read on the literal
 * `process.env.EXPO_PUBLIC_ZK_BENCH` reference alone because `babel-preset-expo` inlines only that
 * form. It decides one thing here: whether `dev/zk-bench` is reachable without a session, which is
 * what the Maestro benchmark flow needs on a fresh bench build (AAP 0.5.5).
 */
const BENCH_BUILD = process.env.EXPO_PUBLIC_ZK_BENCH === '1';

/** The app's own sentence for an unreachable API, shown and spoken by the retry notice (AAP 0.5.4). */
const OFFLINE_MESSAGE = userMessageFor('network_error');

/** The retry control's label. UI labels are not in the fixed-string table of AAP 0.5.8. */
const RETRY_LABEL = 'Retry';

/** The inset edges the retry notice claims: it sits at the bottom of the window. */
const NOTICE_EDGES = ['bottom', 'left', 'right'] as const;

/**
 * The initial route for a deep link into a stack screen such as `/meetups/<id>`, so the tabs stay
 * beneath it and the header's back control returns there (Expo Router's `unstable_settings`).
 */
export const unstable_settings = { initialRouteName: '(tabs)' };

// --- The navigation gate (AAP 0.5.8) ------------------------------------------------------------

/**
 * Whether an area of the route tree is public.
 *
 * `(auth)` holds sign-in and the "check your email" screen, and `auth` is the magic-link target
 * `auth/verify`, which sits outside that group because it is reached from a link rather than from
 * navigation. `legal` holds the terms, which the age gate links to before consent exists. `dev` is
 * public in a benchmark build alone: the Maestro flow opens `tablemate://dev/zk-bench` on a fresh
 * build with no session.
 *
 * The resolved route decides, and the requested path stands in when there is no route to resolve: a
 * URL no route file answers — a link into an area before its screen exists, or to a screen that has
 * been renamed away — renders the not-found route, whose segments are that route's rather than the
 * URL's. Without the fallback such a link would make a public area private, and a signed-out traveler
 * would be sent to sign-in from the terms screen they asked for. A group never appears in a URL, so
 * the fallback reads the part of the path a link actually names.
 */
function isOpenArea(area: string | undefined): boolean {
  if (area === '(auth)' || area === 'auth' || area === 'legal') return true;
  return BENCH_BUILD && area === 'dev';
}

/** The first segment of a requested path: `/legal/terms` -> `legal`, `/` -> undefined. */
function firstPathSegment(pathname: string): string | undefined {
  const segment = pathname.split('/')[1];
  return segment === undefined || segment === '' ? undefined : segment;
}

/**
 * The route a session is allowed to be on, or null when the current one is already allowed. Rules are
 * checked in this order, and the order is the implementation:
 *
 *   1. Signed out, not a public area -> `/sign-in`.
 *   2. Signed in, consents unrecorded, and not at the age gate, `auth` or `legal` -> `/age-gate`:
 *      every feature route answers `403 age_gate_required` until `POST /me/consents` has succeeded
 *      (AAP 0.5.4).
 *   3. Signed in, consented, inside `(auth)` -> `/discover`, so a finished sign-in leaves the auth
 *      group rather than rendering a sign-in screen at an authenticated session.
 *   4. Signed in, consented, at the app root -> `/discover`: the root layout is the client entry
 *      point (AAP 0.6.2) and no route file owns `/`.
 *   5. Otherwise null, `/ops` included — that area's own layout owns its operator and platform
 *      checks.
 *
 * A `loading` session resolves nothing: the splash is still up, or the retry notice is, and moving a
 * traveler whose session is merely unknown would take them off a route they are entitled to.
 *
 * @param session - The session the store currently holds.
 * @param segments - The resolved route's segments, group segments included.
 * @param pathname - The requested path, which is what a deep link asked for.
 * @returns The path to replace the current route with, or null to stay.
 */
function protectedRouteFor(
  session: SessionSnapshot,
  segments: readonly string[],
  pathname: string,
): string | null {
  const [area, second] = segments;

  if (session.status === 'signed_out') {
    return isOpenArea(area) || isOpenArea(firstPathSegment(pathname)) ? null : '/sign-in';
  }
  if (session.status !== 'signed_in') return null;

  if (session.consented !== true) {
    const allowed =
      (area === '(auth)' && second === 'age-gate') || area === 'auth' || area === 'legal';
    return allowed ? null : '/age-gate';
  }

  if (area === '(auth)') return '/discover';
  return pathname === '/' ? '/discover' : null;
}

/**
 * Whether the root navigator has mounted, which is the moment a navigation may be dispatched.
 *
 * Expo Router 4 types `useRootNavigationState()` as `any`, and navigating before the root layout has
 * mounted throws ("Attempted to navigate before mounting the Root Layout"), so the state is narrowed
 * by hand to the one field that proves mounting, the navigator's own key.
 */
function navigationIsMounted(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  return typeof (state as { key?: unknown }).key === 'string';
}

/**
 * Corrects the current route when the session may not be on it, and renders nothing itself.
 *
 * It runs only once the root navigator has mounted and the session is known, both of which are
 * prerequisites of a redirect rather than its subject, and it uses `replace` alone so a route the
 * session is not allowed on cannot be reached again through the back control.
 *
 * A target equal to the current path is skipped. That matters when a route cannot resolve — a
 * redirect into a path no route file owns lands on the not-found screen, which reports the path it
 * was sent to — and without the comparison every render would issue the same navigation again.
 */
function Gate(): null {
  const session = useSession();
  const segments = useSegments();
  const pathname = usePathname();
  const router = useRouter();
  const rootState: unknown = useRootNavigationState();

  useEffect(() => {
    if (!navigationIsMounted(rootState)) return;
    const target = protectedRouteFor(session, segments, pathname);
    if (target !== null && target !== pathname) router.replace(target);
  }, [pathname, rootState, router, segments, session]);

  return null;
}

// --- Share-sheet intake, native only (AAP 0.3.4, AAP 0.5.5) -------------------------------------

/** The shape of `expo-share-intent` 3.2.3: a provider and the hook that reads what was shared. */
type ShareIntentApi = typeof import('expo-share-intent');

/**
 * The share-intent API on iOS and Android, or null on the web.
 *
 * `expo-share-intent` 3.2.3 ships one build for both platforms and resolves its native module at
 * import, so a web bundle would evaluate a module whose only work is native: the require below sits
 * inside a native-only branch, and the web half of the proof intake is the `.eml` file picker alone
 * (AAP 0.3.4). The `import()` in the annotation is a type, which emits nothing.
 */
function loadShareIntentApi(): ShareIntentApi | null {
  if (Platform.OS === 'web') return null;
  /* eslint-disable-next-line @typescript-eslint/no-require-imports -- expo-share-intent has no web build; a static import would evaluate it in the web bundle. */
  return require('expo-share-intent') as ShareIntentApi;
}

/** This build's share-intent API, resolved once at first load. */
const SHARE_INTENT_API = loadShareIntentApi();

/**
 * Carries a shared `.eml` to the proof import screen once a session may import one.
 *
 * A share can arrive before sign-in and before the age gate, so the intent is kept untouched until
 * the session is `signed_in` and consented and forwarded then: the import screen would answer
 * `403 age_gate_required`, and `POST /itinerary-proofs` refuses a proof from any other session
 * (AAP 0.5.4). The URI is handed over as a route parameter, never logged, and `resetShareIntent`
 * clears the native module's copy in the same turn (AAP 0.5.5).
 */
function SharedFileForwarder({ api }: { readonly api: ShareIntentApi }): null {
  const { hasShareIntent, shareIntent, resetShareIntent } = api.useShareIntentContext();
  const session = useSession();
  const router = useRouter();

  const uri = hasShareIntent ? (shareIntent.files?.[0]?.path ?? null) : null;
  const ready = session.status === 'signed_in' && session.consented === true;

  useEffect(() => {
    if (uri === null || !ready) return;
    router.replace({ pathname: '/proof/import', params: { uri } });
    resetShareIntent();
  }, [ready, resetShareIntent, router, uri]);

  return null;
}

/**
 * Mounts the share-sheet provider where the platform has one and passes its children through where
 * it has none, so no screen has to know which platform it runs on.
 */
function ShareIntentIntake({ children }: { readonly children: ReactNode }): ReactElement {
  const api = SHARE_INTENT_API;
  if (api === null) return <>{children}</>;

  return (
    <api.ShareIntentProvider>
      <SharedFileForwarder api={api} />
      {children}
    </api.ShareIntentProvider>
  );
}

// --- The root layout (AAP 0.6.2) ----------------------------------------------------------------

/**
 * Renders the provider chain, the gate and the Stack every route hangs from, and runs the session
 * bootstrap once.
 *
 * The ref guard keeps React 18's development double-mount from running the side effects twice;
 * `bootstrap` is single-flight regardless. The splash is released when that attempt settles, because
 * `unavailable` leaves the session in `loading` and `loading` alone would hold it for good on an
 * offline start. Three effects follow the session: notifications are registered on a consented
 * session keyed by the traveler, the cache is bound to the chat socket once, and the gate corrects
 * the route.
 *
 * @returns The root element of the traveler app.
 */
export default function RootLayout(): ReactElement {
  const session = useSession();
  const [bootstrapSettled, setBootstrapSettled] = useState(false);
  const [offline, setOffline] = useState(false);
  const bootstrapStarted = useRef(false);

  /**
   * Runs one restore attempt and records what it established. Called once on mount and again by the
   * retry the notice offers: `bootstrap` clears its single-flight slot when an attempt settles, so a
   * retry really is a second attempt.
   */
  const runBootstrap = useCallback((): void => {
    void (async () => {
      let result: BootstrapResult;
      try {
        result = await bootstrap();
      } catch {
        // `bootstrap` answers every outcome it can reach; a rejection would mean this client could
        // not start an attempt at all, which reads to the traveler as an unreachable API does.
        result = 'unavailable';
      }

      setBootstrapSettled(true);
      const unreachable = result === 'unavailable';
      setOffline(unreachable);
      if (unreachable) announce(OFFLINE_MESSAGE);
    })();
  }, []);

  useEffect(() => {
    // React 18 mounts an effect twice in development, to surface effects that are not idempotent.
    if (bootstrapStarted.current) return;
    bootstrapStarted.current = true;
    runBootstrap();
  }, [runBootstrap]);

  useEffect(() => {
    // Held until the session is known, and released on a settled attempt as well as on a status
    // change, because `unavailable` leaves the status at `loading`.
    if (!bootstrapSettled && session.status === 'loading') return;
    void SplashScreen.hideAsync().catch(() => {
      // A splash already released — a reload, the web export — cannot be hidden twice.
    });
  }, [bootstrapSettled, session.status]);

  useEffect(() => {
    // Fire and forget: it resolves in every case, and nothing in the core flow waits on a
    // notification (AAP 0.3.2, AAP 0.3.4). Not called before consent, because the API refuses
    // feature routes with `403 age_gate_required` until then (AAP 0.5.4).
    if (session.status !== 'signed_in' || session.consented !== true) return;
    void registerForNotifications();
  }, [session.consented, session.status, session.userId]);

  useEffect(() => bindRealtimeInvalidation(), []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <PaymentsProvider>
            <ShareIntentIntake>
              <Gate />
              {/* The page's one main landmark, on the wrapper that holds the Stack rather than in a
                  screen: react-native-web renders role="main" as a real <main> (AAP 0.5.8), it
                  covers every route, the screens that do not render the Screen primitive included,
                  and react-native's own Role union accepts 'main', so iOS and Android are unchanged. */}
              <View role="main" style={styles.fill}>
                <Stack
                  screenOptions={{
                    headerBackTitle: 'Back',
                    contentStyle: { backgroundColor: colors.background },
                  }}
                >
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  <Stack.Screen name="(auth)" options={{ headerShown: false }} />
                  <Stack.Screen name="ops" options={{ headerShown: false }} />
                  <Stack.Screen name="report" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="dev/zk-bench" options={{ headerShown: false }} />
                </Stack>
                {offline ? (
                  <SafeAreaView edges={NOTICE_EDGES} style={styles.notice} pointerEvents="box-none">
                    <Banner
                      tone="error"
                      message={OFFLINE_MESSAGE}
                      action={{
                        label: RETRY_LABEL,
                        onPress: runBootstrap,
                        testID: 'bootstrap-retry',
                      }}
                      testID="bootstrap-notice"
                    />
                  </SafeAreaView>
                ) : null}
              </View>
              <StatusBar style="dark" />
            </ShareIntentIntake>
          </PaymentsProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  fill: {
    flex: 1,
  },
  notice: {
    // An overlay rather than a band: the retry has to be reachable while the route beneath it is a
    // screen that could not load. `box-none` lets every touch outside the notice through to it.
    position: 'absolute',
    start: 0,
    end: 0,
    bottom: 0,
    padding: spacing.lg,
  },
});
