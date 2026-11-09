/**
 * Magic-link sign-in: the link request and the exchange that creates the account on first use
 * (AAP 0.1.1, 0.3.2, 0.5.1, 0.5.4).
 *
 * The request path is fenced, and the fence is a dropped write rather than a refusal: an account that
 * has requested deletion writes no row and queues no mail, while an unknown or erased address writes
 * its row like any other, because `POST /auth/magic-link` answers `202` for every address it accepts
 * (AAP 0.5.3, 0.5.4). Delivery belongs to `apps/workers` (AAP 0.3.2), so nothing here mails, enqueues
 * or clears a ciphertext; no log line carries an address, a token or a digest; and time comes only
 * from the injected clock (AAP 0.11.1).
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

// Type-only, so nothing of `app.ts` is read at run time and no import cycle reaches the root.
import type { AppServices } from '../../app.ts';

/** How long a magic-link token stays valid: 15 minutes, and single use (AAP 0.1.1, 0.5.2). */
const MAGIC_LINK_TTL_MS = MAGIC_LINK_TTL_MINUTES * MINUTE_MS;

/** What the verify transaction decided, to be read once it has committed. */
interface VerifiedSession {
  readonly userId: string;
  readonly role: UserRole;
  readonly sessionId: string;
  readonly refreshToken: string;
  readonly created: boolean;
}

/**
 * Writes a magic-link token and asks the outbox to mail its link; the address is stored only as
 * AES-256-GCM ciphertext beside its keyed HMAC look-up, and both are computed before the transaction
 * opens, so it holds no lock across CPU work (AAP 0.3.2, 0.5.3, 0.5.4).
 */
export async function requestMagicLink(services: AppServices, email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  const now = services.clock.now();
  const token = randomToken();
  const tokenHash = sha256Hex(token);
  const emailCiphertext = encryptField(services.keyring, normalized);
  const lookup = emailLookupHash(services.env.EMAIL_LOOKUP_PEPPER, normalized);
  const deliveryTokenCiphertext = encryptField(services.keyring, token);
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS);
  await transact(services, async (tx) => {
    // The write fence of AAP 0.5.3: an account that has requested deletion gets no row carrying its
    // address ciphertext, and the refusal is this dropped write, because the route answers `202` for
    // every address it accepts (AAP 0.5.4); an erased address is a tombstone with no lookup hash.
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
 * The token is consumed in the transaction that resolved it, with `usedAt` as a condition inside the
 * update rather than a check before it, so two racing verifies leave exactly one session; an account
 * that has requested deletion is fenced before its session is written (AAP 0.5.2, 0.5.3). The retry
 * exists for two unique-index collisions and each attempt is a whole transaction, because a unique
 * violation aborts the one it was raised in (AAP 0.5.2).
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
          // The write fence runs here rather than on the transaction: a returning sign-in has an
          // account to take the share lock on, a first one has none, and a refused account leaves the
          // variant untouched, which keeps it stable across a re-login (AAP 0.5.7).
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
 * Signs the session a verified token opened and builds the response of `POST /auth/verify`, after the
 * transaction committed and never inside it (AAP 0.5.4).
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
