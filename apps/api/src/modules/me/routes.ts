/**
 * The six Me routes of AAP 0.5.4 — the caller's own profile, their age gate and terms, their push
 * token, their saved card and their account deletion (AAP 0.5.1, 0.5.2, 0.5.3, 0.5.4, 0.8.1).
 *
 * Two route groups are registered as encapsulated children of the context `app.ts` mounts under
 * `/v1`, because their guards differ and a hook added to an instance covers that instance's routes
 * *and its children's* (AAP 0.5.4):
 *
 *  - **The bearer group** carries {@link requireBearer}: the access token alone, with the 18+ gate
 *    deliberately left off. `GET /me`, `POST /me/consents` and `DELETE /me` are the three bearer
 *    routes a new account needs *before* the gate can open — the client reads `MeDto.consents` to
 *    decide whether to show the age gate at all (`apps/mobile/app/(auth)/age-gate.tsx`), records the
 *    consents through the second, and must be able to delete its account whatever the gate's state —
 *    so AAP 0.5.4 lists exactly these three as outside the guard's scope.
 *  - **The traveler group** carries {@link requireTraveler}: the token plus a recorded 18+
 *    confirmation and terms version, so `PUT /me/profile`, `POST /me/push-tokens` and
 *    `POST /me/payment-setup` answer `403 age_gate_required` until the gate has been passed. The
 *    guard is installed at route-group level and never globally, so no route outside these two groups
 *    can inherit it by accident.
 *
 * Nothing but delegation happens here. Each handler calls the module function that owns its rule —
 * `profile.ts` (`buildMeDto`, `updateProfile`), `consents.ts`, `payment-setup.ts`, `deletion.ts` — and
 * answers what that function returned, so no validation, transaction, refusal, ledger read or DTO
 * assembly is repeated in this file. Validation is the shared schema each route declares: an unknown
 * key, a tag outside the interest vocabulary, more than three tags, a duplicate tag, a length over
 * its limit and a stale `termsVersion` are all the contract's `400 invalid_field`, and a body past
 * the profile route's 8 MB limit is its `413 photo_too_large`. Both codes are the defaults
 * `plugins/errors.ts` applies unless a route names its own, which is why `PUT /me/profile` sets only
 * `bodyTooLargeCode` and no route here sets `validationErrorCode`.
 *
 * The counters follow AAP 0.5.4: the five mutating routes spread `mutatingLimits(app)` — 60 a minute
 * per user, `RATE_LIMIT_IP_PER_MIN` per address, `429 rate_limited` with `Retry-After` past either,
 * and `503 service_unavailable` rather than an uncounted request when the limiter's Redis store is
 * unreachable (AAP 0.3.2) — while `GET /me` is a plain read and carries no counter at all.
 *
 * No handler logs. The account's address, nickname, bio, full name, external contact, push token and
 * photo bytes all pass through this file and reach no log line: `consents.ts`, `profile.ts`,
 * `payment-setup.ts` and `deletion.ts` record the events their own rules call for, each naming ids
 * and never a value, and a registered push token is recorded nowhere at all (AAP 0.11.1). The instant
 * a handler judges at is `request.receivedAt`, the single instant `plugins/clock.ts` stamps per
 * request, so proof validity cannot be decided across the boundary of the proof's own window
 * (AAP 0.11.1).
 *
 * @see AAP 0.5.4 for the six routes, their schemas, their errors, the guard scope, the limits and the
 *   deletion row, 0.5.1 for the Me component and the functions below, 0.5.2 for `PushToken` and the
 *   encrypted tier-3 fields, 0.5.3 for the deletion disposition and the write fence behind every
 *   write, 0.5.5 for the proof state `MeDto.proof` reports, 0.11.1 for the logging and clock rules,
 *   and 0.8.1 for this file.
 */

import { z } from 'zod';

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

// Type-only, as in every sibling plugin and route module: `App` is the plan's one declaration of the
// instance and of what it hands its modules (AAP 0.5.1), it is erased at compile time, and nothing of
// `app.ts` is read here at runtime. `app.ts` registers this plugin with the `/v1` prefix, which is
// what makes the six routes below `/v1/me...`.
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { App } from '../../app.ts';

/** The tag all six routes group under: a member of the document's own vocabulary (AAP 0.11.2). */
const ME_TAG = 'me' satisfies OpenApiTag;

/**
 * The authenticated caller's context, or a refusal.
 *
 * The group guard above admitted this request, so `request.auth` is set — but that is a property of
 * the registration, not of the handler: a hook that were moved, removed or shadowed would otherwise
 * leave a `TypeError` to be answered as `500 internal_error` where the contract requires `401
 * token_invalid`, and no compiler check would catch it. The whole context is returned rather than the
 * id alone, because `POST /me/consents` is decided by the session's own account: `recordConsents`
 * takes the context and drops that account's cached sessions after the write (AAP 0.3.2).
 *
 * @param request - The request the group's bearer or traveler guard admitted.
 * @returns The acting account's context.
 * @throws AppError `token_invalid` (401) when no context is present.
 */
function callerAuth(request: FastifyRequest): AuthContext {
  if (request.auth === null) {
    throw new AppError('token_invalid');
  }
  return request.auth;
}

/**
 * Registers the six Me routes of AAP 0.5.4 on the context `app.ts` mounts under `/v1` (AAP 0.5.1).
 *
 * The two groups are registered as children of this context rather than on it: a hook added to this
 * instance would cover both, and the age gate must not reach `GET /me`, `POST /me/consents` or
 * `DELETE /me`, which a new account reaches before it can record its consents (AAP 0.5.4).
 *
 * Registration is synchronous, as in every plugin the composition root installs — `clock.ts`,
 * `security.ts`, `openapi.ts`, `auth.ts`, `rate-limit.ts`, `raw-body.ts`, `websocket.ts` and the
 * sibling route modules all declare a `void` function — so the returned promise is already resolved
 * and a caller may await it or not. The declared `Promise<void>` is what keeps this plugin usable
 * wherever Fastify's own plugin types expect one, and `return Promise.resolve()` states that
 * resolution rather than relying on the absence of an `await` (AAP 0.11.2:
 * `@typescript-eslint/require-await`).
 *
 * @param app - The route instance; its `services` carry the guarded database client, the injected
 *   clock, the field keyring, the payments gateway, the logger and the outbox every write opens its
 *   transaction through, and the validated environment `TERMS_VERSION` is compared against.
 * @see AAP 0.5.4 for the six routes, their schemas, their errors and the guard scope, 0.5.3 for the
 *   write fence and the deletion disposition, and 0.5.8 for the screens that call these routes.
 */
export default function meRoutes(app: App): Promise<void> {
  // The bearer group: `GET /me`, `POST /me/consents` and `DELETE /me`, and only those three. The
  // guard is installed at route-group level, so the 18+ gate stays off these routes while the token
  // is still required (AAP 0.5.4). A sub-plugin's instance does not inherit the app's Zod type
  // provider through `register`, so it is asked for explicitly; `withTypeProvider` is a no-op at
  // runtime and is what types `request.body` from each route's schema, so a handler reads the parsed
  // body rather than an `unknown` it would have to re-check (AAP 0.3.1, 0.11.1).
  app.register((instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();

    scope.addHook('onRequest', requireBearer);

    scope.get(
      '/me',
      {
        // No counter: `GET /me` is a plain read, and AAP 0.5.4 limits the mutating routes and the two
        // state-writing reads alone, of which this is neither.
        schema: {
          tags: [ME_TAG],
          security: OPENAPI_SECURITY.bearer,
          // `401` is the one refusal this route can answer: the guard's, and `buildMeDto`'s own for an
          // account row that is gone or erased (AAP 0.5.3).
          response: { 200: MeDto, 401: ErrorEnvelope },
        },
      },
      // `request.receivedAt` rather than the clock read a second time inside the module, so the proof
      // state, the 90-day no-show window the reputation counters are counted over and the active
      // claim's stay are all judged at one instant for this request (AAP 0.11.1).
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
          // `400` for a version other than `TERMS_VERSION` (`consents.ts`) or a body the schema
          // refused, `401` once the account has requested deletion — the fence refuses before any
          // write (AAP 0.5.3) — and `429`/`503` from the counters above.
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

        // The confirmation and the accepted version commit in one fenced transaction, and the cache
        // entries of this account's live sessions are dropped after it, so the very next request is
        // admitted to the traveler routes instead of waiting out the cache TTL (AAP 0.3.2, 0.5.4).
        await recordConsents(app.services, auth, request.body);

        // The gate is open by now, so the payload the client routes on is the one it just recorded.
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
          // `202` with no body, the empty-answer form `POST /auth/magic-link` uses: `z.void()` rather
          // than the `z.null()` the 204s declare, because the reply is sent with no payload at all and
          // it is the body — not the status — that carries no information here (AAP 0.5.4).
          response: { 202: z.void(), 401: ErrorEnvelope, 429: ErrorEnvelope, 503: ErrorEnvelope },
        },
      },
      async (request, reply) => {
        // The disposition and its order belong to `deletion.ts` (AAP 0.5.3): the flag that closes the
        // account to writes, the cancellation rules for its open meetups, its claims with their
        // booking details, its sessions and refresh tokens, the `delete_customer` plan and the erasure
        // request. It has no refusal of its own, which is why this route publishes no error code
        // (AAP 0.5.4), and it logs its own counts — no id of a meetup, a claim or a session leaves it.
        await requestDeletion(app.services, callerAuth(request).userId);

        reply.code(202).send();
      },
    );
  });

  // The traveler group: `PUT /me/profile`, `POST /me/push-tokens` and `POST /me/payment-setup`. All
  // three are traveler feature routes, so the guard adds the age gate to the token and answers `403
  // age_gate_required` until the consents above are recorded (AAP 0.5.4).
  app.register((instance) => {
    const scope = instance.withTypeProvider<ZodTypeProvider>();

    scope.addHook('onRequest', requireTraveler);

    scope.put(
      '/me/profile',
      {
        ...mutatingLimits(app),
        // The base64 photo makes the JSON body up to a third larger than the bytes it carries, so the
        // route's own limit is 8 MB — room for a 5 MB image, which `processPhoto` answers `413
        // photo_too_large` above — and a body past it answers that same code through the error
        // plugin's `bodyTooLargeCode` (AAP 0.5.4).
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
      // The edit runs in one fenced transaction and the profile is read back after the commit, so the
      // answer is exactly what was stored; a refusal is `profile.ts`'s or the schema's (AAP 0.5.2).
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
          // `204` carries no body: Fastify runs no serializer for that status, and the reply below
          // hands it the `null` the schema declares (AAP 0.5.4).
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

        // One device, one account: `token` is the row's unique key, so a token presented by a second
        // account moves to that account — the phone it belongs to now signs in as the caller — and a
        // re-registration by the same account only refreshes its platform. Behind the write fence,
        // like every other write, so an account that has requested deletion registers nothing
        // (AAP 0.5.2, 0.5.3).
        await transact(
          app.services,
          (tx) =>
            tx.pushToken.upsert({
              where: { token },
              create: { token, platform, userId },
              update: { platform, userId },
            }),
          { fenceUserId: userId },
        );

        // Nothing about the token is logged, here or anywhere on this path: it names a device that
        // can be sent to, and a log line is not a place to hold one (AAP 0.11.1).
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
          // `401` for an account that is gone or has requested deletion, which `createPaymentSetup`
          // refuses before it creates a customer, and `503 payment_unavailable` when the provider
          // could not start the setup (AAP 0.5.4). No card field exists in this contract: the card is
          // entered in Stripe's own component, so no raw card data reaches the API (AAP 0.12.2).
          response: {
            200: PaymentSetupResponse,
            401: ErrorEnvelope,
            403: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      // The customer, the SetupIntent's client secret and the ephemeral key are `payment-setup.ts`'s
      // to create, reuse and store; a response whose customer is not the one the account names is a
      // defect inside it, not something this handler could repair.
      async (request) => createPaymentSetup(app.services, callerAuth(request).userId),
    );
  });

  return Promise.resolve();
}
