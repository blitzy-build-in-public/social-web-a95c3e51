/**
 * The client error model: the one error type the API and WebSocket clients raise, the parser that turns a failing HTTP
 * response into it, and the code-to-sentence map a screen renders. An `ApiError` never carries the server's `message`
 * text or any part of the body — it leaves as a code alone, which is also what makes it safe to log.
 */
import {
  BUDGET_MAX_CENTS,
  BUDGET_MIN_CENTS,
  CHECK_IN_CLOSES_AFTER_MINUTES,
  CHECK_IN_OPENS_BEFORE_MINUTES,
  DISPUTE_FILING_WINDOW_HOURS,
  ErrorCode,
  ErrorEnvelope,
  PHOTO_MAX_BYTES,
  START_HORIZON_DAYS,
  STAY_MAX_DAYS,
  STAY_MIN_DAYS,
} from '@tablemate/shared';
import { DEPOSIT_AMOUNTS_TEXT } from '../copy/strings';
/**
 * Every code the client can hold: the shared server codes, plus `network_error` and `invalid_response`, which must
 * never be added to the shared `ErrorCode` enum.
 */
export type ClientErrorCode = ErrorCode | 'network_error' | 'invalid_response';

interface ApiErrorOptions {
  /** Whole seconds to wait before retrying, from a 429's `Retry-After`. Omitted when unknown. */
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  /** HTTP status of the response, or 0 for a network failure or a timeout. */
  readonly status: number;
  readonly code: ClientErrorCode;
  /** Whole seconds to wait before retrying, when a 429 said so. */
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: ClientErrorCode, options?: ApiErrorOptions) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    // Assigned only when known: `exactOptionalPropertyTypes` keeps absent and `undefined` distinct.
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
    // Babel's class transform under Hermes does not preserve the prototype chain of a built-in
    // subclass, so `instanceof ApiError` fails without this. It must run after `super`.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

// True only for a request that never reached the API, which `src/state/meetup-store.ts` reads so React Query retries
// it and treats a 4xx answer as final.
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'network_error';
}

export function networkError(): ApiError {
  return new ApiError(0, 'network_error');
}

export function invalidResponse(status: number): ApiError {
  return new ApiError(status, 'invalid_response');
}

/**
 * Turns a failing HTTP response into an `ApiError`: a body that is empty, not JSON or not the envelope yields
 * `invalid_response`, and the status comes from the response, never the body, with no part of the body kept. A 429's
 * `Retry-After` is read as whole seconds only — unreadable cross-origin unless the answer exposes it — so callers
 * treat `retryAfterSeconds` as an optional hint.
 *
 * @param response - Typed structurally, so both `Response` implementations and a test literal fit it.
 */
export function parseError(
  response: { status: number; headers: { get(name: string): string | null } },
  bodyText: string,
): ApiError {
  const retryAfterSeconds = retryAfterSecondsFrom(response);
  const options = retryAfterSeconds === undefined ? undefined : { retryAfterSeconds };
  const code = codeFromBody(bodyText);
  return code === undefined
    ? new ApiError(response.status, 'invalid_response', options)
    : new ApiError(response.status, code, options);
}

function codeFromBody(bodyText: string): ClientErrorCode | undefined {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const envelope = ErrorEnvelope.safeParse(body);
  return envelope.success ? envelope.data.error.code : undefined;
}

function retryAfterSecondsFrom(response: {
  status: number;
  headers: { get(name: string): string | null };
}): number | undefined {
  if (response.status !== 429) return undefined;
  const header = response.headers.get('Retry-After');
  if (header === null) return undefined;
  const value = header.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';
const PHOTO_MAX_MEGABYTES = PHOTO_MAX_BYTES / 1024 / 1024;
/**
 * The fixed English sentence each code shows a user (AAP 0.5.8: English only). Keys are `ClientErrorCode` members, so
 * a misspelt key fails typecheck; a sentence carrying a rule's own number is built from that shared constant, so the
 * copy cannot drift from what the API enforces.
 */
const MESSAGES: Partial<Record<ClientErrorCode, string>> = {
  // Client-side codes, raised by this client only; an answer that is not the envelope shows the fallback.
  network_error: 'No connection. Check your network and try again.',
  invalid_response: GENERIC_MESSAGE,
  invalid_email: "That email address doesn't look right.",
  proof_malformed: "We couldn't read that proof. Import your booking again.",
  invalid_field: "Some of those details aren't accepted. Check them and try again.",
  consent_missing: 'Confirm the call notice before continuing.',
  booking_name_empty: 'Enter the name on the booking.',
  bad_signature: "We couldn't verify that request.",
  token_invalid: 'Your session ended. Sign in again.',
  bad_venue_secret: 'The venue sign-in details are not valid.',
  bad_lodging_secret: 'The lodging sign-in details are not valid.',
  hold_failed: 'Your card could not be held. Check or update your saved card and try again.',
  no_valid_proof: 'You need a verified stay in this city first.',
  not_recipient: 'Only the traveler who received this proposal can answer it.',
  not_initiator: 'Only the traveler who sent this proposal can do that.',
  not_participant: "You're not part of this meetup.",
  messaging_locked: 'Chat opens once both seats are held.',
  blocked: "You can't interact with this traveler.",
  operator_only: 'This area is for operators only.',
  age_gate_required: 'Confirm that you are 18 or older to continue.',
  city_not_found: 'That city is not available.',
  user_not_found: 'That traveler is not available.',
  venue_not_found: 'That venue is not available.',
  meetup_not_found: 'That meetup is not available.',
  lodging_not_found: 'That lodging is not available.',
  claim_not_found: 'That stay is not available.',
  not_found: 'We could not find that.',
  nullifier_used: 'This booking has already been used to verify a stay.',
  meetup_exists: 'You already have an open meetup with this traveler.',
  not_proposed: 'This proposal can no longer be answered.',
  hold_pending: 'Your card hold is still being confirmed. Try again in a moment.',
  already_settled: 'This meetup has already been settled.',
  dispute_open: 'A report is open on this meetup, so it cannot be changed right now.',
  not_locked: 'This meetup is not locked yet.',
  already_checked_in: 'You have already checked in.',
  dispute_window_closed: `The ${DISPUTE_FILING_WINDOW_HOURS} hours for reporting a problem have passed.`,
  meetup_not_locked: 'Day-plan ideas are available once the meetup is locked.',
  active_claim_exists: 'You already have a stay being verified.',
  call_in_progress: 'A call to the lodging is in progress. Try again when it ends.',
  no_verified_claim: 'Verify your stay before sharing it.',
  details_unavailable: 'The booking details are no longer available.',
  proposal_lapsed: 'This proposal expired before it was answered.',
  outside_window: `Check-in opens ${CHECK_IN_OPENS_BEFORE_MINUTES} minutes before the start and closes ${CHECK_IN_CLOSES_AFTER_MINUTES} minutes after it.`,
  photo_too_large: `That photo is too large. Choose one under ${PHOTO_MAX_MEGABYTES} MB.`,
  proof_invalid: "That proof didn't verify. Import your booking again.",
  issuer_not_allowlisted: "We don't verify stays from that booking site yet.",
  stay_out_of_range: `Stays of ${STAY_MIN_DAYS} to ${STAY_MAX_DAYS} days can be verified.`,
  self_proposal: "You can't propose a meetup to yourself.",
  venue_not_partner: 'Meetups can only be planned at a partner venue.',
  starts_at_invalid: `Pick a start time within the next ${START_HORIZON_DAYS} days.`,
  deposit_invalid: `Choose a deposit of ${DEPOSIT_AMOUNTS_TEXT} USD.`,
  invalid_code: 'That code is wrong or expired. Enter the code shown at the venue.',
  outside_geofence: 'You need to be at the venue to check in.',
  invalid_outcome: 'That action is not available for this item.',
  budget_out_of_range: `Choose a per-person budget between ${BUDGET_MIN_CENTS / 100} and ${BUDGET_MAX_CENTS / 100} USD.`,
  claim_dates_invalid: 'Your stay dates must fall inside your verified dates.',
  lodging_other_city: 'That lodging is not in your verified city.',
  rate_limited: "You're doing that too often. Wait a moment and try again.",
  daily_cap_reached: 'The daily limit is reached. Try again tomorrow.',
  internal_error: 'Something went wrong on our side. Please try again.',
  fx_rate_unavailable:
    'No exchange rate for that currency yet. Enter the price in USD, or try again after the daily exchange-rate refresh.',
  payment_unavailable:
    'Payment is catching up: your hold is still being confirmed. Check back shortly.',
  service_unavailable: 'Tablemate is briefly unavailable. Please try again shortly.',
  suggestions_unavailable: "We couldn't load day-plan ideas right now. Try again shortly.",
};
/**
 * The sentence a screen shows for an error code (AAP 0.5.4). An unknown string returns the generic sentence rather than
 * exposing it.
 */
export function userMessageFor(code: string): string {
  if (!isClientErrorCode(code)) return GENERIC_MESSAGE;
  return MESSAGES[code] ?? GENERIC_MESSAGE;
}

/** Narrows a string to the codes this client can hold, checked against the shared schema (AAP 0.11.1). */
function isClientErrorCode(code: string): code is ClientErrorCode {
  return (
    code === 'network_error' || code === 'invalid_response' || ErrorCode.safeParse(code).success
  );
}
