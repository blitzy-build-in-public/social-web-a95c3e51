/**
 * The web 3-D Secure next action of a card hold: the browser half of the platform pair `./next-action` (AAP 0.3.4,
 * AAP 0.5.3, AAP 0.5.4).
 *
 * This file runs the challenge that closes the gap between a created hold and an authenticated one, inside Stripe's own
 * iframe and through the Stripe.js instance `./card-setup.web` already loaded: it never loads Stripe.js itself, and a
 * build with no publishable key never reaches Stripe from here. The native half is imported type-only — erased under
 * `verbatimModuleSyntax`, which keeps that module and `@stripe/stripe-react-native` out of the web bundle — and its
 * export is what holds this one to the pair's signature; `./card-setup.web` is spelled out for the opposite reason,
 * because an extensionless `./card-setup` type-checks against the native half, which has no `getStripe`.
 * The client secret is a bearer credential for the caller's own PaymentIntent: a parameter, a local and an argument for
 * the length of one call and nothing else, never in state, storage, a log line or the returned result. The challenge's
 * frames need `https://js.stripe.com` and `https://hooks.stripe.com` in the web app's Content-Security-Policy.
 */
import { getStripe } from './card-setup.web';
import type * as Native from './next-action.native';
export type { NextActionErrorCode, NextActionResult } from './next-action.native';

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
