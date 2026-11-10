/**
 * The `notifications` queue: delivery of one outbox row's message to its recipient (AAP 0.3.2, 0.3.3, 0.5.6).
 *
 * A domain transaction never sends anything: it writes a `Notification` outbox row — ids only — and the API's dispatcher
 * publishes that row as a `notifications`/`deliver` job carrying the row's id, which is what makes this consumer
 * idempotent per row. The per-channel Redis markers below are written before the send, so a crash in that window leaves
 * the row read as already sent by the next run, and a failed send clears the marker so the retry still delivers.
 *
 * Two paths run through {@link process}. A magic link (`magicLinkTokenId`) is the one kind that carries a token instead
 * of a recipient: the row's `expiresAt` is read first and an expired row is cleared without sending, because a
 * backlogged job must never mail a dead link; otherwise the address and the raw token are decrypted, the message is sent
 * and `deliveryTokenCiphertext` is nulled in the same step. Every other kind is addressed to a `userId`: a recipient who
 * is gone or whose deletion has been requested is skipped (AAP 0.5.3), and the message is rendered from the ids, the
 * recipient's own experiment variant and the public venue or lodging name (AAP 0.5.7, 0.5.8), pushed to the recipient's
 * registered devices where Expo push is configured for them, and mailed where it is not — email is the web fallback, the
 * only channel a browser has (AAP 0.3.4).
 *
 * Three rules hold throughout: time comes from the injected clock (AAP 0.11.1); no SMTP or Expo traffic runs inside a
 * database transaction; and no log line carries an email address, a token, a push token, a message body or a booking
 * field — the fields logged are the outbox id, the kind, the channel and, on a skip, the code under `skipReason`.
 */

import type { DbTx } from '@tablemate/db';
import {
  QUEUE,
  FieldDecryptionError,
  QueuePayloadError,
  decryptField,
  formatCityWallTime,
  isJobName,
  parseJobData,
  parseOutboxPayload,
} from '@tablemate/server-core';
import type { JobDataByQueueAndName, OutboxPayloadByKind } from '@tablemate/server-core';
import { isDepositLevel } from '@tablemate/shared';
import type { NotificationKind, Variant } from '@tablemate/shared';

import { DEPOSIT_NOTIFICATION_KINDS, renderNotification } from '../notify/templates.ts';
import type {
  NotificationOutcome,
  NotificationRenderData,
  RenderedNotification,
} from '../notify/templates.ts';
import type { WorkerContext } from '../queues.ts';

/** The parsed payload of a `notification` outbox row: a kind and the ids it concerns. */
type NotificationPayload = OutboxPayloadByKind['notification'];
// The parsed data of a `notifications`/`deliver` job: that payload plus the row id the job carries, which is what makes a redelivery of the row a no-op (AAP 0.3.2).
type NotificationJobData = JobDataByQueueAndName['notifications']['deliver'];
// The one kind that carries a token rather than a recipient: the account it will sign in may not exist yet (AAP 0.3.2).
const MAGIC_LINK_KIND: NotificationKind = 'magic_link';
/** The two channels one outbox row is delivered on; email is the fallback (AAP 0.3.4). */
type DeliveryChannel = 'push' | 'email';
// How long a sent marker lives. A redelivery only ever follows a dispatcher pass over the same row within a job's retry horizon, so a week is far longer than any path that could repeat one, and the marker then expires rather than leaving one key per outbox row in Redis forever.
const SENT_KEY_TTL_SECONDS = 604_800;
// Why a notification was not delivered. `missing` is the row the payload names having been purged, `expired` a magic link whose 15 minutes had passed, `already_sent` a redelivery this channel's send was already claimed for, `user_deleted` a recipient who is gone or deleting, `undecryptable` a ciphertext no key of the ring can read, and `no_channel` a recipient with neither a push token nor an address (AAP 0.3.2, 0.5.3).
export type NotificationSkip =
  'missing' | 'expired' | 'already_sent' | 'user_deleted' | 'undecryptable' | 'no_channel';
// What {@link process} did with one outbox row: the channel that carried it, or why nothing was sent. A skipped row is a decision, not a failure, so the job completes and BullMQ records no retry for it.
export type NotificationDeliveryResult =
  | { readonly channel: DeliveryChannel; readonly kind: NotificationKind }
  | { readonly skipped: NotificationSkip };
/** Writes the outbox row that asks for one notification, and returns its id. A `workers` job calls this inside the transaction that makes the change it announces, never after it, so the message and the state it describes commit together. The payload is validated before the insert, so an inconsistent row — a magic link without its token, or another kind without its recipient — can never be committed. */
export async function writeNotificationOutbox(
  tx: DbTx,
  now: Date,
  payload: NotificationPayload,
): Promise<string> {
  const parsed = parseOutboxPayload('notification', payload);
  const row = await tx.outboxMessage.create({
    data: { kind: 'notification', payload: parsed, createdAt: now },
    select: { id: true },
  });
  return row.id;
}

/** The key claiming `channel` for this outbox row's message. */
function sentKey(outboxId: string, channel: DeliveryChannel): string {
  return `notify-sent:${outboxId}:${channel}`;
}

// Whether `channel`'s one send for this row has already been claimed by an earlier run of this job.
async function channelAlreadySent(
  ctx: WorkerContext,
  outboxId: string,
  channel: DeliveryChannel,
): Promise<boolean> {
  return (await ctx.redis.get(sentKey(outboxId, channel))) !== null;
}

// Claims `channel` for this row's message. The marker is set with `NX`, so it never overwrites an earlier run's, and its TTL is {@link SENT_KEY_TTL_SECONDS}: the guarantee is per row and per channel, the granularity a redelivery works at. It goes up before the send and not after, so a crash between the marker and the provider's answer reads as sent instead of sending twice; only a send that delivered nothing removes it.
async function markChannelSent(
  ctx: WorkerContext,
  outboxId: string,
  channel: DeliveryChannel,
): Promise<void> {
  await ctx.redis.set(sentKey(outboxId, channel), '1', 'EX', SENT_KEY_TTL_SECONDS, 'NX');
}

/** Removes the marker of a channel whose send reached nobody, so that channel is not lost. */
async function clearChannelSent(
  ctx: WorkerContext,
  outboxId: string,
  channel: DeliveryChannel,
): Promise<void> {
  await ctx.redis.del(sentKey(outboxId, channel));
}

// Sends on `channel` with that channel's sent marker written before the send (AAP 0.3.2).
//
// The ordering is the invariant: the marker precedes the send, so a redelivery of the row — BullMQ's own retry or the
// dispatcher publishing an undispatched row again — finds the channel claimed and sends nothing. The cost is one unsent
// message where the opposite order would send a second one, because neither SMTP nor Expo offers an idempotency key a
// retry could match against a delivery that may never have happened. A send that failed, and one that delivered
// nothing, clear the marker again before they rethrow or return, so a transient failure still delivers on the retry
// (AAP 0.11.1) and a push that reached no device leaves the email fallback open.
async function sendChannelOnce(
  ctx: WorkerContext,
  outboxId: string,
  channel: DeliveryChannel,
  attempt: () => Promise<boolean>,
): Promise<boolean> {
  await markChannelSent(ctx, outboxId, channel);
  let delivered: boolean;
  try {
    delivered = await attempt();
  } catch (error) {
    await clearChannelSent(ctx, outboxId, channel);
    throw error;
  }
  if (!delivered) {
    await clearChannelSent(ctx, outboxId, channel);
  }
  return delivered;
}

/** Nulls a magic-link row's raw token, guarded so it is written only for a row that still holds one. */
async function clearDeliveryToken(ctx: WorkerContext, tokenId: string): Promise<void> {
  await ctx.db.magicLinkToken.updateMany({
    where: { id: tokenId, deliveryTokenCiphertext: { not: null } },
    data: { deliveryTokenCiphertext: null },
  });
}

/** The origin a message's links are built on: the sign-in URL of a magic link, and the base the app opens a meetup from. `WEB_ORIGIN` belongs to the `api` process's scope, and this process reads it where the deployment provides it while a deployment that leaves it out still starts. A message whose links cannot be built is not worth sending, so the absence fails this job and the row stays in the outbox for the retry and for the operator to see. */
function webOriginFor(ctx: WorkerContext): string {
  const origin = ctx.env.WEB_ORIGIN;
  if (origin === null) {
    throw new Error('notification delivery needs WEB_ORIGIN: the message links are built on it');
  }
  return origin;
}

/** Delivers the notification the outbox row of `job.data` asks for, once (AAP 0.3.2). The row id the job carries makes a second run of the same job a no-op, through the per-channel markers of {@link deliver}; a skipped row completes the job, while a failure of SMTP or Expo propagates so BullMQ retries the row. */
export async function process(
  job: { id?: string; name: string; data: unknown },
  ctx: WorkerContext,
): Promise<NotificationDeliveryResult> {
  const queue = QUEUE.notifications;
  // A name this queue does not accept has no schema to parse against, so it is refused here rather than parsed as `deliver`: a foreign job arriving on this queue is a wiring fault, not a message.
  if (!isJobName(queue, job.name)) {
    throw new QueuePayloadError(`${queue}/${job.name}`);
  }
  const payload = parseJobData(queue, job.name, job.data);
  if (payload.magicLinkTokenId !== undefined) {
    return await deliverMagicLink(ctx, payload);
  }
  const recipientId = payload.userId;
  if (recipientId === undefined) {
    // The payload schema requires a recipient on every kind but the magic link (AAP 0.3.2), so this guard is unreachable through the queue and exists for a hand-built job.
    throw new Error(`${payload.kind} notification carries no recipient`);
  }
  return await deliverToUser(ctx, payload, recipientId);
}

/** Mails a magic link, or clears it without sending (AAP 0.3.2, 0.3.3). The order of the checks is the point of this path. `expiresAt` is read before anything is decrypted or sent, so a job that reaches a link after its 15 minutes clears the raw token and stops: a backlogged queue delays a sign-in, it never mails a dead link. A row whose token has already been cleared is a link that has been sent. The email marker is written before the send, so a crash in that window leaves the row read as already sent by the next run. */
async function deliverMagicLink(
  ctx: WorkerContext,
  payload: NotificationJobData,
): Promise<NotificationDeliveryResult> {
  const tokenId = payload.magicLinkTokenId;
  if (tokenId === undefined) {
    throw new Error(`${payload.kind} notification carries no magic-link token`);
  }
  const log = { outboxId: payload.outboxId, kind: payload.kind };
  const token = await ctx.db.magicLinkToken.findUnique({
    where: { id: tokenId },
    select: { emailCiphertext: true, deliveryTokenCiphertext: true, expiresAt: true },
  });
  if (token === null) {
    // Purged 24 hours after it expired (AAP 0.5.2): the link is long dead. The code travels under `skipReason`, not `reason`: the logger's redaction list censors `reason`, and a code that has to be read back is logged under a name the list does not cover (AAP 0.11.1).
    ctx.logger.warn({ event: 'notification_skipped', ...log, skipReason: 'missing' });
    return { skipped: 'missing' };
  }
  if (token.expiresAt.getTime() <= ctx.clock.now().getTime()) {
    await clearDeliveryToken(ctx, tokenId);
    ctx.logger.info({ event: 'notification_skipped', ...log, skipReason: 'expired' });
    return { skipped: 'expired' };
  }
  const ciphertext = token.deliveryTokenCiphertext;
  if (ciphertext === null) {
    ctx.logger.info({ event: 'notification_skipped', ...log, skipReason: 'already_sent' });
    return { skipped: 'already_sent' };
  }
  if (await channelAlreadySent(ctx, payload.outboxId, 'email')) {
    // The earlier run claimed this channel and died before the row was cleared: clearing it here finishes what that run started instead of mailing the link a second time.
    await clearDeliveryToken(ctx, tokenId);
    ctx.logger.info({ event: 'notification_skipped', ...log, skipReason: 'already_sent' });
    return { skipped: 'already_sent' };
  }
  const secrets = magicLinkSecrets(ctx, token.emailCiphertext, ciphertext);
  if (secrets === null) {
    await clearDeliveryToken(ctx, tokenId);
    ctx.logger.warn({ event: 'notification_skipped', ...log, skipReason: 'undecryptable' });
    return { skipped: 'undecryptable' };
  }
  const rendered = renderNotification(MAGIC_LINK_KIND, {
    webOrigin: webOriginFor(ctx),
    magicLinkToken: secrets.token,
  });
  await sendChannelOnce(ctx, payload.outboxId, 'email', async () => {
    await ctx.mailer.send({
      to: secrets.to,
      subject: rendered.emailSubject,
      text: rendered.emailText,
    });
    return true;
  });
  // The marker went up before the send and the token is cleared after it, so a crash in either window leaves a row the next run clears instead of mailing the link a second time.
  await clearDeliveryToken(ctx, tokenId);
  ctx.logger.info({ event: 'notification_sent', ...log, channel: 'email' });
  return { channel: 'email', kind: MAGIC_LINK_KIND };
}

// Delivers one addressee's notification: the recipient's own message, on push where they have registered devices and by email where they have not (AAP 0.3.4).
async function deliverToUser(
  ctx: WorkerContext,
  payload: NotificationJobData,
  recipientId: string,
): Promise<NotificationDeliveryResult> {
  const log = { outboxId: payload.outboxId, kind: payload.kind };
  const user = await ctx.db.user.findUnique({
    where: { id: recipientId },
    select: { emailCiphertext: true, deletedAt: true, deletionRequestedAt: true },
  });
  // An erased account is a tombstone and a deleting one is about to become one (AAP 0.5.2, 0.5.3): neither is told anything, and the row is acknowledged rather than retried.
  if (user === null || user.deletedAt !== null || user.deletionRequestedAt !== null) {
    ctx.logger.info({ event: 'notification_skipped', ...log, skipReason: 'user_deleted' });
    return { skipped: 'user_deleted' };
  }
  const gathered = await gatherRenderData(ctx, payload, recipientId);
  if (gathered === null) {
    ctx.logger.warn({ event: 'notification_skipped', ...log, skipReason: 'missing' });
    return { skipped: 'missing' };
  }
  const rendered = renderNotification(payload.kind, gathered.data);
  return await deliver(
    ctx,
    payload,
    recipientId,
    user.emailCiphertext,
    gathered.meetupId,
    rendered,
  );
}

/** The meetup a notification concerns, as {@link loadMeetup} resolves it, or `null` once purged. */
async function loadMeetup(ctx: WorkerContext, meetupId: string) {
  return await ctx.db.meetup.findUnique({
    where: { id: meetupId },
    select: {
      id: true,
      initiatorId: true,
      startsAt: true,
      depositCents: true,
      status: true,
      venue: { select: { name: true, city: { select: { timezone: true } } } },
      initiator: { select: { handle: true } },
      recipient: { select: { handle: true } },
      settlement: { select: { initiatorPresent: true, recipientPresent: true } },
    },
  });
}

/** The meetup row {@link gatherRenderData} reads, taken from the query so the shape is stated once. */
type MeetupForNotification = NonNullable<Awaited<ReturnType<typeof loadMeetup>>>;
/** The dispute a notification concerns, as {@link loadDispute} resolves it. */
async function loadDispute(ctx: WorkerContext, disputeId: string) {
  return await ctx.db.dispute.findUnique({
    where: { id: disputeId },
    select: { meetupId: true, outcome: true },
  });
}

/** The render data one kind needs, with the meetup the push payload may point at (AAP 0.5.8). */
interface GatheredNotification {
  readonly data: NotificationRenderData;
  readonly meetupId: string | null;
}

/**
 * Loads what the message of `payload.kind` may read: the meetup it concerns, the venue and city-local start time, the
 * counterpart's handle, the recipient's framing variant, the deposit for a deposit kind, the dispute's outcome, or the
 * lodging's public name for a claim kind (AAP 0.5.6, 0.5.7, 0.5.8).
 *
 * Only what the kind needs is loaded, and nothing personal reaches the copy: the data carries ids, a public venue or
 * lodging name, a handle, a formatted start time in the venue city's zone and amounts in cents, never an email address,
 * a real name, a booking detail, a phone number or a coordinate (AAP 0.5.2, 0.11.1). A handle is absent rather than empty
 * once its owner has been erased, so the copy falls back to its generic phrase (`notify/templates.ts`).
 */
async function gatherRenderData(
  ctx: WorkerContext,
  payload: NotificationJobData,
  recipientId: string,
): Promise<GatheredNotification | null> {
  const data: NotificationRenderData = { webOrigin: webOriginFor(ctx) };
  const dispute =
    payload.disputeId === undefined ? null : await loadDispute(ctx, payload.disputeId);
  if (payload.disputeId !== undefined && dispute === null) {
    return null;
  }
  const meetupId = payload.meetupId ?? dispute?.meetupId ?? null;
  if (meetupId !== null) {
    const meetup = await loadMeetup(ctx, meetupId);
    if (meetup === null) {
      return null;
    }
    data.meetupId = meetupId;
    data.venueName = meetup.venue.name;
    data.startsAtLocal = formatLocalStart(meetup.startsAt, meetup.venue.city.timezone);
    const counterpartHandle =
      (meetup.initiatorId === recipientId ? meetup.recipient.handle : meetup.initiator.handle) ??
      undefined;
    if (counterpartHandle !== undefined && counterpartHandle !== '') {
      data.counterpartHandle = counterpartHandle;
    }
    if (isDepositKind(payload.kind)) {
      data.variant = await framingVariant(ctx, recipientId, payload.kind);
      if (!isDepositLevel(meetup.depositCents)) {
        throw new Error(`meetup ${meetupId} holds no deposit level for a ${payload.kind} message`);
      }
      data.depositCents = meetup.depositCents;
    }
    const outcome = await outcomeFor(ctx, payload.kind, meetup, recipientId);
    if (outcome !== undefined) {
      data.outcome = outcome;
    }
  }
  if (payload.lodgingClaimId !== undefined) {
    const claim = await ctx.db.lodgingClaim.findUnique({
      where: { id: payload.lodgingClaimId },
      select: { status: true, lodging: { select: { name: true } } },
    });
    if (claim === null) {
      return null;
    }
    data.lodgingName = claim.lodging.name;
    // A claim that has not reached a terminal status has no outcome sentence yet (AAP 0.5.3).
    if (claim.status !== 'pending_call' && claim.status !== 'calling') {
      data.outcome = claim.status;
    }
  }
  if (dispute !== null && payload.kind === 'dispute_resolved' && dispute.outcome !== null) {
    data.outcome = dispute.outcome;
  }
  return { data, meetupId };
}

/** The meetup start as it is shown: wall-clock time in the venue city's zone (AAP 0.5.7). */
function formatLocalStart(startsAt: Date, timezone: string): string {
  return formatCityWallTime(timezone, startsAt, 'ccc d LLL, HH:mm');
}

/** Whether the copy of `kind` is framed in the recipient's variant (AAP 0.5.7, 0.5.8). */
function isDepositKind(kind: NotificationKind): boolean {
  return DEPOSIT_NOTIFICATION_KINDS.some((deposit) => deposit === kind);
}

// The recipient's own framing variant (AAP 0.5.7): the framing sentence a deposit notification carries is the recipient's variable, never the counterpart's.
async function framingVariant(
  ctx: WorkerContext,
  recipientId: string,
  kind: NotificationKind,
): Promise<Variant> {
  const assignment = await ctx.db.experimentAssignment.findUnique({
    where: { userId: recipientId },
    select: { variant: true },
  });
  if (assignment === null) {
    throw new Error(`no experiment assignment for a ${kind} message`);
  }
  return assignment.variant;
}

// The outcome sentence `kind` selects, derived from the recipient's own side of the meetup, or `undefined` for a kind that reports no outcome.
async function outcomeFor(
  ctx: WorkerContext,
  kind: NotificationKind,
  meetup: MeetupForNotification,
  recipientId: string,
): Promise<NotificationOutcome | undefined> {
  switch (kind) {
    case 'meetup_cancelled':
      return forfeitOutcome(meetup, recipientId);
    case 'meetup_settled':
      return settledOutcome(meetup, recipientId);
    case 'lock_lost':
      return await lockLostOutcome(ctx, meetup.id, recipientId);
    default:
      return undefined;
  }
}

/** The money sentence a cancellation notification carries, from the recipient's own side. `forfeited` is the one status that moves money, and the settlement records which side was absent whatever the forfeit reason: a late cancellation records the canceller absent and the counterpart present, a no-show records the absent party absent (AAP 0.5.7). Every other status — an early cancellation, a decline, a lapse, a block or a deletion — releases both holds. */
function forfeitOutcome(meetup: MeetupForNotification, recipientId: string): NotificationOutcome {
  if (meetup.status !== 'forfeited') {
    return 'released';
  }
  const settlement = meetup.settlement;
  if (settlement === null) {
    // A forfeit and its settlement row are written in one transaction, so a missing row is a data fault: refusing to guess is what keeps a wrong sentence about money off the wire.
    throw new Error(`no settlement record for the forfeited meetup ${meetup.id}`);
  }
  const present =
    meetup.initiatorId === recipientId ? settlement.initiatorPresent : settlement.recipientPresent;
  return present ? 'credit_granted' : 'deposit_captured';
}

/** The money sentence a settlement notification carries: presence first, then the forfeit reading. */
function settledOutcome(meetup: MeetupForNotification, recipientId: string): NotificationOutcome {
  switch (meetup.status) {
    case 'completed':
      return 'completed';
    case 'unattended':
      return 'unattended';
    default:
      return forfeitOutcome(meetup, recipientId);
  }
}

/** Which lock-lost sentence the recipient reads (AAP 0.3.2, 0.5.3, 0.5.8): a held deposit is being captured and refunded by the no-forfeit compensation, while one never captured — an expired hold, or an authorization Stripe cancelled — is simply being released. */
async function lockLostOutcome(
  ctx: WorkerContext,
  meetupId: string,
  recipientId: string,
): Promise<NotificationOutcome> {
  const deposit = await ctx.db.deposit.findUnique({
    where: { meetupId_ownerId: { meetupId, ownerId: recipientId } },
    select: { status: true },
  });
  return deposit?.status === 'captured' || deposit?.status === 'refunded' ? 'refund' : 'release';
}

/** Sends one rendered notification on the channel the recipient has, once. Push comes first where Expo push is configured and the recipient has registered devices; email is the fallback, the only channel a browser has. A marker for a channel whose send was already claimed ends the job with nothing sent, and a send that reaches nobody on push falls through to email, so the recipient is not left uninformed by a device that has gone away. Tokens Expo reports as unregistered are deleted. */
async function deliver(
  ctx: WorkerContext,
  payload: NotificationJobData,
  recipientId: string,
  emailCiphertext: string | null,
  meetupId: string | null,
  rendered: RenderedNotification,
): Promise<NotificationDeliveryResult> {
  const log = { outboxId: payload.outboxId, kind: payload.kind };
  const push = ctx.push;
  const tokens =
    push === null
      ? []
      : (
          await ctx.db.pushToken.findMany({
            where: { userId: recipientId },
            select: { token: true },
          })
        ).map((row) => row.token);
  if (push !== null && tokens.length > 0) {
    if (await channelAlreadySent(ctx, payload.outboxId, 'push')) {
      return { skipped: 'already_sent' };
    }
    // The push data carries identifiers only: it reaches the device unredacted (AAP 0.3.4).
    const data = meetupId === null ? { kind: payload.kind } : { kind: payload.kind, meetupId };
    const delivered = await sendChannelOnce(ctx, payload.outboxId, 'push', async () => {
      const result = await push.send(tokens, {
        title: rendered.title,
        body: rendered.body,
        data,
      });
      if (result.invalidTokens.length > 0) {
        await ctx.db.pushToken.deleteMany({
          where: { userId: recipientId, token: { in: result.invalidTokens } },
        });
      }
      // A push that reached no device is not a delivery, so its marker comes off again and the message falls through to email below.
      return result.sent > 0;
    });
    if (delivered) {
      ctx.logger.info({ event: 'notification_sent', ...log, channel: 'push' });
      return { channel: 'push', kind: payload.kind };
    }
  }
  if (await channelAlreadySent(ctx, payload.outboxId, 'email')) {
    return { skipped: 'already_sent' };
  }
  if (emailCiphertext === null) {
    // No device to push to and no address to mail. An erased or deleting recipient is skipped before here, so this is a data gap rather than a tombstone, and the row is recorded as undeliverable instead of being retried until it fails.
    ctx.logger.warn({ event: 'notification_skipped', ...log, skipReason: 'no_channel' });
    return { skipped: 'no_channel' };
  }
  const to = decryptAddress(ctx, emailCiphertext);
  if (to === null) {
    ctx.logger.warn({ event: 'notification_skipped', ...log, skipReason: 'undecryptable' });
    return { skipped: 'undecryptable' };
  }
  await sendChannelOnce(ctx, payload.outboxId, 'email', async () => {
    await ctx.mailer.send({ to, subject: rendered.emailSubject, text: rendered.emailText });
    return true;
  });
  ctx.logger.info({ event: 'notification_sent', ...log, channel: 'email' });
  return { channel: 'email', kind: payload.kind };
}

/** The address and the raw token of a magic-link row, or `null` when either cannot be decrypted. A `FieldDecryptionError` is permanent — no retry can read the value — so the caller clears the row instead of failing the job five times over; any other failure is a real fault and is rethrown. */
function magicLinkSecrets(
  ctx: WorkerContext,
  emailCiphertext: string,
  tokenCiphertext: string,
): { to: string; token: string } | null {
  try {
    return {
      to: decryptField(ctx.keyring, emailCiphertext),
      token: decryptField(ctx.keyring, tokenCiphertext),
    };
  } catch (error) {
    if (error instanceof FieldDecryptionError) {
      return null;
    }
    throw error;
  }
}

/** The recipient's address, or `null` when the stored value cannot be decrypted (see above). */
function decryptAddress(ctx: WorkerContext, emailCiphertext: string): string | null {
  try {
    return decryptField(ctx.keyring, emailCiphertext);
  } catch (error) {
    if (error instanceof FieldDecryptionError) {
      return null;
    }
    throw error;
  }
}
