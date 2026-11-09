/**
 * The console contract: the venue's rotating check-in code and one lodging's standings (AAP 0.5.4,
 * AAP 0.8.1). Two web front ends call these routes and authenticate with a secret alone, never a
 * bearer token (AAP 0.3.3); a wrong or missing one answers `401` with `bad_venue_secret` or
 * `bad_lodging_secret`, and neither shape carries a personal field (AAP 0.5.4, AAP 0.5.7).
 */
import { z } from 'zod';

import { CODE_DIGITS, LODGING_TREND_WEEKS } from '../constants.ts';
import { Count, DateOnly, IsoDateTime } from './common.ts';
import { GuestCount } from './lodgings.ts';

/**
 * The header carrying a venue's operator-issued secret on `GET /venue/check-in-code` (AAP 0.3.3).
 * Fastify lowercases header names, so the handler reads `request.headers['x-venue-secret']`, and
 * the header is redacted from the logs along with the lodging one (AAP 0.11.1).
 */
export const VENUE_SECRET_HEADER = 'X-Venue-Secret' as const;

/**
 * The header carrying a lodging's operator-issued secret on `GET /lodging-console/stats` (AAP
 * 0.3.3): read lowercased as `request.headers['x-lodging-secret']`, redacted from the logs (AAP
 * 0.11.1).
 */
export const LODGING_SECRET_HEADER = 'X-Lodging-Secret' as const;

/**
 * The venue check-in code route's path, relative to `API_PATH_PREFIX` (AAP 0.5.4): the consoles
 * module registers it under that prefix and the venue console appends the prefix and this path to
 * the origin its build was given, so a rename on either side is a compile error rather than a
 * runtime 404.
 */
export const VENUE_CODE_PATH = '/venue/check-in-code' as const;

/**
 * The lodging console's stats route, relative to `API_PATH_PREFIX` (AAP 0.5.4) and read on the same
 * terms as {@link VENUE_CODE_PATH}: the consoles module registers it under that prefix and the
 * lodging console appends the prefix and this path to its own configured origin.
 */
export const LODGING_CONSOLE_STATS_PATH = '/lodging-console/stats' as const;

/**
 * The pattern of one check-in code, built from {@link CODE_DIGITS} so the two cannot drift apart —
 * the server renders every code zero-padded to that width, and the console only displays it.
 */
const CODE_PATTERN = new RegExp(`^\\d{${CODE_DIGITS}}$`);

/**
 * The body of `GET /venue/check-in-code` (AAP 0.5.4), the only shape the console renders. The code
 * is always the server's: the venue secret keys an HKDF-SHA256 derivation and the counter is
 * `floor(serverTime / 60)`, which the route accepts for T-1, T and T+1 (AAP 0.5.7). `expiresAt`
 * ends the current 60-second step; the console's countdown is measured from the offset between the
 * `Date` response header and the device clock, so clock skew shifts the countdown alone and never
 * validation (AAP 0.3.2).
 */
export const VenueCodeResponse = z.object({
  code: z.string().regex(CODE_PATTERN),
  expiresAt: IsoDateTime,
});
export type VenueCodeResponse = z.infer<typeof VenueCodeResponse>;

/**
 * One weekly point of the 90-day trend (AAP 0.5.4): the week's start date and the witnessed-meetup
 * score the leaderboard recorded for that lodging, counted as in AAP 0.5.7.
 */
export const TrendPoint = z.object({
  weekStart: DateOnly,
  activityScore: Count,
});
export type TrendPoint = z.infer<typeof TrendPoint>;

/**
 * The body of `GET /lodging-console/stats` (AAP 0.5.4). `rank` is the lodging's leaderboard
 * position among its city's lodgings, so it is 1 or greater even for a lodging scoring 0;
 * `weeklyTrend` is exactly {@link LODGING_TREND_WEEKS} weekly points covering `activityScore`'s
 * window; `verifiedGuests` reuses {@link GuestCount}, so a count below three reads "fewer than 3"
 * here as in the directory instead of singling a guest out (AAP 0.5.7). No guest, claim or booking
 * field is included.
 */
export const LodgingConsoleStats = z.object({
  rank: z.number().int().positive(),
  activityScore: Count,
  verifiedGuests: GuestCount,
  weeklyTrend: z.array(TrendPoint).length(LODGING_TREND_WEEKS),
});
export type LodgingConsoleStats = z.infer<typeof LodgingConsoleStats>;
