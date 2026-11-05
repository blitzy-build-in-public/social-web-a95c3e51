/**
 * The operator contract (AAP 0.8.1): the dashboard metrics of AAP 0.5.7, the dispute, call-task,
 * lodging-claim and report queues, venue and lodging onboarding, and the crawl-domain review of
 * AAP 0.5.6.
 *
 * Every route built on these shapes is an `/admin/*` route that requires `role = operator` and
 * answers `403 operator_only` to anybody else (AAP 0.5.4). The `/ops` area of the Expo web build
 * renders them and is web-only (AAP 0.5.8).
 *
 * No DTO here declares a console-secret field, a booking name or reference, or a user's email
 * address (AAP 0.5.4). Two shapes hold plaintext on purpose and each has one route —
 * {@link SecretIssued} is the single answer of the secret issue routes, and
 * {@link BookingDetailsDto} is the audited booking-details read, which writes an
 * `OperatorAccessLog` row (AAP 0.5.4).
 *
 * Operator input splits in two. `MetricsQuery` states the one bound the contract can express
 * itself; every `outcome` and `decision` below is a plain `z.string()`, because no schema can tell
 * a lifecycle transition from an illegal one. The handler validates the value against the
 * lifecycle enum — `DisputeOutcome`, `OperatorCallTaskOutcome`, `OperatorClaimOutcome`, or
 * `allowed`/`prohibited` — and answers `422 invalid_outcome` for an unknown value and for a
 * transition the lifecycle forbids, such as any outcome on a lodging-verification call task
 * (AAP 0.5.3, 0.5.4).
 *
 * Client-safe by construction — `zod`, the contract primitives and the domain enums, with no Node
 * built-in, no DOM global and no top-level side effect — because the same module loads under
 * Hermes, in a browser and in Node (AAP 0.11.1).
 *
 * @see AAP 0.5.3 for the dispute, call-task and lodging-claim lifecycles, 0.5.6 for the crawl
 * policy and the calls and spend the dashboard reports, and 0.5.7 for the metric definitions.
 */
import { z } from 'zod';

import {
  BlockedReason,
  CallAttemptOutcome,
  CallTaskKind,
  CallTaskStatus,
  CheckInResult,
  CrawlDecision,
  DisputeKind,
  DisputeStatus,
  LodgingClaimStatus,
  LodgingKind,
  PhoneSource,
  PriceJobKind,
  VariantPairing,
} from '../enums.ts';
import { VenueDto } from './cities.ts';
import {
  CitySlug,
  Count,
  DateOnly,
  Domain,
  E164,
  IsoDateTime,
  Latitude,
  Longitude,
  Uuid,
} from './common.ts';
import { PriceItemInput } from './suggestions.ts';

// ---------------------------------------------------------------------------------------------
// GET /admin/metrics (AAP 0.5.4, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The query string of `GET /admin/metrics` (AAP 0.5.4).
 *
 * The range applies to `Meetup.startsAt`, so a meetup counts in the period it was meant to happen
 * in rather than the day it settled. `variant` selects a `VariantPairing` — the two participants
 * may hold different variants, so each meetup carries its pairing and counts once (AAP 0.5.7). A
 * reversed range is rejected rather than tolerated: it has no reading, and a silently empty
 * dashboard would look like a real zero. The comparison is a string compare by design, valid
 * because `DateOnly` is fixed-width `YYYY-MM-DD` (AAP 0.3.3).
 */
export const MetricsQuery = z
  .strictObject({
    from: DateOnly,
    to: DateOnly,
    cityId: CitySlug.optional(),
    variant: VariantPairing.optional(),
  })
  .refine((query) => query.from <= query.to, '`from` must not be later than `to`.');
export type MetricsQuery = z.infer<typeof MetricsQuery>;

/** One city's count in a per-city breakdown of the dashboard. */
const CityCount = z.object({ cityId: CitySlug, count: Count });

/** One venue's meetup count over the range, named so the operator need not look an id up. */
const VenueCount = z.object({ venueId: Uuid, venueName: z.string(), count: Count });

/** One city's calls on one local day, against that day's cap (AAP 0.5.6). */
const CallCapDay = z.object({ cityId: CitySlug, localDate: DateOnly, calls: Count, cap: Count });

/** One city's language-model spend on one local day, in micro-dollars, against its cap. */
const LlmSpendDay = z.object({
  cityId: CitySlug,
  localDate: DateOnly,
  spendMicros: Count,
  capMicros: Count,
});

/**
 * Calls by outcome (AAP 0.5.7), each task counted once and dated by `CallTask.outcomeAt`.
 *
 * `no_answer` is the one entry that is not a task status: it counts a task still `queued` whose
 * latest attempt went unanswered. The keys are exactly the members of `CallAttemptOutcome`, which
 * the `satisfies` clause holds at compile time, so an outcome added to the lifecycle cannot be
 * left out of the dashboard.
 */
const CallOutcomeCounts = z.object({
  completed: Count,
  refused: Count,
  do_not_call: Count,
  unreachable: Count,
  needs_review: Count,
  no_answer: Count,
} satisfies Record<CallAttemptOutcome, typeof Count>);

/**
 * Blocked tasks by reason, 0 when none (AAP 0.5.3, 0.5.7).
 *
 * The keys are exactly the members of `BlockedReason`, held by the `satisfies` clause, which is
 * what makes the blocked panel complete: a task set aside for vendor failures, an unreconcilable
 * dispatch or a number that is not allowlisted still shows up here.
 */
const BlockedReasonCounts = z.object({
  not_allowlisted: Count,
  no_phone: Count,
  do_not_call: Count,
  invalid_number: Count,
  vendor_unavailable: Count,
  dispatch_unknown: Count,
  no_final_status: Count,
} satisfies Record<BlockedReason, typeof Count>);

/**
 * The operator dashboard (AAP 0.5.4, 0.5.7), per city and date range, with the range applied to
 * `startsAt` for every meetup measure.
 *
 * `completion` is the headline the pilot is judged by: meetups with a pass check-in from both
 * participants over meetups that reached two locked holds. Both terms come from `Meetup.lockedAt`
 * and `CheckIn`, never from `status`, so a later hold loss or dispute resolution does not rewrite
 * history; a meetup whose window is still open stays in the denominator and is reported beside the
 * rate as `openWindowMeetups`. `rate` is null, not 0, when nothing was locked. `thresholds` are
 * the pilot's reference lines from `PILOT_LOCK_RATE_THRESHOLD` and `PILOT_COMPLETION_THRESHOLD`,
 * drawn on the chart rather than tested (AAP 0.7.3).
 *
 * `funnel` counts distinct meetups at each stage from the retained timestamps, so acceptance is
 * counted separately from the lock it may not reach; the stage is attributed through
 * `Meetup.variantPairing`, which survives account erasure (AAP 0.5.2). In `counts` a late
 * cancellation counts as a no-show, because the canceller is the absent party (AAP 0.5.7).
 *
 * `calls.llmSuspended` and `calls.llmCountMismatches` feed the spend panel: a model whose
 * reported token count differs from the count taken before sending suspends language-model use in
 * every city until an operator re-enables it (AAP 0.5.6).
 *
 * `lodgingClaims` and `signups` come from the unlinked `account_created`,
 * `lodging_claim_submitted` and `lodging_claim_resolved` events, which survive account erasure, so
 * neither figure moves when a user is deleted (AAP 0.5.2). `signups` is last on purpose: the
 * hypothesis is tested on completion rate, and a signup count is never a headline number
 * (AAP 0.1.1).
 */
export const MetricsDto = z.object({
  completion: z.object({
    lockedMeetups: Count,
    bothCheckedIn: Count,
    rate: z.number().min(0).max(1).nullable(),
    openWindowMeetups: Count,
  }),
  thresholds: z.object({
    lockRate: z.number(),
    completion: z.number(),
  }),
  funnel: z.object({
    proposalsSent: Count,
    proposalsViewed: Count,
    proposalsAccepted: Count,
    bothLocked: Count,
    bothCheckedIn: Count,
  }),
  counts: z.object({
    noShows: Count,
    cancelledEarly: Count,
    cancelledLate: Count,
    lockLost: Count,
    disputesOpened: Count,
  }),
  activeProofsByCity: z.array(CityCount),
  meetupsByVenue: z.array(VenueCount),
  prices: z.object({
    placesWithFreshPriceByCity: z.array(CityCount),
    neighborhoodsCoveredShare: z.number().min(0).max(1).nullable(),
    meetupsWithSuggestionsViewed: Count,
    placesOpened: Count,
  }),
  calls: z.object({
    byOutcome: CallOutcomeCounts,
    lifecycle: z.object({
      queuedWithoutOutcome: Count,
      inProgress: Count,
      cancelled: Count,
      blockedByReason: BlockedReasonCounts,
    }),
    perDay: z.array(CallCapDay),
    spend: z.array(LlmSpendDay),
    llmSuspended: z.boolean(),
    llmCountMismatches: Count,
  }),
  lodgingClaims: z.object({
    submitted: Count,
    verified: Count,
    rejected: Count,
    unreachable: Count,
    medianResolveSeconds: Count.nullable(),
  }),
  signups: Count,
});
export type MetricsDto = z.infer<typeof MetricsDto>;

// ---------------------------------------------------------------------------------------------
// Operator queues: disputes, call tasks, lodging claims and reports (AAP 0.5.3, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * One dispute in the operator queue (AAP 0.5.4).
 *
 * `checkIns` is what the operator settles on: each participant's handle with their pass, fail or
 * absent result. A handle is null for a tombstone and a result is null when that participant never
 * checked in (AAP 0.5.2, 0.5.3). `overdue` is the flag `dispute-escalate-<disputeId>` sets 24
 * hours before `deadlineAt`, after which the operator has one day of the five left. `reason` is
 * the filer's free text, null once the 180-day purge has removed it.
 */
export const AdminDisputeDto = z.object({
  id: Uuid,
  meetupId: Uuid,
  cityId: CitySlug,
  venueName: z.string(),
  kind: DisputeKind,
  reason: z.string().nullable(),
  status: DisputeStatus,
  openedAt: IsoDateTime,
  deadlineAt: IsoDateTime,
  overdue: z.boolean(),
  checkIns: z.array(z.object({ handle: z.string().nullable(), result: CheckInResult.nullable() })),
});
export type AdminDisputeDto = z.infer<typeof AdminDisputeDto>;

/** The body of `GET /admin/disputes`, the open disputes by `deadlineAt` (AAP 0.5.4). */
export const AdminDisputesResponse = z.object({ items: z.array(AdminDisputeDto) });
export type AdminDisputesResponse = z.infer<typeof AdminDisputesResponse>;

/**
 * The body of `POST /admin/disputes/:id/resolve` (AAP 0.5.4): `settle_by_checkins` or `no_fault`,
 * checked by the handler against `DisputeOutcome`, which answers `422 invalid_outcome` otherwise.
 * A resolution before `startsAt + 45 min` only closes the dispute — the meetup stays `locked`,
 * check-in stays open and the outcome waits for the timer — so a check-in made in between counts
 * (AAP 0.5.3).
 */
export const ResolveDispute = z.strictObject({ outcome: z.string() });
export type ResolveDispute = z.infer<typeof ResolveDispute>;

/**
 * The partial fields one call extracted, as the queue shows them (AAP 0.5.4): a free-form map,
 * because what a call yields depends on the task kind and how far the dialogue got, and only JSON
 * scalars reach it. For a menu call these are the values the model extracted, with `priceText`
 * copied verbatim from the source, so nothing here is invented (AAP 0.5.6). Null for a lodging
 * verification, whose content is erased once its claim resolves (AAP 0.5.2).
 */
export const ExtractedFields = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type ExtractedFields = z.infer<typeof ExtractedFields>;

/**
 * One automated call task in the operator queue (AAP 0.5.4).
 *
 * `targetName` is the business dialed — a place or a lodging, never a traveler. `blockedReason`
 * says why a task is not being dialed while it stays out of the dialing path, `lastOutcome` and
 * `lastSummary` are the latest attempt's results, and `extractedFields` is null for a lodging
 * verification, whose call content does not outlive its claim (AAP 0.5.3, 0.5.6).
 */
export const AdminCallTaskDto = z.object({
  id: Uuid,
  kind: CallTaskKind,
  targetName: z.string(),
  cityId: CitySlug,
  status: CallTaskStatus,
  attempts: Count,
  nextAttemptAt: IsoDateTime.nullable(),
  blockedReason: BlockedReason.nullable(),
  lastOutcome: CallAttemptOutcome.nullable(),
  lastSummary: z.string().nullable(),
  extractedFields: ExtractedFields.nullable(),
});
export type AdminCallTaskDto = z.infer<typeof AdminCallTaskDto>;

/** The body of `GET /admin/call-tasks`, the queue in priority order (AAP 0.5.4, 0.5.7). */
export const AdminCallTasksResponse = z.object({ items: z.array(AdminCallTaskDto) });
export type AdminCallTasksResponse = z.infer<typeof AdminCallTasksResponse>;

/**
 * The body of `POST /admin/call-tasks/:id/resolve` (AAP 0.5.4).
 *
 * The handler validates `outcome` against `OperatorCallTaskOutcome` and accepts it only for a
 * `menu_prices` task that has not reached a terminal state and was not already resolved by an
 * operator; anything else answers `422 invalid_outcome`. A lodging-verification task is resolved
 * through its claim instead, so any outcome here on one is `422` too (AAP 0.5.3). `completed`
 * carries the prices the operator was told on the phone and stores them as `operator_entry`; a
 * ticket price states `perPerson` and `ticketType` like any other entry (AAP 0.5.6).
 */
export const ResolveCallTask = z.strictObject({
  outcome: z.string(),
  prices: z.array(PriceItemInput).optional(),
});
export type ResolveCallTask = z.infer<typeof ResolveCallTask>;

/**
 * One lodging claim in the operator queue (AAP 0.5.4).
 *
 * Never the booking details: the operator sees that the claim exists, which lodging and city it
 * concerns and whether the details are still readable, and reads the name and reference through
 * the audited route of {@link BookingDetailsDto} when a manual verification call needs them.
 * `expiresAt` is `createdAt + 72 h`, the instant `claim-expire-<claimId>` moves an unresolved
 * claim to `unreachable` with no penalty (AAP 0.5.3).
 */
export const AdminLodgingClaimDto = z.object({
  id: Uuid,
  lodgingName: z.string(),
  lodgingPhone: E164.nullable(),
  cityId: CitySlug,
  status: LodgingClaimStatus,
  stayFrom: DateOnly,
  stayTo: DateOnly,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  detailsAvailable: z.boolean(),
});
export type AdminLodgingClaimDto = z.infer<typeof AdminLodgingClaimDto>;

/** The body of `GET /admin/lodging-claims`, the operator's claim queue (AAP 0.5.4). */
export const AdminLodgingClaimsResponse = z.object({ items: z.array(AdminLodgingClaimDto) });
export type AdminLodgingClaimsResponse = z.infer<typeof AdminLodgingClaimsResponse>;

/**
 * The body of `POST /admin/lodging-claims/:id/resolve` (AAP 0.5.4): `verified`, `rejected` or
 * `unreachable`, checked by the handler against `OperatorClaimOutcome` and accepted only while the
 * claim is `pending_call` or `calling`. A claim that is already terminal, or that is `calling`
 * because a call may genuinely be live, answers `422 invalid_outcome` (AAP 0.5.3).
 */
export const ResolveLodgingClaim = z.strictObject({ outcome: z.string() });
export type ResolveLodgingClaim = z.infer<typeof ResolveLodgingClaim>;

/**
 * The body of `GET /admin/lodging-claims/:id/booking-details` (AAP 0.5.4), the one route that
 * returns a decrypted booking name, for the manual verification call that is the fallback when the
 * automated call cannot resolve a claim.
 *
 * Every read is audited with an `OperatorAccessLog` row — purpose `manual_verification_call`, no
 * booking data in the log itself — and the route answers `409 details_unavailable` once the claim
 * is terminal or the details were erased by the first hourly `data-expiry` run after it resolved,
 * well inside the 24-hour limit (AAP 0.5.2).
 */
export const BookingDetailsDto = z.object({
  claimId: Uuid,
  bookingName: z.string(),
  bookingReference: z.string().nullable(),
});
export type BookingDetailsDto = z.infer<typeof BookingDetailsDto>;

/**
 * The body of `POST /admin/price-jobs`: `menus` queues menu ingestion for a city, `calls` its
 * phone fallback (AAP 0.5.4, 0.5.6). When the city's call cap or language-model spend cap is
 * already used up for its local day the route answers `429 daily_cap_reached` and queues nothing.
 */
export const PriceJobRequest = z.strictObject({ cityId: CitySlug, kind: PriceJobKind });
export type PriceJobRequest = z.infer<typeof PriceJobRequest>;

/** The `202` answer of `POST /admin/price-jobs`: the id of the queued job (AAP 0.5.4). */
export const PriceJobResponse = z.object({ jobId: z.string() });
export type PriceJobResponse = z.infer<typeof PriceJobResponse>;

/**
 * One user report in the operator queue (AAP 0.5.4).
 *
 * Both handles are nullable, because either party may have deleted their account and become a
 * tombstone by the time the queue is read. `reason` is the reporter's free text, null once the
 * 180-day purge has removed it, and `meetupId` is null when the report concerns no meetup
 * (AAP 0.5.2).
 */
export const AdminReportDto = z.object({
  id: Uuid,
  reporterHandle: z.string().nullable(),
  reportedHandle: z.string().nullable(),
  reason: z.string().nullable(),
  meetupId: Uuid.nullable(),
  createdAt: IsoDateTime,
});
export type AdminReportDto = z.infer<typeof AdminReportDto>;

/** The body of `GET /admin/reports`, newest first (AAP 0.5.4). */
export const AdminReportsResponse = z.object({ items: z.array(AdminReportDto) });
export type AdminReportsResponse = z.infer<typeof AdminReportsResponse>;

// ---------------------------------------------------------------------------------------------
// Venue and lodging onboarding (AAP 0.5.2, 0.5.4, 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * One venue in the operator registry (AAP 0.5.4): the public {@link VenueDto} fields plus the two
 * facts only `/ops` shows. `isFixture` marks a seeded record, written only in `test` and `demo`
 * and filtered out of every read elsewhere (AAP 0.5.2). `secretIssuedAt` is when the venue's
 * console secret was issued, null until one has been; the secret itself is never part of a read,
 * because the issue route shows it once (AAP 0.3.2).
 */
export const AdminVenueDto = VenueDto.extend({
  isFixture: z.boolean(),
  secretIssuedAt: IsoDateTime.nullable(),
});
export type AdminVenueDto = z.infer<typeof AdminVenueDto>;

/** The body of `GET /admin/venues`, the venue registry (AAP 0.5.4, requirement 10). */
export const AdminVenuesResponse = z.object({ items: z.array(AdminVenueDto) });
export type AdminVenuesResponse = z.infer<typeof AdminVenuesResponse>;

/**
 * One lodging in the operator registry (AAP 0.5.4).
 *
 * `phoneSource` and `doNotCall` are the two operator-managed phone facts: the weekly OpenStreetMap
 * refresh never overwrites a number whose source is `operator`, never clears `doNotCall`, and
 * never touches a manually entered lodging at all (AAP 0.5.6). `secretIssuedAt` mirrors
 * `Venue.secretIssuedAt`; AAP 0.5.2's table text omits it on `Lodging`, while
 * `packages/db/prisma/schema.prisma` carries the column this DTO needs.
 */
export const AdminLodgingDto = z.object({
  id: Uuid,
  cityId: CitySlug,
  name: z.string(),
  kind: LodgingKind,
  address: z.string().nullable(),
  phone: E164.nullable(),
  lat: Latitude,
  lng: Longitude,
  isFixture: z.boolean(),
  secretIssuedAt: IsoDateTime.nullable(),
  phoneSource: PhoneSource,
  doNotCall: z.boolean(),
});
export type AdminLodgingDto = z.infer<typeof AdminLodgingDto>;

/** The body of `GET /admin/lodgings`, the lodging registry (AAP 0.5.4, requirement 15). */
export const AdminLodgingsResponse = z.object({ items: z.array(AdminLodgingDto) });
export type AdminLodgingsResponse = z.infer<typeof AdminLodgingsResponse>;

/**
 * The body of `POST /admin/venues`: operator-led venue onboarding (AAP 0.5.4, requirement 10).
 *
 * `placeId` links the new venue to a place the price pipeline already ingested, so suggestions can
 * find its neighbours; a venue entered without one is a stand-alone partner until a refresh
 * matches it. `isActivePartner` defaults to true server-side, and `422 venue_not_partner` is what
 * rejects a proposal at a venue that is not an active partner (AAP 0.5.4).
 */
export const CreateVenueRequest = z.strictObject({
  cityId: CitySlug,
  name: z.string().min(1).max(120),
  address: z.string().min(1).max(200),
  lat: Latitude,
  lng: Longitude,
  placeId: Uuid.optional(),
  isActivePartner: z.boolean().optional(),
});
export type CreateVenueRequest = z.infer<typeof CreateVenueRequest>;

/**
 * The body of `PATCH /admin/venues/:id` (AAP 0.5.4): any subset of the editable fields, and at
 * least one of them. An empty body is rejected rather than treated as a no-op, because a client
 * that sends one has misread the route. `lat` and `lng` are supplied together, since moving a
 * venue half-way would leave the 150 m check-in geofence measured from a point that is not the
 * venue anymore (AAP 0.5.7). Deactivating a venue leaves existing `locked` meetups to settle where
 * they are.
 */
export const UpdateVenueRequest = z
  .strictObject({
    name: z.string().min(1).max(120).optional(),
    address: z.string().min(1).max(200).optional(),
    lat: Latitude.optional(),
    lng: Longitude.optional(),
    isActivePartner: z.boolean().optional(),
  })
  .superRefine((update, ctx) => {
    if (Object.values(update).every((value) => value === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Supply at least one field to update.', path: [] });
      return;
    }

    const latSupplied = update.lat !== undefined;

    if (latSupplied !== (update.lng !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Supply `lat` and `lng` together.',
        path: [latSupplied ? 'lat' : 'lng'],
      });
    }
  });
export type UpdateVenueRequest = z.infer<typeof UpdateVenueRequest>;

/**
 * The body of `POST /admin/lodgings`: manual lodging entry (AAP 0.5.4, requirement 15).
 *
 * Such a lodging has no OpenStreetMap identity and is stored with `phoneSource = operator`, so the
 * weekly refresh never overwrites it and never removes it for having disappeared from a query
 * (AAP 0.5.6). `phone` is required as a key and may be null: a lodging with no callable number is
 * legitimate, and a claim against one waits in the operator queue instead of being dialed
 * (AAP 0.5.3).
 */
export const CreateLodgingRequest = z.strictObject({
  cityId: CitySlug,
  name: z.string().min(1).max(120),
  kind: LodgingKind,
  address: z.string().min(1).max(200),
  phone: E164.nullable(),
  lat: Latitude,
  lng: Longitude,
});
export type CreateLodgingRequest = z.infer<typeof CreateLodgingRequest>;

/**
 * The one-time answer of `POST /admin/venues/:id/secret` and `POST /admin/lodgings/:id/secret`
 * (AAP 0.5.4), and the only plaintext secret in this module.
 *
 * The server keeps the secret as a SHA-256 lookup hash plus AES-256-GCM ciphertext, because the
 * code generator needs the secret itself; the value is shown to the operator once and stored for
 * seeded rows in the gitignored `.local/fixture-secrets.json`, never in the repository
 * (AAP 0.3.2, 0.5.2).
 */
export const SecretIssued = z.object({ secret: z.string() });
export type SecretIssued = z.infer<typeof SecretIssued>;

// ---------------------------------------------------------------------------------------------
// Crawl-domain review and the blocklist (AAP 0.5.6)
// ---------------------------------------------------------------------------------------------

/**
 * One domain in the crawl-policy review queue (AAP 0.5.6, `CrawlDomainPolicy`).
 *
 * `decision` is `uncertain` until an operator reads the site's terms and records `allowed` or
 * `prohibited`, and a domain that is not `allowed` is never fetched. `reason` states why the
 * decision was recorded — `blocklist`, `awaiting_review`, or the operator's note — and
 * `overridden` is true once an operator set the decision, which tells a later reader that the
 * value is a human judgement rather than a derived one. A decision is not rechecked automatically.
 */
export const AdminCrawlDomainDto = z.object({
  domain: Domain,
  decision: CrawlDecision,
  reason: z.string(),
  checkedAt: IsoDateTime,
  overridden: z.boolean(),
});
export type AdminCrawlDomainDto = z.infer<typeof AdminCrawlDomainDto>;

/** The body of `GET /admin/crawl-domains`, the domains awaiting review (AAP 0.5.4). */
export const AdminCrawlDomainsResponse = z.object({ items: z.array(AdminCrawlDomainDto) });
export type AdminCrawlDomainsResponse = z.infer<typeof AdminCrawlDomainsResponse>;

/**
 * The body of `PATCH /admin/crawl-domains/:domain` (AAP 0.5.4). The handler accepts `allowed` or
 * `prohibited` — `uncertain` is where an unreviewed domain already sits — records `overriddenBy`,
 * and answers `422 invalid_outcome` for anything else.
 */
export const CrawlDomainDecisionUpdate = z.strictObject({ decision: z.string() });
export type CrawlDomainDecisionUpdate = z.infer<typeof CrawlDomainDecisionUpdate>;

/**
 * The contents of `config/crawl-blocklist.json` (AAP 0.5.6): the aggregator, delivery and review
 * sites the menu pipeline never fetches, read by `apps/workers/src/menus/blocklist.ts`.
 *
 * A blocklisted domain is recorded `prohibited` with reason `blocklist`, and its places take the
 * phone fallback instead. Domains are lower case by construction — `Domain` admits no upper-case
 * letter — so a mistyped host fails the file loudly instead of being crawled under a second
 * spelling, and a repeated domain is rejected because one host must not hold two decisions. It is
 * a configuration file and so a `strictObject`: an unknown key is a mistake to raise, not to
 * ignore silently.
 */
export const CrawlBlocklist = z
  .strictObject({ domains: z.array(Domain).min(1) })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();

    file.domains.forEach((domain, index) => {
      if (seen.has(domain)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate blocklisted domain "${domain}".`,
          path: ['domains', index],
        });
      }
      seen.add(domain);
    });
  });
export type CrawlBlocklist = z.infer<typeof CrawlBlocklist>;
