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
  ErrorEnvelope,
  IdParams,
  MessageHistoryQuery,
  MessageHistoryResponse,
  PAGE_SIZE,
  Uuid,
} from '@tablemate/shared';

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

/**
 * How the statement renders a cursor instant: UTC, ISO 8601, microseconds, `Z` suffix.
 *
 * The same rendering `cities/discovery.ts` writes, because both readers page over columns of the same
 * type — `timestamptz(6)` — for the same reason (AAP 0.5.4).
 */
const CURSOR_INSTANT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * The only instant form {@link decodeCursor} accepts: exactly what {@link CURSOR_INSTANT_FORMAT}
 * writes. Anything else would reach PostgreSQL as a bound `timestamptz` and could make it raise,
 * which would answer `500` for what is a malformed request.
 */
const CURSOR_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/*
 * Types (AAP 0.5.2, 0.5.4)
 */

/**
 * A keyset position: the last row of a page, as the statement wrote it back.
 *
 * `createdAt` is deliberately text rather than a `Date` — it carries the microseconds the column
 * stores, which a `Date` cannot (AAP 0.5.4).
 */
interface MessageCursor {
  /** The boundary row's `created_at`, in {@link CURSOR_INSTANT_FORMAT}. */
  readonly createdAt: string;
  /** The boundary row's id, the tie-breaker under the creation instant. */
  readonly id: string;
}

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

/*
 * The cursor (AAP 0.5.4)
 */

/**
 * Encodes a keyset position as the opaque cursor the client echoes back.
 *
 * The payload is a two-key JSON object, base64url-encoded, so it survives a query string unmangled
 * and stays well inside the contract's 200-character `Cursor`. Its shape is this file's own: only
 * {@link decodeCursor} reads it.
 *
 * @param position - The instant and id of the page's last row, taken from the statement.
 * @returns The cursor for the page that continues where that row ended.
 */
function encodeCursor(position: MessageCursor): string {
  return Buffer.from(JSON.stringify({ t: position.createdAt, id: position.id }), 'utf8').toString(
    'base64url',
  );
}

/**
 * Decodes a cursor this file issued, or refuses it as `400 invalid_field` (AAP 0.5.4).
 *
 * A cursor is client-supplied text, so every step is checked rather than trusted: canonical
 * base64url, a JSON object inside it, an instant in exactly the form the statement writes, and a
 * UUID. `Buffer.from(…, 'base64url')` ignores what it cannot decode instead of throwing, which is why
 * the round trip is compared rather than the decode trusted (the shape
 * `meetups/queries.ts:decodeMeetupCursor` uses for the same reason). A cursor is opaque — a client
 * that edits one has no contract to break, only a request to lose — so nothing about why it was
 * refused is answered.
 *
 * @param cursor - The `cursor` query parameter, echoed back from a previous page.
 * @returns The position to continue after.
 * @throws AppError `invalid_field` for anything that is not a cursor this file wrote.
 */
function decodeCursor(cursor: string): MessageCursor {
  const malformed = (): AppError => new AppError('invalid_field');

  const decoded = Buffer.from(cursor, 'base64url');

  if (decoded.toString('base64url') !== cursor) {
    throw malformed();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded.toString('utf8')) as unknown;
  } catch {
    throw malformed();
  }

  if (typeof payload !== 'object' || payload === null) {
    throw malformed();
  }

  const { t, id } = payload as { t?: unknown; id?: unknown };

  if (
    typeof t !== 'string' ||
    typeof id !== 'string' ||
    !Uuid.safeParse(id).success ||
    !isStatementInstant(t)
  ) {
    throw malformed();
  }

  return { createdAt: t, id };
}

/**
 * Whether `text` is an instant this file's statement wrote: the exact form of
 * {@link CURSOR_INSTANT_FORMAT}, and a real UTC instant rather than a merely well-formed one.
 *
 * `2026-02-30T00:00:00.000000Z` matches the pattern and is a timestamp PostgreSQL refuses, so the
 * instant is rebuilt from its own fields and every field is read back: an overflowing field carries
 * into a larger one, so the field that overflowed no longer matches what it was given. A trailing
 * second of 60 (a real leap second in UTC) is refused as well, because the statement never writes one.
 *
 * @param text - The instant from a decoded cursor.
 * @returns True when the statement could have written this instant.
 */
function isStatementInstant(text: string): boolean {
  const match = CURSOR_INSTANT_RE.exec(text);

  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  return (
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second
  );
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
  cursor: MessageCursor | null,
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
        ? encodeCursor({ createdAt: boundary.createdAtKey, id: boundary.id })
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
