/**
 * The "I'm staying here" guest list: the opt-in toggle behind `PUT /me/lodging-visibility` and the
 * opted-in guests a lodging's detail returns (AAP 0.5.1, 0.5.4, 0.5.7).
 *
 * Where a traveler sleeps is the most sensitive disclosure in the product, so it is opt-in twice
 * over: nothing is listed until they turn `showStaying` on, and the toggle can be turned on only for
 * a claim that is `verified` and still inside its stay. Hiding always succeeds — a traveler can
 * always take themselves off a guest list (AAP 0.5.7 "Lodging visibility", 0.12.2 "Guest list
 * opt-in, off by default, with a safety warning"; the warning itself is the client's, in
 * `apps/mobile/app/profile/stay.tsx`).
 *
 * {@link setVisibility} is the write. It runs inside one transaction behind the account-deletion
 * write fence (AAP 0.5.3), so a traveler whose deletion has been requested cannot opt in, and it
 * re-points the visibility row at the claim the opt-in was granted for on every turn-on, so a new
 * stay never inherits an older stay's consent. It writes no outbox row, emits no analytics event and
 * touches no cache: a guest list is read live, and the leaderboard's guest count counts every
 * current verified guest whether or not they opted in.
 *
 * {@link guestsFor} is the read: the opted-in travelers currently staying at one lodging, as
 * tier-0 profiles — the same shape a stranger sees in discovery, and never a room number, a stay
 * date, a booking field or a claim id (AAP 0.5.4). It answers a viewer who holds a valid proof for
 * the lodging's city, which the route checks before calling; here a deleted or deletion-requested
 * traveler, and every pair with a block in either direction, are absent from the list. The list is
 * bounded at {@link LODGING_GUEST_LIST_LIMIT} entries, and the count shown beside it is what says so.
 *
 * Four invariants the SQL keeps:
 *
 * - The toggle's claim lookup and the guest list share {@link currentStayPredicate}, so "active"
 *   means the lodging's local today in both and the two cannot disagree about who is staying: a
 *   stay stops counting at the end of its `stayTo` in city time, before the daily `stay-expiry` job
 *   in `apps/workers` gets round to turning the flag off.
 * - Both statements read `lodging`, and a raw query bypasses the guarded client's fixture extension,
 *   so each adds {@link fixturePredicate} for that alias (AAP 0.5.2), as `leaderboard.ts` does.
 * - The guest list is bounded at {@link LODGING_GUEST_LIST_LIMIT} entries, the most recently
 *   resolved stay first, and the bound is visible in the answer rather than silent: the DTO's own
 *   `guestCount` counts every current verified guest, so a list shorter than that number reads as a
 *   cut list rather than as a claim that nobody else is staying there (AAP 0.5.4, 0.5.7).
 * - The opt-in is written under a share lock on the claim row it names, so a claim deleted between
 *   the lookup and the upsert makes the upsert wait rather than fail on the foreign key.
 *
 * The services each function takes is the app's own services object narrowed structurally, the way
 * `lodgings/leaderboard.ts` narrows it, rather than the composition root's `AppServices` type:
 * `apps/api/src/app.ts` is another file's deliverable, it is not on this file's dependency
 * whitelist, and the narrowed types state exactly the capabilities these two functions use.
 *
 * @see AAP 0.5.7 for the visibility, claim and leaderboard rules, 0.5.4 for
 *   `PUT /me/lodging-visibility` and the lodging DTOs, 0.5.3 for the write fence, 0.5.2 for
 *   retention, 0.8.1 for this file.
 */

import { Prisma, fixturePredicate, type DbTx } from '@tablemate/db';
import type { CommonEnv } from '@tablemate/server-core';
import type { AppEnv, Tier0Profile, VisibilityResponse } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { transact, type TransactServices } from '../outbox/write.ts';
import { tier0Profiles, type ReaderServices } from '../users/disclosure/serialize.ts';
import { currentStayPredicate } from './leaderboard.ts';

// ---------------------------------------------------------------------------------------------
// Table aliases (AAP 0.5.2, 0.5.7)
// ---------------------------------------------------------------------------------------------

/** The alias {@link currentStayPredicate} expects for `lodging_claim`. */
const CLAIM_ALIAS = 'c';

/** The alias {@link currentStayPredicate} expects for `city`. */
const CITY_ALIAS = 'ci';

/** The alias both statements give `lodging`, the table that carries the fixture predicate. */
const LODGING_ALIAS = 'l';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/**
 * What {@link setVisibility} needs of the app's services (AAP 0.5.3, 0.5.4): the database, injected
 * clock, logger and outbox dispatcher that {@link transact} takes, plus the environment whose
 * `APP_ENV` decides fixture visibility in its claim lookup (AAP 0.5.2).
 */
export type VisibilityWriteServices = TransactServices & {
  /** The validated environment of the process; only `APP_ENV` is read here. */
  readonly env: Pick<CommonEnv, 'APP_ENV'>;
};

/**
 * What {@link guestsFor} needs (AAP 0.5.2, 0.5.4): the database, keyring and logger that
 * `tier0Profiles` takes, plus the same environment for the guest statement's fixture predicate.
 */
export type GuestListServices = ReaderServices & {
  /** The validated environment of the process; only `APP_ENV` is read here. */
  readonly env: Pick<CommonEnv, 'APP_ENV'>;
};

/** One row of the claim lookup: only the id the visibility row has to name. */
interface ClaimIdRow {
  readonly id: string;
}

/** One row of the guest statement: only the id whose tier-0 profile is wanted. */
interface GuestRow {
  readonly user_id: string;
}

// ---------------------------------------------------------------------------------------------
// setVisibility — PUT /me/lodging-visibility (AAP 0.5.4, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * Turns the caller's staying visibility on or off and answers the state recorded (AAP 0.5.4).
 *
 * **On** requires a claim that is `verified` and active — the caller's most recently resolved one,
 * should the data ever hold more than one (the claim rules of AAP 0.5.7 allow at most one active
 * claim). Without one the request is refused with `409 no_verified_claim`, so nothing can be listed
 * for a stay the lodging has not confirmed. The visibility row is keyed by the traveler and is
 * re-pointed at that claim on every turn-on, which is what keeps a new claim from inheriting an
 * older stay's consent.
 *
 * **Off** always succeeds, with or without a claim and whatever the row currently says, because a
 * traveler must be able to hide at any moment (AAP 0.12.2). It updates an existing row rather than
 * deleting it, leaving `lodgingClaimId` as it stands: the flag is the whole of what is disclosed.
 *
 * The whole change is one transaction behind the write fence of AAP 0.5.3, so a traveler whose
 * deletion has been requested is refused with `401 token_invalid` before anything is written and no
 * opt-in can commit after their erasure begins. The claim row is read `FOR SHARE`: a claim deleted
 * while this request is in flight makes the upsert wait for the deletion and then follow it into
 * oblivion through the foreign key, rather than failing the request on a violated reference.
 *
 * @param services - The app's services: database, clock, logger, outbox and environment.
 * @param userId - The caller's id, from the authenticated session; it is the visibility row's key.
 * @param showStaying - The requested state: `true` opts in, `false` hides.
 * @returns A fresh `VisibilityResponse` holding the state the server recorded.
 * @throws AppError `no_verified_claim` (`409`) when `showStaying` is `true` and no verified, active
 *   claim exists.
 * @throws AppError `token_invalid` (`401`) when the account's deletion has been requested.
 * @see AAP 0.5.7 for the opt-in rule, 0.5.4 for the route, 0.5.3 for the fence.
 */
export async function setVisibility(
  services: VisibilityWriteServices,
  userId: string,
  showStaying: boolean,
): Promise<VisibilityResponse> {
  const now = services.clock.now();

  return await transact(
    services,
    async (tx) => {
      if (!showStaying) {
        // Only a row that is currently shown needs writing; an absent row is already hidden.
        await tx.lodgingVisibility.updateMany({
          where: { userId, showStaying: true },
          data: { showStaying: false },
        });
        return { showStaying: false };
      }

      const claimId = await activeVerifiedClaimId(tx, userId, now, services.env.APP_ENV);

      if (claimId === null) {
        throw new AppError('no_verified_claim');
      }

      await tx.lodgingVisibility.upsert({
        where: { userId },
        create: { userId, lodgingClaimId: claimId, showStaying: true },
        update: { lodgingClaimId: claimId, showStaying: true },
      });

      return { showStaying: true };
    },
    { fenceUserId: userId },
  );
}

/**
 * The caller's verified, still-active claim, or `null` (AAP 0.5.7).
 *
 * "Active" is {@link currentStayPredicate}: `status = 'verified'` and a `stayTo` that has not passed
 * in the lodging's city time, which is the period the guest count, the guest list and the claim
 * rules all use. The claim rules allow one active claim per traveler, so the ordering is a
 * tie-break for data that somehow holds two: the most recently resolved first, then the id, so the
 * same rows always answer the same claim.
 *
 * `FOR SHARE OF "c"` is what makes the caller's decision hold until it is written: the row cannot be
 * deleted between this read and the `lodgingVisibility` upsert that references it. The city is
 * reached through the lodging because a claim carries no city of its own.
 *
 * @param tx - The transaction client `transact`'s `fn` received.
 * @param userId - The traveler whose claim is wanted.
 * @param now - The instant the city-local day is derived from; from `services.clock`.
 * @param appEnv - The process's `APP_ENV`; the statement reads `lodging`, so it needs the fixture
 *   predicate that a raw query cannot inherit from the guarded client (AAP 0.5.2).
 * @returns The claim's id, or `null` when no such claim exists.
 */
async function activeVerifiedClaimId(
  tx: DbTx,
  userId: string,
  now: Date,
  appEnv: AppEnv,
): Promise<string | null> {
  const rows = await tx.$queryRaw<ClaimIdRow[]>(Prisma.sql`
    SELECT "c"."id"::text AS "id"
      FROM "lodging_claim" AS "c"
      JOIN "lodging" AS "l" ON "l"."id" = "c"."lodging_id"
      JOIN "city" AS "ci" ON "ci"."id" = "l"."city_id"
     WHERE "c"."user_id" = ${userId}::uuid
       AND ${currentStayPredicate(CLAIM_ALIAS, CITY_ALIAS, now)}
       AND ${fixturePredicate(appEnv, LODGING_ALIAS)}
     ORDER BY "c"."resolved_at" DESC NULLS LAST, "c"."id" DESC
     LIMIT 1
       FOR SHARE OF "c"
  `);

  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// guestsFor — the guest list of one lodging (AAP 0.5.4, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * How many guests one lodging's detail lists (AAP 0.5.4, 0.5.7).
 *
 * Without a bound the list would grow with the lodging's own opted-in population — a hostel's guest
 * list is as large as the number of travelers who opted in while staying there — so one row's
 * request would answer with a list as large as that population, and the payload a client renders
 * would grow with the disclosure decisions of every traveler who ever stayed. Every other list the
 * API answers is bounded the same way (`LODGING_DIRECTORY_LIMIT` in `lodgings/leaderboard.ts`,
 * `ADMIN_CALL_TASKS_LIMIT` in `admin/call-tasks.ts`), and AAP 0.5.4 fixes no cursor for a guest
 * list, so a cap is the resolution rather than a paging change.
 *
 * The statement reads one row beyond this bound and that row is dropped as a sentinel, so the list
 * is cut at exactly this many guests and nothing is logged per request: the DTO's own `guestCount`
 * already reports every current verified guest, and a list shorter than that number is what makes a
 * partial list honest rather than a hidden one (AAP 0.5.7 "Lodging visibility").
 */
export const LODGING_GUEST_LIST_LIMIT = 100;

/**
 * The opted-in travelers currently staying at one lodging, as tier-0 profiles (AAP 0.5.4, 0.5.7).
 *
 * One statement selects the traveler ids and {@link tier0Profiles} builds their profiles, so the
 * shape a guest list discloses is the same shape discovery discloses and a page costs a fixed number
 * of queries. The list is answered only to a viewer holding a valid proof for the lodging's city —
 * that check belongs to the route, which answers `403 no_valid_proof` before reaching here.
 *
 * One row per opted-in guest, and the four conditions a guest would have to fail to be listed:
 *
 * - `lodging_visibility` names *this* claim and has `show_staying` on. Naming the claim matters:
 *   a row left over from an earlier stay lists nothing.
 * - the claim is verified and active by {@link currentStayPredicate}, so a stay that ended
 *   yesterday is gone from the list even before the daily `stay-expiry` job clears the flag.
 * - the traveler is not deleted or awaiting erasure, and neither they nor the viewer blocked the
 *   other (AAP 0.5.7): a block hides the pair from each other in both directions.
 * - the lodging is not a fixture outside the environments that hold them (AAP 0.5.2).
 *
 * Ordering is by the instant the stay was resolved, most recent first, then by id, so a list does
 * not reshuffle between two reads of unchanged data. Nothing else about a guest leaves this function:
 * no stay dates, no room number, no booking field, no claim id, and no coordinates.
 *
 * The list is bounded at {@link LODGING_GUEST_LIST_LIMIT} guests, the most recently resolved stays
 * first, so the number of travelers one request answers with is a decision of ours rather than a
 * property of the lodging. The bound never claims to be the whole guest list: the sibling
 * `guestCount` of the same DTO counts every current verified guest, so a list shorter than that
 * count is a cut list, and its first entries are the stays the lodging resolved most recently.
 *
 * @param services - The app's services: database, keyring, logger and environment.
 * @param lodgingId - The lodging whose guest list is wanted; the route has already resolved it.
 * @param viewerId - The traveler looking, whose blocks are excluded in both directions.
 * @param now - The instant the city-local day is derived from; from the caller's injected clock.
 * @returns The opted-in guests' tier-0 profiles, most recently resolved stay first, at most
 *   {@link LODGING_GUEST_LIST_LIMIT} of them; empty when nobody has opted in.
 * @see AAP 0.5.7 for the visibility rule, 0.5.4 for `LodgingDetail.guests`, 0.5.2 for erasure.
 */
export async function guestsFor(
  services: GuestListServices,
  lodgingId: string,
  viewerId: string,
  now: Date,
): Promise<Tier0Profile[]> {
  const rows = await services.db.$queryRaw<GuestRow[]>(Prisma.sql`
    SELECT "c"."user_id"::text AS "user_id"
      FROM "lodging_claim" AS "c"
      JOIN "lodging_visibility" AS "lv"
        ON "lv"."user_id" = "c"."user_id"
       AND "lv"."lodging_claim_id" = "c"."id"
       AND "lv"."show_staying" = true
      JOIN "lodging" AS "l" ON "l"."id" = "c"."lodging_id"
      JOIN "city" AS "ci" ON "ci"."id" = "l"."city_id"
      JOIN "user" AS "u" ON "u"."id" = "c"."user_id"
     WHERE "c"."lodging_id" = ${lodgingId}::uuid
       AND ${currentStayPredicate(CLAIM_ALIAS, CITY_ALIAS, now)}
       AND "u"."deleted_at" IS NULL
       AND "u"."deletion_requested_at" IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM "block" AS "b"
              WHERE ("b"."blocker_id" = ${viewerId}::uuid AND "b"."blocked_id" = "c"."user_id")
                 OR ("b"."blocker_id" = "c"."user_id" AND "b"."blocked_id" = ${viewerId}::uuid)
           )
       AND ${fixturePredicate(services.env.APP_ENV, LODGING_ALIAS)}
     ORDER BY "c"."resolved_at" DESC, "c"."user_id"
     LIMIT ${LODGING_GUEST_LIST_LIMIT + 1}
  `);

  // The row past the bound is the sentinel the statement reads to know the list was cut: it is
  // dropped here rather than listed. Nothing is logged for it, because the DTO's own `guestCount`
  // already reports every current verified guest and is what makes the shorter list honest
  // (`LODGING_GUEST_LIST_LIMIT`, AAP 0.5.7).
  const listed =
    rows.length > LODGING_GUEST_LIST_LIMIT ? rows.slice(0, LODGING_GUEST_LIST_LIMIT) : rows;

  return await tier0Profiles(
    services,
    listed.map((row: GuestRow) => row.user_id),
    now,
  );
}
