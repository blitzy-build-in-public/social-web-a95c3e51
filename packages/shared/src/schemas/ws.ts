/**
 * Chat and meetup-status WebSocket frames (AAP 0.3.3, AAP 0.5.3, AAP 0.5.4, AAP 0.8.1): the one
 * frame a client sends on `WS /v1/chat` and the three the API can answer with. `Message` is
 * declared once, in `./messaging.ts`, and imported here, so the chat socket and `GET
 * /meetups/:id/messages` cannot disagree about a message's shape. A client frame is a
 * `z.strictObject` whose discriminant is optional on the wire — AAP 0.5.4 states it as `{ meetupId,
 * body }` while the app sends `type: 'chat_send'` — and a server frame is a strip-mode `z.object`
 * with a required discriminant. Every chat write re-resolves the session the socket was admitted
 * with behind the account-deletion write fence, so a message sent after `DELETE /me` is answered
 * with an `ErrorFrame` carrying `token_invalid` and is never stored.
 */

import { z } from 'zod';

import { MESSAGE_MAX_CHARS } from '../constants.ts';
import { HoldView, MeetupStatus } from '../enums.ts';
import { ErrorCode } from '../errors.ts';
import { Uuid } from './common.ts';
import { Message } from './messaging.ts';

/**
 * The first entry of the `Sec-WebSocket-Protocol` list a client offers when it opens the chat
 * socket. The client sends `['bearer', <accessToken>]`, the API validates the JWT from the second
 * entry and echoes this one back as the selected subprotocol, because a browser `WebSocket` cannot
 * set an `Authorization` header (AAP 0.3.3).
 */
export const WS_BEARER_SUBPROTOCOL = 'bearer' as const;

/**
 * The Redis pub/sub channel carrying one meetup's chat frames (AAP 0.5.1). Every API instance
 * subscribes while it holds a socket for the meetup and publishes each accepted message, so chat
 * fan-out works across API replicas.
 */
export function chatChannel(meetupId: string): string {
  return `chat:${meetupId}`;
}

/**
 * The Redis pub/sub channel carrying one user's own pushes (AAP 0.5.1): meetup-status frames and
 * the account-deletion invalidation published when `DELETE /me` commits, which every API instance
 * uses to drop its cached session entries and close that user's sockets (AAP 0.5.3).
 */
export function userChannel(userId: string): string {
  return `user:${userId}`;
}

/**
 * The only frame a client sends: one chat message for a meetup (AAP 0.5.4, `ChatSend`). The
 * discriminant is this module's own, because {@link ClientFrame} is one union over every frame
 * shape a client may send (AAP 0.11.1), so it is optional on the wire and filled in here: a frame
 * that omits `type` is one chat send, and every parsed value carries `type: 'chat_send'`.
 */
export const ChatSend = z.strictObject({
  type: z.literal('chat_send').default('chat_send'),
  meetupId: Uuid,
  body: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
});
export type ChatSend = z.infer<typeof ChatSend>;

/**
 * Every frame a client may send on the chat socket, discriminated on `type` (AAP 0.11.1). The
 * discriminant is required on each {@link ServerFrame} and optional on a client frame, where {@link
 * ChatSend} fills it in, so both the AAP's `{ meetupId, body }` frame and the app's `{ type:
 * 'chat_send', meetupId, body }` frame are accepted on the wire.
 */
export const ClientFrame = z.discriminatedUnion('type', [ChatSend]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/**
 * One stored message, pushed to both participants' sockets over `chat:<meetupId>` as soon as it is
 * committed (AAP 0.5.4).
 */
export const MessageFrame = z.object({ type: z.literal('message'), message: Message });
export type MessageFrame = z.infer<typeof MessageFrame>;

/**
 * A meetup's status and the caller-visible hold state of both sides, pushed on every meetup
 * transition and every deposit change (AAP 0.5.3, 0.5.4); it carries exactly what
 * `MeetupDto.initiatorHold` and `.recipientHold` carry, so a client treats it as a signal to
 * refetch rather than as the authority on the meetup.
 */
export const MeetupStatusFrame = z.object({
  type: z.literal('meetup_status'),
  meetupId: Uuid,
  status: MeetupStatus,
  initiatorHold: HoldView,
  recipientHold: HoldView,
});
export type MeetupStatusFrame = z.infer<typeof MeetupStatusFrame>;

/**
 * A refused client frame, mirroring the REST envelope's `{ code, message }` (AAP 0.5.4). Codes are
 * `messaging_locked` and `blocked` for access, `invalid_field` for a frame {@link ClientFrame}
 * rejects, `rate_limited` for a write over the per-user limit, and `token_invalid` for a write
 * attempted with a session that is no longer live (AAP 0.3.2, AAP 0.5.3).
 */
export const ErrorFrame = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string(),
  meetupId: Uuid.optional(),
});
export type ErrorFrame = z.infer<typeof ErrorFrame>;

/**
 * Every frame the API may send on the chat socket, discriminated on `type`: a stored message, a
 * meetup-status push, or a refusal (AAP 0.5.4).
 */
export const ServerFrame = z.discriminatedUnion('type', [
  MessageFrame,
  MeetupStatusFrame,
  ErrorFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
