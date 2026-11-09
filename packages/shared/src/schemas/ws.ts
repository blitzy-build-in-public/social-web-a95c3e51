/**
 * Chat and meetup-status WebSocket frames (AAP 0.8.1): the one frame a client sends on `WS /v1/chat` and the
 * three the API can answer with. `Message` is declared once, in `./messaging.ts`, and imported here, so the chat
 * socket and `GET /meetups/:id/messages` cannot disagree about a message's shape. A client frame is a
 * `z.strictObject` whose discriminant is optional on the wire — the contract states it as `{ meetupId, body }`
 * while the app sends `type: 'chat_send'` — and a server frame is a strip-mode `z.object` with a required
 * discriminant. Every chat write re-resolves the session the socket was admitted with behind the account-deletion
 * write fence, so a message sent after `DELETE /me` is answered with an `ErrorFrame` carrying `token_invalid` and
 * is never stored.
 */

import { z } from 'zod';

import { MESSAGE_MAX_CHARS } from '../constants.ts';
import { HoldView, MeetupStatus } from '../enums.ts';
import { ErrorCode } from '../errors.ts';
import { FreeText, Uuid } from './common.ts';
import { Message } from './messaging.ts';
/** The first entry of the `Sec-WebSocket-Protocol` list a client offers when it opens the chat socket. The client sends `['bearer', <accessToken>]`, the API validates the JWT from the second entry and echoes this one back as the selected subprotocol, because a browser `WebSocket` cannot set an `Authorization` header. */
export const WS_BEARER_SUBPROTOCOL = 'bearer' as const;

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
 *   from `apps/api/src/modules/messaging/pubsub.ts` (AAP 0.3.2, 0.5.3). A frame that names its
 *   sessions closes the sockets those sessions were admitted with, which is what a logout
 *   publishes; one that names none closes every socket of the user, which is what an account that
 *   ended as a whole publishes.
 * - `tooMany` (4429): the caller is over an allowance that ends the socket — the
 *   `CHAT_MAX_SOCKETS_PER_USER` allowance of live chat sockets one account may hold on an API
 *   instance (AAP 0.3.2). The relay's `VOICE_RELAY_MAX_SESSIONS` cap is not this code: it refuses
 *   a further Twilio connection as plain HTTP `503 service_unavailable` before its upgrade, and a
 *   chat socket's own send allowance is answered in place, per the paragraph below.
 *
 * Both sides read this one declaration — the API sends these codes and the app's socket client
 * branches on them (`apps/mobile/src/api/ws.ts`) — so a code added or renumbered here fails to
 * compile on the side that did not change, rather than silently diverging there.
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
 * The Redis pub/sub channel carrying one meetup's chat frames (AAP 0.5.1). Every API instance
 * subscribes while it holds a socket for the meetup and publishes each accepted message, so chat
 * fan-out works across API replicas.
 */
export function chatChannel(meetupId: string): string {
  return `chat:${meetupId}`;
}
/** The Redis pub/sub channel carrying one user's own pushes: meetup-status frames and the account-deletion invalidation published when `DELETE /me` commits, which every API instance uses to drop its cached session entries and close that user's sockets. */
export function userChannel(userId: string): string {
  return `user:${userId}`;
}
/** The only frame a client sends: one chat message for a meetup. The discriminant is this module's own, because {@link ClientFrame} is one union over every frame shape a client may send, so it is optional on the wire and filled in here: a frame that omits `type` is one chat send. */
export const ChatSend = z.strictObject({
  type: z.literal('chat_send').default('chat_send'),
  meetupId: Uuid,
  body: FreeText.trim().min(1).max(MESSAGE_MAX_CHARS),
});
export type ChatSend = z.infer<typeof ChatSend>;
/** Every frame a client may send on the chat socket, discriminated on `type`; the discriminant is optional on a client frame, where {@link ChatSend} fills it in, so both the contract's `{ meetupId, body }` frame and the app's `{ type: 'chat_send', meetupId, body }` frame are accepted on the wire. */
export const ClientFrame = z.discriminatedUnion('type', [ChatSend]);
export type ClientFrame = z.infer<typeof ClientFrame>;
/** One stored message, pushed to both participants' sockets over `chat:<meetupId>` as soon as it is committed. */
export const MessageFrame = z.object({ type: z.literal('message'), message: Message });
export type MessageFrame = z.infer<typeof MessageFrame>;
/** A meetup's status and the caller-visible hold state of both sides, pushed on every meetup transition and every deposit change; it carries exactly what `MeetupDto.initiatorHold` and `.recipientHold` carry, so a client treats it as a signal to refetch rather than as the authority on the meetup. */
export const MeetupStatusFrame = z.object({
  type: z.literal('meetup_status'),
  meetupId: Uuid,
  status: MeetupStatus,
  initiatorHold: HoldView,
  recipientHold: HoldView,
});
export type MeetupStatusFrame = z.infer<typeof MeetupStatusFrame>;
/** A refused client frame, mirroring the REST envelope's `{ code, message }`. Codes are `messaging_locked` and `blocked` for access, `invalid_field` for a frame {@link ClientFrame} rejects, `rate_limited` for a write over the per-user limit, and `token_invalid` for a write attempted with a session that is no longer live. */
export const ErrorFrame = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string(),
  meetupId: Uuid.optional(),
});
export type ErrorFrame = z.infer<typeof ErrorFrame>;
/** Every frame the API may send on the chat socket, discriminated on `type`: a stored message, a meetup-status push, or a refusal. */
export const ServerFrame = z.discriminatedUnion('type', [
  MessageFrame,
  MeetupStatusFrame,
  ErrorFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
