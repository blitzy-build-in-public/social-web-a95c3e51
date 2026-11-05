/**
 * WebSocket support for the API (AAP 0.3.3, 0.4.1, 0.5.1): the one registration of
 * `@fastify/websocket` 11.3.7 that both sockets are served by — the browser chat socket
 * `WS /v1/chat` and Twilio's ConversationRelay socket `WS /v1/webhooks/voice/relay` — plus the
 * subprotocol helper those routes and `plugins/auth.ts` share.
 *
 * A browser `WebSocket` cannot set an `Authorization` header, so the chat client opens the socket
 * as `new WebSocket(url, ['bearer', accessToken])` and the handshake answers with `bearer`: the
 * offered protocols are the only channel the token can travel on, and only the `bearer` entry may
 * ever be echoed back, never the token beside it (AAP 0.3.3). The token is read here and never
 * logged: neither this module nor `plugins/auth.ts` logs the header it came from, and Fastify's
 * request logging records only the method, url, host and IP (AAP 0.11.1).
 *
 * Authentication of an upgrade belongs to its route, not to this file: `@fastify/websocket`
 * dispatches an upgrade request through the Fastify router and hijacks the connection only inside
 * the route handler, so `onRequest`/`preValidation` hooks run first — `requireWebSocketBearer` in
 * `plugins/auth.ts` for chat, the Twilio signature check in
 * `modules/voice-agent/relay-ws.ts` for the relay — and a refusal is answered as plain HTTP
 * (401 `token_invalid`, 400 `bad_signature`, 503 while the relay is at capacity) on a connection
 * that is never upgraded.
 *
 * Side-effect free at import: registering the plugin is what opens the WebSocket server, so
 * importing this module in a script that never builds an app costs nothing.
 */

import websocket from '@fastify/websocket';

import { WS_BEARER_SUBPROTOCOL } from '@tablemate/shared';

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
 *   from `modules/messaging/pubsub.ts` (AAP 0.3.2, 0.5.3).
 * - `tooMany` (4429): the caller is over an allowance that ends the socket — the relay's
 *   `VOICE_RELAY_MAX_SESSIONS` cap of 10 concurrent sessions, or a chat socket whose per-minute
 *   message allowance is spent (AAP 0.3.2).
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
 * Registers the WebSocket server on the root app (AAP 0.5.1, registration step 6 of the
 * composition root), before any route is declared so every `{ websocket: true }` route in the
 * workspace is served by it.
 *
 * The registration is queued rather than awaited, which is how Fastify plugins compose: the
 * WebSocket server is created during `ready()`, and `app.register` returns the instance so the
 * caller keeps the synchronous `buildApp` contract. `errorHandler` and `preClose` stay at the
 * `@fastify/websocket` defaults, which log an established socket's error and close every client on
 * shutdown.
 */
export function registerWebsocket(app: App): void {
  app.register(websocket, {
    options: { maxPayload: WS_MAX_PAYLOAD_BYTES, handleProtocols },
  });
}
