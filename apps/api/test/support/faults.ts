/**
 * The fault injector the crash and interruption tests throw from (AAP 0.11.2).
 *
 * The production code awaits `services.faults.hit(point, ids)` at five places — one inside the
 * Stripe webhook's transaction and one after its commit, one either side of each Stripe call the
 * payment executor makes, and one inside the settlement transaction — so a suite can make a
 * request, a sweeper pass or a settlement fail exactly there and assert what the next run
 * recovers: the rollback and the redelivery applied once, the outbox poller's late delivery, the
 * reconcile-then-retry of a payment operation, or the one settlement that survives a crash inside
 * its transaction.
 *
 * Arming is the test's business, never the environment's: `buildApp` refuses `deps.faults` outside
 * `APP_ENV=test` and every other process carries `noFaults`, so a call site never branches on
 * whether injection is configured. Nothing here reads the clock, the environment, the filesystem or
 * a global, and the import below is type-only, so loading this module loads no part of the app.
 *
 * @see AAP 0.11.2 for the fault points and the crash cases, 0.8.1 for this file, 0.3.2 for what the
 *   recovery of each point is.
 */

import type { FaultInjector, FaultPoint } from '../../src/app.ts';

/**
 * The ids a call site reports — `{ eventId }`, `{ operationId, kind }`, `{ meetupId }` — as
 * `FaultInjector.hit` declares them.
 */
type FaultContext = Record<string, string>;

/**
 * The five points a test can throw from (AAP 0.11.2), in the order the production code reaches
 * them. Each names a place the corresponding module already passes to {@link FaultInjector.hit}, so
 * this list and the call sites cannot drift apart.
 *
 * - `stripe_webhook.after_event_insert` — `payments/webhook.ts`, inside the webhook transaction
 *   after the `StripeEvent` insert: a crash rolls every effect back, and Stripe's redelivery is what
 *   applies the event, exactly once.
 * - `stripe_webhook.after_commit` — `payments/webhook.ts`, after the commit and before the
 *   dispatcher is kicked: the committed outbox rows are delivered by the poller instead.
 * - `payment_op.before_stripe_call` — `payments/operations.ts`, before the call: the operation is
 *   left `pending`, so the sweeper is what executes it.
 * - `payment_op.after_stripe_call` — `payments/operations.ts`, after the call and before its result
 *   is recorded: the executor retrieves the object and records what it finds, without a second call.
 * - `settlement.inside_transaction` — `settlement/settle.ts`, inside the settlement transaction: the
 *   meetup stays unsettled and the next run settles it once.
 */
export const FAULT_POINTS = [
  'stripe_webhook.after_event_insert',
  'stripe_webhook.after_commit',
  'payment_op.before_stripe_call',
  'payment_op.after_stripe_call',
  'settlement.inside_transaction',
] as const satisfies readonly FaultPoint[];

/**
 * The failure an armed point raises, so a suite can tell an injected crash from a provider error it
 * also catches, and can name the point in the assertion.
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
 * Whether `error` is a fault this module injected.
 *
 * `instanceof` is the primary test. The structural fallback exists because the value crosses a
 * boundary that may rewrap it — Prisma's `$transaction` a callback failure, BullMQ a processor's
 * rejection — and the wrapper is what the suite's `catch` sees.
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
   * Arm for the hits this accepts, so one arming can fire for one meetup or one payment operation and
   * not another. Called with the ids the call site passed, on every hit of the armed point; returning
   * false leaves the arming in place.
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
   * Disarm one point, or every point when called with no argument. Never resets
   * {@link TestFaults.hits}, so a suite that wants the counters back at zero reads a delta or builds
   * a fresh injector.
   */
  disarm(point?: FaultPoint): void;
  /**
   * How often each point was reached, armed or not: a crash test asserts its point was reached at all
   * — that the scenario really walked through it — before it asserts what the next run recovered.
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
