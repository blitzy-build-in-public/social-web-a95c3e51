/**
 * Integration tests for `apps/workers/src/jobs/call-results.ts` (AAP 0.5.3, 0.5.6, 0.8.1).
 *
 * The suite runs against a real PostgreSQL 16 with PostGIS 3.4, started from the shipped image and
 * migrated with `packages/db/prisma/migrations/20261104000000_init/migration.sql`, so what it proves
 * is the effect of the job's own statements on the schema the run delivers. Time comes from
 * `createTestClock`, so one frozen instant fixes `outcomeAt` and the 24-hour retry.
 *
 * The cases, in order:
 *
 *   1. A `menu_prices` call whose prices were all confirmed stores one `phone_quote` batch and
 *      completes the task (AAP 0.5.6).
 *   2. A partial call stores what it collected as `needs_review`, and a payload that is not a
 *      readable extraction stores nothing and sends the task to the operator queue.
 *   3. A price in a currency the FX table does not cover is dropped; a covered currency with no rate
 *      raises `FxRateUnavailableError` and leaves the task untouched for the queue to retry, and the
 *      last delivery of the same failure hands the task to the operator queue as `needs_review`
 *      instead of leaving it `in_progress` (AAP 0.5.3).
 *   4. The four outcomes that collect nothing: the retry after 24 hours, the second `no_answer`, the
 *      invalid number and the refusal (AAP 0.5.3).
 *   5. `do_not_call` blocks the number everywhere, cancels the other tasks of those targets and
 *      supersedes their live attempts, while the task that produced the outcome is left alone.
 *   6. A stay call's confirmed yes and no decide the claim and its task together, and a confirmed yes
 *      backfills the lodging's leaderboard fact; anything less returns the claim to `pending_call`.
 *   7. The guards: a missing attempt, a terminal or superseded task or attempt, an attempt with no
 *      outcome, a result a later attempt has replaced, and a stripped lodging attempt.
 *   8. The job's own boundary: an unknown name and malformed data are refused, and a second run of
 *      the same job changes nothing.
 *
 * @see AAP 0.5.3 for every mapping, 0.5.6 for the price and do-not-call rules, 0.5.7 for `outcomeAt`
 *   and the leaderboard fact, 0.11.2 for the integration layer.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma, createPrismaClient, type DbClient } from '@tablemate/db';
import {
  JOB,
  QUEUE,
  QUEUE_JOB_OPTIONS,
  QueuePayloadError,
  createLogger,
  createTestClock,
  loadWorkersEnv,
} from '@tablemate/server-core';
import { DAY_MS, HOUR_MS } from '@tablemate/shared';
import type {
  BlockedReason,
  CallAttemptOutcome,
  CallTaskStatus,
  LodgingClaimStatus,
} from '@tablemate/shared';

import {
  FxRateUnavailableError,
  process,
  type CallResultsResult,
} from '../../src/jobs/call-results.ts';
// Type-only, and narrowed below: this job reads the clock, the logger and the database client, and
// no other collaborator of a worker context, so the suite builds those four fields and nothing else.
import type { WorkerContext } from '../../src/queues.ts';

/** The part of a worker context this job touches. */
type CallResultsContext = Pick<WorkerContext, 'env' | 'clock' | 'logger' | 'db'>;

/** The instant every relative date below is measured from, and the clock's starting point. */
const START = new Date('2026-11-04T12:00:00.000Z');

/** The UTC day every FX rate and price below belongs to. */
const CAPTURE_DAY = '2026-11-04';

/** The number a menu call is dialed from, and the EUR/USD rate the expected cents are built on. */
const MENU_PHONE = '+12025550100';
const EUR_USD = '1.1';

/**
 * How many deliveries BullMQ gives one `call-results` job: the queue's own policy (AAP 0.5.6), read
 * rather than hard-coded, so the case that runs the last delivery cannot drift from it.
 */
const CALL_RESULTS_ATTEMPTS = QUEUE_JOB_OPTIONS[QUEUE.callResults].attempts ?? 1;

// Every row this suite seeds is named, and the names are the assertions' vocabulary.
const CITY = 'lisbon';
const VENUE = 'aaaaaaaa-0000-4000-8000-000000000001';
const PLACE = 'aaaaaaaa-0000-4000-8000-000000000002';
const PLACE_SHARED = 'aaaaaaaa-0000-4000-8000-000000000003';
const PLACE_OTHER = 'aaaaaaaa-0000-4000-8000-000000000004';
const LODGING = 'aaaaaaaa-0000-4000-8000-000000000005';
const LODGING_PHONE = '+12025550101';
const OTHER_PHONE = '+12025550102';
const CLAIMANT = 'bbbbbbbb-0000-4000-8000-000000000001';
const COUNTERPART = 'bbbbbbbb-0000-4000-8000-000000000002';
const MEETUP = 'cccccccc-0000-4000-8000-000000000001';

/** The four items a complete menu call collects, in the order the script asks them. */
const MENU_ITEMS = [
  {
    slot: 'cheapest_main',
    dish: 'Bacalhau',
    priceText: '12,50 €',
    amountMinor: 1250,
    currency: 'EUR',
    confirmed: true,
  },
  {
    slot: 'priciest_main',
    dish: 'Arroz de Marisco',
    priceText: '24,00 €',
    amountMinor: 2400,
    currency: 'EUR',
    confirmed: true,
  },
  {
    slot: 'coffee',
    dish: 'Espresso',
    priceText: '2,50 €',
    amountMinor: 250,
    currency: 'EUR',
    confirmed: true,
  },
  {
    slot: 'beer',
    dish: 'Imperial',
    priceText: '5,00 €',
    amountMinor: 500,
    currency: 'EUR',
    confirmed: true,
  },
];

/**
 * The migration the container is built with: the same file the compose stack applies. Found by
 * walking up from this module's own directory, because the repository carries no vitest
 * configuration and `vitest run` therefore collects a compiled copy of this file as well.
 */
const MIGRATION = findMigration();

/**
 * @returns The absolute path of the init migration.
 * @throws Error naming the directory the search started from when no ancestor holds it.
 */
function findMigration(): string {
  const from = dirname(fileURLToPath(import.meta.url));
  const migration = 'packages/db/prisma/migrations/20261104000000_init/migration.sql';
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, migration);
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dirname(dir) === dir) {
      throw new Error(`the init migration is missing: no ancestor of ${from} holds ${migration}`);
    }
  }
}

/**
 * The environment the `workers` process validates at start (AAP 0.6.2). Every value is a placeholder
 * that matches no credential shape, and the telephony and language-model modes reach no provider, so
 * the job under test needs no external service at all.
 */
function environment(databaseUrl: string): Record<string, string> {
  return {
    APP_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    FIELD_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    FIELD_ENCRYPTION_KEY_ID: 'k1',
    ANALYTICS_SALT: 'test-analytics-salt-0123456789abcdef',
    TELEPHONY_MODE: 'off',
    LLM_PROVIDER: 'fake',
    SMTP_URL: 'smtp://127.0.0.1:1025',
    EMAIL_FROM: 'Tablemate <no-reply@tablemate.test>',
    CRAWLER_CONTACT_URL: 'https://tablemate.test/crawler',
    API_PUBLIC_URL: 'http://127.0.0.1:21000',
    WEB_ORIGIN: 'http://127.0.0.1:21001',
  };
}

let db: DbClient;
let clock: ReturnType<typeof createTestClock>;
let ctx: CallResultsContext;
/** Assigned last in `beforeAll`, so a failure before that point leaves it undefined. */
let stop: (() => Promise<void>) | undefined;
const logs: Record<string, unknown>[] = [];

beforeAll(async () => {
  const container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
  const migration = await readFile(MIGRATION, 'utf8');
  const applied = await container.exec([
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'test',
    '-d',
    'test',
    '-c',
    migration,
  ]);

  if (applied.exitCode !== 0) {
    throw new Error(`the init migration failed: ${applied.stderr}`);
  }

  const databaseUrl = container.getConnectionUri();
  db = createPrismaClient({ databaseUrl, appEnv: 'test' });
  clock = createTestClock({ start: START });
  ctx = {
    env: loadWorkersEnv(environment(databaseUrl)),
    clock,
    logger: createLogger({
      name: 'call-results-test',
      level: 'info',
      appEnv: 'test',
      destination: {
        write: (line: string) => {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    }),
    db,
  };
  stop = async () => {
    await db.$disconnect();
    await container.stop();
  };

  await seed();
}, 300_000);

afterAll(async () => {
  // A `beforeAll` that failed before assigning `stop` must report its own error, not a second one.
  if (stop) {
    await stop();
  }
});

/**
 * The rows every case builds on: the city, the venue, the three places (two of them sharing a
 * number), the lodging, the two accounts and the completed meetup a verified stay credits.
 */
async function seed(): Promise<void> {
  await db.city.createMany({
    data: [
      {
        id: CITY,
        circuitCityId: 1,
        name: 'Lisbon',
        countryCode: 'PT',
        timezone: 'Europe/Lisbon',
        callLanguage: 'pt-PT',
        currency: 'EUR',
        bbox: { south: 38.6, west: -9.3, north: 38.8, east: -9.0 },
      },
    ],
  });

  await db.venue.createMany({
    data: [{ id: VENUE, cityId: CITY, name: 'Venue', address: 'Rua Teste 1' }],
  });

  await db.place.createMany({
    data: [
      { id: PLACE, cityId: CITY, name: 'Place', category: 'restaurant', phone: MENU_PHONE },
      {
        id: PLACE_SHARED,
        cityId: CITY,
        name: 'Place Shared Line',
        category: 'cafe',
        phone: MENU_PHONE,
      },
      {
        id: PLACE_OTHER,
        cityId: CITY,
        name: 'Place Other Line',
        category: 'bar',
        phone: OTHER_PHONE,
      },
    ],
  });

  await db.lodging.createMany({
    data: [{ id: LODGING, cityId: CITY, name: 'Lodging', kind: 'hostel', phone: LODGING_PHONE }],
  });

  await db.user.createMany({
    data: [
      { id: CLAIMANT, handle: 'claimant' },
      { id: COUNTERPART, handle: 'counterpart' },
    ],
  });

  // The meetup a verified stay of the claim below covers: completed yesterday, inside the 90-day
  // window, on the one local date the claim's stay spans (AAP 0.5.7).
  await db.meetup.createMany({
    data: [
      {
        id: MEETUP,
        initiatorId: CLAIMANT,
        recipientId: COUNTERPART,
        venueId: VENUE,
        startsAt: new Date(START.getTime() - DAY_MS),
        depositCents: 1000,
        status: 'completed',
        variantPairing: 'social',
        lockedAt: new Date(START.getTime() - 2 * DAY_MS),
        settledAt: new Date(START.getTime() - DAY_MS),
        finalAt: new Date(START.getTime() - DAY_MS),
      },
    ],
  });

  // EUR only: a menu price quoted in its own currency converts, MXN has no row (the retry case) and
  // GBP is not a currency the table covers at all (the drop case).
  await db.fxRate.createMany({
    data: [
      { date: new Date(`${CAPTURE_DAY}T00:00:00.000Z`), currency: 'EUR', usdPerUnit: EUR_USD },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Runs the job for one attempt, as the outbox dispatcher would: `apply` with `{ outboxId, … }`. */
async function runApply(attemptId: string): Promise<CallResultsResult> {
  return await process(
    {
      name: JOB[QUEUE.callResults].apply,
      data: { outboxId: randomUUID(), callAttemptId: attemptId },
    },
    ctx as WorkerContext,
  );
}

/**
 * Runs the same job as its last delivery: the one that spends the queue's final retry, so a failure
 * inside it has to leave the task's state decided rather than throwing it back to BullMQ.
 */
async function runFinalApply(attemptId: string): Promise<CallResultsResult> {
  return await process(
    {
      name: JOB[QUEUE.callResults].apply,
      data: { outboxId: randomUUID(), callAttemptId: attemptId },
      attemptsMade: CALL_RESULTS_ATTEMPTS - 1,
      opts: { attempts: CALL_RESULTS_ATTEMPTS },
    },
    ctx as WorkerContext,
  );
}

/** The task as it stands, so an assertion names the columns the job writes. */
async function taskRow(taskId: string) {
  return await db.callTask.findUniqueOrThrow({ where: { id: taskId } });
}

/** A call's extracted fields as the JSON column stores them. */
function extraction(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** What one seeded menu call is: its task, its attempt and the place it was dialed to. */
interface MenuCall {
  readonly taskId: string;
  readonly attemptId: string;
  readonly placeId: string;
  readonly endedAt: Date;
}

/** The shape {@link seedMenuCall} builds a menu call from, with the ordinary case as its default. */
interface MenuCallInput {
  readonly outcome: CallAttemptOutcome;
  readonly confidence?: 'high' | 'low' | null;
  readonly items?: readonly unknown[];
  readonly extracted?: boolean;
  readonly attempts?: number;
  readonly status?: CallTaskStatus;
  readonly superseded?: boolean;
  readonly placeId?: string;
  readonly startedAt?: Date;
  readonly endedAt?: Date | null;
  readonly twilioCallSid?: string | null;
}

/** How many case-owned places exist, so each one gets a number of its own. */
let casePlaces = 0;

/**
 * A place of its own for one case: a case's assertions read its place's price records alone, so a
 * batch another case stored can never be mistaken for this one's.
 */
async function seedPlace(): Promise<string> {
  const id = randomUUID();
  casePlaces += 1;

  await db.place.create({
    data: {
      id,
      cityId: CITY,
      name: `Case Place ${casePlaces}`,
      category: 'restaurant',
      phone: `+1202555${String(1000 + casePlaces)}`,
    },
  });

  return id;
}

/** Seeds one `menu_prices` task, with its own place unless one is given, and one ended attempt. */
async function seedMenuCall(input: MenuCallInput): Promise<MenuCall> {
  const taskId = randomUUID();
  const attemptId = randomUUID();
  const placeId = input.placeId ?? (await seedPlace());
  const startedAt = input.startedAt ?? new Date(START.getTime() - HOUR_MS);
  const endedAt = input.endedAt === undefined ? START : input.endedAt;

  await db.callTask.create({
    data: {
      id: taskId,
      kind: 'menu_prices',
      placeId,
      status: input.status ?? 'in_progress',
      attempts: input.attempts ?? 1,
      nextAttemptAt: startedAt,
    },
  });

  await db.callAttempt.create({
    data: {
      id: attemptId,
      callTaskId: taskId,
      twilioCallSid:
        input.twilioCallSid === undefined ? `CA-${attemptId.slice(0, 8)}` : input.twilioCallSid,
      state: 'ended',
      superseded: input.superseded ?? false,
      outcome: input.outcome,
      extractedFields:
        input.extracted === false
          ? Prisma.DbNull
          : extraction({ kind: 'menu_prices', items: input.items ?? MENU_ITEMS }),
      confidence: input.confidence ?? (input.outcome === 'completed' ? 'high' : null),
      startedAt,
      endedAt: endedAt === null ? null : endedAt,
    },
  });

  return { taskId, attemptId, placeId, endedAt: endedAt ?? START };
}

/** What one seeded stay call is: its task, its attempt and the claim it verifies. */
interface StayCall {
  readonly taskId: string;
  readonly attemptId: string;
  readonly claimId: string;
}

/** The shape {@link seedStayCall} builds a stay call from, with a `calling` claim as its default. */
interface StayCallInput {
  readonly outcome: CallAttemptOutcome;
  readonly confidence?: 'high' | 'low' | null;
  readonly answer?: 'yes' | 'no' | null;
  readonly confirmed?: boolean;
  readonly extracted?: boolean;
  readonly attempts?: number;
  readonly status?: CallTaskStatus;
  readonly claimStatus?: LodgingClaimStatus;
  readonly detachedClaim?: boolean;
  readonly startedAt?: Date;
  readonly endedAt?: Date | null;
  readonly twilioCallSid?: string | null;
}

/** Seeds one `lodging_stay_verification` task, its claim and one ended attempt (AAP 0.5.3). */
async function seedStayCall(input: StayCallInput): Promise<StayCall> {
  const taskId = randomUUID();
  const attemptId = randomUUID();
  const claimId = randomUUID();
  const startedAt = input.startedAt ?? new Date(START.getTime() - HOUR_MS);

  await db.lodgingClaim.create({
    data: {
      id: claimId,
      userId: CLAIMANT,
      lodgingId: LODGING,
      stayFrom: new Date('2026-10-30T00:00:00.000Z'),
      stayTo: new Date('2026-11-10T00:00:00.000Z'),
      callConsentAt: startedAt,
      status: input.claimStatus ?? 'calling',
    },
  });

  await db.callTask.create({
    data: {
      id: taskId,
      kind: 'lodging_stay_verification',
      lodgingId: LODGING,
      lodgingClaimId: input.detachedClaim === true ? null : claimId,
      status: input.status ?? 'in_progress',
      attempts: input.attempts ?? 1,
      nextAttemptAt: startedAt,
    },
  });

  await db.callAttempt.create({
    data: {
      id: attemptId,
      callTaskId: taskId,
      twilioCallSid:
        input.twilioCallSid === undefined ? `CA-${attemptId.slice(0, 8)}` : input.twilioCallSid,
      state: 'ended',
      outcome: input.outcome,
      extractedFields:
        input.extracted === false
          ? Prisma.DbNull
          : extraction({
              kind: 'lodging_stay_verification',
              answer: input.answer ?? null,
              confirmed: input.confirmed ?? false,
            }),
      confidence: input.confidence ?? (input.outcome === 'completed' ? 'high' : null),
      startedAt,
      endedAt: input.endedAt === undefined ? START : input.endedAt,
    },
  });

  return { taskId, attemptId, claimId };
}

/** The price records of one place, oldest id first, so an assertion reads a whole batch. */
async function priceRows(placeId: string) {
  return await db.priceRecord.findMany({ where: { placeId } });
}

// ---------------------------------------------------------------------------------------------
// A menu call's result (AAP 0.5.3, 0.5.6)
// ---------------------------------------------------------------------------------------------

describe('a menu call that collected every price', () => {
  it('stores one phone_quote batch and completes the task', async () => {
    const call = await seedMenuCall({ outcome: 'completed' });

    const result = await runApply(call.attemptId);

    expect(result).toEqual({ applied: true, taskStatus: 'completed' });

    const task = await taskRow(call.taskId);
    expect(task.status).toBe('completed');
    expect(task.resolvedBy).toBe('agent');
    expect(task.blockedReason).toBeNull();
    expect(task.outcomeAt?.toISOString()).toBe(call.endedAt.toISOString());

    const rows = await priceRows(call.placeId);
    expect(rows).toHaveLength(4);

    // One batch, one source, one URL: the prices were heard on the place's own number (AAP 0.5.6).
    const batchIds = new Set(rows.map((row) => row.captureBatchId));
    expect(batchIds.size).toBe(1);

    const place = await db.place.findUniqueOrThrow({ where: { id: call.placeId } });

    for (const row of rows) {
      expect(row.source).toBe('phone_quote');
      expect(row.sourceUrl).toBe(`tel:${place.phone}`);
      expect(row.currency).toBe('EUR');
      expect(row.reviewStatus).toBe('approved');
      expect(row.confidence).toBe('high');
      expect(row.isFixture).toBe(false);
      expect(row.perPerson).toBeNull();
      expect(row.ticketType).toBeNull();
      expect(row.capturedAt.toISOString()).toBe(call.endedAt.toISOString());
      expect(row.fxDate.toISOString()).toBe(`${CAPTURE_DAY}T00:00:00.000Z`);
    }

    const byName = new Map(rows.map((row) => [row.itemName, row]));

    // 12,50 EUR at 1.1 USD per EUR is 1,375 cents, and the same conversion is applied to each item.
    expect(byName.get('Bacalhau')?.priceUsdCents).toBe(1375);
    expect(byName.get('Bacalhau')?.itemCategory).toBe('main');
    expect(byName.get('Bacalhau')?.normalizedName).toBe('bacalhau');
    expect(byName.get('Bacalhau')?.localAmountMinor).toBe(1250);
    expect(byName.get('Bacalhau')?.alcoholic).toBeNull();
    expect(byName.get('Arroz de Marisco')?.priceUsdCents).toBe(2640);
    expect(byName.get('Espresso')?.itemCategory).toBe('drink');
    expect(byName.get('Espresso')?.alcoholic).toBe(false);
    expect(byName.get('Espresso')?.priceUsdCents).toBe(275);
    expect(byName.get('Imperial')?.alcoholic).toBe(true);
    expect(byName.get('Imperial')?.priceUsdCents).toBe(550);
  });

  it('stores partial data as needs_review and leaves the task to an operator', async () => {
    const call = await seedMenuCall({
      outcome: 'needs_review',
      confidence: 'low',
      items: [
        {
          slot: 'cheapest_main',
          dish: 'Bacalhau',
          priceText: '12,50 €',
          amountMinor: 1250,
          currency: 'EUR',
          confirmed: false,
        },
      ],
    });

    expect(await runApply(call.attemptId)).toEqual({ applied: true, taskStatus: 'needs_review' });

    const task = await taskRow(call.taskId);
    expect(task.status).toBe('needs_review');
    expect(task.resolvedBy).toBeNull();
    expect(task.outcomeAt?.toISOString()).toBe(call.endedAt.toISOString());

    const rows = await priceRows(call.placeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewStatus).toBe('needs_review');
    expect(rows[0]?.confidence).toBe('low');
  });

  it('stores nothing when the payload is not a readable extraction', async () => {
    // The menu form without its `items` list: a shape the contract does not define.
    const call = await seedMenuCall({ outcome: 'needs_review' });
    await db.callAttempt.update({
      where: { id: call.attemptId },
      data: { extractedFields: extraction({ kind: 'menu_prices' }) },
    });

    expect(await runApply(call.attemptId)).toEqual({ applied: true, taskStatus: 'needs_review' });
    expect(await priceRows(call.placeId)).toHaveLength(0);
  });

  it('drops an item whose currency the FX table does not cover', async () => {
    const call = await seedMenuCall({
      outcome: 'completed',
      items: [
        ...MENU_ITEMS.slice(0, 1),
        {
          slot: 'priciest_main',
          dish: 'Roast',
          priceText: '£18.00',
          amountMinor: 1800,
          currency: 'GBP',
          confirmed: true,
        },
      ],
    });

    // One of the two items could not be converted, so the task is not complete on partial data.
    expect(await runApply(call.attemptId)).toEqual({ applied: true, taskStatus: 'needs_review' });

    const rows = await priceRows(call.placeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.itemName).toBe('Bacalhau');
  });

  it('throws for a covered currency with no rate and leaves the task untouched', async () => {
    const call = await seedMenuCall({
      outcome: 'completed',
      items: [
        {
          slot: 'cheapest_main',
          dish: 'Tacos',
          priceText: '$180',
          amountMinor: 18000,
          currency: 'MXN',
          confirmed: true,
        },
      ],
    });

    await expect(runApply(call.attemptId)).rejects.toBeInstanceOf(FxRateUnavailableError);

    // The transaction rolled back: the task is still the dispatcher's to retry, and nothing was
    // stored from a price that has no rate (AAP 0.5.6).
    const task = await taskRow(call.taskId);
    expect(task.status).toBe('in_progress');
    expect(task.outcomeAt).toBeNull();
    expect(await priceRows(call.placeId)).toHaveLength(0);
  });

  it('hands a covered currency with no rate to the operator on the last delivery', async () => {
    const call = await seedMenuCall({
      outcome: 'completed',
      items: [
        {
          slot: 'cheapest_main',
          dish: 'Tacos',
          priceText: '$180',
          amountMinor: 18000,
          currency: 'MXN',
          confirmed: true,
        },
      ],
    });

    expect(await runFinalApply(call.attemptId)).toEqual({
      applied: true,
      taskStatus: 'needs_review',
    });

    // With no retry left there is nothing to fail into, so the task leaves `in_progress` for the one
    // status an operator resolves a menu task from, dated by the attempt's own end (AAP 0.5.3, 0.5.7),
    // and the prices the call could not convert are still not stored (AAP 0.5.6).
    const task = await taskRow(call.taskId);
    expect(task.status).toBe('needs_review');
    expect(task.resolvedBy).toBeNull();
    expect(task.blockedReason).toBeNull();
    expect(task.outcomeAt?.toISOString()).toBe(call.endedAt.toISOString());
    expect(await priceRows(call.placeId)).toHaveLength(0);

    // The hand-off reports the failure by id and a short token, never by its message (AAP 0.11.1).
    const line = logs.find(
      (entry) =>
        entry['event'] === 'call_result_unapplied' && entry['attemptId'] === call.attemptId,
    );
    expect(line).toMatchObject({ code: 'FxRateUnavailableError' });

    // A redelivery now finds a task that is no longer its to move, which is what proves the task left
    // `in_progress` and is the operator's to resolve.
    expect(await runApply(call.attemptId)).toEqual({
      applied: false,
      reason: 'task_not_in_progress',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The outcomes that collect nothing (AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

describe('a menu call that collected nothing', () => {
  const cases: {
    readonly name: string;
    readonly outcome: CallAttemptOutcome;
    readonly attempts: number;
    readonly expected: CallTaskStatus;
    readonly blockedReason: BlockedReason | null;
  }[] = [
    {
      name: 'requeues an unanswered call',
      outcome: 'no_answer',
      attempts: 1,
      expected: 'queued',
      blockedReason: null,
    },
    {
      name: 'stops after the second unanswered call',
      outcome: 'no_answer',
      attempts: 2,
      expected: 'unreachable',
      blockedReason: null,
    },
    {
      name: 'stops on an invalid number',
      outcome: 'unreachable',
      attempts: 1,
      expected: 'unreachable',
      blockedReason: 'invalid_number',
    },
    {
      name: 'closes on a refusal',
      outcome: 'refused',
      attempts: 1,
      expected: 'refused',
      blockedReason: null,
    },
  ];

  it.each(cases)('$name', async (entry) => {
    const call = await seedMenuCall({ outcome: entry.outcome, attempts: entry.attempts });

    expect(await runApply(call.attemptId)).toEqual({ applied: true, taskStatus: entry.expected });

    const task = await taskRow(call.taskId);
    expect(task.status).toBe(entry.expected);
    expect(task.blockedReason).toBe(entry.blockedReason);
    expect(task.outcomeAt?.toISOString()).toBe(call.endedAt.toISOString());
    expect(task.resolvedBy).toBeNull();

    if (entry.expected === 'queued') {
      // The retry is a day after the attempt ended, and a queued task is not blocked (AAP 0.5.3).
      expect(task.nextAttemptAt.toISOString()).toBe(
        new Date(call.endedAt.getTime() + 24 * HOUR_MS).toISOString(),
      );
    }

    expect(await priceRows(call.placeId)).toHaveLength(0);
  });

  it('blocks the number everywhere and cancels every other task for it', async () => {
    // The call answers for the seeded place, whose number a second place shares (AAP 0.5.6).
    const call = await seedMenuCall({ outcome: 'do_not_call', placeId: PLACE });

    // A second place behind the same line, with a task waiting and a call already live, and a third
    // place on another number that must be left exactly as it is.
    const sharedTaskId = randomUUID();
    const sharedAttemptId = randomUUID();
    const otherTaskId = randomUUID();

    await db.callTask.create({
      data: {
        id: sharedTaskId,
        kind: 'menu_prices',
        placeId: PLACE_SHARED,
        status: 'queued',
        nextAttemptAt: START,
      },
    });
    await db.callAttempt.create({
      data: {
        id: sharedAttemptId,
        callTaskId: sharedTaskId,
        twilioCallSid: `CA-${sharedAttemptId.slice(0, 8)}`,
        state: 'in_progress',
        startedAt: START,
      },
    });
    await db.callTask.create({
      data: {
        id: otherTaskId,
        kind: 'menu_prices',
        placeId: PLACE_OTHER,
        status: 'queued',
        nextAttemptAt: START,
      },
    });

    expect(await runApply(call.attemptId)).toEqual({ applied: true, taskStatus: 'do_not_call' });

    const applied = await taskRow(call.taskId);
    expect(applied.status).toBe('do_not_call');
    expect(applied.blockedReason).toBe('do_not_call');

    // The number is blocked on both records that carry it, and nowhere else.
    expect((await db.place.findUniqueOrThrow({ where: { id: PLACE } })).doNotCall).toBe(true);
    expect((await db.place.findUniqueOrThrow({ where: { id: PLACE_SHARED } })).doNotCall).toBe(
      true,
    );
    expect((await db.place.findUniqueOrThrow({ where: { id: PLACE_OTHER } })).doNotCall).toBe(
      false,
    );

    expect((await taskRow(sharedTaskId)).status).toBe('cancelled');
    expect((await taskRow(otherTaskId)).status).toBe('queued');

    // Only the attempt that did not produce the result is superseded (AAP 0.5.3).
    const sharedAttempt = await db.callAttempt.findUniqueOrThrow({
      where: { id: sharedAttemptId },
    });
    const appliedAttempt = await db.callAttempt.findUniqueOrThrow({
      where: { id: call.attemptId },
    });
    expect(sharedAttempt.superseded).toBe(true);
    expect(appliedAttempt.superseded).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// A lodging call's result (AAP 0.5.3, 0.5.7)
// ---------------------------------------------------------------------------------------------

describe('a stay call with a confirmed answer', () => {
  it('verifies the claim, completes the task and credits the lodging', async () => {
    const call = await seedStayCall({
      outcome: 'completed',
      confidence: 'high',
      answer: 'yes',
      confirmed: true,
    });

    expect(await runApply(call.attemptId)).toEqual({ applied: true, taskStatus: 'completed' });

    const task = await taskRow(call.taskId);
    expect(task.status).toBe('completed');
    expect(task.resolvedBy).toBe('agent');
    expect(task.lodgingClaimId).toBe(call.claimId);

    const claim = await db.lodgingClaim.findUniqueOrThrow({ where: { id: call.claimId } });
    expect(claim.status).toBe('verified');
    expect(claim.resolvedAt?.toISOString()).toBe(START.toISOString());

    // The verification backfills the one completed meetup the stay covers (AAP 0.5.7).
    const facts = await db.lodgingActivityFact.findMany({ where: { lodgingId: LODGING } });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.meetupId).toBe(MEETUP);

    // The dashboard's claim measures and the claimant's notification are written with it.
    expect(
      await db.analyticsEvent.count({ where: { name: 'lodging_claim_resolved' } }),
    ).toBeGreaterThan(0);
    expect(await db.outboxMessage.count({ where: { kind: 'notification' } })).toBeGreaterThan(0);
  });

  it('rejects the claim when reception said no', async () => {
    const call = await seedStayCall({
      outcome: 'completed',
      confidence: 'high',
      answer: 'no',
      confirmed: true,
    });

    expect(await runApply(call.attemptId)).toEqual({ applied: true, taskStatus: 'completed' });

    const claim = await db.lodgingClaim.findUniqueOrThrow({ where: { id: call.claimId } });
    expect(claim.status).toBe('rejected');
    expect(await db.lodgingActivityFact.count({ where: { lodgingId: LODGING } })).toBe(1);
  });

  it('returns the claim to pending_call when no answer was confirmed', async () => {
    const call = await seedStayCall({
      outcome: 'needs_review',
      confidence: 'low',
      answer: 'yes',
      confirmed: false,
    });

    expect(await runApply(call.attemptId)).toEqual({ applied: true, taskStatus: 'needs_review' });

    const claim = await db.lodgingClaim.findUniqueOrThrow({ where: { id: call.claimId } });
    expect(claim.status).toBe('pending_call');
    expect(claim.resolvedAt).toBeNull();

    // The task joins the operator queue while the claimant still sees the claim pending, and the
    // attempt's own fields are left for the operator to read (AAP 0.5.3).
    const task = await taskRow(call.taskId);
    expect(task.status).toBe('needs_review');
    const attempt = await db.callAttempt.findUniqueOrThrow({ where: { id: call.attemptId } });
    expect(attempt.extractedFields).not.toBeNull();
  });

  it('refuses a result whose claim a resolution has already decided', async () => {
    const call = await seedStayCall({
      outcome: 'completed',
      confidence: 'high',
      answer: 'yes',
      confirmed: true,
      claimStatus: 'verified',
    });

    expect(await runApply(call.attemptId)).toEqual({ applied: false, reason: 'claim_missing' });
    expect((await taskRow(call.taskId)).status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------------------------
// The guards (AAP 0.3.2, 0.5.3)
// ---------------------------------------------------------------------------------------------

describe('a result that has already been decided', () => {
  it('is refused when the task is no longer in progress', async () => {
    const call = await seedMenuCall({ outcome: 'completed' });

    expect(await runApply(call.attemptId)).toEqual({ applied: true, taskStatus: 'completed' });
    // The outbox row was redelivered: the same job, the same attempt, nothing left to decide.
    expect(await runApply(call.attemptId)).toEqual({
      applied: false,
      reason: 'task_not_in_progress',
    });
    expect(await priceRows(call.placeId)).toHaveLength(4);
  });

  it('is refused when the attempt was superseded', async () => {
    const call = await seedMenuCall({ outcome: 'completed', superseded: true });

    expect(await runApply(call.attemptId)).toEqual({
      applied: false,
      reason: 'attempt_superseded',
    });
    expect((await taskRow(call.taskId)).status).toBe('in_progress');
  });

  it('is refused when a later attempt has replaced it', async () => {
    const call = await seedMenuCall({
      outcome: 'needs_review',
      startedAt: new Date(START.getTime() - 4 * HOUR_MS),
    });
    const later = randomUUID();

    await db.callAttempt.create({
      data: {
        id: later,
        callTaskId: call.taskId,
        twilioCallSid: `CA-${later.slice(0, 8)}`,
        state: 'in_progress',
        startedAt: new Date(START.getTime() - 2 * HOUR_MS),
      },
    });

    expect(await runApply(call.attemptId)).toEqual({
      applied: false,
      reason: 'attempt_superseded',
    });
    expect((await taskRow(call.taskId)).status).toBe('in_progress');
  });

  it('is refused when it names an attempt that is gone', async () => {
    expect(await runApply(randomUUID())).toEqual({ applied: false, reason: 'attempt_missing' });
  });

  it('is refused when the attempt carries no outcome yet', async () => {
    const taskId = randomUUID();
    const attemptId = randomUUID();

    await db.callTask.create({
      data: {
        id: taskId,
        kind: 'menu_prices',
        placeId: PLACE,
        status: 'in_progress',
        attempts: 1,
        nextAttemptAt: START,
      },
    });
    await db.callAttempt.create({
      data: {
        id: attemptId,
        callTaskId: taskId,
        twilioCallSid: `CA-${attemptId.slice(0, 8)}`,
        state: 'in_progress',
        startedAt: START,
      },
    });

    expect(await runApply(attemptId)).toEqual({ applied: false, reason: 'outcome_missing' });
    expect(
      logs.some(
        (line) =>
          line['event'] === 'call_result_without_outcome' && line['attemptId'] === attemptId,
      ),
    ).toBe(true);
  });

  it('is refused for an attempt whose call content was stripped', async () => {
    const call = await seedStayCall({
      outcome: 'needs_review',
      extracted: false,
      detachedClaim: true,
      twilioCallSid: null,
    });

    expect(await runApply(call.attemptId)).toEqual({ applied: false, reason: 'attempt_stripped' });
    expect((await taskRow(call.taskId)).status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------------------------
// The job's own boundary (AAP 0.5.6, 0.11.1)
// ---------------------------------------------------------------------------------------------

describe('the job itself', () => {
  it('refuses a name the call-results queue does not accept', async () => {
    await expect(
      process(
        { name: 'settle', data: { outboxId: randomUUID(), callAttemptId: randomUUID() } },
        ctx as WorkerContext,
      ),
    ).rejects.toBeInstanceOf(QueuePayloadError);
  });

  it('refuses data that is not an attempt to apply', async () => {
    await expect(
      process(
        { name: JOB[QUEUE.callResults].apply, data: { outboxId: randomUUID() } },
        ctx as WorkerContext,
      ),
    ).rejects.toBeInstanceOf(QueuePayloadError);
  });

  it('logs the applied outcome by id alone', async () => {
    const call = await seedMenuCall({ outcome: 'completed' });

    await runApply(call.attemptId);

    const line = logs.find(
      (entry) => entry['event'] === 'call_outcome' && entry['attemptId'] === call.attemptId,
    );
    expect(line).toMatchObject({
      taskId: call.taskId,
      outcome: 'completed',
      taskStatus: 'completed',
    });
    // Nothing that was said on the call reaches a log line (AAP 0.11.1).
    expect(JSON.stringify(line)).not.toContain(MENU_PHONE);
    expect(JSON.stringify(line)).not.toContain('Bacalhau');
  });
});
