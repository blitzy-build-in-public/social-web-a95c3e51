/**
 * Refresh-token storage in the browser: the web half of the `./storage` platform pair, which `moduleSuffixes` does not
 * otherwise hold to the `TokenStorage` interface it must honour.
 *
 * Why `localStorage` (AAP 0.5.1): it is the one web store that survives a reload, which is what makes the web client
 * hold its capabilities across sessions as the native app does. Its cost is that any script on the origin can read it,
 * which the strict Content-Security-Policy served with the web app bounds (AAP 0.3.2, `infra/nginx/web.conf`).
 *
 * Multi-tab: the store is shared, so two tabs rotating at the same instant present the same token twice, which the API
 * reads as reuse and answers by revoking every session of the user (AAP 0.11.2); that caveat is not recoverable from
 * here. Fallback: where storage is unreachable or refuses the write, the token is kept in this module's memory for the
 * life of the tab, so sign-in works and simply does not survive a reload. The access token never leaves `./session`'s
 * memory (AAP 0.5.2) and nothing here is logged (AAP 0.11.1).
 */
import type { TokenStorage } from './session';

/**
 * The key the refresh token is stored under; `storage.native.ts` uses the same one (AAP 0.3.3).
 */
const REFRESH_TOKEN_KEY = 'tablemate.refreshToken';

/** The in-memory fallback: what answers once the store is unavailable or refused the write. */
let memoryToken: string | null = null;

/**
 * The origin's `localStorage`, or null where it cannot be reached: no `window` at all, or a read that
 * throws `SecurityError` because the browser has blocked storage for this page.
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
 * A store that cannot be read is treated as one that is not there, so blocked storage costs a
 * reload's worth of persistence and never an error. An empty stored value is treated as absent too,
 * so a blanked key cannot become a rotation carrying no token.
 *
 * A store holding no entry is not taken as evidence that this tab holds no token: one that refused
 * the write holds none either, and the memory fallback is what keeps this tab signed in. A token
 * another tab's sign-out removed is then still offered once and refused as revoked, so the end state
 * is the signed-out one either way.
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
 * The token is remembered in memory before the write is attempted, so a store that refuses it costs
 * the next reload alone: this tab keeps working with the token it was just given.
 */
function setRefreshToken(token: string): Promise<void> {
  memoryToken = token;
  try {
    localStore()?.setItem(REFRESH_TOKEN_KEY, token);
  } catch {
    // A refused write (`QuotaExceededError`, `SecurityError`) is not something the traveler can act
    // on, and the fallback above covers it.
  }
  return Promise.resolve();
}

/**
 * Memory is cleared first and the store afterwards, so a store that cannot be reached leaves this tab
 * signed out in any case; `./session` retries the removal through its own storage guard.
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
 * The web half of the platform pair, reached by `./session` as `tokenStorage` (AAP 0.5.1). Every
 * member is a plain function returning an already-resolved promise: a body with no `await` in it is
 * what `@typescript-eslint/require-await` rejects.
 */
export const tokenStorage = {
  getRefreshToken,
  setRefreshToken,
  clear,
} satisfies TokenStorage;
