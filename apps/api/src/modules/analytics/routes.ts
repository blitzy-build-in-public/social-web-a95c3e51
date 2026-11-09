/**
 * Client analytics: the additive route `POST /v1/events`.
 *
 * This is the client's only analytics write, and the only event a client may report about itself: opening a suggested
 * place. Every other `AnalyticsEventName` is a server-side fact a client may not forge, so the body is validated
 * against the shared `ClientEventRequest`, whose name is the one-member `CLIENT_EVENT_NAMES` enum: an unlisted name and
 * an unknown key both answer `400 invalid_field` before the handler runs.
 *
 * Everything else about the stored row comes from the session and the server: the actor is the HMAC of its id under
 * `ANALYTICS_SALT` and never the clear id; the meetup and its venue's city are read from the meetup the caller is a
 * participant of rather than taken from the body; the variant columns stay empty, because a client event carries no
 * meetup pairing; and the instant comes from the injected clock inside the transaction.
 *
 * Two refusals are deliberately indistinguishable: an unknown meetup id and a meetup the caller is not part of both
 * answer `400 invalid_field`, so the route is no oracle for which meetup ids exist. The meetup is read through this
 * handler's own transaction, never through `meetups/queries.ts`, because `meetups` depends on `analytics` and
 * importing it back would close a cycle. A success answers `204` with no body, and the body is never logged.
 */
import { z } from 'zod';

import { ClientEventRequest, ErrorEnvelope, type AnalyticsProps } from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { requireTraveler } from '../../plugins/auth.ts';
import { mutatingLimits } from '../../plugins/rate-limit.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { transact } from '../outbox/write.ts';
import { emit } from './emit.ts';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { App } from '../../app.ts';

/** The tag the route groups under. */
const ANALYTICS_TAG = 'analytics' satisfies OpenApiTag;

/**
 * Registers the client-analytics route.
 *
 * Encapsulated rather than wrapped in `fastify-plugin`, so the guard, the route and its schema stay in their own
 * context: `app.ts` registers this plugin with the `/v1` prefix, which is what makes the route `POST /v1/events`. The
 * guard is added here, at route-group level, and never globally — the age gate covers the traveler feature routes
 * alone. Registration is synchronous, as in every plugin the composition root installs, and the declared
 * `Promise<void>` is what keeps this plugin usable wherever Fastify's own plugin types expect one.
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
        // `204` carries no body, and the reply below hands it the `null` the schema declares. The `400` is
        // the one error this route answers itself, so the document publishes it.
        response: { 204: z.null(), 400: ErrorEnvelope },
      },
    },
    async (request, reply) => {
      // Read the context rather than asserting it: the guard above admitted this request as a property of
      // the registration, and a hook moved or shadowed would leave a `TypeError` answered as `500` where
      // the contract requires `401 token_invalid`.
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
          // The place is a business, so its id and category are the only body values that reach the row.
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
