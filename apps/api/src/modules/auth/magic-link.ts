/**
 * Magic-link sign-in: the link request, and the exchange that creates the account on first use
 * (AAP 0.1.1 requirement 1, 0.3.2, 0.5.1, 0.5.4).
 *
 * Sign-in is one path in two halves. {@link requestMagicLink} writes a `MagicLinkToken` row — never
 * a user — and asks the transactional outbox to mail its link; the row holds the address as
 * AES-256-GCM ciphertext beside its keyed HMAC lookup hash, the token's SHA-256 digest, the raw
 * token encrypted for the mailer alone, and a 15-minute expiry (AAP 0.5.2). {@link verifyMagicLink}
 * consumes that row exactly once, resolves the account or creates it on first use, and opens a
 * session.
 *
 * The request path is fenced like every other mutation. It reads the account the address belongs to
 * — if there is one — and takes `SELECT … FOR SHARE` on that row, so an account that has requested
 * deletion and has not yet been erased writes no row and queues no mail (AAP 0.5.3). The fence is a
 * dropped write and never a refusal, because `POST /auth/magic-link` answers `202` for every address
 * it accepts (AAP 0.5.4): an unknown address has no row to take the lock on, and an erased one is a
 * tombstone whose `emailLookupHash` is null, so both write their row and are answered the same way.
 * Only the link itself says whether an address had an account.
 *
 * Delivery belongs to `apps/workers`, not to this process (AAP 0.3.2). The outbox row carries the
 * token row's id and nothing else; `jobs/notifications.ts` checks `expiresAt` before it sends
 * anything and clears an expired row unsent, so a backlogged mailer never mails a dead link, and it
 * nulls `deliveryTokenCiphertext` in the same step as the send. `jobs/data-expiry.ts` clears any
 * ciphertext a lost job leaves behind and purges the row 24 hours after expiry. Nothing here mails,
 * enqueues or clears a ciphertext.
 *
 * Time comes only from the injected clock, so a test that advances it expires a token the way real
 * time would (AAP 0.11.1). No log line of this module carries an address, a token or a digest, and
 * no external call — SMTP, Redis, a provider — runs inside the transactions below.
 *
 * @see AAP 0.5.1 for the auth component, 0.5.2 for the token row and its retention, 0.5.3 for the
 *   account-deletion write fence, 0.5.4 for the two routes and their errors, 0.8.1 for this file.
 */

import { isUniqueViolation } from '@tablemate/db';
import {
  MAGIC_LINK_TTL_MINUTES,
  MINUTE_MS,
  type UserRole,
  type VerifyResponse,
} from '@tablemate/shared';
import {
  emailLookupHash,
  encryptField,
  normalizeEmail,
  randomToken,
  sha256Hex,
} from '@tablemate/server-core';

import { assertWritable, isWritable } from '../../plugins/auth.ts';
import { AppError } from '../../plugins/errors.ts';
import { emit } from '../analytics/emit.ts';
import { assign } from '../experiment/assignment.ts';
import { buildMeDto } from '../me/profile.ts';
import { notifyMagicLink } from '../notifications/enqueue.ts';
import { transact } from '../outbox/write.ts';
import { generateHandle, MAX_HANDLE_ATTEMPTS, newAvatarSeed } from './handles.ts';
import { createSession, issueTokens } from './sessions.ts';

// Type-only, so nothing of `app.ts` is read at run time and no cycle reaches the composition root
// that declares it.
import type { AppServices } from '../../app.ts';

/** How long a magic-link token stays valid: 15 minutes, and single use (AAP 0.1.1, 0.5.2). */
const MAGIC_LINK_TTL_MS = MAGIC_LINK_TTL_MINUTES * MINUTE_MS;

/** What the verify transaction decided, to be read once it has committed. */
interface VerifiedSession {
  /** The account that signed in, whether it was just created or already existed. */
  readonly userId: string;
  /** The account's role, granted to its access token: `traveler`, or `operator` for an operator. */
  readonly role: UserRole;
  /** The session the access token names in `sid`; logout and refresh revoke it. */
  readonly sessionId: string;
  /** The raw refresh token, which exists only here and in the response. */
  readonly refreshToken: string;
  /** True when this sign-in created the account, false for a returning one (AAP 0.5.7). */
  readonly created: boolean;
}

/**
 * Writes a magic-link token and asks the outbox to mail its link, unless the address's account has
 * requested deletion (AAP 0.3.2, 0.5.3, 0.5.4).
 *
 * The address is normalized once and then only ever stored transformed: AES-256-GCM ciphertext for
 * the mailer to read back, and the keyed HMAC of the normalized value as the look-up the verify
 * path resolves an account by. The raw token exists in the row only encrypted, and in the database
 * not at all — `tokenHash` is its SHA-256 digest. Both encryptions and the digest are computed
 * before the transaction opens, so the transaction holds no lock across CPU work.
 *
 * The account the address belongs to is read only to fence the write, and no `User` is ever created
 * or updated here. An unknown address, an erased one and a known one whose account may still be
 * written to write the same row and queue the same mail; only an account that has requested deletion
 * writes neither, which keeps its address ciphertext out of a row the erasure job never sees
 * (AAP 0.5.2, 0.5.3). The route's `202` holds for all of them, because this function never refuses
 * (AAP 0.5.4). The per-address limit of 5 an hour is the rate-limit plugin's, which counts the same
 * HMAC in Redis and answers `429 rate_limited` before this function is reached.
 *
 * @param services - The app's services: the database, clock, logger and outbox dispatcher the
 *   transaction runs through, the field keyring the address and token are encrypted under, and the
 *   environment, whose `EMAIL_LOOKUP_PEPPER` keys the look-up hash.
 * @param email - The address as the route received it, already validated as an address shape. It is
 *   normalized here, so casing and surrounding whitespace reach one account.
 * @returns Nothing. Delivery is the `notifications` job's, after this transaction commits.
 * @throws Error when the insert or the outbox write fails, which rolls both back.
 * @see AAP 0.3.2 for the outbox hand-off, 0.5.2 for the row and its retention, 0.5.3 for the write
 *   fence, 0.5.4 for the route.
 */
export async function requestMagicLink(services: AppServices, email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  const now = services.clock.now();
  const token = randomToken();

  // Pure CPU work, outside the transaction: the fence read and the insert are the only statements
  // this transaction holds open, and the ciphertexts are ready by the time it opens.
  const tokenHash = sha256Hex(token);
  const emailCiphertext = encryptField(services.keyring, normalized);
  const lookup = emailLookupHash(services.env.EMAIL_LOOKUP_PEPPER, normalized);
  const deliveryTokenCiphertext = encryptField(services.keyring, token);
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS);

  await transact(services, async (tx) => {
    // The write fence of AAP 0.5.3, taken on the row this address belongs to when there is one: an
    // account that has requested deletion gets no row carrying its address ciphertext, and the
    // refusal is this dropped write rather than a `401`, because the route answers `202` for every
    // address it accepts (AAP 0.5.4). An erased address is a tombstone with no lookup hash, so it
    // matches nothing here and writes its row like an address that never had an account (AAP 0.5.2).
    const existing = await tx.user.findUnique({
      where: { emailLookupHash: lookup },
      select: { id: true },
    });
    if (existing !== null && !(await isWritable(tx, existing.id))) return;

    const row = await tx.magicLinkToken.create({
      data: {
        tokenHash,
        emailCiphertext,
        emailLookupHash: lookup,
        deliveryTokenCiphertext,
        expiresAt,
      },
      select: { id: true },
    });

    // Ids only: the worker decrypts the address and the token from this row (AAP 0.5.2).
    await notifyMagicLink(tx, row.id);
  });

  services.logger.info({ event: 'magic_link_requested' }, 'magic_link_requested');
}

/**
 * Exchanges a magic-link token for a session, creating the account on first use (AAP 0.5.4).
 *
 * The token is resolved by its digest and consumed in the same transaction — with the `usedAt`
 * condition inside the update, so two racing verifies of one link leave exactly one session, and the
 * loser is refused as `401 token_invalid`. An unknown token, one older than 15 minutes by the
 * injected clock and one already used are the same refusal, and the transaction that raises it rolls
 * its consumption back, which is what makes a retried attempt safe.
 *
 * An account resolved from the address is fenced before its session is written, so an account that
 * requested deletion, or was erased, signs nobody in and no session can commit after `DELETE /me`
 * (AAP 0.5.3). An address with no account creates one: a generated handle and avatar seed, no real
 * name, photo or phone (AAP 0.1.1), the experiment variant assigned once, and the `account_created`
 * event. Consents stay unset, so the age gate holds the new account at `403 age_gate_required` until
 * `POST /me/consents`.
 *
 * The retry exists for two collisions the unique indexes of AAP 0.5.2 can raise: a handle already
 * taken, and a concurrent first sign-in of the same address. Each attempt is a whole transaction and
 * not a repeated insert, because a unique violation aborts the interactive transaction it was raised
 * in; the losing attempt leaves no row behind, and the retry after an address collision finds the
 * account its competitor just created.
 *
 * Only after the commit does this build the profile payload and sign the tokens, so no token is
 * handed out for a session a rollback discarded.
 *
 * @param services - The app's services: the database, clock, logger and outbox the transaction runs
 *   through, the field keyring, the environment holding the signing secret, and the profile, event
 *   and assignment writers.
 * @param token - The token from the link, exactly as `POST /auth/verify` received it.
 * @returns The caller's own profile, a 15-minute access token and a 30-day refresh token.
 * @throws AppError `token_invalid` (401) for an unknown, expired or already-used token, and for an
 *   account that has requested deletion or been deleted.
 * @see AAP 0.3.3 for the token pair, 0.5.2 for the erased tombstone, 0.5.3 for the fence, 0.5.7 for
 *   the once-only variant assignment.
 */
export async function verifyMagicLink(
  services: AppServices,
  token: string,
): Promise<VerifyResponse> {
  const hash = sha256Hex(token);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const verified = await transact(services, async (tx): Promise<VerifiedSession> => {
        const now = services.clock.now();

        const row = await tx.magicLinkToken.findUnique({ where: { tokenHash: hash } });
        if (row === null || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime()) {
          throw new AppError('token_invalid');
        }

        // Single use. `usedAt` is the condition as well as the value, so a verify blocked on this
        // row's lock re-evaluates it after the first one commits, matches no row, and is refused.
        const consumed = await tx.magicLinkToken.updateMany({
          where: { id: row.id, usedAt: null },
          data: { usedAt: now },
        });
        if (consumed.count === 0) throw new AppError('token_invalid');

        const existing = await tx.user.findUnique({
          where: { emailLookupHash: row.emailLookupHash },
          select: { id: true, role: true },
        });

        if (existing !== null) {
          // The write fence, and the reason it runs here rather than on the transaction: a returning
          // sign-in has an account to take the share lock on, and a first one has none. A refused
          // account also leaves the variant untouched, which is what keeps it stable across a
          // re-login (AAP 0.5.7).
          await assertWritable(tx, existing.id);
          const session = await createSession(tx, services, existing.id);
          return { ...session, userId: existing.id, role: existing.role, created: false };
        }

        // An erased account is a tombstone whose `emailLookupHash` is null, so an address that
        // returns after erasure matches nothing here and gets a fresh account (AAP 0.5.2).
        const user = await tx.user.create({
          data: {
            emailCiphertext: row.emailCiphertext,
            emailLookupHash: row.emailLookupHash,
            handle: generateHandle(),
            avatarSeed: newAvatarSeed(),
            role: 'traveler',
          },
          select: { id: true, role: true },
        });

        // Both commit with the account or not at all: the assignment is written once, here, and the
        // signup measure is read from the event (AAP 0.5.2, 0.5.7).
        await assign(tx, services, user.id);
        await emit(tx, services, 'account_created', user.id);

        const session = await createSession(tx, services, user.id);
        return { ...session, userId: user.id, role: user.role, created: true };
      });

      return await verifiedResponse(services, verified);
    } catch (error) {
      if (attempt >= MAX_HANDLE_ATTEMPTS || !isUniqueViolation(error)) throw error;
    }
  }
}

/**
 * Signs the session a verified token opened and builds the response of `POST /auth/verify`
 * (AAP 0.5.4).
 *
 * Runs after the transaction committed, never inside it: the profile payload is read through the
 * process's own client, which sees the account now, and signing costs no database time.
 *
 * @param services - The app's services, from which the signing secret, the clock, the database and
 *   the logger are read.
 * @param verified - What the committed transaction decided.
 * @returns The token pair and the caller's own `MeDto`, which carries no email address.
 */
async function verifiedResponse(
  services: AppServices,
  verified: VerifiedSession,
): Promise<VerifyResponse> {
  const user = await buildMeDto(services, verified.userId);
  const tokens = await issueTokens(services, verified);

  services.logger.info(
    { event: 'auth_verified', userId: verified.userId, created: verified.created },
    'auth_verified',
  );

  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user };
}
