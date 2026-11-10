/**
 * The operator contract (AAP 0.8.1): the dashboard metrics, the dispute, call-task, lodging-claim and report
 * queues, venue and lodging onboarding, and the crawl-domain review — all served by `/admin/*` routes that
 * require `role = operator` (`403 operator_only` otherwise) and rendered by the web-only `/ops` area.
 *
 * No DTO here declares a console-secret field, a booking name or reference, or a user's email address: the two
 * shapes holding plaintext on purpose are {@link SecretIssued} and {@link BookingDetailsDto}, the audited read
 * that writes an `OperatorAccessLog` row. Every `outcome` and `decision` is a plain `z.string()`, because no
 * schema can tell a lifecycle transition from an illegal one; the handler checks the enum and answers
 * `422 invalid_outcome`. Client-safe: no Node built-in, no DOM global, no side effect.
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
  Cursor,
  DateOnly,
  Domain,
  E164,
  FreeText,
  IsoDateTime,
  Latitude,
  Longitude,
  Uuid,
} from './common.ts';
import { PriceItemInput } from './suggestions.ts';
/** The query string of `GET /admin/metrics`. The range applies to `Meetup.startsAt`, so a meetup counts in the period it was meant to happen in rather than the day it settled, and `variant` selects a `VariantPairing`, because the two participants may hold different variants. A reversed range is rejected rather than read as a zero. The compare is a string compare, valid because `DateOnly` is fixed-width `YYYY-MM-DD`. */
export const MetricsQuery = z
  .strictObject({
    from: DateOnly,
    to: DateOnly,
    cityId: CitySlug.optional(),
    variant: VariantPairing.optional(),
  })
  .refine((query) => query.from <= query.to, '`from` must not be later than `to`.');
export type MetricsQuery = z.infer<typeof MetricsQuery>;
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
/** Calls by outcome, each task counted once and dated by `CallTask.outcomeAt`; `no_answer` is the one entry that is not a task status — it counts a task still `queued` whose latest attempt went unanswered. `satisfies` holds the keys to `CallAttemptOutcome`, so an outcome added to the lifecycle cannot be left off the dashboard. */
const CallOutcomeCounts = z.object({
  completed: Count,
  refused: Count,
  do_not_call: Count,
  unreachable: Count,
  needs_review: Count,
  no_answer: Count,
} satisfies Record<CallAttemptOutcome, typeof Count>);
/** Blocked tasks by reason, 0 when none; `satisfies` holds the keys to `BlockedReason`, which is what makes the blocked panel complete. */
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
 * The operator dashboard, per city and date range, the range applied to `startsAt` for every meetup measure.
 *
 * `completion` is the headline the pilot is judged by: both-pass check-ins over meetups that reached two locked
 * holds, both read from `Meetup.lockedAt` and `CheckIn` and never from `status`, so a later hold loss or dispute
 * resolution does not rewrite history; a meetup whose window is still open stays in the denominator as
 * `openWindowMeetups`, and `rate` is null, not 0, when nothing was locked. `funnel` counts distinct meetups per
 * stage from the retained timestamps, attributing the stage through `Meetup.variantPairing`, which survives
 * account erasure; a late cancellation counts as a no-show, because the canceller is the absent party.
 *
 * The `cityId` filter narrows every per-city figure while the variant filter reaches the meetup measures alone,
 * and `signups`, the one global figure, is last on purpose: the hypothesis is tested on completion rate.
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
/** The answer of `POST /admin/language-model/re-enable`: the suspension flag as the operator's own clear left it, not an assumed `false`, while `mismatches` stays the cumulative counter the spend panel reports, because only the flag is the suspension. */
export const AdminLlmSuspension = z.object({
  suspended: z.boolean(),
  mismatches: Count,
});
export type AdminLlmSuspension = z.infer<typeof AdminLlmSuspension>;
/** One dispute in the operator queue. `checkIns` is what the operator settles on: each participant's handle with their pass, fail or absent result, a handle null for a tombstone and a result null when that participant never checked in. `overdue` is the flag `dispute-escalate-<disputeId>` sets 24 hours before `deadlineAt`; `reason` is the filer's free text, null once the 180-day purge has removed it. */
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
/** The body of `POST /admin/disputes/:id/resolve`: `settle_by_checkins` or `no_fault`, checked by the handler against `DisputeOutcome`, which answers `422 invalid_outcome` otherwise. A resolution before `startsAt + 45 min` only closes the dispute — the meetup stays `locked` and the outcome waits for the timer — so a check-in made in between still counts. */
export const ResolveDispute = z.strictObject({ outcome: z.string() });
export type ResolveDispute = z.infer<typeof ResolveDispute>;
/** The query string of `GET /admin/call-tasks`, the operator's call queue: a strict object, so a parameter this contract does not carry is `400 invalid_field` rather than ignored. `status` narrows the queue to one of the two statuses an operator still has to resolve; `q` searches the target business's name, trimmed before it is bounded; `cursor` is the `nextCursor` a previous page answered. */
export const AdminCallTasksQuery = z.strictObject({
  status: z.enum(['needs_review', 'unreachable']).optional(),
  kind: CallTaskKind.optional(),
  q: FreeText.trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: Cursor.optional(),
});
export type AdminCallTasksQuery = z.infer<typeof AdminCallTasksQuery>;
/** The partial fields one call extracted: a free-form map, because what a call yields depends on the task kind and how far the dialogue got, and only JSON scalars reach it. For a menu call `priceText` is copied verbatim from the source, so nothing here is invented; null for a lodging verification. */
export const ExtractedFields = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type ExtractedFields = z.infer<typeof ExtractedFields>;
/** One automated call task in the operator queue. `targetName` is the business dialed — a place or a lodging, never a traveler. `blockedReason` says why a task is not being dialed while it stays out of the dialing path, and `extractedFields` is null for a lodging verification, whose call content does not outlive its claim. */
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
/** One page of `GET /admin/call-tasks`, oldest outcome first — `outcomeAt` ascending, the task id breaking a same-instant tie, a task with no outcome yet last. `total` counts every task the filters match with the cursor ignored, and counts matching tasks rather than DTOs, so a row the guarded client hides leaves `items` one element shorter than `total`; both extra fields are additive. */
export const AdminCallTasksResponse = z.object({
  items: z.array(AdminCallTaskDto),
  total: Count,
  nextCursor: Cursor.nullable(),
});
export type AdminCallTasksResponse = z.infer<typeof AdminCallTasksResponse>;
/** The body of `POST /admin/call-tasks/:id/resolve`: the handler validates `outcome` against `OperatorCallTaskOutcome` and accepts it only for a `menu_prices` task that is neither terminal nor already resolved; a lodging-verification task is resolved through its claim. `prices` belongs to `completed` alone, the only outcome that stores anything, which makes prices with any other outcome a `400 invalid_field` before any task is read rather than a `200` with the array dropped. */
export const ResolveCallTask = z
  .strictObject({
    outcome: z.string(),
    prices: z.array(PriceItemInput).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.prices !== undefined && body.outcome !== 'completed') {
      ctx.addIssue({
        code: 'custom',
        message: '`prices` accompanies `completed` only.',
        path: ['prices'],
      });
    }
  });
export type ResolveCallTask = z.infer<typeof ResolveCallTask>;
/** One lodging claim in the operator queue. Never the booking details: the operator sees that the claim exists, which lodging and city it concerns and whether the details are still readable, and reads the name and reference through the audited route of {@link BookingDetailsDto} when a manual verification call needs them. `expiresAt` is `createdAt + 72 h`, the instant `claim-expire-<claimId>` moves an unresolved claim to `unreachable` with no penalty. */
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
/** The body of `POST /admin/lodging-claims/:id/resolve`: `verified`, `rejected` or `unreachable`, checked against `OperatorClaimOutcome` and accepted only while the claim is `pending_call` or `calling`. A claim that is already terminal answers `422 invalid_outcome`. */
export const ResolveLodgingClaim = z.strictObject({ outcome: z.string() });
export type ResolveLodgingClaim = z.infer<typeof ResolveLodgingClaim>;
/** The body of `GET /admin/lodging-claims/:id/booking-details`: the one route that returns a decrypted booking name, for the manual verification call that is the fallback when the automated call cannot resolve a claim. Every read is audited with an `OperatorAccessLog` row — purpose `manual_verification_call`, no booking data in the log itself — and the route answers `409 details_unavailable` once the claim is terminal or the details were erased by the first hourly `data-expiry` run after it resolved, well inside the 24-hour limit. */
export const BookingDetailsDto = z.object({
  claimId: Uuid,
  bookingName: z.string(),
  bookingReference: z.string().nullable(),
});
export type BookingDetailsDto = z.infer<typeof BookingDetailsDto>;
/** The body of `POST /admin/price-jobs`: `menus` queues menu ingestion for a city, `calls` its phone fallback. When the city's call cap or language-model spend cap is already used up for its local day, the route answers `429 daily_cap_reached` and queues nothing. */
export const PriceJobRequest = z.strictObject({ cityId: CitySlug, kind: PriceJobKind });
export type PriceJobRequest = z.infer<typeof PriceJobRequest>;
/** The `202` answer of `POST /admin/price-jobs`: the id of the queued job (AAP 0.5.4). */
export const PriceJobResponse = z.object({ jobId: z.string() });
export type PriceJobResponse = z.infer<typeof PriceJobResponse>;
/** One user report in the operator queue. Both handles are nullable, because either party may have deleted their account and become a tombstone by the time the queue is read; `reason` is the reporter's free text, null once the 180-day purge has removed it, and `meetupId` is null when the report concerns no meetup. */
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
/** One venue in the operator registry: the public {@link VenueDto} fields plus the two facts only `/ops` shows. `isFixture` marks a seeded record, written only in `test` and `demo` and filtered out of every read elsewhere; `secretIssuedAt` is when the venue's console secret was issued, null until one has been, and the secret itself is never part of a read, because the issue route shows it once. */
export const AdminVenueDto = VenueDto.extend({
  isFixture: z.boolean(),
  secretIssuedAt: IsoDateTime.nullable(),
});
export type AdminVenueDto = z.infer<typeof AdminVenueDto>;
/** The query string of `GET /admin/venues`, the operator's venue registry: a strict object, so a parameter this contract does not carry is `400 invalid_field` rather than ignored, which keeps a client's misspelled filter from silently reading the whole registry. `q` searches the venue's name and is trimmed before it is bounded; `limit` defaults to the read's own bound. */
export const AdminVenuesQuery = z.strictObject({
  cityId: CitySlug.optional(),
  q: FreeText.trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: Cursor.optional(),
});
export type AdminVenuesQuery = z.infer<typeof AdminVenuesQuery>;
/** One page of `GET /admin/venues`, the venue registry (AAP 0.5.4, requirement 10): every venue in (city, name, id) order, an active partner and a paused one alike, because pausing a venue is a status change rather than a withdrawal from the registry. `total` counts every venue the filters match with the cursor ignored, and counts matching rows rather than DTOs, so a venue with no stored coordinate — which has no `AdminVenueDto`, the DTO requiring `lat` and `lng` — leaves `items` one element shorter than `total`; both extra fields are additive. */
export const AdminVenuesResponse = z.object({
  items: z.array(AdminVenueDto),
  total: Count,
  nextCursor: Cursor.nullable(),
});
export type AdminVenuesResponse = z.infer<typeof AdminVenuesResponse>;
/** One lodging in the operator registry. `phoneSource` and `doNotCall` are the two operator-managed phone facts: the weekly OpenStreetMap refresh never overwrites a number whose source is `operator`, never clears `doNotCall`, and never touches a manually entered lodging at all. `secretIssuedAt` mirrors `Venue.secretIssuedAt`, the column `packages/db/prisma/schema.prisma` carries. */
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
/** The query string of `GET /admin/lodgings`, the operator's lodging registry: a strict object, so a parameter this contract does not carry is `400 invalid_field` rather than ignored, which keeps a client's misspelled filter from silently reading the whole registry. `q` searches the lodging's name and is trimmed before it is bounded; `limit` defaults to the read's own bound. */
export const AdminLodgingsQuery = z.strictObject({
  cityId: CitySlug.optional(),
  q: FreeText.trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: Cursor.optional(),
});
export type AdminLodgingsQuery = z.infer<typeof AdminLodgingsQuery>;
/** One page of `GET /admin/lodgings`, the lodging registry: the current lodgings in (city, name, id) order, with the rows an OpenStreetMap refresh found missing left out, because a lodging that carries `osmMissingAt` has left the public directory too. `total` counts every lodging the filters match with the cursor ignored, and counts matching rows rather than DTOs, so a row the guarded client cannot render leaves `items` one element shorter than `total`; both extra fields are additive. */
export const AdminLodgingsResponse = z.object({
  items: z.array(AdminLodgingDto),
  total: Count,
  nextCursor: Cursor.nullable(),
});
export type AdminLodgingsResponse = z.infer<typeof AdminLodgingsResponse>;
/** The body of `POST /admin/venues`: operator-led venue onboarding. `placeId` links the new venue to a place the price pipeline already ingested, so suggestions can find its neighbours; a venue entered without one is a stand-alone partner until a refresh matches it. `422 venue_not_partner` is what rejects a proposal at a venue that is not an active partner. */
export const CreateVenueRequest = z.strictObject({
  cityId: CitySlug,
  name: FreeText.min(1).max(120),
  address: FreeText.min(1).max(200),
  lat: Latitude,
  lng: Longitude,
  placeId: Uuid.optional(),
  isActivePartner: z.boolean().optional(),
});
export type CreateVenueRequest = z.infer<typeof CreateVenueRequest>;
/** The body of `PATCH /admin/venues/:id`: any subset of the editable fields, and at least one of them, because a client that sends an empty body has misread the route. `lat` and `lng` are supplied together, since moving a venue half-way would leave the 150 m check-in geofence measured from a point that is not the venue anymore. Deactivating a venue leaves existing `locked` meetups to settle where they are. */
export const UpdateVenueRequest = z
  .strictObject({
    name: FreeText.min(1).max(120).optional(),
    address: FreeText.min(1).max(200).optional(),
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
/** The body of `POST /admin/lodgings`: manual lodging entry. Such a lodging has no OpenStreetMap identity and is stored with `phoneSource = operator`, so the weekly refresh never overwrites it and never removes it for having disappeared from a query. `phone` is required as a key and may be null: a lodging with no callable number is legitimate, and a claim against one waits in the operator queue instead of being dialed. */
export const CreateLodgingRequest = z.strictObject({
  cityId: CitySlug,
  name: FreeText.min(1).max(120),
  kind: LodgingKind,
  address: FreeText.min(1).max(200),
  phone: E164.nullable(),
  lat: Latitude,
  lng: Longitude,
});
export type CreateLodgingRequest = z.infer<typeof CreateLodgingRequest>;
/** The one-time answer of `POST /admin/venues/:id/secret` and `POST /admin/lodgings/:id/secret`, and the only plaintext secret in this module. The server keeps the secret as a SHA-256 lookup hash plus AES-256-GCM ciphertext, because the code generator needs the secret itself; the value is shown to the operator once and stored for seeded rows in the gitignored `.local/fixture-secrets.json`. */
export const SecretIssued = z.object({ secret: z.string() });
export type SecretIssued = z.infer<typeof SecretIssued>;
/** One domain in the crawl-policy review queue. `decision` is `uncertain` until an operator reads the site's terms and records `allowed` or `prohibited`, and a domain that is not `allowed` is never fetched; `reason` states why the decision was recorded, and `overridden` is true once an operator set it, which tells a later reader the value is a human judgement rather than a derived one. A decision is not rechecked automatically. */
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
/** The body of `PATCH /admin/crawl-domains/:domain`. The handler accepts `allowed` or `prohibited` — `uncertain` is where an unreviewed domain already sits — records `overriddenBy`, and answers `422 invalid_outcome` for anything else. */
export const CrawlDomainDecisionUpdate = z.strictObject({ decision: z.string() });
export type CrawlDomainDecisionUpdate = z.infer<typeof CrawlDomainDecisionUpdate>;
/** The contents of `config/crawl-blocklist.json`: the aggregator, delivery and review sites the menu pipeline never fetches. A blocklisted domain is recorded `prohibited` with reason `blocklist`, and its places take the phone fallback instead. Domains are lower case by construction — `Domain` admits no upper-case letter — so a mistyped host fails the file loudly instead of being crawled under a second spelling, and a repeated domain is rejected because one host must not hold two decisions. It is a configuration file and so a `strictObject`: an unknown key is a mistake to raise, not to ignore. */
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
