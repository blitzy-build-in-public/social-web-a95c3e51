/**
 * Notification registration on the web (AAP 0.3.4, AAP 0.5.4, AAP 0.8.1).
 *
 * The web half of a platform pair whose native half registers an Expo push token. The web has no push service, no
 * service worker and no browser Notification API, so there is no device token to obtain and nothing to post to
 * `POST /v1/me/push-tokens` (AAP 0.5.4): a no-op with no request, no storage write and no other side effect, which
 * exists so that import resolves on every platform. The one import is a type, so `verbatimModuleSyntax` erases it
 * (AAP 0.11.1): no native code reaches the web bundle.
 */
import type { RegisterForNotifications } from './register.native';

export type { RegisterForNotifications } from './register.native';

/**
 * Resolves immediately and does nothing, since email from the workers' sender is the only notification
 * channel the web has (AAP 0.3.4). The `satisfies` clause holds the two halves together at compile
 * time, rather than at a call site that reads both platforms the same way.
 */
export const registerForNotifications = (() =>
  Promise.resolve()) satisfies RegisterForNotifications;
