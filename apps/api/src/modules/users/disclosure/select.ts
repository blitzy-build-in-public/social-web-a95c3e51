/**
 * Disclosure layer 2 of 3: the per-tier Prisma `select`.
 *
 * `selectForTier(tier)` gives a query nothing but the columns behind the tier's field list, so a field above the
 * viewer's tier is never loaded into the process at all — it cannot then escape through a forgotten serializer, a log
 * line or a spread row. The tiers are cumulative, and the four trees are frozen module constants handed out by
 * reference, so no caller can widen a tier by mutating the select it received. No tier ever selects
 * `ProfilePhoto.webp`, `emailCiphertext`, `emailLookupHash`, `stripeCustomerId`, `role`, `ageConfirmedAt`,
 * `termsVersion`, `homeCity`, `deletionRequestedAt` or `deletedAt`; a deleted user is excluded by a query's `where`,
 * never by leaving that flag in the row.
 */
import type { Prisma } from '@tablemate/db';
import type { DisclosureTier } from '@tablemate/shared';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Freezes `value` and every object it reaches: the tier selects are shared constants, and one runtime mutation would
 * silently widen disclosure for every later request in the process. */
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

/** Tier 0: the columns any other traveler may see. `homeCountryCode` is disclosed as `homeRegion`, and `interestTags`
 * is the tag list every viewer receives. */
const TIER_0_SELECT = {
  id: true,
  handle: true,
  avatarSeed: true,
  homeCountryCode: true,
  disclosureProfile: { select: { interestTags: true } },
} as const satisfies Prisma.UserSelect;

/** Tier 1: tier 0 plus the self-described fields, released once the pair shares a locked meetup whose deposits are
 * both held. */
const TIER_1_SELECT = {
  ...TIER_0_SELECT,
  disclosureProfile: { select: { interestTags: true, nickname: true, bio: true } },
} as const satisfies Prisma.UserSelect;

/** Tier 2: tier 1 plus whether the target has a profile photo, released after one completed meetup. Only the photo's
 * existence is a profile field, so its row is selected for its key alone; the WebP bytes come from
 * `GET /users/:userId/photo`. */
const TIER_2_SELECT = {
  ...TIER_1_SELECT,
  profilePhoto: { select: { userId: true } },
} as const satisfies Prisma.UserSelect;

/** Tier 3: tier 2 plus the full name and external contact handle, released after two completed meetups; both stay
 * ciphertext until `serialize.ts` decrypts them for this tier. */
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

/** The select of each disclosure tier, keyed by tier. A `'blocked'` result from `computeTier` is not a tier and has no
 * entry: a block in either direction answers `404 user_not_found`. */
export const TIER_SELECTS = deepFreeze({
  0: TIER_0_SELECT,
  1: TIER_1_SELECT,
  2: TIER_2_SELECT,
  3: TIER_3_SELECT,
} as const satisfies Record<DisclosureTier, Prisma.UserSelect>);

export type TierSelect<T extends DisclosureTier> = (typeof TIER_SELECTS)[T];

/** The row a query with the select of tier `T` returns, so `serialize.ts` cannot read a column the tier did not select. */
export type ProfileRow<T extends DisclosureTier> = Prisma.UserGetPayload<{
  select: TierSelect<T>;
}>;

/** The select to load a profile with for a viewer whose tier is `tier`: the frozen module constant of that tier,
 * shared by every query that asks for it. */
export function selectForTier<T extends DisclosureTier>(tier: T): TierSelect<T> {
  return TIER_SELECTS[tier];
}
