/**
 * Refresh-token storage in the browser (AAP 0.3.3, AAP 0.5.1, AAP 0.8.1).
 *
 * The web half of the `./storage` platform pair: Metro resolves `./session`'s extensionless
 * `./storage` to this file on the web and to `storage.native.ts` on iOS and Android, where the token
 * goes to the device keystore through `expo-secure-store`. Both halves implement `TokenStorage`,
 * which `./session` declares; the `satisfies` clause at the foot of this file is the only
 * compile-time check of that contract, because `moduleSuffixes` type-checks the extensionless import
 * against the native half alone, so this file is not otherwise held to the interface it must honour.
 *
 * Only the refresh token is kept here. The access token never leaves `./session`'s memory
 * (AAP 0.5.2), and nothing in this module logs anything at all, not a token and no error detail
 * (AAP 0.11.1).
 *
 * Why `localStorage` (AAP 0.5.1): it is the one store on the web that survives a reload, which is
 * what makes the web client hold its capabilities across sessions as the native app does. Its cost
 * is that any script running on the origin can read what it holds, which the strict
 * Content-Security-Policy served with the web app is there to bound (AAP 0.3.2, `infra/nginx/web.conf`).
 *
 * Multi-tab: `localStorage` is shared by every tab of the origin, which is what lets a reload in any
 * tab restore the session, and why `./session` reads the token at the moment of use rather than
 * caching it. Two tabs rotating at the same instant still present the same token twice, which the
 * API reads as reuse and answers by revoking every session of the user (AAP 0.11.2): both tabs then
 * end up signed out, and the traveler signs in again with a fresh link. That caveat is not
 * recoverable from here, because these two tabs are the same storage and the same origin.
 *
 * Fallback: where storage is unreachable or refuses the write — a blocked cookie policy, a
 * sandboxed frame, a full quota, private browsing on a browser that throws only on write — the token
 * is kept in this module's memory for the life of the tab. Sign-in then works exactly as it does
 * otherwise and simply does not survive a reload.
 */
import type { TokenStorage } from './session';

/**
 * The key the refresh token is stored under. `storage.native.ts` uses the same one, so the two
 * halves of the pair are interchangeable to anything reading them (AAP 0.3.3).
 */
const REFRESH_TOKEN_KEY = 'tablemate.refreshToken';

/**
 * The token held in memory, which is what answers once the platform store is unavailable or has
 * refused a write. Null until this tab's first write, and null again as soon as it clears the token.
 */
let memoryToken: string | null = null;

/**
 * The origin's `localStorage`, or null where it cannot be reached: no `window` at all — server-side
 * rendering, a bundler evaluation, a test process — or a read that throws `SecurityError` because the
 * browser has blocked storage for this page (a blocked cookie policy, a sandboxed frame).
 */
function localStore(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The stored refresh token, the in-memory fallback, or null when the traveler is signed out.
 *
 * A store that cannot be read is treated as one that is not there, so storage being blocked costs a
 * reload's worth of persistence and never an error. An empty stored value is treated as absent, so a
 * blanked key cannot become a rotation carrying no token, which the API would answer with something
 * other than a refusal and leave the caller retrying a session that is really over.
 *
 * A store holding no entry is not taken as evidence that this tab holds no token: a store that
 * refused the write holds none either, and the memory fallback is what keeps this tab signed in. A
 * token another tab's sign-out removed is then still offered once, which the API refuses as revoked,
 * so the end state is the signed-out one either way.
 *
 * @returns The refresh token to rotate with, or null when there is none.
 */
function getRefreshToken(): Promise<string | null> {
  const store = localStore();
  if (store === null) return Promise.resolve(memoryToken);

  try {
    const stored = store.getItem(REFRESH_TOKEN_KEY);
    return Promise.resolve(stored !== null && stored.length > 0 ? stored : memoryToken);
  } catch {
    return Promise.resolve(memoryToken);
  }
}

/**
 * Replaces the stored refresh token with the rotated one (AAP 0.3.3).
 *
 * The token is remembered in memory before the write is attempted, so a store that refuses it costs
 * the next reload alone: this tab keeps working with the token it was just given.
 *
 * @param token - The refresh token `./session` has just received.
 */
function setRefreshToken(token: string): Promise<void> {
  memoryToken = token;
  try {
    localStore()?.setItem(REFRESH_TOKEN_KEY, token);
  } catch {
    // A refused write — `QuotaExceededError` under a full quota, `SecurityError` under a blocked
    // storage policy — is not something the traveler can act on, and the fallback above covers it.
  }
  return Promise.resolve();
}

/**
 * Removes the stored token, which is what ends a session that outlived the tab (AAP 0.3.3).
 *
 * Memory is cleared first and the store afterwards, so a store that cannot be reached leaves this
 * tab signed out in any case; `./session` retries the removal through its own storage guard.
 */
function clear(): Promise<void> {
  memoryToken = null;
  try {
    localStore()?.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Nothing to undo: a store this call cannot reach is a store that accepts no write either.
  }
  return Promise.resolve();
}

/**
 * The web half of the platform pair, reached by `./session` as `tokenStorage` (AAP 0.5.1). The
 * `satisfies` clause is what holds it to `TokenStorage`, so a change to the interface fails the build
 * here rather than at the call site that reads both platforms the same way.
 *
 * Every member is written as a plain function returning an already-resolved promise, rather than as
 * an `async` one: a body with no `await` in it is what `@typescript-eslint/require-await` rejects, and
 * none of the three has asynchronous work of its own to wait on.
 */
export const tokenStorage = {
  getRefreshToken,
  setRefreshToken,
  clear,
} satisfies TokenStorage;
