/**
 * The operator routes of `/v1/admin/*`: the dashboard, the four operator queues with the resolutions that act on
 * them, the price-job trigger, venue and lodging onboarding with their console-secret issue routes, the report queue,
 * the crawl-domain review queue and the language-model re-enable.
 *
 * Every handler here is a call and nothing else: the rule each route exposes is decided in the module beside it, a
 * handler passes that function the app's services, the authenticated operator's id and `request.receivedAt`, and
 * `plugins/errors.ts` renders a module's `AppError` into the shared envelope with the status the contract fixes.
 *
 * The guard is group-level and never global: `app.addHook('onRequest', requireOperator)` covers exactly the routes
 * below and cannot reach the traveler routes, the public routes, the provider webhooks or the console routes.
 * `/admin/*` is outside the 18+ age gate. Reads are unlimited and writes are counted: every POST and PATCH spreads
 * `mutatingLimits(app)`.
 *
 * Three answers carry a value nobody else may hold — the two plaintext console secrets, shown once, and a guest's
 * decrypted booking name and reference — so all three set `Cache-Control: no-store`. Time is the request's own
 * instant, `request.receivedAt`, and this file reads no clock of its own and logs nothing.
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
  CitiesResponse,
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

import { cityList } from '../cities/routes.ts';

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

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
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
 * The group guard above admitted this request, so `request.auth` is set — but that is a property of
 * the registration, not of the handler: a hook that were moved, removed or shadowed would otherwise
 * leave a `TypeError` to be answered as `500 internal_error` where the contract requires `401
 * token_invalid`, and no compiler check would catch it.
 *
 * @throws AppError `token_invalid` (401) when no context is present.
 */
function operatorAuth(request: FastifyRequest): AuthContext {
  if (request.auth === null) {
    throw new AppError('token_invalid');
  }
  return request.auth;
}

/**
 * The guard comes first and covers this context alone: `requireOperator` reads the access token and
 * the account's role, and installing it here rather than globally is what keeps `/admin/*` guarded
 * while the traveler, public, provider and console routes stay outside it (AAP 0.5.4). Every handler
 * below then delegates: it hands the module function the app's services, the operator's id where the
 * rule is audited or fenced on it, and `request.receivedAt`.
 */
export default function adminRoutes(app: App): Promise<void> {
  app.addHook('onRequest', requireOperator);
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
  // The operator's own read of the launch-city catalogue, and the same list the age-gated
  // `GET /cities` answers: the dashboard's city filter, the per-city labels, the registry's city
  // selects and the call-task currency map are all labelled from it (AAP 0.5.4). The operator area is
  // not a traveler feature route, so it reads the catalogue here rather than through the route the
  // age gate guards.
  app.get(
    '/admin/cities',
    {
      schema: {
        tags: [ADMIN_TAG],
        security: OPENAPI_SECURITY.bearer,
        response: { 200: CitiesResponse, 401: ErrorEnvelope, 403: ErrorEnvelope },
      },
    },
    async (request) => cityList(request.server.services),
  );
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
