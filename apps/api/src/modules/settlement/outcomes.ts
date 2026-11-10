/**
 * The settlement outcome table: presence at `startsAt + 45 min` to the money decision and the reputation decision
 * that follow it, held in one readable plan, one row per presence combination, plus the late-cancellation plan whose
 * outcome is already known.
 *
 * Purity is deliberate: the module imports its types from `@tablemate/shared` and nothing else, so it holds no
 * database, clock, logger, Redis, Stripe or sibling-module dependency. `settlement/settle.ts` computes the presence
 * flags from `pass` check-ins only, calls {@link settlementPlan} or {@link lateCancelPlan}, and applies the plan
 * inside its transaction; `reputation/counters.ts` and `admin/metrics.ts` read the flags the plan records.
 */
import type {
  AnalyticsEventName,
  ForfeitReason,
  MeetupStatus,
  ParticipantRole,
  SettlementOutcome,
} from '@tablemate/shared';

/**
 * The meetup statuses a settlement can reach (AAP 0.5.3): `completed`, `forfeited` — which covers
 * a no-show and a late cancellation alike — or `unattended`. Derived from {@link MeetupStatus} so
 * the three literals can never drift from the domain enum.
 */
export type SettlementFinalStatus = Extract<MeetupStatus, 'completed' | 'forfeited' | 'unattended'>;

/**
 * One analytics event a settlement writes, with the participant it is attributed to.
 *
 * `actor` is null when the event belongs to the meetup rather than to a side; a forfeit names the
 * absent party as the actor, so a no-show is attributable without reading the presence flags
 * (AAP 0.5.7).
 */
export interface SettlementAnalyticsEvent {
  readonly name: AnalyticsEventName;
  readonly actor: ParticipantRole | null;
}

/**
 * Everything one settlement decides, in the form `settlement/settle.ts` applies.
 *
 * The money fields are the deposit-level decision: `captureRole` is the single side whose hold is
 * captured, `releaseRoles` are the sides whose holds are released, and `creditRole` is the side
 * that receives a Table Credit `grant`. The invariant this module keeps — and
 * `apps/api/test/unit/settlement-state-machine.test.ts` asserts — is that `captureRole` never
 * appears in `releaseRoles`, that `creditRole` is set exactly when `captureRole` is, and that
 * `captureRole` together with `releaseRoles` covers both participants exactly once, so no hold is
 * left undecided and none is decided twice.
 *
 * Table Credit is granted in USD cents equal to the meetup's `depositCents`, the currency every
 * amount is charged in (AAP 0.7.3); it has no cash value and is recorded, never paid out.
 *
 * The reputation fields are the decision `reputation/counters.ts` and `admin/metrics.ts` read:
 * `witness` writes a `WitnessEvent` per participant, `pairHistory` increments
 * `PairHistory.completedCount`, and `lodgingActivity` writes the `LodgingActivityFact` rows of
 * AAP 0.5.7. `initiatorPresent` and `recipientPresent` are stored on `MeetupSettlement` as the
 * record of what the settlement saw, and `forfeitReason` is written on the meetup.
 */
export interface SettlementPlan {
  readonly outcome: SettlementOutcome;
  readonly status: SettlementFinalStatus;
  readonly forfeitReason: ForfeitReason | null;
  readonly initiatorPresent: boolean;
  readonly recipientPresent: boolean;
  readonly captureRole: ParticipantRole | null;
  readonly releaseRoles: readonly ParticipantRole[];
  readonly creditRole: ParticipantRole | null;
  readonly witness: boolean;
  readonly pairHistory: boolean;
  readonly lodgingActivity: boolean;
  readonly analytics: readonly SettlementAnalyticsEvent[];
}

/**
 * Who was witnessed at the venue when the window closed, from `pass` check-ins only (AAP 0.5.7).
 * `settle.ts` computes it; this module maps it to a plan.
 */
export interface Presence {
  readonly initiatorPresent: boolean;
  readonly recipientPresent: boolean;
}

/** The four presence combinations, the keys of {@link SETTLEMENT_TABLE}. */
export type PresenceKey = 'both' | 'initiator_only' | 'recipient_only' | 'neither';

/**
 * The settlement outcome rule of AAP 0.5.7, one row per presence combination.
 *
 * | presence | outcome | status | forfeit | capture | release | credit | witness / pairHistory / lodgingActivity | analytics |
 * |---|---|---|---|---|---|---|---|---|
 * | both | `completed` | `completed` | — | — | both | — | true / true / true | `meetup_completed` per participant |
 * | initiator only | `no_show` | `forfeited` | `no_show` | recipient | initiator | initiator | false | `no_show`, actor = recipient |
 * | recipient only | `no_show` | `forfeited` | `no_show` | initiator | recipient | recipient | false | `no_show`, actor = initiator |
 * | neither | `unattended` | `unattended` | — | — | both | — | false | `meetup_unattended` per participant |
 *
 * The forfeit rows carry no witness event, no pair-history increment and no lodging activity,
 * because neither the pair nor the lodging witnessed a meetup; the absent party's analytics event
 * is what the dashboard counts as a no-show (AAP 0.5.7).
 */
export const SETTLEMENT_TABLE = {
  both: {
    outcome: 'completed',
    status: 'completed',
    forfeitReason: null,
    initiatorPresent: true,
    recipientPresent: true,
    captureRole: null,
    releaseRoles: ['initiator', 'recipient'],
    creditRole: null,
    witness: true,
    pairHistory: true,
    lodgingActivity: true,
    analytics: [
      { name: 'meetup_completed', actor: 'initiator' },
      { name: 'meetup_completed', actor: 'recipient' },
    ],
  },
  initiator_only: {
    outcome: 'no_show',
    status: 'forfeited',
    forfeitReason: 'no_show',
    initiatorPresent: true,
    recipientPresent: false,
    captureRole: 'recipient',
    releaseRoles: ['initiator'],
    creditRole: 'initiator',
    witness: false,
    pairHistory: false,
    lodgingActivity: false,
    analytics: [{ name: 'no_show', actor: 'recipient' }],
  },
  recipient_only: {
    outcome: 'no_show',
    status: 'forfeited',
    forfeitReason: 'no_show',
    initiatorPresent: false,
    recipientPresent: true,
    captureRole: 'initiator',
    releaseRoles: ['recipient'],
    creditRole: 'recipient',
    witness: false,
    pairHistory: false,
    lodgingActivity: false,
    analytics: [{ name: 'no_show', actor: 'initiator' }],
  },
  neither: {
    outcome: 'unattended',
    status: 'unattended',
    forfeitReason: null,
    initiatorPresent: false,
    recipientPresent: false,
    captureRole: null,
    releaseRoles: ['initiator', 'recipient'],
    creditRole: null,
    witness: false,
    pairHistory: false,
    lodgingActivity: false,
    analytics: [
      { name: 'meetup_unattended', actor: 'initiator' },
      { name: 'meetup_unattended', actor: 'recipient' },
    ],
  },
} as const satisfies Readonly<Record<PresenceKey, SettlementPlan>>;

/** The row of {@link SETTLEMENT_TABLE} a presence combination selects (AAP 0.5.7). */
function presenceKey(presence: Presence): PresenceKey {
  if (presence.initiatorPresent) {
    return presence.recipientPresent ? 'both' : 'initiator_only';
  }
  return presence.recipientPresent ? 'recipient_only' : 'neither';
}

/**
 * The plan for a meetup settled on its check-ins at `startsAt + 45 min` (AAP 0.5.7).
 *
 * `presence` comes from `pass` check-ins only, so a failed code or a point outside the geofence
 * leaves a side absent. The returned plan is a readonly row of {@link SETTLEMENT_TABLE}: a plan is
 * data, never mutated by its caller.
 */
export function settlementPlan(presence: Presence): SettlementPlan {
  return SETTLEMENT_TABLE[presenceKey(presence)];
}

/**
 * The plan for a cancellation inside two hours of the start, applied without waiting for the
 * window (AAP 0.5.3 "locked → forfeited (late_cancel)").
 *
 * The canceller's hold is captured, the counterpart's is released, and the counterpart receives
 * Table Credit equal to the deposit, which is the same money decision as a no-show — because a
 * late cancellation counts as a no-show by the canceller (AAP 0.7.3). The presence flags follow
 * that reading: the canceller is recorded absent and the counterpart present, so the party whose
 * flag is false in a `forfeited` settlement is always the no-show, whatever the forfeit reason.
 * No witness event, pair-history increment or lodging activity is recorded, and the two analytics
 * events carry the canceller as their actor.
 */
export function lateCancelPlan(cancellerRole: ParticipantRole): SettlementPlan {
  const counterpart = otherRole(cancellerRole);
  return {
    outcome: 'late_cancel',
    status: 'forfeited',
    forfeitReason: 'late_cancel',
    initiatorPresent: cancellerRole !== 'initiator',
    recipientPresent: cancellerRole !== 'recipient',
    captureRole: cancellerRole,
    releaseRoles: [counterpart],
    creditRole: counterpart,
    witness: false,
    pairHistory: false,
    lodgingActivity: false,
    analytics: [
      { name: 'cancelled_late', actor: cancellerRole },
      { name: 'no_show', actor: cancellerRole },
    ],
  };
}

/** The opposite side of a meetup (AAP 0.5.2): an initiator's counterpart is the recipient. */
export function otherRole(role: ParticipantRole): ParticipantRole {
  return role === 'initiator' ? 'recipient' : 'initiator';
}
