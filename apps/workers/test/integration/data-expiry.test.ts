/** Integration tests for the retention rules `apps/workers/src/jobs/data-expiry.ts` enforces (AAP 0.5.2, 0.5.6, 0.12.2). */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, testWorkersEnv, type TestApp } from '@tablemate/api/test-support/app';
import {
  callRoute,
  makeActivityFacts,
  makeCallAttempt,
  makeCallTask,
  makeClaim,
  makeDispute,
  makeLodging,
  makeMeetup,
  makePlace,
  makeUser,
  makeVenue,
  rows,
  type UserFixture,
} from '@tablemate/api/test-support/factories';
import { JOB, QUEUE, loadWorkersEnv } from '@tablemate/server-core';
import { DAY_MS, MINUTE_MS, MeDto } from '@tablemate/shared';

import {
  process as runDataExpiry,
  runDailyExpiry,
  runHourlyExpiry,
} from '../../src/jobs/data-expiry.ts';
import { closeWorkerContext, createWorkerContext, type WorkerContext } from '../../src/queues.ts';

const CITY = 'lisbon';
/** The minutes one day holds, so the two 24-hour boundaries below are written as the rules state them. */
const DAY_MINUTES = 24 * 60;
/** The provider call ids of the lodging call the strip removes and of the live one it must leave alone: `CA` and thirty-two hex digits, the shape Twilio reports and the unique column takes. */
const STRIPPED_CALL_SID = 'CA0123456789abcdef0123456789abcdef';
const LIVE_CALL_SID = 'CAfedcba9876543210fedcba9876543210';
/** What a lodging call's attempt carries before the strip: every field the rule has to take away, so the case asserts the retained shape against a row that was not already empty. */
const LODGING_CALL_CONTENT = {
  outcome: 'completed' as const,
  confidence: 'high' as const,
  summary: 'Fixture summary',
  extractedFields: { slots: 3 },
  durationSec: 42,
  llmReservedMicros: 1_234n,
};
/** The fields the strip takes off an attempt (AAP 0.5.2, 0.12.2): the provider's id, the summary, the extracted fields, the confidence, the duration, the transcript with its deadline, and the language-model reservation the call has released. */
const STRIPPED_ATTEMPT = {
  twilioCallSid: null,
  summary: null,
  extractedFields: null,
  confidence: null,
  durationSec: null,
  transcript: null,
  transcriptDeleteAt: null,
  llmReservedMicros: 0n,
} as const;
/** The `workers` configuration of this host: `FINANCIAL_RETENTION_DAYS` is the daily step's cut-off and is read here rather than assumed, because it is configuration (AAP 0.5.2, 0.6.2). */
const env = loadWorkersEnv(testWorkersEnv());
let testApp: TestApp;
let ctx: WorkerContext;
function minutesFromNow(minutes: number): Date {
  return new Date(testApp.time.now().getTime() + minutes * MINUTE_MS);
}

function daysFromNow(days: number): Date {
  return new Date(testApp.time.now().getTime() + days * DAY_MS);
}

/** `now` shifted by `days` and then by `minutes`, negative for the past: the instant one minute either side of a day-count rule's window. */
function atAge(days: number, minutes: number): Date {
  return new Date(testApp.time.now().getTime() + (days * DAY_MINUTES + minutes) * MINUTE_MS);
}

function residual(counts: Record<string, number>): readonly (readonly [string, number])[] {
  return Object.entries(counts).filter(([, count]) => count !== 0);
}

/** Run the hourly step once, then once more, and require the first pass to report `expected`, the second to report zeros, and `read` to be unchanged across it (AAP 0.3.2). @param read - The rows this case asserts on, read afresh before and after the second pass. @param expected - What the first pass must report, as the rule's own count keys. @returns The rows as they stand once the first pass has run. */
async function hourlyPass<Row>(
  read: () => Promise<Row>,
  expected: Record<string, number>,
): Promise<Row> {
  const first = await runHourlyExpiry(ctx);
  expect(
    first,
    'the first pass of the hourly step did not report the rule’s own counts',
  ).toMatchObject(expected);
  const after = await read();
  const second = residual(await runHourlyExpiry(ctx));
  expect(second, 'a second pass of the hourly step still changed rows').toEqual([]);
  expect(await read(), 'a second pass of the hourly step changed rows').toEqual(after);
  return after;
}

beforeAll(async () => {
  testApp = await createTestApp();
  // The app's own clock, so a case that advances it moves the job's cut-offs too, and the app's own database, which `resetState` truncates between cases (AAP 0.11.2).
  ctx = await createWorkerContext(env, { clock: testApp.clock });
});
afterAll(async () => {
  await closeWorkerContext(ctx);
  await testApp.close();
});
beforeEach(async () => {
  await testApp.resetState();
  await testApp.seedCities();
});
interface HourlyCase {
  readonly name: string;
  readonly check: () => Promise<void>;
}

/** One entry per hourly rule of `data-expiry.ts`, each seeding the record its rule is due to reach and, beside it, the record just inside the window the rule must not: one minute either side of the rule's own edge, which is what makes the rule's count move when its window moves (AAP 0.5.2). */
const HOURLY_CASES: readonly HourlyCase[] = [
  {
    name: 'erases a resolved claim’s booking details and keeps a live claim’s',
    check: async () => {
      const db = testApp.services.db;
      const guest = await makeUser(testApp);
      const lodging = await makeLodging(testApp, { cityId: CITY });
      const resolved = await makeClaim(testApp, guest, lodging, {
        status: 'verified',
        bookingReference: 'FIXTURE-REFERENCE-1',
      });
      const calling = await makeClaim(testApp, guest, lodging, {
        status: 'calling',
        bookingReference: 'FIXTURE-REFERENCE-2',
      });
      // The claim resolved a minute before the run. The rule keys off the status rather than the instant, which is what keeps it well inside the 24-hour limit criterion 14 measures.
      const erasedAt = testApp.time.advance({ minutes: 1 });
      const read = () =>
        Promise.all([
          db.lodgingClaim.findUniqueOrThrow({ where: { id: resolved.id } }),
          db.lodgingClaim.findUniqueOrThrow({ where: { id: calling.id } }),
        ]);
      const [resolvedBefore, liveBefore] = await read();
      const [after, live] = await hourlyPass(read, { bookingDetailsErased: 1 });
      expect(resolvedBefore.bookingNameCiphertext).not.toBeNull();
      expect(after).toEqual({
        ...resolvedBefore,
        bookingNameCiphertext: null,
        bookingReferenceCiphertext: null,
        detailsErasedAt: erasedAt,
      });
      expect(liveBefore.bookingReferenceCiphertext).not.toBeNull();
      expect(live).toEqual(liveBefore);
    },
  },
  {
    name: 'strips a resolved claim’s lodging call rows field by field and keeps a live claim’s',
    check: async () => {
      const db = testApp.services.db;
      const guest = await makeUser(testApp);
      const lodging = await makeLodging(testApp, { cityId: CITY });
      const resolved = await makeClaim(testApp, guest, lodging, { status: 'verified' });
      const calling = await makeClaim(testApp, guest, lodging, { status: 'calling' });
      const deleted = await makeClaim(testApp, guest, lodging, { status: 'rejected' });
      const outcomeAt = testApp.time.now();
      const taskOf = (lodgingClaimId: string | null) =>
        makeCallTask(testApp, {
          kind: 'lodging_stay_verification',
          lodgingId: lodging.id,
          ...(lodgingClaimId === null ? {} : { lodgingClaimId }),
          status: 'completed',
          attempts: 1,
          outcomeAt,
        });
      const stripped = await taskOf(resolved.id);
      const live = await taskOf(calling.id);
      const orphaned = await taskOf(deleted.id);
      await db.lodgingClaim.delete({ where: { id: deleted.id } });
      await db.callTask.updateMany({
        where: { id: { in: [stripped.id, live.id, orphaned.id] } },
        data: { resolvedBy: 'agent' },
      });
      const strippedAttempt = await makeCallAttempt(testApp, stripped, {
        ...LODGING_CALL_CONTENT,
        twilioCallSid: STRIPPED_CALL_SID,
      });
      const liveAttempt = await makeCallAttempt(testApp, live, {
        ...LODGING_CALL_CONTENT,
        twilioCallSid: LIVE_CALL_SID,
      });
      const orphanedAttempt = await makeCallAttempt(testApp, orphaned, LODGING_CALL_CONTENT);
      await db.voiceCallbackEvent.createMany({
        data: [
          {
            callAttemptId: strippedAttempt.id,
            callSid: STRIPPED_CALL_SID,
            callStatus: 'answered',
            sequenceNumber: 1,
            receivedAt: outcomeAt,
          },
          {
            callAttemptId: strippedAttempt.id,
            callSid: STRIPPED_CALL_SID,
            callStatus: 'completed',
            sequenceNumber: 2,
            receivedAt: outcomeAt,
          },
          {
            callAttemptId: liveAttempt.id,
            callSid: LIVE_CALL_SID,
            callStatus: 'completed',
            sequenceNumber: 1,
            receivedAt: outcomeAt,
          },
        ],
      });
      const read = async () => ({
        strippedTask: await db.callTask.findUniqueOrThrow({ where: { id: stripped.id } }),
        liveTask: await db.callTask.findUniqueOrThrow({ where: { id: live.id } }),
        orphanedTask: await db.callTask.findUniqueOrThrow({ where: { id: orphaned.id } }),
        strippedAttempt: await db.callAttempt.findUniqueOrThrow({
          where: { id: strippedAttempt.id },
        }),
        liveAttempt: await db.callAttempt.findUniqueOrThrow({ where: { id: liveAttempt.id } }),
        orphanedAttempt: await db.callAttempt.findUniqueOrThrow({
          where: { id: orphanedAttempt.id },
        }),
        callbacks: await db.voiceCallbackEvent.findMany({ orderBy: { sequenceNumber: 'asc' } }),
      });
      const before = await read();
      expect(before.callbacks).toHaveLength(3);
      const after = await hourlyPass(read, {
        lodgingCallCallbacksDeleted: 2,
        lodgingCallAttemptsStripped: 2,
        lodgingCallTasksStripped: 2,
      });
      expect(after.strippedTask).toEqual({
        ...before.strippedTask,
        lodgingClaimId: null,
        updatedAt: outcomeAt,
      });
      expect(after.strippedAttempt).toEqual({ ...before.strippedAttempt, ...STRIPPED_ATTEMPT });
      expect(after.callbacks.map((callback) => callback.callSid)).toEqual([LIVE_CALL_SID]);
      expect(after.liveTask).toEqual(before.liveTask);
      expect(after.liveAttempt).toEqual(before.liveAttempt);
      expect(after.orphanedTask).toEqual({
        ...before.orphanedTask,
        lodgingClaimId: null,
        updatedAt: outcomeAt,
      });
      expect(after.orphanedAttempt).toEqual({
        ...before.orphanedAttempt,
        ...STRIPPED_ATTEMPT,
      });
    },
  },
  {
    name: 'deletes a menu call’s transcript at thirty days and keeps one inside the window',
    check: async () => {
      const db = testApp.services.db;
      const place = await makePlace(testApp, { cityId: CITY, category: 'restaurant' });
      const task = await makeCallTask(testApp, {
        kind: 'menu_prices',
        placeId: place.id,
        status: 'completed',
        attempts: 1,
        outcomeAt: testApp.time.now(),
      });
      const due = await makeCallAttempt(testApp, task, {
        outcome: 'completed',
        confidence: 'high',
        summary: 'Fixture summary',
        extractedFields: { slots: 3 },
      });
      const inside = await makeCallAttempt(testApp, task, { outcome: 'completed' });
      const undated = await makeCallAttempt(testApp, task, { outcome: 'completed' });
      await db.callAttempt.update({
        where: { id: due.id },
        data: { transcript: 'Fixture transcript', transcriptDeleteAt: minutesFromNow(-1) },
      });
      await db.callAttempt.update({
        where: { id: inside.id },
        data: { transcript: 'Fixture transcript', transcriptDeleteAt: minutesFromNow(60) },
      });
      const dated = await makeCallAttempt(testApp, task, { outcome: 'completed' });
      await db.callAttempt.update({
        where: { id: undated.id },
        data: { transcript: 'Fixture transcript', startedAt: atAge(-30, -1) },
      });
      await db.callAttempt.update({
        where: { id: dated.id },
        data: { transcript: 'Fixture transcript', startedAt: atAge(-30, 1) },
      });
      const read = async () => ({
        due: await db.callAttempt.findUniqueOrThrow({ where: { id: due.id } }),
        inside: await db.callAttempt.findUniqueOrThrow({ where: { id: inside.id } }),
        undated: await db.callAttempt.findUniqueOrThrow({ where: { id: undated.id } }),
        dated: await db.callAttempt.findUniqueOrThrow({ where: { id: dated.id } }),
      });
      const before = await read();
      const after = await hourlyPass(read, { menuTranscriptsDeleted: 2 });
      expect(after.due).toEqual({ ...before.due, transcript: null, transcriptDeleteAt: null });
      expect(after.inside).toEqual(before.inside);
      expect(after.undated).toEqual({
        ...before.undated,
        transcript: null,
        transcriptDeleteAt: null,
      });
      expect(after.dated).toEqual(before.dated);
    },
  },
  {
    name: 'disarms an expired magic link, purges the row a day later, and keeps a fresh one',
    check: async () => {
      const db = testApp.services.db;
      const tokenOf = (label: string, expiresAt: Date) =>
        db.magicLinkToken.create({
          data: {
            tokenHash: `fixture-token-hash-${label}`,
            emailCiphertext: 'fixture-email-ciphertext',
            emailLookupHash: `fixture-email-lookup-${label}`,
            deliveryTokenCiphertext: 'fixture-delivery-token-ciphertext',
            expiresAt,
          },
          select: { id: true },
        });
      const expired = await tokenOf('expired', minutesFromNow(-1));
      const beyondGrace = await tokenOf('beyond-grace', minutesFromNow(-DAY_MINUTES - 1));
      const withinGrace = await tokenOf('within-grace', minutesFromNow(-DAY_MINUTES + 1));
      const fresh = await tokenOf('fresh', minutesFromNow(5));
      const read = async () => ({
        expired: await db.magicLinkToken.findUniqueOrThrow({ where: { id: expired.id } }),
        beyondGrace: await db.magicLinkToken.findUnique({ where: { id: beyondGrace.id } }),
        withinGrace: await db.magicLinkToken.findUniqueOrThrow({ where: { id: withinGrace.id } }),
        fresh: await db.magicLinkToken.findUniqueOrThrow({ where: { id: fresh.id } }),
      });
      const before = await read();
      const after = await hourlyPass(read, {
        magicLinkTokensDisarmed: 3,
        magicLinkTokensPurged: 1,
      });
      expect(before.expired.deliveryTokenCiphertext).not.toBeNull();
      expect(after.expired).toEqual({
        ...before.expired,
        deliveryTokenCiphertext: null,
      });
      expect(after.withinGrace).toEqual({
        ...before.withinGrace,
        deliveryTokenCiphertext: null,
      });
      expect(after.beyondGrace).toBeNull();
      expect(after.fresh).toEqual(before.fresh);
    },
  },
  {
    name: 'purges a session a day after it expired and keeps one inside the grace',
    check: async () => {
      const db = testApp.services.db;
      const guest = await makeUser(testApp);
      const sessionOf = (label: string, expiresAt: Date) =>
        db.session.create({
          data: {
            userId: guest.id,
            refreshTokenHash: `fixture-refresh-hash-${label}`,
            expiresAt,
          },
          select: { id: true },
        });
      const beyondGrace = await sessionOf('beyond-grace', minutesFromNow(-DAY_MINUTES - 1));
      const withinGrace = await sessionOf('within-grace', minutesFromNow(-DAY_MINUTES + 1));
      const read = async () => ({
        beyondGrace: await db.session.findUnique({ where: { id: beyondGrace.id } }),
        withinGrace: await db.session.findUniqueOrThrow({ where: { id: withinGrace.id } }),
      });
      const before = await read();
      const after = await hourlyPass(read, { sessionsPurged: 1 });
      expect(before.beyondGrace).not.toBeNull();
      expect(after.beyondGrace).toBeNull();
      expect(after.withinGrace).toEqual(before.withinGrace);
    },
  },
  {
    name: 'purges a menu call and its attempt at 365 days and keeps one a day inside',
    check: async () => {
      const db = testApp.services.db;
      const place = await makePlace(testApp, { cityId: CITY, category: 'cafe' });
      const taskOf = (outcomeAt: Date) =>
        makeCallTask(testApp, {
          kind: 'menu_prices',
          placeId: place.id,
          status: 'completed',
          attempts: 1,
          outcomeAt,
        });
      const stale = await taskOf(atAge(-365, -1));
      const current = await taskOf(atAge(-365, 1));
      const staleAttempt = await makeCallAttempt(testApp, stale, { outcome: 'completed' });
      const currentAttempt = await makeCallAttempt(testApp, current, { outcome: 'completed' });
      // Every instant on the row is set to the same boundary, so the rule's own COALESCE reads any of them and still ages the call by the outcome that ended it.
      const ageAttempt = (id: string, at: Date) =>
        db.callAttempt.update({ where: { id }, data: { startedAt: at, endedAt: at } });
      await ageAttempt(staleAttempt.id, atAge(-365, -1));
      await ageAttempt(currentAttempt.id, atAge(-365, 1));
      const read = async () => ({
        staleTask: await db.callTask.findUnique({ where: { id: stale.id } }),
        staleAttempt: await db.callAttempt.findUnique({ where: { id: staleAttempt.id } }),
        currentTask: await db.callTask.findUniqueOrThrow({ where: { id: current.id } }),
        currentAttempt: await db.callAttempt.findUniqueOrThrow({
          where: { id: currentAttempt.id },
        }),
      });
      const before = await read();
      const after = await hourlyPass(read, { callAttemptsPurged: 1, callTasksPurged: 1 });
      expect(before.staleTask).not.toBeNull();
      expect(after.staleTask).toBeNull();
      expect(after.staleAttempt).toBeNull();
      expect(after.currentTask).toEqual(before.currentTask);
      expect(after.currentAttempt).toEqual(before.currentAttempt);
    },
  },
  {
    name: 'purges an already-stripped lodging call at 365 days and keeps one a day inside',
    check: async () => {
      const db = testApp.services.db;
      const lodging = await makeLodging(testApp, { cityId: CITY });
      const taskOf = (outcomeAt: Date) =>
        makeCallTask(testApp, {
          kind: 'lodging_stay_verification',
          lodgingId: lodging.id,
          status: 'completed',
          attempts: 1,
          outcomeAt,
        });
      const stale = await taskOf(atAge(-365, -1));
      const current = await taskOf(atAge(-365, 1));
      const staleAttempt = await makeCallAttempt(testApp, stale, { outcome: 'completed' });
      const currentAttempt = await makeCallAttempt(testApp, current, { outcome: 'completed' });
      // The strip's own shape, which is what the age rule selects on: no provider id, no duration and every instant on the boundary. A row that still held a sid would be stripped by the hourly rule first, which is what makes this case about the age rule alone.
      const strip = (id: string, at: Date) =>
        db.callAttempt.update({
          where: { id },
          data: { twilioCallSid: null, durationSec: null, startedAt: at, endedAt: at },
        });
      await strip(staleAttempt.id, atAge(-365, -1));
      await strip(currentAttempt.id, atAge(-365, 1));
      const read = async () => ({
        staleTask: await db.callTask.findUnique({ where: { id: stale.id } }),
        staleAttempt: await db.callAttempt.findUnique({ where: { id: staleAttempt.id } }),
        currentTask: await db.callTask.findUniqueOrThrow({ where: { id: current.id } }),
        currentAttempt: await db.callAttempt.findUniqueOrThrow({
          where: { id: currentAttempt.id },
        }),
      });
      const before = await read();
      const after = await hourlyPass(read, { callAttemptsPurged: 1, callTasksPurged: 1 });
      expect(before.staleTask).not.toBeNull();
      expect(after.staleTask).toBeNull();
      expect(after.staleAttempt).toBeNull();
      expect(after.currentTask).toEqual(before.currentTask);
      expect(after.currentAttempt).toEqual(before.currentAttempt);
    },
  },
  {
    name: 'clears report and resolved-dispute reason text at 180 days and keeps an open dispute’s',
    check: async () => {
      const db = testApp.services.db;
      const reporter = await makeUser(testApp);
      const reported = await makeUser(testApp);
      const venue = await makeVenue(testApp, { cityId: CITY });
      const reportOf = (label: string, createdAt: Date) =>
        db.report.create({
          data: {
            reporterId: reporter.id,
            reportedId: reported.id,
            reason: `Fixture report ${label}`,
            createdAt,
          },
          select: { id: true },
        });
      const due = await reportOf('due', atAge(-180, -1));
      const inside = await reportOf('inside', atAge(-180, 1));
      const older = await makeMeetup(testApp, {
        status: 'completed',
        initiator: reporter,
        recipient: reported,
        venue,
      });
      const newer = await makeMeetup(testApp, {
        status: 'completed',
        initiator: reporter,
        recipient: reported,
        venue,
      });
      const resolvedDue = await makeDispute(testApp, older, reporter, {
        status: 'resolved',
        outcome: 'settle_by_checkins',
      });
      const resolvedInside = await makeDispute(testApp, newer, reporter, {
        status: 'resolved',
        outcome: 'settle_by_checkins',
      });
      const open = await makeDispute(testApp, older, reporter, { openedAt: daysFromNow(-200) });
      await db.dispute.update({
        where: { id: resolvedDue.id },
        data: { resolvedAt: atAge(-180, -1) },
      });
      await db.dispute.update({
        where: { id: resolvedInside.id },
        data: { resolvedAt: atAge(-180, 1) },
      });
      const read = async () => ({
        reportDue: await db.report.findUniqueOrThrow({ where: { id: due.id } }),
        reportInside: await db.report.findUniqueOrThrow({ where: { id: inside.id } }),
        disputeDue: await db.dispute.findUniqueOrThrow({ where: { id: resolvedDue.id } }),
        disputeInside: await db.dispute.findUniqueOrThrow({ where: { id: resolvedInside.id } }),
        disputeOpen: await db.dispute.findUniqueOrThrow({ where: { id: open.id } }),
      });
      const before = await read();
      const after = await hourlyPass(read, { reportReasonsCleared: 1, disputeReasonsCleared: 1 });
      // The row stays and only its text goes. Both columns are NOT NULL, so a cleared reason is the empty string rather than null.
      expect(before.reportDue.reason).toBe('Fixture report due');
      expect(after.reportDue).toEqual({ ...before.reportDue, reason: '' });
      expect(after.reportInside).toEqual(before.reportInside);
      expect(after.disputeDue).toEqual({ ...before.disputeDue, reason: '' });
      expect(after.disputeInside).toEqual(before.disputeInside);
      expect(after.disputeOpen).toEqual(before.disputeOpen);
    },
  },
  {
    name: 'purges the booking-detail access log at 365 days and keeps one a day inside',
    check: async () => {
      const db = testApp.services.db;
      const operator = await makeUser(testApp, { role: 'operator' });
      const guest = await makeUser(testApp);
      const lodging = await makeLodging(testApp, { cityId: CITY });
      const claim = await makeClaim(testApp, guest, lodging, { status: 'pending_call' });
      const logOf = (label: string, accessedAt: Date) =>
        db.operatorAccessLog.create({
          data: {
            operatorId: operator.id,
            lodgingClaimId: claim.id,
            purpose: 'manual_verification_call',
            accessedAt,
          },
          select: { id: true },
        });
      const stale = await logOf('stale', atAge(-365, -1));
      const current = await logOf('current', atAge(-365, 1));
      const read = async () => ({
        stale: await db.operatorAccessLog.findUnique({ where: { id: stale.id } }),
        current: await db.operatorAccessLog.findUniqueOrThrow({ where: { id: current.id } }),
      });
      const before = await read();
      const after = await hourlyPass(read, { operatorAccessLogsPurged: 1 });
      expect(before.stale).not.toBeNull();
      expect(after.stale).toBeNull();
      expect(after.current).toEqual(before.current);
    },
  },
  {
    name: 'purges a lodging activity fact at 120 days and keeps one inside the leaderboard window',
    check: async () => {
      const db = testApp.services.db;
      const lodging = await makeLodging(testApp, { cityId: CITY });
      const left = await makeUser(testApp);
      const right = await makeUser(testApp);
      // Two facts for one pair: the unique key is the lodging with the meetup, so both stand.
      await makeActivityFacts(testApp, lodging, [
        { pair: [left, right], completedAt: atAge(-120, -1) },
        { pair: [left, right], completedAt: atAge(-120, 1) },
      ]);
      const read = async () => ({
        stale: await db.lodgingActivityFact.findFirst({
          where: { lodgingId: lodging.id, completedAt: atAge(-120, -1) },
        }),
        current: await db.lodgingActivityFact.findFirstOrThrow({
          where: { lodgingId: lodging.id, completedAt: atAge(-120, 1) },
        }),
      });
      const before = await read();
      const after = await hourlyPass(read, { lodgingActivityFactsPurged: 1 });
      expect(before.stale).not.toBeNull();
      expect(after.stale).toBeNull();
      expect(after.current).toEqual(before.current);
    },
  },
];

describe('the hourly retention step (AAP 0.5.2)', () => {
  it.each(rows(HOURLY_CASES))('$name', async (hourlyCase) => {
    await hourlyCase.check();
  });
});

describe('the data-expiry queue processor (AAP 0.5.6)', () => {
  it('refuses a job name the queue does not accept, and data that contradicts its name', async () => {
    await expect(
      runDataExpiry({ name: 'fortnightly', data: { step: 'hourly' } }, ctx),
    ).rejects.toThrow(/data-expiry\/fortnightly/);
    await expect(runDataExpiry({ name: 'hourly', data: { step: 'daily' } }, ctx)).rejects.toThrow(
      /data-expiry\/hourly/,
    );
  });

  it('dispatches each step by name and leaves every financial record to the daily one', async () => {
    const db = testApp.services.db;
    const venue = await makeVenue(testApp, { cityId: CITY });
    const initiator = await makeUser(testApp);
    const recipient = await makeUser(testApp);
    const meetup = await makeMeetup(testApp, {
      status: 'completed',
      initiator,
      recipient,
      venue,
    });
    testApp.time.advance({ days: env.FINANCIAL_RETENTION_DAYS + 1 });
    const hourly = await runDataExpiry(
      { name: JOB[QUEUE.dataExpiry].hourly, data: { step: 'hourly' } },
      ctx,
    );
    expect(hourly).not.toHaveProperty('meetupsPurged');
    expect(await db.meetup.findUnique({ where: { id: meetup.id } })).not.toBeNull();
    expect(await db.deposit.count({ where: { meetupId: meetup.id } })).toBe(2);
    const daily = await runDataExpiry(
      { name: JOB[QUEUE.dataExpiry].daily, data: { step: 'daily' } },
      ctx,
    );
    expect(daily.meetupsPurged).toBe(1);
    expect(await db.meetup.findUnique({ where: { id: meetup.id } })).toBeNull();
  });
});

describe('the daily financial purge (AAP 0.5.2)', () => {
  it('purges what is past the retention period and leaves a live account’s counters unchanged', async () => {
    const db = testApp.services.db;
    const venue = await makeVenue(testApp, { cityId: CITY });
    const ana = await makeUser(testApp);
    const clara = await makeUser(testApp);
    const bea = await makeUser(testApp, { deleted: true });
    const duarte = await makeUser(testApp, { deleted: true });
    const startedAt = testApp.time.now();
    const first = await makeMeetup(testApp, {
      status: 'completed',
      initiator: ana,
      recipient: bea,
      venue,
    });
    const unattended = await makeMeetup(testApp, {
      status: 'unattended',
      initiator: clara,
      recipient: duarte,
      venue,
    });
    await db.tableCreditEntry.create({
      data: { userId: ana.id, meetupId: first.id, kind: 'grant', amountCents: 1_000 },
    });
    const message = await db.message.create({
      data: { meetupId: first.id, senderId: ana.id, body: 'Fixture message' },
      select: { id: true },
    });
    const dispute = await db.dispute.create({
      data: {
        meetupId: first.id,
        filedById: ana.id,
        kind: 'other',
        reason: 'Fixture dispute',
        status: 'resolved',
        outcome: 'settle_by_checkins',
        openedAt: startedAt,
        deadlineAt: new Date(startedAt.getTime() + 5 * DAY_MS),
        resolvedAt: startedAt,
      },
      select: { id: true },
    });
    const report = await db.report.create({
      data: {
        reporterId: ana.id,
        reportedId: bea.id,
        reason: 'Fixture report',
        meetupId: first.id,
        createdAt: startedAt,
      },
      select: { id: true },
    });
    await db.paymentOperation.create({
      data: {
        userId: duarte.id,
        kind: 'delete_customer',
        seq: 1,
        stripeCustomerId: 'cus_fixture_erased',
        idempotencyKey: 'fixture-delete-customer',
        status: 'succeeded',
        completedAt: startedAt,
      },
    });
    const oldEvent = await db.stripeEvent.create({
      data: { id: 'evt_fixture_older', type: 'payment_intent.succeeded', receivedAt: startedAt },
      select: { id: true },
    });
    testApp.time.at(new Date(startedAt.getTime() + 2 * DAY_MS));
    const second = await makeMeetup(testApp, {
      status: 'completed',
      initiator: ana,
      recipient: clara,
      venue,
    });
    const newEvent = await db.stripeEvent.create({
      data: {
        id: 'evt_fixture_newer',
        type: 'payment_intent.succeeded',
        receivedAt: testApp.time.now(),
      },
      select: { id: true },
    });
    testApp.time.at(new Date(startedAt.getTime() + (env.FINANCIAL_RETENTION_DAYS + 1) * DAY_MS));
    await db.session.updateMany({
      where: { userId: { in: [ana.id, clara.id] } },
      data: { expiresAt: daysFromNow(1) },
    });
    const reputation = async (user: UserFixture) => {
      const answer = await callRoute(testApp.app, {
        method: 'GET',
        url: '/v1/me',
        as: await testApp.tokenFor(user),
      });
      expect(answer.status).toBe(200);
      return MeDto.parse(answer.json()).reputation;
    };
    const countersBefore = { ana: await reputation(ana), clara: await reputation(clara) };
    const counts = await runDailyExpiry(ctx);
    expect(counts).toMatchObject({
      meetupsPurged: 2,
      depositsPurged: 4,
      depositOperationsPurged: 8,
      settlementsPurged: 2,
      creditEntriesPurged: 1,
      checkInsPurged: 2,
      messagesPurged: 1,
      disputesPurged: 1,
      witnessEventsUnlinked: 2,
      reportsUnlinked: 1,
      customerOperationsPurged: 1,
      stripeEventsPurged: 1,
      tombstoneWitnessEventsPurged: 1,
      pairHistoryRowsPurged: 1,
      tombstonesPurged: 1,
    });
    expect(await db.meetup.findUnique({ where: { id: first.id } })).toBeNull();
    expect(await db.meetup.findUnique({ where: { id: unattended.id } })).toBeNull();
    expect(await db.deposit.count({ where: { meetupId: first.id } })).toBe(0);
    expect(await db.deposit.count({ where: { meetupId: unattended.id } })).toBe(0);
    expect(await db.tableCreditEntry.count({ where: { meetupId: first.id } })).toBe(0);
    expect(await db.checkIn.count({ where: { meetupId: first.id } })).toBe(0);
    expect(await db.message.findUnique({ where: { id: message.id } })).toBeNull();
    expect(await db.dispute.findUnique({ where: { id: dispute.id } })).toBeNull();
    expect(await db.meetup.findUnique({ where: { id: second.id } })).not.toBeNull();
    expect(await db.deposit.count({ where: { meetupId: second.id } })).toBe(2);
    expect(await db.meetupSettlement.count({ where: { meetupId: second.id } })).toBe(1);
    expect(await db.checkIn.count({ where: { meetupId: second.id } })).toBe(2);
    expect(await db.witnessEvent.count({ where: { meetupId: second.id } })).toBe(2);
    expect(await db.stripeEvent.findUnique({ where: { id: oldEvent.id } })).toBeNull();
    expect(await db.stripeEvent.findUnique({ where: { id: newEvent.id } })).not.toBeNull();
    const kept = await db.witnessEvent.findFirstOrThrow({
      where: { userId: ana.id, counterpartId: bea.id },
    });
    expect(kept.meetupId).toBeNull();
    expect(kept.countsForReputation).toBe(true);
    expect(await db.witnessEvent.count({ where: { userId: ana.id } })).toBe(2);
    expect(await db.witnessEvent.count({ where: { userId: bea.id } })).toBe(0);
    expect(await db.report.findUniqueOrThrow({ where: { id: report.id } })).toMatchObject({
      meetupId: null,
      reason: 'Fixture report',
    });
    expect(await db.user.findUnique({ where: { id: bea.id } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: duarte.id } })).toBeNull();
    const state = async () => ({
      meetups: await db.meetup.count(),
      deposits: await db.deposit.count(),
      operations: await db.paymentOperation.count(),
      settlements: await db.meetupSettlement.count(),
      checkIns: await db.checkIn.count(),
      credits: await db.tableCreditEntry.count(),
      witnessEvents: await db.witnessEvent.count(),
      pairHistory: await db.pairHistory.count(),
      stripeEvents: await db.stripeEvent.count(),
      users: await db.user.count(),
      ana: await reputation(ana),
      clara: await reputation(clara),
    });
    const settled = await state();
    expect(settled.ana).toEqual(countersBefore.ana);
    expect(settled.clara).toEqual(countersBefore.clara);
    expect(settled.ana).toMatchObject({
      witnessedMeetups: 2,
      distinctCounterparts: 2,
      distinctVenues: 1,
      distinctCities: 1,
      noShows90d: 0,
    });
    const again = residual(await runDailyExpiry(ctx));
    expect(again, 'a second pass of the daily step still changed rows').toEqual([]);
    expect(await state(), 'a second pass of the daily step changed rows').toEqual(settled);
  });
});
