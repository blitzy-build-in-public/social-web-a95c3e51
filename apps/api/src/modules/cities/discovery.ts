/**
 * Traveler discovery for one city: the keyset-paginated page of travelers a viewer may see
 * (AAP 0.5.1, 0.5.4, 0.5.7).
 *
 * AAP 0.5.7 "Proof validity and discovery" is the rule here. Discovery for city X lists the users
 * holding a valid proof for X at the instant the caller passes — a proof is valid from two local days
 * before its arrival through the last instant of its departure day in the city's own zone, both
 * stored on the row by `proofValidity` (`proofs/validity.ts`) — and excludes the caller and every
 * block in either direction. A user with no valid proof appears only to a viewer who already
 * completed a meetup with them, and then only in the city of that user's most recent proof, "the
 * only city such a pair can share" (AAP 0.5.7, 0.7.3). A user with no proof at all appears in
 * neither set.
 *
 * Two candidate sets, one statement. The verified set is keyed by each user's latest proof valid for
 * this city, and its `city_id = … AND valid_to >= …` predicate is the shape the `(cityId, validTo)`
 * index serves (AAP 0.5.2). The shared-history set is driven from the viewer's own `pair_history`
 * rows — a handful, where a city's valid proofs are thousands — and is keyed by the counterpart's
 * most recent proof whatever its validity, kept only when that proof is for this city and the
 * counterpart holds no valid proof anywhere. The two are disjoint by construction (a member of the
 * first holds a valid proof, a member of the second holds none), which is what makes `UNION ALL`
 * exact rather than merely likely.
 *
 * The keyset predicate is applied in the outer query, after the per-user `DISTINCT ON`: inside the
 * first branch it would keep the older of a user's two valid proofs and so hand that user back on a
 * later page (AAP 0.5.1).
 *
 * Every traveler is a `Tier0Profile` whatever the tier between the viewer and the target would
 * otherwise be (AAP 0.5.4): discovery and the lodging guest lists show strangers, and
 * `tier0Profiles` builds a whole page in four queries rather than two per row. The viewer's own proof
 * is not checked here — `routes.ts` answers `403 no_valid_proof` before calling, in the error order
 * of AAP 0.5.4 — and nothing in this file writes, logs or opens a transaction. The instant every
 * window is judged at arrives from the caller's injected clock (AAP 0.11.1), so a criterion test can
 * cross a proof's validity boundary.
 *
 * @see AAP 0.5.2 for the models the statement reads, 0.5.4 for the route, its `Tier0Profile` page and
 *   its error order, 0.5.7 for the validity and discovery rules, 0.11.1 for the injected clock,
 *   0.8.1 for this file.
 */

import { Prisma } from '@tablemate/db';
import {
  CURSOR_INSTANT_FORMAT,
  decodeKeysetCursor,
  encodeKeysetCursor,
  PAGE_SIZE,
} from '@tablemate/shared';
import type { TravelersResponse } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { tier0Profiles } from '../users/disclosure/serialize.ts';

// Type-only, and taken from the module that builds the instance rather than from this file's
// dependency whitelist: `AppServices` is the plan's one declaration of what the app hands its
// modules, it is erased at compile time, and nothing of `app.ts` is read at runtime.
import type { AppServices } from '../../app.ts';

/**
 * The keyset position of a discovery page: the proof a page ended on, as its creation instant and
 * its id — the total order the page is sorted by (AAP 0.5.1).
 *
 * `createdAt` is that instant as the statement itself renders it: UTC, ISO 8601, microseconds. It is
 * deliberately a string and not a `Date`. `itinerary_proof.created_at` is `timestamptz(6)`, and a
 * `Date` holds milliseconds, so a row created at `…00.123456` would render as `…00.123`, a bound the
 * row is still greater than — the next page would show that row a second time. Carrying the
 * statement's own text back into the next statement's comparison keeps the order exact.
 */
export interface DiscoveryKey {
  /** The keying proof's `created_at`, as `{@link CURSOR_INSTANT_FORMAT}` renders it. */
  readonly createdAt: string;
  /** The keying proof's id, the tie-breaker under the creation instant. */
  readonly id: string;
}

/**
 * Encodes a keyset position as an opaque cursor (AAP 0.5.1).
 *
 * The wire form is the shared codec's, `@tablemate/shared`'s `encodeKeysetCursor`, so this reader and
 * the messaging and meetup readers issue one payload shape and read it back by one set of rules
 * (AAP 0.11.1). It is base64url text, so it survives a query string unmangled and stays well inside
 * the contract's 200-character `Cursor`. Clients echo it back unchanged: the shape is internal, and
 * only {@link decodeDiscoveryCursor} reads it.
 *
 * @param key - The instant and id of the page's last row, from the statement rather than a profile.
 * @returns The cursor for the next page.
 */
export function encodeDiscoveryCursor(key: DiscoveryKey): string {
  return encodeKeysetCursor(key);
}

/**
 * Decodes a cursor {@link encodeDiscoveryCursor} produced, or refuses it as `400 invalid_field`.
 *
 * A cursor is client-supplied text, so every step is checked rather than trusted: the shared codec
 * refuses anything that is not canonical base64url of a `{t,i}` JSON payload whose instant is in
 * {@link CURSOR_INSTANT_FORMAT} and names a real UTC instant — a client could otherwise hand the
 * statement a timestamp PostgreSQL refuses, which would answer `500` for what is really a bad request
 * — and whose id is a UUID. A cursor is opaque, so a client that edits one has no contract to break,
 * only a request to lose, and no diagnostic detail is returned.
 *
 * @param cursor - The `cursor` query parameter, echoed back from a previous page.
 * @returns The keyset position to continue after.
 * @throws AppError with code `invalid_field` for anything that is not a cursor this file wrote.
 */
export function decodeDiscoveryCursor(cursor: string): DiscoveryKey {
  const position = decodeKeysetCursor(cursor);

  if (position === null) {
    throw new AppError('invalid_field');
  }

  return position;
}

/**
 * One row of the discovery statement: the traveler, and the proof the page is keyed on.
 *
 * The names are the statement's quoted column aliases, which Prisma returns unchanged. Both ids are
 * cast to `text` in SQL and the instant is rendered by `to_char`, so nothing here depends on how the
 * driver maps `uuid` or `timestamptz`.
 */
interface DiscoveryRow {
  readonly userId: string;
  readonly createdAtKey: string;
  readonly id: string;
}

/**
 * One page of travelers visible in a city, 20 at a time, newest proof first (AAP 0.5.1, 0.5.4).
 *
 * @param services - The database and the services `tier0Profiles` needs to build the page.
 * @param cityId - The city slug whose travelers are wanted; the route has already answered
 *   `404 city_not_found` for a city that is not configured.
 * @param viewerId - The caller, excluded from the page and the one side of every block comparison.
 * @param cursor - The previous page's `nextCursor`, or `undefined` for the first page.
 * @param now - The instant proof validity is judged at; the route passes the one it used for its own
 *   `403 no_valid_proof` check, and the default keeps the four-argument call working.
 * @returns The page and, while rows remain, the cursor to continue from.
 * @throws AppError with code `invalid_field` when `cursor` is not a cursor this file wrote.
 */
export async function listTravelers(
  services: AppServices,
  cityId: string,
  viewerId: string,
  cursor: string | undefined,
  now: Date = services.clock.now(),
): Promise<TravelersResponse> {
  const key = cursor === undefined ? null : decodeDiscoveryCursor(cursor);

  const cursorPredicate =
    key === null
      ? Prisma.empty
      : Prisma.sql`AND (c."created_at", c."id") < (${key.createdAt}::timestamptz, ${key.id}::uuid)`;

  const rows = await services.db.$queryRaw<DiscoveryRow[]>(Prisma.sql`
    WITH "candidate" AS (
      (
        SELECT DISTINCT ON (p."user_id")
               p."user_id" AS "user_id",
               p."created_at" AS "created_at",
               p."id" AS "id"
        FROM "itinerary_proof" p
        WHERE p."city_id" = ${cityId}
          AND p."valid_to" >= ${now}
          AND p."valid_from" <= ${now}
        ORDER BY p."user_id", p."created_at" DESC, p."id" DESC
      )
      UNION ALL
      (
        SELECT o."other_id" AS "user_id",
               latest."created_at" AS "created_at",
               latest."id" AS "id"
        FROM (
          SELECT CASE
                   WHEN ph."user_low_id" = ${viewerId}::uuid THEN ph."user_high_id"
                   ELSE ph."user_low_id"
                 END AS "other_id"
          FROM "pair_history" ph
          WHERE (ph."user_low_id" = ${viewerId}::uuid OR ph."user_high_id" = ${viewerId}::uuid)
            AND ph."completed_count" >= 1
        ) o
        JOIN LATERAL (
          SELECT p."city_id" AS "city_id",
                 p."created_at" AS "created_at",
                 p."id" AS "id"
          FROM "itinerary_proof" p
          WHERE p."user_id" = o."other_id"
          ORDER BY p."created_at" DESC, p."id" DESC
          LIMIT 1
        ) latest ON TRUE
        WHERE latest."city_id" = ${cityId}
          AND NOT EXISTS (
            SELECT 1 FROM "itinerary_proof" v
            WHERE v."user_id" = o."other_id"
              AND v."valid_from" <= ${now}
              AND v."valid_to" >= ${now}
          )
      )
    )
    SELECT
      c."user_id"::text AS "userId",
      to_char(c."created_at" AT TIME ZONE 'UTC', ${CURSOR_INSTANT_FORMAT}) AS "createdAtKey",
      c."id"::text AS "id"
    FROM "candidate" c
    JOIN "user" u ON u."id" = c."user_id"
    WHERE c."user_id" <> ${viewerId}::uuid
      AND u."deleted_at" IS NULL
      AND u."deletion_requested_at" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "block" b
        WHERE (b."blocker_id" = ${viewerId}::uuid AND b."blocked_id" = c."user_id")
           OR (b."blocker_id" = c."user_id" AND b."blocked_id" = ${viewerId}::uuid)
      )
    ${cursorPredicate}
    ORDER BY c."created_at" DESC, c."id" DESC
    LIMIT ${PAGE_SIZE + 1}
  `);

  // One row beyond the page answers "is there more?" without a second query. The cursor is taken from
  // the rows, never from the profiles: a user that account erasure removed between the statement and
  // `tier0Profiles` shortens the page but must not move the position the next page continues from.
  const page = rows.slice(0, PAGE_SIZE);
  const lastRow = page[page.length - 1];
  const nextCursor =
    rows.length > PAGE_SIZE && lastRow !== undefined
      ? encodeDiscoveryCursor({ createdAt: lastRow.createdAtKey, id: lastRow.id })
      : null;

  const items = await tier0Profiles(
    services,
    page.map((row) => row.userId),
    now,
  );

  return { items, nextCursor };
}
