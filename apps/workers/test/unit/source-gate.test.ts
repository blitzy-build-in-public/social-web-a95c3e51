/** The no-invention source gate's unit suite (AAP 0.5.6 "Source gate", AAP 0.12.2 "No invented prices"): `gateItems` keeps an extracted item only when its `priceText` occurs in the extracted source text as a whitespace-normalized string and `./price-parse.ts` parses that same substring to one positive amount. Everything else is dropped and counted, so criterion 11's "100% of extracted price strings found in the source text" holds by construction. */

import type { ExtractedMenuItem } from '@tablemate/shared';
import { describe, expect, it } from 'vitest';

import { parsePrice } from '../../src/menus/price-parse.ts';
import { gateItems, normalizeWhitespace } from '../../src/menus/source-gate.ts';

const CURRENCY = 'EUR';
/** One page's visible text: `12,50` followed by a no-break space, `14,50` split from its `€` by a line break, `1,50` after a tab, `13,00` printed plainly, and three lines that carry no usable price. */
const SOURCE_TEXT = [
  'Casa do Bairro — Menu',
  'Bitoque 12,50\u00a0€',
  'Bacalhau à Brás 14,50\n€',
  'Água\t1,50 €',
  'Arroz de pato 13,00 €',
  'Peixe do dia market price',
  'Polvo 12–15 €',
  'Pão 0,00 €',
].join('\n');
/** A second page that prints a negative amount, which is not a price either. */
const NEGATIVE_SOURCE_TEXT = 'Couvert -5,00 €';
type GateVerdict = 'kept' | 'not_in_source' | 'unparseable';
/** One gate row: the case's name, the extractor's price string, and the verdict it must earn. */
type GateCase = readonly [label: string, priceText: string, verdict: GateVerdict];
/** The prices the extractor claims, one per row. The four `kept` rows differ from their source only by whitespace, so a gate that skips normalization drops them while one that skips the substring check keeps the invented price and the empty string. */
const GATE_CASES: readonly GateCase[] = [
  ['a price the page prints plainly', '13,00 €', 'kept'],
  ['a price printed with a no-break space', '12,50 €', 'kept'],
  ['a price printed across a line break', '14,50 €', 'kept'],
  ['a price printed after a tab', '1,50 €', 'kept'],
  ['a price the page never prints', '11,00 €', 'not_in_source'],
  ['an empty price string', '', 'not_in_source'],
  ['text that carries no number', 'market price', 'unparseable'],
  ['a range rather than one price', '12–15 €', 'unparseable'],
  ['a free item the page prints as 0,00', '0,00 €', 'unparseable'],
];
function item(priceText: string, overrides: Partial<ExtractedMenuItem> = {}): ExtractedMenuItem {
  return {
    name: 'Arroz de pato',
    category: 'main',
    priceText,
    currency: CURRENCY,
    alcoholic: null,
    perPerson: null,
    ticketType: null,
    ...overrides,
  };
}

describe('gateItems', () => {
  it.each(GATE_CASES)('%s -> %s', (_label, priceText, verdict) => {
    const { kept, drops } = gateItems([item(priceText)], SOURCE_TEXT, CURRENCY);
    if (verdict === 'kept') {
      // The row's string is already whitespace-normalized, so normalizing it is a no-op and the stored text is the substring the source was found to contain, unchanged.
      expect(kept).toHaveLength(1);
      expect(kept[0]?.priceText).toBe(priceText);
      expect(kept[0]?.localAmountMinor).toBe(parsePrice(priceText, CURRENCY));
      expect(drops).toEqual({ not_in_source: 0, unparseable: 0 });
      return;
    }
    expect(kept).toEqual([]);
    expect(drops).toEqual({
      not_in_source: verdict === 'not_in_source' ? 1 : 0,
      unparseable: verdict === 'unparseable' ? 1 : 0,
    });
  });

  it('drops a negative amount a second page prints', () => {
    const { kept, drops } = gateItems([item('-5,00 €')], NEGATIVE_SOURCE_TEXT, CURRENCY);
    expect(kept).toEqual([]);
    expect(drops).toEqual({ not_in_source: 0, unparseable: 1 });
  });

  it('drops a foreign label the page does not print', () => {
    const { kept, drops } = gateItems([item('5,00', { currency: 'MXN' })], 'Sopa 5,00', CURRENCY);
    expect(kept).toEqual([]);
    expect(drops).toEqual({ not_in_source: 0, unparseable: 1 });
  });

  it('keeps the supported items in order and counts every item it dropped', () => {
    const items = [
      item('11,00 €', { name: 'Invented' }),
      item('1,50 €', { name: 'Água' }),
      item('13,00 €', { name: 'Arroz de pato' }),
      item('12–15 €', { name: 'Polvo' }),
    ];
    const { kept, drops } = gateItems(items, SOURCE_TEXT, CURRENCY);
    for (const keptItem of kept) {
      expect(normalizeWhitespace(SOURCE_TEXT)).toContain(keptItem.priceText);
    }
    expect(kept.map((keptItem) => keptItem.name)).toEqual(['Água', 'Arroz de pato']);
    expect(kept.map((keptItem) => keptItem.priceText)).toEqual(['1,50 €', '13,00 €']);
    expect(kept.map((keptItem) => keptItem.localAmountMinor)).toEqual([
      parsePrice('1,50 €', CURRENCY),
      parsePrice('13,00 €', CURRENCY),
    ]);
    expect(kept.length + drops.not_in_source + drops.unparseable).toBe(items.length);
    expect(drops).toEqual({ not_in_source: 1, unparseable: 1 });
  });
});
/** The whitespace runs the gate collapses, and the accented, upper-case string it must leave alone. */
const NORMALIZE_CASES: readonly (readonly [input: string, normalized: string])[] = [
  ['12,50\u00a0€', '12,50 €'],
  ['12,50\u202f€', '12,50 €'],
  ['12,50\u2009€', '12,50 €'],
  ['14,50\n€', '14,50 €'],
  ['Sopa\r\n5,00 €', 'Sopa 5,00 €'],
  ['Água\t1,50 €', 'Água 1,50 €'],
  ['  Arroz   de    pato  ', 'Arroz de pato'],
  ['ÉCOLE 12 €', 'ÉCOLE 12 €'],
];

describe('normalizeWhitespace', () => {
  it.each(NORMALIZE_CASES)('%j -> %j', (input, normalized) => {
    expect(normalizeWhitespace(input)).toBe(normalized);
  });
});
