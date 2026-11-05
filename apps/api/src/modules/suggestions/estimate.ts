/**
 * Cost estimation from real, fresh price records for the day-plan suggestions (AAP 0.5.7).
 *
 * `estimatePlace` turns a place's stored `PriceRecord` rows into the per-person estimate, the range
 * around it and the provenance the suggestion reports, using only records that are real, fresh and
 * approved. A price is never invented or interpolated: a place that lacks the items its category
 * needs is left out of the suggestions rather than shown with a guess (request item 13).
 *
 * Pure by design — `now` is a parameter and nothing outside `@tablemate/shared` is imported — so
 * `apps/api/test/unit/suggestions-rules.test.ts` exercises every rule in-process.
 *
 * @see AAP 0.5.7 "Cost estimation" and "Suggestion filtering", 0.5.6 for the ticket fields.
 */

import { DAY_MS, FRESHNESS_ONLINE_DAYS, FRESHNESS_PHONE_OPERATOR_DAYS } from '@tablemate/shared';
import type {
  ItemCategory,
  PlaceCategory,
  PriceSource,
  ReviewStatus,
  TicketType,
} from '@tablemate/shared';

// ---------------------------------------------------------------------------------------------
// Row and result shapes (AAP 0.5.2, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * One `PriceRecord` row as `candidates.ts` maps it from SQL, reduced to the fields the estimate
 * reads (AAP 0.5.2). Internal to the module, not a shared schema: the response carries the narrower
 * `SuggestionItemUsed` contract shape instead.
 */
export interface PriceRow {
  readonly id: string;
  /** One fetch, one phone call or one operator entry, grouped into a capture batch (AAP 0.5.2). */
  readonly captureBatchId: string;
  readonly itemName: string;
  readonly normalizedName: string;
  readonly itemCategory: ItemCategory;
  /** `true`/`false` when the source states it, `null` when unknown; only `false` estimates drinks. */
  readonly alcoholic: boolean | null;
  /** Set on a `ticket` row: `true` when the price admits one person (AAP 0.5.6). */
  readonly perPerson: boolean | null;
  /** Set on a `ticket` row; an admission that is not `standard` never enters an estimate. */
  readonly ticketType: TicketType | null;
  readonly priceUsdCents: number;
  readonly source: PriceSource;
  /** An `http(s)` URL for a menu, `tel:<number>` for a quote, `null` for an operator entry. */
  readonly sourceUrl: string | null;
  readonly reviewStatus: ReviewStatus;
  readonly capturedAt: Date;
}

/**
 * A place's per-person estimate for the meetup day (AAP 0.5.7): the typical `estimateCents`, the
 * cheapest to most expensive `lowCents`..`highCents`, and the provenance the response reports.
 */
export interface PlaceEstimate {
  readonly estimateCents: number;
  readonly lowCents: number;
  readonly highCents: number;
  readonly itemsUsed: readonly PriceRow[];
  /** The source contributing the most items used; ties follow `SOURCE_PRIORITY`. */
  readonly priceSource: PriceSource;
  /** The oldest `capturedAt` among `itemsUsed`: how current the least current price is. */
  readonly priceVerifiedAt: Date;
}

// ---------------------------------------------------------------------------------------------
// Source and freshness rules (AAP 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * Which source wins when two current records are otherwise equal: the AAP's tie order
 * "operator_entry, then phone_quote, then online_menu" (AAP 0.5.7). A lower number wins, and this
 * one table serves both the record tie in {@link currentSet} and the `priceSource` tie below.
 */
export const SOURCE_PRIORITY: Readonly<Record<PriceSource, number>> = {
  operator_entry: 0,
  phone_quote: 1,
  online_menu: 2,
};

/** Days a price of each source stays fresh, from the AAP's 30 and 60 day windows (AAP 0.5.7). */
const FRESHNESS_DAYS_BY_SOURCE: Readonly<Record<PriceSource, number>> = {
  online_menu: FRESHNESS_ONLINE_DAYS,
  phone_quote: FRESHNESS_PHONE_OPERATOR_DAYS,
  operator_entry: FRESHNESS_PHONE_OPERATOR_DAYS,
};

/**
 * Whether a price record is fresh enough to estimate from: at most 30 days old for an online menu,
 * at most 60 days for a phone quote or an operator entry (AAP 0.5.7).
 *
 * The authoritative freshness rule: `candidates.ts` prefilters rows by the widest window (60 days)
 * and approval alone, so the per-source limits live here. The bound is inclusive, and a `capturedAt`
 * later than `now` counts as fresh rather than as stale.
 */
export function isFresh(source: PriceSource, capturedAt: Date, now: Date): boolean {
  return now.getTime() - capturedAt.getTime() <= FRESHNESS_DAYS_BY_SOURCE[source] * DAY_MS;
}

// ---------------------------------------------------------------------------------------------
// The current price set (AAP 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * A place's current price set (AAP 0.5.7): the approved, fresh records that survive both dedupe
 * rules, ordered by `itemCategory`, then price ascending, then `normalizedName`, then `id` — also
 * the order `PlaceEstimate.itemsUsed` reports them in.
 *
 * Only the most recent capture batch of each source is kept, a batch being one fetch, one call or
 * one operator entry; then, across those batches, each `(itemCategory, normalizedName)` keeps only
 * its latest record, so repeated captures never double-weight an item. A batch's recency is its
 * latest `capturedAt`, and two batches captured at the same instant are separated by the
 * lexicographically larger `captureBatchId`, because UUIDv7 ids are time-ordered. Two equally
 * recent records of one item are separated by `SOURCE_PRIORITY` and then the smallest `id`, so the
 * result is deterministic whatever order the rows arrive in. A record that is not `approved` is
 * dropped here: a phone quote stored `needs_review` waits for an operator (AAP 0.5.6).
 */
export function currentSet(rows: readonly PriceRow[], now: Date): PriceRow[] {
  const usable = rows.filter(
    (row) => row.reviewStatus === 'approved' && isFresh(row.source, row.capturedAt, now),
  );
  return latestRecordPerItem(latestBatchPerSource(usable)).sort(compareRows);
}

/** A capture batch while it is being compared: its source, its rows, its latest capture time. */
interface Batch {
  readonly source: PriceSource;
  readonly rows: PriceRow[];
  latest: number;
}

/** Keeps the most recent capture batch of each source (AAP 0.5.7). */
function latestBatchPerSource(rows: readonly PriceRow[]): PriceRow[] {
  const batches = new Map<string, Batch>();
  for (const row of rows) {
    const key = `${row.source}\u0000${row.captureBatchId}`;
    const batch = batches.get(key) ?? { source: row.source, rows: [], latest: 0 };
    batch.rows.push(row);
    batch.latest = Math.max(batch.latest, row.capturedAt.getTime());
    batches.set(key, batch);
  }

  const newestFirst = [...batches.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      compareText(left.source, right.source) ||
      right.latest - left.latest ||
      compareText(rightKey, leftKey),
  );

  const seen = new Set<PriceSource>();
  const kept: PriceRow[] = [];
  for (const [, batch] of newestFirst) {
    if (seen.has(batch.source)) {
      continue;
    }
    seen.add(batch.source);
    kept.push(...batch.rows);
  }
  return kept;
}

/** Keeps the single latest record of each `(itemCategory, normalizedName)` item (AAP 0.5.7). */
function latestRecordPerItem(rows: readonly PriceRow[]): PriceRow[] {
  const latestByItem = new Map<string, PriceRow>();
  for (const row of rows) {
    const key = `${row.itemCategory}\u0000${row.normalizedName}`;
    const current = latestByItem.get(key);
    if (current === undefined || isNewerRecord(row, current)) {
      latestByItem.set(key, row);
    }
  }
  return [...latestByItem.values()];
}

/** Whether `candidate` supersedes `current` for the same item: newer, then source, then id. */
function isNewerRecord(candidate: PriceRow, current: PriceRow): boolean {
  const candidateAt = candidate.capturedAt.getTime();
  const currentAt = current.capturedAt.getTime();
  if (candidateAt !== currentAt) {
    return candidateAt > currentAt;
  }
  const candidateRank = SOURCE_PRIORITY[candidate.source];
  const currentRank = SOURCE_PRIORITY[current.source];
  return candidateRank === currentRank ? candidate.id < current.id : candidateRank < currentRank;
}

/** The order `currentSet` and `itemsUsed` report rows in: category, price, name, id. */
function compareRows(left: PriceRow, right: PriceRow): number {
  return (
    compareText(left.itemCategory, right.itemCategory) ||
    left.priceUsdCents - right.priceUsdCents ||
    compareText(left.normalizedName, right.normalizedName) ||
    compareText(left.id, right.id)
  );
}

/** A code-unit string comparison, so the ordering never depends on the host locale. */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

// ---------------------------------------------------------------------------------------------
// Medians (AAP 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The median of `values` in integer USD cents, an even count taking the mean of the two middle
 * values rounded half up (AAP 0.5.7): `Math.floor((lower + upper + 1) / 2)` is exact for
 * non-negative integers, so 1001 and 1002 give 1002. Callers check the set for emptiness first, so
 * an empty input is a programming error rather than a data condition.
 */
export function medianHalfUp(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  const upper = sorted[middle];
  if (upper === undefined) {
    throw new Error('medianHalfUp requires at least one value.');
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1];
  if (lower === undefined) {
    throw new Error('medianHalfUp requires at least one value.');
  }
  return Math.floor((lower + upper + 1) / 2);
}

// ---------------------------------------------------------------------------------------------
// Estimation (AAP 0.5.7)
// ---------------------------------------------------------------------------------------------

/** An estimate before its provenance is attached. */
interface CategoryEstimate {
  readonly estimateCents: number;
  readonly lowCents: number;
  readonly highCents: number;
  readonly itemsUsed: readonly PriceRow[];
}

/** One category's rule: the estimate its current price set produces, or `null` when it cannot. */
type CategoryRule = (set: readonly PriceRow[]) => CategoryEstimate | null;

/**
 * A restaurant, cafe or bar: the median main course plus the median non-alcoholic drink (AAP
 * 0.5.7). A drink whose `alcoholic` flag is `true` or unknown is excluded, and when no
 * non-alcoholic drink exists the main course alone counts. Starters and desserts never enter.
 */
function estimateFoodAndDrink(set: readonly PriceRow[]): CategoryEstimate | null {
  const mainPrices = pricesOf(set, (row) => row.itemCategory === 'main');
  if (mainPrices.length === 0) {
    return null;
  }
  const drinkPrices = pricesOf(set, isNonAlcoholicDrink);
  const drinkEstimate = drinkPrices.length === 0 ? 0 : medianHalfUp(drinkPrices);
  const drinkLow = drinkPrices.length === 0 ? 0 : Math.min(...drinkPrices);
  const drinkHigh = drinkPrices.length === 0 ? 0 : Math.max(...drinkPrices);

  return {
    estimateCents: medianHalfUp(mainPrices) + drinkEstimate,
    lowCents: Math.min(...mainPrices) + drinkLow,
    highCents: Math.max(...mainPrices) + drinkHigh,
    itemsUsed: set.filter((row) => row.itemCategory === 'main' || isNonAlcoholicDrink(row)),
  };
}

/**
 * An activity: its lowest listed standard per-person ticket (AAP 0.5.7). A concession or group
 * admission is never used, and neither is a price that does not admit one person, so an activity
 * priced only that way is left out of the suggestions (AAP 0.5.6).
 */
function estimateActivity(set: readonly PriceRow[]): CategoryEstimate | null {
  const tickets = set.filter(
    (row) =>
      row.itemCategory === 'ticket' && row.perPerson === true && row.ticketType === 'standard',
  );
  if (tickets.length === 0) {
    return null;
  }
  const ticketPrices = tickets.map((row) => row.priceUsdCents);
  const lowest = Math.min(...ticketPrices);
  return {
    estimateCents: lowest,
    lowCents: lowest,
    highCents: Math.max(...ticketPrices),
    itemsUsed: tickets,
  };
}

/** The category-to-rule table; every `PlaceCategory` has exactly one rule (AAP 0.5.7). */
const CATEGORY_RULES: Readonly<Record<PlaceCategory, CategoryRule>> = {
  restaurant: estimateFoodAndDrink,
  cafe: estimateFoodAndDrink,
  bar: estimateFoodAndDrink,
  activity: estimateActivity,
};

/**
 * A place's per-person cost estimate for the meetup day, or `null` when its current price set cannot
 * produce one (AAP 0.5.7).
 *
 * The estimate comes only from {@link currentSet}, deduped per batch and per item. `priceSource` is
 * the source contributing the most `itemsUsed`, ties by `SOURCE_PRIORITY`, and `priceVerifiedAt` is
 * the oldest `capturedAt` among them. Nothing is interpolated, so `null` means the place is left
 * out, never shown with a guessed price.
 */
export function estimatePlace(
  category: PlaceCategory,
  rows: readonly PriceRow[],
  now: Date,
): PlaceEstimate | null {
  const estimate = CATEGORY_RULES[category](currentSet(rows, now));
  if (estimate === null) {
    return null;
  }
  return {
    ...estimate,
    priceSource: dominantSource(estimate.itemsUsed),
    priceVerifiedAt: oldestCapturedAt(estimate.itemsUsed),
  };
}

/** The prices of the set's rows that match `matches`, in set order. */
function pricesOf(set: readonly PriceRow[], matches: (row: PriceRow) => boolean): number[] {
  return set.filter(matches).map((row) => row.priceUsdCents);
}

/** A drink the source states is non-alcoholic; an unknown flag excludes it (AAP 0.5.7). */
function isNonAlcoholicDrink(row: PriceRow): boolean {
  return row.itemCategory === 'drink' && row.alcoholic === false;
}

/** The source contributing the most items used, ties by `SOURCE_PRIORITY` (AAP 0.5.7). */
function dominantSource(items: readonly PriceRow[]): PriceSource {
  const counts = new Map<PriceSource, number>();
  for (const item of items) {
    counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(
    ([leftSource, leftCount], [rightSource, rightCount]) =>
      rightCount - leftCount || SOURCE_PRIORITY[leftSource] - SOURCE_PRIORITY[rightSource],
  );
  const dominant = ranked[0];
  if (dominant === undefined) {
    throw new Error('estimatePlace: an estimate always uses at least one price record.');
  }
  return dominant[0];
}

/** The oldest capture time among the items used, i.e. the least current price read (AAP 0.5.7). */
function oldestCapturedAt(items: readonly PriceRow[]): Date {
  const oldest = Math.min(...items.map((item) => item.capturedAt.getTime()));
  if (!Number.isFinite(oldest)) {
    throw new Error('estimatePlace: an estimate always uses at least one price record.');
  }
  return new Date(oldest);
}
