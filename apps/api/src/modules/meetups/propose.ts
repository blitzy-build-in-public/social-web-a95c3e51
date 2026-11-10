/**
 * The proposal handler, `POST /meetups`: the commitment lock's first half.
 *
 * One request creates the meetup as `proposed`, its initiator's deposit and that deposit's first hold attempt, and
 * then places the hold. The guards run in the order the contract lists them: `422 self_proposal` first, before any
 * read or write, because that failure has to leave no meetup, deposit, operation or PaymentIntent behind; then
 * `404 venue_not_found` / `404 user_not_found` (also when a block exists in either direction), `403 no_valid_proof`
 * for either participant, `422 venue_not_partner`, `422 starts_at_invalid`, `422 deposit_invalid` and
 * `409 meetup_exists`.
 *
 * **The proposal is invisible until the money decision is durable.** Everything but the guards is one transaction —
 * the meetup with `proposalVisibleAt` and `recipientDeadline` left null, the initiator's `Deposit` at attempt 1, the
 * `hold` `PaymentOperation` — and the hold runs after the commit, because its result is the response. A `held`
 * outcome makes the proposal visible through `applyHoldOutcome`, which sets
 * `recipientDeadline = min(proposalVisibleAt + 48 h, startsAt)`, notifies the recipient and emits `proposal_sent`; a
 * `requires_action` hold is completed by the client's 3-D Secure step and made visible by the webhook. This file's
 * only timer is the lapse at `createdAt + 48 h`, which covers the window in which the recipient sees nothing.
 *
 * **A failed hold does not lose the proposal.** `402 hold_failed` leaves the meetup `proposed`, so the initiator
 * recovers its id from `GET /meetups` and retries through `POST /meetups/:id/hold`; `503 payment_unavailable` leaves
 * the deposit `pending` while the sweeper replays the identical create under the original key. Neither creates a
 * second authorization, and no caller is ever answered with the counterpart's client secret. {@link inlineHoldOrThrow}
 * is exported because `accept.ts` and the hold-retry handler map the same outcomes.
 *
 * No Stripe or Redis call runs inside the transaction; time comes only from `now`, which is `request.receivedAt`, and
 * money is integer USD cents.
 */

import {
  DAY_MS,
  HOUR_MS,
  RECIPIENT_DEADLINE_HOURS,
  START_HORIZON_DAYS,
  isDepositLevel,
} from '@tablemate/shared';
import type { MeetupStatus, ProposeMeetup, ProposeResponse } from '@tablemate/shared';
import { isUniqueViolation } from '@tablemate/db';
import type { DbTx } from '@tablemate/db';

import { AppError } from '../../plugins/errors.ts';
import { variantFor } from '../experiment/assignment.ts';
import { variantPairing } from '../experiment/copy.ts';
import { transact } from '../outbox/write.ts';
import { planHold } from '../payments/holds.ts';
import { executeHoldInline } from '../payments/operations.ts';
import type { HoldExecution } from '../payments/operations.ts';
import { hasValidProof } from '../proofs/validity.ts';
import { scheduleLapse } from '../settlement/timers.ts';

import type { AppServices } from '../../app.ts';

/**
 * The partial unique index that admits one open meetup per pair, in either initiator/recipient order:
 * `UNIQUE (LEAST(initiator_id, recipient_id), GREATEST(...)) WHERE status IN ('proposed', 'locked')`.
 *
 * The insert cannot rely on the read above it: two proposals for one pair can pass the same read in two
 * transactions, and `isUniqueViolation` naming this index is what turns the loser into `409 meetup_exists` rather
 * than a `500 internal_error` (AAP 0.5.4).
 */
const OPEN_PAIR_INDEX = 'meetup_open_pair_key';

/** The meetup statuses that are open, which is exactly the predicate of {@link OPEN_PAIR_INDEX}. */
const OPEN_STATUSES = ['proposed', 'locked'] as const satisfies readonly MeetupStatus[];

/** The event name the single log line of this file carries (AAP 0.11.1). */
const PROPOSE_EVENT = 'meetup_proposed';

/** What {@link inlineHoldOrThrow} is told about the route asking (AAP 0.5.4). */
export interface InlineHoldOptions {
  /**
   * The code an outcome of `pending` is answered with: `payment_unavailable` on `POST /meetups`, where the
   * initiator retries the hold, and `hold_pending` on a repeated accept, where the recipient's own attempt is
   * still being recovered (AAP 0.3.2, 0.5.4).
   */
  readonly pendingCode: 'payment_unavailable' | 'hold_pending';
}

/** The hold a route can answer with: the outcome, and the caller's own client secret to confirm. */
export interface InlineHoldHeld {
  readonly outcome: 'held' | 'requires_action';
  /** The caller's own current attempt's secret, never the counterpart's (AAP 0.5.4). */
  readonly clientSecret: string;
}

/**
 * Map one inline hold attempt's outcome onto the response of the route that asked for it (AAP 0.5.4).
 *
 * The five outcomes `executeHoldInline` reports become three answers, and the two that carry a secret are always
 * the caller's own: the attempt belongs to the deposit the route authorized the caller against, so `accept` and
 * the hold retry — each serving one side of the meetup — can only return that side's secret.
 *
 * `failed` is `402 hold_failed` (no saved card, a decline) and leaves the meetup and its deposit as they were, so
 * a retry is allowed. `unavailable` and `pending` mean Stripe's answer to the create was lost and is being
 * recovered: the deposit stays `pending`, no second authorization is created, and the client recovers through
 * `GET /meetups` (AAP 0.3.2).
 *
 * @throws AppError `hold_failed` (402) for `failed`, `payment_unavailable` (503) for `unavailable` and for an
 *   authorized outcome that carries no secret, and `opts.pendingCode` for `pending`.
 */
export function inlineHoldOrThrow(result: HoldExecution, opts: InlineHoldOptions): InlineHoldHeld {
  const { outcome, clientSecret } = result;
  switch (outcome) {
    case 'held':
    case 'requires_action': {
      if (clientSecret === undefined) {
        // A hold that authorized without a secret cannot be confirmed by the client, so it is
        // reported as recoverable rather than as a success.
        throw new AppError('payment_unavailable');
      }
      return { outcome, clientSecret };
    }
    case 'failed':
      throw new AppError('hold_failed');
    case 'unavailable':
      throw new AppError('payment_unavailable');
    case 'pending':
      throw new AppError(opts.pendingCode);
    default:
      // Unreachable while `HoldExecution` holds five outcomes; a sixth added later must fail closed,
      // because an outcome whose money decision is unknown is exactly what `503` means here.
      throw new AppError('payment_unavailable');
  }
}

/**
 * Whether a block stands between two accounts in either direction (AAP 0.5.3). The row is read by its pair, never
 * by the caller's direction alone, so the blocked side receives the same answer as the blocker; asked before the
 * proposal exists, it leaves no meetup between two users who must not meet.
 */
async function blockedBetween(tx: DbTx, a: string, b: string): Promise<boolean> {
  const row = await tx.block.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { blockerId: true },
  });
  return row !== null;
}

/**
 * The pair's open meetup, if it has one (AAP 0.5.2, 0.5.3). "Open" is a meetup in `proposed` or `locked` — the
 * predicate of {@link OPEN_PAIR_INDEX} — matched in either initiator/recipient order, so a meetup the counterpart
 * initiated blocks a new proposal just as one the caller initiated does.
 */
async function openMeetupFor(tx: DbTx, a: string, b: string): Promise<string | null> {
  const row = await tx.meetup.findFirst({
    where: {
      status: { in: [...OPEN_STATUSES] },
      OR: [
        { initiatorId: a, recipientId: b },
        { initiatorId: b, recipientId: a },
      ],
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** What the proposal transaction resolves with: the ids its post-commit work needs (AAP 0.3.2). */
interface ProposalCommit {
  /** The new meetup. */
  readonly meetupId: string;
  /** The `hold` operation the executor runs after the commit. */
  readonly operationId: string;
}

/**
 * Propose a meetup and place the initiator's commitment-lock hold (AAP 0.5.4).
 *
 * Every guard runs inside the transaction that creates the meetup, so the checks and the insert read one snapshot:
 * a venue deactivated, a proof expired or a block written between two reads cannot be overtaken by a proposal based
 * on the earlier one. The transaction is fenced on the caller, so it cannot commit for an account whose deletion is
 * in flight (AAP 0.5.3), and it takes no row lock, because the meetup it is about to create is the only row it
 * could hold.
 *
 * The hold comes after the commit: a `held` outcome makes the proposal visible and starts the recipient's 48-hour
 * deadline through `applyHoldOutcome`, `requires_action` leaves the client to complete 3-D Secure, and `failed`,
 * `unavailable` and `pending` are the errors below, each with the meetup left where it stands.
 *
 * @throws AppError `self_proposal` (422), `venue_not_found` (404), `user_not_found` (404), `no_valid_proof` (403),
 *   `venue_not_partner` (422), `starts_at_invalid` (422), `deposit_invalid` (422), `meetup_exists` (409),
 *   `hold_failed` (402) or `payment_unavailable` (503), in that order.
 */
export async function proposeMeetup(
  services: AppServices,
  userId: string,
  body: ProposeMeetup,
  now: Date,
): Promise<ProposeResponse> {
  // 1. A proposal to oneself, refused before any read or write: the failing case must leave no
  //    meetup, deposit, operation or PaymentIntent to clean up (AAP 0.5.4).
  if (body.recipientId === userId) {
    throw new AppError('self_proposal');
  }
  const startsAt = new Date(body.startsAt);
  const horizonEnd = now.getTime() + START_HORIZON_DAYS * DAY_MS;
  const commit = await transact(
    services,
    async (tx, after): Promise<ProposalCommit> => {
      // 2. The venue and the recipient, as the one snapshot every later check reads. A fixture venue
      //    is hidden outside `test` and `demo` by the client's fixture guard, so it answers 404 here
      //    exactly like an unknown id (AAP 0.5.2).
      const venue = await tx.venue.findUnique({
        where: { id: body.venueId },
        select: { id: true, cityId: true, isActivePartner: true },
      });
      if (venue === null) {
        throw new AppError('venue_not_found');
      }
      const recipient = await tx.user.findFirst({
        where: { id: body.recipientId, deletedAt: null, deletionRequestedAt: null },
        select: { id: true },
      });
      if (recipient === null || (await blockedBetween(tx, userId, body.recipientId))) {
        // A deleted, deleting or blocked recipient is answered like a stranger, which keeps a block
        // undiscoverable (AAP 0.5.3, 0.5.4).
        throw new AppError('user_not_found');
      }
      // 3. Both sides need a proof valid for the venue's city now: an unverified user can neither
      //    propose nor be proposed to (AAP 0.5.7).
      if (!(await hasValidProof(tx, userId, venue.cityId, now))) {
        throw new AppError('no_valid_proof');
      }
      if (!(await hasValidProof(tx, body.recipientId, venue.cityId, now))) {
        throw new AppError('no_valid_proof');
      }
      // 4. Meetups happen at active partner venues only (AAP 0.5.4).
      if (!venue.isActivePartner) {
        throw new AppError('venue_not_partner');
      }
      // 5. The start must be ahead of `now` and inside the five-day horizon: exactly five days is
      //    allowed, one minute more is not (AAP 0.5.4). An instant that cannot be read at all is
      //    outside the horizon by definition.
      const startsAtMs = startsAt.getTime();
      if (Number.isNaN(startsAtMs) || startsAtMs < now.getTime() || startsAtMs > horizonEnd) {
        throw new AppError('starts_at_invalid');
      }
      // 6. The deposit is one of the three levels and is always charged in USD (AAP 0.5.7, 0.7.3).
      if (!isDepositLevel(body.depositCents)) {
        throw new AppError('deposit_invalid');
      }
      // 7. One open meetup per pair, in either order; the insert below is the backstop for two
      //    proposals that pass this read in two transactions (AAP 0.5.2, 0.5.4).
      if ((await openMeetupFor(tx, userId, body.recipientId)) !== null) {
        throw new AppError('meetup_exists');
      }
      // The pair's framing variant is fixed here, at proposal, and never recomputed: `mixed` covers
      // two different variants and a missing assignment alike, so every meetup counts exactly once
      // under the dashboard's variant filter (AAP 0.5.7).
      const initiatorAssignment = await variantFor(tx, userId);
      const recipientAssignment = await variantFor(tx, body.recipientId);
      let meetup: { id: string };
      try {
        meetup = await tx.meetup.create({
          data: {
            initiatorId: userId,
            recipientId: body.recipientId,
            venueId: venue.id,
            startsAt,
            depositCents: body.depositCents,
            status: 'proposed',
            variantPairing: variantPairing(
              initiatorAssignment?.variant ?? null,
              recipientAssignment?.variant ?? null,
              services.logger,
            ),
            createdAt: now,
          },
          select: { id: true },
        });
      } catch (error) {
        // The only collision this insert can hit is the pair's open-meetup index, so a match is the
        // concurrent duplicate rather than a defect.
        if (isUniqueViolation(error, OPEN_PAIR_INDEX)) {
          throw new AppError('meetup_exists');
        }
        throw error;
      }
      // The recipient sees nothing yet: `proposalVisibleAt` and `recipientDeadline` stay null until
      // the initiator's hold is held, which `applyHoldOutcome` applies after this commit (AAP 0.5.3).
      const deposit = await tx.deposit.create({
        data: {
          meetupId: meetup.id,
          ownerId: userId,
          role: 'initiator',
          status: 'pending',
          amountCents: body.depositCents,
          currentAttempt: 1,
        },
      });
      // The first attempt's durable plan, keyed `hold:<depositId>:1` by the planner: the executor
      // sends it, and the sweeper replays it verbatim, should this request die before it answers.
      const holdOperation = await planHold(tx, { deposit, attempt: 1 }, now);
      // Lapse while the proposal is still invisible. `markProposalVisible` replaces this job with one
      // at the recipient deadline. Registered for after the commit: no queue write inside the
      // transaction (AAP 0.3.2, 0.5.3).
      const lapseAt = new Date(now.getTime() + RECIPIENT_DEADLINE_HOURS * HOUR_MS);
      after(() => scheduleLapse(services, meetup.id, lapseAt));
      return { meetupId: meetup.id, operationId: holdOperation.id };
    },
    { fenceUserId: userId },
  );
  // 8. The hold's result is the response, so it is placed here, after the commit, and never inside
  //    the transaction. It is confirmed on-session as a customer-initiated payment, which is what
  //    gives it the seven-day validity a start inside the five-day horizon settles well within
  //    (AAP 0.2.4). A `held` outcome makes the proposal visible and notifies the recipient.
  const authorized = inlineHoldOrThrow(await executeHoldInline(services, commit.operationId), {
    pendingCode: 'payment_unavailable',
  });
  services.logger.info({ event: PROPOSE_EVENT, meetupId: commit.meetupId }, PROPOSE_EVENT);
  return {
    meetupId: commit.meetupId,
    status: 'proposed',
    clientSecret: authorized.clientSecret,
  };
}
