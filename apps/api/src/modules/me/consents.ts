/**
 * The consents `POST /me/consents` records: the caller's 18+ confirmation and the terms version it
 * was accepted under (AAP 0.5.1, 0.5.4, 0.5.8).
 *
 * The body's `adult` is the literal `true` (`ConsentsRequest`), so an under-age submission is
 * already a `400 invalid_field` from the route's validator and nothing here re-reads it. What is
 * left to decide is whether the version the caller was shown is the version this API serves: text
 * accepted before `TERMS_VERSION` moved is not the text in force, so a stale version is
 * `400 invalid_field` too (AAP 0.5.4).
 *
 * The age gate reads two columns — `User.ageConfirmedAt` and `User.termsVersion` — and
 * `plugins/auth.ts` admits a traveler feature route only when both are set. The two writes
 * therefore commit in one fenced transaction (AAP 0.3.2, 0.5.3): the fence refuses the whole call
 * with `401 token_invalid` once `DELETE /me` has been requested, so nothing can be recorded for an
 * account on its way out. `termsVersion` follows every acceptance, so an account that accepts a
 * revised version is recorded against the revision it saw; `ageConfirmedAt` is written only while
 * it is still `NULL`, because being over 18 is a fact about the person that a second confirmation
 * cannot make truer, and the first confirmation is the one those terms were accepted under. The
 * pair is what the client reads back as `MeDto.consents`.
 *
 * The cache drop is what opens the gate at once. A request admitted a moment ago left
 * `auth:session:<sid>` in Redis holding `ageConfirmed: false` for up to 30 seconds
 * (`plugins/auth.ts`), so the live sessions' entries are deleted — but only once the transaction
 * has committed, through `after`, because Redis takes no part in the transaction and a rolled-back
 * consent must evict nothing (AAP 0.3.2). An entry that outlived the drop would cost at most those
 * 30 seconds, since the row, not the cache, is the authority.
 *
 * This file returns nothing on purpose: `me/routes.ts` answers the `MeDto` it builds with
 * `buildMeDto` from `./profile.ts` after this call, which keeps the module's declared order
 * (consents → photo → profile) acyclic. Nothing here logs an email address (AAP 0.11.1).
 *
 * @param services - The app's services: the database, the injected clock, the logger and the outbox
 *   the transaction is opened through, plus the Redis connection the cache drop uses.
 * @param auth - The caller's context. `auth.userId` is the fenced account; the sessions whose cache
 *   entries are dropped are the account's own live ones.
 * @param body - The validated `ConsentsRequest`.
 * @returns Nothing.
 * @throws AppError `invalid_field` when `body.termsVersion` is not `services.env.TERMS_VERSION`.
 * @throws AppError `token_invalid` after `DELETE /me`, thrown by the fence before any write.
 * @see AAP 0.5.4 for the route and its errors, 0.5.8 for the age-gate screen, 0.12.2 for the 18+
 *   constraint, 0.3.2 for the fence and the after-commit rule, 0.8.1 for this file.
 */

import type { ConsentsRequest } from '@tablemate/shared';

import { dropCachedSessions, type AuthContext } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { transact } from '../outbox/write.ts';

// Type-only, so this file holds no runtime edge to the module that builds the app — the same
// `AppServices` every module of `apps/api/src/modules` names (AAP 0.5.1).
import type { AppServices } from '../../app.ts';

/**
 * What a version mismatch answers with. The client renders its own sentence for the code
 * (`apps/mobile/src/api/errors.ts`), so this text is for a caller reading the envelope directly and
 * carries no value the caller supplied.
 */
const STALE_TERMS_MESSAGE = 'The terms have changed. Review and accept the current version.';

/**
 * Records the caller's age confirmation and accepted terms version, and lets the age gate open
 * (AAP 0.5.4, 0.5.8).
 *
 * A version other than `TERMS_VERSION` is refused before the transaction opens, so a caller that
 * accepted superseded text changes nothing. Otherwise the account's `termsVersion` is set to the
 * accepted version and `ageConfirmedAt` to the injected clock's now — once, on the first
 * acceptance. The account's live sessions are read in the same transaction, and their Redis cache
 * entries are dropped after it commits, so the very next request is admitted instead of waiting out
 * `SESSION_CACHE_SECONDS`.
 *
 * @param services - See the module documentation.
 * @param auth - See the module documentation.
 * @param body - The validated `ConsentsRequest`.
 * @returns Nothing.
 * @throws AppError `invalid_field` for a stale `termsVersion`; `token_invalid` when the account has
 *   requested deletion or been deleted.
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

      // Unconditional: an account that accepts a revised version is recorded against the revision
      // it just accepted, which is what the terms screen showed it.
      await tx.user.updateMany({
        where: { id: auth.userId },
        data: { termsVersion: body.termsVersion },
      });

      // Conditional on the column still being `NULL`, so the first confirmation and its timestamp
      // survive every later acceptance — `updateMany` writes nothing when the condition matches
      // no row.
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
