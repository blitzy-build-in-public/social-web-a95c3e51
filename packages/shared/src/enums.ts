/**
 * The Tablemate domain enums — one Zod enum per value set, shared by every workspace.
 *
 * `packages/db/prisma/schema.prisma` declares each Prisma enum with exactly these members and
 * these string values, so a value stored in PostgreSQL always parses against the matching enum
 * here. Nothing outside this module hard-codes these strings: the API, the workers, the consoles
 * and the mobile client import the enum (or a schema built from it) instead, which keeps a value
 * change to one edit and keeps a comparison honest.
 *
 * Every enum follows the same shape — `export const Name = z.enum([...])` with
 * `export type Name = z.infer<typeof Name>` — so one name serves as runtime validator and type.
 * `zod` is the only import, which keeps the module safe for the Expo client and the web Worker,
 * where Node built-ins are unavailable.
 *
 * @see AAP 0.5.2 for the data model, 0.5.3 for the meetup, deposit, dispute and call lifecycles,
 * 0.5.4 for the DTO fields that carry these values and 0.5.6/0.5.7 for the rules that read them.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Roles, meetups and the experiment (AAP 0.5.2, 0.5.3, 0.5.7)
// ---------------------------------------------------------------------------------------------

/** A traveller account or a platform operator; `operator` unlocks the `/admin` routes (AAP 0.5.2). */
export const UserRole = z.enum(['traveler', 'operator']);
export type UserRole = z.infer<typeof UserRole>;

/** A meetup's single lifecycle value; every change runs through the state machine (AAP 0.5.3). */
export const MeetupStatus = z.enum([
  'proposed',
  'locked',
  'declined',
  'lapsed',
  'cancelled',
  'completed',
  'forfeited',
  'unattended',
  'lock_lost',
  'no_fault',
]);
export type MeetupStatus = z.infer<typeof MeetupStatus>;

/**
 * The final meetup statuses: every `MeetupStatus` except `proposed` and `locked`, which is the
 * point the retention clock and the account-deletion rules read (AAP 0.5.3). An open dispute is
 * not a status — it is an open `Dispute` row that gates settlement while the meetup stays
 * `locked`, so both attendees can still check in inside the window (AAP 0.5.3).
 */
export const FINAL_MEETUP_STATUSES = [
  'declined',
  'lapsed',
  'cancelled',
  'completed',
  'forfeited',
  'unattended',
  'lock_lost',
  'no_fault',
] as const satisfies readonly MeetupStatus[];

/** True when `status` is final, i.e. every status except `proposed` and `locked` (AAP 0.5.3). */
export function isFinalMeetupStatus(status: MeetupStatus): boolean {
  return FINAL_MEETUP_STATUSES.some((final) => final === status);
}

/** Why a meetup was cancelled, recorded on the transition to `cancelled` (AAP 0.5.2). */
export const CancelReason = z.enum(['initiator', 'recipient', 'block', 'account_deleted']);
export type CancelReason = z.infer<typeof CancelReason>;

/** Why a meetup was forfeited: the absent party, or a cancellation inside two hours (AAP 0.5.3). */
export const ForfeitReason = z.enum(['no_show', 'late_cancel']);
export type ForfeitReason = z.infer<typeof ForfeitReason>;

/** Which side of a meetup a user holds: the deposit role, `MeetupDto.role`, the query filter (AAP 0.5.4). */
export const ParticipantRole = z.enum(['initiator', 'recipient']);
export type ParticipantRole = z.infer<typeof ParticipantRole>;

/** The deposit-framing variant a user is assigned once, at account creation (AAP 0.5.7). */
export const Variant = z.enum(['social', 'punitive']);
export type Variant = z.infer<typeof Variant>;

/** The two participants' variants resolved per meetup, so each meetup counts once (AAP 0.5.7). */
export const VariantPairing = z.enum(['social', 'punitive', 'mixed']);
export type VariantPairing = z.infer<typeof VariantPairing>;

// ---------------------------------------------------------------------------------------------
// Deposits, payments, outbox and check-in (AAP 0.5.2, 0.5.3)
// ---------------------------------------------------------------------------------------------

/** One side's card-authorization hold; transitions are forward-only (AAP 0.5.3). */
export const DepositStatus = z.enum([
  'pending',
  'requires_action',
  'held',
  'failed',
  'released',
  'captured',
  'expired',
  'refunded',
]);
export type DepositStatus = z.infer<typeof DepositStatus>;

/**
 * The deposit statuses that end a hold's life; the account-deletion `delete_customer` operation
 * runs only once every deposit of the user is one of these (AAP 0.5.3).
 */
export const FINAL_DEPOSIT_STATUSES = [
  'released',
  'captured',
  'refunded',
  'expired',
] as const satisfies readonly DepositStatus[];

/**
 * The caller-visible hold state of `MeetupDto.initiatorHold` and `.recipientHold`: `none` when
 * that side has no current attempt, otherwise the current attempt's `DepositStatus` (AAP 0.5.4).
 * Spelled out rather than spread, which preserves the literal union type.
 */
export const HoldView = z.enum([
  'none',
  'pending',
  'requires_action',
  'held',
  'failed',
  'released',
  'captured',
  'expired',
  'refunded',
]);
export type HoldView = z.infer<typeof HoldView>;

/** The durable Stripe operations the executor runs, each under its own idempotency key (AAP 0.3.2). */
export const PaymentOperationKind = z.enum([
  'hold',
  'release',
  'capture',
  'refund',
  'delete_customer',
]);
export type PaymentOperationKind = z.infer<typeof PaymentOperationKind>;

/** A payment operation's lifecycle, tracked apart from the PaymentIntent's own state (AAP 0.3.2). */
export const PaymentOperationStatus = z.enum([
  'pending',
  'executing',
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'fenced',
]);
export type PaymentOperationStatus = z.infer<typeof PaymentOperationStatus>;

/** Webhook dedupe marker: `received` inside the transaction, `processed` at commit (AAP 0.3.2). */
export const StripeEventStatus = z.enum(['received', 'processed']);
export type StripeEventStatus = z.infer<typeof StripeEventStatus>;

/** What an outbox row asks another process to do once the domain transaction commits (AAP 0.3.2). */
export const OutboxKind = z.enum([
  'notification',
  'apply_call_result',
  'create_call_task',
  'account_erasure',
]);
export type OutboxKind = z.infer<typeof OutboxKind>;

/** A check-in's outcome; only this and the distance bucket are stored, never coordinates (AAP 0.5.7). */
export const CheckInResult = z.enum(['pass', 'fail']);
export type CheckInResult = z.infer<typeof CheckInResult>;

/** Distance from the venue: under 50 m, or 50 m up to the 150 m geofence (AAP 0.5.7). */
export const DistanceBucket = z.enum(['lt_50', 'm50_150']);
export type DistanceBucket = z.infer<typeof DistanceBucket>;

// ---------------------------------------------------------------------------------------------
// Settlement, disputes and Table Credit (AAP 0.5.2, 0.5.3, 0.5.7)
// ---------------------------------------------------------------------------------------------

/** A meetup's settlement outcome, recorded once in `MeetupSettlement` (AAP 0.5.7). */
export const SettlementOutcome = z.enum(['completed', 'no_show', 'late_cancel', 'unattended']);
export type SettlementOutcome = z.infer<typeof SettlementOutcome>;

/** The settlement's own progress: `applying` until every Stripe operation has succeeded (AAP 0.3.2). */
export const SettlementStatus = z.enum(['applying', 'complete']);
export type SettlementStatus = z.infer<typeof SettlementStatus>;

/** The dispute's subject: the venue could not witness, or anything else (AAP 0.5.4). */
export const DisputeKind = z.enum(['venue_unavailable', 'other']);
export type DisputeKind = z.infer<typeof DisputeKind>;

/** A dispute is `open` until the operator resolves it; while open it gates settlement (AAP 0.5.3). */
export const DisputeStatus = z.enum(['open', 'resolved']);
export type DisputeStatus = z.infer<typeof DisputeStatus>;

/** The operator's resolution: settle on the recorded check-ins, or void both holds (AAP 0.5.3). */
export const DisputeOutcome = z.enum(['settle_by_checkins', 'no_fault']);
export type DisputeOutcome = z.infer<typeof DisputeOutcome>;

/** Why a dispute was resolved automatically instead of by the operator (AAP 0.5.2). */
export const DisputeResolutionNote = z.enum(['cancelled_by_block', 'hold_expired']);
export type DisputeResolutionNote = z.infer<typeof DisputeResolutionNote>;

/** A Table Credit ledger entry: the grant to the attendee, or the `void` reversing one (AAP 0.5.7). */
export const CreditKind = z.enum(['grant', 'void']);
export type CreditKind = z.infer<typeof CreditKind>;

// ---------------------------------------------------------------------------------------------
// Places, prices and crawl policy (AAP 0.5.2, 0.5.6, 0.5.7)
// ---------------------------------------------------------------------------------------------

/** The place categories a suggestion may draw from (AAP 0.5.2). */
export const PlaceCategory = z.enum(['restaurant', 'cafe', 'bar', 'activity']);
export type PlaceCategory = z.infer<typeof PlaceCategory>;

/** A price record's item bucket; `ticket` carries `TicketType` and `perPerson` (AAP 0.5.6). */
export const ItemCategory = z.enum(['main', 'starter', 'dessert', 'drink', 'ticket']);
export type ItemCategory = z.infer<typeof ItemCategory>;

/** The admission kind of a ticket price; estimates read standard per-person tickets (AAP 0.5.7). */
export const TicketType = z.enum(['standard', 'concession', 'group']);
export type TicketType = z.infer<typeof TicketType>;

/**
 * Where a price came from. When one item has several equally recent current records, the
 * estimate keeps `operator_entry` over `phone_quote` over `online_menu` (AAP 0.5.7).
 */
export const PriceSource = z.enum(['online_menu', 'phone_quote', 'operator_entry']);
export type PriceSource = z.infer<typeof PriceSource>;

/** Only `approved` records feed suggestions; `needs_review` waits for an operator (AAP 0.5.6). */
export const ReviewStatus = z.enum(['approved', 'needs_review']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/** The operator's site-terms decision; a domain that is not `allowed` is never crawled (AAP 0.5.6). */
export const CrawlDecision = z.enum(['allowed', 'prohibited', 'uncertain']);
export type CrawlDecision = z.infer<typeof CrawlDecision>;

// ---------------------------------------------------------------------------------------------
// Automated calls (AAP 0.5.2, 0.5.3, 0.5.6)
// ---------------------------------------------------------------------------------------------

/** The dialogue a call task runs: collect menu prices, or verify a guest's stay (AAP 0.5.6). */
export const CallTaskKind = z.enum(['menu_prices', 'lodging_stay_verification']);
export type CallTaskKind = z.infer<typeof CallTaskKind>;

/** The call task's lifecycle, driven by dispatch and by the applied call results (AAP 0.5.3). */
export const CallTaskStatus = z.enum([
  'queued',
  'in_progress',
  'completed',
  'needs_review',
  'refused',
  'do_not_call',
  'unreachable',
  'cancelled',
]);
export type CallTaskStatus = z.infer<typeof CallTaskStatus>;

/** Why a task is not being dialed; it shows in the operator queue beside the task's status (AAP 0.5.3). */
export const BlockedReason = z.enum([
  'not_allowlisted',
  'no_phone',
  'do_not_call',
  'invalid_number',
  'vendor_unavailable',
  'dispatch_unknown',
  'no_final_status',
]);
export type BlockedReason = z.infer<typeof BlockedReason>;

/** Whether the agent or an operator produced a task's or a claim's result (AAP 0.5.2). */
export const ResolvedBy = z.enum(['agent', 'operator']);
export type ResolvedBy = z.infer<typeof ResolvedBy>;

/** A call attempt's dispatch state, kept apart from the outcome the call produced (AAP 0.3.2, 0.5.3). */
export const CallAttemptState = z.enum([
  'dispatching',
  'dispatch_unknown',
  'dispatch_failed',
  'dialing',
  'in_progress',
  'ended',
]);
export type CallAttemptState = z.infer<typeof CallAttemptState>;

/** What a call produced; `needs_review` carries the partial data to the operator queue (AAP 0.5.3). */
export const CallAttemptOutcome = z.enum([
  'completed',
  'no_answer',
  'refused',
  'do_not_call',
  'unreachable',
  'needs_review',
]);
export type CallAttemptOutcome = z.infer<typeof CallAttemptOutcome>;

/** A call's extraction confidence; `low` sends the task to the operator queue (AAP 0.5.6). */
export const Confidence = z.enum(['high', 'low']);
export type Confidence = z.infer<typeof Confidence>;

/**
 * The speech pairing a ConversationRelay call opens in, and the name of each template file under
 * `apps/api/src/modules/voice-agent/i18n/`. Mexico City and Medellín use the Latin American
 * `es-US` pairing (AAP 0.2.4).
 */
export const CallLanguage = z.enum(['en-US', 'pt-PT', 'es-US', 'th-TH', 'id-ID']);
export type CallLanguage = z.infer<typeof CallLanguage>;

/**
 * The outcomes an operator may record on a `menu_prices` call task. The API validates
 * `ResolveCallTask.outcome` against this and answers `422 invalid_outcome` for anything else,
 * including any outcome on a lodging-verification task (AAP 0.5.3, 0.5.4).
 */
export const OperatorCallTaskOutcome = z.enum([
  'completed',
  'refused',
  'do_not_call',
  'unreachable',
]);
export type OperatorCallTaskOutcome = z.infer<typeof OperatorCallTaskOutcome>;

// ---------------------------------------------------------------------------------------------
// Lodgings (AAP 0.5.2, 0.5.3, 0.5.6)
// ---------------------------------------------------------------------------------------------

/** The lodging kinds ingested from OpenStreetMap's `tourism` tags (AAP 0.5.6). */
export const LodgingKind = z.enum(['hostel', 'hotel', 'guesthouse']);
export type LodgingKind = z.infer<typeof LodgingKind>;

/** Whether a lodging's phone number came from OpenStreetMap or from an operator (AAP 0.5.6). */
export const PhoneSource = z.enum(['osm', 'operator']);
export type PhoneSource = z.infer<typeof PhoneSource>;

/** A claim's lifecycle; it stays `calling` only while a call may genuinely be live (AAP 0.5.3). */
export const LodgingClaimStatus = z.enum([
  'pending_call',
  'calling',
  'verified',
  'rejected',
  'unreachable',
]);
export type LodgingClaimStatus = z.infer<typeof LodgingClaimStatus>;

/**
 * The outcomes an operator may record on a lodging claim, and only while the claim is
 * `pending_call` or `calling`; `ResolveLodgingClaim.outcome` is validated against this and
 * answers `422 invalid_outcome` otherwise (AAP 0.5.3, 0.5.4).
 */
export const OperatorClaimOutcome = z.enum(['verified', 'rejected', 'unreachable']);
export type OperatorClaimOutcome = z.infer<typeof OperatorClaimOutcome>;

// ---------------------------------------------------------------------------------------------
// Deployment, notifications and client-facing values (AAP 0.1.1, 0.5.2, 0.5.4, 0.5.5)
// ---------------------------------------------------------------------------------------------

/** The device platform a push token belongs to (AAP 0.5.2). */
export const PushPlatform = z.enum(['ios', 'android']);
export type PushPlatform = z.infer<typeof PushPlatform>;

/** The only purpose for which an operator may read a claim's decrypted booking details (AAP 0.5.4). */
export const OperatorAccessPurpose = z.enum(['manual_verification_call']);
export type OperatorAccessPurpose = z.infer<typeof OperatorAccessPurpose>;

/**
 * The deployment mode `APP_ENV` selects. Fixtures are seeded only in `test` and `demo`, and the
 * test-only clock route exists only in `test` (AAP 0.5.2, 0.6.2).
 */
export const AppEnv = z.enum(['test', 'demo', 'staging', 'production']);
export type AppEnv = z.infer<typeof AppEnv>;

/** What the caller does next on a meetup, carried by `MeetupDto.nextAction` (AAP 0.5.4). */
export const NextAction = z.enum(['confirm_hold', 'retry_hold', 'accept', 'check_in', 'none']);
export type NextAction = z.infer<typeof NextAction>;

/** Why a suggestion list is empty; the API checks these in this order (AAP 0.5.7). */
export const SuggestionEmptyReason = z.enum(['no_priced_places', 'none_open', 'budget_too_low']);
export type SuggestionEmptyReason = z.infer<typeof SuggestionEmptyReason>;

/** The lodging directory's sort order: witnessed-meetup activity, or name (AAP 0.5.4, 0.5.7). */
export const LodgingSort = z.enum(['activity', 'name']);
export type LodgingSort = z.infer<typeof LodgingSort>;

/** Which price pipeline `POST /admin/price-jobs` enqueues for a city (AAP 0.5.4). */
export const PriceJobKind = z.enum(['menus', 'calls']);
export type PriceJobKind = z.infer<typeof PriceJobKind>;

/** The caller's own proof state, carried by `MeDto.proof.status` (AAP 0.5.5, 0.5.8). */
export const ProofStatus = z.enum(['none', 'valid', 'expired']);
export type ProofStatus = z.infer<typeof ProofStatus>;

/**
 * The kinds an outbox `notification` row may carry, rendered by
 * `apps/workers/src/notify/templates.ts`. A kind that concerns the deposit is rendered in the
 * recipient's framing variant (AAP 0.1.1).
 */
export const NotificationKind = z.enum([
  'magic_link',
  'proposal_received',
  'proposal_declined',
  'proposal_lapsed',
  'meetup_locked',
  'meetup_cancelled',
  'meetup_reminder',
  'counterpart_checked_in',
  'meetup_settled',
  'lock_lost',
  'dispute_opened',
  'dispute_resolved',
  'lodging_claim_resolved',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;
