/**
 * The meetup routes (AAP 0.5.1, 0.5.3, 0.5.4, 0.8.1): the proposal, the acceptance and the commitment lock, the
 * retry of the initiator's hold, cancellation, check-in, dispute filing, and the caller's own two meetup reads.
 *
 * Nine operations are registered here and none of them holds a business rule: each reads its request, takes the
 * caller through the guard this plugin installs, and hands the work to the module that owns it. What this file
 * fixes is the contract of AAP 0.5.4 for those operations: the path, the schema each one validates and serializes
 * with, and the set of statuses it may answer.
 *
 * Four rules of that contract are applied here rather than in a handler:
 *
 *  - **The guard is route-group level, never global.** `requireTraveler` is added to this encapsulated context
 *    alone, so the age gate covers exactly these nine traveler features and an unverified traveler still reaches
 *    their own meetups: only proposing needs a valid proof, and `propose.ts` asks for it.
 *  - **Every POST, and the one read that writes, carries the mutating counters.** `mutatingLimits` spreads the
 *    per-IP and per-user allowances of AAP 0.5.4; the plain list read carries none.
 *  - **`GET /meetups/:id` is one of the two state-writing reads.** A recipient's first read of a visible proposal
 *    records `recipientViewedAt` and emits `proposal_viewed` in a transaction behind the account-deletion write
 *    fence — never on cached authentication alone — and the row is read back, so the answer reports what committed.
 *  - **Every route declares `schema.response`.** The composition root refuses to start with a non-WebSocket route
 *    that does not. The declared statuses are the ones AAP 0.5.4 lists, plus `400 invalid_field`, `401
 *    token_invalid`, `429 rate_limited` / `503 service_unavailable`, and `404 meetup_not_found` where a handler
 *    hides a meetup an id alone does not reveal.
 *
 * Two routes under this prefix deliberately live elsewhere: `GET /meetups/:id/messages` in
 * `../messaging/routes.ts` and `GET /meetups/:id/suggestions` in `../suggestions/routes.ts`, each with the module
 * that owns its rules.
 *
 * No handler logs anything: a check-in carries device coordinates and a dispute free text (AAP 0.11.1, 0.12.2). The
 * one instant a request is judged at is read once, from `request.receivedAt`, so no two window checks straddle it.
 */

import {
  AcceptResponse,
  CancelResponse,
  CheckInRequest,
  CheckInResponse,
  DeclineResponse,
  DisputeRequest,
  DisputeResponse,
  ErrorEnvelope,
  HoldRetryResponse,
  IdParams,
  MeetupDto,
  MeetupListQuery,
  MeetupListResponse,
  ProposeMeetup,
  ProposeResponse,
} from '@tablemate/shared';

import { requireTraveler, type AuthContext } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { mutatingLimits } from '../../plugins/rate-limit.ts';
import { transact } from '../outbox/write.ts';
import { acceptMeetup, declineMeetup, retryInitiatorHold } from './accept.ts';
import { cancelMeetup } from './cancel.ts';
import { checkIn } from './check-in.ts';
import { fileDispute } from './dispute.ts';
import { listMeetups, loadForParticipant, toMeetupDto } from './queries.ts';
import { proposeMeetup } from './propose.ts';
import { lockMeetup, markRecipientViewed } from './state-machine.ts';

// Type-only, as in every other route module: `App` is the one declaration of the app's type, it is
// erased at compile time, and nothing of `app.ts` is read here at runtime — which is also why this
// module holds no run-time edge back to the composition root that registers it.
import type { FastifyRequest } from 'fastify';
import type { App } from '../../app.ts';

/** The tag all nine routes group under: a member of the document's own vocabulary (AAP 0.11.2). */
const MEETUPS_TAG = 'meetups' satisfies OpenApiTag;

/**
 * The authenticated caller's context, or a refusal. The guard admitted this request, so `request.auth` is set — but
 * that is a property of the registration, not of a handler: a hook moved, removed or shadowed would otherwise leave
 * a `TypeError` to be answered as `500 internal_error` where the contract requires `401 token_invalid`. Throws
 * {@link AppError} `token_invalid` (401) when no context is present.
 */
function authContext(request: FastifyRequest): AuthContext {
  if (request.auth === null) {
    throw new AppError('token_invalid');
  }
  return request.auth;
}

/**
 * Registers the nine meetup routes on the context `app.ts` mounts under `/v1` (AAP 0.5.1, 0.5.4): registration is
 * synchronous, as in every other plugin the composition root installs, and every handler passes
 * `request.receivedAt` as its `now` (AAP 0.11.1).
 */
export default function meetupsRoutes(app: App): Promise<void> {
  app.addHook('onRequest', requireTraveler);
  app.get(
    '/meetups',
    {
      schema: {
        tags: [MEETUPS_TAG],
        security: OPENAPI_SECURITY.bearer,
        querystring: MeetupListQuery,
        response: {
          200: MeetupListResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    // A plain read, so it carries no counter. The page, its `role` and `status` filters, its keyset
    // cursor and the `400 invalid_field` a cursor this API did not write answers with all belong to
    // `queries.ts` (AAP 0.5.4).
    async (request) =>
      listMeetups(app.services, authContext(request).userId, request.query, request.receivedAt),
  );
  app.get(
    '/meetups/:id',
    {
      // One of the two reads that write (AAP 0.5.4): the counter cannot be dropped from the route
      // that records the recipient's first view.
      ...mutatingLimits(app),
      config: { stateWritingRead: true },
      schema: {
        tags: [MEETUPS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: MeetupDto,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    async (request) => {
      const userId = authContext(request).userId;
      const { id } = request.params;
      const now = request.receivedAt;
      // The caller's own meetup, or the refusals `loadForParticipant` owns, in their order: `404
      // meetup_not_found` for an unknown id, `403 not_participant` for a caller who is not on the
      // meetup, and `404 meetup_not_found` again for a recipient whose proposal is not visible yet,
      // so the route cannot be used to probe whether a proposal exists (AAP 0.5.3, 0.5.4).
      const loaded = await loadForParticipant(app.services.db, id, userId);
      let row = loaded.meetup;
      // The state-writing half: the recipient's first read of a visible proposal records
      // `recipientViewedAt` and emits the funnel's `proposal_viewed`. The mark is made under the
      // meetup row lock and behind the deletion write fence, so it can neither race a second read
      // into a second event nor commit for an account whose deletion is in flight, and the
      // conditional update inside `markRecipientViewed` keeps two racing first reads to one write
      // (AAP 0.5.3, 0.5.4). An initiator's read, a second read and a proposal whose row has gone
      // write nothing, and no transaction is opened for them.
      if (loaded.role === 'recipient' && loaded.meetup.recipientViewedAt === null) {
        await transact(
          app.services,
          async (tx) => {
            const locked = await lockMeetup(tx, id);
            if (locked !== null) {
              await markRecipientViewed(tx, app.services, locked, userId, now);
            }
          },
          { fenceUserId: userId },
        );
        // Read back after the commit, so the DTO answers from the row this request left behind.
        row = (await loadForParticipant(app.services.db, id, userId)).meetup;
      }
      // Field by field through the serializer, which carries no client secret (AAP 0.5.4).
      return toMeetupDto(app.services, row, userId, now);
    },
  );
  app.post(
    '/meetups',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [MEETUPS_TAG],
        security: OPENAPI_SECURITY.bearer,
        body: ProposeMeetup,
        response: {
          201: ProposeResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          402: ErrorEnvelope,
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
      // The guards and their order — including `422 self_proposal`, checked before any meetup or
      // hold exists — belong to `propose.ts` (AAP 0.5.4). The client secret in this body is the
      // caller's own hold attempt's.
      const proposal = await proposeMeetup(
        app.services,
        authContext(request).userId,
        request.body,
        request.receivedAt,
      );
      reply.code(201);
      return proposal;
    },
  );
  app.post(
    '/meetups/:id/accept',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [MEETUPS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: AcceptResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          402: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          409: ErrorEnvelope,
          410: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    // No body: acceptance is the caller, the meetup and the recipient's own hold attempt
    // (AAP 0.5.4).
    async (request) =>
      acceptMeetup(
        app.services,
        authContext(request).userId,
        request.params.id,
        request.receivedAt,
      ),
  );
  app.post(
    '/meetups/:id/decline',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [MEETUPS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: DeclineResponse,
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
    // No body: a decline is the recipient's refusal of a proposal that is still `proposed`, and the
    // releases it plans are `accept.ts`'s work (AAP 0.5.4).
    async (request) =>
      declineMeetup(
        app.services,
        authContext(request).userId,
        request.params.id,
        request.receivedAt,
      ),
  );
  app.post(
    '/meetups/:id/hold',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [MEETUPS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: HoldRetryResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          402: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          409: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    // No body: the additive retry route places a failed hold again, or returns the client secret of
    // the caller's own attempt that is waiting on 3-D Secure (AAP 0.5.4).
    async (request) =>
      retryInitiatorHold(
        app.services,
        authContext(request).userId,
        request.params.id,
        request.receivedAt,
      ),
  );
  app.post(
    '/meetups/:id/cancel',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [MEETUPS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        response: {
          200: CancelResponse,
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
    // No body: whether the cancellation is free or forfeits the caller's hold is measured against
    // `startsAt - 2 h` by `cancel.ts`, from this one instant (AAP 0.5.4).
    async (request) =>
      cancelMeetup(
        app.services,
        authContext(request).userId,
        request.params.id,
        request.receivedAt,
      ),
  );
  app.post(
    '/meetups/:id/check-in',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [MEETUPS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        body: CheckInRequest,
        response: {
          200: CheckInResponse,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
          409: ErrorEnvelope,
          410: ErrorEnvelope,
          422: ErrorEnvelope,
          429: ErrorEnvelope,
          503: ErrorEnvelope,
        },
      },
    },
    // The body carries the console's code and the device's coordinates; the code and the 150 m
    // geofence test belong to `check-in.ts`, which stores neither the coordinates nor the code, and
    // nothing here logs the body (AAP 0.5.7, 0.12.2).
    async (request) =>
      checkIn(
        app.services,
        authContext(request).userId,
        request.params.id,
        request.body,
        request.receivedAt,
      ),
  );
  app.post(
    '/meetups/:id/dispute',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [MEETUPS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        body: DisputeRequest,
        response: {
          201: DisputeResponse,
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
      // The reason text is read from the validated body and passed on; it is never logged, never
      // returned and never attached to a notification (AAP 0.5.4, 0.11.1). Filing writes the
      // dispute, its notification and its event, and schedules the escalation timer (AAP 0.5.3).
      const dispute = await fileDispute(
        app.services,
        authContext(request).userId,
        request.params.id,
        request.body,
        request.receivedAt,
      );
      reply.code(201);
      return dispute;
    },
  );
  return Promise.resolve();
}
