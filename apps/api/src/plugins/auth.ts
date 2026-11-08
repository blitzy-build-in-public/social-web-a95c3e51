/**
 * Authentication for the API: the access token, the route-group guards, the Redis session cache
 * and the account-deletion write fence (AAP 0.3.2, 0.3.3, 0.5.1, 0.5.3, 0.5.4, 0.8.1).
 *
 * Five things live here, and each is the only place its rule is applied.
 *
 *  - **The access token.** {@link signAccessToken} and {@link verifyAccessToken} are the one pair
 *    that writes and reads the 15-minute HS256 JWT of AAP 0.3.3, whose claims are exactly `sub`,
 *    `role`, `sid` (plus `iat` and `exp`). No email address, handle or other profile field ever
 *    enters a token, and verification reads the injected clock, so a test that advances the clock
 *    past 15 minutes expires a token the way real time would.
 *  - **The guards.** {@link requireBearer}, {@link requireTraveler}, {@link requireOperator} and
 *    {@link requireWebSocketBearer} are plain exported hooks, deliberately not a global `onRequest`
 *    hook: a route group installs the one it needs with `app.addHook('onRequest', requireTraveler)`,
 *    which is what keeps the age gate on the traveler feature routes and off `GET /me`,
 *    `POST /me/consents`, `POST /auth/logout` and `DELETE /me` (bearer only), the public routes, the
 *    provider webhooks (`/webhooks/*`), the console routes, `/admin/*` (role-guarded) and the
 *    test-control routes (AAP 0.5.4). A route outside those groups cannot inherit the gate by
 *    accident, because nothing is registered globally.
 *  - **The session cache.** `auth:session:<sid>` in Redis for 30 seconds (AAP 0.5.3), holding the
 *    three facts a request needs — user id, role, age gate — and never an email address or a token.
 *    It serves read-only authentication. A miss, an error and a slow reply are one thing here: all
 *    three fall through to PostgreSQL, so a Redis outage slows authentication without failing it,
 *    and a cached entry can never authorise a write, because every write runs behind the fence.
 *  - **The fence.** {@link assertWritable} takes `SELECT ... FOR SHARE` on the acting user's row
 *    inside the caller's transaction and refuses with `401 token_invalid` once
 *    `deletion_requested_at` or `deleted_at` is set (AAP 0.5.3). `DELETE /me` takes `FOR UPDATE` on
 *    the same row, so a mutation already in flight commits before the deletion and every mutation
 *    starting later is refused — nothing the erased account wrote can be recreated afterwards. It
 *    reads PostgreSQL, never the cache.
 *  - **The invalidation.** {@link dropCachedSessions}, {@link invalidateSession} and
 *    {@link invalidateUserSessions} are what make the two writes above visible at once: the first
 *    drops cache entries after a logout, a refresh-reuse revocation, a consent change or a role
 *    change; the second also publishes the `{ type: 'invalidate' }` control frame naming the one
 *    session that ended, so every API instance closes the sockets that session was admitted with;
 *    and the third publishes it for an account that ended, so every socket of that user is closed
 *    (AAP 0.3.2, 0.5.3). All three are called after the revoking transaction commits.
 *
 * Nothing in this module logs a token, an email address, an `Authorization` header or a
 * `Sec-WebSocket-Protocol` header: a refusal writes one `auth_rejected` line carrying its reason
 * under `guardReason` and nothing else, and a success writes nothing per request (AAP 0.11.1).
 */

import { SignJWT, jwtVerify } from 'jose';

import {
  ACCESS_TOKEN_TTL_MINUTES,
  AccessTokenClaims,
  SESSION_CACHE_SECONDS,
  UserRole,
  type ErrorCode,
} from '@tablemate/shared';

import { Prisma, type DbClient, type DbTx } from '@tablemate/db';
import type { ApiEnv, Clock, Logger } from '@tablemate/server-core';

import { AppError, isAppError } from './errors.ts';
import { bearerTokenFromProtocolHeader } from './websocket.ts';

import type { FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** Set on every request by whichever guard admitted it, and `null` until then (AAP 0.3.3). */
declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/**
 * What a request is authenticated as.
 *
 * `role` and `ageConfirmed` are read from the user row — directly, or from the cache entry a
 * previous request wrote from that row — and never from the token's `role` claim alone: the claim
 * says which session was minted, while the row says what the account is now. `scripts/grant-operator.ts`
 * revokes the sessions it promotes, so the two agree in every case the API serves.
 */
export interface AuthContext {
  /** The acting account's id, which every ownership check compares against. */
  readonly userId: string;
  /** The account's role, from `User.role`. */
  readonly role: UserRole;
  /** The session the access token names in `sid`; logout and refresh revoke it. */
  readonly sessionId: string;
  /** True once the 18+ confirmation and the terms version are both recorded. */
  readonly ageConfirmed: boolean;
}

/**
 * The two dependencies the token helpers read.
 *
 * Narrowed deliberately: a script (`scripts/bench-verify.ts`, `scripts/perf-seed.ts`) and
 * `test/support/factories.ts` sign tokens without building the app's whole container, and a guard
 * needs no capability a token does not.
 */
export type TokenServices = {
  readonly env: Pick<ApiEnv, 'JWT_SECRET'>;
  readonly clock: Clock;
};

/**
 * The Redis commands the session cache uses, as the `client`-role connection of
 * `packages/server-core/src/queues/connection.ts` exposes them.
 *
 * Spelled out instead of imported, so the module names the three capabilities it depends on rather
 * than the whole ioredis surface: a real client satisfies this structurally, and a test can stand a
 * map in for it. `set` names the `PX` form, which is the one the cache writes with.
 */
export interface SessionCacheCommands {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, marker: 'PX', milliseconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

/**
 * The control frame published when a session ends for every instance at once (AAP 0.3.2, 0.5.3).
 *
 * It is not a `ServerFrame` of `packages/shared/src/schemas/ws.ts`: it is never sent to a client.
 * Every API instance subscribed to the user's channel reads it and closes the sockets it names with
 * `WS_CLOSE.invalidated`: the sockets of the sessions in `sessionIds`, or every socket of the user
 * when it names none, which is what an account that ended as a whole publishes.
 */
export interface SessionInvalidationFrame {
  readonly type: 'invalidate';
  /** The sessions that ended; absent when the whole account did. */
  readonly sessionIds?: string[];
}

/** The one invalidation frame, frozen so no caller can mutate what every instance receives. */
export const SESSION_INVALIDATION_FRAME: SessionInvalidationFrame = Object.freeze({
  type: 'invalidate',
} as const);

/**
 * The Redis pub/sub surface the invalidation is published through, as
 * `apps/api/src/modules/messaging/pubsub.ts` provides it. The channel is
 * `userChannel(userId)` (`user:<id>`), which the publisher names, so no channel string is built
 * here.
 */
export interface SessionPubSub {
  publishUser(userId: string, frame: SessionInvalidationFrame): Promise<unknown>;
}

/**
 * The one instance method {@link registerAuth} calls.
 *
 * Typed structurally instead of as the app's own `App`, so this plugin reads no other module of the
 * API: its imports are its two sibling plugins and the shared packages, which is what lets it
 * compile on its own and cannot create a cycle with the bootstrap that calls it. An instance type
 * satisfies this structurally — the two other plugins an instance is passed to (`errors.ts`,
 * `websocket.ts`) already prove it carries `setErrorHandler` and `register`, and Fastify declares
 * `decorateRequest` on every instance shape.
 */
export type AuthHost = {
  decorateRequest(name: string, value: unknown): unknown;
};

/**
 * What the guards read off the running instance.
 *
 * Narrowed to the capabilities this module uses, the way the modules of `apps/api/src/modules`
 * narrow theirs: the app's own services type is declared by `app.ts`, and a
 * `Pick`-shaped member set is satisfied structurally by it while keeping a test free to stand a
 * double in for one capability. Only `clock` is used by the token helpers as well, which is why
 * {@link TokenServices} is the same object narrowed further.
 */
export interface AuthServices {
  /** The guarded Prisma client, of which the session lookup is the only delegate read here. */
  readonly db: Pick<DbClient, 'session'>;
  /** The `client`-role Redis connection, of which the session cache reads and writes. */
  readonly redis: { readonly client: SessionCacheCommands };
  /** The process logger, used for the cache-drop and publish warnings only. */
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  /** The injected clock (AAP 0.11.1): token expiry and session expiry are both measured by it. */
  readonly clock: Clock;
  /** The API's validated environment, of which only the signing secret is read. */
  readonly env: Pick<ApiEnv, 'JWT_SECRET'>;
  /** The pub/sub publisher that carries an invalidation to every API instance. */
  readonly pubsub: SessionPubSub;
}

/**
 * Why a guard refused a request, as the `auth_rejected` line's `guardReason` records it: `missing`
 * for an absent or unusable `Authorization` header, `invalid` for a token that fails signature,
 * lifetime or shape, `session` for a token whose session is unknown, revoked, expired or deleted,
 * `age_gate` for a signed-in account that has not recorded the 18+ confirmation, and `role` for a
 * traveler reaching an operator route. Never a value the caller supplied.
 */
export type AuthRejectionReason = 'missing' | 'invalid' | 'session' | 'age_gate' | 'role';

/** The cached shape: the three facts a request needs, and nothing that identifies the person. */
interface CachedSession {
  readonly userId: string;
  readonly role: UserRole;
  readonly ageConfirmed: boolean;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** The session cache key. The `:` separator is the convention for Redis keys (AAP 0.3.2). */
const SESSION_CACHE_KEY_PREFIX = 'auth:session:';

/**
 * How long a cache command may take. ioredis' own `commandTimeout` on a `client`-role connection is
 * 5 seconds, which is far longer than an authentication may wait: the cache is an optimisation, so a
 * reply that has not arrived in this window sends the request to PostgreSQL instead.
 */
const CACHE_COMMAND_TIMEOUT_MS = 250;

/** How long an invalidation publish may take before it is recorded and dropped. */
const INVALIDATION_PUBLISH_TIMEOUT_MS = 1000;

/** The access token's lifetime in seconds, from the shared 15-minute constant (AAP 0.3.3). */
const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TOKEN_TTL_MINUTES * 60;

/**
 * The longest token that is even looked at. A compact JWS for the three claims above is a few
 * hundred characters; the bound keeps an absurd header from reaching the verifier at all.
 */
const MAX_TOKEN_CHARS = 4096;

/** The `Bearer <token>` form the `Authorization` header must have; the scheme is case-insensitive. */
const BEARER_HEADER_RE = /^Bearer ([A-Za-z0-9._-]+)$/i;

/**
 * The characters a compact JWS may consist of: base64url segments joined by `.`. Checked before a
 * value taken from a header is treated as a token, so neither a header nor a handshake can hand the
 * JWT verifier arbitrary bytes; the signature and the claims are still what authenticate a caller.
 * The same shape `plugins/websocket.ts` uses for the subprotocol entry.
 */
const COMPACT_JWS_RE = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------------------------
// Access tokens (AAP 0.3.3)
// ---------------------------------------------------------------------------------------------

/**
 * The HMAC keys already derived, by secret. The secret is fixed for the life of a process, so this
 * holds one entry in the API, the workers and a script, and at most a handful in a test process that
 * builds several apps.
 */
const hmacKeys = new Map<string, Uint8Array>();

/** The signing key for `secret`, encoded once and reused. Never logged. */
function hmacKey(secret: string): Uint8Array {
  const cached = hmacKeys.get(secret);
  if (cached !== undefined) return cached;

  const key = new TextEncoder().encode(secret);
  hmacKeys.set(secret, key);
  return key;
}

/**
 * Signs the access token of AAP 0.3.3: HS256, the claims `sub`, `role` and `sid`, an `iat` taken from
 * the injected clock and an `exp` {@link ACCESS_TOKEN_TTL_SECONDS} later. Nothing else is put in the
 * payload — no email address, no handle, no session expiry — because a token is handed to a client
 * and read by anyone who holds it.
 *
 * `sessions.ts` calls this for `POST /auth/verify` and `POST /auth/refresh`, and the test factories
 * and benchmark scripts call it to act as a signed-in traveler.
 *
 * @param services - The signing secret and the clock.
 * @param claims - The subject, role and session the token names.
 * @returns The compact JWS.
 * @see AAP 0.3.3.
 */
export async function signAccessToken(
  services: TokenServices,
  claims: AccessTokenClaims,
): Promise<string> {
  const issuedAt = Math.floor(services.clock.nowMs() / 1000);

  return new SignJWT({ role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
    .sign(hmacKey(services.env.JWT_SECRET));
}

/**
 * Verifies an access token and returns its claims.
 *
 * The clock is passed to `jose` as `currentDate`, so expiry is measured by the same injected clock
 * everything else in the API reads and a test that advances it past 15 minutes expires the token
 * (AAP 0.11.1). Every failure — a bad signature, an expired token, a wrong algorithm, a malformed
 * payload, a claim of the wrong shape — is the same `401 token_invalid` to the caller, so a probe
 * cannot learn which part of a token was wrong.
 *
 * @param services - The signing secret and the clock.
 * @param token - The compact JWS taken from the request.
 * @returns The parsed claims, carrying exactly `sub`, `role` and `sid`.
 * @throws AppError `token_invalid` for anything that is not a token this process signed and that has
 *   not expired.
 * @see AAP 0.3.3, 0.5.4.
 */
export async function verifyAccessToken(
  services: TokenServices,
  token: string,
): Promise<AccessTokenClaims> {
  if (token.length > MAX_TOKEN_CHARS || !COMPACT_JWS_RE.test(token)) {
    throw new AppError('token_invalid');
  }

  let payload: unknown;
  try {
    const { payload: verified } = await jwtVerify(token, hmacKey(services.env.JWT_SECRET), {
      algorithms: ['HS256'],
      currentDate: services.clock.now(),
    });
    payload = verified;
  } catch {
    // The verifier's own error is deliberately dropped rather than attached as a cause: it names
    // which check failed, and the envelope answers every failure the same way.
    throw new AppError('token_invalid');
  }

  const claims = AccessTokenClaims.safeParse(payload);
  if (!claims.success) {
    throw new AppError('token_invalid');
  }

  return claims.data;
}

// ---------------------------------------------------------------------------------------------
// The session cache and its invalidation (AAP 0.3.2, 0.5.3)
// ---------------------------------------------------------------------------------------------

/** The cache key for one session. */
function sessionCacheKey(sessionId: string): string {
  return `${SESSION_CACHE_KEY_PREFIX}${sessionId}`;
}

/**
 * Settles with `work`, or rejects once `milliseconds` have passed.
 *
 * A Redis command that hangs must not hold an authentication request open: the cache is an
 * optimisation, so exceeding this window is treated exactly like a miss. The handlers are attached
 * to `work` immediately, so a reply that arrives after the timeout is consumed rather than surfacing
 * as an unhandled rejection.
 */
function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('cache_command_timed_out'));
    }, milliseconds);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('cache_command_failed'));
      },
    );
  });
}

/**
 * The cached entry, or `null` for anything that is not one: a miss, a value that is not JSON, and a
 * payload of the wrong shape are all treated the same way, so a stale or hand-written key can never
 * authenticate a request through a partial parse.
 */
function parseCachedSession(raw: string | null): CachedSession | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { userId, role, ageConfirmed } = parsed as Record<string, unknown>;
  if (typeof userId !== 'string' || typeof ageConfirmed !== 'boolean') return null;

  const parsedRole = UserRole.safeParse(role);
  if (!parsedRole.success) return null;

  return { userId, role: parsedRole.data, ageConfirmed };
}

/** The cached entry for a session, or `null` on a miss, an error or a slow reply. */
async function readCachedSession(
  services: AuthServices,
  sessionId: string,
): Promise<CachedSession | null> {
  try {
    const raw = await withTimeout(
      services.redis.client.get(sessionCacheKey(sessionId)),
      CACHE_COMMAND_TIMEOUT_MS,
    );
    return parseCachedSession(raw);
  } catch {
    return null;
  }
}

/**
 * Caches a session that PostgreSQL just confirmed, for {@link SESSION_CACHE_SECONDS}.
 *
 * Fire-and-forget, and deliberately so: the request has already been authenticated by the row this
 * entry is a copy of, so a write that fails or is slow costs the next request one database read and
 * nothing else. Returns `void` rather than a promise, which is why a caller cannot accidentally
 * await it, and the shape written is exactly the one {@link parseCachedSession} accepts — never an
 * email address, a refresh token or a session expiry.
 */
function writeCachedSession(
  services: AuthServices,
  sessionId: string,
  session: CachedSession,
): void {
  const key = sessionCacheKey(sessionId);
  const payload = JSON.stringify(session);

  void withTimeout(
    services.redis.client.set(key, payload, 'PX', SESSION_CACHE_SECONDS * 1000),
    CACHE_COMMAND_TIMEOUT_MS,
  ).catch(() => {
    // Nothing to report and nothing to retry: the entry is an optimisation with a 30-second life.
  });
}

/**
 * Resolves verified claims to a live session.
 *
 * The cache is tried first and PostgreSQL second, on a miss, on any cache error and on any timeout.
 * A row is accepted only when it exists, belongs to the token's `sub`, is neither revoked nor
 * expired by the injected clock, and its account has neither requested deletion nor been deleted:
 * the same four checks the cache entry was built from, which is why a cached hit needs only the
 * ownership test. `role` and `ageConfirmed` come from the row, so a promotion that revoked sessions
 * and a consent that was recorded are both seen at once.
 *
 * @throws AppError `token_invalid` for every refusal. A database failure is not one of them: it is
 *   rethrown, so an outage answers `500` rather than telling a signed-in caller their token is bad.
 */
async function resolveSession(
  services: AuthServices,
  claims: AccessTokenClaims,
): Promise<AuthContext> {
  const cached = await readCachedSession(services, claims.sid);
  if (cached !== null && cached.userId === claims.sub) {
    return {
      userId: cached.userId,
      role: cached.role,
      sessionId: claims.sid,
      ageConfirmed: cached.ageConfirmed,
    };
  }

  const row = await services.db.session.findUnique({
    where: { id: claims.sid },
    select: {
      userId: true,
      revokedAt: true,
      expiresAt: true,
      user: {
        select: {
          role: true,
          ageConfirmedAt: true,
          termsVersion: true,
          deletionRequestedAt: true,
          deletedAt: true,
        },
      },
    },
  });

  const now = services.clock.now();
  if (
    row === null ||
    row.userId !== claims.sub ||
    row.revokedAt !== null ||
    row.expiresAt.getTime() <= now.getTime() ||
    row.user.deletionRequestedAt !== null ||
    row.user.deletedAt !== null
  ) {
    throw new AppError('token_invalid');
  }

  const context: AuthContext = {
    userId: row.userId,
    role: row.user.role,
    sessionId: claims.sid,
    ageConfirmed: row.user.ageConfirmedAt !== null && row.user.termsVersion !== null,
  };
  writeCachedSession(services, claims.sid, {
    userId: context.userId,
    role: context.role,
    ageConfirmed: context.ageConfirmed,
  });

  return context;
}

/**
 * Drops the cache entries of the named sessions, after the transaction that revoked them committed.
 *
 * A drop that fails is logged and swallowed: the entries expire within {@link SESSION_CACHE_SECONDS}
 * on their own, and no write can ride a cached entry, because every write runs behind
 * {@link assertWritable}. Callers are `modules/auth/sessions.ts` on logout and on a refresh-reuse
 * revocation, `me/consents.ts` once consents are recorded (so the age gate opens at once),
 * `scripts/grant-operator.ts`, and `messaging/pubsub.ts` when another instance publishes an
 * invalidation.
 *
 * @param services - The Redis connection and the logger.
 * @param sessionIds - The sessions to forget; an empty list is a no-op, which keeps the command
 *   valid (`DEL` needs at least one key).
 */
export async function dropCachedSessions(
  services: Pick<AuthServices, 'redis' | 'logger'>,
  sessionIds: readonly string[],
): Promise<void> {
  if (sessionIds.length === 0) return;

  try {
    await withTimeout(
      services.redis.client.del(...sessionIds.map(sessionCacheKey)),
      CACHE_COMMAND_TIMEOUT_MS,
    );
  } catch {
    services.logger.warn({ event: 'session_cache_drop_failed' }, 'session_cache_drop_failed');
  }
}

/**
 * Drops the cache entries of a user's sessions and tells every API instance to close their sockets.
 *
 * The whole-account form: the frame it publishes names no session, so every instance closes every
 * socket of the user rather than the sockets of one session. Its callers are the paths that end all
 * of the account's authority at once — `DELETE /me` in `modules/me/deletion.ts` and the
 * reuse-detection revocation in `modules/auth/sessions.ts`; {@link invalidateSession} is the
 * one-session form.
 *
 * Called only after the transaction that revoked the sessions committed, so an instance can never be
 * told to drop a session that a rollback kept. The publish is what reaches the instances that do not
 * hold the user's cache entries, and a failure to publish is logged and swallowed for the same reason
 * a failed drop is: it costs at most {@link SESSION_CACHE_SECONDS} of read-only staleness, and it can
 * never let a write through.
 *
 * @param services - The Redis connection, the logger and the pub/sub publisher.
 * @param userId - The account whose sessions ended; the frame is published on its own channel.
 * @param sessionIds - The revoked sessions whose cache entries are dropped first.
 * @see AAP 0.3.2 for the invalidation frame, 0.5.3 for the write fence that makes it sufficient.
 */
export async function invalidateUserSessions(
  services: Pick<AuthServices, 'redis' | 'logger' | 'pubsub'>,
  userId: string,
  sessionIds: readonly string[],
): Promise<void> {
  await dropCachedSessions(services, sessionIds);

  try {
    await withTimeout(
      services.pubsub.publishUser(userId, SESSION_INVALIDATION_FRAME),
      INVALIDATION_PUBLISH_TIMEOUT_MS,
    );
  } catch {
    services.logger.warn(
      { event: 'session_invalidation_publish_failed' },
      'session_invalidation_publish_failed',
    );
  }
}

/**
 * Ends one session for every API instance at once: the invalidation `POST /auth/logout` publishes.
 *
 * The one-session form of {@link invalidateUserSessions}, for the write that ends a single session
 * while the account keeps its others: the cache entry of that session is dropped and the
 * `{ type: 'invalidate' }` frame naming it is published on the user's channel, so every API instance
 * closes the sockets that session was admitted with — the socket the caller is most likely still
 * holding, on whichever instance admitted it — and every other session and socket of the account is
 * left alone. The closed sockets are ended with `WS_CLOSE.invalidated` (AAP 0.5.3).
 *
 * Called only after the transaction that revoked the session committed, and a failure to publish is
 * logged and swallowed for the same reason as in {@link invalidateUserSessions}: it costs at most
 * {@link SESSION_CACHE_SECONDS} of read-only staleness, and a write can never ride a cached session,
 * because every write re-reads its own session behind the fence.
 *
 * @param services - The Redis connection, the logger and the pub/sub publisher.
 * @param userId - The account whose channel carries the frame.
 * @param sessionId - The session that ended, and the only sockets the frame closes.
 * @see AAP 0.5.3 for the invalidation and the cache's read-only role, 0.5.4 for the logout route.
 */
export async function invalidateSession(
  services: Pick<AuthServices, 'redis' | 'logger' | 'pubsub'>,
  userId: string,
  sessionId: string,
): Promise<void> {
  await dropCachedSessions(services, [sessionId]);

  try {
    await withTimeout(
      services.pubsub.publishUser(userId, { type: 'invalidate', sessionIds: [sessionId] }),
      INVALIDATION_PUBLISH_TIMEOUT_MS,
    );
  } catch {
    services.logger.warn(
      { event: 'session_invalidation_publish_failed' },
      'session_invalidation_publish_failed',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Registration and the guards (AAP 0.3.2, 0.5.4)
// ---------------------------------------------------------------------------------------------

/**
 * Registers the request decorator the guards write to and nothing else.
 *
 * No global `onRequest` hook is added here, and that is the invariant this function exists to keep:
 * `app.addHook('onRequest', requireTraveler)` is called by a route group inside its own plugin, so
 * the age gate covers the traveler feature routes and the guarded routes outside them — `GET /me`,
 * `POST /me/consents`, the public routes, the provider webhooks, the console routes and
 * `/admin/*` — never inherit it (AAP 0.5.4). The container is optional and unused: it is accepted
 * for the shape the composition root registers every plugin with, while the guards read the running
 * instance's services, so nothing is captured per registration and two apps in one process (a test
 * harness beside the app) stay independent.
 */
export function registerAuth(app: AuthHost, _services?: AuthServices): void {
  app.decorateRequest('auth', null);
}

/**
 * The instance's services, as the guards read them.
 *
 * One narrowing accessor rather than a `request.server.services` read at each call site: the
 * declaration that types `services` on the instance belongs to the plugin that decorates it, and
 * this module needs only the capabilities in {@link AuthServices}. The cast is the same shape the
 * property has at runtime.
 */
function authServicesOf(request: FastifyRequest): AuthServices {
  return (request.server as unknown as { readonly services: AuthServices }).services;
}

/**
 * Ends a request with `code`, after one `auth_rejected` line carrying the reason and nothing else.
 *
 * The reason travels under `guardReason`, not `reason`: the logger's redaction list censors `reason`
 * (a dispute's or a report's free text), and a code that has to be read back is logged under a name
 * the list does not cover (AAP 0.11.1).
 */
function refuse(request: FastifyRequest, reason: AuthRejectionReason, code: ErrorCode): never {
  request.log.info({ event: 'auth_rejected', guardReason: reason }, 'auth_rejected');
  throw new AppError(code);
}

/**
 * The token an `Authorization: Bearer <token>` header carries, or `null` when there is no usable one
 * — absent, a different scheme, or a value that is not the shape of a compact JWS.
 */
function bearerFromAuthorization(header: string | undefined): string | null {
  if (header === undefined) return null;

  const match = BEARER_HEADER_RE.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * The token a browser offered as the chat socket's subprotocol entry, or `null`.
 *
 * A browser `WebSocket` cannot set an `Authorization` header, so the client opens the socket as
 * `new WebSocket(url, ['bearer', accessToken])` and the token arrives inside the
 * `Sec-WebSocket-Protocol` header (AAP 0.3.3). Node presents a repeated header as an array, which is
 * joined back into the list `plugins/websocket.ts` parses; the header itself is never logged.
 */
function bearerFromSubprotocolHeader(request: FastifyRequest): string | null {
  const header: string | string[] | undefined = request.headers['sec-websocket-protocol'];
  const offered = Array.isArray(header) ? header.join(', ') : header;

  return bearerTokenFromProtocolHeader(offered);
}

/**
 * Authenticates one request: verify the token, resolve its session, and record the result on
 * `request.auth`.
 *
 * The three failure kinds are kept apart for the log alone — a missing token, a token that does not
 * verify, and a token whose session is gone all answer the same `401 token_invalid`. A failure that
 * is not `token_invalid` is rethrown rather than answered as an authentication failure: a database
 * outage reaches the error handler as an unexpected error, so a signed-in caller is never told their
 * token is bad because PostgreSQL was unreachable.
 */
async function authenticate(request: FastifyRequest, token: string | null): Promise<AuthContext> {
  if (token === null) {
    refuse(request, 'missing', 'token_invalid');
  }

  const services = authServicesOf(request);

  let claims: AccessTokenClaims;
  try {
    claims = await verifyAccessToken(services, token);
  } catch (error) {
    if (isAppError(error) && error.code === 'token_invalid') {
      refuse(request, 'invalid', 'token_invalid');
    }
    throw error;
  }

  let context: AuthContext;
  try {
    context = await resolveSession(services, claims);
  } catch (error) {
    if (isAppError(error) && error.code === 'token_invalid') {
      refuse(request, 'session', 'token_invalid');
    }
    throw error;
  }

  request.auth = context;
  return context;
}

/**
 * Admits a caller with any valid session, age gate included or not.
 *
 * For the four bearer routes a new account needs before the gate can open: `GET /me`,
 * `POST /me/consents`, `POST /auth/logout` and `DELETE /me`. `request.auth` is set for the handler.
 *
 * @throws AppError `token_invalid` (401) when the token is missing, invalid or its session is gone.
 * @see AAP 0.5.4.
 */
export async function requireBearer(request: FastifyRequest): Promise<void> {
  await authenticate(request, bearerFromAuthorization(request.headers.authorization));
}

/**
 * Admits a caller who has passed the age gate, for every traveler feature route.
 *
 * @throws AppError `token_invalid` (401) as {@link requireBearer} does, and `age_gate_required`
 *   (403) once the session is valid but the 18+ confirmation and the terms version are not both
 *   recorded. The client routes to the age gate on that code.
 * @see AAP 0.3.2, 0.5.4, 0.5.8.
 */
export async function requireTraveler(request: FastifyRequest): Promise<void> {
  const context = await authenticate(
    request,
    bearerFromAuthorization(request.headers.authorization),
  );

  if (!context.ageConfirmed) {
    refuse(request, 'age_gate', 'age_gate_required');
  }
}

/**
 * Admits an operator, for `/v1/admin/*`.
 *
 * No age gate: an operator is an internal account, and the role is read from the user row rather
 * than from the token's claim, so revoking the sessions of a demoted operator takes effect at once.
 *
 * @throws AppError `token_invalid` (401) as {@link requireBearer} does, and `operator_only` (403)
 *   for a valid session whose account is a traveler.
 * @see AAP 0.3.3, 0.5.4.
 */
export async function requireOperator(request: FastifyRequest): Promise<void> {
  const context = await authenticate(
    request,
    bearerFromAuthorization(request.headers.authorization),
  );

  if (context.role !== 'operator') {
    refuse(request, 'role', 'operator_only');
  }
}

/**
 * Admits a chat-socket upgrade, taking the token from the subprotocol header.
 *
 * Used as an `onRequest` (or `preValidation`) hook on `WS /v1/chat`, which runs before
 * `@fastify/websocket` hijacks the connection: a refusal is therefore answered as plain HTTP 401
 * through the error handler, on a connection that is never upgraded. The age gate applies here as it
 * does on the traveler REST routes.
 *
 * @throws AppError `token_invalid` (401) and `age_gate_required` (403), as {@link requireTraveler}.
 * @see AAP 0.3.3, 0.5.4.
 */
export async function requireWebSocketBearer(request: FastifyRequest): Promise<void> {
  const context = await authenticate(request, bearerFromSubprotocolHeader(request));

  if (!context.ageConfirmed) {
    refuse(request, 'age_gate', 'age_gate_required');
  }
}

// ---------------------------------------------------------------------------------------------
// The account-deletion write fence (AAP 0.5.3)
// ---------------------------------------------------------------------------------------------

/**
 * Refuses a write by an account that has requested deletion or has been deleted.
 *
 * **Called first inside the transaction**, before any write: by `transact(services, fn,
 * { fenceUserId })` in `modules/outbox/write.ts`, by every mutating handler, by the two
 * state-writing reads (`GET /meetups/:id` and `GET /meetups/:id/suggestions`) and by every
 * WebSocket write. It takes `SELECT ... FOR SHARE` on the acting user's row, and `DELETE /me` takes
 * `FOR UPDATE` on that same row, which orders the two: a mutation already in flight holds its share
 * lock, so the deletion waits for it to commit and erases what it wrote; any mutation starting later
 * waits for the deletion, then reads the flag and is refused. Nothing the erased account wrote can be
 * recreated, and `account-erasure` runs only after the deletion committed.
 *
 * The check reads PostgreSQL, never the session cache: the cache may lag a revocation by up to
 * {@link SESSION_CACHE_SECONDS}, which is tolerable for a read and not for a write. It is spelled as
 * raw SQL because the row lock has no Prisma client equivalent, and `"user"` is quoted because it is
 * a reserved word.
 *
 * @param tx - The caller's open transaction.
 * @param userId - The acting user, whose row is locked for the rest of the transaction.
 * @throws AppError `token_invalid` (401) when no such user row exists — an id nothing holds, or a
 *   tombstone the financial purge has removed — and when either deletion column is set.
 * @see AAP 0.5.2 for what erasure removes, 0.11.2 for the parameterized-SQL rule.
 */
export async function assertWritable(tx: DbTx, userId: string): Promise<void> {
  const rows = await tx.$queryRaw<
    { deletion_requested_at: Date | null; deleted_at: Date | null }[]
  >(Prisma.sql`
    SELECT "deletion_requested_at", "deleted_at"
      FROM "user"
     WHERE "id" = ${userId}::uuid
       FOR SHARE
  `);

  const row = rows[0];
  if (row === undefined || row.deletion_requested_at !== null || row.deleted_at !== null) {
    throw new AppError('token_invalid');
  }
}

/**
 * Refuses a write authenticated with a session that is no longer live, re-read from PostgreSQL.
 *
 * **Called first inside the transaction of every WebSocket write**, before any other check: a chat
 * socket is authenticated once, at its upgrade, and kept alive by its heartbeat for as long as the
 * client answers, so the session behind it can end long after the handshake admitted it — `POST
 * /auth/logout` and `DELETE /me` both revoke the row, and a refresh rotation revokes it too. The row
 * named by the session id the handshake carried is read here, and the write proceeds only when it
 * exists, belongs to the acting user, is unrevoked and is unexpired by the injected clock. A socket
 * the client keeps open therefore never outlives the authority it was admitted with (AAP 0.5.3).
 *
 * The row is read from PostgreSQL and never from the session cache: the cache may lag a revocation by
 * up to {@link SESSION_CACHE_SECONDS}, which is tolerable for a read and never for a write. The row
 * is not locked: {@link assertWritable} already orders this write against `DELETE /me`, and the
 * commit of the transaction that revoked the session is what this read sees.
 *
 * @param services - The injected clock, which decides expiry as it does for every other check.
 * @param tx - The caller's open transaction, so the check and the write it guards commit together.
 * @param session - The acting user and the session the write was authenticated with, taken from
 *   `request.auth` at the upgrade and carried by the socket.
 * @throws AppError `token_invalid` (401) when the row is absent, belongs to another account, is
 *   revoked or has expired by the injected clock.
 * @see AAP 0.5.3 for the cache's read-only role and the write fence, 0.5.4 for the logout route.
 */
export async function assertLiveSession(
  services: Pick<AuthServices, 'clock'>,
  tx: DbTx,
  session: { readonly userId: string; readonly sessionId: string },
): Promise<void> {
  const row = await tx.session.findUnique({
    where: { id: session.sessionId },
    select: { userId: true, revokedAt: true, expiresAt: true },
  });

  const now = services.clock.now();
  if (
    row === null ||
    row.userId !== session.userId ||
    row.revokedAt !== null ||
    row.expiresAt.getTime() <= now.getTime()
  ) {
    throw new AppError('token_invalid');
  }
}
