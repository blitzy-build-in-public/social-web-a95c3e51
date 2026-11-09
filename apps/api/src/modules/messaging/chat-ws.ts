/**
 * `WS /v1/chat`: the one socket the traveler app holds, carrying pair chat and the meetup-status pushes that
 * arrive beside it (AAP 0.3.3, 0.5.1, 0.5.3, 0.5.4, 0.8.1).
 *
 * A browser `WebSocket` cannot set an `Authorization` header, so the handshake authenticates with the
 * `Sec-WebSocket-Protocol: bearer, <accessToken>` subprotocol and the API answers with `bearer` alone (AAP 0.3.3).
 * `requireWebSocketBearer` reads the token there, applies the age gate as the REST traveler guard does, and runs
 * before `@fastify/websocket` hijacks the connection, so a refusal is answered as plain `401 token_invalid` on a
 * connection that is never upgraded. This route is deliberately not inside the traveler route group, whose guard
 * reads the header a browser cannot set.
 *
 * Five invariants hold for the life of an accepted socket:
 *
 *  - **Frames are processed one at a time, in order.** Every inbound frame's work is appended to a per-socket
 *    promise chain, so two messages from one sender commit in the order they were sent and a frame written the
 *    moment the handshake completed waits for the socket's meetup set instead of being lost. Each frame's handling
 *    turns every failure it can meet into a frame and resolves, since a rejected chain would stall the frames
 *    behind it.
 *  - **The access check runs inside the transaction that writes the message**, behind the account-deletion write
 *    fence (AAP 0.5.3): the session the upgrade authenticated with is re-resolved from PostgreSQL
 *    (`assertLiveSession`, never from the 30-second cache) and `canMessage` reads the block, the pair's lock and
 *    the counterpart's account, so a logout, revocation, block, settlement or deletion that committed first is
 *    visible and a refusal writes nothing.
 *  - **No Redis call runs inside the transaction.** The message is published to both participants after the
 *    commit, through `after`: Redis is never a condition of the write, and a publish that fails costs only the
 *    live frame, since the message is in the pair's history either way (AAP 0.3.2).
 *  - **Delivery is the pub/sub echo.** The sender's confirmation is the same `MessageFrame` the other participant
 *    receives, delivered by subscription rather than by this handler (AAP 0.5.4); the meetup joins the writer's own
 *    socket before that frame is published, so a chat beyond the attached set is live for its sender too.
 *  - **A socket is bounded and is always given up.** An account holds at most `CHAT_MAX_SOCKETS_PER_USER` live
 *    sockets on one instance, refused before they are attached rather than registered and then closed; sixty
 *    accepted sends per rolling minute per socket; a 30-second ping/pong heartbeat ends a socket that stopped
 *    answering; a close or an error stops the heartbeat and detaches it from the fan-out, whichever way the
 *    transport ends and whenever that lands — the release is registered before this module awaits anything on the
 *    socket's behalf, and a socket that can no longer carry a frame is never registered at all (AAP 0.3.2).
 *
 * Nothing here logs a message body, a token or a `Sec-WebSocket-Protocol` header: a refused frame writes no line,
 * a socket refused for the allowance writes the event and the allowance, an internal failure writes the event, the
 * meetup id and the error's name, and a stored message writes at most one debug line (AAP 0.11.1).
 */

import { CHAT_PATH, ClientFrame, MINUTE_MS, WS_CLOSE } from '@tablemate/shared';
import type { ChatSend, Message, ServerFrame } from '@tablemate/shared';

import { assertLiveSession, requireWebSocketBearer } from '../../plugins/auth.ts';
import { AppError, errorFrame, isAppError } from '../../plugins/errors.ts';
import { transact } from '../outbox/write.ts';
import { canMessage, messageableMeetupIds } from './access.ts';

import type { FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';

import type { AuthContext } from '../../plugins/auth.ts';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { App, AppServices } from '../../app.ts';

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
 * RFC 6455's "internal error": this file failed on a connection it had already accepted, so the
 * socket is closed rather than left open on a connection no attach has registered (AAP 0.3.2).
 */
const CLOSE_INTERNAL_ERROR = 1011;

/**
 * What this module needs from the app's services (AAP 0.5.1): a `Pick` narrowed to what a socket reads — the
 * guarded database client, the injected clock, the logger, the outbox, the pub/sub fan-out and the configuration
 * the account's socket allowance is read from — so test doubles stay small.
 */
type ChatServices = Pick<AppServices, 'db' | 'clock' | 'logger' | 'outbox' | 'pubsub' | 'env'>;

/**
 * One `Message` row, as the insert hands it back and as the pair's history loads it (AAP 0.5.2). `senderId` is
 * nullable here although `Message.senderId` is not: erasure leaves the counterpart's messages in their history, so
 * a retained row may name a sender whose account is gone, and the history route nulls it in the DTO. Declared
 * structurally, so the one DTO builder serves every caller of either shape.
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
  /**
   * The session that upgrade was authenticated with, carried for the life of the socket so every
   * write can re-resolve it inside its own transaction (AAP 0.5.3).
   */
  readonly sessionId: string;
  /** The request's own logger, which already carries the request id (AAP 0.11.1). */
  readonly log: FastifyRequest['log'];
  /** Writes one server frame to this socket, when it is still open. */
  readonly send: (frame: ServerFrame) => void;
  /** Epoch milliseconds of the sends accepted inside the current rolling minute, oldest first. */
  readonly sendTimes: number[];
  /** The tail of this socket's frame chain, which the next frame's work is appended to. */
  chain: Promise<void>;
}

/**
 * One stored message as the contract's `Message` (AAP 0.5.4).
 *
 * Built field by field rather than spread, so no column the model grows can reach a client through
 * this shape, and shared with `GET /meetups/:id/messages`, so the socket and the history route can
 * never disagree about a message (AAP 0.5.4, 0.11.1).
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

/**
 * Stores one chat message and announces it to both participants (AAP 0.5.3, 0.5.4).
 *
 * The access check, the sender's re-resolved session and the insert share one transaction behind the sender's
 * write fence, so a logout, revocation, block or deletion that committed first is refused with nothing written. The
 * meetup joins the writer's own socket through that transaction's commit chain, ahead of the publish, so the frame
 * confirming the write is not also the moment the socket first carries the chat (AAP 0.5.1). The publish is
 * registered through `after` and runs after the commit (AAP 0.3.2).
 */
async function persistMessage(
  services: ChatServices,
  senderId: string,
  sessionId: string,
  frame: ChatSend,
): Promise<void> {
  await transact(
    services,
    async (tx, after) => {
      // Before the message is judged and before anything is written: the socket holds the authority
      // it was admitted with, so a logout, a rotation or a deletion that committed since then refuses
      // the frame here. Read from PostgreSQL, never from the session cache, which may lag a
      // revocation by up to its 30-second life (AAP 0.5.3).
      await assertLiveSession(services, tx, { userId: senderId, sessionId });
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
      // The socket that just wrote in this meetup carries it from now on, on this instance: a send is
      // the client's own use of the chat, and it is what makes a meetup outside the set that socket
      // attached with live for the sender (AAP 0.5.1, 0.5.4). Registered before the publish below,
      // because delivery is the subscription's: the frame coming back is what confirms the write, so
      // the registration has to exist before the frame is announced. The attach is in process and runs
      // after the commit, so no Redis call joins the transaction (AAP 0.3.2).
      after(() => {
        services.pubsub.attachMeetup(senderId, frame.meetupId);
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
      // The session is not live — the write fence saw a `DELETE /me` commit first, or the session
      // the socket was admitted with was revoked or rotated away — so the socket cannot continue.
      // The frame is answered before the close, so a client that never observes the close code still
      // learns why the message was not stored (AAP 0.5.3).
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
    await persistMessage(connection.services, connection.userId, connection.sessionId, frame);
    connection.log.debug(
      { event: 'chat_message_sent', meetupId: frame.meetupId },
      'chat_message_sent',
    );
  } catch (error) {
    refuseSend(connection, frame, error);
  }
}

/**
 * Serves one accepted socket for its whole life: admit it, attach it, keep it alive, and hand it its
 * frames.
 *
 * The attach query is what makes a message reach both participants — the socket is registered under the caller,
 * under the session the upgrade carried and under each meetup they may chat in — and a failure there closes the
 * socket with `1011` rather than leaving one open that no frame would ever reach (AAP 0.3.2, 0.5.1).
 *
 * The account's socket allowance is decided inside that attach (AAP 0.3.2): a socket the account has no allowance
 * left for is refused before it is attached, so nothing about it enters the registry and it never reaches
 * `pubsub.detach`, by closing it with `WS_CLOSE.tooMany` (4429) after one line naming the event and the allowance.
 * A socket whose transport ended before that point is not registered at all, so a connection that dies during its
 * own setup leaves nothing of itself behind for the allowance to count (AAP 0.3.2, 0.5.4).
 */
async function serveSocket(
  services: ChatServices,
  socket: WebSocket,
  request: FastifyRequest,
): Promise<void> {
  const auth: AuthContext | null | undefined = request.auth;
  // `requireWebSocketBearer` admitted this upgrade, so a missing context is impossible; reading it
  // rather than asserting it keeps a hook that were moved or shadowed from surfacing as a socket
  // nobody answers (the same choice `modules/cities/routes.ts` makes on its own handler). The session
  // travels with the socket, because every write is re-checked against it (AAP 0.5.3).
  if (auth === null || auth === undefined) {
    socket.close(WS_CLOSE.unauthorized, 'token_invalid');
    return;
  }
  const userId = auth.userId;
  const connection: ChatConnection = {
    services,
    socket,
    userId,
    sessionId: auth.sessionId,
    log: request.log,
    send: (frame) => sendFrame(socket, frame, request.log),
    sendTimes: [],
    chain: Promise.resolve(),
  };
  /**
   * Resolved once the socket carries its meetups, and never before.
   *
   * The listener below is attached before the first `await`, because `ws` emits `message` whether or not anything
   * is listening: both clients send as soon as the socket is open, with no readiness step, so a frame written
   * during the handshake would otherwise be dropped in the window the meetup set is read in. Every frame's work
   * waits on this gate, so the frames still run in the order they were sent. An attach that fails closes the socket
   * and leaves the gate unresolved: nothing queued behind it runs.
   */
  let attached: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    attached = resolve;
  });
  socket.on('message', (data, isBinary) => {
    connection.chain = connection.chain
      .then(() => ready)
      .then(() => receiveFrame(connection, data, isBinary));
  });
  /**
   * The heartbeat, its `pong` listener and the handlers that end the socket, registered before the first `await`.
   *
   * The order is the invariant (AAP 0.3.2): `ws` emits `close` exactly once and a transport can end at any moment,
   * the window of the query below included. A handler attached after that emit never runs, so everything the socket
   * registered would stay counted against the account's allowance for the life of the instance, and the heartbeat
   * meant to end it would ping a socket that can no longer answer — a send `ws` discards in silence rather than one
   * that errors. Attached here, a close or an error that lands anywhere in this handler's life is answered by
   * `detach`, and no interval can be created after the close that should have cleared it. `answered` is whether the
   * ping sent last is still unanswered.
   */
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
  try {
    const meetupIds = await messageableMeetupIds(services.db, userId);
    // The transport may have ended inside that query, in which case `stop` has already run: nothing was
    // registered, so there is nothing to release and nothing to report, and a socket that can no longer
    // carry a frame is never registered. The check is here rather than inside the attach, whose refusal
    // keeps its own single meaning — the account is over its allowance — so the newest socket is still
    // the one refused, and a readiness check there would answer `false` to a question nobody asked.
    if (socket.readyState !== socket.OPEN) return;
    const registered = services.pubsub.attach(socket, userId, connection.sessionId, meetupIds);
    if (!registered) {
      // The account already holds its allowance of live sockets on this instance, so this socket is
      // refused instead of registered and closed: the newest one goes, which leaves the socket the
      // account is already chatting on working (AAP 0.3.2). One line, carrying the event and the
      // allowance it was measured against and nothing of the account, the session or the socket
      // (AAP 0.11.1).
      request.log.warn(
        { event: 'chat_socket_cap', allowance: services.env.CHAT_MAX_SOCKETS_PER_USER },
        'chat_socket_cap',
      );
      socket.close(WS_CLOSE.tooMany, 'too_many_sockets');
      return;
    }
    attached();
  } catch (error) {
    request.log.warn(
      { event: 'chat_attach_failed', err: { name: errorName(error) } },
      'chat_attach_failed',
    );
    socket.close(CLOSE_INTERNAL_ERROR, 'internal_error');
  }
}

/**
 * Registers `WS /v1/chat` on the messaging context `routes.ts` composes (AAP 0.5.1, 0.5.4).
 *
 * Synchronous registration with a resolved promise, the shape every route module uses: Fastify accepts the returned
 * thenable as the plugin's own completion, so `app.register(chatWsRoutes)` and a direct call both compose.
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
