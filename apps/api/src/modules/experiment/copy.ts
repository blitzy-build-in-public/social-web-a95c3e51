/**
 * Deposit framing copy and the per-meetup variant pairing (AAP 0.5.1, 0.5.7, 0.8.1).
 *
 * {@link depositCopy} renders the sentence a viewer reads on a deposit screen or in a deposit
 * notification for their assigned experiment variant. The strings are the request's exact wording
 * and live once in `packages/shared/src/copy.ts`, so this module delegates rather than restates them
 * (AAP 0.5.7 "Framing copy", 0.11.1). {@link variantPairing} resolves both participants' variants
 * into the single `Meetup.variantPairing` the proposal stores, so the dashboard's variant filter
 * counts each meetup once (AAP 0.5.7 "Metric definitions").
 *
 * No clock, no I/O, no database, so a unit test exercises it in-process.
 */

import { depositCopy as sharedDepositCopy, isDepositLevel } from '@tablemate/shared';
import type { Variant, VariantPairing } from '@tablemate/shared';
import type { Logger } from '@tablemate/server-core';

/**
 * The deposit framing sentence for `variant` and the meetup's amount, per AAP 0.5.7: the request's
 * exact wording with "10 USD" replaced by 5, 10 or 20 USD, as the shared copy module renders it.
 *
 * `depositCents` is a plain number because `ProposeMeetup` accepts any integer and the route answers
 * `422 deposit_invalid` for a level outside `DEPOSIT_LEVELS_CENTS`. Reaching the guard here is our
 * own mistake, not a caller's, so it throws a plain `RangeError` naming the value rather than an
 * `AppError` — this module imports no Fastify plugin (AAP 0.5.4).
 *
 * @param variant - The viewer's assigned framing variant (AAP 0.5.7).
 * @param depositCents - The deposit in integer USD cents: 500, 1000 or 2000.
 * @returns The exact deposit sentence for that variant and amount.
 */
export function depositCopy(variant: Variant, depositCents: number): string {
  if (!isDepositLevel(depositCents)) {
    throw new RangeError(
      `depositCopy expects a deposit level of 500, 1000 or 2000 cents, received ${depositCents}`,
    );
  }

  return sharedDepositCopy(variant, depositCents);
}

/**
 * Both participants' variants as the one value a meetup carries (AAP 0.5.7).
 *
 * Equal variants give that variant; a `social`/`punitive` pair gives `mixed`. Either side missing
 * also gives `mixed` and warns, which keeps attribution total — every meetup counts exactly once
 * under the dashboard's variant filter — instead of failing a proposal over a missing assignment.
 * Assignment runs once at account creation, so that fallback is not expected to be reached. Its
 * warning carries no user id: analytics identify users only by salted hash (AAP 0.12.2), and the id
 * would be the only personal datum on the line.
 *
 * `meetups/propose.ts` reads both variants with `variantFor` and stores the result on
 * `Meetup.variantPairing` inside the proposal transaction.
 *
 * @param initiatorVariant - The initiator's variant, or null when none was recorded.
 * @param recipientVariant - The recipient's variant, or null when none was recorded.
 * @param logger - The API logger; only `warn` is used, so a caller may pass a narrowed stand-in.
 * @returns `social`, `punitive` or `mixed` — the value stored on the meetup.
 */
export function variantPairing(
  initiatorVariant: Variant | null,
  recipientVariant: Variant | null,
  logger?: Pick<Logger, 'warn'>,
): VariantPairing {
  if (initiatorVariant !== null && initiatorVariant === recipientVariant) {
    return initiatorVariant;
  }

  // A missing assignment means the pairing cannot speak for both participants, so the meetup is
  // attributed as `mixed` and the gap is recorded once, without the user it concerns.
  if (initiatorVariant === null || recipientVariant === null) {
    logger?.warn(
      { event: 'experiment_assignment_missing' },
      'experiment assignment missing at proposal',
    );
  }

  return 'mixed';
}
