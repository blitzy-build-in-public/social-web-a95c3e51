/**
 * The daily USD FX table and the conversion built on it (AAP 0.3.3; conversion 0.5.6): `fx-refresh` stores what
 * {@link fetchUsdTable} returns through {@link toFxRows}, and the menu and call pipelines convert a local price
 * with {@link fxRateFor} and {@link toUsdCents}, keeping the rate's date as `fxDate`. The endpoint arrives as an
 * argument and a row's date is the provider's own, so this module reads no environment, no clock and no query of
 * its own, and each failure carries a code rather than a response body.
 */

import { z } from 'zod';

import { Prisma } from '@tablemate/db';
import type { DbClient, DbTx } from '@tablemate/db';

import { isPriceCurrency, MINOR_UNIT_EXPONENT } from '../menus/price-parse.ts';

/**
 * The currencies the FX table covers: the five launch cities' (AAP 0.5.2 — EUR, MXN, COP, THB, IDR)
 * plus USD, the unit every price is stored in. A city with a new currency must be added here and to
 * `MINOR_UNIT_EXPONENT` in `../menus/price-parse.ts`.
 */
export const FX_CURRENCIES = ['USD', 'EUR', 'MXN', 'COP', 'THB', 'IDR'] as const;

/** One currency {@link FX_CURRENCIES} covers. */
export type FxCurrency = (typeof FX_CURRENCIES)[number];

/**
 * The provider's table for one UTC day (AAP 0.3.3), in the direction the provider quotes it: units
 * of each currency per 1 USD, which {@link toFxRows} inverts before storing anything.
 */
export type UsdTable = {
  /**
   * The UTC day the provider's rates belong to, `YYYY-MM-DD`, from its own `time_last_update_unix`: what
   * {@link toFxRows} stores as `FxRate.date`, so a table served late keys the day it belongs to rather than the
   * day the job happened to run.
   */
  date: string;
  /** Units of the quoted currency per 1 USD, by currency code — the provider's direction. */
  rates: Readonly<Record<string, number>>;
};

/** The scale of `FxRate.usdPerUnit`, `@db.Decimal(20, 10)` in the schema. */
const USD_PER_UNIT_SCALE = 10;

/** The deadline applied when the caller passes none (AAP 0.11.1: a bounded external call). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The only date spelling {@link utcDate} accepts, which is also how Prisma's `Date` is reported. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The provider's success envelope (AAP 0.3.3), loose because a real table carries many more keys. `result` and
 * `base_code` are pinned — a bad request is answered with `{ result: 'error' }` under HTTP 200, and another unit
 * would be inverted before it was stored — and each rate must be positive, which rules out a division by zero.
 */
const UsdTableResponse = z.looseObject({
  result: z.literal('success'),
  base_code: z.literal('USD'),
  time_last_update_unix: z.number().int().positive(),
  rates: z.record(z.string(), z.number().positive().finite()),
});

/**
 * Reads the provider's latest USD table in one request (AAP 0.3.3).
 *
 * answer, `fx_response_invalid` on a body outside the envelope above or on a timestamp no `Date` can
 * represent. `fx-refresh` lets it out to have BullMQ retry, and the rows already stored keep serving
 * conversions ("the last good table stays in use").
 */
export async function fetchUsdTable(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<UsdTable> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error('fx_fetch_failed: transport', { cause: error });
  }
  if (!response.ok) {
    throw new Error(`fx_fetch_failed: HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('fx_response_invalid');
  }
  const parsed = UsdTableResponse.safeParse(body);
  if (!parsed.success) {
    throw new Error('fx_response_invalid', { cause: parsed.error });
  }
  // Built once, before any getter reads it: an unrepresentable timestamp yields an invalid `Date`
  // whose `toISOString` throws an untyped RangeError, which the envelope's positive integer alone
  // does not rule out.
  const updatedAt = new Date(parsed.data.time_last_update_unix * 1_000);
  if (Number.isNaN(updatedAt.getTime())) {
    throw new Error('fx_response_invalid');
  }
  return {
    date: updatedAt.toISOString().slice(0, 10),
    rates: parsed.data.rates,
  };
}

/**
 * Turns a fetched table into the `FxRate` rows of the table's own date, one per {@link FX_CURRENCIES} entry and
 * in that order, ready for `createMany` or for `upsert({ where: { date_currency: … } })`.
 *
 * The provider quotes units of a currency per 1 USD and the row stores the USD one unit of that currency buys:
 * `FxRate.usdPerUnit = 1 / rates[currency]`, rounded to the column's own scale, so a conversion made from the
 * value computed here and one made from the value the database returns agree (AAP 0.5.6).
 */
export function toFxRows(
  table: UsdTable,
): { date: Date; currency: FxCurrency; usdPerUnit: Prisma.Decimal }[] {
  const day = utcDate(table.date);
  return FX_CURRENCIES.map((currency) => {
    const rate = table.rates[currency];
    if (rate === undefined) {
      throw new Error(`fx_rate_missing: ${currency}`);
    }
    return {
      date: day,
      currency,
      usdPerUnit: new Prisma.Decimal(1)
        .div(rate)
        .toDecimalPlaces(USD_PER_UNIT_SCALE, Prisma.Decimal.ROUND_HALF_UP),
    };
  });
}

/**
 * The rate to convert a price captured on `date` (AAP 0.5.6): the latest row on or before the capture date, so a
 * day whose refresh failed still converts through the last good table, and the AAP sets no staleness limit. USD
 * needs no row — it is the stored unit and always converts at 1 — and a currency the table does not cover leaves
 * the caller nothing to convert with, so it drops the item as `currency_unsupported`.
 */
export async function fxRateFor(
  db: DbClient | DbTx,
  currency: string,
  date: string,
): Promise<{ date: string; usdPerUnit: Prisma.Decimal } | null> {
  if (currency === 'USD') {
    return { date, usdPerUnit: new Prisma.Decimal(1) };
  }
  const row = await db.fxRate.findFirst({
    where: { currency, date: { lte: utcDate(date) } },
    orderBy: { date: 'desc' },
    select: { date: true, usdPerUnit: true },
  });
  return row === null
    ? null
    : { date: row.date.toISOString().slice(0, 10), usdPerUnit: row.usdPerUnit };
}

/**
 * Converts a price in the currency's minor units to whole USD cents (AAP 0.5.6). The computation stays in
 * `Prisma.Decimal` throughout: a float would lose cents at the scale of an IDR amount, could round a repeat of
 * the same conversion differently, and stored money is always integer USD cents (AAP 0.11.1).
 */
export function toUsdCents(
  localAmountMinor: number,
  currency: string,
  usdPerUnit: Prisma.Decimal,
): number {
  if (!Number.isSafeInteger(localAmountMinor) || localAmountMinor < 0) {
    throw new RangeError('fx_amount_invalid');
  }
  if (!isPriceCurrency(currency)) {
    throw new Error(`currency_unsupported: ${currency}`);
  }
  return new Prisma.Decimal(localAmountMinor)
    .div(new Prisma.Decimal(10).pow(MINOR_UNIT_EXPONENT[currency]))
    .mul(usdPerUnit)
    .mul(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

/**
 * Reads a `YYYY-MM-DD` date as the UTC midnight Prisma stores in an `@db.Date` column, so the value is the same
 * day whatever the process's own zone is.
 */
function utcDate(date: string): Date {
  if (!DATE_PATTERN.test(date)) {
    throw new RangeError('fx_date_invalid');
  }
  return new Date(`${date}T00:00:00.000Z`);
}
