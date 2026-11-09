/**
 * The native 3-D Secure next action of a card hold: the iOS and Android half of the platform pair `./next-action`
 * (AAP 0.3.4, AAP 0.5.3, AAP 0.5.4).
 *
 * A hold the server has created is `requires_action` until the traveller's bank authenticates it. The API answers the
 * propose and accept routes with `status: "proposed"` and the caller's own PaymentIntent client secret for exactly that
 * case, and the deposit becomes `held` — and the meetup `locked` — only when Stripe reports
 * `payment_intent.amount_capturable_updated` to the webhook (AAP 0.5.3, AAP 0.5.4).
 *
 * This file is the pair's type source, so the web half types its export against the types below, and importing
 * `@stripe/stripe-react-native` here is what keeps that split honest: the package is a native module, so no web bundle
 * and no server module may reach this file.
 *
 * The client secret is a bearer credential for the caller's own PaymentIntent: a parameter, a local and an argument for
 * the length of one call and nothing else, never in state, storage, a log line or the returned result (AAP 0.11.1). No
 * card number, expiry or CVC reaches this app either — the challenge is Stripe's own UI (AAP 0.12.2).
 */
import { CardActionError, handleNextAction } from '@stripe/stripe-react-native';

import { STRIPE_RETURN_URL, isPaymentsConfigured } from './card-setup';

/**
 * In this app's own vocabulary: `payments_unconfigured` is a build with no publishable key, where no
 * challenge can run at all (AAP 0.6.2); `authentication_failed` is the bank refusing the card or its
 * challenge, which the traveller can answer with a different card; `stripe_failed` is Stripe unable to
 * complete the challenge, or the deposit in a state the SDK cannot authenticate.
 */
export type NextActionErrorCode =
  'payments_unconfigured' | 'authentication_failed' | 'stripe_failed';

/**
 * It carries no client secret, no PaymentIntent and no Stripe message, so a screen renders a sentence of
 * this app's own for `code` (AAP 0.11.1).
 */
export type NextActionResult =
  | { status: 'succeeded' }
  | { status: 'cancelled' }
  | { status: 'failed'; code: NextActionErrorCode };

/**
 * The challenge runs inside Stripe's SDK under the `StripeProvider` that `card-setup.native.tsx`'s
 * `PaymentsProvider` mounts; where that build has no publishable key none is mounted, and the call answers
 * `payments_unconfigured` without touching Stripe.
 *
 * The result is this app's own vocabulary, and never a fact about the meetup: `succeeded` means Stripe holds
 * the authorization itself, while the meetup changes only when the API processes
 * `payment_intent.amount_capturable_updated`, so the caller refetches `GET /v1/meetups/:id` — or waits for
 * the `meetup_status` frame — and never assumes `locked`. `cancelled` and `failed` leave the attempt
 * `requires_action` or `failed`, and neither is the end of the road: the caller offers a retry through
 * `POST /v1/meetups/:id/hold` when it is the initiator or `.../accept` when it is the recipient, each
 * returning the caller's own current attempt's secret, with `MeetupDto.nextAction` naming that step for the
 * screen (`retry_hold` or `confirm_hold`) and `409 hold_pending` answering while a lost hold response is
 * recovered (AAP 0.3.4, AAP 0.5.3).
 *
 * It resolves in every case and never rejects, so a screen can render the result directly.
 */
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

/**
 * This file on iOS and Android, `next-action.web.tsx` on the web, where the Payment Element's own
 * `handleNextAction` runs instead (AAP 0.3.4). The web half holds itself to it, so a change here that it no
 * longer implements fails its typecheck rather than a call site that reads both platforms the same way.
 */
export type CompleteNextAction = typeof completeNextAction;
