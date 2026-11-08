/**
 * Redis pub/sub fan-out and the in-process socket registry behind the chat socket (AAP 0.3.2, 0.5.1,
 * 0.5.3, 0.5.4, 0.8.1).
 *
 * A socket belongs to exactly one API instance, so a frame written on one instance reaches a socket
 * held by another only through Redis. Two channels carry that traffic, named by the shared helpers
 * rather than spelled out here (AAP 0.5.1):
 *
 * - `chat:<meetupId>` ({@link chatChannel}) carries one committed chat message to both participants'
 *   sockets — the sender's own included, where it doubles as delivery confirmation (AAP 0.5.4).
 * - `user:<userId>` ({@link userChannel}) carries that user's meetup-status pushes, the invalidation
 *   every API instance reads to drop the cached entries of the sessions that ended and close the
 *   sockets they were admitted with — the sockets of the sessions the frame names, or every socket of
 *   the user when it names none, which is what an account that ended as a whole publishes
 *   (AAP 0.5.3) — and the attach signal an instance reads to add one meetup to that user's sockets,
 *   which is how a chat a participant opens or writes in reaches their open socket live (AAP 0.5.1,
 *   0.5.4).
 *
 * **Delivery happens only through the subscription.** A publisher never hands a frame to its own
 * local sockets: it publishes, its own pattern subscription receives the message back, and the
 * receiving path delivers it. Every instance, the publisher's included, therefore delivers exactly
 * once per socket, and no instance can deliver a frame it did not receive.
 *
 * **Redis is never a condition of anything else.** `start()` never rejects and retries every
 * {@link SUBSCRIBE_RETRY_MS} until it holds both patterns, so chat history and every non-socket route
 * keep working meanwhile, and a publish that fails is logged and dropped (AAP 0.3.2). What a window
 * without a subscription costs is local delivery of the frames published inside it, never state: a
 * client reads `GET /meetups/:id` for the truth about a meetup (AAP 0.5.4).
 *
 * Both internal frames — the invalidation and the attach — are defined here and only here. They
 * travel between API instances and are never sent to a client.
 *
 * @see AAP 0.3.2 for the stateless-API fan-out, the channel-name convention (`:` here, `-` in BullMQ
 *   job ids) and the rule that no Redis call runs inside a domain transaction; 0.5.1 for this file's
 *   place in the messaging component; 0.5.3 for the invalidation and the session-cache drop it
 *   triggers; 0.5.4 for the chat the attach signal makes live on a socket that already opened; 0.8.1
 *   for this file.
 */

import { z } from 'zod';

import { ServerFrame, Uuid, chatChannel, userChannel } from '@tablemate/shared';
import type { MessageFrame } from '@tablemate/shared';
import { throttleRedisFailure } from '@tablemate/server-core';
import type { Logger } from '@tablemate/server-core';

import { dropCachedSessions } from '../../plugins/auth.ts';
import { WS_CLOSE } from '../../plugins/websocket.ts';

import type { SessionCacheCommands } from '../../plugins/auth.ts';

import type { WebSocket } from 'ws';

/*
 * Constants
 */

/**
 * How long to wait before registering the two pattern subscriptions again after a failed attempt.
 *
 * An attempt fails while Redis is unreachable — a `client`-role connection queues nothing, so
 * `psubscribe` rejects instead of waiting — and is retried on this cadence until it succeeds.
 */
export const SUBSCRIBE_RETRY_MS = 5_000;

/**
 * The close code {@link PubSub.close} sends: 1001, "going away" (RFC 6455 §7.4.1), the standard code
 * for a server shutting down. It is deliberately not one of {@link WS_CLOSE}'s application codes,
 * because no application rule refused the socket — the process is going away.
 */
const WS_GOING_AWAY = 1001;

/** The prefix of a chat channel, and of a user channel, taken from the shared helpers (AAP 0.5.1). */
const CHAT_PREFIX = chatChannel('');
const USER_PREFIX = userChannel('');

/** The two patterns one `psubscribe` registers, likewise derived from the shared helpers. */
const CHAT_PATTERN = chatChannel('*');
const USER_PATTERN = userChannel('*');

/*
 * Types
 */

/**
 * The one Redis command a frame is published with, as the `client`-role connection of
 * `packages/server-core/src/queues/connection.ts` exposes it (AAP 0.3.2).
 */
export interface PublishCommands {
  publish(channel: string, message: string): Promise<unknown>;
}

/** A message delivered on the patterns above: the pattern, the channel, and the frame as JSON. */
type PmessageListener = (pattern: string, channel: string, message: string) => void;

/**
 * What the subscriber connection must offer: a `client`-role connection of its own, because a
 * subscribed connection can issue no other command, so it is never the one a frame is published on.
 *
 * Spelled out rather than imported so the module names the four capabilities it depends on instead
 * of the whole ioredis surface: a real connection satisfies this structurally, and `status`,
 * `connect` and `autoResubscribe` are the three connection facts the retry loop reads.
 */
export interface SubscriberCommands {
  /** The connection state; `'wait'` until a connection created with `lazyConnect` is opened. */
  readonly status: string;
  /** Opens a lazily created connection, or reopens one whose socket ended. */
  connect(): Promise<void>;
  /** Registers the patterns. ioredis re-registers them itself after a reconnect. */
  psubscribe(...patterns: string[]): Promise<unknown>;
  /** Gives the patterns back, on shutdown. */
  punsubscribe(...patterns: string[]): Promise<unknown>;
  on(event: 'pmessage', listener: PmessageListener): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'pmessage', listener: PmessageListener): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * What this module needs from the app's services: the publisher, the subscriber and the logger.
 *
 * Declared narrow and locally — the way `plugins/auth.ts`, `modules/settlement/timers.ts` and
 * `modules/admin/reports.ts` declare theirs — rather than as `Pick<AppServices, ...>`: `AppServices`
 * lives in `apps/api/src/app.ts`, a file this module must not depend on, and the app container
 * satisfies this shape structurally. `redis.client` is the connection the session cache is dropped
 * through as well, which is why it carries {@link SessionCacheCommands} beside its `publish`.
 */
export interface PubSubServices {
  readonly redis: {
    readonly client: SessionCacheCommands & PublishCommands;
    readonly subscriber: SubscriberCommands;
  };
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

/**
 * The invalidation every API instance reads on `user:<userId>` (AAP 0.3.2, 0.5.3).
 *
 * Published by `plugins/auth.ts` after the transaction that revoked sessions committed: as the frozen
 * `{ type: 'invalidate' }` frame for an account that ended as a whole, or as the same frame carrying
 * the `sessionIds` of the one session `POST /auth/logout` revoked. Each instance drops the named
 * sessions' cache entries beside closing their sockets, and a frame that names none closes every
 * socket of the user. It is not a `ServerFrame`: it never reaches a client, which is why its schema is
 * a strict object of its own.
 */
export const InvalidateSignal = z.strictObject({
  type: z.literal('invalidate'),
  sessionIds: z.array(Uuid).optional(),
});
export type InvalidateSignal = z.infer<typeof InvalidateSignal>;

/**
 * The attach every API instance reads on `user:<userId>`: one meetup joins that user's sockets
 * (AAP 0.3.2, 0.5.1, 0.5.4).
 *
 * Published by {@link PubSub.openChat}, which has already attached the meetup on the instance that
 * served the request, so the addition reaches a user's sockets whoever holds them. It exists because
 * a socket's meetup set is read once as it opens and bounded, so a chat the participant opens or
 * writes in later would otherwise never be delivered to their open socket (AAP 0.5.1). Like the
 * invalidation it is not a `ServerFrame`: it never reaches a client, which is why its schema is a
 * strict object of its own.
 */
export const AttachMeetupSignal = z.strictObject({
  type: z.literal('attach_meetup'),
  meetupId: Uuid,
});
export type AttachMeetupSignal = z.infer<typeof AttachMeetupSignal>;

/**
 * Every message the user channel may carry: a client-facing {@link ServerFrame}, or one of the two
 * internal signals the API instances send each other — {@link InvalidateSignal} and
 * {@link AttachMeetupSignal}.
 */
export type UserChannelMessage = ServerFrame | InvalidateSignal | AttachMeetupSignal;

/**
 * Redis pub/sub fan-out and the local socket registry, as `apps/api/src/app.ts` holds it on
 * `services.pubsub` (AAP 0.3.2, 0.5.1).
 *
 * The publishing methods are the whole cross-instance surface: they are what `modules/messaging`
 * calls after a message commits, and what the meetup state machine calls on a transition.
 * {@link PubSub.openChat} publishes as well, because the chat it makes live may be held by any
 * instance, and it attaches on this one first. The three registry methods are local to the instance
 * that owns the socket, so a route attaches its socket here and nothing about that socket crosses the
 * process boundary.
 */
export interface PubSub {
  /**
   * Subscribes this instance to both patterns, and starts retrying if that fails.
   *
   * Idempotent, never rejects, and safe to call before Redis is reachable: a failed attempt is logged
   * as `pubsub_subscribe_failed` and retried every {@link SUBSCRIBE_RETRY_MS} until it succeeds, so a
   * Redis outage delays this instance's chat fan-out instead of failing startup (AAP 0.3.2).
   */
  start(): Promise<void>;
  /**
   * Gives the two patterns back, detaches every registered socket and closes it with 1001.
   *
   * The Redis connections are left open: `app.ts` owns them and closes them itself. Idempotent.
   */
  close(): Promise<void>;
  /**
   * Publishes one frame to a user's own sockets, on `user:<userId>` (AAP 0.5.1).
   *
   * Call it after the transaction that decided the frame committed, never inside one: no Redis call
   * belongs in a domain transaction (AAP 0.3.2). It never throws. A frame that is none of
   * {@link ServerFrame}, {@link InvalidateSignal} or {@link AttachMeetupSignal} is a programming
   * error, logged as `ws_frame_invalid` and not published; a publish that fails is logged as
   * `pubsub_publish_failed` and dropped, because the frame's state is read back from the route that
   * owns it.
   */
  publishUser(userId: string, message: UserChannelMessage): Promise<void>;
  /**
   * Publishes one committed chat message to its meetup, on `chat:<meetupId>` (AAP 0.5.1, 0.5.4).
   *
   * Same preconditions and the same failure behaviour as {@link PubSub.publishUser}. A frame naming
   * another meetup than the channel is refused, so a message can never be delivered to the wrong
   * pair's sockets.
   */
  publishChat(meetupId: string, frame: MessageFrame): Promise<void>;
  /**
   * Publishes an invalidation on a user's channel, naming the sessions it ends (AAP 0.5.3).
   *
   * The frame is what every instance closes the sockets of those sessions from, and the session ids
   * are also what each instance drops from its own cache beside it. An empty or absent list publishes
   * the bare frame, which closes every socket of the user: that is the whole-account end `DELETE /me`
   * and a refresh-reuse revocation publish, since a cache drop of no keys is already a no-op where it
   * happens.
   */
  publishInvalidate(userId: string, sessionIds?: readonly string[]): Promise<void>;
  /**
   * Registers an open socket under its user, the session it was admitted with, and each of the
   * meetups it carries (AAP 0.5.1, 0.5.3).
   *
   * Called once by the chat route when a socket opens, with the meetups the caller may chat in. The
   * meetup set is what makes a message reach both participants: a socket in it is delivered to
   * whatever the pair writes, on whichever instance wrote it. The session is what a session-scoped
   * invalidation closes the socket from, so a logout ends the sockets it opened and no others
   * (AAP 0.5.3).
   */
  attach(socket: WebSocket, userId: string, sessionId: string, meetupIds: readonly string[]): void;
  /**
   * Adds one meetup to every open socket of a user on this instance.
   *
   * Called when a meetup locks during the life of a socket, and by the write path for the meetup a
   * send committed in, so chat opens without a reconnect (AAP 0.5.3, 0.5.4); a socket opened after
   * the lock carries the meetup from {@link PubSub.attach}, and a chat beyond the bound that set was
   * read with arrives through {@link PubSub.openChat}.
   */
  attachMeetup(userId: string, meetupId: string): void;
  /**
   * Makes one chat live for a user's open sockets, on every API instance (AAP 0.3.2, 0.5.1, 0.5.4).
   *
   * A socket's meetup set is read once as it opens and bounded to the newest chats the user may
   * message in, so a chat the participant opens or writes in later would otherwise never reach their
   * open socket while the history read still returns its messages (AAP 0.5.1). This is the addition
   * that closes that window: the attach is the client's own use of the chat, and it reaches every
   * instance holding one of the user's sockets.
   *
   * Called by the history route, whose read is the client's "I opened this chat"; the write path makes
   * the same addition on its own instance through {@link PubSub.attachMeetup}, because the socket that
   * just wrote in the meetup already holds it (AAP 0.5.4). Raise-only: a meetup is added and never
   * removed, so a repeated call costs one lookup. Call it outside any transaction, as the publishing
   * methods above are called: it publishes on `user:<userId>`, and no Redis call belongs in a domain
   * transaction (AAP 0.3.2).
   *
   * It never throws: the attach is in process, and a publish that fails is logged as
   * `pubsub_publish_failed` and dropped exactly as {@link PubSub.publishUser} drops one, because the
   * frames it makes live are read back from the route that owns them (AAP 0.3.2).
   */
  openChat(userId: string, meetupId: string): Promise<void>;
  /**
   * Removes a socket from the registry: its user, every meetup it carried, and the registration
   * itself. Called by the chat route when the socket closes. Harmless for an unknown socket.
   */
  detach(socket: WebSocket): void;
}

/*
 * Helpers
 */

/**
 * A frame as it arrived: parsed JSON, or `null` when the payload is not JSON at all.
 *
 * `JSON.parse` is used through this one function so its result is `unknown` rather than `any`, and so
 * an invalid payload is one failure path instead of an exception escaping a socket listener.
 */
function decodeJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/*
 * The registry and the fan-out
 */

/** One socket's membership: the account it belongs to, its session, and the meetups it carries. */
interface SocketRegistration {
  readonly userId: string;
  /**
   * The session the upgrade authenticated with, which is what a session-scoped invalidation is
   * matched against, so a logout closes that session's sockets and leaves the user's others open
   * (AAP 0.5.3).
   */
  readonly sessionId: string;
  /**
   * The meetups whose `chat:` channel reaches this socket; the set grows as a meetup locks, or as the
   * participant opens or writes in a chat ({@link PubSub.openChat}).
   */
  readonly meetupIds: Set<string>;
}

/**
 * Builds the fan-out and the registry `apps/api/src/app.ts` holds as `services.pubsub`
 * (AAP 0.3.2, 0.5.1).
 *
 * The registry is per instance and in process. It is the only place this instance knows which
 * sockets it holds, and nothing about them is written to Redis: an instance serves the sockets it
 * accepted, and a frame reaches a socket on another instance through the subscription both instances
 * hold on the same channel.
 *
 * @param services - the publishing connection, the subscriber connection and the process logger.
 * @returns the {@link PubSub} the app exposes to `modules/messaging`, the meetup state machine and
 *   `app.ts`'s own shutdown.
 */
export function createPubSub(services: PubSubServices): PubSub {
  const { logger } = services;
  const { client, subscriber } = services.redis;

  /** Each socket's registration. A `WeakMap`, so a socket the route forgot to detach still goes. */
  const registrations = new WeakMap<WebSocket, SocketRegistration>();

  /** The open sockets of one user, and of one meetup. A set is dropped as soon as it empties. */
  const userSockets = new Map<string, Set<WebSocket>>();
  const meetupSockets = new Map<string, Set<WebSocket>>();

  let started = false;
  let closed = false;
  let subscribed = false;
  let listening = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------------------------
  // The registry
  // ---------------------------------------------------------------------------------------------

  /** Adds `socket` to the set `key` holds, creating the set on first use. */
  function addSocket(index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket): void {
    const sockets = index.get(key);
    if (sockets === undefined) index.set(key, new Set([socket]));
    else sockets.add(socket);
  }

  /** Removes `socket` from the set `key` holds, and drops the set once it is empty. */
  function removeSocket(index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket): void {
    const sockets = index.get(key);
    if (sockets === undefined) return;

    sockets.delete(socket);
    if (sockets.size === 0) index.delete(key);
  }

  /** Adds one meetup to a socket's registration, once, so repeated calls cost one lookup. */
  function attachMeetupTo(
    registration: SocketRegistration,
    socket: WebSocket,
    meetupId: string,
  ): void {
    if (registration.meetupIds.has(meetupId)) return;

    registration.meetupIds.add(meetupId);
    addSocket(meetupSockets, meetupId, socket);
  }

  function attach(
    socket: WebSocket,
    userId: string,
    sessionId: string,
    meetupIds: readonly string[],
  ): void {
    const existing = registrations.get(socket);
    // A socket belongs to one user and one session for its life. Should a route re-attach it as
    // another user, or under a session that replaced the one it was admitted with, the earlier
    // registration is dropped first, so no frame can reach a socket under the wrong account and no
    // invalidation names the wrong session.
    if (
      existing !== undefined &&
      (existing.userId !== userId || existing.sessionId !== sessionId)
    ) {
      detach(socket);
    }

    let registration = registrations.get(socket);
    if (registration === undefined) {
      registration = { userId, sessionId, meetupIds: new Set<string>() };
      registrations.set(socket, registration);
      addSocket(userSockets, userId, socket);
    }

    for (const meetupId of meetupIds) attachMeetupTo(registration, socket, meetupId);
  }

  function attachMeetup(userId: string, meetupId: string): void {
    const sockets = userSockets.get(userId);
    if (sockets === undefined) return;

    for (const socket of sockets) {
      const registration = registrations.get(socket);
      if (registration !== undefined && registration.userId === userId) {
        attachMeetupTo(registration, socket, meetupId);
      }
    }
  }

  function detach(socket: WebSocket): void {
    const registration = registrations.get(socket);
    if (registration === undefined) return;

    registrations.delete(socket);
    removeSocket(userSockets, registration.userId, socket);
    for (const meetupId of registration.meetupIds) removeSocket(meetupSockets, meetupId, socket);
    registration.meetupIds.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------------------------

  /**
   * Sends one already-serialized frame to every open socket of a set, one guarded send per socket, so
   * a socket that closed between the lookup and the send costs only its own frame.
   */
  function deliver(sockets: ReadonlySet<WebSocket> | undefined, payload: string): void {
    if (sockets === undefined) return;

    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;

      try {
        socket.send(payload);
      } catch {
        logger.warn({ event: 'ws_send_failed' }, 'ws_send_failed');
      }
    }
  }

  /**
   * Closes and forgets the sockets an invalidation ends (AAP 0.5.3).
   *
   * The frame's `sessionIds` decide the scope: when it names sessions, the sockets that were admitted
   * with one of them are the ones closed, which is what a logout ends and no more; when it names
   * none, every socket of the user goes, which is what an account-wide end — `DELETE /me` and a
   * refresh-reuse revocation — means.
   *
   * The close code is the client's signal that its session ended rather than a socket it should
   * reconnect: the token it holds was revoked, so it signs in again before opening another one.
   */
  function closeUserSockets(userId: string, sessionIds?: readonly string[]): void {
    const sockets = userSockets.get(userId);
    if (sockets === undefined) return;

    const ended = sessionIds === undefined || sessionIds.length === 0 ? null : new Set(sessionIds);

    for (const socket of [...sockets]) {
      const registration = registrations.get(socket);
      if (ended !== null && (registration === undefined || !ended.has(registration.sessionId))) {
        continue;
      }

      try {
        socket.close(WS_CLOSE.invalidated, 'invalidated');
      } catch {
        logger.warn({ event: 'ws_close_failed', userId }, 'ws_close_failed');
      }

      detach(socket);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Inbound frames
  // ---------------------------------------------------------------------------------------------

  /**
   * One message from either pattern. The channel decides which one it is; the payload is never
   * logged, because a chat frame carries a message body (AAP 0.11.1).
   */
  function onMessage(_pattern: string, channel: string, payload: string): void {
    if (channel.startsWith(CHAT_PREFIX)) {
      onChatFrame(channel.slice(CHAT_PREFIX.length), decodeJson(payload));
      return;
    }

    if (channel.startsWith(USER_PREFIX)) {
      onUserFrame(channel.slice(USER_PREFIX.length), decodeJson(payload));
      return;
    }

    logger.warn({ event: 'pubsub_frame_invalid', channelKind: 'unknown' }, 'pubsub_frame_invalid');
  }

  /** One chat frame, delivered to the meetup's sockets when it is a message for that meetup. */
  function onChatFrame(meetupId: string, decoded: unknown): void {
    const parsed = ServerFrame.safeParse(decoded);
    // The channel is the audience and the frame must agree with it: a frame published for another
    // meetup, or one that is not a chat message at all, is refused instead of delivered.
    if (
      !parsed.success ||
      parsed.data.type !== 'message' ||
      parsed.data.message.meetupId !== meetupId
    ) {
      logger.warn({ event: 'pubsub_frame_invalid', channelKind: 'chat' }, 'pubsub_frame_invalid');
      return;
    }

    deliver(meetupSockets.get(meetupId), JSON.stringify(parsed.data));
  }

  /** One user-channel frame: one of the two internal signals, or a client-facing server frame. */
  function onUserFrame(userId: string, decoded: unknown): void {
    const invalidate = InvalidateSignal.safeParse(decoded);
    if (invalidate.success) {
      const { sessionIds } = invalidate.data;
      closeUserSockets(userId, sessionIds);

      if (sessionIds !== undefined && sessionIds.length > 0) {
        // The publisher deleted the shared keys before publishing; this is the entry an instance of
        // its own wrote from an earlier request (AAP 0.5.3). Not awaited, so a socket listener never
        // holds the connection's callback up, and the drop cannot fail the frame.
        dropCachedSessions(services, sessionIds).catch(() => {
          logger.warn({ event: 'session_cache_drop_failed' }, 'session_cache_drop_failed');
        });
      }
      return;
    }

    // The other internal frame: it announces that one meetup joins this user's sockets, and it is
    // consumed here rather than delivered, so no client is ever sent a frame the contract does not
    // define (AAP 0.5.1). The instance that published it attached the meetup before publishing, so
    // this is the addition for every other instance (AAP 0.3.2).
    const attach = AttachMeetupSignal.safeParse(decoded);
    if (attach.success) {
      attachMeetup(userId, attach.data.meetupId);
      return;
    }

    const parsed = ServerFrame.safeParse(decoded);
    if (!parsed.success) {
      logger.warn({ event: 'pubsub_frame_invalid', channelKind: 'user' }, 'pubsub_frame_invalid');
      return;
    }

    // A locked meetup is the moment messaging opens (AAP 0.5.4), and the socket is already open: the
    // meetup joins its set here so chat needs no reconnect. No other status detaches it, because
    // `canMessage` is checked on every send and is the authority on access.
    if (parsed.data.type === 'meetup_status' && parsed.data.status === 'locked') {
      attachMeetup(userId, parsed.data.meetupId);
    }

    deliver(userSockets.get(userId), JSON.stringify(parsed.data));
  }

  // ---------------------------------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------------------------------

  /** The wire form of a user-channel message, or `null` when it is not a shape the contract allows. */
  function encodeUserMessage(message: UserChannelMessage): string | null {
    if (message.type === 'invalidate') {
      const parsed = InvalidateSignal.safeParse(message);
      return parsed.success ? JSON.stringify(parsed.data) : null;
    }

    // The second internal frame, encoded the same way: it is not a `ServerFrame`, so it is written
    // back from its own schema rather than handed to `ServerFrame` (AAP 0.5.1).
    if (message.type === 'attach_meetup') {
      const parsed = AttachMeetupSignal.safeParse(message);
      return parsed.success ? JSON.stringify(parsed.data) : null;
    }

    const parsed = ServerFrame.safeParse(message);
    return parsed.success ? JSON.stringify(parsed.data) : null;
  }

  /** Publishes `payload` on `channel`, recording a failure and never throwing (AAP 0.3.2). */
  async function publish(
    channel: string,
    payload: string,
    channelKind: 'chat' | 'user',
  ): Promise<void> {
    try {
      await client.publish(channel, payload);
    } catch {
      logger.warn({ event: 'pubsub_publish_failed', channelKind }, 'pubsub_publish_failed');
    }
  }

  async function publishUser(userId: string, message: UserChannelMessage): Promise<void> {
    const encoded = encodeUserMessage(message);
    if (encoded === null) {
      logger.warn({ event: 'ws_frame_invalid', type: message.type }, 'ws_frame_invalid');
      return;
    }

    await publish(userChannel(userId), encoded, 'user');
  }

  async function publishChat(meetupId: string, frame: MessageFrame): Promise<void> {
    const parsed = ServerFrame.safeParse(frame);
    if (
      !parsed.success ||
      parsed.data.type !== 'message' ||
      parsed.data.message.meetupId !== meetupId
    ) {
      logger.warn({ event: 'ws_frame_invalid', type: 'message' }, 'ws_frame_invalid');
      return;
    }

    await publish(chatChannel(meetupId), JSON.stringify(parsed.data), 'chat');
  }

  async function publishInvalidate(userId: string, sessionIds?: readonly string[]): Promise<void> {
    const message: InvalidateSignal =
      sessionIds === undefined || sessionIds.length === 0
        ? { type: 'invalidate' }
        : { type: 'invalidate', sessionIds: [...sessionIds] };

    await publishUser(userId, message);
  }

  /**
   * Makes one chat live for a user's open sockets: on this instance at once, and on every other one
   * through the user channel (AAP 0.3.2, 0.5.1, 0.5.4).
   *
   * The local attach runs first, because the instance serving the read or the write is the one most
   * likely to hold a socket of that user, and its sockets are then carried without waiting for the
   * frame published below to come back over the subscription. The attach is in process; only the
   * publish is a round trip, and {@link publishUser} never throws.
   */
  async function openChat(userId: string, meetupId: string): Promise<void> {
    attachMeetup(userId, meetupId);
    await publishUser(userId, { type: 'attach_meetup', meetupId });
  }

  // ---------------------------------------------------------------------------------------------
  // Subscription lifecycle
  // ---------------------------------------------------------------------------------------------

  /**
   * Registers the two listeners, once for the life of this instance.
   *
   * ioredis' `autoResubscribe` restores the patterns itself after a reconnect, so a listener may not
   * be registered again — that would deliver every frame twice. `close()` removes exactly the pair
   * added here.
   */
  function listen(): void {
    if (listening) return;

    listening = true;
    subscriber.on('pmessage', onMessage);
    subscriber.on('error', onError);
  }

  /**
   * A connection-level error, recorded without the connection string and without a message.
   *
   * Throttled, because a Redis that is down fires this listener on every reconnect attempt and the
   * subscriber's own connection failure is the same outage the connection warnings report: the first
   * line is written at once and a later one waits out the throttle's window, so an outage lasting
   * minutes costs a handful of lines here rather than one per attempt, and the first one — the one an
   * operator reads — stays where they can find it.
   */
  function onError(error: Error): void {
    throttleRedisFailure('pubsub:subscriber', () => {
      logger.warn({ event: 'pubsub_error', err: { name: error.name } }, 'pubsub_error');
    });
  }

  /** One attempt at holding both patterns; `true` when the instance is subscribed. */
  async function subscribe(): Promise<boolean> {
    try {
      if (subscriber.status === 'wait' || subscriber.status === 'end') {
        // Not awaited: a Redis that is down leaves this pending, and the retry below is what reports
        // the outage and keeps trying. `main.ts` awaits `waitForRedisReady` at startup, so a
        // connection that is already open skips this.
        void subscriber.connect().catch(() => undefined);
      }

      await subscriber.psubscribe(USER_PATTERN, CHAT_PATTERN);
      return true;
    } catch {
      logger.warn({ event: 'pubsub_subscribe_failed' }, 'pubsub_subscribe_failed');
      return false;
    }
  }

  /** Retries the subscription once, {@link SUBSCRIBE_RETRY_MS} later, unless `close()` has run. */
  function scheduleRetry(): void {
    if (closed || retryTimer !== null) return;

    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attemptSubscribe();
    }, SUBSCRIBE_RETRY_MS);
  }

  /** Holds both patterns, retrying on the fixed cadence while Redis is unreachable (AAP 0.3.2). */
  async function attemptSubscribe(): Promise<void> {
    if (closed) return;

    if (await subscribe()) {
      subscribed = true;
      return;
    }

    scheduleRetry();
  }

  async function start(): Promise<void> {
    if (started || closed) return;

    started = true;
    listen();
    await attemptSubscribe();
  }

  async function close(): Promise<void> {
    if (closed) return;

    closed = true;

    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    if (listening) {
      subscriber.off('pmessage', onMessage);
      subscriber.off('error', onError);
      listening = false;
    }

    if (subscribed) {
      subscribed = false;
      try {
        await subscriber.punsubscribe(USER_PATTERN, CHAT_PATTERN);
      } catch {
        logger.warn({ event: 'pubsub_unsubscribe_failed' }, 'pubsub_unsubscribe_failed');
      }
    }

    closeRegisteredSockets();
  }

  /** Closes every registered socket with 1001 and empties the registry. */
  function closeRegisteredSockets(): void {
    for (const sockets of userSockets.values()) {
      for (const socket of [...sockets]) {
        try {
          if (socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING) {
            socket.close(WS_GOING_AWAY);
          }
        } catch {
          logger.warn({ event: 'ws_close_failed' }, 'ws_close_failed');
        }

        detach(socket);
      }
    }

    userSockets.clear();
    meetupSockets.clear();
  }

  return {
    start,
    close,
    publishUser,
    publishChat,
    publishInvalidate,
    attach,
    attachMeetup,
    openChat,
    detach,
  };
}
