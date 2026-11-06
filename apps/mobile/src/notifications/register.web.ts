/**
 * Notification registration on the web (AAP 0.3.4, AAP 0.5.4, AAP 0.8.1).
 *
 * The web half of a platform pair: Metro resolves the call site's extensionless `./register` to
 * `register.native.ts` on iOS and Android, where a notification arrives as Expo push, and to this
 * file everywhere else, where it arrives by email from the workers' SMTP sender
 * (`apps/workers/src/notify/email.ts`) instead -- the whole of the web's delivery (AAP 0.3.4).
 *
 * The web has no push service, no service worker and no browser Notification API, so there is no
 * device token to obtain and nothing to post to `POST /v1/me/push-tokens` (AAP 0.5.4): this is a
 * no-op that resolves at once, with no request, no storage write and no other side effect. It
 * exists so that import resolves on every platform and reads the same from all of them; nothing
 * awaits it for a result (AAP 0.3.2).
 *
 * The one import is a type, so `verbatimModuleSyntax` erases it (AAP 0.11.1): no `expo-notifications`
 * and no native code reaches the web bundle.
 */
import type { RegisterForNotifications } from './register.native';

export type { RegisterForNotifications } from './register.native';

/**
 * The web implementation of the pair's one export. It resolves immediately and does nothing, since
 * email from the workers' sender is the only notification channel the web has (AAP 0.3.4).
 *
 * The `satisfies` clause holds the two halves together at compile time: a change to the native
 * signature that this file no longer implements fails the build here, rather than at a call site
 * that reads both platforms the same way.
 */
export const registerForNotifications = (() =>
  Promise.resolve()) satisfies RegisterForNotifications;
