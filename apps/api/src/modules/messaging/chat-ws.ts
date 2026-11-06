/**
 * `WS /v1/chat`: the one socket the traveler app holds, carrying pair chat and the meetup-status
 * pushes that arrive beside it (AAP 0.3.3, 0.5.1, 0.5.3, 0.5.4, 0.8.1).
 *
 * A browser `WebSocket` cannot set an `Authorization` header, so the handshake authenticates with the
 * `Sec-WebSocket-Protocol: bearer, <accessToken>` subprotocol and the API answers with `bearer` alone
 * (AAP 0.3.3). Authentication is a route hook rather than a global one: `requireWebSocketBearer` reads
 * the token from the subprotocol header, applies the age gate as the REST traveler guard does, and
 * runs before `@fastify/websocket` hijacks the connection, so a refusal is answered as plain HTTP 401
 * `token_invalid` (or 403 `age_gate_required`) on a connection that is never upgraded. This route is
 * deliberately not inside the traveler route group, whose guard reads the header a browser cannot set.
 *
 * Five invariants hold for the life of an accepted socket:
 *
 *  - **Frames are processed one at a time, in order.** Every inbound frame's work is appended to a
 *    per-socket promise chain, so two messages from one sender are committed in the order they were
 *    sent. A chain that rejected would stall every frame behind it, so each frame's handling turns
 *    every failure it can meet into a frame and resolves.
 *  - **The access check runs inside the transaction that writes the message**, behind the
 *    account-deletion write fence (AAP 0.5.3). `transact(..., { fenceUserId })` takes `SELECT … FOR
 *    SHARE` on the sender's row first, and `canMessage` then reads the block, the pair's lock and the
 *    counterpart's account from the tables, so a block, a settlement or a deletion that committed
 *    first is visible here and a refusal writes nothing.
 *  - **No Redis call runs inside the transaction.** The message is published to both participants
 *    after the commit, through `after`: Redis is never a condition of the write, and a publish that
 *    fails costs only the live frame — the message is in the pair's history either way (AAP 0.3.2).
 *  - **Delivery is the pub/sub echo.** The sender's confirmation is the same `MessageFrame` the other
 *    participant receives, delivered by subscription rather than by this handler, so the two see one
 *    frame each and this file acknowledges nothing separately (AAP 0.5.4).
 *  - **A socket is bounded and is always given up.** Sixty accepted sends per rolling minute per
 *    socket, a 30-second ping/pong heartbeat that ends a socket which stopped answering, and a close
 *    or an error that stops the heartbeat and detaches the socket from the fan-out (AAP 0.3.2).
 *
 * Nothing here logs a message body, a token or a `Sec-WebSocket-Protocol` header: a refusal writes no
 * line at all, an internal failure writes the event, the meetup id and the error's name, and a stored
 * message writes at most one debug line carrying the event and the meetup id (AAP 0.11.1).
 *
 * @see AAP 0.3.2 for the stateless fan-out, the transaction and outbox rules and the socket bounds;
 *   0.3.3 for the subprotocol handshake; 0.5.1 for this file's place in the messaging component;
 *   0.5.2 for the `Message` model; 0.5.3 for the write fence, the block's effect and the meetup
 *   lifecycle a send is judged against; 0.5.4 for the route, its frames and its errors; 0.11.1 for
 *   the injected clock and the logging rules; and 0.8.1 for this file.
 */

import { ClientFrame, MINUTE_MS } from '@tablemate/shared';
import type { ChatSend, Message, ServerFrame } from '@tablemate/shared';

import { requireWebSocketBearer } from '../../plugins/auth.ts';
import { AppError, errorFrame, isAppError } from '../../plugins/errors.ts';
import { WS_CLOSE } from '../../plugins/websocket.ts';
import { transact } from '../outbox/write.ts';
import { canMessage, messageableMeetupIds } from './access.ts';

import type { FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';

// Type-only, so this file holds no run-time edge back to the module that registers it: `App` and
// `AppServices` are the plan's one declaration of the instance and of what it hands its modules,
// they are erased at compile time, and nothing of `app.ts` is read here at runtime.
import type { App, AppServices } from '../../app.ts';

/*
 * Constants (AAP 0.5.4)
 */

/**
 * How many `chat_send` frames one socket may have accepted inside a rolling minute.
 *
 * The allowance belongs to the socket rather than to the account, because a WebSocket write carries
 * no HTTP request for `@fastify/rate-limit` to count; the REST routes keep their own per-user and
 * per-IP limits (AAP 0.5.4).
 */
export const CHAT_SEND_LIMIT_PER_MINUTE = 60;

/**
 * How often an accepted socket is pinged, and therefore how long an unanswered ping may stand before
 * the socket is terminated. Half of the relay's own 10-minute call budget, and long enough that a
 * mobile client on a slow network is not ended by one late pong (AAP 0.3.2).
 */
export const CHAT_HEARTBEAT_MS = 30_000;

/**
 * The chat socket's path, relative to the `/v1` prefix the composition root mounts the messaging
 * module under; the client appends the same path to its configured base (`src/api/ws.ts`).
 */
const CHAT_PATH = '/chat';

/**
 * RFC 6455's "internal error": this file failed on a connection it had already accepted, so the
 * socket is closed rather than left open on a connection no attach has registered (AAP 0.3.2).
 */
const CLOSE_INTERNAL_ERROR = 1011;

/*
 * Types
 */

/**
 * What this module needs from the app's services (AAP 0.5.1).
 *
 * A `Pick` of the app's own services type, narrowed to what a socket reads: the guarded database
 * client, the injected clock, the logger `transact` reports its own failures with, the outbox the
 * transaction helper kicks, and the pub/sub fan-out. Test doubles therefore stay small, and the app
 * container satisfies this structurally.
 */
type ChatServices = Pick<AppServices, 'db' | 'clock' | 'logger' | 'outbox' | 'pubsub'>;

/**
 * One `Message` row, as the insert hands it back and as the pair's history loads it (AAP 0.5.2).
 *
 * `senderId` is nullable here although `Message.senderId` is not: erasure leaves the counterpart's
 * messages in the counterpart's history, so a retained row may name a sender whose account is gone,
 * and the history route nulls it in the DTO (AAP 0.5.2). Declared structurally rather than imported
 * from the database package, so the one DTO builder serves every caller of either shape.
 */
export interface MessageRow {
  readonly id: string;
  readonly meetupId: string;
  readonly senderId: string | null;
  readonly body: string;
  readonly createdAt: Date;
}

/** One open socket's state: the connection, the frames it may still accept, and its frame chain. */
interface ChatConnection {
  /** The app's services, as the attach, the fenced transaction and the publish each need them. */
  readonly services: ChatServices;
  /** The upgraded socket. */
  readonly socket: WebSocket;
  /** The authenticated caller, read from `request.auth` once the upgrade hook admitted it. */
  readonly userId: string;
  /** The request's own logger, which already carries the request id (AAP 0.11.1). */
  readonly log: FastifyRequest['log'];
  /** Writes one server frame to this socket, when it is still open. */
  readonly send: (frame: ServerFrame) => void;
  /** Epoch milliseconds of the sends accepted inside the current rolling minute, oldest first. */
  readonly sendTimes: number[];
  /** The tail of this socket's frame chain, which the next frame's work is appended to. */
  chain: Promise<void>;
}

/*
 * The message DTO (AAP 0.5.4)
 */

/**
 * One stored message as the contract's `Message` (AAP 0.5.4).
 *
 * Built field by field rather than spread, so no column the model grows can reach a client through
 * this shape, and shared with `GET /meetups/:id/messages`, so the socket and the history route can
 * never disagree about a message (AAP 0.5.4, 0.11.1).
 *
 * @param row - The stored row.
 * @param senderErased - Whether the sender's account has been erased, in which case the message is
 *   not tied to a live sender and `senderId` is `null` (AAP 0.5.2).
 * @returns The message as the contract declares it, with `createdAt` in ISO 8601 UTC.
 */
export function toMessageDto(row: MessageRow, senderErased: boolean): Message {
  const senderId = row.senderId;

  return {
    id: row.id,
    meetupId: row.meetupId,
    senderId: senderErased || senderId === null ? null : senderId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/*
 * Helpers
 */

/** An error's name, or `Error` for a value that is not one (AAP 0.11.1). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/**
 * The text of a text frame, or `null` when the frame arrived as binary.
 *
 * A frame is one buffer, an `ArrayBuffer` or the fragments `ws` collected, so the chunks are decoded
 * with one streaming decoder: a multi-byte character split across two fragments is therefore joined
 * before it is parsed rather than replaced with a replacement character (AAP 0.3.3).
 */
function frameText(data: RawData, isBinary: boolean): string | null {
  if (isBinary) return null;

  const chunks = Array.isArray(data) ? data : [data];
  const decoder = new TextDecoder();
  let text = '';

  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }

  return text + decoder.decode();
}

/**
 * One inbound frame, or `null` when the payload is not a frame the contract allows (AAP 0.5.4).
 *
 * The returned value is the parsed frame, not the text it came from: `ChatSend` trims its `body`, so
 * what is validated is what is stored.
 */
function parseClientFrame(data: RawData, isBinary: boolean): ClientFrame | null {
  const text = frameText(data, isBinary);
  if (text === null) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  const parsed = ClientFrame.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether one more send fits the socket's allowance, and records it when it does (AAP 0.5.4).
 *
 * A rolling minute rather than a fixed one, so a sender cannot write `2 × CHAT_SEND_LIMIT_PER_MINUTE`
 * back to back across a bucket boundary. The instant comes from the injected clock (AAP 0.11.1), and
 * the window is pruned as it moves, so the array holds at most the allowance in timestamps.
 *
 * @param sendTimes - The accepted sends of one socket, oldest first; pruned in place to the window.
 * @param nowMs - The instant the frame was received.
 * @returns `true` when the frame fits the allowance and was counted, `false` when it does not fit and
 *   was therefore not counted either.
 */
function withinSendAllowance(sendTimes: number[], nowMs: number): boolean {
  const cutoff = nowMs - MINUTE_MS;

  for (;;) {
    const oldest = sendTimes[0];
    if (oldest === undefined || oldest > cutoff) break;
    sendTimes.shift();
  }

  if (sendTimes.length >= CHAT_SEND_LIMIT_PER_MINUTE) return false;

  sendTimes.push(nowMs);
  return true;
}

/**
 * Writes one server frame to a socket that is still open (AAP 0.5.4).
 *
 * Only `ServerFrame`-shaped JSON leaves this module, and only while the socket can carry it: a frame
 * written after the close costs one failed send and nothing else, because what it announced is read
 * back from the route that owns it (AAP 0.3.2).
 */
function sendFrame(socket: WebSocket, frame: ServerFrame, log: FastifyRequest['log']): void {
  if (socket.readyState !== socket.OPEN) return;

  try {
    socket.send(JSON.stringify(frame));
  } catch (error) {
    log.warn({ event: 'ws_send_failed', err: { name: errorName(error) } }, 'ws_send_failed');
  }
}

/*
 * The write path (AAP 0.3.2, 0.5.3, 0.5.4)
 */

/**
 * Stores one chat message and announces it to both participants (AAP 0.5.3, 0.5.4).
 *
 * The access check and the insert share one transaction behind the sender's write fence, so a block
 * or a deletion that committed first is refused with nothing written and no message can be recreated
 * for an erased account. The publish is registered through `after` and therefore runs after the
 * commit: no Redis call belongs inside a domain transaction (AAP 0.3.2).
 *
 * @param services - The app's services, of which the database, the clock and the outbox are used.
 * @param senderId - The authenticated sender, checked against the meetup inside the transaction.
 * @param frame - The parsed `ChatSend`, whose trimmed body is the text stored.
 * @throws AppError `not_participant`, `messaging_locked` or `blocked` when the pair may not message,
 *   and `token_invalid` when the write fence refused the sender (AAP 0.5.3, 0.5.4).
 */
async function persistMessage(
  services: ChatServices,
  senderId: string,
  frame: ChatSend,
): Promise<void> {
  await transact(
    services,
    async (tx, after) => {
      const access = await canMessage(tx, frame.meetupId, senderId);
      if (!access.ok) {
        throw new AppError(access.code);
      }

      const row = await tx.message.create({
        data: {
          meetupId: frame.meetupId,
          senderId,
          body: frame.body,
          createdAt: services.clock.now(),
        },
      });

      // The sender's confirmation is this same frame: `publishChat` reaches every instance holding a
      // socket for the meetup, the sender's included, so no separate acknowledgement is sent.
      after(() =>
        services.pubsub.publishChat(frame.meetupId, {
          type: 'message',
          message: toMessageDto(row, false),
        }),
      );
    },
    { fenceUserId: senderId },
  );
}

/**
 * Answers a send that failed, in a frame the client can act on (AAP 0.5.3, 0.5.4).
 *
 * The distinction is what the client must do next: an ended session closes the socket, a momentary
 * refusal is answered in place and leaves it open, because the same pair may lock a meetup later in
 * this socket's life, and anything else is our defect and is logged before it is answered.
 */
function refuseSend(connection: ChatConnection, frame: ChatSend, error: unknown): void {
  if (isAppError(error)) {
    if (error.code === 'token_invalid') {
      // The write fence refused the message: `DELETE /me` committed first, so this session is gone
      // and the socket cannot continue. The frame is answered before the close, so a client that
      // never observes the close code still learns why the message was not stored (AAP 0.5.3).
      connection.send(errorFrame('token_invalid'));
      connection.socket.close(WS_CLOSE.unauthorized, 'token_invalid');
      return;
    }

    connection.send(errorFrame(error.code, undefined, frame.meetupId));
    return;
  }

  connection.log.error(
    { event: 'chat_send_failed', meetupId: frame.meetupId, err: { name: errorName(error) } },
    'chat_send_failed',
  );
  connection.send(errorFrame('internal_error', undefined, frame.meetupId));
}

/**
 * Handles one inbound frame: parse, allowance, then the fenced write (AAP 0.5.4).
 *
 * Never rejects. Every failure becomes a frame on the socket or a log line, so the socket's frame
 * chain always advances and one refused message never stalls the messages behind it.
 */
async function receiveFrame(
  connection: ChatConnection,
  data: RawData,
  isBinary: boolean,
): Promise<void> {
  const frame = parseClientFrame(data, isBinary);

  if (frame === null) {
    connection.send(errorFrame('invalid_field'));
    return;
  }

  if (!withinSendAllowance(connection.sendTimes, connection.services.clock.nowMs())) {
    // One frame over the allowance is refused in place: the socket stays open and nothing is stored,
    // which tells a client to slow down rather than to reconnect (AAP 0.5.4).
    connection.send(errorFrame('rate_limited', undefined, frame.meetupId));
    return;
  }

  try {
    await persistMessage(connection.services, connection.userId, frame);
    connection.log.debug(
      { event: 'chat_message_sent', meetupId: frame.meetupId },
      'chat_message_sent',
    );
  } catch (error) {
    refuseSend(connection, frame, error);
  }
}

/*
 * The connection (AAP 0.3.2, 0.5.3, 0.5.4)
 */

/**
 * Serves one accepted socket for its whole life: attach it, keep it alive, and hand it its frames.
 *
 * The attach query is what makes a message reach both participants — the socket is registered under
 * the caller and under each meetup they may chat in — and a failure there closes the socket with
 * `1011` rather than leaving one open that no frame would ever reach (AAP 0.3.2, 0.5.1).
 */
async function serveSocket(
  services: ChatServices,
  socket: WebSocket,
  request: FastifyRequest,
): Promise<void> {
  const userId = request.auth?.userId;

  // `requireWebSocketBearer` admitted this upgrade, so a missing context is impossible; reading it
  // rather than asserting it keeps a hook that were moved or shadowed from surfacing as a socket
  // nobody answers (the same choice `modules/cities/routes.ts` makes on its own handler).
  if (userId === undefined) {
    socket.close(WS_CLOSE.unauthorized, 'token_invalid');
    return;
  }

  const connection: ChatConnection = {
    services,
    socket,
    userId,
    log: request.log,
    send: (frame) => sendFrame(socket, frame, request.log),
    sendTimes: [],
    chain: Promise.resolve(),
  };

  try {
    const meetupIds = await messageableMeetupIds(services.db, userId);
    services.pubsub.attach(socket, userId, meetupIds);
  } catch (error) {
    request.log.warn(
      { event: 'chat_attach_failed', err: { name: errorName(error) } },
      'chat_attach_failed',
    );
    socket.close(CLOSE_INTERNAL_ERROR, 'internal_error');
    return;
  }

  /** Whether the ping sent last is still unanswered. */
  let answered = true;

  const heartbeat = setInterval(() => {
    if (!answered) {
      // A socket that stopped answering is gone without having closed — a dropped mobile connection
      // leaves no FIN — and it still holds a registration and a timer, so it is terminated here.
      socket.terminate();
      return;
    }

    answered = false;
    socket.ping();
  }, CHAT_HEARTBEAT_MS);

  socket.on('pong', () => {
    answered = true;
  });

  const stop = (): void => {
    clearInterval(heartbeat);
    services.pubsub.detach(socket);
  };

  socket.on('close', stop);
  socket.on('error', stop);

  socket.on('message', (data, isBinary) => {
    connection.chain = connection.chain.then(() => receiveFrame(connection, data, isBinary));
  });
}

/*
 * The route (AAP 0.3.3, 0.5.4)
 */

/**
 * Registers `WS /v1/chat` on the messaging context `routes.ts` composes (AAP 0.5.1, 0.5.4).
 *
 * Synchronous registration with a resolved promise, the shape every route module of
 * `apps/api/src/modules` uses (`citiesRoutes`, `analyticsRoutes`): Fastify accepts the returned
 * thenable as the plugin's own completion, so `app.register(chatWsRoutes)` and a direct call both
 * compose, and nothing here needs to await.
 *
 * @param app - the messaging context. Its services carry the guarded database client, the injected
 *   clock, the logger and outbox the transaction helper needs, and the pub/sub fan-out; its
 *   encapsulation gives the route the module's `/v1` prefix and nothing else's hooks.
 */
export function chatWsRoutes(app: App): Promise<void> {
  app.get(
    CHAT_PATH,
    {
      websocket: true,
      // A frame protocol OpenAPI cannot describe: the route stays out of `docs/api/openapi.json`,
      // whose WebSocket frames are documented from `packages/shared/src/schemas/ws.ts` (AAP 0.5.4).
      schema: { hide: true },
      // The token travels as the `bearer, <token>` subprotocol, because a browser cannot set an
      // `Authorization` header on a WebSocket; a refusal is plain HTTP before the upgrade
      // (AAP 0.3.3). The traveler guard is not used here for that reason.
      onRequest: requireWebSocketBearer,
    },
    (socket, request) => serveSocket(app.services, socket, request),
  );

  return Promise.resolve();
}

export default chatWsRoutes;
