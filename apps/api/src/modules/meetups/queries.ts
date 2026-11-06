/**
 * The meetup reads: the row loaders, the `MeetupDto` builder and the own-meetups list
 * (AAP 0.5.1, 0.5.3, 0.5.4).
 *
 * Three things live here, and every meetup route reaches at least one of them:
 *
 * - {@link loadMeetup} and {@link loadForParticipant} answer "which meetup is this, and what may
 *   this caller see of it". A proposal is invisible to its recipient until the initiator's hold is
 *   held, so {@link isVisibleTo} is what answers a not-yet-visible proposal exactly like a meetup
 *   that does not exist.
 * - {@link toMeetupDtos} turns rows into `MeetupDto`s a page at a time, over a fixed set of queries:
 *   each field is copied from an allowlist, the counterpart is serialized at the caller's disclosure
 *   tier, and no DTO can carry a client secret, a PaymentIntent id or a field above that tier
 *   (AAP 0.5.4, criterion 5).
 * - {@link listMeetups} is the additive `GET /meetups?role=&status=&cursor=` read, newest first over
 *   an opaque keyset cursor (AAP 0.5.4).
 *
 * The pure helpers are exported and shared with the handlers: `check-in.ts` asks
 * {@link isWithinCheckInWindow} for its `410 outside_window` and `cancel.ts` asks
 * {@link lateCancelFrom} for the free-cancellation boundary, so the `nextAction` a screen renders
 * and the route that acts on it turn over at the same instant (AAP 0.5.3, 0.5.4).
 *
 * A leaf of the module graph. The only module files it imports are `users/disclosure/serialize.ts`
 * and `payments/holds.ts`; it imports no handler, no `state-machine.ts`, no `payments/operations.ts`
 * and nothing under `settlement/`, `outbox/`, `analytics/` or `notifications/`, because those import
 * this file (AAP 0.5.1).
 *
 * Nothing here locks or mutates, and nothing reads the clock: the instant every rule is judged at
 * arrives as the `now` argument, and a handler about to change a meetup re-reads it under the row
 * lock taken by `meetups/state-machine.ts` (AAP 0.5.3, 0.11.1).
 *
 * @see AAP 0.5.3 for the meetup lifecycle, the visibility of a proposal and the two-hour
 *   late-cancellation boundary; 0.5.4 for `MeetupDto`, its `nextAction` values and the two reads;
 *   0.5.7 for the tier rules and the check-in window; 0.11.1 for the injected clock; 0.8.1 for this
 *   file.
 */

import {
  CHECK_IN_CLOSES_AFTER_MINUTES,
  CHECK_IN_OPENS_BEFORE_MINUTES,
  CURSOR_INSTANT_FORMAT,
  decodeKeysetCursor,
  encodeKeysetCursor,
  HOUR_MS,
  LATE_CANCEL_WINDOW_HOURS,
  MINUTE_MS,
  PAGE_SIZE,
  Tier0Profile,
} from '@tablemate/shared';
import type {
  AnyTierProfile,
  LatLng,
  MeetupDto,
  MeetupListQuery,
  MeetupListResponse,
  MeetupStatus,
  NextAction,
  ParticipantRole,
  VenueDto,
} from '@tablemate/shared';
import { readPoints } from '@tablemate/db';
import type { DbClient, DbTx, Deposit, Meetup, Prisma } from '@tablemate/db';

import { AppError } from '../../plugins/errors.ts';
import { holdView } from '../payments/holds.ts';
import { loadProfiles } from '../users/disclosure/serialize.ts';
import type { LoadedProfile } from '../users/disclosure/serialize.ts';

import type { AppServices } from '../../app.ts';

/*
 * Types (AAP 0.5.2, 0.5.4)
 */

/** The Prisma `Meetup` row every read here loads. */
export type MeetupRow = Meetup;

/** The one column {@link computeNextAction} reads off a deposit: its current status (AAP 0.5.4). */
export type DepositLike = Pick<Deposit, 'status'>;

/** A meetup and the caller's own side of it, as the routes load one (AAP 0.5.4). */
export interface LoadedMeetup {
  /** The row, unlocked: a mutating handler re-reads it under the meetup row lock. */
  readonly meetup: MeetupRow;
  /** Which side of it the caller holds; never null, because the caller must be a participant. */
  readonly role: ParticipantRole;
}

/**
 * What {@link computeNextAction} is given: one meetup as the caller sees it (AAP 0.5.4).
 *
 * Kept as plain values rather than a row, so the five rules can be unit-tested without a database
 * and so a handler that already knows the pieces (a deposit it just moved, for instance) can ask
 * what the caller should do next without loading anything.
 */
export interface NextActionInput {
  /** The caller's side of the meetup. */
  readonly role: ParticipantRole;
  /** The meetup's current status. */
  readonly status: MeetupStatus;
  /** Whether the meetup is served to this caller at all, from {@link isVisibleTo}. */
  readonly visible: boolean;
  /** The instant the deadline and the check-in window are judged at, from the injected clock. */
  readonly now: Date;
  /** The meetup's start. */
  readonly startsAt: Date;
  /** The recipient's acceptance deadline, or null while the proposal is not yet visible. */
  readonly recipientDeadline: Date | null;
  /** The caller's own deposit, or null when that side has none. */
  readonly own: DepositLike | null;
  /** The initiator's deposit, whoever the caller is; null when it was never created. */
  readonly initiator: DepositLike | null;
  /** Whether the caller already holds a passing check-in. */
  readonly checkedIn: boolean;
}

/**
 * A decoded keyset cursor: the position one page ended at (AAP 0.5.4).
 *
 * `createdAt` is the stored timestamp as ISO 8601 text rather than a `Date`, because the column's
 * microseconds have to survive the round trip; see {@link exactCreatedAt} for why that matters to
 * the page that continues after it.
 */
export interface MeetupCursorPosition {
  /** The boundary row's `createdAt`, `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  readonly createdAt: string;
  /** The boundary row's id, the tie-break for rows sharing that timestamp. */
  readonly id: string;
}

/*
 * Pure helpers (AAP 0.5.3, 0.5.4, 0.5.7)
 */

/**
 * Which side of `meetup` `userId` holds, or null when the caller is not a participant (AAP 0.5.4).
 *
 * Both ids are lowercased before they are compared, as the disclosure layer's own self check does:
 * the same uuid can arrive from a path, a token claim or a stored row, and none of them decides the
 * comparison.
 */
export function participantRole(
  meetup: Pick<MeetupRow, 'initiatorId' | 'recipientId'>,
  userId: string,
): ParticipantRole | null {
  const wanted = userId.toLowerCase();

  if (meetup.initiatorId.toLowerCase() === wanted) {
    return 'initiator';
  }
  if (meetup.recipientId.toLowerCase() === wanted) {
    return 'recipient';
  }
  return null;
}

/**
 * Whether `meetup` may be served to `userId` at all (AAP 0.5.3).
 *
 * The initiator sees their own proposal from the moment it exists. The recipient sees nothing until
 * the initiator's hold is held, which is the transition that sets `proposalVisibleAt`. A
 * non-participant is never served it.
 */
export function isVisibleTo(
  meetup: Pick<MeetupRow, 'initiatorId' | 'recipientId' | 'proposalVisibleAt'>,
  userId: string,
): boolean {
  const role = participantRole(meetup, userId);

  if (role === 'initiator') {
    return true;
  }
  return role === 'recipient' && meetup.proposalVisibleAt !== null;
}

/**
 * The instant a cancellation stops being free: `startsAt - LATE_CANCEL_WINDOW_HOURS` (AAP 0.5.3).
 *
 * At that instant a cancellation is still free; one second later it forfeits the canceller's hold,
 * which is the boundary `cancel.ts` and `MeetupDto.lateCancelFrom` both read (AAP 0.5.4).
 */
export function lateCancelFrom(startsAt: Date): Date {
  return new Date(startsAt.getTime() - LATE_CANCEL_WINDOW_HOURS * HOUR_MS);
}

/**
 * Whether `now` falls inside the check-in window (AAP 0.5.7).
 *
 * From `CHECK_IN_OPENS_BEFORE_MINUTES` (15) before the start to `CHECK_IN_CLOSES_AFTER_MINUTES` (45)
 * after it, both ends inclusive. `check-in.ts` asks this same function for its `410 outside_window`,
 * so `nextAction: check_in` and the route the client then calls agree on the boundary.
 */
export function isWithinCheckInWindow(now: Date, startsAt: Date): boolean {
  return (
    now.getTime() >= startsAt.getTime() - CHECK_IN_OPENS_BEFORE_MINUTES * MINUTE_MS &&
    now.getTime() <= startsAt.getTime() + CHECK_IN_CLOSES_AFTER_MINUTES * MINUTE_MS
  );
}

/**
 * The one thing the caller can usefully do next with this meetup (AAP 0.5.4).
 *
 * Pure, so the rules are unit-testable without a database, and stated once so the proposal screen,
 * the meetup screen and every client rendering a button agree. The first matching rule wins:
 *
 * 1. `confirm_hold` — the meetup is `proposed` and the caller's own deposit is `requires_action`,
 *    the state a card authentication left behind. The client repeats accept (recipient) or hold
 *    (initiator), and receives its own current attempt's client secret, which is why no DTO carries
 *    one.
 * 2. `retry_hold` — the caller is the initiator, the meetup is `proposed` and the initiator's deposit
 *    is `failed`, the state a declined card leaves. The retry is `POST /meetups/:id/hold`.
 * 3. `accept` — the caller is the recipient of a visible proposal whose deadline has not passed and
 *    holds no deposit yet (absent or `failed`). A proposal past its deadline is left to lapse.
 * 4. `check_in` — the meetup is `locked`, the window is open and the caller has no passing check-in.
 * 5. `none` — nothing to do: an invisible proposal, a settled meetup, a deposit being recovered, or a
 *    check-in already recorded.
 */
export function computeNextAction(input: NextActionInput): NextAction {
  const own = input.own?.status ?? null;

  if (input.status === 'proposed' && own === 'requires_action') {
    return 'confirm_hold';
  }

  if (
    input.role === 'initiator' &&
    input.status === 'proposed' &&
    input.initiator?.status === 'failed'
  ) {
    return 'retry_hold';
  }

  if (
    input.role === 'recipient' &&
    input.status === 'proposed' &&
    input.visible &&
    input.recipientDeadline !== null &&
    input.now.getTime() < input.recipientDeadline.getTime() &&
    (own === null || own === 'failed')
  ) {
    return 'accept';
  }

  if (
    input.status === 'locked' &&
    !input.checkedIn &&
    isWithinCheckInWindow(input.now, input.startsAt)
  ) {
    return 'check_in';
  }

  return 'none';
}

/*
 * Loaders (AAP 0.5.4)
 */

/**
 * One meetup by id, or null when no such row exists.
 *
 * This read takes no lock and applies no participant check: it is for building a response. A handler
 * about to change the meetup re-reads it under `lockMeetup` in `meetups/state-machine.ts`, which is
 * the transaction every meetup transition is serialized on (AAP 0.5.3).
 *
 * @param db - The guarded client, or the client of a transaction the caller is already in.
 * @param id - The meetup's id.
 * @returns The row, or null when there is none.
 */
export async function loadMeetup(db: DbClient | DbTx, id: string): Promise<MeetupRow | null> {
  return db.meetup.findUnique({ where: { id } });
}

/**
 * The meetup `userId` is a participant of, with the side they hold (AAP 0.5.4).
 *
 * The three refusals are ordered: an unknown id is `404 meetup_not_found`; a caller who is not on the
 * meetup is `403 not_participant`; and a recipient whose proposal is not visible yet is answered
 * `404 meetup_not_found` again, so the route cannot be used to probe whether a proposal exists or
 * whether the initiator's hold is still pending (AAP 0.5.3).
 *
 * No lock is taken, exactly as {@link loadMeetup}: this is the read a handler does before deciding,
 * and the decision itself runs under the meetup row lock.
 *
 * @param db - The guarded client, or the client of a transaction the caller is already in.
 * @param id - The meetup's id.
 * @param userId - The caller.
 * @returns The row and the caller's side of it.
 * @throws AppError `meetup_not_found` (404) or `not_participant` (403), as above.
 */
export async function loadForParticipant(
  db: DbClient | DbTx,
  id: string,
  userId: string,
): Promise<LoadedMeetup> {
  const meetup = await loadMeetup(db, id);

  if (meetup === null) {
    throw new AppError('meetup_not_found');
  }

  const role = participantRole(meetup, userId);

  if (role === null) {
    throw new AppError('not_participant');
  }

  if (!isVisibleTo(meetup, userId)) {
    throw new AppError('meetup_not_found');
  }

  return { meetup, role };
}

/*
 * The `MeetupDto` builder (AAP 0.5.4)
 */

/** The handle an erased counterpart is shown under. */
const DELETED_HANDLE = 'deleted-traveler';

/**
 * The avatar seed an erased counterpart is shown under: one fixed value, never derived from the id,
 * because a seed derived from the tombstone would let a client correlate it with a real seed.
 */
const DELETED_AVATAR_SEED = 'deleted-traveler';

/**
 * The tier-0 profile standing in for a counterpart whose account is gone (AAP 0.5.2, 0.5.4).
 *
 * A meetup outlives its participants' accounts: erasure leaves the user row as a tombstone with every
 * personal field nulled, and {@link loadProfile} answers null for it. `MeetupDto.counterpart` is
 * required, so this constant — the contract does not say what a client shows here, which makes it
 * this file's choice — keeps the caller's own meetup readable while disclosing nothing: the id is
 * the tombstone id the caller's meetup already references, and every other field is empty.
 */
function deletedTraveler(id: string): Tier0Profile {
  return Tier0Profile.parse({
    id,
    handle: DELETED_HANDLE,
    avatarSeed: DELETED_AVATAR_SEED,
    homeRegion: null,
    currentCityId: null,
    proofDates: null,
    reputation: {
      witnessedMeetups: 0,
      distinctCounterparts: 0,
      distinctVenues: 0,
      distinctCities: 0,
      noShows90d: 0,
    },
    interestTags: [],
  });
}

/**
 * The counterpart's profile at the caller's tier, or the tombstone above (AAP 0.5.4, 0.5.7).
 *
 * `counterpartProfile` serializes every counterpart from the batched read of the page, which runs all
 * three disclosure layers on its own: the pair's facts decide the tier, that tier's select loads only
 * its columns and its serializer builds the response, so the counterpart is exactly as disclosed as
 * `GET /users/:userId` would answer (criterion 5). `blocked: 'tier0'` is what keeps the caller's own
 * meetup readable when a block exists in either direction, at the minimum disclosure the contract
 * allows.
 */
function counterpartProfile(loaded: LoadedProfile | null, counterpartId: string): AnyTierProfile {
  return loaded?.profile ?? deletedTraveler(counterpartId);
}

/**
 * The venue columns `MeetupDto.venue` is built from (AAP 0.5.4).
 *
 * A venue carries the secret its console authenticates with, and a meetup read has no business
 * loading one: the select holds no secret column, so `secretLookupHash`, `secretCiphertext` and
 * `secretIssuedAt` never enter the process on this path. The coordinates are not in the select
 * either, because `location` is `Unsupported` in the schema and comes from the PostGIS helper.
 */
const MEETUP_VENUE_SELECT = {
  id: true,
  cityId: true,
  name: true,
  address: true,
  isActivePartner: true,
} as const satisfies Prisma.VenueSelect;

/** One row of {@link MEETUP_VENUE_SELECT}: the five columns above, and no secret (AAP 0.5.4). */
type MeetupVenueRow = Prisma.VenueGetPayload<{ select: typeof MEETUP_VENUE_SELECT }>;

/**
 * One venue as `MeetupDto.venue` carries it (AAP 0.5.4).
 *
 * The row it is handed holds only the five columns {@link MEETUP_VENUE_SELECT} names, which is what
 * keeps `secretLookupHash`, `secretCiphertext` and `secretIssuedAt` out of the process: a console
 * secret is shown once, by its issue route, and never loaded on a meetup read. `lat` and `lng` are
 * the venue's own place of business — what the client maps the meetup by and what the 150 m check-in
 * geofence is measured from (AAP 0.5.7) — never a user's coordinates.
 *
 * @throws Error when the venue carries no location, since the DTO's `lat`/`lng` are required.
 */
function venueDto(row: MeetupVenueRow, point: LatLng | undefined): VenueDto {
  if (point === undefined) {
    throw new Error('Meetup venue has no location to serialize.');
  }

  return {
    id: row.id,
    cityId: row.cityId,
    name: row.name,
    address: row.address,
    lat: point.lat,
    lng: point.lng,
    isActivePartner: row.isActivePartner,
  };
}

/**
 * The deposit columns a meetup page is built from (AAP 0.5.4).
 *
 * `meetupId` and `role` are the keys one side's deposit is filed under, and `status` is the whole of
 * what a `MeetupDto` reads off the row: `holdView` renders it and {@link computeNextAction} compares
 * it. The read therefore holds no amount, attempt counter, PaymentIntent id or capture instant.
 */
const MEETUP_DEPOSIT_SELECT = {
  meetupId: true,
  role: true,
  status: true,
} as const satisfies Prisma.DepositSelect;

/**
 * One row of {@link MEETUP_DEPOSIT_SELECT}: those three columns, which are all {@link DepositLike}
 * and {@link holdView} need.
 */
type MeetupDepositRow = Prisma.DepositGetPayload<{ select: typeof MEETUP_DEPOSIT_SELECT }>;

/** The key one side's deposit is filed under: a meetup has at most one deposit per side (AAP 0.5.2). */
function depositSide(meetupId: string, role: ParticipantRole): string {
  return `${meetupId}:${role}`;
}

/**
 * One page of `MeetupDto`s, in the order the rows arrived (AAP 0.5.4).
 *
 * The page costs a fixed number of queries however many rows it holds, and not one of them is issued
 * per row: the six reads of the `Promise.all` below — the deposits, the caller's passing check-ins,
 * the open disputes, the venues, the venue coordinates and the page's counterpart profiles — over one
 * pair-facts statement for every counterpart of the page, one `user` read per disclosure tier the
 * page actually holds (at most four, each carrying its own `selectForTier`), one reputation-counters
 * call and one current-proof read. A 20-meetup page therefore costs the same shape of work as a
 * single-row read, which is what lets the own-meetups list hold the read latency target (AAP 0.12.2).
 *
 * Each field comes from the allowlist below rather than from a spread row, and nothing a DTO carries
 * can be a secret: no client secret, PaymentIntent id or card detail is read here, and a caller
 * wanting to confirm its own hold repeats accept, as the recipient, or hold, as the initiator, and
 * receives the secret of its own current attempt (AAP 0.5.4).
 *
 * @param services - The database, the environment that decides fixture visibility, and the keyring,
 *   logger and clock the disclosure layer reads.
 * @param rows - The meetups to serialize; every one of them the viewer's own.
 * @param viewerId - The caller: `role` and `checkedIn` are theirs and their tier decides
 *   `counterpart`.
 * @param now - The instant the accept deadline and the check-in window are judged at, from the
 *   route's injected clock.
 * @returns One DTO per row, in input order; an empty page queries nothing.
 * @throws AppError `not_participant` (403) when a row does not include the viewer, which the routes
 *   reaching here have already refused.
 * @throws Error when a row's venue is missing from the guarded read or has no location: its
 *   `VenueDto` cannot be built, which is a defect on our side rather than the caller's.
 */
export async function toMeetupDtos(
  services: AppServices,
  rows: readonly MeetupRow[],
  viewerId: string,
  now: Date,
): Promise<MeetupDto[]> {
  if (rows.length === 0) {
    return [];
  }

  const prepared = rows.map((meetup) => {
    const role = participantRole(meetup, viewerId);

    if (role === null) {
      throw new AppError('not_participant');
    }

    return {
      meetup,
      role,
      counterpartId: role === 'initiator' ? meetup.recipientId : meetup.initiatorId,
    };
  });

  const meetupIds = prepared.map((entry) => entry.meetup.id);
  const venueIds = [...new Set(prepared.map((entry) => entry.meetup.venueId))];

  const [deposits, passedCheckIns, openDisputes, venues, points, profiles] = await Promise.all([
    services.db.deposit.findMany({
      where: { meetupId: { in: meetupIds } },
      select: MEETUP_DEPOSIT_SELECT,
    }),
    services.db.checkIn.findMany({
      where: { meetupId: { in: meetupIds }, userId: viewerId, result: 'pass' },
      select: { meetupId: true },
    }),
    services.db.dispute.findMany({
      where: { meetupId: { in: meetupIds }, status: 'open' },
      select: { meetupId: true },
    }),
    services.db.venue.findMany({
      where: { id: { in: venueIds } },
      select: MEETUP_VENUE_SELECT,
    }),
    readPoints(services.db, 'venue', venueIds, services.env.APP_ENV),
    loadProfiles(
      services,
      viewerId,
      prepared.map((entry) => entry.counterpartId),
      now,
      { blocked: 'tier0' },
    ),
  ]);

  const depositBySide = new Map<string, MeetupDepositRow>();
  for (const deposit of deposits) {
    depositBySide.set(depositSide(deposit.meetupId, deposit.role), deposit);
  }

  const checkedInIds = new Set(passedCheckIns.map((row) => row.meetupId));
  const disputeMeetupIds = new Set(openDisputes.map((row) => row.meetupId));
  const venueById = new Map(venues.map((venue) => [venue.id, venue]));

  return prepared.map((entry, index) => {
    const { meetup, role } = entry;

    const venue = venueById.get(meetup.venueId);
    if (venue === undefined) {
      throw new Error('Meetup venue is missing from the guarded read.');
    }

    const initiatorDeposit = depositBySide.get(depositSide(meetup.id, 'initiator')) ?? null;
    const recipientDeposit = depositBySide.get(depositSide(meetup.id, 'recipient')) ?? null;
    const own = role === 'initiator' ? initiatorDeposit : recipientDeposit;
    const checkedIn = checkedInIds.has(meetup.id);

    return {
      id: meetup.id,
      role,
      status: meetup.status,
      counterpart: counterpartProfile(profiles[index] ?? null, entry.counterpartId),
      venue: venueDto(venue, points.get(meetup.venueId)),
      startsAt: meetup.startsAt.toISOString(),
      depositCents: meetup.depositCents,
      recipientDeadline: meetup.recipientDeadline?.toISOString() ?? null,
      initiatorHold: holdView(initiatorDeposit),
      recipientHold: holdView(recipientDeposit),
      lateCancelFrom: lateCancelFrom(meetup.startsAt).toISOString(),
      checkedIn,
      disputeOpen: disputeMeetupIds.has(meetup.id),
      nextAction: computeNextAction({
        role,
        status: meetup.status,
        visible: isVisibleTo(meetup, viewerId),
        now,
        startsAt: meetup.startsAt,
        recipientDeadline: meetup.recipientDeadline,
        own,
        initiator: initiatorDeposit,
        checkedIn,
      }),
    };
  });
}

/**
 * One meetup as `MeetupDto`, for `GET /meetups/:id` (AAP 0.5.4).
 *
 * The single-row form of {@link toMeetupDtos}, with the same allowlist and the same queries; a route
 * that has already loaded the row with {@link loadForParticipant} uses this, so the detail read and
 * the list read cannot drift apart.
 */
export async function toMeetupDto(
  services: AppServices,
  row: MeetupRow,
  viewerId: string,
  now: Date,
): Promise<MeetupDto> {
  const [dto] = await toMeetupDtos(services, [row], viewerId, now);

  if (dto === undefined) {
    throw new Error('The meetup serializer returned no DTO for one row.');
  }

  return dto;
}

/*
 * Keyset cursor (AAP 0.5.4)
 */

/**
 * The exact stored `createdAt` of one meetup, as ISO 8601 in UTC.
 *
 * Why a string and not the row's own `Date`: Prisma answers a `timestamptz(6)` column as a `Date`,
 * which holds milliseconds, while a row written by the database's `CURRENT_TIMESTAMP` default — as a
 * raw-SQL insert does — keeps microseconds. A cursor built from a truncated value would make the
 * equality branch of {@link afterCursor} unable to match the boundary row at all, and every row
 * sharing its millisecond would be dropped from the middle of the list: exactly the case a page
 * boundary meets when several meetups were written in one statement. PostgreSQL therefore formats the
 * value with {@link CURSOR_INSTANT_FORMAT}, the one rendering the shared codec's instant accepts and
 * the next page's bound is compared as, and Prisma receives it back as the ISO string its `DateTime`
 * filters accept (AAP 0.5.4).
 *
 * @param db - The guarded client; a page is built outside any transaction.
 * @param id - The boundary row's id.
 * @returns Its `createdAt`, `YYYY-MM-DDTHH:MM:SS.ffffffZ`.
 * @throws Error when the row is gone, which no request in the pilot can cause and which leaves no
 *   cursor to continue from.
 */
async function exactCreatedAt(db: DbClient | DbTx, id: string): Promise<string> {
  const rows = await db.$queryRaw<{ exact: string }[]>`
    SELECT to_char("created_at" AT TIME ZONE 'UTC', ${CURSOR_INSTANT_FORMAT}) AS "exact"
      FROM "meetup"
     WHERE "id" = ${id}::uuid
  `;

  const exact = rows[0]?.exact;

  if (exact === undefined) {
    throw new Error('The meetup a page ended on is no longer there.');
  }

  return exact;
}

/**
 * Encodes a keyset cursor as the shared codec's opaque wire form (AAP 0.5.4).
 *
 * The cursor is opaque: the client echoes it back unchanged, and `MeetupListQuery.cursor` accepts it
 * as a bounded string. Encoding goes through `@tablemate/shared`'s `encodeKeysetCursor`, so a position
 * the codec could not read back is never issued, and this reader writes the same bytes as the
 * discovery and messaging readers (AAP 0.11.1).
 *
 * @param position - The boundary row's exact `createdAt` and its id.
 * @returns The encoded cursor.
 */
export function encodeMeetupCursor(position: MeetupCursorPosition): string {
  return encodeKeysetCursor(position);
}

/**
 * Decodes a cursor this file issued (AAP 0.5.4).
 *
 * A cursor is a value the client sends back, so the shared codec parses it strictly: canonical
 * base64url of a `{t,i}` JSON payload that its `KeysetCursor` accepts — an instant in exactly the form
 * {@link CURSOR_INSTANT_FORMAT} writes, and a UUID — and nothing else.
 *
 * @param value - The `cursor` query parameter.
 * @returns The position it names.
 * @throws AppError `invalid_field` (400) for anything else, which is the contract's answer for a
 *   malformed cursor (AAP 0.5.4).
 */
export function decodeMeetupCursor(value: string): MeetupCursorPosition {
  const position = decodeKeysetCursor(value);

  if (position === null) {
    throw new AppError('invalid_field', 'The cursor is malformed.');
  }

  return position;
}

/*
 * The own-meetups list (AAP 0.5.4)
 */

/**
 * The visibility half of the list's filter (AAP 0.5.3, 0.5.4).
 *
 * `role` selects the caller's own side of the meetup, not the counterpart's. With no role the
 * caller's meetups are the ones they initiated plus the ones they received and that are visible: the
 * `proposalVisibleAt IS NOT NULL` test is what keeps an initiator's not-yet-held proposal out of the
 * recipient's list until that hold is held.
 */
function visibilityFilter(
  viewerId: string,
  role: ParticipantRole | undefined,
): Prisma.MeetupWhereInput {
  if (role === 'initiator') {
    return { initiatorId: viewerId };
  }

  if (role === 'recipient') {
    return { recipientId: viewerId, proposalVisibleAt: { not: null } };
  }

  return {
    OR: [{ initiatorId: viewerId }, { recipientId: viewerId, proposalVisibleAt: { not: null } }],
  };
}

/**
 * The keyset half: every row ordered after the boundary by `(createdAt desc, id desc)` (AAP 0.5.4).
 *
 * The tie-break on the id is load-bearing rather than decorative: rows written in one statement
 * share one `createdAt`, so a page can end in the middle of a group of equal timestamps and the id
 * order is what continues it.
 */
function afterCursor(cursor: MeetupCursorPosition): Prisma.MeetupWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/**
 * The cursor for the page that ended at `boundary`, or null when that page was the last one.
 *
 * The exact timestamp is read only when another page follows, so a short list costs nothing extra.
 */
async function nextCursorAfter(
  db: DbClient | DbTx,
  boundary: MeetupRow | undefined,
): Promise<string | null> {
  if (boundary === undefined) {
    return null;
  }

  return encodeMeetupCursor({ createdAt: await exactCreatedAt(db, boundary.id), id: boundary.id });
}

/**
 * One page of the caller's meetups, newest first (AAP 0.5.4).
 *
 * The additive `GET /meetups?role=&status=&cursor=` read. The query arrives already parsed by the
 * route's strict shared schema, so an unknown filter or a bad enum is `400 invalid_field` before this
 * function runs; a malformed `cursor` is the one thing that is refused here, by
 * {@link decodeMeetupCursor}.
 *
 * `PAGE_SIZE + 1` rows are read so the presence of a next page is known without a second count, and
 * a page holds at most `PAGE_SIZE` (20) of them. Ordering is `(createdAt desc, id desc)`, which the
 * matching partial index on the caller's own column serves, and the cursor continues exactly where
 * the last row ended.
 *
 * A `status` filter is what lets the client recover its proposal id after a `402 hold_failed`:
 * `?role=initiator&status=proposed` holds at most one meetup per pair, because the open-meetup index
 * allows no more (AAP 0.5.4).
 *
 * @param services - The database and the clock, environment and keyring the serializer reads.
 * @param viewerId - The caller.
 * @param query - The parsed query string: `role`, `status` and `cursor`, each optional.
 * @param now - The instant the serializer judges the accept deadline and the check-in window at.
 * @returns The page and the cursor that continues it, null on the last page.
 * @throws AppError `invalid_field` (400) for a malformed cursor.
 */
export async function listMeetups(
  services: AppServices,
  viewerId: string,
  query: MeetupListQuery,
  now: Date,
): Promise<MeetupListResponse> {
  const cursor = query.cursor === undefined ? null : decodeMeetupCursor(query.cursor);

  const filters: Prisma.MeetupWhereInput[] = [visibilityFilter(viewerId, query.role)];

  if (query.status !== undefined) {
    filters.push({ status: query.status });
  }

  if (cursor !== null) {
    filters.push(afterCursor(cursor));
  }

  const rows = await services.db.meetup.findMany({
    where: { AND: filters },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE + 1,
  });

  const page = rows.slice(0, PAGE_SIZE);
  const boundary = rows.length > PAGE_SIZE ? page[page.length - 1] : undefined;

  const [items, nextCursor] = await Promise.all([
    toMeetupDtos(services, page, viewerId, now),
    nextCursorAfter(services.db, boundary),
  ]);

  return { items, nextCursor };
}
