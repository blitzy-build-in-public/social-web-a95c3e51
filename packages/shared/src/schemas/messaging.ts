/**
 * Pair messaging contract (AAP 0.5.4, AAP 0.8.1): the `Message` DTO shared by the chat WebSocket
 * and the history route `GET /meetups/:id/messages`, with that route's query and response.
 * `Message` is declared here alone, and `./ws.ts` imports it from here along with the client's send
 * frame `ChatSend` (AAP 0.11.1). Messaging opens only once both deposits are locked, so the route
 * and the socket answer `403 messaging_locked` when the pair has neither a locked nor a completed
 * meetup, and `403 blocked` when a block exists in either direction (AAP 0.5.4). Message bodies are
 * redacted from logs (AAP 0.11.1).
 */
import { z } from 'zod';

import { MESSAGE_MAX_CHARS } from '../constants.ts';
import { Cursor, IsoDateTime, Uuid, paginated } from './common.ts';

/**
 * One chat message (AAP 0.5.2 `Message`), written over the chat socket and read back through the
 * pair's message history (AAP 0.5.4). `senderId` is nullable for a sender whose account was erased:
 * erasure deletes the messages the erased user wrote, so a retained message is not tied to a live
 * sender (AAP 0.5.2).
 */
export const Message = z.object({
  id: Uuid,
  meetupId: Uuid,
  senderId: Uuid.nullable(),
  body: z.string().max(MESSAGE_MAX_CHARS),
  createdAt: IsoDateTime,
});
export type Message = z.infer<typeof Message>;

/**
 * The query string of `GET /meetups/:id/messages`: newest-first keyset paging over (`createdAt`,
 * `id`), with `PAGE_SIZE` (20) items per page set by the handler (AAP 0.5.4).
 */
export const MessageHistoryQuery = z.strictObject({ cursor: Cursor.optional() });
export type MessageHistoryQuery = z.infer<typeof MessageHistoryQuery>;

/** One page of a pair's message history, newest first; `nextCursor` is `null` on the last page. */
export const MessageHistoryResponse = paginated(Message);
export type MessageHistoryResponse = z.infer<typeof MessageHistoryResponse>;
