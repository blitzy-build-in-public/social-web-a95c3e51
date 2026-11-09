/**
 * Saved-card setup: the Customer, the SetupIntent and the ephemeral key of `POST /me/payment-setup`.
 *
 * A commitment lock only works from a card the traveler saved earlier: the hold is confirmed on-session from that
 * card, which is what gives it the 7-day window — a merchant-initiated hold lasts about 5 days and a meetup may start
 * up to 5 days after the proposal.
 *
 * Stripe is reached only through `services.payments`, and no provider call sits inside a transaction: the setup starts
 * outside one, and the single write it may need happens afterwards in `transact`, which also runs the account-deletion
 * write fence.
 */
import type { PaymentSetupResponse } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { transact } from '../outbox/write.ts';
import { isPaymentError } from '../payments/gateway.ts';

import type { SetupResult } from '../payments/gateway.ts';

import type { AppServices } from '../../app.ts';

/** What a setup the provider could not start answers with: the fixed sentence of `503 payment_unavailable`. */
const SETUP_UNAVAILABLE_MESSAGE = 'Card setup is unavailable right now. Please try again.';

/**
 * Starts a card setup for `customerId`, creating the customer when the account has none. Called from outside any
 * transaction, because a provider call held inside one would keep its locks for as long as Stripe took. Every failure
 * the gateway raises becomes `payment_unavailable`, with the gateway's failure as the cause of the log alone.
 */
async function startSetup(services: AppServices, customerId: string | null): Promise<SetupResult> {
  try {
    return await services.payments.createSetup({ customerId });
  } catch (error) {
    if (isPaymentError(error)) {
      throw new AppError('payment_unavailable', SETUP_UNAVAILABLE_MESSAGE, { cause: error });
    }
    throw error;
  }
}

/**
 * The response body, built field by field from the gateway's result — listed rather than spread, so a field added to
 * that result can never reach a response it was not copied into.
 */
function toResponse(result: SetupResult): PaymentSetupResponse {
  return {
    customerId: result.customerId,
    setupIntentClientSecret: result.setupIntentClientSecret,
    ephemeralKeySecret: result.ephemeralKeySecret,
  };
}

/**
 * Prepares the caller's saved card: the Customer the holds will bill, a SetupIntent to confirm and the ephemeral key
 * the Stripe client components authenticate with.
 *
 * The account's customer is created once and then reused, and `stripe_customer_id IS NULL` is the filter of the write
 * that records one, so two concurrent first-time setups cannot both store a customer: the one whose update matched
 * nothing keeps the id the other stored, re-issues its response against it and logs the customer it created as an
 * orphan. An account whose row is gone or whose deletion has been requested is refused with `token_invalid`.
 */
export async function createPaymentSetup(
  services: AppServices,
  userId: string,
): Promise<PaymentSetupResponse> {
  const account = await services.db.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, deletionRequestedAt: true, deletedAt: true },
  });
  // The cheap half of the deletion write fence: refusing here costs one read instead of a transaction,
  // and it is the state a request arriving after `DELETE /me` commits sees; the fenced transaction below
  // is the authoritative half.
  if (account === null || account.deletionRequestedAt !== null || account.deletedAt !== null) {
    throw new AppError('token_invalid');
  }
  const result = await startSetup(services, account.stripeCustomerId);
  // The account already had a customer, so nothing is recorded and the response is complete as it stands.
  if (account.stripeCustomerId !== null) {
    return toResponse(result);
  }
  const stored = await transact(
    services,
    async (tx) => {
      // A guarded update rather than a read followed by a write: the `stripe_customer_id IS NULL`
      // filter makes exactly one of two concurrent first-time setups match.
      const { count } = await tx.user.updateMany({
        where: { id: userId, stripeCustomerId: null },
        data: { stripeCustomerId: result.customerId },
      });
      if (count === 1) return { customerId: result.customerId, ours: true } as const;
      // The other request stored its customer first, so its id is the one to keep; the customer this
      // call created is abandoned, so it can never be confirmed against and never takes money.
      const row = await tx.user.findUnique({
        where: { id: userId },
        select: { stripeCustomerId: true },
      });
      return { customerId: row?.stripeCustomerId ?? null, ours: false } as const;
    },
    { fenceUserId: userId },
  );
  if (stored.ours) {
    return toResponse(result);
  }
  if (stored.customerId === null) {
    // Unreachable while the fence above holds the account row; if it ever happens the account names no
    // customer, so the honest answer is the retryable failure.
    throw new AppError('payment_unavailable', SETUP_UNAVAILABLE_MESSAGE);
  }
  services.logger.warn({ event: 'stripe_customer_orphaned', userId }, 'stripe_customer_orphaned');
  // One more setup, on the customer the account actually names: this card is the one the next hold uses.
  return toResponse(await startSetup(services, stored.customerId));
}
