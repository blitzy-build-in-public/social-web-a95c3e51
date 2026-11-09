/**
 * The locale price parser's unit suite (AAP 0.5.6, "Source gate").
 */

import { describe, expect, it } from 'vitest';

import {
  hasExplicitCurrencyMarker,
  isPriceCurrency,
  MINOR_UNIT_EXPONENT,
  parsePrice,
  type PriceCurrency,
} from '../../src/menus/price-parse.ts';

type AcceptedCase = readonly [text: string, currency: PriceCurrency, major: number];

/** A refused string; `currency` stays a plain string, so an unsupported code can be a row. */
type RefusedCase = readonly [text: string, currency: string];

type MarkerCase = readonly [text: string, currency: PriceCurrency, explicit: boolean];

/**
 * The amount `major` units of `currency` is worth in that currency's ISO 4217 minor units, read
 * from the module's exponent table so no minor-unit literal is repeated in this suite.
 */
function minor(major: number, currency: PriceCurrency): number {
  return Math.round(major * 10 ** MINOR_UNIT_EXPONENT[currency]);
}

/**
 * Every form the pipeline must read, one row per rule: both separator orders (`1.234,50` and
 * `1,234.50`), each launch currency's marker, the grouping a lone separator is resolved by
 * (`12,50` is 12.50, `1.500` is 1500), and the IDR thousands suffix (`45K`, `45rb`, `45,5K`). The
 * `€` rows are the fixture strings, in the shapes those pages print themselves.
 */
const ACCEPTED_CASES: readonly AcceptedCase[] = [
  ['1.234,50', 'EUR', 1234.5],
  ['1,234.50', 'USD', 1234.5],
  ['€12,50', 'EUR', 12.5],
  ['12,50\u00a0€', 'EUR', 12.5],
  ['14,50\n€', 'EUR', 14.5],
  ['$12.50', 'USD', 12.5],
  ['MX$ 180', 'MXN', 180],
  ['COP 25.000', 'COP', 25000],
  ['฿120', 'THB', 120],
  ['Rp 45.000', 'IDR', 45000],
  ['Rp 45.000,-', 'IDR', 45000],
  ['Rp 1.234.567', 'IDR', 1234567],
  ['45K', 'IDR', 45000],
  ['45rb', 'IDR', 45000],
  ['45,5K', 'IDR', 45500],
  ['12,50', 'EUR', 12.5],
  ['1.500', 'EUR', 1500],
  ['1,500', 'USD', 1500],
  ['3,50 €', 'EUR', 3.5],
  ['0,90 €', 'EUR', 0.9],
  ['15,00 €', 'EUR', 15],
  ['40,00 €', 'EUR', 40],
];

/**
 * The strings that are not one price in the row's currency: empty or blank, a sign, zero, a range,
 * two prices, a malformed grouping, the IDR suffix in another currency, a marker naming a currency
 * the row does not ask for, and a code the pipeline does not price.
 */
const REFUSED_CASES: readonly RefusedCase[] = [
  ['', 'EUR'],
  ['   ', 'EUR'],
  ['-5', 'EUR'],
  ['-5,00 €', 'EUR'],
  ['0', 'EUR'],
  ['0,00 €', 'EUR'],
  ['10-12 €', 'EUR'],
  ['12–15 €', 'EUR'],
  ['12,50 € / 14,00 €', 'EUR'],
  ['2 for 10', 'EUR'],
  ['market price', 'EUR'],
  ['Preço sob consulta', 'EUR'],
  ['1,23,456', 'USD'],
  ['45K', 'EUR'],
  ['€12', 'MXN'],
  ['12,50', 'GBP'],
];

/** A bare `$` is ambiguous (USD, MXN or COP) and counts for USD alone; two markers name none. */
const MARKER_CASES: readonly MarkerCase[] = [
  ['€12,50', 'EUR', true],
  ['12,50', 'EUR', false],
  ['Rp 45.000', 'IDR', true],
  ['฿120', 'THB', true],
  ['$12.50', 'USD', true],
  ['$12.50', 'MXN', false],
  ['12,50 € EUR', 'EUR', false],
];

describe('MINOR_UNIT_EXPONENT and isPriceCurrency', () => {
  it('covers exactly the six currencies the pipeline prices', () => {
    expect(Object.keys(MINOR_UNIT_EXPONENT).sort()).toEqual([
      'COP',
      'EUR',
      'IDR',
      'MXN',
      'THB',
      'USD',
    ]);
  });

  it.each(['USD', 'EUR', 'MXN', 'COP', 'THB', 'IDR'] as const)('%s is a price currency', (code) => {
    expect(isPriceCurrency(code)).toBe(true);
  });

  it.each(['GBP', 'eur', ''])('%s is not', (code) => {
    expect(isPriceCurrency(code)).toBe(false);
  });
});

describe('parsePrice', () => {
  it.each(ACCEPTED_CASES)('reads %s as %s', (text, currency, major) => {
    expect(parsePrice(text, currency)).toBe(minor(major, currency));
  });

  it.each(REFUSED_CASES)('refuses %s as %s, without throwing', (text, currency) => {
    expect(() => parsePrice(text, currency)).not.toThrow();
    expect(parsePrice(text, currency)).toBeNull();
  });
});

describe('hasExplicitCurrencyMarker', () => {
  it.each(MARKER_CASES)('%s names %s: %s', (text, currency, explicit) => {
    expect(hasExplicitCurrencyMarker(text, currency)).toBe(explicit);
  });
});
