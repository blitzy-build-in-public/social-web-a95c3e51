/**
 * Client analytics: the additive route `POST /v1/events` (AAP 0.5.1, 0.5.4, 0.5.7).
 *
 * This is the client's only analytics write, and the only event a client may report about itself:
 * opening a suggested place, which the operator dashboard counts as "places opened" (AAP 0.5.7).
 * Every other `AnalyticsEventName` is a server-side fact a client may not forge, so the body is
 * validated against the shared `ClientEventRequest`, whose name is the one-member
 * `CLIENT_EVENT_NAMES` enum: an unlisted name and an unknown key both answer `400 invalid_field`
 * before the handler runs (AAP 0.5.4).
 *
 * Everything else about the stored row comes from the session and the server. The actor reaches the
 * table as the HMAC of its id under `ANALYTICS_SALT` and never in the clear (AAP 0.5.2); the meetup
 * and its venue's city are read from the meetup the caller is a participant of rather than taken
 * from the body; the variant columns stay empty, because a client event carries no meetup pairing;
 * and the instant comes from the injected clock inside the transaction (AAP 0.11.1). The body
 * therefore carries no actor, city, variant or timestamp that could be spoofed.
 *
 * Two refusals are deliberately indistinguishable: an unknown meetup id and a meetup the caller is
 * not part of both answer `400 invalid_field`, so the route is no oracle for which meetup ids exist.
 * The meetup is read through this handler's own transaction, never through `meetups/queries.ts`:
 * `meetups` depends on `analytics`, and importing it back would close a cycle.
 *
 * The route is a traveler feature route, so it carries the age gate and the write fence like every
 * other mutating route: `requireTraveler` runs as a route-group `onRequest` hook (401
 * `token_invalid`, 403 `age_gate_required`), the mutating allowances count the request per IP and
 * per user (AAP 0.5.4), and `transact(..., { fenceUserId })` takes the account-deletion write fence
 * before any read, so an account that requested deletion is refused with 401 `token_invalid`
 * instead of recording an event (AAP 0.3.2, 0.5.3).
 *
 * The body is never logged, and a success answers `204` with no body at all (AAP 0.11.1).
 *
 * @see AAP 0.5.4 for the route, its body, its errors and the guard scope, 0.5.7 for the metric it
 *   feeds, 0.5.2 for the pseudonymity and retention of the row, 0.5.1 for the analytics component,
 *   and 0.8.1 for this file.
 */

import { z } from 'zod';

import { ClientEventRequest, ErrorEnvelope, type AnalyticsProps } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { requireTraveler } from '../../plugins/auth.ts';
import { mutatingLimits } from '../../plugins/rate-limit.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { transact } from '../outbox/write.ts';
import { emit } from './emit.ts';

// Type-only: `app.ts` is the plan's one declaration of the app's type, it is erased at compile time,
// and nothing of that module is read here at runtime.
import type { App } from '../../app.ts';

/** The tag the route groups under: a member of the document's own vocabulary, never a new string. */
const ANALYTICS_TAG = 'analytics' satisfies OpenApiTag;

/**
 * Registers the client-analytics route (AAP 0.5.1, 0.5.4).
 *
 * Encapsulated rather than wrapped in `fastify-plugin`, so the guard, the route and its schema stay
 * in their own context: `app.ts` registers this plugin with the `/v1` prefix, which is what makes
 * the route `POST /v1/events`. The guard is added here, at route-group level, and never globally —
 * the age gate covers the traveler feature routes alone (AAP 0.5.4).
 *
 * Registration is synchronous, as in every plugin the composition root installs, and it awaits
 * nothing: the hook and the route are queued on the context, and every value the handler needs is
 * resolved per request. The declared `Promise<void>` is what keeps this plugin usable wherever
 * Fastify's own plugin types expect one.
 *
 * @param app - The instance this plugin is registered on; its `services` carry the database client,
 *   the injected clock, the logger and the outbox dispatcher `transact` and `emit` need.
 * @see AAP 0.5.7 for "places opened", the one metric this route supplies.
 */
export default function analyticsRoutes(app: App): Promise<void> {
  app.addHook('onRequest', requireTraveler);

  app.post(
    '/events',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [ANALYTICS_TAG],
        security: OPENAPI_SECURITY.bearer,
        body: ClientEventRequest,
        // `204` carries no body: Fastify runs no serializer for that status, and the reply below
        // hands it the `null` the schema declares, so the route needs no response payload type.
        // The `400` is the one error this route answers itself, so the document publishes it.
        response: { 204: z.null(), 400: ErrorEnvelope },
      },
    },
    async (request, reply) => {
      // Read the context rather than asserting it. The guard above admitted this request, so it is
      // set — but that is a property of the registration two lines up, not of this handler: a hook
      // that were moved, removed or shadowed would otherwise leave a `TypeError` to be answered as
      // `500 internal_error` where the contract requires `401 token_invalid`, and no compiler check
      // would catch it.
      if (request.auth === null) {
        throw new AppError('token_invalid');
      }
      const userId = request.auth.userId;
      const body = request.body;

      await transact(
        app.services,
        async (tx) => {
          const meetup = await tx.meetup.findUnique({
            where: { id: body.meetupId },
            select: {
              initiatorId: true,
              recipientId: true,
              venue: { select: { cityId: true } },
            },
          });

          if (meetup === null || (meetup.initiatorId !== userId && meetup.recipientId !== userId)) {
            throw new AppError('invalid_field');
          }

          // The place is a business, not a person, so its id and category are the only body values
          // that reach the row; the city comes from the venue the meetup is held at (AAP 0.5.2).
          const props: AnalyticsProps = {
            placeId: body.placeId,
            ...(body.placeCategory === undefined ? {} : { placeCategory: body.placeCategory }),
          };

          await emit(tx, app.services, body.name, userId, {
            meetupId: body.meetupId,
            cityId: meetup.venue.cityId,
            props,
          });
        },
        { fenceUserId: userId },
      );

      reply.code(204).send(null);
    },
  );

  return Promise.resolve();
}
