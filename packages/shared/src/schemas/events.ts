/**
 * The analytics vocabulary of the Tablemate contract: the closed set of event names, the shape of
 * the `props` payload stored on an `AnalyticsEvent` and the body of the additive client route
 * `POST /events` (AAP 0.5.2, 0.5.4, 0.5.7).
 *
 * Client-safe like every module under `packages/shared/src/schemas` (AAP 0.11.1): the mobile client
 * builds `ClientEventRequest` from here, so the module imports `zod` and sibling contract modules
 * only — no Node built-in, no DOM global and no side effect at load time.
 */
import { z } from 'zod';

import { PlaceCategory, Variant, VariantPairing } from '../enums.ts';
import { Count, UsdCents, Uuid } from './common.ts';

/**
 * Every analytics event name, and the only set `AnalyticsEvent.name` may hold (AAP 0.5.2).
 *
 * Each funnel event is written by the same transaction that sets the meetup timestamp it counts,
 * so the funnel is computed from retained meetup facts and erasure never changes it (AAP 0.5.7):
 * `proposal_sent` when the initiator's hold is held and the proposal becomes visible to the
 * recipient; `proposal_viewed` on the recipient's first `GET /meetups/:id`; `proposal_accepted` on
 * the first accept that passes validation, whatever the authorization outcome; `deposit_locked`
 * for the recipient and `meetup_locked` once per participant at the lock; `both_checked_in` with
 * the second pass check-in, which settlement does not gate, so an open dispute or a later hold
 * loss neither delays nor removes it; `cancelled_late` and `no_show` together on a late cancel.
 * `account_created`, `lodging_claim_submitted` and `lodging_claim_resolved` are the only source of
 * the signup and claim measures, because no retained meetup fact carries them (AAP 0.5.2).
 *
 * The lifecycle names are the meetup, hold and dispute transitions of AAP 0.5.3 that no funnel
 * stage above already records.
 */
export const AnalyticsEventName = z.enum([
  // Funnel stages and headline measures (AAP 0.5.7).
  'account_created',
  'proposal_sent',
  'proposal_viewed',
  'proposal_accepted',
  'deposit_locked',
  'meetup_locked',
  'both_checked_in',
  'cancelled_early',
  'cancelled_late',
  'no_show',
  'lock_lost',
  'lodging_claim_submitted',
  'lodging_claim_resolved',
  'suggestion_place_opened',
  // Lifecycle transitions (AAP 0.3.2 every transition writes its analytics events, 0.5.3).
  'proposal_declined',
  'proposal_lapsed',
  'meetup_completed',
  'meetup_unattended',
  'meetup_no_fault',
  'dispute_opened',
  'dispute_resolved',
]);
export type AnalyticsEventName = z.infer<typeof AnalyticsEventName>;

/**
 * The `props` payload of an `AnalyticsEvent`: ids, enums and measures, and never a handle, an
 * email address, coordinates, a message body or any other personal field (AAP 0.5.2).
 *
 * Every deposit-funnel event carries its actor's `variant` and `assignmentId` and the meetup's
 * `variantPairing`, which is what criterion 7 checks (AAP 0.12.1). `account-erasure` reduces the
 * props of a deleted user's events to the measure fields — `variantPairing` and `depositCents`,
 * and for the claim events `outcome` and `resolveSeconds` — so a retained event reconnects to no
 * person and no meetup while the measures it feeds stay unchanged (AAP 0.5.2). `placeId` and
 * `placeCategory` are the non-personal place reference of `suggestion_place_opened`, the one event
 * that has no meetup timestamp to date it.
 */
export const AnalyticsProps = z.strictObject({
  variant: Variant.optional(),
  assignmentId: Uuid.optional(),
  variantPairing: VariantPairing.optional(),
  depositCents: UsdCents.optional(),
  outcome: z.string().max(40).optional(),
  resolveSeconds: Count.optional(),
  placeCategory: PlaceCategory.optional(),
  placeId: Uuid.optional(),
});
export type AnalyticsProps = z.infer<typeof AnalyticsProps>;

/**
 * The names `POST /events` accepts. Every other `AnalyticsEventName` is a server-side fact the
 * client may not forge, and the route answers `400 invalid_field` for one (AAP 0.5.4).
 */
export const CLIENT_EVENT_NAMES = ['suggestion_place_opened'] as const;

/** A name a client may report about itself (AAP 0.5.4). */
export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

/**
 * The body of the additive route `POST /events`, the client's only analytics write. The handler
 * stores `meetupId` on the event row and `placeId` and `placeCategory` as `AnalyticsProps`; the
 * actor hash, its variant and the timestamp come from the session and the injected clock, never
 * from the body (AAP 0.5.2, 0.5.4).
 *
 * A `strictObject`, so an unknown key fails exactly as an unlisted name does.
 */
export const ClientEventRequest = z.strictObject({
  name: z.enum(CLIENT_EVENT_NAMES),
  meetupId: Uuid,
  placeId: Uuid,
  placeCategory: PlaceCategory.optional(),
});
export type ClientEventRequest = z.infer<typeof ClientEventRequest>;
