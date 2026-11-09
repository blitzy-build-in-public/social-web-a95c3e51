/**
 * The day-plan suggestion rules' unit suite (AAP 0.5.7 "Budget", "Cost estimation", "Ranking" and the
 * `emptyReason` order of "Suggestion filtering"), plus the 24-hour eligibility reading of AAP 0.7.3
 * that `GET /meetups/:id/suggestions` applies through `suggestionsEligible`.
 */

import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/plugins/errors.ts';
import {
  assertBudgetInRange,
  defaultBudgetFor,
  effectiveBudget,
  isBudgetInRange,
} from '../../src/modules/suggestions/budget.ts';
import {
  SOURCE_PRIORITY,
  currentSet,
  estimatePlace,
  isFresh,
  medianHalfUp,
} from '../../src/modules/suggestions/estimate.ts';
import type { PlaceEstimate, PriceRow } from '../../src/modules/suggestions/estimate.ts';
import {
  RANK_KEYS,
  compareRank,
  emptyReasonFor,
  fitsBudget,
  inFitBand,
  rankSuggestions,
} from '../../src/modules/suggestions/rank.ts';
import type { RankInput, SuggestionCounts } from '../../src/modules/suggestions/rank.ts';
import { suggestionsEligible } from '../../src/modules/suggestions/routes.ts';
import {
  BUDGET_MAX_CENTS,
  BUDGET_MIN_CENTS,
  DAY_MS,
  DEFAULT_BUDGET_BY_DEPOSIT,
  FRESHNESS_ONLINE_DAYS,
  FRESHNESS_PHONE_OPERATOR_DAYS,
  HOUR_MS,
  SUGGESTIONS_MAX,
  SUGGESTIONS_PER_CATEGORY_MAX,
  SUGGESTION_BUDGET_FIT_LOW,
} from '@tablemate/shared';
import type {
  ItemCategory,
  MeetupStatus,
  PlaceCategory,
  PriceSource,
  ReviewStatus,
  SuggestionEmptyReason,
  TicketType,
} from '@tablemate/shared';

/** The instant every case is measured from: 2026-11-20T12:00:00Z. */
const NOW = new Date(Date.UTC(2026, 10, 20, 12));

/** The pair's shared per-person budget in the budget and ranking cases: a 1,000-cent deposit's default. */
const BUDGET_CENTS = 3000;

/** `days` before {@link NOW}, plus `extraMs`: the staleness boundaries turn on a millisecond past a window. */
function ago(days: number, extraMs = 0): Date {
  return new Date(NOW.getTime() - days * DAY_MS - extraMs);
}

/** A counter, so two rows built without an id are still distinct for the id tiebreak. */
let nextRowId = 0;

/** One `PriceRecord` row as `candidates.ts` maps it (AAP 0.5.2): an approved online menu of a day ago. */
function price(overrides: Partial<PriceRow> = {}): PriceRow {
  nextRowId += 1;
  return {
    id: `row-${nextRowId}`,
    captureBatchId: 'batch-1',
    itemName: 'Pasta',
    normalizedName: 'pasta',
    itemCategory: 'main',
    alcoholic: null,
    perPerson: null,
    ticketType: null,
    priceUsdCents: 1200,
    source: 'online_menu',
    sourceUrl: 'https://example.test/menu',
    reviewStatus: 'approved',
    capturedAt: ago(1),
    ...overrides,
  };
}

/** One item of a capture batch: the fields the rows of a batch differ in. */
interface ItemSpec {
  readonly name: string;
  readonly cents: number;
  readonly category?: ItemCategory;
  readonly reviewStatus?: ReviewStatus;
  /** Only a `drink` reads this, and only `false` estimates one (AAP 0.5.7). */
  readonly alcoholic?: boolean | null;
  /** Only a `ticket` carries this and `ticketType` (AAP 0.5.6). */
  readonly perPerson?: boolean | null;
  readonly ticketType?: TicketType | null;
}

/**
 * One capture batch of `source` taken at one instant — one fetch, one phone call or one operator entry
 * (AAP 0.5.2) — holding a row per item listed. The batch id stands in for the time-ordered UUIDv7 of
 * production, and each row keeps the builder's own id, so the id tiebreak never decides a case by accident.
 */
function capture(
  captureBatchId: string,
  source: PriceSource,
  capturedAt: Date,
  items: readonly ItemSpec[],
): PriceRow[] {
  return items.map((item) =>
    price({
      captureBatchId,
      source,
      capturedAt,
      itemName: item.name,
      normalizedName: item.name,
      itemCategory: item.category ?? 'main',
      alcoholic: item.alcoholic ?? null,
      perPerson: item.perPerson ?? null,
      ticketType: item.ticketType ?? null,
      priceUsdCents: item.cents,
      sourceUrl: source === 'operator_entry' ? null : 'https://example.test/menu',
      reviewStatus: item.reviewStatus ?? 'approved',
    }),
  );
}

/** One capture batch holding a single 1,200-cent pasta main, the item the dedupe cases turn on. */
function pastaBatch(captureBatchId: string, source: PriceSource, capturedAt: Date): PriceRow[] {
  return capture(captureBatchId, source, capturedAt, [{ name: 'pasta', cents: 1200 }]);
}

/** The item names of a set of rows, in the order the rule returned them. */
function names(rows: readonly PriceRow[]): string[] {
  return rows.map((row) => row.normalizedName);
}

/** The value `run` throws, or `null` when it returns: keeps an `unknown` catch value typed. */
function thrownBy(run: () => void): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

/** The estimate of a place a case asserts must have one, so the rule's non-null branch is typed. */
function mustEstimate(category: PlaceCategory, rows: readonly PriceRow[]): PlaceEstimate {
  const estimate = estimatePlace(category, rows, NOW);
  if (estimate === null) {
    throw new Error(`expected an estimate for a ${category}`);
  }
  return estimate;
}

// Budget (AAP 0.5.7 "Budget", 0.7.3 assumption 10) ----------------------------------------------

/** A deposit level and the budget it defaults to. */
type DefaultBudgetCase = readonly [depositCents: number, budgetCents: number];

/** A meetup's stored budget and deposit, and the budget its suggestions are ranked against. */
type EffectiveBudgetCase = readonly [
  meetup: { budgetCents: number | null; depositCents: number },
  budgetCents: number,
];

/** A per-person budget and whether the route accepts it. */
type RangeCase = readonly [cents: number, accepted: boolean];

describe('the budget rules', () => {
  it('pins the constants the route and the estimate read (AAP 0.5.4, 0.5.7)', () => {
    expect(DEFAULT_BUDGET_BY_DEPOSIT).toEqual({ 500: 1500, 1000: 3000, 2000: 6000 });
    expect(BUDGET_MIN_CENTS).toBe(500);
    expect(BUDGET_MAX_CENTS).toBe(10_000);
    expect(FRESHNESS_ONLINE_DAYS).toBe(30);
    expect(FRESHNESS_PHONE_OPERATOR_DAYS).toBe(60);
    expect(DAY_MS).toBe(86_400_000);
    expect(HOUR_MS).toBe(3_600_000);
    expect(SUGGESTIONS_MAX).toBe(10);
    expect(SUGGESTIONS_PER_CATEGORY_MAX).toBe(3);
    expect(SUGGESTION_BUDGET_FIT_LOW).toBe(0.7);
  });
  const DEFAULT_CASES: readonly DefaultBudgetCase[] = [
    [500, 1500],
    [1000, 3000],
    [2000, 6000],
  ];
  it.each(DEFAULT_CASES)('defaults a %i-cent deposit to a %i-cent budget', (deposit, budget) => {
    expect(defaultBudgetFor(deposit)).toBe(budget);
  });
  it('refuses a deposit that is not one of the three levels', () => {
    // Unreachable through the API — `POST /meetups` answers `422 deposit_invalid` — so this branch is
    // an invariant violation of ours and throws a plain Error rather than an `AppError`.
    expect(() => defaultBudgetFor(750)).toThrowError('deposit_not_a_level');
  });
  const EFFECTIVE_CASES: readonly EffectiveBudgetCase[] = [
    [{ budgetCents: null, depositCents: 1000 }, 3000],
    [{ budgetCents: 2500, depositCents: 1000 }, 2500],
    [{ budgetCents: 500, depositCents: 2000 }, 500],
  ];
  it.each(EFFECTIVE_CASES)(
    'ranks against the stored budget %j, else the deposit default',
    (meetup, budget) => {
      expect(effectiveBudget(meetup)).toBe(budget);
    },
  );
  const RANGE_CASES: readonly RangeCase[] = [
    [499, false],
    [500, true],
    [10_000, true],
    [10_001, false],
  ];
  it.each(RANGE_CASES)('reads the budget %i as in range: %s', (cents, accepted) => {
    expect(isBudgetInRange(cents)).toBe(accepted);
    if (accepted) {
      expect(thrownBy(() => assertBudgetInRange(cents))).toBeNull();
      return;
    }
    const error = thrownBy(() => assertBudgetInRange(cents));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('budget_out_of_range');
    expect((error as AppError).httpStatus).toBe(422);
  });
});

// Freshness and the current set (AAP 0.5.7 "Cost estimation") -----------------------------------

/** A freshness case: the source, the age of its capture in milliseconds, and whether it counts. */
type FreshnessCase = readonly [source: PriceSource, ageMs: number, fresh: boolean];

/** Two sources capturing one item at the same instant, and the record that survives. */
type TieCase = readonly [sources: readonly [PriceSource, PriceSource], winner: PriceSource];

describe('freshness and the current price set', () => {
  // The bound is inclusive: an online menu at 30 days and a phone quote or operator entry at 60 days
  // still count, and one millisecond more does not (AAP 0.5.7).
  const FRESHNESS_CASES: readonly FreshnessCase[] = [
    ['online_menu', FRESHNESS_ONLINE_DAYS * DAY_MS, true],
    ['online_menu', FRESHNESS_ONLINE_DAYS * DAY_MS + 1, false],
    ['phone_quote', FRESHNESS_PHONE_OPERATOR_DAYS * DAY_MS, true],
    ['phone_quote', FRESHNESS_PHONE_OPERATOR_DAYS * DAY_MS + 1, false],
    ['operator_entry', FRESHNESS_PHONE_OPERATOR_DAYS * DAY_MS, true],
    ['operator_entry', 61 * DAY_MS, false],
  ];
  it.each(FRESHNESS_CASES)('reads a %s price of %i ms as fresh: %s', (source, ageMs, fresh) => {
    expect(isFresh(source, new Date(NOW.getTime() - ageMs), NOW)).toBe(fresh);
  });
  it('keeps only the most recent capture batch of each source', () => {
    const older = capture('batch-a', 'online_menu', ago(10), [
      { name: 'pasta', cents: 1200 },
      { name: 'soup', cents: 500 },
    ]);
    const newer = capture('batch-b', 'online_menu', ago(2), [{ name: 'pasta', cents: 1300 }]);
    const set = currentSet([...older, ...newer], NOW);
    // The older batch is superseded whole: its pasta loses to the newer capture, and its soup, absent
    // from the newer batch, goes with it rather than keeping a stale price alive.
    expect(names(set)).toEqual(['pasta']);
    expect(set[0]?.priceUsdCents).toBe(1300);
  });
  it('keeps one batch per source and the latest capture of an item across them', () => {
    const rows = [
      ...pastaBatch('batch-online', 'online_menu', ago(5)),
      ...capture('batch-phone', 'phone_quote', ago(2), [
        { name: 'pasta', cents: 1100 },
        { name: 'coffee', cents: 300, category: 'drink', alcoholic: false },
      ]),
    ];
    // Both sources count, and the phone's newer pasta supersedes the online one. The set is ordered by
    // category, so the drink comes first (AAP 0.5.7).
    expect(currentSet(rows, NOW).map((row) => `${row.normalizedName}:${row.source}`)).toEqual([
      'coffee:phone_quote',
      'pasta:phone_quote',
    ]);
  });
  const TIE_CASES: readonly TieCase[] = [
    [['online_menu', 'phone_quote'], 'phone_quote'],
    [['online_menu', 'operator_entry'], 'operator_entry'],
    [['phone_quote', 'operator_entry'], 'operator_entry'],
  ];
  it.each(TIE_CASES)(
    'breaks a capture-time tie between %j by the source order',
    (sources, winner) => {
      const rows = sources.flatMap((source) => pastaBatch(`batch-${source}`, source, ago(3)));
      const set = currentSet(rows, NOW);
      expect(set).toHaveLength(1);
      expect(set[0]?.source).toBe(winner);
      // The same order `priceSource` reads: operator_entry, then phone_quote, then online_menu.
      expect(SOURCE_PRIORITY.operator_entry).toBeLessThan(SOURCE_PRIORITY.phone_quote);
      expect(SOURCE_PRIORITY.phone_quote).toBeLessThan(SOURCE_PRIORITY.online_menu);
    },
  );
  it('drops a record waiting for operator review, and a batch past its freshness window', () => {
    const waiting = capture('batch-phone', 'phone_quote', ago(1), [
      { name: 'pasta', cents: 1200, reviewStatus: 'needs_review' },
      { name: 'soup', cents: 600 },
    ]);
    const stale = pastaBatch('batch-old', 'online_menu', ago(FRESHNESS_ONLINE_DAYS, 1));
    // A phone quote stored `needs_review` waits for an operator instead of feeding an estimate
    // (AAP 0.5.6); a batch past its window is not a price the pair can plan on at all (AAP 0.5.7).
    expect(names(currentSet(waiting, NOW))).toEqual(['soup']);
    expect(currentSet(stale, NOW)).toEqual([]);
  });
  it('counts an item once however often it was captured', () => {
    // Three captures of one source in a row, then the same item captured again from each source in
    // turn: either way the set holds exactly one pasta record.
    const repeats = ['batch-1', 'batch-2', 'batch-3'].flatMap((id, index) =>
      pastaBatch(id, 'online_menu', ago(5 - index)),
    );
    const acrossSources = [
      ...pastaBatch('batch-online', 'online_menu', ago(4)),
      ...pastaBatch('batch-phone', 'phone_quote', ago(3)),
      ...pastaBatch('batch-operator', 'operator_entry', ago(2)),
    ];
    expect(currentSet(repeats, NOW)).toHaveLength(1);
    expect(currentSet(acrossSources, NOW)).toHaveLength(1);
  });
});

// The per-person estimate (AAP 0.5.7 "Cost estimation", 0.5.6 for the ticket fields) ------------

/** A median case: the values, and the cents the rule returns. */
type MedianCase = readonly [values: readonly number[], median: number];

/** A case whose only drink does not count: the label, and the drink row. */
type DrinkCase = readonly [label: string, drinks: readonly ItemSpec[]];

describe('medianHalfUp', () => {
  const MEDIAN_CASES: readonly MedianCase[] = [
    [[1000], 1000],
    [[1000, 1201], 1101],
    [[100, 200, 300], 200],
    [[101, 102], 102],
    [[1, 2, 3, 4], 3],
  ];
  it.each(MEDIAN_CASES)('reads the median of %j as %i cents', (values, median) => {
    // An even count takes the mean of the two middle values rounded half up, so 1,100.5 cents is
    // 1,101 and 101.5 cents is 102 (AAP 0.5.7).
    expect(medianHalfUp(values)).toBe(median);
  });
});

describe('the food and drink estimate', () => {
  /** One menu: three mains, two non-alcoholic drinks, a beer, an unknown-flag juice, a starter and a dessert. */
  const FOOD_ROWS = capture('batch-menu', 'online_menu', ago(1), [
    { name: 'pasta', cents: 1000 },
    { name: 'curry', cents: 1200 },
    { name: 'steak', cents: 1500 },
    { name: 'water', cents: 300, category: 'drink', alcoholic: false },
    { name: 'tea', cents: 400, category: 'drink', alcoholic: false },
    { name: 'beer', cents: 500, category: 'drink', alcoholic: true },
    { name: 'juice', cents: 350, category: 'drink', alcoholic: null },
    { name: 'salad', cents: 400, category: 'starter' },
    { name: 'cake', cents: 450, category: 'dessert' },
  ]);
  it.each(['restaurant', 'cafe', 'bar'] as const)(
    'estimates a %s from its mains and its non-alcoholic drinks',
    (category) => {
      const estimate = mustEstimate(category, FOOD_ROWS);
      // The median main (1,200) plus the median non-alcoholic drink (the 350 of water and tea), and
      // the range from the cheapest pair to the dearest (1,000 + 300 to 1,500 + 400). The provenance
      // holds exactly those five rows: the beer and the unknown-flag juice are excluded for their
      // alcohol field, and a starter and a dessert never enter a food estimate (AAP 0.5.7).
      expect(estimate.estimateCents).toBe(1550);
      expect(estimate.lowCents).toBe(1300);
      expect(estimate.highCents).toBe(1900);
      expect(names(estimate.itemsUsed)).toEqual(['water', 'tea', 'pasta', 'curry', 'steak']);
    },
  );
  const DRINK_CASES: readonly DrinkCase[] = [
    [
      'an unknown alcohol flag',
      [{ name: 'juice', cents: 900, category: 'drink', alcoholic: null }],
    ],
    ['an alcoholic drink', [{ name: 'beer', cents: 900, category: 'drink', alcoholic: true }]],
  ];
  it.each(DRINK_CASES)(
    'estimates a meal whose only drink has %s from its main alone',
    (_, drinks) => {
      const estimate = mustEstimate(
        'restaurant',
        capture('batch-1', 'online_menu', ago(1), [{ name: 'pasta', cents: 1200 }, ...drinks]),
      );
      expect(estimate.estimateCents).toBe(1200);
      expect(estimate.lowCents).toBe(1200);
      expect(estimate.highCents).toBe(1200);
      expect(names(estimate.itemsUsed)).toEqual(['pasta']);
    },
  );
  it('estimates a meal with no drink priced from its mains alone', () => {
    const rows = capture('batch-1', 'online_menu', ago(1), [
      { name: 'pasta', cents: 1000 },
      { name: 'curry', cents: 1200 },
      { name: 'steak', cents: 1500 },
    ]);
    const estimate = mustEstimate('bar', rows);
    expect(estimate.estimateCents).toBe(1200);
    expect(estimate.lowCents).toBe(1000);
    expect(estimate.highCents).toBe(1500);
    expect(names(estimate.itemsUsed)).toEqual(['pasta', 'curry', 'steak']);
  });
  it.each(['restaurant', 'cafe', 'bar'] as const)('leaves a %s with no main out', (category) => {
    const rows = capture('batch-1', 'online_menu', ago(1), [
      { name: 'water', cents: 300, category: 'drink', alcoholic: false },
      { name: 'salad', cents: 400, category: 'starter' },
      { name: 'cake', cents: 450, category: 'dessert' },
    ]);
    // A price is never guessed: a place the estimate cannot price is left out (AAP 0.5.7).
    expect(estimatePlace(category, rows, NOW)).toBeNull();
  });
});

describe('the activity estimate', () => {
  /** One ticket page: two standard adult fares, a concession, a family ticket and a group adult fare. */
  const TICKET_ROWS = capture('batch-tickets', 'operator_entry', ago(1), [
    { name: 'adult-day', cents: 1500, category: 'ticket', perPerson: true, ticketType: 'standard' },
    {
      name: 'adult-night',
      cents: 2000,
      category: 'ticket',
      perPerson: true,
      ticketType: 'standard',
    },
    { name: 'child', cents: 800, category: 'ticket', perPerson: true, ticketType: 'concession' },
    { name: 'family', cents: 5000, category: 'ticket', perPerson: false, ticketType: 'group' },
    {
      name: 'group-adult',
      cents: 1000,
      category: 'ticket',
      perPerson: false,
      ticketType: 'standard',
    },
  ]);
  it('estimates an activity from its cheapest standard per-person ticket', () => {
    const estimate = mustEstimate('activity', TICKET_ROWS);
    // Concession, group and non-per-person fares never enter: the estimate is the lowest standard
    // adult fare and the range runs between the standard adult fares (AAP 0.5.6, 0.5.7).
    expect(estimate.estimateCents).toBe(1500);
    expect(estimate.lowCents).toBe(1500);
    expect(estimate.highCents).toBe(2000);
    expect(names(estimate.itemsUsed)).toEqual(['adult-day', 'adult-night']);
  });
  it('leaves an activity out when only concession or group fares are priced', () => {
    const rows = TICKET_ROWS.filter(
      (row) => row.ticketType !== 'standard' || row.perPerson !== true,
    );
    expect(estimatePlace('activity', rows, NOW)).toBeNull();
  });
});

describe('the estimate provenance', () => {
  it('names the source contributing the most items used, and breaks a tie by the source order', () => {
    const threeOnline = capture('batch-online', 'online_menu', ago(4), [
      { name: 'pasta', cents: 1000 },
      { name: 'curry', cents: 1200 },
      { name: 'steak', cents: 1500 },
    ]);
    const onePhone = capture('batch-phone', 'phone_quote', ago(3), [
      { name: 'water', cents: 300, category: 'drink', alcoholic: false },
    ]);
    const twoOnline = capture('batch-menu', 'online_menu', ago(2), [
      { name: 'risotto', cents: 1100 },
      { name: 'fish', cents: 1400 },
    ]);
    const twoDrinks = capture('batch-call', 'phone_quote', ago(1), [
      { name: 'coffee', cents: 300, category: 'drink', alcoholic: false },
      { name: 'tea', cents: 400, category: 'drink', alcoholic: false },
    ]);
    // Two items each: the phone quote wins, as it outranks the online menu (AAP 0.5.7).
    const tie = mustEstimate('cafe', [...twoOnline, ...twoDrinks]);
    expect(names(tie.itemsUsed)).toHaveLength(4);
    expect(tie.priceSource).toBe('phone_quote');
    // Three items against one: the majority source wins, whatever its rank.
    const majority = mustEstimate('restaurant', [...threeOnline, ...onePhone]);
    expect(names(majority.itemsUsed)).toHaveLength(4);
    expect(majority.priceSource).toBe('online_menu');
  });
  it('dates the estimate by the oldest capture among the items used', () => {
    const rows = [
      ...pastaBatch('batch-online', 'online_menu', ago(10)),
      ...capture('batch-phone', 'phone_quote', ago(2), [
        { name: 'water', cents: 300, category: 'drink', alcoholic: false },
      ]),
    ];
    const estimate = mustEstimate('restaurant', rows);
    expect(estimate.priceVerifiedAt.getTime()).toBe(ago(10).getTime());
    expect(estimate.priceSource).toBe('phone_quote');
  });
});

// Ranking and the empty states (AAP 0.5.7 "Ranking", "Suggestion filtering") --------------------

/** A budget case: the estimate, whether it fits, and whether it falls in the 70%-100% band. */
type FitCase = readonly [estimateCents: number, fits: boolean, inBand: boolean];

/** A ranking candidate as `[placeId, category, is a partner venue, distance in metres, estimate]`. */
type CandidateCase = readonly [
  placeId: string,
  category: PlaceCategory,
  partner: boolean,
  distanceM: number,
  estimateCents: number,
];

/** An empty-state case: the surviving counts and the reason they name. */
type EmptyCase = readonly [counts: SuggestionCounts, reason: SuggestionEmptyReason | undefined];

/** The candidates of a case table in the rule's own input shape. */
function rankItems(cases: readonly CandidateCase[]): RankInput[] {
  return cases.map(([placeId, category, partner, distanceM, estimateCents]) => ({
    placeId,
    category,
    isPartnerVenue: partner,
    distanceM,
    estimateCents,
  }));
}

describe('the budget filter and the ranking band', () => {
  const FIT_CASES: readonly FitCase[] = [
    [2100, true, true],
    [2099, true, false],
    [3000, true, true],
    [3001, false, false],
  ];
  it.each(FIT_CASES)(
    'reads the estimate %i as fitting %s and in band %s',
    (estimate, fits, band) => {
      expect(fitsBudget(estimate, BUDGET_CENTS)).toBe(fits);
      expect(inFitBand(estimate, BUDGET_CENTS)).toBe(band);
    },
  );
  it('starts the band at 70% of the budget, both ends inclusive', () => {
    const bandFloor = Math.floor(SUGGESTION_BUDGET_FIT_LOW * BUDGET_CENTS);
    expect(bandFloor).toBe(2100);
    expect(inFitBand(bandFloor, BUDGET_CENTS)).toBe(true);
    expect(inFitBand(bandFloor - 1, BUDGET_CENTS)).toBe(false);
    expect(inFitBand(BUDGET_CENTS, BUDGET_CENTS)).toBe(true);
    expect(fitsBudget(BUDGET_CENTS + 1, BUDGET_CENTS)).toBe(false);
  });
});

describe('rankSuggestions', () => {
  /**
   * Fourteen candidates against a 3,000-cent budget where the five partner venues are also the best ranking
   * group: four restaurants (one of them the fourth of its category), a cafe, an activity, and non-partners
   * both inside the band and cheaper than it, plus one candidate priced above the budget.
   */
  const CANDIDATE_CASES: readonly CandidateCase[] = [
    ['p-cafe-1', 'cafe', true, 200, 2600],
    ['p-rest-1', 'restaurant', true, 300, 2400],
    ['p-rest-2', 'restaurant', true, 350, 2500],
    ['p-rest-3', 'restaurant', true, 400, 2600],
    ['p-act-1', 'activity', true, 500, 2100],
    ['n-cafe-1', 'cafe', false, 100, 2900],
    ['n-rest-1', 'restaurant', false, 150, 3000],
    ['n-bar-1', 'bar', false, 250, 2350],
    ['n-act-1', 'activity', false, 600, 2200],
    ['n-bar-2', 'bar', false, 700, 2450],
    ['n-cafe-2', 'cafe', false, 50, 1200],
    ['n-rest-2', 'restaurant', false, 80, 900],
    ['n-act-2', 'activity', false, 120, 1800],
    ['n-rest-over', 'restaurant', false, 10, 3100],
  ];
  it('ranks the partners, then the band, then distance, and applies both limits', () => {
    const inputs = rankItems(CANDIDATE_CASES);
    const ranked = rankSuggestions(inputs, BUDGET_CENTS);
    const kept = ranked.map((item) => item.placeId);
    // The five partner venues come first in ascending distance, then the in-band non-partners, then
    // the cheaper ones. `n-rest-1` is the fourth restaurant and is skipped by the per-category limit,
    // the ten results are reached at `n-cafe-2`, and `n-rest-over` — above the budget — was dropped by
    // the filter this function applies itself, so no caller has to pre-filter (AAP 0.5.7).
    expect(kept).toEqual([
      'p-cafe-1',
      'p-rest-1',
      'p-rest-2',
      'p-rest-3',
      'p-act-1',
      'n-cafe-1',
      'n-bar-1',
      'n-act-1',
      'n-bar-2',
      'n-cafe-2',
    ]);
    expect(ranked).toHaveLength(SUGGESTIONS_MAX);
    expect(kept).not.toContain('n-rest-over');
    expect(kept).not.toContain('n-rest-1');
    expect(kept).not.toContain('n-rest-2');
    expect(kept).not.toContain('n-act-2');
    for (const category of ['restaurant', 'cafe', 'bar', 'activity'] as const) {
      const inCategory = ranked.filter((item) => item.category === category);
      expect(inCategory.length).toBeLessThanOrEqual(SUGGESTIONS_PER_CATEGORY_MAX);
    }
    // The candidates are ordered without mutating the caller's array.
    expect(inputs.map((item) => item.placeId)).toEqual(CANDIDATE_CASES.map(([placeId]) => placeId));
  });
  it('orders on the four ranking keys, the place id last', () => {
    // A partner cheaper than the band, two partners identical but for their ids, an in-band
    // non-partner, and a cheaper non-partner nearer than every other candidate.
    const orderCases: readonly CandidateCase[] = [
      ['z-cheap-near', 'bar', false, 10, 1000],
      ['a-band-far', 'cafe', false, 900, 2100],
      ['b-partner-cheap', 'bar', true, 800, 600],
      ['c-partner-band', 'cafe', true, 700, 3000],
      ['d-partner-twin', 'activity', true, 700, 3000],
    ];
    expect(RANK_KEYS).toHaveLength(4);
    expect(
      rankSuggestions(rankItems(orderCases), BUDGET_CENTS).map((item) => item.placeId),
    ).toEqual([
      'c-partner-band',
      'd-partner-twin',
      'b-partner-cheap',
      'a-band-far',
      'z-cheap-near',
    ]);
    const left: RankInput = {
      placeId: 'x-1',
      category: 'bar',
      isPartnerVenue: true,
      distanceM: 10,
      estimateCents: 2000,
    };
    const right: RankInput = { ...left, placeId: 'y-2' };
    expect(compareRank(left, right, BUDGET_CENTS)).toBeLessThan(0);
    expect(compareRank(right, left, BUDGET_CENTS)).toBeGreaterThan(0);
    expect(compareRank(left, { ...left }, BUDGET_CENTS)).toBe(0);
  });
});

describe('emptyReasonFor', () => {
  const EMPTY_CASES: readonly EmptyCase[] = [
    [{ pricedCount: 0, openCount: 0, fittingCount: 0 }, 'no_priced_places'],
    [{ pricedCount: 4, openCount: 0, fittingCount: 0 }, 'none_open'],
    [{ pricedCount: 4, openCount: 2, fittingCount: 0 }, 'budget_too_low'],
    [{ pricedCount: 4, openCount: 2, fittingCount: 1 }, undefined],
    [{ pricedCount: 0, openCount: 3, fittingCount: 3 }, 'no_priced_places'],
  ];
  it.each(EMPTY_CASES)('names %j as %s', (counts, reason) => {
    // The stages are nested, so the first zero count is the reason: no priced place is
    // `no_priced_places` even where the later counts are zero as well (AAP 0.5.7).
    expect(emptyReasonFor(counts)).toBe(reason);
  });
});

// Eligibility (AAP 0.5.4, 0.7.3) ----------------------------------------------------------------

/** An eligibility case: the status, how long ago the outcome was applied, and the verdict. */
type EligibilityCase = readonly [
  status: MeetupStatus,
  settledAgoMs: number | null,
  eligible: boolean,
];

describe('suggestionsEligible', () => {
  const ELIGIBILITY_CASES: readonly EligibilityCase[] = [
    ['locked', null, true],
    ['completed', 23 * HOUR_MS + 59 * 60_000, true],
    ['completed', 24 * HOUR_MS, true],
    ['completed', 24 * HOUR_MS + 1, false],
    ['completed', null, false],
    ['proposed', null, false],
    ['forfeited', 1 * HOUR_MS, false],
    ['unattended', 1 * HOUR_MS, false],
    ['cancelled', 1 * HOUR_MS, false],
    ['lock_lost', 1 * HOUR_MS, false],
    ['no_fault', 1 * HOUR_MS, false],
  ];
  it.each(ELIGIBILITY_CASES)(
    'reads a %s meetup settled %s ms ago as eligible: %s',
    (status, settledAgoMs, eligible) => {
      // A locked meetup is always served; a completed one only until 24 hours have passed since its
      // outcome was applied, both ends inclusive; every other status carries no plan (AAP 0.7.3).
      const settledAt = settledAgoMs === null ? null : new Date(NOW.getTime() - settledAgoMs);
      expect(suggestionsEligible(status, settledAt, NOW)).toBe(eligible);
    },
  );
});
