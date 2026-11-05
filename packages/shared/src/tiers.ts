/**
 * Disclosure tier field allowlists (AAP 0.5.4).
 *
 * Progressive disclosure releases profile fields per viewer-and-target pair across tiers 0-3,
 * enforced by the API at field level: `selectForTier(tier)` loads only the columns behind
 * these fields, `serializeProfile(row, tier)` copies exactly these keys and never spreads a
 * row, and the response schema is the tier's schema, so a field above the viewer's tier never
 * leaves the server (AAP 0.12.2, criterion 5).
 *
 * Invariant: the tiers are cumulative and ordered 0 < 1 < 2 < 3, and `'blocked'` is not a
 * tier: a block in either direction is the minimum disclosure and `404 user_not_found` on
 * `GET /users/:userId` (AAP 0.5.4). Discovery listings and lodging guest lists always use
 * tier 0. A name here is a response key, not a column (`homeRegion` is a home country code,
 * `currentCityId` the city of the user's most recent proof, `proofDates` and `reputation`
 * assembled objects), and nothing is imported or runs at load time.
 */

/**
 * Disclosure tier of a viewer toward a target (AAP 0.5.4): 0 stranger, 1 a shared locked
 * meetup with both deposits held, 2 one completed meetup, 3 two or more. The rules mapping
 * meetups and pair history onto a tier live in `apps/api/src/modules/users/disclosure/tier.ts`.
 */
export type DisclosureTier = 0 | 1 | 2 | 3;

/**
 * Result of `computeTier(viewerId, targetId)` (AAP 0.5.1). `'blocked'` means a block exists in
 * either direction and carries no fields at all, not the tier 0 allowlist: the profile read
 * answers `404 user_not_found`, and a caller needing a numeric ceiling treats it as below 0.
 */
export type TierResult = DisclosureTier | 'blocked';

/**
 * The four tiers in ascending order. Iterate this rather than counting to 3, so a tier added
 * later cannot be skipped.
 */
export const DISCLOSURE_TIERS = [0, 1, 2, 3] as const;

/**
 * Fields each tier adds, in the order the tier's response schema declares them (AAP 0.5.4).
 * Tier 0 is what any other traveler sees; tier 1 also needs a shared locked meetup, tier 2 one
 * completed meetup, tier 3 two. Every field but tier 0's identity fields is optional.
 */
export const TIER_ADDED_FIELDS = {
  0: [
    'id',
    'handle',
    'avatarSeed',
    'homeRegion',
    'currentCityId',
    'proofDates',
    'reputation',
    'interestTags',
  ],
  1: ['nickname', 'bio', 'canMessage'],
  2: ['hasPhoto'],
  3: ['externalContact', 'fullName'],
} as const satisfies Record<DisclosureTier, readonly string[]>;

/**
 * Cumulative allowlist per tier: `TIER_FIELDS[tier]` concatenates `TIER_ADDED_FIELDS` from tier
 * 0 up to that tier, so a viewer at tier N receives exactly these keys and no others (AAP
 * 0.5.4). Spreads inside `as const` keep the element types literal.
 */
export const TIER_FIELDS = [
  [...TIER_ADDED_FIELDS[0]],
  [...TIER_ADDED_FIELDS[0], ...TIER_ADDED_FIELDS[1]],
  [...TIER_ADDED_FIELDS[0], ...TIER_ADDED_FIELDS[1], ...TIER_ADDED_FIELDS[2]],
  [
    ...TIER_ADDED_FIELDS[0],
    ...TIER_ADDED_FIELDS[1],
    ...TIER_ADDED_FIELDS[2],
    ...TIER_ADDED_FIELDS[3],
  ],
] as const;

/** Every field name any viewer may receive: the widest allowlist, tier 3 (AAP 0.5.4). */
export type ProfileField = (typeof TIER_FIELDS)[3][number];

/** The field names visible at tier `T`, given as a tier literal (AAP 0.5.4). */
export type TierField<T extends DisclosureTier> = (typeof TIER_FIELDS)[T][number];

/**
 * Lowest tier that receives profile-photo bytes from `GET /users/:userId/photo` (AAP 0.5.4);
 * tiers below it receive `hasPhoto` alone, and photo bytes are never a profile field.
 */
export const PHOTO_MIN_TIER = 2 satisfies DisclosureTier;
