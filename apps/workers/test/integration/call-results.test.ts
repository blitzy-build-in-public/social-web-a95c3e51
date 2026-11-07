/**
 * Integration tests for `apps/workers/src/jobs/call-results.ts` (AAP 0.3.2, 0.5.3, 0.5.6, 0.5.7).
 *
 * The API's relay records what a finished call produced on its `CallAttempt` in the same transaction
 * that writes the `apply_call_result` outbox row; this job consumes that row and applies the result to
 * the task and, for a lodging call, to the claim (AAP 0.3.2). The suite drives it exactly as the
 * dispatcher would: one `OutboxMessage` row per case, its payload parsed with `parseOutboxPayload`,
 * dispatched under the row's own `outbox-<id>` job id, and run against the real PostgreSQL 16 with
 * PostGIS 3.4 and Redis the harness starts (AAP 0.11.2). What it proves is therefore the effect of the
 * job's own statements on the schema the run delivers.
 *
 * Three groups of cases:
 *
 *   - A menu call's result (AAP 0.5.3, 0.5.6): every price confirmed stores one `phone_quote` capture
 *     batch and completes the task; anything less stores what was collected as `needs_review` and hands
 *     the task to the operator queue; each outcome that collected nothing moves the task on without
 *     storing a price, and `do_not_call` blocks the number everywhere.
 *   - A result that must not be applied changes nothing at all (AAP 0.5.3, "Terminal tasks stay
 *     terminal"): a task already decided, an attempt a resolution superseded, a redelivered job.
 *   - A lodging call's result (AAP 0.5.3, 0.5.7): a confirmed answer decides the task and the claim in
 *     one run, and `verified` backfills the lodging's leaderboard fact, the dashboard's claim measure
 *     and the claimant's notification.
 *
 * Time comes from the harness's injected clock, so `outcomeAt`, the 24-hour retry and a claim's
 * `resolveSeconds` are exact. The FX table is the recorded provider response of
 * `apps/workers/test/fixtures/fx/usd-latest.json`, served over a local HTTP server and stored by the
 * real `fx-refresh` job, which is what makes a phone quote's USD cents assertable (EUR 0.8, so 1.25 USD
 * per EUR).
 *
 * @see AAP 0.5.3 for both lifecycles and their timers, 0.5.6 for the pipeline and the per-task-kind
 *   rules, 0.5.7 for `outcomeAt` and the leaderboard fact, 0.3.2 for the outbox and the idempotence it
 *   needs, 0.11.2 for the integration topology, 0.8.1 for this file's inventory row.
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

/* The fixture set (AAP 0.5.2) */

/** The one city every case works in: a launch city whose call language is published. */
const CITY = 'lisbon';

/**
 * The instant every case starts at: Lisbon midday on the harness's own default day. `resetState`
 * returns the clock here, and each case states it so the reason the dates below line up is visible.
 */
const NOW = new Date('2026-11-16T12:00:00.000Z');

/** The provider response `fx-refresh` stores the day's rates from (AAP 0.3.3, 0.5.6). */
const FX_FIXTURE = new URL('../fixtures/fx/usd-latest.json', import.meta.url);

/** The number a menu call is dialed from, from the reserved fictional range (AAP 0.5.2). */
const MENU_PHONE = '+14155550150';
/** One number two places share, for the do-not-call cascade, and one nothing else uses. */
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

/** `CallAttempt.extractedFields`, mirrored from `ExtractedFields` in the API's `dialogue.ts`. */
type ExtractedFields =
  | { readonly kind: 'menu_prices'; readonly items: readonly MenuPriceItem[] }
  | {
      readonly kind: 'lodging_stay_verification';
      readonly answer: 'yes' | 'no' | null;
      readonly confirmed: boolean;
    };

/** The four prices a complete Lisbon menu call collects, at the FX fixture's EUR rate of 1.25. */
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

/* The stay a lodging call asks about (AAP 0.5.2, 0.5.7) */

/** The week the claimed stay covers, `YYYY-MM-DD`, ending the day before the cases run. */
const STAY_FROM = '2026-11-09';
const STAY_TO = '2026-11-15';

/** A completed meetup inside the stay, one outside its dates, and one past the 90-day window. */
const IN_STAY = new Date('2026-11-12T12:00:00.000Z');
const OUTSIDE_STAY = new Date('2026-10-20T12:00:00.000Z');
const BEFORE_WINDOW = new Date('2026-07-01T12:00:00.000Z');

/* The harness (AAP 0.11.2) */

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
 *
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

/* Running the job as the outbox dispatcher does (AAP 0.3.2) */

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
 *
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
 *
 * The queue's retry allowance is read from the queue's own options rather than written here, so the
 * case that spends the last delivery cannot drift from the policy it is about (AAP 0.5.6).
 *
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
 *
 * The builders write an attempt's columns, but the menu form carries a list of items, which their
 * `extractedFields` option does not admit, so the payload is written here in the shape the relay
 * records it (AAP 0.5.2).
 *
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

/* Seeding one menu call (AAP 0.5.2, 0.5.6) */

/** What one seeded menu call is: its place, its task and the attempt whose result is applied. */
interface MenuCall {
  readonly place: PlaceFixture;
  readonly task: CallTaskFixture;
  readonly attempt: CallAttemptFixture;
}

/** What {@link seedMenuCall} may replace, with a complete confirmed call as its default. */
interface MenuCallInput {
  readonly outcome: CallAttemptOutcome;
  readonly confidence?: 'high' | 'low';
  readonly items?: readonly MenuPriceItem[];
  readonly attempts?: number;
  readonly phone?: string;
}

/**
 * Seed one `menu_prices` task in `in_progress` with one ended attempt, as the dispatcher leaves them.
 *
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

/* Seeding one lodging call (AAP 0.5.2, 0.5.3, 0.5.7) */

/** What one seeded stay call is: the claim, its lodging, the pair and the three completed meetups. */
interface StayCall {
  readonly claimant: UserFixture;
  readonly counterpart: UserFixture;
  readonly lodging: LodgingFixture;
  readonly claim: ClaimFixture;
  readonly task: CallTaskFixture;
  readonly attempt: CallAttemptFixture;
  readonly inStay: MeetupFixture;
}

/** What {@link seedStayCall} may replace; the confirmed answer a case names is otherwise unconfirmed. */
interface StayCallInput {
  readonly outcome: CallAttemptOutcome;
  readonly answer: 'yes' | 'no' | null;
  readonly confidence?: 'high' | 'low';
  readonly attempts?: number;
}

/**
 * Seed one `lodging_stay_verification` task in `in_progress`, the `calling` claim it verifies, and the
 * completed meetups a verified stay is credited with.
 *
 * The claim was created two hours ago, which is what makes its `resolveSeconds` exact; the claimant met
 * the counterpart once inside the stay, once outside its dates and once past the 90-day window, so a
 * backfill that ignored either bound would be visible (AAP 0.5.7).
 *
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

/* The rows one case can change (AAP 0.5.3) */

/** Every row a result may move, for the deep equality of the cases that must change nothing. */
interface Rows {
  readonly task: readonly unknown[];
  readonly attempts: readonly unknown[];
  readonly records: readonly unknown[];
  readonly outbox: readonly unknown[];
}

/**
 * Read the rows of one menu call, so a case can assert that a refused result changed none of them.
 *
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

/* Applying one recorded result (AAP 0.3.2) */

/** The job one recorded result becomes, and what the processor reported for it. */
interface AppliedResult {
  readonly job: CallResultsJob;
  readonly result: CallResultsResult;
}

/**
 * Apply one seeded result as the dispatcher would: the outbox row the API's relay writes, then the job
 * that row becomes.
 *
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

/* A menu call's recorded result (AAP 0.5.3, 0.5.6) */

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
    // Every status a call result reaches is dated by the attempt's own end (AAP 0.5.7).
    expect(task.outcomeAt?.toISOString()).toBe(endedAt.toISOString());
    expect(task.blockedReason).toBe(row.blockedReason ?? null);
    // Only a call that collected every price counts as the task's own result, so only it is resolved
    // by the agent (AAP 0.5.2, 0.5.3).
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
    // One call is one capture batch, as one fetch is on the online path, so the estimate reads the
    // call's prices as one capture (AAP 0.5.6, 0.5.7).
    expect(new Set(records.map((record) => record.captureBatchId)).size).toBe(1);

    const byName = new Map(records.map((record) => [record.itemName, record]));

    for (const item of MENU_ITEMS) {
      const record = byName.get(item.dish);

      if (record === undefined) {
        throw new Error(`no price record was stored for ${item.dish}`);
      }

      expect(record.source).toBe('phone_quote');
      // The number called is the price's source, and the only attribution a quote has (AAP 0.5.6).
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
      // A phone quote is a dish or a drink, so the two ticket columns stay empty (AAP 0.5.6).
      expect(record.perPerson).toBeNull();
      expect(record.ticketType).toBeNull();
      expect(record.reviewStatus).toBe('approved');
      expect(record.confidence).toBe('high');
      expect(record.capturedAt.toISOString()).toBe(endedAt.toISOString());
      // The rate's own day, which the provider published and `fx-refresh` stored under.
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

    // A second task for the place that was called, one for a place reachable on the same number, and
    // one that must not be touched: the answer is about the number, not about one row (AAP 0.5.3).
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

    // The menu form without its list of items: a payload the contract does not define, which must not
    // become a price nobody can trace to what was said (AAP 0.5.6).
    await store.callAttempt.update({
      where: { id: call.attempt.id },
      data: { extractedFields: asJson({ kind: 'menu_prices' }) },
    });

    const { result } = await applyResult(call.attempt.id);

    expect(result).toEqual({ applied: true, taskStatus: 'needs_review' });
    expect(await store.priceRecord.count({ where: { placeId: call.place.id } })).toBe(0);
  });

  it('leaves a price it cannot convert for the queue to retry', async () => {
    // The table covers MXN, so the item is not dropped as an unsupported currency is; no rate reaches
    // back to the capture day, so it cannot be converted yet (AAP 0.5.6).
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

    // A delivery the queue will retry fails, and the next one tries the same application again: the
    // whole application is one transaction, so nothing it wrote survives the throw (AAP 0.3.2).
    await expect(runJob(job)).rejects.toThrow(FxRateUnavailableError);
    expect((await taskRow(call.task.id)).status).toBe('in_progress');
    expect(await store.priceRecord.count({ where: { placeId: call.place.id } })).toBe(0);

    // The last delivery has no retry behind it, so it hands the task to the operator queue rather than
    // leaving it `in_progress` with nothing that could ever move it (AAP 0.5.3).
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

    // An operator or a claim's resolution moved the task on after the call ended: the terminal task
    // stays terminal, whatever a later attempt reports (AAP 0.5.3).
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

    // The signal the API's relay reads when a call is ended: a superseded attempt's result is never
    // applied, even while its task is still open (AAP 0.5.3).
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

/* A lodging call's recorded result (AAP 0.5.3, 0.5.7) */

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
    // The task that produced the answer is never cancelled and never superseded by the resolution it
    // caused, whichever way the answer went (AAP 0.5.3).
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

    // A resolution writes the leaderboard fact only for a verified stay, and the claim measure and the
    // claimant's notification for any resolution (AAP 0.5.7).
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

    // A retry the dispatcher left open for the same claim, with its attempt still in a state a call
    // could genuinely be live in: resolving the claim cancels the work that produced no result and
    // ends the call it was holding, while the task that did produce it is left alone (AAP 0.5.3).
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
    // The verification work the claim still had outstanding is cancelled, not the task that answered:
    // a terminal task stays terminal (AAP 0.5.3).
    expect((await taskRow(retry.id)).status).toBe('cancelled');
    expect((await store.callAttempt.findUniqueOrThrow({ where: { id: live.id } })).superseded).toBe(
      true,
    );

    const claim = await store.lodgingClaim.findUniqueOrThrow({ where: { id: stay.claim.id } });
    expect(claim.status).toBe('verified');
    expect(claim.resolvedAt?.toISOString()).toBe(endedAt.toISOString());
    // The booking details are the `data-expiry` run's to erase, not this job's (AAP 0.5.2).
    expect(claim.detailsErasedAt).toBeNull();

    // Exactly the one completed meetup the stay covers is credited: not the meetup outside the stay's
    // dates, and not the one past the 90-day window (AAP 0.5.7).
    const facts = await store.lodgingActivityFact.findMany({
      where: { lodgingId: stay.lodging.id },
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.meetupId).toBe(stay.inStay.id);
    expect(facts[0]?.pairKey).toBe(
      pairKey(ctx.env.ANALYTICS_SALT, stay.claimant.id, stay.counterpart.id),
    );
    // A fact carries the meetup's own settlement, so a backfill never moves a historical score.
    expect(facts[0]?.completedAt.getTime()).toBe(
      stay.inStay.startsAt.getTime() + CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS,
    );

    // The claim measure the dashboard counts, keyed by the claimant's hash and dated by the run.
    const events = await store.analyticsEvent.findMany({
      where: { name: 'lodging_claim_resolved' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorHash).toBe(actorHash(ctx.env.ANALYTICS_SALT, stay.claimant.id));
    expect(events[0]?.cityId).toBe(CITY);
    expect(events[0]?.props).toEqual({ outcome: 'verified', resolveSeconds: (2 * HOUR_MS) / 1000 });

    // The claimant's message, written in the transaction that resolved the claim (AAP 0.3.2).
    const notifications = await store.outboxMessage.findMany({ where: { kind: 'notification' } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toEqual({
      kind: 'lodging_claim_resolved',
      userId: stay.claimant.id,
      lodgingClaimId: stay.claim.id,
    });

    // The row is delivered a second time, and the claim is terminal: nothing is written again.
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
