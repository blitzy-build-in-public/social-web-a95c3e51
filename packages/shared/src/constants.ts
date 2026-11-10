/**
 * Fixed business constants (AAP 0.8.1): the bounds the API enforces with an error code of their own,
 * plus the HTTP-date arithmetic both clients read the server clock with. Values an operator tunes per
 * environment are environment variables owned by `packages/server-core/src/env/*` and are deliberately
 * absent here. No imports: the module loads under Hermes and in browsers. Money is integer USD cents.
 */
/** Milliseconds in one minute (AAP 0.5.7). */
export const MINUTE_MS = 60_000 as const;
/** Milliseconds in one hour (AAP 0.5.7). */
export const HOUR_MS = 3_600_000 as const;
/** Milliseconds in one day (AAP 0.5.7). */
export const DAY_MS = 86_400_000 as const;
/** The accepted deposit amounts in integer USD cents; any other value is `422 deposit_invalid`. */
export const DEPOSIT_LEVELS_CENTS = [500, 1000, 2000] as const;
/** An accepted deposit amount in USD cents (AAP 0.7.3). */
export type DepositCents = (typeof DEPOSIT_LEVELS_CENTS)[number];
/** The deposit preselected on a new proposal (AAP 0.7.3). */
export const DEFAULT_DEPOSIT_CENTS: DepositCents = 1000;
/** Reports whether `value` is one of {@link DEPOSIT_LEVELS_CENTS}: the proposal schema accepts any integer, so this separates `422 deposit_invalid` from `400 invalid_field`. */
export function isDepositLevel(value: number): value is DepositCents {
  return DEPOSIT_LEVELS_CENTS.some((level) => level === value);
}
/** The default per-person budget in cents at each deposit level; the deposit is never spent. */
export const DEFAULT_BUDGET_BY_DEPOSIT: Readonly<Record<DepositCents, number>> = {
  500: 1500,
  1000: 3000,
  2000: 6000,
};
/** Lowest per-person budget in cents, inclusive (AAP 0.5.4, `422 budget_out_of_range`). */
export const BUDGET_MIN_CENTS = 500 as const;
/** Highest per-person budget in cents, inclusive (AAP 0.5.4, `422 budget_out_of_range`). */
export const BUDGET_MAX_CENTS = 10000 as const;
/** Minutes before the start that check-in opens; earlier is `410 outside_window` (AAP 0.5.7). */
export const CHECK_IN_OPENS_BEFORE_MINUTES = 15 as const;
/** Minutes after the start that check-in closes and settlement runs; later is `410 outside_window`. */
export const CHECK_IN_CLOSES_AFTER_MINUTES = 45 as const;
/** Inclusive venue radius in metres; a farther point is `422 outside_geofence` (AAP 0.5.7). */
export const GEOFENCE_METERS = 150 as const;
/** Distance in metres under which a pass check-in stores `lt_50`; up to the geofence, `m50_150`. */
export const DISTANCE_BUCKET_SPLIT_METERS = 50 as const;
/** Hours before the start at which a cancellation stops being free: `startsAt - 2 h` is still free. */
export const LATE_CANCEL_WINDOW_HOURS = 2 as const;
/** Days within which a proposal's start must fall, counted from the proposal (AAP 0.5.4). */
export const START_HORIZON_DAYS = 5 as const;
/** Hours a recipient has to accept, from when the proposal becomes visible: `min(proposalVisibleAt + 48 h, startsAt)`. */
export const RECIPIENT_DEADLINE_HOURS = 48 as const;
/** Hours after the start within which a dispute may be filed; later is `409 dispute_window_closed`. */
export const DISPUTE_FILING_WINDOW_HOURS = 24 as const;
/** Days an operator has to resolve a dispute, from filing to its deadline (AAP 0.5.3). */
export const DISPUTE_RESOLUTION_DAYS = 5 as const;
/** Hours before that deadline the escalation job flags the dispute in `/ops` (AAP 0.5.3). */
export const DISPUTE_ESCALATE_BEFORE_HOURS = 24 as const;
/** Items per page for discovery, meetup lists and message history (AAP 0.5.4). */
export const PAGE_SIZE = 20 as const;
/** Longest chat message body in characters (AAP 0.5.2, 0.5.4). */
export const MESSAGE_MAX_CHARS = 1000 as const;
/** Longest tier-1 bio in characters (AAP 0.5.2). */
export const BIO_MAX_CHARS = 280 as const;
/** Longest tier-1 nickname in characters (AAP 0.5.2). */
export const NICKNAME_MAX_CHARS = 40 as const;
/** Longest home city in characters (AAP 0.5.2). */
export const HOME_CITY_MAX_CHARS = 80 as const;
/** Longest dispute or report reason in characters (AAP 0.5.2, 0.5.4). */
export const REASON_MAX_CHARS = 500 as const;
/** Most interest tags one profile may keep, drawn from the fixed vocabulary (AAP 0.5.2). */
export const INTEREST_TAGS_MAX = 3 as const;
/** Longest tier-3 full name in characters. The AAP sets no length, so this is the chosen limit. */
export const FULL_NAME_MAX_CHARS = 120 as const;
/** Longest tier-3 contact handle in characters. The AAP sets no length, so this is the limit. */
export const EXTERNAL_CONTACT_MAX_CHARS = 120 as const;
/** Longest booking name in characters. The AAP sets no length, so this is the chosen limit. */
export const BOOKING_NAME_MAX_CHARS = 120 as const;
/** Longest booking reference in characters. The AAP sets no length, so this is the chosen limit. */
export const BOOKING_REFERENCE_MAX_CHARS = 64 as const;
/** Largest accepted decoded profile photo in bytes; above it the route is `413 photo_too_large`. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Longest edge in pixels a stored profile photo is re-encoded to (AAP 0.5.2). */
export const PHOTO_MAX_EDGE_PX = 1024 as const;
/** Body limit in bytes of `PUT /me/profile`, which carries the base64 photo (AAP 0.5.4). */
export const PROFILE_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
/** Shortest provable stay in days (AAP 0.5.4, `422 stay_out_of_range`). */
export const STAY_MIN_DAYS = 1 as const;
/** Longest provable stay in days (AAP 0.5.4, `422 stay_out_of_range`). */
export const STAY_MAX_DAYS = 120 as const;
/** Days before arrival from which an itinerary proof is valid (AAP 0.5.2, 0.5.5). */
export const PROOF_VALID_FROM_DAYS_BEFORE = 2 as const;
/** Seconds per code step; the counter is `floor(serverTime / 60)` on the server (AAP 0.5.7). */
export const CODE_STEP_SECONDS = 60 as const;
/** Steps of tolerance around the counter: T-1, T and T+1 are accepted, T-2 is `422 invalid_code`. */
export const CODE_TOLERANCE_STEPS = 1 as const;
/** Digits in a venue check-in code (AAP 0.5.7). */
export const CODE_DIGITS = 6 as const;
/** How long the client keeps an entered code while offline before discarding it (AAP 0.5.7). */
export const OFFLINE_CODE_RETENTION_MS = 60_000 as const;
/** Resolution of an HTTP `Date` header in milliseconds. */
export const HTTP_DATE_RESOLUTION_MS = 1000;
/** The only header shape this module trusts: the IMF-fixdate form the API emits. `Date.parse` accepts far more — ISO 8601, RFC 850, asctime, an unzoned date-time read in the device's own zone — and an offset taken from one of those would be hours out. */
const HTTP_DATE_PATTERN =
  /^[A-Za-z]{3}, [0-9]{2} [A-Za-z]{3} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
/** Parses an HTTP `Date` header into epoch milliseconds: the header the API exposes to the web origin, which lets the offset be re-estimated on every response instead of trusting the device clock. `null` when the header is missing, blank or not in that form, so the caller keeps the offset it has. */
export function parseHttpDate(header: string | null | undefined): number | null {
  if (header === null || header === undefined) {
    return null;
  }
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!HTTP_DATE_PATTERN.test(trimmed)) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}
/** Estimates the offset to add to the device clock to obtain the server clock. An HTTP date carries whole seconds, so the server instant is taken as the middle of that second and the device instant that pairs with it as the midpoint of the round trip. */
export function estimateOffsetMs(sample: {
  serverDateMs: number;
  sentAtMs: number;
  receivedAtMs: number;
}): number {
  return Math.round(
    sample.serverDateMs + HTTP_DATE_RESOLUTION_MS / 2 - (sample.sentAtMs + sample.receivedAtMs) / 2,
  );
}
/** Radius in metres around the meetup venue that suggestions are searched in (AAP 0.5.7). */
export const SUGGESTION_RADIUS_METERS = 2000 as const;
/** Most suggestions returned for one meetup (AAP 0.5.7). */
export const SUGGESTIONS_MAX = 10 as const;
/** Most suggestions returned per place category (AAP 0.5.7). */
export const SUGGESTIONS_PER_CATEGORY_MAX = 3 as const;
/** Hours after the start from which a qualifying place must be open at some point (AAP 0.5.7). */
export const SUGGESTION_OPEN_FROM_HOURS_AFTER_START = 1 as const;
/** Latest local opening time, `HH:mm`, a qualifying place must open by (AAP 0.5.7). */
export const SUGGESTION_LOCAL_CUTOFF = '23:00' as const;
/** Lower bound of the ranking band, as a share of budget, that sorts before cheaper places. */
export const SUGGESTION_BUDGET_FIT_LOW = 0.7 as const;
/** Upper bound of that band: an estimate at or under the budget fits (AAP 0.5.7). */
export const SUGGESTION_BUDGET_FIT_HIGH = 1 as const;
/** Hours a completed meetup stays eligible for suggestions, counted from settlement (AAP 0.7.3). */
export const SUGGESTIONS_SETTLED_ELIGIBLE_HOURS = 24 as const;
/** Age in days past which an online-menu price is stale (AAP 0.5.7). */
export const FRESHNESS_ONLINE_DAYS = 30 as const;
/** Age in days past which a phone-quoted or operator-entered price is stale (AAP 0.5.7). */
export const FRESHNESS_PHONE_OPERATOR_DAYS = 60 as const;
/** Below this many priced items a place takes the phone fallback (AAP 0.5.6). */
export const MIN_PRICED_ITEMS = 5 as const;
/** Verified guest counts below this are reported as a label rather than a number (AAP 0.5.7). */
export const GUEST_COUNT_THRESHOLD = 3 as const;
/** The literal a guest count below {@link GUEST_COUNT_THRESHOLD} is serialized as (AAP 0.5.4). */
export const GUEST_COUNT_BELOW_LABEL = 'fewer than 3' as const;
/** Days of witnessed-meetup activity a lodging's leaderboard score counts (AAP 0.5.7). */
export const LEADERBOARD_WINDOW_DAYS = 90 as const;
/** Days in which one pair counts once per lodging, however often it meets (AAP 0.5.7). */
export const LEADERBOARD_PAIR_DEDUPE_DAYS = 30 as const;
/** Seconds a city's leaderboard response is cached in Redis (AAP 0.5.7). */
export const LEADERBOARD_CACHE_SECONDS = 60 as const;
/** Weekly points in the lodging console's 90-day trend (AAP 0.5.4). */
export const LODGING_TREND_WEEKS = 13 as const;
/** Hours after creation an unresolved lodging claim becomes `unreachable` (AAP 0.5.3). */
export const CLAIM_EXPIRY_HOURS = 72 as const;
/** Days in which one pair's completion counts once toward reputation and the leaderboard. */
export const ANTI_FARMING_WINDOW_DAYS = 30 as const;
/** Lowest deposit whose completed meetup can count toward reputation (AAP 0.5.7). */
export const ANTI_FARMING_MIN_DEPOSIT_CENTS = 500 as const;
/** Days a forfeited meetup counts as a no-show in a user's reputation counters (AAP 0.5.7). */
export const NO_SHOW_WINDOW_DAYS = 90 as const;
/** Attempts one call task may spend: a third is never dispatched (AAP 0.5.3). */
export const CALL_MAX_ATTEMPTS = 2 as const;
/** Hours that must pass between two attempts at the same call task (AAP 0.5.3, 0.5.6). */
export const CALL_RETRY_SPACING_HOURS = 24 as const;
/** Earliest local time, `HH:mm`, at which a call may start (AAP 0.5.6). */
export const CALLING_HOURS_START = '09:00' as const;
/** Latest local time, `HH:mm`, a call must finish by: it starts only while `now + CAP_CALL_SECONDS <= 20:00` in the business's city. */
export const CALLING_HOURS_END = '20:00' as const;
/** First delay in seconds before retrying a task after a definite vendor dispatch error (AAP 0.5.3). */
export const CALL_VENDOR_BACKOFF_BASE_SECONDS = 60 as const;
/** Multiplier applied to that delay for each further vendor failure (AAP 0.5.3). */
export const CALL_VENDOR_BACKOFF_FACTOR = 2 as const;
/** Vendor failures after which a task becomes `needs_review`: `vendor_unavailable` (AAP 0.5.3). */
export const CALL_VENDOR_MAX_FAILURES = 8 as const;
/** Minutes after `CAP_CALL_SECONDS` that an unreconciled dispatch becomes `dispatch_unknown`. */
export const CALL_DISPATCH_GRACE_MINUTES = 15 as const;
/** Millisecond timeout on the language-model call that classifies one voice turn (AAP 0.5.6). */
export const LLM_TURN_TIMEOUT_MS = 3000 as const;
/** Minutes a magic-link token stays valid; a token is single use (AAP 0.5.2). */
export const MAGIC_LINK_TTL_MINUTES = 15 as const;
/** Magic-link requests allowed per email address per hour (AAP 0.5.4, `429 rate_limited`). */
export const MAGIC_LINK_MAX_PER_EMAIL_PER_HOUR = 5 as const;
/** Minutes an access token stays valid (AAP 0.3.2). */
export const ACCESS_TOKEN_TTL_MINUTES = 15 as const;
/** Days a refresh token stays valid (AAP 0.5.2). */
export const REFRESH_TOKEN_TTL_DAYS = 30 as const;
/** Seconds a read-only session is cached in Redis; the deletion write fence reads PostgreSQL, not it. */
export const SESSION_CACHE_SECONDS = 30 as const;
/** Mutating requests allowed per user per minute (AAP 0.5.4, `429 rate_limited`). */
export const RATE_LIMIT_USER_PER_MIN = 60 as const;
/** Webhook requests allowed per IP per minute; the general per-IP limit is `RATE_LIMIT_IP_PER_MIN`. */
export const RATE_LIMIT_WEBHOOK_IP_PER_MIN = 6000 as const;

/**
 * The version prefix every API route is mounted under (AAP 0.5.4): the composition root mounts every
 * module beneath it and every client builds its paths from it, so the value is declared once for the
 * workspace here in `@tablemate/shared`.
 */
export const API_PATH_PREFIX = '/v1' as const;

/**
 * The chat socket's path relative to {@link API_PATH_PREFIX} (AAP 0.4.1, AAP 0.5.4): the messaging
 * module registers it under that prefix, and the app's socket client appends the prefix and this
 * path to its configured origin, which composes the `WS /v1/chat` `docs/api/README.md` publishes.
 */
export const CHAT_PATH = '/chat' as const;

/**
 * The app's sign-in route (AAP 0.3.2, AAP 0.5.4, AAP 0.11.1): the magic-link email opens it as
 * `${WEB_ORIGIN}${MAGIC_LINK_PATH}?token=…`, the app's own deep link spells it
 * `tablemate://auth/verify?token=…` — the same path with its leading slash dropped, because a
 * custom-scheme link takes the route's first segment after the scheme separator — and the Expo
 * Router screen `apps/mobile/app/auth/verify.tsx` serves it: declared once here, so the mailer, the
 * deep-link builder and the route metadata cannot drift from that route file's name.
 */
export const MAGIC_LINK_PATH = '/auth/verify' as const;
