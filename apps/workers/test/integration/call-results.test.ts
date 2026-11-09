/**
 * Integration tests for `apps/workers/src/jobs/call-results.ts` (AAP 0.3.2, 0.5.3, 0.5.6, 0.5.7).
 */

import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, testWorkersEnv, type TestApp } from '@tablemate/api/test-support/app';
import {
  makeCallAttempt,
  makeCallTask,
  makeClaim,
  makeLodging,
  makeMeetup,
  makePlace,
  makeUser,
  makeVenue,
  type CallAttemptFixture,
  type CallTaskFixture,
  type ClaimFixture,
  type LodgingFixture,
  type MeetupFixture,
  type PlaceFixture,
  type UserFixture,
} from '@tablemate/api/test-support/factories';
import type { DbClient, Prisma } from '@tablemate/db';
import {
  JOB,
  QUEUE,
  QUEUE_JOB_OPTIONS,
  actorHash,
  loadWorkersEnv,
  outboxJobId,
  pairKey,
  parseOutboxPayload,
} from '@tablemate/server-core';
import {
  CALL_MAX_ATTEMPTS,
  CALL_RETRY_SPACING_HOURS,
  CHECK_IN_CLOSES_AFTER_MINUTES,
  HOUR_MS,
  MINUTE_MS,
} from '@tablemate/shared';
import type {
  BlockedReason,
  CallAttemptOutcome,
  CallTaskStatus,
  LodgingClaimStatus,
} from '@tablemate/shared';

import {
  FxRateUnavailableError,
  process as runCallResults,
  type CallResultsJob,
  type CallResultsResult,
} from '../../src/jobs/call-results.ts';
import { process as runFxRefresh } from '../../src/jobs/fx-refresh.ts';
import { normalizeItemName } from '../../src/jobs/menu-ingest.ts';
import { closeWorkerContext, createWorkerContext, type WorkerContext } from '../../src/queues.ts';

const CITY = 'lisbon';

/**
 * The instant every case starts at: Lisbon midday on the harness's own default day. `resetState`
 * returns the clock here, and each case states it so the reason the dates below line up is visible.
 */
const NOW = new Date('2026-11-16T12:00:00.000Z');

const FX_FIXTURE = new URL('../fixtures/fx/usd-latest.json', import.meta.url);

/** The number a menu call is dialed from, from the reserved fictional range (AAP 0.5.2). */
const MENU_PHONE = '+14155550150';
const SHARED_PHONE = '+14155550151';
const OTHER_PHONE = '+14155550152';

/**
 * One priced item a menu call collected, in the shape the API's relay records it (AAP 0.5.6):
 * `amountMinor` is the price in the currency's minor units and `priceText` is the price as heard.
 */
interface MenuPriceItem {
  readonly slot: 'cheapest_main' | 'priciest_main' | 'coffee' | 'beer';
  readonly dish: string;
  readonly priceText: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly confirmed: boolean;
}

type ExtractedFields =
  | { readonly kind: 'menu_prices'; readonly items: readonly MenuPriceItem[] }
  | {
      readonly kind: 'lodging_stay_verification';
      readonly answer: 'yes' | 'no' | null;
      readonly confirmed: boolean;
    };

const MENU_ITEMS: readonly MenuPriceItem[] = [
  {
    slot: 'cheapest_main',
    dish: 'Bitoque',
    priceText: '9,50 €',
    amountMinor: 950,
    currency: 'EUR',
    confirmed: true,
  },
  {
    slot: 'priciest_main',
    dish: 'Bacalhau',
    priceText: '18,50 €',
    amountMinor: 1850,
    currency: 'EUR',
    confirmed: true,
  },
  {
    slot: 'coffee',
    dish: 'Café',
    priceText: '0,90 €',
    amountMinor: 90,
    currency: 'EUR',
    confirmed: true,
  },
  {
    slot: 'beer',
    dish: 'Imperial',
    priceText: '2,50 €',
    amountMinor: 250,
    currency: 'EUR',
    confirmed: true,
  },
];

/** Each dish's price in whole USD cents: `amountMinor / 100 * 1.25 * 100`, rounded half up. */
const USD_CENTS: Readonly<Record<string, number>> = {
  Bitoque: 1188,
  Bacalhau: 2313,
  Café: 113,
  Imperial: 313,
};

const STAY_FROM = '2026-11-09';
const STAY_TO = '2026-11-15';

const IN_STAY = new Date('2026-11-12T12:00:00.000Z');
const OUTSIDE_STAY = new Date('2026-10-20T12:00:00.000Z');
const BEFORE_WINDOW = new Date('2026-07-01T12:00:00.000Z');

let app: TestApp;
let store: DbClient;
let ctx: WorkerContext;
let fx: Server;

beforeAll(async () => {
  const table = await readFile(FX_FIXTURE, 'utf8');
  // The recorded provider response, served over HTTP: `fx-refresh` reads it through the same path it
  // reads the real endpoint through, so the rates and their own date are the recorded ones (AAP 0.3.3).
  fx = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(table);
  });
  const fxUrl = await listenOnLoopback(fx);

  app = await createTestApp();
  store = app.services.db;
  ctx = await createWorkerContext(
    loadWorkersEnv(testWorkersEnv({ FX_URL: `${fxUrl}/usd-latest.json` })),
    { clock: app.clock },
  );
});

afterAll(async () => {
  fx.closeAllConnections();
  await new Promise<void>((resolve) => {
    fx.close(() => {
      resolve();
    });
  });
  await closeWorkerContext(ctx);
  await app.close();
});

beforeEach(async () => {
  await app.resetState();
  await app.seedCities();
  app.time.at(NOW);
  // The rates every `phone_quote` converts through, written by the job that writes them in production
  // rather than inserted by hand, so the conversion the cases assert is the pipeline's own.
  await runFxRefresh({ name: JOB[QUEUE.fxRefresh].refresh, data: {} }, ctx);
});

/**
 * Start a fixture HTTP server on an ephemeral loopback port.
 * @param server - The server to start.
 * @returns Its `http://127.0.0.1:<port>` base.
 * @throws Error when the server bound no TCP address.
 */
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

/** The instant the clock reads, which is the end of every attempt these cases seed. */
function now(): Date {
  return app.clock.now();
}

/** The task as it stands, so an assertion names the columns the job writes. */
function taskRow(taskId: string): Promise<{
  readonly status: CallTaskStatus;
  readonly blockedReason: BlockedReason | null;
  readonly resolvedBy: string | null;
  readonly outcomeAt: Date | null;
  readonly nextAttemptAt: Date;
}> {
  return store.callTask.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      status: true,
      blockedReason: true,
      resolvedBy: true,
      outcomeAt: true,
      nextAttemptAt: true,
    },
  });
}

/**
 * The job one outbox row becomes: the row the API's relay would have written, parsed before the insert
 * as `outbox/write.ts` parses it, dispatched under the stable id of AAP 0.3.2.
 * @param attemptId - The attempt whose recorded result the row names.
 * @returns The `call-results` / `apply` job carrying that row.
 */
async function callResultJob(attemptId: string): Promise<CallResultsJob> {
  const payload = parseOutboxPayload('apply_call_result', { callAttemptId: attemptId });
  const row = await store.outboxMessage.create({
    data: { kind: 'apply_call_result', payload, createdAt: now() },
    select: { id: true },
  });

  return {
    id: outboxJobId(row.id),
    name: JOB[QUEUE.callResults].apply,
    data: { outboxId: row.id, callAttemptId: attemptId },
  };
}

/**
 * Runs one `apply` job as BullMQ would, at the delivery the caller names.
 * @param job - The job to run.
 * @param delivery - `first` for a delivery a retry follows, `last` for the one that has none.
 * @returns What the processor reports.
 */
function runJob(
  job: CallResultsJob,
  delivery: 'first' | 'last' = 'first',
): Promise<CallResultsResult> {
  if (delivery === 'first') {
    return runCallResults(job, ctx);
  }

  const attempts = QUEUE_JOB_OPTIONS[QUEUE.callResults].attempts ?? 1;

  return runCallResults({ ...job, attemptsMade: attempts - 1, opts: { attempts } }, ctx);
}

/**
 * Writes what the API's relay recorded on an attempt: the extraction the dialogue contract defines.
 * @param attemptId - The attempt to write.
 * @param fields - The extraction, or any other payload a case needs.
 */
async function setExtraction(attemptId: string, fields: ExtractedFields): Promise<void> {
  await store.callAttempt.update({
    where: { id: attemptId },
    data: { extractedFields: asJson(fields) },
  });
}

/** A JSON column's input, which Prisma types structurally rather than by the values it holds. */
function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

interface MenuCall {
  readonly place: PlaceFixture;
  readonly task: CallTaskFixture;
  readonly attempt: CallAttemptFixture;
}

interface MenuCallInput {
  readonly outcome: CallAttemptOutcome;
  readonly confidence?: 'high' | 'low';
  readonly items?: readonly MenuPriceItem[];
  readonly attempts?: number;
  readonly phone?: string;
}

/**
 * Seed one `menu_prices` task in `in_progress` with one ended attempt, as the dispatcher leaves them.
 * @param input - The outcome the call produced and whatever the case varies.
 * @returns The place the call was dialed to, the task and the attempt.
 */
async function seedMenuCall(input: MenuCallInput): Promise<MenuCall> {
  const place = await makePlace(app, {
    cityId: CITY,
    category: 'restaurant',
    phone: input.phone ?? MENU_PHONE,
  });
  const task = await makeCallTask(app, {
    kind: 'menu_prices',
    placeId: place.id,
    status: 'in_progress',
    attempts: input.attempts ?? 1,
  });
  const attempt = await makeCallAttempt(app, task, {
    state: 'ended',
    outcome: input.outcome,
    durationSec: 90,
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
  });

  await setExtraction(attempt.id, { kind: 'menu_prices', items: input.items ?? MENU_ITEMS });

  return { place, task, attempt };
}

interface StayCall {
  readonly claimant: UserFixture;
  readonly counterpart: UserFixture;
  readonly lodging: LodgingFixture;
  readonly claim: ClaimFixture;
  readonly task: CallTaskFixture;
  readonly attempt: CallAttemptFixture;
  readonly inStay: MeetupFixture;
}

interface StayCallInput {
  readonly outcome: CallAttemptOutcome;
  readonly answer: 'yes' | 'no' | null;
  readonly confidence?: 'high' | 'low';
  readonly attempts?: number;
}

/**
 * Seed one `lodging_stay_verification` task in `in_progress`, the `calling` claim it verifies, and the
 * completed meetups a verified stay is credited with.
 * @param input - The outcome the call produced and whatever the case varies.
 * @returns The rows the assertion needs, including the meetup inside the stay.
 */
async function seedStayCall(input: StayCallInput): Promise<StayCall> {
  const claimant = await makeUser(app);
  const counterpart = await makeUser(app);
  const venue = await makeVenue(app, { cityId: CITY });
  const lodging = await makeLodging(app, { cityId: CITY });
  const claim = await makeClaim(app, claimant, lodging, {
    status: 'calling',
    stayFrom: STAY_FROM,
    stayTo: STAY_TO,
  });

  await store.lodgingClaim.update({
    where: { id: claim.id },
    data: { createdAt: new Date(now().getTime() - 2 * HOUR_MS) },
  });

  const inStay = await makeMeetup(app, {
    status: 'completed',
    initiator: claimant,
    recipient: counterpart,
    venue,
    startsAt: IN_STAY,
  });
  await makeMeetup(app, {
    status: 'completed',
    initiator: claimant,
    recipient: counterpart,
    venue,
    startsAt: OUTSIDE_STAY,
  });
  await makeMeetup(app, {
    status: 'completed',
    initiator: counterpart,
    recipient: claimant,
    venue,
    startsAt: BEFORE_WINDOW,
  });

  const task = await makeCallTask(app, {
    kind: 'lodging_stay_verification',
    lodgingId: lodging.id,
    lodgingClaimId: claim.id,
    status: 'in_progress',
    attempts: input.attempts ?? 1,
  });
  const attempt = await makeCallAttempt(app, task, {
    state: 'ended',
    outcome: input.outcome,
    durationSec: 45,
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
  });

  await setExtraction(attempt.id, {
    kind: 'lodging_stay_verification',
    answer: input.answer,
    confirmed: input.answer !== null,
  });

  return { claimant, counterpart, lodging, claim, task, attempt, inStay };
}

/** Every row a result may move, for the deep equality of the cases that must change nothing. */
interface Rows {
  readonly task: readonly unknown[];
  readonly attempts: readonly unknown[];
  readonly records: readonly unknown[];
  readonly outbox: readonly unknown[];
}

/**
 * Read the rows of one menu call, so a case can assert that a refused result changed none of them.
 * @param call - The seeded call.
 * @returns Its task, its attempts, its price records and every outbox row.
 */
async function callRows(call: MenuCall): Promise<Rows> {
  return {
    task: await store.callTask.findMany({ where: { id: call.task.id } }),
    attempts: await store.callAttempt.findMany({
      where: { callTaskId: call.task.id },
      orderBy: { startedAt: 'asc' },
    }),
    records: await store.priceRecord.findMany({
      where: { placeId: call.place.id },
      orderBy: { id: 'asc' },
    }),
    outbox: await store.outboxMessage.findMany({ orderBy: { id: 'asc' } }),
  };
}

interface AppliedResult {
  readonly job: CallResultsJob;
  readonly result: CallResultsResult;
}

/**
 * Apply one seeded result as the dispatcher would: the outbox row the API's relay writes, then the job
 * that row becomes.
 * @param attemptId - The attempt whose recorded result is applied.
 * @param delivery - Which delivery of that job this is.
 * @returns The job, so a case can redeliver it, and what the processor reported.
 */
async function applyResult(
  attemptId: string,
  delivery: 'first' | 'last' = 'first',
): Promise<AppliedResult> {
  const job = await callResultJob(attemptId);

  return { job, result: await runJob(job, delivery) };
}

/** One case of a recorded menu result: what the call produced and what the task must read after it. */
interface MenuMapping {
  readonly name: string;
  readonly outcome: CallAttemptOutcome;
  readonly confidence?: 'high' | 'low';
  readonly items?: readonly MenuPriceItem[];
  readonly attempts?: number;
  readonly status: CallTaskStatus;
  readonly blockedReason?: BlockedReason;
  readonly records: number;
  readonly reviewStatus?: 'approved' | 'needs_review';
}

/**
 * Every outcome a menu call can record, and the task status and price records each leaves behind
 * (AAP 0.5.3's lifecycle, 0.5.6's confidence rule): a call that collected every price completes the
 * task, one that collected less hands it to an operator queue, and the outcomes that collected nothing
 * store no price at all.
 */
const MENU_MAPPINGS: readonly MenuMapping[] = [
  {
    name: 'a completed call with every price confirmed completes the task',
    outcome: 'completed',
    confidence: 'high',
    status: 'completed',
    records: MENU_ITEMS.length,
    reviewStatus: 'approved',
  },
  {
    name: 'a completed call with one price unconfirmed goes to the operator queue',
    outcome: 'completed',
    confidence: 'low',
    items: MENU_ITEMS.map((item, index) => (index === 0 ? { ...item, confirmed: false } : item)),
    status: 'needs_review',
    records: MENU_ITEMS.length,
    reviewStatus: 'needs_review',
  },
  {
    name: 'a call dropped mid-script goes to the operator queue with what it collected',
    outcome: 'needs_review',
    confidence: 'low',
    items: MENU_ITEMS.slice(0, 1),
    status: 'needs_review',
    records: 1,
    reviewStatus: 'needs_review',
  },
  {
    name: 'an unanswered call with an attempt left is requeued for the next day',
    outcome: 'no_answer',
    status: 'queued',
    records: 0,
  },
  {
    name: 'an unanswered call whose attempts are spent becomes unreachable',
    outcome: 'no_answer',
    attempts: CALL_MAX_ATTEMPTS,
    status: 'unreachable',
    records: 0,
  },
  {
    name: 'a number the provider cannot reach becomes unreachable',
    outcome: 'unreachable',
    status: 'unreachable',
    blockedReason: 'invalid_number',
    records: 0,
  },
  {
    name: 'a refusal closes the task and blocks no target',
    outcome: 'refused',
    status: 'refused',
    records: 0,
  },
];

describe('a menu call record applied to its task', () => {
  it.each(MENU_MAPPINGS)('$name', async (row) => {
    const call = await seedMenuCall({
      outcome: row.outcome,
      ...(row.confidence === undefined ? {} : { confidence: row.confidence }),
      ...(row.items === undefined ? {} : { items: row.items }),
      ...(row.attempts === undefined ? {} : { attempts: row.attempts }),
    });
    const endedAt = now();
    const { result } = await applyResult(call.attempt.id);
    expect(result).toEqual({ applied: true, taskStatus: row.status });
    const task = await taskRow(call.task.id);
    expect(task.status).toBe(row.status);
    expect(task.outcomeAt?.toISOString()).toBe(endedAt.toISOString());
    expect(task.blockedReason).toBe(row.blockedReason ?? null);
    expect(task.resolvedBy).toBe(row.status === 'completed' ? 'agent' : null);
    if (row.status === 'queued') {
      expect(task.nextAttemptAt.getTime()).toBe(
        endedAt.getTime() + CALL_RETRY_SPACING_HOURS * HOUR_MS,
      );
    }
    const records = await store.priceRecord.findMany({ where: { placeId: call.place.id } });
    expect(records).toHaveLength(row.records);
    if (row.reviewStatus !== undefined) {
      expect(new Set(records.map((record) => record.reviewStatus))).toEqual(
        new Set([row.reviewStatus]),
      );
    }
  });

  it('stores the collected prices as one approved phone_quote batch', async () => {
    const call = await seedMenuCall({ outcome: 'completed', confidence: 'high' });
    const endedAt = now();
    const { result } = await applyResult(call.attempt.id);
    expect(result).toEqual({ applied: true, taskStatus: 'completed' });
    const records = await store.priceRecord.findMany({ where: { placeId: call.place.id } });
    expect(records).toHaveLength(MENU_ITEMS.length);
    expect(new Set(records.map((record) => record.captureBatchId)).size).toBe(1);
    const byName = new Map(records.map((record) => [record.itemName, record]));
    for (const item of MENU_ITEMS) {
      const record = byName.get(item.dish);
      if (record === undefined) {
        throw new Error(`no price record was stored for ${item.dish}`);
      }
      expect(record.source).toBe('phone_quote');
      expect(record.sourceUrl).toBe(`tel:${call.place.phone}`);
      expect(record.currency).toBe('EUR');
      expect(record.priceText).toBe(item.priceText);
      expect(record.localAmountMinor).toBe(item.amountMinor);
      expect(record.priceUsdCents).toBe(USD_CENTS[item.dish]);
      expect(record.itemCategory).toBe(
        item.slot === 'coffee' || item.slot === 'beer' ? 'drink' : 'main',
      );
      expect(record.alcoholic).toBe(
        item.slot === 'coffee' ? false : item.slot === 'beer' ? true : null,
      );
      expect(record.normalizedName).toBe(normalizeItemName(item.dish));
      expect(record.perPerson).toBeNull();
      expect(record.ticketType).toBeNull();
      expect(record.reviewStatus).toBe('approved');
      expect(record.confidence).toBe('high');
      expect(record.capturedAt.toISOString()).toBe(endedAt.toISOString());
      expect(record.fxDate.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    }
  });

  it('blocks the number and cancels every other task for it', async () => {
    const shared = await makePlace(app, {
      cityId: CITY,
      category: 'cafe',
      phone: SHARED_PHONE,
    });
    const call = await seedMenuCall({ outcome: 'do_not_call', phone: SHARED_PHONE });
    const other = await makePlace(app, { cityId: CITY, category: 'bar', phone: OTHER_PHONE });
    const sameTarget = await makeCallTask(app, {
      kind: 'menu_prices',
      placeId: call.place.id,
      status: 'queued',
    });
    const samePhone = await makeCallTask(app, {
      kind: 'menu_prices',
      placeId: shared.id,
      status: 'queued',
    });
    const untouched = await makeCallTask(app, {
      kind: 'menu_prices',
      placeId: other.id,
      status: 'queued',
    });
    const { result } = await applyResult(call.attempt.id);
    expect(result).toEqual({ applied: true, taskStatus: 'do_not_call' });
    const applied = await taskRow(call.task.id);
    expect(applied.status).toBe('do_not_call');
    expect(applied.blockedReason).toBe('do_not_call');
    expect((await taskRow(sameTarget.id)).status).toBe('cancelled');
    expect((await taskRow(samePhone.id)).status).toBe('cancelled');
    expect((await taskRow(untouched.id)).status).toBe('queued');
    const places = await store.place.findMany({
      where: { id: { in: [call.place.id, shared.id, other.id] } },
      select: { id: true, doNotCall: true },
    });
    const flagged = new Map(places.map((place) => [place.id, place.doNotCall]));
    expect(flagged.get(call.place.id)).toBe(true);
    expect(flagged.get(shared.id)).toBe(true);
    expect(flagged.get(other.id)).toBe(false);
    expect(await store.priceRecord.count({ where: { placeId: call.place.id } })).toBe(0);
  });

  it('stores nothing when the payload is not a readable extraction', async () => {
    const call = await seedMenuCall({ outcome: 'needs_review' });
    await store.callAttempt.update({
      where: { id: call.attempt.id },
      data: { extractedFields: asJson({ kind: 'menu_prices' }) },
    });
    const { result } = await applyResult(call.attempt.id);
    expect(result).toEqual({ applied: true, taskStatus: 'needs_review' });
    expect(await store.priceRecord.count({ where: { placeId: call.place.id } })).toBe(0);
  });

  it('leaves a price it cannot convert for the queue to retry', async () => {
    await store.fxRate.deleteMany({ where: { currency: 'MXN' } });
    const call = await seedMenuCall({
      outcome: 'completed',
      confidence: 'high',
      items: [
        {
          slot: 'cheapest_main',
          dish: 'Tacos',
          priceText: '180 MXN',
          amountMinor: 18_000,
          currency: 'MXN',
          confirmed: true,
        },
      ],
    });
    const endedAt = now();
    const job = await callResultJob(call.attempt.id);
    await expect(runJob(job)).rejects.toThrow(FxRateUnavailableError);
    expect((await taskRow(call.task.id)).status).toBe('in_progress');
    expect(await store.priceRecord.count({ where: { placeId: call.place.id } })).toBe(0);
    expect(await runJob(job, 'last')).toEqual({ applied: true, taskStatus: 'needs_review' });
    const task = await taskRow(call.task.id);
    expect(task.status).toBe('needs_review');
    expect(task.blockedReason).toBeNull();
    expect(task.outcomeAt?.toISOString()).toBe(endedAt.toISOString());
    expect(await store.priceRecord.count({ where: { placeId: call.place.id } })).toBe(0);
  });
});

/* Results that must not be applied (AAP 0.3.2, 0.5.3) */

describe('a result that must not be applied', () => {
  it('changes nothing for a task that is already decided', async () => {
    const call = await seedMenuCall({ outcome: 'completed', confidence: 'high' });
    expect((await applyResult(call.attempt.id)).result).toEqual({
      applied: true,
      taskStatus: 'completed',
    });
    await store.callTask.update({ where: { id: call.task.id }, data: { status: 'cancelled' } });
    const later = await makeCallAttempt(app, call.task, {
      state: 'ended',
      outcome: 'completed',
      confidence: 'high',
    });
    await setExtraction(later.id, { kind: 'menu_prices', items: MENU_ITEMS });
    const job = await callResultJob(later.id);
    const before = await callRows(call);
    expect(await runJob(job)).toEqual({ applied: false, reason: 'task_not_in_progress' });
    expect(await callRows(call)).toEqual(before);
    expect(await store.priceRecord.count({ where: { placeId: call.place.id } })).toBe(
      MENU_ITEMS.length,
    );
  });

  it('changes nothing for an attempt a resolution superseded', async () => {
    const call = await seedMenuCall({ outcome: 'completed', confidence: 'high' });
    await store.callAttempt.update({
      where: { id: call.attempt.id },
      data: { superseded: true },
    });
    const job = await callResultJob(call.attempt.id);
    const before = await callRows(call);
    expect(await runJob(job)).toEqual({ applied: false, reason: 'attempt_superseded' });
    expect(await callRows(call)).toEqual(before);
    expect(await store.priceRecord.count({ where: { placeId: call.place.id } })).toBe(0);
  });

  it('changes nothing when the same job is delivered again', async () => {
    const call = await seedMenuCall({ outcome: 'completed', confidence: 'high' });
    const applied = await applyResult(call.attempt.id);
    expect(applied.result).toEqual({ applied: true, taskStatus: 'completed' });
    const before = await callRows(call);
    expect(await runJob(applied.job)).toEqual({
      applied: false,
      reason: 'task_not_in_progress',
    });
    expect(await callRows(call)).toEqual(before);
    const records = await store.priceRecord.findMany({ where: { placeId: call.place.id } });
    expect(records).toHaveLength(MENU_ITEMS.length);
    expect(new Set(records.map((record) => record.captureBatchId)).size).toBe(1);
  });
});

/** One case of a recorded stay result: the answer and what the claim and task must read after it. */
interface StayMapping {
  readonly name: string;
  readonly outcome: CallAttemptOutcome;
  readonly answer: 'yes' | 'no' | null;
  readonly confidence?: 'high' | 'low';
  readonly attempts?: number;
  readonly taskStatus: CallTaskStatus;
  readonly claimStatus: LodgingClaimStatus;
}

/**
 * Every result a stay call can record, and what it leaves behind (AAP 0.5.3): only an explicit,
 * confirmed answer decides the claim, and every other result returns it to the operator queue while
 * the claimant still reads it as pending.
 */
const STAY_MAPPINGS: readonly StayMapping[] = [
  {
    name: 'a confirmed yes verifies the claim and completes the task',
    outcome: 'completed',
    answer: 'yes',
    confidence: 'high',
    taskStatus: 'completed',
    claimStatus: 'verified',
  },
  {
    name: 'a confirmed no rejects the claim',
    outcome: 'completed',
    answer: 'no',
    confidence: 'high',
    taskStatus: 'completed',
    claimStatus: 'rejected',
  },
  {
    name: 'an unconfirmed answer returns the claim to the operator queue',
    outcome: 'needs_review',
    answer: null,
    confidence: 'low',
    taskStatus: 'needs_review',
    claimStatus: 'pending_call',
  },
  {
    name: 'an unanswered call leaves the claim waiting for a retry',
    outcome: 'no_answer',
    answer: null,
    attempts: 1,
    taskStatus: 'queued',
    claimStatus: 'pending_call',
  },
];

describe('a lodging call record applied to its claim', () => {
  it.each(STAY_MAPPINGS)('$name', async (row) => {
    const stay = await seedStayCall({
      outcome: row.outcome,
      answer: row.answer,
      ...(row.confidence === undefined ? {} : { confidence: row.confidence }),
      ...(row.attempts === undefined ? {} : { attempts: row.attempts }),
    });
    const endedAt = now();
    const { result } = await applyResult(stay.attempt.id);
    expect(result).toEqual({ applied: true, taskStatus: row.taskStatus });
    const task = await taskRow(stay.task.id);
    expect(task.status).toBe(row.taskStatus);
    expect(task.outcomeAt?.toISOString()).toBe(endedAt.toISOString());
    expect(task.status).not.toBe('cancelled');
    if (row.taskStatus === 'queued') {
      expect(task.nextAttemptAt.getTime()).toBe(
        endedAt.getTime() + CALL_RETRY_SPACING_HOURS * HOUR_MS,
      );
    }
    const resolved = row.claimStatus === 'verified' || row.claimStatus === 'rejected';
    const claim = await store.lodgingClaim.findUniqueOrThrow({ where: { id: stay.claim.id } });
    expect(claim.status).toBe(row.claimStatus);
    expect(claim.resolvedAt?.toISOString() ?? null).toBe(resolved ? endedAt.toISOString() : null);
    expect(await store.lodgingActivityFact.count({ where: { lodgingId: stay.lodging.id } })).toBe(
      row.claimStatus === 'verified' ? 1 : 0,
    );
    const events = await store.analyticsEvent.findMany({
      where: { name: 'lodging_claim_resolved' },
    });
    expect(events).toHaveLength(resolved ? 1 : 0);
    if (resolved) {
      expect(events[0]?.props).toEqual({
        outcome: row.claimStatus,
        resolveSeconds: (2 * HOUR_MS) / 1000,
      });
    }
    expect(await store.outboxMessage.count({ where: { kind: 'notification' } })).toBe(
      resolved ? 1 : 0,
    );
  });

  it('credits the stay to the lodging and notifies the claimant', async () => {
    const stay = await seedStayCall({ outcome: 'completed', answer: 'yes', confidence: 'high' });
    const retry = await makeCallTask(app, {
      kind: 'lodging_stay_verification',
      lodgingId: stay.lodging.id,
      lodgingClaimId: stay.claim.id,
      status: 'queued',
    });
    const live = await makeCallAttempt(app, retry, { state: 'dispatching' });
    const endedAt = now();
    const { job, result } = await applyResult(stay.attempt.id);
    expect(result).toEqual({ applied: true, taskStatus: 'completed' });
    const task = await taskRow(stay.task.id);
    expect(task.resolvedBy).toBe('agent');
    expect((await taskRow(retry.id)).status).toBe('cancelled');
    expect((await store.callAttempt.findUniqueOrThrow({ where: { id: live.id } })).superseded).toBe(
      true,
    );
    const claim = await store.lodgingClaim.findUniqueOrThrow({ where: { id: stay.claim.id } });
    expect(claim.status).toBe('verified');
    expect(claim.resolvedAt?.toISOString()).toBe(endedAt.toISOString());
    expect(claim.detailsErasedAt).toBeNull();
    const facts = await store.lodgingActivityFact.findMany({
      where: { lodgingId: stay.lodging.id },
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.meetupId).toBe(stay.inStay.id);
    expect(facts[0]?.pairKey).toBe(
      pairKey(ctx.env.ANALYTICS_SALT, stay.claimant.id, stay.counterpart.id),
    );
    expect(facts[0]?.completedAt.getTime()).toBe(
      stay.inStay.startsAt.getTime() + CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS,
    );
    const events = await store.analyticsEvent.findMany({
      where: { name: 'lodging_claim_resolved' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorHash).toBe(actorHash(ctx.env.ANALYTICS_SALT, stay.claimant.id));
    expect(events[0]?.cityId).toBe(CITY);
    expect(events[0]?.props).toEqual({ outcome: 'verified', resolveSeconds: (2 * HOUR_MS) / 1000 });
    const notifications = await store.outboxMessage.findMany({ where: { kind: 'notification' } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toEqual({
      kind: 'lodging_claim_resolved',
      userId: stay.claimant.id,
      lodgingClaimId: stay.claim.id,
    });
    expect(await runJob(job)).toEqual({ applied: false, reason: 'task_not_in_progress' });
    expect(
      (await store.lodgingClaim.findUniqueOrThrow({ where: { id: stay.claim.id } })).status,
    ).toBe('verified');
    expect(await store.lodgingActivityFact.count({ where: { lodgingId: stay.lodging.id } })).toBe(
      1,
    );
    expect(await store.analyticsEvent.count({ where: { name: 'lodging_claim_resolved' } })).toBe(1);
    expect(await store.outboxMessage.count({ where: { kind: 'notification' } })).toBe(1);
  });
});
