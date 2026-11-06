/**
 * Chat and meetup-status WebSocket frames (AAP 0.3.3, AAP 0.5.3, AAP 0.5.4, AAP 0.8.1): the one
 * frame a client sends on `WS /v1/chat` and the three the API can answer with.
 *
 * `Message` is declared once, in `./messaging.ts`, and imported here rather than restated, so the
 * chat socket and `GET /meetups/:id/messages` can never disagree about a message's shape
 * (AAP 0.11.1).
 *
 * The two directions carry deliberately different contracts:
 * - A client frame is a `z.strictObject`, so a key the API does not act on is refused instead of
 *   quietly ignored. Its discriminant is optional on the wire: AAP 0.5.4 states the client's chat
 *   frame as `{ meetupId, body }`, while the app sends the same frame with `type: 'chat_send'`, and
 *   one schema describes both — a frame that omits the discriminant is one chat send, and a frame
 *   carrying any other `type` is refused exactly like any other unknown key (AAP 0.11.1).
 * - A server frame is a strip-mode `z.object` with a required discriminant, so a field a newer API
 *   adds never breaks an older client that parses the frame.
 *
 * Access is decided before any frame is exchanged. The socket answers `403 messaging_locked` when
 * the pair has neither a locked nor a completed meetup, and `403 blocked` when a block exists in
 * either direction (AAP 0.5.4). Every chat write then re-resolves the session the socket was admitted
 * with and runs behind the account-deletion write fence, so a message sent after `DELETE /me`, or
 * after the session was revoked by a logout or rotated away, is answered with an {@link ErrorFrame}
 * carrying `token_invalid` and is never stored (AAP 0.5.3).
 *
 * Client-safe: `zod` and four sibling modules only — no Node built-in, no DOM global, no top-level
 * side effect — because the same module loads under Hermes, in a browser and in the API.
 */

import { z } from 'zod';

import { MESSAGE_MAX_CHARS } from '../constants.ts';
import { HoldView, MeetupStatus } from '../enums.ts';
import { ErrorCode } from '../errors.ts';
import { Uuid } from './common.ts';
import { Message } from './messaging.ts';

/*
 * Connection.
 */

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
 *
 * Channel names keep `:`; only BullMQ job ids use `-` as their separator (AAP 0.3.2).
 */
export function chatChannel(meetupId: string): string {
  return `chat:${meetupId}`;
}

/**
 * The Redis pub/sub channel carrying one user's own pushes (AAP 0.5.1): meetup-status frames for
 * every meetup they are part of, and the account-deletion invalidation published when `DELETE /me`
 * commits, which every API instance uses to drop its cached session entries and close that user's
 * sockets (AAP 0.5.3).
 *
 * Channel names keep `:` (AAP 0.3.2).
 */
export function userChannel(userId: string): string {
  return `user:${userId}`;
}

/*
 * Client frames — strict, because every field is one the API acts on.
 */

/**
 * The only frame a client sends: one chat message for a meetup (AAP 0.5.4, `ChatSend`).
 *
 * AAP 0.5.4 states the frame as the two fields a client has to know, `{ meetupId, body }`. The
 * discriminant is this module's own, because {@link ClientFrame} is one union over every frame shape
 * a client may send (AAP 0.11.1), so it is optional on the wire and filled in here: a frame that
 * omits `type` is one chat send, and every parsed value carries `type: 'chat_send'`. The object stays
 * strict, so an unknown key is still refused and `'chat_send'` stays the only accepted value of
 * `type`.
 *
 * `body` is trimmed first and then held to 1 to {@link MESSAGE_MAX_CHARS} (1,000) characters, so a
 * whitespace-only message is refused like an empty one. The API checks access before storing it:
 * the sender must be a participant of a `locked` or `completed` meetup with no block in either
 * direction, and the write runs behind the deletion write fence (AAP 0.5.3).
 */
export const ChatSend = z.strictObject({
  type: z.literal('chat_send').default('chat_send'),
  meetupId: Uuid,
  body: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
});
export type ChatSend = z.infer<typeof ChatSend>;

/**
 * Every frame a client may send on the chat socket, discriminated on `type` (AAP 0.11.1). The
 * discriminant is required on each {@link ServerFrame} and optional on a client frame, where
 * {@link ChatSend} fills it in, so both the AAP's `{ meetupId, body }` frame and the app's
 * `{ type: 'chat_send', meetupId, body }` frame are accepted on the wire. A frame that is not a
 * {@link ChatSend} — one carrying an unknown key included — is answered with an {@link ErrorFrame}
 * carrying `invalid_field` (AAP 0.5.4).
 */
export const ClientFrame = z.discriminatedUnion('type', [ChatSend]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/*
 * Server frames — strip-mode, so an added field is dropped rather than fatal on an older client.
 */

/**
 * One stored message, pushed to both participants' sockets over `chat:<meetupId>` as soon as it is
 * committed (AAP 0.5.4).
 */
export const MessageFrame = z.object({ type: z.literal('message'), message: Message });
export type MessageFrame = z.infer<typeof MessageFrame>;

/**
 * A meetup's status and the caller-visible hold state of both sides, pushed on every meetup
 * transition and every deposit change (AAP 0.5.3, AAP 0.5.4). It carries exactly what
 * `MeetupDto.initiatorHold` and `.recipientHold` carry, so the client treats it as a signal to
 * refetch `GET /meetups/:id` rather than as the authority on the meetup.
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
 * A refused client frame, mirroring the REST envelope's `{ code, message }` (AAP 0.5.4). Codes the
 * chat socket returns are `messaging_locked` and `blocked` for access, `invalid_field` for a frame
 * the {@link ClientFrame} schema rejects, `rate_limited` for a write over the per-user limit, and
 * `token_invalid` for a write attempted with a session that is no longer live — the account asked for
 * deletion, the session was revoked by a logout, or a rotation replaced it (AAP 0.3.2, AAP 0.5.3).
 *
 * `meetupId` is set when the refusal concerns a known meetup, so the client can show the error on
 * that meetup's screen.
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
