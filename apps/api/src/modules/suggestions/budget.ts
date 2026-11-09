/**
 * The pair's shared per-person budget for day-plan suggestions, and the range the route accepts.
 *
 * A suggestion's per-person estimate is measured against this budget, and both attendees share one value: the latest
 * write by either of them wins. The deposit never becomes the budget — it is only ever held, captured or released —
 * and its level merely selects the default a meetup starts with. Every amount is integer USD cents, and every bound
 * is read from `packages/shared/src/constants.ts` rather than restated here.
 */
import {
  BUDGET_MAX_CENTS,
  BUDGET_MIN_CENTS,
  DEFAULT_BUDGET_BY_DEPOSIT,
  isDepositLevel,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';

/**
 * The default per-person budget in cents of a meetup proposed at `depositCents`.
 *
 * An amount outside `DEPOSIT_LEVELS_CENTS` throws a plain `Error`, not an `AppError`: every stored deposit is one of
 * those levels, because `POST /meetups` answers `422 deposit_invalid` for any other, so reaching that branch is an
 * invariant violation of ours and never the caller's mistake.
 */
export function defaultBudgetFor(depositCents: number): number {
  if (!isDepositLevel(depositCents)) {
    throw new Error('deposit_not_a_level');
  }
  return DEFAULT_BUDGET_BY_DEPOSIT[depositCents];
}

/**
 * The budget a meetup's suggestions are ranked against: the pair's stored budget once one has been written, and
 * {@link defaultBudgetFor} until then. `routes.ts` writes `meetup.budgetCents` when the suggestions route carries
 * `perPersonBudgetCents`, and because the pair shares a single budget the stored value is the whole of their choice.
 * The deposit is never spent into it.
 */
export function effectiveBudget(meetup: {
  budgetCents: number | null;
  depositCents: number;
}): number {
  return meetup.budgetCents ?? defaultBudgetFor(meetup.depositCents);
}

/** Whether `cents` is a per-person budget the route accepts: a whole number of USD cents from `BUDGET_MIN_CENTS`
 * through `BUDGET_MAX_CENTS`, both inclusive. */
export function isBudgetInRange(cents: number): boolean {
  return Number.isInteger(cents) && cents >= BUDGET_MIN_CENTS && cents <= BUDGET_MAX_CENTS;
}

/**
 * Rejects a per-person budget outside the accepted range with `422 budget_out_of_range`.
 *
 * `SuggestionsQuery.perPersonBudgetCents` accepts any integer, so the range is enforced here — by the suggestion route
 * after its `409 meetup_not_locked` check, which is the order the contract lists those errors in.
 */
export function assertBudgetInRange(cents: number): void {
  if (!isBudgetInRange(cents)) {
    throw new AppError('budget_out_of_range');
  }
}
