/**
 * The web 3-D Secure next action of a card hold: the browser half of the platform pair
 * `./next-action` (AAP 0.3.4, AAP 0.5.3, AAP 0.5.4, AAP 0.8.1).
 *
 * A hold the API has created is `requires_action` until the traveller's bank authenticates it:
 * `POST /v1/meetups` and `POST /v1/meetups/:id/accept` answer `status: "proposed"` with the caller's
 * own PaymentIntent client secret for exactly that case, and the deposit becomes `held` — and the
 * meetup `locked` — only once the API processes `payment_intent.amount_capturable_updated`
 * (AAP 0.5.3, AAP 0.5.4). This file runs the challenge that closes the gap, inside Stripe's own
 * iframe and through the Stripe.js instance `./card-setup.web` already loaded: it never loads
 * Stripe.js itself, and a build with no publishable key never reaches Stripe from here at all
 * (AAP 0.6.2, 0.11.2).
 *
 * Metro resolves a call site's extensionless `./next-action` to `next-action.native.tsx` on iOS and
 * Android and to this file on the web, while `moduleSuffixes [".native", ""]` makes the typecheck
 * read it the native way. So the native half is imported type-only — erased under
 * `verbatimModuleSyntax`, which keeps that module and `@stripe/stripe-react-native` out of the web
 * bundle — and its export is what holds this one to the pair's signature. `./card-setup.web` is
 * spelled out for the opposite reason: an extensionless `./card-setup` type-checks against the
 * native half, which has no `getStripe`.
 *
 * The client secret is a bearer credential for the caller's own PaymentIntent. It is a parameter, a
 * local and an argument for the length of one call and nothing else: never in state, storage, a log
 * line or the returned result (AAP 0.11.1). No card number, expiry or CVC reaches this app either,
 * and the challenge's frames need `https://js.stripe.com` and `https://hooks.stripe.com` in the web
 * app's Content-Security-Policy (`infra/nginx/web.conf`).
 */
import { getStripe } from './card-setup.web';

import type * as Native from './next-action.native';

/* The types a screen may name are the native half's, re-exported rather than restated, so the two
 * halves of the pair cannot drift apart (AAP 0.5.1). */
export type { NextActionErrorCode, NextActionResult } from './next-action.native';

/**
 * Runs the 3-D Secure challenge a card hold is waiting on, so Stripe can take its authorization to
 * `requires_capture` (AAP 0.3.4, AAP 0.5.3).
 *
 * The web has no distinct cancel signal: Stripe.js reports a challenge the traveller abandoned as
 * the same authentication failure as one their bank refused, so this half never returns `cancelled`,
 * and a screen offers a retry for `authentication_failed` instead of treating it as a change of
 * mind.
 *
 * The result is this app's own vocabulary, and it is never a fact about the meetup:
 *
 * - `succeeded` means Stripe holds the authorization itself (`requires_capture`). The meetup still
 *   changes only when the API processes `payment_intent.amount_capturable_updated`, so the caller
 *   refetches `GET /v1/meetups/:id` — or waits for the `meetup_status` frame — and never assumes
 *   `locked`.
 * - `authentication_failed` and `stripe_failed` leave the attempt `requires_action` or `failed`.
 *   Neither is the end of the road: the caller offers a retry through `POST /v1/meetups/:id/hold`
 *   when it is the initiator or `POST /v1/meetups/:id/accept` when it is the recipient, and each of
 *   those returns the caller's own current attempt's secret. `MeetupDto.nextAction` names that step
 *   for the screen — `retry_hold` or `confirm_hold` — and while a lost hold response is being
 *   recovered the route answers `409 hold_pending` instead, with the hold shown as `pending`.
 *
 * A `stripe_failed` on an attempt the server confirmed without delegating the next action to
 * Stripe.js points at `apps/api/src/modules/payments/stripe-gateway.ts` (`use_stripe_sdk: true`)
 * rather than at the card.
 *
 * It resolves in every case and never rejects, so a screen can render the result directly.
 *
 * @param clientSecret - The current attempt's PaymentIntent client secret from the API's propose,
 * accept or hold response. Never logged, never stored.
 * @returns The attempt's outcome: `succeeded`, or a failure code. Never `cancelled`.
 */
export const completeNextAction: typeof Native.completeNextAction = async (clientSecret) => {
  const pending = getStripe();
  // No publishable key: this build has no Stripe.js to challenge with (AAP 0.6.2, 0.11.2).
  if (pending === null) return { status: 'failed', code: 'payments_unconfigured' };

  try {
    const stripe = await pending;
    // Stripe.js itself could not load — an offline page, or a policy that blocks js.stripe.com.
    if (stripe === null) return { status: 'failed', code: 'stripe_failed' };

    const { error } = await stripe.handleNextAction({ clientSecret });
    if (error === undefined) return { status: 'succeeded' };
    // Stripe's word for a challenge the bank refused, or that the bank's page never completed.
    if (error.code === 'payment_intent_authentication_failure') {
      return { status: 'failed', code: 'authentication_failed' };
    }
    // Every other failure — an intent in a state Stripe.js cannot authenticate, a network error —
    // is Stripe's rather than the card's, so the traveller is offered the retry above.
    return { status: 'failed', code: 'stripe_failed' };
  } catch {
    // `handleNextAction` resolves an error result rather than rejecting; a rejection here is a
    // Stripe.js failure it reported no other way.
    return { status: 'failed', code: 'stripe_failed' };
  }
};
