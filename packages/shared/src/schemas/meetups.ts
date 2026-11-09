/**
 * The meetups contract (AAP 0.8.1): the request and response schemas of the proposal, acceptance,
 * commitment-lock, cancellation, check-in and dispute routes, and of the two meetup reads (AAP 0.5.4).
 *
 * It carries `POST /meetups`, `/meetups/:id/accept`, `/decline`, `/cancel`, `/hold`, `/check-in`
 * and `/dispute`, plus the additive `GET /meetups?role=&status=&cursor=` and `GET /meetups/:id`.
 * Every status here comes from the one transition table in
 * `apps/api/src/modules/meetups/state-machine.ts` (AAP 0.5.3), never from a handler's own idea of where
 * a meetup may go.
 *
 * A request body or query is a `z.strictObject`, so an unknown key or an invalid filter is answered
 * `400 invalid_field` rather than ignored; a response is a strip-mode `z.object`, so a field a newer
 * API adds is dropped instead of fatal on an older client, and no DTO is a spread of a Prisma row —
 * each is built from an allowlist, one of the three layers that keep a field above a viewer's
 * disclosure tier from leaving the server (criterion 5).
 *
 * Where AAP 0.5.4 assigns a value's own error code — a deposit outside `DEPOSIT_LEVELS_CENTS`, a start
 * outside the five-day horizon, a proposal to oneself, a malformed check-in code — the schema accepts
 * the wider type and the handler applies that code, so a route keeps the AAP's error order rather than
 * answering `400 invalid_field` in front of its own checks.
 *
 * Client-safe: `zod`, the shared primitives, the domain enums and two sibling DTO modules, with no Node
 * built-in, no DOM global and no top-level side effect, because `apps/mobile` types its API client from
 * these schemas (AAP 0.11.1).
 */
import { z } from 'zod';

import { REASON_MAX_CHARS } from '../constants.ts';
import { DisputeKind, HoldView, MeetupStatus, NextAction, ParticipantRole } from '../enums.ts';
import { VenueDto } from './cities.ts';
import { Cursor, IsoDateTime, Latitude, Longitude, Uuid, UsdCents, paginated } from './common.ts';
import { AnyTierProfile } from './users.ts';

/**
 * The body of `POST /meetups`: the handler applies this route's guards in the AAP's order, each with its
 * own code — `recipientId` equal to the caller is `422 self_proposal`, checked before any meetup or hold
 * exists; a `startsAt` in the past or more than `START_HORIZON_DAYS` (5) days away is
 * `422 starts_at_invalid`; a `depositCents` outside `DEPOSIT_LEVELS_CENTS` (500, 1000, 2000) is
 * `422 deposit_invalid`. `depositCents` therefore accepts any integer here and the handler answers for
 * the value it was given. Deposits are always charged in USD (AAP 0.7.3).
 */
export const ProposeMeetup = z.strictObject({
  recipientId: Uuid,
  venueId: Uuid,
  startsAt: IsoDateTime,
  depositCents: z.number().int(),
});
export type ProposeMeetup = z.infer<typeof ProposeMeetup>;

/**
 * The `201` body of `POST /meetups`. `clientSecret` belongs to the caller's own hold attempt, for the
 * client to confirm behind the Payment Sheet or the Payment Element; the proposal stays invisible to
 * the recipient until that hold is held (AAP 0.5.3). A `402 hold_failed` answer carries no meetup id,
 * so the initiator recovers it from `GET /meetups?role=initiator&status=proposed` and retries through
 * `POST /meetups/:id/hold` (AAP 0.5.4).
 */
export const ProposeResponse = z.object({
  meetupId: Uuid,
  status: z.literal('proposed'),
  clientSecret: z.string(),
});
export type ProposeResponse = z.infer<typeof ProposeResponse>;

/**
 * The `200` body of `POST /meetups/:id/accept`. `status` is `locked` when the recipient's hold
 * authorizes without customer action and `proposed` while 3-D Secure is still pending, so a client is
 * never told a meetup is locked before the money decision is durable. A repeated accept while the
 * recipient's current attempt is `requires_action` returns that same attempt's `clientSecret` and
 * creates no new authorization, and the secret is always the caller's own (AAP 0.5.4).
 */
export const AcceptResponse = z.object({
  status: z.enum(['locked', 'proposed']),
  clientSecret: z.string(),
});
export type AcceptResponse = z.infer<typeof AcceptResponse>;

/**
 * The `200` body of `POST /meetups/:id/decline`: the recipient refuses a proposal that is still
 * `proposed`, which releases every non-final deposit attempt and notifies the initiator (AAP 0.5.3).
 */
export const DeclineResponse = z.object({ status: z.literal('declined') });
export type DeclineResponse = z.infer<typeof DeclineResponse>;

/**
 * The `200` body of `POST /meetups/:id/cancel`. `lateCancel` is false for a free cancellation, at or
 * before `startsAt - 2 h`, and true one second later, which forfeits the canceller's hold through the
 * recoverable settlement of AAP 0.3.2 and credits the counterpart with Table Credit equal to the
 * deposit. Both sides are notified either way (AAP 0.5.3).
 */
export const CancelResponse = z.object({ lateCancel: z.boolean() });
export type CancelResponse = z.infer<typeof CancelResponse>;

/**
 * The `200` body of the additive `POST /meetups/:id/hold`, which retries the initiator's failed hold
 * (AAP 0.5.4). The route is authorized for the meetup's initiator alone, so a recipient is answered
 * `403 not_initiator`; while the initiator's current attempt is `requires_action` it returns that
 * attempt's `clientSecret` and creates no new authorization, which is how a client recovers after an
 * app restart during 3-D Secure. `initiatorHold` reports the caller-visible state the retry left.
 */
export const HoldRetryResponse = z.object({
  status: z.literal('proposed'),
  initiatorHold: HoldView,
  clientSecret: z.string(),
});
export type HoldRetryResponse = z.infer<typeof HoldRetryResponse>;

/**
 * The body of `POST /meetups/:id/check-in`.
 *
 * `code` accepts a 1-16 character string rather than a six-digit pattern deliberately: this route fixes
 * its failures in the AAP's order — `403 not_participant`, `409 not_locked` or `already_checked_in`,
 * `410 outside_window`, `422 invalid_code`, `422 outside_geofence` — and a wrong code is
 * `422 invalid_code`, which a schema regex would pre-empt with `400 invalid_field`. The handler trims
 * the value, requires the `CODE_DIGITS` (6) digits the venue console displays, and verifies the
 * server-derived code with the `CODE_TOLERANCE_STEPS` (1) step of tolerance around the current counter,
 * so a device-supplied time never decides acceptance (AAP 0.5.7).
 *
 * `lat` and `lng` are used only for the `GEOFENCE_METERS` (150 m) test and are never persisted or
 * logged: the stored check-in keeps the result and the distance bucket alone (AAP 0.12.2).
 */
export const CheckInRequest = z.strictObject({
  code: z.string().min(1).max(16),
  lat: Latitude,
  lng: Longitude,
});
export type CheckInRequest = z.infer<typeof CheckInRequest>;

/**
 * The `200` body of `POST /meetups/:id/check-in`. `bothCheckedIn` mirrors `Meetup.bothCheckedInAt`,
 * which the transaction storing the second pass check-in sets, so it does not depend on settlement: an
 * open dispute, a `no_fault` resolution or a later hold loss neither delays nor removes it (AAP 0.5.7).
 */
export const CheckInResponse = z.object({
  status: MeetupStatus,
  bothCheckedIn: z.boolean(),
});
export type CheckInResponse = z.infer<typeof CheckInResponse>;

/**
 * The body of `POST /meetups/:id/dispute`, which answers `201`.
 *
 * `kind` is the pilot's addition to the contract's free-text body: it is how the penalty-free
 * `venue_unavailable` case is marked, since a phrase inside `reason` cannot do that reliably. It
 * defaults to `other`, so the contract's own `{ reason }` body still parses unchanged. The handler
 * answers `403 not_participant`, `409 not_locked` for a meetup that is still `proposed`,
 * `409 dispute_window_closed` later than `DISPUTE_FILING_WINDOW_HOURS` (24) hours after the start, and
 * `409 dispute_open` while a dispute is already open (AAP 0.5.4); the meetup stays `locked` while the
 * dispute gates settlement, so both attendees can still check in (AAP 0.5.3).
 */
export const DisputeRequest = z.strictObject({
  reason: z.string().trim().min(1).max(REASON_MAX_CHARS),
  kind: DisputeKind.default('other'),
});
export type DisputeRequest = z.infer<typeof DisputeRequest>;

/** The `201` body of `POST /meetups/:id/dispute` (AAP 0.5.4). */
export const DisputeResponse = z.object({ disputeId: Uuid });
export type DisputeResponse = z.infer<typeof DisputeResponse>;

/**
 * The query string of the additive `GET /meetups`, paged at `PAGE_SIZE` (20) items per page over a
 * keyset cursor (AAP 0.5.4). Both filters are closed enums, so an invalid one is `400 invalid_field`;
 * absent means every meetup the caller is part of, and `role` selects the caller's own side.
 */
export const MeetupListQuery = z.strictObject({
  role: ParticipantRole.optional(),
  status: MeetupStatus.optional(),
  cursor: Cursor.optional(),
});
export type MeetupListQuery = z.infer<typeof MeetupListQuery>;

/**
 * One meetup as both reads return it: an element of `GET /meetups`, the body of `GET /meetups/:id`,
 * and the counter the `meetup_status` WebSocket frame is refetched on (AAP 0.5.4).
 *
 * `role` and `checkedIn` are the calling user's; `counterpartCheckedIn` is the other attendee's pass
 * check-in, from the same pass `CheckIn` rows `Meetup.bothCheckedInAt` is set from (AAP 0.5.7), so it
 * is what lets either attendee see whether the counterpart showed up — the trust signal the deposit is
 * held against — while the meetup is still `locked`, and it reports the row that exists at the read.
 * `counterpart` is serialized at the caller's tier through `PROFILE_SCHEMA_BY_TIER`, so it is a
 * `Tier0Profile` for a stranger and reaches tier 3 only after two completed meetups (criterion 5).
 *
 * `recipientDeadline` is the earlier of `proposalVisibleAt + 48 h` and `startsAt`, and is null while
 * the proposal is not yet visible because the initiator's hold is still pending; a meetup left past it
 * lapses (AAP 0.5.3). `lateCancelFrom` is `startsAt - 2 h`. `initiatorHold` and `recipientHold` are
 * each side's current attempt only, so a superseded attempt never shows through.
 *
 * No client secret ever appears here: for `nextAction: confirm_hold` the client repeats accept, as the
 * recipient, or hold, as the initiator, and receives its own attempt's secret (AAP 0.5.4).
 */
export const MeetupDto = z.object({
  id: Uuid,
  role: ParticipantRole,
  status: MeetupStatus,
  counterpart: AnyTierProfile,
  venue: VenueDto,
  startsAt: IsoDateTime,
  depositCents: UsdCents,
  recipientDeadline: IsoDateTime.nullable(),
  initiatorHold: HoldView,
  recipientHold: HoldView,
  lateCancelFrom: IsoDateTime,
  checkedIn: z.boolean(),
  counterpartCheckedIn: z.boolean(),
  disputeOpen: z.boolean(),
  nextAction: NextAction,
});
export type MeetupDto = z.infer<typeof MeetupDto>;

/**
 * One page of `GET /meetups`, newest first, with `nextCursor` null on the last page.
 * `GET /meetups/:id` answers a single {@link MeetupDto}, and the recipient's first read of a proposal
 * is what sets `recipientViewedAt` and emits `proposal_viewed` (AAP 0.5.4).
 */
export const MeetupListResponse = paginated(MeetupDto);
export type MeetupListResponse = z.infer<typeof MeetupListResponse>;
