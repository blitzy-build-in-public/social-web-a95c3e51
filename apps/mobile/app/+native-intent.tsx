/**
 * Expo Router's native-intent hook for the traveler app: where a URL the operating system delivers
 * is answered before the router navigates on it (AAP 0.3.4, AAP 0.5.1).
 *
 * Expo Router 4 finds this file by name — `./+native-intent.tsx` among the route context's keys —
 * and calls {@link redirectSystemPath} for the URL the app was launched with and for every URL
 * event afterwards. Its answer is the URL the router works from, and a falsy answer leaves the
 * router where it is: the launch URL resolves to no state, so the app starts at its root route, and
 * a later URL dispatches no navigation at all.
 *
 * One URL is dropped here, the Stripe return of `STRIPE_RETURN_URL`. A redirect-based 3-D Secure
 * step sends the traveller to their bank and Stripe hands the app back through the `tablemate`
 * scheme, at which point the screen that started the flow is still the one underneath; a path no
 * route file owns would replace it with the not-found screen and lose the deposit step that was
 * running (AAP 0.3.4). Every other URL is returned unchanged, so the router sees exactly what it
 * saw before this file existed: the magic link `tablemate://auth/verify`, the benchmark deep link
 * `tablemate://dev/zk-bench`, and every ordinary route (AAP 0.5.8).
 *
 * Nothing here logs: not the URL, not its path, and not the query or fragment Stripe may append to
 * it, because a delivered URI is not a value this app may put in a console, a logger or an error
 * message (AAP 0.5.5, AAP 0.11.1).
 */
import { STRIPE_RETURN_URL } from '../src/payments/card-setup';

/**
 * The path of a URL as the operating system delivers it: everything after the scheme's `://`, with
 * any query and fragment removed and a leading `/` given to a URL that has none.
 *
 * The URL is read as text rather than through `new URL`, because React Native's `URL` is a partial
 * implementation and this module runs under Hermes as well as in a browser.
 */
function pathOf(url: string): string {
  const schemeSeparator = url.indexOf('://');
  const afterScheme = schemeSeparator === -1 ? url : url.slice(schemeSeparator + '://'.length);
  const queryOrFragment = afterScheme.search(/[?#]/);
  const path = queryOrFragment === -1 ? afterScheme : afterScheme.slice(0, queryOrFragment);
  return path.startsWith('/') ? path : `/${path}`;
}

/** The same path with one trailing `/` removed, so `/stripe-redirect/` reads as `/stripe-redirect`. */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** The path the check below compares a delivered URL against, taken from the return URL itself. */
const STRIPE_RETURN_PATH = withoutTrailingSlash(pathOf(STRIPE_RETURN_URL));

/**
 * Answers the URL Expo Router is about to navigate on: null for the Stripe return of
 * `STRIPE_RETURN_URL`, and the URL unchanged for every other one.
 *
 * The comparison is on the URL's path alone, so every form the operating system can deliver is
 * covered — `tablemate://stripe-redirect`, the same path with a trailing `/`, and either with the
 * query or fragment Stripe appends — and it is an equality rather than a suffix match, so a URL
 * whose path merely ends in `stripe-redirect`, such as `tablemate://meetups/stripe-redirect`, is
 * still navigated to.
 *
 * `null` is the answer the pinned expo-router 4.0.22 honours. Its own
 * `NativeIntent['redirectSystemPath']` type spells the result as `string` alone, while
 * `getLinkingConfig` assigns the return value to the initial URL and `link/linking` hands the same
 * value to the subscription listener, whose `getStateFromURL` returns early for a falsy URL: nothing
 * is dispatched, and the screen that started the flow stays on top. The `initial` flag is not read,
 * because this answer is the same whichever URL brought the app here.
 *
 * @param event - What Expo Router delivers, whose `path` is the URL itself.
 * @returns `null` for the Stripe return URL, or `path` unchanged.
 */
export function redirectSystemPath({ path }: { path: string }): string | null {
  return withoutTrailingSlash(pathOf(path)) === STRIPE_RETURN_PATH ? null : path;
}
