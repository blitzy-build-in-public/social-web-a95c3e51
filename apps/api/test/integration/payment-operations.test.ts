/**
 * `PaymentOperation` recovery: the executor's crash points, the ambiguous hold create, the hold
 * attempts a client restarts, and the late, orphan and lost authorizations.
 *
 * Every Stripe mutation Tablemate makes is a durable `payment_operation` row written in the
 * transaction that decided it, and the rules the cases break one at a time are: claim, call, record —
 * a throw before the request is sent returns the claim, a throw after a successful call leaves the row
 * `executing` for the two-minute reclaim to reconcile; an ambiguous result is not a failure; an
 * ambiguous hold create is replayed under its own key rather than replaced, and handed to the
 * operator once `HOLD_UNRESOLVED_AFTER_MS` has passed; an attempt a client restarts is confirmed,
 * never re-authorized; and a late authorization never leaves money outstanding.
 *
 * The cases that drive a provider-side outcome come from the stateful proxy's control routes and run
 * in `mock` alone; the rest run in both topologies and carry `stripeModeLabel()`. Time comes from the
 * injected clock, faults are disarmed in a `finally`, and no assertion reads a card field.
 */

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';

import {
  AcceptResponse,
  DEFAULT_DEPOSIT_CENTS,
  DAY_MS,
  HoldRetryResponse,
  MINUTE_MS,
  OUR_CANCELLATION_REASON,
  ProposeResponse,
  type ParticipantRole,
} from '@tablemate/shared';
import type { PaymentOperation } from '@tablemate/db';

import {
  HOLD_HAND_OFF_MARKERS,
  captureKey,
  deleteCustomerKey,
  holdKey,
  releaseKey,
} from '../../src/modules/payments/holds.ts';
import { createTestApp, type TestApp } from '../support/app.ts';
import {
  callRoute,
  checkIn,
  expectError,
  makeDispute,
  makeMeetup,
  makeProof,
  makeUser,
  makeVenue,
  proposeAndLock,
  rows,
  stripeApi,
  stripeModeLabel,
  type CardFixture,
  type RouteResponse,
  type UserFixture,
  type VenueFixture,
} from '../support/factories.ts';
import { settleNow } from '../support/clock.ts';
import {
  deliverStripeEvents,
  type ProxyControl,
  type StripeEvent,
} from '../support/stripe-proxy/state.ts';

const CITY_ID = 'lisbon';

const MODE = stripeModeLabel();

/** Whether this run holds the stateful proxy: the provider-side outcomes need its controls. */
const MOCK = inject('stripeMode') === 'mock';

const INTENTS_PATH = '/v1/payment_intents';

const CANCEL_PATH = '/v1/payment_intents/*/cancel';

const TIMEOUT_CASE_MS = 30_000;

/** The executor's interrupt window: an `executing` row older than this is a lost answer. */
const RECLAIM_AFTER_MS = 2 * MINUTE_MS;

/**
 * How far out a proposal this file locks starts, inside the five-day horizon and far enough ahead
 * that the recipient deadline is the 48-hour one rather than the start.
 */
const PROPOSAL_LEAD_MS = 4 * DAY_MS;

/** One second past `startsAt - 2 h`: the first instant a cancellation is a forfeit (AAP 0.5.3). */
const LATE_BY_MS = 1_000;

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
});

afterAll(async () => {
  await t.close();
});

function proxy(): ProxyControl {
  const control = t.stripe.proxy;
  if (control === null) {
    throw new Error('this case needs the stateful proxy: STRIPE_MODE=mock');
  }
  return control;
}

interface DepositRow {
  readonly id: string;
  readonly status: string;
  readonly currentAttempt: number;
  readonly currentPaymentIntentId: string | null;
  readonly canceledAt: Date | null;
}

async function depositOf(meetupId: string, role: ParticipantRole): Promise<DepositRow> {
  const deposit = await t.services.db.deposit.findFirst({
    where: { meetupId, role },
    select: {
      id: true,
      status: true,
      currentAttempt: true,
      currentPaymentIntentId: true,
      canceledAt: true,
    },
  });
  if (deposit === null) {
    throw new Error(`no ${role} deposit on meetup ${meetupId}`);
  }
  return deposit;
}

/** A deposit's operations, in plan order; the executor's claim ordering is `seq`. */
function ops(depositId: string, kind?: PaymentOperation['kind']): Promise<PaymentOperation[]> {
  return t.services.db.paymentOperation.findMany({
    where: kind === undefined ? { depositId } : { depositId, kind },
    orderBy: { seq: 'asc' },
  });
}

async function operationOf(
  depositId: string,
  kind: PaymentOperation['kind'],
): Promise<PaymentOperation | null> {
  const operations = await ops(depositId, kind);
  return operations.length === 0 ? null : (operations[operations.length - 1] ?? null);
}

async function meetupStatus(meetupId: string): Promise<string> {
  const meetup = await t.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { status: true },
  });
  return meetup.status;
}

/** How many operations of `kind` the deposit holds: the count is what "one effect" is asserted on. */
function operationCount(depositId: string, kind: PaymentOperation['kind']): Promise<number> {
  return t.services.db.paymentOperation.count({ where: { depositId, kind } });
}

function intentIdOf(deposit: DepositRow): string {
  if (deposit.currentPaymentIntentId === null) {
    throw new Error(`deposit ${deposit.id} holds no current PaymentIntent`);
  }
  return deposit.currentPaymentIntentId;
}

async function notificationKinds(): Promise<string[]> {
  const messages = await t.services.db.outboxMessage.findMany({
    where: { kind: 'notification' },
    select: { payload: true },
  });
  return messages
    .map(({ payload }) => {
      const kind =
        typeof payload === 'object' && payload !== null
          ? (payload as { kind?: unknown }).kind
          : undefined;
      return typeof kind === 'string' ? kind : 'unknown';
    })
    .sort();
}

function analyticsCount(name: string): Promise<number> {
  return t.services.db.analyticsEvent.count({ where: { name } });
}

interface ProviderIntent {
  readonly id: string;
  readonly status: string;
  readonly client_secret: string;
  readonly metadata: Record<string, string>;
  readonly cancellation_reason: string | null;
}

interface ProviderEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly data: { readonly object: unknown };
}

function objectId(object: unknown): string | null {
  if (typeof object !== 'object' || object === null) return null;
  const id = (object as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/**
 * A fresh delivery of an event the provider already recorded: the same payload under a new event id,
 * which is what makes two deliveries of one historical object two distinct events (AAP 0.3.2).
 */
function rewrap(event: StripeEvent): ProviderEvent {
  return {
    id: `evt_${randomBytes(12).toString('hex')}`,
    type: event.type,
    created: Math.floor(t.services.clock.nowMs() / 1000),
    data: { object: event.data.object },
  };
}

async function recordedEventsFor(type: string, intentId: string): Promise<StripeEvent[]> {
  const events = await proxy().events();
  return events.filter((event) => event.type === type && objectId(event.data.object) === intentId);
}

async function recordedEvent(type: string, intentId: string): Promise<StripeEvent | null> {
  const events = await recordedEventsFor(type, intentId);
  return events[events.length - 1] ?? null;
}

/**
 * The attempt's PaymentIntent as the provider reports it, through the same API the gateway's own
 * reconciliation reads — in either topology, because the proxy answers this path from its state.
 */
function intentById(intentId: string): Promise<ProviderIntent> {
  return stripeApi(t).get<ProviderIntent>(`${INTENTS_PATH}/${encodeURIComponent(intentId)}`);
}

async function customerIdOf(depositId: string): Promise<string> {
  const deposit = await t.services.db.deposit.findUniqueOrThrow({
    where: { id: depositId },
    select: { owner: { select: { stripeCustomerId: true } } },
  });
  const customerId = deposit.owner.stripeCustomerId;
  if (customerId === null) {
    throw new Error(`the owner of deposit ${depositId} holds no Stripe customer`);
  }
  return customerId;
}

/**
 * Every PaymentIntent the provider has for `depositId`, newest first: the count is how a case proves
 * that no second authorization was created for one attempt (AAP 0.3.2).
 */
async function intentsFor(depositId: string): Promise<ProviderIntent[]> {
  const customer = await customerIdOf(depositId);
  const listed = await stripeApi(t).get<{ data: ProviderIntent[] }>(INTENTS_PATH, {
    customer,
    limit: '100',
  });
  return listed.data.filter((intent) => intent.metadata['depositId'] === depositId);
}

async function authorizationEvent(intentId: string): Promise<ProviderEvent> {
  const recorded = await recordedEvent('payment_intent.amount_capturable_updated', intentId);
  if (recorded !== null) {
    return rewrap(recorded);
  }
  const intent = await intentById(intentId);
  return {
    id: `evt_${randomBytes(12).toString('hex')}`,
    type: 'payment_intent.amount_capturable_updated',
    created: Math.floor(t.services.clock.nowMs() / 1000),
    data: { object: intent },
  };
}

async function deliver(event: ProviderEvent): Promise<void> {
  const [response] = await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret);
  expect(response?.statusCode, `the webhook answered ${response?.body ?? 'nothing'}`).toBe(200);
}

async function deliverCancellation(intentId: string): Promise<void> {
  const recorded = await recordedEvent('payment_intent.canceled', intentId);
  if (recorded === null) {
    return;
  }
  await deliver(rewrap(recorded));
}

async function deliverRecorded(type: string, intentId: string): Promise<void> {
  const recorded = await recordedEvent(type, intentId);
  if (recorded === null) {
    throw new Error(`the proxy recorded no ${type} for that PaymentIntent`);
  }
  await deliver(rewrap(recorded));
}

async function customerDeleted(customerId: string): Promise<boolean> {
  const customer = await stripeApi(t).get<{ deleted?: boolean }>(
    `/v1/customers/${encodeURIComponent(customerId)}`,
  );
  return customer.deleted === true;
}

/**
 * Save another card on the account, as the card-setup step does before a hold is retried — the
 * provider control route, so this belongs to the `mock` topologies alone.
 */
async function attachVisa(user: UserFixture): Promise<void> {
  const row = await t.services.db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { stripeCustomerId: true },
  });
  if (row.stripeCustomerId === null) {
    throw new Error(`account ${user.id} holds no Stripe customer`);
  }
  await proxy().attachCard(row.stripeCustomerId, proxy().TEST_CARDS.visa);
}

interface Proposal {
  readonly meetupId: string;
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
  readonly venue: VenueFixture;
  readonly startsAt: Date;
}

interface OpenProposalOptions {
  readonly initiatorCard?: CardFixture;
  readonly recipientCard?: CardFixture;
  readonly startsAt?: Date;
  readonly proofs?: boolean;
}

interface Cast {
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
  readonly venue: VenueFixture;
  readonly startsAt: Date;
}

/**
 * Write what a proposal needs and nothing else: two accounts with their cards, a partner venue, a
 * valid proof on either side and the instant the meetup starts at.
 *
 * The route call is deliberately a separate step, so a case can arm a fault — a dropped create, a
 * refusal — between the fixture and the request that has to survive it.
 */
async function cast(options: OpenProposalOptions = {}): Promise<Cast> {
  const venue = await makeVenue(t, { cityId: CITY_ID });
  const initiator = await makeUser(t, { card: options.initiatorCard ?? 'visa' });
  const recipient = await makeUser(t, { card: options.recipientCard ?? 'visa' });
  const startsAt = options.startsAt ?? new Date(t.services.clock.nowMs() + PROPOSAL_LEAD_MS);
  if (options.proofs !== false) {
    for (const actor of [initiator, recipient]) {
      await makeProof(t, actor, { cityId: CITY_ID });
    }
  }
  return { initiator, recipient, venue, startsAt };
}

function propose(actors: Cast): Promise<RouteResponse> {
  return route('POST', '/v1/meetups', actors.initiator, {
    recipientId: actors.recipient.id,
    venueId: actors.venue.id,
    startsAt: actors.startsAt.toISOString(),
    depositCents: DEFAULT_DEPOSIT_CENTS,
  });
}

function meetupIdOf(response: RouteResponse): string {
  return ProposeResponse.parse(response.json()).meetupId;
}

/**
 * Propose through the real route: a cast, then `POST /meetups`, whose initiator hold the request
 * itself places. A `3ds` card leaves the proposal invisible behind `requires_action`, which is the
 * state the recovery rows start from.
 */
async function openProposal(options: OpenProposalOptions = {}): Promise<Proposal> {
  const actors = await cast(options);
  const proposed = await propose(actors);
  expect(proposed.status, `POST /v1/meetups answered ${proposed.body}`).toBe(201);
  return { ...actors, meetupId: meetupIdOf(proposed) };
}

interface ListedMeetup {
  readonly id: string;
  readonly status: string;
  readonly initiatorHold: string;
  readonly recipientHold: string;
}

/**
 * The caller's own meetups, as the recovery path the contract names reads them (AAP 0.5.4): the
 * initiator of a proposal whose hold the response never confirmed recovers its id here.
 */
async function listedMeetups(actor: UserFixture, status?: string): Promise<ListedMeetup[]> {
  const query = new URLSearchParams({
    role: 'initiator',
    ...(status === undefined ? {} : { status }),
  });
  const response = await route('GET', `/v1/meetups?${query.toString()}`, actor);
  expect(response.status, `GET /v1/meetups answered ${response.body}`).toBe(200);
  return response.json<{ items: ListedMeetup[] }>().items;
}

/**
 * Read until `read` reports what the case expects, or give up at the bound.
 *
 * A delivery's post-commit work runs after its response and is deliberately not awaited
 * (`payments/webhook.ts`), so the effect of an event is observable a moment after it is
 * acknowledged. A case that asserts on such an effect waits here instead of racing the pass that
 * carries it out.
 */
async function eventually<T>(
  read: () => Promise<T>,
  expected: (value: T) => boolean,
  budgetMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let value = await read();
  while (!expected(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

async function lockedPair(): Promise<Proposal> {
  const venue = await makeVenue(t, { cityId: CITY_ID });
  const initiator = await makeUser(t, { card: 'visa' });
  const recipient = await makeUser(t, { card: 'visa' });
  const startsAt = new Date(t.services.clock.nowMs() + PROPOSAL_LEAD_MS);
  const { meetupId } = await proposeAndLock(t, { initiator, recipient, venue, startsAt });
  return { meetupId, initiator, recipient, venue, startsAt };
}

/**
 * One route call as an actor, with an optional JSON body.
 *
 * The token is signed for this call from the injected clock, never the fixture's own: several cases
 * jump the clock past an access token's 15 minutes, and the account acting is the same one.
 */
async function route(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  actor: UserFixture | null,
  body?: object,
): Promise<RouteResponse> {
  return callRoute(t.app, {
    method,
    url,
    ...(actor === null ? {} : { as: await t.tokenFor(actor) }),
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * Retry a hold through the route that owns it.
 *
 * A retry that supersedes an attempt which recorded an authorization writes that attempt's release
 * ahead of the new attempt in the deposit's own plan, and the same request carries both rows out: the
 * release first, the new attempt inline after it, and the answer is that attempt's own client secret —
 * the deposit ends holding attempt `n + 1` and the meetup moves with it (AAP 0.3.2, 0.5.4). A retry
 * whose predecessor cannot conclude still answers `409 hold_pending`, which is the case that pins the
 * refusal against a deposit left `pending`.
 */
function retryHold(
  proposal: Proposal,
  actor: UserFixture,
  endpoint: 'accept' | 'hold',
): Promise<RouteResponse> {
  return route('POST', `/v1/meetups/${proposal.meetupId}/${endpoint}`, actor);
}

describe.runIf(MOCK)(`${MODE} payment operations — executor crash points`, () => {
  it('leaves a release the next pass executes when nothing reached the provider', async () => {
    const proposal = await openProposal();
    const deposit = await depositOf(proposal.meetupId, 'initiator');
    const intentId = intentIdOf(deposit);
    t.faults.arm('payment_op.before_stripe_call', { once: true });
    let declined: RouteResponse;
    try {
      declined = await route(
        'POST',
        `/v1/meetups/${proposal.meetupId}/decline`,
        proposal.recipient,
      );
    } finally {
      t.faults.disarm();
    }
    expect(declined.status, `the decline answered ${declined.body}`).toBe(200);
    expect(t.faults.hits['payment_op.before_stripe_call']).toBeGreaterThan(0);
    // The throw happened before the request was sent, so the claim went back with it: the row is
    // plainly retryable, no effect was applied, and the decision's own work still stands.
    const lost = await operationOf(deposit.id, 'release');
    expect(lost?.status).toBe('pending');
    expect(lost?.idempotencyKey).toBe(releaseKey(deposit.id, 1));
    expect((await depositOf(proposal.meetupId, 'initiator')).status).toBe('held');
    expect((await intentById(intentId)).status).toBe('requires_capture');
    expect(await meetupStatus(proposal.meetupId)).toBe('declined');
    await settleNow(t.services);
    expect((await operationOf(deposit.id, 'release'))?.status).toBe('succeeded');
    expect((await depositOf(proposal.meetupId, 'initiator')).status).toBe('released');
    const released = await intentById(intentId);
    expect(released.status).toBe('canceled');
    // Our own reason is what tells a release from a hold Stripe took away (AAP 0.3.2).
    expect(released.cancellation_reason).toBe(OUR_CANCELLATION_REASON);
  });
  const AFTER_CALL_ROWS: readonly {
    readonly title: string;
    readonly kind: 'capture' | 'release';
    readonly side: ParticipantRole;
    readonly trigger: 'late' | 'decline';
  }[] = [
    { title: 'a capture', kind: 'capture', side: 'recipient', trigger: 'late' },
    { title: 'a release', kind: 'release', side: 'initiator', trigger: 'decline' },
  ];
  it.each(rows(AFTER_CALL_ROWS))(
    'records the effect a lost answer hid, with one provider call for $title',
    async (row) => {
      const proposal = row.trigger === 'late' ? await lockedPair() : await openProposal();
      const deposit = await depositOf(proposal.meetupId, row.side);
      const intentId = intentIdOf(deposit);
      if (row.trigger === 'late') {
        t.time.toMeetupPoint(proposal, 'startsAt-2h', LATE_BY_MS);
      }
      t.faults.arm('payment_op.after_stripe_call', { when: (ctx) => ctx['kind'] === row.kind });
      let answered: RouteResponse;
      try {
        answered =
          row.trigger === 'late'
            ? await route('POST', `/v1/meetups/${proposal.meetupId}/cancel`, proposal.recipient)
            : await route('POST', `/v1/meetups/${proposal.meetupId}/decline`, proposal.recipient);
      } finally {
        t.faults.disarm();
      }
      expect(answered.status, `the route answered ${answered.body}`).toBe(200);
      if (row.trigger === 'late') {
        expect(answered.json<{ lateCancel: boolean }>().lateCancel).toBe(true);
      }
      // The call reached the provider and the recorded answer was lost with it: the row keeps the
      // claim, which is exactly the state the two-minute reclaim exists for.
      expect((await operationOf(deposit.id, row.kind))?.status).toBe('executing');
      expect((await intentById(intentId)).status).toBe(
        row.kind === 'capture' ? 'succeeded' : 'canceled',
      );
      t.time.advance(RECLAIM_AFTER_MS + 1_000);
      await settleNow(t.services);
      // The reclaim retrieves the intent and records what it finds, without a second capture or a
      // second cancellation (AAP 0.3.2 "Reconciling release, capture and refund").
      expect((await operationOf(deposit.id, row.kind))?.status).toBe('succeeded');
      expect((await depositOf(proposal.meetupId, row.side)).status).toBe(
        row.kind === 'capture' ? 'captured' : 'released',
      );
      expect(await operationCount(deposit.id, row.kind)).toBe(1);
      const effect =
        row.kind === 'capture' ? 'payment_intent.succeeded' : 'payment_intent.canceled';
      expect(await recordedEventsFor(effect, intentId)).toHaveLength(1);
    },
  );
  it('produces one provider effect when a release’s answer is dropped', async () => {
    const proposal = await openProposal();
    const deposit = await depositOf(proposal.meetupId, 'initiator');
    const intentId = intentIdOf(deposit);
    await proxy().dropNextResponse({ method: 'POST', path: CANCEL_PATH });
    const declined = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/decline`,
      proposal.recipient,
    );
    expect(declined.status, `the decline answered ${declined.body}`).toBe(200);
    // The provider performed the cancellation while the answer never arrived. Whether the pinned
    // SDK's own closed-connection retry replays it under the same key or the API's next pass does,
    // one cancellation is all the provider ever sees.
    await settleNow(t.services);
    const release = await eventually(
      () => operationOf(deposit.id, 'release'),
      (operation) => operation?.status === 'succeeded',
    );
    expect(release?.status).toBe('succeeded');
    expect((await depositOf(proposal.meetupId, 'initiator')).status).toBe('released');
    expect(await operationCount(deposit.id, 'release')).toBe(1);
    expect(await recordedEventsFor('payment_intent.canceled', intentId)).toHaveLength(1);
  });
  it(
    'resolves a release whose answer the gateway timed out on, with one provider effect',
    async () => {
      const proposal = await openProposal();
      const deposit = await depositOf(proposal.meetupId, 'initiator');
      const intentId = intentIdOf(deposit);
      // Past the gateway's own ten-second bound, so the caller gives up while the effect stands.
      await proxy().delayNext({ method: 'POST', path: CANCEL_PATH, ms: 11_000 });
      const declined = await route(
        'POST',
        `/v1/meetups/${proposal.meetupId}/decline`,
        proposal.recipient,
      );
      expect(declined.status, `the decline answered ${declined.body}`).toBe(200);
      // The identical request under the same key returns the answer the first one stored, so one
      // cancellation is all the provider ever sees and the deposit moves on it.
      await settleNow(t.services);
      const release = await eventually(
        () => operationOf(deposit.id, 'release'),
        (operation) => operation?.status === 'succeeded',
      );
      expect(release?.status).toBe('succeeded');
      expect((await depositOf(proposal.meetupId, 'initiator')).status).toBe('released');
      expect((await intentById(intentId)).status).toBe('canceled');
      expect(await operationCount(deposit.id, 'release')).toBe(1);
      expect(await recordedEventsFor('payment_intent.canceled', intentId)).toHaveLength(1);
    },
    TIMEOUT_CASE_MS,
  );
});

describe.runIf(MOCK)(`${MODE} payment operations — ambiguous hold create`, () => {
  it(
    'answers 503 and recovers the same attempt when the create’s answer is lost',
    async () => {
      const actors = await cast();
      // Past the gateway's own timeout: the create reaches the provider and its answer never does,
      // which is the one result the caller cannot be told about.
      await proxy().delayNext({ method: 'POST', path: INTENTS_PATH, ms: 11_000 });
      const proposed = await propose(actors);
      expectError(proposed, 503, 'payment_unavailable');
      // The initiator recovers its meetup from its own list, where the side reads as still pending.
      const [listed] = await listedMeetups(actors.initiator, 'proposed');
      expect(listed?.initiatorHold).toBe('pending');
      const deposit = await depositOf(listed?.id ?? '', 'initiator');
      expect(deposit.status).toBe('pending');
      // The create did reach the provider; only its answer was lost.
      const [created] = await intentsFor(deposit.id);
      expect(created?.status).toBe('requires_capture');
      // While the attempt is unresolved nothing may replace it: the retry route refuses.
      const retried = await route('POST', `/v1/meetups/${listed?.id ?? ''}/hold`, actors.initiator);
      expectError(retried, 409, 'hold_pending');
      // With no further client request, the sweeper replays the identical request under its own key.
      await settleNow(t.services);
      const recovered = await depositOf(listed?.id ?? '', 'initiator');
      expect(recovered.status).toBe('held');
      expect(recovered.currentPaymentIntentId).toBe(created?.id);
      const holds = await ops(deposit.id, 'hold');
      expect(holds).toHaveLength(1);
      expect(holds[0]?.idempotencyKey).toBe(holdKey(deposit.id, 1));
      expect(holds[0]?.status).toBe('succeeded');
      expect(await intentsFor(deposit.id)).toHaveLength(1);
      // A held initiator hold is what makes the proposal visible and starts the recipient's clock.
      const meetup = await t.services.db.meetup.findUniqueOrThrow({
        where: { id: listed?.id ?? '' },
        select: { proposalVisibleAt: true, recipientDeadline: true },
      });
      expect(meetup.proposalVisibleAt).not.toBeNull();
      expect(meetup.recipientDeadline).not.toBeNull();
    },
    TIMEOUT_CASE_MS,
  );
  it(
    'recovers the recipient’s own attempt, without a second authorization',
    async () => {
      const proposal = await openProposal();
      // The create reaches the provider and its answer never does.
      await proxy().delayNext({ method: 'POST', path: INTENTS_PATH, ms: 11_000 });
      const accepted = await route(
        'POST',
        `/v1/meetups/${proposal.meetupId}/accept`,
        proposal.recipient,
      );
      expectError(accepted, 503, 'payment_unavailable');
      // The attempt is left unresolved by the inline call and the executor pass that follows it in
      // the same request replays the identical request under the same key: one authorization, one
      // `hold` plan, and the meetup locked on it. A refusal here is the answer to a client whose
      // attempt the application could not confirm — never a second attempt.
      const recovered = await depositOf(proposal.meetupId, 'recipient');
      expect(recovered.status).toBe('held');
      const holds = await ops(recovered.id, 'hold');
      expect(holds).toHaveLength(1);
      expect(holds[0]?.idempotencyKey).toBe(holdKey(recovered.id, 1));
      const intents = await intentsFor(recovered.id);
      expect(intents).toHaveLength(1);
      expect(recovered.currentPaymentIntentId).toBe(intents[0]?.id);
      expect(await meetupStatus(proposal.meetupId)).toBe('locked');
      // The client's next attempt is refused because the meetup has locked: it refetches instead.
      const repeated = await route(
        'POST',
        `/v1/meetups/${proposal.meetupId}/accept`,
        proposal.recipient,
      );
      expectError(repeated, 409, 'not_proposed');
    },
    TIMEOUT_CASE_MS,
  );
  it('hands a create that twelve hours of replaying never resolved to the operator', async () => {
    const actors = await cast();
    await proxy().failNext({ method: 'POST', path: INTENTS_PATH, status: 500 });
    expectError(await propose(actors), 503, 'payment_unavailable');
    const [listed] = await listedMeetups(actors.initiator, 'proposed');
    const deposit = await depositOf(listed?.id ?? '', 'initiator');
    const first = await operationOf(deposit.id, 'hold');
    expect(first?.status).toBe('failed_retryable');
    expect(first?.idempotencyKey).toBe(holdKey(deposit.id, 1));
    // Past the twelve-hour window the replay stops being safe, so the attempt is closed for an
    // operator instead of being sent again — and no second attempt's key is ever created, because a
    // second authorization is exactly what the rule forbids.
    t.time.advance({ hours: 12, minutes: 1 });
    await settleNow(t.services);
    const handed = await operationOf(deposit.id, 'hold');
    expect(handed?.status).toBe('failed_terminal');
    expect(HOLD_HAND_OFF_MARKERS.some((marker) => marker === handed?.lastError)).toBe(true);
    expect(await intentsFor(deposit.id)).toHaveLength(0);
    // The deposit is deliberately left `pending`, which is what keeps every retry refused.
    expect((await depositOf(listed?.id ?? '', 'initiator')).status).toBe('pending');
    const retried = await route('POST', `/v1/meetups/${listed?.id ?? ''}/hold`, actors.initiator);
    expectError(retried, 409, 'hold_pending');
  });
});

describe(`${MODE} payment operations — a restart during 3-D Secure`, () => {
  it('answers a repeated accept with its own attempt’s secret and writes no second plan', async () => {
    const proposal = await openProposal({ recipientCard: '3ds' });
    const initiatorIntent = intentIdOf(await depositOf(proposal.meetupId, 'initiator'));
    const accepted = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/accept`,
      proposal.recipient,
    );
    expect(accepted.status, `the accept answered ${accepted.body}`).toBe(200);
    const first = AcceptResponse.parse(accepted.json());
    expect(first.status).toBe('proposed');
    // The app restarts during the step and repeats the accept: the attempt's authorization is
    // durable, so its own secret comes back and nothing new is authorized.
    const repeated = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/accept`,
      proposal.recipient,
    );
    expect(repeated.status, `the repeated accept answered ${repeated.body}`).toBe(200);
    expect(AcceptResponse.parse(repeated.json()).clientSecret).toBe(first.clientSecret);
    const deposit = await depositOf(proposal.meetupId, 'recipient');
    expect(deposit.status).toBe('requires_action');
    const intents = await intentsFor(deposit.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.client_secret).toBe(first.clientSecret);
    // The secret belongs to the caller's own deposit, and the counterpart's is another attempt.
    expect(first.clientSecret).not.toBe((await intentById(initiatorIntent)).client_secret);
  });
  it('answers a repeated hold with the initiator’s own attempt and leaves the counterpart out', async () => {
    const actors = await cast({ initiatorCard: '3ds' });
    const proposed = await propose(actors);
    expect(proposed.status, `POST /v1/meetups answered ${proposed.body}`).toBe(201);
    const created = ProposeResponse.parse(proposed.json());
    const deposit = await depositOf(created.meetupId, 'initiator');
    expect(deposit.status).toBe('requires_action');
    // The proposal is invisible to the recipient until that hold holds (AAP 0.5.3).
    expect(await listedMeetups(actors.initiator, 'proposed')).toHaveLength(1);
    const retried = await route('POST', `/v1/meetups/${created.meetupId}/hold`, actors.initiator);
    expect(retried.status, `the hold retry answered ${retried.body}`).toBe(200);
    const retry = retried.json<{ status: string; initiatorHold: string; clientSecret: string }>();
    expect(retry.clientSecret).toBe(created.clientSecret);
    expect(retry.initiatorHold).toBe('requires_action');
    const intents = await intentsFor(deposit.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.client_secret).toBe(created.clientSecret);
    // The recipient holds no deposit at all, so no route here could answer their secret.
    expect(
      await t.services.db.deposit.count({
        where: { meetupId: created.meetupId, role: 'recipient' },
      }),
    ).toBe(0);
  });
});

describe.runIf(MOCK)(`${MODE} payment operations — superseded attempts`, () => {
  it('releases the superseded attempt and the current one under their own keys', async () => {
    const proposal = await openProposal({ recipientCard: 'declining' });
    const declined = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/accept`,
      proposal.recipient,
    );
    expectError(declined, 402, 'hold_failed');
    const failed = await depositOf(proposal.meetupId, 'recipient');
    expect(failed.status).toBe('failed');
    expect(failed.currentAttempt).toBe(1);
    // The traveler saves another card and the attempt is retried, which supersedes the first one.
    // Its release is planned ahead of the new attempt, and this request carries both rows out: the
    // release of attempt 1, then attempt 2 inline, whose own secret is the answer (AAP 0.5.4).
    await attachVisa(proposal.recipient);
    const retried = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/accept`,
      proposal.recipient,
    );
    expect(retried.status, `the retry answered ${retried.body}`).toBe(200);
    const accepted = AcceptResponse.parse(retried.json());
    expect(accepted.status).toBe('locked');
    const current = await depositOf(proposal.meetupId, 'recipient');
    expect(current.currentAttempt).toBe(2);
    expect(current.status).toBe('held');
    expect(await meetupStatus(proposal.meetupId)).toBe('locked');
    // The secret is the caller's own current attempt's: the attempt this call placed, never the
    // counterpart's and never the superseded one (AAP 0.5.4).
    const placed = (await intentsFor(current.id)).find(
      (intent) => intent.id === intentIdOf(current),
    );
    expect(accepted.clientSecret).toBe(placed?.client_secret);
    const superseded = await operationOf(current.id, 'release');
    expect(superseded?.idempotencyKey).toBe(releaseKey(current.id, 1));
    expect(superseded?.status).toBe('succeeded');
    // A repeated accept is refused because the meetup has locked: the client refetches instead.
    const repeated = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/accept`,
      proposal.recipient,
    );
    expectError(repeated, 409, 'not_proposed');
    // Free cancellation at exactly the boundary: the current attempt is released under the key that
    // names it, which is what makes the two attempts' cancellations tell themselves apart.
    t.time.toMeetupPoint(proposal, 'startsAt-2h');
    const cancelled = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/cancel`,
      proposal.initiator,
    );
    expect(cancelled.status, `the cancel answered ${cancelled.body}`).toBe(200);
    expect(cancelled.json<{ lateCancel: boolean }>().lateCancel).toBe(false);
    await settleNow(t.services);
    const releases = await ops(current.id, 'release');
    expect(releases.map((operation) => operation.idempotencyKey).sort()).toEqual(
      [releaseKey(current.id, 1), releaseKey(current.id, 2)].sort(),
    );
    for (const release of releases) {
      expect(release.status).toBe('succeeded');
    }
    // Both attempts' authorizations are cancelled at the provider, each by us, and nothing is left
    // outstanding.
    for (const intent of await intentsFor(current.id)) {
      expect(intent.status).toBe('canceled');
      expect(intent.cancellation_reason).toBe(OUR_CANCELLATION_REASON);
    }
    expect((await depositOf(proposal.meetupId, 'recipient')).status).toBe('released');
  });

  it('closes the settlement of a meetup whose retried hold superseded a failed attempt', async () => {
    // Step 1: the traveler has no saved card, so attempt 1 places no authorization at all and the
    // deposit is `failed` with attempt 1's own `hold` row written `failed_terminal` (AAP 0.5.3).
    const actors = await cast({ initiatorCard: 'none' });
    const proposed = await propose(actors);
    expectError(proposed, 402, 'hold_failed');

    // The proposal stands for retry, so the initiator recovers its id from its own list.
    const [listed] = await listedMeetups(actors.initiator, 'proposed');
    expect(listed?.initiatorHold).toBe('failed');
    const proposal: Proposal = { ...actors, meetupId: listed?.id ?? '' };
    const failed = await depositOf(proposal.meetupId, 'initiator');
    expect(failed.status).toBe('failed');
    expect(failed.currentAttempt).toBe(1);
    // Nothing reached the provider under attempt 1's key, so its row can never carry an intent.
    expect(failed.currentPaymentIntentId).toBeNull();
    const firstHolds = await ops(failed.id, 'hold');
    expect(firstHolds.map((operation) => [operation.attempt, operation.status])).toEqual([
      [1, 'failed_terminal'],
    ]);

    // Step 2: the traveler completes the saved-card step and retries, which supersedes attempt 1 and
    // holds attempt 2. Attempt 2 owns the authorization, and attempt 1 keeps its terminal row: it
    // recorded no PaymentIntent, so there is nothing a release could cancel (AAP 0.3.2).
    const setup = await route('POST', '/v1/me/payment-setup', actors.initiator);
    expect(setup.status, `the card setup answered ${setup.body}`).toBe(200);
    await attachVisa(actors.initiator);
    const retried = await retryHold(proposal, actors.initiator, 'hold');
    expect(retried.status, `the hold retry answered ${retried.body}`).toBe(200);
    expect(HoldRetryResponse.parse(retried.json()).initiatorHold).toBe('held');

    const current = await depositOf(proposal.meetupId, 'initiator');
    expect(current.currentAttempt).toBe(2);
    expect(current.status).toBe('held');
    expect(await operationCount(failed.id, 'release')).toBe(0);
    const holds = await ops(failed.id, 'hold');
    expect(holds.map((operation) => [operation.attempt, operation.status])).toEqual([
      [1, 'failed_terminal'],
      [2, 'succeeded'],
    ]);

    // Step 3: the recipient accepts, and both holds stand (AAP 0.5.3).
    const accepted = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/accept`,
      actors.recipient,
    );
    expect(accepted.status, `the accept answered ${accepted.body}`).toBe(200);
    expect(AcceptResponse.parse(accepted.json()).status).toBe('locked');

    // Step 4: both attendees check in through the real route inside the window, the second answer
    // reporting the pair as present.
    t.time.toMeetupPoint(proposal, 'startsAt');
    const venueSecret = proposal.venue.secret;
    expect(venueSecret).not.toBeNull();
    const at = { id: proposal.meetupId, venueId: proposal.venue.id };
    expect(
      (await checkIn(t, actors.initiator, at, { venueSecret: venueSecret ?? '' })).bothCheckedIn,
    ).toBe(false);
    expect(
      (await checkIn(t, actors.recipient, at, { venueSecret: venueSecret ?? '' })).bothCheckedIn,
    ).toBe(true);

    // Step 5: the window closes and the settlement falls due; every money move it plans runs.
    t.time.toMeetupPoint(proposal, 'startsAt+45m');
    await settleNow(t.services);

    for (const role of ['initiator', 'recipient'] as const) {
      const released = await eventually(
        () => depositOf(proposal.meetupId, role),
        (deposit) => deposit.status === 'released',
      );
      expect(released.status).toBe('released');
    }

    // Step 6: every operation that could still move money has finished — the two holds, the two
    // releases, and attempt 1's failed row, which supersession made history — so the marker closes.
    const settlement = await eventually(
      () =>
        t.services.db.meetupSettlement.findUnique({
          where: { meetupId: proposal.meetupId },
          select: { outcome: true, status: true },
        }),
      (row) => row?.status === 'complete',
    );
    expect(settlement).toMatchObject({ outcome: 'completed', status: 'complete' });
    expect(await meetupStatus(proposal.meetupId)).toBe('completed');
    // The superseded attempt's history is left exactly as it was written.
    const finalHolds = await ops(failed.id, 'hold');
    expect(finalHolds.map((operation) => [operation.attempt, operation.status])).toEqual([
      [1, 'failed_terminal'],
      [2, 'succeeded'],
    ]);
  });
});

describe.runIf(MOCK)(`${MODE} payment operations — late and orphan authorizations`, () => {
  const FINAL_ROWS: readonly {
    readonly title: string;
    readonly status: string;
    readonly reach: (proposal: Proposal) => Promise<void>;
  }[] = [
    {
      title: 'a decline',
      status: 'declined',
      reach: async (proposal) => {
        const declined = await route(
          'POST',
          `/v1/meetups/${proposal.meetupId}/decline`,
          proposal.recipient,
        );
        expect(declined.status, `the decline answered ${declined.body}`).toBe(200);
      },
    },
    {
      title: 'a lapse',
      status: 'lapsed',
      reach: async () => {
        // Past the recipient's 48-hour deadline, which the sweeper's lapse step applies.
        t.time.advance({ hours: 49 });
        await settleNow(t.services);
      },
    },
    {
      title: 'a cancellation',
      status: 'cancelled',
      reach: async (proposal) => {
        const cancelled = await route(
          'POST',
          `/v1/meetups/${proposal.meetupId}/cancel`,
          proposal.initiator,
        );
        expect(cancelled.status, `the cancel answered ${cancelled.body}`).toBe(200);
      },
    },
  ];
  it.each(rows(FINAL_ROWS))(
    'acknowledges a 3-D Secure step that completes after $title',
    async (row) => {
      const proposal = await openProposal({ recipientCard: '3ds' });
      const accepted = await route(
        'POST',
        `/v1/meetups/${proposal.meetupId}/accept`,
        proposal.recipient,
      );
      expect(accepted.status, `the accept answered ${accepted.body}`).toBe(200);
      const attempt = await depositOf(proposal.meetupId, 'recipient');
      expect(attempt.status).toBe('requires_action');
      const intentId = intentIdOf(attempt);
      // The releases the decision plans are held back, so the attempt is still waiting on the
      // customer's step when the step lands — the "completed after a decline, a lapse or a cancel"
      // case of AAP 0.5.3.
      t.faults.arm('payment_op.before_stripe_call', { once: false });
      try {
        await row.reach(proposal);
        expect(await meetupStatus(proposal.meetupId)).toBe(row.status);
        const plan = await eventually(
          () => operationOf(attempt.id, 'release'),
          (operation) => operation?.status === 'pending',
        );
        expect(plan?.idempotencyKey).toBe(releaseKey(attempt.id, 1));
        // The customer's step lands now, and the provider reports the authorization it produced.
        await proxy().complete3ds(intentId);
        await deliver(await authorizationEvent(intentId));
        // The money decision is durable, so the event is history: no second release, no lock, and no
        // status ever moved back to `locked` (AAP 0.5.3).
        expect(await meetupStatus(proposal.meetupId)).toBe(row.status);
        expect(await operationCount(attempt.id, 'release')).toBe(1);
        expect((await depositOf(proposal.meetupId, 'recipient')).status).toBe('requires_action');
      } finally {
        t.faults.disarm();
      }
      await settleNow(t.services);
      // Once the plan is free to run, the authorization the late step produced is cancelled by it.
      const settled = await eventually(
        () => depositOf(proposal.meetupId, 'recipient'),
        (deposit) => deposit.status === 'released',
      );
      expect(settled.status).toBe('released');
      expect((await intentById(intentId)).status).toBe('canceled');
    },
  );
  interface Abandoned {
    readonly proposal: Proposal;
    readonly actor: UserFixture;
    readonly role: ParticipantRole;
    readonly intentId: string;
  }
  const EXPIRY_ROWS: readonly {
    readonly title: string;
    readonly endpoint: 'accept' | 'hold';
    readonly start: () => Promise<Abandoned>;
  }[] = [
    {
      title: 'an attempt whose create’s answer was lost',
      endpoint: 'hold',
      start: async () => {
        // The create reaches the provider and its answer never does, and the proposal the initiator
        // holds is invisible to the recipient until that attempt resolves (AAP 0.5.3).
        const actors = await cast({ initiatorCard: '3ds' });
        await proxy().delayNext({ method: 'POST', path: INTENTS_PATH, ms: 11_000 });
        expectError(await propose(actors), 503, 'payment_unavailable');
        const [listed] = await listedMeetups(actors.initiator, 'proposed');
        const deposit = await depositOf(listed?.id ?? '', 'initiator');
        expect(deposit.status).toBe('pending');
        const [unlearned] = await intentsFor(deposit.id);
        return {
          proposal: { ...actors, meetupId: listed?.id ?? '' },
          actor: actors.initiator,
          role: 'initiator',
          intentId: unlearned?.id ?? '',
        };
      },
    },
    {
      title: 'an attempt waiting on 3-D Secure',
      endpoint: 'accept',
      start: async () => {
        const proposal = await openProposal({ recipientCard: '3ds' });
        const accepted = await route(
          'POST',
          `/v1/meetups/${proposal.meetupId}/accept`,
          proposal.recipient,
        );
        expect(accepted.status, `the accept answered ${accepted.body}`).toBe(200);
        const deposit = await depositOf(proposal.meetupId, 'recipient');
        expect(deposit.status).toBe('requires_action');
        return {
          proposal,
          actor: proposal.recipient,
          role: 'recipient',
          intentId: intentIdOf(deposit),
        };
      },
    },
  ];
  it.each(rows(EXPIRY_ROWS))(
    'fails the deposit when Stripe abandons $title',
    async (row) => {
      const { proposal, actor, role, intentId } = await row.start();
      // Stripe cancels the authorization itself — an abandoned 3-D Secure step — which is a hold that
      // was lost rather than a release of ours (AAP 0.3.2).
      await proxy().abandonAuthentication(intentId);
      await deliverCancellation(intentId);
      expect((await depositOf(proposal.meetupId, role)).status).toBe('failed');
      expect(await meetupStatus(proposal.meetupId)).toBe('proposed');
      // A `failed` deposit whose attempt ended is exactly what a retry needs: the new attempt is
      // planned, the request releases the abandoned one ahead of it, and then places it inline — so
      // the answer carries attempt 2's own secret (AAP 0.5.4).
      const retried = await retryHold(proposal, actor, row.endpoint);
      expect(retried.status, `the retry answered ${retried.body}`).toBe(200);
      const again = await depositOf(proposal.meetupId, role);
      expect(again.currentAttempt).toBe(2);
      expect(again.status).toBe('requires_action');
      const attempts = await intentsFor(again.id);
      expect(attempts).toHaveLength(2);
      // The caller's own current attempt's secret, on the body the route answers for that side.
      const current = attempts.find((intent) => intent.id === intentIdOf(again));
      if (row.endpoint === 'accept') {
        const answered = AcceptResponse.parse(retried.json());
        expect(answered.status).toBe('proposed');
        expect(answered.clientSecret).toBe(current?.client_secret);
      } else {
        const answered = HoldRetryResponse.parse(retried.json());
        expect(answered.initiatorHold).toBe('requires_action');
        expect(answered.clientSecret).toBe(current?.client_secret);
      }
    },
    TIMEOUT_CASE_MS,
  );
  it('ignores an authorization event for an attempt the deposit has moved past', async () => {
    const proposal = await openProposal({ recipientCard: '3ds' });
    const accepted = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/accept`,
      proposal.recipient,
    );
    expect(accepted.status, `the accept answered ${accepted.body}`).toBe(200);
    const first = await depositOf(proposal.meetupId, 'recipient');
    expect(first.status).toBe('requires_action');
    const firstIntent = intentIdOf(first);
    // The authentication fails, so the recipient retries with another card and attempt 1 is history.
    await proxy().failAuthentication(firstIntent);
    await deliverRecorded('payment_intent.payment_failed', firstIntent);
    expect((await depositOf(proposal.meetupId, 'recipient')).status).toBe('failed');
    await attachVisa(proposal.recipient);
    const retried = await retryHold(proposal, proposal.recipient, 'accept');
    expect(retried.status, `the retry answered ${retried.body}`).toBe(200);
    // The new attempt holds and the initiator's already did, so the proposal locks on this request
    // (AAP 0.5.4).
    expect(AcceptResponse.parse(retried.json()).status).toBe('locked');
    const current = await depositOf(proposal.meetupId, 'recipient');
    expect(current.currentAttempt).toBe(2);
    const currentIntent = intentIdOf(current);
    expect(await intentsFor(current.id)).toHaveLength(2);
    // The superseded attempt's own authorization event arrives now: the release that supersedes it
    // is already written, so the event is history and the current attempt is untouched.
    await deliver(await authorizationEvent(firstIntent));
    expect(await meetupStatus(proposal.meetupId)).toBe('locked');
    expect((await depositOf(proposal.meetupId, 'recipient')).status).toBe('held');
    expect(await operationCount(current.id, 'release')).toBe(1);
    expect((await intentById(currentIntent)).status).toBe('requires_capture');
    // The attempt that was superseded alone is cancelled; the attempt that holds is not.
    const cancelled = await eventually(
      () => intentById(firstIntent),
      (intent) => intent.status === 'canceled',
    );
    expect(cancelled.status).toBe('canceled');
    expect((await intentById(currentIntent)).status).toBe('requires_capture');
    expect((await depositOf(proposal.meetupId, 'recipient')).status).toBe('held');
  });
  it('ends a visible proposal as lock_lost when the initiator’s hold is taken away', async () => {
    const proposal = await openProposal({ recipientCard: '3ds' });
    const accepted = await route(
      'POST',
      `/v1/meetups/${proposal.meetupId}/accept`,
      proposal.recipient,
    );
    expect(accepted.status, `the accept answered ${accepted.body}`).toBe(200);
    const recipientDeposit = await depositOf(proposal.meetupId, 'recipient');
    expect(recipientDeposit.status).toBe('requires_action');
    const initiator = await depositOf(proposal.meetupId, 'initiator');
    const initiatorIntent = intentIdOf(initiator);
    // The initiator's authorization runs past its capture deadline: the hold was lost, not released.
    await proxy().expireHold(initiatorIntent);
    await deliverCancellation(initiatorIntent);
    await settleNow(t.services);
    const lost = await depositOf(proposal.meetupId, 'initiator');
    expect(lost.status).toBe('expired');
    expect(lost.canceledAt).not.toBeNull();
    expect(await meetupStatus(proposal.meetupId)).toBe('lock_lost');
    // The recipient's attempt is an authorization too, so it is cancelled rather than left standing.
    const survivor = await eventually(
      () => depositOf(proposal.meetupId, 'recipient'),
      (deposit) => deposit.status === 'released',
    );
    expect(survivor.status).toBe('released');
    expect((await intentById(intentIdOf(recipientDeposit))).status).toBe('canceled');
    // No forfeit, no credit, and both parties are told (AAP 0.3.2).
    expect(await analyticsCount('lock_lost')).toBe(1);
    expect(await notificationKinds()).toEqual(['lock_lost', 'lock_lost', 'proposal_received']);
    expect(await t.services.db.tableCreditEntry.count()).toBe(0);
  });
  const CAPTURE_ROWS: readonly {
    readonly title: string;
    readonly capture: 'pending' | 'succeeded';
  }[] = [
    { title: 'before the capture has run', capture: 'pending' },
    { title: 'after the capture has run', capture: 'succeeded' },
  ];
  it.each(rows(CAPTURE_ROWS))(
    'keeps a settled forfeit when a stale authorization arrives $title',
    async (row) => {
      const pair = await lockedPair();
      const venueSecret = pair.venue.secret;
      expect(venueSecret).not.toBeNull();
      // The initiator is at the venue and the recipient never arrives, so the settlement at
      // `startsAt + 45 min` captures the absent side's hold and releases the attendee's.
      t.time.toMeetupPoint(pair, 'startsAt');
      await checkIn(
        t,
        pair.initiator,
        { id: pair.meetupId, venueId: pair.venue.id },
        { venueSecret: venueSecret ?? '' },
      );
      const absent = await depositOf(pair.meetupId, 'recipient');
      const absentIntent = intentIdOf(absent);
      t.time.toMeetupPoint(pair, 'startsAt+45m');
      if (row.capture === 'pending') {
        t.faults.arm('payment_op.before_stripe_call', {
          once: false,
          when: (ctx) => ctx['kind'] === 'capture',
        });
      }
      try {
        await settleNow(t.services);
        expect(await meetupStatus(pair.meetupId)).toBe('forfeited');
        const capture = await eventually(
          () => operationOf(absent.id, 'capture'),
          (operation) =>
            operation?.status === (row.capture === 'pending' ? 'pending' : 'succeeded'),
        );
        expect(capture?.idempotencyKey).toBe(captureKey(absent.id, 1));
        expect(capture?.status).toBe(row.capture === 'pending' ? 'pending' : 'succeeded');
        // The authorization the hold itself produced arrives now, long after the money decision. It
        // is acknowledged, and no release is written for an attempt whose capture is already planned:
        // the capture runs or stands (AAP 0.5.3).
        await deliver(await authorizationEvent(absentIntent));
        expect(await meetupStatus(pair.meetupId)).toBe('forfeited');
        expect(await operationCount(absent.id, 'release')).toBe(0);
      } finally {
        t.faults.disarm();
      }
      await settleNow(t.services);
      const captured = await eventually(
        () => depositOf(pair.meetupId, 'recipient'),
        (deposit) => deposit.status === 'captured',
      );
      expect(captured.status).toBe('captured');
      expect((await intentById(absentIntent)).status).toBe('succeeded');
      expect(await operationCount(absent.id, 'release')).toBe(0);
      expect(await recordedEventsFor('payment_intent.succeeded', absentIntent)).toHaveLength(1);
      // The attendee's own hold is released, and the absent party's deposit credits the attendee.
      const attendee = await eventually(
        () => depositOf(pair.meetupId, 'initiator'),
        (deposit) => deposit.status === 'released',
      );
      expect(attendee.status).toBe('released');
      expect(await t.services.db.tableCreditEntry.count()).toBe(1);
    },
  );
});

describe(`${MODE} payment operations — the customer deletion gate`, () => {
  it('keeps the deletion pending until every deposit is final and no dispute is open', async () => {
    const venue = await makeVenue(t, { cityId: CITY_ID });
    const initiator = await makeUser(t, { card: 'visa' });
    const recipient = await makeUser(t, { card: 'visa' });
    const meetup = await makeMeetup(t, { status: 'locked', initiator, recipient, venue });
    const dispute = await makeDispute(t, meetup, initiator);
    const operator = await makeUser(t, { role: 'operator' });
    const myDeposit = await depositOf(meetup.id, 'initiator');
    const customerId = await customerIdOf(myDeposit.id);
    const deleted = await route('DELETE', '/v1/me', initiator);
    expect(deleted.status, `DELETE /me answered ${deleted.body}`).toBe(202);
    // The deletion plans the customer's own operation, carrying its own copy of the id so the
    // erasure job can clear the column without losing what the provider still needs (AAP 0.5.2).
    const planned = await t.services.db.paymentOperation.findUnique({
      where: { idempotencyKey: deleteCustomerKey(initiator.id) },
    });
    expect(planned?.kind).toBe('delete_customer');
    expect(planned?.depositId).toBeNull();
    expect(planned?.stripeCustomerId).toBe(customerId);
    const operationId = planned?.id ?? '';
    // The gate holds: a deposit of the account is not final and one of its meetups is under an open
    // dispute, so the provider object a resolution still needs is not deleted.
    await settleNow(t.services);
    expect(
      (await t.services.db.paymentOperation.findUniqueOrThrow({ where: { id: operationId } }))
        .status,
    ).toBe('pending');
    // The operator resolves the dispute without fault, which releases both holds — and only then
    // does the account's money have nothing left outstanding to decide.
    const resolved = await route('POST', `/v1/admin/disputes/${dispute.id}/resolve`, operator, {
      outcome: 'no_fault',
    });
    expect(resolved.status, `the operator answered ${resolved.body}`).toBe(200);
    await settleNow(t.services);
    const finished = await t.services.db.paymentOperation.findUniqueOrThrow({
      where: { id: operationId },
    });
    expect(finished.status).toBe('succeeded');
    // The copy is cleared in the transaction that records the success, so the column is not the last
    // place a deleted customer's id survives.
    expect(finished.stripeCustomerId).toBeNull();
    expect((await depositOf(meetup.id, 'initiator')).status).toBe('released');
    expect((await depositOf(meetup.id, 'recipient')).status).toBe('released');
    expect(await customerDeleted(customerId)).toBe(true);
  });
});
