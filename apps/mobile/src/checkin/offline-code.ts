/**
 * Offline retention of an entered venue check-in code (AAP 0.5.1, 0.5.7, 0.5.8).
 *
 * A check-in code rotates every 60 s and the server accepts the current step and one either side of it, so a code
 * typed just before connectivity drops is still worth submitting when it comes back. This module holds one such code in
 * memory for at most `OFFLINE_CODE_RETENTION_MS`, submits it on the next online signal, and otherwise drops it so the
 * screen can ask for a fresh one.
 * The code is never persisted and never logged: it lives in the single active hold below and nowhere else, and is
 * released the moment that hold settles. Coordinates are not held either — the caller's `submit` reads them when it
 * runs. Client-only and Hermes-safe: one file serves iOS, Android and web, because NetInfo's web build runs on
 * `navigator.onLine`.
 */
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { CODE_DIGITS, OFFLINE_CODE_RETENTION_MS } from '@tablemate/shared';
/** The shape of a venue check-in code, built from the contract's `CODE_DIGITS` so the two agree. */
const CODE_PATTERN = new RegExp(`^\\d{${CODE_DIGITS}}$`);

function isOnlineState(state: NetInfoState): boolean {
  return state.isConnected === true && state.isInternetReachable !== false;
}

export async function isOnline(): Promise<boolean> {
  return isOnlineState(await NetInfo.fetch());
}

export type HoldOutcome = 'submitted' | 'expired' | 'cancelled';

export interface HeldCode {
  cancel(): void;
  readonly result: Promise<HoldOutcome>;
}

/** How {@link holdCode} tells a retryable connectivity failure from a final one. */
export interface HoldOptions {
  /**
   * Classifies an error from `submit` as a connectivity failure, which keeps the hold waiting for the
   * next online signal instead of ending it. Anything else ends the hold with that error.
   */
  isNetworkError?: (error: unknown) => boolean;
}

function now(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

let active: HeldCode | null = null;
/**
 * Holds `code` until the device is online, submitting it at most once and only within
 * `OFFLINE_CODE_RETENTION_MS` of this call (AAP 0.5.7).
 *
 * `submit` runs with the code when connectivity returns, or on this call when the device is already
 * online. The hold ends as `submitted`, as `expired` once the window has passed — when the screen
 * asks for a fresh code from the venue console, which imposes no hard time limit — or as `cancelled`
 * from {@link HeldCode.cancel}, which the screen must call on unmount. The code is kept in memory
 * alone, for no longer than the window, and never logged.
 * Only one hold exists at a time: calling this supersedes an earlier hold, which ends as `cancelled`.
 * @throws A `TypeError` when `code` is not exactly `CODE_DIGITS` digits. It names no code itself.
 */
export function holdCode(
  code: string,
  submit: (code: string) => Promise<unknown>,
  options?: HoldOptions,
): HeldCode {
  if (!CODE_PATTERN.test(code)) {
    throw new TypeError(`holdCode expects ${CODE_DIGITS} digits`);
  }
  active?.cancel();
  const deadline = now() + OFFLINE_CODE_RETENTION_MS;
  let held: string | null = code;
  let settled = false;
  let submitting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  // `new Promise` runs its executor synchronously, so both resolvers are assigned before anything
  // below can reach them and the definite-assignment assertions hold.
  let resolveResult!: (outcome: HoldOutcome) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<HoldOutcome>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  /** Releases everything the hold is holding: the timer, the listener and the code itself. */
  function cleanup(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    held = null;
    if (active === handle) active = null;
  }
  /** Ends the hold with `outcome`, once: every later call is a no-op. */
  function finish(outcome: HoldOutcome): void {
    if (settled) return;
    settled = true;
    cleanup();
    resolveResult(outcome);
  }
  /** Ends the hold with the error `submit` threw, once, releasing the code as it goes. */
  function fail(error: unknown): void {
    if (settled) return;
    settled = true;
    cleanup();
    rejectResult(error);
  }
  /** Submits the held code once, or ends the hold when the window has already passed. */
  async function attempt(): Promise<void> {
    if (settled || submitting) return;
    // The timer can fire late after the app was backgrounded, so this wall-clock check at
    // reconnect -- not the timer -- is what enforces the window.
    if (now() > deadline) {
      finish('expired');
      return;
    }
    const pending = held;
    if (pending === null) return;
    submitting = true;
    try {
      await submit(pending);
      finish('submitted');
    } catch (error) {
      submitting = false;
      // A hold that ended while the request was in flight keeps that outcome: a cancelled hold is
      // never reported as a submission, and nothing is thrown after the result has settled.
      if (settled) return;
      // A connectivity failure with time left leaves the hold waiting for the next online signal.
      if (options?.isNetworkError?.(error) === true && now() <= deadline) return;
      fail(error);
    }
  }
  // `cancel` only calls `finish` after `holdCode` has returned, so both helpers are defined by the
  // time the handle can be used.
  const handle: HeldCode = { cancel: () => finish('cancelled'), result };
  timer = setTimeout(() => finish('expired'), OFFLINE_CODE_RETENTION_MS);
  // The platform's own signal rather than a poll: NetInfo calls back when connectivity changes.
  unsubscribe = NetInfo.addEventListener((state) => {
    if (isOnlineState(state)) void attempt();
  });
  // Ask once now as well, so a code held with connectivity already back is not left waiting for
  // the next change event.
  void NetInfo.fetch().then(
    (state) => {
      if (isOnlineState(state)) void attempt();
    },
    () => {
      // A probe that fails leaves the hold waiting on the timer and the listener above.
    },
  );
  active = handle;
  return handle;
}
