/** Deterministic price-string parsing for the menu pipeline (AAP 0.5.1, 0.5.6). The source gate keeps an extracted item only when its `priceText` occurs in the source text and this module parses that substring to the same amount, so no price is ever guessed. The module is pure — no imports, no I/O, no clock — and total: the same text always yields the same amount or `null`. Money is assembled as a digit string and converted once, never through floating-point arithmetic, so `45,5K` IDR is exactly 4,550,000 minor units. */

/** ISO 4217 minor-unit exponents for USD and the five launch-city currencies (AAP 0.5.2: EUR, MXN, COP, THB, IDR). ISO 4217 lists 2 for COP and IDR even though menus usually print them without decimals, so `Rp 45.000` is 4,500,000 minor units and `COP 25.000` is 2,500,000. `apps/workers/src/fx/open-er-api.ts` imports this table — never redefining it — to scale those minor units back to major units, so the two stay consistent. */
export const MINOR_UNIT_EXPONENT = {
  USD: 2,
  EUR: 2,
  MXN: 2,
  COP: 2,
  THB: 2,
  IDR: 2,
} as const satisfies Record<string, number>;
/** A currency this module parses: USD plus the five launch-city currencies (AAP 0.5.2). */
export type PriceCurrency = keyof typeof MINOR_UNIT_EXPONENT;
/** Narrows a currency code to the ones {@link MINOR_UNIT_EXPONENT} covers (AAP 0.5.6); every other code is refused, so no price is reported in a currency the pipeline cannot convert. */
export function isPriceCurrency(code: string): code is PriceCurrency {
  return Object.hasOwn(MINOR_UNIT_EXPONENT, code);
}

/** One currency marker and the currencies it may denote; a bare `$` is ambiguous: USD, MXN, COP. */
interface CurrencyMarker {
  /** The marker as a menu or a call writes it; ASCII markers match case-insensitively. */
  readonly text: string;
  /** The currencies the marker names. */
  readonly currencies: readonly PriceCurrency[];
}

/** The marker table shared by {@link parsePrice} and {@link hasExplicitCurrencyMarker}, longest marker first so that `COL$`, `MX$`, `US$` and `Rp.` win over the `$` or `Rp` they end with. */
const CURRENCY_MARKERS: readonly CurrencyMarker[] = [
  { text: 'COL$', currencies: ['COP'] },
  { text: 'MX$', currencies: ['MXN'] },
  { text: 'US$', currencies: ['USD'] },
  { text: 'EUR', currencies: ['EUR'] },
  { text: 'USD', currencies: ['USD'] },
  { text: 'MXN', currencies: ['MXN'] },
  { text: 'COP', currencies: ['COP'] },
  { text: 'THB', currencies: ['THB'] },
  { text: 'IDR', currencies: ['IDR'] },
  { text: 'Rp.', currencies: ['IDR'] },
  { text: 'บาท', currencies: ['THB'] },
  { text: 'Rp', currencies: ['IDR'] },
  { text: '€', currencies: ['EUR'] },
  { text: '฿', currencies: ['THB'] },
  { text: '$', currencies: ['USD', 'MXN', 'COP'] },
];
/** The characters that may separate the digit groups of one number: space is thousands only. */
const SEPARATOR_CHARS = ['.', ',', ' '] as const;
/** One number and nothing else: a digit, digits with separators, then a closing digit. */
const NUMBER_TOKEN = /^[0-9](?:[0-9., ]*[0-9])?$/u;
/** `45K`, `45k`, `45 rb` and `45 ribu`: the IDR thousands suffix, which `parsePrice` restricts. */
const THOUSANDS_SUFFIX = /^(.*?)\s?(?:K|k|rb|ribu)$/u;
/** A trailing `,-` or `.-`, written after an Indonesian menu amount and adding no decimals. */
const TRAILING_NO_DECIMALS = /[.,]-$/u;
/** Collapses the whitespace a page renders between a marker, a number and a suffix. */
function normalize(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** Finds one currency marker at the start or the end of the text, the longest marker winning. `null` means no marker, which is not an error: an unmarked number is read in the caller's currency. */
function matchMarker(text: string): { rest: string; marker: CurrencyMarker } | null {
  for (const marker of CURRENCY_MARKERS) {
    const length = marker.text.length;
    if (text.length < length) continue;
    // Only the bounded slice is upper-cased, so case mapping can never shift the marker's bounds.
    const upper = marker.text.toUpperCase();
    if (text.slice(0, length).toUpperCase() === upper) {
      return { rest: text.slice(length).trim(), marker };
    }
    if (text.slice(-length).toUpperCase() === upper) {
      return { rest: text.slice(0, -length).trim(), marker };
    }
  }
  return null;
}

/** Counts the occurrences of one character. */
function countChar(text: string, char: string): number {
  let count = 0;
  for (const character of text) {
    if (character === char) count += 1;
  }
  return count;
}

/** Validates one grouped integer part and returns its digits, or `null`. One separator character groups it: a leading group of one to three digits, then groups of exactly three (`1.234` is 1234, `25 000` is 25000; `1,23,456` and a mix such as `1.234 567` are refused). A digit run passes. */
function groupedDigits(part: string): string | null {
  const separators = SEPARATOR_CHARS.filter((separator) => part.includes(separator));
  if (separators.length > 1) return null;
  const [separator] = separators;
  if (separator === undefined) return /^[0-9]+$/u.test(part) ? part : null;
  const [head = '', ...tail] = part.split(separator);
  if (head.length < 1 || head.length > 3 || !/^[0-9]+$/u.test(head)) return null;
  for (const group of tail) {
    if (group.length !== 3 || !/^[0-9]+$/u.test(group)) return null;
  }
  return head + tail.join('');
}

/**
 * Resolves the separators of one numeric token and returns its digits in ISO 4217 minor units, or
 * `null` when the token is not exactly one number.
 *
 * Both `.` and `,` present: the later one is the decimal separator and must be followed by one or
 * two digits, and the integer part is grouped by the other character (`1.234,50` and `1,234.50` are
 * both 1234.50); a three-digit tail is not a fraction, so `1,234.567` is refused.
 *
 * One kind of separator, occurring more than once: every occurrence is a thousands separator, so
 * `1.234.567` is 1234567 while `1,23,456` fails on its two-digit group.
 *
 * A lone separator: one or two trailing digits make it a decimal (`12,5` and `12,50` are 12.50),
 * exactly three trailing digits behind a leading group of one to three make it a thousands
 * separator (`25.000` is 25000, `1,234` is 1234), and anything else is refused (`1234,5678`).
 *
 * Space is only ever a thousands separator between groups of exactly three (`1 234,50`, `25 000`),
 * so `12 15` is refused rather than read as one number.
 */
function minorUnitDigits(token: string, exponent: number): string | null {
  if (!NUMBER_TOKEN.test(token)) return null;
  const dots = countChar(token, '.');
  const commas = countChar(token, ',');
  let decimal: '.' | ',' | null = null;
  if (dots > 0 && commas > 0) {
    decimal = token.lastIndexOf('.') > token.lastIndexOf(',') ? '.' : ',';
  } else if (dots + commas === 1) {
    const separator = dots === 1 ? '.' : ',';
    const trailing = token.length - token.lastIndexOf(separator) - 1;
    if (trailing === 1 || trailing === 2) decimal = separator;
    else if (trailing !== 3) return null;
  }
  const boundary = decimal === null ? -1 : token.lastIndexOf(decimal);
  const integerPart = boundary === -1 ? token : token.slice(0, boundary);
  const fractionPart = boundary === -1 ? '' : token.slice(boundary + 1);
  if (fractionPart.length > exponent) return null;
  if (fractionPart !== '' && !/^[0-9]+$/u.test(fractionPart)) return null;
  const integer = groupedDigits(integerPart);
  if (integer === null) return null;
  return integer + fractionPart.padEnd(exponent, '0');
}

/**
 * Parses one price string into a positive integer amount in the ISO 4217 minor units of
 * `currency` (AAP 0.5.6), or `null` when the text is not one unambiguous price in that currency.
 *
 * The order of the checks is the rule. The text is NFKC-normalized and its whitespace collapsed;
 * at most one currency marker may appear, at either end (`12,50 €`, `€12,50`, `EUR 12.50`), and it
 * must name `currency`, so `€12` read as MXN is refused; a trailing `,-` or `.-` is dropped
 * (`Rp 45.000,-`); the IDR thousands suffix `K`, `k`, `rb` or `ribu` multiplies by 1,000 for IDR
 * and is refused for every other currency, so `45K` is not 45 EUR; what remains must be exactly one
 * number, which refuses signs, ranges (`12-15`, `12 – 15 €`), a second number (`12 15`, `12 / 15`)
 * and letters; and the amount must be a safe integer greater than 0, which refuses `0,00 €` and a
 * digit run beyond `Number.MAX_SAFE_INTEGER`. Zero is refused because a free item is not a price.
 */
export function parsePrice(text: string, currency: string): number | null {
  if (!isPriceCurrency(currency)) return null;
  const exponent = MINOR_UNIT_EXPONENT[currency];
  let rest = normalize(text);
  if (rest === '') return null;
  const marked = matchMarker(rest);
  if (marked !== null) {
    if (!marked.marker.currencies.includes(currency)) return null;
    if (matchMarker(marked.rest) !== null) return null;
    rest = marked.rest;
  }
  rest = rest.replace(TRAILING_NO_DECIMALS, '').trim();
  if (rest === '') return null;
  let scaled = false;
  const suffix = THOUSANDS_SUFFIX.exec(rest);
  if (suffix !== null) {
    if (currency !== 'IDR') return null;
    scaled = true;
    rest = (suffix[1] ?? '').trim();
  }
  const digits = minorUnitDigits(rest, exponent);
  if (digits === null) return null;
  const amount = Number(scaled ? `${digits}000` : digits);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

/** Reports whether the text carries a marker that names `currency` (AAP 0.5.6), so the source gate can refuse a number whose currency the page does not name. A bare `$` is ambiguous — it may mean USD, MXN or COP — and counts only for USD, as `$5` in Canggu may be a dollar price. Text carrying two markers names no single currency and reports `false`. Only the marker is inspected: it says nothing about whether the text parses. */
export function hasExplicitCurrencyMarker(text: string, currency: PriceCurrency): boolean {
  const found = matchMarker(normalize(text));
  if (found === null || matchMarker(found.rest) !== null) return false;
  if (found.marker.text === '$') return currency === 'USD';
  return found.marker.currencies.includes(currency);
}
