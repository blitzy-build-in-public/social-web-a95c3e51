import { z } from 'zod';

/**
 * Every error code the API can return in the error envelope
 * `{ error: { code: string, message: string } }` (AAP 0.5.4).
 *
 * Values are `snake_case` (AAP 0.11.1) and are listed in the group order of the HTTP status
 * that {@link ERROR_STATUS} maps them to. `not_found` is the generic 404, used where no more
 * specific code applies (operator reads of a venue or lodging, and the `/v1/test/*` routes
 * when `APP_ENV` is not `test`). `internal_error` is the mapping for an unexpected error,
 * which the errors plugin answers with a request id and no stack trace in the body (AAP
 * 0.11.1). `service_unavailable` is the rate limiter's Redis outage: every rate-limited route
 * answers it instead of running, because the limiter keeps `skipOnError: false` (AAP 0.3.2).
 * `suggestions_unavailable` is a failure confined to the suggestions route (AAP 0.3.2).
 * `fx_rate_unavailable` is a price conversion whose currency has no rate for the capture day
 * (AAP 0.5.6), confined to the operator price-entry route.
 */
export const ErrorCode = z.enum([
  'invalid_email',
  'proof_malformed',
  'invalid_field',
  'consent_missing',
  'booking_name_empty',
  'bad_signature',
  'token_invalid',
  'bad_venue_secret',
  'bad_lodging_secret',
  'hold_failed',
  'no_valid_proof',
  'not_recipient',
  'not_initiator',
  'not_participant',
  'messaging_locked',
  'blocked',
  'operator_only',
  'age_gate_required',
  'city_not_found',
  'user_not_found',
  'venue_not_found',
  'meetup_not_found',
  'lodging_not_found',
  'claim_not_found',
  'not_found',
  'nullifier_used',
  'meetup_exists',
  'not_proposed',
  'hold_pending',
  'already_settled',
  'dispute_open',
  'not_locked',
  'already_checked_in',
  'dispute_window_closed',
  'meetup_not_locked',
  'active_claim_exists',
  'call_in_progress',
  'no_verified_claim',
  'details_unavailable',
  'proposal_lapsed',
  'outside_window',
  'photo_too_large',
  'proof_invalid',
  'issuer_not_allowlisted',
  'stay_out_of_range',
  'self_proposal',
  'venue_not_partner',
  'starts_at_invalid',
  'deposit_invalid',
  'invalid_code',
  'outside_geofence',
  'invalid_outcome',
  'budget_out_of_range',
  'claim_dates_invalid',
  'lodging_other_city',
  'rate_limited',
  'daily_cap_reached',
  'internal_error',
  'fx_rate_unavailable',
  'payment_unavailable',
  'service_unavailable',
  'suggestions_unavailable',
]);

export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * The HTTP status each error code is answered with (AAP 0.5.4).
 *
 * Entries are grouped in the same order as {@link ErrorCode}, and no code has more than one
 * status. The `satisfies` clause makes exhaustiveness compiler-enforced: a missing code or an
 * unknown key fails typecheck, so `apps/api/src/plugins/errors.ts` can resolve the status of an
 * `AppError` thrown by code alone.
 */
export const ERROR_STATUS = {
  invalid_email: 400,
  proof_malformed: 400,
  invalid_field: 400,
  consent_missing: 400,
  booking_name_empty: 400,
  bad_signature: 400,
  token_invalid: 401,
  bad_venue_secret: 401,
  bad_lodging_secret: 401,
  hold_failed: 402,
  no_valid_proof: 403,
  not_recipient: 403,
  not_initiator: 403,
  not_participant: 403,
  messaging_locked: 403,
  blocked: 403,
  operator_only: 403,
  age_gate_required: 403,
  city_not_found: 404,
  user_not_found: 404,
  venue_not_found: 404,
  meetup_not_found: 404,
  lodging_not_found: 404,
  claim_not_found: 404,
  not_found: 404,
  nullifier_used: 409,
  meetup_exists: 409,
  not_proposed: 409,
  hold_pending: 409,
  already_settled: 409,
  dispute_open: 409,
  not_locked: 409,
  already_checked_in: 409,
  dispute_window_closed: 409,
  meetup_not_locked: 409,
  active_claim_exists: 409,
  call_in_progress: 409,
  no_verified_claim: 409,
  details_unavailable: 409,
  proposal_lapsed: 410,
  outside_window: 410,
  photo_too_large: 413,
  proof_invalid: 422,
  issuer_not_allowlisted: 422,
  stay_out_of_range: 422,
  self_proposal: 422,
  venue_not_partner: 422,
  starts_at_invalid: 422,
  deposit_invalid: 422,
  invalid_code: 422,
  outside_geofence: 422,
  invalid_outcome: 422,
  budget_out_of_range: 422,
  claim_dates_invalid: 422,
  lodging_other_city: 422,
  rate_limited: 429,
  daily_cap_reached: 429,
  internal_error: 500,
  fx_rate_unavailable: 503,
  payment_unavailable: 503,
  service_unavailable: 503,
  suggestions_unavailable: 503,
} as const satisfies Record<ErrorCode, number>;

/**
 * Codes the pilot adds to routes the request's contract already defines, each marked as an
 * addition in `docs/api/README.md` (AAP 0.5.4).
 *
 * `payment_unavailable` and `hold_pending` carry the lost-response recovery for a card hold
 * (AAP 0.3.2): the deposit stays `pending`, no second authorization is created and the client
 * recovers through `GET /meetups`. `self_proposal` rejects a proposal whose recipient is its
 * caller, before any meetup or hold exists. `service_unavailable` reports the rate limiter's
 * Redis outage, which every rate-limited route answers instead of running (AAP 0.3.2).
 * `token_invalid` is original on `POST /auth/verify` and an addition on every other route,
 * which returns it for a write attempted after account deletion (AAP 0.5.3). `fx_rate_unavailable`
 * is the operator price-entry route's own dependency error: a supplied currency has no `FxRate`
 * row at or before the capture day (AAP 0.5.6), which the `fx-refresh` job writes (AAP 0.5.6), so
 * the entry is refused as temporarily unavailable rather than mistaken for a lifecycle refusal.
 */
export const ADDED_ERROR_CODES = [
  'payment_unavailable',
  'hold_pending',
  'token_invalid',
  'self_proposal',
  'service_unavailable',
  'fx_rate_unavailable',
] as const satisfies readonly ErrorCode[];

/**
 * The error envelope every failing route answers with, verbatim from the request: one `error`
 * key holding a `code` from {@link ErrorCode} and a human-readable `message` (AAP 0.5.4). No
 * other field is added — no request id, no stack trace (AAP 0.11.1) — and the response schema
 * is the schema of `apps/api/src/plugins/errors.ts`.
 *
 * It is a strip-mode `z.object` with no transforms: unknown keys on a serialized response are
 * dropped rather than rejected, and `@fastify/swagger` can emit the schema into
 * `docs/api/openapi.json`.
 */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
