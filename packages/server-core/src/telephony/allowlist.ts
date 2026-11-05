/**
 * The outbound-call guard: the one place that decides whether Tablemate may dial a number
 * (AAP 0.3.3, 0.7.3, 0.12.2).
 *
 * Two rules meet here and neither relaxes the other. Outside production a call reaches only a
 * number the operator has allowlisted — "Calls only to `CALL_ALLOWLIST` (operator-owned E.164
 * numbers) whenever `APP_ENV` != `production`" (AAP 0.3.3) — so `test`, `demo` and `staging` all
 * dial the allowlist alone, even with real Twilio credentials configured. In production a call
 * waits for the operator's explicit approval, because the automated-voice, recording and
 * disclosure wording of the five launch countries is still under legal review:
 * "`APP_ENV=production` calls remain disabled until `CALLS_PRODUCTION_APPROVED=true` is set"
 * (AAP 0.7.3). What AAP 0.12.2 records from the pair is that a number outside the allowlist is
 * never dialed.
 *
 * The module is pure: no I/O, no logging, no environment read and no clock. Parsed configuration
 * arrives as {@link CallGuardOptions}, the caller supplies the number, and the caller logs the
 * reason a number was refused.
 */

import { E164, type AppEnv } from '@tablemate/shared';

/**
 * Why a number may not be dialed (AAP 0.3.3, 0.7.3). `apps/workers/src/calls/eligibility.ts` maps
 * **either** value onto `blockedReason = not_allowlisted`, the only matching `BlockedReason` in
 * `packages/shared/src/enums.ts`, and leaves the task `queued` without dialing it.
 */
export type NotCallableReason = 'not_allowlisted' | 'production_calls_not_approved';

/** The guard's verdict on one number (AAP 0.3.3, 0.7.3). */
export type CallableResult = { callable: true } | { callable: false; reason: NotCallableReason };

/**
 * The deployment facts {@link createCallGuard} is built from, all of them already validated: the
 * `APP_ENV` of the running process, the parsed `CALL_ALLOWLIST`, and whether production calls have
 * been approved (AAP 0.3.3, 0.7.3, 0.6.2).
 */
export interface CallGuardOptions {
  /** The process's deployment mode; only `production` is treated as production. */
  appEnv: AppEnv;
  /**
   * The operator-owned numbers a non-production process may dial, as the parsed `CALL_ALLOWLIST`.
   * Ignored in production, where the approval flag governs instead.
   */
  allowlist: ReadonlySet<string>;
  /** `CALLS_PRODUCTION_APPROVED`; consulted only in production (AAP 0.7.3). */
  productionApproved: boolean;
}

/**
 * The guard every outbound call passes through (AAP 0.12.2). Callers ask it before dispatching, so
 * a refused number never reaches Twilio.
 */
export interface CallGuard {
  /**
   * Whether `number` may be dialed, with the reason when it may not:
   *
   * | `appEnv` | `productionApproved` | number in allowlist | result |
   * |---|---|---|---|
   * | `production` | `false` | any | `{ callable: false, reason: 'production_calls_not_approved' }` |
   * | `production` | `true` | any | `{ callable: true }` |
   * | `test`, `demo`, `staging` | any | yes | `{ callable: true }` |
   * | `test`, `demo`, `staging` | any | no | `{ callable: false, reason: 'not_allowlisted' }` |
   *
   * The allowlist is not consulted in production, because the rule it enforces is scoped to
   * `APP_ENV` != `production` (AAP 0.3.3); the approval flag is what admits a production call. The
   * comparison is exact, on the E.164 string as supplied: a number that is not E.164 simply fails
   * to match and is refused, so an unnormalised input is refused rather than dialed.
   */
  isCallable(number: string): CallableResult;

  /**
   * The same verdict as {@link CallGuard.isCallable}, as a throw, for a call site that cannot
   * continue without a callable number.
   *
   * @throws NotCallableError carrying the {@link NotCallableReason} when the number may not be
   * dialed.
   */
  assertCallable(number: string): void;
}

/**
 * Thrown by {@link CallGuard.assertCallable} when a number may not be dialed.
 *
 * The message carries the reason alone: an E.164 string is an operator's or a business's data, and
 * a phone number must reach neither a log nor a response (AAP 0.11.1, 0.12.2). Read
 * {@link NotCallableError.reason} to classify the refusal.
 */
export class NotCallableError extends Error {
  /** Why the number was refused (AAP 0.3.3, 0.7.3). */
  readonly reason: NotCallableReason;

  constructor(reason: NotCallableReason) {
    super(`Call refused: ${reason}`);
    this.reason = reason;
    this.name = 'NotCallableError';
  }
}

/**
 * Parse the `CALL_ALLOWLIST` value: a comma-separated list of E.164 numbers, empty by default
 * (AAP 0.6.2 — `workers` reads it, and `src/env/modes.ts` separately requires it to be non-empty
 * for `TELEPHONY_MODE=twilio` outside production).
 *
 * An omitted or all-whitespace value yields an empty set, so a demo stack with
 * `TELEPHONY_MODE=off` needs no allowlist at all. Entries are trimmed and empty ones dropped, so
 * `"+12025550100, ,+13125550101,"` parses; duplicates collapse, since a set is returned.
 *
 * @param csv - the raw `CALL_ALLOWLIST` value, or `undefined` when unset.
 * @returns the accepted numbers, as the `ReadonlySet` {@link createCallGuard} takes.
 * @throws RangeError when an entry is not E.164. The message names the entry's 1-based position
 * among the non-empty entries and never its value, because a phone number must not reach a log
 * (AAP 0.11.1); `src/env/*` turns the throw into an `EnvValidationError` issue.
 */
export function parseAllowlist(csv: string | undefined): ReadonlySet<string> {
  const entries = (csv ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const numbers = new Set<string>();
  entries.forEach((entry, index) => {
    if (!E164.safeParse(entry).success) {
      throw new RangeError(`CALL_ALLOWLIST entry ${index + 1} is not an E.164 number`);
    }
    numbers.add(entry);
  });

  return numbers;
}

/**
 * Build the guard from validated configuration (AAP 0.3.3, 0.7.3).
 *
 * The allowlist is copied, so mutating the set this was handed afterwards cannot widen what may be
 * dialed. `productionApproved` is read only in production; setting it outside production changes
 * nothing, because non-production calls stay allowlist-only (AAP 0.3.3).
 *
 * @param options - the deployment's `APP_ENV`, parsed allowlist and production approval.
 * @returns a guard whose decisions are fixed at construction.
 */
export function createCallGuard(options: CallGuardOptions): CallGuard {
  const allowlist = new Set(options.allowlist);
  const inProduction = options.appEnv === 'production';

  const isCallable = (number: string): CallableResult => {
    if (inProduction) {
      return options.productionApproved
        ? { callable: true }
        : { callable: false, reason: 'production_calls_not_approved' };
    }
    return allowlist.has(number)
      ? { callable: true }
      : { callable: false, reason: 'not_allowlisted' };
  };

  const assertCallable = (number: string): void => {
    const result = isCallable(number);
    if (!result.callable) {
      throw new NotCallableError(result.reason);
    }
  };

  return Object.freeze({ isCallable, assertCallable });
}
