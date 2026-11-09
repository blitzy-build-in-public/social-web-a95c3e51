/**
 * The no-invention source gate of the menu pipeline (AAP 0.5.6).
 *
 * An extracted item survives only when its `priceText` occurs in the extracted source text —
 * compared as whitespace-normalized strings — and `./price-parse.ts` parses that same substring to
 * one unambiguous positive amount in the currency the source declares. Everything else is dropped
 * and counted, so a price the source never printed is never stored: criterion 11's "100% of
 * extracted price strings found in the source text" then holds by construction (AAP 0.12.2).
 *
 * Pure and total: no I/O, no clock, no logger, and a malformed item is counted rather than thrown.
 * The caller (`../jobs/menu-ingest.ts`) owns logging and reads the returned drop counts; source
 * text is neither logged nor returned.
 *
 * kept items, and 0.8.1 for this file.
 */

import type { ExtractedMenuItem } from '@tablemate/shared';

import { hasExplicitCurrencyMarker, isPriceCurrency, parsePrice } from './price-parse.ts';

/**
 * Collapses every Unicode whitespace run to one ASCII space and trims the result (AAP 0.5.6), so a
 * price the extractor restated with a regular space still matches a source written with a no-break
 * space (U+00A0), a narrow no-break space (U+202F), a thin space, a tab or a newline.
 *
 * Deliberately the only normalization: no NFKC, no case folding, no punctuation change. The kept
 * `priceText` has to occur literally in the whitespace-normalized source — the criterion-11 check
 * itself — so normalizing further would let a stored price differ from its source text.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * One gated item: the extracted item with its `priceText` replaced by the normalized string the
 * gate found in the source, plus `localAmountMinor`, the amount that string parses to in the ISO
 * 4217 minor unit of its own currency (AAP 0.5.6, 0.5.7).
 *
 * Field for field this is the contract's `PriceItemInput`, so the pipeline stores the item as it
 * stands after converting `localAmountMinor` to USD cents with the capture date's `FxRate`.
 */
export type GatedMenuItem = ExtractedMenuItem & { localAmountMinor: number };

/**
 * What the gate dropped, by reason (AAP 0.5.6): `not_in_source` counts a `priceText` that does not
 * occur in the extracted source text, `unparseable` counts one that does occur but is not one
 * positive amount in the currency the source declares. The caller logs both counts.
 */
export type GateDrops = { not_in_source: number; unparseable: number };

/**
 * Keeps the extracted items whose price is provably in the source and drops the rest (AAP 0.5.6),
 * checking each item in this order, the first failure deciding the drop:
 *
 * 1. `priceText`, normalized, must be non-empty and occur in the normalized `sourceText`, else
 *    `drops.not_in_source`. A price the source never wrote would be invented by storing it
 *    (AAP 0.12.2).
 * 2. `item.currency` must be one the pipeline converts, and the same text must parse to a positive
 *    amount in it, else `drops.unparseable`. A range such as `12-15 €`, a bare `0` and two numbers
 *    in one string all fail here.
 * 3. A foreign price — `item.currency` other than the city's `currency` — is kept only when the text
 *    carries a currency marker naming it (`US$ 5`, `฿120`). A marker-less number on a city menu is
 *    in the city's currency and the extractor's label for it cannot be checked against the source,
 *    so such an item is dropped rather than converted at an unverified rate: the reason this
 *    parameter exists. `currency` is the city's ISO 4217 code (AAP 0.5.2 `City.currency`), not the
 *    item's own.
 *
 * Order-preserving and total: `kept` holds the surviving items in input order, a bad item is
 * counted rather than thrown, and the stored `priceText` is the normalized substring the source was
 * found to contain (AAP 0.5.6).
 */
export function gateItems(
  items: readonly ExtractedMenuItem[],
  sourceText: string,
  currency: string,
): { kept: GatedMenuItem[]; drops: GateDrops } {
  const source = normalizeWhitespace(sourceText);
  const kept: GatedMenuItem[] = [];
  const drops: GateDrops = { not_in_source: 0, unparseable: 0 };
  for (const item of items) {
    const priceText = normalizeWhitespace(item.priceText);
    if (priceText === '' || !source.includes(priceText)) {
      drops.not_in_source += 1;
      continue;
    }
    const itemCurrency = item.currency;
    if (!isPriceCurrency(itemCurrency)) {
      drops.unparseable += 1;
      continue;
    }
    // `parsePrice` refuses zero and negatives; the range check keeps the gate's "positive amount"
    // contract true however that parser bounds its own return value.
    const amount = parsePrice(priceText, itemCurrency);
    if (amount === null || amount <= 0) {
      drops.unparseable += 1;
      continue;
    }
    if (itemCurrency !== currency && !hasExplicitCurrencyMarker(priceText, itemCurrency)) {
      drops.unparseable += 1;
      continue;
    }
    kept.push({ ...item, priceText, localAmountMinor: amount });
  }
  return { kept, drops };
}
