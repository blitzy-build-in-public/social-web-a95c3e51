/**
 * Sessions, refresh rotation with reuse detection, and logout (AAP 0.3.3, 0.5.1, 0.5.2, 0.5.4,
 * 0.11.2).
 *
 * A session row *is* the refresh token: `Session.refreshTokenHash` is the SHA-256 digest of a
 * 256-bit token from `randomToken`, and the raw token is never stored, logged or sent anywhere but to
 * the client just handed it. `Session.id` is the `sid` claim of every access token the session mints,
 * so revoking the row is what ends them. A lookup by the digest of a 256-bit random token needs no
 * constant-time comparison: guessing the digest is guessing the token.
 *
 * Rotation is the security property of AAP 0.11.2. Every refresh marks the presented row `rotatedAt`
 * and `revokedAt`, creates a new row with a new `sid`, and returns a pair signed for it alone. A
 * token presented after it was rotated away is evidence that two parties hold it, so every live
 * session of the account is revoked — the successor included — instead of issuing another pair.
 *
 * Three orderings are deliberate. The account-deletion write fence runs before any session write
 * (AAP 0.5.3) and before the session row is locked: `DELETE /me` locks the user row and only then
 * updates that account's sessions, so this file keeps that order, and the reverse one would let the
 * two transactions deadlock. Reuse is tested before revocation, because a rotated row is revoked too
 * and the reuse branch is the one that must also revoke the successor. And the reuse branch returns
 * instead of throwing, because a throw inside `transact` would roll back the revocation it wrote.
 *
 * Time comes from the injected clock alone (AAP 0.11.1). No refresh token, digest, access token or
 * `Authorization` header reaches a log line: each event below carries an `event` and a `userId`.
 */

import { Prisma, type DbTx } from '@tablemate/db';
import {
  DAY_MS,
  REFRESH_TOKEN_TTL_DAYS,
  type RefreshResponse,
  type UserRole,
} from '@tablemate/shared';
import { randomToken, sha256Hex } from '@tablemate/server-core';

import {
  assertWritable,
  dropCachedSessions,
  invalidateUserSessions,
  signAccessToken,
} from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { transact } from '../outbox/write.ts';

// Type-only, so nothing of `app.ts` is read at run time and no cycle reaches the composition root
// that declares it.
import type { AppServices } from '../../app.ts';

/** A refresh token's lifetime: 30 days, granted again on every rotation (AAP 0.5.2). */
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * DAY_MS;

/**
 * The session row the rotation path acts on, as the locking read returns it.
 *
 * `created_at` is deliberately absent: no rule reads it, and these three columns are the facts the
 * decision below is made from.
 */
interface LockedSessionRow {
  readonly id: string;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly rotated_at: Date | null;
}

/** What {@link refresh} decided, known once its transaction has committed. */
type RefreshOutcome =
  | { readonly kind: 'reuse'; readonly userId: string; readonly sessionIds: readonly string[] }
  | {
      readonly kind: 'rotated';
      readonly userId: string;
      readonly role: UserRole;
      readonly sessionId: string;
      readonly refreshToken: string;
    };

/**
 * Creates one session row inside the caller's transaction (AAP 0.5.2).
 *
 * The row holds the digest of a fresh 32-byte token and an expiry 30 days beyond the injected clock,
 * so every rotation grants a fresh 30 days. It never opens a transaction of its own: account creation
 * and rotation both call it inside the transaction that decides them, so the session commits or rolls
 * back with the change it belongs to.
 *
 * @param tx - The caller's open transaction, from `transact` or `db.$transaction`.
 * @param services - The injected clock, which fixes `expiresAt`.
 * @param userId - The account the session belongs to.
 * @param opts - `previousRefreshTokenHash` records a rotation's lineage; reuse detection never reads
 *   it.
 * @returns The new session's id — its `sid` — and the raw refresh token, which exists only here.
 */
export async function createSession(
  tx: DbTx,
  services: Pick<AppServices, 'clock'>,
  userId: string,
  opts?: { readonly previousRefreshTokenHash?: string },
): Promise<{ sessionId: string; refreshToken: string }> {
  const refreshToken = randomToken();
  const expiresAt = new Date(services.clock.nowMs() + REFRESH_TOKEN_TTL_MS);

  const row = await tx.session.create({
    data: {
      userId,
      refreshTokenHash: sha256Hex(refreshToken),
      expiresAt,
      // Spread rather than passed as `undefined`: `exactOptionalPropertyTypes` refuses an absent
      // value written into a column the caller did not give.
      ...(opts?.previousRefreshTokenHash === undefined
        ? {}
        : { previousRefreshTokenHash: opts.previousRefreshTokenHash }),
    },
    select: { id: true },
  });

  return { sessionId: row.id, refreshToken };
}

/**
 * Mints the pair a verified caller receives: a 15-minute access token for the session, and the
 * refresh token that session was created with (AAP 0.3.3, 0.5.4).
 *
 * Called only after the creating transaction committed, so no token is handed out for a session a
 * rollback discarded. The raw token is an argument rather than a re-read, because the row holds only
 * its digest — hence this departure from the plan's `{ userId, role, sessionId }` form.
 *
 * @param services - The signing secret and the injected clock.
 * @param tokens - The account, its role, the session the token names, and the token to return.
 * @returns The response body of `POST /auth/verify` and `POST /auth/refresh`.
 */
export async function issueTokens(
  services: Pick<AppServices, 'env' | 'clock'>,
  tokens: {
    readonly userId: string;
    readonly role: UserRole;
    readonly sessionId: string;
    readonly refreshToken: string;
  },
): Promise<RefreshResponse> {
  const accessToken = await signAccessToken(services, {
    sub: tokens.userId,
    role: tokens.role,
    sid: tokens.sessionId,
  });

  return { accessToken, refreshToken: tokens.refreshToken };
}

/**
 * Rotates a refresh token, or refuses it (AAP 0.5.4, 0.11.2).
 *
 * The digest resolves the account, whose row is share-locked for the fence; the session row is locked
 * after it and the decision is made from that locked row, so two concurrent refreshes of one token
 * are serialized — the second waits, sees `rotatedAt` and is treated as reuse. Clients must refresh
 * single-flight; `apps/mobile/src/auth/session.ts` does.
 *
 * A session that was logged out, revoked by `DELETE /me` or expired is refused on its own. A rotated
 * token is not: it proves the token was copied, so every live session of the account is revoked in
 * the same transaction, its cache entries are dropped and the invalidation published after the
 * commit, and the call is then refused.
 *
 * @param services - The database client, clock, logger, outbox, environment and pub/sub of the app.
 * @param refreshToken - The token as `POST /auth/refresh` received it.
 * @returns The rotated pair for a valid token.
 * @throws AppError `token_invalid` (401) for an unknown, rotated, revoked or expired token, and for
 *   an account that has requested deletion or been deleted. Reuse is refused with that same code.
 * @see AAP 0.5.3 for the write fence, 0.11.2 for rotation with reuse detection.
 */
export async function refresh(
  services: AppServices,
  refreshToken: string,
): Promise<RefreshResponse> {
  const presentedHash = sha256Hex(refreshToken);

  const outcome = await transact(services, async (tx, after): Promise<RefreshOutcome> => {
    const now = services.clock.now();

    // Resolve the account first, unlocked: the fence needs a user id, and locking the session row
    // before the user row would invert `DELETE /me`'s lock order (see the module header).
    const presented = await tx.session.findUnique({
      where: { refreshTokenHash: presentedHash },
      select: { userId: true },
    });
    if (presented === null) throw new AppError('token_invalid');

    const userId = presented.userId;
    await assertWritable(tx, userId);

    const rows = await tx.$queryRaw<LockedSessionRow[]>(Prisma.sql`
      SELECT "id"::text AS "id", "expires_at", "revoked_at", "rotated_at"
        FROM "session"
       WHERE "refresh_token_hash" = ${presentedHash}
         FOR UPDATE
    `);
    const locked = rows[0];
    if (locked === undefined) throw new AppError('token_invalid');

    // Before the revocation check, never after: a rotated row is revoked too, and this is the branch
    // that must revoke the successor session the rotation created.
    if (locked.rotated_at !== null) {
      const revoked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "session" SET "revoked_at" = ${now}
         WHERE "user_id" = ${userId}::uuid AND "revoked_at" IS NULL
        RETURNING "id"::text AS "id"
      `);

      // Returned rather than thrown: a throw here would roll back the revocation above.
      return { kind: 'reuse', userId, sessionIds: revoked.map((row) => row.id) };
    }

    if (locked.revoked_at !== null || locked.expires_at.getTime() <= now.getTime()) {
      throw new AppError('token_invalid');
    }

    const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (user === null) throw new AppError('token_invalid');

    await tx.session.update({ where: { id: locked.id }, data: { rotatedAt: now, revokedAt: now } });

    const session = await createSession(tx, services, userId, {
      previousRefreshTokenHash: presentedHash,
    });

    // The old `sid` is dead the moment this commits, so its 30-second cache entry goes with it.
    after(() => dropCachedSessions(services, [locked.id]));

    return {
      kind: 'rotated',
      userId,
      role: user.role,
      sessionId: session.sessionId,
      refreshToken: session.refreshToken,
    };
  });

  if (outcome.kind === 'reuse') {
    // After the commit, so every instance drops its cache entries for the revoked sessions and closes
    // that account's sockets (AAP 0.3.2, 0.5.3).
    await invalidateUserSessions(services, outcome.userId, outcome.sessionIds);
    services.logger.warn(
      { event: 'refresh_reuse_detected', userId: outcome.userId },
      'refresh_reuse_detected',
    );
    throw new AppError('token_invalid');
  }

  services.logger.info({ event: 'refresh_rotated', userId: outcome.userId }, 'refresh_rotated');

  return issueTokens(services, {
    userId: outcome.userId,
    role: outcome.role,
    sessionId: outcome.sessionId,
    refreshToken: outcome.refreshToken,
  });
}

/**
 * Ends one session: `POST /v1/auth/logout` (AAP 0.5.4).
 *
 * The session the caller's access token names is revoked, and only when it belongs to the caller, so
 * no request can end another account's session. Idempotent — an already-revoked session matches
 * nothing and the call still succeeds — and it runs behind the account-deletion write fence, so a
 * token whose account asked for deletion is refused with the same `401 token_invalid` every other
 * mutation answers (AAP 0.5.3).
 *
 * @param services - The database client, clock, logger, outbox and Redis of the app.
 * @param session - `userId` and `sessionId` from `request.auth`, filled by the bearer guard.
 * @throws AppError `token_invalid` (401) when the account has requested deletion or was deleted.
 */
export async function logout(
  services: AppServices,
  session: { readonly userId: string; readonly sessionId: string },
): Promise<void> {
  await transact(
    services,
    async (tx, after) => {
      const now = services.clock.now();

      await tx.session.updateMany({
        where: { id: session.sessionId, userId: session.userId, revokedAt: null },
        data: { revokedAt: now },
      });

      after(() => dropCachedSessions(services, [session.sessionId]));
    },
    { fenceUserId: session.userId },
  );

  services.logger.info({ event: 'logout', userId: session.userId }, 'logout');
}
