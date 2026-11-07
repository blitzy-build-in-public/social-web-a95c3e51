/**
 * Pair messaging end to end: the history route and the chat socket (AAP 0.8.1, AAP 0.5.4, AAP 0.5.1,
 * AAP 0.3.3).
 *
 * `GET /v1/meetups/:id/messages` and `WS /v1/chat` are one conversation seen twice, so they are
 * covered together here: one `canMessage` gate decides both (AAP 0.5.1), one `Message` DTO describes
 * what each returns, and a message written on the socket is in the history the route answers with.
 *
 * Three rules this suite fixes against a real PostgreSQL 16 with PostGIS, a real Redis and the run's
 * Stripe topology:
 *
 *   1. The gate's refusals, in the contract's order (AAP 0.5.4): `403 not_participant` for a meetup
 *      the caller is not on — an unknown id included, so the route cannot be used to probe for a
 *      proposal — `403 messaging_locked` while the pair holds no locked or completed meetup, and
 *      `403 blocked` for a block in either direction. A completed meetup keeps the conversation open,
 *      and the history pages newest first, `PAGE_SIZE` at a time.
 *   2. The handshake (AAP 0.3.3): the access token arrives in the
 *      `Sec-WebSocket-Protocol: bearer, <token>` subprotocol, which is the only channel a browser
 *      `WebSocket` can offer; a refusal is plain HTTP on a connection that is never upgraded, and the
 *      subprotocol the API selects is `bearer` alone.
 *   3. The write path (AAP 0.3.2, AAP 0.5.4): one accepted send stores one message and is delivered
 *      as the `message` frame the pair receives — across two API instances it travels through Redis,
 *      which is what lets a stateless API fan out — while a pair that may not message, a malformed
 *      frame, a body past the limit and the sixty-first send inside a minute are answered in place
 *      with an `ErrorFrame`, storing nothing. A meetup that locks while a socket is open pushes
 *      `meetup_status` to both participants and opens chat on that same socket, with no reconnect.
 *
 * Delivery happens only through the pub/sub subscription, so both apps are subscribed before a socket
 * opens: `pubsub.start()` is the call `startBackground` makes in production. Every socket wait has an
 * explicit timeout, every socket is closed in `afterEach`, and no case logs a message body, a token or
 * a `Sec-WebSocket-Protocol` header (AAP 0.11.1).
 *
 * @see AAP 0.5.4 for the route, its frames and its errors, 0.5.3 for the lock that opens messaging,
 *   0.5.1 for the modules behind both surfaces, 0.3.2 for the stateless API and the Redis channels,
 *   0.11.2 for the harness, and 0.8.1 for this file.
 */

import { randomUUID } from 'node:crypto';

import {
  AcceptResponse,
  DEFAULT_DEPOSIT_CENTS,
  HOUR_MS,
  MESSAGE_MAX_CHARS,
  MessageHistoryResponse,
  PAGE_SIZE,
  ProposeResponse,
  ServerFrame,
  WS_BEARER_SUBPROTOCOL,
} from '@tablemate/shared';
import type {
  ErrorCode,
  ErrorFrame,
  HoldView,
  MessageFrame,
  MeetupStatus,
  MeetupStatusFrame,
  ParticipantRole,
} from '@tablemate/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { CHAT_SEND_LIMIT_PER_MINUTE } from '../../src/modules/messaging/chat-ws.ts';
import { createTestApp } from '../support/app.ts';
import {
  callRoute,
  expectError,
  makeBlock,
  makeMeetup,
  makeProof,
  makeUser,
  makeVenue,
  proposeAndLock,
  rows,
} from '../support/factories.ts';

import type { RawData } from 'ws';

import type { TestApp } from '../support/app.ts';
import type { ActorRef, RouteResponse, UserFixture, VenueFixture } from '../support/factories.ts';

/* Names and numbers every case is written against (AAP 0.5.2, 0.5.4) */

/** The launch city every fixture stands in: Lisbon, one of the five of `config/cities.json`. */
const CITY = 'lisbon';

/** The chat socket's path below the API's `/v1` prefix (AAP 0.5.4). */
const CHAT_PATH = '/v1/chat';

/** How long a case waits for a frame before it fails, so no socket wait can hang a run. */
const FRAME_TIMEOUT_MS = 5_000;

/** RFC 6455's normal closure, which is what a test client sends as it closes (AAP 0.3.3). */
const CLOSE_NORMAL = 1000;

/** One full page and a partial one, so the history covers both paging paths (AAP 0.5.4). */
const MESSAGE_COUNT = PAGE_SIZE + 5;

/** How long a Redis connection has to reach `ready` before the suite fails instead of racing it. */
const REDIS_READY_TIMEOUT_MS = 10_000;

/** How many status frames a case publishes before it gives up on a socket being attached. */
const FANOUT_PROBES = 20;

/** How long each fan-out probe waits for the socket to answer it. */
const FANOUT_PROBE_MS = 250;

/** The members of a Redis connection the suite reads to wait for it (AAP 0.3.2). */
interface RedisReadiness {
  readonly status: string;
  once(event: 'ready', listener: () => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
}

/**
 * Resolve once a Redis connection can serve a command, or fail the hook with a clear message.
 *
 * `pubsub.start()` registers the patterns through these connections, and a `client`-role connection
 * rejects a command issued before its first `ready` — the startup warn the API's own entry point
 * avoids by awaiting the same readiness. Without the wait the first subscribe attempt fails and the
 * module's retry is five seconds away, which is longer than a case waits for a frame.
 */
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

/* The suite (AAP 0.11.2) */

let t: TestApp;
let second: TestApp;
let base: string;
let secondBase: string;

beforeAll(async () => {
  t = await createTestApp();
  // A second instance against the same database, Redis and memoized secrets: the fan-out between two
  // replicas is the property under test, and a token from the first is valid on the second (AAP 0.3.2).
  second = await createTestApp();

  // Every connection has to be able to serve a command before the patterns are registered: an
  // unready `client` connection rejects the subscribe, and the module then retries five seconds
  // later — longer than any case here waits for a frame. The same readiness `main.ts` awaits.
  await Promise.all(
    [
      t.services.redis.client,
      t.services.redis.subscriber,
      second.services.redis.client,
      second.services.redis.subscriber,
    ].map((connection) => ready(connection)),
  );

  // Delivery happens only through the subscription, so both instances subscribe before a socket opens.
  // `start` is idempotent and never rejects: an unreachable Redis delays fan-out rather than failing.
  await Promise.all([t.services.pubsub.start(), second.services.pubsub.start()]);
  [base, secondBase] = await Promise.all([t.listen(), second.listen()]);
}, 240_000);

afterAll(async () => {
  await second.close();
  await t.close();
});

// One database, one Redis and one Stripe proxy are shared by the run, so each case starts from the
// state a fresh database would have (AAP 0.11.2). The reset covers both instances, which share them.
beforeEach(async () => {
  await t.resetState();
  await t.seedCities();
});

// A socket that outlived its case would keep its registration and its heartbeat, and a payload the
// contract does not define is a defect rather than something to skip (AAP 0.5.4).
afterEach(async () => {
  for (const socket of opened.splice(0, opened.length)) {
    expect(socket.unreadable).toHaveLength(0);
    await socket.close();
  }
});

/*
 * The chat socket's client side (AAP 0.3.3, 0.5.4)
 */

/** An upgrade the API refused as plain HTTP on a connection it never hijacked (AAP 0.3.3). */
class SocketRefused extends Error {
  /** The status the refusal was answered with: `401 token_invalid`, or `403 age_gate_required`. */
  readonly status: number;

  constructor(status: number) {
    super(`the socket upgrade was answered with ${status}`);
    this.name = 'SocketRefused';
    this.status = status;
  }
}

/** One open socket: the connection, the frames it received, and the waits over them. */
interface ChatSocket {
  readonly socket: WebSocket;
  /** Every frame received, in arrival order. */
  readonly frames: ServerFrame[];
  /** Payloads that were not a `ServerFrame`; `afterEach` asserts this stays empty. */
  readonly unreadable: string[];
  /** Write one payload, which a case builds from the shared frame schema. */
  send(text: string): void;
  /** Resolve with the next frame matching `predicate`, or reject once `timeoutMs` has passed. */
  next(predicate: (frame: ServerFrame) => boolean, timeoutMs?: number): Promise<ServerFrame>;
  /** Close the socket and wait for the close to complete. */
  close(): Promise<void>;
}

/** Every socket a case opened, closed again in `afterEach`. */
const opened: ChatSocket[] = [];

/** One text frame's payload, or `null` for a binary frame (AAP 0.3.3). */
function frameText(data: RawData, isBinary: boolean): string | null {
  if (isBinary) return null;

  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  return buffer.toString('utf8');
}

/** One received payload as a contract frame, or `null` when it is not one (AAP 0.5.4). */
function parseFrame(text: string): ServerFrame | null {
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
 * Open one chat socket and resolve with it once the handshake completed (AAP 0.3.3).
 *
 * The token is offered as the `bearer, <token>` subprotocol, the only channel a browser `WebSocket`
 * has; `null` offers no subprotocol at all, which is the row that proves the token is read from that
 * header. A refusal is rejected as {@link SocketRefused}, carrying the plain HTTP status the API
 * answered with before the connection was upgraded.
 */
function openSocket(baseUrl: string, token: string | null): Promise<ChatSocket> {
  const url = `${baseUrl.replace(/^http/, 'ws')}${CHAT_PATH}`;
  const socket =
    token === null ? new WebSocket(url) : new WebSocket(url, [WS_BEARER_SUBPROTOCOL, token]);

  const frames: ServerFrame[] = [];
  const unreadable: string[] = [];
  const listeners = new Set<(frame: ServerFrame) => void>();

  /** Hand one payload to this socket's listeners, or record it as off-contract. */
  function receive(text: string): void {
    const frame = parseFrame(text);
    if (frame === null) {
      unreadable.push(text);
      return;
    }

    frames.push(frame);
    for (const listener of [...listeners]) {
      listener(frame);
    }
  }

  function send(text: string): void {
    socket.send(text);
  }

  function next(
    predicate: (frame: ServerFrame) => boolean,
    timeoutMs = FRAME_TIMEOUT_MS,
  ): Promise<ServerFrame> {
    const received = frames.find(predicate);
    if (received !== undefined) return Promise.resolve(received);

    return new Promise<ServerFrame>((resolve, reject) => {
      const listener = (frame: ServerFrame): void => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`the socket received no matching frame within ${timeoutMs} ms`));
      }, timeoutMs);
      listeners.add(listener);
    });
  }

  async function close(): Promise<void> {
    if (socket.readyState === socket.CLOSED) return;

    await new Promise<void>((done) => {
      socket.once('close', () => {
        done();
      });
      socket.close(CLOSE_NORMAL);
    });
  }

  return new Promise<ChatSocket>((resolve, reject) => {
    socket.on('unexpected-response', (_request, response) => {
      response.destroy();
      reject(new SocketRefused(response.statusCode ?? 0));
    });

    socket.on('error', (error: unknown) => {
      reject(error instanceof Error ? error : new Error('the socket failed to connect'));
    });

    socket.on('close', () => {
      reject(new Error('the socket closed before the handshake completed'));
    });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      const text = frameText(data, isBinary);
      if (text !== null) receive(text);
    });

    socket.on('open', () => {
      const handle: ChatSocket = { socket, frames, unreadable, send, next, close };
      opened.push(handle);
      resolve(handle);
    });
  });
}

/**
 * The status an upgrade was refused with, or `null` when the socket opened (AAP 0.3.3).
 *
 * @param opening - the socket being opened, whose own promise is what settles here.
 */
async function upgradeStatus(opening: Promise<ChatSocket>): Promise<number | null> {
  try {
    await opening;
    return null;
  } catch (error) {
    if (error instanceof SocketRefused) return error.status;
    throw error;
  }
}

/* The frames a case waits for (AAP 0.5.4) */

/** The message frame for `meetupId`, or `null` when the frame is anything else. */
function messageOf(frame: ServerFrame | undefined, meetupId: string): MessageFrame | null {
  return frame !== undefined && frame.type === 'message' && frame.message.meetupId === meetupId
    ? frame
    : null;
}

/** The refusal frame carrying `code`, or `null` when the frame is anything else. */
function errorOf(frame: ServerFrame | undefined, code: ErrorCode): ErrorFrame | null {
  return frame !== undefined && frame.type === 'error' && frame.code === code ? frame : null;
}

/** The status frame for `meetupId`, optionally carrying `status`, or `null` otherwise. */
function statusOf(
  frame: ServerFrame | undefined,
  meetupId: string,
  status?: MeetupStatus,
): MeetupStatusFrame | null {
  return frame !== undefined &&
    frame.type === 'meetup_status' &&
    frame.meetupId === meetupId &&
    (status === undefined || frame.status === status)
    ? frame
    : null;
}

/**
 * The next frame one selector picks, failing the case when the socket answers with something else
 * first: a refusal where the contract promises a frame is a defect, not a frame to skip.
 */
async function expectFrame<T extends ServerFrame>(
  socket: ChatSocket,
  select: (frame: ServerFrame) => T | null,
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<T> {
  const frame = await socket.next((candidate) => select(candidate) !== null, timeoutMs);
  const selected = select(frame);
  if (selected === null) {
    throw new Error('the socket produced a frame no selector picked');
  }

  return selected;
}

/* Waiting for a socket to be attached (AAP 0.3.2, AAP 0.5.4) */

/** The values a probe frame carries, taken from the meetup's own row and deposits (AAP 0.5.3). */
interface ProbeStatus {
  readonly status: MeetupStatus;
  readonly initiatorHold: HoldView;
  readonly recipientHold: HoldView;
}

/** What a proposal pushes once the initiator's hold is held (AAP 0.5.3). */
const PROPOSED_PROBE: ProbeStatus = {
  status: 'proposed',
  initiatorHold: 'held',
  recipientHold: 'none',
};

/** What a locked meetup pushes: both deposits held (AAP 0.5.3). */
const LOCKED_PROBE: ProbeStatus = {
  status: 'locked',
  initiatorHold: 'held',
  recipientHold: 'held',
};

/**
 * Wait until `socket` carries its meetups, by pushing the meetup's own status and waiting for the
 * socket to answer with it (AAP 0.3.2, AAP 0.5.4).
 *
 * A socket enters the registry, meetups included, inside the handler that serves its upgrade, so a
 * frame published the moment a handshake completed can be delivered to nobody — the rule that a
 * window without a subscription costs local delivery and never state. The probe is the frame the API
 * itself pushes on a transition, carrying the meetup's current values, so it is a frame the contract
 * defines: a socket that answers it is attached, and every frame published after it reaches it.
 */
async function awaitFanOut(
  socket: ChatSocket,
  userId: string,
  meetupId: string,
  probe: ProbeStatus,
): Promise<void> {
  const frame: MeetupStatusFrame = { type: 'meetup_status', meetupId, ...probe };

  for (let attempt = 0; attempt < FANOUT_PROBES; attempt += 1) {
    await t.services.pubsub.publishUser(userId, frame);

    try {
      await socket.next((candidate) => statusOf(candidate, meetupId) !== null, FANOUT_PROBE_MS);
      return;
    } catch {
      // The frame reached no socket: this one is not attached yet. Publish it again.
    }
  }

  throw new Error('the socket was not attached to the fan-out in time');
}

/*
 * The fixtures a case drives (AAP 0.5.2, 0.5.3)
 */

/** One meeting: the two accounts, the venue and the meetup a case drives. */
interface Meeting {
  readonly initiator: UserFixture;
  readonly recipient: UserFixture;
  readonly venue: VenueFixture;
  readonly meetupId: string;
}

/**
 * Two accounts, a partner venue and the meetup between them a case needs (AAP 0.5.3).
 *
 * A `locked` meetup is walked through the real proposal and acceptance, so both deposits are real
 * authorizations and messaging is open; every other status writes the rows that status leaves.
 */
async function meeting(status: 'locked' | 'proposed' | 'completed'): Promise<Meeting> {
  const initiator = await makeUser(t);
  const recipient = await makeUser(t);
  const venue = await makeVenue(t, { cityId: CITY });

  if (status === 'locked') {
    const locked = await proposeAndLock(t, { initiator, recipient, venue });
    return { initiator, recipient, venue, meetupId: locked.meetupId };
  }

  const written = await makeMeetup(t, { status, initiator, recipient, venue });
  return { initiator, recipient, venue, meetupId: written.id };
}

/** Every message the meetup's history holds, oldest first (AAP 0.5.2). */
function storedMessages(meetupId: string) {
  return t.services.db.message.findMany({
    where: { meetupId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, senderId: true, body: true, createdAt: true },
  });
}

/** `GET /v1/meetups/:id/messages` as `actor`, continuing after `cursor` when one is given. */
async function historyRoute(
  meetupId: string,
  actor: ActorRef,
  cursor?: string,
): Promise<RouteResponse> {
  return await callRoute(t.app, {
    method: 'GET',
    url: `/v1/meetups/${meetupId}/messages`,
    as: await t.tokenFor(actor),
    ...(cursor === undefined ? {} : { query: { cursor } }),
  });
}

/*
 * The refusals the contract lists, one row per case (AAP 0.5.4, 0.11.1)
 */

/** One refusal of the history route: the meetup's state, whose eyes read it, and the code. */
interface HistoryRefusal {
  readonly name: string;
  /** `unknown` leaves the id to the case; otherwise the state the fixture writes. */
  readonly setup: 'unknown' | 'proposed' | 'cancelled' | 'locked';
  /** Who reads: a participant of the meetup, or an account unrelated to both of them. */
  readonly reader: 'participant' | 'stranger';
  /** Which side of the pair blocks the other first, for the `blocked` rows. */
  readonly blockedBy: ParticipantRole | null;
  readonly code: ErrorCode;
}

/**
 * The three refusals in the order the contract decides them: the caller's standing on the meetup,
 * the pair's lock, then a block in either direction (AAP 0.5.4).
 */
const HISTORY_REFUSALS: readonly HistoryRefusal[] = [
  {
    name: 'an unknown meetup id',
    setup: 'unknown',
    reader: 'participant',
    blockedBy: null,
    code: 'not_participant',
  },
  {
    name: 'a meetup between two other accounts',
    setup: 'proposed',
    reader: 'stranger',
    blockedBy: null,
    code: 'not_participant',
  },
  {
    name: 'a proposed meetup',
    setup: 'proposed',
    reader: 'participant',
    blockedBy: null,
    code: 'messaging_locked',
  },
  {
    name: 'a cancelled meetup',
    setup: 'cancelled',
    reader: 'participant',
    blockedBy: null,
    code: 'messaging_locked',
  },
  {
    name: 'a locked meetup the initiator blocked',
    setup: 'locked',
    reader: 'participant',
    blockedBy: 'initiator',
    code: 'blocked',
  },
  {
    name: 'a locked meetup the recipient blocked',
    setup: 'locked',
    reader: 'participant',
    blockedBy: 'recipient',
    code: 'blocked',
  },
];

/* The history route (AAP 0.5.4) */

describe('GET /meetups/:id/messages', () => {
  it.each(rows(HISTORY_REFUSALS))('refuses $name', async (entry) => {
    const initiator = await makeUser(t);
    const recipient = await makeUser(t);
    const venue = await makeVenue(t, { cityId: CITY });
    const reader = entry.reader === 'stranger' ? await makeUser(t) : initiator;

    const meetupId =
      entry.setup === 'unknown'
        ? randomUUID()
        : entry.setup === 'locked'
          ? (await proposeAndLock(t, { initiator, recipient, venue })).meetupId
          : (await makeMeetup(t, { status: entry.setup, initiator, recipient, venue })).id;

    if (entry.blockedBy !== null) {
      const blocker = entry.blockedBy === 'initiator' ? initiator : recipient;
      const blocked = entry.blockedBy === 'initiator' ? recipient : initiator;
      await makeBlock(t, blocker, blocked);
    }

    expectError(await historyRoute(meetupId, reader), 403, entry.code);
  });

  it('keeps the conversation open on a completed meetup', async () => {
    const { initiator, meetupId } = await meeting('completed');

    const response = await historyRoute(meetupId, initiator);

    expect(response.status).toBe(200);
    const page = MessageHistoryResponse.parse(response.json());
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it(`pages ${MESSAGE_COUNT} messages newest first, ${PAGE_SIZE} at a time`, async () => {
    const { initiator, recipient, meetupId } = await meeting('completed');
    const first = t.services.clock.nowMs();
    await t.services.db.message.createMany({
      data: Array.from({ length: MESSAGE_COUNT }, (_unused, index) => ({
        meetupId,
        senderId: index % 2 === 0 ? initiator.id : recipient.id,
        body: `message-${index + 1}`,
        createdAt: new Date(first + index * 1_000),
      })),
    });

    const response = await historyRoute(meetupId, initiator);
    expect(response.status).toBe(200);
    const page = MessageHistoryResponse.parse(response.json());
    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(page.items[0]?.body).toBe(`message-${MESSAGE_COUNT}`);
    expect(page.items.at(-1)?.body).toBe(`message-${MESSAGE_COUNT - PAGE_SIZE + 1}`);

    // The cursor the page issued continues it, and the last page answers none: a client stops on
    // `null` rather than on a short page (AAP 0.5.4).
    const oldest = MESSAGE_COUNT - PAGE_SIZE;
    const cursor = page.nextCursor ?? '';
    expect(cursor).not.toBe('');

    const rest = MessageHistoryResponse.parse(
      (await historyRoute(meetupId, recipient, cursor)).json(),
    );
    expect(rest.items.map((item) => item.body)).toEqual(
      Array.from({ length: oldest }, (_unused, index) => `message-${oldest - index}`),
    );
    expect(rest.nextCursor).toBeNull();
  });
});

/*
 * The chat socket (AAP 0.3.3, AAP 0.5.4)
 */

/** One handshake the API must refuse as plain HTTP, and the token it offers (AAP 0.3.3). */
interface UpgradeRefusal {
  readonly name: string;
  /** How the token is offered; `none` offers no subprotocol at all. */
  readonly token: 'none' | 'garbage' | 'revoked';
  readonly status: number;
}

/** No token, a token that is not a JWS, and a token whose session is gone: the same `401`. */
const UPGRADE_REFUSALS: readonly UpgradeRefusal[] = [
  { name: 'without a subprotocol', token: 'none', status: 401 },
  { name: 'with a token that is not a JWS', token: 'garbage', status: 401 },
  { name: 'with the token of a revoked session', token: 'revoked', status: 401 },
];

/** One refused frame: the meetup it is sent in, its payload, and the code it is answered with. */
interface FrameRefusal {
  readonly name: string;
  readonly setup: 'proposed' | 'locked';
  readonly frame: (meetupId: string) => string;
  readonly code: ErrorCode;
  /** Whether the refusal names the meetup, which is where a client shows it (AAP 0.5.4). */
  readonly carriesMeetupId: boolean;
}

/** The frames the socket refuses in place: an access refusal, a frame the schema rejects, a long body. */
const FRAME_REFUSALS: readonly FrameRefusal[] = [
  {
    name: 'a send in a proposed meetup',
    setup: 'proposed',
    frame: (meetupId) => JSON.stringify({ type: 'chat_send', meetupId, body: 'hello' }),
    code: 'messaging_locked',
    carriesMeetupId: true,
  },
  {
    name: 'a payload that is not JSON',
    setup: 'locked',
    frame: () => 'not a frame at all',
    code: 'invalid_field',
    carriesMeetupId: false,
  },
  {
    name: `a body past the ${MESSAGE_MAX_CHARS}-character limit`,
    setup: 'locked',
    frame: (meetupId) =>
      JSON.stringify({ type: 'chat_send', meetupId, body: 'x'.repeat(MESSAGE_MAX_CHARS + 1) }),
    code: 'invalid_field',
    carriesMeetupId: false,
  },
];

describe('WS /v1/chat', () => {
  /** The token one row offers: none at all, a value that is not a JWS, or a revoked session's. */
  async function offeredToken(offered: UpgradeRefusal['token']): Promise<string | null> {
    if (offered === 'none') return null;
    if (offered === 'garbage') return 'not-a-jws';

    const revoked = await makeUser(t, { card: 'none', deletionRequested: true });
    return await t.tokenFor(revoked);
  }

  it.each(rows(UPGRADE_REFUSALS))('answers $status on an upgrade $name', async (entry) => {
    expect(await upgradeStatus(openSocket(base, await offeredToken(entry.token)))).toBe(
      entry.status,
    );
  });

  it('opens with the token from the subprotocol and selects bearer', async () => {
    const traveler = await makeUser(t, { card: 'none' });

    const socket = await openSocket(base, await t.tokenFor(traveler));

    expect(socket.socket.protocol).toBe(WS_BEARER_SUBPROTOCOL);
    expect(socket.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('stores one message and pushes it to the counterpart', async () => {
    const { initiator, recipient, meetupId } = await meeting('locked');
    const sender = await openSocket(base, await t.tokenFor(initiator));
    const counterpart = await openSocket(base, await t.tokenFor(recipient));

    await awaitFanOut(counterpart, recipient.id, meetupId, LOCKED_PROBE);
    sender.send(JSON.stringify({ type: 'chat_send', meetupId, body: 'hello' }));

    const frame = await expectFrame(counterpart, (candidate) => messageOf(candidate, meetupId));
    expect(frame.message.body).toBe('hello');
    expect(frame.message.senderId).toBe(initiator.id);

    const stored = await storedMessages(meetupId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.senderId).toBe(initiator.id);
    expect(stored[0]?.body).toBe('hello');
  });

  it('carries a message to a socket another API instance holds, through Redis', async () => {
    const { initiator, recipient, meetupId } = await meeting('locked');
    const sender = await openSocket(base, await t.tokenFor(initiator));
    const counterpart = await openSocket(secondBase, await t.tokenFor(recipient));

    // The frame below is published by the first instance and reaches this socket only through Redis,
    // so the socket has to be attached on the second instance first (AAP 0.3.2).
    await awaitFanOut(counterpart, recipient.id, meetupId, LOCKED_PROBE);
    sender.send(JSON.stringify({ type: 'chat_send', meetupId, body: 'across instances' }));

    const frame = await expectFrame(counterpart, (candidate) => messageOf(candidate, meetupId));
    expect(frame.message.body).toBe('across instances');
    expect(await storedMessages(meetupId)).toHaveLength(1);
  });

  it.each(rows(FRAME_REFUSALS))('answers $name with an ErrorFrame', async (entry) => {
    const { initiator, meetupId } = await meeting(entry.setup);
    const socket = await openSocket(base, await t.tokenFor(initiator));

    socket.send(entry.frame(meetupId));

    const frame = await expectFrame(socket, (candidate) => errorOf(candidate, entry.code));
    expect(frame.meetupId ?? null).toBe(entry.carriesMeetupId ? meetupId : null);
    expect(frame.message.length).toBeGreaterThan(0);
    expect(await storedMessages(meetupId)).toHaveLength(0);
  });

  it('refuses the sixty-first send inside a minute and keeps the first sixty', async () => {
    const { initiator, meetupId } = await meeting('locked');
    const socket = await openSocket(base, await t.tokenFor(initiator));

    // The allowance belongs to the socket, and the contract fixes it at sixty a minute (AAP 0.5.4).
    expect(CHAT_SEND_LIMIT_PER_MINUTE).toBe(60);
    for (let index = 0; index < CHAT_SEND_LIMIT_PER_MINUTE + 1; index += 1) {
      socket.send(JSON.stringify({ type: 'chat_send', meetupId, body: `message-${index + 1}` }));
    }

    const refusal = await expectFrame(socket, (candidate) => errorOf(candidate, 'rate_limited'));
    expect(refusal.meetupId).toBe(meetupId);

    // Frames are handled one at a time in order, so the refusal is answered after sixty writes; the
    // clock is frozen, so the rows share one instant and are compared as a set of bodies.
    const bodies = new Set((await storedMessages(meetupId)).map((row) => row.body));
    expect(bodies.size).toBe(CHAT_SEND_LIMIT_PER_MINUTE);
    expect(bodies.has(`message-${CHAT_SEND_LIMIT_PER_MINUTE}`)).toBe(true);
    expect(bodies.has(`message-${CHAT_SEND_LIMIT_PER_MINUTE + 1}`)).toBe(false);
  });

  it('pushes the lock to both sockets and opens the chat on the same socket', async () => {
    const initiator = await makeUser(t);
    const recipient = await makeUser(t);
    const venue = await makeVenue(t, { cityId: CITY });
    await makeProof(t, initiator, { cityId: CITY });
    await makeProof(t, recipient, { cityId: CITY });

    const startsAt = new Date(t.services.clock.nowMs() + 2 * HOUR_MS);
    const proposed = await callRoute(t.app, {
      method: 'POST',
      url: '/v1/meetups',
      as: await t.tokenFor(initiator),
      body: {
        recipientId: recipient.id,
        venueId: venue.id,
        startsAt: startsAt.toISOString(),
        depositCents: DEFAULT_DEPOSIT_CENTS,
      },
    });
    expect(proposed.status).toBe(201);
    const meetupId = ProposeResponse.parse(proposed.json()).meetupId;

    // Both sockets are open while the pair may not message yet, so neither carries the meetup; each
    // one proves it is attached — on this instance — before the lock is published (AAP 0.3.2).
    const initiatorSocket = await openSocket(base, await t.tokenFor(initiator));
    const recipientSocket = await openSocket(base, await t.tokenFor(recipient));
    await awaitFanOut(initiatorSocket, initiator.id, meetupId, PROPOSED_PROBE);
    await awaitFanOut(recipientSocket, recipient.id, meetupId, PROPOSED_PROBE);

    const viewed = await callRoute(t.app, {
      method: 'GET',
      url: `/v1/meetups/${meetupId}`,
      as: await t.tokenFor(recipient),
    });
    expect(viewed.status).toBe(200);

    const accepted = await callRoute(t.app, {
      method: 'POST',
      url: `/v1/meetups/${meetupId}/accept`,
      as: await t.tokenFor(recipient),
    });
    expect(accepted.status).toBe(200);
    expect(AcceptResponse.parse(accepted.json()).status).toBe('locked');

    for (const socket of [initiatorSocket, recipientSocket]) {
      const frame = await expectFrame(socket, (candidate) =>
        statusOf(candidate, meetupId, 'locked'),
      );
      expect(frame.status).toBe('locked');
      expect(frame.initiatorHold).toBe('held');
      expect(frame.recipientHold).toBe('held');
    }

    // The lock is what opened the chat: the socket that received it writes with no reconnect.
    recipientSocket.send(JSON.stringify({ type: 'chat_send', meetupId, body: 'see you there' }));
    const message = await expectFrame(recipientSocket, (candidate) =>
      messageOf(candidate, meetupId),
    );
    expect(message.message.body).toBe('see you there');
  });
});
