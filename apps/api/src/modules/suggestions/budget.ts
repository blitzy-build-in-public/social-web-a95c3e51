/**
 * The pair's shared per-person budget for day-plan suggestions, and the range the route accepts
 * (AAP 0.5.7 "Budget", AAP 0.5.4).
 *
 * A suggestion's per-person estimate is measured against this budget, and both attendees share one
 * value: the latest write by either of them wins (AAP 0.5.7). The deposit never becomes the budget
 * — it is only ever held, captured or released — and its level merely selects the default a
 * meetup starts with (AAP 0.7.3 assumption 10).
 *
 * Every amount is integer USD cents (AAP 0.11.1), and every bound is read from
 * `packages/shared/src/constants.ts` rather than restated here.
 *
 * No I/O: no database, clock or Fastify instance is touched and nothing is imported from a sibling
 * module, so `apps/api/test/unit/suggestions-rules.test.ts` exercises this in-process.
 */

import {
  BUDGET_MAX_CENTS,
  BUDGET_MIN_CENTS,
  DEFAULT_BUDGET_BY_DEPOSIT,
  isDepositLevel,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';

/**
 * The default per-person budget in cents of a meetup proposed at `depositCents` (AAP 0.5.7):
 * 500 gives 1,500, 1,000 gives 3,000 and 2,000 gives 6,000.
 *
 * An amount outside `DEPOSIT_LEVELS_CENTS` throws a plain `Error`, not an `AppError`: every stored
 * deposit is one of those levels, because `POST /meetups` answers `422 deposit_invalid` for any
 * other, so reaching that branch is an invariant violation of ours and never the caller's mistake.
 */
export function defaultBudgetFor(depositCents: number): number {
  if (!isDepositLevel(depositCents)) {
    throw new Error('deposit_not_a_level');
  }

  return DEFAULT_BUDGET_BY_DEPOSIT[depositCents];
}

/**
 * The budget a meetup's suggestions are ranked against: the pair's stored budget once one has been
 * written, and {@link defaultBudgetFor} until then (AAP 0.5.7).
 *
 * `routes.ts` writes `meetup.budgetCents` when `GET /meetups/:id/suggestions` carries
 * `perPersonBudgetCents`, and because the pair shares a single budget the stored value is the whole
 * of their choice. The deposit is never spent into it (AAP 0.7.3 assumption 10).
 */
export function effectiveBudget(meetup: {
  budgetCents: number | null;
  depositCents: number;
}): number {
  return meetup.budgetCents ?? defaultBudgetFor(meetup.depositCents);
}

/**
 * Whether `cents` is a per-person budget the route accepts: a whole number of USD cents from
 * `BUDGET_MIN_CENTS` through `BUDGET_MAX_CENTS`, both inclusive (AAP 0.5.4).
 */
export function isBudgetInRange(cents: number): boolean {
  return Number.isInteger(cents) && cents >= BUDGET_MIN_CENTS && cents <= BUDGET_MAX_CENTS;
}

/**
 * Rejects a per-person budget outside the accepted range with `422 budget_out_of_range`
 * (AAP 0.5.4).
 *
 * `SuggestionsQuery.perPersonBudgetCents` accepts any integer, so the range is enforced here — by
 * the suggestion route after its `409 meetup_not_locked` check, which is the order the contract
 * lists those errors in.
 */
export function assertBudgetInRange(cents: number): void {
  if (!isBudgetInRange(cents)) {
    throw new AppError('budget_out_of_range');
  }
}
