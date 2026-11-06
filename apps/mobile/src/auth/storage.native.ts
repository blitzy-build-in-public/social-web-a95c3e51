/**
 * Refresh-token storage on iOS and Android (AAP 0.5.1, AAP 0.5.2, AAP 0.8.1).
 *
 * The native half of the platform pair whose contract `./session` declares: the extensionless
 * `./storage` import in that file resolves here on iOS and Android and to `storage.web.ts` on the
 * web, which keeps the same key in `localStorage`. Both halves are written as `satisfies`
 * {@link TokenStorage}, so a change to that interface fails to compile in the file that implements
 * it rather than at a call site.
 *
 * Only the refresh token is kept here. The access token lives in memory in `./session` and is never
 * persisted (AAP 0.5.2). The token is never logged, and a failure is either answered here or passed
 * to the caller that can act on it.
 */
import * as SecureStore from 'expo-secure-store';

import type { TokenStorage } from './session';

/**
 * The one entry this app keeps in secure storage, spelled identically in `storage.web.ts`.
 * SecureStore accepts keys of letters, digits, `.`, `-` and `_` only.
 */
const REFRESH_TOKEN_KEY = 'tablemate.refreshToken';

/**
 * How the entry is protected, passed to every call. It is readable once the device has been
 * unlocked after a start, so a cold start can rotate the token without waking the traveler for it,
 * and `..._THIS_DEVICE_ONLY` keeps it out of an encrypted backup restored onto another device
 * (AAP 0.5.2). Android encrypts through the Keystore and ignores `keychainAccessible`.
 *
 * `requireAuthentication` stays off: a biometric prompt on every launch would protect little,
 * since the token on its own opens nothing without the API (AAP 0.3.3).
 */
const OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
} satisfies SecureStore.SecureStoreOptions;

/**
 * `TokenStorage` over the iOS Keychain and Android's Keystore-backed encrypted store (AAP 0.5.1).
 */
export const tokenStorage = {
  /**
   * The stored refresh token, or null when there is none.
   *
   * A read the platform itself cannot complete — an entry whose Keystore key a restore or a factory
   * reset has left undecryptable, which no retry can fix — is reported as no session at all. The
   * entry is dropped best effort so the next read is clean, and the null sends the traveler to
   * sign-in rather than failing the same way at every launch (AAP 0.5.1).
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
   * Replaces the stored refresh token with the rotated one. A refused write propagates: `./session`
   * is what decides whether a session may be exposed without one, and hiding the failure here would
   * make that decision blind (AAP 0.3.3).
   */
  async setRefreshToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, OPTIONS);
  },

  /**
   * Removes the stored token, on sign-out and after `DELETE /me` (AAP 0.5.3). A refused delete
   * propagates, so the caller knows the sign-out did not finish.
   */
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS);
  },
} satisfies TokenStorage;
