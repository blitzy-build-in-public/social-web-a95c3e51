/**
 * Criterion 17 (AAP 0.12.1): the per-city call cap, the dialogue-budget refusal and the failure
 * isolation of the meetup flow, end to end across `api`, `workers` and the scripted telephony
 * simulator.
 *
 * Three claims, and none of them is observable from one process alone:
 *
 *  - **The cap holds at 40 calls for one city on one local day.** Forty-one due `menu_prices` tasks
 *    are decided in one afternoon: exactly forty calls are placed, to forty distinct numbers, and the
 *    forty-first task keeps its status and waits for 09:00 the next local morning. That morning it is
 *    the only task due, so the second local day places exactly one call (`calls/caps.ts`).
 *  - **A call whose dialogue budget cannot be reserved is never dialed.** With the city's local day
 *    already at `CAP_LLM_USD_PER_CITY_DAY`, the reservation is refused before the task is claimed: no
 *    attempt exists, the day's call slot is untouched and the task waits for the next morning
 *    (AAP 0.5.6).
 *  - **Telephony failing cannot block proposing, locking, checking in or settling.** Four dispatch
 *    passes run concurrently with a whole meetup walk while every Twilio create is refused: no call
 *    is placed, every task keeps the two calls it is allowed and waits on the vendor backoff, and the
 *    meetup still completes, releases both holds and reports a 100% completion rate (AAP 0.12.1
 *    criterion 17; AAP 0.12.2 "suggestions, price jobs or telephony failures MUST NOT block proposing,
 *    locking, checking in or settling").
 *
 * The suite drives the jobs rather than a queue runner — `dispatch-city` and the `call-results`
 * processor are called directly, the outbox poller is the app's own — so each case observes the
 * effect of the production path on the schema the run delivers (AAP 0.11.2). Every call is played by
 * the simulator through the transport injected into the Twilio client, so no traffic leaves the host.
 * Time comes only from the injected clock the app and the workers share, and every city-local instant
 * is derived through `@tablemate/server-core`'s city-time helpers rather than a hard-coded UTC
 * offset, because Lisbon keeps DST (AAP 0.11.1).
 *
 * The third case's title carries `stripeModeLabel()`, so `docs/acceptance.md` records mock evidence
 * apart from test-mode evidence: the holds it settles belong to the stateful proxy in
 * `STRIPE_MODE=mock` and are Stripe's own test-mode objects under `pnpm test:stripe`.
 *
 * @see AAP 0.12.1 criterion 17 for the recorded result, 0.12.2 for the isolation and the caps, 0.5.3
 *   for the call-task lifecycle and the vendor backoff, 0.5.6 for the caps, the dialogue budget and
 *   the 09:00 deferral, 0.5.7 for the completion rate, 0.11.1 and 0.11.2 for the harness and the
 *   density conventions, and 0.8.1 for this file's inventory row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  createTestApp,
  testCallAllowlist,
  testWorkersEnv,
  type TestApp,
} from '@tablemate/api/test-support/app';
import { settleNow } from '@tablemate/api/test-support/clock';
import {
  callRoute,
  checkIn,
  makeCallTask,
  makePlace,
  makeUser,
  makeVenue,
  proposeAndLock,
  stripeModeLabel,
} from '@tablemate/api/test-support/factories';
import type { UserFixture, VenueFixture } from '@tablemate/api/test-support/factories';
import { Prisma } from '@tablemate/db';
import {
  JOB,
  QUEUE,
  loadWorkersEnv,
  localDateKey,
  localTimeOn,
  nextLocalDayAt,
  type QueueName,
} from '@tablemate/server-core';
import {
  CALLING_HOURS_START,
  CALL_VENDOR_BACKOFF_BASE_SECONDS,
  CALL_VENDOR_BACKOFF_FACTOR,
  DAY_MS,
  DEFAULT_DEPOSIT_CENTS,
  MetricsDto,
  OUR_CANCELLATION_REASON,
} from '@tablemate/shared';
import type { CallAttemptState, CallTaskStatus } from '@tablemate/shared';
import { process as runCallDispatch } from '@tablemate/workers/jobs/call-dispatch';
import {
  process as runCallResults,
  type CallResultsJob,
} from '@tablemate/workers/jobs/call-results';
import {
  closeWorkerContext,
  createWorkerContext,
  type WorkerContext,
} from '@tablemate/workers/queues';

/* The city the cases work in, and the instants they stand at (AAP 0.5.2, 0.11.1) */

/** The launch city whose cap and queue every case drives, and its IANA zone. */
const CITY = 'lisbon';
const CITY_ZONE = 'Europe/Lisbon';

/** The local day every case starts on: the day after the harness's own `DEFAULT_TEST_NOW`. */
const DAY = '2026-11-17';

/** 10:00 local, inside the 09:00-20:00 calling window with room for a whole `CAP_CALL_SECONDS`. */
const START_LOCAL_TIME = '10:00';

/** 12:00 local, the start of the criterion 1 meetup the third case walks while dispatch fails. */
const MEETUP_LOCAL_TIME = '12:00';

/** `CAP_CALLS_PER_CITY_DAY`'s documented default (AAP 0.5.6), asserted against the loaded env. */
const CALL_CAP = 40;

/** One task more than the cap, so the day's last slot is the one the boundary case turns on. */
const TASK_COUNT = CALL_CAP + 1;

/**
 * The number every task is given: the reserved fictional `+1 415 555 01xx` block of AAP 0.5.2, whose
 * one hundred numbers the harness's own `CALL_ALLOWLIST` holds. Each row passes a distinct one
 * explicitly, because the factory's per-process counter cannot cover forty-one of them.
 */
function phoneAt(index: number): string {
  return `+141555501${String(index).padStart(2, '0')}`;
}

/** The most `dispatch-city` passes {@link dispatchUntilIdle} spends before it gives up. */
const MAX_DISPATCH_PASSES = 12;

/** The most outbox passes {@link drain} spends waiting for the jobs a commit produced. */
const DRAIN_ROUNDS = 60;

/** The pause between two of those passes, in milliseconds. */
const DRAIN_PAUSE_MS = 100;

/** How long one case may take: case one places forty-one simulated calls, each with its callbacks. */
const CASE_TIMEOUT_MS = 180_000;

/** The label the third case's title carries, so a run's output names its Stripe topology. */
const MODE = stripeModeLabel();

/** Whether this run holds the stateful proxy, which is the only topology that can show an intent. */
const MOCK = inject('stripeMode') === 'mock';

/* The harness (AAP 0.11.2) */

let t: TestApp;
let ctx: WorkerContext;

/** The address the app listens on, which the simulator posts every callback to. */
let url: string;

/** Everything the worker context would mail; nothing here sends any, and no SMTP server is reached. */
const sentMail: unknown[] = [];

/** The mailer a worker context would deliver through, stood in for so no SMTP server is contacted. */
const mailer: WorkerContext['mailer'] = {
  send: (message) => {
    sentMail.push(message);
    return Promise.resolve();
  },
};

beforeAll(async () => {
  t = await createTestApp();
  url = await t.listen();
  ctx = await createWorkerContext(
    loadWorkersEnv(
      testWorkersEnv({
        API_PUBLIC_URL: t.env.API_PUBLIC_URL,
        CALL_ALLOWLIST: testCallAllowlist(),
      }),
    ),
    { clock: t.clock, llm: t.llm, twilioHttpClient: t.simulator.httpClient, mailer },
  );

  // The cap the first case is about is the configured default, not a value this suite arranged.
  expect(ctx.env.CAP_CALLS_PER_CITY_DAY).toBe(CALL_CAP);
});

afterAll(async () => {
  await t.simulator.waitIdle();
  await closeWorkerContext(ctx);
  await t.close();
});

beforeEach(async () => {
  // `resetState` returns the database, Redis, the proxy and the simulator to a state a fresh run
  // would see and puts the clock back at the harness's own default, so the clock moves after it.
  await t.resetState();
  await t.seedCities();
  t.time.at(localTimeOn(CITY_ZONE, DAY, START_LOCAL_TIME));

  // `reset` disarms the outage and restores the default scenario; the target is re-pointed anyway so
  // a case cannot inherit an address from the one before it.
  t.simulator.setTarget(url);
  t.simulator.vendorDown(false);
});

/* Driving the queues (AAP 0.3.2, 0.5.6) */

/** One `dispatch-city` run, the job the per-city scheduler adds. */
function dispatch(cityId: string = CITY): Promise<unknown> {
  return runCallDispatch({ name: JOB[QUEUE.callDispatch].dispatchCity, data: { cityId } }, ctx);
}

/**
 * Run passes until one adds no call, which is the pass that decided every task it could: a batch is
 * at most `DISPATCH_BATCH_SIZE` (10) tasks, so forty-one of them are five passes. The count is
 * asserted on its own rather than compared to a table, so a failure's diff carries no number.
 */
async function dispatchUntilIdle(cityId: string = CITY): Promise<number> {
  let previous = t.simulator.calls.length;

  for (let pass = 0; pass < MAX_DISPATCH_PASSES; pass += 1) {
    await dispatch(cityId);
    await t.simulator.waitIdle();

    const current = t.simulator.calls.length;
    if (current === previous) {
      return current;
    }
    previous = current;
  }

  throw new Error(`dispatch-city added a call in each of ${MAX_DISPATCH_PASSES} passes`);
}

/** The processor shape the two worker jobs share (AAP 0.11.2). */
type Processor = (job: CallResultsJob, ctx: WorkerContext) => Promise<unknown>;

/**
 * Deliver the outbox and run `queueName`'s waiting jobs as a runner would (AAP 0.3.2), until
 * `expected` have been applied.
 *
 * The API writes one `apply_call_result` row in the transaction that records an outcome, the poller
 * turns each row into a job under `outbox-<id>`, and this suite runs that job. A row may not be
 * committed when `waitIdle` resolves — a call's last status callback and the lifecycle that ends it
 * travel on different connections — so each round is a bounded pass with a pause, and the rounds stop
 * as soon as the expected number has been applied.
 *
 * @returns How many jobs were applied.
 * @throws Error when fewer than `expected` arrived within {@link DRAIN_ROUNDS} rounds.
 */
async function drain(
  queueName: QueueName,
  processor: Processor,
  expected: number,
): Promise<number> {
  const queue = t.services.queues.get(queueName);
  let applied = 0;

  for (let round = 0; round < DRAIN_ROUNDS && applied < expected; round += 1) {
    await t.services.outbox.runOnce();
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);

    for (const job of jobs) {
      await processor({ name: job.name, data: job.data as unknown }, ctx);
      await job.remove();
      applied += 1;
    }

    if (jobs.length === 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, DRAIN_PAUSE_MS);
      });
    }
  }

  if (applied < expected) {
    throw new Error(`only ${applied} of the ${expected} expected jobs were delivered`);
  }

  return applied;
}

/* Reading what a run wrote (AAP 0.5.3, 0.5.6, 0.5.7) */

/** One call task as an assertion names the columns the queue and the jobs write. */
interface TaskRow {
  readonly id: string;
  readonly placeId: string | null;
  readonly status: CallTaskStatus;
  readonly attempts: number;
  readonly vendorFailures: number;
  readonly nextAttemptAt: Date;
}

/** Every call task, so a case counts the states rather than naming rows it did not create. */
function taskRows(): Promise<TaskRow[]> {
  return t.services.db.callTask.findMany({
    select: {
      id: true,
      placeId: true,
      status: true,
      attempts: true,
      vendorFailures: true,
      nextAttemptAt: true,
    },
    orderBy: { id: 'asc' },
  });
}

/** Every task's attempts, oldest first, which is the order the dispatcher made them in. */
function attemptRows(taskIds: readonly string[]) {
  return t.services.db.callAttempt.findMany({
    where: { callTaskId: { in: [...taskIds] } },
    select: { callTaskId: true, state: true, startedAt: true },
    orderBy: { startedAt: 'asc' },
  });
}

/**
 * One city-local day's call counter (AAP 0.5.6), or `0` for a day nothing reserved against.
 * `call_budget_day.local_date` is a `date`, so the key is that day's UTC midnight — the day
 * `localDateKey` names it by.
 */
async function callsOn(localDate: string): Promise<number> {
  const day = await t.services.db.callBudgetDay.findUnique({
    where: {
      cityId_localDate: { cityId: CITY, localDate: new Date(`${localDate}T00:00:00.000Z`) },
    },
    select: { calls: true },
  });

  return day?.calls ?? 0;
}

/** The one element a case expects, so an assertion never reads through a possibly-absent element. */
function only<T>(items: readonly T[]): T {
  const [first] = items;

  if (first === undefined) {
    throw new Error('the case expected one row and found none');
  }

  return first;
}

/**
 * The instant a task's next attempt is due after `failures` definite vendor rejections (AAP 0.5.3):
 * `failure instant + 60 s x 2^(failures - 1)`, measured from the attempt the failure was recorded on
 * rather than from the clock as the case reads it later.
 */
function vendorBackoffAt(startedAt: Date, failures: number): Date {
  const base = CALL_VENDOR_BACKOFF_BASE_SECONDS * 1_000;
  return new Date(startedAt.getTime() + base * CALL_VENDOR_BACKOFF_FACTOR ** (failures - 1));
}

/* Walking the meetup the third case completes (AAP 0.12.1 criterion 1) */

/** How many queued tasks the vendor outage finds waiting, and how many passes it is driven with. */
const OUTAGE_TASKS = 3;
const OUTAGE_PASSES = 4;

/**
 * The criterion 1 walk on the server (AAP 0.5.4, 0.5.7): propose and lock real holds at `venue`, both
 * attendees check in with the code `GET /v1/venue/check-in-code` derives, and the settlement due at
 * `startsAt + 45 min` runs one pass.
 *
 * @returns The meetup's id.
 * @throws Error when the venue carries no console secret, which only a fixture built with one does not.
 */
async function walkMeetup(
  initiator: UserFixture,
  recipient: UserFixture,
  venue: VenueFixture,
  startsAt: Date,
): Promise<string> {
  const { meetupId } = await proposeAndLock(t, {
    initiator,
    recipient,
    venue,
    startsAt,
    depositCents: DEFAULT_DEPOSIT_CENTS,
  });

  const secret = venue.secret;
  if (secret === null) {
    throw new Error('the venue has no console secret to derive a check-in code from');
  }

  t.time.toMeetupPoint({ startsAt }, 'startsAt');
  const at = { id: meetupId, venueId: venue.id };
  expect((await checkIn(t, initiator, at, { venueSecret: secret })).bothCheckedIn).toBe(false);
  expect((await checkIn(t, recipient, at, { venueSecret: secret })).bothCheckedIn).toBe(true);

  t.time.toMeetupPoint({ startsAt }, 'startsAt+45m');
  await settleNow(t.services);

  return meetupId;
}

/** A fixed number of dispatch passes, each yielding so the meetup flow's awaits interleave with them. */
async function failingDispatches(): Promise<void> {
  for (let pass = 0; pass < OUTAGE_PASSES; pass += 1) {
    await dispatch();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** The dashboard for a window around `at`, as an operator's own token reads it (AAP 0.5.4, 0.5.7). */
async function metricsAround(at: Date): Promise<MetricsDto> {
  const operator = await makeUser(t, { role: 'operator', card: 'none' });
  const response = await callRoute(t.app, {
    method: 'GET',
    url: '/v1/admin/metrics',
    as: await t.tokenFor(operator),
    query: {
      from: localDateKey(CITY_ZONE, new Date(at.getTime() - DAY_MS)),
      to: localDateKey(CITY_ZONE, new Date(at.getTime() + DAY_MS)),
      cityId: CITY,
    },
  });

  expect(
    response.status,
    `GET /v1/admin/metrics answered ${response.status}: ${response.body}`,
  ).toBe(200);
  return MetricsDto.parse(response.json());
}

/** The pair's completions, keyed the way the settlement keys the row (AAP 0.5.2, 0.5.7). */
async function completedCountOf(a: string, b: string): Promise<number> {
  const pair = a.toLowerCase() < b.toLowerCase() ? { low: a, high: b } : { low: b, high: a };
  const row = await t.services.db.pairHistory.findUnique({
    where: { userLowId_userHighId: { userLowId: pair.low, userHighId: pair.high } },
    select: { completedCount: true },
  });

  return row?.completedCount ?? 0;
}

/* Criterion 17 (AAP 0.12.1) */

describe('call caps and failure isolation', { timeout: CASE_TIMEOUT_MS }, () => {
  it("holds one city's local day at its cap and defers the next task to the next morning", async () => {
    // The line is unanswered, so a call that is dialed ends without a dialogue turn and the case is
    // the dispatcher's own decisions rather than the relay's.
    t.simulator.setDefaultScenario('busy');

    const phones: string[] = [];
    const phoneByPlace = new Map<string, string>();

    for (let index = 0; index < TASK_COUNT; index += 1) {
      const phone = phoneAt(index);
      const place = await makePlace(t, {
        cityId: CITY,
        category: 'restaurant',
        phone,
        openingHours: 'Mo-Su 09:00-23:30',
      });
      await makeCallTask(t, {
        kind: 'menu_prices',
        placeId: place.id,
        nextAttemptAt: t.time.now(),
      });
      phones.push(phone);
      phoneByPlace.set(place.id, phone);
    }

    const day = localDateKey(CITY_ZONE, t.time.now());
    const deferredUntil = nextLocalDayAt(CITY_ZONE, t.time.now(), CALLING_HOURS_START);

    expect(await dispatchUntilIdle()).toBe(CALL_CAP);
    expect(t.simulator.calls.length).toBe(CALL_CAP);
    expect(new Set(t.simulator.calls.map((call) => call.to)).size).toBe(CALL_CAP);
    expect(t.simulator.calls.every((call) => phones.includes(call.to))).toBe(true);
    expect(await callsOn(day)).toBe(CALL_CAP);

    // Exactly one task was left undialed, and the cap is what held it back: it keeps the two calls it
    // is allowed and waits for the next local morning (AAP 0.5.6).
    const waiting = only((await taskRows()).filter((task) => task.status === 'queued'));
    expect(waiting.attempts).toBe(0);
    expect(waiting.nextAttemptAt.getTime()).toBe(deferredUntil.getTime());
    const waitingPhone = waiting.placeId === null ? undefined : phoneByPlace.get(waiting.placeId);
    expect(waitingPhone).toBeDefined();

    // The forty unanswered calls are applied: each of them returns to the queue a day after its own
    // call ended, which is past the next 09:00, so only the deferred task is due then. The deferred
    // task keeps its zero attempts and its morning: the drain has nothing to apply for it.
    expect(await drain(QUEUE.callResults, runCallResults, CALL_CAP)).toBe(CALL_CAP);
    const afterDrain = await taskRows();
    const requeued = afterDrain.filter((task) => task.status === 'queued' && task.attempts === 1);
    expect(requeued).toHaveLength(CALL_CAP);
    expect(requeued.some((task) => task.id === waiting.id)).toBe(false);
    expect(requeued.every((task) => task.nextAttemptAt.getTime() > deferredUntil.getTime())).toBe(
      true,
    );

    const stillWaiting = only(afterDrain.filter((task) => task.id === waiting.id));
    expect(stillWaiting.status).toBe('queued');
    expect(stillWaiting.attempts).toBe(0);
    expect(stillWaiting.nextAttemptAt.getTime()).toBe(deferredUntil.getTime());

    // The next local morning places exactly one call, and it is the one the cap left behind. The two
    // numbers are compared as a boolean so neither can reach a failure's diff (AAP 0.11.1).
    t.time.at(deferredUntil);
    await dispatch();
    await t.simulator.waitIdle();

    expect(t.simulator.calls.length).toBe(TASK_COUNT);
    expect(t.simulator.calls.at(-1)?.to === waitingPhone).toBe(true);
    expect(await callsOn(localDateKey(CITY_ZONE, deferredUntil))).toBe(1);
  });

  it('never dials a task whose dialogue budget cannot be reserved, and defers it', async () => {
    const place = await makePlace(t, { cityId: CITY, category: 'restaurant', phone: phoneAt(0) });
    const task = await makeCallTask(t, {
      kind: 'menu_prices',
      placeId: place.id,
      nextAttemptAt: t.time.now(),
    });

    // The city's language-model spend for the local day is already at the cap, so one call's worst
    // case cannot fit under it. Prefilling the column is what keeps the refusal the meter's own
    // rather than a fractional cap the environment schema would refuse (AAP 0.5.6).
    const day = localDateKey(CITY_ZONE, t.time.now());
    await t.services.db.$executeRaw(Prisma.sql`
      INSERT INTO "call_budget_day" ("city_id", "local_date", "llm_spend_micros")
      VALUES (${CITY}, CAST(${day} AS date), ${ctx.env.capLlmMicrosPerCityDay})
      ON CONFLICT ("city_id", "local_date")
      DO UPDATE SET "llm_spend_micros" = EXCLUDED."llm_spend_micros"`);

    const deferredUntil = nextLocalDayAt(CITY_ZONE, t.time.now(), CALLING_HOURS_START);
    await dispatch();
    await t.simulator.waitIdle();

    // Nothing was dialed, no attempt exists, and the task waits for the next morning: the refusal
    // happens before the task is claimed, so the day's call counter is untouched.
    expect(t.simulator.calls.length).toBe(0);
    expect(await callsOn(day)).toBe(0);
    expect(await attemptRows([task.id])).toHaveLength(0);

    const row = only(await taskRows());
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt.getTime()).toBe(deferredUntil.getTime());
  });

  it(`${MODE} completes the meetup and releases both holds while every dispatch is refused`, async () => {
    const initiator = await makeUser(t, { card: 'visa' });
    const recipient = await makeUser(t, { card: 'visa' });
    const venue = await makeVenue(t, { cityId: CITY, isActivePartner: true });

    const taskIds: string[] = [];
    for (let index = 0; index < OUTAGE_TASKS; index += 1) {
      const place = await makePlace(t, {
        cityId: CITY,
        category: 'restaurant',
        phone: phoneAt(index),
      });
      const task = await makeCallTask(t, {
        kind: 'menu_prices',
        placeId: place.id,
        nextAttemptAt: t.time.now(),
      });
      taskIds.push(task.id);
    }

    // Every Twilio create is refused from here on: a connection refused before anything is sent, which
    // is the definite kind, so no call ever exists (AAP 0.3.2, 0.12.1 criterion 17).
    t.simulator.vendorDown(true);

    const startsAt = localTimeOn(CITY_ZONE, DAY, MEETUP_LOCAL_TIME);

    // The two branches interleave: the meetup flow must be unaffected by dispatch passes that fail.
    const [meetupId] = await Promise.all([
      walkMeetup(initiator, recipient, venue, startsAt),
      failingDispatches(),
    ]);

    const meetup = await t.services.db.meetup.findUniqueOrThrow({
      where: { id: meetupId },
      select: { status: true, bothCheckedInAt: true },
    });
    expect(meetup.status).toBe('completed');
    expect(meetup.bothCheckedInAt).not.toBeNull();

    // Both holds are released, and the topology of this run says how: the proxy shows the two
    // PaymentIntents Stripe cancelled for us, and in test mode the durable evidence is the two
    // release operations the executor completed (AAP 0.3.2, 0.5.3).
    const deposits = await t.services.db.deposit.findMany({
      where: { meetupId },
      select: { status: true },
    });
    expect(deposits).toHaveLength(2);
    expect(deposits.every((deposit) => deposit.status === 'released')).toBe(true);

    if (MOCK) {
      const control = t.stripe.proxy;
      if (control === null) {
        throw new Error('STRIPE_MODE=mock must hold the stateful proxy');
      }
      const intents = await control.paymentIntents({ metadata: { meetupId } });
      expect(intents).toHaveLength(2);
      for (const intent of intents) {
        expect(intent.status).toBe('canceled');
        expect(intent.cancellation_reason).toBe(OUR_CANCELLATION_REASON);
      }
    } else {
      const releases = await t.services.db.paymentOperation.findMany({
        where: { deposit: { meetupId }, kind: 'release' },
        select: { status: true },
      });
      expect(releases).toHaveLength(2);
      expect(releases.every((operation) => operation.status === 'succeeded')).toBe(true);
    }

    // The headline the pilot is judged by, and the pair's history behind the top disclosure tiers.
    const metrics = await metricsAround(startsAt);
    expect(metrics.completion).toMatchObject({ lockedMeetups: 1, bothCheckedIn: 1, rate: 1 });
    expect(metrics.counts.noShows).toBe(0);
    expect(await completedCountOf(initiator.id, recipient.id)).toBe(1);

    // The outage itself: no call was placed, no task spent an attempt, and every dispatch left an
    // attempt of the definite kind behind it.
    expect(t.simulator.calls.length).toBe(0);
    expect(await callsOn(localDateKey(CITY_ZONE, startsAt))).toBe(0);

    const tasks = (await taskRows()).filter((task) => taskIds.includes(task.id));
    expect(tasks).toHaveLength(OUTAGE_TASKS);
    expect(tasks.every((task) => task.status === 'queued')).toBe(true);
    expect(tasks.every((task) => task.attempts === 0)).toBe(true);
    expect(tasks.every((task) => task.vendorFailures >= 1)).toBe(true);

    const attempts = await attemptRows(taskIds);
    expect(attempts.length).toBeGreaterThanOrEqual(OUTAGE_TASKS);
    const states: CallAttemptState[] = attempts.map((attempt) => attempt.state);
    expect(states.every((state) => state === 'dispatch_failed')).toBe(true);

    // Each task waits on the vendor backoff its own last failure set, measured from that attempt, so a
    // definite rejection never spends one of the two calls the task is allowed (AAP 0.5.3).
    const latest = new Map<string, Date>();
    for (const attempt of attempts) {
      latest.set(attempt.callTaskId, attempt.startedAt);
    }

    for (const task of tasks) {
      const startedAt = latest.get(task.id);
      expect(startedAt).toBeDefined();
      if (startedAt !== undefined) {
        expect(task.nextAttemptAt.getTime()).toBe(
          vendorBackoffAt(startedAt, task.vendorFailures).getTime(),
        );
      }
    }
  });
});
