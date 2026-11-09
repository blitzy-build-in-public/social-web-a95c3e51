import { E164, type AppEnv } from '@tablemate/shared';
/** Why a number may not be dialed (AAP 0.3.3, 0.7.3). */
export type NotCallableReason = 'not_allowlisted' | 'production_calls_not_approved';
/** The guard's verdict on one number (AAP 0.3.3, 0.7.3). */
export type CallableResult = { callable: true } | { callable: false; reason: NotCallableReason };
/** The deployment facts {@link createCallGuard} is built from, all of them already validated: the `APP_ENV` of the running process, the parsed `CALL_ALLOWLIST`, and whether production calls have been approved (AAP 0.3.3, 0.7.3, 0.6.2). */
export interface CallGuardOptions {
  /** The process's deployment mode; only `production` is treated as production. */
  appEnv: AppEnv;
  /** The operator-owned numbers a non-production process may dial, as the parsed `CALL_ALLOWLIST`. Ignored in production, where the approval flag governs instead. */
  allowlist: ReadonlySet<string>;
  /** `CALLS_PRODUCTION_APPROVED`; consulted only in production (AAP 0.7.3). */
  productionApproved: boolean;
}
/** The guard every outbound call passes through (AAP 0.12.2). */
export interface CallGuard {
  /** Whether `number` may be dialed, with the reason when it may not: the allowlist is consulted only outside production, where the approval flag governs instead, and the comparison is exact on the E.164 string as supplied (AAP 0.3.3). */
  isCallable(number: string): CallableResult;
  /** The same verdict as {@link CallGuard.isCallable}, as a throw, for a call site that cannot continue without a callable number. @throws NotCallableError carrying the {@link NotCallableReason} when the number may not be dialed. */
  assertCallable(number: string): void;
}
/** Thrown by {@link CallGuard.assertCallable} when a number may not be dialed. */
export class NotCallableError extends Error {
  /** Why the number was refused (AAP 0.3.3, 0.7.3). */
  readonly reason: NotCallableReason;
  constructor(reason: NotCallableReason) {
    super(`Call refused: ${reason}`);
    this.reason = reason;
    this.name = 'NotCallableError';
  }
}
/** Parse the `CALL_ALLOWLIST` value: a comma-separated list of E.164 numbers, empty by default. `src/env/modes.ts` separately requires it to be non-empty for `TELEPHONY_MODE=twilio` outside production (AAP 0.6.2). */
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
/** Build the guard from validated configuration (AAP 0.3.3, 0.7.3). */
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
