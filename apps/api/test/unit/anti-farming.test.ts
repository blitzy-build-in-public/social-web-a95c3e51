/**
 * The anti-farming rule's unit suite (AAP 0.5.7): the deposit floor and the half-open 30-day window
 * that decide whether a completed meetup counts toward reputation and the leaderboard.
 *
 * `countsForReputation = depositCents >= 500 AND the pair has no counted event in the 30 days
 * before this completion`, so both boundaries are pinned here rather than left to the SQL wrapper:
 * 499 cents never counts and 500 does, a pair with no counted event counts, and a counted event
 * exactly 30 days before the completion lies outside the window `(completedAt - 30 days,
 * completedAt]` while one a millisecond inside blocks it. Every duration is built from the shared
 * constants, never from a literal, so a change to the window moves the cases with it.
 *
 * `countsForReputationPure` is pure - no clock, no I/O - so each row fixes `completedAt` and derives
 * the pair's last counted event from it; no row reads the wall clock (AAP 0.11.1). The rule limits
 * the reputation counters and the leaderboard score and nothing else: `pair-history.ts` increments
 * on every completed meetup and the disclosure tiers ignore the window entirely, so the same pair
 * still reaches tier 3 after two meetups however closely they fall (AAP 0.7.3).
 */

import { describe, expect, it } from 'vitest';

import {
  ANTI_FARMING_MIN_DEPOSIT_CENTS,
  ANTI_FARMING_WINDOW_DAYS,
  DAY_MS,
  HOUR_MS,
} from '@tablemate/shared';

import { countsForReputationPure } from '../../src/modules/reputation/anti-farming.ts';

/** The completion every row is judged at: fixed in UTC, so no row depends on the host's clock. */
const COMPLETED_AT = new Date(Date.UTC(2026, 10, 20, 18, 0, 0));

/** The anti-farming window in milliseconds (AAP 0.5.7). */
const WINDOW_MS = ANTI_FARMING_WINDOW_DAYS * DAY_MS;

/** One millisecond: the smallest step that separates two instants, which probes the window's edges. */
const TICK_MS = 1;

/** 29 days and 23 hours: the closest whole-hour instant that is still inside the window. */
const INSIDE_WINDOW_MS = 29 * DAY_MS + 23 * HOUR_MS;

/**
 * One row: what it describes, the meetup's deposit, how long before the completion the pair's last
 * counted event fell - null when the pair has none - and whether this completion counts.
 */
type Case = readonly [
  label: string,
  depositCents: number,
  elapsedBeforeMs: number | null,
  counts: boolean,
];

/**
 * Every row of the rule (AAP 0.5.7).
 *
 * A row whose `lastCountedAt` is null stands for two situations the pure function must treat alike:
 * the pair has never completed a meetup, and its only prior completion was uncounted. The SQL
 * wrapper reads `witness_event` filtered by `counts_for_reputation` and passes the maximum it finds,
 * so an uncounted prior completion arrives here as null exactly as no history does.
 * `integration/settlement.test.ts` covers the wrapper the other way round: a second completion
 * inside the window is written with `countsForReputation = false`.
 */
const CASES: readonly Case[] = [
  // The deposit floor: 500 cents, the lowest accepted level, counts; 499 does not.
  ['the lowest accepted deposit, 500 cents, with no counted event', 500, null, true],
  ['the middle deposit, 1,000 cents, with no counted event', 1000, null, true],
  ['the highest accepted deposit, 2,000 cents, with no counted event', 2000, null, true],
  [
    'a cent below the floor, with no counted event',
    ANTI_FARMING_MIN_DEPOSIT_CENTS - 1,
    null,
    false,
  ],
  ['no deposit at all, with no counted event', 0, null, false],
  // The window is `(completedAt - 30 days, completedAt]`: its open lower bound is outside it.
  ['a counted event 29 d 23 h earlier, inside the window', 1000, INSIDE_WINDOW_MS, false],
  ['a counted event a millisecond inside the window', 1000, WINDOW_MS - TICK_MS, false],
  ['a counted event exactly 30 days earlier, on the open lower bound', 1000, WINDOW_MS, true],
  ['a counted event a millisecond beyond the window', 1000, WINDOW_MS + TICK_MS, true],
  ['a counted event at the instant of the completion', 1000, 0, false],
  // The criterion 16 complement: two completions a month apart both count.
  ['a counted event 31 days earlier, one window and a day', 1000, WINDOW_MS + DAY_MS, true],
  // The deposit rule alone fails, however old the pair's last counted event is.
  ['below the floor, with a counted event three windows earlier', 499, 3 * WINDOW_MS, false],
];

describe('countsForReputationPure', () => {
  it.each(CASES)(
    '%s: %i cents, %s ms before -> %s',
    (_label, depositCents, elapsedBeforeMs, counts) => {
      const lastCountedAt =
        elapsedBeforeMs === null ? null : new Date(COMPLETED_AT.getTime() - elapsedBeforeMs);
      expect(countsForReputationPure(depositCents, lastCountedAt, COMPLETED_AT)).toBe(counts);
    },
  );
});
