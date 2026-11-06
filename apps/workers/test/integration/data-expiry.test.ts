/**
 * Integration tests for `apps/workers/src/jobs/data-expiry.ts` (AAP 0.5.2, 0.5.6, 0.8.1).
 *
 * The suite runs against a real PostgreSQL 16 with PostGIS 3.4, started from the shipped image and
 * migrated with `packages/db/prisma/migrations/20261104000000_init/migration.sql`, so what it proves
 * is the effect of the job's own statements on the schema the run delivers. Time comes from
 * `createTestClock`, which lets one frozen instant drive every retention boundary and then move two
 * days to show a rule following the clock.
 *
 * The cases, in order:
 *
 *   1. `process` refuses a job name the `data-expiry` queue does not accept, and data whose `step`
 *      contradicts the name it arrived as (AAP 0.5.6).
 *   2. The hourly step erases a resolved claim's booking details, strips its lodging call rows to
 *      exactly the shape AAP 0.5.2 keeps, and leaves a claim that is still `calling` alone.
 *   3. The same step applies the transcript, magic-link, session, 365-day call-metadata, 180-day
 *      reason, operator-access-log and 120-day activity-fact rules.
 *   4. A second run of the hourly step at the same instant changes nothing and reports zeros.
 *   5. After the clock moves two days, the transcript that was not yet due is deleted and a grace
 *      period that has run out takes its row — the test clock driving the job, not a fixed window.
 *   6. The daily step purges the meetup family past `FINANCIAL_RETENTION_DAYS`, the `StripeEvent`
 *      rows, the finished `delete_customer` operation, the tombstone-owned reputation rows and the
 *      tombstone no retained record references — while the live participant's witness event keeps
 *      existing with its meetup link nulled, so a live account's counters cannot move.
 *   7. A second run of the daily step changes nothing.
 *
 * @see AAP 0.5.2 for every rule, 0.12.2 for the stripped shape, 0.11.2 for the integration layer
 *   running against real PostgreSQL, and 0.8.1 for the file under test.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, type DbClient } from '@tablemate/db';
import { DAY_MS, HOUR_MS } from '@tablemate/shared';
import { createLogger, createTestClock, loadWorkersEnv } from '@tablemate/server-core';

import { process, runDailyExpiry, runHourlyExpiry } from '../../src/jobs/data-expiry.ts';

/** The instant every relative date below is measured from, and the clock's starting point. */
const START = new Date('2026-11-04T12:00:00.000Z');

/** `START` moved by `days` (negative for the past), so one instant describes every seeded age. */
const at = (days: number): Date => new Date(START.getTime() + days * DAY_MS);

/** `START` moved backwards by `hours`, for the two grace periods shorter than a day (AAP 0.5.2). */
const hoursAgo = (hours: number): Date => new Date(START.getTime() - hours * HOUR_MS);

/**
 * The migration the container is built with: the same file the compose stack applies.
 *
 * Found by walking up from this module's own directory rather than by a fixed relative path, because
 * the repository carries no vitest configuration and `vitest run` therefore collects the compiled
 * copy of this file under `dist/` as well as the source: from `apps/workers/dist/test/integration` a
 * fixed depth of four lands in `apps/` instead of the repository root.
 */
const MIGRATION = findMigration();

/**
 * The nearest ancestor of this module's directory that holds the init migration, so the source and
 * the compiled copy of this file read the same file.
 *
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

// Every row this suite seeds is named, and the names are the assertions' vocabulary. The ids are
// plain uuids rather than generated ones so a failing assertion names the row it meant.
const CITY = 'lisbon';
const VENUE = 'aaaaaaaa-0000-4000-8000-000000000001';
const LODGING = 'aaaaaaaa-0000-4000-8000-000000000002';
const LODGING_TWO = 'aaaaaaaa-0000-4000-8000-000000000004';
const PLACE = 'aaaaaaaa-0000-4000-8000-000000000003';
const LIVE = 'bbbbbbbb-0000-4000-8000-000000000001';
const LIVE_TWO = 'bbbbbbbb-0000-4000-8000-000000000002';
const GONE = 'bbbbbbbb-0000-4000-8000-000000000003';
const GONE_KEPT = 'bbbbbbbb-0000-4000-8000-000000000004';
const GONE_FREE = 'bbbbbbbb-0000-4000-8000-000000000005';
const MEETUP_OLD = 'cccccccc-0000-4000-8000-000000000001';
const MEETUP_RECENT = 'cccccccc-0000-4000-8000-000000000002';
const DEPOSIT_OLD = 'dddddddd-0000-4000-8000-000000000001';
const OPERATION_OLD = 'dddddddd-0000-4000-8000-000000000002';
const CUSTOMER_OLD = 'dddddddd-0000-4000-8000-000000000003';
const CUSTOMER_RECENT = 'dddddddd-0000-4000-8000-000000000004';
const CREDIT_OLD = 'eeeeeeee-0000-4000-8000-000000000001';
const CHECK_IN_OLD = 'eeeeeeee-0000-4000-8000-000000000002';
const MESSAGE_OLD = 'eeeeeeee-0000-4000-8000-000000000003';
const DISPUTE_OLD = 'ffffffff-0000-4000-8000-000000000001';
const DISPUTE_STALE = 'ffffffff-0000-4000-8000-000000000002';
const DISPUTE_OPEN = 'ffffffff-0000-4000-8000-000000000003';
const WITNESS_LIVE = 'ffffffff-0000-4000-8000-000000000004';
const WITNESS_GONE = 'ffffffff-0000-4000-8000-000000000005';
const WITNESS_LONE = 'ffffffff-0000-4000-8000-000000000006';
const REPORT_OLD = 'ffffffff-0000-4000-8000-000000000007';
const REPORT_RECENT = 'ffffffff-0000-4000-8000-000000000008';
const REPORT_LINKED = 'ffffffff-0000-4000-8000-000000000009';
const FACT_OLD = 'ffffffff-0000-4000-8000-00000000000a';
const FACT_FOR_OLD_MEETUP = 'ffffffff-0000-4000-8000-00000000000b';
const FACT_RECENT = 'ffffffff-0000-4000-8000-00000000000c';
const ACCESS_OLD = '66666666-0000-4000-8000-000000000001';
const ACCESS_RECENT = '66666666-0000-4000-8000-000000000002';
const STRIPE_OLD = 'evt_old';
const STRIPE_RECENT = 'evt_recent';
const CLAIM_TERMINAL = '99999999-0000-4000-8000-000000000001';
const CLAIM_LIVE = '99999999-0000-4000-8000-000000000002';
const TASK_LODGING_OLD = '99999999-0000-4000-8000-000000000003';
const TASK_LODGING_LIVE = '99999999-0000-4000-8000-000000000004';
const TASK_MENU_OLD = '99999999-0000-4000-8000-000000000005';
const TASK_MENU_RECENT = '99999999-0000-4000-8000-000000000006';
const TASK_MENU_REVIEW = '99999999-0000-4000-8000-000000000007';
const ATTEMPT_LODGING_OLD = '99999999-0000-4000-8000-000000000008';
const ATTEMPT_LODGING_LIVE = '99999999-0000-4000-8000-000000000009';
const ATTEMPT_MENU_OLD = '99999999-0000-4000-8000-00000000000a';
const ATTEMPT_MENU_RECENT = '99999999-0000-4000-8000-00000000000b';
const ATTEMPT_MENU_LATER = '99999999-0000-4000-8000-00000000000c';
const ATTEMPT_MENU_UNDATED = '99999999-0000-4000-8000-00000000000d';
const CALLBACK_FIRST = '55555555-0000-4000-8000-000000000001';
const CALLBACK_LAST = '55555555-0000-4000-8000-000000000002';
const MAGIC_PURGED = '88888888-0000-4000-8000-000000000001';
const MAGIC_DISARMED = '88888888-0000-4000-8000-000000000002';
const MAGIC_SENT = '88888888-0000-4000-8000-000000000003';
const MAGIC_LIVE = '88888888-0000-4000-8000-000000000004';
const SESSION_PURGED = '77777777-0000-4000-8000-000000000001';
const SESSION_KEPT = '77777777-0000-4000-8000-000000000002';

/** The lodging call's sid, which the strip must match on when it deletes the callbacks. */
const LODGING_SID = 'CA-terminal-0001';

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
let ctx: Parameters<typeof runHourlyExpiry>[0];
/** Assigned last in `beforeAll`, so a failure before that point leaves it undefined. */
let stop: (() => Promise<void>) | undefined;
const logs: Record<string, unknown>[] = [];

/** The ids a query returns, so an assertion reads as a set comparison rather than a count. */
async function ids(sql: TemplateStringsArray, ...values: unknown[]): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(sql, ...values);
  return rows.map((row) => row.id);
}

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
  // The expiry steps read the clock, the logger, the configuration and the database client, and no
  // other collaborator of a worker context, so the suite builds those four and asserts the cast: the
  // remaining fields are the ones no statement under test reaches.
  ctx = {
    env: loadWorkersEnv(environment(databaseUrl)),
    clock,
    logger: createLogger({
      name: 'data-expiry-test',
      level: 'info',
      appEnv: 'test',
      destination: {
        write: (line: string) => {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    }),
    db,
  } as unknown as Parameters<typeof runHourlyExpiry>[0];
  stop = async () => {
    await db.$disconnect();
    await container.stop();
  };
}, 300_000);

afterAll(async () => {
  // A `beforeAll` that failed before assigning `stop` must report its own error, not a second one.
  if (stop) {
    await stop();
  }
});

/**
 * The rows each rule is meant to act on, plus the neighbours it must leave alone.
 *
 * Every age is expressed against {@link START}, which is also the clock's instant when the first
 * assertions run, so the arithmetic an assertion checks is visible in the seed. The rows are created
 * through the guarded client rather than by hand-written SQL, which keeps a mistyped column out of
 * the fixture; the assertions read raw SQL, because the subject under test is raw SQL.
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
  await db.lodging.createMany({
    data: [
      { id: LODGING, cityId: CITY, name: 'Lodging', kind: 'hostel', phone: '+12025550100' },
      { id: LODGING_TWO, cityId: CITY, name: 'Lodging Two', kind: 'hotel', phone: '+12025550101' },
    ],
  });
  await db.place.createMany({
    data: [{ id: PLACE, cityId: CITY, name: 'Place', category: 'restaurant' }],
  });

  // Two live accounts — one of them the counterpart every retained row about an erased account
  // points at — and three tombstones: one still referenced by a report, one by a recent meetup, and
  // one referenced only by rows this run deletes.
  await db.user.createMany({
    data: [
      { id: LIVE, handle: 'live-one' },
      { id: LIVE_TWO, handle: 'live-two' },
    ],
  });
  await db.user.createMany({
    data: [
      { id: GONE, deletedAt: at(-200) },
      { id: GONE_KEPT, deletedAt: at(-200) },
      { id: GONE_FREE, deletedAt: at(-200) },
    ],
  });

  // The old meetup: finalised 2,558 days ago, one day past the 2,557-day retention period. The
  // recent one is 10 days old, and is why a tombstone that still appears in the directory stays.
  await db.meetup.createMany({
    data: [
      {
        id: MEETUP_OLD,
        initiatorId: LIVE,
        recipientId: LIVE_TWO,
        venueId: VENUE,
        startsAt: at(-2560),
        depositCents: 1000,
        status: 'completed',
        variantPairing: 'social',
        lockedAt: at(-2561),
        settledAt: at(-2560),
        finalAt: at(-2558),
        budgetUpdatedBy: GONE,
      },
      {
        id: MEETUP_RECENT,
        initiatorId: GONE_KEPT,
        recipientId: LIVE_TWO,
        venueId: VENUE,
        startsAt: at(-11),
        depositCents: 1000,
        status: 'completed',
        variantPairing: 'punitive',
        lockedAt: at(-12),
        settledAt: at(-10),
        finalAt: at(-10),
      },
    ],
  });

  await db.deposit.createMany({
    data: [
      {
        id: DEPOSIT_OLD,
        meetupId: MEETUP_OLD,
        ownerId: LIVE,
        role: 'initiator',
        status: 'captured',
        amountCents: 1000,
      },
    ],
  });
  await db.paymentOperation.createMany({
    data: [
      {
        id: OPERATION_OLD,
        userId: LIVE,
        depositId: DEPOSIT_OLD,
        kind: 'capture',
        seq: 1,
        idempotencyKey: 'capture-old-1',
        status: 'succeeded',
        completedAt: at(-2558),
      },
      {
        id: CUSTOMER_OLD,
        userId: GONE_FREE,
        kind: 'delete_customer',
        seq: 1,
        stripeCustomerId: 'cus_deleted',
        idempotencyKey: 'delete-customer-old',
        status: 'succeeded',
        completedAt: at(-2558),
      },
      {
        id: CUSTOMER_RECENT,
        userId: LIVE_TWO,
        kind: 'delete_customer',
        seq: 1,
        stripeCustomerId: 'cus_recent',
        idempotencyKey: 'delete-customer-recent',
        status: 'succeeded',
        completedAt: at(-10),
      },
    ],
  });
  await db.meetupSettlement.createMany({
    data: [
      {
        meetupId: MEETUP_OLD,
        outcome: 'completed',
        initiatorPresent: true,
        recipientPresent: true,
        appliedAt: at(-2560),
      },
    ],
  });
  await db.tableCreditEntry.createMany({
    data: [
      { id: CREDIT_OLD, userId: GONE, meetupId: MEETUP_OLD, kind: 'grant', amountCents: 1000 },
    ],
  });
  await db.checkIn.createMany({
    data: [
      {
        id: CHECK_IN_OLD,
        meetupId: MEETUP_OLD,
        userId: LIVE_TWO,
        result: 'pass',
        distanceBucket: 'lt_50',
      },
    ],
  });
  await db.message.createMany({
    data: [{ id: MESSAGE_OLD, meetupId: MEETUP_OLD, senderId: LIVE, body: 'see you there' }],
  });
  await db.dispute.createMany({
    data: [
      {
        id: DISPUTE_OLD,
        meetupId: MEETUP_OLD,
        filedById: LIVE,
        reason: 'old dispute',
        status: 'resolved',
        outcome: 'no_fault',
        openedAt: at(-2562),
        deadlineAt: at(-2557),
        resolvedAt: at(-2560),
      },
      {
        id: DISPUTE_STALE,
        meetupId: MEETUP_RECENT,
        filedById: LIVE_TWO,
        reason: 'stale dispute',
        status: 'resolved',
        outcome: 'settle_by_checkins',
        openedAt: at(-205),
        deadlineAt: at(-200),
        resolvedAt: at(-200),
      },
      {
        id: DISPUTE_OPEN,
        meetupId: MEETUP_RECENT,
        filedById: GONE_KEPT,
        reason: 'open dispute',
        status: 'open',
        openedAt: at(-2),
        deadlineAt: at(3),
      },
    ],
  });

  // Reputation: the live participant's witness event must survive the purge with its meetup link
  // nulled, the erased participant's must go, and the lone tombstone's must go with it.
  await db.witnessEvent.createMany({
    data: [
      {
        id: WITNESS_LIVE,
        meetupId: MEETUP_OLD,
        userId: LIVE,
        counterpartId: GONE,
        venueId: VENUE,
        cityId: CITY,
        completedAt: at(-2560),
        countsForReputation: true,
      },
      {
        id: WITNESS_GONE,
        meetupId: MEETUP_OLD,
        userId: GONE,
        counterpartId: LIVE,
        venueId: VENUE,
        cityId: CITY,
        completedAt: at(-2560),
        countsForReputation: true,
      },
      {
        id: WITNESS_LONE,
        userId: GONE_FREE,
        counterpartId: LIVE,
        venueId: VENUE,
        cityId: CITY,
        completedAt: at(-100),
        countsForReputation: true,
      },
    ],
  });
  await db.pairHistory.createMany({
    data: [
      {
        userLowId: LIVE,
        userHighId: GONE,
        completedCount: 1,
        firstCompletedAt: at(-2560),
        lastCompletedAt: at(-2558),
      },
      {
        userLowId: LIVE_TWO,
        userHighId: GONE_KEPT,
        completedCount: 1,
        firstCompletedAt: at(-10),
        lastCompletedAt: at(-10),
      },
      {
        userLowId: LIVE,
        userHighId: LIVE_TWO,
        completedCount: 1,
        firstCompletedAt: at(-2560),
        lastCompletedAt: at(-2558),
      },
    ],
  });

  await db.report.createMany({
    data: [
      {
        id: REPORT_OLD,
        reporterId: GONE,
        reportedId: LIVE,
        reason: 'old report',
        createdAt: at(-200),
      },
      {
        id: REPORT_RECENT,
        reporterId: LIVE_TWO,
        reportedId: LIVE,
        reason: 'recent report',
        createdAt: at(-10),
      },
      {
        id: REPORT_LINKED,
        reporterId: LIVE_TWO,
        reportedId: LIVE,
        reason: 'linked report',
        meetupId: MEETUP_OLD,
        createdAt: at(-10),
      },
    ],
  });

  await db.lodgingActivityFact.createMany({
    data: [
      {
        id: FACT_OLD,
        lodgingId: LODGING_TWO,
        meetupId: MEETUP_RECENT,
        pairKey: 'pair-old',
        completedAt: at(-130),
      },
      {
        id: FACT_FOR_OLD_MEETUP,
        lodgingId: LODGING,
        meetupId: MEETUP_OLD,
        pairKey: 'pair-meetup',
        completedAt: at(-10),
      },
      {
        id: FACT_RECENT,
        lodgingId: LODGING,
        meetupId: MEETUP_RECENT,
        pairKey: 'pair-recent',
        completedAt: at(-10),
      },
    ],
  });

  await db.operatorAccessLog.createMany({
    data: [
      {
        id: ACCESS_OLD,
        operatorId: LIVE,
        lodgingClaimId: CLAIM_TERMINAL,
        accessedAt: at(-400),
        purpose: 'manual_verification_call',
      },
      {
        id: ACCESS_RECENT,
        operatorId: LIVE,
        lodgingClaimId: CLAIM_TERMINAL,
        accessedAt: at(-10),
        purpose: 'manual_verification_call',
      },
    ],
  });

  // A resolved claim with booking details to erase and call rows to strip, and one whose call may
  // still be running: the second must come through the run untouched.
  await db.lodgingClaim.createMany({
    data: [
      {
        id: CLAIM_TERMINAL,
        userId: LIVE,
        lodgingId: LODGING,
        stayFrom: new Date('2026-10-01T00:00:00.000Z'),
        stayTo: new Date('2026-10-10T00:00:00.000Z'),
        bookingNameCiphertext: 'name-ciphertext',
        bookingReferenceCiphertext: 'reference-ciphertext',
        callConsentAt: at(-5),
        status: 'verified',
        resolvedAt: at(-1),
      },
      {
        id: CLAIM_LIVE,
        userId: LIVE_TWO,
        lodgingId: LODGING,
        stayFrom: new Date('2026-11-01T00:00:00.000Z'),
        stayTo: new Date('2026-11-20T00:00:00.000Z'),
        bookingNameCiphertext: 'live-name-ciphertext',
        bookingReferenceCiphertext: 'live-reference-ciphertext',
        callConsentAt: at(-1),
        status: 'calling',
      },
    ],
  });
  await db.callTask.createMany({
    data: [
      {
        id: TASK_LODGING_OLD,
        kind: 'lodging_stay_verification',
        lodgingId: LODGING,
        lodgingClaimId: CLAIM_TERMINAL,
        status: 'completed',
        attempts: 1,
        nextAttemptAt: at(-1),
        outcomeAt: at(-1),
      },
      {
        id: TASK_LODGING_LIVE,
        kind: 'lodging_stay_verification',
        lodgingId: LODGING,
        lodgingClaimId: CLAIM_LIVE,
        status: 'in_progress',
        attempts: 1,
        nextAttemptAt: at(-1),
      },
    ],
  });
  await db.callAttempt.createMany({
    data: [
      {
        id: ATTEMPT_LODGING_OLD,
        callTaskId: TASK_LODGING_OLD,
        twilioCallSid: LODGING_SID,
        state: 'ended',
        twilioFinalStatus: 'completed',
        outcome: 'completed',
        extractedFields: { guest: 'yes' },
        summary: 'guest confirmed',
        confidence: 'high',
        durationSec: 42,
        llmReservedMicros: 5000n,
        startedAt: at(-1),
        endedAt: at(-1),
      },
      {
        id: ATTEMPT_LODGING_LIVE,
        callTaskId: TASK_LODGING_LIVE,
        twilioCallSid: 'CA-live-0001',
        state: 'in_progress',
        summary: 'in progress',
        llmReservedMicros: 1000n,
        startedAt: at(-1),
      },
    ],
  });
  await db.voiceCallbackEvent.createMany({
    data: [
      {
        id: CALLBACK_FIRST,
        callAttemptId: ATTEMPT_LODGING_OLD,
        callSid: LODGING_SID,
        callStatus: 'initiated',
        sequenceNumber: 1,
        receivedAt: at(-1),
      },
      {
        id: CALLBACK_LAST,
        callAttemptId: ATTEMPT_LODGING_OLD,
        callSid: LODGING_SID,
        callStatus: 'completed',
        sequenceNumber: 2,
        receivedAt: at(-1),
      },
    ],
  });

  // Call metadata at both ends of the 365-day rule, and a transcript due only after the clock moves.
  await db.callTask.createMany({
    data: [
      {
        id: TASK_MENU_OLD,
        kind: 'menu_prices',
        placeId: PLACE,
        status: 'completed',
        attempts: 1,
        nextAttemptAt: at(-400),
        outcomeAt: at(-400),
      },
      {
        id: TASK_MENU_RECENT,
        kind: 'menu_prices',
        placeId: PLACE,
        status: 'completed',
        attempts: 2,
        nextAttemptAt: at(-10),
        outcomeAt: at(-10),
      },
      {
        id: TASK_MENU_REVIEW,
        kind: 'menu_prices',
        placeId: PLACE,
        status: 'needs_review',
        attempts: 1,
        nextAttemptAt: at(-400),
        outcomeAt: at(-400),
      },
    ],
  });
  await db.callAttempt.createMany({
    data: [
      {
        id: ATTEMPT_MENU_OLD,
        callTaskId: TASK_MENU_OLD,
        state: 'ended',
        outcome: 'completed',
        transcript: 'old transcript',
        transcriptDeleteAt: at(-400),
        startedAt: at(-400),
        endedAt: at(-400),
      },
      {
        id: ATTEMPT_MENU_RECENT,
        callTaskId: TASK_MENU_RECENT,
        state: 'ended',
        outcome: 'completed',
        transcript: 'recent transcript',
        transcriptDeleteAt: at(-1),
        startedAt: at(-10),
        endedAt: at(-10),
      },
      {
        id: ATTEMPT_MENU_LATER,
        callTaskId: TASK_MENU_RECENT,
        state: 'ended',
        outcome: 'completed',
        transcript: 'later transcript',
        transcriptDeleteAt: at(1),
        startedAt: at(-2),
        endedAt: at(-2),
      },
      {
        id: ATTEMPT_MENU_UNDATED,
        callTaskId: TASK_MENU_RECENT,
        state: 'ended',
        outcome: 'completed',
        transcript: 'undated transcript',
        startedAt: at(-40),
        endedAt: at(-40),
      },
    ],
  });

  await db.magicLinkToken.createMany({
    data: [
      {
        id: MAGIC_PURGED,
        tokenHash: 'hash-purged',
        emailCiphertext: 'email-ciphertext',
        emailLookupHash: 'lookup-purged',
        deliveryTokenCiphertext: 'delivery-purged',
        expiresAt: hoursAgo(25),
      },
      {
        id: MAGIC_DISARMED,
        tokenHash: 'hash-disarmed',
        emailCiphertext: 'email-ciphertext',
        emailLookupHash: 'lookup-disarmed',
        deliveryTokenCiphertext: 'delivery-disarmed',
        expiresAt: hoursAgo(2),
      },
      {
        id: MAGIC_SENT,
        tokenHash: 'hash-sent',
        emailCiphertext: 'email-ciphertext',
        emailLookupHash: 'lookup-sent',
        expiresAt: hoursAgo(2),
      },
      {
        id: MAGIC_LIVE,
        tokenHash: 'hash-live',
        emailCiphertext: 'email-ciphertext',
        emailLookupHash: 'lookup-live',
        deliveryTokenCiphertext: 'delivery-live',
        expiresAt: at(5),
      },
    ],
  });
  await db.session.createMany({
    data: [
      {
        id: SESSION_PURGED,
        userId: LIVE,
        refreshTokenHash: 'refresh-purged',
        expiresAt: hoursAgo(25),
      },
      { id: SESSION_KEPT, userId: LIVE, refreshTokenHash: 'refresh-kept', expiresAt: at(10) },
    ],
  });

  await db.stripeEvent.createMany({
    data: [
      {
        id: STRIPE_OLD,
        type: 'payment_intent.succeeded',
        status: 'processed',
        receivedAt: at(-2558),
      },
      {
        id: STRIPE_RECENT,
        type: 'payment_intent.succeeded',
        status: 'processed',
        receivedAt: at(-10),
      },
    ],
  });
}

describe('data-expiry', () => {
  beforeAll(async () => {
    await seed();
  }, 60_000);

  it('refuses a job name the queue does not accept, and data that contradicts its name', async () => {
    await expect(process({ name: 'fortnightly', data: { step: 'hourly' } }, ctx)).rejects.toThrow(
      /data-expiry\/fortnightly/,
    );
    await expect(process({ name: 'hourly', data: { step: 'daily' } }, ctx)).rejects.toThrow(
      /data-expiry\/hourly/,
    );
  });

  it('runs the hourly step as the `hourly` job: details erased, call rows stripped, windows applied', async () => {
    const counts = await process({ name: 'hourly', data: { step: 'hourly' } }, ctx);

    expect(counts).toEqual({
      bookingDetailsErased: 1,
      lodgingCallCallbacksDeleted: 2,
      lodgingCallAttemptsStripped: 1,
      lodgingCallTasksStripped: 1,
      menuTranscriptsDeleted: 3,
      magicLinkTokensDisarmed: 2,
      magicLinkTokensPurged: 1,
      sessionsPurged: 1,
      callAttemptsPurged: 1,
      callTasksPurged: 1,
      reportReasonsCleared: 1,
      disputeReasonsCleared: 2,
      operatorAccessLogsPurged: 1,
      lodgingActivityFactsPurged: 1,
    });
    expect(logs.at(-1)).toMatchObject({ event: 'data_expiry', step: 'hourly', counts });

    // Rule 1: the resolved claim lost its booking details and gained the erasure stamp; the claim
    // whose call may still be running lost nothing.
    const [terminalClaim] = await db.$queryRaw<
      { booking_name: string | null; booking_reference: string | null; erased_at: Date | null }[]
    >`SELECT "booking_name_ciphertext" AS "booking_name",
             "booking_reference_ciphertext" AS "booking_reference",
             "details_erased_at" AS "erased_at"
        FROM "lodging_claim" WHERE "id" = ${CLAIM_TERMINAL}::uuid`;
    expect(terminalClaim?.booking_name).toBeNull();
    expect(terminalClaim?.booking_reference).toBeNull();
    expect(terminalClaim?.erased_at?.toISOString()).toBe(START.toISOString());

    const [liveClaim] = await db.$queryRaw<
      { booking_name: string | null; erased_at: Date | null }[]
    >`SELECT "booking_name_ciphertext" AS "booking_name", "details_erased_at" AS "erased_at"
        FROM "lodging_claim" WHERE "id" = ${CLAIM_LIVE}::uuid`;
    expect(liveClaim?.booking_name).toBe('live-name-ciphertext');
    expect(liveClaim?.erased_at).toBeNull();

    // Rule 2: the attempt keeps its identity and loses everything about the call; the task keeps its
    // own shape and loses the claim link; the callbacks are gone, so a later Twilio callback matches
    // nothing (AAP 0.5.2, 0.12.2).
    const [attempt] = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "call_attempt" WHERE "id" = ${ATTEMPT_LODGING_OLD}::uuid`;
    expect(attempt).toMatchObject({
      id: ATTEMPT_LODGING_OLD,
      call_task_id: TASK_LODGING_OLD,
      state: 'ended',
      superseded: false,
      outcome: 'completed',
      twilio_final_status: 'completed',
      twilio_call_sid: null,
      summary: null,
      extracted_fields: null,
      confidence: null,
      duration_sec: null,
      transcript: null,
      transcript_delete_at: null,
      llm_reserved_micros: 0n,
    });
    expect((attempt?.['started_at'] as Date).toISOString()).toBe(at(-1).toISOString());
    expect((attempt?.['ended_at'] as Date).toISOString()).toBe(at(-1).toISOString());

    const [task] = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "call_task" WHERE "id" = ${TASK_LODGING_OLD}::uuid`;
    expect(task).toMatchObject({
      id: TASK_LODGING_OLD,
      kind: 'lodging_stay_verification',
      lodging_id: LODGING,
      lodging_claim_id: null,
      status: 'completed',
      attempts: 1,
      vendor_failures: 0,
      resolved_by: null,
    });
    expect((task?.['outcome_at'] as Date).toISOString()).toBe(at(-1).toISOString());

    expect(await ids`SELECT "id"::text AS "id" FROM "voice_callback_event"`).toEqual([]);

    const [liveAttempt] = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "call_attempt" WHERE "id" = ${ATTEMPT_LODGING_LIVE}::uuid`;
    expect(liveAttempt).toMatchObject({
      twilio_call_sid: 'CA-live-0001',
      summary: 'in progress',
      llm_reserved_micros: 1000n,
    });

    const [liveTask] = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "call_task" WHERE "id" = ${TASK_LODGING_LIVE}::uuid`;
    expect(liveTask).toMatchObject({ lodging_claim_id: CLAIM_LIVE, status: 'in_progress' });

    // Rule 3, and rule 6 deleting the aged attempt whose transcript it had just cleared. The undated
    // attempt is deleted too, on the data's own age rather than on a date nobody recorded.
    const [clearedTranscript] = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "call_attempt" WHERE "id" = ${ATTEMPT_MENU_RECENT}::uuid`;
    expect(clearedTranscript).toMatchObject({ transcript: null, transcript_delete_at: null });

    const [undatedTranscript] = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "call_attempt" WHERE "id" = ${ATTEMPT_MENU_UNDATED}::uuid`;
    expect(undatedTranscript).toMatchObject({ transcript: null, transcript_delete_at: null });

    const [pendingTranscript] = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "call_attempt" WHERE "id" = ${ATTEMPT_MENU_LATER}::uuid`;
    expect(pendingTranscript).toMatchObject({ transcript: 'later transcript' });
    expect((pendingTranscript?.['transcript_delete_at'] as Date).toISOString()).toBe(
      at(1).toISOString(),
    );

    expect(
      await ids`SELECT "id"::text AS "id" FROM "call_attempt" WHERE "call_task_id" = ${TASK_MENU_OLD}::uuid`,
    ).toEqual([]);
    expect(await ids`SELECT "id"::text AS "id" FROM "call_task" ORDER BY "id"`).toEqual([
      TASK_LODGING_OLD,
      TASK_LODGING_LIVE,
      TASK_MENU_RECENT,
      TASK_MENU_REVIEW,
    ]);

    // Rule 4 and rule 5: the purged token is gone in this run, the one inside the grace period is
    // disarmed but kept, a token the mailer already cleared and one that has not expired are
    // untouched, and the expired session's row is gone.
    expect(
      await ids`SELECT "id"::text AS "id" FROM "magic_link_token" WHERE "id" = ${MAGIC_PURGED}::uuid`,
    ).toEqual([]);
    const tokenRows = await db.$queryRaw<
      { id: string; delivery_token_ciphertext: string | null }[]
    >`SELECT "id"::text AS "id", "delivery_token_ciphertext" AS "delivery_token_ciphertext"
        FROM "magic_link_token" ORDER BY "id"`;
    expect(tokenRows).toEqual([
      { id: MAGIC_DISARMED, delivery_token_ciphertext: null },
      { id: MAGIC_SENT, delivery_token_ciphertext: null },
      { id: MAGIC_LIVE, delivery_token_ciphertext: 'delivery-live' },
    ]);
    expect(await ids`SELECT "id"::text AS "id" FROM "session" ORDER BY "id"`).toEqual([
      SESSION_KEPT,
    ]);

    // Rule 7: an old report and a resolved dispute lose their text, a recent one and an open one keep
    // theirs, and the dispute the daily step is about to delete has already been emptied.
    const reasonRows = await db.$queryRaw<{ id: string; reason: string }[]>`
      SELECT "id"::text AS "id", "reason" AS "reason" FROM "report" ORDER BY "id"`;
    expect(reasonRows).toEqual([
      { id: REPORT_OLD, reason: '' },
      { id: REPORT_RECENT, reason: 'recent report' },
      { id: REPORT_LINKED, reason: 'linked report' },
    ]);
    const disputeRows = await db.$queryRaw<{ id: string; reason: string }[]>`
      SELECT "id"::text AS "id", "reason" AS "reason" FROM "dispute" ORDER BY "id"`;
    expect(disputeRows).toEqual([
      { id: DISPUTE_OLD, reason: '' },
      { id: DISPUTE_STALE, reason: '' },
      { id: DISPUTE_OPEN, reason: 'open dispute' },
    ]);

    // Rules 8 and 9.
    expect(await ids`SELECT "id"::text AS "id" FROM "operator_access_log" ORDER BY "id"`).toEqual([
      ACCESS_RECENT,
    ]);
    expect(await ids`SELECT "id"::text AS "id" FROM "lodging_activity_fact" ORDER BY "id"`).toEqual(
      [FACT_FOR_OLD_MEETUP, FACT_RECENT],
    );
  });

  it('changes nothing when the hourly step runs a second time at the same instant', async () => {
    const counts = await runHourlyExpiry(ctx);

    expect(Object.values(counts).every((value) => value === 0)).toBe(true);
    const [attempt] = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "call_attempt" WHERE "id" = ${ATTEMPT_LODGING_OLD}::uuid`;
    expect(attempt).toMatchObject({ call_task_id: TASK_LODGING_OLD, twilio_call_sid: null });
  });

  it('follows the injected clock past a transcript’s date and a grace period’s end', async () => {
    clock.advance(2 * DAY_MS);
    const counts = await runHourlyExpiry(ctx);

    expect(counts).toEqual({
      bookingDetailsErased: 0,
      lodgingCallCallbacksDeleted: 0,
      lodgingCallAttemptsStripped: 0,
      lodgingCallTasksStripped: 0,
      menuTranscriptsDeleted: 1,
      magicLinkTokensDisarmed: 0,
      magicLinkTokensPurged: 2,
      sessionsPurged: 0,
      callAttemptsPurged: 0,
      callTasksPurged: 0,
      reportReasonsCleared: 0,
      disputeReasonsCleared: 0,
      operatorAccessLogsPurged: 0,
      lodgingActivityFactsPurged: 0,
    });

    const [later] = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM "call_attempt" WHERE "id" = ${ATTEMPT_MENU_LATER}::uuid`;
    expect(later).toMatchObject({ transcript: null, transcript_delete_at: null });
    expect(
      await ids`SELECT "id"::text AS "id" FROM "magic_link_token" WHERE "id" = ${MAGIC_DISARMED}::uuid`,
    ).toEqual([]);
  });

  it('runs the daily step as the `daily` job: the financial purge, the events and the tombstones', async () => {
    const counts = await process({ name: 'daily', data: { step: 'daily' } }, ctx);

    expect(counts).toEqual({
      meetupsPurged: 1,
      depositOperationsPurged: 1,
      depositsPurged: 1,
      settlementsPurged: 1,
      creditEntriesPurged: 1,
      checkInsPurged: 1,
      messagesPurged: 1,
      disputesPurged: 1,
      witnessEventsUnlinked: 2,
      reportsUnlinked: 1,
      activityFactsPurgedForMeetups: 1,
      customerOperationsPurged: 1,
      stripeEventsPurged: 1,
      tombstoneWitnessEventsPurged: 2,
      pairHistoryRowsPurged: 1,
      tombstonesPurged: 1,
    });
    expect(logs.at(-1)).toMatchObject({ event: 'data_expiry', step: 'daily', counts });

    // The meetup past the retention period and its whole family are gone; the recent one is not.
    expect(await ids`SELECT "id"::text AS "id" FROM "meetup" ORDER BY "id"`).toEqual([
      MEETUP_RECENT,
    ]);
    expect(await ids`SELECT "id"::text AS "id" FROM "deposit"`).toEqual([]);
    expect(await ids`SELECT "id"::text AS "id" FROM "payment_operation" ORDER BY "id"`).toEqual([
      CUSTOMER_RECENT,
    ]);
    expect(await ids`SELECT "meetup_id"::text AS "id" FROM "meetup_settlement"`).toEqual([]);
    expect(await ids`SELECT "id"::text AS "id" FROM "table_credit_entry"`).toEqual([]);
    expect(await ids`SELECT "id"::text AS "id" FROM "check_in"`).toEqual([]);
    expect(await ids`SELECT "id"::text AS "id" FROM "message"`).toEqual([]);
    expect(await ids`SELECT "id"::text AS "id" FROM "dispute" ORDER BY "id"`).toEqual([
      DISPUTE_STALE,
      DISPUTE_OPEN,
    ]);

    // The live participant's reputation row survives with its meetup link nulled, which is what keeps
    // a live account's counters where they were; the erased participant's and the lone tombstone's go.
    const witnessRows = await db.$queryRaw<{ id: string; meetup_id: string | null }[]>`
      SELECT "id"::text AS "id", "meetup_id"::text AS "meetup_id"
        FROM "witness_event" ORDER BY "id"`;
    expect(witnessRows).toEqual([{ id: WITNESS_LIVE, meetup_id: null }]);

    // The retained report keeps its text and loses the meetup link; the erased pairs go, the pair of
    // two live accounts stays; the tombstone nothing references any more is deleted.
    const [linkedReport] = await db.$queryRaw<{ meetup_id: string | null; reason: string }[]>`
      SELECT "meetup_id"::text AS "meetup_id", "reason" AS "reason"
        FROM "report" WHERE "id" = ${REPORT_LINKED}::uuid`;
    expect(linkedReport).toEqual({ meetup_id: null, reason: 'linked report' });

    const pairRows = await db.$queryRaw<{ low: string; high: string }[]>`
      SELECT "user_low_id"::text AS "low", "user_high_id"::text AS "high"
        FROM "pair_history" ORDER BY "user_low_id", "user_high_id"`;
    expect(pairRows).toEqual([
      { low: LIVE, high: LIVE_TWO },
      { low: LIVE_TWO, high: GONE_KEPT },
    ]);

    expect(await ids`SELECT "id"::text AS "id" FROM "user" ORDER BY "id"`).toEqual([
      LIVE,
      LIVE_TWO,
      GONE,
      GONE_KEPT,
    ]);
    expect(await ids`SELECT "id" AS "id" FROM "stripe_event" ORDER BY "id"`).toEqual([
      STRIPE_RECENT,
    ]);
    expect(await ids`SELECT "id"::text AS "id" FROM "lodging_activity_fact" ORDER BY "id"`).toEqual(
      [FACT_RECENT],
    );
  });

  it('changes nothing when the daily step runs a second time', async () => {
    const counts = await runDailyExpiry(ctx);

    expect(Object.values(counts).every((value) => value === 0)).toBe(true);
    expect(await ids`SELECT "id"::text AS "id" FROM "meetup"`).toEqual([MEETUP_RECENT]);
  });
});
