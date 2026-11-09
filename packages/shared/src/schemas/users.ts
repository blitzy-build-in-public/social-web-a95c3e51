/**
 * Tiered profile response DTOs and the safety-route body of the users module (AAP 0.5.4, AAP
 * 0.5.7). Disclosure is enforced at field level in three layers: `selectForTier` loads only the
 * columns behind a tier's field list, `serializeProfile` copies exactly those keys from an explicit
 * allowlist, and the route answers with the tier's schema from {@link PROFILE_SCHEMA_BY_TIER}, so a
 * field above the viewer's tier never leaves the server (criterion 5). Invariant: the tiers are
 * cumulative and every field a tier adds is REQUIRED, nullable where it may be empty and never
 * optional.
 */
import { z } from 'zod';

import { INTEREST_TAGS_MAX, REASON_MAX_CHARS } from '../constants.ts';
import { InterestTag } from '../interests.ts';
import type { DisclosureTier } from '../tiers.ts';
import { CitySlug, Count, CountryCode, DateOnly, Uuid } from './common.ts';

/**
 * The witnessed-presence counters a traveler shows on their profile (AAP 0.5.7). `witnessedMeetups`
 * counts `WitnessEvent` rows whose `countsForReputation` is set and the three distinct counters
 * come from those same rows; a pair counts once until the anti-farming window has passed, so
 * neither number can be inflated by meeting one person repeatedly.
 */
export const Reputation = z.object({
  witnessedMeetups: Count,
  distinctCounterparts: Count,
  distinctVenues: Count,
  distinctCities: Count,
  noShows90d: Count,
});
export type Reputation = z.infer<typeof Reputation>;

/**
 * What any other traveler receives: a stranger's view of a profile, with no nickname, bio or photo
 * (AAP 0.5.4). `homeRegion` is `User.homeCountryCode` and the only home information disclosed,
 * never a home city or address; `currentCityId` and `proofDates` describe the current valid proof
 * and are `null` for a user who has none.
 */
export const Tier0Profile = z.object({
  id: Uuid,
  handle: z.string(),
  avatarSeed: z.string(),
  homeRegion: CountryCode.nullable(),
  currentCityId: CitySlug.nullable(),
  proofDates: z.object({ arrivalDate: DateOnly, departureDate: DateOnly }).nullable(),
  reputation: Reputation,
  interestTags: z.array(InterestTag).max(INTEREST_TAGS_MAX),
});
export type Tier0Profile = z.infer<typeof Tier0Profile>;

/**
 * Tier 0 plus the self-described fields, released once the pair shares a locked meetup whose
 * deposits are both held (AAP 0.5.4). `canMessage` states whether messaging is open to this viewer,
 * which is a property of the pair rather than of the target: it is what lets the client hide a chat
 * entry point without knowing the messaging rule.
 */
export const Tier1Profile = Tier0Profile.extend({
  nickname: z.string().nullable(),
  bio: z.string().nullable(),
  canMessage: z.boolean(),
});
export type Tier1Profile = z.infer<typeof Tier1Profile>;

/**
 * Tier 1 plus whether the target has a profile photo, released after one completed meetup (AAP
 * 0.5.4); only the presence is a field, and the WebP bytes come from `GET /users/:userId/photo`,
 * which serves them from tier 2 upward.
 */
export const Tier2Profile = Tier1Profile.extend({
  hasPhoto: z.boolean(),
});
export type Tier2Profile = z.infer<typeof Tier2Profile>;

/**
 * Tier 2 plus the full name and external contact handle, released after two completed meetups (AAP
 * 0.5.4). They are the highest-disclosure fields in the product and are never serialized to a tier
 * below 3.
 */
export const Tier3Profile = Tier2Profile.extend({
  externalContact: z.string().nullable(),
  fullName: z.string().nullable(),
});
export type Tier3Profile = z.infer<typeof Tier3Profile>;

/**
 * Any profile a viewer may receive, as the route-level schema of `GET /users/:userId` and of
 * `MeetupDto.counterpart` (AAP 0.5.4); the variants are ordered highest tier first, so a full
 * tier-3 payload resolves without being narrowed to a lower tier.
 */
export const AnyTierProfile = z.union([Tier3Profile, Tier2Profile, Tier1Profile, Tier0Profile]);
export type AnyTierProfile = z.infer<typeof AnyTierProfile>;

/**
 * The response schema for each disclosure tier, looked up by the tier `computeTier(viewerId,
 * targetId)` returned (AAP 0.5.4). A `'blocked'` result is not a tier and has no entry: a block in
 * either direction answers `404 user_not_found`.
 */
export const PROFILE_SCHEMA_BY_TIER = {
  0: Tier0Profile,
  1: Tier1Profile,
  2: Tier2Profile,
  3: Tier3Profile,
} as const satisfies Record<DisclosureTier, z.ZodType>;

/**
 * The body of `POST /users/:id/report`, which answers `204` (AAP 0.5.4). The reason is free text
 * capped at `REASON_MAX_CHARS` (500) and is trimmed before it is stored (AAP 0.5.2
 * `Report.reason`); it is operator-only, so the report's own routes never return it.
 *
 * `meetupId` is the pilot's addition to the contract's `{ reason }` body: it names the meetup the
 * report was filed from, which only the caller knows, since the report route carries the reported
 * traveler's id and nothing else (AAP 0.5.2 `Report.meetupId`, AAP 0.5.8). It is optional, so the
 * contract's own body still parses unchanged; when it is absent — or names a meetup the pair does
 * not share — the handler infers the pair's most recent shared meetup instead. The handler answers
 * `404 user_not_found` and refuses a body this schema rejects with `400 invalid_field`, which is how
 * a `meetupId` that is not a UUID is refused (AAP 0.5.4).
 */
export const ReportRequest = z.strictObject({
  reason: z.string().trim().min(1).max(REASON_MAX_CHARS),
  meetupId: Uuid.optional(),
});
export type ReportRequest = z.infer<typeof ReportRequest>;
