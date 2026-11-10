/**
 * The traveler app's root: the providers every screen sits in, the session bootstrap and its notice,
 * the navigation gate, the web head and the one Stack the route tree hangs from (AAP 0.5.8,
 * AAP 0.6.2, AAP 0.8.1).
 *
 * It also releases focus from the control a press was made on, hands that control back when the press
 * stayed on its screen, and marks the containers the router has hidden `inert`: a screen the reader
 * has left keeps its controls in the tab order while it is only `aria-hidden`, so without the mark a
 * keyboard or screen-reader user can be left holding a control on a screen that is not on the window,
 * and the next write to that screen's container cannot be applied while they hold it.
 */
import 'react-native-get-random-values';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  SafeAreaInsetsContext,
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, usePathname, useRootNavigationState, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { colors, spacing } from '@tablemate/shared';
import { userMessageFor } from '../src/api/errors';
import { bootstrap, type BootstrapResult } from '../src/auth/session';
import { registerForNotifications } from '../src/notifications/register';
import { PaymentsProvider } from '../src/payments/card-setup';
import { RouteHead } from '../src/seo/RouteHead';
import { bindRealtimeInvalidation, queryClient } from '../src/state/meetup-store';
import { useSession, type SessionSnapshot } from '../src/state/session-store';
import { AppNoticeProvider, Banner, announce, navigationHeaderOptions } from '../src/ui';
void SplashScreen.preventAutoHideAsync().catch(() => {});
const BENCH_BUILD = process.env.EXPO_PUBLIC_ZK_BENCH === '1';
const OFFLINE_MESSAGE = userMessageFor('network_error');
/** The safe-area edges the notice strip claims: as the first element of the content column it clears the status bar or notch rather than drawing behind them. */
const NOTICE_EDGES = ['top', 'left', 'right'] as const;
const NOTICE = { tone: 'error', message: OFFLINE_MESSAGE } as const;
// The root Stack's chrome comes from the one shared definition (`src/ui/NavigationHeader`); `contentStyle` is the stack's own.
const HEADER = {
  ...navigationHeaderOptions('background'),
  contentStyle: { backgroundColor: colors.background },
};
export const unstable_settings = { initialRouteName: '(tabs)' };
const isOpenArea = (area: string | undefined): boolean =>
  area === '(auth)' || area === 'auth' || area === 'legal' || (BENCH_BUILD && area === 'dev');
/** Whether the route the client is on does its own job with no session at all: the sign-in screens, the emailed link and the legal pages. One predicate answers for both the navigation gate and the app-level notice, so what counts as public cannot differ between them. */
function isOpenRoute(segments: readonly string[], path: string): boolean {
  return isOpenArea(segments[0]) || isOpenArea(path.split('/')[1] || undefined);
}
const openToUnconsented = (area: string | undefined, second: string | undefined): boolean =>
  (area === '(auth)' && second === 'age-gate') || area === 'auth' || area === 'legal';
/**
 * Whether the route in view is the operator area, for the operator session that holds it (AAP
 * 0.5.4).
 *
 * `/ops` is not a traveler feature route: the API guards the operator area by role rather than by
 * consents, and leaves `/admin/*` outside the 18+ age gate. Without this exemption the consent
 * branch below would send an operator whose consents are still unset to the traveler's own gate, so
 * the dashboard would stay unreachable until they recorded traveler consents they do not need.
 * Nothing is granted here: the area's own layout serves it to an operator session alone, and the
 * server's role guard, which answers `403 operator_only` to anyone else, is the authority.
 *
 * Both halves are required, so a signed-out session, a non-operator session and every traveler route
 * keep the answer the branch gives them today. The area test follows {@link isOpenRoute}: the
 * resolved route's first segment, with the requested path's first segment as the fallback for a URL
 * that resolves to the not-found route.
 */
function openToOperator(
  session: SessionSnapshot,
  segments: readonly string[],
  path: string,
): boolean {
  return session.role === 'operator' && (segments[0] === 'ops' || path.split('/')[1] === 'ops');
}
function protectedRouteFor(session: SessionSnapshot, segments: readonly string[], path: string) {
  const [area, second] = segments;
  const open = isOpenRoute(segments, path);
  if (session.status === 'signed_out') return open ? null : '/sign-in';
  if (session.status !== 'signed_in') return null;
  if (session.consented !== true) {
    const exempt = openToUnconsented(area, second) || openToOperator(session, segments, path);
    return exempt ? null : '/age-gate';
  }
  if (area === '(auth)') return '/discover';
  return path === '/' ? '/discover' : null;
}
const navigationIsMounted = (raw: unknown): boolean =>
  raw !== null && typeof raw === 'object' && typeof (raw as { key?: unknown }).key === 'string';

/** The elements whose field keeps focus: taking focus out of a text field would interrupt typing — a space especially, which is one of the two keys focus is released on everywhere else. */
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Whether the control that holds focus answers the key-down itself: a link drawn as a row (`role="link"` with no `href`) is activated by the app on the key-down, because the browser activates no such element and react-native-web withholds its own press from `role="link"`. */
function answersKeyDown(active: HTMLElement): boolean {
  return active.tagName !== 'A' && active.getAttribute('role') === 'link';
}

/** Whether the browser performs the press on the control that holds focus: react-native-web renders `role="button"` as a real button and leaves an anchor alone, and a browser activates both, so those presses are left to the press itself. */
function browserAnswersPress(active: HTMLElement): boolean {
  return active.tagName === 'A' || active.tagName === 'BUTTON';
}

/**
 * Releases focus from the control that holds it, on web, unless that control is a text field.
 *
 * A screen the router has left stays mounted inside a container react-navigation marks `aria-hidden`,
 * and Chrome refuses to hide a subtree that still holds focus: it blocks the attribute and logs a
 * warning on every in-app navigation started from a focusable control, which also leaves a screen
 * reader's focus parked in a subtree marked hidden. Letting go of the control the navigation was
 * started from, before the navigation commits, removes both.
 *
 * Chrome re-focuses a pressed control on mousedown, so a mouse press has to be answered as the press
 * itself arrives, and these listeners therefore run in the capture phase rather than after the app's
 * own handlers have run.
 *
 * The release is only right for a press that navigates, and that is all it lasts for here: the control
 * is handed back by {@link restoreReleasedFocus} when the press stayed on its screen.
 */
function releaseFocusedControl(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (TEXT_ENTRY_TAGS.has(active.tagName) || active.isContentEditable) return;
  active.blur();
  restoreReleasedFocus(active);
}

/**
 * The mark of a screen the router has left: the `aria-hidden` the router writes, and the `inert` this
 * file mirrors it into. A control below either one has no screen of its own to hold focus on.
 */
const HIDDEN_SCREEN = '[aria-hidden="true"], [inert]';

/**
 * Hands focus back to the control a press was released from, on web, when the press did not leave the
 * screen it was made on.
 *
 * A press that stays on the screen hides nothing, so releasing it costs a keyboard user the control
 * they were operating and the ring the primitives paint from their own focused state, with nothing to
 * say where they are (AAP 0.5.8: every web flow is fully keyboard-operable). A press that navigates
 * leaves focus released, because the screen being left is being hidden.
 *
 * Which of the two a press was is only known once the app has applied it: the router hides the screen
 * it leaves in a React commit, and that commit lands after the microtasks of the press, at the end of
 * the frame the press arrived in. That frame is therefore when the release is settled, and what the
 * conditions below read is the app as it stands then: nothing else has taken focus, the control is
 * still in the document and is not `document.body`, no ancestor of it carries the mark above (both
 * forms, because the `inert` mirror of it is applied by a MutationObserver microtask), and it is still
 * focusable — the browser decides that last one, and `focus()` is a no-op on a control that is not.
 */
function restoreReleasedFocus(released: HTMLElement): void {
  requestAnimationFrame(() => {
    if (released === document.body || !released.isConnected) return;
    if (document.activeElement !== document.body) return;
    if (released.closest(HIDDEN_SCREEN) !== null) return;
    released.focus();
  });
}

/** Marks the containers the router has hidden `inert` as well, on web: `aria-hidden` alone leaves their controls in the tab order and blocks the next `aria-hidden` write while a descendant holds focus. */
function mirrorHiddenContainers(): () => void {
  const sync = (element: Element): void => {
    // `inert` is an HTML attribute, and the app's decorative `aria-hidden` glyphs hold no focus; the body is left alone, because a hidden document is not a hidden screen.
    if (!(element instanceof HTMLElement) || element === document.body) return;
    element.inert = element.getAttribute('aria-hidden') === 'true';
  };
  const syncTree = (node: Node): void => {
    if (!(node instanceof Element)) return;
    sync(node);
    for (const nested of node.querySelectorAll('[aria-hidden]')) sync(nested);
  };
  for (const element of document.querySelectorAll('[aria-hidden]')) sync(element);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof Element) sync(record.target);
        continue;
      }
      for (const added of record.addedNodes) syncTree(added);
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-hidden'],
  });
  return () => observer.disconnect();
}
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
type ShareIntentApi = typeof import('expo-share-intent');
function SharedFileForwarder({ api }: { readonly api: ShareIntentApi }): null {
  const { hasShareIntent, shareIntent, resetShareIntent } = api.useShareIntentContext();
  const session = useSession();
  const router = useRouter();
  const uri = hasShareIntent ? (shareIntent.files?.[0]?.path ?? null) : null;
  useEffect(() => {
    if (uri === null || session.status !== 'signed_in' || session.consented !== true) return;
    router.replace({ pathname: '/proof/import', params: { uri } });
    resetShareIntent();
  }, [resetShareIntent, router, session.consented, session.status, uri]);
  return null;
}
function ShareIntentIntake({ children }: { readonly children: ReactNode }): ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- expo-share-intent has no web build
  const api = Platform.OS === 'web' ? null : (require('expo-share-intent') as ShareIntentApi);
  if (api === null) return <>{children}</>;
  return (
    <api.ShareIntentProvider>
      <SharedFileForwarder api={api} />
      {children}
    </api.ShareIntentProvider>
  );
}
export default function RootLayout(): ReactElement {
  const session = useSession();
  const segments = useSegments();
  const pathname = usePathname();
  // The insets every screen below the notice is laid out in, read from the context rather than with `useSafeAreaInsets`, because this component is where the provider is mounted: a null value means no provider above it.
  const insets = useContext(SafeAreaInsetsContext);
  const [{ settled, offline }, setStatus] = useState({ settled: false, offline: false });
  const [retrying, setRetrying] = useState(false);
  const bootstrapStarted = useRef(false);
  const runBootstrap = useCallback((): void => {
    setRetrying(true);
    void (async () => {
      const result = await bootstrap().catch((): BootstrapResult => 'unavailable');
      setStatus({ settled: true, offline: result === 'unavailable' });
      setRetrying(false);
      if (result === 'unavailable') announce(OFFLINE_MESSAGE);
    })();
  }, []);
  const retry = {
    label: 'Retry',
    onPress: runBootstrap,
    busy: retrying,
    testID: 'bootstrap-retry',
  };
  /** The notice belongs to the routes that need the session at all: a public screen reaches no API, so it has nothing to be told about the failure. The predicate the navigation gate uses decides this too, so the two cannot disagree. */
  const noticeMessage = offline && !isOpenRoute(segments, pathname) ? OFFLINE_MESSAGE : null;
  /** The notice is the window's topmost element and carries the status bar's inset itself, exactly as a navigator's own header does: everything below it must stop reserving that band, or the same inset is spent twice. */
  const contentInsets = useMemo(() => {
    if (noticeMessage === null || insets === null) return insets;
    return { ...insets, top: 0 };
  }, [insets, noticeMessage]);
  useEffect(() => {
    if (bootstrapStarted.current) return;
    bootstrapStarted.current = true;
    runBootstrap();
  }, [runBootstrap]);
  useEffect(() => {
    if (settled || session.status !== 'loading') void SplashScreen.hideAsync().catch(() => {});
  }, [settled, session.status]);
  useEffect(() => {
    if (session.status !== 'signed_in' || session.consented !== true) return;
    void registerForNotifications();
  }, [session.consented, session.status, session.userId]);
  useEffect(() => bindRealtimeInvalidation(), []);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const active = document.activeElement;
      if (event.key !== 'Enter' || event.repeat || !(active instanceof HTMLElement)) return;
      if (answersKeyDown(active)) releaseFocusedControl();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      const active = document.activeElement;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (!(active instanceof HTMLElement) || browserAnswersPress(active)) return;
      releaseFocusedControl();
    };
    // Capture phase, so focus is released before the app's own handlers navigate: the key-down answers a link row that presses itself, the key-up answers a control react-native-web presses, and the click answers everything the browser presses — so no press is released before it is delivered.
    document.addEventListener('click', releaseFocusedControl, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    const stopMirroring = mirrorHiddenContainers();
    return () => {
      document.removeEventListener('click', releaseFocusedControl, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      stopMirroring();
    };
  }, []);
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <PaymentsProvider>
            <ShareIntentIntake>
              <Gate />
              <RouteHead />
              {/* No landmark here: the page's own `main` landmark lives in the `Screen` primitive, and a second one wrapping every route would nest two. */}
              <View style={styles.fill}>
                {noticeMessage === null ? null : (
                  <SafeAreaView edges={NOTICE_EDGES} style={styles.notice}>
                    <Banner {...NOTICE} action={retry} testID="bootstrap-notice" />
                  </SafeAreaView>
                )}
                <SafeAreaInsetsContext.Provider value={contentInsets}>
                  <AppNoticeProvider notice={noticeMessage}>
                    <Stack screenOptions={HEADER}>
                      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
                      <Stack.Screen name="ops" options={{ headerShown: false }} />
                      <Stack.Screen name="report" options={{ presentation: 'modal' }} />
                      <Stack.Screen name="dev/zk-bench" options={{ headerShown: false }} />
                    </Stack>
                  </AppNoticeProvider>
                </SafeAreaInsetsContext.Provider>
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
  root: { flex: 1 },
  fill: { flex: 1 },
  // In flow, above the navigator: the notice takes its own height and leaves every control below it where it was.
  notice: { padding: spacing.lg },
});
