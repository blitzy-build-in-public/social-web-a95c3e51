/**
 * Every fixed, user-facing English string the client renders (AAP 0.5.8).
 *
 * A string that carries a rule's own number — the deposit levels, the late-cancellation window, the dispute windows —
 * is built from the shared constants rather than typed out, so the copy cannot drift from what the API enforces. A
 * string another module owns stays there: the framing copy in `depositCopy`, the lock-loss copy in `LOCK_LOST_COPY`
 * and the low guest count in `GUEST_COUNT_BELOW_LABEL` are never repeated here. Every string AAP 0.5.8 states is
 * copied character for character from it, and the two page-chrome strings at the foot of the file come from its
 * accessibility rules instead. No `Intl`, `Date`, React Native or Node API is used, so the e2e support scripts and
 * Vitest also load this module under plain Node.
 */
import {
  DEPOSIT_LEVELS_CENTS,
  DISPUTE_FILING_WINDOW_HOURS,
  DISPUTE_RESOLUTION_DAYS,
  GUEST_COUNT_BELOW_LABEL,
  LATE_CANCEL_WINDOW_HOURS,
} from '@tablemate/shared';
import type { GuestCount, SuggestionEmptyReason, Tier0Profile } from '@tablemate/shared';

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
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const BOOKING_NAME_FALLBACK = 'the name on your booking';
export const SAFETY_NOTICE = 'Your deposit is not a safety guarantee.';
export const SAFETY_TIPS_TITLE = 'Basic safety tips';

export const SAFETY_TIPS = [
  'Meet only at the partner venue.',
  "Tell a friend where you'll be.",
  'Keep your own transport.',
  'Leave if uncomfortable.',
  'Report problems.',
] as const;
/**
 * What Table Credit is wherever it is granted or explained (AAP 0.5.8, 0.7.2): a forfeit becomes
 * credit, never cash, and no money is transmitted to a user or a venue.
 */
export const TABLE_CREDIT_NOTICE =
  'Table Credit is in USD, redeemable at partner venues, and has no cash value.';
export const AGE_GATE_CONFIRM = 'I confirm I am 18 or older.';
/**
 * The terms version a traveller accepts, sent as `termsVersion` in
 * `POST /v1/me/consents { adult: true, termsVersion }` (AAP 0.5.4). Bump it with
 * {@link TERMS_SUMMARY} or {@link TERMS_SECTIONS} and with the API's `TERMS_VERSION` default in the
 * same change: the consents handler rejects any other value with `400 invalid_field`.
 */
export const TERMS_VERSION = '2026-11-04';

export const TERMS_SUMMARY = [
  `Each meetup places a refundable hold of ${DEPOSIT_AMOUNTS_TEXT} USD on both attendees' saved cards. Both holds are released when you both check in, when neither of you checks in, or when the meetup is cancelled at least ${LATE_CANCEL_WINDOW_HOURS} hours before it starts.`,
  `If only one of you checks in, the absent attendee's hold is captured. Cancelling less than ${LATE_CANCEL_WINDOW_HOURS} hours before the start counts as not showing up.`,
  TABLE_CREDIT_NOTICE,
] as const;

export interface TermsSection {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

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
export const TERMS_PENDING_REVIEW_NOTE = 'Pending legal review';

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

export interface LodgingCallNoticeInput {
  readonly lodging: string;
  readonly bookingName: string;
  readonly stayFrom: string;
  readonly stayTo: string;
}

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

export const LODGING_CALL_CONSENT_LABEL = 'I understand and agree to this call.';

export function guestListWarning(city: string): string {
  return `Sharing where you sleep affects your safety. Verified travelers in ${city.trim()} will be able to see that you are staying here.`;
}

export const STAY_TOGGLE_LABEL = "Show that I'm staying here";
export { GUEST_COUNT_BELOW_LABEL };

export function guestCountText(count: GuestCount): string {
  return typeof count === 'number' ? String(count) : GUEST_COUNT_BELOW_LABEL;
}

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

export const OSM_LICENSE_NOTE =
  'Place data from OpenStreetMap is available under the Open Database License (ODbL).';
export const FX_ATTRIBUTION = 'Rates By Exchange Rate API';
export const FX_ATTRIBUTION_URL = 'https://www.exchangerate-api.com';
export const EMAIL_STAYS_ON_DEVICE = 'Your email never leaves this device.';

export const IMPORT_BANNER =
  'Import a booking confirmation to propose meetups and appear to other travelers.';
export const UNSUPPORTED_ISSUER = "This booking site isn't supported yet.";

export function supportedIssuersText(names: readonly string[]): string {
  return names.length === 0
    ? 'No booking sites are supported yet.'
    : `Supported booking sites: ${names.join(', ')}.`;
}

export function unsupportedIssuersText(names: readonly string[]): string {
  return `Not yet supported: ${names.join(', ')}.`;
}

export const CHECKED_IN_NOTICE = "You're checked in.";
export const BOTH_CHECKED_IN_NOTICE = "You're both checked in.";
export const CHECK_IN_CLOSED_NOTICE = 'This meetup has finished, so check-in is closed.';
export const VENUE_CODE_FILLED_NOTICE = 'Venue code filled in.';

function witnessedMeetupsText(count: number): string {
  return count === 1 ? '1 witnessed meetup' : `${count} witnessed meetups`;
}

export function travelerSubtitle(profile: Tier0Profile): string {
  const parts = [witnessedMeetupsText(profile.reputation.witnessedMeetups)];
  const tags = profile.interestTags.map((tag) => tag.replace(/_/g, ' '));
  if (tags.length > 0) parts.push(tags.join(', '));
  const { proofDates } = profile;
  if (proofDates !== null) {
    const { arrivalDate, departureDate } = proofDates;
    parts.push(`${formatCalendarDate(arrivalDate)} – ${formatCalendarDate(departureDate)}`);
  }
  return parts.join(' · ');
}

export const DISCOVERY_EMPTY =
  'No travelers here yet. Check back later or plan your day at a partner venue.';

export const VENUES_EMPTY =
  "No partner venues in this city yet. We're adding them — check back soon.";
export const MESSAGES_EMPTY = "Say hello — you can chat now that you've both held your seats.";

export const REPUTATION_EMPTY =
  'No witnessed meetups yet. Propose one at a partner venue to start.';

export const SUGGESTIONS_EMPTY = {
  no_priced_places:
    "We don't have prices for places near this venue yet. Check back closer to your meetup.",
  none_open:
    'Nothing nearby is listed as open between an hour after your meetup and 23:00. Check opening hours directly before heading anywhere.',
  budget_too_low:
    'Nothing nearby fits this budget. Raise the per-person budget to see more places.',
} as const satisfies Record<SuggestionEmptyReason, string>;
export const CARD_PAYMENTS_UNAVAILABLE = 'Card payments are not configured in this environment.';
export const REASON_FIELD_LABEL = 'Describe the problem';

export function remainingCharsText(value: string, maxLength: number): string {
  const remaining = Math.max(0, maxLength - value.length);
  return remaining === 1 ? '1 character left' : `${remaining} characters left`;
}

export const CHAT_MENU_ANNOUNCEMENT = 'More options: report or block.';
export const DELETE_CONFIRM_ANNOUNCEMENT = 'Press Permanently delete my account to confirm.';
export const MAIN_LANDMARK_LABEL = 'Main content';
export const SKIP_TO_CONTENT = 'Skip to content';
