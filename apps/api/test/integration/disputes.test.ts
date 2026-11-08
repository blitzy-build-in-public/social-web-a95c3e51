/**
 * Dispute filing, escalation and resolution: `POST /meetups/:id/dispute`, the
 * `dispute-escalate-<disputeId>` timer, and the operator resolutions that end the meetup an open
 * dispute was holding (AAP 0.5.3, 0.5.4, 0.12.2).
 *
 * Four properties, one describe each:
 *
 *  - **The filing guards**, in the order AAP 0.5.4 lists them: `403 not_participant`, the
 *    `409 dispute_window_closed` boundary at `startsAt + 24 h` (a `201` at that instant, the
 *    refusal a second later), `409 not_locked` for a `proposed` meetup, `409 dispute_open` for a
 *    second filing, and the `400 invalid_field` bodies `DisputeRequest` refuses.
 *  - **The deadline and the escalation**: `deadlineAt = openedAt + 5 days`, the escalation job
 *    armed for `deadlineAt - 24 h`, and the pass that flags the dispute for `/ops` once that instant
 *    arrives (AAP 0.12.2 "Operator MUST resolve a dispute within 5 days").
 *  - **Check-in and settlement**: both attendees still check in while the dispute is open, the
 *    settlement instant passes with no `MeetupSettlement` and no money decided, and the operator's
 *    `settle_by_checkins` then applies the outcome the recorded check-ins give — after the window,
 *    or before it with a check-in made in between counting when the window closes.
 *  - **The money**: a `venue_unavailable` dispute resolved `no_fault` releases both holds with no
 *    forfeit and no credit; a hold lost while a dispute is open ends the meetup `lock_lost` and
 *    closes the dispute with the note `hold_expired`; and a post-settlement `no_fault` on a forfeit
 *    reverses the capture, voids the attendee's credit and removes the no-show.
 *
 * Time comes from the injected clock — `t.time` for the jumps, `settleNow` for one settlement pass
 * — and every title carries `stripeModeLabel()`, so a run's output names its Stripe topology
 * (AAP 0.11.2, 0.12.1). The one case that needs an authorization it can expire runs behind
 * `it.runIf(MOCK)`, because only the stateful proxy expires one. Nothing here imports the `stripe`
 * SDK.
 *
 * @see AAP 0.5.3 for the dispute lifecycle and the transitions a resolution applies, 0.5.4 for the
 *   three routes and the order of their errors, 0.5.2 for the rows they write, 0.3.2 for the
 *   settlement recovery, 0.11.2 for the harness, and 0.8.1 for this file's place in the inventory.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { JOB, QUEUE, disputeEscalateJobId } from '@tablemate/server-core';
import {
  AdminDisputesResponse,
  DAY_MS,
  DEFAULT_DEPOSIT_CENTS,
  DISPUTE_ESCALATE_BEFORE_HOURS,
  DISPUTE_RESOLUTION_DAYS,
  DisputeResponse,
  HOUR_MS,
  MeDto,
  MINUTE_MS,
  NotificationKind,
  REASON_MAX_CHARS,
  type DepositStatus,
  type MeetupStatus,
  type ParticipantRole,
  type SettlementOutcome,
} from '@tablemate/shared';

import { createTestApp, type TestApp } from '../support/app.ts';
import { settleNow } from '../support/clock.ts';
import {
  callRoute,
  checkIn,
  expectError,
  makeMeetup,
  makeUser,
  makeVenue,
  proposeAndLock,
  rows,
  stripeModeLabel,
  type ActorRef,
  type RouteResponse,
  type UserFixture,
  type VenueFixture,
} from '../support/factories.ts';
import {
  deliverStripeEvents,
  type ProxyControl,
  type StripeEvent,
} from '../support/stripe-proxy/state.ts';

/* Constants (AAP 0.5.3, 0.11.2) */

/** The launch city every fixture venue here stands in, from `config/cities.json` (AAP 0.5.2). */
const CITY = 'lisbon';

/** The tag every title carries, so a run's output names the Stripe topology it ran in (AAP 0.12.1). */
const MODE = stripeModeLabel();

/** Whether this run holds the stateful proxy: the only topology with an expirable hold. */
const MOCK = inject('stripeMode') === 'mock';

/** The step between an instant a rule accepts and the refusal immediately after it. */
const STEP_MS = 1_000;

/**
 * The step between two reads of a state the provider decides: a webhook runs the payment operations
 * its decision planned after it has committed, without holding up its answer (`payments/webhook.ts`).
 */
const POLL_MS = 50;

/** Both sides of a meetup, in one list, wherever a case has to touch each deposit it carries. */
const SIDES: readonly ParticipantRole[] = ['initiator', 'recipient'];

/* The harness (AAP 0.11.2) */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

// One database, one Redis and one Stripe topology are shared by the run, so each case starts from the
// state a fresh database would have (AAP 0.11.2). Background work stays off: `settleNow` is the only
// thing that settles, which is what makes each case's own clock jump the decisive one.
beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
});

afterAll(async () => {
  await t.close();
});

/* Fixtures (AAP 0.5.2, 0.5.3) */

/** A pair committed to a meetup at a fixture venue, with the clock standing at its start. */
interface LockedPair {
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
  readonly venue: VenueFixture;
  readonly meetupId: string;
  readonly startsAt: Date;
}

/** Lock a meetup through the real routes, with two real holds, and stand the clock on its start. */
async function lockedPair(): Promise<LockedPair> {
  const venue = await makeVenue(t, { cityId: CITY });
  const initiator = await makeUser(t, { card: 'visa' });
  const recipient = await makeUser(t, { card: 'visa' });
  const { meetupId, startsAt } = await proposeAndLock(t, { initiator, recipient, venue });
  t.time.toMeetupPoint({ startsAt }, 'startsAt');

  return { initiator, recipient, venue, meetupId, startsAt };
}

/** The console secret a fixture venue was issued; a null one would fail the route, not the case. */
function venueSecretOf(venue: VenueFixture): string {
  if (venue.secret === null) {
    throw new Error('the fixture venue was issued no console secret');
  }
  return venue.secret;
}

/** Check one attendee in at the venue's own code, 20 m from the venue (AAP 0.5.7). */
async function checkInAs(actor: ActorRef, pair: LockedPair): Promise<void> {
  const response = await checkIn(
    t,
    actor,
    { id: pair.meetupId, venueId: pair.venue.id },
    { venueSecret: venueSecretOf(pair.venue) },
  );
  expect(response.status).toBe('locked');
}

/* The routes (AAP 0.5.4) */

/** `POST /meetups/:id/dispute` as `actor`, with the body given. */
async function fileAs(
  actor: ActorRef,
  meetupId: string,
  body: Record<string, unknown> = { reason: 'The venue could not witness our check-in.' },
): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: `/v1/meetups/${meetupId}/dispute`,
    as: await t.tokenFor(actor),
    body,
  });
}

/** `POST /meetups/:id/cancel` as `actor`; a `locked` meetup's cancellation rules are measured in time. */
async function cancelAs(actor: ActorRef, meetupId: string): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: `/v1/meetups/${meetupId}/cancel`,
    as: await t.tokenFor(actor),
  });
}

/** An operator account: the role the `/admin` routes accept (AAP 0.3.3). */
function operator(): Promise<UserFixture> {
  return makeUser(t, { role: 'operator' });
}

/** `POST /admin/disputes/:id/resolve` as `op`, with the outcome given. */
async function resolveAs(op: ActorRef, disputeId: string, outcome: string): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: `/v1/admin/disputes/${disputeId}/resolve`,
    as: await t.tokenFor(op),
    body: { outcome },
  });
}

/** `GET /admin/disputes` as `op`, parsed: the queue an operator works from (AAP 0.5.4). */
async function adminDisputes(op: ActorRef): Promise<AdminDisputesResponse> {
  const response = await callRoute(t.app, {
    method: 'GET',
    url: '/v1/admin/disputes',
    as: await t.tokenFor(op),
  });
  expect(response.status).toBe(200);
  return AdminDisputesResponse.parse(response.json());
}

/** The proxy's control client; only a `mock` run has one, which is why the callers guard first. */
function proxy(): ProxyControl {
  const control = t.stripe.proxy;
  if (control === null) {
    throw new Error('this case needs the stateful proxy: STRIPE_MODE=mock');
  }
  return control;
}

/* Reads (AAP 0.5.2) */

/** Wait until `check` answers true, or fail after a bounded number of polls. */
async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
  throw new Error(`${what} did not happen within ${(200 * POLL_MS) / 1_000} seconds`);
}

/** A meetup's stored lifecycle columns. */
function meetupRow(meetupId: string) {
  return t.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { status: true, cancelReason: true, forfeitReason: true, finalAt: true },
  });
}

/** A dispute's stored columns, the escalation flag and the automatic resolution's note included. */
function disputeRow(disputeId: string) {
  return t.services.db.dispute.findUniqueOrThrow({
    where: { id: disputeId },
    select: {
      status: true,
      kind: true,
      outcome: true,
      resolutionNote: true,
      openedAt: true,
      deadlineAt: true,
      escalatedAt: true,
      resolvedAt: true,
    },
  });
}

/** One side's deposit, requiring the PaymentIntent id its current attempt carries. */
interface DepositRow {
  readonly id: string;
  readonly status: DepositStatus;
  readonly paymentIntentId: string;
}

async function depositOf(meetupId: string, role: ParticipantRole): Promise<DepositRow> {
  const deposit = await t.services.db.deposit.findFirst({
    where: { meetupId, role },
    select: { id: true, status: true, currentPaymentIntentId: true },
  });
  if (deposit === null || deposit.currentPaymentIntentId === null) {
    throw new Error(`no ${role} deposit with a live attempt on meetup ${meetupId}`);
  }
  return {
    id: deposit.id,
    status: deposit.status,
    paymentIntentId: deposit.currentPaymentIntentId,
  };
}

/** One deposit's operations of a kind, oldest first (AAP 0.3.2). */
function operationsOf(depositId: string, kind: 'hold' | 'release' | 'capture' | 'refund') {
  return t.services.db.paymentOperation.findMany({
    where: { depositId, kind },
    orderBy: { seq: 'asc' },
    select: { id: true, status: true, dependsOnId: true },
  });
}

/** A meetup's settlement row, or null while no outcome has been applied (AAP 0.5.3). */
function settlementOf(meetupId: string) {
  return t.services.db.meetupSettlement.findUnique({
    where: { meetupId },
    select: { outcome: true, status: true, initiatorPresent: true, recipientPresent: true },
  });
}

/** A meetup's Table Credit entries, a reversal's `void` as well as the `grant` (AAP 0.5.7). */
function creditEntries(meetupId: string) {
  return t.services.db.tableCreditEntry.findMany({
    where: { meetupId },
    orderBy: { kind: 'asc' },
    select: { userId: true, kind: true, amountCents: true },
  });
}

/** One actor's own reputation counters, read through `GET /me` (AAP 0.5.7). */
async function reputationOf(actor: ActorRef) {
  const response = await callRoute(t.app, {
    method: 'GET',
    url: '/v1/me',
    as: await t.tokenFor(actor),
  });
  expect(response.status).toBe(200);
  return MeDto.parse(response.json()).reputation;
}

/** One notification request as the outbox holds it: a kind and its recipient, never personal data. */
function notificationOf(payload: unknown): { kind: string; userId: string } {
  const record =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  return {
    kind: typeof record['kind'] === 'string' ? record['kind'] : 'unknown',
    userId: typeof record['userId'] === 'string' ? record['userId'] : 'unknown',
  };
}

/** The notification requests the domain transactions wrote, by recipient (AAP 0.3.2). */
async function notifications(): Promise<
  readonly { readonly kind: string; readonly userId: string }[]
> {
  const messages = await t.services.db.outboxMessage.findMany({
    where: { kind: 'notification' },
    select: { payload: true },
  });
  return messages
    .map((message) => notificationOf(message.payload))
    .sort((left, right) => left.userId.localeCompare(right.userId));
}

/** The PaymentIntent an event's object names: the intent itself, or the charge that belongs to it. */
function intentIdOf(object: unknown): string | null {
  const record =
    typeof object === 'object' && object !== null ? (object as Record<string, unknown>) : {};
  if (typeof record['payment_intent'] === 'string') {
    return record['payment_intent'];
  }
  const id = record['id'];
  return typeof id === 'string' && id.startsWith('pi_') ? id : null;
}

/** The events of one type the proxy recorded for `intentId`, in the order it recorded them. */
function eventsFor(
  events: readonly StripeEvent[],
  type: string,
  intentId: string,
): readonly StripeEvent[] {
  return events.filter(
    (event) => event.type === type && intentIdOf(event.data.object) === intentId,
  );
}

/* Phase 1 — the filing guards (AAP 0.5.4) */

/** One `DisputeRequest` body the route must refuse, and why. */
interface BadBody {
  readonly name: string;
  readonly body: Record<string, unknown>;
}

const BAD_BODIES: readonly BadBody[] = [
  { name: 'an empty reason', body: { reason: '' } },
  { name: 'a reason that is only whitespace', body: { reason: '   ' } },
  {
    name: `a reason past the ${REASON_MAX_CHARS}-character cap`,
    body: { reason: 'x'.repeat(REASON_MAX_CHARS + 1) },
  },
  {
    name: 'a kind outside the two the contract names',
    body: { reason: 'A fixture complaint.', kind: 'refund' },
  },
];

/** The filing window's own boundary: still open at the instant, closed one second later. */
interface WindowCase {
  readonly name: string;
  readonly offsetMs: number;
  readonly accepted: boolean;
}

const WINDOW: readonly WindowCase[] = [
  { name: 'files at the instant the window closes', offsetMs: 0, accepted: true },
  { name: 'refuses one second past it', offsetMs: STEP_MS, accepted: false },
];

describe(`${MODE} POST /v1/meetups/:id/dispute`, () => {
  it('refuses an account outside the meetup with 403 not_participant', async () => {
    const pair = await lockedPair();
    const stranger = await makeUser(t, { card: 'visa' });

    expectError(await fileAs(stranger, pair.meetupId), 403, 'not_participant');
    expect(await t.services.db.dispute.count()).toBe(0);
  });

  it('refuses a meetup that has not been locked with 409 not_locked', async () => {
    const venue = await makeVenue(t, { cityId: CITY });
    const initiator = await makeUser(t, { card: 'visa' });
    const recipient = await makeUser(t, { card: 'visa' });
    // The proposal is visible — the initiator's hold is held — and there is nothing to dispute yet.
    const meetup = await makeMeetup(t, { status: 'proposed', initiator, recipient, venue });

    expectError(await fileAs(recipient, meetup.id), 409, 'not_locked');
    expect(await t.services.db.dispute.count()).toBe(0);
  });

  it('refuses a second filing while one is open with 409 dispute_open', async () => {
    const pair = await lockedPair();
    expect((await fileAs(pair.initiator, pair.meetupId)).status).toBe(201);

    // The other side of the same meetup: one open dispute per meetup is what the partial index says.
    expectError(await fileAs(pair.recipient, pair.meetupId), 409, 'dispute_open');
    expect(await t.services.db.dispute.count({ where: { status: 'open' } })).toBe(1);
  });

  it.each(rows(WINDOW))(`${MODE} $name at startsAt + 24 h`, async (entry) => {
    const pair = await lockedPair();
    t.time.toMeetupPoint({ startsAt: pair.startsAt }, 'startsAt+24h', entry.offsetMs);

    const filed = await fileAs(pair.initiator, pair.meetupId);

    if (entry.accepted) {
      expect(filed.status).toBe(201);
      expect(DisputeResponse.parse(filed.json()).disputeId).toBeDefined();
    } else {
      expectError(filed, 409, 'dispute_window_closed');
      expect(await t.services.db.dispute.count()).toBe(0);
    }
  });

  it.each(rows(BAD_BODIES))(`${MODE} refuses $name with 400 invalid_field`, async (entry) => {
    const pair = await lockedPair();

    expectError(await fileAs(pair.initiator, pair.meetupId, entry.body), 400, 'invalid_field');
    expect(await t.services.db.dispute.count()).toBe(0);
  });

  it('records the filing, notifies the counterpart and leaves the meetup locked', async () => {
    const pair = await lockedPair();
    const filed = await fileAs(pair.recipient, pair.meetupId);
    expect(filed.status).toBe(201);

    const dispute = await disputeRow(DisputeResponse.parse(filed.json()).disputeId);
    expect(dispute.status).toBe('open');
    expect(dispute.kind).toBe('other');
    expect(dispute.resolutionNote).toBeNull();
    expect(dispute.resolvedAt).toBeNull();

    // Filing commits no meetup change: the pair can still be witnessed while it gates (AAP 0.5.3).
    expect((await meetupRow(pair.meetupId)).status).toBe('locked');
    // The pair's earlier notifications stand; the filing added exactly one, for the counterpart.
    const filing = (await notifications()).filter(
      (entry) => entry.kind === NotificationKind.enum.dispute_opened,
    );
    expect(filing).toEqual([
      { kind: NotificationKind.enum.dispute_opened, userId: pair.initiator.id },
    ]);
    expect(await t.services.db.analyticsEvent.count({ where: { name: 'dispute_opened' } })).toBe(1);
  });
});

/* Phase 2 — the deadline and the escalation (AAP 0.5.3, 0.12.2) */

/** Whether the operator queue reports one dispute as overdue (AAP 0.5.4, 0.12.2). */
async function overdueFlag(op: ActorRef, disputeId: string): Promise<boolean> {
  const queue = await adminDisputes(op);
  const item = queue.items.find((entry) => entry.id === disputeId);
  expect(item).toBeDefined();
  return item?.overdue ?? false;
}

describe(`${MODE} dispute deadline and escalation`, () => {
  it('sets deadlineAt five days after the filing and arms the escalation a day before it', async () => {
    const pair = await lockedPair();
    const filed = await fileAs(pair.initiator, pair.meetupId);
    expect(filed.status).toBe(201);
    const disputeId = DisputeResponse.parse(filed.json()).disputeId;

    const { openedAt, deadlineAt } = await disputeRow(disputeId);
    expect(deadlineAt.getTime() - openedAt.getTime()).toBe(DISPUTE_RESOLUTION_DAYS * DAY_MS);

    // The timer is the latency optimisation; the sweeper's escalation step is the backstop, and
    // both are measured from the same instant (AAP 0.5.3, 0.12.2).
    const queue = t.services.queues.get(QUEUE.settlement);
    const job = await queue.getJob(disputeEscalateJobId(disputeId));
    expect(job?.name).toBe(JOB.settlement.disputeEscalate);
    expect(job?.opts.delay).toBe(
      DISPUTE_RESOLUTION_DAYS * DAY_MS - DISPUTE_ESCALATE_BEFORE_HOURS * HOUR_MS,
    );
  });

  it('flags the dispute for the operator queue once the escalation instant passes', async () => {
    const pair = await lockedPair();
    const op = await operator();
    const filed = await fileAs(pair.initiator, pair.meetupId);
    const disputeId = DisputeResponse.parse(filed.json()).disputeId;
    const { deadlineAt } = await disputeRow(disputeId);

    // A day before the deadline the dispute is not overdue, and the queue says so.
    expect(await overdueFlag(op, disputeId)).toBe(false);

    t.time.at(new Date(deadlineAt.getTime() - DISPUTE_ESCALATE_BEFORE_HOURS * HOUR_MS + STEP_MS));
    const pass = await settleNow(t.services);

    expect(pass.sweep.escalated).toBe(1);
    expect((await disputeRow(disputeId)).escalatedAt).not.toBeNull();
    // The meetup is untouched by the pass: an open dispute postpones it (AAP 0.5.3).
    expect((await meetupRow(pair.meetupId)).status).toBe('locked');
    expect(await overdueFlag(op, disputeId)).toBe(true);
  });
});

/* Phase 3 — check-in and settlement while a dispute is open (AAP 0.5.3, 0.5.7) */

/** Who was witnessed, and the outcome the settlement applies from those check-ins. */
interface PresenceCase {
  readonly name: string;
  readonly present: readonly ParticipantRole[];
  readonly status: MeetupStatus;
  readonly outcome: SettlementOutcome;
}

const PRESENCE: readonly PresenceCase[] = [
  {
    name: 'both attendees',
    present: ['initiator', 'recipient'],
    status: 'completed',
    outcome: 'completed',
  },
  { name: 'the initiator alone', present: ['initiator'], status: 'forfeited', outcome: 'no_show' },
  { name: 'neither attendee', present: [], status: 'unattended', outcome: 'unattended' },
];

describe(`${MODE} settlement while a dispute is open`, () => {
  it('accepts a check-in from both attendees while the dispute is open', async () => {
    const pair = await lockedPair();
    expect((await fileAs(pair.initiator, pair.meetupId)).status).toBe(201);

    const witnessed = (actor: ActorRef) =>
      checkIn(
        t,
        actor,
        { id: pair.meetupId, venueId: pair.venue.id },
        { venueSecret: venueSecretOf(pair.venue) },
      );
    const first = await witnessed(pair.initiator);
    const second = await witnessed(pair.recipient);

    expect(first.bothCheckedIn).toBe(false);
    expect(second.bothCheckedIn).toBe(true);
    // The dispute is still open and nothing was decided: a check-in settles nothing on its own.
    expect((await meetupRow(pair.meetupId)).status).toBe('locked');
    expect(await settlementOf(pair.meetupId)).toBeNull();
  });

  it('postpones the settlement due at startsAt + 45 min while the dispute is open', async () => {
    const pair = await lockedPair();
    expect((await fileAs(pair.initiator, pair.meetupId)).status).toBe(201);
    t.time.toMeetupPoint({ startsAt: pair.startsAt }, 'startsAt+45m');

    await settleNow(t.services);

    expect((await meetupRow(pair.meetupId)).status).toBe('locked');
    expect(await settlementOf(pair.meetupId)).toBeNull();
    expect(await creditEntries(pair.meetupId)).toHaveLength(0);
    for (const role of SIDES) {
      const deposit = await depositOf(pair.meetupId, role);
      expect(await operationsOf(deposit.id, 'capture')).toHaveLength(0);
      expect(await operationsOf(deposit.id, 'release')).toHaveLength(0);
    }
  });

  it.each(rows(PRESENCE))(
    `${MODE} settle_by_checkins after the window with $name witnessed`,
    async (entry) => {
      const pair = await lockedPair();
      const op = await operator();
      const filed = await fileAs(pair.initiator, pair.meetupId);
      const disputeId = DisputeResponse.parse(filed.json()).disputeId;

      for (const role of entry.present) {
        await checkInAs(role === 'initiator' ? pair.initiator : pair.recipient, pair);
      }
      t.time.toMeetupPoint({ startsAt: pair.startsAt }, 'startsAt+45m');
      await settleNow(t.services);

      expect((await resolveAs(op, disputeId, 'settle_by_checkins')).status).toBe(200);

      expect((await meetupRow(pair.meetupId)).status).toBe(entry.status);
      expect(await settlementOf(pair.meetupId)).toMatchObject({
        outcome: entry.outcome,
        status: 'complete',
      });
      const dispute = await disputeRow(disputeId);
      expect(dispute.status).toBe('resolved');
      expect(dispute.outcome).toBe('settle_by_checkins');
      expect(dispute.resolvedAt).not.toBeNull();
    },
  );

  it('applies no outcome for a settle_by_checkins resolution before the window closes', async () => {
    const pair = await lockedPair();
    const op = await operator();
    const filed = await fileAs(pair.initiator, pair.meetupId);
    const disputeId = DisputeResponse.parse(filed.json()).disputeId;

    // Ten minutes past the start, with only the initiator witnessed: the resolution closes the
    // dispute and leaves check-in open, so the outcome waits for the settlement instant.
    await checkInAs(pair.initiator, pair);
    t.time.advance(10 * MINUTE_MS);
    expect((await resolveAs(op, disputeId, 'settle_by_checkins')).status).toBe(200);
    expect((await disputeRow(disputeId)).status).toBe('resolved');
    expect((await meetupRow(pair.meetupId)).status).toBe('locked');
    expect(await settlementOf(pair.meetupId)).toBeNull();

    // The check-in made in between counts when the window closes (AAP 0.5.3).
    t.time.advance(20 * MINUTE_MS);
    await checkInAs(pair.recipient, pair);
    t.time.toMeetupPoint({ startsAt: pair.startsAt }, 'startsAt+45m');
    await settleNow(t.services);

    expect((await meetupRow(pair.meetupId)).status).toBe('completed');
    expect(await settlementOf(pair.meetupId)).toMatchObject({
      outcome: 'completed',
      status: 'complete',
    });
  });

  it('releases both holds without a forfeit for a venue_unavailable dispute resolved no_fault', async () => {
    const pair = await lockedPair();
    const op = await operator();
    const filed = await fileAs(pair.initiator, pair.meetupId, {
      reason: 'The venue cancelled our booking and could not witness us.',
      kind: 'venue_unavailable',
    });
    expect(filed.status).toBe(201);
    const disputeId = DisputeResponse.parse(filed.json()).disputeId;
    expect((await disputeRow(disputeId)).kind).toBe('venue_unavailable');

    expect((await resolveAs(op, disputeId, 'no_fault')).status).toBe(200);
    await settleNow(t.services);

    expect((await meetupRow(pair.meetupId)).status).toBe('no_fault');
    for (const role of SIDES) {
      const deposit = await depositOf(pair.meetupId, role);
      expect((await operationsOf(deposit.id, 'release')).map((entry) => entry.status)).toEqual([
        'succeeded',
      ]);
      expect(await operationsOf(deposit.id, 'capture')).toHaveLength(0);
      await eventually(
        async () => (await depositOf(pair.meetupId, role)).status === 'released',
        `the ${role} hold to be released`,
      );
    }
    // No forfeit, no credit, no outcome and no reputation change (AAP 0.5.3).
    expect(await creditEntries(pair.meetupId)).toHaveLength(0);
    expect(await settlementOf(pair.meetupId)).toBeNull();
    expect((await reputationOf(pair.initiator)).noShows90d).toBe(0);
    expect((await reputationOf(pair.recipient)).noShows90d).toBe(0);

    if (MOCK) {
      // Both authorizations are cancelled at the provider, by our own release (AAP 0.3.2, 0.3.3).
      expect((await proxy().paymentIntents({ status: 'canceled' })).length).toBeGreaterThanOrEqual(
        2,
      );
    }
  });
});

/* Phase 4 — the money a resolution moves (AAP 0.3.2, 0.5.3) */

describe(`${MODE} dispute money`, () => {
  it.runIf(MOCK)(
    'ends the meetup lock_lost when a hold expires while the dispute is open',
    async () => {
      const pair = await lockedPair();
      const filed = await fileAs(pair.initiator, pair.meetupId);
      const disputeId = DisputeResponse.parse(filed.json()).disputeId;
      const held = await depositOf(pair.meetupId, 'initiator');

      // Stripe takes the initiator's authorization away, and reports the loss with its own events.
      await proxy().expireHold(held.paymentIntentId);
      const expired = eventsFor(await proxy().events(), 'charge.expired', held.paymentIntentId);
      expect(expired).toHaveLength(1);

      const delivered = await deliverStripeEvents(t.app, expired, t.stripe.webhookSecret);
      expect(delivered.map((response) => response.statusCode)).toEqual([200]);
      await settleNow(t.services);

      // A lost hold is not a forfeit: the meetup ends `lock_lost`, the surviving hold is released and
      // the open dispute is closed with the note the automatic resolution writes (AAP 0.3.2, 0.5.3).
      expect((await meetupRow(pair.meetupId)).status).toBe('lock_lost');
      expect((await depositOf(pair.meetupId, 'initiator')).status).toBe('expired');
      const survivor = await depositOf(pair.meetupId, 'recipient');
      expect(await operationsOf(survivor.id, 'release')).toHaveLength(1);
      await eventually(
        async () => (await depositOf(pair.meetupId, 'recipient')).status === 'released',
        'the surviving hold to be released',
      );
      expect(await settlementOf(pair.meetupId)).toBeNull();
      expect(await creditEntries(pair.meetupId)).toHaveLength(0);
      expect(await disputeRow(disputeId)).toMatchObject({
        status: 'resolved',
        outcome: 'no_fault',
        resolutionNote: 'hold_expired',
      });
      expect((await reputationOf(pair.recipient)).noShows90d).toBe(0);
    },
  );

  it('reverses a forfeit when a post-settlement dispute is resolved no_fault', async () => {
    const pair = await lockedPair();
    const op = await operator();

    // Only the initiator is witnessed, so the settlement forfeits the recipient's hold (AAP 0.5.7).
    await checkInAs(pair.initiator, pair);
    t.time.toMeetupPoint({ startsAt: pair.startsAt }, 'startsAt+45m');
    await settleNow(t.services);
    expect((await meetupRow(pair.meetupId)).status).toBe('forfeited');

    const absent = await depositOf(pair.meetupId, 'recipient');
    expect(absent.status).toBe('captured');
    expect(await creditEntries(pair.meetupId)).toEqual([
      { userId: pair.initiator.id, kind: 'grant', amountCents: DEFAULT_DEPOSIT_CENTS },
    ]);
    expect((await reputationOf(pair.recipient)).noShows90d).toBe(1);

    // The absent party's dispute, filed inside the 24-hour window, is what the operator resolves.
    const filed = await fileAs(pair.recipient, pair.meetupId, {
      reason: 'I was at the venue; the code did not work for me.',
    });
    expect(filed.status).toBe(201);
    const disputeId = DisputeResponse.parse(filed.json()).disputeId;
    expect((await resolveAs(op, disputeId, 'no_fault')).status).toBe(200);
    await settleNow(t.services);

    // The capture is reversed by a refund that depends on it, the credit is voided and the no-show
    // is removed (AAP 0.5.3).
    const capture = await operationsOf(absent.id, 'capture');
    const refund = await operationsOf(absent.id, 'refund');
    expect(capture.map((entry) => entry.status)).toEqual(['succeeded']);
    expect(refund.map((entry) => entry.status)).toEqual(['succeeded']);
    expect(refund[0]?.dependsOnId).toBe(capture[0]?.id);

    expect((await meetupRow(pair.meetupId)).status).toBe('no_fault');
    await eventually(
      async () => (await depositOf(pair.meetupId, 'recipient')).status === 'refunded',
      'the captured hold to be refunded',
    );
    // The grant stays as history and the void supersedes it; the balance is grants minus voids.
    expect(await creditEntries(pair.meetupId)).toEqual([
      { userId: pair.initiator.id, kind: 'grant', amountCents: DEFAULT_DEPOSIT_CENTS },
      { userId: pair.initiator.id, kind: 'void', amountCents: DEFAULT_DEPOSIT_CENTS },
    ]);
    expect((await reputationOf(pair.recipient)).noShows90d).toBe(0);

    if (MOCK) {
      // The reversal reached the provider, which reports the refund of the captured charge.
      await eventually(
        async () => (await proxy().events()).some((event) => event.type === 'charge.refunded'),
        'the provider to report the refund',
      );
    }
  });

  it('changes nothing for a post-settlement dispute on a completed meetup and refuses no_fault', async () => {
    const pair = await lockedPair();
    const op = await operator();
    for (const actor of [pair.initiator, pair.recipient]) {
      await checkInAs(actor, pair);
    }
    t.time.toMeetupPoint({ startsAt: pair.startsAt }, 'startsAt+45m');
    await settleNow(t.services);
    expect((await meetupRow(pair.meetupId)).status).toBe('completed');

    const filed = await fileAs(pair.initiator, pair.meetupId, {
      reason: 'Something came up afterwards.',
    });
    expect(filed.status).toBe(201);
    const disputeId = DisputeResponse.parse(filed.json()).disputeId;
    expect((await resolveAs(op, disputeId, 'settle_by_checkins')).status).toBe(200);

    // Nothing changed: the outcome, the money and the deposits all stand (AAP 0.5.3).
    expect((await meetupRow(pair.meetupId)).status).toBe('completed');
    expect(await settlementOf(pair.meetupId)).toMatchObject({ outcome: 'completed' });
    expect(await creditEntries(pair.meetupId)).toHaveLength(0);
    for (const role of SIDES) {
      const deposit = await depositOf(pair.meetupId, role);
      expect(deposit.status).toBe('released');
      expect(await operationsOf(deposit.id, 'capture')).toHaveLength(0);
    }

    // A second dispute on the same settled meetup can only be closed the same way (AAP 0.5.3).
    const second = await fileAs(pair.recipient, pair.meetupId, { reason: 'Still something else.' });
    expect(second.status).toBe(201);
    const secondId = DisputeResponse.parse(second.json()).disputeId;
    expectError(await resolveAs(op, secondId, 'refund'), 422, 'invalid_outcome');
    expectError(await resolveAs(op, secondId, 'no_fault'), 422, 'invalid_outcome');
    expect((await disputeRow(secondId)).status).toBe('open');
  });

  it('refuses a traveler the operator routes with 403 operator_only', async () => {
    const pair = await lockedPair();
    const filed = await fileAs(pair.initiator, pair.meetupId);
    const disputeId = DisputeResponse.parse(filed.json()).disputeId;

    expectError(await resolveAs(pair.recipient, disputeId, 'no_fault'), 403, 'operator_only');
    expect((await disputeRow(disputeId)).status).toBe('open');

    // An operator reaching an id that names no dispute gets the contract's own generic 404.
    expectError(await resolveAs(await operator(), randomUUID(), 'no_fault'), 404, 'not_found');
  });

  it('refuses a participant cancellation while a dispute is open with 409 dispute_open', async () => {
    const pair = await lockedPair();
    expect((await fileAs(pair.initiator, pair.meetupId)).status).toBe(201);

    expectError(await cancelAs(pair.recipient, pair.meetupId), 409, 'dispute_open');
    expect((await meetupRow(pair.meetupId)).status).toBe('locked');
  });
});
