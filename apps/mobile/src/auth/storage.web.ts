/**
 * Refresh-token storage in the browser: the web half of the `./storage` platform pair.
 *
 * Why `localStorage` (AAP 0.5.1): it is the one web store that survives a reload. Its cost is that any script on the
 * origin can read it, which the strict Content-Security-Policy served with the web app bounds (AAP 0.3.2,
 * `infra/nginx/web.conf`). Multi-tab: two tabs rotating at the same instant present the same token twice, which the API
 * reads as reuse and answers by revoking every session of the user (AAP 0.11.2). Where storage is unreachable the token
 * is kept in memory for the life of the tab, so sign-in works and simply does not survive a reload.
 */
import type { TokenStorage } from './session';
const REFRESH_TOKEN_KEY = 'tablemate.refreshToken';
let memoryToken: string | null = null;
/** The origin's `localStorage`, or null where it cannot be reached: no `window` at all, or a read that throws
 * `SecurityError` because the browser has blocked storage for this page. */
function localStore(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A store that cannot be read is treated as one that is not there, so blocked storage costs a reload's worth of
 * persistence and never an error; an empty stored value is treated as absent too. */
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

/** The token is remembered in memory before the write is attempted, so a store that refuses it costs the next reload
 * alone: this tab keeps working with the token it was just given. */
function setRefreshToken(token: string): Promise<void> {
  memoryToken = token;
  try {
    localStore()?.setItem(REFRESH_TOKEN_KEY, token);
  } catch {}
  return Promise.resolve();
}

/** Memory is cleared first and the store afterwards, so a store that cannot be reached leaves this tab signed out in
 * any case. */
function clear(): Promise<void> {
  memoryToken = null;
  try {
    localStore()?.removeItem(REFRESH_TOKEN_KEY);
  } catch {}
  return Promise.resolve();
}

/** The web half of the platform pair, reached by `./session` as `tokenStorage`. Every member returns an
 * already-resolved promise, because a body without an `await` in it is what keeps the interface's own promise type. */
export const tokenStorage = {
  getRefreshToken,
  setRefreshToken,
  clear,
} satisfies TokenStorage;
