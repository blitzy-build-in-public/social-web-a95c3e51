/**
 * The lodging leaderboard's pure rules as unit rows: the 90-day activity window, the
 * once-in-any-30-days pair dedupe, the "fewer than 3" guest-count label and the ranking order
 * (AAP 0.5.7, 0.5.4, criterion 16).
 *
 * Almost every row pins a boundary the directory's SQL also relies on, and both readers share one
 * implementation of the rule: `scoreFacts` is the pair chain the city board, a lodging's own
 * console standings and the settlement's fact writer all go through, and `compareForLeaderboard`
 * is the order the board and that console both report. No database is touched here — the SQL, and
 * the seeded scenario for a whole city (score first, then verified guest count, then name, zero
 * scores last), are covered by `apps/api/test/integration/lodgings.test.ts`.
 *
 * Three conventions keep the rows honest: every instant comes from `Date.UTC` arithmetic and never
 * from the wall clock, a row's facts are plain `ActivityFact` values no statement produced, and the
 * expected `counted` instants are written with the same {@link at} helper the facts are, so a row
 * states *when* each fact must count rather than only how many did.
 *
 * @see AAP 0.5.7 for the leaderboard, visibility and guest-count rules, 0.5.4 for the DTOs and the
 *   "fewer than 3" label, 0.12.1 criterion 16 for "a second meetup by the same pair within 30 days
 *   adds nothing".
 */
import { describe, expect, it } from 'vitest';

import { coveringMeetupStatement } from '@tablemate/db';

import {
  DAY_MS,
  GUEST_COUNT_BELOW_LABEL,
  GUEST_COUNT_THRESHOLD,
  GuestCount,
  LEADERBOARD_PAIR_DEDUPE_DAYS,
  LEADERBOARD_WINDOW_DAYS,
  toGuestCount as sharedToGuestCount,
  type AppEnv,
  type GuestCount as GuestCountValue,
} from '@tablemate/shared';

import {
  compareForLeaderboard,
  scoreFacts,
  toGuestCount,
  type ActivityFact,
  type LeaderboardEntry,
} from '../../src/modules/lodgings/leaderboard.ts';

/** The instant every row measures back from; fixed, so no row depends on when it ran. */
const NOW = new Date(Date.UTC(2026, 10, 20, 12));

/** The two lodgings the rows place facts on. */
const L1 = 'lodging-1';
const L2 = 'lodging-2';

/** Two distinct pair keys: the order-independent HMAC of a pair that dedupes a fact. */
const P1 = 'pair-1';
const P2 = 'pair-2';

/** An instant `daysAgo` days before {@link NOW}; a negative value lies after it (clock skew). */
function at(daysAgo: number, extraMs = 0): Date {
  return new Date(NOW.getTime() - daysAgo * DAY_MS + extraMs);
}

/** One activity fact of `lodgingId` and `pairKey`, completed at {@link at}. */
function fact(lodgingId: string, pairKey: string, daysAgo: number, extraMs = 0): ActivityFact {
  return { lodgingId, pairKey, completedAt: at(daysAgo, extraMs) };
}

/** One row over {@link scoreFacts}. */
interface ScoreCase {
  /** Reads as the rule the row pins. */
  readonly name: string;
  readonly facts: readonly ActivityFact[];
  /**
   * Lodging id to the instants that must count. A lodging named nowhere here must be absent from
   * the result, which is how a caller reads a score of 0.
   */
  readonly expected: Readonly<Record<string, readonly Date[]>>;
}

const SCORE_CASES: readonly ScoreCase[] = [
  {
    name: 'counts a fact completed yesterday',
    facts: [fact(L1, P1, 1)],
    expected: { [L1]: [at(1)] },
  },
  {
    name: 'counts a fact a day inside the 90-day window',
    facts: [fact(L1, P1, LEADERBOARD_WINDOW_DAYS - 1)],
    expected: { [L1]: [at(LEADERBOARD_WINDOW_DAYS - 1)] },
  },
  {
    name: 'ignores a fact past the far edge of the window',
    facts: [fact(L1, P1, LEADERBOARD_WINDOW_DAYS + 1)],
    expected: {},
  },
  {
    name: 'ignores a fact exactly on the edge: the lower bound is strict',
    facts: [fact(L1, P1, LEADERBOARD_WINDOW_DAYS)],
    expected: {},
  },
  {
    name: 'ignores a second fact of the same pair 29 days after a counted one',
    facts: [fact(L1, P1, 40), fact(L1, P1, 11)],
    expected: { [L1]: [at(40)] },
  },
  {
    name: 'counts a second fact of the same pair 31 days after a counted one',
    facts: [fact(L1, P1, 45), fact(L1, P1, 14)],
    expected: { [L1]: [at(45), at(14)] },
  },
  {
    name: 'chains from the last counted fact, not from the last fact',
    facts: [fact(L1, P1, 60), fact(L1, P1, 40), fact(L1, P1, 20)],
    expected: { [L1]: [at(60), at(20)] },
  },
  {
    name: 'ignores a fact exactly 30 days after a counted one: the spacing is "more than 30 days"',
    facts: [fact(L1, P1, 40), fact(L1, P1, 10)],
    expected: { [L1]: [at(40)] },
  },
  {
    name: 'counts two different pairs at one lodging on the same day',
    facts: [fact(L1, P1, 5), fact(L1, P2, 5)],
    expected: { [L1]: [at(5), at(5)] },
  },
  {
    name: 'counts the same pair once per lodging',
    facts: [fact(L1, P1, 5), fact(L2, P1, 5)],
    expected: { [L1]: [at(5)], [L2]: [at(5)] },
  },
  {
    name: 'scores the same way whatever order the facts arrive in',
    facts: [fact(L1, P1, 20), fact(L1, P1, 60), fact(L1, P1, 40)],
    expected: { [L1]: [at(60), at(20)] },
  },
  {
    name: 'ignores a fact dated after the reading instant',
    facts: [fact(L1, P1, -1)],
    expected: {},
  },
  {
    name: 'counts a window fact beside one dated after the reading instant',
    facts: [fact(L1, P1, 1), fact(L1, P1, -1)],
    expected: { [L1]: [at(1)] },
  },
  {
    name: 'adds nothing for a second meetup of the same pair within 30 days (criterion 16)',
    facts: [fact(L1, P1, 20), fact(L1, P1, 5)],
    expected: { [L1]: [at(20)] },
  },
];

describe('scoreFacts', () => {
  it('reads the window and the pair spacing the rows above are expressed in', () => {
    expect([LEADERBOARD_WINDOW_DAYS, LEADERBOARD_PAIR_DEDUPE_DAYS]).toEqual([90, 30]);
  });

  it.each(SCORE_CASES)('$name', ({ facts, expected }) => {
    const scored = scoreFacts(facts, NOW);

    // Exactly the lodgings with a counted fact, and no others: absence is how a caller reads 0.
    expect([...scored.keys()].sort()).toEqual(Object.keys(expected).sort());

    for (const [lodgingId, counted] of Object.entries(expected)) {
      const entry = scored.get(lodgingId);

      expect(entry?.counted).toEqual(counted);
      expect(entry?.score).toBe(counted.length);
    }
  });

  it("holds ascending instants of its own, not the caller's Date objects", () => {
    const newer = fact(L1, P1, 5);
    const older = fact(L1, P1, 60);
    const elsewhere = fact(L2, P1, 30);

    const entry = scoreFacts([newer, older, elsewhere], NOW).get(L1);

    expect(entry?.counted).toEqual([at(60), at(5)]);
    expect(entry?.counted[0]).not.toBe(older.completedAt);
    expect(entry?.counted[1]).not.toBe(newer.completedAt);
  });

  it('scores nothing when no fact arrived', () => {
    expect(scoreFacts([], NOW).size).toBe(0);
  });
});

describe('toGuestCount', () => {
  const GUEST_COUNT_CASES: readonly { name: string; guests: number; expected: GuestCountValue }[] =
    [
      { name: 'renders no guest as the label', guests: 0, expected: GUEST_COUNT_BELOW_LABEL },
      { name: 'renders one guest as the label', guests: 1, expected: GUEST_COUNT_BELOW_LABEL },
      { name: 'renders two guests as the label', guests: 2, expected: GUEST_COUNT_BELOW_LABEL },
      {
        name: 'renders the first disclosable count as a number',
        guests: GUEST_COUNT_THRESHOLD,
        expected: GUEST_COUNT_THRESHOLD,
      },
      { name: 'renders a larger count as a number', guests: 10, expected: 10 },
    ];

  it.each(GUEST_COUNT_CASES)('$name', ({ guests, expected }) => {
    const rendered = toGuestCount(guests);

    expect(rendered).toBe(expected);
    // Every rendering is a valid `GuestCount`, so no response schema can reject one.
    expect(GuestCount.parse(rendered)).toBe(expected);
  });

  it('is the shared toGuestCount, so the threshold and the label have one definition', () => {
    expect(toGuestCount).toBe(sharedToGuestCount);
    expect(GUEST_COUNT_BELOW_LABEL).toBe('fewer than 3');
  });

  it('makes a count below the threshold unrepresentable as a number', () => {
    expect(GuestCount.safeParse(GUEST_COUNT_THRESHOLD - 1).success).toBe(false);
    expect(GuestCount.safeParse(GUEST_COUNT_BELOW_LABEL).success).toBe(true);
    // Nor as a numeric string: only an integer or the label parses.
    expect(GuestCount.safeParse(String(GUEST_COUNT_THRESHOLD)).success).toBe(false);
  });
});

/** One row over {@link compareForLeaderboard}. */
interface OrderCase {
  readonly name: string;
  readonly entries: readonly LeaderboardEntry[];
  /** The ids in the order the rule must give, from the first standing to the last. */
  readonly order: readonly string[];
}

/** A lodging as the ranking rule reads it. */
function entry(
  id: string,
  name: string,
  activityScore: number,
  guestCount: number,
): LeaderboardEntry {
  return { id, name, activityScore, guestCount };
}

/** The ids `Array.prototype.sort` produces under the leaderboard's comparator. */
function sortIds(entries: readonly LeaderboardEntry[]): string[] {
  return [...entries].sort(compareForLeaderboard).map((item) => item.id);
}

const ORDER_CASES: readonly OrderCase[] = [
  {
    name: 'orders by witnessed-meetup score, highest first',
    entries: [
      entry('charlie', 'Charlie', 3, 9),
      entry('alpha', 'Alpha', 9, 1),
      entry('bravo', 'Bravo', 5, 4),
    ],
    order: ['alpha', 'bravo', 'charlie'],
  },
  {
    name: 'breaks an equal score by verified guest count, highest first',
    entries: [
      entry('alpha', 'Alpha', 4, 1),
      entry('bravo', 'Bravo', 4, 9),
      entry('charlie', 'Charlie', 4, 3),
    ],
    order: ['bravo', 'charlie', 'alpha'],
  },
  {
    name: 'breaks an equal score and guest count by name',
    entries: [
      entry('bravo', 'Bravo', 7, 2),
      entry('charlie', 'Charlie', 7, 2),
      entry('alpha', 'Alpha', 7, 2),
    ],
    order: ['alpha', 'bravo', 'charlie'],
  },
  {
    // A score of 0 also ignores the guest count, so a busy lodging with no witnessed meetup still
    // follows the scored ones in name order.
    name: 'places lodgings scoring 0 after every scored one, alphabetically',
    entries: [
      entry('zulu', 'Zulu', 0, 50),
      entry('yankee', 'Yankee', 1, 0),
      entry('alpha', 'Alpha', 0, 0),
      entry('bravo', 'Bravo', 0, 9),
    ],
    order: ['yankee', 'alpha', 'bravo', 'zulu'],
  },
  {
    name: 'breaks a final tie by id, so two reads of one board do not reshuffle',
    entries: [entry('bravo', 'Twin', 4, 2), entry('alpha', 'Twin', 4, 2)],
    order: ['alpha', 'bravo'],
  },
];

describe('compareForLeaderboard', () => {
  it.each(ORDER_CASES)('$name', ({ entries, order }) => {
    expect(sortIds(entries)).toEqual(order);
    // The rule is total and input-order-independent, so the same board reversed sorts the same way.
    expect(sortIds([...entries].reverse())).toEqual(order);
  });

  it('ranks that order from 1, the standing the directory reports', () => {
    const entries: readonly LeaderboardEntry[] = [
      entry('charlie', 'Charlie', 3, 1),
      entry('alpha', 'Alpha', 0, 0),
      entry('bravo', 'Bravo', 3, 4),
    ];

    expect(sortIds(entries)).toEqual(['bravo', 'charlie', 'alpha']);
    // `computeLeaderboard` numbers the board it sorts this way (`rank: index + 1`).
    expect([...entries].sort(compareForLeaderboard).map((_, index) => index + 1)).toEqual([
      1, 2, 3,
    ]);
  });
});

/**
 * The one covering-meetup statement both processes run, pinned at the place it is stated
 * (AAP 0.5.2, 0.5.7).
 *
 * These rows assert on `@tablemate/db`'s builder itself: it is the statement the API's
 * `recordActivityForVerifiedClaim` and the workers' `backfillActivityFacts` share, so there is no
 * second copy to keep in step with it, and nothing in this suite runs SQL. The rows it returns, and
 * the facts written from them, are covered by the integration suites.
 */

/** The claim every statement row is built for: one traveler, one five-day stay. */
const COVERAGE = {
  userId: '11111111-1111-4111-8111-111111111111',
  stayFrom: '2026-11-01',
  stayTo: '2026-11-05',
} as const;

/** One environment the statement is built for, and the fixture clause its text must close with. */
interface StatementCase {
  /** Reads as the environment the row builds for. */
  readonly name: string;
  readonly appEnv: AppEnv;
  /** The predicate `fixturePredicate` gives that environment (AAP 0.5.2). */
  readonly fixtureClause: string;
}

const STATEMENT_CASES: readonly StatementCase[] = [
  { name: 'test', appEnv: 'test', fixtureClause: 'AND TRUE' },
  { name: 'demo', appEnv: 'demo', fixtureClause: 'AND TRUE' },
  { name: 'staging', appEnv: 'staging', fixtureClause: 'AND "v"."is_fixture" = false' },
  { name: 'production', appEnv: 'production', fixtureClause: 'AND "v"."is_fixture" = false' },
];

/** The statement's text for `appEnv`, its whitespace collapsed, so a row reads the clauses alone. */
function statementSql(appEnv: AppEnv): string {
  return coveringMeetupStatement(appEnv, COVERAGE, NOW).sql.replace(/\s+/g, ' ').trim();
}

describe('coveringMeetupStatement', () => {
  it.each(STATEMENT_CASES)("$name: reads the covering rule over the venue's city", ({ appEnv }) => {
    const sql = statementSql(appEnv);

    // The meetup, its venue and that venue's city, joined so the local date is the meetup's own.
    expect(sql).toContain('FROM "meetup" AS "m"');
    expect(sql).toContain('JOIN "venue" AS "v" ON "v"."id" = "m"."venue_id"');
    expect(sql).toContain('JOIN "city" AS "ci" ON "ci"."id" = "v"."city_id"');
    // Completed, settled, and inside the activity window the caller passes in.
    expect(sql).toContain('"m"."status" = \'completed\'');
    expect(sql).toContain('"m"."settled_at" IS NOT NULL');
    expect(sql).toContain('"m"."settled_at" > ?');
    // The meetup's local date in that city, against both ends of the stay.
    expect(sql).toContain('(("m"."starts_at" AT TIME ZONE "ci"."timezone")::date');
    expect(sql).toContain('BETWEEN CAST(? AS date) AND CAST(? AS date)');
    // The claimant, matched against either participant of the meetup.
    expect(sql).toContain('("m"."initiator_id" = ?::uuid OR "m"."recipient_id" = ?::uuid)');
  });

  it.each(STATEMENT_CASES)("$name: ends on its environment's fixture predicate", (row) => {
    expect(statementSql(row.appEnv).endsWith(row.fixtureClause)).toBe(true);
  });

  it('binds every value and interpolates none of them into its text', () => {
    const statement = coveringMeetupStatement('staging', COVERAGE, NOW);

    expect(statement.values).toEqual([
      NOW,
      COVERAGE.userId,
      COVERAGE.userId,
      COVERAGE.stayFrom,
      COVERAGE.stayTo,
    ]);

    for (const value of [COVERAGE.userId, COVERAGE.stayFrom, COVERAGE.stayTo]) {
      expect(statement.sql).not.toContain(value);
    }
  });
});
