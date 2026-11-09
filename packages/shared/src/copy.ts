import { isDepositLevel, type DepositCents } from './constants.ts';
import type { Variant } from './enums.ts';

/**
 * Fixed deposit-framing and lock-loss copy (AAP 0.5.7, 0.5.8). The deposit copy is the single
 * variable of the framing experiment, defined once here and read by the API, the workers that send
 * deposit notifications and every deposit screen (AAP 0.5.7, 0.11.1); no import beyond the deposit
 * types, so the module loads under Hermes, in browsers and on the server.
 */

/** Placeholder standing where the request's "10 USD" sits in a framing template (AAP 0.5.7). */
const AMOUNT_PLACEHOLDER = '{amount}';

/**
 * Formats a whole-dollar USD amount in cents as the copy's amount phrase (AAP 0.5.7). Anything but
 * a non-negative integer multiple of 100 throws a `RangeError` rather than printing a fractional or
 * negative amount, and plain arithmetic rather than `Intl` keeps the output byte-stable on every
 * runtime.
 */
export function formatUsdWhole(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0 || cents % 100 !== 0) {
    throw new RangeError(
      `formatUsdWhole expects a non-negative whole-dollar amount in cents, received ${cents}`,
    );
  }
  return `${cents / 100} USD`;
}

/**
 * The experiment's two framing strings, one per assigned variant (AAP 0.5.7, 0.5.8). The request's
 * exact sentences, with the amount left as {@link AMOUNT_PLACEHOLDER} so a single substitution site
 * fills in 5, 10 or 20 USD.
 */
export const DEPOSIT_COPY_TEMPLATES = {
  social: 'Hold a seat at the table. Your {amount} comes back as soon as you both show up.',
  punitive: "You'll lose {amount} if you don't show up.",
} as const satisfies Record<Variant, string>;

/**
 * Renders the deposit copy a viewer sees for their assigned variant and the meetup's deposit (AAP
 * 0.5.7). The guard protects a caller that passes an unchecked number and throws a `RangeError`
 * instead of printing an amount no deposit can hold; `422 deposit_invalid` for an amount off the
 * level list stays with {@link isDepositLevel}.
 */
export function depositCopy(variant: Variant, depositCents: DepositCents): string {
  // The proposal schema accepts any integer, so a caller can arrive with a number the type does not
  // describe; widening before the guard keeps the message able to print what it received.
  const requested: number = depositCents;
  if (!isDepositLevel(requested)) {
    throw new RangeError(
      `depositCopy expects a deposit level of 500, 1000 or 2000 cents, received ${requested}`,
    );
  }
  const amount = formatUsdWhole(requested);
  return DEPOSIT_COPY_TEMPLATES[variant].replace(AMOUNT_PLACEHOLDER, amount);
}

/**
 * What each participant is told when a hold ends before the meetup could settle (AAP 0.5.8).
 * `released` goes to a participant whose own deposit was never captured; `refunded` to the one
 * whose captured deposit a compensating resolution reverses.
 */
export const LOCK_LOST_COPY = {
  released:
    'A card hold for this meetup ended before it could settle, so no deposit applies. Any hold still on your card is being released.',
  refunded:
    'A card hold for this meetup ended before it could settle, so no deposit applies. The amount taken from your card is being refunded.',
} as const;
