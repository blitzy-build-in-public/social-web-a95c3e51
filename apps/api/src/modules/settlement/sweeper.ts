/**
 * The advisory-locked settlement sweeper: the 60-second pass that settles what is overdue, lapses what has expired,
 * escalates what is about to, and resumes every unfinished payment operation.
 *
 * It is the backstop, because settlement depends on PostgreSQL and Stripe alone: a delayed `settle-<meetupId>` job
 * is a latency optimisation and never the guarantee. A job lost to a Redis outage, a process that died mid-pass or a
 * hold create whose answer was lost all end at the next pass. Nothing here reads Redis, and nothing here calls
 * Stripe — money moves only through the operations {@link settleMeetup} plans, which `payments/operations.ts`
 * executes.
 *
 * The lock: one holder transaction takes a **transaction-scoped** `pg_try_advisory_xact_lock`, and it covers the
 * pass's decision phase alone — the three deciding steps, their selections and the settlement decisions, each of
 * which commits through its own transactions on other pooled connections. The two PaymentIntent retrievals
 * {@link settleMeetup} makes stay inside it, because they are the decision — whether each hold still stands. The
 * holder ends before the executor phase starts, so no transaction, no pooled connection and no lock is held while
 * an executor provider call runs; that is safe because every operation a decision wrote is claimed atomically and
 * records its result conditionally on that claim. The holder writes nothing, so the pool must allow at least two
 * connections while it is open.
 *
 * The scope is deliberately transactional, not session-level: with Prisma's pool each statement is handed whichever
 * connection is free, so a `pg_try_advisory_lock`'s matching unlock could run on another connection and leave the
 * lock held for the life of a pooled connection — every later pass would then skip and the backstop would die
 * silently. A transaction-scoped lock cannot leak; it ends with the holder, on any ending. Because the lock covers
 * the pass's decisions, a second API replica cannot double-settle: it finds the lock taken and returns
 * `{ skipped: true }`. A caller that must run after any pass in flight passes `waitForLock: true` and gets the
 * blocking `pg_advisory_xact_lock` instead.
 *
 * No further item is started once {@link PASS_BUDGET_MS} of monotonic `performance.now()` has elapsed, which keeps
 * the decision phase inside the holder's transaction timeout and bounds the executor phase's provider calls. The
 * measure is deliberately independent of the app clock: a frozen test clock never advances, so a deadline measured
 * with `services.clock` would never fire. Items that finished stay committed even if the holder later rolls back.
 *
 * "Overdue" is judged against `services.clock.now()` and never `Date.now()`. The intervals come from
 * `@tablemate/shared`, the same constants `./timers.ts` computes its due times from, so a timer and this selection
 * turn over at the same instant; `./timers.ts` is not imported because its helpers answer for a row in hand, while
 * a pass selects candidates as SQL range predicates over the same durations.
 *
 * Log lines carry counters, a step name and an id — never an error object, whose message and stack pino writes as
 * strings that key-based redaction cannot rewrite, and which for a provider failure can quote a `PaymentIntent` id.
 */

import { performance } from 'node:perf_hooks';

import { Prisma } from '@tablemate/db';
import type { DbTx } from '@tablemate/db';
import {
  CHECK_IN_CLOSES_AFTER_MINUTES,
  DISPUTE_ESCALATE_BEFORE_HOURS,
  HOUR_MS,
  MINUTE_MS,
  RECIPIENT_DEADLINE_HOURS,
} from '@tablemate/shared';

import { runOperationsFor, runPendingOperations } from '../payments/operations.ts';

import { escalateDisputeIfDue, lapseIfDue, settleMeetup } from './settle.ts';

// Type-only, so the runtime graph stays acyclic: `app.ts` composes this pass and imports it as a value, and
// nothing of its module is read here at run time.
import type { AppServices } from '../../app.ts';

/**
 * The advisory-lock key every pass takes, and no other module may use. The eight ASCII bytes `TMSWEEP1` read as a
 * signed 64-bit integer (`0x544D535745455031`): positive, so it is a valid `bigint` key rather than one of the
 * negative ids PostgreSQL reserves for its own use, and a compile-time literal, so every process and every replica
 * locks the same value — which is what makes the second replica skip rather than double-settle.
 */
export const SWEEPER_LOCK_KEY = 6_074_603_106_682_097_713n;

const DEFAULT_BATCH_SIZE = 100;

const PASS_BUDGET_MS = 45_000;

const LOCK_MAX_WAIT_MS = 5_000;

/**
 * How long the holder transaction may stay open: the wait for the lock plus the pass's decision phase, never the
 * executor phase's provider calls, which run once the holder has ended. It is longer than {@link PASS_BUDGET_MS} by
 * a margin, so a pass that used its whole decision budget still finishes inside the holder rather than being killed
 * by Prisma's own deadline.
 */
const HOLDER_TIMEOUT_MS = 55_000;

const DEFAULT_INTERVAL_MS = 60_000;

const FAILURE_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface SweepOptions {
  /** How many candidates one step reads. Defaults to 100, far more than a minute's worth of due meetups, disputes and operations at pilot scale. */
  readonly batchSize?: number;
  /**
   * Whether the pass waits for an in-flight pass instead of skipping.
   *
   * Left unset by the 60-second background loop, where skipping is the point: a second replica — or the same
   * replica's timer firing while a pass is still running — must do nothing rather than queue behind work it would
   * repeat. Set by the two callers that have to observe the effect of their own clock jump before they answer:
   * `POST /v1/test/run-settlement` and `settleNow` in `apps/api/test/support/clock.ts`. The pass then takes the
   * blocking `pg_advisory_xact_lock`, so it runs after any pass in flight.
   */
  readonly waitForLock?: boolean;
}

/**
 * What one pass did, whichever way it ended. Every tally counts decisions taken by this pass alone, so a caller can
 * assert that a clock jump settled one meetup and that the pass after it settled none. `skipped` means another pass
 * held the lock and this one did nothing at all.
 */
export interface SweepSummary {
  readonly skipped: boolean;
  readonly lapsed: number;
  readonly settled: number;
  readonly postponed: number;
  readonly lockLost: number;
  readonly escalated: number;
  readonly operations: number;
  readonly errors: number;
}

type SweepStep = 'lapse' | 'settle' | 'escalate' | 'operations';

interface Counters {
  lapsed: number;
  settled: number;
  postponed: number;
  lockLost: number;
  escalated: number;
  operations: number;
  errors: number;
}

/**
 * A meetup whose open payment operations the executor phase still has to run. A step records one as soon as it
 * commits the operation rows a decision implies, and the step travels with the record, so a failure of its executor
 * run is logged under the step that planned it.
 */
interface PlannedOperation {
  readonly step: SweepStep;
  readonly meetupId: string;
}

/** Everything a pass needs while it runs: its bounds, the instant it judges with, its tallies, and the executor work its decision phase recorded. */
interface Pass {
  readonly batchSize: number;
  readonly now: Date;
  readonly startedAt: number;
  readonly counters: Counters;
  readonly planned: PlannedOperation[];
}

/**
 * Run one sweep, or skip it because another pass holds the lock.
 *
 * A pass runs in two phases. The **decision phase** holds the transaction-scoped advisory lock and works through
 * the three deciding steps in order — lapse, settle, escalate — each committing its own work through its own
 * transactions and recording every meetup whose open operations the second phase still has to run. The **executor
 * phase** runs once the holder transaction has ended: it carries out what the decisions recorded, meetup by meetup,
 * and resumes every unfinished payment operation behind them.
 *
 * Splitting the pass keeps a transaction, a pooled connection and the advisory lock away from the provider calls
 * the executor makes. Running them outside the holder cannot double-apply an effect: each operation was claimed
 * atomically when the executor took it and records its result conditionally on that claim, so two executors cannot
 * both apply one. The decisions themselves stay inside the phase, the two PaymentIntent retrievals a settlement
 * needs included: those are what decide whether each hold still stands. The lock therefore spans every decision
 * the pass takes, and a second pass skips rather than deciding the same meetup twice.
 *
 * Every step's selection and every item are isolated, so one failing meetup cannot cost the others, and a pass
 * competes with a cancellation, a block, a hold-loss webhook, an operator resolution and `DELETE /me` exactly as
 * they compete with each other — the loser of a race does nothing.
 *
 * Never throws for a failure inside a step or an executor run: those are counted and logged. It can reject when
 * the holder transaction itself fails — PostgreSQL unreachable, or the lock query refused — which
 * {@link startSweeper} records and a route caller answers as a server error.
 */
export async function runSweeper(
  services: AppServices,
  opts: SweepOptions = {},
): Promise<SweepSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  // The budget covers the wait for the lock as well as the work, so a pass that queued behind a long one starts
  // less work rather than overrunning the holder's own timeout.
  const startedAt = performance.now();

  // The decision phase: the lock, the three deciding steps and nothing that reaches a provider. `null` is its
  // answer when another pass holds the lock, which is the only case where this pass does nothing at all rather than
  // record work for the executor phase.
  const decided: Pass | null = await services.db.$transaction(
    async (holder: DbTx): Promise<Pass | null> => {
      if (!(await acquireLock(holder, opts.waitForLock === true))) {
        services.logger.debug({ event: 'sweeper_skipped' }, 'sweeper_skipped');
        return null;
      }

      // Read the instant only once the lock is held, so a pass that waited behind another judges overdue at the moment
      // it actually starts working.
      const pass: Pass = {
        batchSize,
        now: services.clock.now(),
        startedAt,
        counters: emptyCounters(),
        planned: [],
      };

      await decideSteps(services, pass);
      return pass;
    },
    { maxWait: LOCK_MAX_WAIT_MS, timeout: HOLDER_TIMEOUT_MS },
  );

  if (decided === null) {
    return skippedSummary();
  }

  // The executor phase, with no transaction, no pooled connection and no lock held by this pass.
  const summary = await executePlannedOperations(services, decided);
  reportPass(services, summary);
  return summary;
}

/**
 * Start the sweeper loop and hand back the function that stops it. `app.ts` calls this from its background startup
 * and registers the returned stop function on close.
 *
 * The loop is a self-rescheduling `setTimeout` rather than an interval: the first pass runs at once, so a restarted
 * API recovers what the crash left behind instead of waiting a whole period, and the next pass is armed only once
 * the previous one has ended, so passes never overlap on one instance. A pass that rejects — PostgreSQL
 * unreachable, or the holder transaction refused — is recorded as `sweeper_pass_failed` and the loop carries on; a
 * database blip must not end the backstop that exists for outages. The timer is `unref`ed so it never holds the
 * process open on shutdown.
 *
 * @returns The stop function: it clears the pending timer, stops rescheduling and resolves once the pass in flight
 *   has ended. Calling it twice is harmless.
 */
export function startSweeper(
  services: AppServices,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  /**
   * Run one pass and arm the next one, whatever this pass did. The failure is logged with the failing error's own
   * short token and nothing else: a pass that logs its error object would write a message and a stack that pino's
   * key-based redaction cannot rewrite.
   */
  async function runPass(): Promise<void> {
    try {
      await runSweeper(services);
    } catch (error) {
      services.logger.error(
        { event: 'sweeper_pass_failed', code: failureToken(error) },
        'sweeper_pass_failed',
      );
    } finally {
      if (!stopped) {
        arm(intervalMs);
      }
    }
  }

  /** Arm one pass `delayMs` from now, and let the timer keep the process open under no circumstance. */
  function arm(delayMs: number): void {
    timer = setTimeout(() => {
      inFlight = runPass();
    }, delayMs);
    timer.unref();
  }

  arm(0);

  return async () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await inFlight;
  };
}

/**
 * Take the pass lock on the holder transaction, and answer whether this pass may run.
 *
 * The key is cast to `bigint` explicitly: both functions are overloaded for one `int8` and for two `int4` keys, and
 * the cast is what makes the single-key form the one PostgreSQL resolves, rather than leaving that to a parameter
 * type.
 *
 * The blocking form is wrapped in a sub-select that returns a boolean instead of the function's own column:
 * `pg_advisory_xact_lock` returns `void`, and Prisma's `$queryRaw` fails to deserialize a `void` column (`P2010`).
 * The sub-select is the reason the answer is unconditional — PostgreSQL evaluates the volatile function in it, and
 * the call has returned only once the lock is held.
 *
 * The lock ends with `holder`, on any ending, which is why it is taken there and never on a pooled client.
 *
 * @returns Whether the pass may run. Always `true` when `wait` is set.
 */
async function acquireLock(holder: DbTx, wait: boolean): Promise<boolean> {
  if (wait) {
    await holder.$queryRaw(
      Prisma.sql`SELECT true AS locked FROM (SELECT pg_advisory_xact_lock(${SWEEPER_LOCK_KEY}::bigint)) AS acquired`,
    );
    return true;
  }

  const rows = await holder.$queryRaw<readonly { locked: boolean }[]>(
    Prisma.sql`SELECT pg_try_advisory_xact_lock(${SWEEPER_LOCK_KEY}::bigint) AS locked`,
  );
  return rows[0]?.locked === true;
}

/**
 * The decision phase — the three deciding steps, in order. It runs inside the holder transaction, so it decides and
 * commits and calls no provider but the two PaymentIntent retrievals a settlement makes. Each step records the
 * executor work its decisions imply on the pass, for {@link executePlannedOperations} to run after the holder has
 * ended.
 */
async function decideSteps(services: AppServices, pass: Pass): Promise<void> {
  await lapseDueProposals(services, pass);
  await settleDueMeetups(services, pass);
  await escalateDueDisputes(services, pass);
}

/**
 * The executor phase — run what the decisions recorded, then resume the rest.
 *
 * The holder transaction has ended by the time this runs, so the pass holds no transaction, no pooled connection
 * and no advisory lock while a provider call is in flight: what it runs are the open operations of the meetups the
 * decision phase recorded, meetup by meetup, and then {@link resumeOperations} for everything else that is still
 * open — an ambiguous hold create whose answer was lost, an `executing` row whose process died, a retryable
 * failure, and the capture and release of an earlier settlement.
 *
 * Single-flight is preserved without the lock: each operation is claimed atomically by `payments/operations.ts` and
 * records its result conditionally on that claim, so a second executor reaching the same row applies no second
 * effect. Every run is isolated like the steps' items, and the pass deadline is checked before each one.
 */
async function executePlannedOperations(services: AppServices, pass: Pass): Promise<SweepSummary> {
  for (const planned of pass.planned) {
    if (passExpired(pass)) {
      warnDeadline(services, planned.step);
      break;
    }

    try {
      await runOperationsFor(services, { meetupId: planned.meetupId });
    } catch (error) {
      pass.counters.errors += 1;
      logItemFailed(services, planned.step, planned.meetupId, error);
    }
  }

  await resumeOperations(services, pass);

  return { skipped: false, ...pass.counters };
}

/**
 * Step 1 — lapse every proposal whose recipient deadline has passed.
 *
 * A proposal is due when its `recipientDeadline` is set and has passed, or — while it is still invisible to the
 * recipient, because the initiator's hold never held — when {@link RECIPIENT_DEADLINE_HOURS} have passed since its
 * creation. {@link lapseIfDue} re-reads both under the meetup row lock by the same rule, so a job that arrives
 * early and this selection cannot disagree. The transition writes a release operation for every non-final deposit
 * attempt; the pass records the meetup, and the executor phase runs those releases once the holder has ended.
 */
async function lapseDueProposals(services: AppServices, pass: Pass): Promise<void> {
  await eachCandidate(
    services,
    'lapse',
    pass,
    () => lapseCandidates(services, pass),
    async (id) => {
      if (await lapseIfDue(services, id)) {
        pass.counters.lapsed += 1;
        pass.planned.push({ step: 'lapse', meetupId: id });
      }
    },
  );
}

/**
 * Step 2 — settle every locked meetup past its settlement instant.
 *
 * The selection is deliberately narrower than {@link settleMeetup}'s own guard: an open dispute and an existing
 * `MeetupSettlement` row are filtered out in SQL, so a postponed settlement is not re-read every 60 seconds for as
 * long as its operator takes. A meetup whose dispute opens between the selection and the call still reaches
 * {@link settleMeetup}, which answers `postponed` for it and leaves it `locked` with check-in open.
 *
 * Every candidate is recorded for the executor phase whatever {@link settleMeetup} answered, not only when it
 * settled: the executor returns as soon as the meetup has no open operation, and running it is what carries a
 * settlement's capture and release out in the same pass that decided them.
 */
async function settleDueMeetups(services: AppServices, pass: Pass): Promise<void> {
  await eachCandidate(
    services,
    'settle',
    pass,
    () => settleCandidates(services, pass),
    async (id) => {
      const result = await settleMeetup(services, id, { trigger: 'sweeper' });
      if (result.result === 'settled') {
        pass.counters.settled += 1;
      } else if (result.result === 'postponed') {
        pass.counters.postponed += 1;
      } else if (result.result === 'lock_lost') {
        pass.counters.lockLost += 1;
      }

      pass.planned.push({ step: 'settle', meetupId: id });
    },
  );
}

/**
 * Step 3 — flag every open dispute that is inside its escalation window. The window opens
 * {@link DISPUTE_ESCALATE_BEFORE_HOURS} before the operator's five-day deadline, so the escalation reaches `/ops`
 * a day early. {@link escalateDisputeIfDue} compares the same instant and is guarded on `escalatedAt` still being
 * null, which makes a second flag a no-op whichever of the timer and this pass arrives first.
 */
async function escalateDueDisputes(services: AppServices, pass: Pass): Promise<void> {
  await eachCandidate(
    services,
    'escalate',
    pass,
    () => escalateCandidates(services, pass),
    async (id) => {
      if (await escalateDisputeIfDue(services, id)) {
        pass.counters.escalated += 1;
      }
    },
  );
}

/**
 * Step 4 — resume every unfinished payment operation.
 *
 * This is the recovery path the whole settlement design rests on, and it runs last on purpose: the three steps
 * above decide and record, and one pass should carry out what it decided. It is the last piece of
 * {@link executePlannedOperations}, so it runs with the holder transaction already ended and holds no lock while
 * it calls the provider. It covers what no client will ever return for: an ambiguous hold create whose response
 * was lost, an `executing` row whose process died, a retryable failure, and the capture and release of an earlier
 * settlement. It reads nothing but PostgreSQL and the payment gateway, so a paused Redis does not stop it.
 *
 * {@link runPendingOperations} logs its own per-operation failures but lets a failure of its first read reject,
 * which is why the whole call is isolated here rather than inside it.
 */
async function resumeOperations(services: AppServices, pass: Pass): Promise<void> {
  if (passExpired(pass)) {
    warnDeadline(services, 'operations');
    return;
  }

  try {
    const { attempted } = await runPendingOperations(services, { limit: pass.batchSize });
    pass.counters.operations += attempted;
  } catch (error) {
    pass.counters.errors += 1;
    services.logger.error(
      { event: 'sweeper_step_failed', step: 'operations', code: failureToken(error) },
      'sweeper_step_failed',
    );
  }
}

/**
 * Run one step: select its candidates and act on each, oldest first.
 *
 * The selection and every single item are isolated, so one failing meetup, one failing dispute or one unreachable
 * Stripe call costs that item alone and the pass still reaches the steps below — and so a step whose query itself
 * fails, which is what a database under load looks like, does not cost the payment operations of an earlier
 * settlement their recovery.
 *
 * The pass deadline is checked before each item rather than during it: an item that has started runs to its own
 * outcome, because abandoning a transaction half-way would only roll back work that is cheaper to finish.
 */
async function eachCandidate(
  services: AppServices,
  step: SweepStep,
  pass: Pass,
  select: () => Promise<readonly string[]>,
  act: (id: string) => Promise<void>,
): Promise<void> {
  let ids: readonly string[];

  try {
    ids = await select();
  } catch (error) {
    pass.counters.errors += 1;
    services.logger.error(
      { event: 'sweeper_step_failed', step, code: failureToken(error) },
      'sweeper_step_failed',
    );
    return;
  }

  for (const id of ids) {
    if (passExpired(pass)) {
      warnDeadline(services, step);
      return;
    }

    try {
      await act(id);
    } catch (error) {
      pass.counters.errors += 1;
      logItemFailed(services, step, id, error);
    }
  }
}

async function lapseCandidates(services: AppServices, pass: Pass): Promise<readonly string[]> {
  const rows = await services.db.meetup.findMany({
    where: {
      status: 'proposed',
      OR: [
        { recipientDeadline: { lte: pass.now } },
        { recipientDeadline: null, createdAt: { lte: invisibleSince(pass.now) } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: pass.batchSize,
    select: { id: true },
  });

  return rows.map((row) => row.id);
}

async function settleCandidates(services: AppServices, pass: Pass): Promise<readonly string[]> {
  const rows = await services.db.meetup.findMany({
    where: {
      status: 'locked',
      startsAt: { lte: settleThreshold(pass.now) },
      settlement: { is: null },
      disputes: { none: { status: 'open' } },
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: pass.batchSize,
    select: { id: true },
  });

  return rows.map((row) => row.id);
}

async function escalateCandidates(services: AppServices, pass: Pass): Promise<readonly string[]> {
  const rows = await services.db.dispute.findMany({
    where: {
      status: 'open',
      escalatedAt: null,
      deadlineAt: { lte: escalationThreshold(pass.now) },
    },
    orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
    take: pass.batchSize,
    select: { id: true },
  });

  return rows.map((row) => row.id);
}

/**
 * The latest start a meetup settled at `now` may have. The inverse of `./timers.ts`'s `settleDueAt`:
 * `startsAt + 45 min <= now` holds for exactly the meetups whose settlement instant has passed, and this form is a
 * range predicate PostgreSQL can seek on `meetup("status", "starts_at")` rather than an expression per row.
 */
function settleThreshold(now: Date): Date {
  return new Date(now.getTime() - CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS);
}

function invisibleSince(now: Date): Date {
  return new Date(now.getTime() - RECIPIENT_DEADLINE_HOURS * HOUR_MS);
}

function escalationThreshold(now: Date): Date {
  return new Date(now.getTime() + DISPUTE_ESCALATE_BEFORE_HOURS * HOUR_MS);
}

function passExpired(pass: Pass): boolean {
  return performance.now() - pass.startedAt > PASS_BUDGET_MS;
}

function emptyCounters(): Counters {
  return {
    lapsed: 0,
    settled: 0,
    postponed: 0,
    lockLost: 0,
    escalated: 0,
    operations: 0,
    errors: 0,
  };
}

function skippedSummary(): SweepSummary {
  return {
    skipped: true,
    lapsed: 0,
    settled: 0,
    postponed: 0,
    lockLost: 0,
    escalated: 0,
    operations: 0,
    errors: 0,
  };
}

function isBusy(summary: SweepSummary): boolean {
  return (
    summary.lapsed +
      summary.settled +
      summary.postponed +
      summary.lockLost +
      summary.escalated +
      summary.operations +
      summary.errors >
    0
  );
}

/**
 * Report a pass. A pass that changed or attempted something — and a pass that failed at something — is an `info`
 * line, because it is what an operator reads to see settlement keeping up. An idle pass is a `debug` line, so the
 * 1,440 passes a day that found nothing cost an untouched log at the default level.
 */
function reportPass(services: AppServices, summary: SweepSummary): void {
  if (isBusy(summary)) {
    services.logger.info({ event: 'sweeper_pass', ...summary }, 'sweeper_pass');
    return;
  }
  services.logger.debug({ event: 'sweeper_pass', ...summary }, 'sweeper_pass');
}

/**
 * Record that one item of a step, or one executor run, failed, and let the pass carry on. The `sweeper_item_failed`
 * line names the item and its step and carries the failure's own short token, never the error object.
 */
function logItemFailed(services: AppServices, step: SweepStep, id: string, error: unknown): void {
  services.logger.error(
    { event: 'sweeper_item_failed', step, id, code: failureToken(error) },
    'sweeper_item_failed',
  );
}

function warnDeadline(services: AppServices, step: SweepStep): void {
  services.logger.warn(
    { event: 'sweeper_pass_deadline', step, budgetMs: PASS_BUDGET_MS },
    'sweeper_pass_deadline',
  );
}

/**
 * A failure's own short token, for a log line: its driver code (`P2028`) or its class name
 * (`SettlementReconcileError`), and never its message or stack.
 *
 * A message and a stack are written by pino as strings, which key-based redaction cannot rewrite, and a provider
 * failure's message can quote the `PaymentIntent` id it concerns — the one field the settlement log lines are
 * forbidden to carry. A token that is not a plain short identifier becomes `Error`.
 */
function failureToken(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'Error';
  }

  const { code, name } = error as { code?: unknown; name?: unknown };
  const token = typeof code === 'string' && code.length > 0 ? code : name;

  if (typeof token !== 'string' || !FAILURE_TOKEN_PATTERN.test(token)) {
    return 'Error';
  }
  return token;
}
