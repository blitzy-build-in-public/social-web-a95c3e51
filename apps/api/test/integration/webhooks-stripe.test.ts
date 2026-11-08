/**
 * `POST /v1/webhooks/stripe`: the signature check, the idempotency, the ordering and the crash cases
 * (AAP 0.3.2, 0.3.3, 0.5.3, 0.5.4, 0.11.2).
 *
 * The endpoint's contract is that one provider event is applied exactly once, and every case here
 * breaks one of the four things that guarantee it:
 *
 *  - **The bytes that were signed.** `stripe.webhooks.constructEvent` checks the received body, never
 *    a re-serialized payload, so a delivery with no header, signed with another secret or altered by
 *    one byte after signing answers `400 bad_signature`, while a body signed over its own exact bytes
 *    is accepted even where `JSON.stringify` would never have produced those bytes (AAP 0.3.3).
 *  - **The dedupe key.** `stripe_event.id` is inserted `ON CONFLICT DO NOTHING` and locked inside the
 *    transaction that applies the effect, so a replay — or two concurrent deliveries — answers `200`
 *    with one effect, one `processed` row and one notification (AAP 0.3.2).
 *  - **The order deliveries arrive in.** Stripe delivers at least once and out of order, so an
 *    authorization that arrives after its deposit was released is acknowledged and ignored — a
 *    deposit moves forward only — and a type the handler does not apply is recorded and acknowledged
 *    (AAP 0.3.3, 0.5.3).
 *  - **A crash in either half of the transaction.** A throw inside it rolls the `stripe_event` row
 *    back with every effect it describes, and the redelivery is what applies the event, exactly once;
 *    a throw after the commit leaves the committed effects standing and the outbox poller delivers
 *    what that delivery wrote (AAP 0.11.2).
 *
 * The cases that need only a hold the fixture placed and the event the provider recorded for it run
 * in both topologies — through the factories' Stripe helper in `test` mode and the stateful proxy's
 * own record in `mock` — and their titles carry `stripeModeLabel()`, so a run's output says which
 * one produced the result (AAP 0.12.1). The cases that need a 3-D Secure step completed or a hold
 * expired come from the proxy's control routes and run in `mock` alone. Time comes from the injected
 * clock, nothing here imports the `stripe` SDK, and every secret is generated at run time.
 *
 * @see AAP 0.3.2 for the idempotency, the correlation and the hold-loss rules, 0.3.3 for the event
 *   list and the signature, 0.5.2 for the deposit and `stripe_event` models, 0.5.3 for the two
 *   lifecycles, 0.5.4 for the route, and 0.11.2 for the topologies and the fault points.
 */

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';

import {
  AcceptResponse,
  DEFAULT_DEPOSIT_CENTS,
  DAY_MS,
  HOUR_MS,
  OUR_CANCELLATION_REASON,
  ProposeResponse,
  RECIPIENT_DEADLINE_HOURS,
  type DepositStatus,
  type ParticipantRole,
} from '@tablemate/shared';

import { createTestApp, type TestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  makeMeetup,
  makeProof,
  makeUser,
  makeVenue,
  rows,
  stripeApi,
  stripeModeLabel,
  type RouteResponse,
  type UserFixture,
} from '../support/factories.ts';
import {
  deliverStripeEvents,
  signStripePayload,
  type ProxyControl,
  type WebhookResponse,
} from '../support/stripe-proxy/state.ts';

/* Constants (AAP 0.5.4, 0.11.2) */

/** The route under test; the same path `deliverStripeEvents` posts to. */
const WEBHOOK_URL = '/v1/webhooks/stripe';

/** The city every fixture venue stands in, from `config/cities.json`. */
const CITY_ID = 'lisbon';

/** How far out a proposal this suite locks starts: inside the five-day horizon of AAP 0.5.4. */
const PROPOSAL_START_MS = 4 * DAY_MS;

/** The type the handler does not apply, used by the cases that exercise the transport alone. */
const UNAPPLIED_TYPE = 'customer.created';

/** The outbox queue a `notification` row is delivered through (AAP 0.3.2, `OUTBOX_TARGET`). */
const NOTIFICATION_QUEUE = 'notifications';

/** The label every title carries, so a run's output names the topology it ran in (AAP 0.12.1). */
const MODE = stripeModeLabel();

/** Whether this run holds the stateful proxy: the 3-D Secure and hold-expiry cases need it. */
const MOCK = inject('stripeMode') === 'mock';

/* The harness (AAP 0.11.2) */

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

/* Provider events (AAP 0.3.3) */

/** The parts of an event payload this suite reads: the dedupe key, the type and the object carried. */
interface ProviderEvent {
  readonly id: string;
  readonly type: string;
  readonly created: number;
  readonly data: { readonly object: unknown };
}

/** Epoch seconds from the injected clock: the instant a signature and an event are stamped with. */
function nowSec(): number {
  return Math.floor(t.services.clock.nowMs() / 1000);
}

/** The `id` of an event's object, or null when it carries none. */
function objectId(object: unknown): string | null {
  if (typeof object !== 'object' || object === null) return null;
  const id = (object as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/**
 * An event envelope around an object the provider returned. A `mock` case delivers the events the
 * proxy recorded for the resources it made; in `test` mode nothing records them, so the object is
 * retrieved from Stripe's test API and wrapped here. The fresh id is what makes two hand-built
 * envelopes two distinct deliveries (AAP 0.3.2).
 */
function eventEnvelope(type: string, object: unknown): ProviderEvent {
  return {
    id: `evt_${randomBytes(12).toString('hex')}`,
    type,
    created: nowSec(),
    data: { object },
  };
}

/** The proxy's control client; only a `mock` run has one. */
function proxy(): ProxyControl {
  const control = t.stripe.proxy;
  if (control === null) throw new Error('this case needs the stateful proxy: STRIPE_MODE=mock');
  return control;
}

/** The most recent event the proxy recorded for `intentId` and `type`; null in `test` mode. */
async function recordedEvent(type: string, intentId: string): Promise<ProviderEvent | null> {
  const control = t.stripe.proxy;
  if (control === null) return null;

  const events: readonly ProviderEvent[] = await control.events();
  return (
    events.findLast((event) => event.type === type && objectId(event.data.object) === intentId) ??
    null
  );
}

/** The event the provider recorded for that intent, or an envelope around the retrieved object. */
async function eventForIntent(type: string, intentId: string): Promise<ProviderEvent> {
  const recorded = await recordedEvent(type, intentId);
  if (recorded !== null) return recorded;

  const intent = await stripeApi(t).get(`/v1/payment_intents/${encodeURIComponent(intentId)}`, {
    'expand[]': 'latest_charge',
  });
  return eventEnvelope(type, intent);
}

/**
 * Cancel a live hold at the provider with our own reason, and answer the event that reports it: the
 * cancellation is made where it can be observed, through the topology's own API, so every event a
 * case delivers is one the provider issued (AAP 0.3.2).
 */
async function ourReleaseEvent(intentId: string): Promise<ProviderEvent> {
  await stripeApi(t).post(`/v1/payment_intents/${encodeURIComponent(intentId)}/cancel`, {
    cancellation_reason: OUR_CANCELLATION_REASON,
  });
  return eventForIntent('payment_intent.canceled', intentId);
}

/** Complete a 3-D Secure step at the proxy and answer the authorization event it recorded. */
async function completionEvent(intentId: string): Promise<ProviderEvent> {
  await proxy().complete3ds(intentId);
  return eventForIntent('payment_intent.amount_capturable_updated', intentId);
}

/* Fixtures and reads (AAP 0.5.2, 0.5.3) */

/** One deposit as a webhook case reads it. */
interface DepositRow {
  readonly id: string;
  readonly status: DepositStatus;
  readonly paymentIntentId: string;
  readonly captureBefore: Date | null;
  readonly canceledAt: Date | null;
}

/** A side's deposit, requiring its live PaymentIntent: every case here acts on a real attempt. */
async function depositOf(meetupId: string, role: ParticipantRole): Promise<DepositRow> {
  const deposit = await t.services.db.deposit.findFirst({
    where: { meetupId, role },
    select: {
      id: true,
      status: true,
      currentPaymentIntentId: true,
      captureBefore: true,
      canceledAt: true,
    },
  });
  if (deposit === null || deposit.currentPaymentIntentId === null) {
    throw new Error(`no live ${role} deposit on meetup ${meetupId}`);
  }
  return {
    id: deposit.id,
    status: deposit.status,
    paymentIntentId: deposit.currentPaymentIntentId,
    captureBefore: deposit.captureBefore,
    canceledAt: deposit.canceledAt,
  };
}

/** A pair locked at a fixture venue, with a real hold on each side (AAP 0.5.3). */
interface LockedPair {
  readonly meetupId: string;
  readonly initiatorDeposit: DepositRow;
  readonly recipientDeposit: DepositRow;
}

async function lockedPair(): Promise<LockedPair> {
  const venue = await makeVenue(t, { cityId: CITY_ID });
  const initiator = await makeUser(t, { card: 'visa' });
  const recipient = await makeUser(t, { card: 'visa' });
  const meetup = await makeMeetup(t, { status: 'locked', initiator, recipient, venue });

  return {
    meetupId: meetup.id,
    initiatorDeposit: await depositOf(meetup.id, 'initiator'),
    recipientDeposit: await depositOf(meetup.id, 'recipient'),
  };
}

/** A pair awaiting the recipient's acceptance of a proposal the initiator's card authorized. */
interface OpenProposal {
  readonly meetupId: string;
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
}

/**
 * A proposal whose initiator's hold is waiting on 3-D Secure (AAP 0.5.3): the deposit is
 * `requires_action` and the proposal is invisible until the customer's step completes, which the
 * proxy performs and which records the `amount_capturable_updated` event.
 */
async function awaitingInitiation(): Promise<OpenProposal & { readonly deposit: DepositRow }> {
  const proposal = await proposeMeeting('3ds', 'visa');
  const deposit = await depositOf(proposal.meetupId, 'initiator');

  expect(deposit.status).toBe('requires_action');
  return { ...proposal, deposit };
}

/** Propose a meeting through the real route, with both accounts proved for the venue's city. */
async function proposeMeeting(
  initiatorCard: 'visa' | '3ds',
  recipientCard: 'visa' | '3ds',
): Promise<OpenProposal> {
  const venue = await makeVenue(t, { cityId: CITY_ID });
  const initiator = await makeUser(t, { card: initiatorCard });
  const recipient = await makeUser(t, { card: recipientCard });
  for (const actor of [initiator, recipient]) {
    await makeProof(t, actor, { cityId: CITY_ID });
  }

  const proposed = await callRoute(t.app, {
    method: 'POST',
    url: '/v1/meetups',
    as: initiator,
    body: {
      recipientId: recipient.id,
      venueId: venue.id,
      startsAt: new Date(t.services.clock.nowMs() + PROPOSAL_START_MS).toISOString(),
      depositCents: DEFAULT_DEPOSIT_CENTS,
    },
  });
  expect(proposed.status).toBe(201);

  return { meetupId: ProposeResponse.parse(proposed.json()).meetupId, initiator, recipient };
}

/* Assertions and reads (AAP 0.11.1's density rules) */

/** Deliver one event as the exact bytes it is signed over, and answer the route's own response. */
async function deliverOne(event: ProviderEvent): Promise<RouteResponse> {
  const payload = JSON.stringify(event);

  return callRoute(t.app, {
    method: 'POST',
    url: WEBHOOK_URL,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signStripePayload(payload, t.stripe.webhookSecret, nowSec()),
    },
    body: payload,
  });
}

/** Assert every delivery was accepted, naming the one that was not. */
function expectAccepted(responses: readonly WebhookResponse[]): void {
  for (const response of responses) {
    expect(
      response.statusCode,
      `the webhook answered ${response.statusCode}: ${response.body}`,
    ).toBe(200);
  }
}

/** Assert this event was recorded exactly once and marked applied. */
async function expectProcessedOnce(eventId: string): Promise<void> {
  const matches = await t.services.db.stripeEvent.findMany({
    where: { id: eventId },
    select: { status: true, processedAt: true },
  });

  expect(matches).toHaveLength(1);
  expect(matches[0]?.status).toBe('processed');
  expect(matches[0]?.processedAt).not.toBeNull();
}

/** Assert no delivery of this event was recorded at all. */
async function expectNoEventRow(eventId: string): Promise<void> {
  expect(await t.services.db.stripeEvent.count({ where: { id: eventId } })).toBe(0);
}

/** How many analytics rows carry `name`. */
function analyticsCount(name: string): Promise<number> {
  return t.services.db.analyticsEvent.count({ where: { name } });
}

/** The notification kinds the outbox holds, one entry per row, sorted (AAP 0.3.2). */
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

/** A meetup's stored status, and how many operations of `kind` a deposit holds. */
async function meetupStatus(meetupId: string): Promise<string> {
  const meetup = await t.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { status: true },
  });
  return meetup.status;
}

function operationCount(depositId: string, kind: 'release' | 'capture'): Promise<number> {
  return t.services.db.paymentOperation.count({ where: { depositId, kind } });
}

/* The signature (AAP 0.3.2, 0.3.3) */

describe(`${MODE} POST ${WEBHOOK_URL} — signature`, () => {
  /** An event of a type the handler does not apply: it exercises the transport and nothing else. */
  function transportEvent(): ProviderEvent {
    return eventEnvelope(UNAPPLIED_TYPE, { id: 'cus_fixture', object: 'customer' });
  }

  /** Post exact bytes with the given signature, or with none when it is omitted. */
  async function post(payload: string, signature?: string): Promise<RouteResponse> {
    return callRoute(t.app, {
      method: 'POST',
      url: WEBHOOK_URL,
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'stripe-signature': signature }),
      },
      body: payload,
    });
  }

  it('refuses a delivery that carries no signature header', async () => {
    const event = transportEvent();

    expectError(await post(JSON.stringify(event)), 400, 'bad_signature');
    await expectNoEventRow(event.id);
  });

  it('refuses a delivery signed with another secret', async () => {
    const event = transportEvent();
    const payload = JSON.stringify(event);
    const anotherSecret = randomBytes(32).toString('hex');

    const response = await post(payload, signStripePayload(payload, anotherSecret, nowSec()));

    expectError(response, 400, 'bad_signature');
    await expectNoEventRow(event.id);
  });

  it('refuses a body that was altered after it was signed', async () => {
    const event = transportEvent();
    const payload = JSON.stringify(event);
    const signature = signStripePayload(payload, t.stripe.webhookSecret, nowSec());
    const altered = payload.replace('cus_fixture', 'cus_fixturz');

    expectError(await post(altered, signature), 400, 'bad_signature');
    await expectNoEventRow(event.id);
  });

  it('accepts the exact bytes it signed, and refuses their re-serialization', async () => {
    const event = transportEvent();
    // Non-canonical whitespace: a route that verified a re-serialized payload would refuse this
    // genuine delivery, which is the whole reason the parser keeps the received bytes (AAP 0.3.3).
    const spaced = JSON.stringify(event, null, 2);
    const signature = signStripePayload(spaced, t.stripe.webhookSecret, nowSec());

    expect((await post(spaced, signature)).status).toBe(200);
    await expectProcessedOnce(event.id);

    expectError(await post(JSON.stringify(event), signature), 400, 'bad_signature');
  });
});

/* The dedupe key (AAP 0.3.2) */

describe(`${MODE} POST ${WEBHOOK_URL} — idempotency`, () => {
  it('applies one delivery of an event and skips its replay', async () => {
    const pair = await lockedPair();
    const event = await ourReleaseEvent(pair.initiatorDeposit.paymentIntentId);

    expectAccepted(await deliverStripeEvents(t.app, [event, event], t.stripe.webhookSecret));

    await expectProcessedOnce(event.id);
    expect((await depositOf(pair.meetupId, 'initiator')).status).toBe('released');
    // Our own cancellation is one forward move and nothing else: no notification, no plan of ours.
    expect(await notificationKinds()).toEqual([]);
    expect(await operationCount(pair.initiatorDeposit.id, 'release')).toBe(0);
  });

  it('records a type it does not apply and acknowledges it', async () => {
    const event = eventEnvelope(UNAPPLIED_TYPE, { id: 'cus_fixture', object: 'customer' });

    expectAccepted(await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret));

    await expectProcessedOnce(event.id);
  });

  it('acknowledges a saved card', async () => {
    const event = eventEnvelope('setup_intent.succeeded', {
      id: `seti_${randomBytes(8).toString('hex')}`,
      object: 'setup_intent',
      customer: `cus_${randomBytes(8).toString('hex')}`,
      payment_method: `pm_${randomBytes(8).toString('hex')}`,
    });

    expectAccepted(await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret));

    await expectProcessedOnce(event.id);
  });
});

/* The order events arrive in, and the effects only the proxy can drive (AAP 0.5.3) */

describe.runIf(MOCK)(`${MODE} POST ${WEBHOOK_URL} — ordering and lifecycle`, () => {
  it('acknowledges an authorization that arrives after the deposit was released', async () => {
    const pair = await lockedPair();
    const intentId = pair.initiatorDeposit.paymentIntentId;
    const authorization = await eventForIntent(
      'payment_intent.amount_capturable_updated',
      intentId,
    );
    const released = await ourReleaseEvent(intentId);

    expectAccepted(await deliverStripeEvents(t.app, [released], t.stripe.webhookSecret));
    expect((await depositOf(pair.meetupId, 'initiator')).status).toBe('released');

    // The earlier authorization is history: acknowledged, so Stripe stops retrying it, and the
    // deposit stays where it is, because a deposit only ever moves forward (AAP 0.5.3).
    expectAccepted(await deliverStripeEvents(t.app, [authorization], t.stripe.webhookSecret));
    await expectProcessedOnce(authorization.id);
    expect((await depositOf(pair.meetupId, 'initiator')).status).toBe('released');
    expect(await meetupStatus(pair.meetupId)).toBe('locked');
  });

  it('applies one of two concurrent deliveries of the same event', async () => {
    const pending = await awaitingInitiation();
    const event = await completionEvent(pending.deposit.paymentIntentId);

    const [first, second] = await Promise.all([
      deliverStripeEvents(t.app, [event], t.stripe.webhookSecret),
      deliverStripeEvents(t.app, [event], t.stripe.webhookSecret),
    ]);

    expectAccepted([...first, ...second]);
    await expectProcessedOnce(event.id);
    // The second delivery waited on the row lock and then skipped: one effect, one notification.
    expect(await analyticsCount('proposal_sent')).toBe(1);
    expect(await notificationKinds()).toEqual(['proposal_received']);
    expect((await depositOf(pending.meetupId, 'initiator')).status).toBe('held');
  });

  it('makes the proposal visible when the initiator completes 3-D Secure', async () => {
    const pending = await awaitingInitiation();
    const at = t.services.clock.nowMs();
    const event = await completionEvent(pending.deposit.paymentIntentId);

    expectAccepted(await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret));

    const deposit = await depositOf(pending.meetupId, 'initiator');
    expect(deposit.status).toBe('held');
    // The payload carries the charge as an id, so the deadline comes from the intent the handler
    // retrieves before its transaction opens (AAP 0.3.2, 0.5.2).
    expect(deposit.captureBefore).not.toBeNull();

    const meetup = await t.services.db.meetup.findUniqueOrThrow({
      where: { id: pending.meetupId },
      select: { proposalVisibleAt: true, recipientDeadline: true },
    });
    expect(meetup.proposalVisibleAt?.getTime()).toBe(at);
    expect(meetup.recipientDeadline?.getTime()).toBe(at + RECIPIENT_DEADLINE_HOURS * HOUR_MS);
    expect(await analyticsCount('proposal_sent')).toBe(1);
    expect(await notificationKinds()).toEqual(['proposal_received']);
  });

  it('retrieves the intent of an authorization whose payload carries no status', async () => {
    const pending = await awaitingInitiation();
    const at = t.services.clock.nowMs();
    await proxy().complete3ds(pending.deposit.paymentIntentId);

    // The payload a delivery may carry with no field the handler can normalize: an id and the object
    // kind alone. The state the effect decides on therefore comes from the intent the handler reads
    // before its transaction opens (AAP 0.3.2), and the delivery is posted twice, with a fresh
    // signature each time, because that is how a provider redelivers (AAP 0.3.2, 0.11.1).
    const event = eventEnvelope('payment_intent.amount_capturable_updated', {
      id: pending.deposit.paymentIntentId,
      object: 'payment_intent',
    });

    expectAccepted(await deliverStripeEvents(t.app, [event, event], t.stripe.webhookSecret));

    await expectProcessedOnce(event.id);

    const deposit = await depositOf(pending.meetupId, 'initiator');
    expect(deposit.status).toBe('held');
    // The deadline is not in this payload either: it comes from the retrieved intent (AAP 0.5.2).
    expect(deposit.captureBefore).not.toBeNull();

    const meetup = await t.services.db.meetup.findUniqueOrThrow({
      where: { id: pending.meetupId },
      select: { proposalVisibleAt: true, recipientDeadline: true },
    });
    expect(meetup.proposalVisibleAt?.getTime()).toBe(at);
    expect(meetup.recipientDeadline?.getTime()).toBe(at + RECIPIENT_DEADLINE_HOURS * HOUR_MS);
    expect(await analyticsCount('proposal_sent')).toBe(1);
    expect(await notificationKinds()).toEqual(['proposal_received']);
  });

  it('acknowledges a status-less payload naming an intent this application did not create', async () => {
    const event = eventEnvelope('payment_intent.amount_capturable_updated', {
      id: `pi_${randomBytes(12).toString('hex')}`,
      object: 'payment_intent',
    });

    // The read the reduced payload forces reports `resource_missing`, which is nothing to correlate
    // and nothing a redelivery could change, so the delivery is acknowledged as unmatched
    // (AAP 0.3.2) rather than retried forever.
    expectAccepted(await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret));

    await expectProcessedOnce(event.id);
  });

  it('acknowledges a signed payload that carries no object at all', async () => {
    // An envelope with no `data` member, which only a hand-built delivery produces: nothing can be
    // correlated and nothing throws, so the delivery is recorded and acknowledged rather than
    // answered 500 — whose retries the provider would keep sending (AAP 0.3.2, AAP 0.11.1).
    const event = {
      id: `evt_${randomBytes(12).toString('hex')}`,
      type: 'payment_intent.amount_capturable_updated',
      created: nowSec(),
    };

    expectAccepted(await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret));

    await expectProcessedOnce(event.id);
  });

  it('locks the meetup when the recipient completes 3-D Secure', async () => {
    const proposed = await proposeMeeting('visa', '3ds');

    const accepted = await callRoute(t.app, {
      method: 'POST',
      url: `/v1/meetups/${proposed.meetupId}/accept`,
      as: proposed.recipient,
    });
    expect(accepted.status).toBe(200);
    expect(AcceptResponse.parse(accepted.json()).status).toBe('proposed');

    const deposit = await depositOf(proposed.meetupId, 'recipient');
    const event = await completionEvent(deposit.paymentIntentId);

    expectAccepted(await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret));

    expect(await meetupStatus(proposed.meetupId)).toBe('locked');
    expect((await depositOf(proposed.meetupId, 'recipient')).status).toBe('held');
    expect(await analyticsCount('meetup_locked')).toBe(2);
    expect(await analyticsCount('deposit_locked')).toBe(1);
    expect(await notificationKinds()).toEqual([
      'meetup_locked',
      'meetup_locked',
      'proposal_received',
    ]);
  });

  it.each(
    rows([
      { title: 'a cancellation Stripe made', type: 'payment_intent.canceled' },
      { title: 'a charge expiry', type: 'charge.expired' },
    ]),
  )('ends the meetup without a forfeit on $title', async ({ type }) => {
    const pair = await lockedPair();
    const intentId = pair.initiatorDeposit.paymentIntentId;
    await proxy().expireHold(intentId);
    const event = await eventForIntent(type, intentId);

    expectAccepted(await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret));

    const lost = await depositOf(pair.meetupId, 'initiator');
    expect(lost.status).toBe('expired');
    expect(lost.canceledAt).not.toBeNull();
    expect(await meetupStatus(pair.meetupId)).toBe('lock_lost');
    // The surviving hold is released, nothing is captured and no credit is granted (AAP 0.3.2).
    expect(await operationCount(pair.recipientDeposit.id, 'release')).toBe(1);
    expect(await operationCount(pair.recipientDeposit.id, 'capture')).toBe(0);
    expect(await t.services.db.tableCreditEntry.count()).toBe(0);
    expect(await analyticsCount('lock_lost')).toBe(1);
    expect(await notificationKinds()).toEqual(['lock_lost', 'lock_lost']);
  });

  it('confirms a release of ours rather than reading it as a lost hold', async () => {
    const pair = await lockedPair();
    const event = await ourReleaseEvent(pair.initiatorDeposit.paymentIntentId);

    expectAccepted(await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret));

    const released = await depositOf(pair.meetupId, 'initiator');
    expect(released.status).toBe('released');
    expect(released.canceledAt).toBeNull();
    expect(await meetupStatus(pair.meetupId)).toBe('locked');
    expect(await analyticsCount('lock_lost')).toBe(0);
    expect(await notificationKinds()).toEqual([]);
  });

  it('records a hold attempt that failed at authentication', async () => {
    const venue = await makeVenue(t, { cityId: CITY_ID });
    const initiator = await makeUser(t, { card: '3ds' });
    const recipient = await makeUser(t, { card: 'visa' });
    const meetup = await makeMeetup(t, {
      status: 'proposed',
      initiator,
      recipient,
      venue,
      deposits: { initiator: 'requires_action' },
    });
    const deposit = await depositOf(meetup.id, 'initiator');

    await proxy().failAuthentication(deposit.paymentIntentId);
    const event = await eventForIntent('payment_intent.payment_failed', deposit.paymentIntentId);

    expectAccepted(await deliverStripeEvents(t.app, [event], t.stripe.webhookSecret));

    expect((await depositOf(meetup.id, 'initiator')).status).toBe('failed');
    expect(await meetupStatus(meetup.id)).toBe('proposed');
  });
});

/* A crash in either half of the transaction (AAP 0.11.2) */

describe(`${MODE} POST ${WEBHOOK_URL} — crash cases`, () => {
  it('rolls a crashed delivery back and applies the redelivery exactly once', async () => {
    const pair = await lockedPair();
    const event = await ourReleaseEvent(pair.initiatorDeposit.paymentIntentId);
    t.faults.arm('stripe_webhook.after_event_insert', { once: true });

    let crashed: RouteResponse;
    try {
      crashed = await deliverOne(event);
    } finally {
      t.faults.disarm();
    }

    expectError(crashed, 500, 'internal_error');
    expect(t.faults.hits['stripe_webhook.after_event_insert']).toBeGreaterThan(0);
    // The row was inserted in the transaction that rolled back, so neither it nor its effect stands.
    await expectNoEventRow(event.id);
    expect((await depositOf(pair.meetupId, 'initiator')).status).toBe('held');

    // Stripe's redelivery is what applies it, and it applies it once.
    expect((await deliverOne(event)).status).toBe(200);
    await expectProcessedOnce(event.id);
    expect((await depositOf(pair.meetupId, 'initiator')).status).toBe('released');
  });

  it.runIf(MOCK)('delivers what a crash after the commit left in the outbox', async () => {
    const pending = await awaitingInitiation();
    const event = await completionEvent(pending.deposit.paymentIntentId);
    t.faults.arm('stripe_webhook.after_commit', { once: true });

    let crashed: RouteResponse;
    try {
      crashed = await deliverOne(event);
    } finally {
      t.faults.disarm();
    }

    // The fault lands after the commit, so the effects stand and the request still answers 500.
    expectError(crashed, 500, 'internal_error');
    expect(t.faults.hits['stripe_webhook.after_commit']).toBeGreaterThan(0);
    await expectProcessedOnce(event.id);
    expect((await depositOf(pending.meetupId, 'initiator')).status).toBe('held');
    expect(await analyticsCount('proposal_sent')).toBe(1);

    // What the commit wrote is durable from the commit: the poller is what delivers it, and the job
    // it adds carries the row's own `outbox-<id>`, which suppresses a second enqueue (AAP 0.3.2).
    await t.services.outbox.runOnce();
    const delivered = await t.services.db.outboxMessage.findMany({
      where: { kind: 'notification' },
      select: { id: true, dispatchedAt: true },
    });
    expect(delivered).toHaveLength(1);

    for (const message of delivered) {
      expect(message.dispatchedAt).not.toBeNull();
      const jobId = `outbox-${message.id}`;
      expect((await t.services.queues.get(NOTIFICATION_QUEUE).getJob(jobId))?.id).toBe(jobId);
    }

    // The redelivery is a duplicate: this delivery was applied before the crash.
    expect((await deliverOne(event)).status).toBe(200);
    await expectProcessedOnce(event.id);
    expect(await notificationKinds()).toEqual(['proposal_received']);
  });
});
