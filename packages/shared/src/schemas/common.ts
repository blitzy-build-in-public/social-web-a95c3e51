/**
 * Shared primitives of the Tablemate contract (AAP 0.5.4, AAP 0.8.1).
 *
 * Every other module under `packages/shared/src/schemas` builds on these primitives and none of
 * them is redeclared (AAP 0.11.1). This module therefore imports `zod` alone and never a sibling:
 * a back-edge would close a cycle.
 *
 * It is client-safe by construction — no Node built-in, no DOM global, no top-level side effect —
 * because the same module runs under Hermes (React Native 0.76.9), in a browser and in Node.
 */
import { z } from 'zod';

/*
 * Scalar primitives.
 */

/**
 * A row identifier. Ids are UUIDv7 (AAP 0.5.2), which `z.uuid()` accepts along with every other
 * RFC 9562 version.
 */
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/**
 * A city slug, the primary key of `City` (AAP 0.5.2) — `lisbon`, `mexico-city`, `medellin`,
 * `chiang-mai`, `canggu`.
 *
 * An open format rather than a closed enum, because the launch cities are configuration in
 * `config/cities.json` and the pilot must be able to change them without a code change
 * (AAP 0.1.3).
 */
export const CitySlug = z
  .string()
  .max(40)
  .regex(/^[a-z]+(-[a-z]+)*$/);
export type CitySlug = z.infer<typeof CitySlug>;

/**
 * An ISO 8601 instant in UTC with the `Z` suffix only, never a numeric offset (AAP 0.3.3). Every
 * timestamp on the wire — request, response and WebSocket frame — is this form, and storage is
 * `timestamptz` in UTC (AAP 0.11.1).
 */
export const IsoDateTime = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** A calendar date as `YYYY-MM-DD` (AAP 0.3.3): stay dates, a proof's validity dates. */
export const DateOnly = z.iso.date();
export type DateOnly = z.infer<typeof DateOnly>;

/** An amount of money in integer USD cents; money is never a float (AAP 0.11.1). */
export const UsdCents = z.number().int().nonnegative();
export type UsdCents = z.infer<typeof UsdCents>;

/** A non-negative integer count in a response DTO, such as `attempts` or a metric (AAP 0.5.4). */
export const Count = z.number().int().nonnegative();
export type Count = z.infer<typeof Count>;

/** A WGS 84 latitude in degrees. */
export const Latitude = z.number().min(-90).max(90);
export type Latitude = z.infer<typeof Latitude>;

/** A WGS 84 longitude in degrees. */
export const Longitude = z.number().min(-180).max(180);
export type Longitude = z.infer<typeof Longitude>;

/**
 * A coordinate pair, as configuration carries it (`CityConfig.centroid`, AAP 0.5.2). DTOs such as
 * `VenueDto` spell `lat` and `lng` out inline instead of nesting this object.
 */
export const LatLng = z.strictObject({ lat: Latitude, lng: Longitude });
export type LatLng = z.infer<typeof LatLng>;

/**
 * An E.164 phone number, `+` and 7 to 15 digits (AAP 0.5.2 `Place.phone`, `Lodging.phone`).
 */
export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/);
export type E164 = z.infer<typeof E164>;

/** An ISO 3166-1 alpha-2 country code, uppercase (AAP 0.5.2 `User.homeCountryCode`). */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/);
export type CountryCode = z.infer<typeof CountryCode>;

/** An ISO 4217 currency code, uppercase (AAP 0.5.2 `City.currency`). */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/**
 * A lowercase hexadecimal SHA-256 digest, the form `artifacts.manifest.json` records for the
 * proving artifacts (AAP 0.5.5).
 */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/**
 * A BN254 scalar field element as a decimal string, the form snarkjs uses for proof coordinates
 * and public signals (AAP 0.5.5). 78 digits is the field modulus length.
 */
export const FieldElement = z.string().regex(/^\d{1,78}$/);
export type FieldElement = z.infer<typeof FieldElement>;

/**
 * An opaque keyset cursor for paginated reads, echoed back by the client unchanged
 * (AAP 0.5.1 discovery, AAP 0.5.4 meetup and message lists).
 */
export const Cursor = z.string().min(1).max(200);
export type Cursor = z.infer<typeof Cursor>;

/**
 * A lowercase host or registrable domain, with no scheme, port or trailing dot; a single label is
 * accepted so a local fixture host can be reviewed (AAP 0.5.6 crawl policy). Shared by the
 * `:domain` path parameter and the `CrawlDomainPolicy` routes.
 */
export const Domain = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/);
export type Domain = z.infer<typeof Domain>;

/*
 * Pagination and route parameters.
 */

/**
 * The response of every 20-per-page list route: `GET /cities/:cityId/travelers`, `GET /meetups`,
 * message history (AAP 0.5.4). `nextCursor` is `null` on the last page.
 *
 * A response DTO, so it uses `z.object` and strips unknown keys on serialization.
 *
 * @param item - The schema of one list element.
 */
export function paginated<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: Cursor.nullable() });
}

/** The query string of a paginated list route (AAP 0.5.4). */
export const CursorQuery = z.strictObject({ cursor: Cursor.optional() });
export type CursorQuery = z.infer<typeof CursorQuery>;

/** The `:id` path parameter of a meetup, dispute, claim or lodging route (AAP 0.5.4). */
export const IdParams = z.strictObject({ id: Uuid });
export type IdParams = z.infer<typeof IdParams>;

/** The `:userId` path parameter of a profile or block route (AAP 0.5.4). */
export const UserIdParams = z.strictObject({ userId: Uuid });
export type UserIdParams = z.infer<typeof UserIdParams>;

/** The `:cityId` path parameter, a configured city slug (AAP 0.5.4). */
export const CityIdParams = z.strictObject({ cityId: CitySlug });
export type CityIdParams = z.infer<typeof CityIdParams>;

/** The `:domain` path parameter of the crawl-domain review routes (AAP 0.5.4, AAP 0.5.6). */
export const DomainParams = z.strictObject({ domain: Domain });
export type DomainParams = z.infer<typeof DomainParams>;

/*
 * Health and test control.
 */

/** The body of public `GET /v1/health`, the liveness and readiness probe for compose (AAP 0.5.4). */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: z.enum(['ok', 'fail']),
    redis: z.enum(['ok', 'fail']),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/**
 * The header carrying `TEST_CONTROL_TOKEN` on the test-control routes, which are mounted only when
 * `APP_ENV=test` and that token is set (AAP 0.5.1).
 */
export const TEST_CONTROL_HEADER = 'X-Test-Control-Token' as const;

/**
 * The body of `POST /test/clock`, which moves the injected clock so a test can cross the 45-minute
 * check-in period, the 24-hour erasure limit and the 30-day anti-farming rule (AAP 0.1.1).
 *
 * Exactly one of `now` and `advanceMs` is supplied: `now` sets the clock, `advanceMs` moves it
 * forward by that many milliseconds.
 */
export const TestClockRequest = z
  .strictObject({
    now: IsoDateTime.optional(),
    advanceMs: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.now === undefined) === (value.advanceMs === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Supply exactly one of `now` or `advanceMs`.',
        path: [],
      });
    }
  });
export type TestClockRequest = z.infer<typeof TestClockRequest>;

/**
 * The body of `POST /test/run-settlement`: one meetup when `meetupId` is supplied, otherwise a
 * full sweeper pass (AAP 0.5.1 test control).
 */
export const RunSettlementRequest = z.strictObject({ meetupId: Uuid.optional() });
export type RunSettlementRequest = z.infer<typeof RunSettlementRequest>;

/*
 * UTF-8 byte counting.
 */

/**
 * The number of UTF-8 bytes `s` encodes to, counted by hand rather than through a platform
 * encoder, because this package also runs under Hermes and in a browser.
 *
 * The circuit caps a template anchor and a city alias at 32 bytes (AAP 0.5.5), and those limits
 * have to be checked on the client, so the count must match what the prover hashes. A lone
 * surrogate counts 3, the width of the U+FFFD replacement it becomes when encoded.
 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;

  for (const ch of s) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }

    if (codePoint < 0x80) {
      bytes += 1;
    } else if (codePoint < 0x800) {
      bytes += 2;
    } else if (codePoint < 0x10000) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }

  return bytes;
}
