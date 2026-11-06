/**
 * The `notifications` queue: delivery of one outbox row's message to its recipient (AAP 0.3.2,
 * 0.3.3, 0.5.6).
 *
 * A domain transaction never sends anything. It writes a `Notification` outbox row — ids only — and
 * the API's dispatcher publishes that row as a `notifications`/`deliver` job carrying the row's id,
 * which is what makes this consumer idempotent per row: the per-channel Redis markers below
 * suppress a second send when a redelivered job is processed again.
 *
 * Two paths run through {@link process}:
 *
 * - **magic link** (`magicLinkTokenId`), the one kind that carries a token instead of a recipient
 *   (AAP 0.3.2, 0.3.3). The token row's `expiresAt` is read first and an expired row is cleared
 *   without sending, because a backlogged job must never mail a dead link. Otherwise the address and
 *   the raw token are decrypted, the message is sent and `deliveryTokenCiphertext` is nulled in the
 *   same step, so the raw token stops existing as soon as it has been used once.
 * - **every other kind**, addressed to a `userId` (AAP 0.5.6). A recipient who is gone or whose
 *   deletion has been requested is skipped, because a deleting account receives nothing (AAP 0.5.3).
 *   The message is rendered from the ids, the recipient's own experiment variant and the public
 *   venue or lodging name (AAP 0.5.7, 0.5.8), pushed to the recipient's registered devices where
 *   Expo push is configured for them, and mailed where it is not — email is the web fallback, the
 *   only channel a browser has (AAP 0.3.4).
 *
 * Three rules hold throughout. Time comes from the injected clock and never from the wall clock
 * (AAP 0.11.1). No SMTP or Expo traffic runs inside a database transaction. And no log line carries
 * an email address, a token, a push token, a message body or a booking field: the fields logged are
 * the outbox id, the kind, the channel and a reason (AAP 0.11.1).
 *
 * @see AAP 0.3.2 for the outbox and the magic-link flow, 0.3.3 for SMTP and Expo push, 0.5.3 for the
 *   lifecycle a notification reports, 0.5.6 for the job table, 0.5.7 for the framing variant and
 *   0.5.8 for the copy `notify/templates.ts` renders.
 */

import { DateTime } from 'luxon';

import type { DbTx } from '@tablemate/db';
import {
  QUEUE,
  FieldDecryptionError,
  QueuePayloadError,
  decryptField,
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

/*
 * What this job handles (AAP 0.3.2, 0.3.4).
 */

/** The parsed payload of a `notification` outbox row: a kind and the ids it concerns. */
type NotificationPayload = OutboxPayloadByKind['notification'];

/**
 * The parsed data of a `notifications`/`deliver` job: that payload plus the row id the job carries,
 * which is what makes a redelivery of the row a no-op (AAP 0.3.2).
 */
type NotificationJobData = JobDataByQueueAndName['notifications']['deliver'];

/**
 * The one kind that carries a token rather than a recipient: the account it will sign in may not
 * exist yet (AAP 0.3.2).
 */
const MAGIC_LINK_KIND: NotificationKind = 'magic_link';

/** The two channels one outbox row is delivered on; email is the fallback (AAP 0.3.4). */
type DeliveryChannel = 'push' | 'email';

/**
 * How long a sent marker lives. A redelivery only ever follows a dispatcher pass over the same row
 * within a job's retry horizon, so a week is far longer than any path that could repeat one, and
 * the marker then expires instead of leaving one key per outbox row in Redis forever.
 */
const SENT_KEY_TTL_SECONDS = 604_800;

/**
 * Why a notification was not delivered. `missing` is the row the payload names having been purged,
 * `expired` a magic link whose 15 minutes had passed, `already_sent` a redelivery of a row whose
 * message this channel already carried, `user_deleted` a recipient who is gone or deleting,
 * `undecryptable` a stored ciphertext no key of the ring can read, and `no_channel` a recipient
 * with neither a push token nor an address to send to (AAP 0.3.2, 0.5.3).
 */
export type NotificationSkip =
  'missing' | 'expired' | 'already_sent' | 'user_deleted' | 'undecryptable' | 'no_channel';

/**
 * What {@link process} did with one outbox row: the channel that carried the message, or why
 * nothing was sent. A skipped row is a decision, not a failure, so the job completes and BullMQ
 * records no retry for it.
 */
export type NotificationDeliveryResult =
  | { readonly channel: DeliveryChannel; readonly kind: NotificationKind }
  | { readonly skipped: NotificationSkip };

/*
 * Requesting delivery (AAP 0.3.2).
 */

/**
 * Writes the outbox row that asks for one notification, and returns its id.
 *
 * A `workers` job calls this inside the transaction that makes the change it announces, never
 * after it, so the message and the state it describes commit together: the API's outbox dispatcher
 * then delivers the row and a crash before the commit leaves neither. The payload is validated
 * before the insert, so an inconsistent row — a magic link without its token, or another kind
 * without its recipient — can never be committed.
 *
 * @param tx - the transaction the calling job is inside, so the row commits with its cause.
 * @param now - the instant of the change, from the injected clock (AAP 0.11.1).
 * @param payload - the kind and the ids it concerns. It carries no email address, name, booking
 *   field, coordinate or message body; the delivery job decrypts or loads what it needs.
 * @returns the new row's id, which becomes the job id that makes delivery idempotent.
 * @throws QueuePayloadError when `payload` does not satisfy the `notification` payload schema.
 * @see AAP 0.3.2 for the transactional outbox, 0.5.6 for the job table.
 */
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

/*
 * Redis markers, one per channel (AAP 0.3.2).
 */

/** The key marking that `channel` has carried this outbox row's message. */
function sentKey(outboxId: string, channel: DeliveryChannel): string {
  return `notify-sent:${outboxId}:${channel}`;
}

/** Whether `channel` already carried this row's message in an earlier run of this job. */
async function channelAlreadySent(
  ctx: WorkerContext,
  outboxId: string,
  channel: DeliveryChannel,
): Promise<boolean> {
  return (await ctx.redis.get(sentKey(outboxId, channel))) !== null;
}

/**
 * Marks `channel` as having carried this row's message.
 *
 * The marker is set with `NX`, so it never overwrites the marker an earlier run left, and its TTL is
 * {@link SENT_KEY_TTL_SECONDS}: the guarantee is per row and per channel, which is the granularity a
 * redelivery works at.
 */
async function markChannelSent(
  ctx: WorkerContext,
  outboxId: string,
  channel: DeliveryChannel,
): Promise<void> {
  await ctx.redis.set(sentKey(outboxId, channel), '1', 'EX', SENT_KEY_TTL_SECONDS, 'NX');
}

/** Nulls a magic-link row's raw token, guarded so it is written only for a row that still holds one. */
async function clearDeliveryToken(ctx: WorkerContext, tokenId: string): Promise<void> {
  await ctx.db.magicLinkToken.updateMany({
    where: { id: tokenId, deliveryTokenCiphertext: { not: null } },
    data: { deliveryTokenCiphertext: null },
  });
}

/*
 * Processing one job (AAP 0.5.6).
 */

/**
 * Delivers the notification the outbox row of `job.data` asks for, once (AAP 0.3.2).
 *
 * The row id the job carries is what makes a second run of the same job a no-op: the per-channel
 * markers of {@link deliver} record that a channel already carried the message. A skipped row
 * completes the job, while a failure of SMTP or Expo propagates so BullMQ retries the row (5 tries,
 * exponential backoff from 30 s), and the marker stops a retry from repeating a send that already
 * succeeded.
 *
 * @param job - the BullMQ job: its name must be `deliver`, and its data the row's payload plus
 *   `outboxId`.
 * @param ctx - the worker's dependencies: configuration, clock, logger, database, the `client`
 *   Redis connection and the field keyring.
 * @returns the channel that carried the message, or why nothing was sent.
 * @throws QueuePayloadError when the job name is not one this queue accepts, or its data does not
 *   satisfy the payload schema.
 * @see AAP 0.3.2 for the outbox, 0.3.3 for the channels, 0.5.6 for the queue.
 */
export async function process(
  job: { id?: string; name: string; data: unknown },
  ctx: WorkerContext,
): Promise<NotificationDeliveryResult> {
  const queue = QUEUE.notifications;

  // A name this queue does not accept has no schema to parse against, so it is refused here rather
  // than parsed as `deliver`: a foreign job arriving on this queue is a wiring fault, not a message.
  if (!isJobName(queue, job.name)) {
    throw new QueuePayloadError(`${queue}/${job.name}`);
  }

  const payload = parseJobData(queue, job.name, job.data);

  if (payload.magicLinkTokenId !== undefined) {
    return await deliverMagicLink(ctx, payload);
  }

  const recipientId = payload.userId;
  if (recipientId === undefined) {
    // The payload schema requires a recipient on every kind but the magic link (AAP 0.3.2), so this
    // guard is unreachable through the queue and exists for a hand-built job.
    throw new Error(`${payload.kind} notification carries no recipient`);
  }

  return await deliverToUser(ctx, payload, recipientId);
}

/**
 * Mails a magic link, or clears it without sending (AAP 0.3.2, 0.3.3).
 *
 * The order of the checks is the point of this path. `expiresAt` is read before anything is
 * decrypted or sent, so a job that reaches a link after its 15 minutes clears the raw token and
 * stops: a backlogged queue delays a sign-in, it never mails a dead link. A row whose token has
 * already been cleared is a link that has been sent, and a row whose email marker exists is one
 * whose mail went out before a crash stopped the job — neither sends again.
 */
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
    // Purged 24 hours after it expired (AAP 0.5.2): the link is long dead, so there is nothing to do.
    ctx.logger.warn({ event: 'notification_skipped', ...log, reason: 'missing' });
    return { skipped: 'missing' };
  }

  if (token.expiresAt.getTime() <= ctx.clock.now().getTime()) {
    await clearDeliveryToken(ctx, tokenId);
    ctx.logger.info({ event: 'notification_skipped', ...log, reason: 'expired' });
    return { skipped: 'expired' };
  }

  const ciphertext = token.deliveryTokenCiphertext;
  if (ciphertext === null) {
    ctx.logger.info({ event: 'notification_skipped', ...log, reason: 'already_sent' });
    return { skipped: 'already_sent' };
  }

  if (await channelAlreadySent(ctx, payload.outboxId, 'email')) {
    // The mail went out and the process died before the row was cleared: clearing it here finishes
    // what the earlier run started instead of sending the link a second time.
    await clearDeliveryToken(ctx, tokenId);
    ctx.logger.info({ event: 'notification_skipped', ...log, reason: 'already_sent' });
    return { skipped: 'already_sent' };
  }

  const secrets = magicLinkSecrets(ctx, token.emailCiphertext, ciphertext);
  if (secrets === null) {
    await clearDeliveryToken(ctx, tokenId);
    ctx.logger.warn({ event: 'notification_skipped', ...log, reason: 'undecryptable' });
    return { skipped: 'undecryptable' };
  }

  const rendered = renderNotification(MAGIC_LINK_KIND, {
    webOrigin: ctx.env.WEB_ORIGIN,
    magicLinkToken: secrets.token,
  });

  await ctx.mailer.send({
    to: secrets.to,
    subject: rendered.emailSubject,
    text: rendered.emailText,
  });

  // The marker is written before the token is cleared, so a crash in between leaves a row that the
  // next run recognises as sent rather than mails again.
  await markChannelSent(ctx, payload.outboxId, 'email');
  await clearDeliveryToken(ctx, tokenId);

  ctx.logger.info({ event: 'notification_sent', ...log, channel: 'email' });
  return { channel: 'email', kind: MAGIC_LINK_KIND };
}

/**
 * Delivers one addressee's notification: the recipient's own message, on push where they have
 * registered devices and by email where they have not (AAP 0.3.4).
 */
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

  // An erased account is a tombstone and a deleting one is about to become one (AAP 0.5.2, 0.5.3):
  // neither is told anything, and the row is acknowledged rather than retried.
  if (user === null || user.deletedAt !== null || user.deletionRequestedAt !== null) {
    ctx.logger.info({ event: 'notification_skipped', ...log, reason: 'user_deleted' });
    return { skipped: 'user_deleted' };
  }

  const gathered = await gatherRenderData(ctx, payload, recipientId);
  if (gathered === null) {
    ctx.logger.warn({ event: 'notification_skipped', ...log, reason: 'missing' });
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

/*
 * Rendering the message (AAP 0.5.7, 0.5.8).
 */

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
 * Loads what the message of `payload.kind` may read: the meetup it concerns — named directly, or
 * reached through the dispute it names — that meetup's venue and city-local start time, the
 * counterpart's handle, the recipient's framing variant and the deposit for a deposit kind, the
 * dispute's outcome, or the lodging's public name for a claim kind (AAP 0.5.6, 0.5.7, 0.5.8).
 *
 * Only what the kind needs is loaded, and nothing personal reaches the copy: the data carries ids,
 * a public venue or lodging name, a handle, a formatted start time in the venue city's zone and
 * amounts in cents. It never carries an email address, a real name, a booking detail, a phone number
 * or a coordinate (AAP 0.5.2, 0.11.1).
 *
 * A handle is absent rather than empty once its owner has been erased, so the copy falls back to its
 * generic phrase (`notify/templates.ts`).
 *
 * @returns the render data and the meetup id, or `null` when a row the payload names has been
 *   purged and there is therefore nothing to say.
 */
async function gatherRenderData(
  ctx: WorkerContext,
  payload: NotificationJobData,
  recipientId: string,
): Promise<GatheredNotification | null> {
  const data: NotificationRenderData = { webOrigin: ctx.env.WEB_ORIGIN };

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
  return DateTime.fromJSDate(startsAt, { zone: timezone }).toFormat('ccc d LLL, HH:mm');
}

/** Whether the copy of `kind` is framed in the recipient's variant (AAP 0.5.7, 0.5.8). */
function isDepositKind(kind: NotificationKind): boolean {
  return DEPOSIT_NOTIFICATION_KINDS.some((deposit) => deposit === kind);
}

/**
 * The recipient's own framing variant (AAP 0.5.7): the framing sentence a deposit notification
 * carries is the recipient's variable, never the counterpart's.
 *
 * @throws Error when the recipient holds no assignment. Every account is assigned one at creation,
 *   so a missing row is a data fault rather than a transient failure: failing the job puts it in
 *   BullMQ's failed set, where an operator sees it, instead of dropping a message about money.
 */
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

/*
 * The outcome sentence (AAP 0.5.3, 0.5.7, 0.5.8).
 */

/**
 * The outcome sentence `kind` selects, derived from the recipient's own side of the meetup, or
 * `undefined` for a kind that reports no outcome.
 */
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

/**
 * The money sentence a cancellation notification carries, from the recipient's own side.
 *
 * `forfeited` is the one status that moves money, and the settlement records which side was absent
 * whatever the forfeit reason: a late cancellation records the canceller absent and the counterpart
 * present, a no-show records the absent party absent (AAP 0.5.7). The absent party therefore reads
 * that its deposit was charged and the present one that it was credited, while every other status —
 * an early cancellation, a decline, a lapse, a block or a deletion — releases both holds.
 */
function forfeitOutcome(meetup: MeetupForNotification, recipientId: string): NotificationOutcome {
  if (meetup.status !== 'forfeited') {
    return 'released';
  }

  const settlement = meetup.settlement;
  if (settlement === null) {
    // A forfeit and its settlement row are written in one transaction, so a missing row is a data
    // fault: refusing to guess is what keeps a wrong sentence about money off the wire.
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

/**
 * Which lock-lost sentence the recipient reads (AAP 0.3.2, 0.5.3, 0.5.8): a deposit that was
 * captured is being refunded by the no-forfeit compensation, while one that was never captured —
 * a hold that expired, or an authorization Stripe cancelled — is simply being released.
 */
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

/*
 * Choosing the channel (AAP 0.3.4).
 */

/**
 * Sends one rendered notification on the channel the recipient has, once.
 *
 * Push comes first where Expo push is configured and the recipient has registered devices; email is
 * the fallback, which is the only channel a browser has. A marker for the channel that already
 * carried the message ends the job with nothing sent, and a send that reaches nobody on push —
 * because every token was invalid — falls through to email, so the recipient is not left uninformed
 * by a device that has gone away. Tokens Expo reports as unregistered are deleted.
 *
 * @param emailCiphertext - the recipient's stored address, `null` once their account is erased.
 * @returns the channel that carried the message, or why nothing was sent.
 * @throws the mailer's or the push sender's own failure, so the job retries; the marker set after a
 *   successful send stops that retry from repeating it.
 */
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

    if (result.sent > 0) {
      await markChannelSent(ctx, payload.outboxId, 'push');
      ctx.logger.info({ event: 'notification_sent', ...log, channel: 'push' });
      return { channel: 'push', kind: payload.kind };
    }
  }

  if (await channelAlreadySent(ctx, payload.outboxId, 'email')) {
    return { skipped: 'already_sent' };
  }

  if (emailCiphertext === null) {
    // No device to push to and no address to mail: the account holds no stored address. An erased
    // or deleting recipient is skipped before here, so this is a data gap rather than a tombstone,
    // and the row is recorded as undeliverable instead of being retried until it fails.
    ctx.logger.warn({ event: 'notification_skipped', ...log, reason: 'no_channel' });
    return { skipped: 'no_channel' };
  }

  const to = decryptAddress(ctx, emailCiphertext);
  if (to === null) {
    ctx.logger.warn({ event: 'notification_skipped', ...log, reason: 'undecryptable' });
    return { skipped: 'undecryptable' };
  }

  await ctx.mailer.send({ to, subject: rendered.emailSubject, text: rendered.emailText });
  await markChannelSent(ctx, payload.outboxId, 'email');

  ctx.logger.info({ event: 'notification_sent', ...log, channel: 'email' });
  return { channel: 'email', kind: payload.kind };
}

/*
 * Secrets (AAP 0.3.2).
 */

/**
 * The address and the raw token of a magic-link row, or `null` when either cannot be decrypted.
 *
 * A `FieldDecryptionError` — a value written under a key this ring does not hold, or one that has
 * been altered — is permanent: no retry can read it, so the caller clears the row instead of failing
 * the job five times over. Any other failure is a real fault and is rethrown.
 */
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
