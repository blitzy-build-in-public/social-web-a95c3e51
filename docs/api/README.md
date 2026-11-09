# API conventions and route index

How the API in `apps/api` behaves as this branch stands: the conventions every route follows, an index
of every route the process serves, why the additive routes exist, and how `openapi.json` is
regenerated. Routes the contract already defines carry no mark; the routes, error codes,
request-body fields, response-envelope fields and query parameters this pilot adds to it are marked
**Addition** below.

## Conventions

**Basics.** Every route is mounted under `/v1` (`apps/api/src/app.ts` registers each module with
`{ prefix: API_PREFIX }`), speaks JSON over HTTPS, and uses the request and response schemas of
`packages/shared/src/schemas/<group>.ts`. Timestamps are ISO 8601 in UTC, dates are `YYYY-MM-DD`, and
money is integer USD cents.

**Where things live.** Schemas: `packages/shared/src/schemas/<group>.ts`. Routes and the logic behind
them: `apps/api/src/modules/<module>/routes.ts` and the sibling file each row names in the Handler
column. Integration suites: `apps/api/test/integration/<group>.test.ts`. The machine-readable contract
is [`./openapi.json`](./openapi.json), and architecture context is in
[`../architecture.md`](../architecture.md).

The Test column names the suite AAP 0.8.1 assigns to the route. Those suites are committed: the route
suites in `apps/api/test/integration/` and the unit suites in `apps/api/test/unit/`, over the shared
`apps/api/test/support/` harness — the app factory and the container setup it shares, the fault points,
the test clock, the fixture proofs, the stateful Stripe proxy and the voice simulator. A Test cell
naming `tests/system` or `apps/mobile/e2e` points at a suite outside this module.

**Errors.** The envelope is exactly `{ "error": { "code": string, "message": string } }`, with the code
from `ErrorCode` and the status from `ERROR_STATUS`, both in `packages/shared/src/errors.ts`. An
unexpected failure is `500 internal_error`, whose message carries the request id and never a stack
trace (`plugins/errors.ts`). An unknown path is `404 not_found`. A request-schema failure is
`400 invalid_field` unless the route names a code: `400 proof_malformed` on `POST /itinerary-proofs`,
`400 invalid_email` on `POST /auth/magic-link`. Where several failures apply, a route checks them in the
order its row lists.

`503 service_unavailable` carries four meanings in this API: the rate limiter's Redis outage
(**Addition**, every limited route), a missing circuit artefact (`POST /itinerary-proofs`,
`GET /zk/config`), the ConversationRelay concurrent-session cap (`WS /webhooks/voice/relay`), and the
language-model suspension flag's store being unreachable when an operator re-enables use
(`POST /admin/language-model/re-enable`, **Addition**).

**Authentication.** `Authorization: Bearer <JWT>` — HS256, a 15-minute lifetime, claims `sub`, `role`
and `sid`. Refresh tokens rotate, and a reused one revokes its session. The consoles send
`X-Venue-Secret` and `X-Lodging-Secret`; a missing, malformed or expired token answers
`401 token_invalid` on every guarded route, so the tables below name that code only where a route's own
logic gives it a second meaning. Webhooks authenticate by provider signature alone: Stripe's
signature over the raw body, and Twilio's `X-Twilio-Signature` over the public URL built from
`API_PUBLIC_URL` plus the original path and query and every posted form field, on the relay upgrade
too. Operator routes need `role = operator` and answer `403 operator_only` without it. The
test-control routes need `X-Test-Control-Token`; they exist only when `APP_ENV=test` and
`TEST_CONTROL_TOKEN` is set, and are not mounted anywhere else, where the path answers `404 not_found`.
The OpenAPI security schemes are `bearer`, `venueSecret` and `lodgingSecret`.

**Guards and the age gate.** `traveler` in the Auth column is bearer plus the 18+ gate: until
`POST /me/consents` records the adult confirmation and `TERMS_VERSION`, a traveler feature route
answers `403 age_gate_required`. The gate is installed per route group and never globally, so it stays
off `GET /me`, `POST /me/consents`, `POST /auth/logout` and `DELETE /me`; off the public routes
(`POST /auth/magic-link`, `/auth/verify`, `/auth/refresh`, `GET /health`, `GET /zk/config`); and off
`/webhooks/*`, the console routes, `/admin/*` and `/test/*`. The routes under `/cities` — `GET /cities`,
`GET /cities/:cityId/venues`, `GET /cities/:cityId/travelers` and `GET /cities/:cityId/lodgings` — are
`traveler` routes: an unverified traveler browses a city and its venues without a proof, while
`GET /cities/:cityId/travelers` and `GET /cities/:cityId/lodgings` answer `403 no_valid_proof`
themselves, as does `GET /lodgings/:id`.

**Rate limits.** `plugins/rate-limit.ts` registers `@fastify/rate-limit` with `global: false`, so only
the routes that ask for a counter have one: every POST, PUT, PATCH and DELETE, and the two reads that
write (below). Those are limited to 60 requests a minute per user and `RATE_LIMIT_IP_PER_MIN` (600 by
default) per IP. `POST /auth/verify` and `POST /auth/refresh` are limited per IP alone,
`POST /auth/magic-link` per IP and at five an hour per address, and the webhook routes at the provider
allowance of 6,000 a minute per IP. Exceeding a counter answers `429 rate_limited` with `Retry-After`.
The limiter keeps `skipOnError: false`, so while its Redis store is unreachable a limited route answers
`503 service_unavailable` (**Addition**) instead of running uncounted. Reads, `/health` and `/test/*`
carry no counter.

**The two reads that write.** `GET /meetups/:id` sets `recipientViewedAt` and emits `proposal_viewed`
on the recipient's first read. `GET /meetups/:id/suggestions` stores a supplied budget and stamps
`suggestionsFirstViewedAt`. Each makes that write in a transaction behind the deletion fence, and each
carries the mutating counters above.

**The account-deletion write fence.** `DELETE /me` sets `deletion_requested_at` and revokes every
session. From then on every mutation, both state-writing reads and every WebSocket write by that
account answers `401 token_invalid` (**Addition**): the fence takes `SELECT … FOR SHARE` on the user's
row inside the transaction that would write, so it reads PostgreSQL and never the 30-second session
cache. No row below repeats it.

**Disclosure.** A profile payload is one of `Tier0Profile` … `Tier3Profile`, chosen by the viewer's
tier and field-allowlisted by `modules/users/disclosure`; the field lists are
`packages/shared/src/tiers.ts`. Tier 0 carries `id`, `handle`, `avatarSeed`, `homeRegion`,
`currentCityId`, `proofDates`, `reputation` and `interestTags`; tier 1 adds `nickname`, `bio` and
`canMessage`; tier 2 adds `hasPhoto`, whose bytes come only from `GET /users/:userId/photo`; tier 3
adds `externalContact` and `fullName`. Discovery listings and lodging guest lists are always tier 0. A
block in either direction is not a tier: the profile read answers `404 user_not_found`. `guestCount` is
an integer of 3 or more, or the literal `"fewer than 3"`. No DTO carries a secret hash or ciphertext, a
booking ciphertext, a user's email or a user's coordinates, and a console secret appears once, in the
`SecretIssued` body of the issue routes, served with `Cache-Control: no-store`.

**WebSocket `WS /v1/chat`.** Authenticated by the `Sec-WebSocket-Protocol: bearer, <token>`
subprotocol, because a browser cannot put an `Authorization` header on a `WebSocket`; a refusal is
plain HTTP 401 `token_invalid` (or 403 `age_gate_required`) on a connection that is never upgraded.
Frames come from `packages/shared/src/schemas/ws.ts`: the client sends
`ChatSend { type: "chat_send", meetupId, body }` with a body of 1 to 1,000 characters, and the server
sends `MessageFrame`, `MeetupStatusFrame` and `ErrorFrame { type: "error", code, message, meetupId? }`.
A send is refused in place for `messaging_locked`, `blocked`, `invalid_field` or `rate_limited` (60
sends a rolling minute per socket); `token_invalid` answers the frame and closes with
`WS_CLOSE.unauthorized` (4401). The close codes are `WS_CLOSE` in `packages/shared/src/schemas/ws.ts`,
the one declaration both sides import — the API sends these codes and the app's socket client
branches on them: `unauthorized` 4401, `forbidden` 4403, `invalidated` 4409, and `tooMany` 4429, which
closes the socket that would exceed the `CHAT_MAX_SOCKETS_PER_USER` allowance of live sockets one
account may hold on an API instance — the account's other sockets keep serving its chat, and the
allowance is released as one of them closes. The socket routes and the two test-control routes are
hidden from `openapi.json`, so it lists every operation below except those four.

## Route index

### Auth

| Route                   | Auth   | Handler                                | Response                                                 | Errors (in check order)                                                         | Test           | Addition     |
| ----------------------- | ------ | -------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------- | ------------ |
| `POST /auth/magic-link` | public | `auth/routes.ts`, `auth/magic-link.ts` | `202`, no body                                           | `400 invalid_email`; `429 rate_limited` (over five an hour for one address)     | `auth.test.ts` | —            |
| `POST /auth/verify`     | public | `auth/routes.ts`, `auth/sessions.ts`   | `200 VerifyResponse { accessToken, refreshToken, user }` | `401 token_invalid` (unknown, older than 15 minutes, or already used)           | `auth.test.ts` | —            |
| `POST /auth/refresh`    | public | `auth/routes.ts`, `auth/sessions.ts`   | `200 RefreshResponse`                                    | `401 token_invalid` (unknown, expired, or reused — a reuse revokes the session) | `auth.test.ts` | **Addition** |
| `POST /auth/logout`     | bearer | `auth/routes.ts`, `auth/sessions.ts`   | `204`                                                    | —                                                                               | `auth.test.ts` | **Addition** |

### Me

| Route                    | Auth     | Handler                                        | Response                   | Errors (in check order)                                                                  | Test                                    | Addition     |
| ------------------------ | -------- | ---------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------- | ------------ |
| `GET /me`                | bearer   | `me/routes.ts`, `me/profile.ts`                | `200 MeDto`                | —                                                                                        | `me-profile.test.ts`                    | **Addition** |
| `POST /me/consents`      | bearer   | `me/routes.ts`, `me/consents.ts`               | `200 MeDto`                | `400 invalid_field` (a version other than `TERMS_VERSION`, or a body the schema refused) | `me-profile.test.ts`                    | **Addition** |
| `DELETE /me`             | bearer   | `me/routes.ts`, `me/deletion.ts`               | `202`, no body             | none of its own: the cancellation rules it applies have no refusal                       | `tests/system/account-deletion.test.ts` | —            |
| `PUT /me/profile`        | traveler | `me/routes.ts`, `me/profile.ts`, `me/photo.ts` | `200 MeDto`                | `400 invalid_field`; `413 photo_too_large` (a decoded photo over 5 MB)                   | `me-profile.test.ts`                    | —            |
| `POST /me/push-tokens`   | traveler | `me/routes.ts`                                 | `204`                      | `400 invalid_field`                                                                      | `me-profile.test.ts`                    | **Addition** |
| `POST /me/payment-setup` | traveler | `me/routes.ts`, `me/payment-setup.ts`          | `200 PaymentSetupResponse` | `503 payment_unavailable` (Addition)                                                     | `meetups.test.ts`                       | **Addition** |

### Proofs and cities

| Route                                   | Auth     | Handler                                   | Response                                                            | Errors (in check order)                                                                                                                                                                      | Test                       | Addition     |
| --------------------------------------- | -------- | ----------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ |
| `POST /itinerary-proofs`                | traveler | `proofs/routes.ts`, `proofs/verifier.ts`  | `201 ProofAccepted { proofId, cityId, arrivalDate, departureDate }` | `400 proof_malformed`; `422 proof_invalid`; `422 issuer_not_allowlisted`; `422 stay_out_of_range` (1–120 days); `409 nullifier_used`; `503 service_unavailable` (no usable verification key) | `proofs.test.ts`           | —            |
| `GET /cities`                           | traveler | `cities/routes.ts`                        | `200 CitiesResponse`                                                | —                                                                                                                                                                                            | `cities-discovery.test.ts` | **Addition** |
| `GET /cities/:cityId/venues`            | traveler | `cities/routes.ts`                        | `200 VenuesResponse` (active partners as `VenueDto`)                | `404 city_not_found`                                                                                                                                                                         | `cities-discovery.test.ts` | —            |
| `GET /cities/:cityId/travelers?cursor=` | traveler | `cities/routes.ts`, `cities/discovery.ts` | `200 TravelersResponse`, 20 `Tier0Profile`s a page                  | `404 city_not_found`; `403 no_valid_proof`; `400 invalid_field` (a cursor this API did not write)                                                                                            | `cities-discovery.test.ts` | —            |
| `GET /zk/config`                        | public   | `proofs/routes.ts`, `proofs/registry.ts`  | `200 ZkConfig`                                                      | `503 service_unavailable` (the artefact manifest is absent)                                                                                                                                  | `proofs.test.ts`           | **Addition** |

`Deviation:` the additive-routes table of AAP 0.5.4 marks the row holding `GET /cities` and
`GET /zk/config` as "(public)", but that marking reads on `GET /zk/config` alone: the same
section's age-gate scope enumerates the public routes (`POST /auth/magic-link`, `/auth/verify`,
`/auth/refresh`, `GET /health`, `GET /zk/config`) and does not carry `/cities`; requirement 1 of
AAP 0.1.1 puts the 18+ gate before any feature use, which is what the Discover city picker over
this route is (AAP 0.5.8). The route group in `modules/cities/routes.ts` therefore keeps
`requireTraveler`: the route answers `401 token_invalid` with no bearer token,
`403 age_gate_required` until the consents are recorded and `200` after, while an unverified
traveler still browses the cities and the venues, which is what AAP 0.5.8 requires.

### Users and safety

| Route                      | Auth     | Handler                                                          | Response                                   | Errors (in check order)                                                 | Test                   | Addition                  |
| -------------------------- | -------- | ---------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | ---------------------- | ------------------------- |
| `GET /users/:userId`       | traveler | `users/routes.ts`, `users/disclosure/{tier,select,serialize}.ts` | `200 AnyTierProfile`, at the viewer's tier | `404 user_not_found` (unknown, deleted, or a block in either direction) | `disclosure.test.ts`   | —                         |
| `GET /users/:userId/photo` | traveler | `users/routes.ts`                                                | WebP bytes (`rawResponse`, no JSON schema) | `404 user_not_found` (also below tier 2)                                | `disclosure.test.ts`   | **Addition**              |
| `POST /users/:id/block`    | traveler | `users/routes.ts`, `users/safety.ts`                             | `204`                                      | `404 user_not_found`                                                    | `users-safety.test.ts` | —                         |
| `POST /users/:id/report`   | traveler | `users/routes.ts`, `users/safety.ts`                             | `204`                                      | `404 user_not_found`                                                    | `users-safety.test.ts` | **Addition** (`meetupId`) |

A block also cancels any open meetup of the pair, with `cancelReason` `block`.

### Meetups

| Route                                                    | Auth     | Handler                                   | Response                                                              | Errors (in check order)                                                                                                                                                                                                                                  | Test                                            | Addition                       |
| -------------------------------------------------------- | -------- | ----------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| `GET /meetups?role=initiator\|recipient&status=&cursor=` | traveler | `meetups/routes.ts`, `meetups/queries.ts` | `200 MeetupListResponse`, 20 a page                                   | `400 invalid_field` (an unknown filter value or a malformed cursor)                                                                                                                                                                                      | `meetups.test.ts`                               | **Addition**                   |
| `GET /meetups/:id`                                       | traveler | `meetups/routes.ts`, `meetups/queries.ts` | `200 MeetupDto` (state-writing read)                                  | `404 meetup_not_found`; `403 not_participant`                                                                                                                                                                                                            | `meetups.test.ts`                               | **Addition**                   |
| `POST /meetups`                                          | traveler | `meetups/propose.ts`                      | `201 ProposeResponse { meetupId, status, clientSecret }`              | `422 self_proposal` (Addition); `404 venue_not_found`; `404 user_not_found`; `403 no_valid_proof`; `422 venue_not_partner`; `422 starts_at_invalid`; `422 deposit_invalid`; `409 meetup_exists`; `402 hold_failed`; `503 payment_unavailable` (Addition) | `meetups.test.ts`, `payment-operations.test.ts` | —                              |
| `POST /meetups/:id/accept`                               | traveler | `meetups/accept.ts`                       | `200 AcceptResponse { status, clientSecret }`, `locked` or `proposed` | `404 meetup_not_found`; `403 not_recipient`; `410 proposal_lapsed`; `409 not_proposed`; `402 hold_failed`; `409 hold_pending` (Addition); `503 payment_unavailable` (Addition)                                                                           | `meetups.test.ts`, `payment-operations.test.ts` | —                              |
| `POST /meetups/:id/decline`                              | traveler | `meetups/accept.ts`                       | `200 DeclineResponse { status: "declined" }`                          | `404 meetup_not_found`; `403 not_recipient`; `409 not_proposed`                                                                                                                                                                                          | `meetups.test.ts`                               | —                              |
| `POST /meetups/:id/hold`                                 | traveler | `meetups/accept.ts`                       | `200 HoldRetryResponse { status, initiatorHold, clientSecret }`       | `404 meetup_not_found`; `403 not_participant`; `403 not_initiator`; `409 not_proposed`; `409 hold_pending` (Addition); `402 hold_failed`; `503 payment_unavailable` (Addition)                                                                           | `meetups.test.ts`, `payment-operations.test.ts` | **Addition**                   |
| `POST /meetups/:id/cancel`                               | traveler | `meetups/cancel.ts`                       | `200 CancelResponse { lateCancel }`                                   | `403 not_participant`; `404 meetup_not_found`; `409 already_settled`; `409 dispute_open`                                                                                                                                                                 | `meetups.test.ts`                               | —                              |
| `POST /meetups/:id/check-in`                             | traveler | `meetups/check-in.ts`                     | `200 CheckInResponse { status, bothCheckedIn }`                       | `404 meetup_not_found`; `403 not_participant`; `409 not_locked`; `409 already_checked_in`; `410 outside_window`; `422 invalid_code`; `422 outside_geofence`                                                                                              | `check-in.test.ts`                              | **Addition** (`bothCheckedIn`) |
| `POST /meetups/:id/dispute`                              | traveler | `meetups/dispute.ts`                      | `201 DisputeResponse { disputeId }`                                   | `404 meetup_not_found`; `403 not_participant`; `409 dispute_window_closed`; `409 not_locked`; `409 dispute_open`                                                                                                                                         | `disputes.test.ts`                              | **Addition** (`kind`)          |

`Deviation:` `meetups/accept.ts` (accept, decline and the hold retry), `meetups/cancel.ts`,
`meetups/check-in.ts` and `meetups/dispute.ts` answer `404 meetup_not_found` for an id that is unknown
— or, on accept, a proposal the initiator has not yet made visible to the recipient. AAP 0.5.4's route
table names that code for the by-id read and for the suggestions read alone; the six routes that
answer it — the three in `meetups/accept.ts`, `meetups/cancel.ts`, `meetups/check-in.ts` and
`meetups/dispute.ts` — declare it beside their own codes, so `openapi.json` publishes `404` for every
`/meetups/:id` route of the `meetups` module, and a client must treat it as possible on all of them.
`GET /meetups/:id/messages` is not one of those: it answers `403 not_participant` for an unknown id or
an invisible proposal, as `messaging/access.ts` sets out.

Adding `kind` (`venue_unavailable` or `other`, default `other`) to the dispute body is an **Addition**:
the contract's `{ reason }` cannot mark a venue-unavailable case, which the operator resolves `no_fault`.

`counterpartCheckedIn` on `MeetupDto` is an **Addition**: the counterpart's pass check-in, read from the
same pass `CheckIn` rows `Meetup.bothCheckedInAt` is set from (AAP 0.5.7), so either attendee can see
whether the other showed up while the meetup is still `locked`. AAP 0.5.4's field list carries the
caller's own `checkedIn` alone, which leaves the product's central trust signal invisible to both sides
until settlement.

### Messaging

| Route                               | Auth                                         | Handler                                      | Response                                          | Errors (in check order)                                                                                | Test                | Addition              |
| ----------------------------------- | -------------------------------------------- | -------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- | --------------------- |
| `GET /meetups/:id/messages?cursor=` | traveler                                     | `messaging/routes.ts`, `messaging/access.ts` | `200 MessageHistoryResponse`                      | `403 not_participant`; `403 messaging_locked`; `403 blocked`; `400 invalid_field` (a malformed cursor) | `messaging.test.ts` | **Addition** (cursor) |
| `WS /chat`                          | bearer, in the `bearer, <token>` subprotocol | `messaging/chat-ws.ts`                       | `MessageFrame`, `MeetupStatusFrame`, `ErrorFrame` | `messaging_locked`; `blocked`; `invalid_field`; `rate_limited`; `token_invalid`                        | `messaging.test.ts` | —                     |

The history route checks `403 not_participant` before the pair's access rule, so a stranger learns
nothing about the meetup; the socket checks access inside the transaction that would store the message,
behind the deletion fence.

### Suggestions and events

| Route                                                | Auth     | Handler                                                                     | Response                                                                            | Errors (in check order)                                                                                                                      | Test                  | Addition     |
| ---------------------------------------------------- | -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------ |
| `GET /meetups/:id/suggestions?perPersonBudgetCents=` | traveler | `suggestions/routes.ts`, `suggestions/{candidates,estimate,rank,budget}.ts` | `200 SuggestionsResponse { items, emptyReason?, budgetCents }` (state-writing read) | `404 meetup_not_found`; `403 not_participant`; `409 meetup_not_locked`; `422 budget_out_of_range` (500–10000); `503 suggestions_unavailable` | `suggestions.test.ts` | —            |
| `POST /events`                                       | traveler | `analytics/routes.ts`, `analytics/emit.ts`                                  | `204`                                                                               | `400 invalid_field` (a name outside the allowlist, or a `meetupId` the caller is not a participant of)                                       | `admin.test.ts`       | **Addition** |

`503 suggestions_unavailable` is confined to this route and is not in `ADDED_ERROR_CODES`, which is why
it carries no Addition mark; `openapi.json` publishes it as the contract's own code for that route.

### Lodgings

| Route                                              | Auth     | Handler                                         | Response                                                          | Errors (in check order)                                                                                                                                                        | Test                     | Addition |
| -------------------------------------------------- | -------- | ----------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | -------- |
| `GET /cities/:cityId/lodgings?sort=activity\|name` | traveler | `lodgings/routes.ts`, `lodgings/leaderboard.ts` | `200 LodgingsResponse` with `rank`, `activityScore`, `guestCount` | `404 city_not_found`; `403 no_valid_proof`                                                                                                                                     | `lodgings.test.ts`       | —        |
| `GET /lodgings/:id`                                | traveler | `lodgings/routes.ts`, `lodgings/visibility.ts`  | `200 LodgingDetail`, opted-in guests as `Tier0Profile[]`          | `404 lodging_not_found`; `403 no_valid_proof`                                                                                                                                  | `lodgings.test.ts`       | —        |
| `POST /me/lodging-claims`                          | traveler | `lodgings/claims.ts`                            | `201 LodgingClaimCreated { claimId, status }`                     | `400 consent_missing`; `400 booking_name_empty`; `404 lodging_not_found`; `403 no_valid_proof`; `409 active_claim_exists`; `422 claim_dates_invalid`; `422 lodging_other_city` | `lodging-claims.test.ts` | —        |
| `GET /me/lodging-claims/:id`                       | traveler | `lodgings/claims.ts`                            | `200 LodgingClaimStatusDto { status, resolvedAt? }`               | `404 claim_not_found` (another traveler's claim included)                                                                                                                      | `lodging-claims.test.ts` | —        |
| `DELETE /me/lodging-claims/:id`                    | traveler | `lodgings/claims.ts`                            | `204`                                                             | `404 claim_not_found`; `409 call_in_progress`                                                                                                                                  | `lodging-claims.test.ts` | —        |
| `PUT /me/lodging-visibility`                       | traveler | `lodgings/visibility.ts`                        | `200 VisibilityResponse`                                          | `409 no_verified_claim`                                                                                                                                                        | `lodgings.test.ts`       | —        |

The directory's answer is bounded, and says so when the bound bit. `GET /cities/:cityId/lodgings`
answers at most `LODGING_DIRECTORY_LIMIT` (500) of a city's lodgings, cut in the order the board's own
inputs imply — a lodging with a meetup inside the 90-day window first, then the current verified guest
count, then name — so a city that holds more loses the lodgings that witnessed nothing rather than the
ones that did; the cut is logged as `lodgings_truncated`. Each lodging's score reads at most
`LODGING_ACTIVITY_FACTS_LIMIT` (1000) facts of that window, newest first, which is far beyond any
pilot-scale count, and a lodging that reached it is logged as `lodging_activity_facts_capped`. The
contract fixes no cursor for this route, so a cap is the resolution rather than a paging change (**no
Addition**): the DTO, the `sort` values, the errors and the 60-second cache are unchanged. A lodging
the cut left out is still answered rather than refused: `GET /lodgings/:id` takes its summary from the
board where the board carries the lodging, and otherwise from the lodging's own row, its own window
facts and its own verified guest count, at the rank after every listed lodging (`listed + 1`, which is
the position the lodging console already reports for a lodging outside the directory) — so the bound
can never turn a listed lodging into `404 lodging_not_found`. A guest list is bounded the same way, at
`LODGING_GUEST_LIST_LIMIT` (100) entries, the most recently resolved stay first, while the
`guestCount` beside it keeps reporting every current verified guest, so a cut list is visible as one.

### Consoles

| Route                        | Auth           | Handler                                            | Response                                                                                                           | Errors (in check order)  | Test               | Addition |
| ---------------------------- | -------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------ | -------- |
| `GET /venue/check-in-code`   | venue secret   | `consoles/routes.ts`, `consoles/{secrets,totp}.ts` | `200 VenueCodeResponse { code, expiresAt }`, `Cache-Control: no-store`, `Date` exposed for the console's countdown | `401 bad_venue_secret`   | `consoles.test.ts` | —        |
| `GET /lodging-console/stats` | lodging secret | `consoles/routes.ts`, `lodgings/leaderboard.ts`    | `200 LodgingConsoleStats { rank, activityScore, verifiedGuests, weeklyTrend }`                                     | `401 bad_lodging_secret` | `consoles.test.ts` | —        |

### Admin

| Route                                                   | Auth     | Handler                                      | Response                                                                               | Errors (in check order)                                                                                                                                                                                                                    | Test                 | Addition                          |
| ------------------------------------------------------- | -------- | -------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | --------------------------------- |
| `GET /admin/metrics?from=&to=&cityId=&variant=`         | operator | `admin/routes.ts`, `admin/metrics.ts`        | `200 MetricsDto`                                                                       | `400 invalid_field` (an unusable range)                                                                                                                                                                                                    | `admin.test.ts`      | —                                 |
| `GET /admin/cities`                                     | operator | `admin/routes.ts`, `cities/routes.ts`        | `200 CitiesResponse`                                                                   | —                                                                                                                                                                                                                                          | `admin.test.ts`      | **Addition**                      |
| `GET /admin/disputes`                                   | operator | `admin/disputes.ts`                          | `200 AdminDisputesResponse`                                                            | —                                                                                                                                                                                                                                          | `admin.test.ts`      | —                                 |
| `POST /admin/disputes/:id/resolve`                      | operator | `admin/disputes.ts`                          | `200 AdminDisputeDto`                                                                  | `422 invalid_outcome` (an unknown outcome, an already-resolved dispute, or a resolution the meetup's status forbids); `404 not_found`                                                                                                      | `admin.test.ts`      | —                                 |
| `GET /admin/call-tasks?status=&kind=&q=&limit=&cursor=` | operator | `admin/call-tasks.ts`                        | `200 AdminCallTasksResponse { items, total, nextCursor }`, one page a read             | `400 invalid_field` (a cursor this API did not write, a `limit` outside 1–500, or a parameter the queue does not carry)                                                                                                                    | `admin.test.ts`      | **Addition** (paging and filters) |
| `POST /admin/call-tasks/:id/resolve`                    | operator | `admin/call-tasks.ts`                        | `200 AdminCallTaskDto`                                                                 | `422 invalid_outcome` (an unknown outcome, a lodging-verification task, or a task already terminal or operator-resolved); `404 not_found`; `503 fx_rate_unavailable` (Addition: a price in a currency with no FX rate for the capture day) | `admin.test.ts`      | —                                 |
| `GET /admin/lodging-claims`                             | operator | `admin/lodging-claims.ts`                    | `200 AdminLodgingClaimsResponse`                                                       | —                                                                                                                                                                                                                                          | `admin.test.ts`      | —                                 |
| `POST /admin/lodging-claims/:id/resolve`                | operator | `admin/lodging-claims.ts`                    | `200 AdminLodgingClaimDto`                                                             | `422 invalid_outcome`; `404 claim_not_found`                                                                                                                                                                                               | `admin.test.ts`      | —                                 |
| `GET /admin/lodging-claims/:id/booking-details`         | operator | `admin/lodging-claims.ts`                    | `200 BookingDetailsDto`, `Cache-Control: no-store`, one `OperatorAccessLog` row a read | `404 claim_not_found`; `409 details_unavailable` (the claim reached a terminal state, or its details were erased)                                                                                                                          | `admin.test.ts`      | **Addition**                      |
| `POST /admin/price-jobs`                                | operator | `admin/price-jobs.ts`                        | `202 PriceJobResponse`                                                                 | `404 city_not_found`; `429 daily_cap_reached`                                                                                                                                                                                              | `price-jobs.test.ts` | —                                 |
| `GET /admin/venues`                                     | operator | `admin/onboarding.ts`                        | `200 AdminVenuesResponse`                                                              | —                                                                                                                                                                                                                                          | `admin.test.ts`      | **Addition**                      |
| `POST /admin/venues`                                    | operator | `admin/onboarding.ts`                        | `201 AdminVenueDto`                                                                    | `404 city_not_found`; `404 not_found` (an unknown `placeId`)                                                                                                                                                                               | `admin.test.ts`      | **Addition**                      |
| `PATCH /admin/venues/:id`                               | operator | `admin/onboarding.ts`                        | `200 AdminVenueDto`                                                                    | `400 invalid_field` (one of `lat`/`lng` alone, or neither and the venue has no location); `404 not_found`                                                                                                                                  | `admin.test.ts`      | **Addition**                      |
| `POST /admin/venues/:id/secret`                         | operator | `admin/onboarding.ts`, `consoles/secrets.ts` | `200 SecretIssued { secret }`, shown once, `Cache-Control: no-store`                   | `404 not_found`                                                                                                                                                                                                                            | `admin.test.ts`      | **Addition**                      |
| `GET /admin/lodgings?cityId=&q=&limit=&cursor=`         | operator | `admin/onboarding.ts`                        | `200 AdminLodgingsResponse { items, total, nextCursor }`, one page a read              | `400 invalid_field` (a cursor this API did not write, a `limit` outside 1–500, or a parameter the route does not carry)                                                                                                                    | `admin.test.ts`      | **Addition** (paging and filters) |
| `POST /admin/lodgings`                                  | operator | `admin/onboarding.ts`                        | `201 AdminLodgingDto`                                                                  | `404 city_not_found`                                                                                                                                                                                                                       | `admin.test.ts`      | **Addition**                      |
| `POST /admin/lodgings/:id/secret`                       | operator | `admin/onboarding.ts`, `consoles/secrets.ts` | `200 SecretIssued { secret }`, shown once, `Cache-Control: no-store`                   | `404 not_found`                                                                                                                                                                                                                            | `admin.test.ts`      | **Addition**                      |
| `GET /admin/reports`                                    | operator | `admin/reports.ts`                           | `200 AdminReportsResponse`                                                             | —                                                                                                                                                                                                                                          | `admin.test.ts`      | **Addition**                      |
| `GET /admin/crawl-domains`                              | operator | `admin/crawl-domains.ts`                     | `200 AdminCrawlDomainsResponse`                                                        | —                                                                                                                                                                                                                                          | `admin.test.ts`      | **Addition**                      |
| `PATCH /admin/crawl-domains/:domain`                    | operator | `admin/crawl-domains.ts`                     | `200 AdminCrawlDomainDto`                                                              | `422 invalid_outcome` (an unknown decision, or `uncertain`, which is where an unreviewed domain already sits)                                                                                                                              | `admin.test.ts`      | **Addition**                      |
| `POST /admin/language-model/re-enable`                  | operator | `admin/metrics.ts`                           | `200 AdminLlmSuspension { suspended, mismatches }`                                     | `403 operator_only`; `503 service_unavailable` (the flag's store cannot be reached)                                                                                                                                                        | `admin.test.ts`      | **Addition**                      |

The paging fields and filters on `GET /admin/call-tasks` are an **Addition**: the body AAP 0.5.4 fixes
for that row, `{ items: AdminCallTaskDto[] }`, neither counts the tasks a request matches nor carries
the read past its first page, while the queue holds more of them than one answer can. `total` counts
every task the filters match with the cursor ignored; `nextCursor` continues the read and is null on
the last page; and `status`, `kind`, `q`, `limit` (default 200) and `cursor` are the query parameters
the route accepts, raising `400 invalid_field` for a `limit` outside 1–500, a cursor this API did
not write, or a parameter the queue does not carry. `items` is unchanged, so a client that sends no
query still reads one page of 200 tasks in the same order.

`503 fx_rate_unavailable` on `POST /admin/call-tasks/:id/resolve` is an **Addition**: AAP 0.5.6
converts a price at the capture day's `FxRate`, and only the daily `fx-refresh` job writes that
table, so a stack younger than its first 00:30 UTC cannot convert a non-USD price the operator was
told. The route answers `503` with a message naming the currency rather than the `422 invalid_outcome`
AAP 0.5.4 reserves for an outcome or a lifecycle the call-task rules refuse; nothing is stored, and
the task stays in the queue, so the same entry succeeds unchanged once a rate exists.

### Webhooks

| Route                        | Auth                               | Handler                                              | Response                                   | Errors (in check order)                                                                                                     | Test                      | Addition     |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------ |
| `POST /webhooks/stripe`      | Stripe signature over the raw body | `payments/webhook.ts`                                | `200`, no body; deduplicated on `event.id` | `400 bad_signature`; `503 payment_unavailable` (Addition, when the PaymentIntent a missing field needs cannot be retrieved) | `webhooks-stripe.test.ts` | —            |
| `POST /webhooks/voice`       | Twilio signature                   | `voice-agent/status-webhook.ts`                      | `204`                                      | `400 bad_signature`; `400 invalid_field` (a body that is not form-encoded)                                                  | `webhooks-voice.test.ts`  | —            |
| `POST /webhooks/voice/twiml` | Twilio signature                   | `voice-agent/twiml.ts`                               | TwiML XML (`rawResponse`, no JSON schema)  | `400 bad_signature`                                                                                                         | `webhooks-voice.test.ts`  | **Addition** |
| `WS /webhooks/voice/relay`   | Twilio signature on the upgrade    | `voice-agent/relay-ws.ts`, `voice-agent/dialogue.ts` | ConversationRelay JSON frames              | `400 bad_signature`; `503 service_unavailable` (the concurrent-session cap)                                                 | `webhooks-voice.test.ts`  | **Addition** |

All four take the webhook per-IP counter, at the provider allowance, because one provider's traffic
arrives from a handful of addresses.

### Test control

| Route                       | Auth       | Handler                                          | Response | Errors (in check order)                                                   | Test                              | Addition     |
| --------------------------- | ---------- | ------------------------------------------------ | -------- | ------------------------------------------------------------------------- | --------------------------------- | ------------ |
| `POST /test/clock`          | test token | `test-control/routes.ts`                         | `204`    | `404 not_found` (not `APP_ENV=test`, or a bad token); `400 invalid_field` | `tests/system`, `apps/mobile/e2e` | **Addition** |
| `POST /test/run-settlement` | test token | `test-control/routes.ts`, `settlement/settle.ts` | `204`    | `404 not_found`; `400 invalid_field`                                      | `tests/system`, `apps/mobile/e2e` | **Addition** |

Both are hidden from `openapi.json`. `X-Test-Control-Token` is compared in constant time and an absent
header, a repeated one and a wrong token all answer the same `404 not_found`, so the routes are
invisible where they are not mounted.

### Health

| Route         | Auth   | Handler  | Response                                                                                                                                                                                                           | Errors (in check order) | Test           | Addition     |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | -------------- | ------------ |
| `GET /health` | public | `app.ts` | `200 HealthResponse { status: "ok", checks: { database, redis } }` when both checks pass, `503 HealthResponse { status: "degraded", checks: { database, redis } }` when either fails; each check is `ok` or `fail` | —                       | `auth.test.ts` | **Addition** |

The probe is what compose gates stack readiness on, so it is mounted as its own context while the
plugins load and carries no counter.

## Why the additions exist

Each additive route closes a gap the contract's own responses open, and none has a counterpart in the
request's route table.

- **Refresh and logout** — `POST /auth/verify` returns a refresh token, so something must rotate it and
  something must end a session.
- **`GET /me`, consents and push tokens** — the age gate, the deposit-framing variant, the proof status,
  the Table Credit balance and push registration a client needs before any feature route.
- **Payment setup** — a hold confirmed on-session needs a saved card, which is what the contract's `402`
  on propose and `locked` on accept presuppose.
- **Own meetups and the proposal detail** — recovery after a `402` or a `503`, and the "viewed by the
  recipient" funnel step the dashboard counts.
- **The hold retry** — the initiator's retry after a declined card, when the `402` envelope carries no
  meetup id.
- **Booking details** — the operator's manual verification call, audited by `OperatorAccessLog`.
- **Crawl domains** — an operator's review of a site's terms, which must happen before any crawl.
- **The operator's city catalogue** — the operator area is entered by role alone and lies outside the
  age gate, so it cannot read `GET /cities`, which that gate guards; and the dashboard's city filter,
  its per-city rows, the registry's city selects and the call-task currency map are all labelled from
  that one list. `GET /admin/cities` is the same read, answered to the role the area guards on.
- **The language-model re-enable** — AAP 0.5.6 suspends language-model use in every city on a
  counted-versus-reported input-token mismatch and ends that suspension only when an operator
  re-enables it, which is the one write that ends it.
- **The call-task queue's paging and filters** — the operator queue holds thousands of tasks, far more
  than one answer can carry, so the read names a page (`limit`, default 200) and continues from the
  `nextCursor` it answered, narrowing by status, kind and a search over the target's name and reporting
  in `total` how many tasks those filters match.
- **The profile photo** — the bytes of the tier-2 `hasPhoto` field, which is never part of a profile
  payload.
- **Cities and the ZK configuration** — city browsing, and the keys, registry leaves, salt and artefact
  URLs the device builds circuit inputs from without a DNS lookup.
- **Events** — `suggestion_place_opened`, the one client event the dashboard's metric set reads.
- **Health** — the readiness probe compose and Docker gate the stack on.
- **Venue and lodging onboarding, secrets and reports** — the operator tools the venue registry, the
  console secrets and the report queue need.
- **TwiML and the relay socket** — Twilio ConversationRelay fetches the one and connects to the other;
  neither fits a JSON request and response.
- **Test control** — criterion tests that must cross the 45-minute check-in window, the 24-hour erasure
  limit and the 30-day anti-farming rule without waiting.
- **`kind` on the dispute body** — free text cannot reliably mark a `venue_unavailable` dispute, which
  the operator resolves `no_fault` as the penalty-free exit.
- **`meetupId` on the report body** — the report route names the reported traveler and nothing else, so
  a report filed from a meetup's chat reached the operator queue with a null meetup; the field carries
  the meetup the report was filed from, and the API records the pair's most recent shared meetup when
  it is absent (AAP 0.5.2 `Report.meetupId`).
- **`counterpartCheckedIn` on `MeetupDto`** — AAP 0.5.4's field list carries the caller's own check-in
  alone, so neither attendee could see whether the other showed up until the meetup settled; the field
  reports the counterpart's pass `CheckIn` row (AAP 0.5.7), which the meetup still holds while it is
  `locked`.
- **The five added error codes** — `503 payment_unavailable` and `409 hold_pending` carry the
  lost-response recovery for a card hold, `401 token_invalid` the write fence behind account deletion,
  `422 self_proposal` the proposal whose recipient is its caller, and `503 service_unavailable` the
  rate limiter's Redis outage and the suspension flag's store being unreachable on the re-enable.

## Regenerating the OpenAPI document

`pnpm --filter @tablemate/api openapi:emit` rewrites [`./openapi.json`](./openapi.json) from the route
schemas through `apps/api/scripts/emit-openapi.ts`; it needs no running service, no database and no
Redis. Commit the file with any route or schema change and never edit it by hand.

`openapi.json` is excluded from Prettier and from `pnpm loc`, and this README is maintained by hand:
update the route tables, the Addition marks and the notes above in the same change as the code.
