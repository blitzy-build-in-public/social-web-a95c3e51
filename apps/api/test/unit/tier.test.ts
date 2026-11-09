/**
 * The tier-computation unit suite (AAP 0.5.7, 0.5.4): `tierFrom`'s whole rule as a table, one row
 * per case, in the order the rule applies.
 */

import { describe, expect, it } from 'vitest';

import type { TierResult } from '@tablemate/shared';

import { tierFrom, type PairFacts } from '../../src/modules/users/disclosure/tier.ts';

/** A row of the table: the case's name, the pair's facts, and the tier those facts must yield. */
interface TierCase {
  /** What the row pins, carried into the title as `AAP 0.5.7 tier: <name>`. */
  readonly name: string;
  /** The four facts of the pair, as `pairFacts` would read them (AAP 0.5.7). */
  readonly facts: PairFacts;
  /** The tier `tierFrom` must answer, per the mapping of AAP 0.5.4. */
  readonly expected: TierResult;
}

/**
 * The facts of a pair that has never met: no block, no completed meetup, nothing locked and no
 * meetup to message over. Every row starts here and states only what it changes.
 */
const STRANGER: PairFacts = {
  blocked: false,
  completedCount: 0,
  sharedLockedBothHeld: false,
  messageable: false,
};

/** One row's facts: {@link STRANGER} with the named facts overridden. */
function facts(overrides: Partial<PairFacts> = {}): PairFacts {
  return { ...STRANGER, ...overrides };
}

/**
 * A shared meetup in `locked` with both deposits `held`, which also opens messaging (tiers 1 and 2
 * of the table below). A meetup with an open dispute reaches these very facts: it stays `locked`
 * while the dispute stands, so `pairFacts` must not filter disputed meetups out of its
 * `shared_locked_both_held` test (AAP 0.5.3) — `integration/disclosure.test.ts` covers that SQL.
 */
const LOCKED_BOTH_HELD = facts({ sharedLockedBothHeld: true, messageable: true });

/**
 * The rule of AAP 0.5.7, one row per case. Two properties are deliberately out of `tierFrom`'s
 * reach and are named here instead. `completedCount` counts every completed meetup whatever the
 * deposit and however closely the two are spaced, because the anti-farming rule limits the
 * reputation counters and the leaderboard only and never disclosure (AAP 0.7.3), so two completions
 * inside 30 days still reach tier 3 (criterion 5). And `PairFacts.blocked` carries no block
 * *direction*: it is true for a block in either direction, a property of `pairFacts`' SQL rather
 * than of this function, which `integration/disclosure.test.ts` covers.
 */
const TIER_CASES: readonly TierCase[] = [
  // A stranger keeps the tier 0 allowlist.
  { name: 'a stranger → 0', facts: facts(), expected: 0 },
  // A shared locked meetup with both deposits held is the one thing tier 1 adds.
  { name: 'shared locked meetup, both deposits held → 1', facts: LOCKED_BOTH_HELD, expected: 1 },
  // The same meetup with an open dispute: it stays `locked`, so the facts are identical.
  { name: 'shared locked meetup, open dispute → 1', facts: LOCKED_BOTH_HELD, expected: 1 },
  // Locked but only one deposit held: messageable, and still below tier 1.
  { name: 'locked meetup, one deposit held → 0', facts: facts({ messageable: true }), expected: 0 },
  // One completed meetup.
  { name: 'completedCount=1 → 2', facts: facts({ completedCount: 1 }), expected: 2 },
  // A completion with a locked meetup beside it: the higher tier wins.
  {
    name: 'completedCount=1 and a shared locked meetup → 2',
    facts: facts({ completedCount: 1, sharedLockedBothHeld: true }),
    expected: 2,
  },
  // Two completions: the tier criterion 5 measures.
  { name: 'completedCount=2 → 3', facts: facts({ completedCount: 2 }), expected: 3 },
  // Tier 3 is open-ended above two.
  { name: 'completedCount=7 → 3', facts: facts({ completedCount: 7 }), expected: 3 },
  // A block outranks the absence of history: `GET /users/:userId` answers `404 user_not_found`.
  { name: 'blocked, no history → blocked', facts: facts({ blocked: true }), expected: 'blocked' },
  // A block outranks history and a locked meetup too.
  {
    name: 'blocked, five completions and a shared locked meetup → blocked',
    facts: facts({ blocked: true, completedCount: 5, sharedLockedBothHeld: true }),
    expected: 'blocked',
  },
];

describe('tierFrom', () => {
  it.each(TIER_CASES)('AAP 0.5.7 tier: $name', ({ facts: rowFacts, expected }) => {
    expect(tierFrom(rowFacts)).toBe(expected);
  });
});
