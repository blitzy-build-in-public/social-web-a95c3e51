/**
 * Who may message whom: the one access rule the chat history, the open socket and every send share.
 *
 * Messaging opens only once both deposits are locked, and the rule is worded per pair — a pair may message while it holds a
 * `locked` or a `completed` meetup — so the gate is asked of the pair rather than of the meetup the caller happened to open:
 * one locked meetup opens every conversation the pair has, and any other status unlocks nothing.
 *
 * The three refusals are checked in the contract's order, and that order is load-bearing: `not_participant` when the meetup
 * does not exist, the caller is not on it, or the caller is its recipient while the proposal is not yet visible to them;
 * `messaging_locked` when the pair has neither a `locked` nor a `completed` meetup, or the counterpart's account is gone; then
 * `blocked` for a block row in either direction, because safety outranks the pair's own history.
 *
 * {@link messageableMeetupIds} answers that same rule as a set, so the meetups the socket attaches to and the meetups
 * {@link requireMessaging} admits can never disagree. A leaf of the messaging module, and read-only.
 */
import { Prisma } from '@tablemate/db';
import type { DbClient, DbTx } from '@tablemate/db';
import type { ErrorCode, MeetupStatus } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { isVisibleTo, loadMeetup, participantRole } from '../meetups/queries.ts';

export type MessagingDenial = Extract<
  ErrorCode,
  'not_participant' | 'messaging_locked' | 'blocked'
>;

/**
 * Whether a caller may message in a meetup, and whom they would be messaging. A value rather than a thrown error, because the
 * chat socket turns a refusal into an `ErrorFrame` while the history route turns it into the envelope.
 */
export type MessagingAccess =
  | { readonly ok: true; readonly counterpartId: string }
  | { readonly ok: false; readonly code: MessagingDenial };
/**
 * The database surface this module needs: the `meetup` delegate for the row load, and tagged-template raw SQL for the pair
 * facts no delegate expresses. Satisfied by the guarded `DbClient` and by a `DbTx`, the same union `loadMeetup` takes.
 */
export type MessagingDb = DbClient | DbTx;

/**
 * The two statuses that open messaging, taken from the shared `MeetupStatus` values: `locked` is the pair's commitment lock and
 * `completed` keeps the conversation open after the meetup settled.
 */
const MESSAGING_OPEN_STATUSES = ['locked', 'completed'] as const satisfies readonly MeetupStatus[];

/**
 * The same two values as SQL text, rendered from the shared enum rather than spelled into each statement, so renaming one in
 * `packages/shared` cannot leave a statement behind; the text is written into the query because `meetup.status` is the
 * `meetup_status` enum type, and a bound `text` parameter has no operator against it.
 */
const MESSAGING_OPEN_STATUSES_SQL = Prisma.raw(
  MESSAGING_OPEN_STATUSES.map((status) => `'${status}'`).join(', '),
);

/** The most meetup ids one attach carries: the newest, not the whole of the socket's set (AAP 0.5.1). */
const MESSAGEABLE_MEETUP_LIMIT = 200;

/** The one row the pair-facts statement returns; column names are PostgreSQL's, so they stay snake_case. */
interface AccessFactsRow {
  messageable: boolean;
  counterpart_gone: boolean;
  blocked: boolean;
}

/**
 * The three facts about the caller's pair, read in one round trip: a `SELECT` with no `FROM`, so it is one parameterized
 * statement that always returns exactly one row. The pair is matched with an explicit `OR` over `initiator_id` and
 * `recipient_id` rather than `LEAST`/`GREATEST`, so the ordinary indexes on the two participant columns serve the lookup.
 */
async function accessFacts(
  db: MessagingDb,
  userId: string,
  counterpartId: string,
): Promise<AccessFactsRow> {
  const rows = await db.$queryRaw<AccessFactsRow[]>(Prisma.sql`
    SELECT
      EXISTS (
        SELECT 1 FROM "meetup" m
        WHERE ((m."initiator_id" = ${userId}::uuid AND m."recipient_id" = ${counterpartId}::uuid)
            OR (m."initiator_id" = ${counterpartId}::uuid AND m."recipient_id" = ${userId}::uuid))
          AND m."status" IN (${MESSAGING_OPEN_STATUSES_SQL})
      ) AS "messageable",
      EXISTS (
        SELECT 1 FROM "user" u
        WHERE u."id" = ${counterpartId}::uuid
          AND (u."deleted_at" IS NOT NULL OR u."deletion_requested_at" IS NOT NULL)
      ) AS "counterpart_gone",
      EXISTS (
        SELECT 1 FROM "block" b
        WHERE (b."blocker_id" = ${userId}::uuid AND b."blocked_id" = ${counterpartId}::uuid)
           OR (b."blocker_id" = ${counterpartId}::uuid AND b."blocked_id" = ${userId}::uuid)
      ) AS "blocked"
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('messaging access facts returned no row');
  }
  return row;
}

/**
 * Whether `userId` may message in `meetupId`, and whom they would be messaging.
 *
 * Read-only, and it refuses by returning rather than throwing, so a caller decides what its own surface answers with: taking no
 * lock and opening no transaction makes it safe on every chat frame and inside a caller's transaction alike. Each of the three
 * checks is decided by the tables rather than by a cache, because a block, a completion or an erasure changes the answer at
 * once.
 */
export async function canMessage(
  db: MessagingDb,
  meetupId: string,
  userId: string,
): Promise<MessagingAccess> {
  const meetup = await loadMeetup(db, meetupId);
  if (meetup === null) {
    return { ok: false, code: 'not_participant' };
  }
  const role = participantRole(meetup, userId);
  // An invisible proposal is answered exactly like a meetup that does not exist (AAP 0.5.3).
  if (role === null || !isVisibleTo(meetup, userId)) {
    return { ok: false, code: 'not_participant' };
  }
  const counterpartId = role === 'initiator' ? meetup.recipientId : meetup.initiatorId;
  const facts = await accessFacts(db, userId, counterpartId);
  if (!facts.messageable || facts.counterpart_gone) {
    return { ok: false, code: 'messaging_locked' };
  }
  if (facts.blocked) {
    return { ok: false, code: 'blocked' };
  }
  return { ok: true, counterpartId };
}

/** {@link canMessage} as the refusal it throws, for the handlers that answer with the envelope: each code maps to `403` through
 * the shared `ERROR_STATUS`. */
export async function requireMessaging(
  db: MessagingDb,
  meetupId: string,
  userId: string,
): Promise<{ counterpartId: string }> {
  const access = await canMessage(db, meetupId, userId);
  if (!access.ok) {
    throw new AppError(access.code);
  }
  return { counterpartId: access.counterpartId };
}

interface MeetupIdRow {
  id: string;
}

/**
 * The meetups one socket attaches with for `userId`, newest first.
 *
 * Every condition is the one {@link canMessage} applies, so the set a socket attaches to and the per-send check agree by
 * construction. One statement, and the only bound is the limit, which keeps the set a socket carries as it opens bounded
 * however long a pair's history grows: a chat the participant opens joins it through `pubsub.openChat` and one they write in
 * through `pubsub.attachMeetup`, so a meetup past this bound is not permanently outside the live fan-out.
 */
export async function messageableMeetupIds(
  db: MessagingDb,
  userId: string,
  limit = MESSAGEABLE_MEETUP_LIMIT,
): Promise<string[]> {
  const bounded = Number.isFinite(limit)
    ? Math.max(Math.trunc(limit), 1)
    : MESSAGEABLE_MEETUP_LIMIT;
  const rows = await db.$queryRaw<MeetupIdRow[]>(Prisma.sql`
    SELECT m."id" AS "id"
    FROM "meetup" m
    JOIN "user" counterpart
      ON counterpart."id" = CASE
           WHEN m."initiator_id" = ${userId}::uuid THEN m."recipient_id"
           ELSE m."initiator_id"
         END
    WHERE (m."initiator_id" = ${userId}::uuid OR m."recipient_id" = ${userId}::uuid)
      AND (m."initiator_id" = ${userId}::uuid OR m."proposal_visible_at" IS NOT NULL)
      AND counterpart."deleted_at" IS NULL
      AND counterpart."deletion_requested_at" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "block" b
        WHERE (b."blocker_id" = ${userId}::uuid AND b."blocked_id" = counterpart."id")
           OR (b."blocker_id" = counterpart."id" AND b."blocked_id" = ${userId}::uuid)
      )
      AND EXISTS (
        SELECT 1 FROM "meetup" p
        WHERE p."status" IN (${MESSAGING_OPEN_STATUSES_SQL})
          AND ((p."initiator_id" = ${userId}::uuid AND p."recipient_id" = counterpart."id")
            OR (p."initiator_id" = counterpart."id" AND p."recipient_id" = ${userId}::uuid))
      )
    ORDER BY m."created_at" DESC, m."id" DESC
    LIMIT ${bounded}
  `);
  return rows.map((row) => row.id);
}
