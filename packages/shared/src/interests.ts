import { z } from 'zod';
/** The interest-tag vocabulary of the tier-0 disclosure profile. A profile carries at most `INTEREST_TAGS_MAX` (3) distinct tags; that limit is enforced where the profile body is validated (`schemas/me.ts`), not here. */
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
/** Validates a single interest tag. Any value outside {@link INTEREST_TAGS} fails, which is the `400 invalid_field` response of `PUT /me/profile`. */
export const InterestTag = z.enum(INTEREST_TAGS);
export type InterestTag = z.infer<typeof InterestTag>;
