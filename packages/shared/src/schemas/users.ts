/**
 * Tiered profile response DTOs and the safety-route body of the users module
 * (AAP 0.5.4, AAP 0.5.7).
 *
 * Disclosure of a profile is enforced at field level in three layers: `selectForTier` loads only
 * the columns behind a tier's field list, `serializeProfile` copies exactly those keys from an
 * explicit allowlist and never spreads a row, and the route answers with the tier's schema chosen
 * through {@link PROFILE_SCHEMA_BY_TIER}, because Zod's serializer drops every key a schema does
 * not declare. A field above the viewer's tier therefore never leaves the server (criterion 5).
 *
 * Invariant: the tiers are cumulative (0 < 1 < 2 < 3) and every field a tier adds is REQUIRED,
 * nullable where it may be empty and never optional, so the union in {@link AnyTierProfile}
 * resolves a payload to the highest tier it fully satisfies and each schema's key set matches that
 * tier's list in `tiers.ts`.
 *
 * Client-safe: no Node built-in, no DOM global, no top-level side effect, because the same module
 * runs under Hermes, in a browser and in Node (AAP 0.11.1). No sibling schema module is imported,
 * because `me.ts`, `cities.ts`, `meetups.ts` and `lodgings.ts` build on this one.
 */
import { z } from 'zod';

import { INTEREST_TAGS_MAX, REASON_MAX_CHARS } from '../constants.ts';
import { InterestTag } from '../interests.ts';
import type { DisclosureTier } from '../tiers.ts';
import { CitySlug, Count, CountryCode, DateOnly, Uuid } from './common.ts';

/*
 * Reputation.
 */

/**
 * The witnessed-presence counters a traveler shows on their profile (AAP 0.5.7).
 *
 * `witnessedMeetups` counts `WitnessEvent` rows whose `countsForReputation` is set, and the three
 * distinct counters are taken over those same rows; a pair counts once until the anti-farming
 * window has passed, so neither number can be inflated by meeting one person repeatedly. No-shows
 * are forfeited meetups within `NO_SHOW_WINDOW_DAYS` (90) days in which the user was the absent
 * party, a late cancellation included, and neither a block nor a deletion of the counterpart
 * changes them.
 *
 * There are no stars and no free-text reviews anywhere in the product: witnessed presence is the
 * only reputation input (AAP 0.7.2).
 */
export const Reputation = z.object({
  witnessedMeetups: Count,
  distinctCounterparts: Count,
  distinctVenues: Count,
  distinctCities: Count,
  noShows90d: Count,
});
export type Reputation = z.infer<typeof Reputation>;

/*
 * Disclosure tiers.
 */

/**
 * What any other traveler receives: a stranger's view of a profile, with no nickname, bio or photo
 * (AAP 0.5.4). Discovery listings and lodging guest lists use this tier alone.
 *
 * `homeRegion` is `User.homeCountryCode`, the ISO 3166-1 alpha-2 code of the traveler's home
 * region, and it is the only home information disclosed — never a home city or address.
 * `currentCityId` and `proofDates` describe the traveler's current valid itinerary proof, so both
 * are `null` for a user whose proof has expired or who has none; `proofDates` carries the day
 * precision of the proof's validity range, and its dates are the only stay dates any viewer sees.
 * `interestTags` is the tier-0 tag list, at most `INTEREST_TAGS_MAX` (3) distinct tags.
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
 * deposits are both held (AAP 0.5.4).
 *
 * `nickname` and `bio` are `null` until the target fills them in. `canMessage` states whether
 * messaging is open to this viewer, which is a property of the pair rather than of the target: it
 * is what lets the client hide a chat entry point without knowing the messaging rule.
 */
export const Tier1Profile = Tier0Profile.extend({
  nickname: z.string().nullable(),
  bio: z.string().nullable(),
  canMessage: z.boolean(),
});
export type Tier1Profile = z.infer<typeof Tier1Profile>;

/**
 * Tier 1 plus whether the target has a profile photo, released after one completed meetup
 * (AAP 0.5.4).
 *
 * Only the presence is a profile field; the WebP bytes themselves come from
 * `GET /users/:userId/photo`, which serves them from tier 2 upward and never to a discovery or
 * guest-list reader.
 */
export const Tier2Profile = Tier1Profile.extend({
  hasPhoto: z.boolean(),
});
export type Tier2Profile = z.infer<typeof Tier2Profile>;

/**
 * Tier 2 plus the full name and external contact handle, released after two completed meetups
 * (AAP 0.5.4).
 *
 * Both arrive decrypted from their AES-256-GCM ciphertext (`DisclosureProfile`, AAP 0.5.2) and are
 * `null` until the target supplies them. They are the highest-disclosure fields in the product and
 * are never serialized to a tier below 3.
 */
export const Tier3Profile = Tier2Profile.extend({
  externalContact: z.string().nullable(),
  fullName: z.string().nullable(),
});
export type Tier3Profile = z.infer<typeof Tier3Profile>;

/**
 * Any profile a viewer may receive, as the route-level schema of `GET /users/:userId` and of
 * `MeetupDto.counterpart` (AAP 0.5.4).
 *
 * The variants are ordered highest tier first, so a full tier-3 payload resolves without being
 * narrowed to a lower tier and a payload carrying stray higher-tier keys is stripped by the
 * strictest variant that admits it. A union alone cannot know the viewer's tier, so the API still
 * serializes through {@link PROFILE_SCHEMA_BY_TIER} first: the union is what guarantees that no
 * schema in the map can emit a key outside the tier lists.
 */
export const AnyTierProfile = z.union([Tier3Profile, Tier2Profile, Tier1Profile, Tier0Profile]);
export type AnyTierProfile = z.infer<typeof AnyTierProfile>;

/**
 * The response schema for each disclosure tier, looked up by the tier
 * `computeTier(viewerId, targetId)` returned (AAP 0.5.4).
 *
 * `apps/api/src/modules/users/disclosure/serialize.ts` uses this map, so the schema a route
 * serializes with is the viewer's tier by construction. A `'blocked'` result is not a tier and has
 * no entry: a block in either direction answers `404 user_not_found`.
 */
export const PROFILE_SCHEMA_BY_TIER = {
  0: Tier0Profile,
  1: Tier1Profile,
  2: Tier2Profile,
  3: Tier3Profile,
} as const satisfies Record<DisclosureTier, z.ZodType>;

/*
 * Safety routes.
 */

/**
 * The body of `POST /users/:id/report`, which answers `204` (AAP 0.5.4).
 *
 * The reason is free text capped at `REASON_MAX_CHARS` (500) and is trimmed before it is stored
 * (AAP 0.5.2 `Report.reason`); it is operator-only, so the report's own routes never return it.
 * Unknown keys are rejected rather than ignored, because a client sending one has misunderstood
 * the payload. `POST /users/:id/block` takes no body.
 */
export const ReportRequest = z.strictObject({
  reason: z.string().trim().min(1).max(REASON_MAX_CHARS),
});
export type ReportRequest = z.infer<typeof ReportRequest>;
