/**
 * The fault injector the crash and interruption tests throw from (AAP 0.11.2). Arming is the test's
 * business, never the environment's: `buildApp` refuses `deps.faults` outside `APP_ENV=test`, and every
 * other process carries `noFaults`.
 */

import type { FaultInjector, FaultPoint } from '../../src/app.ts';

/**
 * The ids a call site reports — `{ eventId }`, `{ operationId, kind }`, `{ meetupId }` — as
 * `FaultInjector.hit` declares them.
 */
type FaultContext = Record<string, string>;

/**
 * The five points a test can throw from (AAP 0.11.2), in the order the production code reaches them.
 * Each names a place the corresponding module already passes to {@link FaultInjector.hit}, so this list
 * and the call sites cannot drift apart.
 */
export const FAULT_POINTS = [
  'stripe_webhook.after_event_insert',
  'stripe_webhook.after_commit',
  'payment_op.before_stripe_call',
  'payment_op.after_stripe_call',
  'settlement.inside_transaction',
] as const satisfies readonly FaultPoint[];

/**
 * The failure an armed point raises, so a suite can tell an injected crash from a provider error it also
 * catches, and can name the point in the assertion.
 */
export class InjectedFault extends Error {
  /** Which point threw. */
  readonly point: FaultPoint;
  constructor(point: FaultPoint) {
    super(`injected fault at ${point}`);
    this.name = 'InjectedFault';
    this.point = point;
    // Keeps `instanceof` true across transpilation and when a second copy of this module is loaded.
    Object.setPrototypeOf(this, InjectedFault.prototype);
  }
}

/**
 * Whether `error` is a fault this module injected. `instanceof` is the primary test; the structural
 * fallback covers a value a boundary rewrapped — Prisma's `$transaction`, BullMQ's processor.
 */
export function isInjectedFault(error: unknown): error is InjectedFault {
  if (error instanceof InjectedFault) return true;
  if (typeof error !== 'object' || error === null) return false;
  const fault = error as { name?: unknown; point?: unknown };
  if (fault.name !== 'InjectedFault' || typeof fault.point !== 'string') return false;
  return FAULT_POINTS.some((point) => point === fault.point);
}

/** How {@link TestFaults.arm} behaves for one point. */
export interface ArmOptions {
  /** Throw on the first hit and disarm, or stay armed for every hit. Defaults to `true`. */
  once?: boolean;
  /**
   * Arm for the hits this accepts, so one arming can fire for one meetup or one payment operation and not
   * another. Called with the ids the call site passed, on every hit of the armed point; returning false
   * leaves the arming in place.
   */
  when?: (context: FaultContext) => boolean;
}

/**
 * The injector a suite drives: what `buildApp({ faults })` accepts (AAP 0.11.2), plus the arming and
 * the counters the test needs around it.
 */
export interface TestFaults extends FaultInjector {
  /** Arm `point`, replacing any earlier arming of it. */
  arm(point: FaultPoint, options?: ArmOptions): void;
  /**
   * Disarm one point, or every point when called with no argument. Never resets {@link TestFaults.hits},
   * so a suite that wants the counters back at zero reads a delta or builds a fresh injector.
   */
  disarm(point?: FaultPoint): void;
  /**
   * How often each point was reached, armed or not: a crash test asserts its point was reached at all —
   * that the scenario really walked through it — before it asserts what the next run recovered.
   */
  readonly hits: Record<FaultPoint, number>;
}

/** One armed point: `once` resolved, and the predicate present only when the caller gave one. */
interface ArmedPoint {
  once: boolean;
  when?: (context: FaultContext) => boolean;
}

/** Build a fresh injector, in its production state: nothing armed and every counter at zero. */
export function createFaultInjector(): TestFaults {
  const armed = new Map<FaultPoint, ArmedPoint>();
  // The keys are built from FAULT_POINTS so they cannot drift from the list of points above; the
  // assertion holds as soon as the loop below has run.
  const hits = {} as Record<FaultPoint, number>;
  for (const point of FAULT_POINTS) hits[point] = 0;
  return {
    arm(point, options): void {
      const once = options?.once ?? true;
      const when = options?.when;
      armed.set(point, when === undefined ? { once } : { once, when });
    },
    disarm(point): void {
      if (point === undefined) armed.clear();
      else armed.delete(point);
    },
    hits,
    hit(point, context): Promise<void> {
      hits[point] += 1;
      const armedPoint = armed.get(point);
      if (armedPoint === undefined) return Promise.resolve();
      // `when` decides per hit, so one arming can fire for one meetup or operation and not another.
      const matched = armedPoint.when?.(context ?? {}) ?? true;
      if (!matched) return Promise.resolve();
      if (armedPoint.once) armed.delete(point);
      return Promise.reject(new InjectedFault(point));
    },
  };
}
