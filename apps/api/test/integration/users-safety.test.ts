import { randomUUID } from 'node:crypto';

import { JOB, QUEUE, remindJobId, settleJobId } from '@tablemate/server-core';
import {
  HOUR_MS,
  MeDto,
  NotificationKind,
  OUR_CANCELLATION_REASON,
  REASON_MAX_CHARS,
} from '@tablemate/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp } from '../support/app.ts';
import { settleNow } from '../support/clock.ts';
import {
  callRoute,
  expectError,
  makeDispute,
  makeMeetup,
  makeUser,
  makeVenue,
  proposeAndLock,
  rows,
  stripeModeLabel,
} from '../support/factories.ts';

import type { TestApp } from '../support/app.ts';
import type { ActorRef, RouteResponse } from '../support/factories.ts';

const CITY = 'lisbon';

interface RefusalCase {
  readonly name: string;
  readonly route: 'block' | 'report';
  readonly target: 'unknown' | 'self' | 'deleted';
}

const REFUSALS: readonly RefusalCase[] = [
  { name: 'block refuses an unknown account', route: 'block', target: 'unknown' },
  { name: 'block refuses the calling account itself', route: 'block', target: 'self' },
  { name: 'block refuses a deleted account', route: 'block', target: 'deleted' },
  { name: 'report refuses an unknown account', route: 'report', target: 'unknown' },
  { name: 'report refuses the calling account itself', route: 'report', target: 'self' },
  { name: 'report refuses a deleted account', route: 'report', target: 'deleted' },
];

interface BadReportBody {
  readonly name: string;
  readonly body: Record<string, unknown>;
}

/** The reason is trimmed and capped at `REASON_MAX_CHARS`, and an unknown key is not ignored. */
const BAD_REPORT_BODIES: readonly BadReportBody[] = [
  { name: 'an empty reason', body: { reason: '' } },
  { name: 'a reason that is only whitespace', body: { reason: '   ' } },
  {
    name: `a reason past the ${REASON_MAX_CHARS}-character cap`,
    body: { reason: 'x'.repeat(REASON_MAX_CHARS + 1) },
  },
  {
    name: 'an unknown key beside the reason',
    body: { reason: 'a fixture complaint', extra: true },
  },
];

interface BlockerCase {
  readonly name: string;
  readonly blocker: 'initiator' | 'recipient';
}

/** Either participant may block, and neither one's block forfeits anything. */
const LATE_WINDOW_BLOCKERS: readonly BlockerCase[] = [
  { name: 'the recipient blocks the initiator', blocker: 'recipient' },
  { name: 'the initiator blocks the recipient', blocker: 'initiator' },
];

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

// One database, one Redis and one Stripe proxy are shared by the run, so each case starts from the
// state a fresh database would have (AAP 0.11.2).
beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
});

async function blockAs(actor: ActorRef, targetId: string): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: `/v1/users/${targetId}/block`,
    as: await t.tokenFor(actor),
  });
}

async function reportAs(
  actor: ActorRef,
  targetId: string,
  body: Record<string, unknown>,
): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: `/v1/users/${targetId}/report`,
    as: await t.tokenFor(actor),
    body,
  });
}

async function profileAs(viewer: ActorRef, targetId: string): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'GET',
    url: `/v1/users/${targetId}`,
    as: await t.tokenFor(viewer),
  });
}

async function reputationOf(actor: ActorRef) {
  const response = await callRoute(t.app, {
    method: 'GET',
    url: '/v1/me',
    as: await t.tokenFor(actor),
  });
  expect(response.status).toBe(200);
  return MeDto.parse(response.json()).reputation;
}

function lifecycleOf(meetupId: string) {
  return t.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { status: true, cancelReason: true, forfeitReason: true, finalAt: true },
  });
}

function depositRows(meetupId: string) {
  return t.services.db.deposit.findMany({
    where: { meetupId },
    select: { id: true, ownerId: true, status: true, currentPaymentIntentId: true },
  });
}

async function expectCancelledWithoutForfeit(meetupId: string): Promise<void> {
  const cancelled = await lifecycleOf(meetupId);
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.cancelReason).toBe('block');
  expect(cancelled.forfeitReason).toBeNull();
  expect(cancelled.finalAt).not.toBeNull();
}

async function expectNoMoneyMoved(meetupId: string) {
  await settleNow(t.services);
  const deposits = await depositRows(meetupId);
  expect(deposits).not.toHaveLength(0);
  expect(deposits.every((deposit) => deposit.status === 'released')).toBe(true);
  const ids = deposits.map((deposit) => deposit.id);
  const [releases, captures] = await Promise.all([
    t.services.db.paymentOperation.findMany({
      where: { depositId: { in: ids }, kind: 'release' },
      select: { status: true },
    }),
    t.services.db.paymentOperation.count({ where: { depositId: { in: ids }, kind: 'capture' } }),
  ]);
  expect(releases).toHaveLength(ids.length);
  expect(releases.every((release) => release.status === 'succeeded')).toBe(true);
  expect(captures).toBe(0);
  expect(await t.services.db.meetupSettlement.count({ where: { meetupId } })).toBe(0);
  expect(await t.services.db.tableCreditEntry.count({ where: { meetupId } })).toBe(0);
  return deposits;
}

/**
 * The provider's own record of the meetup's holds, read in the mock topology alone (AAP 0.3.2).
 *
 * A release of ours is the one cancellation reason that leaves a deposit `released` rather than
 * `expired`, so the reason is asserted with the status (AAP 0.5.3). In `test` mode the provider's
 * objects are the operator's and this reads nothing; the rows above cover the same rule there.
 */
async function expectHoldsCancelledByUs(meetupId: string): Promise<void> {
  const proxy = t.stripe.proxy;
  if (proxy === null) {
    return;
  }
  for (const deposit of await depositRows(meetupId)) {
    const intents = await proxy.paymentIntents({ metadata: { depositId: deposit.id } });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.status).toBe('canceled');
    expect(intents[0]?.cancellation_reason).toBe(OUR_CANCELLATION_REASON);
  }
}

function notificationOf(payload: unknown): { kind: string | null; userId: string | null } {
  if (typeof payload !== 'object' || payload === null) {
    return { kind: null, userId: null };
  }
  const { kind, userId } = payload as { kind?: unknown; userId?: unknown };
  return {
    kind: typeof kind === 'string' ? kind : null,
    userId: typeof userId === 'string' ? userId : null,
  };
}

describe('users-safety: block and report (AAP 0.5.3, 0.5.4, 0.5.7)', () => {
  describe('the two routes', () => {
    it.each(rows(REFUSALS))('$name', async (entry) => {
      const caller = await makeUser(t, { card: 'none' });
      const deleted = await makeUser(t, { deleted: true });
      const targetId =
        entry.target === 'unknown'
          ? randomUUID()
          : entry.target === 'self'
            ? caller.id
            : deleted.id;
      const response =
        entry.route === 'block'
          ? await blockAs(caller, targetId)
          : await reportAs(caller, targetId, { reason: 'Fixture complaint' });
      expectError(response, 404, 'user_not_found');
      expect(await t.services.db.block.count()).toBe(0);
      expect(await t.services.db.report.count()).toBe(0);
    });
    it.each(rows(BAD_REPORT_BODIES))('report refuses $name', async (entry) => {
      const reporter = await makeUser(t, { card: 'none' });
      const reported = await makeUser(t, { card: 'none' });
      expectError(await reportAs(reporter, reported.id, entry.body), 400, 'invalid_field');
      expect(await t.services.db.report.count()).toBe(0);
    });
    it('answers 204 and keeps one Block row for a repeated block', async () => {
      const blocker = await makeUser(t, { card: 'none' });
      const blocked = await makeUser(t, { card: 'none' });
      expect((await blockAs(blocker, blocked.id)).status).toBe(204);
      expect((await blockAs(blocker, blocked.id)).status).toBe(204);
      expect(
        await t.services.db.block.count({
          where: { blockerId: blocker.id, blockedId: blocked.id },
        }),
      ).toBe(1);
    });
    it('serves no profile to either side of a block', async () => {
      const blocker = await makeUser(t, { card: 'none' });
      const blocked = await makeUser(t, { card: 'none' });
      // Tier 0 is what a stranger reads before the block, so the `404` afterwards is the block's.
      expect((await profileAs(blocker, blocked.id)).status).toBe(200);
      expect((await blockAs(blocker, blocked.id)).status).toBe(204);
      expectError(await profileAs(blocker, blocked.id), 404, 'user_not_found');
      expectError(await profileAs(blocked, blocker.id), 404, 'user_not_found');
    });
  });
  describe('a block cancels an open meetup without moving money', () => {
    it(`${stripeModeLabel()} cancels a visible proposal, releases the initiator's hold and notifies both`, async () => {
      const initiator = await makeUser(t, { card: 'visa' });
      const recipient = await makeUser(t, { card: 'visa' });
      const venue = await makeVenue(t, { cityId: CITY });
      const meetup = await makeMeetup(t, { status: 'proposed', initiator, recipient, venue });
      // The recipient blocks the initiator, the side able to see the proposal at all (AAP 0.5.3).
      expect((await blockAs(recipient, initiator.id)).status).toBe(204);
      await expectCancelledWithoutForfeit(meetup.id);
      expect((await expectNoMoneyMoved(meetup.id)).map((deposit) => deposit.ownerId)).toEqual([
        initiator.id,
      ]);
      await expectHoldsCancelledByUs(meetup.id);
      const notifications = await t.services.db.outboxMessage.findMany({
        where: { kind: 'notification' },
        select: { payload: true },
      });
      const notified = notifications.map((row) => notificationOf(row.payload));
      expect(notified.map((entry) => entry.userId).sort()).toEqual(
        [initiator.id, recipient.id].sort(),
      );
      expect(notified.every((entry) => entry.kind === NotificationKind.enum.meetup_cancelled)).toBe(
        true,
      );
    });
    it.each(rows(LATE_WINDOW_BLOCKERS))(
      `${stripeModeLabel()} $name at one hour before the start`,
      async (entry) => {
        const initiator = await makeUser(t, { card: 'visa' });
        const recipient = await makeUser(t, { card: 'visa' });
        const venue = await makeVenue(t, { cityId: CITY });
        const startsAt = new Date(t.services.clock.nowMs() + HOUR_MS);
        const { meetupId } = await proposeAndLock(t, { initiator, recipient, venue, startsAt });
        // The lock scheduled both locked timers, which a cancelled meetup must not keep (AAP 0.5.6).
        const queue = t.services.queues.get(QUEUE.settlement);
        expect((await queue.getJob(settleJobId(meetupId)))?.name).toBe(JOB.settlement.settle);
        expect((await queue.getJob(remindJobId(meetupId)))?.name).toBe(JOB.settlement.remind);
        // The clock stands at `startsAt - 1 h`, where the cancel route would forfeit (AAP 0.5.3).
        expect(startsAt.getTime() - t.time.now().getTime()).toBe(HOUR_MS);
        const blocker = entry.blocker === 'initiator' ? initiator : recipient;
        const blocked = entry.blocker === 'initiator' ? recipient : initiator;
        expect((await blockAs(blocker, blocked.id)).status).toBe(204);
        await expectCancelledWithoutForfeit(meetupId);
        // Safety outranks the money rules: both holds are released, neither captured, and no
        // settlement, credit or no-show is recorded (AAP 0.5.3, 0.5.7, 0.7.3).
        expect(await expectNoMoneyMoved(meetupId)).toHaveLength(2);
        await expectHoldsCancelledByUs(meetupId);
        expect(await queue.getJob(settleJobId(meetupId))).toBeUndefined();
        expect(await queue.getJob(remindJobId(meetupId))).toBeUndefined();
      },
    );
    it('resolves an open dispute no_fault with the note a block earns', async () => {
      const initiator = await makeUser(t, { card: 'visa' });
      const recipient = await makeUser(t, { card: 'visa' });
      const venue = await makeVenue(t, { cityId: CITY });
      const meetup = await makeMeetup(t, { status: 'locked', initiator, recipient, venue });
      const dispute = await makeDispute(t, meetup, initiator, { kind: 'venue_unavailable' });
      expect((await blockAs(recipient, initiator.id)).status).toBe(204);
      const resolved = await t.services.db.dispute.findUniqueOrThrow({
        where: { id: dispute.id },
        select: { status: true, outcome: true, resolutionNote: true, resolvedAt: true },
      });
      expect(resolved.status).toBe('resolved');
      expect(resolved.outcome).toBe('no_fault');
      expect(resolved.resolutionNote).toBe('cancelled_by_block');
      expect(resolved.resolvedAt).not.toBeNull();
      expect((await lifecycleOf(meetup.id)).status).toBe('cancelled');
    });
    it('leaves a settled meetup and its money exactly as they stand', async () => {
      const initiator = await makeUser(t, { card: 'none' });
      const recipient = await makeUser(t, { card: 'none' });
      const venue = await makeVenue(t, { cityId: CITY });
      const meetup = await makeMeetup(t, { status: 'completed', initiator, recipient, venue });
      const before = await lifecycleOf(meetup.id);
      expect(before.status).toBe('completed');
      expect((await blockAs(recipient, initiator.id)).status).toBe(204);
      expect(await lifecycleOf(meetup.id)).toEqual(before);
      expect(
        await t.services.db.meetupSettlement.findUniqueOrThrow({
          where: { meetupId: meetup.id },
          select: { outcome: true, status: true },
        }),
      ).toEqual({ outcome: 'completed', status: 'complete' });
      expect(await t.services.db.tableCreditEntry.count({ where: { meetupId: meetup.id } })).toBe(
        0,
      );
    });
  });
  describe('what a block leaves alone', () => {
    it("changes neither party's reputation counters", async () => {
      const initiator = await makeUser(t, { card: 'none' });
      const recipient = await makeUser(t, { card: 'none' });
      const venue = await makeVenue(t, { cityId: CITY });
      await makeMeetup(t, { status: 'completed', initiator, recipient, venue });
      const before = {
        initiator: await reputationOf(initiator),
        recipient: await reputationOf(recipient),
      };
      // A completed meetup is what the counters count, so this is not a comparison of two zeros.
      expect(before.initiator.witnessedMeetups).toBe(1);
      expect(before.recipient.distinctCounterparts).toBe(1);
      expect((await blockAs(recipient, initiator.id)).status).toBe(204);
      expect(await reputationOf(initiator)).toEqual(before.initiator);
      expect(await reputationOf(recipient)).toEqual(before.recipient);
    });
    it("names the pair's most recent shared meetup on a report, and none when they have none", async () => {
      const initiator = await makeUser(t, { card: 'none' });
      const recipient = await makeUser(t, { card: 'none' });
      const stranger = await makeUser(t, { card: 'none' });
      const venue = await makeVenue(t, { cityId: CITY });
      const meetup = await makeMeetup(t, { status: 'completed', initiator, recipient, venue });
      expect(
        (await reportAs(initiator, recipient.id, { reason: 'Fixture complaint' })).status,
      ).toBe(204);
      expect((await reportAs(initiator, stranger.id, { reason: 'Fixture complaint' })).status).toBe(
        204,
      );
      const pair = await t.services.db.report.findFirstOrThrow({
        where: { reporterId: initiator.id, reportedId: recipient.id },
        select: { reporterId: true, reportedId: true, reason: true, meetupId: true },
      });
      expect(pair).toEqual({
        reporterId: initiator.id,
        reportedId: recipient.id,
        reason: 'Fixture complaint',
        meetupId: meetup.id,
      });
      const unrelated = await t.services.db.report.findFirstOrThrow({
        where: { reporterId: initiator.id, reportedId: stranger.id },
        select: { meetupId: true },
      });
      expect(unrelated.meetupId).toBeNull();
    });
  });
});
