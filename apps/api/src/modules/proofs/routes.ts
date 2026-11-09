/**
 * The two proof routes: the contract's `POST /itinerary-proofs`, which stores the stay a proof proves and spends that
 * booking's nullifier, and the additive public `GET /zk/config`, which publishes the configuration a device builds its
 * circuit inputs from.
 *
 * They differ in who may call them, so each route group is registered in its own encapsulated sub-plugin: the submission is a
 * traveler feature route — a bearer token, the 18+ gate and the mutating allowances — while `GET /zk/config` is public,
 * because a device needs the issuer keys, the registry, the salt and the artefact links before it holds any proof. No hook is
 * installed on the context this file is mounted on, so neither group's guard can reach the other's routes.
 *
 * The submission's steps, each where it is for a reason: `verifyItineraryProof` runs outside any transaction, because it is
 * CPU-bound pairing work and holding a transaction across it would pin a pool connection and a row lock; the validity window
 * is derived from the arrival city's own zone; and one transaction, behind the account-deletion write fence, writes the
 * `SpentNullifier` row first and the `ItineraryProof` row second, the nullifier insert being what makes a booking provable
 * once for the whole deployment — the key names the booking rather than the account and survives account erasure.
 *
 * Nothing private leaves this file: the proof, the nullifier, the registry root and the salt are read by the verifier and
 * written to the row, never logged and never answered.
 */

import { Prisma, isUniqueViolation, type DbTx } from '@tablemate/db';
import { ErrorEnvelope, ProofAccepted, ProofSubmission, ZkConfig } from '@tablemate/shared';

import { requireTraveler } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { OPENAPI_SECURITY, type OpenApiTag } from '../../plugins/openapi.ts';
import { guardRouteGroup, mutatingLimits } from '../../plugins/rate-limit.ts';
import { transact } from '../outbox/write.ts';
import { zkConfig } from './registry.ts';
import { proofValidity } from './validity.ts';
import { verifyItineraryProof, type VerifiedItinerary } from './verifier.ts';

import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { App, AppServices } from '../../app.ts';

/** The tag both routes group under: a member of the document's own vocabulary (AAP 0.11.2). */
const PROOFS_TAG = 'proofs' satisfies OpenApiTag;

/**
 * The one log line a stored proof writes: the public outputs alone — the city, the issuer and the two dates the proof proves —
 * and never the proof, the nullifier, the root or the salt.
 */
const PROOF_VERIFIED = 'proof_verified';

/**
 * The authenticated caller's id, or a refusal: the guard above admitted this request, but that is a property of the
 * registration rather than of this handler, and a hook that were moved, removed or shadowed would otherwise leave a
 * `TypeError` answered as `500 internal_error` where the contract requires `401 token_invalid`.
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
 * The UTC midnight of a `YYYY-MM-DD` date: the form Prisma takes for the `@db.Date` columns of `ItineraryProof`. The date is a
 * calendar date the circuit proved, not an instant, so it is anchored to UTC rather than to any process zone.
 */
function dateColumn(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

/**
 * Spends the booking's nullifier.
 *
 * `ON CONFLICT DO NOTHING` rather than catching a unique violation, because a failed statement aborts the enclosing PostgreSQL
 * transaction and every later write in it would then fail as well. The returned row count is the whole answer: one row means
 * this call spent the nullifier, and no rows mean another proof already holds it.
 *
 * `@throws AppError nullifier_used` (409) when the booking was already spent, by this account or another.
 */
async function spendNullifier(tx: DbTx, nullifier: string, now: Date): Promise<void> {
  const spent = await tx.$queryRaw<{ nullifier: string }[]>(
    Prisma.sql`
      INSERT INTO "spent_nullifier" ("nullifier", "spent_at")
      VALUES (${nullifier}, ${now})
      ON CONFLICT DO NOTHING
      RETURNING "nullifier"
    `,
  );
  if (spent.length === 0) {
    throw new AppError('nullifier_used');
  }
}

/**
 * Stores a verified proof and the stay it proves, as one transaction behind the deletion write fence.
 *
 * A second proof for the same city is simply another row: discovery reads the latest valid one. `validFrom` and `validTo` are
 * stored rather than derived per read, so a later change to the city's zone or to the look-back constant cannot move an
 * accepted proof's window.
 *
 * `@throws AppError nullifier_used` (409) for a booking already spent, and `token_invalid` (401) when the account has
 * requested deletion.
 */
async function storeProof(
  services: AppServices,
  userId: string,
  verified: VerifiedItinerary,
  window: { readonly validFrom: Date; readonly validTo: Date },
): Promise<string> {
  const now = services.clock.now();
  return transact(
    services,
    async (tx) => {
      await spendNullifier(tx, verified.nullifier, now);
      try {
        const created = await tx.itineraryProof.create({
          data: {
            userId,
            cityId: verified.cityId,
            arrivalDate: dateColumn(verified.arrivalDate),
            departureDate: dateColumn(verified.departureDate),
            issuerId: BigInt(verified.issuerId),
            nullifier: verified.nullifier,
            registryRoot: verified.registryRoot,
            validFrom: window.validFrom,
            validTo: window.validTo,
          },
          select: { id: true },
        });
        return created.id;
      } catch (error) {
        // Unreachable after the nullifier insert above, which is the table's only unique column. It
        // is still mapped, so a collision that did reach here answers the contract's `409` instead of
        // a `500 internal_error` (AAP 0.5.4).
        if (isUniqueViolation(error, 'nullifier')) {
          throw new AppError('nullifier_used');
        }
        throw error;
      }
    },
    { fenceUserId: userId },
  );
}

/**
 * Registers the two proof routes of AAP 0.5.4 on the context `app.ts` mounts under `/v1`.
 *
 * Registration is synchronous, as in every plugin the composition root installs, so the returned promise is already resolved;
 * the declared `Promise<void>` is what keeps this plugin usable wherever Fastify's own plugin types expect one.
 */
export default function proofsRoutes(app: App): Promise<void> {
  // The traveler group: bearer authentication plus the 18+ gate, and the mutating allowances of
  // AAP 0.5.4 — 60 requests a minute per user, `RATE_LIMIT_IP_PER_MIN` per address, and
  // `503 service_unavailable` rather than an uncounted request when the limiter's Redis store is
  // unreachable. The guard is installed at route-group level and never globally.
  app.register((instance) => {
    // A sub-plugin's instance does not inherit the app's Zod type provider through `register`, so it
    // is asked for explicitly. `withTypeProvider` is a no-op at runtime — Fastify's own
    // implementation returns the instance it was called on — and it is what types `request.body`
    // from the route's schema, so the handler reads the parsed `ProofSubmission` rather than an
    // `unknown` it would have to re-check (AAP 0.3.1, 0.11.1).
    const traveler = instance.withTypeProvider<ZodTypeProvider>();
    guardRouteGroup(traveler, requireTraveler);
    traveler.post(
      '/itinerary-proofs',
      {
        ...mutatingLimits(traveler),
        config: { validationErrorCode: 'proof_malformed' },
        schema: {
          tags: [PROOFS_TAG],
          security: OPENAPI_SECURITY.bearer,
          body: ProofSubmission,
          response: {
            201: ProofAccepted,
            400: ErrorEnvelope,
            401: ErrorEnvelope,
            403: ErrorEnvelope,
            409: ErrorEnvelope,
            422: ErrorEnvelope,
            429: ErrorEnvelope,
            503: ErrorEnvelope,
          },
        },
      },
      async (request, reply) => {
        const userId = callerId(request);
        // Verification first, outside any transaction and outside the window below: it answers the
        // contract's own codes and needs no database at all (AAP 0.5.5).
        const verified = await verifyItineraryProof(app.services, request.body);
        const window = proofValidity(
          app.services.timezoneFor(verified.cityId),
          verified.arrivalDate,
          verified.departureDate,
        );
        const proofId = await storeProof(app.services, userId, verified, window);
        // Public outputs only, in the one line a stored proof writes (AAP 0.11.1).
        request.log.info(
          {
            event: PROOF_VERIFIED,
            cityId: verified.cityId,
            issuerId: verified.issuerId,
            arrivalDate: verified.arrivalDate,
            departureDate: verified.departureDate,
          },
          PROOF_VERIFIED,
        );
        reply.code(201);
        return {
          proofId,
          cityId: verified.cityId,
          arrivalDate: verified.arrivalDate,
          departureDate: verified.departureDate,
        };
      },
    );
  });
  // The public group: `GET /zk/config` carries no bearer guard, no age gate and no counter, because
  // the device fetches it before it can prove anything and AAP 0.5.4 lists it among the public
  // routes. A missing artefact manifest is answered `503 service_unavailable` by `zkConfig` itself.
  app.register((instance) => {
    instance.withTypeProvider<ZodTypeProvider>().get(
      '/zk/config',
      { schema: { tags: [PROOFS_TAG], response: { 200: ZkConfig, 503: ErrorEnvelope } } },
      // The handler returns `zkConfig`'s promise instead of awaiting it: Fastify awaits what a handler
      // returns, and the error plugin renders a rejection from it exactly as a thrown `AppError`.
      () => zkConfig(app.services),
    );
  });
  return Promise.resolve();
}
