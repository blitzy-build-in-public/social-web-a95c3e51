/**
 * The cancellation rules' unit suite (AAP 0.5.3, 0.7.3): the two-hour free-cancellation boundary, the
 * status a cancel, a block and an account deletion reach from each status that accepts them, and the
 * status a late cancellation ends on.
 *
 * Everything here is pure. `isLateCancel` — imported from `meetups/cancel.ts`, the contract that folder
 * names — and `lateCancelFrom` are the two halves of the one boundary the screen shows
 * (`MeetupDto.lateCancelFrom`) and the guard applies, and `nextStatus` is the transition table of
 * AAP 0.5.3 read without a database.
 *
 * The one rule the table does not carry is the late cancellation itself: `state-machine.ts` refuses
 * `cancel` and `deletion` on a `locked` meetup once `isLateCancel` is true, and the forfeit is applied
 * by `settlement/settle.ts` with the outcome already known (`late_cancel`), which the table lands on
 * `forfeited`. The rows below therefore assert both the lateness the guard sees at the row's instant and
 * the status the table names, so the free cancellation and the settlement's row are pinned together.
 *
 * The open-dispute branch is deliberately absent: `applyCancellationRules` reads the `Dispute` row
 * inside its own transaction, so it is covered where the database is — `integration/meetups.test.ts`
 * (`409 dispute_open`), `integration/users-safety.test.ts` (a block resolves the open dispute `no_fault`
 * with the note `cancelled_by_block`) and `tests/system/account-deletion.test.ts` (a deletion that
 * leaves the meetup and its money to the operator).
 *
 * @see AAP 0.5.3 for the transition table, the boundary and the account-deletion disposition; 0.7.3 for
 *   the safety-wins and late-deletion interpretations; 0.5.4 for the errors a refusal maps to; 0.11.1 for
 *   the injected clock; 0.8.1 for this file.
 */

import { describe, expect, it } from 'vitest';

import { FINAL_MEETUP_STATUSES, HOUR_MS, LATE_CANCEL_WINDOW_HOURS } from '@tablemate/shared';
import type { MeetupStatus, SettlementOutcome } from '@tablemate/shared';

import { isLateCancel } from '../../src/modules/meetups/cancel.ts';
import { lateCancelFrom } from '../../src/modules/meetups/queries.ts';
import {
  MEETUP_TRANSITIONS,
  SETTLE_OUTCOME_STATUSES,
  isLateCancel as isLateCancelFromStateMachine,
  nextStatus,
} from '../../src/modules/meetups/state-machine.ts';
import type { MeetupEvent } from '../../src/modules/meetups/state-machine.ts';
import { meetupPointMs } from '../support/clock.ts';

/** The fixed start every case is judged against: 2026-11-20T19:00:00Z (AAP 0.5.3). */
const STARTS_AT = new Date(Date.UTC(2026, 10, 20, 19, 0, 0));

/** One second, the smallest step past the boundary a case needs. */
const SECOND_MS = 1_000;

/** The instant a cancellation stops being free: `startsAt - LATE_CANCEL_WINDOW_HOURS` (AAP 0.5.3). */
const BOUNDARY_MS = STARTS_AT.getTime() - LATE_CANCEL_WINDOW_HOURS * HOUR_MS;

/** Epoch milliseconds `offsetMs` from that boundary. */
function atBoundary(offsetMs: number): Date {
  return new Date(BOUNDARY_MS + offsetMs);
}

/** One millisecond past the boundary: the first late instant there is, for the cases without a row. */
const LATE = atBoundary(1);

/** The acting participant; every cancellation event of the table carries one (AAP 0.5.3). */
const ACTOR_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * A {@link MeetupEvent} whose instant is explicit: `MeetupEventFields.at` is optional for the handlers
 * that read the injected clock, and every event here names the instant it is judged at, so a row states
 * the lateness the guard sees beside the status the table names.
 */
type TimedEvent = MeetupEvent & { readonly at: Date };

/** A participant's own cancellation, judged at `at`. */
function cancel(at: Date): TimedEvent {
  return { type: 'cancel', actorId: ACTOR_ID, reason: 'initiator', at };
}

/** A block, which `users/safety.ts` applies directly (AAP 0.5.3). */
function block(at: Date): TimedEvent {
  return { type: 'block', actorId: ACTOR_ID, at };
}

/** An account deletion, which follows the cancellation rules (AAP 0.5.3, 0.7.3). */
function deletion(at: Date): TimedEvent {
  return { type: 'deletion', actorId: ACTOR_ID, at };
}

/** A settlement's outcome, the event `settlement/settle.ts` applies (AAP 0.5.3, 0.5.7). */
function settle(outcome: SettlementOutcome): TimedEvent {
  return { type: 'settle', outcome, at: STARTS_AT };
}

/** The three cancellation events of the table (AAP 0.5.3). */
type CancellationKind = 'cancel' | 'block' | 'deletion';

/** The event `kind` names, judged at `at`. */
function eventFor(kind: CancellationKind, at: Date): TimedEvent {
  switch (kind) {
    case 'cancel':
      return cancel(at);
    case 'block':
      return block(at);
    case 'deletion':
      return deletion(at);
  }
}

/** A boundary case: how far from the boundary the cancellation is judged, and its verdict. */
type BoundaryCase = readonly [offsetMs: number, late: boolean];

const BOUNDARY_CASES: readonly BoundaryCase[] = [
  [-HOUR_MS, false],
  [-SECOND_MS, false],
  [0, false], // exactly startsAt − 2 h: still free (AAP 0.5.3)
  [1, true],
  [SECOND_MS, true], // one second past the boundary
  [2 * HOUR_MS, true], // = startsAt, the meetup's own start
  [3 * HOUR_MS, true], // after the start: settlement is due at startsAt + 45 min
];

describe('AAP 0.5.3 the two-hour late-cancellation boundary', () => {
  it('is the same two hours in the shared constant and in `lateCancelFrom`', () => {
    expect(LATE_CANCEL_WINDOW_HOURS).toBe(2);
    // `MeetupDto.lateCancelFrom` is what a screen shows, and `meetupPointMs` is the suite's own name
    // for the same instant: both must equal the guard's boundary (AAP 0.5.3, 0.5.4).
    expect(lateCancelFrom(STARTS_AT).getTime()).toBe(BOUNDARY_MS);
    expect(meetupPointMs(STARTS_AT, 'startsAt-2h')).toBe(BOUNDARY_MS);
  });

  it.each(BOUNDARY_CASES)('isLateCancel at the boundary %i ms -> %s', (offsetMs, late) => {
    expect(isLateCancel(atBoundary(offsetMs), STARTS_AT)).toBe(late);
  });

  it('is the one guard the state machine defines, re-exported so the two cannot drift apart', () => {
    expect(isLateCancel).toBe(isLateCancelFromStateMachine);
  });
});

/**
 * A cancellation case: the status it starts from, the event, how far from the boundary it lands, the
 * lateness that follows, and the status the table names (AAP 0.5.3).
 */
type CancellationCase = readonly [
  from: MeetupStatus,
  kind: CancellationKind,
  offsetMs: number,
  late: boolean,
  to: MeetupStatus | null,
];

/**
 * The cancellation rows of the table (AAP 0.5.3): before the lock a cancellation is always free, from
 * `locked` the free row is the one `transition` allows at or before `startsAt − 2 h`, and a block
 * cancels whenever it lands.
 */
const CANCELLATION_CASES: readonly CancellationCase[] = [
  // Before the lock, `applyCancellationRules` answers `cancelled` with `lateCancel: false` whatever
  // the hour, because there is no hold of the canceller's own to capture.
  ['proposed', 'cancel', -HOUR_MS, false, 'cancelled'],
  ['proposed', 'cancel', 1, true, 'cancelled'],
  ['proposed', 'block', 1, true, 'cancelled'],
  ['proposed', 'deletion', -HOUR_MS, false, 'cancelled'],
  ['locked', 'cancel', -HOUR_MS, false, 'cancelled'],
  ['locked', 'cancel', 0, false, 'cancelled'], // exactly startsAt − 2 h: still free
  ['locked', 'deletion', 0, false, 'cancelled'],
  // Late: the table names the free row and `transition` refuses it, because the forfeit is the
  // settlement's `late_cancel` row (asserted below) rather than a status this event writes.
  ['locked', 'cancel', 1, true, 'cancelled'],
  ['locked', 'deletion', 1, true, 'cancelled'],
  ['locked', 'block', -HOUR_MS, false, 'cancelled'],
  ['locked', 'block', 1, true, 'cancelled'], // safety wins (AAP 0.7.3)
];

describe('AAP 0.5.3 cancellation transitions', () => {
  it.each(CANCELLATION_CASES)(
    '%s + %s at the boundary %i ms (late=%s) -> %s',
    (from, kind, offsetMs, late, to) => {
      const event = eventFor(kind, atBoundary(offsetMs));
      expect(isLateCancel(event.at, STARTS_AT)).toBe(late);
      expect(nextStatus(from, event)).toBe(to);
    },
  );

  it('AAP 0.5.3 a late cancellation ends `forfeited` through the settlement', () => {
    // `applyCancellationRules` answers `late` and applies it as `settleMeetup(..., 'late_cancel')`.
    expect(SETTLE_OUTCOME_STATUSES.late_cancel).toBe('forfeited');
    expect(nextStatus('locked', settle('late_cancel'))).toBe('forfeited');
    // A no-show is the same status and a different `forfeitReason` (AAP 0.5.3).
    expect(nextStatus('locked', settle('no_show'))).toBe('forfeited');
  });

  it('AAP 0.7.3 safety wins: a block cancels a locked meetup at any hour and never forfeits', () => {
    expect(MEETUP_TRANSITIONS.locked.block).toBe('cancelled');
    expect(Object.values(MEETUP_TRANSITIONS.locked)).not.toContain('forfeited');
    expect(nextStatus('locked', block(LATE))).toBe('cancelled');
  });

  it.each(FINAL_MEETUP_STATUSES)(
    'AAP 0.5.3 a final meetup refuses a cancellation (%s)',
    (status) => {
      // The handler maps the refusal to `409 already_settled` (AAP 0.5.4).
      expect(nextStatus(status, cancel(LATE))).toBeNull();
      expect(nextStatus(status, block(LATE))).toBeNull();
      expect(nextStatus(status, deletion(LATE))).toBeNull();
    },
  );
});
