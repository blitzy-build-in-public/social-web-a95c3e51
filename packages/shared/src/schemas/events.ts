/** The analytics vocabulary of the Tablemate contract: the closed set of event names, the shape of the `props` payload stored on an `AnalyticsEvent` and the body of the additive client route `POST /events`. Client-safe like every module under `packages/shared/src/schemas`, so no Node built-in, DOM global or load-time side effect. */
import { z } from 'zod';

import { PlaceCategory, Variant, VariantPairing } from '../enums.ts';
import { Count, UsdCents, Uuid } from './common.ts';
/** Every analytics event name, and the only set `AnalyticsEvent.name` may hold. Each funnel event is written by the same transaction that sets the meetup timestamp it counts, so the funnel is computed from retained meetup facts and erasure never changes it. */
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
/** The `props` payload of an `AnalyticsEvent`: ids, enums and measures, and never a handle, an email address, coordinates, a message body or any other personal field. `account-erasure` reduces the props of a deleted user's events to the measure fields, so a retained event reconnects to no person and no meetup while the measures it feeds stay unchanged. */
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
/** The names `POST /events` accepts. Every other `AnalyticsEventName` is a server-side fact the client may not forge, and the route answers `400 invalid_field` for one. */
export const CLIENT_EVENT_NAMES = ['suggestion_place_opened'] as const;
/** A name a client may report about itself (AAP 0.5.4). */
export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];
/** The body of the additive route `POST /events`, the client's only analytics write. The actor hash, its variant and the timestamp come from the session and the injected clock, never from the body, and an unknown key fails exactly as an unlisted name does. */
export const ClientEventRequest = z.strictObject({
  name: z.enum(CLIENT_EVENT_NAMES),
  meetupId: Uuid,
  placeId: Uuid,
  placeCategory: PlaceCategory.optional(),
});
export type ClientEventRequest = z.infer<typeof ClientEventRequest>;
