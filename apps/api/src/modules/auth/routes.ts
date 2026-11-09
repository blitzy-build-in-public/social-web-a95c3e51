/**
 * The four `/auth` routes (AAP 0.3.3, 0.5.4): the magic-link request and verify exchange, plus the
 * refresh rotation and logout the contract's own responses require.
 *
 * The routes differ in what authenticates them, so each group is registered in its own encapsulated
 * sub-plugin: the public group carries no guard, and the bearer group installs `requireBearer` at
 * group level and deliberately stops there, because `requireTraveler` would apply the 18+ gate and
 * logout must work for an account that has not recorded its consents yet (AAP 0.5.4). No hook sits
 * on the context this module is mounted on, so neither group's guard can reach the other's routes.
 *
 * The handler of `POST /auth/magic-link` branches on nothing: it answers `202` with no body for every
 * address it accepts, whatever the service under it decided, which is what an account-enumeration
 * check reads (AAP 0.5.4).
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

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { App } from '../../app.ts';

/** The tag all four routes group under: a member of the document's own vocabulary (AAP 0.11.2). */
const AUTH_TAG = 'auth' satisfies OpenApiTag;

/**
 * Registers the four `/auth` routes on the context `app.ts` mounts under `/v1`. Registration is
 * synchronous; the declared `Promise<void>` is what Fastify's plugin types expect (AAP 0.5.1, 0.5.4).
 */
export default function authRoutes(app: App): Promise<void> {
  // A sub-plugin's instance does not inherit the app's Zod type provider through `register`, so it is
  // asked for explicitly; `withTypeProvider` is a no-op at runtime (AAP 0.3.1, 0.11.1).
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
          // No `security`: the document marks a public route by leaving the requirement out (AAP 0.5.4).
          body: MagicLinkRequest,
          // `z.void()` rather than the `z.null()` the 204s declare: Fastify's reply type allows `send()`
          // with no payload only when the status's schema resolves to `void`.
          response: {
            202: z.void(),
            400: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      async (request, reply) => {
        // The same 202 with no body whether or not an account holds the address; this handler reads
        // neither outcome, the write fence dropping the write for a deleted account (AAP 0.5.3, 0.5.4).
        await requestMagicLink(app.services, request.body.email);
        // No argument, so the reply carries no body and no content type — what an enumeration check reads.
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
  // The bearer group: `POST /auth/logout`, and only it. The guard is installed at route-group level,
  // never globally, and the age gate stays off (AAP 0.5.4).
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
          // No `body`: the session ended is the one the access token names in its `sid` (AAP 0.5.4).
          response: {
            204: z.null(),
            401: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      async (request, reply) => {
        // Read the context rather than asserting it: the hook above admitted this request, but that is a
        // property of the registration, and a hook moved, removed or shadowed would otherwise answer a
        // `TypeError` as `500 internal_error` where the contract requires `401 token_invalid`.
        if (request.auth === null) {
          throw new AppError('token_invalid');
        }
        // Only the caller's own session, named by the signed token and re-checked against the row's owner.
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
