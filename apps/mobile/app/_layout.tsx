/**
 * The traveler app's root: the providers every screen sits in, the session bootstrap, the navigation
 * gate, the web head and the one Stack the route tree hangs from (AAP 0.5.8, AAP 0.6.2, AAP 0.8.1).
 */
import 'react-native-get-random-values';
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
import { bootstrap, type BootstrapResult } from '../src/auth/session';
import { registerForNotifications } from '../src/notifications/register';
import { PaymentsProvider } from '../src/payments/card-setup';
import { RouteHead } from '../src/seo/RouteHead';
import { bindRealtimeInvalidation, queryClient } from '../src/state/meetup-store';
import { useSession, type SessionSnapshot } from '../src/state/session-store';
import { Banner, announce } from '../src/ui';
import { renderWebHeaderLeft } from '../src/ui/HeaderBackButton';
void SplashScreen.preventAutoHideAsync().catch(() => {});
const BENCH_BUILD = process.env.EXPO_PUBLIC_ZK_BENCH === '1';
const OFFLINE_MESSAGE = userMessageFor('network_error');
const NOTICE_EDGES = ['bottom', 'left', 'right'] as const;
const NOTICE = { tone: 'error', message: OFFLINE_MESSAGE } as const;
const HEADER = {
  headerBackTitle: 'Back',
  contentStyle: { backgroundColor: colors.background },
  // Web only: the navigator's own back control is a bundled PNG, which every screen of this stack
  // requests as soon as its header renders its back entry. Native keeps the platform header (AAP 0.5.8).
  ...(Platform.OS === 'web' ? { headerLeft: renderWebHeaderLeft } : {}),
};
export const unstable_settings = { initialRouteName: '(tabs)' };
const isOpenArea = (area: string | undefined): boolean =>
  area === '(auth)' || area === 'auth' || area === 'legal' || (BENCH_BUILD && area === 'dev');
const openToUnconsented = (area: string | undefined, second: string | undefined): boolean =>
  (area === '(auth)' && second === 'age-gate') || area === 'auth' || area === 'legal';
function protectedRouteFor(session: SessionSnapshot, segments: readonly string[], path: string) {
  const [area, second] = segments;
  const open = isOpenArea(area) || isOpenArea(path.split('/')[1] || undefined);
  if (session.status === 'signed_out') return open ? null : '/sign-in';
  if (session.status !== 'signed_in') return null;
  if (session.consented !== true) return openToUnconsented(area, second) ? null : '/age-gate';
  if (area === '(auth)') return '/discover';
  return path === '/' ? '/discover' : null;
}
const navigationIsMounted = (raw: unknown): boolean =>
  raw !== null && typeof raw === 'object' && typeof (raw as { key?: unknown }).key === 'string';
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
  const [{ settled, offline }, setStatus] = useState({ settled: false, offline: false });
  const bootstrapStarted = useRef(false);
  const runBootstrap = useCallback((): void => {
    void (async () => {
      const result = await bootstrap().catch((): BootstrapResult => 'unavailable');
      setStatus({ settled: true, offline: result === 'unavailable' });
      if (result === 'unavailable') announce(OFFLINE_MESSAGE);
    })();
  }, []);
  const retry = { label: 'Retry', onPress: runBootstrap, testID: 'bootstrap-retry' };
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
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <PaymentsProvider>
            <ShareIntentIntake>
              <Gate />
              <RouteHead />
              <View role="main" style={styles.fill}>
                <Stack screenOptions={HEADER}>
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  <Stack.Screen name="(auth)" options={{ headerShown: false }} />
                  <Stack.Screen name="ops" options={{ headerShown: false }} />
                  <Stack.Screen name="report" options={{ presentation: 'modal' }} />
                  <Stack.Screen name="dev/zk-bench" options={{ headerShown: false }} />
                </Stack>
                {offline && (
                  <SafeAreaView edges={NOTICE_EDGES} style={styles.notice} pointerEvents="box-none">
                    <Banner {...NOTICE} action={retry} testID="bootstrap-notice" />
                  </SafeAreaView>
                )}
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
  notice: { position: 'absolute', start: 0, end: 0, bottom: 0, padding: spacing.lg },
});
