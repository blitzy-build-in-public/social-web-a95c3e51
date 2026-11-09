/**
 * The native 3-D Secure next action of a card hold: the iOS and Android half of the platform pair `./next-action`
 * (AAP 0.3.4, AAP 0.5.3, AAP 0.5.4).
 *
 * A hold the server has created is `requires_action` until the traveller's bank authenticates it. The API answers the
 * propose and accept routes with the caller's own PaymentIntent client secret for exactly that case, and the deposit
 * becomes `held` — and the meetup `locked` — only when Stripe reports `payment_intent.amount_capturable_updated` to the
 * webhook.
 * This file is the pair's type source, and importing `@stripe/stripe-react-native` here is what keeps that split honest:
 * the package is a native module, so no web bundle and no server module may reach this file. The client secret is a
 * bearer credential for the caller's own PaymentIntent: a parameter, a local and an argument for the length of one call
 * and nothing else, never in state, storage, a log line or the returned result. No card number, expiry or CVC reaches
 * this app either — the challenge is Stripe's own UI.
 */
import { CardActionError, handleNextAction } from '@stripe/stripe-react-native';
import { STRIPE_RETURN_URL, isPaymentsConfigured } from './card-setup';

export type NextActionErrorCode =
  'payments_unconfigured' | 'authentication_failed' | 'stripe_failed';

export type NextActionResult =
  | { status: 'succeeded' }
  | { status: 'cancelled' }
  | { status: 'failed'; code: NextActionErrorCode };

export async function completeNextAction(clientSecret: string): Promise<NextActionResult> {
  if (!isPaymentsConfigured()) return { status: 'failed', code: 'payments_unconfigured' };
  try {
    // The return URL is the one `app.config.ts`'s `tablemate` scheme serves, so a bank that
    // redirects out of the app comes back to it (AAP 0.3.4).
    const { error } = await handleNextAction(clientSecret, STRIPE_RETURN_URL);
    if (error === undefined) return { status: 'succeeded' };
    // Abandoning the challenge is the traveller changing their mind rather than a failure, so it
    // shows no error and the screen offers the retry above.
    if (error.code === CardActionError.Canceled) return { status: 'cancelled' };
    // The SDK's word for a declined authentication: the bank or the card refused the hold.
    if (error.code === CardActionError.Failed) {
      return { status: 'failed', code: 'authentication_failed' };
    }
    // `Unknown` is the SDK unable to classify the failure. A PaymentIntent the server confirmed
    // without delegating the next action to this SDK lands here too, so an unexpected state points
    // at `apps/api/src/modules/payments/stripe-gateway.ts` rather than at the card.
    return { status: 'failed', code: 'stripe_failed' };
  } catch {
    // `handleNextAction` resolves an error result rather than rejecting; a rejection here is a
    // native failure it reported no other way, which reads to the traveller as Stripe's failure.
    return { status: 'failed', code: 'stripe_failed' };
  }
}

export type CompleteNextAction = typeof completeNextAction;
