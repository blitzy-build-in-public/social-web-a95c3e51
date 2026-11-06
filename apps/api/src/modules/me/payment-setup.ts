/**
 * Saved-card setup: the Customer, the SetupIntent and the ephemeral key of
 * `POST /me/payment-setup` (AAP 0.5.1, AAP 0.5.4).
 *
 * A commitment lock only works from a card the traveler saved earlier. `POST /meetups`,
 * `POST /meetups/:id/accept` and `POST /meetups/:id/hold` confirm their holds **on-session** from
 * the customer's saved card, which is what makes the authorization customer-initiated and gives it
 * the 7-day window AAP 0.2.4 records — a merchant-initiated hold lasts about 5 days for Visa, and a
 * meetup may start up to 5 days after the proposal, so it could expire before there was anything to
 * settle. This function is what puts that card there: the client confirms the returned SetupIntent
 * with PaymentSheet on native or the Payment Element on web, and the card itself never reaches this
 * API (AAP 0.3.2).
 *
 * Two rules shape the code:
 *
 *  - **Stripe is reached only through `services.payments`** (AAP 0.6.2). This file imports
 *    `payments/gateway.ts` for the failures it maps and never the `stripe` SDK, which the root
 *    ESLint configuration reserves for `payments/stripe-gateway.ts`.
 *  - **No provider call inside a transaction** (AAP 0.3.2). The setup is started outside one, and
 *    the single write it may need — recording the customer on the account — happens afterwards in
 *    `transact`, which also runs the account-deletion write fence (AAP 0.5.3).
 *
 * @see AAP 0.5.4 for the route's contract and its response, 0.5.1 for the `Me` component, 0.5.3 for
 *   the write fence, 0.2.4 for the hold lifecycle the saved card serves, and 0.8.1 for this file.
 */

import type { PaymentSetupResponse } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { transact } from '../outbox/write.ts';
import { isPaymentError } from '../payments/gateway.ts';

import type { SetupResult } from '../payments/gateway.ts';

// Type-only, so this file holds no runtime edge to the module that builds the app: it erases at
// compile time, and the services bag it names is the one `app.ts` constructs and passes to every
// module. The two members read here are the guarded database client and the payments gateway.
import type { AppServices } from '../../app.ts';

/**
 * What a setup the provider could not start answers with: the envelope carries
 * `503 payment_unavailable` (AAP 0.5.4) and this fixed sentence, which repeats no value from the
 * request or the provider.
 */
const SETUP_UNAVAILABLE_MESSAGE = 'Card setup is unavailable right now. Please try again.';

/**
 * Starts a card setup for `customerId`, creating the customer when the account has none
 * (AAP 0.5.4).
 *
 * Called from outside any transaction, because a provider call held inside one would keep its locks
 * for as long as Stripe took. The response is never built here: {@link toResponse} is the only place
 * the gateway's result becomes the route's payload.
 *
 * @param customerId - The customer the account records, or `null` on first use.
 * @returns The customer, the SetupIntent's client secret and the ephemeral key.
 * @throws AppError `payment_unavailable` for every failure the gateway raises, whether the outcome
 *   was unknown or the request was refused: the route's contract gives no other failure and the
 *   client's answer is the same — retry the setup. The gateway's own failure rides along as the
 *   cause for the log alone, and its message carries a code rather than provider text.
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
 * The response body, built field by field from the gateway's result (AAP 0.5.4).
 *
 * The three fields are the shared `PaymentSetupResponse`, listed explicitly rather than spread from
 * `SetupResult` so the two shapes stay visibly the same: the route serializes this value with that
 * schema, and a field added to the gateway's result can never reach a response it was not copied
 * into.
 *
 * @param result - What {@link startSetup} returned.
 * @returns The `POST /me/payment-setup` body.
 */
function toResponse(result: SetupResult): PaymentSetupResponse {
  return {
    customerId: result.customerId,
    setupIntentClientSecret: result.setupIntentClientSecret,
    ephemeralKeySecret: result.ephemeralKeySecret,
  };
}

/**
 * Prepares the caller's saved card: the Customer the holds will bill, a SetupIntent to confirm and
 * the ephemeral key the Stripe client components authenticate with (AAP 0.5.4, AAP 0.5.1).
 *
 * The account's customer is created once and then reused: the read below supplies the id the
 * gateway reuses, and the write records a freshly created one. `stripe_customer_id IS NULL` is the
 * filter of that write, so two concurrent first-time setups cannot both store a customer — the one
 * whose update matched nothing keeps the id the other request stored, because that is the customer
 * every later hold confirms against. The customer this call created then has no card and no row
 * pointing at it: it is logged as an orphan at `warn`, and the response is re-issued against the
 * kept customer so the card the client saves is the card the next hold uses.
 *
 * @param services - The app's services: the guarded database client, the payments gateway, the
 *   logger, and the clock and outbox dispatcher `transact` requires.
 * @param userId - The authenticated account the caller's token names.
 * @returns The customer, the SetupIntent's client secret and the ephemeral key.
 * @throws AppError `token_invalid` when the account row is gone or its deletion has been requested
 *   — the same refusal the write fence answers with (AAP 0.5.3) — so no customer is created for an
 *   account that is on its way out.
 * @throws AppError `payment_unavailable` when the provider could not start the setup, or when the
 *   account ended up naming no customer at all.
 */
export async function createPaymentSetup(
  services: AppServices,
  userId: string,
): Promise<PaymentSetupResponse> {
  const account = await services.db.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, deletionRequestedAt: true, deletedAt: true },
  });

  // The cheap half of the deletion write fence: refusing here costs one read instead of a
  // transaction, and it is the state a request that arrives after `DELETE /me` commits sees. The
  // fenced transaction below is the authoritative half, because only it serializes against a
  // deletion that commits while this call is in flight.
  if (account === null || account.deletionRequestedAt !== null || account.deletedAt !== null) {
    throw new AppError('token_invalid');
  }

  const result = await startSetup(services, account.stripeCustomerId);

  // The account already had a customer, so nothing is recorded and the response is complete as it
  // stands: every hold for this account confirms against that customer.
  if (account.stripeCustomerId !== null) {
    return toResponse(result);
  }

  const stored = await transact(
    services,
    async (tx) => {
      // A guarded update rather than a read followed by a write: the `stripe_customer_id IS NULL`
      // filter makes exactly one of two concurrent first-time setups match, so an account can never
      // end up naming a customer whose card the response did not belong to.
      const { count } = await tx.user.updateMany({
        where: { id: userId, stripeCustomerId: null },
        data: { stripeCustomerId: result.customerId },
      });

      if (count === 1) return { customerId: result.customerId, ours: true } as const;

      // The other request stored its customer first, so its id is the one to keep. The customer this
      // call created is abandoned: it has no card and no row pointing at it, so it can never be
      // confirmed against and never takes money. The row is re-read rather than trusted from the
      // failed update, so the id returned is the one the database holds.
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
    // Unreachable while the fence above holds the account row: nothing can clear the id between the
    // fence and the update. If it ever happens the account names no customer, so answering with one
    // no hold would use would be wrong — the honest answer is the retryable failure.
    throw new AppError('payment_unavailable', SETUP_UNAVAILABLE_MESSAGE);
  }

  services.logger.warn({ event: 'stripe_customer_orphaned', userId }, 'stripe_customer_orphaned');

  // One more setup, on the customer the account actually names: the card the client saves against
  // this SetupIntent is the card the next hold confirms against.
  return toResponse(await startSetup(services, stored.customerId));
}
