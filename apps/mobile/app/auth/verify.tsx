/** The magic-link landing screen: the app's only caller of `POST /auth/verify`, which exchanges the link's token for a session and routes on what the account still needs. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Linking, Platform } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { MAGIC_LINK_PATH } from '@tablemate/shared';

import type { MeDto } from '@tablemate/shared';

import { isApiError, isNetworkError, userMessageFor } from '../../src/api/errors';
import { verifyToken } from '../../src/auth/session';
import { Banner, Button, Screen, announce } from '../../src/ui';

type VerifyPhase = 'missing' | 'choose' | 'verifying' | 'error';
const TITLES = {
  missing: 'Sign in',
  choose: 'Where would you like to sign in?',
  verifying: 'Signing in',
  error: 'Sign in',
} satisfies Record<VerifyPhase, string>;
const INCOMPLETE_LINK = 'This sign-in link is incomplete.';
const EXPIRED_LINK = 'This sign-in link has expired or was already used.';
const SIGNING_IN = 'Signing you in…';
const CHOOSE_MESSAGE = 'Open this link in the Tablemate app, or continue here in the browser.';
const CONTINUE_IN_BROWSER = 'Continue in browser';
const OPEN_IN_APP = 'Open in the Tablemate app';
const BACK_TO_SIGN_IN = 'Back to sign-in';
const TRY_AGAIN = 'Try again';
const CLEAN_PATH = MAGIC_LINK_PATH;
const SECONDARY = { variant: 'secondary' } as const;
const MOBILE_AGENT = /Android|iPhone|iPad|iPod/i;
const IPAD_ON_MAC_AGENT = /Macintosh/i;

function isMobileWebBrowser(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  if (MOBILE_AGENT.test(navigator.userAgent)) return true;
  return IPAD_ON_MAC_AGENT.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

function normalizeToken(raw: unknown): string {
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

function appLink(token: string): string {
  /*
   * The leading slash serves the mailer's web URL; a custom-scheme deep link takes the route's
   * path as its first segment after the scheme separator, so it is dropped here.
   */
  return `tablemate://${MAGIC_LINK_PATH.replace(/^\//, '')}?token=${encodeURIComponent(token)}`;
}

function failureMessage(error: unknown): string {
  if (isApiError(error) && error.code === 'token_invalid') return EXPIRED_LINK;
  return isApiError(error) ? userMessageFor(error.code) : userMessageFor('network_error');
}

/**
 * Where the session this link verified lands (AAP 0.5.4, AAP 0.5.8).
 *
 * An operator lands on the operator dashboard: the API guards that area by role and leaves `/admin/*`
 * outside the 18+ age gate (AAP 0.5.4), so a destination chosen on consents alone would park an
 * operator whose consents are still unset on the traveler's gate, which they have no reason to pass.
 * The same destination is right on every platform, because `/ops` renders on web alone and the
 * area's own layout sends a native session to the tabs (AAP 0.5.8).
 *
 * Everyone else keeps the rule this screen has always applied: the gate until `POST /me/consents`
 * has succeeded, and Discover once it has.
 */
function landingRouteFor(user: MeDto): '/ops' | '/discover' | '/age-gate' {
  if (user.role === 'operator') return '/ops';
  return user.consents.ageConfirmedAt !== null ? '/discover' : '/age-gate';
}

function replaceHistoryEntry(): void {
  const entry: unknown = window.history.state;
  try {
    window.history.replaceState(entry, '', CLEAN_PATH);
  } catch {
    /* A refused history write keeps the visible URL; the routed clear below still applies to it. */
  }
}

function dropTokenFromAddressBar(): boolean {
  if (Platform.OS !== 'web') return true;
  if (typeof window !== 'undefined') replaceHistoryEntry();
  try {
    router.setParams({ token: undefined });
  } catch {
    return false;
  }
  return true;
}

export default function VerifyMagicLinkScreen(): ReactElement {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const [token] = useState(() => normalizeToken(params.token));
  const [mobileWeb] = useState(isMobileWebBrowser);
  const routeToken = params.token;
  const [phase, setPhase] = useState<VerifyPhase>(() =>
    token === '' ? 'missing' : mobileWeb ? 'choose' : 'verifying',
  );
  const [message, setMessage] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const spent = useRef(false);
  const cleared = useRef(false);
  const runVerify = useCallback((): void => {
    if (token === '' || spent.current) return;
    spent.current = true;
    setPhase('verifying');
    setMessage(null);
    setRetryable(false);
    void (async () => {
      let landing: '/ops' | '/discover' | '/age-gate';
      try {
        landing = landingRouteFor(await verifyToken(token));
      } catch (error) {
        const failed = failureMessage(error);
        setMessage(failed);
        setRetryable(isNetworkError(error));
        setPhase('error');
        announce(failed);
        return;
      }
      router.replace(landing);
    })();
  }, [token]);
  const goToSignIn = (): void => router.replace('/sign-in');
  const backAction = { label: BACK_TO_SIGN_IN, onPress: goToSignIn, testID: 'verify-back' };
  const retry = (): void => {
    spent.current = false;
    runVerify();
  };
  const openInApp = (): void => void Linking.openURL(appLink(token)).catch(() => undefined);
  useEffect(() => {
    if (token === '') {
      announce(INCOMPLETE_LINK);
      return;
    }
    if (mobileWeb) return;
    runVerify();
  }, [mobileWeb, runVerify, token]);
  useEffect(() => {
    if (cleared.current || routeToken === undefined || phase === 'choose') return;
    cleared.current = dropTokenFromAddressBar();
  }, [phase, routeToken]);
  return (
    <Screen testID="verify-screen">
      <Stack.Screen options={{ title: TITLES.missing }} />
      {phase === 'missing' ? (
        <Banner tone="error" message={INCOMPLETE_LINK} action={backAction} testID="verify-error" />
      ) : null}
      {phase === 'choose' ? (
        <>
          <Banner tone="info" message={CHOOSE_MESSAGE} testID="verify-choose" />
          <Button label={CONTINUE_IN_BROWSER} onPress={runVerify} testID="verify-continue" />
          <Button {...SECONDARY} label={OPEN_IN_APP} onPress={openInApp} testID="verify-open-app" />
        </>
      ) : null}
      {phase === 'verifying' ? (
        <>
          <Banner tone="info" message={SIGNING_IN} testID="verify-status" />
          {mobileWeb ? (
            <Button label={CONTINUE_IN_BROWSER} busy onPress={runVerify} testID="verify-continue" />
          ) : null}
        </>
      ) : null}
      {phase === 'error' && message !== null ? (
        <>
          <Banner tone="error" message={message} action={backAction} testID="verify-error" />
          {retryable ? <Button label={TRY_AGAIN} onPress={retry} testID="verify-retry" /> : null}
        </>
      ) : null}
    </Screen>
  );
}
