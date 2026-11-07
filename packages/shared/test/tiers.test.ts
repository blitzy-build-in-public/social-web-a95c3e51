/**
 * Disclosure allowlists and the profile DTOs that must match them (AAP 0.5.4, 0.11.2).
 *
 * Disclosure is enforced in three layers: `selectForTier` loads only a tier's columns,
 * `serializeProfile` copies exactly the keys of `TIER_FIELDS`, and the route serializes with the
 * tier's schema, whose strip mode drops every key it does not declare. Two of those layers are
 * static data in this package, so this suite proves they agree with each other and with the tier
 * table of AAP 0.5.4: no schema may declare a field its tier's allowlist does not hold, which is
 * what keeps a field above the viewer's tier from leaving the server (criterion 5, checked end to
 * end by the API's disclosure integration suite). `GuestCount` carries the same rule for a
 * lodging's verified guest count: a number below `GUEST_COUNT_THRESHOLD` never leaves the server
 * as a number (AAP 0.5.4, 0.5.7).
 *
 * The expected table below is typed by hand from the AAP rather than read from `src/tiers.ts`, so
 * the allowlist has to disagree with the AAP to pass. Every case is a row of a table (`it.each`)
 * and every fixture payload is derived from one sample, so no tier is written out separately.
 */
import { describe, expect, it } from 'vitest';

import {
  AnyTierProfile,
  DISCLOSURE_TIERS,
  GUEST_COUNT_BELOW_LABEL,
  GUEST_COUNT_THRESHOLD,
  GuestCount,
  INTEREST_TAGS,
  PHOTO_MIN_TIER,
  PROFILE_SCHEMA_BY_TIER,
  Tier0Profile,
  Tier1Profile,
  Tier2Profile,
  Tier3Profile,
  TIER_ADDED_FIELDS,
  TIER_FIELDS,
  toGuestCount,
} from '../src/index.ts';
import type { DisclosureTier, ProfileField } from '../src/index.ts';

/*
 * The tier table of AAP 0.5.4: what each tier adds, in the order its response schema declares it.
 * Tier 0 is what any other traveler sees, and discovery listings and lodging guest lists use it
 * alone.
 */
const EXPECTED_ADDED = {
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

/** The tiers in ascending order, so no case is written out per tier. */
const TIERS = [0, 1, 2, 3] as const satisfies readonly DisclosureTier[];

/**
 * `TIER_FIELDS[tier]`, widened to the field names it holds. `TIER_FIELDS` is a readonly tuple of
 * readonly tuples, so the helper keeps indexing total and keeps a union of tuple types out of the
 * assertions.
 */
function tierFields(tier: DisclosureTier): readonly ProfileField[] {
  return TIER_FIELDS[tier];
}

/** `TIER_ADDED_FIELDS[tier]`, widened the same way. */
function tierAddedFields(tier: DisclosureTier): readonly ProfileField[] {
  return TIER_ADDED_FIELDS[tier];
}

/** The expected cumulative allowlist of a tier: `EXPECTED_ADDED` from tier 0 up to it. */
function expectedFields(tier: DisclosureTier): readonly string[] {
  return TIERS.filter((lower) => lower <= tier).flatMap<string>((lower) => EXPECTED_ADDED[lower]);
}

/** Field names in a stable order, so two lists are compared as sets. */
function sorted(fields: readonly string[]): string[] {
  return [...fields].sort();
}

/*
 * One sample profile, valid at the widest tier: every payload a case needs is derived from it.
 */
const SAMPLE = {
  id: '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b',
  handle: 'quiet-otter-42',
  avatarSeed: 'seed-1',
  homeRegion: 'PT',
  currentCityId: 'lisbon',
  proofDates: { arrivalDate: '2026-11-10', departureDate: '2026-11-20' },
  reputation: {
    witnessedMeetups: 2,
    distinctCounterparts: 2,
    distinctVenues: 1,
    distinctCities: 1,
    noShows90d: 0,
  },
  // Taken from the vocabulary itself: a hard-coded tag would break on a vocabulary change.
  interestTags: INTEREST_TAGS.slice(0, 1),
  nickname: 'Ana',
  bio: 'Coffee first.',
  canMessage: true,
  hasPhoto: true,
  externalContact: '@ana',
  fullName: 'Ana Example',
} satisfies Tier3Profile;

/** `SAMPLE` keyed by the allowlist's field names, so a payload is built field by field. */
const SAMPLE_BY_FIELD: Readonly<Record<ProfileField, unknown>> = SAMPLE;

/** The tier-`tier` payload: exactly the fields of its allowlist, valued from `SAMPLE`. */
function payloadFor(tier: DisclosureTier): Record<string, unknown> {
  return Object.fromEntries(tierFields(tier).map((field) => [field, SAMPLE_BY_FIELD[field]]));
}

/** `payloadFor(tier)` without one field, for the rows that prove a field is required. */
function payloadWithout(tier: DisclosureTier, field: ProfileField): Record<string, unknown> {
  const keys = tierFields(tier).filter((key) => key !== field);

  return Object.fromEntries(keys.map((key) => [key, SAMPLE_BY_FIELD[key]]));
}

/** Each tier with the tier it extends: the growth and the stricter-schema rows share this table. */
const GROWTH_ROWS: readonly (readonly [DisclosureTier, DisclosureTier])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
];

/** Every lower/higher pair, for the strip-mode rows. */
const STRIP_ROWS: readonly (readonly [DisclosureTier, DisclosureTier])[] = TIERS.flatMap((lower) =>
  TIERS.filter((upper) => upper > lower).map((upper) => [lower, upper] as const),
);

/** Every (tier, added field) pair: one row per field that must be present at its own tier. */
const ADDED_FIELD_ROWS: readonly (readonly [DisclosureTier, ProfileField])[] = TIERS.flatMap(
  (tier) => tierAddedFields(tier).map((field) => [tier, field] as const),
);

/** Every (tier, added field, tier below) triple: a payload short of one field of its own tier. */
const INCOMPLETE_ROWS: readonly (readonly [DisclosureTier, ProfileField, DisclosureTier])[] =
  GROWTH_ROWS.flatMap(([lower, upper]) =>
    tierAddedFields(upper).map((field) => [upper, field, lower] as const),
  );

/** The schema each tier must resolve to, named so a map entry cannot pass on shape alone. */
const NAMED_SCHEMA_ROWS = [
  [0, Tier0Profile],
  [1, Tier1Profile],
  [2, Tier2Profile],
  [3, Tier3Profile],
] as const;

/** Fields only a tier above 0 may release: a stranger's view holds none of them (AAP 0.5.4). */
const TIER0_PERSONAL_FIELDS = [
  'nickname',
  'bio',
  'fullName',
  'externalContact',
  'hasPhoto',
  'canMessage',
] as const;

describe('disclosure tier allowlists', () => {
  it('lists the four tiers in ascending order', () => {
    expect(DISCLOSURE_TIERS).toEqual([0, 1, 2, 3]);
  });

  it.each(TIERS)('tier %i adds exactly the fields of the tier table', (tier) => {
    expect(tierAddedFields(tier)).toEqual(EXPECTED_ADDED[tier]);
  });

  it.each(TIERS)('tier %i holds its cumulative fields once each', (tier) => {
    const fields = tierFields(tier);

    expect(sorted(fields)).toEqual(sorted(expectedFields(tier)));
    expect(new Set(fields).size).toBe(fields.length);
  });

  it.each(GROWTH_ROWS)('tier %i is a strict subset of tier %i', (lower, upper) => {
    const lowerFields = tierFields(lower);
    const upperFields = tierFields(upper);

    // Nothing a lower tier releases is withdrawn, the list strictly grows, and the difference is
    // exactly what the upper tier adds.
    expect(lowerFields.filter((field) => !upperFields.includes(field))).toEqual([]);
    expect(upperFields.length).toBeGreaterThan(lowerFields.length);
    expect(upperFields.filter((field) => !lowerFields.includes(field))).toEqual(
      tierAddedFields(upper),
    );
  });

  it('serves photo bytes from the first tier whose allowlist holds hasPhoto', () => {
    // The allowlists are cumulative, so every tier above the photo tier holds the field too, and
    // the smallest one that does is the tier `GET /users/:userId/photo` serves bytes from.
    const holdingPhoto = TIERS.filter((tier) => tierFields(tier).includes('hasPhoto'));

    expect(PHOTO_MIN_TIER).toBe(2);
    expect(holdingPhoto).toEqual([2, 3]);
    expect(holdingPhoto[0]).toBe(PHOTO_MIN_TIER);
    expect(TIERS.filter((tier) => !tierFields(tier).includes('hasPhoto'))).toEqual([0, 1]);
  });

  it.each(TIER0_PERSONAL_FIELDS)('tier 0 never carries %s', (field) => {
    expect(tierFields(0)).not.toContain(field);
  });
});

describe('profile DTO schemas', () => {
  it.each(TIERS)('accepts the exact tier %i payload', (tier) => {
    // Sanity first: without it every rejection below could pass on a payload that was never valid.
    expect(PROFILE_SCHEMA_BY_TIER[tier].safeParse(payloadFor(tier)).success).toBe(true);
  });

  it.each(TIERS)('declares exactly the tier %i allowlist', (tier) => {
    const declared = Object.keys(PROFILE_SCHEMA_BY_TIER[tier].shape);

    expect(sorted(declared)).toEqual(sorted(tierFields(tier)));
  });

  it.each(NAMED_SCHEMA_ROWS)('maps tier %i to its own schema', (tier, schema) => {
    expect(PROFILE_SCHEMA_BY_TIER[tier]).toBe(schema);
  });

  it.each(GROWTH_ROWS)('rejects the tier %i payload at tier %i', (lower, upper) => {
    expect(PROFILE_SCHEMA_BY_TIER[upper].safeParse(payloadFor(lower)).success).toBe(false);
  });

  it.each(ADDED_FIELD_ROWS)('tier %i requires %s', (tier, field) => {
    // A nullable field is still a required key: absent is not the same as `null`.
    expect(PROFILE_SCHEMA_BY_TIER[tier].safeParse(payloadWithout(tier, field)).success).toBe(false);
  });

  it.each(INCOMPLETE_ROWS)(
    'resolves a tier %i payload missing %s to tier %i',
    (upper, field, lower) => {
      // A payload short of one of its tier's fields cannot be resolved to that tier, so the union
      // a route serializes with never claims a tier the payload does not satisfy.
      const resolved = AnyTierProfile.parse(payloadWithout(upper, field));

      expect(sorted(Object.keys(resolved))).toEqual(sorted(tierFields(lower)));
    },
  );

  it.each(TIERS)('resolves the tier %i payload to exactly its fields', (tier) => {
    const resolved = AnyTierProfile.parse(payloadFor(tier));

    expect(sorted(Object.keys(resolved))).toEqual(sorted(tierFields(tier)));
  });

  it.each(STRIP_ROWS)('tier %i keeps only its own fields of a tier %i payload', (lower, upper) => {
    const serialized = PROFILE_SCHEMA_BY_TIER[lower].parse(payloadFor(upper));

    expect(sorted(Object.keys(serialized))).toEqual(sorted(tierFields(lower)));
  });

  it('strips every higher-tier field from a full payload at tier 0', () => {
    // The key case: a tier-3 payload serialized for a stranger carries the tier-0 fields only.
    expect(sorted(Object.keys(Tier0Profile.parse(payloadFor(3))))).toEqual(sorted(tierFields(0)));
  });
});

describe('GuestCount', () => {
  it('reports the threshold and the label the client renders below it', () => {
    expect(GUEST_COUNT_THRESHOLD).toBe(3);
    expect(GUEST_COUNT_BELOW_LABEL).toBe('fewer than 3');
  });

  it.each([0, 1, 2])('rejects a count of %i', (count) => {
    expect(GuestCount.safeParse(count).success).toBe(false);
  });

  it.each([3, 4, 250])('accepts a count of %i unchanged', (count) => {
    expect(GuestCount.parse(count)).toBe(count);
  });

  it('accepts the below-threshold label, literally and as the shared constant', () => {
    expect(GuestCount.parse('fewer than 3')).toBe('fewer than 3');
    expect(GuestCount.parse(GUEST_COUNT_BELOW_LABEL)).toBe(GUEST_COUNT_BELOW_LABEL);
  });

  it.each([2.5, -1, '2', 'fewer than 2', 'Fewer than 3'])('rejects %o', (value) => {
    expect(GuestCount.safeParse(value).success).toBe(false);
  });

  it('never renders a count below the threshold as a number', () => {
    expect(toGuestCount(GUEST_COUNT_THRESHOLD - 1)).toBe(GUEST_COUNT_BELOW_LABEL);
    expect(toGuestCount(GUEST_COUNT_THRESHOLD)).toBe(GUEST_COUNT_THRESHOLD);
  });
});
