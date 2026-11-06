/**
 * The lodging contract: the city directory, one lodging's detail and guest list, the claim routes
 * and the staying-visibility toggle (AAP 0.5.4, AAP 0.5.7).
 *
 * The request's lodging directory, phone verification and leaderboard exchange these shapes, and
 * every read is gated on the caller's own itinerary proof: the
 * directory and the detail answer `403 no_valid_proof` for a caller with no valid proof for the
 * lodging's city, and a guest list is released only to such a caller and only for guests who opted
 * in (AAP 0.5.7 "Lodging visibility").
 *
 * What never leaves the server: a claim's booking name and reference (AES-256-GCM ciphertext
 * erased after resolution, AAP 0.5.2), a lodging's console secret, and the stay dates or room
 * numbers of any guest. A guest appears as {@link Tier0Profile} alone, which discloses the same
 * fields a stranger sees in discovery.
 *
 * Client-safe by construction: `zod`, the contract primitives and the domain enums, and no Node
 * built-in, DOM global or top-level side effect, because the same module loads under Hermes, in a
 * browser and in the Node API and workers (AAP 0.11.1).
 *
 * @see AAP 0.5.4 for the routes and their errors, 0.5.7 for the leaderboard, visibility and claim
 * rules, and 0.5.8 for the screens that render these DTOs.
 */
import { z } from 'zod';

import {
  BOOKING_NAME_MAX_CHARS,
  BOOKING_REFERENCE_MAX_CHARS,
  GUEST_COUNT_BELOW_LABEL,
  GUEST_COUNT_THRESHOLD,
} from '../constants.ts';
import { LodgingClaimStatus, LodgingKind, LodgingSort } from '../enums.ts';
import {
  CitySlug,
  Count,
  DateOnly,
  E164,
  IsoDateTime,
  Latitude,
  Longitude,
  Uuid,
} from './common.ts';
import { Tier0Profile } from './users.ts';

// ---------------------------------------------------------------------------------------------
// GET /cities/:cityId/lodgings and GET /lodgings/:id (AAP 0.5.4, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * A verified guest count: a number from {@link GUEST_COUNT_THRESHOLD} upward, or the label the
 * client shows below it.
 *
 * Below three guests the number itself is a privacy leak — it would let a reader single out the
 * one or two travelers staying somewhere — so a count under `GUEST_COUNT_THRESHOLD` never leaves
 * the server as a number and is serialized as `GUEST_COUNT_BELOW_LABEL` instead (AAP 0.5.4, and
 * the request's example "lodging counts below 3 show 'fewer than 3'"). The literal here must equal
 * `GUEST_COUNT_BELOW_LABEL` in `../constants.ts`, which is the value the client's copy renders
 * (AAP 0.5.8).
 */
export const GuestCount = z.union([
  z.number().int().min(GUEST_COUNT_THRESHOLD),
  z.literal(GUEST_COUNT_BELOW_LABEL),
]);
export type GuestCount = z.infer<typeof GuestCount>;

/**
 * Renders a verified guest count for a response DTO.
 *
 * Pure and client-safe, because the lodgings and consoles routes both go through it and the label
 * it returns is the one the client prints. `n` is a whole number of currently verified guests — a
 * `COUNT(*)` result or a counter — which is the only input the API and the console ever pass.
 */
export function toGuestCount(n: number): GuestCount {
  return n < GUEST_COUNT_THRESHOLD ? GUEST_COUNT_BELOW_LABEL : n;
}

/**
 * One lodging in the city directory or on the leaderboard (AAP 0.5.4).
 *
 * `phone` is the lodging's own business number, which the directory must show, and never a
 * traveler's. `rank` is always the lodging's position in its city's witnessed-meetup ranking —
 * the standing AAP 0.5.7 defines: ordered by `activityScore`, ties broken by current verified
 * guest count and then by name, lodgings scoring 0 following alphabetically. It is never the
 * position in the order a query asked for: `sort` changes only the order in which the items are
 * listed, so a client printing `rank` shows the same standing for a lodging under `sort=activity`
 * and `sort=name`, and the same number the lodging's own console reports (AAP 0.5.4).
 */
export const LodgingSummary = z.object({
  id: Uuid,
  cityId: CitySlug,
  name: z.string(),
  kind: LodgingKind,
  address: z.string().nullable(),
  phone: E164.nullable(),
  rank: z.number().int().positive(),
  activityScore: Count,
  guestCount: GuestCount,
});
export type LodgingSummary = z.infer<typeof LodgingSummary>;

/**
 * One lodging's detail page: the summary fields, its coordinates and its opted-in guests
 * (AAP 0.5.4).
 *
 * `guests` lists only travelers who turned `showStaying` on, as tier-0 profiles — no room number,
 * no stay dates — and the API fills it only for a caller holding a valid proof for the lodging's
 * city, because the route answers `403 no_valid_proof` otherwise (AAP 0.5.7).
 */
export const LodgingDetail = LodgingSummary.extend({
  lat: Latitude,
  lng: Longitude,
  guests: z.array(Tier0Profile),
});
export type LodgingDetail = z.infer<typeof LodgingDetail>;

/** The response of `GET /cities/:cityId/lodgings`, in the order the query's sort asks for. */
export const LodgingsResponse = z.object({ items: z.array(LodgingSummary) });
export type LodgingsResponse = z.infer<typeof LodgingsResponse>;

/**
 * The query string of `GET /cities/:cityId/lodgings`: witnessed-meetup activity (the default) or
 * name (AAP 0.5.4). Unknown keys are rejected rather than ignored, because a client sending one
 * has misunderstood the query.
 */
export const LodgingListQuery = z.strictObject({ sort: LodgingSort.default('activity') });
export type LodgingListQuery = z.infer<typeof LodgingListQuery>;

// ---------------------------------------------------------------------------------------------
// POST /me/lodging-claims, GET and DELETE /me/lodging-claims/:id (AAP 0.5.3, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * The body of `POST /me/lodging-claims` (AAP 0.5.4).
 *
 * Two fields are deliberately permissive here, because the handler answers them with an error code
 * of their own rather than a schema failure:
 *
 * - `callConsent` is optional so that an omitted consent reaches the handler and answers
 *   `400 consent_missing` (criterion 14's "a claim without consent returns 400") instead of
 *   `400 invalid_field`. Consent is given before the notice in `app/lodgings/claim.tsx` is
 *   rendered, which discloses that the lodging will learn a guest with this name uses Tablemate
 *   (AAP 0.5.8).
 * - `bookingName` may be empty, which the handler answers `400 booking_name_empty` after trimming.
 *   Both are checked before `404 lodging_not_found`, in the order AAP 0.5.4 lists them.
 *
 * The handler owns the remaining rules: `stayFrom` and `stayTo` must lie inside the caller's proof
 * dates (`422 claim_dates_invalid`), the lodging must be in the proof's city
 * (`422 lodging_other_city`), the caller may hold at most one active claim
 * (`409 active_claim_exists`), and no claim is created while a verification call may genuinely be
 * live (`409 call_in_progress` on delete).
 *
 * `bookingName` and `bookingReference` are the only personal fields this contract carries into the
 * claim: the API encrypts them at rest and erases them within 24 hours of the claim resolving
 * (AAP 0.5.2), and neither is ever returned by any route or written to a log.
 */
export const LodgingClaimRequest = z.strictObject({
  lodgingId: Uuid,
  stayFrom: DateOnly,
  stayTo: DateOnly,
  bookingName: z.string().max(BOOKING_NAME_MAX_CHARS),
  bookingReference: z.string().max(BOOKING_REFERENCE_MAX_CHARS).optional(),
  callConsent: z.boolean().optional(),
});
export type LodgingClaimRequest = z.infer<typeof LodgingClaimRequest>;

/**
 * The response of `POST /me/lodging-claims` (`201`). A new claim always starts `pending_call`,
 * whether the verification call is dispatched at once or the claim waits in the operator queue
 * because the lodging has no callable number (AAP 0.5.3).
 */
export const LodgingClaimCreated = z.object({
  claimId: Uuid,
  status: z.literal('pending_call'),
});
export type LodgingClaimCreated = z.infer<typeof LodgingClaimCreated>;

/**
 * The response of `GET /me/lodging-claims/:id`, the caller's own claim only, so another user's id
 * answers `404 claim_not_found` (AAP 0.5.4).
 *
 * `resolvedAt` is set once the claim reaches `verified`, `rejected` or `unreachable`; the booking
 * name and reference are not part of the shape, and the details behind them are erased shortly
 * after it is (AAP 0.5.2).
 */
export const LodgingClaimStatusDto = z.object({
  status: LodgingClaimStatus,
  resolvedAt: IsoDateTime.nullable(),
});
export type LodgingClaimStatusDto = z.infer<typeof LodgingClaimStatusDto>;

// ---------------------------------------------------------------------------------------------
// PUT /me/lodging-visibility (AAP 0.5.7, 0.5.8)
// ---------------------------------------------------------------------------------------------

/**
 * The body of `PUT /me/lodging-visibility`, the one switch that puts a traveler on a lodging's
 * guest list (AAP 0.5.7 "Lodging visibility").
 *
 * Staying visibility is off by default and can be turned on only for a verified, active claim;
 * without one the route answers `409 no_verified_claim`. The client shows the safety warning in
 * `app/profile/stay.tsx` before the toggle can be switched on (AAP 0.5.8): sharing where one
 * sleeps is the most sensitive disclosure in the product, it is visible to any traveler with a
 * valid proof for the city, and a verified claim stops being active at the end of `stayTo`.
 */
export const VisibilityRequest = z.strictObject({ showStaying: z.boolean() });
export type VisibilityRequest = z.infer<typeof VisibilityRequest>;

/** The response of `PUT /me/lodging-visibility`: the state the server recorded (AAP 0.5.4). */
export const VisibilityResponse = z.object({ showStaying: z.boolean() });
export type VisibilityResponse = z.infer<typeof VisibilityResponse>;
