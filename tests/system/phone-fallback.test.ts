/**
 * Criterion 12 (AAP 0.12.1): the price phone fallback, end to end across `api`, `workers` and the
 * scripted telephony simulator.
 */

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, testWorkersEnv, type TestApp } from '@tablemate/api/test-support/app';
import {
  callRoute,
  makeCallTask,
  makeMeetup,
  makePlace,
  makeProof,
  makeUser,
  makeVenue,
  rows,
} from '@tablemate/api/test-support/factories';
import type { PlaceFixture, VenueFixture } from '@tablemate/api/test-support/factories';
import type { SimCall } from '@tablemate/api/test-support/voice-simulator/simulator';
import { JOB, QUEUE, loadWorkersEnv, localTimeOn, nextOccurrenceOf } from '@tablemate/server-core';
import {
  CALLING_HOURS_START,
  CALL_MAX_ATTEMPTS,
  CALL_RETRY_SPACING_HOURS,
  HOUR_MS,
  SuggestionsResponse,
} from '@tablemate/shared';
import type { BlockedReason, CallTaskStatus, ItemCategory } from '@tablemate/shared';
import {
  closeWorkerContext,
  createWorkerContext,
  type WorkerContext,
} from '@tablemate/workers/queues';
import { process as dispatchCity } from '@tablemate/workers/jobs/call-dispatch';
import { process as applyCallResult } from '@tablemate/workers/jobs/call-results';
import { process as refreshFx } from '@tablemate/workers/jobs/fx-refresh';
import { ingestPlace } from '@tablemate/workers/jobs/menu-ingest';

const CITY = 'lisbon';

const CITY_ZONE = 'Europe/Lisbon';

/** The currency the call quotes in, which is the city's own. */
const CITY_CURRENCY = 'EUR';

const DAY = '2026-11-17';

const START_LOCAL_TIME = '10:00';

/**
 * The numbers the cases call, one each, from the reserved fictional ranges of AAP 0.5.2. The `+1 202`
 * block is used rather than the factory's own `+1 415` one, whose per-process counter would collide
 * with a fixed value: no two rows may share a number, because a `do_not_call` reply is about the
 * number and not about the row it was dialed from (AAP 0.5.3).
 */
const PHONE = {
  happy: '+12025550121',
  beforeHours: '+12025550122',
  afterHours: '+12025550123',
  unanswered: '+12025550124',
  refused: '+12025550125',
} as const;

/** `CAP_CALL_SECONDS`' documented default (AAP 0.6.2): no call may run longer. */
const CALL_SECONDS = 300;

const STATUS_CALLBACK_EVENTS = ['initiated', 'ringing', 'answered', 'completed'];

const DISCLOSURE_KEY = 'greeting.menu_prices';

/** Where that template lives, read rather than duplicated so an edited greeting cannot drift. */
const PT_PT_I18N = new URL(
  '../../apps/api/src/modules/voice-agent/i18n/pt-PT.json',
  import.meta.url,
);

const FX_FIXTURE = new URL('../../apps/workers/test/fixtures/fx/usd-latest.json', import.meta.url);

/* What the `prices-high` scenario answers with, and what the pipeline must store (AAP 0.5.6) */

interface ExpectedItem {
  /** The name as the callee said it, which becomes `PriceRecord.itemName`. */
  readonly name: string;
  readonly itemCategory: ItemCategory;
  /** The price in the currency's minor units, copied from what was heard. */
  readonly localAmountMinor: number;
  /** `localAmountMinor / 100 * 1.25 * 100`, rounded half up: the FX fixture quotes EUR at 0.8/USD. */
  readonly priceUsdCents: number;
}

const EXPECTED_ITEMS: readonly ExpectedItem[] = [
  { name: 'bitoque', itemCategory: 'main', localAmountMinor: 950, priceUsdCents: 1_188 },
  {
    name: 'cataplana de marisco',
    itemCategory: 'main',
    localAmountMinor: 3_200,
    priceUsdCents: 4_000,
  },
  { name: 'café', itemCategory: 'drink', localAmountMinor: 120, priceUsdCents: 150 },
];

/**
 * The estimate those items produce (AAP 0.5.7): the median main course, `(1,188 + 4,000) / 2`, plus
 * the one non-alcoholic drink at 150 — 2,744 cents, which fits the 3,000-cent budget the day-plan
 * read names. The range spans the cheapest main plus the cheapest drink to the dearest of each.
 */
const ESTIMATE_CENTS = 2_744;
const ESTIMATE_LOW_CENTS = 1_338;
const ESTIMATE_HIGH_CENTS = 4_150;

const BUDGET_CENTS = 3_000;

/**
 * The two local times a task must not be dialed at (AAP 0.5.6): 08:59 is before the window opens, and
 * 19:56 leaves less than the five minutes a call may last, so both wait for the next 09:00 local.
 */
const CALLING_HOURS_CASES = rows([
  { localTime: '08:59', phone: PHONE.beforeHours },
  { localTime: '19:56', phone: PHONE.afterHours },
]);

const CASE_TIMEOUT_MS = 120_000;

const DRAIN_POLLS = 60;

const DRAIN_INTERVAL_MS = 250;

let t: TestApp;
let ctx: WorkerContext;
let fx: Server;
let venue: VenueFixture;

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
  const table = await readFile(FX_FIXTURE, 'utf8');
  fx = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(table);
  });

  t = await createTestApp();
  ctx = await createWorkerContext(
    loadWorkersEnv(testWorkersEnv({ FX_URL: `${await listenOnLoopback(fx)}/usd-latest.json` })),
    { clock: t.clock, llm: t.llm, twilioHttpClient: t.simulator.httpClient, mailer },
  );

  // The relay socket, the TwiML fetch and the status callbacks all reach the app over a real TCP
  // address, so it listens and the simulator is pointed at where it does (AAP 0.11.2).
  await t.listen();
});

afterAll(async () => {
  fx.closeAllConnections();
  await new Promise<void>((resolve) => {
    fx.close(() => {
      resolve();
    });
  });

  await closeWorkerContext(ctx);
  await t.close();
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
  t.time.at(localTimeOn(CITY_ZONE, DAY, START_LOCAL_TIME));

  // The rates a phone quote converts through, written by the job that writes them in production
  // rather than inserted by hand, so the conversion a case asserts is the pipeline's own.
  await refreshFx({ name: JOB[QUEUE.fxRefresh].refresh, data: {} }, ctx);
  venue = await makeVenue(t, { cityId: CITY, isActivePartner: true });
});

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('the FX fixture server bound no TCP port');
  }

  return `http://127.0.0.1:${address.port}`;
}

/**
 * One place the pipeline can only reach by phone: a restaurant `200 m` from the venue, publishing no
 * website and no menu link, with the city's opening hours and its own reserved number.
 */
function menuPlace(phone: string): Promise<PlaceFixture> {
  return makePlace(t, {
    cityId: CITY,
    category: 'restaurant',
    near: { lat: venue.lat, lng: venue.lng },
    phone,
    openingHours: 'Mo-Su 09:00-23:30',
  });
}

function runDispatchCity(): Promise<unknown> {
  return dispatchCity({ name: JOB[QUEUE.callDispatch].dispatchCity, data: { cityId: CITY } }, ctx);
}

/** One call task as a case reads it, so an assertion names the columns the jobs write. */
interface TaskRow {
  readonly id: string;
  readonly kind: string;
  readonly status: CallTaskStatus;
  readonly attempts: number;
  readonly blockedReason: BlockedReason | null;
  readonly resolvedBy: string | null;
  readonly outcomeAt: Date | null;
  readonly nextAttemptAt: Date;
}

/** Every call task of one place, oldest id first, which is the order they were created in. */
function tasksOf(placeId: string): Promise<TaskRow[]> {
  return t.services.db.callTask.findMany({
    where: { placeId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      kind: true,
      status: true,
      attempts: true,
      blockedReason: true,
      resolvedBy: true,
      outcomeAt: true,
      nextAttemptAt: true,
    },
  });
}

/** The one task a case created, so an assertion never reads through a possibly-absent element. */
function onlyTask(tasks: readonly TaskRow[]): TaskRow {
  const task = tasks[0];

  if (task === undefined) {
    throw new Error('the place has no call task');
  }

  return task;
}

/** The instant the call task's latest counted attempt ended, which the 24-hour spacing is measured from. */
async function lastAttemptEndedAt(taskId: string): Promise<Date> {
  const attempt = await t.services.db.callAttempt.findFirstOrThrow({
    where: { callTaskId: taskId, state: { not: 'dispatch_failed' } },
    orderBy: { startedAt: 'desc' },
    select: { endedAt: true },
  });

  if (attempt.endedAt === null) {
    throw new Error('the call task has an attempt that never ended');
  }

  return attempt.endedAt;
}

/**
 * The one call the simulator made to `phone`. The count is asserted on its own, so a failure's diff
 * never carries a phone number (AAP 0.11.1).
 */
function callTo(phone: string): SimCall {
  const calls = t.simulator.callsTo(phone);
  expect(calls.length, 'exactly one call is expected to this number').toBe(1);

  const call = calls[0];
  if (call === undefined) {
    throw new Error('the simulator recorded no call to this number');
  }

  return call;
}

/**
 * Deliver what the relay committed and run the queue's waiting jobs as a runner would (AAP 0.3.2).
 * @returns How many jobs were applied, which one call is.
 * @throws Error when no job reached the queue within the bound.
 */
async function drainCallResults(): Promise<number> {
  const queue = t.services.queues.get(QUEUE.callResults);

  for (let poll = 0; poll < DRAIN_POLLS; poll += 1) {
    await t.services.outbox.runOnce();
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    if (jobs.length > 0) {
      for (const job of jobs) {
        await applyCallResult({ name: job.name, data: job.data as unknown }, ctx);
        await job.remove();
      }
      return jobs.length;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DRAIN_INTERVAL_MS);
    });
  }

  throw new Error('the call result was never delivered to the call-results queue');
}

async function disclosureTemplate(): Promise<string> {
  const document: unknown = JSON.parse(await readFile(PT_PT_I18N, 'utf8')) as unknown;
  const template = (document as Record<string, unknown>)[DISCLOSURE_KEY];

  if (typeof template !== 'string') {
    throw new Error(`pt-PT.json carries no ${DISCLOSURE_KEY}`);
  }

  return template;
}

describe('the price phone fallback', { timeout: CASE_TIMEOUT_MS }, () => {
  it('stores a phone quote and serves it in the pair day plan', async () => {
    const place = await menuPlace(PHONE.happy);
    expect(await ingestPlace(ctx, place.id)).toEqual({ pricedItems: 0, queuedCall: true });
    expect(onlyTask(await tasksOf(place.id))).toMatchObject({
      kind: 'menu_prices',
      status: 'queued',
      attempts: 0,
    });
    t.simulator.setScenarioFor(place.phone, 'prices-high');
    await runDispatchCity();
    await t.simulator.waitIdle();
    const call = callTo(place.phone);
    expect(call.spoken[0]).toEqual({
      text: await disclosureTemplate(),
      lang: 'pt-PT',
      source: 'welcome_greeting',
    });
    expect(call.createParams).toEqual({
      record: false,
      timeLimit: CALL_SECONDS,
      statusCallbackEvent: STATUS_CALLBACK_EVENTS,
      machineDetection: 'Enable',
      statusCallbackMethod: 'POST',
    });
    expect(call.failures).toEqual([]);
    expect(call.finalStatus).toBe('completed');
    expect(await drainCallResults()).toBe(1);
    const completed = onlyTask(await tasksOf(place.id));
    expect(completed).toMatchObject({
      status: 'completed',
      attempts: 1,
      resolvedBy: 'agent',
      blockedReason: null,
    });
    expect(completed.outcomeAt).not.toBeNull();
    const stored = await t.services.db.priceRecord.findMany({
      where: { placeId: place.id },
      select: {
        itemName: true,
        itemCategory: true,
        localAmountMinor: true,
        priceUsdCents: true,
        currency: true,
        source: true,
        sourceUrl: true,
        reviewStatus: true,
        alcoholic: true,
        captureBatchId: true,
      },
    });
    expect(stored).toHaveLength(EXPECTED_ITEMS.length);
    const byName = new Map(stored.map((row) => [row.itemName, row]));
    for (const item of EXPECTED_ITEMS) {
      expect(byName.get(item.name)).toMatchObject({
        itemCategory: item.itemCategory,
        localAmountMinor: item.localAmountMinor,
        priceUsdCents: item.priceUsdCents,
        currency: CITY_CURRENCY,
        source: 'phone_quote',
        sourceUrl: `tel:${place.phone}`,
        reviewStatus: 'approved',
        alcoholic: item.itemCategory === 'drink' ? false : null,
      });
    }
    expect(new Set(stored.map((row) => row.captureBatchId)).size).toBe(1);
    const initiator = await makeUser(t);
    const recipient = await makeUser(t);
    await makeProof(t, initiator, { cityId: CITY });
    await makeProof(t, recipient, { cityId: CITY });
    const meetup = await makeMeetup(t, {
      status: 'locked',
      initiator,
      recipient,
      venue,
      startsAt: new Date(t.time.now().getTime() + 4 * HOUR_MS),
    });
    const answer = await callRoute(t.app, {
      method: 'GET',
      url: `/v1/meetups/${meetup.id}/suggestions`,
      as: initiator,
      query: { perPersonBudgetCents: String(BUDGET_CENTS) },
    });
    expect(answer.status).toBe(200);
    const plan = SuggestionsResponse.parse(answer.json());
    expect(plan.budgetCents).toBe(BUDGET_CENTS);
    const suggestion = plan.items.find((item) => item.placeId === place.id);
    expect(suggestion?.priceSource).toBe('phone_quote');
    expect(suggestion?.estimatedCostRange).toEqual({
      estimateCents: ESTIMATE_CENTS,
      lowCents: ESTIMATE_LOW_CENTS,
      highCents: ESTIMATE_HIGH_CENTS,
    });
    expect(suggestion?.itemsUsed).toHaveLength(EXPECTED_ITEMS.length);
    expect(
      suggestion?.itemsUsed.every(
        (item) => item.source === 'phone_quote' && item.sourceUrl === `tel:${place.phone}`,
      ),
    ).toBe(true);
  });

  it.each(CALLING_HOURS_CASES)(
    'a task at $localTime local waits for the next 09:00 and is never dialed',
    async ({ localTime, phone }) => {
      const place = await menuPlace(phone);
      const at = t.time.at(localTimeOn(CITY_ZONE, DAY, localTime));
      expect(await ingestPlace(ctx, place.id)).toEqual({ pricedItems: 0, queuedCall: true });
      await runDispatchCity();
      await t.simulator.waitIdle();
      const deferred = onlyTask(await tasksOf(place.id));
      expect(deferred).toMatchObject({ status: 'queued', attempts: 0, blockedReason: null });
      expect(deferred.nextAttemptAt).toEqual(nextOccurrenceOf(CITY_ZONE, at, CALLING_HOURS_START));
      expect(t.simulator.callsTo(phone).length).toBe(0);
    },
  );

  it('stops calling once two attempts have gone unanswered', async () => {
    const place = await menuPlace(PHONE.unanswered);
    await ingestPlace(ctx, place.id);
    t.simulator.setScenarioFor(place.phone, 'no-answer');
    await runDispatchCity();
    await t.simulator.waitIdle();
    expect(await drainCallResults()).toBe(1);
    const first = onlyTask(await tasksOf(place.id));
    expect(first).toMatchObject({ status: 'queued', attempts: 1, blockedReason: null });
    const endedAt = await lastAttemptEndedAt(first.id);
    expect(first.nextAttemptAt).toEqual(
      new Date(endedAt.getTime() + CALL_RETRY_SPACING_HOURS * HOUR_MS),
    );
    // Exactly the 24 hours the rule spaces two attempts by — still inside the calling window, so the
    // second attempt is made rather than deferred (AAP 0.5.3).
    t.time.advance({ hours: CALL_RETRY_SPACING_HOURS });
    await runDispatchCity();
    await t.simulator.waitIdle();
    expect(await drainCallResults()).toBe(1);
    const second = onlyTask(await tasksOf(place.id));
    expect(second).toMatchObject({ status: 'unreachable', attempts: CALL_MAX_ATTEMPTS });
    expect(second.outcomeAt).not.toBeNull();
    expect(t.simulator.callsTo(place.phone).length).toBe(CALL_MAX_ATTEMPTS);
    t.time.advance({ hours: CALL_RETRY_SPACING_HOURS });
    await runDispatchCity();
    await t.simulator.waitIdle();
    expect(t.simulator.callsTo(place.phone).length).toBe(CALL_MAX_ATTEMPTS);
  });

  it('honours a request not to be called again', async () => {
    const place = await menuPlace(PHONE.refused);
    await ingestPlace(ctx, place.id);
    const later = new Date(t.time.now().getTime() + HOUR_MS);
    await makeCallTask(t, { kind: 'menu_prices', placeId: place.id, nextAttemptAt: later });
    const sibling = await menuPlace(PHONE.refused);
    await makeCallTask(t, { kind: 'menu_prices', placeId: sibling.id, nextAttemptAt: later });
    t.simulator.setScenarioFor(place.phone, 'do-not-call');
    await runDispatchCity();
    await t.simulator.waitIdle();
    expect(await drainCallResults()).toBe(1);
    expect((await tasksOf(place.id)).map((task) => task.status).sort()).toEqual([
      'cancelled',
      'do_not_call',
    ]);
    expect((await tasksOf(sibling.id)).map((task) => task.status)).toEqual(['cancelled']);
    expect(t.simulator.callsTo(place.phone).length).toBe(1);
    // Both rows holding the number refuse calls from now on (AAP 0.5.3).
    const flagged = await t.services.db.place.findMany({
      where: { id: { in: [place.id, sibling.id] } },
      select: { doNotCall: true },
    });
    expect(flagged).toEqual([{ doNotCall: true }, { doNotCall: true }]);
    // The number is closed for good: a later ingestion opens no task for either place, and nothing
    // dials it again.
    t.time.advance({ hours: CALL_RETRY_SPACING_HOURS });
    expect(await ingestPlace(ctx, place.id)).toEqual({ pricedItems: 0, queuedCall: false });
    expect(await ingestPlace(ctx, sibling.id)).toEqual({ pricedItems: 0, queuedCall: false });
    await runDispatchCity();
    await t.simulator.waitIdle();
    expect(t.simulator.callsTo(place.phone).length).toBe(1);
    expect((await tasksOf(sibling.id)).map((task) => task.status)).toEqual(['cancelled']);
  });
});
