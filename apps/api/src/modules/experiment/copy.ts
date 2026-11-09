/**
 * Deposit framing copy and the per-meetup variant pairing.
 *
 * {@link depositCopy} renders the sentence a viewer reads on a deposit screen or in a deposit notification for their
 * assigned experiment variant; the strings are the request's exact wording and live once in
 * `packages/shared/src/copy.ts`, so this module delegates rather than restates them. {@link variantPairing} resolves
 * both participants' variants into the single `Meetup.variantPairing` the proposal stores, so the dashboard's variant
 * filter counts each meetup once. No clock, no I/O, no database, so a unit test exercises it in-process.
 */
import { depositCopy as sharedDepositCopy, isDepositLevel } from '@tablemate/shared';
import type { Variant, VariantPairing } from '@tablemate/shared';
import type { Logger } from '@tablemate/server-core';

/**
 * The deposit framing sentence for `variant` and the meetup's amount: the request's exact wording with "10 USD"
 * replaced by 5, 10 or 20 USD, as the shared copy module renders it.
 *
 * `depositCents` is a plain number because `ProposeMeetup` accepts any integer and the route answers
 * `422 deposit_invalid` for a level outside `DEPOSIT_LEVELS_CENTS`; reaching the guard here is our own mistake rather
 * than a caller's, so it throws a plain `RangeError` naming the value, this module importing no Fastify plugin.
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
 * Both participants' variants as the one value a meetup carries.
 *
 * Equal variants give that variant; a `social`/`punitive` pair gives `mixed`, as does either side missing, which keeps
 * attribution total — every meetup counts exactly once under the dashboard's variant filter — instead of failing a
 * proposal over a missing assignment. Assignment runs once at account creation, so that fallback is not expected to be
 * reached. Its warning carries no user id: analytics identify users only by salted hash, and the id would be the only
 * personal datum on the line. `meetups/propose.ts` reads both variants with `variantFor` and stores the result on
 * `Meetup.variantPairing` inside the proposal transaction.
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
