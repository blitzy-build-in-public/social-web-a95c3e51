/**
 * The four user routes of AAP 0.5.4 — a traveler's profile, their photo bytes, a block and a report
 * (AAP 0.5.1, 0.5.2, 0.5.3, 0.5.4, 0.5.7).
 *
 * They are the whole HTTP surface of the `users` module, and each of them is deliberately thin: the
 * rule it exposes is decided in one other place and only consumed here.
 *
 *  - `GET /users/:userId` answers the profile `loadProfile` returned for the viewer's disclosure tier
 *    (AAP 0.5.4, criterion 5). The three disclosure layers — `disclosure/tier.ts` decides the tier,
 *    `disclosure/select.ts` loads only that tier's columns and `disclosure/serialize.ts` copies that
 *    tier's keys through its own schema — are the only place a profile field is chosen, so nothing
 *    here re-decides a tier, filters a field or re-serializes one: a field above the viewer's tier is
 *    never loaded, let alone returned, whichever tier the pair earned (AAP 0.12.2). `AnyTierProfile`
 *    is the shared schema the route declares, and `MeetupDto.counterpart` is built by the same
 *    function.
 *  - `GET /users/:userId/photo` asks `computeTier` for the pair's tier and compares it with
 *    `PHOTO_MIN_TIER` (2), which is the single gate on photo bytes (AAP 0.5.4). Every refusal answers
 *    `404 user_not_found`: a block in either direction, a tier below 2, an unknown or erased account
 *    and a traveler with no stored photo are indistinguishable, so the route cannot be used to probe
 *    who exists, who is blocked, or who has a photo.
 *  - `POST /users/:id/block` and `POST /users/:id/report` hand their work to `./safety.ts`, which owns
 *    the `Block` and `Report` rows, the cancellation of an open pair meetup (`cancelReason = block`,
 *    no forfeit and no reputation change) and the account-deletion write fence (AAP 0.5.3, 0.7.3).
 *    A report changes nothing else and is operator-visible only, so its reason travels in the body and
 *    back out to no one.
 *
 * All four are traveler feature routes, so the guard is installed once on this encapsulated context as
 * `app.addHook('onRequest', requireTraveler)` and never globally: the age gate covers exactly the
 * routes declared below and cannot reach `GET /me`, the public routes, the provider webhooks, the
 * console routes or `/admin/*` (AAP 0.5.4). A refusal is `401 token_invalid` or `403
 * age_gate_required`. The two reads carry no counter — AAP 0.5.4 limits the mutating routes and the two
 * state-writing reads, and neither is one — while the block and the report spread `mutatingLimits(app)`
 * for their per-IP `onRequest` and per-user `preHandler` allowances.
 *
 * The instant the profile read is judged at is `request.receivedAt`, the single instant `plugins/clock.ts`
 * stamps per request, so a proof's validity and the tier it feeds cannot be decided across the boundary
 * of the proof's own window (AAP 0.11.1). Nothing here logs: not a profile field, not a report reason,
 * not a contact handle, not a photo byte. A refusal is recorded once by `plugins/auth.ts`, and a block
 * or a report by `./safety.ts`.
 *
 * @see AAP 0.5.1 for the `users` component and its `routes`/`safety` files, 0.5.4 for the four routes,
 *   their schemas, their errors and the guard scope, 0.5.7 for the tier rule `computeTier` implements,
 *   0.5.2 for the `ProfilePhoto` row and erasure, 0.11.1 for the injected clock and the logging rules,
 *   0.11.2 for the response schemas, and 0.8.1 for this file.
 */

import { z } from 'zod';

import {
  AnyTierProfile,
  ErrorEnvelope,
  IdParams,
  PHOTO_MIN_TIER,
  ReportRequest,
  UserIdParams,
} from '@tablemate/shared';

import { requireTraveler } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { mutatingLimits } from '../../plugins/rate-limit.ts';
import { loadProfile } from './disclosure/serialize.ts';
import type { ReaderServices } from './disclosure/serialize.ts';
import { computeTier } from './disclosure/tier.ts';
import { block, report } from './safety.ts';

import type { FastifyContextConfig, FastifyRequest } from 'fastify';

// Type-only, so this module holds no run-time edge back to the module that registers it: `App` and
// `AppServices` are the plan's one declaration of the instance and of what it hands its modules
// (AAP 0.5.1), they are erased at compile time, and nothing of `app.ts` is read here at runtime.
// `app.ts` registers this plugin with the `/v1` prefix, which is what makes the four routes below
// `/v1/users/...`.
import type { App, AppServices } from '../../app.ts';

/** The tag all four routes group under: a member of the document's own vocabulary (AAP 0.11.2). */
const USERS_TAG = 'users' satisfies OpenApiTag;

/**
 * What the photo route answers with: the media type of `ProfilePhoto.webp`, which is the WebP encode
 * `me/photo.ts` produced rather than the bytes a caller uploaded (AAP 0.5.2).
 */
const PHOTO_CONTENT_TYPE = 'image/webp';

/**
 * The cache directive on a profile photo: `private, no-store`.
 *
 * `private` keeps a shared cache from holding one traveler's photo for the next caller, and `no-store`
 * keeps any cache from holding it at all — the tier that released the bytes is a property of the pair
 * and can be revoked by a block, so a cached copy could outlive the right to see it (AAP 0.5.4, 0.5.7).
 */
const PHOTO_CACHE_CONTROL = 'private, no-store';

/**
 * The one route flag `apps/api/src/app.ts` reads to let a route answer bytes rather than a serialized
 * DTO. It is set on the two routes that do — `POST /webhooks/voice/twiml`, whose XML no Zod schema
 * describes, and `GET /users/:userId/photo` below — and the flag belongs to the composition root, so
 * it is passed as a context config here rather than added to the flag vocabulary from this file.
 */
const RAW_PHOTO_RESPONSE = { rawResponse: true } as FastifyContextConfig;

/** What the photo handler reads: the guarded database client, and nothing else. */
type PhotoServices = Pick<AppServices, 'db'>;

/**
 * The authenticated caller's id, or a refusal.
 *
 * The guard above admitted this request, so `request.auth` is set — but that is a property of the
 * registration, not of the handler: a hook that were moved, removed or shadowed would otherwise leave
 * a `TypeError` to be answered as `500 internal_error` where the contract requires `401 token_invalid`,
 * and no compiler check would catch it.
 *
 * @param request - The request the traveler guard admitted.
 * @returns The acting account's id.
 * @throws AppError `token_invalid` (401) when no context is present.
 */
function callerId(request: FastifyRequest): string {
  if (request.auth === null) {
    throw new AppError('token_invalid');
  }
  return request.auth.userId;
}

/**
 * One traveler's profile, at the disclosure tier the viewer has earned toward them (AAP 0.5.4, 0.5.7).
 *
 * The entire rule is `loadProfile`'s: it asks `computeTier` for the tier, loads only that tier's
 * columns, builds the response from that tier's field allowlist and parses it through that tier's own
 * schema. This function's own part is the `404`: `null` covers every way a profile must not be served —
 * a block in either direction, an unknown id, a deleted or deletion-requested account and a tombstone
 * whose handle and avatar seed erasure nulled — so the route is no oracle for which of them applies.
 *
 * @param services - The guarded database client, the keyring the tier-3 fields are decrypted with and
 *   the logger a decryption failure is recorded on.
 * @param viewerId - The authenticated caller, from `request.auth`.
 * @param targetId - The `:userId` path parameter, already validated as a uuid by `UserIdParams`.
 * @param now - The instant proof validity is judged at, from `request.receivedAt`.
 * @returns The tier's profile, already parsed by `PROFILE_SCHEMA_BY_TIER[tier]`.
 * @throws AppError `user_not_found` (404) whenever the pair, the target or the row is unservable.
 */
async function profileForViewer(
  services: ReaderServices,
  viewerId: string,
  targetId: string,
  now: Date,
): Promise<AnyTierProfile> {
  const loaded = await loadProfile(services, viewerId, targetId, now);

  if (loaded === null) {
    throw new AppError('user_not_found');
  }

  return loaded.profile;
}

/**
 * One traveler's stored photo, for a viewer entitled to it (AAP 0.5.2, 0.5.4).
 *
 * The gate is asked first and asked of the disclosure layer: `computeTier` returns the pair's tier, or
 * `'blocked'` for a block in either direction, and `PHOTO_MIN_TIER` (2) is the lowest tier that
 * receives bytes. A self view is tier 3 by definition, so a traveler sees their own photo whatever
 * their history. The read that follows applies the same liveness filter `loadProfile` applies — the
 * row is loaded only while `deletedAt` and `deletionRequestedAt` are both unset — which is what makes a
 * deleted account's photo unreachable even in the window before `account-erasure` removes the row.
 *
 * Only the `webp` column is selected, because the bytes are the whole answer: the dimensions are not a
 * disclosure field and never leave the server (AAP 0.5.2). Every refusal is the same `404`, so neither
 * the tier, the block state, the account's existence nor the presence of a photo can be told apart.
 *
 * @param services - The guarded database client.
 * @param viewerId - The authenticated caller, from `request.auth`.
 * @param targetId - The `:userId` path parameter, already validated as a uuid by `UserIdParams`.
 * @returns The stored WebP bytes, as the `BYTEA` column holds them.
 * @throws AppError `user_not_found` (404) for a block, a tier below {@link PHOTO_MIN_TIER}, an unknown
 *   or erased account, and a traveler with no photo.
 */
async function photoForViewer(
  services: PhotoServices,
  viewerId: string,
  targetId: string,
): Promise<Buffer> {
  const tier = await computeTier(services.db, viewerId, targetId);

  if (tier === 'blocked' || tier < PHOTO_MIN_TIER) {
    throw new AppError('user_not_found');
  }

  const row = await services.db.user.findFirst({
    where: { id: targetId, deletedAt: null, deletionRequestedAt: null },
    select: { profilePhoto: { select: { webp: true } } },
  });

  if (row === null || row.profilePhoto === null) {
    throw new AppError('user_not_found');
  }

  // `Buffer`, not the `Uint8Array` Prisma hands back: Fastify's reply sends a Node buffer as the body
  // it is, and the bytes are never copied anywhere else on the way out (AAP 0.11.1).
  return Buffer.from(row.profilePhoto.webp);
}

/**
 * Registers the four user routes of AAP 0.5.4 on the context `app.ts` mounts under `/v1` (AAP 0.5.1).
 *
 * The guard comes first, on this context alone: `requireTraveler` reads the access token and the age
 * gate, and installing it here rather than globally is what keeps `GET /users/*` guarded while the
 * bearer-only, public, provider, console and operator routes stay outside the gate (AAP 0.5.4).
 *
 * Registration is synchronous, as in every other plugin the composition root installs — `clock.ts`,
 * `security.ts`, `openapi.ts`, `auth.ts`, `rate-limit.ts`, `raw-body.ts` and `websocket.ts` all declare
 * a `void` function — so the returned promise is already resolved and a caller may await it or not. The
 * declared `Promise<void>` is what keeps this plugin usable wherever Fastify's own plugin types expect
 * one, and `return Promise.resolve()` states that resolution rather than relying on the absence of an
 * `await` (AAP 0.11.2: `@typescript-eslint/require-await`).
 *
 * @param app - The route instance; its `services` carry the guarded database client, the keyring the
 *   tier-3 fields are decrypted with, the injected clock, the logger and the outbox every write opens
 *   its transaction through.
 * @see AAP 0.5.4 for the four routes, their schemas and their errors.
 */
export default function usersRoutes(app: App): Promise<void> {
  app.addHook('onRequest', requireTraveler);

  app.get(
    '/users/:userId',
    {
      schema: {
        tags: [USERS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: UserIdParams,
        // The tier is the pair's, so the payload is typed by the shared union and serialized by the
        // variant it satisfies; every profile field the tier carries was already parsed by that tier's
        // own schema in `serialize.ts` (AAP 0.5.4).
        response: {
          200: AnyTierProfile,
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request) =>
      profileForViewer(app.services, callerId(request), request.params.userId, request.receivedAt),
  );

  app.get(
    '/users/:userId/photo',
    {
      schema: {
        tags: [USERS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: UserIdParams,
        // No `response`: the answer is WebP bytes that no Zod schema describes, and a declared `200`
        // would put a JSON serializer in front of them. `config.rawResponse` is the composition root's
        // marker for the routes that answer bytes, and the shared envelope still answers every refusal
        // through the error handler (AAP 0.5.4).
      },
      config: RAW_PHOTO_RESPONSE,
    },
    async (request, reply) => {
      const bytes = await photoForViewer(app.services, callerId(request), request.params.userId);

      return reply
        .type(PHOTO_CONTENT_TYPE)
        .header('Cache-Control', PHOTO_CACHE_CONTROL)
        .send(bytes);
    },
  );

  app.post(
    '/users/:id/block',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [USERS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        // No body: a block is the caller, the target and nothing else (AAP 0.5.4). `204` carries no
        // body at all, so the reply hands the `null` the schema declares and Fastify runs no
        // serializer for that status.
        response: {
          204: z.null(),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      await block(app.services, callerId(request), request.params.id);

      // `block` cancels an open pair meetup itself, through the state machine, and logs the one
      // `user_blocked` line; the answer is the contract's empty `204`.
      reply.code(204).send(null);
    },
  );

  app.post(
    '/users/:id/report',
    {
      ...mutatingLimits(app),
      schema: {
        tags: [USERS_TAG],
        security: OPENAPI_SECURITY.bearer,
        params: IdParams,
        body: ReportRequest,
        response: {
          204: z.null(),
          400: ErrorEnvelope,
          401: ErrorEnvelope,
          403: ErrorEnvelope,
          404: ErrorEnvelope,
        },
      },
    },
    async (request, reply) => {
      // The reason is read from the validated body and passed on; it is never logged, never returned
      // and never attached to a notification (AAP 0.5.4, 0.11.1).
      await report(app.services, callerId(request), request.params.id, request.body);

      reply.code(204).send(null);
    },
  );

  return Promise.resolve();
}
