/**
 * The consents `POST /me/consents` records: the caller's 18+ confirmation and the terms version it was
 * accepted under (AAP 0.5.1, 0.5.4, 0.5.8). The two writes commit in one fenced transaction, which
 * refuses the whole call with `401 token_invalid` once `DELETE /me` has been requested (AAP 0.3.2,
 * 0.5.3).
 */
import type { ConsentsRequest } from '@tablemate/shared';

import { dropCachedSessions, type AuthContext } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { transact } from '../outbox/write.ts';

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { AppServices } from '../../app.ts';

/**
 * A version mismatch's message: the client renders its own sentence for the code, so this is constant.
 */
const STALE_TERMS_MESSAGE = 'The terms have changed. Review and accept the current version.';

/**
 * Records the caller's age confirmation and accepted terms version, and lets the age gate open: the
 * version is checked before the transaction opens, and the live sessions' cache entries are dropped
 * after it commits, so the very next request is admitted instead of waiting out `SESSION_CACHE_SECONDS`.
 */
export async function recordConsents(
  services: AppServices,
  auth: AuthContext,
  body: ConsentsRequest,
): Promise<void> {
  if (body.termsVersion !== services.env.TERMS_VERSION) {
    throw new AppError('invalid_field', STALE_TERMS_MESSAGE);
  }
  await transact(
    services,
    async (tx, after) => {
      const now = services.clock.now();
      // Unconditional: an account that accepts a revised version is recorded against the revision it saw.
      await tx.user.updateMany({
        where: { id: auth.userId },
        data: { termsVersion: body.termsVersion },
      });
      // Conditional on the column still being `NULL`, so the first confirmation and its timestamp
      // survive every later acceptance.
      await tx.user.updateMany({
        where: { id: auth.userId, ageConfirmedAt: null },
        data: { ageConfirmedAt: now },
      });
      const sessions = await tx.session.findMany({
        where: { userId: auth.userId, revokedAt: null, expiresAt: { gt: now } },
        select: { id: true },
      });
      const sessionIds = sessions.map((session) => session.id);
      // After the commit and outside it: `dropCachedSessions` swallows its own failure, so a Redis
      // outage delays the gate by the cache TTL instead of failing this call (AAP 0.3.2).
      after(() => dropCachedSessions(services, sessionIds));
    },
    { fenceUserId: auth.userId },
  );
  services.logger.info(
    { event: 'consents_recorded', userId: auth.userId, termsVersion: body.termsVersion },
    'consents_recorded',
  );
}
