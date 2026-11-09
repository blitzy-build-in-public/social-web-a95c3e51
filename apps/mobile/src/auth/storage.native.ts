/**
 * Refresh-token storage on iOS and Android: the native half of the platform pair whose contract `./session` declares,
 * kept in the device keystore through `expo-secure-store`. Both halves are written as `satisfies`
 * {@link TokenStorage}, so a change to that interface fails to compile in the file that implements it.
 *
 * Only the refresh token is kept here: the access token lives in memory in `./session` and is never persisted
 * (AAP 0.5.2), and the token is never logged.
 */
import * as SecureStore from 'expo-secure-store';

import type { TokenStorage } from './session';

/**
 * The one entry kept in secure storage, spelled identically in `storage.web.ts`. SecureStore accepts
 * keys of letters, digits, `.`, `-` and `_` only.
 */
const REFRESH_TOKEN_KEY = 'tablemate.refreshToken';

/**
 * How the entry is protected. It is readable once the device has been unlocked after a start, so a
 * cold start can rotate the token without waking the traveler, and `..._THIS_DEVICE_ONLY` keeps it
 * out of an encrypted backup restored onto another device (AAP 0.5.2). `requireAuthentication` stays
 * off: a biometric prompt would protect little, since the token alone opens nothing without the API.
 */
const OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
} satisfies SecureStore.SecureStoreOptions;

/**
 * `TokenStorage` over the iOS Keychain and Android's Keystore-backed encrypted store (AAP 0.5.1).
 */
export const tokenStorage = {
  /**
   * A read the platform cannot complete — an entry whose Keystore key a restore or a factory reset
   * has left undecryptable, which no retry can fix — is reported as no session at all, the entry
   * dropped best effort so the next read is clean (AAP 0.5.1).
   */
  async getRefreshToken(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY, OPTIONS);
    } catch {
      await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS).catch(() => undefined);
      return null;
    }
  },
  /**
   * A refused write propagates: `./session` decides whether a session may be exposed without one.
   */
  async setRefreshToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, OPTIONS);
  },
  /**
   * Removes the stored token, on sign-out and after `DELETE /me` (AAP 0.5.3); a refused delete
   * propagates, so the caller knows the sign-out did not finish.
   */
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS);
  },
} satisfies TokenStorage;
