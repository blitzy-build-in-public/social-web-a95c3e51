/**
 * Expo push registration on iOS and Android (AAP 0.3.4, AAP 0.5.4).
 *
 * The native half of a platform pair whose web half registers the email fallback instead. It resolves in every case — a
 * skipped build, a refusal, a failure included — because its caller fires it once the session reaches `signed_in` and
 * must never wait on it, and nothing is retried: a registration is stored once per token and re-registering that token
 * only refreshes its platform. The token is the one thing that leaves the device and it is never logged; the body is
 * exactly `{ token, platform }` of `PushTokenRequest`, and a failure logs a code alone.
 */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { PushPlatform } from '@tablemate/shared';
import { apiClient } from '../api/client';
import { isApiError } from '../api/errors';
let handlerSet = false;

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

function configuredProjectId(): string | null {
  const extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra;
  const eas = extra?.['eas'];
  if (typeof eas !== 'object' || eas === null) return null;
  const value = (eas as { projectId?: unknown }).projectId;
  return typeof value === 'string' && value !== '' ? value : null;
}

async function allowed(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

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
 * The signature both halves of the pair implement: this file on iOS and Android, `register.web.ts` on
 * the web, which registers the email fallback instead of a token.
 */
export type RegisterForNotifications = typeof registerForNotifications;
