/**
 * Criterion 10 (AAP 0.12.1), with the two rules AAP 0.5.2 and 0.5.3 attach to it: what `DELETE /me`
 * and the `account-erasure` job remove, what they deliberately keep, and the two races the write
 * fence exists to decide.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, testWorkersEnv, type TestApp } from '@tablemate/api/test-support/app';
import { settleNow } from '@tablemate/api/test-support/clock';
import {
  callRoute,
  checkIn,
  expectError,
  makeBlock,
  makeCallAttempt,
  makeCallTask,
  makeClaim,
  makeDispute,
  makeLodging,
  makeMeetup,
  makeProof,
  makeUser,
  makeVenue,
  proposeAndLock,
  rows,
  signIn,
  stripeApi,
  stripeModeLabel,
  type ActorRef,
  type LodgingFixture,
  type RouteResponse,
  type UserFixture,
  type VenueFixture,
} from '@tablemate/api/test-support/factories';
import { TEST_CARDS } from '@tablemate/api/test-support/stripe-proxy/state';
import {
  DAY_MS,
  DEFAULT_DEPOSIT_CENTS,
  LODGING_SECRET_HEADER,
  LodgingClaimCreated,
  LodgingConsoleStats,
  LodgingDetail,
  MeDto,
  MetricsDto,
  PaymentSetupResponse,
  ServerFrame,
  TravelersResponse,
  WS_BEARER_SUBPROTOCOL,
} from '@tablemate/shared';
import type { ErrorCode, Reputation } from '@tablemate/shared';
import { QUEUE, actorHash, loadWorkersEnv, localTimeOn } from '@tablemate/server-core';
import {
  process as accountErasure,
  type ErasureResult,
} from '@tablemate/workers/jobs/account-erasure';
import {
  closeWorkerContext,
  createWorkerContext,
  type ProcessorJob,
  type WorkerContext,
} from '@tablemate/workers/queues';

const CITY_ID = 'lisbon';

const CITY_ZONE = 'Europe/Lisbon';

const SUITE_DAY = '2026-11-17';
const SUITE_HOUR = '10:00';

const ME_PATH = '/v1/me';
const PROFILE_PATH = '/v1/me/profile';
const PUSH_TOKENS_PATH = '/v1/me/push-tokens';
const CLAIMS_PATH = '/v1/me/lodging-claims';
const VISIBILITY_PATH = '/v1/me/lodging-visibility';
const ADMIN_METRICS_PATH = '/v1/admin/metrics';
const LODGING_STATS_PATH = '/v1/lodging-console/stats';
const CHAT_PATH = '/v1/chat';

/** The booking a claim carries: a fictional guest and reference, never a real person's. */
const BOOKING_NAME = 'Fixture Guest Ana Lima';
const BOOKING_REFERENCE = 'FIXTURE-REF-0001';

const PUSH_TOKEN = 'ExponentPushToken[fixture-device-0001]';

const RACE_BODY = 'Fixture race message';
const PROBE_BODY = 'Fixture race probe';
const RACE_BIO = 'Fixture race bio';

/** The nickname and bio the main scenario stores, which the erasure has to remove. */
const PROFILE_NICKNAME = 'Fixture Nick';
const PROFILE_BIO = 'Fixture bio for the erasure case';

const CASE_TIMEOUT_MS = 120_000;

/** How long a socket wait may take before the case fails rather than hanging. */
const FRAME_TIMEOUT_MS = 15_000;

const CLOSE_NORMAL = 1000;

const SESSION_CACHE_PREFIX = 'auth:session:';
const LEADERBOARD_CACHE_PREFIX = 'leaderboard:';

const PENDING_JOB_STATES = ['waiting', 'delayed', 'prioritized'] as const;

/**
 * The metric groups the erasure must leave untouched, named rather than compared whole: the two
 * figures {@link MetricsDto} carries that are live snapshots — `activeProofsByCity` today and the
 * calls panels — are asserted on their own instead (AAP 0.5.7).
 */
const RETAINED_METRIC_FIELDS = [
  'completion',
  'thresholds',
  'funnel',
  'counts',
  'meetupsByVenue',
  'prices',
  'lodgingClaims',
  'signups',
] as const;

let t: TestApp;
let ctx: WorkerContext;
/** The address `t.listen()` answered, which the chat socket connects to. */
let base: string;
const openedSockets: ChatSocket[] = [];

/**
 * The worker context's mailer: a capture that sends nothing, so no case opens an SMTP connection.
 */
const mailer: WorkerContext['mailer'] = {
  send(): Promise<void> {
    return Promise.resolve();
  },
};

beforeAll(async () => {
  t = await createTestApp();

  // Delivery on the chat socket happens only through the Redis subscription: a publisher never hands
  // a frame to its own local sockets, so without `start()` the sender's own confirmation never comes
  // back (AAP 0.5.1). The readiness wait comes first, because a `client`-role connection rejects a
  // command issued before its first `ready` and the module's retry is five seconds away.
  await Promise.all([ready(t.services.redis.client), ready(t.services.redis.subscriber)]);
  await t.services.pubsub.start();

  base = await t.listen();

  ctx = await createWorkerContext(loadWorkersEnv(testWorkersEnv()), {
    clock: t.clock,
    llm: t.llm,
    twilioHttpClient: t.simulator.httpClient,
    mailer,
  });
});

afterAll(async () => {
  await closeWorkerContext(ctx);
  await t.close();
});

beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
  t.time.at(localTimeOn(CITY_ZONE, SUITE_DAY, SUITE_HOUR));
});

// A socket that outlived its case would keep its registration and its heartbeat, and a payload the
// contract does not define is a defect rather than something to skip (AAP 0.5.4).
afterEach(async () => {
  for (const socket of openedSockets.splice(0, openedSockets.length)) {
    expect(socket.unreadable).toHaveLength(0);
    await socket.close();
  }
});

interface RedisReadiness {
  readonly status: string;
  once(event: 'ready', listener: () => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
}

/** The longest a Redis connection may take to become ready before the hook fails. */
const REDIS_READY_TIMEOUT_MS = 10_000;

async function ready(connection: RedisReadiness): Promise<void> {
  if (connection.status === 'ready') return;

  await new Promise<void>((settle, fail) => {
    const onReady = (): void => {
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(() => {
      connection.off('ready', onReady);
      fail(new Error('the Redis connection was not ready in time'));
    }, REDIS_READY_TIMEOUT_MS);
    connection.once('ready', onReady);
  });
}

function processorJob(job: { id?: string; name: string; data: unknown }): ProcessorJob {
  return { name: job.name, data: job.data, ...(job.id === undefined ? {} : { id: job.id }) };
}

/**
 * Deliver every pending outbox row, then run every `account-erasure` job it carried.
 * @returns What each erasure job reported; a `sweep` job's own counts are not included, because this
 */
async function drainErasure(): Promise<readonly ErasureResult[]> {
  await t.services.outbox.runOnce();

  const queue = ctx.queues.get(QUEUE.accountErasure);
  const jobs = await queue.getJobs([...PENDING_JOB_STATES], 0, -1, true);
  const results: ErasureResult[] = [];

  for (const job of jobs) {
    const result = await accountErasure(processorJob(job), ctx);
    // `counts` is what an erasure reports and a sweep does not, so it is the discriminator.
    if ('counts' in result) {
      results.push(result);
    }
    await job.remove();
  }

  return results;
}

function statusesOf(results: readonly ErasureResult[]): string[] {
  return results.map((result) => result.status);
}

function tokenFor(actor: ActorRef | UserFixture): Promise<string> {
  return t.tokenFor(actor);
}

/**
 * Give a signed-in account the saved card a hold needs (AAP 0.3.2, 0.5.3).
 * @param actor - The signed-in account, whose own token carries the request.
 * @returns The customer id the account now names.
 * @throws {Error} When the provider attached no payment method in `STRIPE_MODE=test`.
 */
async function saveCard(actor: ActorRef | UserFixture): Promise<string> {
  const setup = await callRoute(t.app, {
    method: 'POST',
    url: '/v1/me/payment-setup',
    as: await tokenFor(actor),
  });
  expect(setup.status, `POST /v1/me/payment-setup answered ${setup.status}: ${setup.body}`).toBe(
    200,
  );
  const { customerId } = PaymentSetupResponse.parse(setup.json());

  const proxy = t.stripe.proxy;
  if (proxy !== null) {
    await proxy.attachCard(customerId, TEST_CARDS.visa, { makeDefault: true });
    return customerId;
  }

  const api = stripeApi(t);
  const attached = await api.post<{ id?: unknown }>(
    `/v1/payment_methods/${encodeURIComponent(TEST_CARDS.visa)}/attach`,
    { customer: customerId },
  );
  const paymentMethodId = typeof attached.id === 'string' ? attached.id : null;
  if (paymentMethodId === null) {
    throw new Error('stripe attached no payment method');
  }

  await api.post(`/v1/customers/${customerId}`, {
    'invoice_settings[default_payment_method]': paymentMethodId,
  });
  return customerId;
}

async function expectRoute(
  request: Parameters<typeof callRoute>[1],
  status: number,
): Promise<RouteResponse> {
  const answer = await callRoute(t.app, request);
  expect(
    answer.status,
    `${request.method} ${request.url} answered ${answer.status}: ${answer.body}`,
  ).toBe(status);
  return answer;
}

async function readMetrics(operator: ActorRef | UserFixture): Promise<MetricsDto> {
  const answer = await expectRoute(
    {
      method: 'GET',
      url: ADMIN_METRICS_PATH,
      as: await tokenFor(operator),
      query: { from: SUITE_DAY, to: SUITE_DAY, cityId: CITY_ID },
    },
    200,
  );
  return MetricsDto.parse(answer.json());
}

function retainedMetrics(metrics: MetricsDto): Record<string, unknown> {
  const retained: Record<string, unknown> = {};
  for (const field of RETAINED_METRIC_FIELDS) {
    retained[field] = metrics[field];
  }
  return retained;
}

function activeProofsOf(metrics: MetricsDto, cityId: string): number {
  return metrics.activeProofsByCity.find((entry) => entry.cityId === cityId)?.count ?? 0;
}

async function readLodgingStats(lodging: LodgingFixture): Promise<LodgingConsoleStats> {
  const answer = await expectRoute(
    {
      method: 'GET',
      url: LODGING_STATS_PATH,
      headers: { [LODGING_SECRET_HEADER]: lodging.secret ?? '' },
    },
    200,
  );
  return LodgingConsoleStats.parse(answer.json());
}

async function readLodgingDetail(
  lodging: LodgingFixture,
  viewer: ActorRef | UserFixture,
): Promise<LodgingDetail> {
  const answer = await expectRoute(
    { method: 'GET', url: `/v1/lodgings/${lodging.id}`, as: await tokenFor(viewer) },
    200,
  );
  return LodgingDetail.parse(answer.json());
}

async function readTravelers(viewer: ActorRef | UserFixture): Promise<TravelersResponse> {
  const answer = await expectRoute(
    { method: 'GET', url: `/v1/cities/${CITY_ID}/travelers`, as: await tokenFor(viewer) },
    200,
  );
  return TravelersResponse.parse(answer.json());
}

/**
 * The leaderboard's cached board, dropped so a re-read recomputes it: `activityScore` comes from the
 * facts, but `rank` comes from a board cached for sixty seconds, and a stale board would hide a
 * change rather than show one (AAP 0.5.7).
 */
async function clearLeaderboardCache(): Promise<void> {
  const keys = await t.services.redis.client.keys(`${LEADERBOARD_CACHE_PREFIX}*`);
  if (keys.length > 0) {
    await t.services.redis.client.del(...keys);
  }
}

async function readCachedSession(sessionId: string): Promise<string | null> {
  const key = `${SESSION_CACHE_PREFIX}${sessionId}`;

  // The write is fire-and-forget on the API's side, so a read that follows the response may arrive
  // before the entry does; these retries wait for it rather than deciding the cache is unused.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = await t.services.redis.client.get(key);
    if (raw !== null) return raw;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  return null;
}

async function restoreCachedSession(sessionId: string, raw: string): Promise<void> {
  await t.services.redis.client.set(`${SESSION_CACHE_PREFIX}${sessionId}`, raw, 'PX', 30_000);
}

/**
 * What one socket wait produced: the frame the API sent, or the close it ended with. A refused write
 * is answered with an error frame before the close, so a case reads whichever arrives.
 */
type SocketOutcome =
  | { readonly kind: 'frame'; readonly frame: ServerFrame }
  | { readonly kind: 'closed'; readonly code: number };

interface ChatSocket {
  /** Every frame received, in arrival order. */
  readonly frames: ServerFrame[];
  /** Payloads that were not a `ServerFrame`; `afterEach` asserts this stays empty. */
  readonly unreadable: string[];
  /** Send one chat frame, as the client's own `{ meetupId, body }` (AAP 0.5.4). */
  send(frame: { readonly meetupId: string; readonly body: string }): void;
  /** Resolve with the next frame or close, or reject once `timeoutMs` has passed. */
  next(timeoutMs?: number): Promise<SocketOutcome>;
  /** Close the socket and wait for the close to complete. */
  close(): Promise<void>;
}

function parseFrame(text: unknown): ServerFrame | null {
  if (typeof text !== 'string') return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  const parsed = ServerFrame.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Bind the frames and waits of one connection, and register it for `afterEach`.
 * @param token - The access token to open with.
 * @returns The socket, once its handshake completed.
 * @throws {Error} When the upgrade failed or the connection closed before it completed.
 */
function openChatSocket(token: string): Promise<ChatSocket> {
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}${CHAT_PATH}`, [
    WS_BEARER_SUBPROTOCOL,
    token,
  ]);

  const frames: ServerFrame[] = [];
  const unreadable: string[] = [];
  const outcomes: SocketOutcome[] = [];
  const waiters = new Set<() => void>();
  const closeWaiters: (() => void)[] = [];
  let closedCode: number | null = null;

  // The handshake settles once, whichever of the three events reaches it first.
  let settleHandshake: ((socket: ChatSocket) => void) | null = null;
  let failHandshake: ((error: Error) => void) | null = null;

  /** Record one outcome and wake every wait that is looking for one. */
  function push(outcome: SocketOutcome): void {
    outcomes.push(outcome);
    for (const wake of [...waiters]) {
      wake();
    }
  }

  // The event is annotated structurally rather than with the DOM's own type: the project compiles
  // against `lib: ES2023`, so only Node's globals are in scope, and `data` is `unknown` here — which
  // is exactly what a parsed frame needs to start from.
  socket.onmessage = (event: { readonly data: unknown }): void => {
    const frame = parseFrame(event.data);
    if (frame === null) {
      unreadable.push(typeof event.data === 'string' ? event.data : '<binary>');
      return;
    }
    frames.push(frame);
    push({ kind: 'frame', frame });
  };

  socket.onclose = (event: { readonly code: number }): void => {
    closedCode = event.code;
    push({ kind: 'closed', code: event.code });
    for (const done of closeWaiters.splice(0, closeWaiters.length)) {
      done();
    }
    failHandshake?.(new Error('the socket closed before its handshake completed'));
  };

  socket.onerror = (): void => {
    failHandshake?.(new Error('the chat socket failed to connect'));
  };

  async function next(timeoutMs = FRAME_TIMEOUT_MS): Promise<SocketOutcome> {
    const claimed = outcomes.shift();
    if (claimed !== undefined) return claimed;
    return new Promise<SocketOutcome>((resolve, reject) => {
      const wake = (): void => {
        clearTimeout(timer);
        waiters.delete(wake);
        const outcome = outcomes.shift();
        if (outcome !== undefined) resolve(outcome);
      };
      const timer = setTimeout(() => {
        waiters.delete(wake);
        reject(new Error(`the socket produced no frame or close within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      waiters.add(wake);
    });
  }

  async function close(): Promise<void> {
    if (closedCode !== null) return;
    await new Promise<void>((done) => {
      closeWaiters.push(done);
      socket.close(CLOSE_NORMAL);
    });
  }

  const handle: ChatSocket = {
    frames,
    unreadable,
    send: (frame) => {
      // A send on a closed socket throws, and the race cases may reach this line after the deletion
      // ended the connection: the close is recorded instead, which is the refusal they read.
      if (socket.readyState !== socket.OPEN) {
        push({ kind: 'closed', code: closedCode ?? 0 });
        return;
      }
      socket.send(JSON.stringify(frame));
    },
    next,
    close,
  };

  socket.onopen = (): void => {
    openedSockets.push(handle);
    settleHandshake?.(handle);
  };

  return new Promise<ChatSocket>((resolve, reject) => {
    settleHandshake = resolve;
    failHandshake = reject;
  });
}

function errorOutcome(outcome: SocketOutcome, code: ErrorCode): ServerFrame | null {
  if (outcome.kind !== 'frame') return null;
  return outcome.frame.type === 'error' && outcome.frame.code === code ? outcome.frame : null;
}

function messageOf(frame: ServerFrame | undefined): string | null {
  return frame !== undefined && frame.type === 'message' ? frame.message.body : null;
}

interface Actor extends ActorRef {
  readonly handle: string;
}

async function signUp(label: string): Promise<Actor> {
  const signedIn = await signIn(t, `fixture-${label}@example.test`);
  return { id: signedIn.userId, sessionId: signedIn.sessionId, handle: signedIn.user.handle };
}

/** The venue's console secret, which the check-in code is derived from. */
function secretOf(venue: VenueFixture): string {
  if (venue.secret === null) throw new Error('the fixture venue holds no console secret');
  return venue.secret;
}

/** Everything one pass of the main scenario holds, so its assertions read it by name. */
interface Scenario {
  readonly user: Actor;
  readonly counterpart: Actor;
  readonly viewer: Actor;
  readonly operator: UserFixture;
  readonly venue: VenueFixture;
  readonly lodging: LodgingFixture;
  readonly meetupId: string;
  readonly nullifier: string;
  readonly assignmentId: string;
  readonly eventIds: readonly string[];
}

interface Aggregates {
  readonly metrics: MetricsDto;
  readonly stats: LodgingConsoleStats;
  readonly facts: number;
  readonly reputation: Reputation;
}

/** A 1×1 WebP image, so the photo row holds a real file rather than filler (AAP 0.5.2). */
const TINY_WEBP = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=',
  'base64',
);

/**
 * Build the state criterion 10 deletes: two signed-in accounts with proofs and saved cards, a
 * verified lodging claim with its visibility on, a meetup locked, checked into and settled at a
 * partner venue, and the rows around them.
 * @returns The ids and handles every assertion in the criterion's case reads.
 */
async function buildScenario(): Promise<Scenario> {
  const db = t.services.db;
  const user = await signUp('deletion-user');
  const counterpart = await signUp('deletion-counterpart');
  const viewer = await signUp('deletion-viewer');
  const operator = await makeUser(t, { role: 'operator' });

  await saveCard(user);
  await saveCard(counterpart);

  const proof = await makeProof(t, user, { cityId: CITY_ID });
  await makeProof(t, counterpart, { cityId: CITY_ID });
  await makeProof(t, viewer, { cityId: CITY_ID });

  const venue = await makeVenue(t, { cityId: CITY_ID });
  const lodging = await makeLodging(t, { cityId: CITY_ID, withSecret: true });

  const submitted = await expectRoute(
    {
      method: 'POST',
      url: CLAIMS_PATH,
      as: await tokenFor(user),
      body: {
        lodgingId: lodging.id,
        stayFrom: proof.arrivalDate,
        stayTo: proof.departureDate,
        bookingName: BOOKING_NAME,
        bookingReference: BOOKING_REFERENCE,
        callConsent: true,
      },
    },
    201,
  );
  const { claimId } = LodgingClaimCreated.parse(submitted.json());
  await expectRoute(
    {
      method: 'POST',
      url: `/v1/admin/lodging-claims/${claimId}/resolve`,
      as: await tokenFor(operator),
      body: { outcome: 'verified' },
    },
    200,
  );
  await expectRoute(
    {
      method: 'PUT',
      url: VISIBILITY_PATH,
      as: await tokenFor(user),
      body: { showStaying: true },
    },
    200,
  );

  for (const label of ['guest-a', 'guest-b', 'guest-c']) {
    const guest = await makeUser(t, { email: `fixture-${label}@example.test` });
    await makeClaim(t, guest, lodging, {
      status: 'verified',
      stayFrom: proof.arrivalDate,
      stayTo: proof.departureDate,
    });
  }

  const locked = await proposeAndLock(t, {
    initiator: user,
    recipient: counterpart,
    venue,
  });
  await expectRoute(
    { method: 'GET', url: `/v1/meetups/${locked.meetupId}`, as: await tokenFor(counterpart) },
    200,
  );

  t.time.toMeetupPoint(locked, 'startsAt');
  const at = { id: locked.meetupId, venueId: venue.id };
  await checkIn(t, user, at, { venueSecret: secretOf(venue) });
  const together = await checkIn(t, counterpart, at, { venueSecret: secretOf(venue) });
  expect(together.bothCheckedIn, 'the second check-in completes the meetup').toBe(true);

  t.time.toMeetupPoint(locked, 'startsAt+45m');
  await settleNow(t.services);

  const settled = await db.meetup.findUniqueOrThrow({ where: { id: locked.meetupId } });
  expect(settled.status, 'the settled meetup is completed').toBe('completed');
  expect(
    await db.lodgingActivityFact.count({ where: { lodgingId: lodging.id } }),
    'the completed meetup credits the lodging the guest verified',
  ).toBe(1);

  const now = t.time.now();
  for (const body of ['Fixture message one', 'Fixture message two']) {
    await db.message.create({
      data: { meetupId: locked.meetupId, senderId: user.id, body, createdAt: now },
    });
    await db.message.create({
      data: { meetupId: locked.meetupId, senderId: counterpart.id, body, createdAt: now },
    });
  }

  const stranger = await makeUser(t);
  await makeBlock(t, user, stranger);
  await makeBlock(t, stranger, user);
  await expectRoute(
    {
      method: 'POST',
      url: PUSH_TOKENS_PATH,
      as: await tokenFor(user),
      body: { token: PUSH_TOKEN, platform: 'ios' },
    },
    204,
  );
  await db.profilePhoto.create({
    data: { userId: user.id, webp: TINY_WEBP, width: 1, height: 1 },
  });
  await expectRoute(
    {
      method: 'PUT',
      url: PROFILE_PATH,
      as: await tokenFor(user),
      body: { nickname: PROFILE_NICKNAME, bio: PROFILE_BIO },
    },
    200,
  );

  const assignment = await db.experimentAssignment.findUniqueOrThrow({
    where: { userId: user.id },
    select: { assignmentId: true },
  });
  const events = await db.analyticsEvent.findMany({
    where: { actorHash: actorHash(t.env.ANALYTICS_SALT, user.id) },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  return {
    user,
    counterpart,
    viewer,
    operator,
    venue,
    lodging,
    meetupId: locked.meetupId,
    nullifier: proof.nullifier,
    assignmentId: assignment.assignmentId,
    eventIds: events.map((event) => event.id),
  };
}

async function readAggregates(scenario: Scenario): Promise<Aggregates> {
  const metrics = await readMetrics(scenario.operator);
  const stats = await readLodgingStats(scenario.lodging);
  const facts = await t.services.db.lodgingActivityFact.count({
    where: { lodgingId: scenario.lodging.id },
  });
  const me = await expectRoute(
    { method: 'GET', url: ME_PATH, as: await tokenFor(scenario.counterpart) },
    200,
  );

  return { metrics, stats, facts, reputation: MeDto.parse(me.json()).reputation };
}

/** `DELETE /me` as `actor`, which the contract answers `202` with no body (AAP 0.5.4). */
async function deleteAccount(actor: ActorRef | UserFixture): Promise<void> {
  await expectRoute({ method: 'DELETE', url: ME_PATH, as: await tokenFor(actor) }, 202);
}

async function meetupState(meetupId: string) {
  return {
    meetup: await t.services.db.meetup.findUniqueOrThrow({ where: { id: meetupId } }),
    deposits: await t.services.db.deposit.findMany({
      where: { meetupId },
      select: { ownerId: true, status: true },
      orderBy: { ownerId: 'asc' },
    }),
  };
}

interface DeletionParty {
  readonly user: UserFixture;
  readonly counterpart: UserFixture;
  readonly venue: VenueFixture;
}

async function makeParty(): Promise<DeletionParty> {
  const [user, counterpart] = [await makeUser(t), await makeUser(t)];
  return { user, counterpart, venue: await makeVenue(t, { cityId: CITY_ID }) };
}

const MEASURE_PROPS = ['variantPairing', 'depositCents', 'outcome', 'resolveSeconds'];

describe('account deletion (AAP 0.12.1 criterion 10)', { timeout: CASE_TIMEOUT_MS }, () => {
  it('erases the live state, keeps every retained aggregate and unlinks the analytics', async () => {
    const db = t.services.db;
    const scenario = await buildScenario();
    /* Before: what the erasure must delete, what it must keep, and the figures it may not move. */
    const before = await readAggregates(scenario);
    expect(before.metrics.completion.lockedMeetups, 'the scenario locked one meetup').toBe(1);
    expect(before.metrics.completion.bothCheckedIn).toBe(1);
    expect(before.metrics.funnel.bothCheckedIn).toBe(1);
    expect(
      before.metrics.signups,
      'both accounts were created by the real flow',
    ).toBeGreaterThanOrEqual(2);
    expect(before.metrics.lodgingClaims.submitted).toBe(1);
    expect(before.metrics.lodgingClaims.verified).toBe(1);
    expect(before.metrics.lodgingClaims.medianResolveSeconds).not.toBeNull();
    expect(before.stats.activityScore, 'the completed meetup scores once').toBe(1);
    expect(before.facts).toBe(1);
    expect(before.reputation.witnessedMeetups).toBe(1);
    expect(scenario.eventIds.length, 'the account produced events to unlink').toBeGreaterThan(2);
    const activeProofsBefore = activeProofsOf(before.metrics, CITY_ID);
    expect(activeProofsBefore).toBeGreaterThanOrEqual(3);
    const detailBefore = await readLodgingDetail(scenario.lodging, scenario.viewer);
    expect(detailBefore.guestCount, 'four verified guests, so the count is a number').toBe(4);
    expect(detailBefore.guests.map((guest) => guest.id)).toEqual([scenario.user.id]);
    expect(before.stats.verifiedGuests).toBe(4);
    expect((await readTravelers(scenario.viewer)).items.map((item) => item.id)).toContain(
      scenario.user.id,
    );
    /* The deletion: the account is closed to writes at once and its erasure is queued (AAP 0.5.3). */
    const token = await tokenFor(scenario.user);
    await deleteAccount(scenario.user);
    expectError(
      await callRoute(t.app, { method: 'GET', url: ME_PATH, as: token }),
      401,
      'token_invalid',
    );
    expect(
      await db.session.count({ where: { userId: scenario.user.id, revokedAt: null } }),
      'every session and refresh token is revoked',
    ).toBe(0);
    const queued = await db.outboxMessage.findMany({
      where: { kind: 'account_erasure' },
      select: { payload: true },
    });
    expect(queued.map((row) => row.payload)).toEqual([{ userId: scenario.user.id }]);
    expect(statusesOf(await drainErasure())).toEqual(['erased']);
    /* After: the live state is gone and the tombstone is what the retained records point at. */
    const tombstone = await db.user.findUniqueOrThrow({ where: { id: scenario.user.id } });
    expect(tombstone.deletedAt?.getTime(), 'the tombstone is dated by the injected clock').toBe(
      t.time.now().getTime(),
    );
    expect(tombstone.deletionRequestedAt).not.toBeNull();
    const personal = [
      tombstone.emailCiphertext,
      tombstone.emailLookupHash,
      tombstone.handle,
      tombstone.avatarSeed,
      tombstone.homeCity,
      tombstone.homeCountryCode,
      tombstone.ageConfirmedAt,
      tombstone.termsVersion,
      tombstone.stripeCustomerId,
    ];
    expect(personal.filter((field) => field !== null)).toEqual([]);
    const owner = { userId: scenario.user.id };
    expect(await db.disclosureProfile.count({ where: owner })).toBe(0);
    expect(await db.profilePhoto.count({ where: owner })).toBe(0);
    expect(await db.message.count({ where: { senderId: scenario.user.id } })).toBe(0);
    expect(await db.itineraryProof.count({ where: owner })).toBe(0);
    expect(await db.session.count({ where: owner })).toBe(0);
    expect(await db.pushToken.count({ where: owner })).toBe(0);
    expect(await db.lodgingClaim.count({ where: owner })).toBe(0);
    expect(await db.lodgingVisibility.count({ where: owner })).toBe(0);
    expect(await db.experimentAssignment.count({ where: owner })).toBe(0);
    expect(
      await db.block.count({
        where: { OR: [{ blockerId: scenario.user.id }, { blockedId: scenario.user.id }] },
      }),
    ).toBe(0);
    expect(await db.spentNullifier.count({ where: { nullifier: scenario.nullifier } })).toBe(1);
    expect(await db.message.count({ where: { senderId: scenario.counterpart.id } })).toBe(2);
    expectError(
      await callRoute(t.app, {
        method: 'GET',
        url: `/v1/users/${scenario.user.id}`,
        as: await tokenFor(scenario.counterpart),
      }),
      404,
      'user_not_found',
    );
    /* Unchanged: every figure computed from retained facts and unlinked events. */
    await clearLeaderboardCache();
    const after = await readAggregates(scenario);
    expect(retainedMetrics(after.metrics)).toEqual(retainedMetrics(before.metrics));
    expect(after.stats.activityScore).toBe(before.stats.activityScore);
    expect(after.stats.weeklyTrend).toEqual(before.stats.weeklyTrend);
    expect(after.stats.rank).toBe(before.stats.rank);
    expect(after.facts).toBe(before.facts);
    expect(after.reputation, "the counterpart's counters are untouched").toEqual(before.reputation);
    /* Removal reflected: the live figures follow the roster at once (AAP 0.5.2). */
    const detailAfter = await readLodgingDetail(scenario.lodging, scenario.viewer);
    expect(detailAfter.guestCount).toBe(3);
    expect(detailAfter.guests).toEqual([]);
    expect(after.stats.verifiedGuests).toBe(3);
    expect(activeProofsOf(after.metrics, CITY_ID)).toBe(activeProofsBefore - 1);
    expect((await readTravelers(scenario.viewer)).items.map((item) => item.id)).not.toContain(
      scenario.user.id,
    );
    /* The unlink: the deleted account's events keep their measures and lose every re-identifier. */
    const salt = t.env.ANALYTICS_SALT;
    expect(
      await db.analyticsEvent.count({ where: { actorHash: actorHash(salt, scenario.user.id) } }),
    ).toBe(0);
    expect(await db.analyticsEvent.count({ where: { assignmentId: scenario.assignmentId } })).toBe(
      0,
    );
    expect(
      await db.analyticsEvent.count({
        where: { meetupId: scenario.meetupId, actorHash: actorHash(salt, scenario.counterpart.id) },
      }),
      "the counterpart's own events keep the meetup link",
    ).toBeGreaterThan(0);
    const mine = await db.analyticsEvent.findMany({
      where: { id: { in: [...scenario.eventIds] } },
    });
    expect(mine).toHaveLength(scenario.eventIds.length);
    for (const event of mine) {
      expect(event.actorHash).toBeNull();
      expect(event.assignmentId).toBeNull();
      expect(event.meetupId).toBeNull();
      expect(event.occurredAt.getTime() % DAY_MS, 'the time of day is truncated').toBe(0);
      const props: unknown = event.props;
      const keys = typeof props === 'object' && props !== null ? Object.keys(props) : [];
      expect(keys.filter((key) => !MEASURE_PROPS.includes(key))).toEqual([]);
    }
  });
});

describe('what the deletion does to what is still open', { timeout: CASE_TIMEOUT_MS }, () => {
  it('cancels a proposed meetup outright, releasing the hold it was waiting on', async () => {
    const { user, counterpart, venue } = await makeParty();
    const meetup = await makeMeetup(t, {
      status: 'proposed',
      initiator: user,
      recipient: counterpart,
      venue,
    });
    await deleteAccount(user);
    expect(statusesOf(await drainErasure())).toEqual(['erased']);
    const state = await meetupState(meetup.id);
    expect(state.meetup.status).toBe('cancelled');
    expect(state.meetup.cancelReason).toBe('account_deleted');
    expect(state.deposits).toEqual([{ ownerId: user.id, status: 'released' }]);
  });

  it('cancels a locked meetup exactly two hours before it starts, with no forfeit', async () => {
    const { user, counterpart, venue } = await makeParty();
    const meetup = await makeMeetup(t, {
      status: 'locked',
      initiator: user,
      recipient: counterpart,
      venue,
    });
    // The boundary itself is still free: the forfeit begins one second later (AAP 0.5.3).
    t.time.toMeetupPoint(meetup, 'startsAt-2h');
    await deleteAccount(user);
    expect(statusesOf(await drainErasure())).toEqual(['erased']);
    const state = await meetupState(meetup.id);
    expect(state.meetup.status).toBe('cancelled');
    expect(state.meetup.cancelReason).toBe('account_deleted');
    expect(state.deposits.every((deposit) => deposit.status === 'released')).toBe(true);
    expect(await t.services.db.tableCreditEntry.count({ where: { meetupId: meetup.id } })).toBe(0);
  });

  it(`forfeits a cancellation one second past the boundary ${stripeModeLabel()}`, async () => {
    const db = t.services.db;
    const { user, counterpart, venue } = await makeParty();
    const meetup = await makeMeetup(t, {
      status: 'locked',
      initiator: user,
      recipient: counterpart,
      venue,
    });
    t.time.toMeetupPoint(meetup, 'startsAt-2h', 1_000);
    await deleteAccount(user);
    expect(statusesOf(await drainErasure())).toEqual(['erased']);
    const state = await meetupState(meetup.id);
    expect(state.meetup.status).toBe('forfeited');
    expect(state.meetup.forfeitReason).toBe('late_cancel');
    const deposits = await db.deposit.findMany({
      where: { meetupId: meetup.id },
      select: { id: true, ownerId: true, status: true },
      orderBy: { ownerId: 'asc' },
    });
    const cancelled = deposits.find((deposit) => deposit.ownerId === user.id);
    const credited = deposits.find((deposit) => deposit.ownerId === counterpart.id);
    if (cancelled === undefined || credited === undefined) {
      throw new Error('the fixture meetup holds no deposit for both sides');
    }
    expect(cancelled.status).toBe('captured');
    expect(credited.status).toBe('released');
    const capture = await db.paymentOperation.findFirst({
      where: { depositId: cancelled.id, kind: 'capture' },
      select: { status: true },
    });
    expect(capture?.status, 'the capture is carried out by the executor').toBe('succeeded');
    const credits = await db.tableCreditEntry.findMany({
      where: { meetupId: meetup.id },
      select: { userId: true, kind: true, amountCents: true },
    });
    expect(credits).toEqual([
      { userId: counterpart.id, kind: 'grant', amountCents: DEFAULT_DEPOSIT_CENTS },
    ]);
  });

  it('leaves a disputed meetup to the operator, and finishes the erasure once it is resolved', async () => {
    const db = t.services.db;
    const operator = await makeUser(t, { role: 'operator' });
    const { user, counterpart, venue } = await makeParty();
    const meetup = await makeMeetup(t, {
      status: 'locked',
      initiator: user,
      recipient: counterpart,
      venue,
    });
    const dispute = await makeDispute(t, meetup, user);
    const now = t.time.now();
    for (const body of ['Fixture disputed message one', 'Fixture disputed message two']) {
      await db.message.create({
        data: { meetupId: meetup.id, senderId: user.id, body, createdAt: now },
      });
    }
    await deleteAccount(user);
    expect(statusesOf(await drainErasure())).toEqual(['partial']);
    const state = await meetupState(meetup.id);
    expect(state.meetup.status).toBe('locked');
    expect(state.deposits.every((deposit) => deposit.status === 'held')).toBe(true);
    expect((await db.dispute.findUniqueOrThrow({ where: { id: dispute.id } })).status).toBe('open');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).toBeNull();
    expect(await db.message.count({ where: { senderId: user.id } })).toBe(2);
    const planned = await db.paymentOperation.findFirstOrThrow({
      where: { userId: user.id, kind: 'delete_customer' },
      select: { depositId: true, stripeCustomerId: true, status: true },
    });
    expect(planned.depositId).toBeNull();
    expect(planned.status).toBe('pending');
    expect(planned.stripeCustomerId).toBe(user.stripeCustomerId);
    await expectRoute(
      {
        method: 'POST',
        url: `/v1/admin/disputes/${dispute.id}/resolve`,
        as: await tokenFor(operator),
        body: { outcome: 'no_fault' },
      },
      200,
    );
    expect((await db.meetup.findUniqueOrThrow({ where: { id: meetup.id } })).status).toBe(
      'no_fault',
    );
    expect(state.deposits.every((deposit) => deposit.status === 'held')).toBe(true);
    const requeued = await db.outboxMessage.findMany({
      where: { kind: 'account_erasure' },
      select: { payload: true },
    });
    expect(requeued.map((row) => row.payload)).toEqual([{ userId: user.id }, { userId: user.id }]);
    expect(statusesOf(await drainErasure())).toEqual(['erased']);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).not.toBeNull();
    expect(await db.message.count({ where: { senderId: user.id } })).toBe(0);
  });

  it('deletes a claim a call is already working on, and cancels its verification', async () => {
    const db = t.services.db;
    const { user } = await makeParty();
    const lodging = await makeLodging(t, { cityId: CITY_ID });
    const claim = await makeClaim(t, user, lodging, { status: 'calling' });
    const task = await makeCallTask(t, {
      kind: 'lodging_stay_verification',
      lodgingId: lodging.id,
      lodgingClaimId: claim.id,
      status: 'in_progress',
    });
    const attempt = await makeCallAttempt(t, task, { state: 'dialing' });
    await deleteAccount(user);
    expect(statusesOf(await drainErasure())).toEqual(['erased']);
    expect(await db.lodgingClaim.count({ where: { id: claim.id } })).toBe(0);
    expect((await db.callTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'cancelled',
    );
    expect(
      (await db.callAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).superseded,
      'the live call is superseded, which is how the relay is told to stop',
    ).toBe(true);
  });

  it("plans the Stripe customer's removal and carries it out once the money is settled", async () => {
    const db = t.services.db;
    const { user, counterpart, venue } = await makeParty();
    await makeMeetup(t, { status: 'proposed', initiator: user, recipient: counterpart, venue });
    await deleteAccount(user);
    const operation = await db.paymentOperation.findFirstOrThrow({
      where: { userId: user.id, kind: 'delete_customer' },
      select: { depositId: true, idempotencyKey: true, stripeCustomerId: true, status: true },
    });
    expect(operation.depositId, 'the deletion belongs to the account, not a deposit').toBeNull();
    expect(operation.idempotencyKey).toBe(`delete_customer:${user.id}`);
    expect(operation.status, 'the executor ran it once the deposits were final').toBe('succeeded');
    expect(operation.stripeCustomerId, 'the copied id is consumed by the success').toBeNull();
    expect(statusesOf(await drainErasure())).toEqual(['erased']);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).stripeCustomerId,
    ).toBeNull();
  });
});

type RaceOrder = 'write-then-delete' | 'delete-then-write' | 'simultaneous';

interface RaceRow {
  readonly order: RaceOrder;
  readonly label: string;
}

/** Each ordering once, so every way the two writes and the deletion can interleave is covered. */
const RACE_ORDERS: readonly RaceRow[] = rows([
  { order: 'write-then-delete', label: 'the writes first' },
  { order: 'delete-then-write', label: 'the deletion first' },
  { order: 'simultaneous', label: 'both at once' },
]);

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function bodyOf(outcome: SocketOutcome): string | null {
  return outcome.kind === 'frame' ? messageOf(outcome.frame) : null;
}

interface RaceState {
  readonly user: Actor;
  readonly counterpart: Actor;
  readonly meetupId: string;
  readonly token: string;
  readonly socket: ChatSocket;
}

/**
 * Lock a meetup between two fresh accounts and open the initiator's chat socket on it.
 */
async function openRaceState(label: string): Promise<RaceState> {
  const user = await signUp(`${label}-user`);
  const counterpart = await signUp(`${label}-counterpart`);
  await saveCard(user);
  await saveCard(counterpart);

  const venue = await makeVenue(t, { cityId: CITY_ID });
  const { meetupId } = await proposeAndLock(t, { initiator: user, recipient: counterpart, venue });

  const token = await tokenFor(user);
  const socket = await openChatSocket(token);
  socket.send({ meetupId, body: PROBE_BODY });
  expect(bodyOf(await socket.next())).toBe(PROBE_BODY);

  return { user, counterpart, meetupId, token, socket };
}

describe('a write racing the deletion (AAP 0.5.3)', { timeout: CASE_TIMEOUT_MS }, () => {
  it.each(RACE_ORDERS)('answers both writes with $label', async ({ order }) => {
    const db = t.services.db;
    const { user, meetupId, token, socket } = await openRaceState(order);
    const observed: { send?: SocketOutcome; profile?: RouteResponse; deletion?: RouteResponse } =
      {};
    const pending: Promise<void>[] = [];
    /** The two writes of the race: one chat frame and one profile update (AAP 0.5.4). */
    const startWrites = (): void => {
      // The waiter is registered before the frame is sent, so an answer that arrives immediately is
      // claimed rather than missed.
      pending.push(
        socket.next().then((outcome) => {
          observed.send = outcome;
        }),
      );
      socket.send({ meetupId, body: RACE_BODY });
      pending.push(
        callRoute(t.app, {
          method: 'PUT',
          url: PROFILE_PATH,
          as: token,
          body: { bio: RACE_BIO },
        }).then((answer) => {
          observed.profile = answer;
        }),
      );
    };
    const deletion = (): Promise<RouteResponse> =>
      callRoute(t.app, { method: 'DELETE', url: ME_PATH, as: token });
    if (order === 'delete-then-write') {
      observed.deletion = await deletion();
      startWrites();
    } else if (order === 'write-then-delete') {
      startWrites();
      await tick();
      observed.deletion = await deletion();
    } else {
      startWrites();
      pending.push(
        deletion().then((answer) => {
          observed.deletion = answer;
        }),
      );
    }
    await Promise.all(pending);
    expect(observed.deletion?.status, 'the deletion itself always answers 202').toBe(202);
    const profile = observed.profile;
    if (profile === undefined) throw new Error('the race produced no profile answer');
    const sent = observed.send;
    if (sent === undefined) throw new Error('the race produced no socket outcome');
    const refused = sent.kind === 'closed' || errorOutcome(sent, 'token_invalid') !== null;
    if (order === 'delete-then-write') {
      expectError(profile, 401, 'token_invalid');
      expect(refused, 'the socket write is refused too').toBe(true);
      expect(await db.disclosureProfile.count({ where: { userId: user.id } })).toBe(0);
      expect(
        await db.message.count({ where: { senderId: user.id, body: RACE_BODY } }),
        'the refused send stored nothing',
      ).toBe(0);
    } else {
      expect([200, 401]).toContain(profile.status);
      if (profile.status === 401) {
        expectError(profile, 401, 'token_invalid');
      }
      expect(
        refused || bodyOf(sent) === RACE_BODY,
        'the send was refused or carried its body',
      ).toBe(true);
    }
    expect(statusesOf(await drainErasure())).toEqual(['erased']);
    expect(await db.message.count({ where: { senderId: user.id } })).toBe(0);
    expect(await db.disclosureProfile.count({ where: { userId: user.id } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).not.toBeNull();
  });

  it('erases a write that committed before the deletion was requested', async () => {
    const db = t.services.db;
    const { user, meetupId, token, socket } = await openRaceState('settled-before');
    const profile = await callRoute(t.app, {
      method: 'PUT',
      url: PROFILE_PATH,
      as: token,
      body: { bio: RACE_BIO },
    });
    expect(profile.status).toBe(200);
    socket.send({ meetupId, body: RACE_BODY });
    expect(bodyOf(await socket.next())).toBe(RACE_BODY);
    expect(await db.message.count({ where: { senderId: user.id } }), 'the probe and the send').toBe(
      2,
    );
    expect(await db.disclosureProfile.count({ where: { userId: user.id } })).toBe(1);
    await deleteAccount(user);
    expect(statusesOf(await drainErasure())).toEqual(['erased']);
    expect(await db.message.count({ where: { senderId: user.id } })).toBe(0);
    expect(await db.disclosureProfile.count({ where: { userId: user.id } })).toBe(0);
  });
});

/* The cached session the fence must not trust (AAP 0.3.2, 0.5.3) */

describe('a write through a second API instance', { timeout: CASE_TIMEOUT_MS }, () => {
  let second: TestApp;

  beforeAll(async () => {
    // The same database, Redis and memoized secrets, so a token signed by one app authenticates on
    // the other — which is the whole point of the case (AAP 0.11.2).
    second = await createTestApp();
  });

  afterAll(async () => {
    await second.close();
  });

  it('is refused even while the second instance holds a cached session for it', async () => {
    const db = t.services.db;
    const user = await signUp('second-instance');
    const token = await tokenFor(user);
    const read = await callRoute(second.app, { method: 'GET', url: ME_PATH, as: token });
    expect(read.status).toBe(200);
    const cached = await readCachedSession(user.sessionId);
    if (cached === null) {
      throw new Error('the read cached no session entry');
    }
    expect(cached).toContain(user.id);
    await deleteAccount(user);
    // The deletion drops the shared entry. Putting it back is exactly the state an instance that
    // missed the invalidation is in, and it is what makes this case about the fence rather than
    // about the revocation: without it the write would be refused for the simpler reason.
    await restoreCachedSession(user.sessionId, cached);
    const served = await callRoute(second.app, {
      method: 'GET',
      url: `/v1/cities/${CITY_ID}/venues`,
      as: token,
    });
    expect(served.status, 'the restored entry still admits a read').toBe(200);
    // The write is refused all the same: the fence reads PostgreSQL, which says the account asked
    // for deletion, so no write can ride a cached session (AAP 0.5.3).
    expectError(
      await callRoute(second.app, {
        method: 'PUT',
        url: PROFILE_PATH,
        as: token,
        body: { bio: RACE_BIO },
      }),
      401,
      'token_invalid',
    );
    expect(await db.disclosureProfile.count({ where: { userId: user.id } })).toBe(0);
  });
});
