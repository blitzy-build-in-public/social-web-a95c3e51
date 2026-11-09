/**
 * The operator routes of `/v1/admin/*` (AAP 0.5.1 `admin/routes.ts`, 0.5.4, 0.8.1): the dashboard,
 * the four operator queues with the resolutions that act on them, the price-job trigger, venue and
 * lodging onboarding with their console-secret issue routes, the report queue, the crawl-domain
 * review queue and the language-model re-enable of AAP 0.5.6.
 *
 * Every handler here is a call and nothing else. The rule each route exposes is decided in the
 * module beside it — `metrics.ts` (`computeMetrics`, `reEnableLanguageModel`),
 * `disputes.ts` (`listDisputes`, `resolveDispute`), `call-tasks.ts` (`listCallTasks`,
 * `resolveCallTask`), `lodging-claims.ts` (`listLodgingClaims`, `resolveLodgingClaim`,
 * `bookingDetails`), `price-jobs.ts`
 * (`enqueuePriceJob`), `onboarding.ts` (`listVenues`, `createVenue`, `updateVenue`,
 * `issueVenueSecret`, `listLodgings`, `createLodging`, `issueLodgingSecret`), `reports.ts`
 * (`listReports`) and `crawl-domains.ts` (`listCrawlDomains`, `decideCrawlDomain`) — and a handler
 * passes that function the app's services, the authenticated operator's id and
 * `request.receivedAt`, in the order the module declares its parameters. No check, refusal,
 * transaction, counter or DTO is assembled here, and no refusal is translated: a module throws its
 * `AppError` and `plugins/errors.ts` renders it into the shared envelope with the status AAP 0.5.4
 * fixes (AAP 0.11.1).
 *
 * **The guard is group-level and never global (AAP 0.5.4).** `app.addHook('onRequest',
 * requireOperator)` is installed on this plugin's own context, which `app.ts` mounts under `/v1`,
 * so it covers exactly the routes below and cannot reach the traveler routes, the public routes, the
 * provider webhooks or the console routes. An operator is admitted by session and by `User.role`,
 * read from the database rather than from the token; a traveler's valid token answers `403
 * operator_only` and a missing, invalid or revoked one `401 token_invalid`. `/admin/*` is outside
 * the 18+ age gate, so no traveler guard is installed anywhere in this file (AAP 0.5.4).
 *
 * **Reads are unlimited, writes are counted (AAP 0.5.4).** Every POST and PATCH below spreads
 * `mutatingLimits(app)`, which runs the per-IP counter on `onRequest` and the per-user one on
 * `preHandler`: 60 a minute per operator, `RATE_LIMIT_IP_PER_MIN` per address, answered as
 * `429 rate_limited` with `Retry-After`, or as `503 service_unavailable` rather than an uncounted
 * request when the limiter's Redis store is unreachable (AAP 0.3.2). The plain reads carry no
 * counter at all. `GET /admin/lodging-claims/:id/booking-details` is a read that writes — it inserts
 * the `OperatorAccessLog` row that makes the disclosure auditable (AAP 0.5.2) — so it is the one GET
 * here that spreads the same limits.
 *
 * **Three answers carry a value nobody else may hold.** The two secret-issue routes answer the
 * plaintext console secret, which is shown once and stored only as a lookup hash beside a
 * ciphertext (AAP 0.3.2), and the booking-details route answers a guest's decrypted booking name and
 * reference. All three set `Cache-Control: no-store`, so no intermediary and no browser cache keeps
 * a copy (AAP 0.5.4). Nothing else in this file is cacheable either, but nothing else needs the
 * directive: every other answer lists rows an operator may re-read at will.
 *
 * **Time is the request's own instant.** Each handler passes `request.receivedAt`, the single
 * instant `plugins/clock.ts` stamps per request, and this file reads no clock of its own (AAP
 * 0.11.1). No handler logs: not a booking field, not a secret, not a report reason, not a phone
 * number. The modules record the event each rule calls for, naming ids only.
 *
 * Two choices AAP 0.5.4 leaves open are fixed here:
 *
 * - **A write answers the item it changed.** Each resolve, create and update route answers the
 *   updated DTO the module returned — the row as the queue would report it — rather than the row as
 *   it stood before the write or an empty body. The contract fixes the payload shape and not which
 *   moment of the row it shows, and an operator who has just resolved a dispute, onboarded a venue
 *   or issued a secret is best served by the state their click produced.
 * - **The routes are ordered as the contract lists them** — the dashboard, then the disputes, call
 *   tasks, lodging claims, price jobs, venues, lodgings, reports and crawl domains — so the
 *   registrations and the emitted document read in the same order as AAP 0.5.4. The re-enable route
 *   has no row in the contract's tables, so it stands after that sequence rather than inside it.
 *
 * Registration is synchronous, as in every other plugin the composition root installs, so the
 * returned promise is already resolved; `return Promise.resolve()` states that rather than relying
 * on the absence of an `await` (AAP 0.11.2: `@typescript-eslint/require-await`).
 *
 * @see AAP 0.5.4 for the routes, their schemas, their errors, the guard scope, the limits and the
 *   additive `booking-details` route, 0.5.6 for the suspension the re-enable clears, 0.5.1 for the
 *   admin component and the functions each handler calls, 0.5.3 for the dispute, call-task and claim
 *   lifecycles those functions own, 0.5.7 for the dashboard figures and the crawl policy, 0.3.2 for
 *   the rate limiting, the outbox and the console secrets, 0.5.2 for the booking fields and the audit
 *   log, 0.11.1 for the injected clock and the logging rules, 0.11.2 for the response-schema rule,
 *   and 0.8.1 for this file.
 */

import {
  AdminCallTaskDto,
  AdminCallTasksQuery,
  AdminCallTasksResponse,
  AdminCrawlDomainDto,
  AdminCrawlDomainsResponse,
  AdminDisputeDto,
  AdminDisputesResponse,
  AdminLlmSuspension,
  AdminLodgingClaimDto,
  AdminLodgingClaimsResponse,
  AdminLodgingDto,
  AdminLodgingsQuery,
  AdminLodgingsResponse,
  AdminReportsResponse,
  AdminVenueDto,
  AdminVenuesResponse,
  BookingDetailsDto,
  CrawlDomainDecisionUpdate,
  CreateLodgingRequest,
  CreateVenueRequest,
  DomainParams,
  ErrorEnvelope,
  IdParams,
  MetricsDto,
  MetricsQuery,
  PriceJobRequest,
  PriceJobResponse,
  ResolveCallTask,
  ResolveDispute,
  ResolveLodgingClaim,
  SecretIssued,
  UpdateVenueRequest,
} from '@tablemate/shared';

import { requireOperator, type AuthContext } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { mutatingLimits } from '../../plugins/rate-limit.ts';

import { listCallTasks, resolveCallTask } from './call-tasks.ts';
import { decideCrawlDomain, listCrawlDomains } from './crawl-domains.ts';
import { listDisputes, resolveDispute } from './disputes.ts';
import { bookingDetails, listLodgingClaims, resolveLodgingClaim } from './lodging-claims.ts';
import { computeMetrics, reEnableLanguageModel } from './metrics.ts';
import {
  createLodging,
  createVenue,
  issueLodgingSecret,
  issueVenueSecret,
  listLodgings,
  listVenues,
  updateVenue,
} from './onboarding.ts';
import { enqueuePriceJob } from './price-jobs.ts';
import { listReports } from './reports.ts';

import type { FastifyRequest } from 'fastify';

// Type-only, as in every sibling plugin and route module: `App` is the plan's one declaration of the
// instance and of what it hands its modules (AAP 0.5.1), it is erased at compile time, and nothing of
// `app.ts` is read here at runtime. `app.ts` registers this plugin with the `/v1` prefix, which is
// what makes the routes below `/v1/admin/...`.
import type { App } from '../../app.ts';

/** The tag every route here groups under: a member of the document's own vocabulary (AAP 0.11.2). */
const ADMIN_TAG = 'admin' satisfies OpenApiTag;

/**
 * The cache directive on the three answers that carry a value shown once — the two issued console
 * secrets and one claim's decrypted booking name and reference. `no-store` keeps every cache from
 * holding a copy: the secret is stored only as a hash and a ciphertext afterwards (AAP 0.3.2), and
 * the booking fields are erased once the claim reaches a terminal state (AAP 0.5.2), so a cached
 * copy would outlive the value it belongs to.
 */
const NO_STORE_CACHE_CONTROL = 'no-store';

/**
 * The authenticated operator's context, or a refusal.
 *
 * The group guard above admitted this request, so `request.auth` is set — but that is a property of
 * the registration, not of the handler: a hook that were moved, removed or shadowed would otherwise
 * leave a `TypeError` to be answered as `500 internal_error` where the contract requires `401
 * token_invalid`, and no compiler check would catch it.
 *
 * @param request - The request the operator guard admitted.
 * @returns The acting operator's context.
 * @throws AppError `token_invalid` (401) when no context is present.
 */
function operatorAuth(request: FastifyRequest): AuthContext {
  if (request.auth === null) {
    throw new AppError('token_invalid');
  }
  return request.auth;
}

/**
 * Registers the operator routes of AAP 0.5.4 on the context `app.ts` mounts under `/v1` (AAP 0.5.1).
 *
 * The guard comes first and covers this context alone: `requireOperator` reads the access token and
 * the account's role, and installing it here rather than globally is what keeps `/admin/*` guarded
 * while the traveler, public, provider and console routes stay outside it (AAP 0.5.4). Every handler
 * below then delegates: it hands the module function the app's services, the operator's id where the
 * rule is audited or fenced on it, and `request.receivedAt`.
 *
 * @param app - The route instance; its `services` carry the guarded database client, the injected
 *   clock, the field keyring the booking fields are decrypted with, the BullMQ producers the price
 *   jobs are enqueued on, the outbox and the logger — the container every function called here reads.
 * @see AAP 0.5.4 for the routes, their schemas, their errors and the guard scope, and 0.5.3 for the
 *   lifecycles the resolutions apply.
 */
export default function adminRoutes(app: App): Promise<void> {
  app.addHook('onRequest', requireOperator);

  // 1. The dashboard (AAP 0.5.4). A read: no counter, and an unknown `cityId` is not an error here —
  // it simply yields zero figures. A reversed range is the one refusal, and it is `computeMetrics`'s
  // `400 invalid_field`.
  app.get(
    '/admin/metrics',
    {
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        querystring: MetricsQuery,
        response: { 200: MetricsDto, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (request) => computeMetrics(request.server.services, request.query, request.receivedAt),
  );

  // 2-3. The dispute queue and one operator's resolution of a dispute in it (AAP 0.5.4, 0.5.3). The
  // resolution answers the dispute as the queue reports it, with the status its outcome produced.
  app.get(
    '/admin/disputes',
    {
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        response: { 200: AdminDisputesResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (request) => listDisputes(request.server.services, request.receivedAt),
  );

  app.post(
    '/admin/disputes/:id/resolve',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        body: ResolveDispute,
        response: {
          200: AdminDisputeDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          422: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request) =>
      resolveDispute(
        request.server.services,
        operatorAuth(request).userId,
        request.params.id,
        request.body,
        request.receivedAt,
      ),
  );

  // 4-5. The call queue and one operator outcome on a `menu_prices` task (AAP 0.5.4, 0.5.3). The read
  // pages: its strict query string carries the queue's own filters and its cursor, and a malformed
  // cursor — like any other unusable value in that query — answers `400 invalid_field`. The lodging
  // registry below pages the same way. A lodging-verification task is refused by `resolveCallTask` with
  // `422 invalid_outcome`, because a claim is resolved through its own route below.
  app.get(
    '/admin/call-tasks',
    {
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        querystring: AdminCallTasksQuery,
        response: {
          200: AdminCallTasksResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
        },
      },
    },
    async (request) => listCallTasks(request.server.services, request.query),
  );

  app.post(
    '/admin/call-tasks/:id/resolve',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        body: ResolveCallTask,
        response: {
          200: AdminCallTaskDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          422: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request) =>
      resolveCallTask(
        request.server.services,
        operatorAuth(request).userId,
        request.params.id,
        request.body,
        request.receivedAt,
      ),
  );

  // 6-8. The lodging-claim queue, the operator's terminal outcome on a claim, and the audited read of
  // one claim's booking details (AAP 0.5.4, 0.5.2). The details read is the additive route, permitted
  // only while the claim is `pending_call` or `calling` and its details are not yet erased, which is
  // why its `409` is `details_unavailable` rather than a status the queue shares.
  app.get(
    '/admin/lodging-claims',
    {
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        response: { 200: AdminLodgingClaimsResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (request) => listLodgingClaims(request.server.services),
  );

  app.post(
    '/admin/lodging-claims/:id/resolve',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        body: ResolveLodgingClaim,
        response: {
          200: AdminLodgingClaimDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          422: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request) =>
      resolveLodgingClaim(
        request.server.services,
        operatorAuth(request).userId,
        request.params.id,
        request.body,
        request.receivedAt,
      ),
  );

  app.get(
    '/admin/lodging-claims/:id/booking-details',
    {
      // A read that writes: the `OperatorAccessLog` row an auditable disclosure needs, committed in
      // the same transaction as the read (AAP 0.5.2), is why this GET carries the mutating limits.
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: BookingDetailsDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          409: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const details = await bookingDetails(
        request.server.services,
        operatorAuth(request).userId,
        request.params.id,
        request.receivedAt,
      );

      // A guest's booking name and reference: shown to one operator for one manual verification call,
      // never cached anywhere (AAP 0.5.2, 0.5.4).
      reply.header('Cache-Control', NO_STORE_CACHE_CONTROL);

      return details;
    },
  );

  // 9. One city's price jobs (AAP 0.5.4, 0.5.6). The answer is `202 { jobId }`: the work runs in
  // `apps/workers`, never in this request. A city whose local day has used up its calls cap or its
  // committed language-model spend is the early refusal `429 daily_cap_reached`, and both caps are
  // still enforced where the work runs, so the refusal only saves the operator a job nobody would
  // run today.
  app.post(
    '/admin/price-jobs',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        body: PriceJobRequest,
        response: {
          202: PriceJobResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const queued = await enqueuePriceJob(
        request.server.services,
        request.body,
        request.receivedAt,
      );

      reply.code(202);
      return queued;
    },
  );

  // 10-13. The venue registry, its onboarding, its edit and its console secret (AAP 0.5.4, 0.5.6).
  // Onboarding answers `201` with the new venue and the two edits answer `200` with the venue as it
  // stands after them; the secret route answers the plaintext once, under `no-store`.
  app.get(
    '/admin/venues',
    {
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        response: { 200: AdminVenuesResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (request) => listVenues(request.server.services),
  );

  app.post(
    '/admin/venues',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        body: CreateVenueRequest,
        response: {
          201: AdminVenueDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const created = await createVenue(
        request.server.services,
        operatorAuth(request).userId,
        request.body,
        request.receivedAt,
      );

      reply.code(201);
      return created;
    },
  );

  app.patch(
    '/admin/venues/:id',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        body: UpdateVenueRequest,
        response: {
          200: AdminVenueDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request) =>
      updateVenue(
        request.server.services,
        operatorAuth(request).userId,
        request.params.id,
        request.body,
        request.receivedAt,
      ),
  );

  app.post(
    '/admin/venues/:id/secret',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: SecretIssued,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const issued = await issueVenueSecret(
        request.server.services,
        operatorAuth(request).userId,
        request.params.id,
        request.receivedAt,
      );

      // Issued once and never readable again: re-issuing replaces the stored hash and ciphertext, so
      // the previous secret stops authenticating the console at once (AAP 0.3.2).
      reply.header('Cache-Control', NO_STORE_CACHE_CONTROL);

      return issued;
    },
  );

  // 14-16. The lodging registry, the hand-entered lodging and its console secret (AAP 0.5.4, 0.5.6).
  // The registry read is the one here that pages: its strict query string carries a city filter, a
  // name search, a page size and its cursor, and any unusable value in it — a cursor this API did not
  // write, a `limit` outside 1-500, a parameter the route does not carry — answers `400 invalid_field`.
  // Issuing a secret is what makes a lodging a partner, which is why the place refresh is enqueued
  // there and not when the row was created.
  app.get(
    '/admin/lodgings',
    {
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        querystring: AdminLodgingsQuery,
        response: {
          200: AdminLodgingsResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
        },
      },
    },
    async (request) => listLodgings(request.server.services, request.query),
  );

  app.post(
    '/admin/lodgings',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        body: CreateLodgingRequest,
        response: {
          201: AdminLodgingDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const created = await createLodging(
        request.server.services,
        operatorAuth(request).userId,
        request.body,
        request.receivedAt,
      );

      reply.code(201);
      return created;
    },
  );

  app.post(
    '/admin/lodgings/:id/secret',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: SecretIssued,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const issued = await issueLodgingSecret(
        request.server.services,
        operatorAuth(request).userId,
        request.params.id,
        request.receivedAt,
      );

      reply.header('Cache-Control', NO_STORE_CACHE_CONTROL);

      return issued;
    },
  );

  // 17. The report queue (AAP 0.5.4, request item 12). A read of rows that never change, so the
  // reporter's free text is answered to an operator and to no one else.
  app.get(
    '/admin/reports',
    {
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        response: { 200: AdminReportsResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (request) => listReports(request.server.services),
  );

  // 18-19. The crawl-policy review queue and one operator's decision on a domain (AAP 0.5.4, 0.5.6).
  // `uncertain` is never accepted here: it is where an unreviewed domain already sits, and
  // `decideCrawlDomain` answers `422 invalid_outcome` for it and for any other value.
  app.get(
    '/admin/crawl-domains',
    {
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        response: { 200: AdminCrawlDomainsResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (request) => listCrawlDomains(request.server.services),
  );

  app.patch(
    '/admin/crawl-domains/:domain',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: DomainParams,
        body: CrawlDomainDecisionUpdate,
        response: {
          200: AdminCrawlDomainDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          422: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request) =>
      decideCrawlDomain(
        request.server.services,
        operatorAuth(request).userId,
        request.params.domain,
        request.body,
        request.receivedAt,
      ),
  );

  // 20. The operator's re-enable of language-model use (AAP 0.5.6). A mismatch suspends use in every
  // city "until an operator re-enables it", so this is the write that ends the suspension the
  // dashboard's Calls panel shows: it clears the shared `llm:suspended` flag and answers the flag as
  // it then stands, beside the cumulative mismatch count it leaves untouched. It has no row in the
  // contract's tables, which is why it stands after their sequence rather than inside it (see the
  // ordering note above); the module's refusal is a `503 service_unavailable` when the flag's store
  // cannot be reached, which the operator reads as a refusal rather than as an internal failure.
  app.post(
    '/admin/language-model/re-enable',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        response: {
          200: AdminLlmSuspension,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request) => reEnableLanguageModel(request.server.services, operatorAuth(request).userId),
  );

  return Promise.resolve();
}
