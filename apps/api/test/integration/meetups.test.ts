/**
 * The meetup routes end to end, with the saved-card setup a first proposal needs.
 *
 * Five groups, in the order the contract states the operations: the proposal's guards, which run in the contract's own order
 * so a request breaking two rules is answered with the earlier one; the proposal that succeeds, whose visibility, recipient
 * deadline and lapse timer all follow from the initiator's hold; the acceptance, which alone locks a meetup and whose retry
 * after a refused card releases the attempt it superseded; the decline, the cancellation with its exact two-hour boundary and
 * the initiator's hold retry; and the own-meetup reads with the payment setup.
 *
 * The assertions read what the handlers wrote and scheduled: the meetup's columns, its deposits, its analytics rows, the
 * outbox rows a worker would deliver, the settlement queue's `lapse-`, `remind-` and `settle-` jobs, and — in the mock
 * topology alone — the proxy's record of the PaymentIntents.
 */
import { randomUUID } from 'node:crypto';

import {
  JOB,
  QUEUE,
  actorHash,
  lapseJobId,
  remindJobId,
  settleJobId,
} from '@tablemate/server-core';
import {
  AcceptResponse,
  CancelResponse,
  CHECK_IN_CLOSES_AFTER_MINUTES,
  CHECK_IN_OPENS_BEFORE_MINUTES,
  DAY_MS,
  DeclineResponse,
  DEFAULT_DEPOSIT_CENTS,
  HoldRetryResponse,
  HOUR_MS,
  LATE_CANCEL_WINDOW_HOURS,
  MeetupDto,
  MeetupListResponse,
  MINUTE_MS,
  NotificationKind,
  OUR_CANCELLATION_REASON,
  PAGE_SIZE,
  PaymentSetupResponse,
  ProposeResponse,
  RECIPIENT_DEADLINE_HOURS,
  START_HORIZON_DAYS,
  VariantPairing,
} from '@tablemate/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createTestApp, DEFAULT_TEST_NOW } from '../support/app.ts';
import { settleNow } from '../support/clock.ts';
import {
  callRoute,
  expectError,
  keysDeep,
  makeBlock,
  makeDispute,
  makeMeetup,
  makeProof,
  makeUser,
  makeVenue,
  proposeAndLock,
  rows,
  stripeApi,
  stripeModeLabel,
} from '../support/factories.ts';
import { TEST_CARDS, type TestCardId } from '../support/stripe-proxy/state.ts';

import type {
  CheckInResult,
  DepositStatus,
  ErrorCode,
  HoldView,
  MeetupStatus,
  ParticipantRole,
} from '@tablemate/shared';
import type { TestApp } from '../support/app.ts';
import type {
  ActorRef,
  CardFixture,
  RouteResponse,
  UserFixture,
  VenueFixture,
} from '../support/factories.ts';

let t: TestApp;

const MOCK = inject('stripeMode') === 'mock';

const MODE = stripeModeLabel(MOCK ? 'mock' : 'test');

const CITY = 'lisbon';

/** A second launch city: a proof for it is the `403 no_valid_proof` of a stay elsewhere. */
const OTHER_CITY = 'mexico-city';

const MEETUPS_URL = '/v1/meetups';
const meetupUrl = (id: string): string => `${MEETUPS_URL}/${id}`;
const acceptUrl = (id: string): string => `${meetupUrl(id)}/accept`;
const declineUrl = (id: string): string => `${meetupUrl(id)}/decline`;
const cancelUrl = (id: string): string => `${meetupUrl(id)}/cancel`;
const holdUrl = (id: string): string => `${meetupUrl(id)}/hold`;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

/** A fresh database, Redis and clock per case, then the five configured cities (AAP 0.5.2). */
beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
});

interface Proposal {
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
  readonly venue: VenueFixture;
  readonly startsAt: Date;
}

interface ProposalOptions {
  readonly card?: CardFixture;
  readonly recipientCard?: CardFixture;
  readonly proofs?: boolean;
  readonly startsAt?: Date;
}

/**
 * The base fixture of this suite: two consented travelers whose accounts can hold a card deposit, a valid proof each for the
 * venue's city, one active partner venue in that city, and a start three days out — far enough ahead that the recipient
 * deadline is the 48-hour one, and inside the five-day horizon.
 */
async function proposal(options: ProposalOptions = {}): Promise<Proposal> {
  const now = t.time.now();
  const card = options.card ?? 'visa';
  const initiator = await makeUser(t, { card });
  const recipient = await makeUser(t, { card: options.recipientCard ?? card });
  const venue = await makeVenue(t, { cityId: CITY });
  if (options.proofs !== false) {
    await makeProof(t, initiator, { cityId: CITY });
    await makeProof(t, recipient, { cityId: CITY });
  }
  return {
    initiator,
    recipient,
    venue,
    startsAt: options.startsAt ?? new Date(now.getTime() + 3 * DAY_MS),
  };
}

interface ProposeOverrides {
  readonly recipientId?: string;
  readonly venueId?: string;
  readonly startsAt?: string;
  readonly depositCents?: number;
}

/**
 * The body of `POST /meetups` for one fixture, with the members a case replaces. Typed as a plain object so a case can spread
 * a replacement over it: the route's own strict schema decides.
 */
function proposeBody(fixture: Proposal, overrides: ProposeOverrides = {}): object {
  return {
    recipientId: overrides.recipientId ?? fixture.recipient.id,
    venueId: overrides.venueId ?? fixture.venue.id,
    startsAt: overrides.startsAt ?? fixture.startsAt.toISOString(),
    depositCents: overrides.depositCents ?? DEFAULT_DEPOSIT_CENTS,
  };
}

function bodyAmong(
  recipient: ActorRef,
  venue: VenueFixture,
  overrides: ProposeOverrides = {},
): object {
  return {
    recipientId: recipient.id,
    venueId: venue.id,
    startsAt: new Date(t.time.now().getTime() + 3 * DAY_MS).toISOString(),
    depositCents: DEFAULT_DEPOSIT_CENTS,
    ...overrides,
  };
}

async function propose(actor: ActorRef, body: object): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'POST', url: MEETUPS_URL, as: await t.tokenFor(actor), body });
}

async function accept(actor: ActorRef, meetupId: string): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: acceptUrl(meetupId),
    as: await t.tokenFor(actor),
  });
}

async function decline(actor: ActorRef, meetupId: string): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: declineUrl(meetupId),
    as: await t.tokenFor(actor),
  });
}

async function cancel(actor: ActorRef, meetupId: string): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'POST',
    url: cancelUrl(meetupId),
    as: await t.tokenFor(actor),
  });
}

async function retryHold(actor: ActorRef, meetupId: string): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'POST', url: holdUrl(meetupId), as: await t.tokenFor(actor) });
}

async function listMeetups(
  actor: ActorRef,
  query: Readonly<Record<string, string>> = {},
): Promise<RouteResponse> {
  return callRoute(t.app, {
    method: 'GET',
    url: MEETUPS_URL,
    as: await t.tokenFor(actor),
    query,
  });
}

async function readMeetup(actor: ActorRef, meetupId: string): Promise<RouteResponse> {
  return callRoute(t.app, { method: 'GET', url: meetupUrl(meetupId), as: await t.tokenFor(actor) });
}

interface MeetupRow {
  readonly status: MeetupStatus;
  readonly cancelReason: string | null;
  readonly forfeitReason: string | null;
  readonly lockedAt: Date | null;
  readonly proposalVisibleAt: Date | null;
  readonly recipientDeadline: Date | null;
  readonly recipientViewedAt: Date | null;
  readonly recipientAcceptedAt: Date | null;
  readonly variantPairing: string;
  readonly startsAt: Date;
  readonly depositCents: number;
  readonly finalAt: Date | null;
}

function meetupRow(meetupId: string): Promise<MeetupRow> {
  return t.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: {
      status: true,
      cancelReason: true,
      forfeitReason: true,
      lockedAt: true,
      proposalVisibleAt: true,
      recipientDeadline: true,
      recipientViewedAt: true,
      recipientAcceptedAt: true,
      variantPairing: true,
      startsAt: true,
      depositCents: true,
      finalAt: true,
    },
  });
}

interface DepositRow {
  readonly id: string;
  readonly ownerId: string;
  readonly role: ParticipantRole;
  readonly status: DepositStatus;
  readonly currentAttempt: number;
  readonly currentPaymentIntentId: string | null;
}

async function depositsByOwner(meetupId: string): Promise<Map<string, DepositRow>> {
  const written = await t.services.db.deposit.findMany({
    where: { meetupId },
    select: {
      id: true,
      ownerId: true,
      role: true,
      status: true,
      currentAttempt: true,
      currentPaymentIntentId: true,
    },
  });
  return new Map(written.map((deposit) => [deposit.ownerId, deposit]));
}

function depositIn(written: Map<string, DepositRow>, owner: ActorRef): DepositRow {
  const deposit = written.get(owner.id);
  if (deposit === undefined) {
    throw new Error('the fixture account holds no deposit on this meetup');
  }
  return deposit;
}

async function depositOf(meetupId: string, owner: ActorRef): Promise<DepositRow> {
  return depositIn(await depositsByOwner(meetupId), owner);
}

interface EventRow {
  readonly name: string;
  readonly actorHash: string | null;
  readonly meetupId: string | null;
  readonly cityId: string | null;
  readonly props: unknown;
}

function eventsFor(meetupId: string): Promise<EventRow[]> {
  return t.services.db.analyticsEvent.findMany({
    where: { meetupId },
    select: { name: true, actorHash: true, meetupId: true, cityId: true, props: true },
    orderBy: { occurredAt: 'asc' },
  });
}

async function onlyMeetupId(): Promise<string> {
  const written = await t.services.db.meetup.findMany({ select: { id: true } });
  expect(written).toHaveLength(1);
  const [row] = written;
  if (row === undefined) {
    throw new Error('no meetup was written');
  }
  return row.id;
}

async function visibleProposal(fixture: Proposal): Promise<ProposeResponse> {
  const response = await propose(fixture.initiator, proposeBody(fixture));
  expect(response.status).toBe(201);
  const created = ProposeResponse.parse(response.json());
  expect((await meetupRow(created.meetupId)).proposalVisibleAt).not.toBeNull();
  return created;
}

function countEvent(meetupId: string, name: string): Promise<number> {
  return t.services.db.analyticsEvent.count({ where: { meetupId, name } });
}

async function eventOf(meetupId: string, name: string): Promise<EventRow> {
  const event = (await eventsFor(meetupId)).find((row) => row.name === name);
  if (event === undefined) {
    throw new Error(`no ${name} event was written for this meetup`);
  }
  return event;
}

async function depositStatuses(meetupId: string): Promise<string[]> {
  return [...(await depositsByOwner(meetupId)).values()].map((row) => row.status).sort();
}

async function operationsOf(
  meetupId: string,
  kind: 'hold' | 'release' | 'capture' | 'refund',
): Promise<{ readonly status: string }[]> {
  const deposits = await t.services.db.deposit.findMany({
    where: { meetupId },
    select: { id: true },
  });
  return t.services.db.paymentOperation.findMany({
    where: { depositId: { in: deposits.map((deposit) => deposit.id) }, kind },
    select: { status: true },
  });
}

async function intentsForDeposit(depositId: string): Promise<{ id: string; status: string }[]> {
  const proxy = t.stripe.proxy;
  if (proxy === null) {
    return [];
  }
  return proxy.paymentIntents({ metadata: { depositId } });
}

/**
 * Assert how many authorizations a deposit has at the provider, in mock mode alone: in `test` mode the deposit rows cover the
 * same rules.
 */
async function expectAttemptIntents(depositId: string, count: number): Promise<void> {
  if (!MOCK) {
    return;
  }
  expect(await intentsForDeposit(depositId)).toHaveLength(count);
}

/**
 * Assert one side's hold was cancelled by our own release and not lost, in mock mode alone: `OUR_CANCELLATION_REASON` is the
 * one reason Stripe reports that is not a hold loss.
 */
async function expectReleasedByUs(deposits: readonly DepositRow[]): Promise<void> {
  const proxy = t.stripe.proxy;
  if (proxy === null) {
    return;
  }
  for (const deposit of deposits) {
    const intents = await proxy.paymentIntents({ metadata: { depositId: deposit.id } });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.status).toBe('canceled');
    expect(intents[0]?.cancellation_reason).toBe(OUR_CANCELLATION_REASON);
  }
}

function hashOf(actor: ActorRef): string {
  return actorHash(t.env.ANALYTICS_SALT, actor.id);
}

interface NotificationRow {
  readonly kind: string | null;
  readonly userId: string | null;
}

async function notifications(): Promise<NotificationRow[]> {
  const written = await t.services.db.outboxMessage.findMany({
    where: { kind: 'notification' },
    select: { payload: true },
    orderBy: { createdAt: 'asc' },
  });
  return written.map((row) => {
    const payload = row.payload;
    if (typeof payload !== 'object' || payload === null) {
      return { kind: null, userId: null };
    }
    const { kind, userId } = payload as { kind?: unknown; userId?: unknown };
    return {
      kind: typeof kind === 'string' ? kind : null,
      userId: typeof userId === 'string' ? userId : null,
    };
  });
}

function jobAt(jobId: string) {
  return t.services.queues.get(QUEUE.settlement).getJob(jobId);
}

async function expectTimer(jobId: string, name: string, expectedDelayMs: number): Promise<number> {
  const job = await jobAt(jobId);
  expect(job?.name).toBe(name);
  const delay = job?.opts.delay ?? -1;
  // A second of slack: the job's delay is measured from the clock the handler read, which a case
  // that moved the clock between two requests can leave a few milliseconds behind.
  expect(Math.abs(delay - expectedDelayMs)).toBeLessThan(1_000);
  return delay;
}

/**
 * The PaymentIntents the proxy holds for one account's customer, in mock mode alone: in `test` mode the provider's objects are
 * the operator's own.
 */
async function intentsFor(user: UserFixture): Promise<{ id: string; status: string }[]> {
  const proxy = t.stripe.proxy;
  const customer = user.stripeCustomerId;
  if (proxy === null || customer === null) {
    return [];
  }
  return proxy.paymentIntents({ customer });
}

/**
 * Drop the next PaymentIntent create: the provider's answer to a hold never arrives, which is the ambiguous result whose effect
 * stands while no PaymentIntent id is known.
 *
 * A `fail` fault is used rather than `dropNextResponse`, which the proxy applies around an answer a loopback client can still
 * read: a 5xx is what makes the create's outcome unknown to us.
 */
async function failHoldCreate(): Promise<void> {
  const proxy = t.stripe.proxy;
  if (proxy === null) {
    throw new Error('the provider-failure cases need the mock topology');
  }
  await proxy.failNext({ method: 'POST', path: '/v1/payment_intents', status: 500 });
}

/** Stripe's published test method that attaches successfully and then refuses the charge. */
const STRIPE_DECLINED_CARD = 'pm_card_chargeCustomerFail';

async function attachCardTo(customer: string, card: string): Promise<void> {
  const proxy = t.stripe.proxy;
  if (proxy !== null) {
    if (!isProxyCard(card)) {
      throw new Error('the mock topology holds no such card fixture');
    }
    await proxy.attachCard(customer, card);
    return;
  }
  const api = stripeApi(t);
  const attached = await api.post<{ id: string }>(
    `/v1/payment_methods/${encodeURIComponent(card)}/attach`,
    { customer },
  );
  await api.post(`/v1/customers/${customer}`, {
    'invoice_settings[default_payment_method]': attached.id,
  });
}

async function attachCard(user: UserFixture, card: string): Promise<void> {
  const customer = user.stripeCustomerId;
  if (customer === null) {
    throw new Error('the fixture account has no customer to attach a card to');
  }
  await attachCardTo(customer, card);
}

/** The declining card fixture of this topology: the proxy's own id in `mock`, and Stripe's published
 * test method that attaches and then declines the charge in `test` (AAP 0.11.2). */
const DECLINED_CARD: string = MOCK ? TEST_CARDS.chargeDeclined : STRIPE_DECLINED_CARD;

const WORKING_CARD: string = TEST_CARDS.visa;

function isProxyCard(card: string): card is TestCardId {
  return Object.values(TEST_CARDS).some((id) => id === card);
}

async function setUpCard(actor: ActorRef, card: string): Promise<string> {
  const response = await callRoute(t.app, {
    method: 'POST',
    url: '/v1/me/payment-setup',
    as: await t.tokenFor(actor),
  });
  expect(response.status).toBe(200);
  const row = await t.services.db.user.findUniqueOrThrow({
    where: { id: actor.id },
    select: { stripeCustomerId: true },
  });
  if (row.stripeCustomerId === null) {
    throw new Error('the card setup stored no customer');
  }
  await attachCardTo(row.stripeCustomerId, card);
  return row.stripeCustomerId;
}

interface SelfProposalRow {
  readonly name: string;
  readonly overrides: ProposeOverrides;
}

/**
 * Three breaches that would each be refused on their own, put beside a proposal to the caller itself: the self check comes
 * first, before any read or write, so the answer is `self_proposal` every time (AAP 0.5.4).
 */
const SELF_PROPOSAL_BREACHES: readonly SelfProposalRow[] = [
  { name: 'an invalid deposit beside it', overrides: { depositCents: 1500 } },
  {
    name: 'a start in the past beside it',
    overrides: { startsAt: new Date(Date.parse(DEFAULT_TEST_NOW) - DAY_MS).toISOString() },
  },
  { name: 'an unknown venue beside it', overrides: { venueId: randomUUID() } },
];

interface NotFoundRow {
  readonly name: string;
  readonly missing: 'venue' | 'recipient' | 'blocked-by-recipient' | 'blocked-by-initiator';
}

/**
 * The two `404`s and the two blocks: a block in either direction answers exactly as a stranger does, which is what keeps a
 * block undiscoverable (AAP 0.5.3).
 */
const NOT_FOUND_ROWS: readonly NotFoundRow[] = [
  { name: 'an unknown venue with 404 venue_not_found', missing: 'venue' },
  { name: 'an unknown recipient with 404 user_not_found', missing: 'recipient' },
  {
    name: 'a recipient who blocked the initiator with 404 user_not_found',
    missing: 'blocked-by-recipient',
  },
  {
    name: 'a recipient the initiator blocked with 404 user_not_found',
    missing: 'blocked-by-initiator',
  },
];

interface NoProofRow {
  readonly name: string;
  readonly without: 'initiator' | 'recipient' | 'initiator-elsewhere';
}

/** Proposing needs a valid proof from both sides, for the venue's own city (AAP 0.5.4). */
const NO_PROOF_ROWS: readonly NoProofRow[] = [
  { name: 'an initiator with no valid proof', without: 'initiator' },
  { name: 'a recipient with no valid proof', without: 'recipient' },
  { name: 'an initiator whose proof is for another city', without: 'initiator-elsewhere' },
];

interface DepositRefusalRow {
  readonly name: string;
  readonly depositCents: number;
}

/** Only 500, 1000 and 2000 cents are deposits; everything else is `422 deposit_invalid`. */
const DEPOSIT_REFUSALS: readonly DepositRefusalRow[] = [
  { name: 'a deposit between two levels', depositCents: 1500 },
  { name: 'a deposit of zero', depositCents: 0 },
  { name: 'a deposit below the lowest level', depositCents: 499 },
];

interface HoldFailureRow {
  readonly name: string;
  readonly card: CardFixture;
}

/** No saved card and a refused card are both `402 hold_failed`, with the proposal standing. */
const HOLD_FAILURES: readonly HoldFailureRow[] = [
  { name: 'no saved card', card: 'none' },
  { name: 'a card the issuer refuses', card: 'declining' },
];

describe(`POST ${MEETUPS_URL} — the guard order and the hold (AAP 0.5.4)`, () => {
  it(`${MODE} answers 422 self_proposal and leaves no meetup, deposit or PaymentIntent`, async () => {
    const fixture = await proposal();
    const response = await propose(fixture.initiator, {
      ...proposeBody(fixture),
      recipientId: fixture.initiator.id,
    });
    expectError(response, 422, 'self_proposal');
    expect(await t.services.db.meetup.count()).toBe(0);
    expect(await t.services.db.deposit.count()).toBe(0);
    expect(await t.services.db.paymentOperation.count()).toBe(0);
    if (MOCK) {
      expect(await intentsFor(fixture.initiator)).toHaveLength(0);
    }
  });

  it.each(rows(SELF_PROPOSAL_BREACHES))(
    `${MODE} answers 422 self_proposal for a proposal to the caller with $name`,
    async (entry) => {
      const fixture = await proposal();
      const response = await propose(fixture.initiator, {
        ...proposeBody(fixture, entry.overrides),
        recipientId: fixture.initiator.id,
      });
      expectError(response, 422, 'self_proposal');
      expect(await t.services.db.meetup.count()).toBe(0);
    },
  );
  it.each(rows(NOT_FOUND_ROWS))(`${MODE} refuses $name`, async (entry) => {
    const fixture = await proposal();
    let body = proposeBody(fixture);
    let code: ErrorCode = 'user_not_found';
    if (entry.missing === 'venue') {
      body = proposeBody(fixture, { venueId: randomUUID() });
      code = 'venue_not_found';
    } else if (entry.missing === 'recipient') {
      body = proposeBody(fixture, { recipientId: randomUUID() });
    } else if (entry.missing === 'blocked-by-recipient') {
      await makeBlock(t, fixture.recipient, fixture.initiator);
    } else {
      await makeBlock(t, fixture.initiator, fixture.recipient);
    }
    expectError(await propose(fixture.initiator, body), 404, code);
    expect(await t.services.db.meetup.count()).toBe(0);
  });

  it.each(rows(NO_PROOF_ROWS))(`${MODE} refuses a proposal with $name`, async (entry) => {
    const initiator = await makeUser(t);
    const recipient = await makeUser(t);
    const venue = await makeVenue(t, { cityId: CITY });
    if (entry.without === 'initiator') {
      await makeProof(t, recipient, { cityId: CITY });
    } else if (entry.without === 'recipient') {
      await makeProof(t, initiator, { cityId: CITY });
    } else {
      await makeProof(t, initiator, { cityId: OTHER_CITY });
      await makeProof(t, recipient, { cityId: CITY });
    }
    expectError(await propose(initiator, bodyAmong(recipient, venue)), 403, 'no_valid_proof');
    expect(await t.services.db.meetup.count()).toBe(0);
  });

  it(`${MODE} refuses a proposal at a venue that is not an active partner`, async () => {
    const fixture = await proposal();
    const inactive = await makeVenue(t, { cityId: CITY, isActivePartner: false });
    expectError(
      await propose(fixture.initiator, proposeBody(fixture, { venueId: inactive.id })),
      422,
      'venue_not_partner',
    );
    expect(await t.services.db.meetup.count()).toBe(0);
  });

  it(`${MODE} refuses a start in the past, and one past the five-day horizon`, async () => {
    const fixture = await proposal();
    const now = t.time.now();
    expectError(
      await propose(fixture.initiator, {
        ...proposeBody(fixture),
        startsAt: new Date(now.getTime() - DAY_MS).toISOString(),
      }),
      422,
      'starts_at_invalid',
    );
    expectError(
      await propose(fixture.initiator, {
        ...proposeBody(fixture),
        startsAt: new Date(now.getTime() + START_HORIZON_DAYS * DAY_MS + 60_000).toISOString(),
      }),
      422,
      'starts_at_invalid',
    );
    expect(await t.services.db.meetup.count()).toBe(0);
  });

  it(`${MODE} accepts a start at exactly five days, the far end of the horizon`, async () => {
    const fixture = await proposal();
    const startsAt = new Date(t.time.now().getTime() + START_HORIZON_DAYS * DAY_MS);
    const response = await propose(fixture.initiator, {
      ...proposeBody(fixture),
      startsAt: startsAt.toISOString(),
    });
    expect(response.status).toBe(201);
    expect(ProposeResponse.parse(response.json()).status).toBe('proposed');
  });

  it.each(rows(DEPOSIT_REFUSALS))(`${MODE} refuses $name`, async (entry) => {
    const fixture = await proposal();
    expectError(
      await propose(fixture.initiator, proposeBody(fixture, { depositCents: entry.depositCents })),
      422,
      'deposit_invalid',
    );
    expect(await t.services.db.meetup.count()).toBe(0);
  });

  it(`${MODE} refuses a second proposal for a pair that already has one open`, async () => {
    const fixture = await proposal();
    expect((await propose(fixture.initiator, proposeBody(fixture))).status).toBe(201);
    // The open meetup is found in either initiator/recipient order (AAP 0.5.2).
    expectError(await propose(fixture.initiator, proposeBody(fixture)), 409, 'meetup_exists');
    expectError(
      await propose(fixture.recipient, bodyAmong(fixture.initiator, fixture.venue)),
      409,
      'meetup_exists',
    );
    expect(await t.services.db.meetup.count()).toBe(1);
  });

  it.each(rows(HOLD_FAILURES))(
    `${MODE} answers 402 hold_failed for $name and keeps the proposal standing`,
    async (entry) => {
      const initiator = await makeUser(t, { card: entry.card });
      const recipient = await makeUser(t);
      await makeProof(t, initiator, { cityId: CITY });
      await makeProof(t, recipient, { cityId: CITY });
      const venue = await makeVenue(t, { cityId: CITY });
      expectError(await propose(initiator, bodyAmong(recipient, venue)), 402, 'hold_failed');
      // The meetup survived the refusal, invisible to the recipient, and the initiator recovers it
      // from its own list — where it shows the failed hold and the retry it needs (AAP 0.5.4).
      const meetupId = await onlyMeetupId();
      const stored = await meetupRow(meetupId);
      expect(stored.status).toBe('proposed');
      expect(stored.proposalVisibleAt).toBeNull();
      expect((await depositOf(meetupId, initiator)).status).toBe('failed');
      const own = await listMeetups(initiator, { role: 'initiator', status: 'proposed' });
      expect(own.status).toBe(200);
      const page = MeetupListResponse.parse(own.json());
      expect(page.items.map((item) => item.id)).toEqual([meetupId]);
      expect(page.items[0]?.initiatorHold).toBe('failed');
      expect(page.items[0]?.nextAction).toBe('retry_hold');
      // The recipient sees nothing at all: neither the detail nor their own list (AAP 0.5.3).
      expectError(await readMeetup(recipient, meetupId), 404, 'meetup_not_found');
      const theirs = await listMeetups(recipient);
      expect(MeetupListResponse.parse(theirs.json()).items).toHaveLength(0);
    },
  );
  it.runIf(MOCK)(
    `${MODE} answers 503 payment_unavailable when the hold create's answer is lost`,
    async () => {
      const fixture = await proposal();
      await failHoldCreate();
      expectError(
        await propose(fixture.initiator, proposeBody(fixture)),
        503,
        'payment_unavailable',
      );
      const meetupId = await onlyMeetupId();
      const stored = await meetupRow(meetupId);
      expect(stored.status).toBe('proposed');
      expect(stored.proposalVisibleAt).toBeNull();
      expect((await depositOf(meetupId, fixture.initiator)).status).toBe('pending');
      // One attempt, and no second authorization: the deposit stays pending until the replay
      // resolves it, and the client recovers through its own list (AAP 0.3.2).
      expect(await t.services.db.deposit.count()).toBe(1);
      const own = await listMeetups(fixture.initiator, { role: 'initiator' });
      expect(MeetupListResponse.parse(own.json()).items[0]?.initiatorHold).toBe('pending');
    },
  );
});

function instantOf(value: Date | null): number {
  if (value === null) {
    throw new Error('the expected instant was not written');
  }
  return value.getTime();
}

interface DeadlineRow {
  readonly name: string;
  readonly aheadMs: number;
  readonly expected: 'now+48h' | 'startsAt';
}

/** The recipient deadline is the earlier of 48 hours out and the start itself (AAP 0.7.3). */
const DEADLINE_ROWS: readonly DeadlineRow[] = [
  { name: 'a start three days out', aheadMs: 3 * DAY_MS, expected: 'now+48h' },
  { name: 'a start inside 48 hours', aheadMs: 24 * HOUR_MS, expected: 'startsAt' },
];

describe(`POST ${MEETUPS_URL} — the proposal that succeeds (AAP 0.5.3, 0.5.7)`, () => {
  it(`${MODE} answers 201 with the caller's own secret and makes the proposal visible`, async () => {
    const fixture = await proposal();
    const now = t.time.now();
    const response = await propose(fixture.initiator, proposeBody(fixture));
    expect(response.status).toBe(201);
    const created = ProposeResponse.parse(response.json());
    expect(created.status).toBe('proposed');
    expect(created.clientSecret).not.toBe('');
    const stored = await meetupRow(created.meetupId);
    expect(stored.status).toBe('proposed');
    expect(instantOf(stored.proposalVisibleAt)).toBe(now.getTime());
    expect(stored.depositCents).toBe(DEFAULT_DEPOSIT_CENTS);
    expect(stored.lockedAt).toBeNull();
    expect(stored.finalAt).toBeNull();
    expect((await depositOf(created.meetupId, fixture.initiator)).status).toBe('held');
    // The recipient can see it now, and reads their own side of it: nothing held, and the
    // acceptance as the one thing left to do (AAP 0.5.4).
    const detail = await readMeetup(fixture.recipient, created.meetupId);
    expect(detail.status).toBe(200);
    const dto = MeetupDto.parse(detail.json());
    expect(dto.role).toBe('recipient');
    expect(dto.initiatorHold).toBe('held');
    expect(dto.recipientHold).toBe('none');
    expect(dto.nextAction).toBe('accept');
    expect(dto.lateCancelFrom).toBe(
      new Date(fixture.startsAt.getTime() - LATE_CANCEL_WINDOW_HOURS * HOUR_MS).toISOString(),
    );
  });

  it.each(rows(DEADLINE_ROWS))(
    `${MODE} gives $name the earlier of 48 hours and the start, and moves the lapse to it`,
    async (entry) => {
      const now = t.time.now();
      const fixture = await proposal({ startsAt: new Date(now.getTime() + entry.aheadMs) });
      const response = await propose(fixture.initiator, proposeBody(fixture));
      expect(response.status).toBe(201);
      const meetupId = ProposeResponse.parse(response.json()).meetupId;
      const stored = await meetupRow(meetupId);
      const expected =
        entry.expected === 'now+48h'
          ? now.getTime() + RECIPIENT_DEADLINE_HOURS * HOUR_MS
          : fixture.startsAt.getTime();
      expect(instantOf(stored.recipientDeadline)).toBe(expected);
      expect(instantOf(stored.recipientDeadline)).toBeLessThanOrEqual(fixture.startsAt.getTime());
      // The lapse timer is armed at the stored `recipientDeadline`, the earlier of 48 hours and the
      // start (AAP 0.5.3).
      await expectTimer(lapseJobId(meetupId), JOB.settlement.lapse, expected - now.getTime());
    },
  );
  it(`${MODE} notifies the recipient and records the funnel's proposal_sent once`, async () => {
    const fixture = await proposal();
    const created = ProposeResponse.parse(
      (await propose(fixture.initiator, proposeBody(fixture))).json(),
    );
    expect(await notifications()).toEqual([
      { kind: NotificationKind.enum.proposal_received, userId: fixture.recipient.id },
    ]);
    const events = await eventsFor(created.meetupId);
    expect(events.map((event) => event.name)).toEqual(['proposal_sent']);
    expect(events[0]?.actorHash).toBe(hashOf(fixture.initiator));
    expect(events[0]?.cityId).toBe(CITY);
    // The pair's framing variant is fixed here and never recomputed (AAP 0.5.7).
    const stored = await meetupRow(created.meetupId);
    expect(VariantPairing.options).toContain(stored.variantPairing);
    expect(events[0]?.props).toMatchObject({
      variantPairing: stored.variantPairing,
      depositCents: DEFAULT_DEPOSIT_CENTS,
    });
  });

  it(`${MODE} leaves the proposal invisible while the initiator's card waits on 3-D Secure`, async () => {
    const fixture = await proposal({ card: '3ds' });
    const response = await propose(fixture.initiator, proposeBody(fixture));
    expect(response.status).toBe(201);
    const created = ProposeResponse.parse(response.json());
    const meetupId = created.meetupId;
    const stored = await meetupRow(meetupId);
    expect(stored.proposalVisibleAt).toBeNull();
    expect(stored.recipientDeadline).toBeNull();
    expect((await depositOf(meetupId, fixture.initiator)).status).toBe('requires_action');
    if (MOCK) {
      const intents = await intentsFor(fixture.initiator);
      expect(intents).toHaveLength(1);
      expect(intents[0]?.status).toBe('requires_action');
      // The secret belongs to the caller's own attempt, and to no other (AAP 0.5.4).
      expect(created.clientSecret.startsWith(intents[0]?.id ?? '')).toBe(true);
    }
    expectError(await readMeetup(fixture.recipient, meetupId), 404, 'meetup_not_found');
    const own = await listMeetups(fixture.initiator, { role: 'initiator' });
    const item = MeetupListResponse.parse(own.json()).items[0];
    expect(item?.initiatorHold).toBe('requires_action');
    expect(item?.nextAction).toBe('confirm_hold');
    // The invisible window still carries its own lapse, at `createdAt + 48 h` (AAP 0.5.3).
    await expectTimer(
      lapseJobId(meetupId),
      JOB.settlement.lapse,
      RECIPIENT_DEADLINE_HOURS * HOUR_MS,
    );
  });
});

interface ActorRow {
  readonly name: string;
  readonly actor: 'initiator' | 'stranger';
  readonly httpStatus: number;
  readonly code: ErrorCode;
}

/** Acceptance is the recipient's alone: the initiator and a stranger are both `403 not_recipient`. */
const NOT_RECIPIENT_ROWS: readonly ActorRow[] = [
  { name: 'the initiator', actor: 'initiator', httpStatus: 403, code: 'not_recipient' },
  { name: 'a stranger', actor: 'stranger', httpStatus: 403, code: 'not_recipient' },
];

/**
 * A decline is the recipient's alone too. The initiator is `403 not_recipient`; a stranger is answered `404 meetup_not_found`,
 * exactly as a proposal that is not yet visible is, so the route cannot be used to probe for one (AAP 0.5.3).
 */
const DECLINE_REFUSALS: readonly ActorRow[] = [
  { name: 'the initiator', actor: 'initiator', httpStatus: 403, code: 'not_recipient' },
  { name: 'a stranger', actor: 'stranger', httpStatus: 404, code: 'meetup_not_found' },
];

interface StatusRow {
  readonly name: string;
  readonly status: MeetupStatus;
}

/** A `locked` meetup has both holds and a final one has decided its money, so both are `409`. */
const NOT_PROPOSED_ROWS: readonly StatusRow[] = [
  { name: 'a locked meetup', status: 'locked' },
  { name: 'a cancelled meetup', status: 'cancelled' },
];

describe(`POST ${MEETUPS_URL}/:id/accept — the lock (AAP 0.5.3, 0.5.4)`, () => {
  it(`${MODE} answers 404 meetup_not_found for an unknown meetup`, async () => {
    const fixture = await proposal();
    expectError(await accept(fixture.recipient, randomUUID()), 404, 'meetup_not_found');
  });

  it.each(rows(NOT_RECIPIENT_ROWS))(
    `${MODE} refuses $name with 403 not_recipient`,
    async (entry) => {
      const fixture = await proposal();
      const created = await visibleProposal(fixture);
      const actor = entry.actor === 'initiator' ? fixture.initiator : await makeUser(t);
      expectError(await accept(actor, created.meetupId), entry.httpStatus, entry.code);
      expect((await meetupRow(created.meetupId)).status).toBe('proposed');
      expect(await t.services.db.deposit.count({ where: { role: 'recipient' } })).toBe(0);
    },
  );
  it(`${MODE} answers 410 proposal_lapsed past the deadline no pass has acted on`, async () => {
    const fixture = await proposal();
    const created = await visibleProposal(fixture);
    // One hour past the 48-hour deadline, with no background pass running in a suite: the meetup is
    // still `proposed`, so the refusal is the deadline's and not a stored status's (AAP 0.5.4).
    t.time.advance({ hours: RECIPIENT_DEADLINE_HOURS + 1 });
    expect((await meetupRow(created.meetupId)).status).toBe('proposed');
    expectError(await accept(fixture.recipient, created.meetupId), 410, 'proposal_lapsed');
    expect(await t.services.db.deposit.count({ where: { role: 'recipient' } })).toBe(0);
  });

  it(`${MODE} answers 410 proposal_lapsed for a proposal already stored as lapsed`, async () => {
    const fixture = await proposal();
    const meetup = await makeMeetup(t, {
      status: 'lapsed',
      initiator: fixture.initiator,
      recipient: fixture.recipient,
      venue: fixture.venue,
    });
    expectError(await accept(fixture.recipient, meetup.id), 410, 'proposal_lapsed');
  });

  it.each(rows(NOT_PROPOSED_ROWS))(`${MODE} answers 409 not_proposed for $name`, async (entry) => {
    const fixture = await proposal();
    const meetup = await makeMeetup(t, {
      status: entry.status,
      initiator: fixture.initiator,
      recipient: fixture.recipient,
      venue: fixture.venue,
      startsAt: fixture.startsAt,
    });
    expectError(await accept(fixture.recipient, meetup.id), 409, 'not_proposed');
  });

  it(`${MODE} locks the meetup, records the funnel and schedules both locked timers`, async () => {
    const fixture = await proposal();
    const created = await visibleProposal(fixture);
    const now = t.time.now();
    const response = await accept(fixture.recipient, created.meetupId);
    expect(response.status).toBe(200);
    const accepted = AcceptResponse.parse(response.json());
    expect(accepted.status).toBe('locked');
    expect(accepted.clientSecret).not.toBe('');
    const stored = await meetupRow(created.meetupId);
    expect(stored.status).toBe('locked');
    expect(instantOf(stored.lockedAt)).toBe(now.getTime());
    expect(instantOf(stored.recipientAcceptedAt)).toBe(now.getTime());
    expect(stored.finalAt).toBeNull();
    // Both sides hold their deposit, and neither was charged anything (AAP 0.5.3).
    const deposits = await depositsByOwner(created.meetupId);
    expect(deposits.get(fixture.initiator.id)?.status).toBe('held');
    expect(deposits.get(fixture.recipient.id)?.status).toBe('held');
    // The funnel: one acceptance, the recipient's own lock, and one `meetup_locked` per participant
    // (AAP 0.5.7). Counted rather than ordered, because the injected clock is frozen and every row
    // of one request shares its instant.
    expect(await countEvent(created.meetupId, 'proposal_accepted')).toBe(1);
    expect(await countEvent(created.meetupId, 'deposit_locked')).toBe(1);
    expect(await countEvent(created.meetupId, 'meetup_locked')).toBe(2);
    expect((await eventOf(created.meetupId, 'proposal_accepted')).actorHash).toBe(
      hashOf(fixture.recipient),
    );
    expect((await eventOf(created.meetupId, 'deposit_locked')).actorHash).toBe(
      hashOf(fixture.recipient),
    );
    const lockedEvents = (await eventsFor(created.meetupId)).filter(
      (event) => event.name === 'meetup_locked',
    );
    expect(lockedEvents.map((event) => event.actorHash).sort()).toEqual(
      [hashOf(fixture.initiator), hashOf(fixture.recipient)].sort(),
    );
    // Both parties are told, and a locked meetup owes no proposal deadline any more.
    const notified = await notifications();
    expect(
      notified
        .filter((row) => row.kind === NotificationKind.enum.meetup_locked)
        .map((row) => row.userId)
        .sort(),
    ).toEqual([fixture.initiator.id, fixture.recipient.id].sort());
    expect(instantOf(stored.recipientDeadline)).toBe(
      instantOf(stored.proposalVisibleAt) + RECIPIENT_DEADLINE_HOURS * HOUR_MS,
    );
    // The reminder opens the check-in window and the settlement closes it (AAP 0.5.3).
    await expectTimer(
      remindJobId(created.meetupId),
      JOB.settlement.remind,
      fixture.startsAt.getTime() - CHECK_IN_OPENS_BEFORE_MINUTES * MINUTE_MS - now.getTime(),
    );
    await expectTimer(
      settleJobId(created.meetupId),
      JOB.settlement.settle,
      fixture.startsAt.getTime() + CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS - now.getTime(),
    );
  });

  it(`${MODE} answers proposed with the recipient's own secret while 3-D Secure is pending`, async () => {
    const fixture = await proposal({ recipientCard: '3ds' });
    const created = await visibleProposal(fixture);
    const first = await accept(fixture.recipient, created.meetupId);
    expect(first.status).toBe(200);
    const answered = AcceptResponse.parse(first.json());
    expect(answered.status).toBe('proposed');
    const deposit = await depositOf(created.meetupId, fixture.recipient);
    expect(deposit.status).toBe('requires_action');
    expect(deposit.currentAttempt).toBe(1);
    // The secret is the recipient's own attempt's, and never the initiator's (AAP 0.5.4).
    expect(answered.clientSecret).not.toBe(created.clientSecret);
    if (MOCK) {
      const intents = await intentsForDeposit(deposit.id);
      expect(intents).toHaveLength(1);
      expect(intents[0]?.status).toBe('requires_action');
      expect(answered.clientSecret.startsWith(intents[0]?.id ?? '')).toBe(true);
      expect(
        answered.clientSecret.startsWith(created.clientSecret.replace(/_secret_.*$/, '')),
      ).toBe(false);
    }
    // A repeated accept returns the same secret and creates no second authorization.
    const second = await accept(fixture.recipient, created.meetupId);
    expect(second.status).toBe(200);
    expect(AcceptResponse.parse(second.json()).clientSecret).toBe(answered.clientSecret);
    expect(await t.services.db.deposit.count({ where: { role: 'recipient' } })).toBe(1);
    expect((await meetupRow(created.meetupId)).status).toBe('proposed');
    await expectAttemptIntents(deposit.id, 1);
  });

  it(`${MODE} retries a refused recipient card, releasing the attempt it superseded and locking`, async () => {
    const fixture = await proposal({ recipientCard: 'declining' });
    const created = await visibleProposal(fixture);
    expectError(await accept(fixture.recipient, created.meetupId), 402, 'hold_failed');
    // The meetup is unchanged, the refusal is recoverable, and the failed attempt stands alone.
    expect((await meetupRow(created.meetupId)).status).toBe('proposed');
    const failed = await depositOf(created.meetupId, fixture.recipient);
    expect(failed.status).toBe('failed');
    expect(failed.currentAttempt).toBe(1);
    // The retry supersedes that attempt: this request carries the release out and then places attempt
    // 2 behind it, so the answer is that attempt's own secret — and the money has moved by the time
    // the client reads the meetup again (AAP 0.3.2, 0.5.4).
    await attachCard(fixture.recipient, WORKING_CARD);
    const response = await accept(fixture.recipient, created.meetupId);
    expect(response.status, `the retry accept answered ${response.body}`).toBe(200);
    const answered = AcceptResponse.parse(response.json());
    expect(answered.status).toBe('locked');
    expect(answered.clientSecret.length).toBeGreaterThan(0);
    const retried = await depositOf(created.meetupId, fixture.recipient);
    expect(retried.status).toBe('held');
    expect(retried.currentAttempt).toBe(2);
    const releases = await t.services.db.paymentOperation.findMany({
      where: { depositId: failed.id, kind: 'release' },
      select: { status: true },
    });
    expect(releases.map((row) => row.status)).toEqual(['succeeded']);
    expect(await t.services.db.deposit.count({ where: { role: 'recipient' } })).toBe(1);
    // The lock is what that recovery left, and a further accept has nothing to place on it.
    const stored = await meetupRow(created.meetupId);
    expect(stored.status).toBe('locked');
    expect(instantOf(stored.lockedAt)).toBe(t.time.now().getTime());
    expectError(await accept(fixture.recipient, created.meetupId), 409, 'not_proposed');
  });

  it(`${MODE} answers 409 hold_pending while the recipient's attempt is unresolved, writing nothing`, async () => {
    const fixture = await proposal();
    // The rows an unresolved create leaves: a planned, unsent attempt for the recipient's side.
    const meetup = await makeMeetup(t, {
      status: 'proposed',
      initiator: fixture.initiator,
      recipient: fixture.recipient,
      venue: fixture.venue,
      deposits: { initiator: 'held', recipient: 'pending' },
    });
    expectError(await accept(fixture.recipient, meetup.id), 409, 'hold_pending');
    // Nothing was written: the acceptance is recorded in the transaction that decides the attempt.
    const stored = await meetupRow(meetup.id);
    expect(stored.status).toBe('proposed');
    expect(stored.recipientAcceptedAt).toBeNull();
    expect(await countEvent(meetup.id, 'proposal_accepted')).toBe(0);
    const deposit = await depositOf(meetup.id, fixture.recipient);
    expect(deposit.status).toBe('pending');
    expect(deposit.currentAttempt).toBe(1);
  });
  it.runIf(MOCK)(
    `${MODE} answers 503 payment_unavailable when the recipient's first create is unresolved`,
    async () => {
      const fixture = await proposal();
      const created = await visibleProposal(fixture);
      await failHoldCreate();
      expectError(await accept(fixture.recipient, created.meetupId), 503, 'payment_unavailable');
      // One attempt, and never a second authorization for the same side (AAP 0.5.4). The replay of
      // AAP 0.3.2 runs in this same request, so the client's next read shows what it left.
      const deposit = await depositOf(created.meetupId, fixture.recipient);
      expect(deposit.currentAttempt).toBe(1);
      expect(deposit.status).toBe('held');
      expect(await t.services.db.deposit.count({ where: { role: 'recipient' } })).toBe(1);
      const detail = MeetupDto.parse(
        (await readMeetup(fixture.recipient, created.meetupId)).json(),
      );
      expect(detail.recipientHold).toBe('held');
      expect(detail.initiatorHold).toBe('held');
    },
  );
});

interface CancelRefusalRow {
  readonly name: string;
  readonly situation: 'stranger' | 'unknown' | 'settled' | 'dispute';
  readonly httpStatus: number;
  readonly code: ErrorCode;
}

const CANCEL_REFUSALS: readonly CancelRefusalRow[] = [
  { name: 'a stranger', situation: 'stranger', httpStatus: 403, code: 'not_participant' },
  { name: 'an unknown meetup', situation: 'unknown', httpStatus: 404, code: 'meetup_not_found' },
  { name: 'a settled meetup', situation: 'settled', httpStatus: 409, code: 'already_settled' },
  {
    name: 'a locked meetup whose dispute is open',
    situation: 'dispute',
    httpStatus: 409,
    code: 'dispute_open',
  },
];

/** Which side withdraws an unanswered proposal, and the reason it records (AAP 0.5.3). */
const PROPOSAL_CANCELLERS: readonly ParticipantRole[] = ['initiator', 'recipient'];

interface BoundaryRow {
  readonly name: string;
  readonly canceller: ParticipantRole;
  readonly offsetMs: number;
  readonly late: boolean;
}

/**
 * The boundary AAP 0.5.3 states exactly: at `startsAt − 2 h` a cancellation is free and one second later it forfeits the
 * canceller's hold, for either participant.
 */
const CANCELLATION_BOUNDARY: readonly BoundaryRow[] = [
  {
    name: 'the initiator at exactly two hours before the start',
    canceller: 'initiator',
    offsetMs: 0,
    late: false,
  },
  {
    name: 'the initiator one second past it',
    canceller: 'initiator',
    offsetMs: 1_000,
    late: true,
  },
  {
    name: 'the recipient at exactly two hours before the start',
    canceller: 'recipient',
    offsetMs: 0,
    late: false,
  },
  {
    name: 'the recipient one second past it',
    canceller: 'recipient',
    offsetMs: 1_000,
    late: true,
  },
];

interface HoldRetryRow {
  readonly name: string;
  readonly caller: 'initiator' | 'recipient' | 'stranger';
  readonly locked: boolean;
  readonly httpStatus: number;
  readonly code: ErrorCode;
}

const HOLD_RETRY_REFUSALS: readonly HoldRetryRow[] = [
  {
    name: 'a stranger',
    caller: 'stranger',
    locked: false,
    httpStatus: 403,
    code: 'not_participant',
  },
  {
    name: 'the recipient, whose own side is accept',
    caller: 'recipient',
    locked: false,
    httpStatus: 403,
    code: 'not_initiator',
  },
  {
    name: 'the initiator of a locked meetup',
    caller: 'initiator',
    locked: true,
    httpStatus: 409,
    code: 'not_proposed',
  },
];

describe(`POST ${MEETUPS_URL}/:id/decline and /cancel (AAP 0.5.3, 0.5.4)`, () => {
  it.each(rows(DECLINE_REFUSALS))(`${MODE} refuses a decline by $name`, async (entry) => {
    const fixture = await proposal();
    const created = await visibleProposal(fixture);
    const actor = entry.actor === 'initiator' ? fixture.initiator : await makeUser(t);
    expectError(await decline(actor, created.meetupId), entry.httpStatus, entry.code);
    expect((await meetupRow(created.meetupId)).status).toBe('proposed');
  });

  it(`${MODE} refuses a decline of a meetup that is no longer proposed`, async () => {
    const fixture = await proposal();
    const { meetupId } = await proposeAndLock(t, {
      initiator: fixture.initiator,
      recipient: fixture.recipient,
      venue: fixture.venue,
      startsAt: fixture.startsAt,
    });
    expectError(await decline(fixture.recipient, meetupId), 409, 'not_proposed');
    expect((await meetupRow(meetupId)).status).toBe('locked');
  });

  it(`${MODE} declines a proposal, releases every non-final attempt and notifies the initiator`, async () => {
    const fixture = await proposal();
    const created = await visibleProposal(fixture);
    const response = await decline(fixture.recipient, created.meetupId);
    expect(response.status).toBe(200);
    expect(DeclineResponse.parse(response.json()).status).toBe('declined');
    const stored = await meetupRow(created.meetupId);
    expect(stored.status).toBe('declined');
    expect(stored.finalAt).not.toBeNull();
    expect(await depositStatuses(created.meetupId)).toEqual(['released']);
    const releases = await operationsOf(created.meetupId, 'release');
    expect(releases.map((row) => row.status)).toEqual(['succeeded']);
    expect(await operationsOf(created.meetupId, 'capture')).toHaveLength(0);
    // The refusal names the recipient, and the initiator is told their proposal is off (AAP 0.5.3).
    expect((await eventOf(created.meetupId, 'proposal_declined')).actorHash).toBe(
      hashOf(fixture.recipient),
    );
    const notified = await notifications();
    expect(notified.filter((row) => row.kind === NotificationKind.enum.proposal_declined)).toEqual([
      { kind: NotificationKind.enum.proposal_declined, userId: fixture.initiator.id },
    ]);
    // No timer survives a final status (AAP 0.5.3).
    expect(await jobAt(lapseJobId(created.meetupId))).toBeUndefined();
    expect(await jobAt(settleJobId(created.meetupId))).toBeUndefined();
    expect(await jobAt(remindJobId(created.meetupId))).toBeUndefined();
  });

  it.each(rows(CANCEL_REFUSALS))(`${MODE} refuses a cancellation by $name`, async (entry) => {
    const fixture = await proposal();
    let meetupId: string;
    let actor: ActorRef = fixture.initiator;
    if (entry.situation === 'unknown') {
      meetupId = randomUUID();
    } else if (entry.situation === 'settled') {
      const settled = await makeMeetup(t, {
        status: 'completed',
        initiator: fixture.initiator,
        recipient: fixture.recipient,
        venue: fixture.venue,
      });
      meetupId = settled.id;
    } else {
      const locked = await proposeAndLock(t, {
        initiator: fixture.initiator,
        recipient: fixture.recipient,
        venue: fixture.venue,
        startsAt: fixture.startsAt,
      });
      meetupId = locked.meetupId;
      if (entry.situation === 'stranger') {
        actor = await makeUser(t);
      }
      if (entry.situation === 'dispute') {
        await makeDispute(t, { id: meetupId }, fixture.initiator, { kind: 'venue_unavailable' });
      }
    }
    expectError(await cancel(actor, meetupId), entry.httpStatus, entry.code);
  });

  it.each(rows(PROPOSAL_CANCELLERS))(
    `${MODE} cancels an unanswered proposal for free when the %s withdraws it`,
    async (role) => {
      const fixture = await proposal();
      const created = await visibleProposal(fixture);
      const canceller = role === 'initiator' ? fixture.initiator : fixture.recipient;
      const response = await cancel(canceller, created.meetupId);
      expect(response.status).toBe(200);
      expect(CancelResponse.parse(response.json()).lateCancel).toBe(false);
      const stored = await meetupRow(created.meetupId);
      expect(stored.status).toBe('cancelled');
      expect(stored.cancelReason).toBe(role);
      expect(stored.forfeitReason).toBeNull();
      expect(await depositStatuses(created.meetupId)).toEqual(['released']);
      expect(await t.services.db.meetupSettlement.count()).toBe(0);
      expect(await t.services.db.tableCreditEntry.count()).toBe(0);
      // A proposal withdrawn before it locked names no `cancelled_early`: only a locked one does.
      expect(await countEvent(created.meetupId, 'cancelled_early')).toBe(0);
    },
  );
  it.each(rows(CANCELLATION_BOUNDARY))(
    `${MODE} cancellation by $name is late: $late`,
    async (entry) => {
      const fixture = await proposal();
      const { meetupId } = await proposeAndLock(t, {
        initiator: fixture.initiator,
        recipient: fixture.recipient,
        venue: fixture.venue,
        startsAt: fixture.startsAt,
      });
      const canceller = entry.canceller === 'initiator' ? fixture.initiator : fixture.recipient;
      const counterpart = entry.canceller === 'initiator' ? fixture.recipient : fixture.initiator;
      // Exactly on the boundary, and one second past it, on the injected clock (AAP 0.5.3).
      t.time.toMeetupPoint({ startsAt: fixture.startsAt }, 'startsAt-2h', entry.offsetMs);
      const cancelledAt = t.time.now();
      const response = await cancel(canceller, meetupId);
      expect(response.status).toBe(200);
      expect(CancelResponse.parse(response.json()).lateCancel).toBe(entry.late);
      const stored = await meetupRow(meetupId);
      expect(instantOf(stored.finalAt)).toBe(cancelledAt.getTime());
      const deposits = await depositsByOwner(meetupId);
      await settleNow(t.services);
      if (!entry.late) {
        // A free cancellation releases both holds, and names the caller's own side as the reason.
        expect(stored.status).toBe('cancelled');
        expect(stored.cancelReason).toBe(entry.canceller);
        expect(stored.forfeitReason).toBeNull();
        expect(await depositStatuses(meetupId)).toEqual(['released', 'released']);
        expect((await operationsOf(meetupId, 'release')).map((row) => row.status)).toEqual([
          'succeeded',
          'succeeded',
        ]);
        expect(await operationsOf(meetupId, 'capture')).toHaveLength(0);
        expect(await t.services.db.meetupSettlement.count({ where: { meetupId } })).toBe(0);
        expect(await t.services.db.tableCreditEntry.count({ where: { meetupId } })).toBe(0);
        expect(await countEvent(meetupId, 'cancelled_early')).toBe(1);
        expect(await countEvent(meetupId, 'cancelled_late')).toBe(0);
        expect(await countEvent(meetupId, 'no_show')).toBe(0);
        expect((await eventOf(meetupId, 'cancelled_early')).actorHash).toBe(hashOf(canceller));
        await expectReleasedByUs([...deposits.values()]);
      } else {
        // A late cancellation forfeits the canceller and credits the counterpart (AAP 0.5.3, 0.5.7).
        expect(stored.status).toBe('forfeited');
        expect(stored.forfeitReason).toBe('late_cancel');
        // It reaches `forfeited` through the settlement, so it records the forfeit and not an
        // early cancellation's reason.
        expect(stored.cancelReason).toBeNull();
        const settlement = await t.services.db.meetupSettlement.findUniqueOrThrow({
          where: { meetupId },
          select: { outcome: true, status: true, appliedAt: true },
        });
        expect(settlement.outcome).toBe('late_cancel');
        expect(settlement.status).toBe('complete');
        expect(settlement.appliedAt).not.toBeNull();
        expect(
          await t.services.db.tableCreditEntry.findMany({
            where: { meetupId },
            select: { userId: true, kind: true, amountCents: true },
          }),
        ).toEqual([{ userId: counterpart.id, kind: 'grant', amountCents: DEFAULT_DEPOSIT_CENTS }]);
        expect(await countEvent(meetupId, 'cancelled_late')).toBe(1);
        expect(await countEvent(meetupId, 'no_show')).toBe(1);
        expect((await eventOf(meetupId, 'cancelled_late')).actorHash).toBe(hashOf(canceller));
        expect((await eventOf(meetupId, 'no_show')).actorHash).toBe(hashOf(canceller));
        expect(await countEvent(meetupId, 'cancelled_early')).toBe(0);
        expect(depositIn(deposits, canceller).status).toBe('captured');
        expect(depositIn(deposits, counterpart).status).toBe('released');
        await expectReleasedByUs([depositIn(deposits, counterpart)]);
      }
      // Either way the meetup keeps no timer once it is final (AAP 0.5.3).
      expect(await jobAt(settleJobId(meetupId))).toBeUndefined();
      expect(await jobAt(remindJobId(meetupId))).toBeUndefined();
    },
  );
});

describe(`POST ${MEETUPS_URL}/:id/hold — the initiator's retry (AAP 0.5.4)`, () => {
  it.each(rows(HOLD_RETRY_REFUSALS))(
    `${MODE} refuses a hold retry by $name with $httpStatus $code`,
    async (entry) => {
      const fixture = await proposal();
      let meetupId: string;
      if (entry.locked) {
        const locked = await proposeAndLock(t, {
          initiator: fixture.initiator,
          recipient: fixture.recipient,
          venue: fixture.venue,
          startsAt: fixture.startsAt,
        });
        meetupId = locked.meetupId;
      } else {
        meetupId = (await visibleProposal(fixture)).meetupId;
      }
      const actor =
        entry.caller === 'initiator'
          ? fixture.initiator
          : entry.caller === 'recipient'
            ? fixture.recipient
            : await makeUser(t);
      expectError(await retryHold(actor, meetupId), entry.httpStatus, entry.code);
    },
  );
  it(`${MODE} refuses a retry whose newly attached card the issuer declines`, async () => {
    const initiator = await makeUser(t, { card: 'none' });
    const recipient = await makeUser(t);
    await makeProof(t, initiator, { cityId: CITY });
    await makeProof(t, recipient, { cityId: CITY });
    const venue = await makeVenue(t, { cityId: CITY });
    // The first attempt is refused for having no card at all, so it leaves no authorization behind.
    expectError(await propose(initiator, bodyAmong(recipient, venue)), 402, 'hold_failed');
    const meetupId = await onlyMeetupId();
    const first = await depositOf(meetupId, initiator);
    expect(first.status).toBe('failed');
    expect(first.currentPaymentIntentId).toBeNull();
    // The saved-card step, and a card the issuer refuses in its turn. The new attempt reaches the
    // provider inline, because the attempt it supersedes left nothing to release (AAP 0.3.2).
    await setUpCard(initiator, DECLINED_CARD);
    expectError(await retryHold(initiator, meetupId), 402, 'hold_failed');
    const retried = await depositOf(meetupId, initiator);
    expect(retried.status).toBe('failed');
    expect(retried.currentAttempt).toBe(2);
    expect(await t.services.db.deposit.count()).toBe(1);
    expect((await meetupRow(meetupId)).proposalVisibleAt).toBeNull();
  });

  it(`${MODE} places the retry, makes the proposal visible and confirms the held attempt`, async () => {
    const initiator = await makeUser(t, { card: 'declining' });
    const recipient = await makeUser(t);
    await makeProof(t, initiator, { cityId: CITY });
    await makeProof(t, recipient, { cityId: CITY });
    const venue = await makeVenue(t, { cityId: CITY });
    expectError(await propose(initiator, bodyAmong(recipient, venue)), 402, 'hold_failed');
    const meetupId = await onlyMeetupId();
    await attachCard(initiator, WORKING_CARD);
    // The retry carries out the superseded attempt's release and then places attempt 2, so the answer
    // is that attempt's own secret, and the money has moved by the time the client reads the meetup
    // (AAP 0.5.4).
    const now = t.time.now();
    const response = await retryHold(initiator, meetupId);
    expect(response.status, `the hold retry answered ${response.body}`).toBe(200);
    const retried = HoldRetryResponse.parse(response.json());
    expect(retried.status).toBe('proposed');
    expect(retried.initiatorHold).toBe('held');
    expect(retried.clientSecret.length).toBeGreaterThan(0);
    const held = await depositOf(meetupId, initiator);
    expect(held.status).toBe('held');
    expect(held.currentAttempt).toBe(2);
    const stored = await meetupRow(meetupId);
    expect(instantOf(stored.proposalVisibleAt)).toBe(now.getTime());
    expect(instantOf(stored.recipientDeadline)).toBe(
      now.getTime() + RECIPIENT_DEADLINE_HOURS * HOUR_MS,
    );
    expect(await countEvent(meetupId, 'proposal_sent')).toBe(1);
    await expectAttemptIntents(held.id, 2);
    // The recipient can see it now, which is what a successful retry buys (AAP 0.5.3).
    expect((await readMeetup(recipient, meetupId)).status).toBe(200);
    // A further retry confirms the attempt that holds the authorization — the provider's own secret
    // for it comes back again — and places no new one.
    const confirmed = await retryHold(initiator, meetupId);
    expect(confirmed.status, `the repeated hold retry answered ${confirmed.body}`).toBe(200);
    const again = HoldRetryResponse.parse(confirmed.json());
    const initiatorHold: HoldView = again.initiatorHold;
    expect(again.status).toBe('proposed');
    expect(initiatorHold).toBe('held');
    expect(again.clientSecret).toBe(retried.clientSecret);
    expect((await depositOf(meetupId, initiator)).currentAttempt).toBe(2);
    await expectAttemptIntents(held.id, 2);
  });

  it(`${MODE} answers the current attempt's own secret while 3-D Secure is pending`, async () => {
    const fixture = await proposal({ card: '3ds' });
    const created = ProposeResponse.parse(
      (await propose(fixture.initiator, proposeBody(fixture))).json(),
    );
    const deposit = await depositOf(created.meetupId, fixture.initiator);
    expect(deposit.status).toBe('requires_action');
    const response = await retryHold(fixture.initiator, created.meetupId);
    expect(response.status).toBe(200);
    const retried = HoldRetryResponse.parse(response.json());
    expect(retried.initiatorHold).toBe('requires_action');
    expect(retried.clientSecret).toBe(created.clientSecret);
    // No second authorization: the same attempt, and one PaymentIntent (AAP 0.3.2).
    expect(await t.services.db.deposit.count({ where: { meetupId: created.meetupId } })).toBe(1);
    expect((await depositOf(created.meetupId, fixture.initiator)).currentAttempt).toBe(1);
    await expectAttemptIntents(deposit.id, 1);
  });
  describe.runIf(MOCK)(`${MODE} hold retries against a lost create`, () => {
    it(`${MODE} answers 409 hold_pending while the attempt is unresolved`, async () => {
      const fixture = await proposal();
      await failHoldCreate();
      expectError(
        await propose(fixture.initiator, proposeBody(fixture)),
        503,
        'payment_unavailable',
      );
      const meetupId = await onlyMeetupId();
      expectError(await retryHold(fixture.initiator, meetupId), 409, 'hold_pending');
      const deposit = await depositOf(meetupId, fixture.initiator);
      expect(deposit.status).toBe('pending');
      expect(deposit.currentAttempt).toBe(1);
      expect(await t.services.db.deposit.count()).toBe(1);
      expect((await meetupRow(meetupId)).proposalVisibleAt).toBeNull();
    });
    it(`${MODE} answers 503 payment_unavailable for a create the provider cannot answer`, async () => {
      const initiator = await makeUser(t, { card: 'none' });
      const recipient = await makeUser(t);
      await makeProof(t, initiator, { cityId: CITY });
      await makeProof(t, recipient, { cityId: CITY });
      const venue = await makeVenue(t, { cityId: CITY });
      expectError(await propose(initiator, bodyAmong(recipient, venue)), 402, 'hold_failed');
      const meetupId = await onlyMeetupId();
      await setUpCard(initiator, WORKING_CARD);
      await failHoldCreate();
      expectError(await retryHold(initiator, meetupId), 503, 'payment_unavailable');
      // One new attempt only, and no second authorization: the replay resolves this one (AAP 0.3.2).
      const deposit = await depositOf(meetupId, initiator);
      expect(deposit.currentAttempt).toBe(2);
      expect(await t.services.db.deposit.count()).toBe(1);
      // The next retry confirms that attempt rather than placing another (AAP 0.5.4).
      const response = await retryHold(initiator, meetupId);
      expect(response.status).toBe(200);
      expect(HoldRetryResponse.parse(response.json()).initiatorHold).toBe('held');
      expect((await depositOf(meetupId, initiator)).currentAttempt).toBe(2);
    });
  });
});

interface BadQueryRow {
  readonly name: string;
  readonly query: Record<string, string>;
}

/** Both filters are closed enums and the cursor is opaque, so neither accepts free text. */
const BAD_QUERIES: readonly BadQueryRow[] = [
  { name: 'a role outside the enum', query: { role: 'boss' } },
  { name: 'a status outside the enum', query: { status: 'done' } },
  { name: 'a cursor this API never issued', query: { cursor: '%%' } },
];

/** One check-in state a locked meetup can hold, and what each attendee must read from it. */
interface CheckInSignalRow {
  readonly name: string;
  /** Which attendees hold a passing check-in, as the meetup's own `CheckIn` rows. */
  readonly passes: { readonly initiator?: CheckInResult; readonly recipient?: CheckInResult };
  /** Each attendee's expected `[checkedIn, counterpartCheckedIn]` (AAP 0.5.4, 0.5.7). */
  readonly expected: {
    readonly initiator: readonly [boolean, boolean];
    readonly recipient: readonly [boolean, boolean];
  };
}

/**
 * Seeing whether the counterpart showed up is the product's trust signal, and both attendees read it from the meetup's pass
 * `CheckIn` rows while it is still `locked` (AAP 0.5.7): each one gets their own check-in and the counterpart's.
 */
const CHECK_IN_SIGNAL_ROWS: readonly CheckInSignalRow[] = [
  {
    name: 'the initiator checked in alone',
    passes: { initiator: 'pass' },
    expected: { initiator: [true, false], recipient: [false, true] },
  },
  {
    name: 'the recipient checked in alone',
    passes: { recipient: 'pass' },
    expected: { initiator: [false, true], recipient: [true, false] },
  },
  {
    name: 'both attendees checked in',
    passes: { initiator: 'pass', recipient: 'pass' },
    expected: { initiator: [true, true], recipient: [true, true] },
  },
];

describe(`GET ${MEETUPS_URL} and GET ${MEETUPS_URL}/:id (AAP 0.5.4)`, () => {
  it.each(rows(BAD_QUERIES))(`${MODE} answers 400 invalid_field for $name`, async (entry) => {
    const fixture = await proposal();
    expectError(await listMeetups(fixture.initiator, entry.query), 400, 'invalid_field');
  });

  it(`${MODE} filters the caller's own meetups by side and by status`, async () => {
    const fixture = await proposal();
    const created = await visibleProposal(fixture);
    const other = await proposal();
    const locked = await proposeAndLock(t, {
      initiator: other.initiator,
      recipient: other.recipient,
      venue: other.venue,
      startsAt: other.startsAt,
    });
    const proposed = MeetupListResponse.parse(
      (await listMeetups(fixture.initiator, { status: 'proposed' })).json(),
    );
    expect(proposed.items.map((item) => item.id)).toEqual([created.meetupId]);
    expect(proposed.items[0]?.role).toBe('initiator');
    // `role` selects the caller's own side, so the recipient's list holds the same meetup (AAP 0.5.4).
    const asRecipient = MeetupListResponse.parse(
      (await listMeetups(fixture.recipient, { role: 'recipient' })).json(),
    );
    expect(asRecipient.items.map((item) => item.id)).toEqual([created.meetupId]);
    expect(asRecipient.items[0]?.role).toBe('recipient');
    const lockedOnly = MeetupListResponse.parse(
      (await listMeetups(other.initiator, { status: 'locked' })).json(),
    );
    expect(lockedOnly.items.map((item) => item.id)).toEqual([locked.meetupId]);
    // A filter that matches nothing is an empty page, not a refusal, and it ends the list.
    const empty = MeetupListResponse.parse(
      (await listMeetups(fixture.initiator, { status: 'completed' })).json(),
    );
    expect(empty.items).toHaveLength(0);
    expect(empty.nextCursor).toBeNull();
  });

  it.each(rows(CHECK_IN_SIGNAL_ROWS))(
    `${MODE} serves each attendee their own and the counterpart's check-in with $name`,
    async (entry) => {
      const fixture = await proposal();
      const meetup = await makeMeetup(t, {
        status: 'locked',
        initiator: fixture.initiator,
        recipient: fixture.recipient,
        venue: fixture.venue,
        startsAt: fixture.startsAt,
        checkIns: entry.passes,
      });
      // Both attendees read the same two facts, each from their own side of the meetup (AAP 0.5.4).
      const attendees = [
        { actor: fixture.initiator, expected: entry.expected.initiator },
        { actor: fixture.recipient, expected: entry.expected.recipient },
      ] as const;
      for (const { actor, expected } of attendees) {
        const dto = MeetupDto.parse((await readMeetup(actor, meetup.id)).json());
        expect([dto.checkedIn, dto.counterpartCheckedIn], `@${actor.handle}`).toEqual(expected);
      }
      // The page read answers the same two fields out of its own single query (AAP 0.5.4, 0.12.2).
      const page = MeetupListResponse.parse(
        (await listMeetups(fixture.initiator, { status: 'locked' })).json(),
      );
      expect(page.items.map((item) => [item.checkedIn, item.counterpartCheckedIn])).toEqual([
        entry.expected.initiator,
      ]);
    },
  );
  it(`${MODE} pages the caller's own meetups at ${PAGE_SIZE} and continues from the cursor`, async () => {
    const fixture = await proposal();
    const total = PAGE_SIZE + 5;
    for (let index = 0; index < total; index += 1) {
      const counterpart = await makeUser(t, { card: 'none' });
      await makeMeetup(t, {
        status: 'declined',
        initiator: fixture.initiator,
        recipient: counterpart,
        venue: fixture.venue,
      });
    }
    const first = await listMeetups(fixture.initiator);
    expect(first.status).toBe(200);
    const page = MeetupListResponse.parse(first.json());
    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(page.nextCursor).not.toBeNull();
    const rest = await listMeetups(fixture.initiator, { cursor: page.nextCursor ?? '' });
    const second = MeetupListResponse.parse(rest.json());
    expect(second.items).toHaveLength(total - PAGE_SIZE);
    expect(second.nextCursor).toBeNull();
    // Every meetup is served once, and no page carries a secret of any kind.
    expect(new Set([...page.items, ...second.items].map((item) => item.id)).size).toBe(total);
    for (const body of [page, second]) {
      expect(keysDeep(body).filter((path) => path.includes('secret'))).toEqual([]);
    }
  });

  it(`${MODE} serves the detail to a participant only, and hides an invisible proposal`, async () => {
    const fixture = await proposal();
    const locked = await makeMeetup(t, {
      status: 'locked',
      initiator: fixture.initiator,
      recipient: fixture.recipient,
      venue: fixture.venue,
      startsAt: fixture.startsAt,
    });
    const stranger = await makeUser(t);
    expectError(await readMeetup(stranger, locked.id), 403, 'not_participant');
    expectError(await readMeetup(fixture.initiator, randomUUID()), 404, 'meetup_not_found');
    // A proposal the initiator's hold has not made visible is answered as if it did not exist, so
    // the route cannot be used to probe for it (AAP 0.5.3).
    const pending = await proposal({ card: '3ds' });
    const invisible = ProposeResponse.parse(
      (await propose(pending.initiator, proposeBody(pending))).json(),
    );
    expectError(await readMeetup(pending.recipient, invisible.meetupId), 404, 'meetup_not_found');
    // The initiator's own read of it is served, and carries no secret (AAP 0.5.4).
    const own = await readMeetup(pending.initiator, invisible.meetupId);
    expect(own.status).toBe(200);
    expect(keysDeep(MeetupDto.parse(own.json())).filter((path) => path.includes('secret'))).toEqual(
      [],
    );
  });

  it(`${MODE} records the recipient's first read once and emits proposal_viewed once`, async () => {
    const fixture = await proposal();
    const created = await visibleProposal(fixture);
    expect(await countEvent(created.meetupId, 'proposal_viewed')).toBe(0);
    const first = await readMeetup(fixture.recipient, created.meetupId);
    expect(first.status).toBe(200);
    const viewedAt = t.time.now();
    expect(instantOf((await meetupRow(created.meetupId)).recipientViewedAt)).toBe(
      viewedAt.getTime(),
    );
    expect(await countEvent(created.meetupId, 'proposal_viewed')).toBe(1);
    expect((await eventOf(created.meetupId, 'proposal_viewed')).actorHash).toBe(
      hashOf(fixture.recipient),
    );
    // A second read of the same proposal, and the initiator's own read, write nothing more.
    expect((await readMeetup(fixture.recipient, created.meetupId)).status).toBe(200);
    expect((await readMeetup(fixture.initiator, created.meetupId)).status).toBe(200);
    expect(await countEvent(created.meetupId, 'proposal_viewed')).toBe(1);
  });
});

describe(`POST /v1/me/payment-setup (AAP 0.5.4)`, () => {
  it(`${MODE} creates the account's customer once and reuses it on a second call`, async () => {
    const user = await makeUser(t, { card: 'none' });
    expect(user.stripeCustomerId).toBeNull();
    const first = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/me/payment-setup',
      as: await t.tokenFor(user),
    });
    expect(first.status).toBe(200);
    const setup = PaymentSetupResponse.parse(first.json());
    expect(setup.customerId).not.toBe('');
    expect(setup.setupIntentClientSecret).not.toBe('');
    expect(setup.ephemeralKeySecret).not.toBe('');
    // The customer is stored on the account, which is what the first proposal's hold reads.
    expect(
      await t.services.db.user
        .findUniqueOrThrow({ where: { id: user.id }, select: { stripeCustomerId: true } })
        .then((row) => row.stripeCustomerId),
    ).toBe(setup.customerId);
    const second = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/me/payment-setup',
      as: await t.tokenFor(user),
    });
    expect(second.status).toBe(200);
    expect(PaymentSetupResponse.parse(second.json()).customerId).toBe(setup.customerId);
    expect(
      await t.services.db.user
        .findUniqueOrThrow({ where: { id: user.id }, select: { stripeCustomerId: true } })
        .then((row) => row.stripeCustomerId),
    ).toBe(setup.customerId);
  });
});
