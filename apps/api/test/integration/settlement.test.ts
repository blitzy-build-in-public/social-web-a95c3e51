/**
 * Settlement end to end: criterion 1, criterion 2, the idempotency, the crash case, the races and
 * the hold-loss compensation.
 *
 * The rules the cases turn on: `MeetupSettlement`'s primary key is the idempotency anchor, so a
 * settlement run twice captures once, grants once and credits once; a fault inside the settlement
 * transaction rolls every effect back and the next pass settles it exactly once; a cancel, a block
 * and a hold-loss webhook raised at the sweep's instant each end the meetup once, on the row lock
 * every one of them takes; and a lost hold never forfeits — one the settlement learns about
 * afterwards is compensated, the capture fenced or reversed, the Table Credit voided and the no-show
 * gone.
 *
 * What only the stateful proxy can produce — an expired hold, a delayed capture — runs in `mock`,
 * while every database assertion runs in both topologies. Time comes from the injected clock and
 * tokens are re-signed after each jump, because an access token lives fifteen minutes of that clock.
 */

import {
  DAY_MS,
  DEFAULT_DEPOSIT_CENTS,
  HOUR_MS,
  MeDto,
  MetricsDto,
  OUR_CANCELLATION_REASON,
  ProofAccepted,
} from '@tablemate/shared';
import type {
  DepositStatus,
  MeetupStatus,
  ParticipantRole,
  ProofSubmission,
  UserRole,
} from '@tablemate/shared';
import { addLocalDays, localDateKey, pairKey } from '@tablemate/server-core';
import { readPoints } from '@tablemate/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';

import { cityByCircuitId } from '../../src/modules/proofs/registry.ts';
import { pairOrder } from '../../src/modules/reputation/pair-history.ts';
import { createTestApp } from '../support/app.ts';
import { settleNow } from '../support/clock.ts';
import {
  callRoute,
  checkIn as checkInAtVenue,
  expectError,
  makeClaim,
  makeLodging,
  makeMeetup,
  makeUser,
  makeVenue,
  proposeAndLock,
  rows,
  stripeApi,
  stripeModeLabel,
} from '../support/factories.ts';
import {
  deliverStripeEvents,
  type ProxyControl,
  type WebhookResponse,
} from '../support/stripe-proxy/state.ts';
import {
  fixtureProof,
  fixtureStay,
  instantDuringStay,
  PROOF_TIMEOUT_MS,
} from '../support/proofs.ts';

import type { CityConfig } from '@tablemate/shared';
import type { TestApp } from '../support/app.ts';
import type {
  MeetupFixture,
  RouteResponse,
  UserFixture,
  VenueFixture,
} from '../support/factories.ts';

const MODE = stripeModeLabel();

/** Whether this run holds the stateful proxy: the expiry and delay controls need it (AAP 0.11.2). */
const MOCK = inject('stripeMode') === 'mock';

const PROOF_ROUTE = '/v1/itinerary-proofs';

/** The two statuses AAP 0.5.3 calls final for a deposit, the ones no further pass may move. */
const FINAL_DEPOSIT_STATUSES: readonly DepositStatus[] = [
  'released',
  'captured',
  'refunded',
  'expired',
];

/** The two event types Stripe issues for an authorization it expired (AAP 0.2.4, 0.3.2). */
const HOLD_LOSS_TYPES: ReadonlySet<string> = new Set(['charge.expired', 'payment_intent.canceled']);

const CAPTURE_DELAY_MS = 3_000;

/**
 * The bound one poll of the executor's own progress may run for: 100 waits of 100 ms, and no read of
 * the wall clock anywhere. A poll that exhausts it fails the case rather than hanging the suite.
 */
const POLL_STEPS = 100;
const POLL_INTERVAL_MS = 100;

let t: TestApp;

/** The two fixture proofs, taken once for the file: one proving run reads a multi-gigabyte key. */
let submissions: { readonly valid: ProofSubmission; readonly validSecond: ProofSubmission };

let city: CityConfig;

beforeAll(async () => {
  t = await createTestApp();
  submissions = {
    valid: await fixtureProof('valid'),
    validSecond: await fixtureProof('valid-second'),
  };
  city = proofCity();
}, PROOF_TIMEOUT_MS);

afterAll(async () => {
  if (t !== undefined) {
    await t.close();
  }
});

// One database, one Redis and one Stripe proxy are shared by the run, so each case starts from the
// state a fresh database would have (AAP 0.11.2).
beforeEach(async () => {
  await t.resetState();
});

/**
 * The launch city a fixture proof names, asserting both fixtures prove the same one: a meetup needs a
 * city both sides hold a valid proof for, and the failure names the file to re-run.
 */
function proofCity(): CityConfig {
  const first = fixtureStay(submissions.valid);
  const second = fixtureStay(submissions.validSecond);
  expect(
    second.circuitCityId,
    'valid.eml and valid-second.eml must prove one city; re-run packages/circuits/scripts/make-test-fixtures.ts with a shared city',
  ).toBe(first.circuitCityId);
  const configured = cityByCircuitId(first.circuitCityId);
  if (configured === undefined) {
    throw new Error(`no configured city carries circuit city id ${first.circuitCityId}`);
  }
  return configured;
}

function instantInsideBothStays(): Date {
  return new Date(
    Math.max(
      instantDuringStay(submissions.valid).getTime(),
      instantDuringStay(submissions.validSecond).getTime(),
    ),
  );
}

function submitProof(user: UserFixture, submission: ProofSubmission): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: PROOF_ROUTE,
    as: user,
    body: { proof: submission.proof, publicSignals: [...submission.publicSignals] },
  });
}

/**
 * One seeded fixture venue of a city, with the console secret that derives its check-in code:
 * criterion 1 names a seeded venue, so this reads the seed's own summary rather than making one.
 */
async function seededVenue(cityId: string): Promise<VenueFixture> {
  const summary = await t.seedFixtures();
  const entry = summary.secrets?.venues.find((venue) => venue.cityId === cityId);
  if (entry === undefined) {
    throw new Error(`the seed wrote no venue in ${cityId}`);
  }
  const stored = await t.services.db.venue.findUniqueOrThrow({
    where: { id: entry.id },
    select: { id: true, cityId: true },
  });
  const points = await readPoints(t.services.db, 'venue', [stored.id], t.env.APP_ENV);
  const point = points.get(stored.id);
  if (point === undefined) {
    throw new Error('the seeded venue has no stored location to measure the geofence from');
  }
  return {
    id: stored.id,
    cityId: stored.cityId,
    lat: point.lat,
    lng: point.lng,
    secret: entry.secret,
  };
}

interface DepositRow {
  readonly id: string;
  readonly ownerId: string;
  readonly role: ParticipantRole;
  readonly status: DepositStatus;
  readonly paymentIntentId: string | null;
}

async function depositsOf(meetupId: string): Promise<DepositRow[]> {
  const found = await t.services.db.deposit.findMany({
    where: { meetupId },
    select: {
      id: true,
      ownerId: true,
      role: true,
      status: true,
      currentPaymentIntentId: true,
    },
    orderBy: { role: 'asc' },
  });
  return found.map((deposit) => ({
    id: deposit.id,
    ownerId: deposit.ownerId,
    role: deposit.role,
    status: deposit.status,
    paymentIntentId: deposit.currentPaymentIntentId,
  }));
}

async function depositFor(meetupId: string, role: ParticipantRole): Promise<DepositRow> {
  const found = (await depositsOf(meetupId)).find((deposit) => deposit.role === role);
  if (found === undefined) {
    throw new Error(`meetup ${meetupId} has no ${role} deposit`);
  }
  return found;
}

async function depositById(depositId: string): Promise<DepositRow> {
  const found = await t.services.db.deposit.findUniqueOrThrow({
    where: { id: depositId },
    select: { id: true, ownerId: true, role: true, status: true, currentPaymentIntentId: true },
  });
  return {
    id: found.id,
    ownerId: found.ownerId,
    role: found.role,
    status: found.status,
    paymentIntentId: found.currentPaymentIntentId,
  };
}

function meetupRow(meetupId: string) {
  return t.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: {
      status: true,
      startsAt: true,
      lockedAt: true,
      bothCheckedInAt: true,
      forfeitReason: true,
      cancelReason: true,
      settledAt: true,
      finalAt: true,
    },
  });
}

function settlementOf(meetupId: string) {
  return t.services.db.meetupSettlement.findUnique({
    where: { meetupId },
    select: { outcome: true, status: true, appliedAt: true, completedAt: true },
  });
}

function operationRows(meetupId: string) {
  return t.services.db.paymentOperation.findMany({
    where: { deposit: { is: { meetupId } } },
    select: { id: true, kind: true, status: true, depositId: true, dependsOnId: true, seq: true },
    orderBy: [{ depositId: 'asc' }, { seq: 'asc' }],
  });
}

interface IntentSnapshot {
  readonly status: string;
  readonly cancellationReason: string | null;
}

function proxy(): ProxyControl {
  const control = t.stripe.proxy;
  if (control === null) {
    throw new Error('this case needs the stateful proxy: STRIPE_MODE=mock');
  }
  return control;
}

function objectId(object: unknown): string | null {
  if (typeof object !== 'object' || object === null) {
    return null;
  }
  const id = (object as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function readIntent(value: unknown): IntentSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new Error('the provider answered no PaymentIntent');
  }
  const intent = value as { status?: unknown; cancellation_reason?: unknown };
  return {
    status: typeof intent.status === 'string' ? intent.status : '',
    cancellationReason:
      typeof intent.cancellation_reason === 'string' ? intent.cancellation_reason : null,
  };
}

/**
 * The authorization of one deposit as the provider holds it: the proxy in `mock`, asked by the
 * attempt's own metadata, or Stripe's test API for the id the deposit carries. Neither path imports
 * the Stripe SDK, which only `payments/stripe-gateway.ts` may.
 */
async function intentOf(deposit: DepositRow): Promise<IntentSnapshot> {
  if (deposit.paymentIntentId === null) {
    throw new Error('this deposit has no live PaymentIntent');
  }
  const control = t.stripe.proxy;
  if (control !== null) {
    const [found] = await control.paymentIntents({ metadata: { depositId: deposit.id } });
    return found === undefined
      ? { status: 'absent', cancellationReason: null }
      : { status: found.status, cancellationReason: found.cancellation_reason };
  }
  const retrieved = await stripeApi(t).get(
    `/v1/payment_intents/${encodeURIComponent(deposit.paymentIntentId)}`,
  );
  return readIntent(retrieved);
}

/**
 * Run settlement passes until the meetup's settlement closes, and fail when it never does: a
 * settlement only plans its provider calls, which the executor carries out after its commit, so the
 * row turns `complete` on the pass that finishes the last of them.
 */
async function settleUntilComplete(meetupId: string): Promise<void> {
  await waitFor(async () => {
    await settleNow(t.services);
    const settlement = await settlementOf(meetupId);
    return settlement?.status === 'complete' ? settlement : null;
  });
}

/**
 * Whether the provider recorded a refund of one deposit's charge, always false without the proxy: a
 * `charge.refunded` event names the charge, so the intent's own `latest_charge` is what it matches.
 */
async function chargeWasRefunded(deposit: DepositRow): Promise<boolean> {
  const control = t.stripe.proxy;
  if (control === null || deposit.paymentIntentId === null) {
    return false;
  }
  const [intent] = await control.paymentIntents({ metadata: { depositId: deposit.id } });
  const charge = intent?.latest_charge ?? null;
  const chargeId = typeof charge === 'string' ? charge : (charge?.id ?? null);
  if (chargeId === null) {
    return false;
  }
  const events = await control.events();
  return events.some(
    (event) => event.type === 'charge.refunded' && objectId(event.data.object) === chargeId,
  );
}

interface RecordedEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly data: { readonly object: unknown };
}

async function recordedEvents(type: string, paymentIntentId: string): Promise<RecordedEvent[]> {
  const control = t.stripe.proxy;
  if (control === null) {
    return [];
  }
  const events: readonly RecordedEvent[] = await control.events();
  return events.filter(
    (event) => event.type === type && objectId(event.data.object) === paymentIntentId,
  );
}

/**
 * Lose one deposit's authorization at the provider, without reporting it: `at` pins the proxy clock
 * first, which fixes Stripe's own `canceled_at` before or after the settlement's `appliedAt`, the
 * comparison the compensation rule turns on. A case that wants the loss reported calls
 * {@link reportHoldLoss}; one that wants the settlement's own reconciliation to find it does not.
 */
async function expireAtProvider(deposit: DepositRow, at?: Date): Promise<void> {
  const control = proxy();
  if (deposit.paymentIntentId === null) {
    throw new Error('this deposit has no live PaymentIntent to expire');
  }
  if (at !== undefined) {
    await control.setNow(at);
  }
  await control.expireHold(deposit.paymentIntentId);
}

/**
 * Deliver the two events Stripe issued for one expired hold, and nothing else: the events the
 * fixtures' own hold creations recorded — which no suite delivers — never ride along.
 */
async function reportHoldLoss(deposit: DepositRow): Promise<WebhookResponse[]> {
  const control = proxy();
  const events = (await control.events()).filter(
    (event) =>
      objectId(event.data.object) === deposit.paymentIntentId && HOLD_LOSS_TYPES.has(event.type),
  );
  return deliverStripeEvents(t.app, events, t.stripe.webhookSecret);
}

async function expireAndReport(deposit: DepositRow, at?: Date): Promise<WebhookResponse[]> {
  await expireAtProvider(deposit, at);
  return reportHoldLoss(deposit);
}

async function actorWith(role: UserRole): Promise<UserFixture> {
  return makeUser(t, { role, card: 'none' });
}

async function metricsAround(at: Date) {
  const operator = await actorWith('operator');
  const response = await callRoute(t.app, {
    method: 'GET',
    url: '/v1/admin/metrics',
    as: operator,
    query: {
      from: dayOf(new Date(at.getTime() - DAY_MS)),
      to: dayOf(new Date(at.getTime() + DAY_MS)),
      cityId: city.id,
    },
  });
  expect(
    response.status,
    `GET /v1/admin/metrics answered ${response.status}: ${response.body}`,
  ).toBe(200);
  return MetricsDto.parse(response.json());
}

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

async function balanceOf(user: UserFixture): Promise<number> {
  const response = await callRoute(t.app, {
    method: 'GET',
    url: '/v1/me',
    as: await t.tokenFor(user),
  });
  expect(response.status).toBe(200);
  return MeDto.parse(response.json()).tableCreditCents;
}

/**
 * A Table Credit grant and the `void` that reverses it: a compensation adds the void and never
 * removes the grant, because the balance is grants less voids.
 */
function expectCreditReversed(entries: readonly { kind: string }[], userId: string): void {
  expect(entries).toEqual([
    { userId, kind: 'grant', amountCents: DEFAULT_DEPOSIT_CENTS },
    { userId, kind: 'void', amountCents: DEFAULT_DEPOSIT_CENTS },
  ]);
}

interface LockedFixture {
  readonly meetup: MeetupFixture;
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
  readonly venue: VenueFixture;
}

/**
 * One locked meetup between two fresh accounts at a fresh venue in the fixture city, with a real
 * authorization on each side, so the reconciliation, the capture and the releases are production's.
 */
async function lockedFixture(
  options: {
    readonly checkIns?: { readonly initiator?: 'pass'; readonly recipient?: 'pass' };
  } = {},
): Promise<LockedFixture> {
  const initiator = await makeUser(t, { card: 'visa' });
  const recipient = await makeUser(t, { card: 'visa' });
  const venue = await makeVenue(t, { cityId: city.id });
  const meetup = await makeMeetup(t, {
    status: 'locked',
    initiator,
    recipient,
    venue,
    ...(options.checkIns === undefined ? {} : { checkIns: options.checkIns }),
  });
  return { meetup, initiator, recipient, venue };
}

/**
 * Check one attendee in through the real route: the code is the one
 * `GET /v1/venue/check-in-code` derives, and the coordinates sit `distanceM` due north of the venue.
 */
function checkIn(user: UserFixture, meetupId: string, venue: VenueFixture, distanceM: number) {
  if (venue.secret === null) {
    throw new Error('the venue has no console secret to derive a code from');
  }
  return checkInAtVenue(
    t,
    user,
    { id: meetupId, venueId: venue.id },
    { venueSecret: venue.secret, distanceM },
  );
}

async function fileDispute(filer: UserFixture, meetupId: string): Promise<string> {
  const response = await callRoute(t.app, {
    method: 'POST',
    url: `/v1/meetups/${meetupId}/dispute`,
    as: await t.tokenFor(filer),
    body: { reason: 'Fixture dispute', kind: 'venue_unavailable' },
  });
  expect(
    response.status,
    `POST /v1/meetups/:id/dispute answered ${response.status}: ${response.body}`,
  ).toBe(201);
  return response.json<{ disputeId: string }>().disputeId;
}

async function resolveDispute(
  operator: UserFixture,
  disputeId: string,
  outcome: 'no_fault' | 'settle_by_checkins',
): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: `/v1/admin/disputes/${disputeId}/resolve`,
    as: operator,
    body: { outcome },
  });
}

/**
 * Wait for one state, by polling the row the production code writes: a bounded number of waits rather
 * than a deadline read from a clock, and a state that never arrives fails the case.
 */
async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  for (let step = 0; step < POLL_STEPS; step += 1) {
    const found = await read();
    if (found !== null) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`the state this case waits for did not arrive within ${POLL_STEPS} polls`);
}

function creditEntries(meetupId: string) {
  return t.services.db.tableCreditEntry.findMany({
    where: { meetupId },
    select: { userId: true, kind: true, amountCents: true },
  });
}

function witnessEvents(meetupId: string) {
  return t.services.db.witnessEvent.findMany({
    where: { meetupId },
    select: { userId: true, counterpartId: true, countsForReputation: true },
    orderBy: { userId: 'asc' },
  });
}

function pairHistoryOf(a: string, b: string) {
  const pair = pairOrder(a, b);
  return t.services.db.pairHistory.findUnique({
    where: { userLowId_userHighId: { userLowId: pair.low, userHighId: pair.high } },
    select: { completedCount: true, firstCompletedAt: true, lastCompletedAt: true },
  });
}

describe('criterion 1 — two verified travelers meet, check in and settle', () => {
  it(`${MODE} walks propose, lock, check in and settle and shows 100% completion`, async () => {
    // Both fixture stays are in force from this instant, and the clock stands inside both of them.
    t.time.at(instantInsideBothStays());
    const venue = await seededVenue(city.id);
    expect(venue.secret).not.toBeNull();
    const initiator = await makeUser(t, { card: 'visa' });
    const recipient = await makeUser(t, { card: 'visa' });
    // Both proofs arrive the way the device sends one, and only the public outputs are stored.
    const first = await submitProof(initiator, submissions.valid);
    expect(first.status, `POST ${PROOF_ROUTE} answered ${first.status}: ${first.body}`).toBe(201);
    expect(ProofAccepted.parse(first.json()).cityId).toBe(city.id);
    const second = await submitProof(recipient, submissions.validSecond);
    expect(second.status, `POST ${PROOF_ROUTE} answered ${second.status}: ${second.body}`).toBe(
      201,
    );
    // A start inside the five-day horizon of AAP 0.5.4, two hours out, where the deposit screens
    // and the free-cancellation window both apply.
    const startsAt = new Date(t.time.now().getTime() + 2 * HOUR_MS);
    const { meetupId } = await proposeAndLock(t, {
      initiator,
      recipient,
      venue,
      startsAt,
      depositCents: DEFAULT_DEPOSIT_CENTS,
    });
    const locked = await meetupRow(meetupId);
    expect(locked.status).toBe('locked');
    expect(locked.lockedAt).not.toBeNull();
    expect((await depositsOf(meetupId)).map((deposit) => deposit.status)).toEqual(['held', 'held']);
    // Both attendees check in with the code the venue console derives, 30 m from the venue.
    t.time.toMeetupPoint({ startsAt }, 'startsAt');
    const firstCheckIn = await checkIn(initiator, meetupId, venue, 30);
    expect(firstCheckIn.bothCheckedIn).toBe(false);
    const secondCheckIn = await checkIn(recipient, meetupId, venue, 30);
    expect(secondCheckIn.bothCheckedIn).toBe(true);
    expect((await meetupRow(meetupId)).bothCheckedInAt).not.toBeNull();
    // The window closes and the settlement falls due: one pass decides the outcome and executes the
    // releases it planned.
    t.time.toMeetupPoint({ startsAt }, 'startsAt+45m');
    await settleNow(t.services);
    const settled = await meetupRow(meetupId);
    expect(settled.status).toBe('completed');
    expect(settled.settledAt).not.toBeNull();
    const settlement = await settlementOf(meetupId);
    expect(settlement).toMatchObject({ outcome: 'completed', status: 'complete' });
    expect(await witnessEvents(meetupId)).toHaveLength(2);
    // Both authorizations are released by us, in the one cancellation reason that means "released"
    // rather than "lost" (AAP 0.3.2, 0.5.3).
    const deposits = await depositsOf(meetupId);
    expect(deposits.every((deposit) => deposit.status === 'released')).toBe(true);
    for (const deposit of deposits) {
      const intent = await intentOf(deposit);
      expect(intent.status).toBe('canceled');
      expect(intent.cancellationReason).toBe(OUR_CANCELLATION_REASON);
    }
    // The headline the pilot is judged by, and the pair's history behind the top disclosure tiers.
    const metrics = await metricsAround(startsAt);
    expect(metrics.completion).toMatchObject({
      lockedMeetups: 1,
      bothCheckedIn: 1,
      rate: 1,
    });
    expect(metrics.counts.noShows).toBe(0);
    expect((await pairHistoryOf(initiator.id, recipient.id))?.completedCount).toBe(1);
    expect(await creditEntries(meetupId)).toHaveLength(0);
  });
});

describe('criterion 2 — the absent party is forfeited and the attendee credited', () => {
  it(`${MODE} captures the absent party's hold, releases the attendee's and grants Table Credit`, async () => {
    t.time.at(instantInsideBothStays());
    const initiator = await makeUser(t, { card: 'visa' });
    const recipient = await makeUser(t, { card: 'visa' });
    const venue = await makeVenue(t, { cityId: city.id });
    const startsAt = new Date(t.time.now().getTime() + 2 * HOUR_MS);
    const { meetupId } = await proposeAndLock(t, { initiator, recipient, venue, startsAt });
    // Only the initiator turns up and checks in inside the window.
    t.time.toMeetupPoint({ startsAt }, 'startsAt');
    expect((await checkIn(initiator, meetupId, venue, 30)).bothCheckedIn).toBe(false);
    t.time.toMeetupPoint({ startsAt }, 'startsAt+45m');
    await settleNow(t.services);
    const settled = await meetupRow(meetupId);
    expect(settled.status).toBe('forfeited');
    expect(settled.forfeitReason).toBe('no_show');
    // The absent party's hold is captured and the attendee's released (AAP 0.5.7).
    const absent = await depositFor(meetupId, 'recipient');
    const attendee = await depositFor(meetupId, 'initiator');
    expect(absent.status).toBe('captured');
    expect(attendee.status).toBe('released');
    expect((await intentOf(absent)).status).toBe('succeeded');
    expect((await intentOf(attendee)).cancellationReason).toBe(OUR_CANCELLATION_REASON);
    // The attendee's Table Credit equals the deposit, and the dashboard counts the no-show.
    expect(await balanceOf(initiator)).toBe(DEFAULT_DEPOSIT_CENTS);
    expect(await creditEntries(meetupId)).toEqual([
      { userId: initiator.id, kind: 'grant', amountCents: DEFAULT_DEPOSIT_CENTS },
    ]);
    expect((await metricsAround(startsAt)).counts.noShows).toBe(1);
    // A forfeit witnesses nothing and completes nothing for the pair.
    expect(await witnessEvents(meetupId)).toHaveLength(0);
    expect(await pairHistoryOf(initiator.id, recipient.id)).toBeNull();
  });
  it(`${MODE} captures once, grants once and credits once however many passes run`, async () => {
    const { meetup, initiator } = await lockedFixture({ checkIns: { initiator: 'pass' } });
    t.time.toMeetupPoint(meetup, 'startsAt+45m');
    // Three passes: the timer's own job, the sweeper's backstop and a repeat of either.
    await settleNow(t.services);
    await settleNow(t.services);
    await settleNow(t.services);
    const operations = await operationRows(meetup.id);
    const captures = operations.filter((operation) => operation.kind === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0]?.status).toBe('succeeded');
    expect(operations.filter((operation) => operation.kind === 'release')).toHaveLength(1);
    expect(await creditEntries(meetup.id)).toEqual([
      { userId: initiator.id, kind: 'grant', amountCents: DEFAULT_DEPOSIT_CENTS },
    ]);
    expect(await settlementOf(meetup.id)).toMatchObject({ outcome: 'no_show', status: 'complete' });
    // One capture is one charge at the provider, whichever pass asked for it.
    const captured = await depositFor(meetup.id, 'recipient');
    if (captured.paymentIntentId !== null && MOCK) {
      expect(
        await recordedEvents('payment_intent.succeeded', captured.paymentIntentId),
      ).toHaveLength(1);
    }
  });
  it(`${MODE} counts a completed meetup once for the pair however many passes run`, async () => {
    const { meetup, initiator, recipient } = await lockedFixture({
      checkIns: { initiator: 'pass', recipient: 'pass' },
    });
    t.time.toMeetupPoint(meetup, 'startsAt+45m');
    await settleNow(t.services);
    await settleNow(t.services);
    await settleNow(t.services);
    expect(await settlementOf(meetup.id)).toMatchObject({
      outcome: 'completed',
      status: 'complete',
    });
    expect(await witnessEvents(meetup.id)).toHaveLength(2);
    expect((await pairHistoryOf(initiator.id, recipient.id))?.completedCount).toBe(1);
    expect(await creditEntries(meetup.id)).toHaveLength(0);
    expect((await depositsOf(meetup.id)).every((deposit) => deposit.status === 'released')).toBe(
      true,
    );
  });
  it(`${MODE} rolls a crash inside the settlement transaction back and settles on the next pass`, async () => {
    const { meetup, initiator, recipient } = await lockedFixture({
      checkIns: { initiator: 'pass', recipient: 'pass' },
    });
    t.time.toMeetupPoint(meetup, 'startsAt+45m');
    t.faults.arm('settlement.inside_transaction', { once: true });
    try {
      await settleNow(t.services);
    } finally {
      t.faults.disarm();
    }
    // The fault is the transaction's last statement, so every effect of the outcome is rolled back
    // with it, and the crash is counted rather than thrown at the caller (AAP 0.3.2, 0.11.2).
    expect(t.faults.hits['settlement.inside_transaction']).toBeGreaterThan(0);
    expect(await settlementOf(meetup.id)).toBeNull();
    // The fixtures' own hold attempts are the only operations left: the transfer the settlement
    // planned rolled back with the transaction that planned it.
    const operations = await operationRows(meetup.id);
    expect(operations.every((operation) => operation.kind === 'hold')).toBe(true);
    expect((await meetupRow(meetup.id)).status).toBe('locked');
    expect(await witnessEvents(meetup.id)).toHaveLength(0);
    // The next pass settles it, exactly once.
    await settleNow(t.services);
    expect((await meetupRow(meetup.id)).status).toBe('completed');
    expect(await settlementOf(meetup.id)).toMatchObject({
      outcome: 'completed',
      status: 'complete',
    });
    expect((await pairHistoryOf(initiator.id, recipient.id))?.completedCount).toBe(1);
    expect((await depositsOf(meetup.id)).every((deposit) => deposit.status === 'released')).toBe(
      true,
    );
  });
});

type RacerName = 'cancel' | 'block' | 'hold_loss';

interface RaceCase {
  readonly name: string;
  readonly racer: RacerName;
  readonly allowed: readonly MeetupStatus[];
}

/**
 * The three racers: a cancel inside the last two hours is the late-cancellation forfeit, a block
 * cancels the open meetup whenever it arrives, and a hold-loss webhook ends it `lock_lost`. Only
 * `mock` can lose a hold on demand.
 */
const RACES: readonly RaceCase[] = [
  {
    name: 'a late cancellation by the recipient',
    racer: 'cancel',
    allowed: ['forfeited'],
  },
  {
    name: 'a block by the recipient',
    racer: 'block',
    allowed: ['cancelled', 'forfeited'],
  },
  ...(MOCK
    ? [
        {
          name: 'a hold-loss webhook for the attendee',
          racer: 'hold_loss' as const,
          allowed: ['lock_lost', 'forfeited'] as readonly MeetupStatus[],
        },
      ]
    : []),
];

/**
 * Expire the attendee's hold at the provider and report it, or report nothing when the settlement got
 * there first (AAP 0.3.2): the provider refuses to expire an authorization that is no longer
 * capturable, which is what a settlement that already released or captured it leaves behind.
 */
async function loseAttendeeHold(fixture: LockedFixture): Promise<WebhookResponse[]> {
  const attendee = await depositFor(fixture.meetup.id, 'initiator');
  try {
    return await expireAndReport(attendee);
  } catch (error) {
    if (!/requires_capture/.test(String(error))) {
      throw error;
    }
    return [];
  }
}

function racer(name: RacerName, fixture: LockedFixture): Promise<unknown> {
  switch (name) {
    case 'cancel':
      return t.tokenFor(fixture.recipient).then((token) =>
        callRoute(t.app, {
          method: 'POST',
          url: `/v1/meetups/${fixture.meetup.id}/cancel`,
          as: token,
        }),
      );
    case 'block':
      return t.tokenFor(fixture.recipient).then((token) =>
        callRoute(t.app, {
          method: 'POST',
          url: `/v1/users/${fixture.initiator.id}/block`,
          as: token,
        }),
      );
    case 'hold_loss':
      return loseAttendeeHold(fixture);
  }
}

describe('a racer and the sweeper serialize on the meetup row lock', () => {
  it.each(rows(RACES))(`${MODE} $name meets the sweep at the same instant`, async (entry) => {
    const fixture = await lockedFixture({ checkIns: { initiator: 'pass' } });
    t.time.toMeetupPoint(fixture.meetup, 'startsAt+45m');
    const [, raced] = await Promise.all([settleNow(t.services), racer(entry.racer, fixture)]);
    // A racer that lost the row is never answered a success it did not have: a cancel that arrives
    // after the sweep settled the meetup is the contract's own `409 already_settled`.
    const answer = raced as RouteResponse[] | undefined;
    const cancelled = answer?.[0];
    if (entry.racer === 'cancel' && cancelled !== undefined && cancelled.status !== 200) {
      expect(expectError(cancelled, 409, 'already_settled').error.code).toBe('already_settled');
    }
    // One outcome, and only one: the loser of the race finds the row it wanted already moved.
    const meetup = await meetupRow(fixture.meetup.id);
    expect(entry.allowed).toContain(meetup.status);
    expect(meetup.finalAt).not.toBeNull();
    const settlements = await t.services.db.meetupSettlement.count({
      where: { meetupId: fixture.meetup.id },
    });
    expect(settlements).toBe(meetup.status === 'forfeited' ? 1 : 0);
    const operations = await operationRows(fixture.meetup.id);
    const captures = operations.filter((operation) => operation.kind === 'capture');
    expect(captures).toHaveLength(meetup.status === 'forfeited' ? 1 : 0);
    const grants = (await creditEntries(fixture.meetup.id)).filter(
      (entry) => entry.kind === 'grant',
    );
    expect(grants).toHaveLength(meetup.status === 'forfeited' ? 1 : 0);
    // Whatever the racer left open — a block plans its releases after its commit — one more pass
    // flushes it, and every deposit ends on a status no further pass may move.
    await settleNow(t.services);
    const deposits = await depositsOf(fixture.meetup.id);
    expect(deposits.length).toBeGreaterThan(0);
    expect(deposits.every((deposit) => FINAL_DEPOSIT_STATUSES.includes(deposit.status))).toBe(true);
  });
});

function holdMoneyPending(): void {
  t.faults.arm('payment_op.before_stripe_call', {
    once: false,
    when: (context) => context['kind'] === 'capture' || context['kind'] === 'release',
  });
}

describe.runIf(MOCK)('a lost hold never forfeits (AAP 0.3.2)', () => {
  it("ends the meetup lock_lost when the attendee's hold expired before the settlement", async () => {
    const { meetup } = await lockedFixture({ checkIns: { initiator: 'pass' } });
    t.time.toMeetupPoint(meetup, 'startsAt+45m');
    // The authorization is gone at the provider and nothing has reported it, so the settlement's own
    // reconciliation is what finds it — and only what is still capturable ever settles an outcome.
    await expireAtProvider(await depositFor(meetup.id, 'initiator'));
    await settleNow(t.services);
    expect((await meetupRow(meetup.id)).status).toBe('lock_lost');
    expect(await settlementOf(meetup.id)).toBeNull();
    expect(await creditEntries(meetup.id)).toHaveLength(0);
    expect((await depositFor(meetup.id, 'initiator')).status).toBe('expired');
    // The surviving hold is released rather than left outstanding, and no capture was ever planned.
    const operations = await operationRows(meetup.id);
    expect(operations.filter((operation) => operation.kind === 'capture')).toHaveLength(0);
    expect(operations.filter((operation) => operation.kind === 'release')).toHaveLength(1);
    expect((await depositFor(meetup.id, 'recipient')).status).toBe('released');
  });
  it("compensates a forfeit whose absent party's hold expired before the capture could run", async () => {
    const { meetup, initiator } = await lockedFixture({ checkIns: { initiator: 'pass' } });
    t.time.toMeetupPoint(meetup, 'startsAt+45m');
    // The forfeit commits, and the fault keeps its capture pending: the loss becomes visible only
    // when the capture itself fails on an authorization that is no longer there.
    holdMoneyPending();
    try {
      await settleNow(t.services);
    } finally {
      t.faults.disarm();
    }
    expect((await meetupRow(meetup.id)).status).toBe('forfeited');
    const capture = (await operationRows(meetup.id)).find(
      (operation) => operation.kind === 'capture',
    );
    expect(capture?.status).toBe('pending');
    const absent = await depositFor(meetup.id, 'recipient');
    await expireAtProvider(absent);
    await settleNow(t.services);
    // The capture failed terminally, so the forfeit is compensated: the meetup is `lock_lost`, the
    // capture never ran, the Table Credit is voided and the no-show is gone (AAP 0.3.2, 0.5.7).
    expect((await meetupRow(meetup.id)).status).toBe('lock_lost');
    expect((await depositFor(meetup.id, 'recipient')).status).toBe('expired');
    expectCreditReversed(await creditEntries(meetup.id), initiator.id);
    expect(await balanceOf(initiator)).toBe(0);
    expect(
      (await operationRows(meetup.id)).find((operation) => operation.id === capture?.id)?.status,
    ).toBe('failed_terminal');
    if (absent.paymentIntentId !== null) {
      expect(await recordedEvents('payment_intent.succeeded', absent.paymentIntentId)).toHaveLength(
        0,
      );
    }
    // The dashboard sees a lock loss and no no-show at all, which is the point of the rule.
    const metrics = await metricsAround(meetup.startsAt);
    expect(metrics.counts.noShows).toBe(0);
    expect(metrics.counts.lockLost).toBe(1);
  });
  interface LateCancelCase {
    readonly name: string;
    readonly lost: 'canceller' | 'counterpart';
    readonly timing: 'before' | 'after';
  }
  const LATE_CANCELS: readonly LateCancelCase[] = [
    { name: "before the commit, the canceller's hold", lost: 'canceller', timing: 'before' },
    { name: "before the commit, the counterpart's hold", lost: 'counterpart', timing: 'before' },
    { name: "after the commit, the canceller's hold", lost: 'canceller', timing: 'after' },
    { name: "after the commit, the counterpart's hold", lost: 'counterpart', timing: 'after' },
  ];
  it.each(rows(LATE_CANCELS))('a late cancellation with a lost hold $name', async (entry) => {
    const fixture = await lockedFixture();
    t.time.toMeetupPoint(fixture.meetup, 'startsAt');
    const canceller = await depositFor(fixture.meetup.id, 'recipient');
    const counterpart = await depositFor(fixture.meetup.id, 'initiator');
    const lostHold = entry.lost === 'canceller' ? canceller : counterpart;
    const token = await t.tokenFor(fixture.recipient);
    const cancel = async (): Promise<RouteResponse> =>
      callRoute(t.app, {
        method: 'POST',
        url: `/v1/meetups/${fixture.meetup.id}/cancel`,
        as: token,
      });
    if (entry.timing === 'before') {
      // The reconciliation runs before the forfeit commits, so the cancellation finds the hold gone
      // and the meetup ends `lock_lost` instead of capturing a card with nothing on it.
      await expireAtProvider(lostHold);
      expect((await cancel()).status).toBe(200);
      expect((await meetupRow(fixture.meetup.id)).status).toBe('lock_lost');
      expect(await settlementOf(fixture.meetup.id)).toBeNull();
      expect(await creditEntries(fixture.meetup.id)).toHaveLength(0);
      expect((await depositById(lostHold.id)).status).toBe('expired');
      await settleNow(t.services);
      expect((await depositById(lostHold.id)).status).toBe('expired');
      return;
    }
    // The forfeit commits first — with both provider calls held pending — and the loss is reported
    // afterwards, at an instant the record places at or after the settlement's own `appliedAt`.
    holdMoneyPending();
    try {
      expect((await cancel()).status).toBe(200);
    } finally {
      t.faults.disarm();
    }
    const settled = await settlementOf(fixture.meetup.id);
    expect(settled).toMatchObject({ outcome: 'late_cancel', status: 'applying' });
    if (settled === null) {
      throw new Error('the late cancellation recorded no settlement to compensate');
    }
    await expireAndReport(lostHold, new Date(settled.appliedAt.getTime() + 1_000));
    await settleNow(t.services);
    if (entry.lost === 'canceller') {
      // The canceller's own hold is the one the forfeit captured, so its loss reverses the whole
      // forfeit: no money moves and the meetup ends without an outcome.
      expect((await meetupRow(fixture.meetup.id)).status).toBe('lock_lost');
      expectCreditReversed(await creditEntries(fixture.meetup.id), counterpart.ownerId);
      expect((await depositById(lostHold.id)).status).toBe('expired');
      return;
    }
    // Only the hold being released was lost, so the forfeit stands: the counterpart's deposit is
    // `expired`, its release is recorded as satisfied, and the absent party is still captured.
    const lifecycle = await meetupRow(fixture.meetup.id);
    expect(lifecycle.status).toBe('forfeited');
    expect(lifecycle.forfeitReason).toBe('late_cancel');
    expect((await depositById(lostHold.id)).status).toBe('expired');
    expect((await depositById(canceller.id)).status).toBe('captured');
    const release = (await operationRows(fixture.meetup.id)).find(
      (operation) => operation.kind === 'release',
    );
    expect(release?.depositId).toBe(lostHold.id);
    expect(release?.status).toBe('succeeded');
  });
  it.each(rows([{ pin: -1_000 }, { pin: 1_000 }]))(
    'a completed outcome stands when a released hold expires $pin ms from the settlement',
    async (entry) => {
      const { meetup } = await lockedFixture({
        checkIns: { initiator: 'pass', recipient: 'pass' },
      });
      t.time.toMeetupPoint(meetup, 'startsAt+45m');
      // Both releases are held pending, so a hold can be lost inside the window the settlement
      // leaves between its decision and the provider calls it planned — the one case in which a
      // completed settlement meets a hold that is already gone.
      holdMoneyPending();
      try {
        await settleNow(t.services);
      } finally {
        t.faults.disarm();
      }
      const settlement = await settlementOf(meetup.id);
      if (settlement === null) {
        throw new Error('the completion recorded no settlement');
      }
      expect(settlement).toMatchObject({ outcome: 'completed', status: 'applying' });
      const released = await depositFor(meetup.id, 'initiator');
      await expireAndReport(released, new Date(settlement.appliedAt.getTime() + entry.pin));
      await settleUntilComplete(meetup.id);
      // A completed settlement releases both holds anyway, so a lost hold moves no money: the outcome
      // stands, the deposit is `expired` and its release is satisfied (AAP 0.3.2).
      expect((await meetupRow(meetup.id)).status).toBe('completed');
      expect(await settlementOf(meetup.id)).toMatchObject({
        outcome: 'completed',
        status: 'complete',
      });
      expect((await depositById(released.id)).status).toBe('expired');
      expect((await depositFor(meetup.id, 'recipient')).status).toBe('released');
      const release = (await operationRows(meetup.id)).find(
        (operation) => operation.kind === 'release' && operation.depositId === released.id,
      );
      expect(release?.status).toBe('succeeded');
    },
  );
  it('waits for an executing capture, then refunds it when the operator decides no_fault', async () => {
    const { meetup, initiator, recipient } = await lockedFixture({
      checkIns: { initiator: 'pass' },
    });
    t.time.toMeetupPoint(meetup, 'startsAt+45m');
    // The capture is with the provider but its answer is late, which is the one state a reversal
    // cannot fence and must instead depend on (AAP 0.3.2 "Fencing").
    await proxy().delayNext({
      method: 'POST',
      path: '/v1/payment_intents/*/capture',
      ms: CAPTURE_DELAY_MS,
    });
    const settling = settleNow(t.services);
    const executing = await waitFor(async () => {
      const operations = await operationRows(meetup.id);
      return (
        operations.find(
          (operation) => operation.kind === 'capture' && operation.status === 'executing',
        ) ?? null
      );
    });
    expect(executing.depositId).not.toBeNull();
    const disputeId = await fileDispute(recipient, meetup.id);
    const resolved = await resolveDispute(await actorWith('operator'), disputeId, 'no_fault');
    expect(resolved.status, `resolve answered ${resolved.status}: ${resolved.body}`).toBe(200);
    await settling;
    await settleUntilComplete(meetup.id);
    const absent = await depositById(executing.depositId ?? '');
    const operations = await operationRows(meetup.id);
    const reversal = operations.find((operation) => operation.kind === 'refund');
    expect(reversal?.dependsOnId).toBe(executing.id);
    expect(reversal?.status).toBe('succeeded');
    expect(absent.status).toBe('refunded');
    expect((await meetupRow(meetup.id)).status).toBe('no_fault');
    expect(await creditEntries(meetup.id)).toEqual(
      expect.arrayContaining([
        { userId: initiator.id, kind: 'grant', amountCents: DEFAULT_DEPOSIT_CENTS },
        { userId: initiator.id, kind: 'void', amountCents: DEFAULT_DEPOSIT_CENTS },
      ]),
    );
    if (MOCK) {
      expect(await chargeWasRefunded(absent)).toBe(true);
    }
  });
  it('fences a pending capture and cancels the authorization instead of refunding it', async () => {
    const { meetup, recipient } = await lockedFixture({ checkIns: { initiator: 'pass' } });
    t.time.toMeetupPoint(meetup, 'startsAt+45m');
    holdMoneyPending();
    try {
      await settleNow(t.services);
    } finally {
      t.faults.disarm();
    }
    const capture = (await operationRows(meetup.id)).find(
      (operation) => operation.kind === 'capture',
    );
    if (capture === undefined) {
      throw new Error('the forfeit planned no capture');
    }
    expect(capture.status).toBe('pending');
    const disputeId = await fileDispute(recipient, meetup.id);
    const resolved = await resolveDispute(await actorWith('operator'), disputeId, 'no_fault');
    expect(resolved.status, `resolve answered ${resolved.status}: ${resolved.body}`).toBe(200);
    // A capture that has not run is fenced before the reversal is planned, so it can never run.
    const fenced = (await operationRows(meetup.id)).find(
      (operation) => operation.id === capture.id,
    );
    expect(fenced?.status).toBe('fenced');
    await settleUntilComplete(meetup.id);
    const absent = await depositById(capture.depositId ?? '');
    const reversal = (await operationRows(meetup.id)).find(
      (operation) => operation.kind === 'refund' && operation.dependsOnId === capture.id,
    );
    expect(reversal?.status).toBe('succeeded');
    expect(absent.status).toBe('released');
    expect((await meetupRow(meetup.id)).status).toBe('no_fault');
    expect(
      await recordedEvents('payment_intent.succeeded', absent.paymentIntentId ?? ''),
    ).toHaveLength(0);
    expect((await intentOf(absent)).cancellationReason).toBe(OUR_CANCELLATION_REASON);
  });
});

describe('what a settlement records for reputation and the leaderboard', () => {
  it('witnesses a pair once in thirty days for reputation but twice for its history', async () => {
    const initiator = await makeUser(t, { card: 'visa' });
    const recipient = await makeUser(t, { card: 'visa' });
    const venue = await makeVenue(t, { cityId: city.id });
    const first = await makeMeetup(t, {
      status: 'locked',
      initiator,
      recipient,
      venue,
      checkIns: { initiator: 'pass', recipient: 'pass' },
    });
    t.time.toMeetupPoint(first, 'startsAt+45m');
    await settleNow(t.services);
    expect((await witnessEvents(first.id)).map((event) => event.countsForReputation)).toEqual([
      true,
      true,
    ]);
    // Ten days later the pair meets again: anti-farming keeps this completion out of the reputation
    // counters, and never out of `PairHistory`, which is what the disclosure tiers read (AAP 0.5.7).
    t.time.advance({ days: 10 });
    const second = await makeMeetup(t, {
      status: 'locked',
      initiator,
      recipient,
      venue,
      startsAt: new Date(t.time.now().getTime() + HOUR_MS),
      checkIns: { initiator: 'pass', recipient: 'pass' },
    });
    t.time.toMeetupPoint(second, 'startsAt+45m');
    await settleNow(t.services);
    expect((await witnessEvents(second.id)).map((event) => event.countsForReputation)).toEqual([
      false,
      false,
    ]);
    expect((await pairHistoryOf(initiator.id, recipient.id))?.completedCount).toBe(2);
  });
  it('credits one lodging whose verified guest stayed over the meetup day', async () => {
    const initiator = await makeUser(t, { card: 'visa' });
    const recipient = await makeUser(t, { card: 'visa' });
    const venue = await makeVenue(t, { cityId: city.id });
    const staying = await makeLodging(t, { cityId: city.id });
    const elsewhere = await makeLodging(t, { cityId: city.id });
    const meetup = await makeMeetup(t, {
      status: 'locked',
      initiator,
      recipient,
      venue,
      checkIns: { initiator: 'pass', recipient: 'pass' },
    });
    t.time.toMeetupPoint(meetup, 'startsAt+45m');
    // One verified claim covers the meetup's own local day; the other starts ten days later.
    const day = localDateKey(city.timezone, meetup.startsAt);
    await makeClaim(t, initiator, staying, {
      status: 'verified',
      stayFrom: addLocalDays(day, -1),
      stayTo: addLocalDays(day, 1),
    });
    await makeClaim(t, initiator, elsewhere, {
      status: 'verified',
      stayFrom: addLocalDays(day, 10),
      stayTo: addLocalDays(day, 12),
    });
    await settleNow(t.services);
    const facts = await t.services.db.lodgingActivityFact.findMany({
      where: { meetupId: meetup.id },
      select: { lodgingId: true, meetupId: true, pairKey: true },
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.lodgingId).toBe(staying.id);
    expect(facts[0]?.pairKey).toBe(pairKey(t.env.ANALYTICS_SALT, initiator.id, recipient.id));
    // The fact carries no user id at all: the leaderboard survives an erasure (AAP 0.5.2, 0.5.7).
    const columns = await t.services.db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'lodging_activity_fact'
    `;
    const names = columns.map((column) => column.column_name);
    expect(names).not.toContain('user_id');
    expect(names).not.toContain('owner_id');
    expect(names).toContain('pair_key');
  });
});
