/**
 * Criterion 17 (AAP 0.12.1): the per-city call cap, the dialogue-budget refusal and the failure isolation of the
 * meetup flow, end to end across `api`, `workers` and the scripted telephony simulator.
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
const CITY = 'lisbon';
const CITY_ZONE = 'Europe/Lisbon';
const DAY = '2026-11-17';
const START_LOCAL_TIME = '10:00';

/** 12:00 local, the start of the criterion 1 meetup the third case walks while dispatch fails. */
const MEETUP_LOCAL_TIME = '12:00';

/** `CAP_CALLS_PER_CITY_DAY`'s documented default (AAP 0.5.6), asserted against the loaded env. */
const CALL_CAP = 40;

/** One task more than the cap, so the day's last slot is the one the boundary case turns on. */
const TASK_COUNT = CALL_CAP + 1;

/**
 * The number every task is given: the reserved fictional `+1 415 555 01xx` block of AAP 0.5.2, whose one hundred
 * numbers the harness's own `CALL_ALLOWLIST` holds. Each row passes a distinct one explicitly, because the factory's
 * per-process counter cannot cover forty-one of them.
 */
function phoneAt(index: number): string {
  return `+141555501${String(index).padStart(2, '0')}`;
}
const MAX_DISPATCH_PASSES = 12;
const DRAIN_ROUNDS = 60;
const DRAIN_PAUSE_MS = 100;
const CASE_TIMEOUT_MS = 180_000;

/** The label the third case's title carries, so a run's output names its Stripe topology. */
const MODE = stripeModeLabel();

/** Whether this run holds the stateful proxy, which is the only topology that can show an intent. */
const MOCK = inject('stripeMode') === 'mock';
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
  await t.resetState();
  await t.seedCities();
  t.time.at(localTimeOn(CITY_ZONE, DAY, START_LOCAL_TIME));
  t.simulator.setTarget(url);
  t.simulator.vendorDown(false);
});
function dispatch(cityId: string = CITY): Promise<unknown> {
  return runCallDispatch({ name: JOB[QUEUE.callDispatch].dispatchCity, data: { cityId } }, ctx);
}

/**
 * Run passes until one adds no call, which is the pass that decided every task it could: a batch is at most
 * `DISPATCH_BATCH_SIZE` (10) tasks, so forty-one of them are five passes. The count is asserted on its own rather
 * than compared to a table, so a failure's diff carries no number.
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
type Processor = (job: CallResultsJob, ctx: WorkerContext) => Promise<unknown>;

/**
 * Deliver the outbox and run `queueName`'s waiting jobs as a runner would (AAP 0.3.2), until `expected` have been
 * applied.
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

/** One city-local day's call counter (AAP 0.5.6), or `0` for a day nothing reserved against. */
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
 * The instant a task's next attempt is due after `failures` definite vendor rejections (AAP 0.5.3): `failure instant
 * + 60 s x 2^(failures - 1)`, measured from the attempt the failure was recorded on rather than from the clock as the
 * case reads it later.
 */
function vendorBackoffAt(startedAt: Date, failures: number): Date {
  const base = CALL_VENDOR_BACKOFF_BASE_SECONDS * 1_000;
  return new Date(startedAt.getTime() + base * CALL_VENDOR_BACKOFF_FACTOR ** (failures - 1));
}
const OUTAGE_TASKS = 3;
const OUTAGE_PASSES = 4;

/**
 * The criterion 1 walk on the server (AAP 0.5.4, 0.5.7): propose and lock real holds at `venue`, both attendees check in
 * with the code `GET /v1/venue/check-in-code` derives, and the settlement due at `startsAt + 45 min` runs one pass.
 * @returns The meetup's id.
 * @throws Error when the venue carries no console secret, which only a fixture built with one does.
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
describe('call caps and failure isolation', { timeout: CASE_TIMEOUT_MS }, () => {
  it("holds one city's local day at its cap and defers the next task to the next morning", async () => {
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
    const waiting = only((await taskRows()).filter((task) => task.status === 'queued'));
    expect(waiting.attempts).toBe(0);
    expect(waiting.nextAttemptAt.getTime()).toBe(deferredUntil.getTime());
    const waitingPhone = waiting.placeId === null ? undefined : phoneByPlace.get(waiting.placeId);
    expect(waitingPhone).toBeDefined();
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
    // The city's language-model spend for the local day is already at the cap, so one call's worst case cannot fit
    // under it; prefilling the column keeps the refusal the meter's own rather than a fractional cap (AAP 0.5.6).
    const day = localDateKey(CITY_ZONE, t.time.now());
    await t.services.db.$executeRaw(Prisma.sql`
      INSERT INTO "call_budget_day" ("city_id", "local_date", "llm_spend_micros")
      VALUES (${CITY}, CAST(${day} AS date), ${ctx.env.capLlmMicrosPerCityDay})
      ON CONFLICT ("city_id", "local_date")
      DO UPDATE SET "llm_spend_micros" = EXCLUDED."llm_spend_micros"`);
    const deferredUntil = nextLocalDayAt(CITY_ZONE, t.time.now(), CALLING_HOURS_START);
    await dispatch();
    await t.simulator.waitIdle();
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
    t.simulator.vendorDown(true);
    const startsAt = localTimeOn(CITY_ZONE, DAY, MEETUP_LOCAL_TIME);
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
    const metrics = await metricsAround(startsAt);
    expect(metrics.completion).toMatchObject({ lockedMeetups: 1, bothCheckedIn: 1, rate: 1 });
    expect(metrics.counts.noShows).toBe(0);
    expect(await completedCountOf(initiator.id, recipient.id)).toBe(1);
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
