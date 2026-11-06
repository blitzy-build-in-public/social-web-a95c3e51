/**
 * Who may message whom: the one access rule the chat history, the open socket and every send share
 * (AAP 0.5.1, 0.5.4, 0.7.3).
 *
 * Messaging opens only once both deposits are locked (AAP 0.7.3, assumption 6), and the rule is worded
 * per pair — a pair may message while it holds a `locked` or a `completed` meetup — so the gate is
 * asked of the pair rather than of the meetup the caller happened to open: one locked meetup opens
 * every conversation the pair has, and a `forfeited`, `unattended`, `no_fault`, `lock_lost`,
 * `cancelled`, `declined` or `lapsed` meetup unlocks nothing (AAP 0.5.3, 0.5.4).
 *
 * The three refusals are checked in the contract's order, and that order is load-bearing (AAP 0.5.4):
 *
 *   1. `not_participant` — the meetup does not exist, the caller is not on it, or the caller is its
 *      recipient while the proposal is not yet visible to them (AAP 0.5.3). An unknown id and an
 *      invisible proposal both answer this rather than `404 meetup_not_found`, so the route cannot be
 *      used to probe whether a proposal exists or whether the initiator's hold is still pending.
 *   2. `messaging_locked` — the pair has neither a `locked` nor a `completed` meetup, or the
 *      counterpart's account is gone: a deleted or deletion-requested user has its sockets closed and
 *      its messages erased (AAP 0.5.2, 0.5.3), so nothing may be written to it. A blocked pair with no
 *      lock answers this rather than `blocked`, because the lock is the gate the caller must clear.
 *   3. `blocked` — a block row in either direction between the two (AAP 0.5.4). Safety outranks the
 *      pair's own history: a block closes the conversation for both sides (AAP 0.5.3).
 *
 * {@link messageableMeetupIds} answers that same rule as a set, so the meetups the chat socket attaches
 * to when it opens and the meetups {@link requireMessaging} admits on each send can never disagree
 * (AAP 0.5.1); {@link canMessage} is the single decision both are built from.
 *
 * A leaf of the messaging module, and read-only: no transaction, no lock, no write, no clock and no
 * log. What it returns is a code its caller reports, never an id it logs. The only module file it
 * imports is `meetups/queries.ts`, whose `participantRole`, `isVisibleTo` and `loadMeetup` are the one
 * definition of who a meetup belongs to (AAP 0.5.4).
 *
 * @see AAP 0.5.1 for this file's place in the messaging component, 0.5.2 and 0.5.3 for the erased
 *   counterpart, the visibility of a proposal and the block's effect on a pair, 0.5.4 for the two
 *   messaging refusals and the routes that answer them, 0.7.3 for the assumption that messaging opens
 *   only after both deposits lock, and 0.8.1 for this file.
 */

import { Prisma } from '@tablemate/db';
import type { DbClient, DbTx } from '@tablemate/db';
import type { ErrorCode, MeetupStatus } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { isVisibleTo, loadMeetup, participantRole } from '../meetups/queries.ts';

/*
 * Types (AAP 0.5.4)
 */

/** The three refusals of the messaging gate, each answered `403` by the shared `ERROR_STATUS`. */
export type MessagingDenial = Extract<
  ErrorCode,
  'not_participant' | 'messaging_locked' | 'blocked'
>;

/**
 * Whether a caller may message in a meetup, and whom they would be messaging (AAP 0.5.4).
 *
 * A value rather than a thrown error, because the chat socket turns a refusal into an `ErrorFrame`
 * while the history route turns it into the envelope: both need the code, neither needs a throw.
 */
export type MessagingAccess =
  | { readonly ok: true; readonly counterpartId: string }
  | { readonly ok: false; readonly code: MessagingDenial };

/**
 * The database surface this module needs: the `meetup` delegate for the row load, and tagged-template
 * raw SQL for the pair facts no delegate expresses (AAP 0.11.2). Satisfied by the guarded `DbClient`
 * and by the `DbTx` of a transaction a caller is already in — the same union `loadMeetup` takes, so a
 * caller passes one client through both.
 */
export type MessagingDb = DbClient | DbTx;

/*
 * Constants
 */

/**
 * The two statuses that open messaging, taken from the shared `MeetupStatus` values (AAP 0.5.3,
 * 0.5.4). `locked` is the pair's commitment lock and `completed` keeps the conversation open after
 * the meetup settled, so a pair that met can still write to each other.
 */
const MESSAGING_OPEN_STATUSES = ['locked', 'completed'] as const satisfies readonly MeetupStatus[];

/**
 * The same two values as SQL text. They are rendered from the shared enum rather than spelled into
 * each statement, so renaming one in `packages/shared` cannot leave a statement behind, and the text
 * is written into the query because `meetup.status` is the `meetup_status` enum type: a bound `text`
 * parameter compared against an enum column has no operator, while an untyped literal coerces to it.
 */
const MESSAGING_OPEN_STATUSES_SQL = Prisma.raw(
  MESSAGING_OPEN_STATUSES.map((status) => `'${status}'`).join(', '),
);

/** The meetup ids one attach carries unless the caller asks for another bound. */
const MESSAGEABLE_MEETUP_LIMIT = 200;

/*
 * The pair facts (AAP 0.5.4)
 */

/** The one row the pair-facts statement returns; column names are PostgreSQL's, so they stay snake_case. */
interface AccessFactsRow {
  messageable: boolean;
  counterpart_gone: boolean;
  blocked: boolean;
}

/**
 * The three facts about the caller's pair, read in one round trip.
 *
 * A `SELECT` with no `FROM` — three scalar sub-expressions, which PostgreSQL evaluates once — so this
 * is one parameterized statement that always returns exactly one row, and it costs the same shape of
 * work for every caller (AAP 0.12.2). Only ids are parameters.
 *
 * The pair is matched with an explicit `OR` over `initiator_id` and `recipient_id` rather than with
 * `LEAST`/`GREATEST`: they name the same unordered pair the open-meetup index uses, but each branch
 * here is an equality on `initiator_id`, so the ordinary indexes on the two participant columns serve
 * the lookup — the same reasoning `pairFacts` in the disclosure layer states for its own statement
 * (AAP 0.5.2).
 *
 * @param db - The guarded client, or the transaction's client when the caller is already in one.
 * @param userId - The caller, one member of the pair.
 * @param counterpartId - The other member: the meetup's opposite participant.
 * @returns The pair's facts, each read fresh.
 * @throws Error when the statement returns no row, which its `FROM`-less shape makes impossible: a
 *   gate is never decided on facts we could not read.
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

/*
 * The gate (AAP 0.5.1, 0.5.4)
 */

/**
 * Whether `userId` may message in `meetupId`, and whom they would be messaging (AAP 0.5.4).
 *
 * Read-only, and it refuses by returning rather than throwing, so a caller decides what its own
 * surface answers with: it takes no lock and opens no transaction, which makes it safe to call on
 * every chat frame and inside a caller's transaction alike (AAP 0.3.2). The three checks run in the
 * order documented at the top of this file, each one decided by the tables rather than by a cache: a
 * block, a completion or an erasure changes the answer at once, and a stale access decision is a
 * message written where it must not be.
 *
 * @param db - The guarded client, or the transaction's client when the caller is already in one.
 * @param meetupId - The meetup the conversation belongs to.
 * @param userId - The caller.
 * @returns `{ ok: true, counterpartId }`, or the refusal the caller reports as `403` (`not_participant`
 *   for a meetup that is not the caller's, `messaging_locked` while the pair has no locked or
 *   completed meetup or the counterpart is gone, `blocked` for a block in either direction).
 * @throws Error when the pair-facts statement returns no row, which cannot happen and is a defect on
 *   our side rather than the caller's.
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

/**
 * {@link canMessage} as the refusal it throws, for the handlers that answer with the envelope
 * (AAP 0.5.4).
 *
 * Each code maps to `403` through the shared `ERROR_STATUS`, and the message stays the code's default
 * one: the envelope carries no reason a caller could use to probe the pair's history.
 *
 * @param db - The guarded client, or the transaction's client when the caller is already in one.
 * @param meetupId - The meetup the conversation belongs to.
 * @param userId - The caller.
 * @returns The counterpart's id, once the gate admits the caller.
 * @throws AppError `not_participant`, `messaging_locked` or `blocked`, in the order {@link canMessage}
 *   decides them.
 */
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

/*
 * The socket's meetup set (AAP 0.5.1)
 */

/** The one column {@link messageableMeetupIds} selects. */
interface MeetupIdRow {
  id: string;
}

/**
 * The meetups one socket may carry for `userId`, newest first (AAP 0.5.1, 0.5.4).
 *
 * Every condition is the one {@link canMessage} applies, so the set a socket attaches to and the
 * per-send check agree by construction: the caller is a participant of the meetup, the meetup is
 * visible to them — a recipient's proposal that is not yet visible to them is not theirs to carry
 * (AAP 0.5.3) — the counterpart's account is live, the pair has a `locked` or a `completed` meetup,
 * and there is no block in either direction.
 *
 * One statement, and the only bound is the limit: a socket's set is read once as it opens, so the
 * ceiling keeps the attachment bounded however long a pair's history grows.
 *
 * @param db - The guarded client, or the transaction's client when the caller is already in one.
 * @param userId - The user whose socket is being attached.
 * @param limit - The most ids to return; default {@link MESSAGEABLE_MEETUP_LIMIT}, normalized to a
 *   whole number of at least 1 so a fractional or non-positive argument cannot reach PostgreSQL's
 *   `LIMIT`.
 * @returns The meetup ids, newest first; an empty array for a user with nothing to message in.
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
