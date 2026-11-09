/**
 * Cost estimation from real, fresh price records for the day-plan suggestions.
 *
 * `estimatePlace` turns a place's stored `PriceRecord` rows into the per-person estimate, the range around it and the provenance the
 * suggestion reports, using only records that are real, fresh and approved. A price is never invented or interpolated: a place that
 * lacks the items its category needs is left out rather than shown with a guess.
 *
 * Pure by design — `now` is a parameter and nothing outside `@tablemate/shared` is imported.
 */

import { DAY_MS, FRESHNESS_ONLINE_DAYS, FRESHNESS_PHONE_OPERATOR_DAYS } from '@tablemate/shared';
import type {
  ItemCategory,
  PlaceCategory,
  PriceSource,
  ReviewStatus,
  TicketType,
} from '@tablemate/shared';

/** One `PriceRecord` row as `candidates.ts` maps it from SQL, reduced to the fields the estimate reads. Internal to the module: the
 * response carries the narrower `SuggestionItemUsed` contract shape instead. */
export interface PriceRow {
  readonly id: string;
  readonly captureBatchId: string;
  readonly itemName: string;
  readonly normalizedName: string;
  readonly itemCategory: ItemCategory;
  readonly alcoholic: boolean | null;
  /** Set on a `ticket` row: `true` when the price admits one person (AAP 0.5.6). */
  readonly perPerson: boolean | null;
  /** Set on a `ticket` row; an admission that is not `standard` never enters an estimate. */
  readonly ticketType: TicketType | null;
  readonly priceUsdCents: number;
  readonly source: PriceSource;
  readonly sourceUrl: string | null;
  readonly reviewStatus: ReviewStatus;
  readonly capturedAt: Date;
}

/** A place's per-person estimate for the meetup day: the typical `estimateCents`, the cheapest to most expensive
 * `lowCents`..`highCents`, and the provenance the response reports. */
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

/**
 * Which source wins when two current records are otherwise equal, in the AAP's tie order "operator_entry, then phone_quote, then
 * online_menu": a lower number wins, and this one table serves both the record tie in {@link currentSet} and the `priceSource` tie.
 */
export const SOURCE_PRIORITY: Readonly<Record<PriceSource, number>> = {
  operator_entry: 0,
  phone_quote: 1,
  online_menu: 2,
};

const FRESHNESS_DAYS_BY_SOURCE: Readonly<Record<PriceSource, number>> = {
  online_menu: FRESHNESS_ONLINE_DAYS,
  phone_quote: FRESHNESS_PHONE_OPERATOR_DAYS,
  operator_entry: FRESHNESS_PHONE_OPERATOR_DAYS,
};

/**
 * Whether a price record is fresh enough to estimate from: at most 30 days old for an online menu, at most 60 days for a phone quote
 * or an operator entry. The authoritative freshness rule — `candidates.ts` prefilters rows by the widest window and approval alone.
 * The bound is inclusive, and a `capturedAt` later than `now` counts as fresh rather than as stale.
 */
export function isFresh(source: PriceSource, capturedAt: Date, now: Date): boolean {
  return now.getTime() - capturedAt.getTime() <= FRESHNESS_DAYS_BY_SOURCE[source] * DAY_MS;
}

/**
 * A place's current price set: the approved, fresh records that survive both dedupe rules, ordered by `itemCategory`, then price
 * ascending, then `normalizedName`, then `id` — also the order `PlaceEstimate.itemsUsed` reports them in.
 *
 * Only the most recent capture batch of each source is kept, a batch being one fetch, one call or one operator entry; then, across
 * those batches, each `(itemCategory, normalizedName)` keeps only its latest record, so repeated captures never double-weight an item.
 * Two equally recent records of one item are separated by `SOURCE_PRIORITY` and then the smallest `id`. A record that is not
 * `approved` is dropped here: a phone quote stored `needs_review` waits for an operator.
 */
export function currentSet(rows: readonly PriceRow[], now: Date): PriceRow[] {
  const usable = rows.filter(
    (row) => row.reviewStatus === 'approved' && isFresh(row.source, row.capturedAt, now),
  );
  return latestRecordPerItem(latestBatchPerSource(usable)).sort(compareRows);
}

interface Batch {
  readonly source: PriceSource;
  readonly rows: PriceRow[];
  latest: number;
}

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

function compareRows(left: PriceRow, right: PriceRow): number {
  return (
    compareText(left.itemCategory, right.itemCategory) ||
    left.priceUsdCents - right.priceUsdCents ||
    compareText(left.normalizedName, right.normalizedName) ||
    compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * The median of `values` in integer USD cents, an even count taking the mean of the two middle values rounded half up:
 * `Math.floor((lower + upper + 1) / 2)` is exact for non-negative integers. Callers check the set for emptiness first.
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

interface CategoryEstimate {
  readonly estimateCents: number;
  readonly lowCents: number;
  readonly highCents: number;
  readonly itemsUsed: readonly PriceRow[];
}

type CategoryRule = (set: readonly PriceRow[]) => CategoryEstimate | null;

/**
 * A restaurant, cafe or bar: the median main course plus the median non-alcoholic drink. A drink whose `alcoholic` flag is `true` or
 * unknown is excluded, and when no non-alcoholic drink exists the main course alone counts. Starters and desserts never enter.
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
 * An activity: its lowest listed standard per-person ticket. A concession or group admission is never used, and neither is a price
 * that does not admit one person, so an activity priced only that way is left out of the suggestions.
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

const CATEGORY_RULES: Readonly<Record<PlaceCategory, CategoryRule>> = {
  restaurant: estimateFoodAndDrink,
  cafe: estimateFoodAndDrink,
  bar: estimateFoodAndDrink,
  activity: estimateActivity,
};

/**
 * A place's per-person cost estimate for the meetup day, or `null` when its current price set cannot produce one.
 *
 * The estimate comes only from {@link currentSet}, deduped per batch and per item. `priceSource` is the source contributing the most
 * `itemsUsed`, ties by `SOURCE_PRIORITY`, and `priceVerifiedAt` is the oldest `capturedAt` among them. Nothing is interpolated, so
 * `null` means the place is left out, never shown with a guessed price.
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

function pricesOf(set: readonly PriceRow[], matches: (row: PriceRow) => boolean): number[] {
  return set.filter(matches).map((row) => row.priceUsdCents);
}

function isNonAlcoholicDrink(row: PriceRow): boolean {
  return row.itemCategory === 'drink' && row.alcoholic === false;
}

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

function oldestCapturedAt(items: readonly PriceRow[]): Date {
  const oldest = Math.min(...items.map((item) => item.capturedAt.getTime()));
  if (!Number.isFinite(oldest)) {
    throw new Error('estimatePlace: an estimate always uses at least one price record.');
  }
  return new Date(oldest);
}
