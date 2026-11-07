/**
 * The deposit-framing and lock-loss copy, character for character (AAP 0.1.2, 0.5.7, 0.5.8).
 *
 * The framing experiment varies exactly one thing -- the sentence a deposit screen and a deposit
 * notification show, `social` against `punitive` -- so a stray character, a Unicode apostrophe
 * included, would contaminate the hypothesis it exists to test. Every expected string below is
 * therefore typed out by hand rather than derived from `DEPOSIT_COPY_TEMPLATES`, and `toBe`
 * compares it byte for byte.
 */
import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_LEVELS_CENTS,
  depositCopy,
  formatUsdWhole,
  LOCK_LOST_COPY,
  Variant,
} from '../src/index.ts';
import type { DepositCents } from '../src/index.ts';

/**
 * One row per variant and deposit level: the request's sentences with the amount filled in. The
 * 1000-cent rows are the request's examples verbatim, and every apostrophe is ASCII U+0027.
 */
const FRAMING_COPY_ROWS = [
  ['social', 500, 'Hold a seat at the table. Your 5 USD comes back as soon as you both show up.'],
  ['social', 1000, 'Hold a seat at the table. Your 10 USD comes back as soon as you both show up.'],
  ['social', 2000, 'Hold a seat at the table. Your 20 USD comes back as soon as you both show up.'],
  ['punitive', 500, "You'll lose 5 USD if you don't show up."],
  ['punitive', 1000, "You'll lose 10 USD if you don't show up."],
  ['punitive', 2000, "You'll lose 20 USD if you don't show up."],
] as const satisfies readonly (readonly [Variant, DepositCents, string])[];

/** The whole-dollar phrase every deposit amount prints as (AAP 0.5.7). */
const WHOLE_USD_ROWS = [
  [500, '5 USD'],
  [1000, '10 USD'],
  [2000, '20 USD'],
] as const satisfies readonly (readonly [DepositCents, string])[];

/**
 * Amounts a proposal can carry but no deposit level accepts (AAP 0.5.4, `422 deposit_invalid`).
 * Annotated `number` on purpose: a literal row would be the union `0|1|499|1500|10000`, which has
 * no overlap with `DepositCents` and so could not be asserted to it at all.
 */
const NON_DEPOSIT_AMOUNTS: readonly number[] = [0, 1, 499, 1500, 10000];

describe('depositCopy', () => {
  it.each(FRAMING_COPY_ROWS)('%s at %i cents', (variant, cents, expected) => {
    expect(depositCopy(variant, cents)).toBe(expected);
  });

  it('has one row per variant and deposit level', () => {
    expect(FRAMING_COPY_ROWS.length).toBe(DEPOSIT_LEVELS_CENTS.length * Variant.options.length);

    const covered = FRAMING_COPY_ROWS.map((row) => `${row[0]}:${row[1]}`);
    for (const cents of DEPOSIT_LEVELS_CENTS) {
      for (const variant of Variant.options) {
        expect(covered).toContain(`${variant}:${cents}`);
      }
    }
  });

  it.each(FRAMING_COPY_ROWS)('%s at %i cents is single-spaced plain text', (variant, cents) => {
    const copy = depositCopy(variant, cents);
    // A curly quote or a second space would change the sentence the recipient reads.
    expect(copy).not.toMatch(/[\u2018\u2019\u201C\u201D]/);
    expect(copy).not.toMatch(/ {2}/);
    expect(copy).toBe(copy.trim());
  });

  it.each(NON_DEPOSIT_AMOUNTS)('%i cents is rejected for both variants', (cents) => {
    const amount = cents as DepositCents;
    expect(() => depositCopy('social', amount)).toThrow();
    expect(() => depositCopy('punitive', amount)).toThrow();
  });
});

describe('formatUsdWhole', () => {
  it.each(WHOLE_USD_ROWS)('%i cents reads as %s', (cents, expected) => {
    expect(formatUsdWhole(cents)).toBe(expected);
  });
});

describe('LOCK_LOST_COPY', () => {
  it('tells a participant whose hold was never captured that it is being released', () => {
    expect(LOCK_LOST_COPY.released).toBe(
      'A card hold for this meetup ended before it could settle, so no deposit applies. Any hold still on your card is being released.',
    );
  });

  it('tells a participant whose captured deposit is reversed that it is being refunded', () => {
    expect(LOCK_LOST_COPY.refunded).toBe(
      'A card hold for this meetup ended before it could settle, so no deposit applies. The amount taken from your card is being refunded.',
    );
  });
});
