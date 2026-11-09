/**
 * Sessions, refresh rotation with reuse detection, and logout.
 *
 * A session row *is* the refresh token: only its SHA-256 digest is stored, and `Session.id` is the `sid` claim of
 * every access token the session mints, so revoking the row is what ends them. Rotation marks the presented row
 * `rotatedAt` and `revokedAt` and mints a fresh row; a token presented after it was rotated away is evidence that
 * two parties hold it, so every live session of the account is revoked, the successor included.
 *
 * Three orderings are deliberate: the account-deletion write fence runs before any session write and before the
 * session row is locked, the order `DELETE /me` uses, because the reverse one would deadlock; reuse is tested before
 * revocation, since a rotated row is revoked too and the reuse branch is the one that must also revoke the successor;
 * and the reuse branch returns instead of throwing, because a throw inside `transact` would roll back the revocation
 * it wrote.
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
  invalidateSession,
  invalidateUserSessions,
  signAccessToken,
} from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { transact } from '../outbox/write.ts';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { AppServices } from '../../app.ts';

/** A refresh token's lifetime: 30 days, granted again on every rotation. */
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * DAY_MS;

/** The session row the rotation path acts on; `created_at` is deliberately absent, because no rule reads it. */
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
 * Creates one session row inside the caller's transaction: the digest of a fresh 32-byte token and an expiry 30 days
 * beyond the injected clock, so every rotation grants a fresh 30 days. It opens no transaction of its own, so the
 * session commits or rolls back with the change it belongs to.
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
      // Spread rather than passed as `undefined`: `exactOptionalPropertyTypes` refuses an absent value.
      ...(opts?.previousRefreshTokenHash === undefined
        ? {}
        : { previousRefreshTokenHash: opts.previousRefreshTokenHash }),
    },
    select: { id: true },
  });
  return { sessionId: row.id, refreshToken };
}

/**
 * Mints the pair a verified caller receives: a 15-minute access token for the session, and the raw refresh token that
 * session was created with, which the row holds only as a digest — hence this departure from the plan's
 * `{ userId, role, sessionId }` form.
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
 * Rotates a refresh token, or refuses it.
 *
 * The digest resolves the account, whose row is share-locked for the fence, and the session row is locked after it and
 * the decision made from that locked row, so two concurrent refreshes of one token are serialized: the second waits,
 * sees `rotatedAt` and is treated as reuse — clients must refresh single-flight. A session that was logged out, revoked
 * or expired is refused on its own; a rotated token proves it was copied, so every live session of the account is
 * revoked in the same transaction, its cache entries dropped and the invalidation published after the commit.
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
    // that account's sockets.
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
 * Ends one session: `POST /v1/auth/logout`.
 *
 * The caller's own session is revoked, so no request can end another account's session; the call is idempotent and
 * runs behind the account-deletion write fence, which refuses it with the same `401 token_invalid` every other
 * mutation answers. Revoking the row ends the session for HTTP, and the socket it may still hold is ended by
 * `invalidateSession`, which drops its cache entry and publishes the session-scoped invalidation after the commit, so
 * every API instance closes that session's sockets while the account's other sessions keep theirs.
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
      after(() => invalidateSession(services, session.userId, session.sessionId));
    },
    { fenceUserId: session.userId },
  );
  services.logger.info({ event: 'logout', userId: session.userId }, 'logout');
}
