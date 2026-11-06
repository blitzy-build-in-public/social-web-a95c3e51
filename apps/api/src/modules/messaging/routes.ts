/**
 * The pair's message history, and the group that installs the chat socket beside it
 * (AAP 0.5.1, 0.5.4, 0.8.1).
 *
 * One route is declared here, `GET /meetups/:id/messages`, and one sibling module's group is
 * installed next to it: `WS /chat`, which `./chat-ws.ts` owns. The two are registered as sibling
 * encapsulated contexts rather than on this plugin's own instance, because their guards differ and a
 * hook added to an instance covers that instance's routes *and its children's* (AAP 0.5.4):
 *
 *  - The history route carries {@link requireTraveler}: the access token from `Authorization`, plus
 *    the age gate, which answers `403 age_gate_required` until the 18+ confirmation and the terms
 *    version are recorded. It is a plain read of the caller's own pair, so it is deliberately not
 *    rate-limited: AAP 0.5.4 limits the mutating routes and the two state-writing reads, and this is
 *    neither.
 *  - The socket carries `requireWebSocketBearer`, which `./chat-ws.ts` installs on its own route. A
 *    browser cannot set an `Authorization` header on a `WebSocket`, so its token arrives in the
 *    `Sec-WebSocket-Protocol` header, and the traveler guard — which reads `Authorization` — must
 *    never be placed over it.
 *
 * The decision itself belongs to `requireMessaging` in `./access.ts`, and it is asked in the
 * contract's order (AAP 0.5.4): `not_participant` for a meetup the caller is not on — an unknown id
 * and a proposal the recipient cannot see yet both answer this, so the route cannot be used to probe
 * whether a proposal exists — then `messaging_locked` while the pair has no locked or completed
 * meetup or the counterpart's account is gone, then `blocked` for a block in either direction. That
 * rule is a property of the pair rather than of the meetup the caller happened to open, which is what
 * keeps this route, the socket and every send in agreement.
 *
 * The read has one effect beyond the page it answers: it subscribes the caller's own open sockets to
 * that meetup's live frames, because reading the history is the client's "I opened this chat" and the
 * set a socket attached with as it opened is bounded to the newest meetups the user may message in
 * (AAP 0.5.1, 0.5.4). The subscription is raise-only and never refuses the read.
 *
 * Paging is keyset on `(created_at, id)`, newest first, with `PAGE_SIZE + 1` rows read so the
 * presence of another page costs no second count. The cursor carries the boundary row's instant
 * exactly as the statement rendered it, at microsecond precision, not the millisecond `Date` the row
 * round-trips as: `message."created_at"` is `timestamptz(6)`, and a truncated bound would both repeat
 * the row the page ended on and skip the rows that share its instant.
 *
 * No message body reaches a log line. Nothing here logs at all: a refusal is recorded once, by
 * `plugins/auth.ts`, as the bare fact that a request was rejected, and a stored message is announced
 * by the socket that stored it, not by this file (AAP 0.11.1).
 *
 * @see AAP 0.5.2 for the `Message` model and what erasure leaves behind, 0.5.3 for the lock that
 *   opens messaging, 0.5.4 for the route, its schema and its errors, 0.11.1 for the logging rules,
 *   and 0.8.1 for this file.
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

// Type-only, so this module holds no run-time edge back to the instance it is installed on: `App` is
// the plan's one declaration of the app's context (AAP 0.5.1), it is erased at compile time, and
// nothing of `app.ts` is read here at runtime. That absence of an edge is also what keeps the
// bootstrap free to import this plugin.
import type { App } from '../../app.ts';

/*
 * Constants (AAP 0.5.4)
 */

/** The tag the history route groups under: a member of the document's own vocabulary (AAP 0.11.2). */
const MESSAGING_TAG = 'messaging' satisfies OpenApiTag;

/*
 * Types (AAP 0.5.2, 0.5.4)
 */

/**
 * One row of the history statement: the message a DTO is built from, plus what paging needs.
 *
 * Column aliases are quoted camelCase in the statement, so Prisma returns the names written here;
 * the ids and the cursor instant are rendered as `text` in SQL, so nothing there depends on how the
 * driver maps `uuid`, and `created_at` comes back as the `Date` the DTO formats. Extending
 * {@link MessageRow} is what lets the socket's own DTO builder serve this read, so the history and
 * the live frame can never disagree about a message (AAP 0.5.4).
 */
interface MessageHistoryRow extends MessageRow {
  /** The row's `created_at` as {@link CURSOR_INSTANT_FORMAT} renders it, microseconds kept. */
  readonly createdAtKey: string;
  /**
   * Whether the sender's account is a tombstone, in which case the message is not tied to a live
   * sender and the DTO answers `senderId: null` (AAP 0.5.2).
   */
  readonly senderErased: boolean;
}

/**
 * Decodes a cursor this file issued, or refuses it as `400 invalid_field` (AAP 0.5.4).
 *
 * The wire form and the rules that read it are the shared codec's, `@tablemate/shared`'s
 * `KeysetCursorPosition` and `decodeKeysetCursor`, so this reader and the discovery and meetup readers
 * accept and refuse exactly the same values (AAP 0.11.1). The codec answers `null` because each reader
 * words its own refusal: this one keeps the contract's bare code, and a cursor is opaque, so nothing
 * about why one was refused is answered.
 *
 * @param cursor - The `cursor` query parameter, echoed back from a previous page.
 * @returns The position to continue after.
 * @throws AppError `invalid_field` for anything that is not a cursor this file wrote.
 */
function decodeCursor(cursor: string): KeysetCursorPosition {
  const position = decodeKeysetCursor(cursor);

  if (position === null) {
    throw new AppError('invalid_field');
  }

  return position;
}

/*
 * One page of history (AAP 0.5.4)
 */

/**
 * One page of a pair's message history, newest first (AAP 0.5.4).
 *
 * One parameterized statement reads the page and everything paging it needs: the messages, the
 * sender's erasure state, and the boundary row's instant at the column's own precision. The gate has
 * already admitted the caller, so this reads the meetup's messages and decides nothing itself.
 *
 * `PAGE_SIZE + 1` rows are read so the presence of another page is known without a second count, and
 * the cursor is taken from the rows rather than from the DTOs: a tombstoned sender's message is still
 * a row the next page must not repeat. The keyset comparison is a row comparison over
 * `(created_at, id)`, so the statement keeps reading backwards from the boundary row the
 * `(meetup_id, created_at)` index serves, and the id orders the rows that share an instant.
 *
 * The `LEFT JOIN` on the sender is defensive rather than expected: a `sender_id` always references a
 * `user` row, and account erasure deletes the messages the erased account wrote. A row whose sender
 * had no user row at all is therefore reported as erased rather than dropped from the pair's history.
 *
 * @param db - The guarded database client; `"user"` and `"message"` are quoted because PostgreSQL
 *   reserves the first as a keyword.
 * @param meetupId - The meetup whose conversation is being read.
 * @param cursor - The position to continue after, or `null` for the newest page.
 * @returns The page, and the cursor that continues it while rows remain.
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
 * The guard above admitted this request, so `request.auth` is set — but that is a property of the
 * registration, not of the handler: a hook that were moved, removed or shadowed would otherwise leave
 * a `TypeError` to be answered as `500 internal_error` where the contract requires `401
 * token_invalid`, and no compiler check would catch it (the same read `cities/routes.ts` and
 * `lodgings/routes.ts` make of their own contexts).
 *
 * @param request - The request the traveler guard admitted.
 * @returns The acting account's id.
 * @throws AppError `token_invalid` (401) when no context is present.
 */
function callerId(request: FastifyRequest): string {
  if (request.auth === null) {
    throw new AppError('token_invalid');
  }

  return request.auth.userId;
}

/*
 * The routes (AAP 0.5.4)
 */

/**
 * Registers `GET /meetups/:id/messages` and installs the chat socket `WS /chat` on the context
 * `app.ts` mounts under `/v1` (AAP 0.5.1, 0.5.4).
 *
 * Registration is synchronous, as in every plugin the composition root installs — `clock.ts`,
 * `security.ts`, `openapi.ts`, `auth.ts`, `rate-limit.ts`, `raw-body.ts`, `websocket.ts` and the
 * sibling route modules all return an already-resolved promise — and the declared `Promise<void>` is
 * what keeps this plugin usable wherever Fastify's own plugin type expects one.
 *
 * The two groups are registered as children of this context rather than on it: a hook added to this
 * instance would cover both, and the socket must not inherit the traveler guard, which reads a header
 * a browser cannot send (AAP 0.3.3, 0.5.4).
 *
 * @param app - The route instance; its `services` carry the guarded database client, which both the
 *   gate and this route's page are read through.
 * @see AAP 0.5.4 for the route, its schema, its errors and the guard's scope, 0.5.8 for the client
 *   screen that reads this page, and 0.8.1 for this file.
 */
export default function messagingRoutes(app: App): Promise<void> {
  // The history group. The guard is installed at route-group level, inside this encapsulated context,
  // so it covers this route and nothing else the API serves — never globally (AAP 0.5.4). The Zod
  // type provider is asked for explicitly because a sub-plugin's instance does not inherit the app's
  // through `register`: the call is a runtime no-op and is what types `request.params` and
  // `request.query` from the route's schemas rather than leaving them `unknown`.
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

        // The gate first, in the order AAP 0.5.4 lists its three refusals, and before a single
        // message of the pair's own conversation is read.
        await requireMessaging(app.services.db, meetupId, userId);

        // Opening the history is the client's "I opened this chat": the meetup joins the caller's open
        // sockets on every instance, so the pair's next message reaches them live even when the set
        // their socket attached with did not carry it (AAP 0.5.1, 0.5.4). It never throws and never
        // refuses the read.
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

  // The socket group: `WS /chat`, registered as a sibling context of this one, so the guard above
  // covers it in no way. Its upgrade authenticates from the `Sec-WebSocket-Protocol` header through
  // the hook `./chat-ws.ts` puts on that route itself, because a browser cannot set an
  // `Authorization` header on a `WebSocket` (AAP 0.3.3, 0.5.4). `chatWsRoutes` takes the app's own
  // context, which is the instance type this plugin is registered on, so Fastify hands it a
  // compatible one.
  app.register(chatWsRoutes);

  return Promise.resolve();
}
