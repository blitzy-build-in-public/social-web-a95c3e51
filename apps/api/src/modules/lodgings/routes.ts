/**
 * The six lodging routes: a city's lodging directory, one lodging's detail page with its opted-in guest list, the three routes of
 * a stay claim, and the staying-visibility toggle.
 *
 * Every route here is a traveler feature route, so the whole plugin carries one guard: `guardRouteGroup(app, requireTraveler)`
 * registers the group's per-IP counter and then `requireTraveler`, which admits a caller with a valid session *and* a recorded
 * age gate and answers `401 token_invalid` or `403 age_gate_required` otherwise. Both hooks are installed on this plugin's
 * context, never globally.
 *
 * Four invariants hold across the file: the caller's own proof gates the disclosure, so the directory, the detail and a claim all
 * require a proof valid for the city in question and answer `403 no_valid_proof` otherwise; reads are unlimited and writes are
 * counted, so the two GETs carry no counter and the POST, DELETE and PUT spread `mutatingLimits(app)`; nothing above the caller's
 * entitlement leaves the server, because no DTO built here carries a console secret, a booking name or reference, another
 * traveler's stay dates or room number, or any user's coordinates; and the writes happen inside `claims.ts` and `visibility.ts`,
 * each in one `transact` behind the account-deletion write fence, while this file opens no transaction, takes no lock and makes no
 * Redis call of its own.
 *
 * The instant every window is judged at is `request.receivedAt`, set once per request by the root clock hook, never `Date.now()`.
 */

import { z } from 'zod';

import { readPoints } from '@tablemate/db';
import {
  CityIdParams,
  ErrorEnvelope,
  IdParams,
  LodgingClaimCreated,
  LodgingClaimRequest,
  LodgingClaimStatusDto,
  LodgingDetail,
  LodgingListQuery,
  LodgingsResponse,
  VisibilityRequest,
  VisibilityResponse,
} from '@tablemate/shared';

import { requireTraveler } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { guardRouteGroup, mutatingLimits } from '../../plugins/rate-limit.ts';
import { hasValidProof } from '../proofs/validity.ts';
import { createClaim, deleteClaim, getClaim } from './claims.ts';
import { leaderboard, lodgingSummary } from './leaderboard.ts';
import { guestsFor, setVisibility } from './visibility.ts';

import type { App } from '../../app.ts';
import type { FastifyRequest } from 'fastify';

const LODGINGS_TAG = 'lodgings' satisfies OpenApiTag;

/**
 * The authenticated caller's id, or a refusal: the guard above admitted this request, but that is a property of the registration
 * rather than of the handler, so a hook that were moved, removed or shadowed would otherwise leave a `TypeError` answered as
 * `500 internal_error` where the contract requires `401 token_invalid`.
 *
 * `@throws AppError token_invalid` (401) when no context is present.
 */
function callerId(request: FastifyRequest): string {
  if (request.auth === null) {
    throw new AppError('token_invalid');
  }
  return request.auth.userId;
}

/**
 * Registers the six lodging routes of AAP 0.5.4 on the context `app.ts` mounts under `/v1`.
 *
 * Registration is synchronous, as in every other plugin the composition root installs, so the returned promise is already resolved;
 * the declared `Promise<void>` is what keeps this plugin usable wherever Fastify's own plugin types expect one.
 */
export default function lodgingRoutes(app: App): Promise<void> {
  guardRouteGroup(app, requireTraveler);
  app.get(
    '/cities/:cityId/lodgings',
    {
      schema: {
        tags: [LODGINGS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: CityIdParams,
        querystring: LodgingListQuery,
        response: {
          200: LodgingsResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request) => {
      const userId = callerId(request);
      const { cityId } = request.params;
      const { sort } = request.query;
      // The city is resolved before the proof, so an unknown city answers `404 city_not_found` rather
      // than a refusal that would read as "you have not proved this city" (AAP 0.5.4 order).
      const city = await app.services.db.city.findUnique({
        where: { id: cityId },
        select: { id: true },
      });
      if (city === null) {
        throw new AppError('city_not_found');
      }
      if (!(await hasValidProof(app.services.db, userId, cityId, request.receivedAt))) {
        throw new AppError('no_valid_proof');
      }
      return { items: await leaderboard(app.services, cityId, sort) };
    },
  );
  app.get(
    '/lodgings/:id',
    {
      schema: {
        tags: [LODGINGS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: LodgingDetail,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request) => {
      const userId = callerId(request);
      const now = request.receivedAt;
      // The guarded client applies the fixture rule itself, so a fixture outside `test` and `demo` is
      // not found here either; a lodging that has left the OpenStreetMap directory (`osmMissingAt`
      // set) counts as not found (AAP 0.5.6). Only the id and the city are read: the summary fields
      // come from the city's own board below, and from the lodging's own row when the board's bound
      // left it out, so this detail and the list cannot disagree about a lodging (AAP 0.5.4).
      const lodging = await app.services.db.lodging.findFirst({
        where: { id: request.params.id, osmMissingAt: null },
        select: { id: true, cityId: true },
      });
      if (lodging === null) {
        throw new AppError('lodging_not_found');
      }
      if (!(await hasValidProof(app.services.db, userId, lodging.cityId, now))) {
        throw new AppError('no_valid_proof');
      }
      // The city's own board first: where it carries this lodging, its entry is what the directory
      // answers with, so the two cannot disagree. The board is bounded, though, so a lodging the
      // bound's cut left out is resolved from its own row, its own window facts and its own guest
      // count — the sources the board itself is computed from — and answered with its own numbers at
      // the position after every listed lodging, instead of as a lodging that does not exist
      // (AAP 0.5.4, 0.5.7).
      const board = await leaderboard(app.services, lodging.cityId, 'activity');
      const entry =
        board.find((item) => item.id === lodging.id) ??
        (await lodgingSummary(app.services, lodging.id, board.length));
      const point = (
        await readPoints(app.services.db, 'lodging', [lodging.id], app.services.env.APP_ENV)
      ).get(lodging.id);
      // Two defects rather than client mistakes, each of them its own gap: the row was listed a
      // moment ago and this detail has to answer it, so a row that is gone or no longer listed
      // leaves nothing to describe; and `LodgingDetail` cannot carry a lodging without coordinates.
      // Each is answered as not found — the one refusal the contract has for this route — and
      // logged, because neither gap is filled by inventing a value.
      if (entry === null) {
        request.log.warn(
          {
            event: 'lodging_detail_unrepresentable',
            lodgingId: lodging.id,
            missing: 'lodging_row',
          },
          'lodging detail cannot be rendered; answered as not found',
        );
        throw new AppError('lodging_not_found');
      }
      if (point === undefined) {
        request.log.warn(
          {
            event: 'lodging_detail_unrepresentable',
            lodgingId: lodging.id,
            missing: 'location',
          },
          'lodging detail cannot be rendered; answered as not found',
        );
        throw new AppError('lodging_not_found');
      }
      // Field by field, never a spread of a row: the summary fields are the entry resolved above —
      // the board's own, or the lodging's own row through the board's mapping — and the guest list is
      // the tier-0 shape `guestsFor` builds (AAP 0.5.4, 0.5.7).
      return {
        id: entry.id,
        cityId: entry.cityId,
        name: entry.name,
        kind: entry.kind,
        address: entry.address,
        phone: entry.phone,
        rank: entry.rank,
        activityScore: entry.activityScore,
        guestCount: entry.guestCount,
        lat: point.lat,
        lng: point.lng,
        guests: await guestsFor(app.services, lodging.id, userId, now),
      };
    },
  );
  app.post(
    '/me/lodging-claims',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [LODGINGS_TAG],
        security: OPENAPI_SECURITY.bearer,
        body: LodgingClaimRequest,
        response: {
          201: LodgingClaimCreated,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          409: ErrorEnvelope,
          422: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      const userId = callerId(request);
      // `createClaim` owns the checks and their order (AAP 0.5.4): consent, a non-empty booking name,
      // the lodging, the caller's proof, one active claim, the stay dates, the lodging's city.
      const created = await createClaim(app.services, userId, request.body);
      reply.code(201);
      return created;
    },
  );
  app.get(
    '/me/lodging-claims/:id',
    {
      schema: {
        tags: [LODGINGS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: LodgingClaimStatusDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request) => {
      const userId = callerId(request);
      // Ownership is part of the query, so another traveler's claim is answered as one that does not
      // exist. The booking name and reference are not read here (AAP 0.5.2).
      return await getClaim(app.services, userId, request.params.id);
    },
  );
  app.delete(
    '/me/lodging-claims/:id',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [LODGINGS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        // `204` carries no body: Fastify runs no serializer for that status, and the reply below
        // hands it the `null` the schema declares.
        response: {
          204: z.null(),
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
      const userId = callerId(request);
      // The claim, its booking ciphertext and its outstanding verification work go together; a call
      // that may be live is the one refusal, and it is `deleteClaim`'s to raise (AAP 0.5.3).
      await deleteClaim(app.services, userId, request.params.id);
      reply.code(204).send(null);
    },
  );
  app.put(
    '/me/lodging-visibility',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [LODGINGS_TAG],
        security: OPENAPI_SECURITY.bearer,
        body: VisibilityRequest,
        response: {
          200: VisibilityResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          409: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request) => {
      const userId = callerId(request);
      // Turning the flag on needs a verified, still-active claim and answers `409 no_verified_claim`
      // without one; turning it off always succeeds (AAP 0.5.7).
      return await setVisibility(app.services, userId, request.body.showStaying);
    },
  );
  return Promise.resolve();
}
