/**
 * WebSocket support for the API (AAP 0.3.3, 0.4.1, 0.5.1): the one registration of `@fastify/websocket` that both
 * sockets are served by — the browser chat socket `WS /v1/chat` and Twilio's ConversationRelay socket
 * `WS /v1/webhooks/voice/relay` — plus the subprotocol helper those routes and `plugins/auth.ts` share.
 *
 * A browser `WebSocket` cannot set an `Authorization` header, so the chat client opens the socket as
 * `new WebSocket(url, ['bearer', accessToken])` and the handshake answers with `bearer`: the offered protocols
 * are the only channel the token can travel on, and only the `bearer` entry may ever be echoed back, never the
 * token beside it (AAP 0.3.3). The token is read here and never logged: neither this module nor `plugins/auth.ts`
 * logs the header it came from (AAP 0.11.1). An error raised while a socket is open is reported as a code and the
 * error's name alone, never the error object, whose message and stack key-based redaction cannot rewrite
 * (AAP 0.3.2).
 *
 * Authentication of an upgrade belongs to its route, not to this file: `@fastify/websocket` hijacks the
 * connection only inside the route handler, so the route's `onRequest`/`preValidation` hooks run first and a
 * refusal is answered as plain HTTP on a connection that is never upgraded. Side-effect free at import:
 * registering the plugin is what opens the WebSocket server.
 */
import websocket from '@fastify/websocket';

import { WS_BEARER_SUBPROTOCOL } from '@tablemate/shared';

import type { WebsocketPluginOptions } from '@fastify/websocket';

import type { App } from '../app.ts';

/**
 * Close codes the API sends on its own application-level refusals, in the 4000-4999 range
 * WebSocket reserves for applications (RFC 6455 §7.4.2). Each one is used where the socket cannot
 * continue:
 *
 * - `unauthorized` (4401): the token was rejected after the upgrade, or a write was attempted
 *   after `DELETE /me` committed and the account-deletion write fence answered
 *   `401 token_invalid` (AAP 0.5.3).
 * - `forbidden` (4403): the caller lost access to what the socket carries — messaging is not open
 *   for the pair (`messaging_locked`) or a block exists in either direction (`blocked`), or a
 *   voice relay could not be attached to its call attempt (AAP 0.5.4, 0.5.6).
 * - `invalidated` (4409): the session itself ended — `DELETE /me` or logout published
 *   `{ type: 'invalidate' }` on `user:<id>`, and every API instance closes that user's sockets
 *   from `modules/messaging/pubsub.ts` (AAP 0.3.2, 0.5.3). A frame that names its sessions closes
 *   the sockets those sessions were admitted with, which is what a logout publishes; one that names
 *   none closes every socket of the user, which is what an account that ended as a whole publishes.
 * - `tooMany` (4429): the caller is over an allowance that ends the socket — the
 *   `CHAT_MAX_SOCKETS_PER_USER` allowance of live chat sockets one account may hold on an API
 *   instance (AAP 0.3.2). The relay's `VOICE_RELAY_MAX_SESSIONS` cap is not this code: it refuses a
 *   further Twilio connection as plain HTTP `503 service_unavailable` before its upgrade, and a chat
 *   socket's own send allowance is answered in place, per the paragraph below.
 *
 * A refusal answered without closing the socket (the single over-limit chat frame, answered in
 * place with a `rate_limited` frame) is delivered as a frame instead.
 */
export const WS_CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  invalidated: 4409,
  tooMany: 4429,
} as const;

/** One of the {@link WS_CLOSE} codes. */
export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

/**
 * The characters a compact JWS may consist of: base64url segments joined by `.`. Checked before a
 * value taken from a header is treated as a token, so a handshake cannot hand the JWT verifier
 * arbitrary bytes; the signature and the claims are still what actually authenticate the caller.
 */
const BEARER_TOKEN_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Largest frame either socket accepts, in bytes (16 KiB, the `maxPayload` of the one WebSocket
 * server below). A larger frame makes `ws` close the connection itself, so an oversized payload is
 * refused before any handler sees it. The bound is far above the largest frame the API defines —
 * a 1,000-character chat message or a ConversationRelay prompt — and well below anything that
 * would let one socket hold API memory.
 */
const WS_MAX_PAYLOAD_BYTES = 16_384;

/**
 * Reads the access token a client offered as a subprotocol, from the raw
 * `Sec-WebSocket-Protocol` header of a handshake (AAP 0.3.3).
 *
 * The client sends `['bearer', accessToken]`, which arrives as the comma-separated list
 * `bearer, <accessToken>`: the entry `bearer` is located case-sensitively and the first non-empty
 * entry after it is the token. `null` is returned when the header is absent, when no `bearer`
 * entry is offered, when nothing follows it, or when what follows is not of the shape a JWT has —
 * so a caller can treat `null` as "no usable token" and answer `401 token_invalid` without
 * inspecting the header further. Never log the returned value or the header it came from.
 */
export function bearerTokenFromProtocolHeader(header: string | undefined): string | null {
  if (header === undefined) return null;
  const entries = header.split(',').map((entry) => entry.trim());
  const markerIndex = entries.indexOf(WS_BEARER_SUBPROTOCOL);
  if (markerIndex === -1) return null;
  const token = entries.slice(markerIndex + 1).find((entry) => entry.length > 0);
  if (token === undefined || !BEARER_TOKEN_RE.test(token)) return null;
  return token;
}

/**
 * Selects the subprotocol the handshake answers with: `bearer` when the client offered it,
 * otherwise `false`.
 *
 * The browser checks that the server selected one of the protocols it offered, so `bearer` has to
 * be echoed; the token entry must never be, which is why the selection is the fixed constant
 * rather than anything read from the request. Twilio's ConversationRelay offers no subprotocol at
 * all, in which case `ws` never calls this and the upgrade proceeds unselected — and a client that
 * offers only protocols the API does not know still gets a socket, which its route's own hook then
 * refuses for the missing bearer token.
 */
function handleProtocols(protocols: Set<string>): typeof WS_BEARER_SUBPROTOCOL | false {
  return protocols.has(WS_BEARER_SUBPROTOCOL) ? WS_BEARER_SUBPROTOCOL : false;
}

/**
 * The handler for an error raised on an established socket, typed from the plugin's own option type
 * so the signature is checked here rather than inherited from {@link App}.
 *
 * It logs a code and the error's name, never the error object and never its message: the plugin's
 * default handler calls `request.log.error(error)`, which promotes that message into the line's own
 * `msg`, where the key-based redaction list cannot reach (AAP 0.3.2, 0.11.1). The line still carries
 * the request id, because it is written through `request.log`. An arrow function, not a method: the
 * plugin calls the handler with the Fastify instance as `this`, and nothing here reads it.
 */
const reportSocketError: NonNullable<WebsocketPluginOptions['errorHandler']> = (
  error,
  socket,
  request,
) => {
  request.log.error({ code: 'internal_error', err: { name: error.name } }, 'websocket_error');
  // The default handler terminates the socket and the plugin itself only attaches the listener, so
  // dropping this would leave a socket whose error was reported still open.
  socket.terminate();
};

/**
 * Registers the WebSocket server on the root app (AAP 0.5.1, registration step 6 of the
 * composition root), before any route is declared so every `{ websocket: true }` route in the
 * workspace is served by it.
 *
 * The registration is queued rather than awaited, which is how Fastify plugins compose: the
 * WebSocket server is created during `ready()`, and `app.register` returns the instance so the
 * caller keeps the synchronous `buildApp` contract. `errorHandler` is set rather than left at its
 * default: the default hands the error object to pino and lets its message become the log line's
 * own message, where the key-based redaction list cannot reach, so an error on an established
 * socket is reported by {@link reportSocketError} as the error's name and a code and nothing else
 * (AAP 0.3.2, 0.11.1). `preClose` stays at the default, which closes every client on shutdown.
 */
export function registerWebsocket(app: App): void {
  app.register(websocket, {
    options: { maxPayload: WS_MAX_PAYLOAD_BYTES, handleProtocols },
    errorHandler: reportSocketError,
  });
}
