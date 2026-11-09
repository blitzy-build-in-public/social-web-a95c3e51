/** The suggestions contract: the day-plan response and the menu-item shape the price pipeline exchanges. `ExtractedMenuItemBase` and `MenuExtractionOutput` are the schemas the pipeline converts with `z.toJSONSchema` and hands to the language model as a strict JSON schema, while `ExtractedMenuItem` and `PriceItemInput` validate the same item after extraction and after operator entry. Client-safe: `zod`, the contract primitives and the domain enums, with no Node built-in or top-level side effect. */
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
/** The query string of `GET /meetups/:id/suggestions`. The numeric range is deliberately absent: the handler checks `BUDGET_MIN_CENTS` through `BUDGET_MAX_CENTS` (500 to 10000 cents) and answers `422 budget_out_of_range`, which leaves `400 invalid_field` for a non-integer. */
export const SuggestionsQuery = z.strictObject({
  perPersonBudgetCents: z.coerce.number().int().optional(),
});
export type SuggestionsQuery = z.infer<typeof SuggestionsQuery>;
/** One price record the estimate used, as the response's `itemsUsed` provenance: an `http(s)` URL for an online menu, a `tel:<number>` reference for a phone quote, and `null` for an operator entry that carries no URL. */
export const SuggestionItemUsed = z.object({
  name: z.string(),
  itemCategory: ItemCategory,
  priceUsdCents: UsdCents,
  source: PriceSource,
  capturedAt: IsoDateTime,
  sourceUrl: z.string().nullable(),
});
export type SuggestionItemUsed = z.infer<typeof SuggestionItemUsed>;
/** A place's per-person estimate and the range around it: `estimateCents` is the median main price plus the median non-alcoholic drink, or the lowest listed standard per-person ticket for an activity, and `lowCents` and `highCents` span the cheapest and the most expensive qualifying combination. */
export const EstimatedCostRange = z.object({
  estimateCents: UsdCents,
  lowCents: UsdCents,
  highCents: UsdCents,
});
export type EstimatedCostRange = z.infer<typeof EstimatedCostRange>;
/** One ranked suggestion: `distanceM` from the meetup venue, `openingHoursToday` as the OpenStreetMap value for the meetup day, and `placeId` and `isPartnerVenue` as non-personal additions that carry the `suggestion_place_opened` event and the partner-first ordering. */
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
/** The body of `GET /meetups/:id/suggestions`: at most `SUGGESTIONS_MAX` ranked places and the budget they were ranked against. `emptyReason` is present only when `items` is empty, and the API checks the three reasons in this order: `no_priced_places`, `none_open`, `budget_too_low`. */
export const SuggestionsResponse = z.object({
  items: z.array(Suggestion).max(SUGGESTIONS_MAX),
  emptyReason: SuggestionEmptyReason.optional(),
  budgetCents: UsdCents,
});
export type SuggestionsResponse = z.infer<typeof SuggestionsResponse>;
/** One priced item exactly as the extractor reads it from an HTML, PDF or image menu. Every key is required and nullable and no string-length keyword is used, because the language model answers under a strict JSON schema; `priceText` is copied verbatim from the source. */
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
/** The complete answer the extractor asks the language model for, converted with `z.toJSONSchema` and passed as the request's `jsonSchema`. */
export const MenuExtractionOutput = z.strictObject({ items: z.array(ExtractedMenuItemBase) });
export type MenuExtractionOutput = z.infer<typeof MenuExtractionOutput>;
type TicketFields = {
  category: ItemCategory;
  perPerson: boolean | null;
  ticketType: TicketType | null;
};
/** The ticket rule, applied to every derived item schema: `perPerson` (true when the price admits one person) and `ticketType` (`standard`, `concession` or `group`) are both set on a `ticket` price and both null on every other category, because the estimate reads only standard per-person tickets. */
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
/** An extracted item that passed the ticket rule; the extractor drops any item this schema rejects rather than store a half-described price. */
export const ExtractedMenuItem = ExtractedMenuItemBase.superRefine(ticketRule);
export type ExtractedMenuItem = z.infer<typeof ExtractedMenuItem>;
/** One price an operator enters through `POST /admin/call-tasks/:id/resolve` with outcome `completed`: the extracted item shape plus `localAmountMinor`, the amount in the currency's minor unit as read from the source. */
export const PriceItemInput = ExtractedMenuItemBase.extend({
  localAmountMinor: z.number().int().nonnegative(),
}).superRefine(ticketRule);
export type PriceItemInput = z.infer<typeof PriceItemInput>;
