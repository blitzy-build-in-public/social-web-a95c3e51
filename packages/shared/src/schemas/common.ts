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
 * Keyset cursors.
 */

/**
 * How a keyset cursor's instant is rendered, in the statement that writes it and on the wire: UTC,
 * ISO 8601, microseconds, `Z` suffix (AAP 0.3.3, 0.5.4).
 *
 * Every keyset reader renders its boundary row with
 * `to_char("created_at" AT TIME ZONE 'UTC', CURSOR_INSTANT_FORMAT)` and passes that text back as the
 * next page's bound. It is the statement's own rendering rather than a `Date`, because `created_at`
 * is `timestamptz(6)` and a `Date` holds milliseconds: a bound truncated to the millisecond would
 * hand back the row the previous page ended on, and every row sharing that millisecond with it.
 */
export const CURSOR_INSTANT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * The only instant form a cursor carries: exactly what {@link CURSOR_INSTANT_FORMAT} writes, with
 * each field captured so {@link isRealUtcInstant} can check it against the instant it builds.
 */
const CURSOR_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/**
 * The earliest year a cursor instant may name. The four-digit form admits `0000` and `Date` has a
 * year zero, but PostgreSQL's `timestamptz` does not: it raises `date/time field value out of range`
 * for that literal (and writes 1 BC as `0001-01-01 BC`), so `0001` is the start of the range a keyset
 * statement can write and read.
 */
const CURSOR_INSTANT_FIRST_YEAR = 1;

/**
 * Whether `text` is an instant in the cursor's form that names a real UTC instant, rather than a
 * merely well-formed one.
 *
 * `2026-02-30T00:00:00.000000Z` and a `99` in any field are timestamps PostgreSQL refuses, so a
 * cursor carrying one would turn a bad request into `500`. Rebuilding the instant from its fields and
 * reading every component back is what rejects it: an overflowing field carries into a larger one, so
 * the field that overflowed no longer matches what it was given. A trailing second of 60 (a real leap
 * second) is refused as well, because no statement writes one.
 *
 * The year is applied with `setUTCFullYear`, not through `Date.UTC`, which reads `0001` as `1901` and
 * would refuse a cursor for a genuine instant at the start of the column's range.
 *
 * The year of `0000` is refused for the opposite reason: the rebuilt instant round-trips, because
 * `Date` has a year zero, but the `timestamptz` the readers bind it to has none, so PostgreSQL would
 * raise on the literal and answer a bad request with a `500` instead of the `400` this check exists
 * to give it. Every year from `0001` to `9999` is accepted, and `to_char` writes the same four digits
 * for each, so bounding the field is what keeps the check in step with the column.
 *
 * @param text - The value a cursor carries as its instant.
 * @returns True when `text` is an instant a keyset statement could have written.
 */
function isRealUtcInstant(text: string): boolean {
  const match = CURSOR_INSTANT_RE.exec(text);

  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);

  return (
    year >= CURSOR_INSTANT_FIRST_YEAR &&
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second
  );
}

/**
 * A keyset cursor's instant: the exact form {@link CURSOR_INSTANT_FORMAT} writes, naming a real UTC
 * instant (AAP 0.3.3, 0.5.4). A cursor is client-supplied text, so what reaches a statement as a
 * bound `timestamptz` is checked here rather than trusted.
 */
export const CursorInstant = z.string().regex(CURSOR_INSTANT_RE).refine(isRealUtcInstant);
export type CursorInstant = z.infer<typeof CursorInstant>;

/**
 * The one payload shape of a keyset cursor: the boundary row's creation instant and its id
 * (AAP 0.5.4).
 *
 * A strict object, so a cursor carrying a third key — or a payload of any other shape — is refused
 * rather than interpreted, and the two fields are named `t` and `i` to keep the encoded form short.
 */
export const KeysetCursor = z.strictObject({ t: CursorInstant, i: Uuid });
export type KeysetCursor = z.infer<typeof KeysetCursor>;

/**
 * A decoded keyset position: where one page ended and the next one continues (AAP 0.5.4).
 *
 * `createdAt` stays text and does not become a `Date`, because the microseconds of the
 * `timestamptz(6)` column are what make the bound exact (see {@link CURSOR_INSTANT_FORMAT}).
 */
export interface KeysetCursorPosition {
  /** The boundary row's `created_at`, as {@link CURSOR_INSTANT_FORMAT} renders it. */
  readonly createdAt: string;
  /** The boundary row's id, the tie-breaker under the creation instant. */
  readonly id: string;
}

/**
 * Encodes a keyset position as the opaque cursor a client echoes back unchanged (AAP 0.5.4).
 *
 * The position goes through {@link KeysetCursor} first, so one the codec could not read back — a
 * millisecond instant, say — is never issued. The payload is base64url text, so it survives a query
 * string unmangled and stays well inside the contract's 200-character `Cursor`.
 *
 * @param position - The boundary row's instant, as the statement rendered it, and its id.
 * @returns The cursor that continues after that row.
 * @throws ZodError when the position is not one this codec could read back.
 */
export function encodeKeysetCursor(position: KeysetCursorPosition): string {
  const payload = KeysetCursor.parse({ t: position.createdAt, i: position.id });

  return encodeBase64Url(JSON.stringify(payload));
}

/**
 * Decodes a keyset cursor, or answers `null` for anything that is not one (AAP 0.5.4).
 *
 * A cursor is client-supplied text, so every step is checked rather than trusted: canonical base64url
 * over ASCII, the JSON object inside it, and a {@link KeysetCursor} payload — an instant in exactly
 * the form a statement writes, and a UUID. The refusal is `null` rather than an error because each
 * caller answers it in its own words, as the `400 invalid_field` the contract gives that route.
 *
 * @param value - The `cursor` query parameter, echoed back from a previous page.
 * @returns The position to continue after, or null when `value` is not a cursor this codec wrote.
 */
export function decodeKeysetCursor(value: string): KeysetCursorPosition | null {
  const decoded = decodeBase64Url(value);

  if (decoded === null) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }

  const parsed = KeysetCursor.safeParse(payload);

  if (!parsed.success) {
    return null;
  }

  return { createdAt: parsed.data.t, id: parsed.data.i };
}

/**
 * The one payload shape of a keyset cursor over an ordered column that may hold no instant
 * (AAP 0.5.4).
 *
 * There is one cursor form per shape of ordered column, because the instant a cursor carries is what
 * the next page's bound compares: {@link KeysetCursor} carries one that is always there, and this
 * variant carries one that may be absent. `CallTask.outcomeAt` is such a column — null until a task
 * reaches its first outcome, and the operator queue orders by it (AAP 0.5.2, 0.5.7) — so that queue's
 * cursors are encoded here, and a cursor whose instant is `null` continues inside the block of tasks
 * that have no outcome, which the queue's order places last.
 *
 * A strict object, as {@link KeysetCursor} is: a cursor carrying a third key, or a payload of any
 * other shape, is refused rather than interpreted, and the two fields are named `t` and `i` to keep
 * the encoded form short.
 */
export const NullableKeysetCursor = z.strictObject({ t: CursorInstant.nullable(), i: Uuid });
export type NullableKeysetCursor = z.infer<typeof NullableKeysetCursor>;

/**
 * A decoded position on a nullable ordered column: where one page ended and the next one continues
 * (AAP 0.5.4).
 *
 * `instant` stays text and does not become a `Date`, for the reason {@link KeysetCursorPosition}
 * states: the microseconds of a `timestamptz(6)` column are what make the bound exact. It is `null`
 * when the boundary row held no instant, which the order that column is read under places after
 * every row that holds one.
 */
export interface NullableKeysetCursorPosition {
  /** The boundary row's instant, as {@link CURSOR_INSTANT_FORMAT} renders it, or null when it has none. */
  readonly instant: string | null;
  /** The boundary row's id, the tie-breaker under the instant. */
  readonly id: string;
}

/**
 * Encodes a position on a nullable ordered column as the opaque cursor a client echoes back
 * unchanged (AAP 0.5.4).
 *
 * The position goes through {@link NullableKeysetCursor} first, so one this codec could not read
 * back — a millisecond instant, say — is never issued. The payload is base64url text, so it survives
 * a query string unmangled and stays well inside the contract's 200-character `Cursor`.
 *
 * @param position - The boundary row's instant, as the statement rendered it or `null` when the row
 *   had none, and its id.
 * @returns The cursor that continues after that row.
 * @throws ZodError when the position is not one this codec could read back.
 */
export function encodeNullableKeysetCursor(position: NullableKeysetCursorPosition): string {
  const payload = NullableKeysetCursor.parse({ t: position.instant, i: position.id });

  return encodeBase64Url(JSON.stringify(payload));
}

/**
 * Decodes a cursor over a nullable ordered column, or answers `null` for anything that is not one
 * (AAP 0.5.4).
 *
 * A cursor is client-supplied text, so every step is checked rather than trusted: canonical base64url
 * over ASCII, the JSON object inside it, and a {@link NullableKeysetCursor} payload — an instant in
 * exactly the form a statement writes or `null`, and a UUID. The refusal is `null` rather than an
 * error because each caller answers it in its own words, as the `400 invalid_field` the contract
 * gives that route.
 *
 * @param value - The `cursor` query parameter, echoed back from a previous page.
 * @returns The position to continue after, or null when `value` is not a cursor this codec wrote.
 */
export function decodeNullableKeysetCursor(value: string): NullableKeysetCursorPosition | null {
  const decoded = decodeBase64Url(value);

  if (decoded === null) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }

  const parsed = NullableKeysetCursor.safeParse(payload);

  if (!parsed.success) {
    return null;
  }

  return { instant: parsed.data.t, id: parsed.data.i };
}

/** The 64 characters of base64url, in encoding order (RFC 4648 §5), with no padding character. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Base64url-encodes ASCII `text`, unpadded.
 *
 * Written out over character codes rather than through a platform base-64 helper: the Node encoding
 * and the DOM pair are both absent where this module also runs — under Hermes, and in a browser — and
 * the shared barrel is what the mobile and web bundles import. For the {@link KeysetCursor} payloads
 * this file encodes, the result is byte-identical to the unpadded base64url of the same ASCII text on
 * a Node host.
 *
 * @param text - ASCII text, as `JSON.stringify` of a cursor payload produces.
 * @returns Its unpadded base64url.
 */
function encodeBase64Url(text: string): string {
  let encoded = '';

  for (let index = 0; index < text.length; index += 3) {
    const first = text.charCodeAt(index);
    const second = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
    const third = index + 2 < text.length ? text.charCodeAt(index + 2) : -1;

    encoded += BASE64URL_ALPHABET.charAt(first >> 2);
    encoded += BASE64URL_ALPHABET.charAt(((first & 0x03) << 4) | (second < 0 ? 0 : second >> 4));

    if (second < 0) {
      break;
    }

    encoded += BASE64URL_ALPHABET.charAt(((second & 0x0f) << 2) | (third < 0 ? 0 : third >> 6));

    if (third < 0) {
      break;
    }

    encoded += BASE64URL_ALPHABET.charAt(third & 0x3f);
  }

  return encoded;
}

/**
 * Base64url-decodes `text`, or answers `null` when it is not the canonical base64url of ASCII text.
 *
 * Five things are refused, each because an encoder never writes it: an empty value, a length of one
 * over a multiple of four (a lone trailing character carries six of the eight bits a byte needs), a
 * character outside the alphabet, a padding bit set in the last character — the canonical form leaves
 * those bits zero, so a value carrying one is not the decoding of the bytes underneath it — and a
 * decoded byte above `0x7f`, because a cursor's payload is ASCII throughout.
 *
 * @param text - The value to decode.
 * @returns The decoded ASCII text, or null when `text` is not canonical base64url of ASCII.
 */
function decodeBase64Url(text: string): string | null {
  if (text.length === 0 || text.length % 4 === 1) {
    return null;
  }

  let bits = 0;
  let pending = 0;
  let decoded = '';

  for (let index = 0; index < text.length; index += 1) {
    const value = BASE64URL_ALPHABET.indexOf(text.charAt(index));

    if (value < 0) {
      return null;
    }

    bits = (bits << 6) | value;
    pending += 6;

    if (pending < 8) {
      continue;
    }

    pending -= 8;

    const byte = (bits >> pending) & 0xff;

    if (byte > 0x7f) {
      return null;
    }

    decoded += String.fromCharCode(byte);
  }

  return (bits & ((1 << pending) - 1)) === 0 ? decoded : null;
}

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
