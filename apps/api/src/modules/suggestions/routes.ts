/**
 * `GET /v1/meetups/:id/suggestions` — the pair's day plan near the meetup's venue.
 *
 * One of the reads that write: a supplied `perPersonBudgetCents` is stored as the pair's shared budget, where the latest
 * write by either attendee wins, and the first read stamps `suggestionsFirstViewedAt`, which feeds the dashboard's metric. Both writes
 * run in one `transact` behind the account-deletion write fence, so nothing commits once `DELETE /me` has been called, and neither
 * runs when there is nothing to write.
 *
 * `409 meetup_not_locked` is read the way the contract's two statements settle it: a `locked` meetup is served, and so is a
 * `completed` one whose settlement is at most `SUGGESTIONS_SETTLED_ELIGIBLE_HOURS` (24 h) old. Every other status carries no plan.
 *
 * Failure isolation: the read behind this route touches stored prices alone, so any failure in it is answered `503
 * suggestions_unavailable` on this route alone.
 */

import {
  ErrorEnvelope,
  HOUR_MS,
  IdParams,
  SUGGESTIONS_SETTLED_ELIGIBLE_HOURS,
  SuggestionsQuery,
  SuggestionsResponse,
  type MeetupStatus,
  type Suggestion,
} from '@tablemate/shared';

import { requireTraveler } from '../../plugins/auth.ts';
import { AppError, isAppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { guardRouteGroup, mutatingLimits } from '../../plugins/rate-limit.ts';
import { loadForParticipant } from '../meetups/queries.ts';
import { transact } from '../outbox/write.ts';
import { assertBudgetInRange, effectiveBudget } from './budget.ts';
import { suggest, type SuggestResult } from './candidates.ts';

import type { App } from '../../app.ts';
import type { FastifyRequest } from 'fastify';

const SUGGESTIONS_TAG = 'suggestions' satisfies OpenApiTag;

/**
 * The authenticated caller's id, or a refusal: the guard below admitted this request, but that is a property of the registration
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
 * Whether this meetup's suggestions may be served. Pure and exported for tests.
 *
 * A `locked` meetup is always eligible, because planning the day is what a locked commitment is for. A `completed` meetup is eligible
 * only until `SUGGESTIONS_SETTLED_ELIGIBLE_HOURS` (24 h, both ends inclusive) have passed since `settledAt`. Everything else is
 * refused with `409 meetup_not_locked`.
 */
export function suggestionsEligible(
  status: MeetupStatus,
  settledAt: Date | null,
  now: Date,
): boolean {
  if (status === 'locked') {
    return true;
  }
  if (status !== 'completed' || settledAt === null) {
    return false;
  }
  return now.getTime() - settledAt.getTime() <= SUGGESTIONS_SETTLED_ELIGIBLE_HOURS * HOUR_MS;
}

/**
 * Registers `GET /meetups/:id/suggestions` on the context `app.ts` mounts under `/v1`.
 *
 * Registration is synchronous, as in every other plugin the composition root installs, so the returned promise is already resolved;
 * the declared `Promise<void>` is what keeps this plugin usable wherever Fastify's own plugin types expect one. The guard is installed
 * on this plugin's context, never globally, so no other route can inherit the age gate by accident.
 */
export default function suggestionsRoutes(app: App): Promise<void> {
  guardRouteGroup(app, requireTraveler);
  app.get(
    '/meetups/:id/suggestions',
    {
      // Every state-writing read counts as a mutating route (AAP 0.5.4): they carry the per-user and
      // per-IP counters, so the counter cannot be dropped from the one read that writes.
      ...mutatingLimits(app),
      config: { stateWritingRead: true },
      schema: {
        tags: [SUGGESTIONS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        querystring: SuggestionsQuery,
        response: {
          200: SuggestionsResponse,
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
    async (request) => {
      const userId = callerId(request);
      const now = request.receivedAt;
      const { id } = request.params;
      // The caller's own meetup, or `404 meetup_not_found` / `403 not_participant`; a proposal the
      // recipient cannot see yet reads as one that does not exist (AAP 0.5.3, 0.5.4).
      const { meetup } = await loadForParticipant(app.services.db, id, userId);
      // Checked before anything is written, in the order the contract lists the route's errors.
      if (!suggestionsEligible(meetup.status, meetup.settledAt, now)) {
        throw new AppError('meetup_not_locked');
      }
      // `SuggestionsQuery` accepts any integer, so the accepted range is enforced here, after the
      // `409` and before the state write (AAP 0.5.4).
      const supplied = request.query.perPersonBudgetCents;
      if (supplied !== undefined) {
        assertBudgetInRange(supplied);
      }
      // One transaction for whichever of the two writes is due, and none at all when neither is: a
      // repeat read that already stamped the first view skips the fence and the round trip. No meetup
      // row lock is taken and no analytics event is written, because this is not a status transition
      // (AAP 0.5.3 lists the lock takers).
      if (supplied !== undefined || meetup.suggestionsFirstViewedAt === null) {
        await transact(
          app.services,
          async (tx) => {
            if (supplied !== undefined) {
              // The pair shares one budget, so this write replaces whatever either attendee stored.
              await tx.meetup.update({
                where: { id: meetup.id },
                data: { budgetCents: supplied, budgetUpdatedBy: userId },
              });
            }
            // Stamped once, by whichever read arrives first, and never moved afterwards.
            await tx.meetup.updateMany({
              where: { id: meetup.id, suggestionsFirstViewedAt: null },
              data: { suggestionsFirstViewedAt: now },
            });
          },
          { fenceUserId: userId },
        );
      }
      // The value supplied now, or the one either attendee stored, or the default the deposit level
      // selects. The deposit itself is never spent (AAP 0.5.7, 0.7.3).
      const budgetCents =
        supplied ??
        effectiveBudget({ budgetCents: meetup.budgetCents, depositCents: meetup.depositCents });
      let result: SuggestResult;
      try {
        // One read, outside the transaction, over places and their stored prices alone.
        result = await suggest(
          app.services,
          { venueId: meetup.venueId, startsAt: meetup.startsAt },
          budgetCents,
          now,
        );
      } catch (err) {
        if (isAppError(err) && err.code === 'suggestions_unavailable') {
          throw err;
        }
        // Any other failure of the read — a statement row that does not match its shape, a venue in a city the configuration does not
        // name, an unreadable hours value, the database itself — stays on this route. It travels as the thrown error's `cause`, which
        // the errors plugin walks for the log alone, so the failure is recorded once, by that plugin's 503 line.
        throw new AppError('suggestions_unavailable', undefined, { cause: err });
      }
      // Field by field, never a spread: the response carries places, their estimate and the
      // provenance of the prices it was built from, and no user data at all (AAP 0.5.4, 0.5.7). Both
      // instants are UTC `Z` forms, which the shared `IsoDateTime` requires.
      const items: Suggestion[] = result.items.map((place): Suggestion => ({
        placeId: place.placeId,
        name: place.name,
        category: place.category,
        isPartnerVenue: place.isPartnerVenue,
        estimatedCostRange: {
          estimateCents: place.estimate.estimateCents,
          lowCents: place.estimate.lowCents,
          highCents: place.estimate.highCents,
        },
        priceSource: place.estimate.priceSource,
        priceVerifiedAt: place.estimate.priceVerifiedAt.toISOString(),
        distanceM: place.distanceM,
        openingHoursToday: place.openingHoursToday,
        itemsUsed: place.estimate.itemsUsed.map((item) => ({
          name: item.itemName,
          itemCategory: item.itemCategory,
          priceUsdCents: item.priceUsdCents,
          source: item.source,
          capturedAt: item.capturedAt.toISOString(),
          sourceUrl: item.sourceUrl,
        })),
      }));
      // `emptyReason` is added only when the read produced one: the contract's key is optional and the
      // compiler option `exactOptionalPropertyTypes` is on.
      return result.emptyReason === undefined
        ? { items, budgetCents }
        : { items, budgetCents, emptyReason: result.emptyReason };
    },
  );
  return Promise.resolve();
}
