/**
 * Rate limits, and the Redis outage behind them.
 *
 * The rules the cases turn on: one account gets 60 writes a minute and one address its own allowance, with the webhook routes at a higher
 * one and a refusal `429 rate_limited` carrying `Retry-After`; a refusal is a refusal, so each outage case asserts the state its route would
 * have written had it gone through is unchanged; and the connection's own fail-fast contract is what a case waits out.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HOUR_MS, RATE_LIMIT_USER_PER_MIN, RATE_LIMIT_WEBHOOK_IP_PER_MIN } from '@tablemate/shared';

import { runSweeper } from '../../src/modules/settlement/sweeper.ts';

import { createTestApp, pauseRedis, unpauseRedis } from '../support/app.ts';
import {
  callRoute,
  expectError,
  makeMeetup,
  makeUser,
  makeVenue,
  rows,
} from '../support/factories.ts';

import type { ErrorCode } from '@tablemate/shared';
import type { TestApp } from '../support/app.ts';
import type { RouteResponse } from '../support/factories.ts';

let t: TestApp;

const LISBON = 'lisbon';

const NOTIFICATION_QUEUE = 'notifications';

const ATTEMPT_ID = '01890a5d-ac96-774b-bcce-b302099a8057';

/** How many plain reads one case issues, to show that no counter is taken for any of them. */
const PLAIN_READS_PER_CASE = 100;

/**
 * The per-IP allowance the guard rows run on: small enough to spend inside one row, and read back from the address's
 * counter in Redis, which is where a counter that never ran is absent rather than `0`.
 */
const GUARDED_ROUTE_IP_PER_MIN = 5;

/** How long one refused request may take: the store's one-second bound plus the session cache's 250 ms. */
const OUTAGE_CASE_TIMEOUT_MS = 30_000;

/**
 * How long the pass a paused Redis holds up may take to finish once Redis answers, which is longer than a refused request: it is bounded by
 * BullMQ's own reconnect delays rather than by the rate limiter's one-second bound.
 */
const PASS_TIMEOUT_MS = 60_000;

const DECISION_ATTEMPTS = 150;
const DECISION_POLL_MS = 100;

const PRODUCER_READY_ATTEMPTS = 40;
const PRODUCER_READY_INTERVAL_MS = 250;

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

/** A counter for the device tokens the allowance cases register: `push_token.token` is unique. */
let deviceTokens = 0;

function pushTokenBody(): { token: string; platform: 'ios' } {
  deviceTokens += 1;
  return { token: `test-device-token-${String(deviceTokens)}`, platform: 'ios' };
}

function registerPushToken(
  harness: TestApp,
  user: { readonly accessToken: string },
  body: { readonly token: string; readonly platform: 'ios' } = pushTokenBody(),
): Promise<RouteResponse> {
  return callRoute(harness.app, {
    method: 'POST',
    url: '/v1/me/push-tokens',
    as: user.accessToken,
    body,
  });
}

/**
 * One injected request from a caller-chosen address. `callRoute` does not forward the client address, which is exactly what a per-IP case has
 * to vary: Fastify reads `request.ip` from the address `inject` was given.
 */
async function fromAddress(
  harness: TestApp,
  remoteAddress: string,
  request: {
    readonly method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE';
    readonly url: string;
    readonly as?: string;
    readonly body?: object;
  },
): Promise<RouteResponse> {
  const injected = await harness.app.inject({
    method: request.method,
    url: request.url,
    remoteAddress,
    ...(request.as === undefined ? {} : { headers: { authorization: `Bearer ${request.as}` } }),
    ...(request.body === undefined ? {} : { payload: request.body }),
  });
  return {
    status: injected.statusCode,
    body: injected.body,
    headers: injected.headers,
    json: <T>() => JSON.parse(injected.body) as T,
  };
}

function lastAnswer(answers: readonly RouteResponse[]): RouteResponse {
  const answer = answers.at(-1);
  if (answer === undefined) throw new Error('no request was made');
  return answer;
}

/**
 * Spend one caller's whole allowance on `send`, and answer the refusal. Every allowed request must answer `allowedStatus` and carry the
 * allowance it was counted against, which is what tells a counted route from an uncounted one.
 */
async function exhaust(
  send: () => Promise<RouteResponse>,
  allowedStatus: number,
): Promise<RouteResponse> {
  for (let request = 0; request < RATE_LIMIT_USER_PER_MIN; request += 1) {
    const answer = await send();
    expect(answer.status).toBe(allowedStatus);
    expect(Number(answer.headers['x-ratelimit-limit'])).toBe(RATE_LIMIT_USER_PER_MIN);
  }
  const refused = await send();
  expectError(refused, 429, 'rate_limited');
  expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  return refused;
}

/**
 * A locked meetup that has fallen due: it started an hour ago on the injected clock, so the check-in window is past, both attendees checked in,
 * and nothing has settled it.
 */
async function overdueMeetup(): Promise<{
  readonly meetupId: string;
  readonly initiator: { readonly accessToken: string };
}> {
  const initiator = await makeUser(t);
  const recipient = await makeUser(t);
  const venue = await makeVenue(t, { cityId: LISBON });
  const meetup = await makeMeetup(t, {
    status: 'locked',
    initiator,
    recipient,
    venue,
    startsAt: new Date(t.time.now().getTime() - HOUR_MS),
    checkIns: { initiator: 'pass', recipient: 'pass' },
  });
  return { meetupId: meetup.id, initiator };
}

async function settlementWithin(
  harness: TestApp,
  meetupId: string,
): Promise<{ readonly outcome: string; readonly status: string } | null> {
  for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt += 1) {
    const row = await harness.services.db.meetupSettlement.findUnique({
      where: { meetupId },
      select: { outcome: true, status: true },
    });
    if (row !== null) return row;
    await new Promise((resolve) => {
      setTimeout(resolve, DECISION_POLL_MS);
    });
  }
  return null;
}

async function depositStatuses(harness: TestApp, meetupId: string): Promise<string[]> {
  const deposits = await harness.services.db.deposit.findMany({
    where: { meetupId },
    select: { status: true },
  });
  return deposits.map((deposit) => deposit.status).sort();
}

interface Connection {
  readonly status: string;
  readonly ping: () => Promise<string>;
}

/**
 * Wait until `connection` is ready and answers a `PING`. Every connection the app builds is fail-fast, so a command issued before the socket
 * reached `ready` is refused rather than queued: a fresh app's first counted request would read that as a store failure.
 */
async function awaitAnswering(connection: Connection): Promise<void> {
  for (let attempt = 0; attempt < PRODUCER_READY_ATTEMPTS; attempt += 1) {
    if (connection.status === 'ready') {
      try {
        await connection.ping();
        return;
      } catch {
        // The socket dropped between the status check and the ping: the next attempt re-checks it.
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, PRODUCER_READY_INTERVAL_MS);
    });
  }
  throw new Error('a Redis connection did not answer after the outage');
}

/**
 * One mutating route whose group refuses the caller before its handler runs: the guard that group carries, what that guard
 * answers with, and the address the row drives from.
 *
 * The routes' own allowances are the same in every row; what varies is which guard refuses, because a guard is registered
 * on its group's own context and Fastify runs a context's `onRequest` hooks before a route's own `onRequest` options. The
 * counter therefore has to be registered on the group ahead of its guard — `rate-limit.ts`'s `guardRouteGroup` — and the
 * address's counter in Redis, not the status alone, is what says it was.
 */
interface GuardedRouteCase {
  /** The guard and the route, as the case is named. */
  readonly label: string;
  /** The address the row sends from; one address per row, so no row reads another's counter. */
  readonly address: string;
  /** The method the route answers: `POST` for a write, `GET` for the audited read that writes, `HEAD` for that read one method over. */
  readonly method: 'GET' | 'HEAD' | 'POST';
  /** The refusal the guard answers with: the status, and the code wherever the method answers a body to carry it. */
  readonly refusal: readonly [number, ErrorCode];
  /** The credential the caller presents; a row that omits it sends no `Authorization` header at all. */
  readonly credential?: (harness: TestApp) => Promise<string>;
  /** The mutating route, which the guard refuses before its body is read, so a row sends none. */
  readonly url: string;
}

const GUARDED_ROUTE_CASES: readonly GuardedRouteCase[] = [
  {
    label: 'requireBearer on POST /v1/me/consents',
    address: '198.51.100.11',
    method: 'POST',
    refusal: [401, 'token_invalid'],
    url: '/v1/me/consents',
  },
  {
    label: 'requireTraveler on POST /v1/events',
    address: '198.51.100.12',
    method: 'POST',
    refusal: [403, 'age_gate_required'],
    // An account that has not consented is exactly what the age gate refuses, and it needs no saved card.
    credential: async (harness) =>
      (await makeUser(harness, { consents: false, card: 'none' })).accessToken,
    url: '/v1/events',
  },
  {
    label: 'requireOperator on POST /v1/admin/price-jobs',
    address: '198.51.100.13',
    method: 'POST',
    refusal: [403, 'operator_only'],
    credential: async (harness) => (await makeUser(harness, { card: 'none' })).accessToken,
    url: '/v1/admin/price-jobs',
  },
  {
    // The audited read: a GET whose method alone cannot say it writes, so it is a counter case only because
    // the route declares `config.stateWritingRead`. The guard refuses it before the id is validated, so a
    // well-formed id no claim carries is enough.
    label: 'requireOperator on GET /v1/admin/lodging-claims/:id/booking-details',
    address: '198.51.100.14',
    method: 'GET',
    refusal: [401, 'token_invalid'],
    url: '/v1/admin/lodging-claims/00000000-0000-7000-8000-000000000000/booking-details',
  },
  {
    // The audited read one method over. Fastify derives a `HEAD` route from every `GET` and runs that route's
    // handler with the body dropped, so a `HEAD` here performs the same `OperatorAccessLog` write and is refused
    // by the same guard — which is why the counter has to charge the method the same way. That dropped body is
    // also why the case pins this row to the refusal's status: a `HEAD` answers no envelope to read a code from.
    label: 'requireOperator on HEAD /v1/admin/lodging-claims/:id/booking-details',
    address: '198.51.100.15',
    method: 'HEAD',
    refusal: [401, 'token_invalid'],
    url: '/v1/admin/lodging-claims/00000000-0000-7000-8000-000000000000/booking-details',
  },
];

describe('the per-user and per-IP allowances', () => {
  it('allows 60 writes for one account and refuses the 61st', async () => {
    const user = await makeUser(t);
    await exhaust(() => registerPushToken(t, user), 204);
    // The refusal ran before the handler: the refused registration was never stored.
    expect(await t.services.db.pushToken.count()).toBe(RATE_LIMIT_USER_PER_MIN);
    // The counter is the account's, not the route's or the address's: a second account still writes.
    const other = await makeUser(t);
    expect((await registerPushToken(t, other)).status).toBe(204);
  });
  it('counts one address across accounts and leaves another address alone', async () => {
    const limited = await createTestApp({ env: { RATE_LIMIT_IP_PER_MIN: '5' } });
    try {
      // The counters live in Redis, and this app is fresh: its first counted request would otherwise
      // race the connection and answer `503` instead of the `204` the allowance allows.
      await awaitAnswering(limited.services.redis.client);
      const owner = await makeUser(limited);
      const guest = await makeUser(limited);
      const stranger = await makeUser(limited);
      const crowded = '203.0.113.7';
      const answers: RouteResponse[] = [];
      for (const user of [owner, guest, stranger]) {
        for (let write = 0; write < 2; write += 1) {
          answers.push(
            await fromAddress(limited, crowded, {
              method: 'POST',
              url: '/v1/me/push-tokens',
              as: await limited.tokenFor(user),
              body: pushTokenBody(),
            }),
          );
        }
      }
      // Three accounts, two writes each, one address: the sixth request is the one that address cannot
      // pay for, whichever of its accounts makes it.
      expect(answers.slice(0, 5).map((answer) => answer.status)).toEqual([204, 204, 204, 204, 204]);
      const refused = lastAnswer(answers);
      expectError(refused, 429, 'rate_limited');
      expect(Number(refused.headers['x-ratelimit-limit'])).toBe(5);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // Another address is untouched by it, and so is an account of the crowded address.
      const elsewhere = await fromAddress(limited, '203.0.113.9', {
        method: 'POST',
        url: '/v1/me/push-tokens',
        as: await limited.tokenFor(stranger),
        body: pushTokenBody(),
      });
      expect(elsewhere.status).toBe(204);
    } finally {
      await limited.close();
    }
  });
  it('gives the webhook routes the higher per-IP allowance', async () => {
    // A provider's request is not a caller's: no bearer token, so the counter is per address at the
    // higher allowance, and the signature is what refuses it (AAP 0.3.3).
    const stripe = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/webhooks/stripe',
      body: { id: 'evt_fixture', type: 'charge.refunded' },
    });
    expectError(stripe, 400, 'bad_signature');
    expect(Number(stripe.headers['x-ratelimit-limit'])).toBe(RATE_LIMIT_WEBHOOK_IP_PER_MIN);
    const voice = await callRoute(t.app, {
      method: 'POST',
      url: `/v1/webhooks/voice?attemptId=${ATTEMPT_ID}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'CallSid=CAfixture&CallStatus=completed&SequenceNumber=1',
    });
    expectError(voice, 400, 'bad_signature');
    expect(Number(voice.headers['x-ratelimit-limit'])).toBe(RATE_LIMIT_WEBHOOK_IP_PER_MIN);
  });
  it.each(rows(GUARDED_ROUTE_CASES))('counts an address refused by $label', async (refused) => {
    const limited = await createTestApp({
      env: { RATE_LIMIT_IP_PER_MIN: String(GUARDED_ROUTE_IP_PER_MIN) },
    });
    try {
      // The counters live in Redis, and this app is fresh: its first counted request would otherwise race the
      // connection and answer `503` where the row expects the guard's own refusal.
      await awaitAnswering(limited.services.redis.client);
      // No credential at all where the row asks for none: the guard refuses it, and the group's counter counts it.
      const as = refused.credential === undefined ? undefined : await refused.credential(limited);
      const send = () =>
        fromAddress(limited, refused.address, {
          method: refused.method,
          url: refused.url,
          ...(as === undefined ? {} : { as }),
        });
      // A `HEAD` answers no body — Fastify's derived HEAD route drops the payload a response would have carried, the
      // error envelope included — so a HEAD row's refusal is its status alone and `expectError`, which reads the code
      // out of the body, cannot be used for it. Every other row answers the envelope and the code with it.
      const expectRefusal = (answer: RouteResponse, status: number, code: ErrorCode): void => {
        if (refused.method === 'HEAD') expect(answer.status).toBe(status);
        else expectError(answer, status, code);
      };
      for (let request = 0; request < GUARDED_ROUTE_IP_PER_MIN; request += 1) {
        expectRefusal(await send(), refused.refusal[0], refused.refusal[1]);
      }
      // What the five refusals left behind: the group's counter ran ahead of the guard, so the address paid for
      // each of them. Read as the count and not as `> 0`, because it pins the charge to one per request — the
      // route of each of these groups carries the same per-IP hook again, and a second charge would leave ten.
      expect(await limited.services.redis.client.get(`rl:ip:${refused.address}`)).toBe(
        String(GUARDED_ROUTE_IP_PER_MIN),
      );
      // The allowance is spent, so the sixth request never reaches the guard: the counter refuses it first.
      const beyondAllowance = await send();
      expectRefusal(beyondAllowance, 429, 'rate_limited');
      expect(Number(beyondAllowance.headers['x-ratelimit-limit'])).toBe(GUARDED_ROUTE_IP_PER_MIN);
      expect(Number(beyondAllowance.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});

/**
 * The contract's two reads that write, both limited per caller: the proposal detail records its recipient's first view and the suggestion route stores a
 * supplied budget. Each is marked `config.stateWritingRead`, which is how the limiter knows the method alone cannot tell them from plain reads. The
 * operator's audited booking-details read is a third such route, covered by the guard table above.
 */
const STATE_WRITING_READS: readonly (readonly [string, (meetupId: string) => string])[] = [
  ['GET /v1/meetups/:id', (meetupId) => `/v1/meetups/${meetupId}`],
  ['GET /v1/meetups/:id/suggestions', (meetupId) => `/v1/meetups/${meetupId}/suggestions`],
];

/** The plain reads a client calls constantly, which carry no counter at all. */
const PLAIN_READS: readonly (readonly [string, string])[] = [
  ['GET /v1/me', '/v1/me'],
  ['GET /v1/cities', '/v1/cities'],
  ['GET /v1/meetups', '/v1/meetups'],
];

describe('which reads carry a counter', () => {
  it.each(rows(STATE_WRITING_READS))('counts %s against its caller', async (_label, path) => {
    const initiator = await makeUser(t);
    const recipient = await makeUser(t);
    const venue = await makeVenue(t, { cityId: LISBON });
    const meetup = await makeMeetup(t, { status: 'locked', initiator, recipient, venue });
    await exhaust(
      () => callRoute(t.app, { method: 'GET', url: path(meetup.id), as: recipient.accessToken }),
      200,
    );
  });
  it.each(rows(PLAIN_READS))('leaves %s uncounted', async (_label, url) => {
    const user = await makeUser(t);
    for (let read = 0; read < PLAIN_READS_PER_CASE; read += 1) {
      const answer = await callRoute(t.app, { method: 'GET', url, as: user.accessToken });
      expect(answer.status).toBe(200);
      // No header at all is the difference between "under the limit" and "never counted".
      expect(answer.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});

/**
 * One mutating route, and the state it must leave untouched while the counter cannot read Redis.
 *
 * The two halves travel together on purpose: `503 service_unavailable` proves the request was refused
 * and `unchanged` proves it did not run, which a status-only assertion cannot tell apart.
 */
interface OutageCase {
  readonly label: string;
  readonly prepare: (harness: TestApp) => Promise<{
    readonly send: () => Promise<RouteResponse>;
    readonly unchanged: () => Promise<void>;
  }>;
}

async function nicknameOf(harness: TestApp, userId: string): Promise<string | null> {
  const profile = await harness.services.db.disclosureProfile.findUnique({
    where: { userId },
    select: { nickname: true },
  });
  return profile?.nickname ?? null;
}

async function viewedAt(harness: TestApp, meetupId: string): Promise<Date | null> {
  const row = await harness.services.db.meetup.findUniqueOrThrow({
    where: { id: meetupId },
    select: { recipientViewedAt: true },
  });
  return row.recipientViewedAt;
}

function putNickname(
  harness: TestApp,
  user: { readonly accessToken: string },
  nickname: string,
): Promise<RouteResponse> {
  return callRoute(harness.app, {
    method: 'PUT',
    url: '/v1/me/profile',
    as: user.accessToken,
    body: { nickname },
  });
}

const OUTAGE_CASES: readonly OutageCase[] = [
  {
    label: 'POST /v1/me/push-tokens',
    prepare: async (harness) => {
      const user = await makeUser(harness);
      const body = pushTokenBody();
      return {
        send: () => registerPushToken(harness, user, body),
        unchanged: async () => {
          const count = await harness.services.db.pushToken.count({ where: { token: body.token } });
          expect(count).toBe(0);
        },
      };
    },
  },
  {
    label: 'PUT /v1/me/profile',
    prepare: async (harness) => {
      const user = await makeUser(harness);
      expect((await putNickname(harness, user, 'Fixture Before')).status).toBe(200);
      return {
        send: () => putNickname(harness, user, 'Fixture After'),
        unchanged: async () => {
          expect(await nicknameOf(harness, user.id)).toBe('Fixture Before');
        },
      };
    },
  },
  {
    label: 'POST /v1/users/:id/report',
    prepare: async (harness) => {
      const reporter = await makeUser(harness);
      const reported = await makeUser(harness);
      return {
        send: () =>
          callRoute(harness.app, {
            method: 'POST',
            url: `/v1/users/${reported.id}/report`,
            as: reporter.accessToken,
            body: { reason: 'Fixture outage report' },
          }),
        unchanged: async () => {
          expect(await harness.services.db.report.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'POST /v1/meetups',
    prepare: async (harness) => {
      const initiator = await makeUser(harness);
      const recipient = await makeUser(harness);
      const venue = await makeVenue(harness, { cityId: LISBON });
      const startsAt = new Date(harness.time.now().getTime() + HOUR_MS).toISOString();
      return {
        send: () =>
          callRoute(harness.app, {
            method: 'POST',
            url: '/v1/meetups',
            as: initiator.accessToken,
            body: { recipientId: recipient.id, venueId: venue.id, startsAt, depositCents: 1000 },
          }),
        unchanged: async () => {
          // No meetup row, so nothing was proposed and no hold was placed.
          expect(await harness.services.db.meetup.count()).toBe(0);
        },
      };
    },
  },
  {
    label: 'GET /v1/meetups/:id as its recipient',
    prepare: async (harness) => {
      const initiator = await makeUser(harness);
      const recipient = await makeUser(harness);
      const venue = await makeVenue(harness, { cityId: LISBON });
      const meetup = await makeMeetup(harness, { status: 'proposed', initiator, recipient, venue });
      const url = `/v1/meetups/${meetup.id}`;
      return {
        send: () => callRoute(harness.app, { method: 'GET', url, as: recipient.accessToken }),
        unchanged: async () => {
          expect(await viewedAt(harness, meetup.id)).toBeNull();
        },
      };
    },
  },
];

describe('a Redis that answers nothing', () => {
  it.each(OUTAGE_CASES)(
    'refuses $label and writes nothing',
    async (outage) => {
      const prepared = await outage.prepare(t);
      await pauseRedis();
      try {
        expectError(await prepared.send(), 503, 'service_unavailable');
      } finally {
        await unpauseRedis();
      }
      await prepared.unchanged();
    },
    OUTAGE_CASE_TIMEOUT_MS,
  );
  it(
    'still settles an overdue meetup while Redis answers nothing',
    async () => {
      const { meetupId } = await overdueMeetup();
      await pauseRedis();
      // The pass is not awaited here on purpose. Its decision is written by the settlement transaction,
      // which reads PostgreSQL and Stripe alone (AAP 0.3.2); the pass then reaches the queue calls its
      // post-commit timers make, and those retry inside BullMQ until Redis answers, so awaiting the
      // pass here would wait on the outage instead of on the settlement.
      const pass = runSweeper(t.services);
      // A pass that rejects after an assertion failed below must not surface as an unhandled rejection.
      pass.catch(() => undefined);
      try {
        const settlement = await settlementWithin(t, meetupId);
        expect(settlement).toEqual({ outcome: 'completed', status: 'applying' });
        const settled = await t.services.db.meetup.findUniqueOrThrow({
          where: { id: meetupId },
          select: { status: true },
        });
        expect(settled.status).toBe('completed');
        // Both holds are still held: money moves in the executor phase, which runs once the pass can
        // reach the provider calls its own decisions recorded.
        expect(await depositStatuses(t, meetupId)).toEqual(['held', 'held']);
        // Durability is the point: the rows are committed, and no pass can deliver them yet.
        const waiting = await t.services.db.outboxMessage.count({ where: { dispatchedAt: null } });
        expect(waiting).toBeGreaterThan(0);
        expect(await t.services.outbox.runOnce()).toBe(0);
        expect(await t.services.db.outboxMessage.count({ where: { dispatchedAt: null } })).toBe(
          waiting,
        );
      } finally {
        await unpauseRedis();
      }
      // With Redis answering again the pass finishes its executor phase: both holds released and the
      // settlement complete.
      const sweep = await pass;
      expect(sweep.skipped).toBe(false);
      expect(sweep.settled).toBe(1);
      expect(await settlementWithin(t, meetupId)).toEqual({
        outcome: 'completed',
        status: 'complete',
      });
      expect(await depositStatuses(t, meetupId)).toEqual(['released', 'released']);
    },
    PASS_TIMEOUT_MS,
  );
  it(
    'delivers every waiting row once Redis answers again',
    async () => {
      const { meetupId, initiator } = await overdueMeetup();
      await pauseRedis();
      const pass = runSweeper(t.services);
      pass.catch(() => undefined);
      let waiting = 0;
      try {
        // The decision is durable while Redis answers nothing, and its rows are not deliverable yet.
        expect(await settlementWithin(t, meetupId)).toEqual({
          outcome: 'completed',
          status: 'applying',
        });
        waiting = await t.services.db.outboxMessage.count({ where: { dispatchedAt: null } });
        expect(waiting).toBeGreaterThan(0);
        expect(await t.services.outbox.runOnce()).toBe(0);
      } finally {
        await unpauseRedis();
      }
      await pass;
      await awaitAnswering(t.services.redis.producer);
      // Whichever pass delivers them — the settlement's own kick once Redis answered, or this one —
      // every row the outage left waiting ends dispatched.
      await t.services.outbox.runOnce();
      const messages = await t.services.db.outboxMessage.findMany({
        select: { id: true, kind: true, dispatchedAt: true },
      });
      expect(messages.length).toBe(waiting);
      for (const message of messages) {
        // A settlement's rows are its notifications, each one job in the queue that consumes it, under
        // the row's own id — which is what suppresses a second enqueue (AAP 0.3.2).
        expect(message.kind).toBe('notification');
        expect(message.dispatchedAt).not.toBeNull();
        const jobId = `outbox-${message.id}`;
        expect((await t.services.queues.get(NOTIFICATION_QUEUE).getJob(jobId))?.id).toBe(jobId);
      }
      // And the API serves writes again, not only its poller.
      expect((await registerPushToken(t, initiator)).status).toBe(204);
    },
    PASS_TIMEOUT_MS,
  );
});
