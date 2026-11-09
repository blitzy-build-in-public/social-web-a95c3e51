/**
 * Authentication for the API: the access token, the route-group guards, the Redis session cache and the
 * account-deletion write fence.
 * - **The access token.** {@link signAccessToken} and {@link verifyAccessToken} write and read the 15-minute HS256 JWT,
 *   whose claims are exactly `sub`, `role`, `sid` (plus `iat` and `exp`). No email address, handle or other profile field
 *   enters a token, and verification reads the injected clock, so a test that advances the clock past 15 minutes expires a
 *   token the way real time would.
 * - **The guards.** {@link requireBearer}, {@link requireTraveler}, {@link requireOperator} and
 *   {@link requireWebSocketBearer} are exported hooks, deliberately not a global `onRequest` hook: a route group installs
 *   the one it needs, which keeps the age gate on the traveler feature routes and off `GET /me`, `POST /me/consents`,
 *   `POST /auth/logout`, `DELETE /me`, the public routes, the provider webhooks, the console routes, `/admin/*` and the
 *   test-control routes, so a route outside those groups cannot inherit the gate by accident.
 * - **The session cache.** `auth:session:<sid>` in Redis for 30 seconds, holding the user id, the role and the age gate and
 *   never an email address or a token. A miss, an error and a slow reply all fall through to PostgreSQL, so a Redis outage
 *   slows authentication without failing it, and a cached entry can never authorise a write, because every write runs
 *   behind the fence.
 * - **The fence.** {@link assertWritable} takes `SELECT ... FOR SHARE` on the acting user's row inside the caller's
 *   transaction and refuses with `401 token_invalid` once `deletion_requested_at` or `deleted_at` is set. {@link isWritable}
 *   is the same statement as a predicate, for the one mutating path whose refusal must not be visible to its caller.
 *   `DELETE /me` takes `FOR UPDATE` on the same row, so a mutation already in flight commits before the deletion and every
 *   mutation starting later is refused. Both read PostgreSQL, never the cache.
 * - **The invalidation.** {@link dropCachedSessions}, {@link invalidateSession} and {@link invalidateUserSessions} make the
 *   two writes above visible at once: the last two also publish the `{ type: 'invalidate' }` control frame naming the
 *   session or account that ended, so every API instance closes the sockets it was admitted with. All three are called
 *   after the revoking transaction commits.
 * Nothing in this module logs a token, an email address, an `Authorization` header or a `Sec-WebSocket-Protocol` header: a
 * refusal writes one `auth_rejected` line carrying its reason under `guardReason` and nothing else.
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

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/**
 * What a request is authenticated as. `role` and `ageConfirmed` are read from the user row — directly, or from the cache
 * entry a previous request wrote from that row — and never from the token's `role` claim alone: the claim says which session
 * was minted, while the row says what the account is now.
 */
export interface AuthContext {
  readonly userId: string;
  readonly role: UserRole;
  readonly sessionId: string;
  readonly ageConfirmed: boolean;
}

/**
 * The two dependencies the token helpers read. Narrowed deliberately: a script (`bench-verify.ts`, `perf-seed.ts`) and
 * `test/support/factories.ts` sign tokens without building the app's whole container, and a guard needs no capability a token
 * does not.
 */
export type TokenServices = {
  readonly env: Pick<ApiEnv, 'JWT_SECRET'>;
  readonly clock: Clock;
};

/**
 * The Redis commands the session cache uses, spelled out instead of imported so the module names the three capabilities it
 * depends on rather than the whole ioredis surface. `set` names the `PX` form, which is the one the cache writes with.
 */
export interface SessionCacheCommands {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, marker: 'PX', milliseconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

/**
 * The control frame published when a session ends for every instance at once. It is never sent to a client: every API
 * instance subscribed to the user's channel reads it and closes the sockets it names with `WS_CLOSE.invalidated` — the
 * sockets of the sessions in `sessionIds`, or every socket of the user when it names none.
 */
export interface SessionInvalidationFrame {
  readonly type: 'invalidate';
  readonly sessionIds?: string[];
}

export const SESSION_INVALIDATION_FRAME: SessionInvalidationFrame = Object.freeze({
  type: 'invalidate',
} as const);

/** The Redis pub/sub surface the invalidation is published through: the channel is `userChannel(userId)`, which the
 * publisher names, so no channel string is built here. */
export interface SessionPubSub {
  publishUser(userId: string, frame: SessionInvalidationFrame): Promise<unknown>;
}

/**
 * The one instance method {@link registerAuth} calls. Typed structurally instead of as the app's own `App`, so this plugin
 * reads no other module of the API: its imports are its two sibling plugins and the shared packages, which lets it compile on
 * its own and cannot create a cycle with the bootstrap that calls it.
 */
export type AuthHost = {
  decorateRequest(name: string, value: unknown): unknown;
};

/**
 * What the guards read off the running instance, narrowed to the capabilities this module uses: a `Pick`-shaped member set
 * is satisfied structurally by the app's own services type, while a test stays free to stand a double in for one capability.
 */
export interface AuthServices {
  readonly db: Pick<DbClient, 'session'>;
  readonly redis: { readonly client: SessionCacheCommands };
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly clock: Clock;
  readonly env: Pick<ApiEnv, 'JWT_SECRET'>;
  readonly pubsub: SessionPubSub;
}

/**
 * Why a guard refused a request, as the `auth_rejected` line's `guardReason` records it: `missing` for an absent or unusable
 * `Authorization` header, `invalid` for a token that fails signature, lifetime or shape, `session` for a token whose session
 * is unknown, revoked, expired or deleted, `age_gate` for an account that has not recorded the 18+ confirmation, and `role`
 * for a traveler reaching an operator route. Never a value the caller supplied.
 */
export type AuthRejectionReason = 'missing' | 'invalid' | 'session' | 'age_gate' | 'role';

interface CachedSession {
  readonly userId: string;
  readonly role: UserRole;
  readonly ageConfirmed: boolean;
}

const SESSION_CACHE_KEY_PREFIX = 'auth:session:';

/**
 * How long a cache command may take. ioredis' own `commandTimeout` on a `client`-role connection is 5 seconds, far longer
 * than an authentication may wait: a reply that has not arrived in this window sends the request to PostgreSQL instead.
 */
const CACHE_COMMAND_TIMEOUT_MS = 250;

const INVALIDATION_PUBLISH_TIMEOUT_MS = 1000;

const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TOKEN_TTL_MINUTES * 60;

/** The longest token that is even looked at: the bound keeps an absurd header from reaching the verifier at all. */
const MAX_TOKEN_CHARS = 4096;

/** The `Bearer <token>` form the `Authorization` header must have; the scheme is case-insensitive. */
const BEARER_HEADER_RE = /^Bearer ([A-Za-z0-9._-]+)$/i;

/**
 * The characters a compact JWS may consist of: base64url segments joined by `.`. Checked before a value taken from a header
 * is treated as a token, so neither a header nor a handshake can hand the JWT verifier arbitrary bytes; the signature and the
 * claims are still what authenticate a caller. The same shape `plugins/websocket.ts` uses for the subprotocol entry.
 */
const COMPACT_JWS_RE = /^[A-Za-z0-9._-]+$/;

/** The HMAC keys already derived, by secret: the secret is fixed for the life of a process, so this holds one entry in the
 * API, the workers and a script, and a handful in a test process that builds several apps. */
const hmacKeys = new Map<string, Uint8Array>();

function hmacKey(secret: string): Uint8Array {
  const cached = hmacKeys.get(secret);
  if (cached !== undefined) return cached;
  const key = new TextEncoder().encode(secret);
  hmacKeys.set(secret, key);
  return key;
}

/**
 * Signs the access token: HS256, the claims `sub`, `role` and `sid`, an `iat` taken from the injected clock and an `exp`
 * {@link ACCESS_TOKEN_TTL_SECONDS} later. Nothing else is put in the payload — no email address, no handle, no session
 * expiry — because a token is handed to a client and read by anyone who holds it. `sessions.ts` calls this for
 * `POST /auth/verify` and `POST /auth/refresh`, and the test factories and benchmark scripts to act as a signed-in traveler.
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
 * Verifies an access token and returns its claims, with the clock passed to `jose` as `currentDate`, so expiry is measured
 * by the same injected clock everything else in the API reads. Every failure — a bad signature, an expired token, a wrong
 * algorithm, a malformed payload, a claim of the wrong shape — is the same `401 token_invalid` to the caller, so a probe
 * cannot learn which part of a token was wrong.
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
    // The verifier's own error is deliberately dropped rather than attached as a cause: it names which check failed, and the envelope answers every failure the same way.
    throw new AppError('token_invalid');
  }
  const claims = AccessTokenClaims.safeParse(payload);
  if (!claims.success) {
    throw new AppError('token_invalid');
  }
  return claims.data;
}

function sessionCacheKey(sessionId: string): string {
  return `${SESSION_CACHE_KEY_PREFIX}${sessionId}`;
}

/**
 * Settles with `work`, or rejects once `milliseconds` have passed: a Redis command that hangs must not hold an authentication
 * request open, so exceeding this window is treated exactly like a miss. The handlers are attached to `work` immediately, so a
 * reply that arrives after the timeout is consumed rather than surfacing as an unhandled rejection.
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
 * The cached entry, or `null` for anything that is not one: a miss, a value that is not JSON and a payload of the wrong shape
 * are all treated the same way, so a stale or hand-written key can never authenticate a request through a partial parse.
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
 * Caches a session that PostgreSQL just confirmed, for {@link SESSION_CACHE_SECONDS}. Fire-and-forget, and deliberately so:
 * the request has already been authenticated by the row this entry is a copy of, so a write that fails or is slow costs the
 * next request one database read and nothing else. Returns `void` rather than a promise, so a caller cannot await it, and the
 * shape written is exactly the one {@link parseCachedSession} accepts — never an email address, a refresh token or a session
 * expiry.
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
 * The cache is tried first and PostgreSQL second, on a miss, on any cache error and on any timeout. A row is accepted only
 * when it exists, belongs to the token's `sub`, is neither revoked nor expired by the injected clock, and its account has
 * neither requested deletion nor been deleted: the same four checks the cache entry was built from, which is why a cached hit
 * needs only the ownership test. `role` and `ageConfirmed` come from the row, so a promotion that revoked sessions and a
 * consent that was recorded are both seen at once.
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
 * Drops the cache entries of the named sessions, after the transaction that revoked them committed. A drop that fails is
 * logged and swallowed: the entries expire within {@link SESSION_CACHE_SECONDS} on their own, and no write can ride a cached
 * entry, because every write runs behind {@link assertWritable}. Callers are `modules/auth/sessions.ts` on logout and on a
 * refresh-reuse revocation, `me/consents.ts` once consents are recorded, `scripts/grant-operator.ts`, and
 * `messaging/pubsub.ts` when another instance publishes an invalidation.
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
 * The whole-account form: the frame it publishes names no session, so every instance closes every socket of the user rather
 * than the sockets of one session. Its callers are the paths that end all of the account's authority at once — `DELETE /me`
 * in `modules/me/deletion.ts` and the reuse-detection revocation in `modules/auth/sessions.ts`; {@link invalidateSession} is
 * the one-session form.
 * Called only after the transaction that revoked the sessions committed, so an instance can never be told to drop a session
 * that a rollback kept. A failure to publish is logged and swallowed for the same reason a failed drop is: it costs at most
 * {@link SESSION_CACHE_SECONDS} of read-only staleness, and it can never let a write through.
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
 * The one-session form of {@link invalidateUserSessions}: that session's cache entry is dropped and the
 * `{ type: 'invalidate' }` frame naming it is published on the user's channel, so every API instance closes the sockets that
 * session was admitted with and every other session and socket of the account is left alone. The closed sockets are ended
 * with `WS_CLOSE.invalidated`.
 * Called only after the transaction that revoked the session committed, and a failure to publish is logged and swallowed for
 * the same reason as in {@link invalidateUserSessions}: it costs at most {@link SESSION_CACHE_SECONDS} of read-only
 * staleness, and a write can never ride a cached session, because every write re-reads its own session behind the fence.
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

/**
 * Registers the request decorator the guards write to and nothing else.
 * No global `onRequest` hook is added here, and that is the invariant this function exists to keep:
 * `app.addHook('onRequest', requireTraveler)` is called by a route group inside its own plugin, so the age gate covers the
 * traveler feature routes and the guarded routes outside them — `GET /me`, `POST /me/consents`, the public routes, the
 * provider webhooks, the console routes and `/admin/*` — never inherit it. The container is accepted for the shape the
 * composition root registers every plugin with, while the guards read the running instance's services, so nothing is captured
 * per registration and two apps in one process stay independent.
 */
export function registerAuth(app: AuthHost, _services?: AuthServices): void {
  app.decorateRequest('auth', null);
}

/**
 * The instance's services, as the guards read them. One narrowing accessor rather than a `request.server.services` read at
 * each call site, since the declaration that types `services` on the instance belongs to the plugin that decorates it.
 */
function authServicesOf(request: FastifyRequest): AuthServices {
  return (request.server as unknown as { readonly services: AuthServices }).services;
}

/**
 * Ends a request with `code`, after one `auth_rejected` line carrying the reason and nothing else. The reason travels under
 * `guardReason`, not `reason`: the logger's redaction list censors `reason` (a dispute's or a report's free text), and a code
 * that has to be read back is logged under a name the list does not cover.
 */
function refuse(request: FastifyRequest, reason: AuthRejectionReason, code: ErrorCode): never {
  request.log.info({ event: 'auth_rejected', guardReason: reason }, 'auth_rejected');
  throw new AppError(code);
}

/** The token an `Authorization: Bearer <token>` header carries, or `null` when there is no usable one — absent, a different
 * scheme, or a value that is not the shape of a compact JWS. */
function bearerFromAuthorization(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = BEARER_HEADER_RE.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * The token a browser offered as the chat socket's subprotocol entry, or `null`.
 * A browser `WebSocket` cannot set an `Authorization` header, so the client opens the socket as
 * `new WebSocket(url, ['bearer', accessToken])` and the token arrives inside the `Sec-WebSocket-Protocol` header. Node
 * presents a repeated header as an array, which is joined back into the list `plugins/websocket.ts` parses; the header itself
 * is never logged.
 */
function bearerFromSubprotocolHeader(request: FastifyRequest): string | null {
  const header: string | string[] | undefined = request.headers['sec-websocket-protocol'];
  const offered = Array.isArray(header) ? header.join(', ') : header;
  return bearerTokenFromProtocolHeader(offered);
}

/**
 * Authenticates one request: verify the token, resolve its session, and record the result on `request.auth`.
 * The three failure kinds are kept apart for the log alone — a missing token, a token that does not verify, and a token whose
 * session is gone all answer the same `401 token_invalid`. A failure that is not `token_invalid` is rethrown rather than
 * answered as an authentication failure, so a signed-in caller is never told their token is bad because PostgreSQL was
 * unreachable.
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

/** Admits a caller with any valid session, age gate included or not: the four bearer routes a new account needs before the
 * gate can open — `GET /me`, `POST /me/consents`, `POST /auth/logout` and `DELETE /me`. */
export async function requireBearer(request: FastifyRequest): Promise<void> {
  await authenticate(request, bearerFromAuthorization(request.headers.authorization));
}

/** Admits a caller who has passed the age gate, for every traveler feature route. */
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
 * Admits an operator, for `/v1/admin/*`. No age gate: an operator is an internal account, and the role is read from the user
 * row rather than from the token's claim, so revoking the sessions of a demoted operator takes effect at once.
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
 * Used as an `onRequest` (or `preValidation`) hook on `WS /v1/chat`, which runs before `@fastify/websocket` hijacks the
 * connection: a refusal is therefore answered as plain HTTP 401 through the error handler, on a connection that is never
 * upgraded. The age gate applies here as it does on the traveler REST routes.
 */
export async function requireWebSocketBearer(request: FastifyRequest): Promise<void> {
  const context = await authenticate(request, bearerFromSubprotocolHeader(request));
  if (!context.ageConfirmed) {
    refuse(request, 'age_gate', 'age_gate_required');
  }
}

/**
 * Refuses a write by an account that has requested deletion or has been deleted.
 * **Called first inside the transaction**, before any write: by `transact(services, fn, { fenceUserId })` in
 * `modules/outbox/write.ts`, by every mutating handler, by the two state-writing reads (`GET /meetups/:id` and
 * `GET /meetups/:id/suggestions`) and by every WebSocket write. It takes `SELECT ... FOR SHARE` on the acting user's row, and
 * `DELETE /me` takes `FOR UPDATE` on that same row, which orders the two: a mutation already in flight holds its share lock,
 * so the deletion waits for it to commit and erases what it wrote; any mutation starting later waits for the deletion, then
 * reads the flag and is refused.
 * The check reads PostgreSQL, never the session cache: the cache may lag a revocation by up to
 * {@link SESSION_CACHE_SECONDS}, which is tolerable for a read and not for a write.
 */
export async function assertWritable(tx: DbTx, userId: string): Promise<void> {
  if (!(await isWritable(tx, userId))) throw new AppError('token_invalid');
}

/**
 * Whether the row this account's writes hang off is still one a mutation may write to.
 * The same statement {@link assertWritable} refuses on, as a predicate: it locks the row `FOR SHARE` for the rest of the
 * caller's transaction and answers true only when it exists and both `deletion_requested_at` and `deleted_at` are null. It
 * exists for the one mutating path whose refusal must not be visible to its caller — `requestMagicLink`, whose route answers
 * `202` for every address it accepts so accounts cannot be enumerated: a request made for an account that has requested
 * deletion is a dropped write, never a response the caller can read.
 */
export async function isWritable(tx: DbTx, userId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<
    { deletion_requested_at: Date | null; deleted_at: Date | null }[]
  >(Prisma.sql`
    SELECT "deletion_requested_at", "deleted_at"
      FROM "user"
     WHERE "id" = ${userId}::uuid
       FOR SHARE
  `);
  const row = rows[0];
  return row !== undefined && row.deletion_requested_at === null && row.deleted_at === null;
}

/**
 * Refuses a write authenticated with a session that is no longer live, re-read from PostgreSQL.
 * **Called first inside the transaction of every WebSocket write**, before any other check: a chat socket is authenticated
 * once, at its upgrade, and kept alive by its heartbeat for as long as the client answers, so the session behind it can end
 * long after the handshake admitted it — `POST /auth/logout` and `DELETE /me` both revoke the row, and a refresh rotation
 * revokes it too. The row named by the session id the handshake carried is read here, and the write proceeds only when it
 * exists, belongs to the acting user, is unrevoked and is unexpired by the injected clock.
 * The row is read from PostgreSQL and never from the session cache, which may lag a revocation by up to
 * {@link SESSION_CACHE_SECONDS}; it is not locked, because {@link assertWritable} already orders this write against
 * `DELETE /me`.
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
