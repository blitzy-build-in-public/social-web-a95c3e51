/**
 * The six Me routes: the caller's own profile, their age gate and terms, their push token, their saved card and their account
 * deletion.
 *
 * The bearer group carries {@link requireBearer} with the 18+ gate deliberately left off, because `GET /me`, `POST /me/consents`
 * and `DELETE /me` are the three routes a new account needs *before* the gate can open; the traveler group carries
 * {@link requireTraveler}, so `PUT /me/profile`, `POST /me/push-tokens` and `POST /me/payment-setup` answer `403 age_gate_required`
 * until it is passed. Both are encapsulated children of this context, so no route outside them inherits a guard by accident.
 *
 * Each handler delegates to the module function that owns its rule and answers what that returned; the counters are
 * `mutatingLimits(app)` on the five mutating routes and none on `GET /me`. The instant a handler judges at is `request.receivedAt`.
 */
import { z } from 'zod';

import { isUniqueViolation } from '@tablemate/db';
import {
  ConsentsRequest,
  ErrorEnvelope,
  MeDto,
  PROFILE_BODY_LIMIT_BYTES,
  PaymentSetupResponse,
  ProfileUpdate,
  PushTokenRequest,
} from '@tablemate/shared';

import { requireBearer, requireTraveler, type AuthContext } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { mutatingLimits } from '../../plugins/rate-limit.ts';
import { transact } from '../outbox/write.ts';
import { recordConsents } from './consents.ts';
import { requestDeletion } from './deletion.ts';
import { createPaymentSetup } from './payment-setup.ts';
import { buildMeDto, updateProfile } from './profile.ts';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { App } from '../../app.ts';

const ME_TAG = 'me' satisfies OpenApiTag;

/**
 * The one refusal `POST /me/push-tokens` answers when the token belongs to another account: the message names neither the token nor
 * an account, so nothing about the device or its owner leaves the server.
 */
const TOKEN_OWNED_MESSAGE = 'This push token is already registered to another account.';

/**
 * The authenticated caller's context, or a refusal: the group guard admitted this request, but that is a property of the registration
 * rather than of the handler, and a hook moved, removed or shadowed would otherwise answer a `TypeError` as `500 internal_error`
 * where the contract requires `401 token_invalid`.
 */
function callerAuth(request: FastifyRequest): AuthContext {
  if (request.auth === null) {
    throw new AppError('token_invalid');
  }
  return request.auth;
}

/**
 * Registers the six Me routes on the context `app.ts` mounts under `/v1`.
 *
 * Registration is synchronous, so the returned promise is already resolved; the declared `Promise<void>` and `return
 * Promise.resolve()` are what keep this plugin usable wherever Fastify's plugin types expect one.
 */
export default function meRoutes(app: App): Promise<void> {
  // The bearer group: `GET /me`, `POST /me/consents` and `DELETE /me`, and only those three. A
  // sub-plugin's instance does not inherit the app's Zod type provider through `register`, so it is asked
  // for explicitly; `withTypeProvider` is a no-op at runtime and is what types `request.body` from each
  // route's schema (AAP 0.3.1, 0.11.1).
  app.register((instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.addHook('onRequest', requireBearer);
    scope.get(
      '/me',
      {
        // No counter: `GET /me` is a plain read, and the limits cover the mutating routes alone.
        schema: {
          tags: [ME_TAG],
          security: OPENAPI_SECURITY.bearer,
          // `401` is the one refusal this route answers: the guard's, and `buildMeDto`'s for a gone account.
          response: { 200: MeDto, 401: ErrorEnvelope },
        },
      },
      // `request.receivedAt` rather than a second clock read, so the proof state, the no-show window and
      // the active claim's stay are all judged at one instant for this request (AAP 0.11.1).
      async (request) =>
        buildMeDto(app.services, callerAuth(request).userId, { now: request.receivedAt }),
    );
    scope.post(
      '/me/consents',
      {
        ...mutatingLimits(app),
        schema: {
          tags: [ME_TAG],
          security: OPENAPI_SECURITY.bearer,
          body: ConsentsRequest,
          // `400` for a stale `termsVersion` or a refused body (`consents.ts`), `401` once the account has
          // requested deletion — the fence refuses before any write — and `429`/`503` from the counters.
          response: {
            200: MeDto,
            400: ErrorEnvelope,
            401: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      async (request) => {
        const auth = callerAuth(request);
        // The confirmation and the accepted version commit in one fenced transaction, and the live
        // sessions' cache entries are dropped after it, so the next request is admitted at once (AAP 0.3.2).
        await recordConsents(app.services, auth, request.body);
        return buildMeDto(app.services, auth.userId, { now: request.receivedAt });
      },
    );
    scope.delete(
      '/me',
      {
        ...mutatingLimits(app),
        schema: {
          tags: [ME_TAG],
          security: OPENAPI_SECURITY.bearer,
          // `202` with no body, the empty-answer form `POST /auth/magic-link` uses: `z.void()` rather than
          // the `z.null()` the 204s declare, because the reply is sent with no payload at all (AAP 0.5.4).
          response: { 202: z.void(), 401: ErrorEnvelope, 429: ErrorEnvelope, 503: ErrorEnvelope },
        },
      },
      async (request, reply) => {
        // The disposition and its order belong to `deletion.ts` (AAP 0.5.3), and it has no refusal of its
        // own, which is why this route publishes no error code (AAP 0.5.4).
        await requestDeletion(app.services, callerAuth(request).userId);
        reply.code(202).send();
      },
    );
  });
  // The traveler group: `PUT /me/profile`, `POST /me/push-tokens` and `POST /me/payment-setup`, where the
  // guard adds the age gate to the token and answers `403 age_gate_required` (AAP 0.5.4).
  app.register((instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();
    scope.addHook('onRequest', requireTraveler);
    scope.put(
      '/me/profile',
      {
        ...mutatingLimits(app),
        // The base64 photo makes the JSON body up to a third larger than the bytes it carries, so the
        // route's own limit is 8 MB, room for the 5 MB image `processPhoto` answers `413` above.
        bodyLimit: PROFILE_BODY_LIMIT_BYTES,
        config: { bodyTooLargeCode: 'photo_too_large' },
        schema: {
          tags: [ME_TAG],
          security: OPENAPI_SECURITY.bearer,
          body: ProfileUpdate,
          response: {
            200: MeDto,
            400: ErrorEnvelope,
            401: ErrorEnvelope,
            403: ErrorEnvelope,
            413: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      // The edit runs in one fenced transaction and the profile is read back after the commit (AAP 0.5.2).
      async (request) => updateProfile(app.services, callerAuth(request).userId, request.body),
    );
    scope.post(
      '/me/push-tokens',
      {
        ...mutatingLimits(app),
        schema: {
          tags: [ME_TAG],
          security: OPENAPI_SECURITY.bearer,
          body: PushTokenRequest,
          // `204` carries no body: Fastify runs no serializer for that status, and the reply hands it `null`.
          response: {
            204: z.null(),
            400: ErrorEnvelope,
            401: ErrorEnvelope,
            403: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      async (request, reply) => {
        const userId = callerAuth(request).userId;
        const { token, platform } = request.body;
        // One device, one account, and that account never changes: `token` is the table's unique key, so a
        // token another account already holds is refused rather than moved, while a re-registration by that
        // same account refreshes its platform. The owner is read inside the transaction that writes and the
        // handler runs behind the write fence, so an account that requested deletion registers nothing.
        await transact(
          app.services,
          async (tx) => {
            const owner = await tx.pushToken.findUnique({
              where: { token },
              select: { userId: true },
            });
            if (owner === null) {
              try {
                await tx.pushToken.create({ data: { token, platform, userId } });
              } catch (error) {
                // Two accounts can pass the read above together and only the insert that commits first owns
                // the token: the other meets the unique key, which is this route's own refusal (AAP 0.5.4).
                if (isUniqueViolation(error, 'token')) {
                  throw new AppError('invalid_field', TOKEN_OWNED_MESSAGE);
                }
                throw error;
              }
              return;
            }
            if (owner.userId !== userId) {
              throw new AppError('invalid_field', TOKEN_OWNED_MESSAGE);
            }
            // Refresh only: the update writes no `userId`, so the account that registered the token keeps it.
            await tx.pushToken.update({ where: { token }, data: { platform } });
          },
          { fenceUserId: userId },
        );
        // Nothing about the token is logged: it names a device that can be sent to (AAP 0.11.1).
        reply.code(204).send(null);
      },
    );
    scope.post(
      '/me/payment-setup',
      {
        ...mutatingLimits(app),
        schema: {
          tags: [ME_TAG],
          security: OPENAPI_SECURITY.bearer,
          // `401` for an account that is gone or has requested deletion, and `503 payment_unavailable` when
          // the provider could not start the setup; no card field exists in this contract (AAP 0.5.4).
          response: {
            200: PaymentSetupResponse,
            401: ErrorEnvelope,
            403: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      // The customer, the SetupIntent's client secret and the ephemeral key are `payment-setup.ts`'s to
      // create, reuse and store; nothing here could repair a response that named another customer.
      async (request) => createPaymentSetup(app.services, callerAuth(request).userId),
    );
  });
  return Promise.resolve();
}
