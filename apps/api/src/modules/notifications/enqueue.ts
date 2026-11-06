/**
 * Notification requests, written into the domain transaction that caused them (AAP 0.3.2, 0.5.1).
 *
 * A `notification` outbox row is how this process asks another one to tell a user something: the row
 * commits or rolls back with the state change it describes, so a Redis outage delays a deposit or
 * safety message instead of losing it, and `outbox/dispatcher.ts` publishes it to the `notifications`
 * queue under `jobId = outbox-<id>` once the commit has happened (AAP 0.3.2, 0.5.6).
 *
 * None of these helpers sends, renders or addresses a message, and none opens a transaction: each
 * takes the client `transact(...)` already opened. The payload carries ids only (AAP 0.5.2) — no
 * address, name, handle, booking field, amount or text — and `jobs/notifications.ts` resolves the
 * recipient's addresses, framing variant and copy from the rows those ids name (AAP 0.1.1, 0.5.8).
 * Validation is `writeOutbox`'s, which parses before the insert and rolls the transaction back on a
 * payload that does not match, so nothing is re-checked here.
 *
 * @see AAP 0.3.2 for the outbox decision and its idempotency rules, 0.5.1 for this module, 0.5.2 for
 *   the kinds, the ids-only payload and the magic-link flow, 0.5.8 for the two `lock_lost` copies.
 */

import type { DbTx } from '@tablemate/db';
import { NotificationKind } from '@tablemate/shared';

import { writeOutbox } from '../outbox/write.ts';

/** The ids a notification names besides its recipient: the event it is about (AAP 0.5.2, 0.5.4). */
export type NotificationData = {
  meetupId?: string;
  disputeId?: string;
  lodgingClaimId?: string;
};

/**
 * Every notification a recipient can be told about (AAP 0.5.2): the proposal, lock, decline, lapse
 * and cancellation notices, the start reminder and the counterpart's check-in, every settlement
 * outcome, `lock_lost`, and the dispute and lodging-claim results.
 *
 * The magic link is the one exclusion. It is addressed to an email that may have no account yet, so
 * it carries the token row's id instead of a `userId` and the payload's refinement requires that
 * split; {@link notifyMagicLink} writes it, never {@link notify}.
 *
 * Spelling the exclusion as the enum's own literal keeps it honest: renaming `magic_link` in
 * `packages/shared/src/enums.ts` fails the typecheck here rather than mis-routing a send.
 */
export type UserNotificationKind = Exclude<
  NotificationKind,
  typeof NotificationKind.enum.magic_link
>;

/**
 * Writes one notification request for `userId`, inside the transaction that decided it (AAP 0.3.2).
 *
 * The caller passes in `data` the ids its kind names — `meetupId` for a proposal, a lock, a
 * cancellation, a reminder, a check-in, a settlement or `lock_lost`; `disputeId` for a dispute;
 * `lodgingClaimId` for a claim result.
 *
 * **Which kind each recipient gets is the caller's choice.** One event can produce two different
 * messages: a settlement compensated because a hold was lost sends `lock_lost` to both parties, and
 * which of the two copies a recipient sees (the hold being released, or the captured amount being
 * refunded) follows from that party's own deposit, which the worker reads (AAP 0.5.8).
 *
 * @param tx - the transaction client `transact(...)`'s callback received, never a bare client.
 * @param userId - the recipient whose addresses and framing variant the worker resolves.
 * @param kind - the notification, other than the magic link.
 * @param data - the ids the kind names. Only the keys present are written, so no stored payload
 *   carries an `undefined` value.
 * @returns the new outbox row's id.
 */
export async function notify(
  tx: DbTx,
  userId: string,
  kind: UserNotificationKind,
  data: NotificationData = {},
): Promise<string> {
  const payload = {
    kind,
    userId,
    ...(data.meetupId === undefined ? {} : { meetupId: data.meetupId }),
    ...(data.disputeId === undefined ? {} : { disputeId: data.disputeId }),
    ...(data.lodgingClaimId === undefined ? {} : { lodgingClaimId: data.lodgingClaimId }),
  };

  return writeOutbox(tx, 'notification', payload);
}

/**
 * Writes the same notification for each of several recipients — "notify both" (AAP 0.5.3).
 *
 * The rows are written one after another in a `for…of` loop, never with `Promise.all`: a Prisma
 * interactive transaction runs on a single connection, so concurrent queries on `tx` are not allowed.
 * A recipient named twice is written once, in first-appearance order, so a pair whose two sides are
 * the same account is not announced twice.
 *
 * @param tx - the transaction client `transact(...)`'s callback received.
 * @param userIds - the recipients, in the order their rows are written.
 * @param kind - the notification every recipient gets. A caller that needs a different kind per
 *   recipient, as the compensated `lock_lost` case does, calls {@link notify} instead.
 * @param data - the ids the kind names.
 * @returns the outbox row ids, one per distinct recipient, in the order written.
 */
export async function notifyAll(
  tx: DbTx,
  userIds: readonly string[],
  kind: UserNotificationKind,
  data?: NotificationData,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const userId of userIds) {
    if (seen.has(userId)) {
      continue;
    }

    seen.add(userId);
    ids.push(await notify(tx, userId, kind, data ?? {}));
  }

  return ids;
}

/**
 * Writes the magic-link delivery request inside the transaction that created the token (AAP 0.3.2).
 *
 * The row carries the `MagicLinkToken` id and no `userId`, because a first sign-in has no account
 * yet. `apps/workers/src/jobs/notifications.ts` checks the token's `expiresAt` first: for an expired
 * token it sends nothing and nulls `deliveryTokenCiphertext`, so a backlogged mailer can never mail
 * a dead link. Otherwise it decrypts the token row's email and delivery token, sends the link and
 * nulls the ciphertext in the same step; anything a lost job leaves behind is cleared by the next
 * hourly `data-expiry` run (AAP 0.5.2).
 *
 * @param tx - the transaction client `transact(...)`'s callback received.
 * @param magicLinkTokenId - the `MagicLinkToken` row the link is built from.
 * @returns the new outbox row's id.
 */
export async function notifyMagicLink(tx: DbTx, magicLinkTokenId: string): Promise<string> {
  return writeOutbox(tx, 'notification', {
    kind: NotificationKind.enum.magic_link,
    magicLinkTokenId,
  });
}
