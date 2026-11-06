/**
 * Expo Router's native-intent hook for the traveler app: where a URL the operating system delivers
 * is answered before the router navigates on it (AAP 0.3.4, AAP 0.5.1, AAP 0.5.5).
 *
 * Expo Router 4 finds this file by name — `./+native-intent.tsx` among the route context's keys —
 * and reads `redirectSystemPath` off the module itself, so the function is a named export and this
 * file is not a route: the route tree skips it by name, and the web route context excludes it, which
 * is why the native module imported below never reaches a browser bundle (Expo Router's own
 * `_ctx.web.js` context carries the exclusion). The function is called for the URL the app was
 * launched with and for every URL event afterwards, and its answer is the URL the router works from.
 *
 * A falsy answer leaves the router where it is. Expo Router's own `if (url && …)` guards the
 * incoming URL rather than the answer, so the guarantee is not there: the subscription hands the
 * answer to React Navigation's listener, whose `getStateFromURL` returns early for a falsy URL and
 * dispatches nothing. For a launch URL the answer becomes the app's initial state, and a falsy one
 * leaves that state unset, so the app starts on its own root route.
 *
 * Three of the four kinds of URL that arrive here are rewritten, because none of them names a route
 * and the router would answer each with its not-found screen, abandoning the import the traveller
 * asked for (AAP 0.3.4, AAP 0.5.5):
 *
 *   - the share extension's marker, `tablemate://dataUrl=<key>#…`, which is how the iOS share
 *     extension hands files over. The key is the library's own; `ShareIntentProvider` in
 *     `app/_layout.tsx` reads the files it stands for and replaces the route with the file's `uri`
 *     in the same turn, so the marker itself needs no parameters of its own;
 *   - an iOS "Open in" from Mail or Files, delivered as `file:///…/Documents/Inbox/<name>.eml`.
 *     `app.config.ts` sets `LSSupportsOpeningDocumentsInPlace` to false, so what arrives is a copy
 *     the app owns and the `.eml` intake deletes after every attempt;
 *   - an Android view intent, delivered as `content://…`, which is the traveller's own file: the
 *     intake never deletes or modifies it.
 *
 * The fourth is dropped rather than rewritten: the Stripe return of `STRIPE_RETURN_URL`. A
 * redirect-based 3-D Secure step sends the traveller to their bank and Stripe hands the app back
 * through the `tablemate` scheme, at which point the screen that started the flow is still the one
 * underneath; a path no route file owns would replace it with the not-found screen and lose the
 * deposit step that was running (AAP 0.3.4). A launch URL and a URL event get the same answer, so
 * the `initial` flag is not read.
 *
 * Every other URL is returned unchanged, so the router sees exactly what it saw before this file
 * existed: the magic link `tablemate://auth/verify`, the benchmark deep link
 * `tablemate://dev/zk-bench`, and every ordinary route (AAP 0.5.8).
 *
 * Nothing here logs: not the URL, not its path, and not the query or fragment Stripe may append to
 * it, because a delivered URI is not a value this app may put in a console, a logger or an error
 * message (AAP 0.5.5, AAP 0.11.1).
 */
import { getShareExtensionKey } from 'expo-share-intent';

import { STRIPE_RETURN_URL } from '../src/payments/card-setup';

/** The screen an `.eml` is handed to, which reads the file from its `uri` parameter (AAP 0.5.8). */
const SHARE_IMPORT_ROUTE = '/proof/import';

/**
 * The answer for a URL this hook cannot process at all. The app's root is the one path the root
 * layout's own gate sends on by session, so an unexpected failure still lands somewhere usable.
 */
const ROOT_PATH = '/';

/**
 * The schemes a shared or opened file arrives with: `file://` for the copy iOS makes, `content://`
 * for the URI an Android view intent names. Compared against the URL's prefix alone.
 */
const FILE_URL_SCHEMES = ['file://', 'content://'] as const;

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
 * Whether a delivered URL names a file the platform handed over rather than a route to navigate to.
 *
 * Only the prefix is lowercased: a URL scheme is case-insensitive (RFC 3986), and lowercasing the
 * whole URL would copy the share extension's fragment, which carries the shared file's bytes.
 */
function isLocalFileUrl(url: string): boolean {
  const prefix = url.slice(0, FILE_URL_SCHEMES[1].length).toLowerCase();
  return FILE_URL_SCHEMES.some((scheme) => prefix.startsWith(scheme));
}

/**
 * Answers the URL Expo Router is about to navigate on: the proof import screen for an `.eml` the
 * share extension, an iOS "Open in" or an Android view intent delivered, null for the Stripe return
 * of `STRIPE_RETURN_URL`, and the URL unchanged for every other one.
 *
 * The share marker is the one the library's own hook looks for, so the two agree on which URL event
 * carries files. The file test is on the URL's prefix, and the import screen is given the whole URL
 * as an encoded `uri` parameter: a file name may hold a space or a non-ASCII character, and the
 * query is where a URL's own `?`, `&` and `#` would otherwise end the parameter early.
 *
 * The Stripe comparison is on the URL's path alone, so every form the operating system can deliver
 * is covered — `tablemate://stripe-redirect`, the same path with a trailing `/`, and either with the
 * query or fragment Stripe appends — and it is an equality rather than a suffix match, so a URL
 * whose path merely ends in `stripe-redirect`, such as `tablemate://meetups/stripe-redirect`, is
 * still navigated to.
 *
 * `null` is the answer the pinned expo-router 4.0.22 honours. Its own
 * `NativeIntent['redirectSystemPath']` type spells the result as `string` alone, while
 * `getLinkingConfig` assigns the return value to the initial URL and `link/linking` hands the same
 * value to the subscription listener, whose `getStateFromURL` returns early for a falsy URL: nothing
 * is dispatched, and the screen that started the flow stays on top.
 *
 * @param event - What Expo Router delivers, whose `path` is the URL itself.
 * @returns The route a shared or opened file belongs on, `null` for the Stripe return URL, or
 *   `path` unchanged.
 */
export function redirectSystemPath({ path }: { path: string }): string | null {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return SHARE_IMPORT_ROUTE;
    if (isLocalFileUrl(path)) return `${SHARE_IMPORT_ROUTE}?uri=${encodeURIComponent(path)}`;
    return withoutTrailingSlash(pathOf(path)) === STRIPE_RETURN_PATH ? null : path;
  } catch {
    // Throwing here would reach Expo Router's subscription as an unhandled rejection, and the
    // traveller would be left on the not-found screen a URL no route owns renders.
    return ROOT_PATH;
  }
}
