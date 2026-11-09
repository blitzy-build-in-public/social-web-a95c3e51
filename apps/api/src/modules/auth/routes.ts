/**
 * The four `/auth` routes (AAP 0.3.3, 0.5.4, 0.8.1): the contract's magic-link request and verify
 * exchange, and the two additive routes the contract's own responses require — the refresh rotation
 * and logout.
 *
 * The routes differ in what authenticates them, so each group is registered in its own encapsulated
 * sub-plugin rather than on one context: the public group carries no guard at all, because
 * `POST /auth/magic-link`, `POST /auth/verify` and `POST /auth/refresh` are reached before a caller
 * holds a usable session, and the bearer group installs `requireBearer` at group level for
 * `POST /auth/logout`. The bearer group deliberately stops there: `requireTraveler` would apply the
 * 18+ gate, and logout must work for an account that has not recorded its consents yet (AAP 0.5.4).
 * No hook is installed on the context this module is mounted on, so neither group's guard can reach
 * the other's routes and nothing outside this module inherits a gate by accident.
 *
 * Nothing but delegation happens here. The rules themselves belong to the two service modules, and
 * the handler of `POST /auth/magic-link` in particular branches on nothing: it answers `202` with no
 * body for every address it accepts, whatever the service under it decided, which is what an
 * account-enumeration check reads (AAP 0.5.4). No handler logs anything — the service modules log
 * their own events, with no address, token or digest — and no request body, token or address is read
 * by this file beyond the field it passes on.
 *
 * Counters carry the allowances of AAP 0.5.4: the magic-link route the per-address limit of five an
 * hour on top of its per-IP allowance, the two other public routes the per-IP allowance alone
 * (neither request carries a user), and logout the mutating allowances of 60 a minute per user plus
 * the per-IP one. A caller over an allowance is answered `429 rate_limited` with `Retry-After`, and a
 * request that cannot be counted at all is answered `503 service_unavailable` rather than run
 * (AAP 0.3.2).
 *
 * @see AAP 0.5.1 for the auth component, 0.5.4 for the four routes, their schemas, their errors, the
 *   guard scope and each route's rate limits, 0.3.2 for the fail-closed counter store, and 0.8.1 for
 *   this file.
 */

import { z } from 'zod';

import {
  ErrorEnvelope,
  MagicLinkRequest,
  RefreshRequest,
  RefreshResponse,
  VerifyRequest,
  VerifyResponse,
} from '@tablemate/shared';

import { requireBearer } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { ipOnlyLimits, magicLinkLimits, mutatingLimits } from '../../plugins/rate-limit.ts';
import { requestMagicLink, verifyMagicLink } from './magic-link.ts';
import { logout, refresh } from './sessions.ts';

// Type-only, as in every sibling plugin and route module: `App` is the plan's one declaration of the
// instance and of what it hands its modules (AAP 0.5.1), it is erased at compile time, and nothing of
// `app.ts` is read here at runtime.
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { App } from '../../app.ts';

/** The tag all four routes group under: a member of the document's own vocabulary (AAP 0.11.2). */
const AUTH_TAG = 'auth' satisfies OpenApiTag;

/**
 * Registers the four `/auth` routes on the context `app.ts` mounts under `/v1` (AAP 0.5.1, 0.5.4).
 *
 * Registration is synchronous, as in every plugin the composition root installs, so the returned
 * promise is already resolved and a caller may await it or not; the declared `Promise<void>` is what
 * keeps this plugin usable wherever Fastify's own plugin types expect one.
 *
 * @param app - The route instance this module is registered on; its `services` carry the database,
 *   the injected clock, the logger, the outbox dispatcher, the field keyring, the environment and the
 *   publisher the four handlers' service modules read.
 */
export default function authRoutes(app: App): Promise<void> {
  // The public group. A sub-plugin's instance does not inherit the app's Zod type provider through
  // `register`, so it is asked for explicitly; `withTypeProvider` is a no-op at runtime and is what
  // types `request.body` from each route's schema, so a handler reads the parsed body rather than an
  // `unknown` it would have to re-check (AAP 0.3.1, 0.11.1).
  app.register((instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();

    scope.post(
      '/auth/magic-link',
      {
        // Per IP on the request, per address in `preHandler`, after the body has been validated.
        ...magicLinkLimits(scope),
        config: { validationErrorCode: 'invalid_email' },
        schema: {
          tags: [AUTH_TAG],
          // No `security`: the route is public, and the document marks a public route by leaving the
          // requirement out (AAP 0.5.4).
          body: MagicLinkRequest,
          // `z.void()` rather than the `z.null()` the 204s declare: an empty answer needs `send()`
          // with no payload, which Fastify's reply type allows only when the status's schema resolves
          // to `void`, and it is the body — not the status — that carries no information here.
          response: {
            202: z.void(),
            400: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      async (request, reply) => {
        // The link is requested for every address that reaches here, and the answer is the same 202
        // with no body whether or not an account holds it: the service writes a `MagicLinkToken` row
        // and the outbox mails it, or, for an account that has requested deletion, drops the write
        // under the write fence — and this handler reads neither outcome (AAP 0.5.3, 0.5.4).
        await requestMagicLink(app.services, request.body.email);

        // No argument, so the reply carries no body and no content type, which is what an account
        // enumeration check reads.
        reply.code(202).send();
      },
    );

    scope.post(
      '/auth/verify',
      {
        ...ipOnlyLimits(scope),
        schema: {
          tags: [AUTH_TAG],
          body: VerifyRequest,
          response: {
            200: VerifyResponse,
            400: ErrorEnvelope,
            401: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      async (request) => verifyMagicLink(app.services, request.body.token),
    );

    scope.post(
      '/auth/refresh',
      {
        ...ipOnlyLimits(scope),
        schema: {
          tags: [AUTH_TAG],
          body: RefreshRequest,
          response: {
            200: RefreshResponse,
            400: ErrorEnvelope,
            401: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      async (request) => refresh(app.services, request.body.refreshToken),
    );
  });

  // The bearer group: `POST /auth/logout`, and only it. The guard is installed here, at route-group
  // level and never globally, so it covers this one route; the age gate stays off, so an account that
  // has not recorded its consents can still end its session (AAP 0.5.4).
  app.register((instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();

    scope.addHook('onRequest', requireBearer);

    scope.post(
      '/auth/logout',
      {
        ...mutatingLimits(scope),
        schema: {
          tags: [AUTH_TAG],
          security: OPENAPI_SECURITY.bearer,
          // No `body`: the session ended is the one the access token names in its `sid`, so the route
          // takes no payload and a client sends none (AAP 0.5.4).
          response: {
            204: z.null(),
            401: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      async (request, reply) => {
        // Read the context rather than asserting it. The hook above admitted this request, so it is
        // set — but that is a property of the registration, not of this handler, and a hook that were
        // moved, removed or shadowed would otherwise leave a `TypeError` answered as
        // `500 internal_error` where the contract requires `401 token_invalid`.
        if (request.auth === null) {
          throw new AppError('token_invalid');
        }

        // Only the caller's own session, named by the signed token and re-checked against the row's
        // owner, so no request can end another account's session.
        await logout(app.services, {
          userId: request.auth.userId,
          sessionId: request.auth.sessionId,
        });

        reply.code(204).send(null);
      },
    );
  });

  return Promise.resolve();
}
