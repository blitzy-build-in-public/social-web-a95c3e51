/**
 * Ranking, the category and total limits, and the empty-state reason of the day-plan suggestions
 * behind `GET /meetups/:id/suggestions` (AAP 0.5.7, `apps/api/src/modules/suggestions/routes.ts`).
 *
 * Everything here is pure: the module reads no database, no clock and no other module of the API, so
 * `candidates.ts` hands it a filtered candidate list and `apps/api/test/unit/suggestions-rules.test.ts`
 * exercises every rule in process.
 *
 * Money is integer USD cents throughout: the band test multiplies by 100 instead of comparing against
 * a float share of the budget, so exactly 70% of the budget sits inside the band.
 *
 * @see AAP 0.5.7 for the ranking, filtering and budget rules and AAP 0.12.1 criterion 13 for the
 *       assertions they must satisfy (a 3,000-cent budget, partner venues first, no category more
 *       than three times).
 */

import {
  SUGGESTIONS_MAX,
  SUGGESTIONS_PER_CATEGORY_MAX,
  SUGGESTION_BUDGET_FIT_LOW,
} from '@tablemate/shared';
import type { PlaceCategory, SuggestionEmptyReason } from '@tablemate/shared';

/**
 * The share of the budget, in whole percent, at which the ranking band begins (AAP 0.5.7).
 * Derived from {@link SUGGESTION_BUDGET_FIT_LOW} (0.7) once, so the band's arithmetic below stays
 * integer-only.
 */
const FIT_LOW_PERCENT = Math.round(SUGGESTION_BUDGET_FIT_LOW * 100);

/**
 * The fields the ranking rules read from one suggestion candidate (AAP 0.5.7).
 *
 * `candidates.ts` produces richer objects; this interface names only what ordering and the budget
 * filter depend on, so `rankSuggestions` returns the caller's own type unchanged.
 */
export interface RankInput {
  /** The place's id; also the deterministic final tiebreak of the ranking (AAP 0.5.7). */
  placeId: string;
  /** Which of the four categories the place belongs to; drives the three-per-category limit. */
  category: PlaceCategory;
  /** True for an active partner venue, which ranks before every non-partner place. */
  isPartnerVenue: boolean;
  /** Distance in metres from the meetup venue, ascending within a ranking group. */
  distanceM: number;
  /** The place's per-person point estimate in USD cents (`EstimatedCostRange.estimateCents`). */
  estimateCents: number;
}

/**
 * The hard budget filter of AAP 0.5.7: a place is eligible only when its point estimate is at or
 * under the pair's shared per-person budget.
 *
 * The point estimate is compared, never the estimate range's high end, because the ranking band and
 * the range are both derived from it (AAP 0.5.7 "Cost estimation").
 */
export function fitsBudget(estimateCents: number, budgetCents: number): boolean {
  return estimateCents <= budgetCents;
}

/**
 * Reports whether an estimate falls in the 70%-100% band that AAP 0.5.7 ranks before cheaper places.
 *
 * Both bounds are inclusive and the comparison is cross-multiplied by 100, so a float share never
 * enters the test: an estimate of exactly 70% of the budget is in the band, and 69% is not.
 */
export function inFitBand(estimateCents: number, budgetCents: number): boolean {
  return (
    fitsBudget(estimateCents, budgetCents) && estimateCents * 100 >= FIT_LOW_PERCENT * budgetCents
  );
}

/** One ordered ranking key: it returns the value its items sort by, ascending (AAP 0.5.7). */
type RankKey = (item: RankInput, budgetCents: number) => number | string;

/**
 * The ranking keys in order of precedence, each compared ascending (AAP 0.5.7 "Ranking"):
 *
 * 1. partner venues before non-partner places;
 * 2. estimates in the 70%-100% budget band before cheaper ones — every candidate still standing has
 *    passed {@link fitsBudget}, so a key of 1 here means "cheaper than 70% of the budget";
 * 3. distance from the meetup venue ascending, which orders places inside one group;
 * 4. the place id, a deterministic final tiebreak so two equally ranked places always come back in
 *    the same order.
 */
export const RANK_KEYS: readonly RankKey[] = [
  (item) => (item.isPartnerVenue ? 0 : 1),
  (item, budgetCents) => (inFitBand(item.estimateCents, budgetCents) ? 0 : 1),
  (item) => item.distanceM,
  (item) => item.placeId,
];

/**
 * Compares two candidates for `Array.prototype.sort` under {@link RANK_KEYS} (AAP 0.5.7).
 *
 * The groups hold in order and distance orders within a group; the first key that separates the two
 * items decides, and two items equal on every key compare as 0.
 */
export function compareRank<T extends RankInput>(a: T, b: T, budgetCents: number): number {
  for (const key of RANK_KEYS) {
    const left = key(a, budgetCents);
    const right = key(b, budgetCents);
    if (left === right) {
      continue;
    }
    if (typeof left === 'number' && typeof right === 'number') {
      return left < right ? -1 : 1;
    }
    return String(left) < String(right) ? -1 : 1;
  }
  return 0;
}

/**
 * Ranks the eligible candidates of one meetup and applies the two limits of AAP 0.5.7: at most
 * `SUGGESTIONS_PER_CATEGORY_MAX` (3) results per category and at most `SUGGESTIONS_MAX` (10) in total.
 *
 * Candidates above the budget are dropped first, then the survivors are ordered by {@link compareRank}
 * and walked in rank order, so the kept results are the best-ranked ones and the input array is never
 * mutated. A category that has filled its three places is skipped without stopping the walk, which
 * lets a later category still reach the ten-result ceiling.
 */
export function rankSuggestions<T extends RankInput>(
  items: readonly T[],
  budgetCents: number,
): T[] {
  const eligible = items.filter((item) => fitsBudget(item.estimateCents, budgetCents));
  const ordered = [...eligible].sort((a, b) => compareRank(a, b, budgetCents));

  const perCategory = new Map<PlaceCategory, number>();
  const ranked: T[] = [];

  for (const item of ordered) {
    if (ranked.length >= SUGGESTIONS_MAX) {
      break;
    }
    const keptInCategory = perCategory.get(item.category) ?? 0;
    if (keptInCategory >= SUGGESTIONS_PER_CATEGORY_MAX) {
      continue;
    }
    perCategory.set(item.category, keptInCategory + 1);
    ranked.push(item);
  }

  return ranked;
}

/**
 * How many candidates survived each filtering stage of AAP 0.5.7, counted by `candidates.ts`:
 * places with a usable estimate, those open in the window on the meetup day, and those also inside
 * the budget.
 */
export interface SuggestionCounts {
  /** Candidates carrying a fresh, approved price record an estimate could be built from. */
  pricedCount: number;
  /** Of those, the ones open between an hour after the start and 23:00 local on the meetup day. */
  openCount: number;
  /** Of those, the ones whose estimate is at or under the pair's per-person budget. */
  fittingCount: number;
}

/**
 * The empty-state reasons in the order the API checks them (AAP 0.5.7): no priced places at all, then
 * none of the priced places open in the window, then nothing open that fits the budget. Each reason
 * has its own empty state in the client (AAP 0.5.8).
 */
const EMPTY_REASON_CHECKS: readonly [
  reason: SuggestionEmptyReason,
  isEmpty: (counts: SuggestionCounts) => boolean,
][] = [
  ['no_priced_places', (counts) => counts.pricedCount === 0],
  ['none_open', (counts) => counts.openCount === 0],
  ['budget_too_low', (counts) => counts.fittingCount === 0],
];

/**
 * Names why a suggestion list is empty, or `undefined` when at least one place fits (AAP 0.5.7).
 *
 * The stages are nested, so the first reason whose count is zero is the reason that stopped the
 * flow: no priced place is `no_priced_places` even when the later counts are zero as well, priced but
 * none open is `none_open`, and open but none fitting the budget is `budget_too_low`.
 */
export function emptyReasonFor(counts: SuggestionCounts): SuggestionEmptyReason | undefined {
  for (const [reason, isEmpty] of EMPTY_REASON_CHECKS) {
    if (isEmpty(counts)) {
      return reason;
    }
  }
  return undefined;
}
