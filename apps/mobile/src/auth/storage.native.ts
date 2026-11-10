/**
 * Refresh-token storage on iOS and Android: the native half of the platform pair whose contract `./session` declares,
 * kept in the device keystore through `expo-secure-store`. Only the refresh token is kept, and never logged.
 */
import * as SecureStore from 'expo-secure-store';
import type { TokenStorage } from './session';
/** The one entry kept in secure storage, spelled identically in `storage.web.ts`. SecureStore accepts keys of letters,
 * digits, `.`, `-` and `_` only. */
const REFRESH_TOKEN_KEY = 'tablemate.refreshToken';
/** How the entry is protected: readable once the device has been unlocked after a start, so a cold start can rotate the
 * token without waking the traveler, and `..._THIS_DEVICE_ONLY` keeps it out of a restored backup. */
const OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
} satisfies SecureStore.SecureStoreOptions;
export const tokenStorage = {
  /** A read the platform cannot complete — an entry whose Keystore key a restore or a factory reset left
   * undecryptable — is reported as no session at all. */
  async getRefreshToken(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY, OPTIONS);
    } catch {
      await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS).catch(() => undefined);
      return null;
    }
  },
  /** A refused write propagates: `./session` decides whether a session may be exposed without one. */
  async setRefreshToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, OPTIONS);
  },
  /** Removes the stored token on sign-out and after `DELETE /me`; a refused delete propagates. */
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS);
  },
} satisfies TokenStorage;
