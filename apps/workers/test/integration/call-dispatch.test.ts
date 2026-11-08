/**
 * Integration tests for the `call-dispatch` queue: eligibility, the calling window, the call a
 * dispatcher creates, and the two ways a dispatch is given up on (AAP 0.3.2, 0.5.3, 0.5.6, 0.5.7).
 *
 * This queue is the only way a call starts, so what the suite proves is the effect of its own
 * statements on the schema the run delivers: a number the call guard refuses is never dialed, a task
 * outside 09:00-20:00 local is deferred to the next local morning rather than dropped, the
 * `CallAttempt` is committed before Twilio is contacted, a definite vendor rejection gives back the
 * call slot and the attempt it spent while an ambiguous one gives back nothing, and a second
 * unanswered call ends the task where the operator queue picks it up. `create-task` opens a lodging
 * claim's verification task and schedules the claim's 72-hour expiry from the claim's own creation
 * instant.
 *
 * Every call is played by the scripted telephony simulator through the transport injected into the
 * Twilio client (AAP 0.11.2), against the real PostgreSQL 16 with PostGIS and Redis the harness
 * starts. Three of the simulator's behaviours carry the interesting cases: a `no-answer` scenario
 * posts the status callbacks the API's own `POST /v1/webhooks/voice` route records, a `vendor-down`
 * switch throws the connection refusal server-core reads as *definite*, and a wrapping transport
 * answers a call create with `503` without forwarding it — the ambiguous dispatch that no listing can
 * disprove. Time comes only from the injected clock (AAP 0.11.1), so the calling window's two
 * boundaries, the 24-hour spacing, the vendor backoff and the 15-minute reconciliation grace are each
 * reachable in a tick.
 *
 * @see AAP 0.3.2 for the dispatch sequence, what it holds and the reconciliation that follows it,
 *   0.5.3 for the call-task and lodging-claim lifecycles and their timers, 0.5.6 for eligibility, the
 *   calling window, the caps and the dialogue budget, 0.5.7 for `outcomeAt`, 0.12.1 criterion 12 for
 *   the deferral and the two unanswered attempts, 0.12.2 for the allowlist and `record: false`,
 *   0.11.1 for the injected clock and the table-driven density, and 0.8.1 for this file's row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestApp,
  testCallAllowlist,
  testWorkersEnv,
  type TestApp,
} from '@tablemate/api/test-support/app';
import {
  makeCallTask,
  makeClaim,
  makeLodging,
  makePlace,
  makeUser,
} from '@tablemate/api/test-support/factories';
import type { DbClient } from '@tablemate/db';
import {
  JOB,
  QUEUE,
  QUEUE_JOB_OPTIONS,
  TWILIO_SIMULATOR,
  claimExpireJobId,
  loadWorkersEnv,
  localDateKey,
  localTimeOn,
  outboxJobId,
  parseOutboxPayload,
  type TwilioHttpClient,
} from '@tablemate/server-core';
import {
  CALL_DISPATCH_GRACE_MINUTES,
  CALL_MAX_ATTEMPTS,
  CALL_RETRY_SPACING_HOURS,
  CALL_VENDOR_BACKOFF_BASE_SECONDS,
  CALL_VENDOR_BACKOFF_FACTOR,
  CALL_VENDOR_MAX_FAILURES,
  CALLING_HOURS_START,
  CLAIM_EXPIRY_HOURS,
  HOUR_MS,
  MINUTE_MS,
} from '@tablemate/shared';
import type { BlockedReason, CallAttemptState, CallTaskStatus } from '@tablemate/shared';

import { process as runCallDispatch, type CallDispatchJob } from '../../src/jobs/call-dispatch.ts';
import { process as runCallResults, type CallResultsJob } from '../../src/jobs/call-results.ts';
import { closeWorkerContext, createWorkerContext, type WorkerContext } from '../../src/queues.ts';

/* The fixture set (AAP 0.5.2) */

/** The city every case works in, its zone, and the two local days the cases cross. */
const CITY = 'lisbon';
const LISBON = 'Europe/Lisbon';
const DAY_ONE = '2026-11-10';
const DAY_TWO = '2026-11-11';

/**
 * The instant every case starts at: Lisbon 10:00, inside the calling window with room for a call that
 * runs its whole `CAP_CALL_SECONDS` allowance. Lisbon is on WET in November, so this is 10:00 UTC.
 */
const NOW = localTimeOn(LISBON, DAY_ONE, '10:00');

/** Milliseconds in a second, for the constants `@tablemate/shared` states in seconds. */
const SECOND_MS = 1_000;

/** Two numbers the test allowlist holds, and one it does not, so the guard must refuse it. */
const MENU_PHONE = '+14155550161';
const LODGING_PHONE = '+14155550171';
const STRANGER_PHONE = '+16175550142';

/* The harness (AAP 0.11.2) */

let app: TestApp;
let store: DbClient;
let ctx: WorkerContext;

beforeAll(async () => {
  app = await createTestApp();
  store = app.services.db;
  // Binding the API is what gives the simulator its target: it signs over `API_PUBLIC_URL` and posts
  // every callback to the address this call resolves, so the signed URL and the real one agree.
  await app.listen();
  ctx = await createWorkerContext(
    loadWorkersEnv(
      testWorkersEnv({
        API_PUBLIC_URL: app.env.API_PUBLIC_URL,
        CALL_ALLOWLIST: testCallAllowlist(),
      }),
    ),
    { clock: app.clock, twilioHttpClient: app.simulator.httpClient },
  );
});

afterAll(async () => {
  await app.simulator.waitIdle();
  await closeWorkerContext(ctx);
  await app.close();
});

beforeEach(async () => {
  // `resetState` returns the database, Redis and the simulator to a state a fresh run would see and
  // puts the clock back at the harness's own default, so the clock is moved after it.
  await app.resetState();
  await app.seedCities();
  app.time.at(NOW);
  app.simulator.reset();
});

/* Reading what a run wrote (AAP 0.5.3, 0.5.7) */

/** The instant the injected clock reads. */
function now(): Date {
  return app.clock.now();
}

/** One call task as an assertion names its columns. */
interface TaskRow {
  readonly status: CallTaskStatus;
  readonly blockedReason: BlockedReason | null;
  readonly attempts: number;
  readonly vendorFailures: number;
  readonly nextAttemptAt: Date;
  readonly outcomeAt: Date | null;
  readonly lodgingId: string | null;
  readonly lodgingClaimId: string | null;
}

/** One attempt as an assertion names it: its dispatch state, its evidence and the budget it holds. */
interface AttemptView {
  readonly id: string;
  readonly state: CallAttemptState;
  readonly twilioCallSid: string | null;
  readonly llmReservedMicros: bigint;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

/** The task as it stands, so an assertion names the columns the queue writes. */
function taskRow(taskId: string): Promise<TaskRow> {
  return store.callTask.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      status: true,
      blockedReason: true,
      attempts: true,
      vendorFailures: true,
      nextAttemptAt: true,
      outcomeAt: true,
      lodgingId: true,
      lodgingClaimId: true,
    },
  });
}

/** Every attempt of a task, oldest first: the dispatcher's own order of its calls. */
function attemptsOf(taskId: string): Promise<AttemptView[]> {
  return store.callAttempt.findMany({
    where: { callTaskId: taskId },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      state: true,
      twilioCallSid: true,
      llmReservedMicros: true,
      startedAt: true,
      endedAt: true,
    },
  });
}

/** The task's latest attempt, which is the one a case's verdict concerns. */
async function requireAttempt(taskId: string): Promise<AttemptView> {
  const attempt = (await attemptsOf(taskId)).at(-1);
  if (attempt === undefined) {
    throw new Error('the call task has no attempt');
  }
  return attempt;
}

/**
 * One city-local day's call and language-model counters (AAP 0.5.6), or `null` for a day nothing
 * reserved against. `call_budget_day.local_date` is a `date`, so the key is that day's UTC midnight,
 * which is the day `localDateKey` names it by.
 */
async function budgetOn(
  localDate: string,
): Promise<{ calls: number; llmReservedMicros: bigint } | null> {
  return store.callBudgetDay.findUnique({
    where: {
      cityId_localDate: { cityId: CITY, localDate: new Date(`${localDate}T00:00:00.000Z`) },
    },
    select: { calls: true, llmReservedMicros: true },
  });
}

/* Driving the queue (AAP 0.3.2, 0.5.6) */

/** One `dispatch-city` run, the job the per-city scheduler adds. */
function dispatchCity(context: WorkerContext, cityId: string = CITY) {
  return runCallDispatch(
    { id: `call-dispatch-${cityId}`, name: JOB[QUEUE.callDispatch].dispatchCity, data: { cityId } },
    context,
  );
}

/** A queued menu task that is due now, with a fixture place the call reaches. */
async function seedMenuTask(phone: string = MENU_PHONE): Promise<string> {
  const place = await makePlace(app, { cityId: CITY, category: 'restaurant', phone });
  const task = await makeCallTask(app, {
    kind: 'menu_prices',
    placeId: place.id,
    nextAttemptAt: now(),
  });

  return task.id;
}

/**
 * Apply the result the API's status webhook recorded on an attempt (AAP 0.3.2): the
 * `apply_call_result` outbox row that route wrote in the transaction recording the outcome, then the
 * `call-results` / `apply` job the row becomes. The row is read from the database rather than
 * rebuilt, so what the case applies is what the API really committed.
 */
async function applyRecordedResult(attemptId: string): Promise<void> {
  const row = await store.outboxMessage.findFirstOrThrow({
    where: { kind: 'apply_call_result' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, payload: true },
  });
  expect(parseOutboxPayload('apply_call_result', row.payload)).toEqual({
    callAttemptId: attemptId,
  });

  const job: CallResultsJob = {
    id: outboxJobId(row.id),
    name: JOB[QUEUE.callResults].apply,
    data: { outboxId: row.id, callAttemptId: attemptId },
    opts: { attempts: QUEUE_JOB_OPTIONS[QUEUE.callResults].attempts ?? 1 },
  };

  await runCallResults(job, ctx);
}

/** A vendor failure's backoff instant: `now + 60 s x 2^(failures - 1)` (AAP 0.5.3). */
function vendorBackoffAt(failures: number, at: Date): Date {
  const base = CALL_VENDOR_BACKOFF_BASE_SECONDS * SECOND_MS;
  return new Date(at.getTime() + base * CALL_VENDOR_BACKOFF_FACTOR ** (failures - 1));
}

/* The suite (AAP 0.12.2 eligibility, 0.12.1 criterion 12) */

describe('call dispatch', () => {
  it('leaves a task whose number the guard refuses queued, and never dials it', async () => {
    // Stated at run time rather than assumed: the number is outside every prefix the test allowlist
    // holds, which is what makes the verdict below the guard's refusal rather than a fixture gap.
    expect(testCallAllowlist().split(',')).not.toContain(STRANGER_PHONE);

    const taskId = await seedMenuTask(STRANGER_PHONE);

    await expect(dispatchCity(ctx)).resolves.toMatchObject({ decisions: { allowlist_block: 1 } });

    const task = await taskRow(taskId);
    expect(task.status).toBe('queued');
    expect(task.blockedReason).toBe('not_allowlisted');
    expect(task.attempts).toBe(0);
    expect(app.simulator.calls).toHaveLength(0);
    expect(await attemptsOf(taskId)).toHaveLength(0);
    expect((await budgetOn(localDateKey(LISBON, NOW)))?.calls ?? 0).toBe(0);
  });

  /** One calling-window case: the instant to stand at, and what a pass there must make of it. */
  type HoursCase =
    | { readonly name: string; readonly at: Date; readonly dials: false; readonly until: Date }
    | { readonly name: string; readonly at: Date; readonly dials: true };

  const HOURS_CASES = [
    {
      name: 'defers a call a minute before the window opens to 09:00 the same local day',
      at: localTimeOn(LISBON, DAY_ONE, '08:59'),
      dials: false,
      until: localTimeOn(LISBON, DAY_ONE, CALLING_HOURS_START),
    },
    {
      name: 'defers a call one second past the last start that fits the cap to the next local morning',
      at: new Date(localTimeOn(LISBON, DAY_ONE, '19:55').getTime() + SECOND_MS),
      dials: false,
      until: localTimeOn(LISBON, DAY_TWO, CALLING_HOURS_START),
    },
    {
      name: 'dials at 19:55 exactly, the last start whose allowance still ends by 20:00',
      at: localTimeOn(LISBON, DAY_ONE, '19:55'),
      dials: true,
    },
  ] satisfies readonly HoursCase[];

  it.each(HOURS_CASES)('$name', async (row) => {
    app.time.at(row.at);
    // The line is unanswered, so a call that is dialed ends without a turn and no dialogue runs.
    app.simulator.setScenarioFor(MENU_PHONE, 'no-answer');
    const taskId = await seedMenuTask();

    await dispatchCity(ctx);

    if (row.dials) {
      await app.simulator.waitIdle();
      expect(app.simulator.calls).toHaveLength(1);

      const dialed = await taskRow(taskId);
      expect(dialed.status).toBe('in_progress');
      expect(dialed.attempts).toBe(1);
      expect(dialed.blockedReason).toBeNull();

      const attempt = await requireAttempt(taskId);
      expect(attempt.twilioCallSid).not.toBeNull();
      expect(attempt.state).not.toBe('dispatching');
      return;
    }

    // Outside the window nothing is dialed: the task keeps its status and moves only its next
    // attempt, so it is deferred to the next morning rather than dropped or left to spin.
    expect(app.simulator.calls).toHaveLength(0);

    const deferred = await taskRow(taskId);
    expect(deferred.status).toBe('queued');
    expect(deferred.attempts).toBe(0);
    expect(deferred.nextAttemptAt.getTime()).toBe(row.until.getTime());
    expect(await attemptsOf(taskId)).toHaveLength(0);
  });

  it('records the attempt before dialing, with recording off and the attempt id in both callbacks', async () => {
    app.simulator.setScenarioFor(MENU_PHONE, 'no-answer');
    const taskId = await seedMenuTask();

    await dispatchCity(ctx);
    await app.simulator.waitIdle();

    const [call] = app.simulator.calls;
    expect(call).toBeDefined();
    const attempt = await requireAttempt(taskId);

    // The create the SDK built carries what AAP 0.5.6 and 0.12.2 fix and no caller may change: the
    // hard bound, no recording, machine detection, one POST callback per progress event.
    expect(call?.createParams).toMatchObject({
      record: false,
      timeLimit: ctx.env.CAP_CALL_SECONDS,
      statusCallbackMethod: 'POST',
      machineDetection: 'Enable',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });
    expect(call?.to).toBe(MENU_PHONE);
    expect(call?.from).toBe(TWILIO_SIMULATOR.fromNumber);

    // Both URLs were built from `API_PUBLIC_URL` — a base the simulator does not recognize is
    // recorded as `url_origin_mismatch` — and the attempt id they carry is what the API resolved the
    // status callback by, which is why this attempt adopted the call's SID.
    expect(call?.failures).toEqual([]);
    expect(call?.attemptId).toBe(attempt.id);
    expect(attempt.twilioCallSid).toBe(call?.sid);
    expect(attempt.state).toBe('ended');
  });

  it('requeues an unanswered task a day later, and ends it after the second unanswered call', async () => {
    app.simulator.setScenarioFor(MENU_PHONE, 'no-answer');
    const taskId = await seedMenuTask();

    await dispatchCity(ctx);
    await app.simulator.waitIdle();

    const first = await requireAttempt(taskId);
    expect(first.twilioCallSid).not.toBeNull();
    expect(first.state).toBe('ended');
    expect(first.endedAt).not.toBeNull();
    expect(app.simulator.calls).toHaveLength(1);

    // The call ended unanswered: the API's status webhook recorded that on the attempt, and the
    // queue's own apply job is what moves the task on it, delivered here as the outbox dispatcher
    // would (AAP 0.3.2).
    await applyRecordedResult(first.id);

    const endedAt = first.endedAt ?? now();
    const spacing = CALL_RETRY_SPACING_HOURS * HOUR_MS;
    const requeued = await taskRow(taskId);
    expect(requeued.status).toBe('queued');
    expect(requeued.attempts).toBe(1);
    expect(requeued.blockedReason).toBeNull();
    expect(requeued.nextAttemptAt.getTime()).toBe(endedAt.getTime() + spacing);
    // The call was placed, so the day's slot stays consumed: only a definite rejection gives it back.
    expect((await budgetOn(localDateKey(LISBON, endedAt)))?.calls).toBe(1);

    // 23 h 59 min later the 24-hour spacing still holds the task back, and nothing is dialed.
    app.time.advance({ hours: 23, minutes: 59 });
    await dispatchCity(ctx);
    expect(app.simulator.calls).toHaveLength(1);

    // At the spacing instant itself the second attempt is allowed, and it goes unanswered too.
    app.time.at(new Date(endedAt.getTime() + spacing));
    await dispatchCity(ctx);
    await app.simulator.waitIdle();
    expect(app.simulator.calls).toHaveLength(2);

    const second = await requireAttempt(taskId);
    expect(second.id).not.toBe(first.id);
    await applyRecordedResult(second.id);

    const stopped = await taskRow(taskId);
    expect(stopped.status).toBe('unreachable');
    expect(stopped.attempts).toBe(CALL_MAX_ATTEMPTS);
    expect(stopped.outcomeAt?.getTime()).toBe(second.endedAt?.getTime());
    expect((await budgetOn(localDateKey(LISBON, second.endedAt ?? now())))?.calls).toBe(1);

    // A third pass dials nothing: the task is no longer queued at all.
    await dispatchCity(ctx);
    expect(app.simulator.calls).toHaveLength(2);
  });

  it('returns a definite vendor rejection to the queue with backoff, keeping the two-call allowance', async () => {
    // A refused connection proves the request never reached the vendor, so no call exists and the
    // dispatch is definite: the slot goes back, `attempts` is decremented and the task waits on the
    // vendor backoff instead of spending one of its two calls (AAP 0.3.2, 0.5.3).
    app.simulator.vendorDown(true);
    const taskId = await seedMenuTask();

    for (let failures = 1; failures <= CALL_VENDOR_MAX_FAILURES; failures += 1) {
      const at = now();
      await dispatchCity(ctx);

      const task = await taskRow(taskId);
      expect(task.attempts).toBe(0);
      expect(task.vendorFailures).toBe(failures);

      const day = await budgetOn(localDateKey(LISBON, at));
      expect(day?.calls ?? 0).toBe(0);
      expect(day?.llmReservedMicros ?? 0n).toBe(0n);

      const attempts = await attemptsOf(taskId);
      expect(attempts).toHaveLength(failures);
      expect(attempts.at(-1)?.state).toBe('dispatch_failed');
      expect(attempts.at(-1)?.llmReservedMicros).toBe(0n);

      if (failures < CALL_VENDOR_MAX_FAILURES) {
        const until = vendorBackoffAt(failures, at);
        expect(task.status).toBe('queued');
        expect(task.nextAttemptAt.getTime()).toBe(until.getTime());
        app.time.at(until);
      } else {
        // The vendor allowance is spent: the task joins the operator queue with its own outcome.
        expect(task.status).toBe('needs_review');
        expect(task.blockedReason).toBe('vendor_unavailable');
        expect(task.outcomeAt?.getTime()).toBe(at.getTime());
      }
    }

    expect(app.simulator.calls).toHaveLength(0);
  });

  it('never redials an ambiguous create, and hands the task to the operator once the grace elapses', async () => {
    // A create answered `503` reached the vendor, so a call may exist that nothing can disprove: the
    // attempt becomes `dispatch_unknown`, the call slot and the dialogue budget stay consumed, and no
    // later pass may dial again (AAP 0.3.2).
    const real = app.simulator.httpClient;
    let creates = 0;
    const wrapper: TwilioHttpClient = {
      async request(request) {
        if (request.method === 'post') {
          creates += 1;
          return {
            statusCode: 503,
            body: { code: 20500, message: 'Internal error', status: 503 },
            headers: {},
          };
        }
        return await real.request(request);
      },
    };

    const taskId = await seedMenuTask();
    const context = await createWorkerContext(ctx.env, {
      clock: app.clock,
      twilioHttpClient: wrapper,
    });

    try {
      const start = now();
      await dispatchCity(context);

      // The wrapper never forwarded the create, so the simulator never saw the call it may hold.
      expect(creates).toBe(1);
      expect(app.simulator.calls).toHaveLength(0);

      const unknown = await requireAttempt(taskId);
      expect(unknown.state).toBe('dispatch_unknown');
      expect(unknown.twilioCallSid).toBeNull();
      expect(unknown.startedAt.getTime()).toBe(start.getTime());
      expect((await taskRow(taskId)).status).toBe('in_progress');

      const reserved = (await budgetOn(localDateKey(LISBON, start))) ?? {
        calls: 0,
        llmReservedMicros: 0n,
      };
      expect(reserved.calls).toBe(1);
      expect(reserved.llmReservedMicros > 0n).toBe(true);

      // Three more passes inside the grace dial nothing: the task is claimed, so the batch has no
      // candidate, and the attempt is not yet due for reconciliation.
      app.time.advance({ minutes: 1 });
      for (let pass = 0; pass < 3; pass += 1) {
        await dispatchCity(context);
      }
      expect(creates).toBe(1);
      expect(app.simulator.calls).toHaveLength(0);

      const graceMs = CALL_DISPATCH_GRACE_MINUTES * MINUTE_MS;
      const allowanceMs = ctx.env.CAP_CALL_SECONDS * SECOND_MS;

      // One minute short of the grace the call may still be up, so nothing is resolved.
      app.time.at(new Date(unknown.startedAt.getTime() + allowanceMs + graceMs - MINUTE_MS));
      await dispatchCity(context);
      expect((await taskRow(taskId)).status).toBe('in_progress');

      // At the grace the attempt is resolved without a `CallSid`, and what the listing offered is
      // never evidence: the reservation stays consumed and the task waits for a person.
      app.time.at(new Date(unknown.startedAt.getTime() + allowanceMs + graceMs));
      await dispatchCity(context);

      const review = await taskRow(taskId);
      expect(review.status).toBe('needs_review');
      expect(review.blockedReason).toBe('dispatch_unknown');
      expect(review.outcomeAt?.getTime()).toBe(now().getTime());
      expect(creates).toBe(1);

      const after = await budgetOn(localDateKey(LISBON, start));
      expect(after?.calls).toBe(reserved.calls);
      expect(after?.llmReservedMicros).toBe(reserved.llmReservedMicros);
    } finally {
      await closeWorkerContext(context);
    }
  });

  /** One claim case: how the lodging a claim names can be called, and what that opens. */
  interface ClaimCase {
    readonly name: string;
    readonly phone: string | null;
    readonly doNotCall: boolean;
    readonly status: CallTaskStatus;
    readonly blockedReason?: BlockedReason;
  }

  const CLAIM_CASES = [
    {
      name: 'a lodging with no phone number',
      phone: null,
      doNotCall: false,
      status: 'unreachable',
      blockedReason: 'no_phone',
    },
    {
      name: 'a lodging that asked not to be called',
      phone: LODGING_PHONE,
      doNotCall: true,
      status: 'unreachable',
      blockedReason: 'do_not_call',
    },
    {
      name: 'a lodging with an allowlisted number',
      phone: LODGING_PHONE,
      doNotCall: false,
      status: 'queued',
    },
  ] satisfies readonly ClaimCase[];

  it.each(CLAIM_CASES)('create-task opens $name and schedules the claim expiry', async (row) => {
    const user = await makeUser(app);
    const lodging = await makeLodging(app, {
      cityId: CITY,
      doNotCall: row.doNotCall,
      ...(row.phone === null ? {} : { phone: row.phone }),
    });
    if (row.phone === null) {
      await store.lodging.update({ where: { id: lodging.id }, data: { phone: null } });
    }

    const claim = await makeClaim(app, user, lodging);
    // The claim was opened an hour ago, which is what makes the 72-hour expiry assertable exactly.
    const createdAt = new Date(now().getTime() - HOUR_MS);
    await store.lodgingClaim.update({ where: { id: claim.id }, data: { createdAt } });

    const payload = parseOutboxPayload('create_call_task', { lodgingClaimId: claim.id });
    const outbox = await store.outboxMessage.create({
      data: { kind: 'create_call_task', payload, createdAt: now() },
      select: { id: true },
    });
    const job: CallDispatchJob = {
      id: outboxJobId(outbox.id),
      name: JOB[QUEUE.callDispatch].createTask,
      data: { outboxId: outbox.id, lodgingClaimId: claim.id },
    };

    await expect(runCallDispatch(job, ctx)).resolves.toEqual({ created: true, status: row.status });

    const task = await store.callTask.findFirstOrThrow({
      where: { lodgingClaimId: claim.id },
      select: {
        kind: true,
        status: true,
        blockedReason: true,
        attempts: true,
        outcomeAt: true,
        lodgingId: true,
      },
    });
    expect(task.kind).toBe('lodging_stay_verification');
    expect(task.status).toBe(row.status);
    expect(task.blockedReason).toBe(row.blockedReason ?? null);
    expect(task.lodgingId).toBe(lodging.id);
    expect(task.attempts).toBe(0);
    // A safety refusal is what puts the task in front of a person, dated when it happened; a task
    // that may be dialed carries no outcome at all.
    expect(task.outcomeAt?.getTime() ?? null).toBe(
      row.status === 'queued' ? null : now().getTime(),
    );
    // The claim is untouched either way, so a claimant whose lodging cannot be called still sees a
    // claim waiting rather than a decision they cannot appeal (AAP 0.5.3).
    const claimRow = await store.lodgingClaim.findUniqueOrThrow({
      where: { id: claim.id },
      select: { status: true },
    });
    expect(claimRow.status).toBe('pending_call');

    // The 72-hour expiry is scheduled from the claim's own creation instant under its stable id, so
    // it fires 72 hours after the claim was opened whatever time this run reached it.
    const queue = ctx.queues.get(QUEUE.lodgingClaims);
    const expiry = await queue.getJob(claimExpireJobId(claim.id));
    expect(expiry?.name).toBe(JOB[QUEUE.lodgingClaims].claimExpire);
    expect(expiry?.data).toEqual({ claimId: claim.id });
    expect(expiry?.opts.delay).toBe(
      createdAt.getTime() + CLAIM_EXPIRY_HOURS * HOUR_MS - now().getTime(),
    );

    // A redelivered outbox row opens no second task and leaves the timer as it stands.
    await expect(runCallDispatch(job, ctx)).resolves.toEqual({ created: false, status: null });
    expect(await store.callTask.count({ where: { lodgingClaimId: claim.id } })).toBe(1);
    expect((await queue.getJob(claimExpireJobId(claim.id)))?.opts.delay).toBe(expiry?.opts.delay);
  });
});
