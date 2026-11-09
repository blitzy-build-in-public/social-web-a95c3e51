/**
 * Every fixed, user-facing English string the Tablemate client renders (AAP 0.5.8, 0.8.1).
 *
 * A string that carries a rule's own number -- the deposit levels, the late-cancellation window,
 * the dispute windows -- is built from the shared constants rather than typed out, so the copy
 * cannot drift from what the API enforces. A string another module owns stays there: the framing
 * copy in `depositCopy`, the lock-loss copy in `LOCK_LOST_COPY` and the low guest count in
 * `GUEST_COUNT_BELOW_LABEL` are never repeated here. Every string is copied character for
 * character from AAP 0.5.8. No `Intl`, `Date`, React Native or Node API is used, so the e2e support
 * scripts and Vitest also load this module under plain Node.
 */
import {
  DEPOSIT_LEVELS_CENTS,
  DISPUTE_FILING_WINDOW_HOURS,
  DISPUTE_RESOLUTION_DAYS,
  GUEST_COUNT_BELOW_LABEL,
  LATE_CANCEL_WINDOW_HOURS,
} from '@tablemate/shared';
import type { GuestCount, SuggestionEmptyReason } from '@tablemate/shared';

// --- Private helpers ---------------------------------------------------------------------------

/** Joins items as an English list ending in `or`: `['5', '10', '20']` -> `'5, 10 or 20'`. */
function joinWithOr(items: readonly string[]): string {
  if (items.length === 0) return '';
  const head = items.slice(0, -1).join(', ');
  const last = items[items.length - 1] ?? '';
  return head === '' ? last : `${head} or ${last}`;
}

/**
 * The accepted deposit levels as whole USD amounts, e.g. `'5, 10 or 20'` (AAP 0.7.3), built from
 * {@link DEPOSIT_LEVELS_CENTS} so no sentence can drift from what `POST /meetups` accepts.
 *
 * The one home for the text: {@link TERMS_SUMMARY}, the terms screen's Card holds paragraph and
 * `src/api/errors.ts`'s `deposit_invalid` sentence all read it, so the deposit amounts are written
 * once.
 */
export const DEPOSIT_AMOUNTS_TEXT = joinWithOr(
  DEPOSIT_LEVELS_CENTS.map((cents) => String(cents / 100)),
);

/** English month names for {@link formatCalendarDate}: a fixed table, never `Intl` or the locale. */
const ENGLISH_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** `YYYY-MM-DD` exactly: four digits, two digits, two digits, and nothing around them. */
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Stands where a booking name has not been typed yet, so {@link lodgingCallNotice} can render. */
const BOOKING_NAME_FALLBACK = 'the name on your booking';

// --- Safety: Propose, Accept and lock, app/legal/safety.tsx -------------------------------------

/** Shown above the tips on Propose, Accept and lock: the hold is not a safety check (AAP 0.5.8). */
export const SAFETY_NOTICE = 'Your deposit is not a safety guarantee.';

/** The heading over {@link SAFETY_TIPS} on Propose, Accept and lock, and on the safety screen. */
export const SAFETY_TIPS_TITLE = 'Basic safety tips';

/** The five safety tips of AAP 0.5.8, in the request's order, shown under {@link SAFETY_NOTICE}. */
export const SAFETY_TIPS = [
  'Meet only at the partner venue.',
  "Tell a friend where you'll be.",
  'Keep your own transport.',
  'Leave if uncomfortable.',
  'Report problems.',
] as const;

// --- Table Credit: settlement result, app/profile/credit.tsx, terms -----------------------------

/**
 * What Table Credit is wherever it is granted or explained (AAP 0.5.8, 0.7.2): a forfeit becomes
 * credit, never cash, and no money is transmitted to a user or a venue.
 */
export const TABLE_CREDIT_NOTICE =
  'Table Credit is in USD, redeemable at partner venues, and has no cash value.';

// --- Age gate and terms: app/(auth)/age-gate.tsx, app/legal/terms.tsx ---------------------------

/** The age-gate checkbox label on first sign-in, before any feature route works (AAP 0.12.2). */
export const AGE_GATE_CONFIRM = 'I confirm I am 18 or older.';

/**
 * The terms version a traveller accepts, sent as `termsVersion` in
 * `POST /v1/me/consents { adult: true, termsVersion }` (AAP 0.5.4). Bump it with
 * {@link TERMS_SUMMARY} or {@link TERMS_SECTIONS} and with the API's `TERMS_VERSION` default in the
 * same change: the consents handler rejects any other value with `400 invalid_field`.
 */
export const TERMS_VERSION = '2026-11-04';

/**
 * The three factual lines shown on the age gate under {@link AGE_GATE_CONFIRM} (AAP 0.5.8): what a
 * hold is, when one is released, and what Table Credit is. Neutral and identical for both
 * experiment variants, whose only variable is the framing copy on the deposit screens.
 */
export const TERMS_SUMMARY = [
  `Each meetup places a refundable hold of ${DEPOSIT_AMOUNTS_TEXT} USD on both attendees' saved cards. Both holds are released when you both check in, when neither of you checks in, or when the meetup is cancelled at least ${LATE_CANCEL_WINDOW_HOURS} hours before it starts.`,
  `If only one of you checks in, the absent attendee's hold is captured. Cancelling less than ${LATE_CANCEL_WINDOW_HOURS} hours before the start counts as not showing up.`,
  TABLE_CREDIT_NOTICE,
] as const;

/** One titled block of the terms screen: a heading and the paragraphs under it. */
export interface TermsSection {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

/**
 * The full terms shown on `app/legal/terms.tsx` (AAP 0.5.8): holds, forfeits and Table Credit in
 * the same neutral voice as {@link TERMS_SUMMARY}, plus the lost-hold, dispute and safety rules.
 * Every figure is a shared constant, so a window or a deposit change moves the API and this text
 * together.
 */
export const TERMS_SECTIONS = [
  {
    title: 'Who can use Tablemate',
    paragraphs: ['You must be 18 or older to use Tablemate.'],
  },
  {
    title: 'Card holds',
    paragraphs: [
      `When you propose a meetup or accept one, Tablemate places a refundable hold on your saved card for the amount you chose: ${DEPOSIT_AMOUNTS_TEXT} USD. Both attendees hold the same amount, always in USD.`,
      'A hold is an authorization, not a charge: no money moves while the meetup is open, and a released hold costs you nothing.',
      `Both holds are released when you both check in, when neither of you checks in, or when the meetup is cancelled at least ${LATE_CANCEL_WINDOW_HOURS} hours before it starts.`,
    ],
  },
  {
    title: 'Forfeits',
    paragraphs: [
      "If only one of you checks in, the absent attendee's hold is captured, and the attendee who checked in receives Table Credit equal to the deposit.",
      `Cancelling less than ${LATE_CANCEL_WINDOW_HOURS} hours before the start counts as not showing up: the canceller's hold is captured and the other attendee receives Table Credit equal to the deposit.`,
    ],
  },
  {
    title: 'Table Credit',
    paragraphs: [TABLE_CREDIT_NOTICE],
  },
  {
    title: 'Lost holds',
    paragraphs: ['If a card hold ends before the meetup settles, no deposit applies.'],
  },
  {
    title: 'Disputes',
    paragraphs: [
      `You can report a problem from the meetup screen until ${DISPUTE_FILING_WINDOW_HOURS} hours after the start. An operator resolves a dispute within ${DISPUTE_RESOLUTION_DAYS} days.`,
      'If the venue cannot witness your check-in, report it before the check-in window ends and no deposit applies.',
    ],
  },
  {
    title: 'Safety',
    paragraphs: [SAFETY_NOTICE],
  },
] as const satisfies readonly TermsSection[];

/** Shown beside the terms in non-production builds, where the legal review has not happened. */
export const TERMS_PENDING_REVIEW_NOTE = 'Pending legal review';

// --- Lodging claim and visibility: app/lodgings/claim.tsx, app/profile/stay.tsx -----------------

/**
 * Renders `YYYY-MM-DD` as `D Month YYYY`: `'2027-03-12'` -> `'12 March 2027'`.
 *
 * Stay dates are calendar dates with no time zone, so `Date` (which parses `YYYY-MM-DD` as UTC and
 * can print the previous day west of Greenwich) and `Intl` (which follows the device locale) are
 * both wrong here. Anything not exactly `YYYY-MM-DD` is returned unchanged, so a screen never
 * receives an exception from a value a traveller typed.
 */
export function formatCalendarDate(date: string): string {
  const match = CALENDAR_DATE_PATTERN.exec(date);
  if (match === null) return date;

  const year = match[1];
  const month = match[2];
  const day = match[3];
  if (year === undefined || month === undefined || day === undefined) return date;

  const monthName = ENGLISH_MONTHS[Number(month) - 1];
  if (monthName === undefined) return date;

  const dayOfMonth = Number(day);
  if (dayOfMonth < 1 || dayOfMonth > 31) return date;

  return `${dayOfMonth} ${monthName} ${year}`;
}

/** The fields {@link lodgingCallNotice} names for the verification call. */
export interface LodgingCallNoticeInput {
  /** The lodging's name, as the directory lists it. */
  readonly lodging: string;
  /** The booking name on the reservation; blank until the traveller fills the field. */
  readonly bookingName: string;
  /** The stay's first night, `YYYY-MM-DD`. */
  readonly stayFrom: string;
  /** The stay's last night, `YYYY-MM-DD`. */
  readonly stayTo: string;
}

/**
 * The lodging exception notice shown on `app/lodgings/claim.tsx` (AAP 0.5.8, 0.12.2). A
 * stay-verification call is the one place Tablemate's zero-knowledge principle is set aside, so the
 * traveller reads this before consent: the call names the booking and tells the lodging that a
 * guest with that name uses Tablemate. The screen renders the notice before
 * {@link LODGING_CALL_CONSENT_LABEL}'s checkbox becomes enabled, and a blank booking name becomes
 * `'the name on your booking'` so the notice reads in full while the field is still empty.
 */
export function lodgingCallNotice({
  lodging,
  bookingName,
  stayFrom,
  stayTo,
}: LodgingCallNoticeInput): string {
  const name = bookingName.trim();
  const from = formatCalendarDate(stayFrom.trim());
  const to = formatCalendarDate(stayTo.trim());
  return `To verify your stay, an automated assistant will call ${lodging.trim()} and ask whether a guest named ${name === '' ? BOOKING_NAME_FALLBACK : name} is staying from ${from} to ${to}. The lodging will learn that a guest with this name uses Tablemate. This is an exception to Tablemate's zero-knowledge principle.`;
}

/** The visible label of the claim screen's consent checkbox, which gates the verification call. */
export const LODGING_CALL_CONSENT_LABEL = 'I understand and agree to this call.';

/**
 * The warning shown on `app/profile/stay.tsx` before `showStaying` can be turned on (AAP 0.5.8):
 * a guest list discloses where the traveller sleeps, so the switch stays off until this is read.
 */
export function guestListWarning(city: string): string {
  return `Sharing where you sleep affects your safety. Verified travelers in ${city.trim()} will be able to see that you are staying here.`;
}

/** The label of the staying-visibility switch on `app/profile/stay.tsx`, which is off by default. */
export const STAY_TOGGLE_LABEL = "Show that I'm staying here";

/**
 * Re-exported so a screen can take its copy and this label from one module. The label belongs to
 * the shared package and the server alone applies the threshold -- a count under three never leaves
 * it as a number (AAP 0.5.4, 0.5.7) -- so nothing here computes or compares it.
 */
export { GUEST_COUNT_BELOW_LABEL };

/**
 * Renders a verified guest count for the lodging list, detail page and lodging console (AAP 0.5.8).
 * A number is always three or more; the label is printed verbatim.
 */
export function guestCountText(count: GuestCount): string {
  return typeof count === 'number' ? String(count) : GUEST_COUNT_BELOW_LABEL;
}

// --- Attribution: suggestions, lodgings, app/legal/attribution.tsx ------------------------------

/** OpenStreetMap's required credit, shown wherever place or lodging data appears (AAP 0.3.1). */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Where {@link OSM_ATTRIBUTION} links on the suggestions screen and the attribution page. */
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/** The licence the OpenStreetMap place and lodging data is used under (AAP 0.3.1). */
export const OSM_LICENSE_NOTE =
  'Place data from OpenStreetMap is available under the Open Database License (ODbL).';

/** ExchangeRate-API's required open-access credit for the daily FX table (AAP 0.3.1, 0.3.3). */
export const FX_ATTRIBUTION = 'Rates By Exchange Rate API';

/** Where {@link FX_ATTRIBUTION} links on the attribution page. */
export const FX_ATTRIBUTION_URL = 'https://www.exchangerate-api.com';

// --- Proof import: app/proof/{import,generate}.tsx, Discover banner, Propose button -------------

/**
 * Shown before and during proving: it is literally true, because only `{ proof, publicSignals }`
 * leaves the device (AAP 0.5.8, 0.12.2).
 */
export const EMAIL_STAYS_ON_DEVICE = 'Your email never leaves this device.';

/** The Discover banner for a traveller with no valid proof, and the Propose button (AAP 0.5.8). */
export const IMPORT_BANNER =
  'Import a booking confirmation to propose meetups and appear to other travelers.';

/** Shown for an email whose DKIM domain matches no supported issuer (AAP 0.5.8, 0.5.5). */
export const UNSUPPORTED_ISSUER = "This booking site isn't supported yet.";

/**
 * The line under {@link UNSUPPORTED_ISSUER} naming the supported booking sites, or the registry's
 * empty line (AAP 0.5.5, 0.5.8). The names come from `GET /v1/zk/config`, which lists only verified
 * issuers; until samples arrive that list is empty.
 */
export function supportedIssuersText(names: readonly string[]): string {
  return names.length === 0
    ? 'No booking sites are supported yet.'
    : `Supported booking sites: ${names.join(', ')}.`;
}

/**
 * The sentence naming the booking sites whose issuer the registry does not verify yet (AAP 0.5.5,
 * 0.5.8), for an email whose DKIM domain matches one of them: `app/proof/import.tsx` shows it as the
 * warning banner's message, and `app/proof/generate.tsx` composes it under
 * {@link supportedIssuersText}. The names come from `GET /v1/zk/config`, which lists an issuer this
 * way until its samples arrive and it receives a production leaf. Both screens render this one
 * sentence, so the two proof screens cannot drift from each other.
 */
export function unsupportedIssuersText(names: readonly string[]): string {
  return `Not yet supported: ${names.join(', ')}.`;
}

// --- Check-in: app/meetups/[id]/{check-in,index}.tsx, app/(tabs)/meetups.tsx ---------------------

/**
 * Confirms the caller's own check-in (AAP 0.5.7): the check-in screen's success card, and the line
 * that marks the caller as checked in on the meetup detail card and on the Meetups list row.
 */
export const CHECKED_IN_NOTICE = "You're checked in.";

/**
 * The pair-completion sentence shown under {@link CHECKED_IN_NOTICE} in the same success card
 * (AAP 0.5.7, 0.5.8): `CheckInResponse.bothCheckedIn` is true once the second pass check-in exists,
 * which is the meetup the headline completion rate counts.
 */
export const BOTH_CHECKED_IN_NOTICE = "You're both checked in.";

/**
 * The refusal a meetup that has already finished gets (AAP 0.5.3, 0.5.4). Every `MeetupStatus`
 * except `proposed` and `locked` is final, and the check-in route answers `409 not_locked` for all
 * of them alike, so the check-in screen resolves which one it is from `GET /meetups/:id` rather
 * than explaining a settled meetup as one that has not been locked yet. It is the terminal card's
 * title for a final status, and the sentence a `not_locked` refusal is announced with once a fresh
 * read reports one.
 */
export const CHECK_IN_CLOSED_NOTICE = 'This meetup has finished, so check-in is closed.';

// --- Empty states (AAP 0.5.8, verbatim) ---------------------------------------------------------

/** The Discover tab with no travelers holding a valid proof for the city (AAP 0.5.8). */
export const DISCOVERY_EMPTY =
  'No travelers here yet. Check back later or plan your day at a partner venue.';

/** The city page's partner-venue list when the city has no venues yet (AAP 0.5.8). */
export const VENUES_EMPTY =
  "No partner venues in this city yet. We're adding them — check back soon.";

/** Chat opened before either attendee has written anything (AAP 0.5.8). */
export const MESSAGES_EMPTY = "Say hello — you can chat now that you've both held your seats.";

/** The profile's reputation block before any witnessed meetup (AAP 0.5.8). */
export const REPUTATION_EMPTY =
  'No witnessed meetups yet. Propose one at a partner venue to start.';

/**
 * The message shown for each reason the suggestions route gave for an empty list (AAP 0.5.8),
 * keyed by `SuggestionEmptyReason`: a new reason fails the type check here rather than rendering an
 * undefined message. The API checks the reasons in that order, and the budget control sits beside
 * `budget_too_low`'s message.
 */
export const SUGGESTIONS_EMPTY = {
  no_priced_places:
    "We don't have prices for places near this venue yet. Check back closer to your meetup.",
  none_open:
    'Nothing nearby is listed as open between an hour after your meetup and 23:00. Check opening hours directly before heading anywhere.',
  budget_too_low:
    'Nothing nearby fits this budget. Raise the per-person budget to see more places.',
} as const satisfies Record<SuggestionEmptyReason, string>;

// --- Payments: apps/mobile/src/payments/* -------------------------------------------------------

/**
 * Shown where a card would be entered when `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` is absent (AAP
 * 0.11.2): the credential-free default stack runs with `STRIPE_MODE=mock`, so Stripe.js and
 * PaymentSheet have nothing to initialize. Card holds need a test-mode key.
 */
export const CARD_PAYMENTS_UNAVAILABLE = 'Card payments are not configured in this environment.';
