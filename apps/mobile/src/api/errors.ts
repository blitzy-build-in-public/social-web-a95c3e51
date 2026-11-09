/**
 * The client error model: the one error type the API and WebSocket clients raise, the parser that
 * turns a failing HTTP response into it, and the code-to-sentence map a screen renders (AAP 0.5.4,
 * AAP 0.8.1, AAP 0.11.1).
 *
 * The envelope is described only by `@tablemate/shared`'s `ErrorEnvelope` and `ErrorCode`, and an
 * `ApiError` never carries the server's `message` text or any part of the body: it leaves as a code
 * alone (AAP 0.11.1), which is also what makes it safe to log. `ApiError.message` is the code itself
 * and screens render {@link userMessageFor}. Client-safe: `@tablemate/shared` and
 * `src/copy/strings.ts` are its only imports.
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
 * Every code the client can hold: the shared server codes of AAP 0.5.4, plus the two client-only ones
 * that must never be added to the shared `ErrorCode` enum. `network_error` is a request that never
 * reached the API and the only code whose `status` is 0; `invalid_response` is an answer that is not
 * the envelope.
 */
export type ClientErrorCode = ErrorCode | 'network_error' | 'invalid_response';

/** The options {@link ApiError} accepts beyond its status and code. */
interface ApiErrorOptions {
  /** Whole seconds to wait before retrying, from a 429's `Retry-After`. Omitted when unknown. */
  retryAfterSeconds?: number;
}

/**
 * The error every request in `apps/mobile/src/api` raises (AAP 0.5.4, AAP 0.11.1).
 *
 * `message` is the code, never the server's prose, which a client may neither display nor log
 * (AAP 0.11.1). `status` is 0 when no response arrived; `retryAfterSeconds` is absent rather than
 * `undefined`-valued unless a 429 asked for a wait.
 */
export class ApiError extends Error {
  /** HTTP status of the response, or 0 for a network failure or a timeout. */
  readonly status: number;

  /** The code that classifies the failure. */
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

/** True when `err` is an {@link ApiError} — the only error type this client raises. */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/**
 * True only for a request that never reached the API — an {@link ApiError} coded `network_error`,
 * which `src/state/meetup-store.ts` reads so React Query retries it and treats a 4xx answer as final.
 */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'network_error';
}

/** A request that never reached the API, so no status came back (AAP 0.5.4). */
export function networkError(): ApiError {
  return new ApiError(0, 'network_error');
}

/** An answer that is not the error envelope, carrying the status it arrived with (AAP 0.5.4). */
export function invalidResponse(status: number): ApiError {
  return new ApiError(status, 'invalid_response');
}

/**
 * Turns a failing HTTP response into an {@link ApiError} (AAP 0.5.4).
 *
 * A body that is empty, not JSON (an nginx HTML 502), or not the envelope yields `invalid_response`;
 * the status comes from the response, never from the body, and no part of the body is kept
 * (AAP 0.11.1). A 429's `Retry-After` is read as whole seconds only — on the web the header is
 * unreadable cross-origin unless the answer exposes it, and the API exposes only `Date` — so callers
 * treat `retryAfterSeconds` as an optional hint. `response` is typed structurally, so both `Response`
 * implementations fit it and a test can pass a literal.
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

/** The code of a body that is the error envelope, or `undefined` for anything else. */
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

/** Whole seconds from a 429's `Retry-After`, or `undefined` when absent or not a non-negative integer. */
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

/** What a screen shows for a code the map below does not hold. */
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/** The largest accepted photo in whole megabytes, built from {@link PHOTO_MAX_BYTES}. */
const PHOTO_MAX_MEGABYTES = PHOTO_MAX_BYTES / 1024 / 1024;

/**
 * The fixed English sentence each code shows a user (AAP 0.5.8: the interface is English only).
 *
 * Keys are {@link ClientErrorCode} members, so a misspelt or unknown key fails typecheck. No sentence
 * repeats a fixed string of AAP 0.5.8 — the deposit framing, safety, age-gate, Table Credit,
 * lodging-call and visibility notices belong to their own screens — and a sentence carrying a rule's
 * own number is built from that shared constant, so the copy cannot drift from what the API enforces.
 * The `/ops` operator screens share this mapping, so the operator codes are covered here too.
 */
const MESSAGES: Partial<Record<ClientErrorCode, string>> = {
  // Client-side codes, raised by this client only. An answer that is not the envelope says nothing
  // more than the fallback, so it shows the fallback.
  network_error: 'No connection. Check your network and try again.',
  invalid_response: GENERIC_MESSAGE,

  // 400 — the request was not acceptable
  invalid_email: "That email address doesn't look right.",
  proof_malformed: "We couldn't read that proof. Import your booking again.",
  invalid_field: "Some of those details aren't accepted. Check them and try again.",
  consent_missing: 'Confirm the call notice before continuing.',
  booking_name_empty: 'Enter the name on the booking.',
  bad_signature: "We couldn't verify that request.",

  // 401 — sign-in
  token_invalid: 'Your session ended. Sign in again.',
  bad_venue_secret: 'The venue sign-in details are not valid.',
  bad_lodging_secret: 'The lodging sign-in details are not valid.',

  // 402 — the card hold
  hold_failed: 'Your card could not be held. Check or update your saved card and try again.',

  // 403 — not allowed
  no_valid_proof: 'You need a verified stay in this city first.',
  not_recipient: 'Only the traveler who received this proposal can answer it.',
  not_initiator: 'Only the traveler who sent this proposal can do that.',
  not_participant: "You're not part of this meetup.",
  messaging_locked: 'Chat opens once both seats are held.',
  blocked: "You can't interact with this traveler.",
  operator_only: 'This area is for operators only.',
  age_gate_required: 'Confirm that you are 18 or older to continue.',

  // 404 — no longer there
  city_not_found: 'That city is not available.',
  user_not_found: 'That traveler is not available.',
  venue_not_found: 'That venue is not available.',
  meetup_not_found: 'That meetup is not available.',
  lodging_not_found: 'That lodging is not available.',
  claim_not_found: 'That stay is not available.',
  not_found: 'We could not find that.',

  // 409 — the meetup, claim or task is in another state
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

  // 410 — a window closed
  proposal_lapsed: 'This proposal expired before it was answered.',
  outside_window: `Check-in opens ${CHECK_IN_OPENS_BEFORE_MINUTES} minutes before the start and closes ${CHECK_IN_CLOSES_AFTER_MINUTES} minutes after it.`,

  // 413 and 422 — a value was rejected
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

  // 429 — too many requests
  rate_limited: "You're doing that too often. Wait a moment and try again.",
  daily_cap_reached: 'The daily limit is reached. Try again tomorrow.',

  // 5xx — the server side
  internal_error: 'Something went wrong on our side. Please try again.',
  fx_rate_unavailable:
    'No exchange rate for that currency yet. Enter the price in USD, or try again after the daily exchange-rate refresh.',
  payment_unavailable:
    'Payment is catching up: your hold is still being confirmed. Check back shortly.',
  service_unavailable: 'Tablemate is briefly unavailable. Please try again shortly.',
  suggestions_unavailable: "We couldn't load day-plan ideas right now. Try again shortly.",
};

/**
 * The sentence a screen shows for an error code (AAP 0.5.4, 0.5.8). An unknown string — a code added
 * to the API before this client knows it — returns the generic sentence rather than exposing it.
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
