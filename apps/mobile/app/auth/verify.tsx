/**
 * The magic-link landing screen: the app's only caller of `POST /auth/verify` (AAP 0.5.4, AAP 0.5.8,
 * AAP 0.8.1).
 *
 * A magic-link mail points at `${WEB_ORIGIN}/auth/verify?token=…` and a native launch at
 * `tablemate://auth/verify?token=…`; `app/+native-intent.tsx` passes both through unchanged, and this
 * route sits outside the `(auth)` group so its URL keeps the `/auth/` prefix.
 *
 * One platform reading decides how the token is spent: on a mobile browser the link opens a choice
 * rather than consuming it — the traveler may have the app installed, and the token is single use —
 * while on desktop web and native the exchange starts on arrival.
 *
 * The token is captured into state on the first render and never re-read, because the exchange takes
 * it out of the address bar; the exchange is guarded by a ref, so React 18's development
 * double-mount cannot spend one link twice. Nothing here logs the token, the URL holding it or any
 * part of the answer (AAP 0.5.5, AAP 0.11.1).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Linking, Platform } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';

import { isApiError, isNetworkError, userMessageFor } from '../../src/api/errors';
import { verifyToken } from '../../src/auth/session';
import { Banner, Button, Screen, announce } from '../../src/ui';

/**
 * What the screen is doing. `choose` is reached on a mobile browser alone, and `verifying` is the
 * exchange and the only state that ends without a route change or an error.
 */
type VerifyPhase = 'missing' | 'choose' | 'verifying' | 'error';

/** The header title of the route, which is the sign-in landing. */
const HEADER_TITLE = 'Sign in';

/** The page heading while the link is being checked or a failure is shown. */
const SIGN_IN_TITLE = 'Sign in';

/** The page heading while the token is being exchanged. */
const SIGNING_IN_TITLE = 'Signing in';

/** The page heading on a mobile browser, where the traveler picks where to sign in. */
const CHOOSE_TITLE = 'Where would you like to sign in?';

/** A link that carries no token: nothing was requested, and a fresh one is what is needed. */
const INCOMPLETE_LINK = 'This sign-in link is incomplete.';

/**
 * The one sentence the API's `401 token_invalid` shows here: the link is unknown, older than its 15
 * minutes, or already used (AAP 0.5.4). Not one of the fixed strings of AAP 0.5.8, so it is written
 * on this screen rather than in `src/copy/strings.ts`.
 */
const EXPIRED_LINK = 'This sign-in link has expired or was already used.';

/** Shown while the token is being exchanged. */
const SIGNING_IN = 'Signing you in…';

/** The mobile browser's prompt above the two choices. */
const CHOOSE_MESSAGE = 'Open this link in the Tablemate app, or continue here in the browser.';

/** The mobile browser's primary action: exchange the token here. */
const CONTINUE_IN_BROWSER = 'Continue in browser';

/** The mobile browser's alternative: hand the same token to the installed app. */
const OPEN_IN_APP = 'Open in the Tablemate app';

/** Offered on every failure, because a spent or unknown link is answered by a new one. */
const BACK_TO_SIGN_IN = 'Back to sign-in';

/** Offered on a request that never reached the API, which is the one failure worth repeating. */
const TRY_AGAIN = 'Try again';

/** The path this route keeps once the token has been sent, so a reload cannot reuse it. */
const CLEAN_PATH = '/auth/verify';

/** The two user-agent readings that mean "a phone or tablet browser", never a desktop one. */
const MOBILE_AGENT = /Android|iPhone|iPad|iPod/i;
const IPAD_ON_MAC_AGENT = /Macintosh/i;

/**
 * Whether this is a mobile browser, which is the one case where the token is not spent on arrival.
 *
 * A phone or tablet browser, and nothing else: the web build is also the desktop client, where a
 * hand-off to an app is meaningless. iPadOS reports a Macintosh user agent and is told apart by its
 * touch points, which every desktop browser and every Playwright engine reports none of.
 */
function isMobileWebBrowser(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  if (MOBILE_AGENT.test(navigator.userAgent)) return true;
  return IPAD_ON_MAC_AGENT.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

/**
 * The token of a magic link, from the one shape `useLocalSearchParams` can give it: Expo Router hands
 * a repeated query parameter as `string[]`, so the first entry is taken. Anything else — absent,
 * empty, whitespace alone, not a string — is the empty string, which is what the incomplete-link
 * state is decided on.
 */
function normalizeToken(raw: unknown): string {
  // Annotated `unknown`: `Array.isArray` narrows to `any[]`, and nothing below trusts its element.
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

/** The deep link that hands a token to the installed app, in the scheme `app.config.ts` declares. */
function appLink(token: string): string {
  return `tablemate://auth/verify?token=${encodeURIComponent(token)}`;
}

/**
 * The sentence a failed exchange shows. The API's `token_invalid` gets this screen's own wording —
 * a spent magic link, not the ended session `userMessageFor` describes for that code elsewhere —
 * and every other code gets the app's sentence for it. The server's prose is never shown
 * (AAP 0.5.4, AAP 0.11.1).
 */
function failureMessage(error: unknown): string {
  if (isApiError(error) && error.code === 'token_invalid') return EXPIRED_LINK;
  return isApiError(error) ? userMessageFor(error.code) : userMessageFor('network_error');
}

/** The page heading for a state: the choice where there is one, the exchange, else the landing. */
function titleFor(phase: VerifyPhase): string {
  if (phase === 'choose') return CHOOSE_TITLE;
  return phase === 'verifying' ? SIGNING_IN_TITLE : SIGN_IN_TITLE;
}

/**
 * Takes the token out of the address bar, once it has been sent, whatever the exchange then answers
 * (AAP 0.5.4), so a reload, a bookmark or a shared screenshot cannot spend the link a second time.
 *
 * Two writes, because neither is enough alone and both were measured in a browser run of this screen.
 * The URL itself is rewritten, because the router writes the launch URL — token and all — into the
 * address bar as it initializes. The route's own parameter is cleared as well, because Expo Router
 * re-derives the address bar from its parameters on later renders, which restores the token if only
 * the URL was rewritten. `window.history.state` is passed through rather than replaced with `null`:
 * Expo Router keeps its history entry id there, and clearing it would reset the history its back
 * control walks. The parameter is cleared with `undefined`, which the URL stringifier drops — `null`
 * would leave `token=null` in the query.
 *
 * Answers whether that routed clear was taken. `router.setParams` refuses an action before the root
 * navigator has mounted, and a refusal is what a cold load gets, because the exchange starts first;
 * `false` leaves the attempt to repeat on the screen's next state transition.
 */
function dropTokenFromAddressBar(): boolean {
  if (Platform.OS !== 'web') return true;

  if (typeof window !== 'undefined') {
    const entry: unknown = window.history.state;
    try {
      window.history.replaceState(entry, '', CLEAN_PATH);
    } catch {
      // A document that refuses a history write keeps the visible URL; the routed clear below still
      // applies to it.
    }
  }

  try {
    router.setParams({ token: undefined });
  } catch {
    // The navigator is not mounted yet. The screen's own effect calls this again on its next state
    // transition, and the exchange runs either way: the link is single use, and only the address bar
    // is at stake.
    return false;
  }

  return true;
}

/**
 * Exchanges the link's token for a session and routes on what the account still needs, offering the
 * mobile browser's choice before it does.
 *
 * `verifyToken` owns everything the sign-in consists of — the stored refresh token, the session
 * store, the cached own profile, the chat socket — so nothing of that is repeated here, and no route
 * is called directly. On success the traveler lands on Discover, or on the age gate when the account
 * has not yet confirmed its age and accepted the terms (AAP 0.5.4, AAP 0.5.8).
 */
export default function VerifyMagicLinkScreen(): ReactElement {
  // Settled on the first render and never re-read: the query parameter may be gone from the address
  // bar a moment later, and the user agent does not change under a mounted screen.
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const [token] = useState(() => normalizeToken(params.token));
  const [mobileWeb] = useState(isMobileWebBrowser);

  /**
   * The token as the route still carries it, which the cleanup effect reads. It is separate from
   * `token` on purpose: `token` is what this mount sends and never changes, while the route's
   * parameter is what the address bar is derived from and is dropped once the token has been sent.
   */
  const routeToken = params.token;

  const [phase, setPhase] = useState<VerifyPhase>(() =>
    token === '' ? 'missing' : mobileWeb ? 'choose' : 'verifying',
  );
  const [message, setMessage] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);

  /**
   * Whether this mount has sent the token. It is set before the request is made rather than after its
   * answer, so a second mount of the same screen — or a double-pressed control — finds the link
   * already spent and sends nothing.
   */
  const spent = useRef(false);

  /**
   * Whether the address bar has already been asked to drop the token. The route's parameter does not
   * read back as absent after being cleared, so an effect gated on it would dispatch on every render
   * and loop; this admits one attempt per mount instead.
   */
  const cleared = useRef(false);

  /** Sends the token once, and drives the screen from whatever the exchange answers. */
  const runVerify = useCallback((): void => {
    if (token === '' || spent.current) return;
    spent.current = true;
    setPhase('verifying');
    setMessage(null);
    setRetryable(false);

    void (async () => {
      let consented: boolean;
      try {
        const user = await verifyToken(token);
        consented = user.consents.ageConfirmedAt !== null;
      } catch (error) {
        const failed = failureMessage(error);
        setMessage(failed);
        // Only a request that never reached the API may be repeated here: if it did reach it, the API
        // answers `401 token_invalid` and the traveler asks for a new link.
        setRetryable(isNetworkError(error));
        setPhase('error');
        // The banner's live region carries this on Android and web; this is the announcement iOS has
        // none of, so every failure is spoken exactly once (AAP 0.5.8).
        announce(failed);
        return;
      }

      router.replace(consented ? '/discover' : '/age-gate');
    })();
  }, [token]);

  /** Leaves the exchange for a fresh link, which is what a spent or unknown token needs. */
  const goToSignIn = useCallback((): void => {
    router.replace('/sign-in');
  }, []);

  /** The traveler's own second attempt after a request that never reached the API. */
  const retry = useCallback((): void => {
    spent.current = false;
    runVerify();
  }, [runVerify]);

  /** Hands the same, unspent token to the installed app, and leaves the browser path standing. */
  const openInApp = useCallback((): void => {
    void Linking.openURL(appLink(token)).catch(() => {
      // A device with nothing registered for the scheme, or a browser that refused the open: the
      // traveler continues in the browser, and no exchange has happened yet.
    });
  }, [token]);

  useEffect(() => {
    if (token === '') {
      announce(INCOMPLETE_LINK);
      return;
    }
    // A mobile browser waits for the choice; every other platform exchanges the token on arrival.
    if (mobileWeb) return;
    runVerify();
  }, [mobileWeb, runVerify, token]);

  /**
   * Drops the token from the address bar once it has been sent, and repeats the attempt on the next
   * state transition if the navigator could not yet take the routed clear. It is one completed attempt
   * per mount: what the drop answers sets the ref, so the refusal a cold load gets — where the exchange
   * starts before the root navigator has mounted, and the router then writes the launch URL, token and
   * all, into the address bar — is repeated rather than lost. A mobile browser keeps the token in its
   * URL until its traveler chooses, so the choice is left alone; there the phase change is what fires
   * this.
   *
   * The route's own parameter and the phase are the only reads here on purpose. Watching the navigator
   * mount through the router's own state would re-render this screen on every navigator update, and
   * each render pushes the `<Stack.Screen>` options below back into the navigator.
   */
  useEffect(() => {
    if (cleared.current || routeToken === undefined || phase === 'choose') return;
    cleared.current = dropTokenFromAddressBar();
  }, [phase, routeToken]);

  return (
    <Screen title={titleFor(phase)} testID="verify-screen">
      <Stack.Screen options={{ title: HEADER_TITLE }} />

      {phase === 'missing' ? (
        <Banner
          tone="error"
          message={INCOMPLETE_LINK}
          action={{ label: BACK_TO_SIGN_IN, onPress: goToSignIn, testID: 'verify-back' }}
          testID="verify-error"
        />
      ) : null}

      {phase === 'choose' ? (
        <>
          <Banner tone="info" message={CHOOSE_MESSAGE} testID="verify-choose" />
          {/* The browser exchange is the primary action, so reading and focus order reach it first;
              the hand-off to the app follows as the alternative. */}
          <Button label={CONTINUE_IN_BROWSER} onPress={runVerify} testID="verify-continue" />
          <Button
            label={OPEN_IN_APP}
            variant="secondary"
            onPress={openInApp}
            testID="verify-open-app"
          />
        </>
      ) : null}

      {phase === 'verifying' ? (
        <>
          <Banner tone="info" message={SIGNING_IN} testID="verify-status" />
          {/* The choice the traveler just made keeps its place, reported as busy, so the layout does
              not move under the pointer while the token is in flight. */}
          {mobileWeb ? (
            <Button label={CONTINUE_IN_BROWSER} busy onPress={runVerify} testID="verify-continue" />
          ) : null}
        </>
      ) : null}

      {phase === 'error' && message !== null ? (
        <>
          <Banner
            tone="error"
            message={message}
            action={{ label: BACK_TO_SIGN_IN, onPress: goToSignIn, testID: 'verify-back' }}
            testID="verify-error"
          />
          {retryable ? <Button label={TRY_AGAIN} onPress={retry} testID="verify-retry" /> : null}
        </>
      ) : null}
    </Screen>
  );
}
