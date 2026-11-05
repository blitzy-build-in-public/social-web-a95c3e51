import { z } from 'zod';

/**
 * The interest-tag vocabulary of the tier-0 disclosure profile (AAP 0.5.2).
 *
 * The vocabulary is fixed and ordered, so schemas, seed data, tests and UI labels can all rely on
 * the same list. A profile carries at most `INTEREST_TAGS_MAX` (3) distinct tags; that limit is
 * enforced where the profile body is validated (`schemas/me.ts`), not here.
 *
 * Tags are snake_case identifiers rather than display labels: the client owns the English wording
 * it shows for each tag.
 */
export const INTEREST_TAGS = [
  'food',
  'coffee',
  'street_food',
  'nightlife',
  'live_music',
  'hiking',
  'surfing',
  'diving',
  'yoga',
  'running',
  'cycling',
  'climbing',
  'museums',
  'art',
  'architecture',
  'history',
  'photography',
  'markets',
  'cooking',
  'wine',
  'craft_beer',
  'coworking',
  'startups',
  'tech',
  'languages',
  'books',
  'film',
  'board_games',
  'football',
  'beaches',
  'wellness',
] as const;

/**
 * Validates a single interest tag. Any value outside {@link INTEREST_TAGS} fails, which is the
 * `400 invalid_field` response of `PUT /me/profile` for a tag outside the vocabulary (AAP 0.5.4).
 */
export const InterestTag = z.enum(INTEREST_TAGS);

/** One tag from the {@link INTEREST_TAGS} vocabulary. */
export type InterestTag = z.infer<typeof InterestTag>;
