/**
 * Redis pub/sub fan-out and the in-process socket registry behind the chat socket.
 * A socket belongs to exactly one API instance, so a frame written on one reaches a socket held by another only through
 * Redis. Two channels carry that traffic: `chat:<meetupId>` carries committed messages, and `user:<userId>` carries the
 * frames addressed to one account — a client frame, an invalidation and an attach.
 */

import { z } from 'zod';

import { ServerFrame, Uuid, WS_CLOSE, chatChannel, userChannel } from '@tablemate/shared';
import type { MessageFrame } from '@tablemate/shared';
import { throttleRedisFailure } from '@tablemate/server-core';
import type { Logger } from '@tablemate/server-core';

import { dropCachedSessions } from '../../plugins/auth.ts';

import type { SessionCacheCommands } from '../../plugins/auth.ts';

import type { WebSocket } from 'ws';

/**
 * How long to wait before registering the two pattern subscriptions again after a failed attempt. An attempt fails while
 * Redis is unreachable — a `client`-role connection queues nothing, so `psubscribe` rejects instead of waiting — and is
 * retried on this cadence until it succeeds.
 */
export const SUBSCRIBE_RETRY_MS = 5_000;

/**
 * The close code {@link PubSub.close} sends: 1001, going away (RFC 6455 §7.4.1). Deliberately not one of
 * {@link WS_CLOSE}'s application codes, because no application rule refused the socket — the process is going away.
 */
const WS_GOING_AWAY = 1001;

/** The prefix of a chat channel, and of a user channel, taken from the shared helpers (AAP 0.5.1). */
const CHAT_PREFIX = chatChannel('');
const USER_PREFIX = userChannel('');

/** The two patterns one `psubscribe` registers, likewise derived from the shared helpers. */
const CHAT_PATTERN = chatChannel('*');
const USER_PATTERN = userChannel('*');

/** The one Redis command a frame is published with, as the `client`-role connection exposes it. */
export interface PublishCommands {
  publish(channel: string, message: string): Promise<unknown>;
}

/** A message delivered on the patterns above: the pattern, the channel, and the frame as JSON. */
type PmessageListener = (pattern: string, channel: string, message: string) => void;

/**
 * What the subscriber connection must offer: a `client`-role connection of its own, because a subscribed connection can
 * issue no other command, so it is never the one a frame is published on. Spelled out rather than imported so the module
 * names the four capabilities it depends on.
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
 * What this module needs from the app's services: the publisher, the subscriber and the logger. Declared narrow and
 * locally rather than as `Pick<AppServices, ...>`, because `AppServices` lives in `apps/api/src/app.ts`, a file this
 * module must not depend on.
 */
export interface PubSubServices {
  readonly redis: {
    readonly client: SessionCacheCommands & PublishCommands;
    readonly subscriber: SubscriberCommands;
  };
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  /**
   * The API's validated configuration, narrowed to the one setting this module decides with: the per-account socket
   * allowance {@link PubSub.attach} enforces. Declared as its own shape rather than as `ApiEnv`, so the app container
   * satisfies it structurally.
   */
  readonly env: { readonly CHAT_MAX_SOCKETS_PER_USER: number };
}

/**
 * The invalidation every API instance reads on `user:<userId>`. Published by `plugins/auth.ts` after the transaction that
 * revoked sessions committed: the frozen `{ type: 'invalidate' }` frame for an account that ended as a whole, or the same
 * frame carrying the `sessionIds` of the one session that ended.
 */
export const InvalidateSignal = z.strictObject({
  type: z.literal('invalidate'),
  sessionIds: z.array(Uuid).optional(),
});
export type InvalidateSignal = z.infer<typeof InvalidateSignal>;

/**
 * The attach every API instance reads on `user:<userId>`: one meetup joins that user's sockets. Published by
 * {@link PubSub.openChat}, which has already attached the meetup on the instance that served the request; it exists
 * because a socket's meetup set is read once as it opens and bounded to the newest chats.
 */
export const AttachMeetupSignal = z.strictObject({
  type: z.literal('attach_meetup'),
  meetupId: Uuid,
});
export type AttachMeetupSignal = z.infer<typeof AttachMeetupSignal>;

/**
 * Every message the user channel may carry: a client-facing {@link ServerFrame}, or one of the two internal signals the
 * API instances send each other — {@link InvalidateSignal} and {@link AttachMeetupSignal}.
 */
export type UserChannelMessage = ServerFrame | InvalidateSignal | AttachMeetupSignal;

/**
 * Redis pub/sub fan-out and the local socket registry, as `app.ts` holds it on `services.pubsub`. The publishing methods
 * are the whole cross-instance surface: what the messaging routes call after a message commits, what the meetup state
 * machine calls on a transition, and what the auth plugin calls after a revocation.
 */
export interface PubSub {
  /**
   * Subscribes this instance to both patterns, and starts retrying if that fails. Idempotent, never rejects, and safe to
   * call before Redis is reachable: a failed attempt is logged as `pubsub_subscribe_failed` and retried every
   * {@link SUBSCRIBE_RETRY_MS} until it succeeds, so a Redis outage delays this instance's fan-out and nothing else.
   */
  start(): Promise<void>;
  /** Gives the two patterns back, detaches every registered socket and closes it with 1001; the Redis connections are left
   * open, because `app.ts` owns them. Idempotent. */
  close(): Promise<void>;
  /**
   * Publishes one frame to a user's own sockets, on `user:<userId>`. Call it after the transaction that decided the frame
   * committed, never inside one. It never throws: a frame that is none of {@link ServerFrame}, {@link InvalidateSignal} or
   * {@link AttachMeetupSignal} is a programming error it reports and drops.
   */
  publishUser(userId: string, message: UserChannelMessage): Promise<void>;
  /**
   * Publishes one committed chat message to its meetup, on `chat:<meetupId>`. Same preconditions and failure behaviour as
   * {@link PubSub.publishUser}; a frame naming another meetup than the channel is refused, so a message can never be
   * delivered to the wrong pair's sockets.
   */
  publishChat(meetupId: string, frame: MessageFrame): Promise<void>;
  /**
   * Publishes an invalidation on a user's channel, naming the sessions it ends. The frame is what every instance closes the
   * sockets of those sessions from, and the session ids are also what each instance drops from its own cache. An absent or
   * empty list publishes the bare frame, which closes every socket of the user.
   */
  publishInvalidate(userId: string, sessionIds?: readonly string[]): Promise<void>;
  /**
   * Registers an open socket under its user, the session it was admitted with, and each of the meetups it carries, and
   * answers whether it registered it. The meetup set is what makes a message reach both participants, and the session is
   * what a session-scoped invalidation closes the socket from.
   * The per-account allowance is enforced here: a socket over `CHAT_MAX_SOCKETS_PER_USER` is refused rather than registered,
   * which is the `tooMany` close the client sees.
   */
  attach(
    socket: WebSocket,
    userId: string,
    sessionId: string,
    meetupIds: readonly string[],
  ): boolean;
  /**
   * Adds one meetup to every open socket of a user on this instance, and answers how many it reached. Called when a meetup
   * locks during the life of a socket, and by the write path for the meetup a send committed in, so chat opens without a
   * reconnect.
   */
  attachMeetup(userId: string, meetupId: string): void;
  /**
   * Makes one chat live for a user's open sockets, on every API instance. A socket's meetup set is read once as it opens and
   * bounded to the newest chats, so a chat the participant opens or writes in later would otherwise never reach their open
   * socket while the history read still returns it. The local attach runs first.
   */
  openChat(userId: string, meetupId: string): Promise<void>;
  /** Removes a socket from the registry: its user, every meetup it carried, and the registration itself. Called by the chat
   * route when the socket closes; harmless for an unknown socket. */
  detach(socket: WebSocket): void;
}

/**
 * A frame as it arrived: parsed JSON, or `null` when the payload is not JSON at all. `JSON.parse` is used through this one
 * function so its result is `unknown` rather than `any`, and so an invalid payload is one failure path instead of an
 * exception escaping a socket listener.
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
 *
 * `userSockets` is both the fan-out index and the count the per-account allowance of {@link PubSub.attach} is taken
 * against: it holds exactly the sockets of one account this instance has registered and not yet detached, which is what
 * `CHAT_MAX_SOCKETS_PER_USER` bounds (AAP 0.3.2, 0.5.2).
 */

interface SocketRegistration {
  readonly userId: string;
  /** The session the upgrade authenticated with, which is what a session-scoped invalidation is matched against, so a logout
   * closes that session's sockets and leaves the user's others open. */
  readonly sessionId: string;
  /** The meetups whose `chat:` channel reaches this socket; the set grows as a meetup locks, or as the participant opens or writes in a chat. */
  readonly meetupIds: Set<string>;
}

/**
 * Builds the fan-out and the registry `app.ts` holds as `services.pubsub`. The registry is per instance and in process:
 * nothing about a socket is written to Redis, and a frame reaches a socket on another instance through the subscription
 * both instances hold on the same channel.
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
  function addSocket(index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket): void {
    const sockets = index.get(key);
    if (sockets === undefined) index.set(key, new Set([socket]));
    else sockets.add(socket);
  }
  function removeSocket(index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket): void {
    const sockets = index.get(key);
    if (sockets === undefined) return;
    sockets.delete(socket);
    if (sockets.size === 0) index.delete(key);
  }
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
  ): boolean {
    const existing = registrations.get(socket);
    // A socket belongs to one user and one session for its life: should a route re-attach it as another user, or under a
    // session that replaced the one it was admitted with, the earlier registration is dropped first, so no frame can reach a
    // socket under the wrong account and no invalidation names the wrong session.
    if (
      existing !== undefined &&
      (existing.userId !== userId || existing.sessionId !== sessionId)
    ) {
      detach(socket);
    }
    let registration = registrations.get(socket);
    if (registration === undefined) {
      // The account's allowance, counted and claimed in one synchronous step: `userSockets` holds exactly the sockets of this
      // account the instance has registered and not detached, and there is no await between reading its size and writing the
      // registration below, so two upgrades of one account arriving together cannot both pass the same count. The newest socket
      // is the one refused, so a refusal leaves the sockets the account is already chatting on serving.
      if ((userSockets.get(userId)?.size ?? 0) >= services.env.CHAT_MAX_SOCKETS_PER_USER) {
        return false;
      }
      registration = { userId, sessionId, meetupIds: new Set<string>() };
      registrations.set(socket, registration);
      addSocket(userSockets, userId, socket);
    }
    for (const meetupId of meetupIds) attachMeetupTo(registration, socket, meetupId);
    return true;
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
  /** Sends one already-serialized frame to every open socket of a set, one guarded send per socket, so a socket that closed between the lookup and the send costs only its own frame. */
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
   * Closes and forgets the sockets an invalidation ends. The frame's `sessionIds` decide the scope: when it names sessions,
   * the sockets admitted with one of them are closed, which is what a logout ends and no more; when it names none, every
   * socket of the user goes.
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
  /** One message from either pattern. The channel decides which one it is; the payload is never logged, because a chat frame carries a message body. */
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
    // The channel is the audience and the frame must agree with it: a frame published for another meetup, or one that is not a chat message at all, is refused instead of delivered.
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
        // The publisher deleted the shared keys before publishing; this is the entry an instance of its own wrote from an earlier
        // request. Not awaited, so a socket listener never holds the connection's callback up, and the drop cannot fail the frame.
        dropCachedSessions(services, sessionIds).catch(() => {
          logger.warn({ event: 'session_cache_drop_failed' }, 'session_cache_drop_failed');
        });
      }
      return;
    }
    // The other internal frame: it announces that one meetup joins this user's sockets, and it is consumed here rather than
    // delivered, so no client is ever sent a frame the contract does not define. The instance that published it attached the
    // meetup before publishing, so this is the addition for every other instance.
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
    // A locked meetup is the moment messaging opens, and the socket is already open: the meetup joins its set here so chat
    // needs no reconnect. No other status detaches it, because `canMessage` is checked on every send.
    if (parsed.data.type === 'meetup_status' && parsed.data.status === 'locked') {
      attachMeetup(userId, parsed.data.meetupId);
    }
    deliver(userSockets.get(userId), JSON.stringify(parsed.data));
  }
  /** The wire form of a user-channel message, or `null` when it is not a shape the contract allows. */
  function encodeUserMessage(message: UserChannelMessage): string | null {
    if (message.type === 'invalidate') {
      const parsed = InvalidateSignal.safeParse(message);
      return parsed.success ? JSON.stringify(parsed.data) : null;
    }
    // The second internal frame, encoded the same way: it is not a `ServerFrame`, so it is written back from its own schema rather than handed to `ServerFrame`.
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
   * Makes one chat live for a user's open sockets: on this instance at once, and on every other one through the user
   * channel. The local attach runs first, because the instance serving the read or the write is the one most likely to hold
   * a socket of that user, and its sockets are then carried without waiting for the frame published below.
   */
  async function openChat(userId: string, meetupId: string): Promise<void> {
    attachMeetup(userId, meetupId);
    await publishUser(userId, { type: 'attach_meetup', meetupId });
  }
  /**
   * Registers the two listeners, once for the life of this instance: ioredis' `autoResubscribe` restores the patterns
   * itself after a reconnect, so a listener registered again would deliver every frame twice. `close()` removes exactly the
   * pair added here.
   */
  function listen(): void {
    if (listening) return;
    listening = true;
    subscriber.on('pmessage', onMessage);
    subscriber.on('error', onError);
  }
  /**
   * A connection-level error, recorded without the connection string and without a message. Throttled, because a Redis that
   * is down fires this listener on every reconnect attempt and the subscriber's own connection failure is the same outage
   * the connection warnings report.
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
        // Not awaited: a Redis that is down leaves this pending, and the retry below is what reports the outage and keeps trying.
        // `main.ts` awaits `waitForRedisReady` at startup, so a connection that is already open skips this.
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
