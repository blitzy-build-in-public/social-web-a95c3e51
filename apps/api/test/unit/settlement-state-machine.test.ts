/**
 * The meetup state machine, the deposit lifecycle, the settlement outcome table and the late and
 * orphan authorization rules, as one unit suite (AAP 0.5.3, 0.5.7, 0.7.1, 0.8.1, 0.11.2).
 */

import { describe, expect, it } from 'vitest';

import {
  DepositStatus,
  FINAL_DEPOSIT_STATUSES,
  FINAL_MEETUP_STATUSES,
  HOUR_MS,
  MeetupStatus,
  PaymentOperationStatus,
  SettlementOutcome,
  type ForfeitReason,
  type ParticipantRole,
} from '@tablemate/shared';

import {
  InvalidTransitionError,
  MEETUP_TRANSITIONS,
  SETTLE_OUTCOME_STATUSES,
  isLateCancel,
  nextStatus,
  type MeetupEvent,
  type MeetupEventType,
} from '../../src/modules/meetups/state-machine.ts';
import {
  DEPOSIT_TRANSITIONS,
  canTransitionDeposit,
  fromStatusesFor,
  holdKey,
  isHandedOffHold,
  isTerminalOperation,
} from '../../src/modules/payments/holds.ts';
import {
  SETTLEMENT_TABLE,
  lateCancelPlan,
  otherRole,
  settlementPlan,
  type Presence,
  type SettlementFinalStatus,
  type SettlementPlan,
} from '../../src/modules/settlement/outcomes.ts';

// ---------------------------------------------------------------------------------------------
// Fixtures: the events of the AAP 0.5.3 table (nothing here reaches a database)
// ---------------------------------------------------------------------------------------------

/** Stable ids for the events below; any uuid serves, because every unit under test is pure. */
const MEETUP_ID = '11111111-1111-7111-8111-111111111111';
const INITIATOR_ID = '22222222-2222-7222-8222-222222222222';
const DEPOSIT_ID = '33333333-3333-7333-8333-333333333333';
const OPERATOR_ID = '44444444-4444-7444-8444-444444444444';

/** Stripe's own cancellation instant, which a `hold_lost` event carries (AAP 0.5.3). */
const CANCELED_AT = new Date('2026-11-04T12:00:00.000Z');

/** Every event type of the AAP 0.5.3 table, in the table's own order. */
const EVENT_TYPES = [
  'recipient_hold_held',
  'decline',
  'lapse',
  'cancel',
  'block',
  'deletion',
  'hold_lost',
  'settle',
  'operator_no_fault',
  'compensate',
] as const satisfies readonly MeetupEventType[];

/** A `settle` event for one outcome: the only event whose target comes from its own payload. */
function settleEvent(outcome: SettlementOutcome): MeetupEvent {
  return { type: 'settle', outcome };
}

/**
 * One event per {@link MeetupEventType}, with the payload its variant requires (AAP 0.5.3).
 *
 * The `Record` makes the factory total, so a variant added to {@link MeetupEvent} fails the build
 * here until it has an event. The `settle` entry carries `completed`; the other three outcomes are
 * rows of the settlement table below.
 */
const EVENTS: Readonly<Record<MeetupEventType, MeetupEvent>> = {
  recipient_hold_held: { type: 'recipient_hold_held' },
  decline: { type: 'decline' },
  lapse: { type: 'lapse' },
  cancel: { type: 'cancel', actorId: INITIATOR_ID, reason: 'initiator' },
  block: { type: 'block', actorId: INITIATOR_ID },
  deletion: { type: 'deletion', actorId: INITIATOR_ID },
  hold_lost: { type: 'hold_lost', depositId: DEPOSIT_ID, canceledAt: CANCELED_AT },
  settle: settleEvent('completed'),
  operator_no_fault: { type: 'operator_no_fault', operatorId: OPERATOR_ID },
  compensate: { type: 'compensate' },
};

/** The key one `(status, event type)` pair, and one encoded arrow, is compared by. */
function pairKey(from: string, eventType: string): string {
  return `${from}|${eventType}`;
}

/** The title one row prints, so a failure names the arrow rather than a test index. */
function rowName(section: string, from: string, event: string, to: string, guard: string): string {
  const condition = guard === '' ? '' : ` (${guard})`;
  return `${section}: ${from} --${event}--> ${to}${condition}`;
}

// ---------------------------------------------------------------------------------------------
// AAP 0.5.3, the meetup transition table
// ---------------------------------------------------------------------------------------------

/** One arrow of the meetup table: its source, its event, the guard the AAP states, and its target. */
interface MeetupArrow {
  readonly from: MeetupStatus;
  readonly event: MeetupEvent;
  /** The guard the AAP names for the arrow, or the empty string when it names none. */
  readonly guard: string;
  readonly to: MeetupStatus;
}

/** A row of the arrow table: the arrow itself plus the title its test prints. */
interface MeetupRow extends MeetupArrow {
  readonly name: string;
}

/**
 * Every arrow of AAP 0.5.3, one row each, in the order the AAP states them.
 *
 * `locked --settle-->` appears four times because a settlement's target comes from its outcome. The
 * two late rows the AAP names for `locked` — a cancellation and an account deletion inside the two
 * hours before the start — are deliberately **not** arrows of this table: it sends both to
 * `cancelled`, and `transition` refuses the pair once {@link isLateCancel} holds, after which
 * `settlement/settle.ts` applies the forfeit with `late_cancel` as its outcome. Both halves of that
 * arrangement are asserted below.
 */
const MEETUP_ARROWS: readonly MeetupArrow[] = [
  {
    from: 'proposed',
    event: EVENTS.recipient_hold_held,
    guard: 'the recipient hold is held',
    to: 'locked',
  },
  { from: 'proposed', event: EVENTS.decline, guard: '', to: 'declined' },
  { from: 'proposed', event: EVENTS.lapse, guard: 'the deadline passes', to: 'lapsed' },
  { from: 'proposed', event: EVENTS.cancel, guard: '', to: 'cancelled' },
  { from: 'proposed', event: EVENTS.block, guard: '', to: 'cancelled' },
  { from: 'proposed', event: EVENTS.deletion, guard: '', to: 'cancelled' },
  { from: 'proposed', event: EVENTS.hold_lost, guard: 'a held hold was lost', to: 'lock_lost' },
  { from: 'locked', event: EVENTS.cancel, guard: 'early', to: 'cancelled' },
  { from: 'locked', event: EVENTS.block, guard: 'any time before settlement', to: 'cancelled' },
  { from: 'locked', event: EVENTS.deletion, guard: 'early', to: 'cancelled' },
  { from: 'locked', event: settleEvent('completed'), guard: 'both present', to: 'completed' },
  { from: 'locked', event: settleEvent('no_show'), guard: 'one present', to: 'forfeited' },
  {
    from: 'locked',
    event: settleEvent('late_cancel'),
    guard: 'a late cancellation',
    to: 'forfeited',
  },
  { from: 'locked', event: settleEvent('unattended'), guard: 'neither present', to: 'unattended' },
  {
    from: 'locked',
    event: EVENTS.operator_no_fault,
    guard: 'a resolved dispute',
    to: 'no_fault',
  },
  { from: 'locked', event: EVENTS.hold_lost, guard: 'a hold was lost', to: 'lock_lost' },
  {
    from: 'forfeited',
    event: EVENTS.operator_no_fault,
    guard: 'a post-settlement dispute',
    to: 'no_fault',
  },
  {
    from: 'forfeited',
    event: EVENTS.compensate,
    guard: 'a hold was lost before the commit',
    to: 'lock_lost',
  },
];

/** {@link MEETUP_ARROWS} with the title each row prints. */
const MEETUP_ROWS: readonly MeetupRow[] = MEETUP_ARROWS.map((arrow) => ({
  ...arrow,
  name: rowName('AAP 0.5.3 meetup', arrow.from, arrow.event.type, arrow.to, arrow.guard),
}));

/** The `(from, event type)` pairs the arrows above name: the pairs the table must accept. */
const ALLOWED_PAIRS: ReadonlySet<string> = new Set(
  MEETUP_ARROWS.map((arrow) => pairKey(arrow.from, arrow.event.type)),
);

/** One `(status, event type)` pair the AAP's arrows do not name, which the table must refuse. */
interface RefusedMeetupPair {
  readonly name: string;
  readonly from: MeetupStatus;
  readonly eventType: MeetupEventType;
}

/**
 * The complement of {@link ALLOWED_PAIRS} in the `MeetupStatus` × `MeetupEventType` product, built
 * from the AAP's own arrows rather than from the table under test. Every final status contributes
 * its whole event row here, which is the property that makes it final.
 */
const REFUSED_MEETUP_PAIRS: readonly RefusedMeetupPair[] = MeetupStatus.options.flatMap((from) =>
  EVENT_TYPES.filter((eventType) => !ALLOWED_PAIRS.has(pairKey(from, eventType))).map(
    (eventType) => ({
      name: `AAP 0.5.3 meetup: ${from} --${eventType}--> refused`,
      from,
      eventType,
    }),
  ),
);

/**
 * The table flattened to `from|event|target` keys, its `by_outcome` row expanded through
 * {@link SETTLE_OUTCOME_STATUSES}, so one comparison covers every arrow it encodes.
 */
function encodedMeetupArrows(): readonly string[] {
  return MeetupStatus.options
    .flatMap((from) =>
      EVENT_TYPES.flatMap((eventType) => {
        const target = MEETUP_TRANSITIONS[from][eventType];
        if (target === undefined) {
          return [];
        }
        if (target === 'by_outcome') {
          return SettlementOutcome.options.map(
            (outcome) => `${from}|${eventType}|${SETTLE_OUTCOME_STATUSES[outcome]}`,
          );
        }
        return [`${from}|${eventType}|${target}`];
      }),
    )
    .sort();
}

/** The arrows of {@link MEETUP_ARROWS} in the same encoded shape, for the fidelity comparison. */
function expectedMeetupArrows(): readonly string[] {
  return MEETUP_ARROWS.map((arrow) => `${arrow.from}|${arrow.event.type}|${arrow.to}`).sort();
}

describe('AAP 0.5.3 meetup transitions', () => {
  it.each(MEETUP_ROWS)('$name', ({ from, event, to }) => {
    expect(nextStatus(from, event)).toBe(to);
  });
  it('AAP 0.5.3 meetup: the table encodes exactly these arrows, no extra and no missing one', () => {
    expect(encodedMeetupArrows()).toEqual(expectedMeetupArrows());
  });
  it.each(REFUSED_MEETUP_PAIRS)('$name', ({ from, eventType }) => {
    expect(nextStatus(from, EVENTS[eventType])).toBeNull();
  });
  it('AAP 0.5.3 meetup: no arrow targets proposed and proposed is the only source of locked', () => {
    expect(expectedMeetupArrows().some((arrow) => arrow.endsWith('|proposed'))).toBe(false);
    expect(encodedMeetupArrows().some((arrow) => arrow.endsWith('|proposed'))).toBe(false);
    expect([
      ...new Set(MEETUP_ARROWS.filter((arrow) => arrow.to === 'locked').map((a) => a.from)),
    ]).toEqual(['proposed']);
  });
  it('AAP 0.5.3 meetup: the final statuses are every status but proposed and locked', () => {
    expect([...FINAL_MEETUP_STATUSES].sort()).toEqual(
      MeetupStatus.options.filter((status) => status !== 'proposed' && status !== 'locked').sort(),
    );
  });
  it('AAP 0.5.3 meetup: every event type has a factory event, and no other pair is refused', () => {
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(EVENTS).sort());
  });
  it('AAP 0.5.3 meetup: a refused pair is reported with the row, the status and the event', () => {
    const error = new InvalidTransitionError({
      meetupId: MEETUP_ID,
      from: 'locked',
      event: EVENTS.decline,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvalidTransitionError');
    expect(error.meetupId).toBe(MEETUP_ID);
    expect(error.from).toBe('locked');
    expect(error.event).toBe(EVENTS.decline);
  });
  it('AAP 0.5.3 meetup: a cancellation is free at startsAt - 2 h and late one second later', () => {
    const startsAt = new Date('2026-11-05T18:00:00.000Z');
    const boundary = new Date(startsAt.getTime() - 2 * HOUR_MS);
    expect(isLateCancel(boundary, startsAt)).toBe(false);
    expect(isLateCancel(new Date(boundary.getTime() + 1_000), startsAt)).toBe(true);
    // The table's own answer for the pair: the lateness guard is the transition's, so the pure
    // lookup sends a `locked` cancellation to `cancelled` whatever the instant (AAP 0.5.3).
    expect(nextStatus('locked', EVENTS.cancel)).toBe('cancelled');
    expect(nextStatus('locked', EVENTS.deletion)).toBe('cancelled');
  });
  it('AAP 0.5.7 settle: each outcome maps to the status its plan records', () => {
    expect(Object.keys(SETTLE_OUTCOME_STATUSES).sort()).toEqual(
      [...SettlementOutcome.options].sort(),
    );
    expect(SETTLE_OUTCOME_STATUSES).toEqual({
      completed: 'completed',
      no_show: 'forfeited',
      late_cancel: 'forfeited',
      unattended: 'unattended',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// AAP 0.5.3, the deposit lifecycle (forward only)
// ---------------------------------------------------------------------------------------------

/** One allowed deposit move, with the rule it comes from. */
interface DepositMove {
  readonly from: DepositStatus;
  readonly to: DepositStatus;
  /** Why the move is allowed, in a few words. */
  readonly note: string;
}

/** A row of the move table: the move plus the title its test prints. */
interface DepositRow extends DepositMove {
  readonly name: string;
}

/**
 * Every deposit move of AAP 0.5.3, one row each.
 *
 * `failed --released-->` is the row the late and orphan authorization rule adds: an authorization
 * that arrives for the attempt of a meetup which already reached a final status is released on the
 * spot, and its deposit has to be able to reach `released` from `failed` for the account-deletion
 * `delete_customer` operation to ever run — that one waits until every deposit of the user is final.
 */
const DEPOSIT_MOVES: readonly DepositMove[] = [
  { from: 'pending', to: 'held', note: 'the confirm answered requires_capture' },
  { from: 'pending', to: 'requires_action', note: '3-D Secure is pending' },
  { from: 'pending', to: 'failed', note: 'the card was declined' },
  { from: 'pending', to: 'released', note: 'our cancel' },
  { from: 'requires_action', to: 'held', note: 'amount_capturable_updated' },
  { from: 'requires_action', to: 'failed', note: 'payment_intent.payment_failed' },
  { from: 'requires_action', to: 'released', note: 'our cancel, or a superseded attempt' },
  { from: 'failed', to: 'pending', note: 'a retry creates attempt n + 1' },
  { from: 'failed', to: 'released', note: 'an orphan authorization is released' },
  { from: 'held', to: 'released', note: 'our release operation ran' },
  { from: 'held', to: 'captured', note: 'our capture operation ran at a forfeit' },
  { from: 'held', to: 'expired', note: 'a hold loss, even while a release of ours is pending' },
  { from: 'captured', to: 'refunded', note: 'a no_fault reversal' },
];

/** {@link DEPOSIT_MOVES} with the title each row prints. */
const DEPOSIT_ROWS: readonly DepositRow[] = DEPOSIT_MOVES.map((move) => ({
  ...move,
  name: `AAP 0.5.3 deposit: ${move.from} --> ${move.to} (${move.note})`,
}));

/** The `(from, to)` pairs the moves above name: the pairs the table must allow. */
const ALLOWED_DEPOSIT_MOVES: ReadonlySet<string> = new Set(
  DEPOSIT_MOVES.map((move) => pairKey(move.from, move.to)),
);

/** One `(from, to)` pair the deposit table does not allow, a self-transition included. */
interface RefusedDepositPair {
  readonly name: string;
  readonly from: DepositStatus;
  readonly to: DepositStatus;
}

/**
 * The complement of {@link ALLOWED_DEPOSIT_MOVES} in the `DepositStatus` × `DepositStatus` product,
 * built from the AAP's own rows. It carries every backwards move a late or out-of-order provider
 * event would ask for — `held` back to `pending` or `requires_action`, `captured` back to `held`,
 * and anything out of `released`, `expired` or `refunded` — which is what "forward-only" means.
 */
const REFUSED_DEPOSIT_PAIRS: readonly RefusedDepositPair[] = DepositStatus.options.flatMap((from) =>
  DepositStatus.options
    .filter((to) => !ALLOWED_DEPOSIT_MOVES.has(pairKey(from, to)))
    .map((to) => ({ name: `AAP 0.5.3 deposit: ${from} --> ${to} refused`, from, to })),
);

/** The deposit table flattened to `from|to` keys, for the fidelity comparison. */
function encodedDepositMoves(): readonly string[] {
  return DepositStatus.options
    .flatMap((from) => DEPOSIT_TRANSITIONS[from].map((to) => pairKey(from, to)))
    .sort();
}

/** The moves of {@link DEPOSIT_MOVES} in the same encoded shape. */
function expectedDepositMoves(): readonly string[] {
  return DEPOSIT_MOVES.map((move) => pairKey(move.from, move.to)).sort();
}

/** The deposit statuses that do not end a hold's life, in the domain enum's order. */
function openDepositStatuses(): readonly DepositStatus[] {
  return DepositStatus.options.filter(
    (status) => !FINAL_DEPOSIT_STATUSES.some((final) => final === status),
  );
}

describe('AAP 0.5.3 deposit transitions', () => {
  it.each(DEPOSIT_ROWS)('$name', ({ from, to }) => {
    expect(canTransitionDeposit(from, to)).toBe(true);
  });
  it('AAP 0.5.3 deposit: the table encodes exactly these moves and no others', () => {
    expect(encodedDepositMoves()).toEqual(expectedDepositMoves());
  });
  it.each(REFUSED_DEPOSIT_PAIRS)('$name', ({ from, to }) => {
    expect(canTransitionDeposit(from, to)).toBe(false);
  });
  it('AAP 0.5.3 deposit: a final status never returns to an open one', () => {
    for (const status of FINAL_DEPOSIT_STATUSES) {
      expect(
        DEPOSIT_TRANSITIONS[status].every((to) =>
          FINAL_DEPOSIT_STATUSES.some((final) => final === to),
        ),
      ).toBe(true);
      expect(canTransitionDeposit(status, 'released')).toBe(false);
      expect(canTransitionDeposit(status, 'held')).toBe(false);
    }
    // `captured` is the one final status with a move left: a `no_fault` reversal refunds it.
    expect(DEPOSIT_TRANSITIONS.captured).toEqual(['refunded']);
  });
  it('AAP 0.5.3 deposit: exactly the open statuses may be released', () => {
    expect(fromStatusesFor('released')).toEqual(openDepositStatuses());
  });
});

// ---------------------------------------------------------------------------------------------
// AAP 0.5.7, the settlement outcome table, and AAP 0.5.3's late cancellation
// ---------------------------------------------------------------------------------------------

/** Both sides of a meetup, for the rows that release both holds. */
const BOTH_ROLES: readonly ParticipantRole[] = ['initiator', 'recipient'];

/** The four presence combinations of AAP 0.5.7, from `pass` check-ins only. */
const BOTH_PRESENT: Presence = { initiatorPresent: true, recipientPresent: true };
const INITIATOR_ONLY: Presence = { initiatorPresent: true, recipientPresent: false };
const RECIPIENT_ONLY: Presence = { initiatorPresent: false, recipientPresent: true };
const NEITHER_PRESENT: Presence = { initiatorPresent: false, recipientPresent: false };

/** The plan fields one row asserts, every one of them read off the plan that was built. */
interface PlanExpectation {
  readonly outcome: SettlementOutcome;
  readonly status: SettlementFinalStatus;
  readonly captureRole: ParticipantRole | null;
  readonly releaseRoles: readonly ParticipantRole[];
  readonly creditRole: ParticipantRole | null;
  /** The witness event, the pair-history increment and the lodging-activity fact, in that order. */
  readonly flags: readonly [witness: boolean, pairHistory: boolean, lodgingActivity: boolean];
}

/** One presence row of the AAP 0.5.7 outcome table. */
interface PresenceRow extends PlanExpectation {
  readonly name: string;
  readonly presence: Presence;
}

/** One late-cancellation row of AAP 0.5.3, whose outcome is known when the plan is applied. */
interface LateCancelRow extends PlanExpectation {
  readonly name: string;
  readonly canceller: ParticipantRole;
  /** The flags the plan must record: the canceller absent and the counterpart present. */
  readonly presence: Presence;
}

/**
 * The four rows of the AAP 0.5.7 outcome table. Both present completes the meetup and releases both
 * holds; one present captures the absent party's hold, releases the attendee's and credits the
 * attendee with Table Credit equal to the deposit; neither present releases both with no reputation
 * change. No forfeit row witnesses anything, because neither the pair nor the lodging witnessed a
 * meetup (AAP 0.5.7).
 */
const PRESENCE_ROWS: readonly PresenceRow[] = [
  {
    name: 'both present',
    presence: BOTH_PRESENT,
    outcome: 'completed',
    status: 'completed',
    captureRole: null,
    releaseRoles: BOTH_ROLES,
    creditRole: null,
    flags: [true, true, true],
  },
  {
    name: 'only the initiator present',
    presence: INITIATOR_ONLY,
    outcome: 'no_show',
    status: 'forfeited',
    captureRole: 'recipient',
    releaseRoles: ['initiator'],
    creditRole: 'initiator',
    flags: [false, false, false],
  },
  {
    name: 'only the recipient present',
    presence: RECIPIENT_ONLY,
    outcome: 'no_show',
    status: 'forfeited',
    captureRole: 'initiator',
    releaseRoles: ['recipient'],
    creditRole: 'recipient',
    flags: [false, false, false],
  },
  {
    name: 'neither present',
    presence: NEITHER_PRESENT,
    outcome: 'unattended',
    status: 'unattended',
    captureRole: null,
    releaseRoles: BOTH_ROLES,
    creditRole: null,
    flags: [false, false, false],
  },
];

/**
 * The two late-cancellation rows of AAP 0.5.3. A cancellation inside the two hours before the start
 * forfeits the canceller's hold through the same recoverable settlement, and counts as a no-show by
 * the canceller (AAP 0.7.3), so the canceller is recorded absent and the counterpart present —
 * the convention `reputation/counters.ts` and `admin/metrics.ts` read.
 */
const LATE_CANCEL_ROWS: readonly LateCancelRow[] = [
  {
    name: 'the initiator cancelled late',
    canceller: 'initiator',
    presence: { initiatorPresent: false, recipientPresent: true },
    outcome: 'late_cancel',
    status: 'forfeited',
    captureRole: 'initiator',
    releaseRoles: ['recipient'],
    creditRole: 'recipient',
    flags: [false, false, false],
  },
  {
    name: 'the recipient cancelled late',
    canceller: 'recipient',
    presence: { initiatorPresent: true, recipientPresent: false },
    outcome: 'late_cancel',
    status: 'forfeited',
    captureRole: 'recipient',
    releaseRoles: ['initiator'],
    creditRole: 'initiator',
    flags: [false, false, false],
  },
];

/** Every plan this suite asserts: the four presence rows and the two late cancellations. */
const ALL_PLANS: readonly { readonly name: string; readonly plan: SettlementPlan }[] = [
  ...PRESENCE_ROWS.map((row) => ({ name: row.name, plan: settlementPlan(row.presence) })),
  ...LATE_CANCEL_ROWS.map((row) => ({ name: row.name, plan: lateCancelPlan(row.canceller) })),
];

/**
 * Asserts one plan field by field (AAP 0.5.7). Fields are asserted individually and `releaseRoles`
 * order-insensitively, never by comparing a spread of the plan, so a field the AAP does not name
 * cannot pass unnoticed.
 */
function expectPlan(plan: SettlementPlan, expected: PlanExpectation): void {
  const [witness, pairHistory, lodgingActivity] = expected.flags;
  expect(plan.outcome).toBe(expected.outcome);
  expect(plan.status).toBe(expected.status);
  expect(plan.captureRole).toBe(expected.captureRole);
  expect([...plan.releaseRoles].sort()).toEqual([...expected.releaseRoles].sort());
  expect(plan.creditRole).toBe(expected.creditRole);
  expect(plan.witness).toBe(witness);
  expect(plan.pairHistory).toBe(pairHistory);
  expect(plan.lodgingActivity).toBe(lodgingActivity);
}

/** The `forfeitReason` AAP 0.5.3 writes beside the status a settlement reaches. */
function expectedForfeitReason(outcome: SettlementOutcome): ForfeitReason | null {
  if (outcome === 'no_show') {
    return 'no_show';
  }
  if (outcome === 'late_cancel') {
    return 'late_cancel';
  }
  return null;
}

/**
 * The analytics events a settlement of one outcome writes, one entry per event, so the comparison
 * is a multiset: a completion and an unattended meetup write one event per participant, a no-show
 * writes one that names the absent party, and a late cancellation writes both of its events (AAP
 * 0.5.7).
 */
function expectedEventNames(outcome: SettlementOutcome): readonly string[] {
  switch (outcome) {
    case 'completed':
      return ['meetup_completed', 'meetup_completed'];
    case 'unattended':
      return ['meetup_unattended', 'meetup_unattended'];
    case 'no_show':
      return ['no_show'];
    case 'late_cancel':
      return ['cancelled_late', 'no_show'];
  }
}

describe('AAP 0.5.7 settlement outcomes and AAP 0.5.3 late cancellation', () => {
  it.each(PRESENCE_ROWS)('AAP 0.5.7 settle ($name)', (row) => {
    const plan = settlementPlan(row.presence);
    expectPlan(plan, row);
    expect(plan.forfeitReason).toBe(expectedForfeitReason(row.outcome));
    expect(plan.initiatorPresent).toBe(row.presence.initiatorPresent);
    expect(plan.recipientPresent).toBe(row.presence.recipientPresent);
  });
  it.each(LATE_CANCEL_ROWS)('AAP 0.5.3 late cancel ($name)', (row) => {
    const plan = lateCancelPlan(row.canceller);
    expectPlan(plan, row);
    expect(plan.forfeitReason).toBe('late_cancel');
    expect(plan.initiatorPresent).toBe(row.presence.initiatorPresent);
    expect(plan.recipientPresent).toBe(row.presence.recipientPresent);
  });
  it('AAP 0.5.7 settle: the table is the plan, one row per presence combination', () => {
    expect(Object.keys(SETTLEMENT_TABLE).sort()).toEqual([
      'both',
      'initiator_only',
      'neither',
      'recipient_only',
    ]);
    expect(settlementPlan(BOTH_PRESENT)).toBe(SETTLEMENT_TABLE.both);
    expect(settlementPlan(INITIATOR_ONLY)).toBe(SETTLEMENT_TABLE.initiator_only);
    expect(settlementPlan(RECIPIENT_ONLY)).toBe(SETTLEMENT_TABLE.recipient_only);
    expect(settlementPlan(NEITHER_PRESENT)).toBe(SETTLEMENT_TABLE.neither);
  });
  it.each(ALL_PLANS)('AAP 0.5.7 $name: no hold left undecided, none decided twice', ({ plan }) => {
    const decided = [
      ...(plan.captureRole === null ? [] : [plan.captureRole]),
      ...plan.releaseRoles,
    ];
    expect([...decided].sort()).toEqual(['initiator', 'recipient']);
    expect(plan.releaseRoles).not.toContain(plan.captureRole);
    // Table Credit is granted exactly when a hold is captured, to the counterpart.
    expect(plan.creditRole === null).toBe(plan.captureRole === null);
    expect(plan.creditRole).toBe(plan.captureRole === null ? null : otherRole(plan.captureRole));
  });
  it.each(ALL_PLANS)(
    'AAP 0.5.3 $name: the meetup takes the status the plan records',
    ({ plan }) => {
      expect(nextStatus('locked', settleEvent(plan.outcome))).toBe(plan.status);
    },
  );
  it.each(ALL_PLANS)('AAP 0.5.7 $name: the settlement writes its own events', ({ plan }) => {
    const names = plan.analytics.map((event) => event.name).sort();
    expect(names).toEqual([...expectedEventNames(plan.outcome)].sort());
    for (const event of plan.analytics) {
      expect(['initiator', 'recipient']).toContain(event.actor);
    }
    if (plan.status !== 'forfeited') {
      return;
    }
    // A forfeit names the absent party as every event's actor, so a no-show is attributable
    // without reading the presence flags (AAP 0.5.7).
    const absent = plan.initiatorPresent ? 'recipient' : 'initiator';
    expect(plan.analytics.every((event) => event.actor === absent)).toBe(true);
  });
  it('AAP 0.5.2: the opposite side of a meetup is the other role', () => {
    expect(otherRole('initiator')).toBe('recipient');
    expect(otherRole('recipient')).toBe('initiator');
  });
});

// ---------------------------------------------------------------------------------------------
// AAP 0.5.3 "Late and orphan authorizations"
// ---------------------------------------------------------------------------------------------

/** The statuses that end an operation's life (AAP 0.3.2 "Fencing"). */
const TERMINAL_OPERATION_STATUSES: readonly PaymentOperationStatus[] = [
  'succeeded',
  'failed_terminal',
  'fenced',
];

/** One operation status with the verdict {@link isTerminalOperation} must give it. */
interface OperationStatusRow {
  readonly status: PaymentOperationStatus;
  readonly terminal: boolean;
}

/** Every operation status, so a status added to the domain enum is covered here at once. */
const OPERATION_STATUS_ROWS: readonly OperationStatusRow[] = PaymentOperationStatus.options.map(
  (status) => ({
    status,
    terminal: TERMINAL_OPERATION_STATUSES.some((terminal) => terminal === status),
  }),
);

/**
 * The `requires_capture` decision itself is not testable here: `payments/webhook.ts` takes it inside
 * its transaction, through `hasCaptureOrRelease`, `isCurrent` and `applyHoldOutcome`, and exports no
 * pure helper for it — so this suite adds no fake one, and the whole path is asserted against the
 * database by `apps/api/test/integration/payment-operations.test.ts` and `webhooks-stripe.test.ts`.
 * What is provable without a database are the invariants those rules rest on: a final meetup but
 * `forfeited` takes no event, so an orphan authorization can never move one back to `locked`; a key
 * names its attempt, so a superseded attempt never shares one with the current attempt; the statuses
 * that end an operation's life are the row `hasNoAuthorization` reads before it declares a deposit
 * released; and a hold whose create was handed to the operator is never treated as holding nothing.
 */
describe('AAP 0.5.3 late and orphan authorizations', () => {
  it('AAP 0.5.3: a final meetup takes no event, and forfeited takes only its two', () => {
    const accepted = FINAL_MEETUP_STATUSES.map((status) => ({
      status,
      events: EVENT_TYPES.filter((eventType) => nextStatus(status, EVENTS[eventType]) !== null),
    }));
    expect(accepted).toEqual([
      { status: 'declined', events: [] },
      { status: 'lapsed', events: [] },
      { status: 'cancelled', events: [] },
      { status: 'completed', events: [] },
      { status: 'forfeited', events: ['operator_no_fault', 'compensate'] },
      { status: 'unattended', events: [] },
      { status: 'lock_lost', events: [] },
      { status: 'no_fault', events: [] },
    ]);
  });
  it('AAP 0.3.2: an idempotency key names its attempt', () => {
    expect(holdKey(DEPOSIT_ID, 1)).toBe(`hold:${DEPOSIT_ID}:1`);
    expect(holdKey(DEPOSIT_ID, 1)).not.toBe(holdKey(DEPOSIT_ID, 2));
    expect(holdKey(DEPOSIT_ID, 2)).not.toBe(holdKey(MEETUP_ID, 2));
  });
  it.each([
    { label: 'a hold with the twelve-hour marker', kind: 'hold', lastError: 'unresolved_12h' },
    {
      label: 'a hold that hit an idempotency conflict',
      kind: 'hold',
      lastError: 'idempotency_error',
    },
  ] as const)('AAP 0.3.2 $label was handed to the operator', ({ kind, lastError }) => {
    expect(isHandedOffHold({ kind, lastError })).toBe(true);
  });
  it.each([
    { label: 'a hold with no marker', kind: 'hold', lastError: null },
    { label: 'a hold that failed for another reason', kind: 'hold', lastError: 'card_declined' },
    { label: 'a release carrying the same marker', kind: 'release', lastError: 'unresolved_12h' },
  ] as const)('AAP 0.3.2 $label was not handed to the operator', ({ kind, lastError }) => {
    expect(isHandedOffHold({ kind, lastError })).toBe(false);
  });
  it.each(OPERATION_STATUS_ROWS)(
    'AAP 0.3.2: $status is terminal: $terminal',
    ({ status, terminal }) => {
      expect(isTerminalOperation(status)).toBe(terminal);
    },
  );
});
