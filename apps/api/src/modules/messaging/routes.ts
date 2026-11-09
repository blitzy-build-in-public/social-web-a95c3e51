/**
 * The pair's message history, and the group that installs the chat socket beside it.
 *
 * One route is declared here, `GET /meetups/:id/messages`, and one sibling module's group is installed next to it:
 * `WS /chat`, which `./chat-ws.ts` owns. The two are sibling encapsulated contexts rather than routes of one instance,
 * because their guards differ and a hook added to an instance covers its children's routes too: the history route
 * carries {@link requireTraveler} plus the age gate, and the socket carries `requireWebSocketBearer`, because a browser
 * cannot set an `Authorization` header on a `WebSocket` and its token arrives in the `Sec-WebSocket-Protocol` header.
 *
 * The decision itself belongs to `requireMessaging` in `./access.ts`, and it is asked in the contract's order:
 * `not_participant`, then `messaging_locked`, then `blocked`. It is a property of the pair rather than of the meetup
 * the caller opened, which is what keeps this route, the socket and every send in agreement.
 *
 * The read has one effect beyond the page it answers: it subscribes the caller's own open sockets to that meetup's
 * live frames, because reading the history is the client's I opened this chat, and the subscription is raise-only and
 * never refuses the read. No message body reaches a log line, and nothing here logs at all.
 */
import { Prisma, type DbClient } from '@tablemate/db';
import {
  CURSOR_INSTANT_FORMAT,
  decodeKeysetCursor,
  encodeKeysetCursor,
  ErrorEnvelope,
  IdParams,
  MessageHistoryQuery,
  MessageHistoryResponse,
  PAGE_SIZE,
} from '@tablemate/shared';
import type { KeysetCursorPosition } from '@tablemate/shared';

import { requireTraveler } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { requireMessaging } from './access.ts';
import { chatWsRoutes, toMessageDto, type MessageRow } from './chat-ws.ts';

import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { App } from '../../app.ts';

/** The tag the history route groups under. */
const MESSAGING_TAG = 'messaging' satisfies OpenApiTag;

/**
 * One row of the history statement: the message a DTO is built from, plus what paging needs. Column aliases are quoted
 * camelCase in the statement, and the ids and cursor instant are rendered as `text` in SQL, so nothing here depends on
 * how the driver maps `uuid`. Extending {@link MessageRow} is what lets the socket's own DTO builder serve this read, so
 * the history and the live frame cannot disagree about a message.
 */
interface MessageHistoryRow extends MessageRow {
  /** The row's `created_at` as {@link CURSOR_INSTANT_FORMAT} renders it, microseconds kept. */
  readonly createdAtKey: string;
  /** Whether the sender's account is a tombstone: the DTO then answers `senderId: null`. */
  readonly senderErased: boolean;
}

/**
 * Decodes a cursor this file issued, or refuses it as `400 invalid_field`.
 *
 * The wire form and the rules that read it are the shared codec's, `@tablemate/shared`'s `KeysetCursorPosition` and
 * `decodeKeysetCursor`, so this reader and the discovery and meetup readers accept and refuse exactly the same values.
 * The codec answers `null` because each reader words its own refusal: this one keeps the contract's bare code, and a
 * cursor is opaque, so nothing about why one was refused is answered.
 */
function decodeCursor(cursor: string): KeysetCursorPosition {
  const position = decodeKeysetCursor(cursor);
  if (position === null) {
    throw new AppError('invalid_field');
  }
  return position;
}

/**
 * One page of a pair's message history, newest first.
 *
 * One parameterized statement reads the page and everything paging it needs: the messages, the sender's erasure state,
 * and the boundary row's instant at the column's own precision. `PAGE_SIZE + 1` rows are read so the presence of
 * another page is known without a second count, and the cursor is taken from the rows rather than the DTOs, because a
 * tombstoned sender's message is still a row the next page must not repeat. The keyset comparison is a row comparison
 * over `(created_at, id)`, which the `(meetup_id, created_at)` index serves, and the `LEFT JOIN` on the sender is
 * defensive: a row with no user row is reported as erased rather than dropped.
 */
async function listMessages(
  db: DbClient,
  meetupId: string,
  cursor: KeysetCursorPosition | null,
): Promise<MessageHistoryResponse> {
  const cursorPredicate =
    cursor === null
      ? Prisma.empty
      : Prisma.sql`AND (m."created_at", m."id") < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
  const rows = await db.$queryRaw<MessageHistoryRow[]>(Prisma.sql`
    SELECT
      m."id"::text AS "id",
      m."meetup_id"::text AS "meetupId",
      m."sender_id"::text AS "senderId",
      m."body" AS "body",
      m."created_at" AS "createdAt",
      to_char(m."created_at" AT TIME ZONE 'UTC', ${CURSOR_INSTANT_FORMAT}) AS "createdAtKey",
      (u."id" IS NULL OR u."deleted_at" IS NOT NULL) AS "senderErased"
    FROM "message" m
    LEFT JOIN "user" u ON u."id" = m."sender_id"
    WHERE m."meetup_id" = ${meetupId}::uuid
    ${cursorPredicate}
    ORDER BY m."created_at" DESC, m."id" DESC
    LIMIT ${PAGE_SIZE + 1}
  `);
  const page = rows.slice(0, PAGE_SIZE);
  const boundary = page[page.length - 1];
  return {
    items: page.map((row) => toMessageDto(row, row.senderErased)),
    nextCursor:
      rows.length > PAGE_SIZE && boundary !== undefined
        ? encodeKeysetCursor({ createdAt: boundary.createdAtKey, id: boundary.id })
        : null,
  };
}

/**
 * The authenticated caller's id, or a refusal.
 *
 * The guard above admitted this request, so `request.auth` is set — but that is a property of the registration, not of
 * the handler: a hook that were moved, removed or shadowed would otherwise leave a `TypeError` to be answered as `500`
 * where the contract requires `401 token_invalid`, and no compiler check would catch it (the same read
 * `cities/routes.ts` and `lodgings/routes.ts` make of their own contexts).
 */
function callerId(request: FastifyRequest): string {
  if (request.auth === null) {
    throw new AppError('token_invalid');
  }
  return request.auth.userId;
}

/**
 * Registers `GET /meetups/:id/messages` and installs the chat socket `WS /chat` on the context `app.ts` mounts under
 * `/v1`. Registration is synchronous, and the two groups are children of this context rather than routes on it: a hook
 * added to this instance would cover both, and the socket must not inherit the traveler guard, which reads a header a
 * browser cannot send.
 */
export default function messagingRoutes(app: App): Promise<void> {
  // The history group. The guard is installed at route-group level, inside this encapsulated context, so
  // it covers this route and nothing else the API serves. The Zod type provider is asked for explicitly
  // because a sub-plugin's instance does not inherit the app's through `register`; it is a runtime no-op
  // and is what types `request.params` and `request.query` from the route's schemas.
  app.register((instance) => {
    const traveler = instance.withTypeProvider<ZodTypeProvider>();
    traveler.addHook('onRequest', requireTraveler);
    traveler.get(
      '/meetups/:id/messages',
      {
        schema: {
          tags: [MESSAGING_TAG],
          security: OPENAPI_SECURITY.bearer,
          params: IdParams,
          querystring: MessageHistoryQuery,
          response: {
            200: MessageHistoryResponse,
            400: ErrorEnvelope,
            401: ErrorEnvelope,
            403: ErrorEnvelope,
          },
        },
      },
      async (request) => {
        const userId = callerId(request);
        const meetupId = request.params.id;
        // The gate first, in the order the contract lists its three refusals, before any message is read.
        await requireMessaging(app.services.db, meetupId, userId);
        // Opening the history is the client's "I opened this chat": the meetup joins the caller's open
        // sockets on every instance, so the pair's next message reaches them live. It never refuses the read.
        await app.services.pubsub.openChat(userId, meetupId);
        const { cursor } = request.query;
        return listMessages(
          app.services.db,
          meetupId,
          cursor === undefined ? null : decodeCursor(cursor),
        );
      },
    );
  });
  // The socket group: `WS /chat`, a sibling context of this one, so the guard above covers it in no way. Its
  // upgrade authenticates from the `Sec-WebSocket-Protocol` header through the hook `./chat-ws.ts` puts on that
  // route itself, because a browser cannot set an `Authorization` header on a `WebSocket`. `chatWsRoutes` takes
  // the instance type this plugin is registered on, so Fastify hands it a compatible context.
  app.register(chatWsRoutes);
  return Promise.resolve();
}
