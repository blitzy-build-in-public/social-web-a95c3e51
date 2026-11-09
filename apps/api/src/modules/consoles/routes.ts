/**
 * The two console routes (AAP 0.5.1, 0.5.4, 0.5.7): a partner venue's current check-in code and one lodging's
 * leaderboard standings.
 *
 * Both authenticate by secret alone — `X-Venue-Secret` and `X-Lodging-Secret`, each 32 random bytes issued once and
 * matched on a SHA-256 lookup hash (AAP 0.3.2, 0.5.2) — so guessing one is infeasible and neither route carries a
 * bearer guard, an age gate or a counter (AAP 0.5.4). A missing, unknown or duplicated header is refused exactly as
 * a wrong one is: `401 bad_venue_secret` or `401 bad_lodging_secret`. Neither route declares a `headers` schema,
 * because a schema failure answers `400 invalid_field` while this contract fixes `401` for every unusable secret;
 * the OpenAPI security scheme is what documents the header instead.
 *
 * The check-in code comes from the server clock and from nowhere else (AAP 0.5.7): the console derives no code of
 * its own, and device clock skew therefore moves a countdown and never a validation. `Date` is set from that same
 * instant, because Node otherwise stamps the response from the system clock while the code comes from the injected
 * one — the two coincide in production but not under the flowing test clock of `APP_ENV=test`, and the console
 * measures its countdown from the offset between this header and the device clock (CORS exposes `Date` for exactly
 * that).
 *
 * The context is encapsulated and hook-free on purpose: a guard or header rule registered here would apply to these
 * two routes and to nothing else, which is the whole of what this module owns.
 */

import {
  ErrorEnvelope,
  LODGING_SECRET_HEADER,
  LodgingConsoleStats,
  VENUE_SECRET_HEADER,
  VenueCodeResponse,
} from '@tablemate/shared';

import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { lodgingStats } from '../lodgings/leaderboard.ts';

import { findLodgingBySecret, findVenueBySecret } from './secrets.ts';
import { codeFor } from './totp.ts';

// Type-only, so this file holds no run-time edge back to the module that registers it: `App` is the
// plan's one declaration of the instance, and the sibling plugins import it the same way.
import type { App } from '../../app.ts';

/** The tag both routes group under: a member of the document's own vocabulary, never a new string. */
const CONSOLES_TAG = 'consoles' satisfies OpenApiTag;

/**
 * Registers the two console routes of AAP 0.5.4 — the venue code and the lodging standings — on the context
 * `app.ts` mounts under `/v1` (AAP 0.5.1).
 *
 * Registration is synchronous, as in every other plugin the composition root installs, so the returned promise is
 * already resolved and a caller may await it or not; the declared `Promise<void>` is what keeps this plugin usable
 * wherever Fastify's own plugin types expect one.
 */
export default function consolesRoutes(app: App): Promise<void> {
  app.get(
    '/venue/check-in-code',
    {
      schema: {
        tags: [CONSOLES_TAG],
        security: OPENAPI_SECURITY.venueSecret,
        response: { 200: VenueCodeResponse, 401: ErrorEnvelope },
      },
    },
    async (request, reply) => {
      const found = await findVenueBySecret(
        app.services,
        request.headers[VENUE_SECRET_HEADER.toLowerCase()],
      );
      if (found === null) {
        throw new AppError('bad_venue_secret');
      }
      const now = app.services.clock.now();
      const { code, expiresAt } = codeFor(found.secret, now);
      // A code is current for 60 seconds and stands for one venue, so no intermediary caches it.
      reply.header('Cache-Control', 'no-store');
      reply.header('Date', now.toUTCString());
      return { code, expiresAt: expiresAt.toISOString() };
    },
  );
  app.get(
    '/lodging-console/stats',
    {
      schema: {
        tags: [CONSOLES_TAG],
        security: OPENAPI_SECURITY.lodgingSecret,
        response: { 200: LodgingConsoleStats, 401: ErrorEnvelope },
      },
    },
    async (request, reply) => {
      const found = await findLodgingBySecret(
        app.services,
        request.headers[LODGING_SECRET_HEADER.toLowerCase()],
      );
      if (found === null) {
        throw new AppError('bad_lodging_secret');
      }
      reply.header('Cache-Control', 'no-store');
      // `lodgingStats` renders a guest count below three as "fewer than 3" itself, so the body is
      // returned as it stands: nothing above the lodging's own standings is added here (AAP 0.5.4).
      return lodgingStats(app.services, found.lodging.id);
    },
  );
  return Promise.resolve();
}
