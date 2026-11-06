/**
 * Expo push registration on iOS and Android (AAP 0.3.4, AAP 0.5.4, AAP 0.8.1).
 *
 * The native half of a platform pair: Metro resolves `./register` to this file on iOS and Android
 * and to `register.web.ts` on the web, where a notification arrives by email instead
 * (`apps/workers/src/notify/email.ts`). The web half checks itself against
 * {@link RegisterForNotifications}.
 *
 * It resolves in every case — a skipped build, a refusal, a failure included — because its caller
 * fires it once the session reaches `signed_in` and must never wait on it (AAP 0.3.2). Nothing is
 * retried either: the API upserts by token, so the next app start is the retry. The token is the
 * one thing that leaves the device and it is never logged; the body is exactly
 * `{ token, platform }` of `PushTokenRequest`, and a failure logs a code alone.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { PushPlatform } from '@tablemate/shared';

import { apiClient } from '../api/client';
import { isApiError } from '../api/errors';

/**
 * Whether the foreground handler is installed. `setNotificationHandler` replaces whatever handler
 * was there, and registration runs after every sign-in and app start.
 */
let handlerSet = false;

/**
 * `Platform.OS` as the contract's `PushPlatform`, or null on a platform that holds no push token.
 *
 * Spelled out rather than cast, so a change to either value set fails to compile here instead of
 * reaching the API as a value it answers `400 invalid_field` for (AAP 0.5.4).
 */
function pushPlatform(): PushPlatform | null {
  switch (Platform.OS) {
    case 'ios':
      return 'ios';
    case 'android':
      return 'android';
    default:
      return null;
  }
}

/**
 * The EAS project id `app.config.ts` writes into `extra.eas.projectId` from `EAS_PROJECT_ID`, or
 * null when the build set none. `extra` is an open record of build-time values, so it is narrowed
 * by hand rather than trusted.
 */
function configuredProjectId(): string | null {
  const extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra;
  const eas = extra?.['eas'];
  if (typeof eas !== 'object' || eas === null) return null;
  const value = (eas as { projectId?: unknown }).projectId;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Whether the app may show notifications, asking the user once while the answer is not already yes.
 * A refusal resolves `false` rather than throwing: the app works without push, and native has no
 * email fallback (AAP 0.3.4).
 */
async function allowed(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/**
 * Registers this device's Expo push token with the API, so `apps/workers/src/notify/push.ts` can
 * reach it for a proposal, a lock, a check-in or a settlement (AAP 0.3.4, AAP 0.5.6).
 *
 * The app root calls this once a session is established. It returns quietly when the device can
 * hold no token (a simulator or an emulator, which is also the path the Maestro flows take), when
 * the platform is neither iOS nor Android, when the build set no `EAS_PROJECT_ID`, and when the
 * user refuses notifications: none of those is an error.
 *
 * @returns A promise that always resolves, whether the device was registered or skipped.
 */
export async function registerForNotifications(): Promise<void> {
  try {
    if (!handlerSet) {
      Notifications.setNotificationHandler({
        handleNotification: () =>
          Promise.resolve({
            shouldShowAlert: true,
            shouldPlaySound: false,
            shouldSetBadge: false,
          }),
      });
      handlerSet = true;
    }

    // A simulator or an emulator has no push service, so it can never be issued a token: reading
    // the permission there would prompt for nothing.
    if (!Device.isDevice) return;

    const platform = pushPlatform();
    if (platform === null) return;

    const projectId = configuredProjectId();
    if (projectId === null) return;

    // The channel comes before the permission request because Android 13 shows the notification
    // prompt only once the app owns a channel (AAP 0.3.4).
    if (platform === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    if (!(await allowed())) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await apiClient.registerPushToken({ token, platform });
  } catch (err) {
    // Swallowed deliberately: nothing awaits this for its result, and the record is a code alone,
    // never the token, the project id, the user or the server's own message (AAP 0.11.1).
    console.warn('push_registration_failed', isApiError(err) ? err.code : 'unknown_error');
  }
}

/**
 * The signature both halves of the platform pair implement: this file on iOS and Android,
 * `register.web.ts` on the web, which registers the email fallback instead of a token.
 */
export type RegisterForNotifications = typeof registerForNotifications;
