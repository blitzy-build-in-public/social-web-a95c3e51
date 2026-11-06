/**
 * Disclosure layer 2 of 3: the per-tier Prisma `select` (AAP 0.5.1, 0.5.4).
 *
 * `selectForTier(tier)` gives a query nothing but the columns behind the tier's field list, so a
 * field above the viewer's tier is never loaded into the process at all — it cannot then escape
 * through a forgotten serializer, a log line or a spread row (AAP 0.2.2). It replaces neither of
 * the other two layers: `tier.ts` decides which tier a viewer-and-target pair has earned, and
 * `serialize.ts` copies the tier's keys from its allowlist and parses them with the tier's schema.
 *
 * Where each disclosed field comes from: `id`, `handle` and `avatarSeed` from `User`; `homeRegion`
 * from `User.homeCountryCode`, the ISO 3166-1 alpha-2 code of the traveler's home region (AAP
 * 0.5.2); `interestTags`, `nickname` and `bio` from `DisclosureProfile`; `hasPhoto` from the
 * presence of `ProfilePhoto`; `fullName` from `DisclosureProfile.fullNameCiphertext` and
 * `externalContact` from its `externalContactCiphertext`, which only `serialize.ts` decrypts, at
 * tier 3. Four of the tiered fields come from outside this select: `currentCityId` and `proofDates`
 * from the user's current valid proof (`proofs/validity.ts`), `reputation` from the reputation
 * counters (`reputation/counters.ts`) and `canMessage` from the pair facts of `tier.ts`.
 *
 * Invariant: the tiers are cumulative, so each select is a superset of the one below it, and the
 * four trees are frozen module constants handed out by reference, so no caller can widen a tier by
 * mutating the select it received.
 *
 * Invariant: no tier ever selects `ProfilePhoto.webp` (the photo bytes, which only
 * `GET /users/:userId/photo` loads), `emailCiphertext`, `emailLookupHash`, `stripeCustomerId`,
 * `role`, `ageConfirmedAt`, `termsVersion`, `homeCity`, `deletionRequestedAt` or `deletedAt`. A
 * deleted user is excluded by a query's `where` clause, never by leaving that flag in the row.
 *
 * @see AAP 0.5.4 for the tier field lists and the three layers that enforce them, 0.5.2 for the
 *   field sources and the fields that must never leave the server, 0.12.2 for the constraint that
 *   no response carries a field above the viewer's tier.
 */

import type { Prisma } from '@tablemate/db';
import type { DisclosureTier } from '@tablemate/shared';

// ---------------------------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------------------------

/** True for a non-null object: what {@link deepFreeze} can descend into and freeze. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Freezes `value` and every object it reaches, and returns it.
 *
 * The tier selects are shared constants, so one runtime mutation of a tier-0 select would silently
 * widen disclosure for every later request in the process. Freezing the trees once at load makes
 * the type-level `readonly` a runtime guarantee as well; Prisma reads a select, never writes to it.
 *
 * @param value - The select tree to freeze.
 * @returns The same value, frozen.
 */
function deepFreeze<T>(value: T): T {
  if (!isRecord(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  Object.freeze(value);

  return value;
}

// ---------------------------------------------------------------------------------------------
// The four selects
// ---------------------------------------------------------------------------------------------

/**
 * Tier 0: the columns any other traveler may see (AAP 0.5.4). Discovery listings and lodging guest
 * lists use this select alone.
 *
 * `homeCountryCode` is disclosed as `homeRegion` and is the only home information a profile
 * carries; `interestTags` is the tag list every viewer receives.
 */
const TIER_0_SELECT = {
  id: true,
  handle: true,
  avatarSeed: true,
  homeCountryCode: true,
  disclosureProfile: { select: { interestTags: true } },
} as const satisfies Prisma.UserSelect;

/**
 * Tier 1: tier 0 plus the self-described fields, released once the pair shares a locked meetup
 * whose deposits are both held (AAP 0.5.4). `nickname` and `bio` are null until the target fills
 * them in.
 */
const TIER_1_SELECT = {
  ...TIER_0_SELECT,
  disclosureProfile: { select: { interestTags: true, nickname: true, bio: true } },
} as const satisfies Prisma.UserSelect;

/**
 * Tier 2: tier 1 plus whether the target has a profile photo, released after one completed meetup
 * (AAP 0.5.4).
 *
 * Only the photo's existence is a profile field, so its row is selected for its key alone: the WebP
 * bytes are never loaded here and come from `GET /users/:userId/photo` instead.
 */
const TIER_2_SELECT = {
  ...TIER_1_SELECT,
  profilePhoto: { select: { userId: true } },
} as const satisfies Prisma.UserSelect;

/**
 * Tier 3: tier 2 plus the full name and external contact handle, released after two completed
 * meetups (AAP 0.5.4). Both stay ciphertext until `serialize.ts` decrypts them for this tier.
 */
const TIER_3_SELECT = {
  ...TIER_2_SELECT,
  disclosureProfile: {
    select: {
      interestTags: true,
      nickname: true,
      bio: true,
      fullNameCiphertext: true,
      externalContactCiphertext: true,
    },
  },
} as const satisfies Prisma.UserSelect;

/**
 * The select of each disclosure tier, keyed by tier (AAP 0.5.4).
 *
 * A `'blocked'` result from `computeTier` is not a tier and has no entry: a block in either
 * direction answers `404 user_not_found` on the profile route.
 */
export const TIER_SELECTS = deepFreeze({
  0: TIER_0_SELECT,
  1: TIER_1_SELECT,
  2: TIER_2_SELECT,
  3: TIER_3_SELECT,
} as const satisfies Record<DisclosureTier, Prisma.UserSelect>);

/** The select of tier `T`, as written in {@link TIER_SELECTS} (AAP 0.5.4). */
export type TierSelect<T extends DisclosureTier> = (typeof TIER_SELECTS)[T];

/**
 * The row a query with the select of tier `T` returns: only the columns that tier loads (AAP
 * 0.5.4), so `serialize.ts` cannot read a column the tier did not select.
 */
export type ProfileRow<T extends DisclosureTier> = Prisma.UserGetPayload<{
  select: TierSelect<T>;
}>;

/**
 * The select to load a profile with for a viewer whose tier is `tier` (AAP 0.5.1, 0.5.4).
 *
 * The returned object is the frozen module constant of that tier, shared by every query that asks
 * for it.
 *
 * @param tier - The tier `computeTier(viewerId, targetId)` returned; a `'blocked'` result is not a
 *   tier and answers `404` before a select is ever needed.
 * @returns The tier's `select`, to pass as `select` to a `user` query.
 */
export function selectForTier<T extends DisclosureTier>(tier: T): TierSelect<T> {
  return TIER_SELECTS[tier];
}
