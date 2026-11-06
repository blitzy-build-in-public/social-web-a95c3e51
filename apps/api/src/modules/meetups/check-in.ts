/**
 * Witnessed check-in: the guarded evaluation of a venue's rotating code that records presence, and
 * the distance bucket it was made at (AAP 0.5.1, 0.5.4, 0.5.7, 0.12.2).
 *
 * `POST /meetups/:id/check-in` hands this file the submitted code and the device's coordinates, and
 * {@link checkIn} answers `{ status: 'locked', bothCheckedIn }` or throws the failure AAP 0.5.4
 * lists for that route, in that row's order: `403 not_participant`, `409 not_locked`,
 * `409 already_checked_in`, `410 outside_window`, `422 invalid_code`, `422 outside_geofence`.
 * Acceptance is the conjunction of AAP 0.5.7 — a `locked` meetup, the window from
 * `CHECK_IN_OPENS_BEFORE_MINUTES` (15) before the start to `CHECK_IN_CLOSES_AFTER_MINUTES` (45)
 * after it, a distance of at most `GEOFENCE_METERS` (150) metres from the venue, and a code the
 * venue displayed within `CODE_TOLERANCE_STEPS` (1) step of the server clock — and every term is
 * judged from the `now` the route stamped the request with. No device-supplied instant is read: the
 * console renders the code `consoles/routes.ts` derives, so a skewed device clock moves a countdown
 * and never an acceptance (AAP 0.5.7, 0.7.3, 0.12.2).
 *
 * **The stored row holds no coordinates (AAP 0.5.2, 0.12.2).** `lat` and `lng` are bound parameters
 * of the one `ST_Distance` query `distanceFrom` runs, and that is all they are: never a column
 * value, never part of an outbox payload, an analytics prop or a notification, never a log field.
 * What a check-in stores is its result, the {@link distanceBucketFor} bucket and the failure code —
 * `check-in.test.ts` asserts exactly that set. The one log line per attempt carries the meetup, the
 * result and, on a refusal, the failure code.
 *
 * **One transaction, fenced on the caller (AAP 0.3.2, 0.5.3).** The whole evaluation runs inside a
 * single `transact` with `fenceUserId`, so it serializes against `DELETE /me`, and inside it takes
 * {@link lockMeetup} first, which serializes it against settlement, a cancellation, a block, a
 * dispute and the hold-loss webhook: the second of two racing actions reads the first one's
 * committed row rather than a status it read earlier. The transaction resolves with a
 * {@link CheckInOutcome} value instead of throwing a refusal, because the two `422`s below still
 * write a `fail` row and a throw would roll it back; only a refusal that owes no row is thrown from
 * inside.
 *
 * **`bothCheckedIn` does not wait for settlement (AAP 0.5.7).** The transaction storing the second
 * `pass` sets `Meetup.bothCheckedInAt` and emits the funnel stage `both_checked_in`, in the same
 * transaction as the row it counts, so a later dispute, a `no_fault` resolution or a hold loss
 * neither delays nor removes it; settlement reads the `pass` rows alone.
 *
 * A leaf of the module graph: it imports the meetup row lock and read helpers, the code and secret
 * helpers, the outbox, analytics and notification writers, and the shared constants — no handler,
 * and nothing under `payments/`, `settlement/`, `reputation/` or `messaging/`. No Redis, Stripe or
 * Twilio call runs anywhere here, and none may enter the transaction (AAP 0.3.2).
 *
 * @see AAP 0.5.7 for the check-in acceptance rule and the funnel stage it feeds, 0.5.4 for the
 *   route, its errors and their order, 0.5.2 for the `CheckIn` columns and the coordinates that are
 *   never among them, 0.5.3 for the row lock and the write fence, 0.11.1 for the log fields, and
 *   0.8.1 for this file.
 */

import {
  DISTANCE_BUCKET_SPLIT_METERS,
  GEOFENCE_METERS,
  type CheckInRequest,
  type CheckInResponse,
  type DistanceBucket,
} from '@tablemate/shared';
import { distanceFrom, isUniqueViolation, type DbTx } from '@tablemate/db';

import { AppError } from '../../plugins/errors.ts';
import { emit } from '../analytics/emit.ts';
import { venueSecretFor } from '../consoles/secrets.ts';
import { verifyCode } from '../consoles/totp.ts';
import { notify } from '../notifications/enqueue.ts';
import { transact } from '../outbox/write.ts';

import { isVisibleTo, isWithinCheckInWindow, participantRole } from './queries.ts';
import { lockMeetup } from './state-machine.ts';

import type { MeetupRow } from './queries.ts';

// Type-only, as everywhere on this branch: `app.ts` is the one declaration of the app's type, it is
// erased at compile time, and nothing of that module is read here at runtime.
import type { AppServices } from '../../app.ts';

/*
 * Constants (AAP 0.5.2, 0.5.7, 0.11.1)
 */

/**
 * The partial unique index that makes a second passing check-in a conflict:
 * `UNIQUE (meetup_id, user_id) WHERE result = 'pass'`, added by the init migration.
 *
 * `isUniqueViolation` names it, which is what turns the race two concurrent check-ins can lose into
 * `409 already_checked_in` rather than a `500 internal_error`.
 */
const CHECK_IN_PASS_INDEX = 'check_in_pass_key';

/** The event name every log line of this file carries (AAP 0.11.1). */
const CHECK_IN_EVENT = 'check_in';

/*
 * Outcomes (AAP 0.5.3, 0.5.4)
 */

/** The two refusals that store a `fail` row, and the codes the route answers them with (AAP 0.5.4). */
type CheckInRefusal = 'invalid_code' | 'outside_geofence';

/** A refused check-in, carried out of the transaction so the `fail` row it wrote commits first. */
interface CheckInRefusalOutcome {
  readonly kind: 'reject';
  readonly code: CheckInRefusal;
}

/** An accepted check-in, and whether the counterpart had already passed. */
interface CheckInPassOutcome {
  readonly kind: 'pass';
  readonly bothCheckedIn: boolean;
}

/**
 * What the check-in transaction resolves with.
 *
 * A value rather than a throw, because both refusals here also record a `fail` row: throwing inside
 * `transact`'s callback would roll that row back, and the row is the evidence that a check-in was
 * attempted from where the caller stood, which is what a settlement or a dispute review reads
 * (AAP 0.5.2). {@link checkIn} throws the refusal from `outcome.code` once the commit has happened.
 */
type CheckInOutcome = CheckInPassOutcome | CheckInRefusalOutcome;

/*
 * Pure helper (AAP 0.5.7)
 */

/**
 * The bucket a check-in's distance falls in: `lt_50` under {@link DISTANCE_BUCKET_SPLIT_METERS}
 * (50 m) and `m50_150` from there up to the {@link GEOFENCE_METERS} (150 m) geofence (AAP 0.5.7).
 *
 * Pure and exported so the boundary is unit-tested without a database. The bucket is the only
 * description of where a check-in was made that survives it: the coordinates themselves are never
 * stored (AAP 0.5.2, 0.12.2).
 *
 * @param meters - The distance from the venue, already known to be within the geofence.
 * @returns The bucket to store on the row.
 */
export function distanceBucketFor(meters: number): DistanceBucket {
  return meters < DISTANCE_BUCKET_SPLIT_METERS ? 'lt_50' : 'm50_150';
}

/*
 * Helpers of the transaction (AAP 0.5.2, 0.5.4, 0.5.7)
 */

/**
 * Stores a failing check-in and answers the refusal the route turns into its error reply.
 *
 * The row keeps the result, the failure code and a null bucket, and nothing else: neither the
 * submitted code nor the coordinates that produced the failure are on it (AAP 0.12.2). It is
 * written inside the caller's transaction precisely so that it commits even though {@link checkIn}
 * throws once that transaction has resolved.
 *
 * @param tx - The check-in transaction, holding the meetup row lock.
 * @param meetupId - The meetup the check-in was attempted for.
 * @param userId - The attendee who attempted it.
 * @param failureCode - Why it failed, and the code the route answers with.
 * @returns The refusal {@link checkIn} carries out of the transaction.
 */
async function recordFailure(
  tx: DbTx,
  meetupId: string,
  userId: string,
  failureCode: CheckInRefusal,
): Promise<CheckInRefusalOutcome> {
  await tx.checkIn.create({
    data: { meetupId, userId, result: 'fail', distanceBucket: null, failureCode },
  });

  return { kind: 'reject', code: failureCode };
}

/**
 * Writes the funnel stage that the second passing check-in produces, with the meetup's city
 * (AAP 0.5.7).
 *
 * `both_checked_in` is a funnel stage, so `emit` takes its `variant` and `assignmentId` columns from
 * the attendee's stored assignment and overrides whatever props are passed; the meetup's own
 * `variantPairing` and `depositCents` are what this call adds, which is what lets the dashboard
 * attribute the stage once per meetup. The venue's `cityId` is read here rather than on the first
 * check-in, because this stage is the only line of the two that carries a city.
 *
 * @param tx - The check-in transaction, holding the meetup row lock.
 * @param services - The configuration, clock and logger `emit` needs.
 * @param meetup - The locked meetup row, for its own variant pairing, deposit and venue.
 * @param userId - The attendee whose second pass this is: the stage's actor.
 */
async function emitBothCheckedIn(
  tx: DbTx,
  services: Pick<AppServices, 'env' | 'clock' | 'logger'>,
  meetup: MeetupRow,
  userId: string,
): Promise<void> {
  const venue = await tx.venue.findUnique({
    where: { id: meetup.venueId },
    select: { cityId: true },
  });

  // Spread rather than passed as `undefined` (`exactOptionalPropertyTypes`), so a venue the fixture
  // guard hides leaves the column null instead of throwing on the way in.
  await emit(tx, services, 'both_checked_in', userId, {
    ...(venue === null ? {} : { cityId: venue.cityId }),
    meetupId: meetup.id,
    props: { variantPairing: meetup.variantPairing, depositCents: meetup.depositCents },
  });
}

/*
 * The route (AAP 0.5.4, 0.5.7)
 */

/**
 * Evaluate one witnessed check-in and record it (AAP 0.5.4, 0.5.7).
 *
 * The guards run in the order the contract lists them, so a request that breaks two rules is
 * answered with the first: `404 meetup_not_found`, `403 not_participant`, `409 not_locked`,
 * `409 already_checked_in`, `410 outside_window`, `422 invalid_code`, `422 outside_geofence`. The
 * first five owe no row and are thrown from inside the transaction; the two `422`s store a `fail`
 * row, so they leave the transaction as a refusal and are thrown only after it has committed.
 *
 * Either attendee may check in first, and only to their own meetup. A proposal the recipient cannot
 * see yet is answered exactly like a meetup that does not exist, as everywhere else in this module.
 * An open dispute does not block a check-in: a dispute leaves the meetup `locked` precisely so both
 * attendees can still check in inside the window (AAP 0.5.3).
 *
 * On acceptance the transaction stores the `pass` row with its bucket, sets `Meetup.bothCheckedInAt`
 * and emits `both_checked_in` when the counterpart has already passed, and notifies the counterpart
 * — the only notification this route produces. Two concurrent passes race on `check_in_pass_key`,
 * and the loser is answered `409 already_checked_in`.
 *
 * @param services - The app's services: the guarded client, the injected clock and logger, the
 *   configuration the geofence query reads `APP_ENV` from, the keyring that opens the venue's
 *   secret, and the outbox dispatcher the notification row commits through.
 * @param userId - The authenticated caller, who must be one of the meetup's two attendees.
 * @param meetupId - The meetup being checked in to.
 * @param body - The validated `CheckInRequest`: the submitted code and the device's coordinates.
 * @param now - The server instant the request arrived at, `request.receivedAt`.
 * @returns The meetup's status, still `locked` inside the window, and whether both pass check-ins
 *   now exist.
 * @throws AppError One of the seven codes above.
 * @see AAP 0.5.7 for the acceptance rule, 0.5.4 for the route and its error order, 0.5.3 for the
 *   lock, the fence and the dispute rule, 0.12.2 for the coordinates that are used and never stored.
 */
export async function checkIn(
  services: AppServices,
  userId: string,
  meetupId: string,
  body: CheckInRequest,
  now: Date,
): Promise<CheckInResponse> {
  const outcome = await transact(
    services,
    async (tx): Promise<CheckInOutcome> => {
      // 1. The row lock, then the caller's place in the meetup (AAP 0.5.3, 0.5.4).
      const meetup = await lockMeetup(tx, meetupId);
      if (meetup === null) {
        throw new AppError('meetup_not_found');
      }

      const role = participantRole(meetup, userId);
      if (role === null || !isVisibleTo(meetup, userId)) {
        throw new AppError('not_participant');
      }

      // 2. Only a locked meetup can be checked in to, and only once per attendee (AAP 0.5.4).
      if (meetup.status !== 'locked') {
        throw new AppError('not_locked');
      }

      const mine = await tx.checkIn.findFirst({
        where: { meetupId, userId, result: 'pass' },
        select: { id: true },
      });
      if (mine !== null) {
        throw new AppError('already_checked_in');
      }

      // 3. The window, measured from the server clock alone (AAP 0.5.7), inclusive at both ends.
      if (!isWithinCheckInWindow(now, meetup.startsAt)) {
        throw new AppError('outside_window');
      }

      // 4. The venue's rotating code. A venue with no issued secret can never yield a valid one
      //    (AAP 0.5.4), and `verifyCode` accepts only the counters one step either side of `now`.
      const secret = await venueSecretFor(services, meetup.venueId, tx);
      if (secret === null || !verifyCode(secret, body.code.trim(), now)) {
        return recordFailure(tx, meetupId, userId, 'invalid_code');
      }

      // 5. The geofence. The coordinates are bound parameters of this statement and of nothing else
      //    (AAP 0.5.7, 0.12.2); a null distance means the venue has no location to measure from.
      const meters = await distanceFrom(
        tx,
        'venue',
        meetup.venueId,
        { lat: body.lat, lng: body.lng },
        services.env.APP_ENV,
      );
      if (meters === null || meters > GEOFENCE_METERS) {
        return recordFailure(tx, meetupId, userId, 'outside_geofence');
      }

      // 6. The pass itself: only the result and the bucket are stored, never the distance itself.
      try {
        await tx.checkIn.create({
          data: {
            meetupId,
            userId,
            result: 'pass',
            distanceBucket: distanceBucketFor(meters),
            failureCode: null,
          },
        });
      } catch (error) {
        // The only way this insert can collide is the partial unique index on a second pass, so a
        // match is the concurrent duplicate rather than a defect (AAP 0.5.4).
        if (isUniqueViolation(error, CHECK_IN_PASS_INDEX)) {
          throw new AppError('already_checked_in');
        }
        throw error;
      }

      const counterpartId = role === 'initiator' ? meetup.recipientId : meetup.initiatorId;
      const counterpart = await tx.checkIn.findFirst({
        where: { meetupId, userId: counterpartId, result: 'pass' },
        select: { id: true },
      });
      const bothCheckedIn = counterpart !== null;

      if (bothCheckedIn && meetup.bothCheckedInAt === null) {
        await tx.meetup.update({ where: { id: meetupId }, data: { bothCheckedInAt: now } });
        await emitBothCheckedIn(tx, services, meetup, userId);
      }

      await notify(tx, counterpartId, 'counterpart_checked_in', { meetupId });

      return { kind: 'pass', bothCheckedIn };
    },
    { fenceUserId: userId },
  );

  if (outcome.kind === 'reject') {
    services.logger.info(
      { event: CHECK_IN_EVENT, meetupId, result: 'fail', failureCode: outcome.code },
      CHECK_IN_EVENT,
    );
    throw new AppError(outcome.code);
  }

  services.logger.info({ event: CHECK_IN_EVENT, meetupId, result: 'pass' }, CHECK_IN_EVENT);

  return { status: 'locked', bothCheckedIn: outcome.bothCheckedIn };
}
