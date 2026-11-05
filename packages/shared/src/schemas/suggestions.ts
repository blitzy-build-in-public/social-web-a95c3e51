/**
 * The suggestions contract: the day-plan response of AAP 0.5.4 and the menu-item shape the price
 * pipeline exchanges (AAP 0.5.6, 0.5.7).
 *
 * `SuggestionsQuery` and `SuggestionsResponse` are the query and the response of
 * `GET /meetups/:id/suggestions`. `ExtractedMenuItemBase` and `MenuExtractionOutput` are the
 * schemas the menu pipeline converts with `z.toJSONSchema` and hands to the language model as a
 * strict JSON schema; `ExtractedMenuItem` and `PriceItemInput` validate the same item after
 * extraction and after operator entry.
 *
 * Client-safe by construction: `zod`, the contract primitives and the domain enums, and no Node
 * built-in, DOM global or top-level side effect, because the same module loads under Hermes, in a
 * browser and in Node.
 *
 * @see AAP 0.5.4 for the route, 0.5.6 for extraction and operator entry, and 0.5.7 for the
 * estimation, ranking and provenance rules the DTO fields carry.
 */
import { z } from 'zod';

import { SUGGESTIONS_MAX } from '../constants.ts';
import {
  ItemCategory,
  PlaceCategory,
  PriceSource,
  SuggestionEmptyReason,
  TicketType,
} from '../enums.ts';
import { Count, CurrencyCode, IsoDateTime, UsdCents, Uuid } from './common.ts';

// ---------------------------------------------------------------------------------------------
// GET /meetups/:id/suggestions (AAP 0.5.4, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * The query string of `GET /meetups/:id/suggestions`.
 *
 * The numeric range is deliberately absent: the handler checks `BUDGET_MIN_CENTS` through
 * `BUDGET_MAX_CENTS` (500 to 10000 cents) and answers `422 budget_out_of_range`, which leaves
 * `400 invalid_field` for a non-integer (AAP 0.5.4). A supplied budget is stored as the pair's
 * shared per-person budget, where the latest write by either attendee wins.
 */
export const SuggestionsQuery = z.strictObject({
  perPersonBudgetCents: z.coerce.number().int().optional(),
});
export type SuggestionsQuery = z.infer<typeof SuggestionsQuery>;

/**
 * One price record the estimate used, as the response's `itemsUsed` provenance (AAP 0.5.7):
 * an `http(s)` URL for an online menu, a `tel:<number>` reference for a phone quote, and `null`
 * for an operator entry that carries no URL (AAP 0.5.6).
 */
export const SuggestionItemUsed = z.object({
  name: z.string(),
  itemCategory: ItemCategory,
  priceUsdCents: UsdCents,
  source: PriceSource,
  capturedAt: IsoDateTime,
  sourceUrl: z.string().nullable(),
});
export type SuggestionItemUsed = z.infer<typeof SuggestionItemUsed>;

/**
 * A place's per-person estimate and the range around it (AAP 0.5.7 "Cost estimation"):
 * `estimateCents` is the median main price plus the median non-alcoholic drink, or the lowest
 * listed standard per-person ticket for an activity, and `lowCents` and `highCents` span the
 * cheapest and the most expensive qualifying combination.
 */
export const EstimatedCostRange = z.object({
  estimateCents: UsdCents,
  lowCents: UsdCents,
  highCents: UsdCents,
});
export type EstimatedCostRange = z.infer<typeof EstimatedCostRange>;

/**
 * One ranked suggestion (AAP 0.5.7 "Ranking"): `distanceM` from the meetup venue,
 * `openingHoursToday` as the OpenStreetMap value for the meetup day, and `placeId` and
 * `isPartnerVenue` as non-personal additions that carry the `suggestion_place_opened` event and
 * the partner-first ordering. The client renders "© OpenStreetMap contributors" beside it
 * (AAP 0.5.8).
 */
export const Suggestion = z.object({
  placeId: Uuid,
  name: z.string(),
  category: PlaceCategory,
  isPartnerVenue: z.boolean(),
  estimatedCostRange: EstimatedCostRange,
  priceSource: PriceSource,
  priceVerifiedAt: IsoDateTime,
  distanceM: Count,
  openingHoursToday: z.string().nullable(),
  itemsUsed: z.array(SuggestionItemUsed),
});
export type Suggestion = z.infer<typeof Suggestion>;

/**
 * The body of `GET /meetups/:id/suggestions`: at most `SUGGESTIONS_MAX` ranked places and the
 * budget they were ranked against.
 *
 * `emptyReason` is present only when `items` is empty, and the API checks the three reasons in
 * this order: `no_priced_places`, `none_open`, `budget_too_low` (AAP 0.5.7). Each has its own
 * empty-state string in the client (AAP 0.5.8).
 */
export const SuggestionsResponse = z.object({
  items: z.array(Suggestion).max(SUGGESTIONS_MAX),
  emptyReason: SuggestionEmptyReason.optional(),
  budgetCents: UsdCents,
});
export type SuggestionsResponse = z.infer<typeof SuggestionsResponse>;

// ---------------------------------------------------------------------------------------------
// Menu extraction and operator price entry (AAP 0.5.6, 0.5.7)
// ---------------------------------------------------------------------------------------------

/**
 * One priced item exactly as the extractor reads it from an HTML, PDF or image menu (AAP 0.5.6).
 *
 * Every key is required and nullable rather than optional, and no string-length keyword is used,
 * because the language model answers under a strict JSON schema: every property must be listed in
 * `required`, `additionalProperties` must be `false`, and only a subset of JSON-Schema keywords is
 * supported.
 *
 * `priceText` is copied verbatim from the source; `source-gate.ts` keeps an item only when that
 * text occurs in the extracted source text and parses to the same amount, so a price absent from
 * the source is never stored. `perPerson` and `ticketType` are set for `ticket` items only.
 */
export const ExtractedMenuItemBase = z.strictObject({
  name: z.string(),
  category: ItemCategory,
  priceText: z.string(),
  currency: CurrencyCode,
  alcoholic: z.boolean().nullable(),
  perPerson: z.boolean().nullable(),
  ticketType: TicketType.nullable(),
});
export type ExtractedMenuItemBase = z.infer<typeof ExtractedMenuItemBase>;

/**
 * The complete answer the extractor asks the language model for, converted with `z.toJSONSchema`
 * and passed as the request's `jsonSchema` (AAP 0.5.6). It stays unrefined so the conversion is
 * clean; the ticket rule is applied to each derived item schema instead.
 */
export const MenuExtractionOutput = z.strictObject({ items: z.array(ExtractedMenuItemBase) });
export type MenuExtractionOutput = z.infer<typeof MenuExtractionOutput>;

/** The two fields the ticket rule constrains, and the category that decides their state. */
type TicketFields = {
  category: ItemCategory;
  perPerson: boolean | null;
  ticketType: TicketType | null;
};

/**
 * The ticket rule, applied to every derived item schema: `perPerson` (true when the price admits
 * one person) and `ticketType` (`standard`, `concession` or `group`) are both set on a `ticket`
 * price and both null on every other category, because the estimate reads only standard
 * per-person tickets (AAP 0.5.6, 0.5.7).
 */
export function ticketRule(value: TicketFields, ctx: z.core.$RefinementCtx): void {
  const ticket = value.category === 'ticket';
  const fields: [field: 'perPerson' | 'ticketType', present: boolean][] = [
    ['perPerson', value.perPerson !== null],
    ['ticketType', value.ticketType !== null],
  ];

  for (const [field, present] of fields) {
    if (present === ticket) {
      continue;
    }
    const rule = ticket ? 'is required on a ticket price' : 'applies to ticket prices only';
    ctx.addIssue({ code: 'custom', message: `${field} ${rule}.`, path: [field] });
  }
}

/**
 * An extracted item that passed the ticket rule; the extractor drops any item this schema rejects
 * rather than store a half-described price (AAP 0.5.6).
 */
export const ExtractedMenuItem = ExtractedMenuItemBase.superRefine(ticketRule);
export type ExtractedMenuItem = z.infer<typeof ExtractedMenuItem>;

/**
 * One price an operator enters through `POST /admin/call-tasks/:id/resolve` with outcome
 * `completed`: the extracted item shape plus `localAmountMinor`, the amount in the currency's
 * minor unit as read from the source (AAP 0.5.4, 0.5.6). The API stores it as
 * `source = operator_entry` and converts it to USD cents with the capture date's `FxRate`.
 */
export const PriceItemInput = ExtractedMenuItemBase.extend({
  localAmountMinor: z.number().int().nonnegative(),
}).superRefine(ticketRule);
export type PriceItemInput = z.infer<typeof PriceItemInput>;
