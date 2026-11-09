/** Shared primitives of the Tablemate contract (AAP 0.8.1). Every other module under `packages/shared/src/schemas` builds on them and none is redeclared, so this module imports `zod` alone and never a sibling, because a back-edge would close a cycle. Client-safe by construction: it runs under Hermes, in a browser and in Node. */
import { z } from 'zod';
/** A row identifier, UUIDv7, which `z.uuid()` accepts along with every other RFC 9562 version. */
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;
/** A city slug, the primary key of `City`. Open rather than a closed enum, since the launch cities are configuration in `config/cities.json`. */
export const CitySlug = z
  .string()
  .max(40)
  .regex(/^[a-z]+(-[a-z]+)*$/);
export type CitySlug = z.infer<typeof CitySlug>;
/** An ISO 8601 instant in UTC with the `Z` suffix only, never a numeric offset (AAP 0.3.3). */
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
/** A WGS-84 latitude in decimal degrees (AAP 0.5.2). */
export const Latitude = z.number().min(-90).max(90);
export type Latitude = z.infer<typeof Latitude>;
/** A WGS-84 longitude in decimal degrees (AAP 0.5.2). */
export const Longitude = z.number().min(-180).max(180);
export type Longitude = z.infer<typeof Longitude>;
/** A coordinate pair, as configuration carries it (`CityConfig.centroid`, AAP 0.5.2). */
export const LatLng = z.strictObject({ lat: Latitude, lng: Longitude });
export type LatLng = z.infer<typeof LatLng>;
/** What a text value may not carry: every C0 control (U+0000 to U+001F) except TAB, LF and CR, plus DEL (U+007F). U+0000 is the one PostgreSQL's UTF-8 `text` cannot hold at all; the rest are invisible in a column, a log line and a call script alike. */
const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/**
 * Free text a client supplies — a nickname, a report reason, a search term, a venue name — carrying no character of
 * {@link CONTROL_CHARACTER_RE}.
 *
 * PostgreSQL's UTF-8 `text` cannot hold U+0000, so a value carrying it raises SQLSTATE 22021 inside the database and
 * would be answered `500` where the boundary owes the caller `400 invalid_field`. The same rule keeps the other
 * invisible controls out of the columns, the log lines and the call scripts. Each field narrows this primitive with
 * its own `.min()` and `.max()` (AAP 0.11.2 input validation on every route and frame).
 */
export const FreeText = z
  .string()
  .refine((value) => !CONTROL_CHARACTER_RE.test(value), 'Must not contain control characters.');
export type FreeText = z.infer<typeof FreeText>;
/** An E.164 phone number, `+` and 7 to 15 digits (AAP 0.5.2 `Place.phone`, `Lodging.phone`). */
export const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/);
export type E164 = z.infer<typeof E164>;
/** An ISO 3166-1 alpha-2 country code, uppercase (AAP 0.5.2 `User.homeCountryCode`). */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/);
export type CountryCode = z.infer<typeof CountryCode>;
/** An ISO 4217 currency code, uppercase (AAP 0.5.2 `City.currency`). */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/** A lowercase hex SHA-256 digest, the form the artefact manifest records (AAP 0.5.5). */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256Hex>;
/** A BN254 scalar field element as a decimal string, the form snarkjs uses (AAP 0.5.5). */
export const FieldElement = z.string().regex(/^\d{1,78}$/);
export type FieldElement = z.infer<typeof FieldElement>;
/** An opaque keyset cursor, echoed back by the client unchanged (AAP 0.5.1, 0.5.4). */
export const Cursor = z.string().min(1).max(200);
export type Cursor = z.infer<typeof Cursor>;
/** A lowercase host or registrable domain, with no scheme, port or trailing dot (AAP 0.5.6). */
export const Domain = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/);
export type Domain = z.infer<typeof Domain>;
/** The response of every 20-per-page list route; `nextCursor` is `null` on the last page. */
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
/** How a keyset cursor's instant is rendered, in the statement that writes it and on the wire: UTC, ISO 8601, microseconds, `Z` suffix. A `Date` holds milliseconds, so a bound truncated to the millisecond would hand back the row the previous page ended on. */
export const CURSOR_INSTANT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const CURSOR_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
/** The earliest year a cursor instant may name: PostgreSQL's `timestamptz` has no year zero, so `0001` starts the range a keyset statement can write and read. */
const CURSOR_INSTANT_FIRST_YEAR = 1;
/** Whether `text` names a real UTC instant rather than a merely well-formed one: `2026-02-30T00:00:00.000000Z` is a timestamp PostgreSQL refuses, so a cursor carrying one would turn a bad request into a `500`. Rebuilding the instant from its fields rejects an overflowing one, and the year goes through `setUTCFullYear` because `Date.UTC` reads `0001` as `1901`. */
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
/** A keyset cursor's instant, in the exact form {@link CURSOR_INSTANT_FORMAT} writes. */
export const CursorInstant = z.string().regex(CURSOR_INSTANT_RE).refine(isRealUtcInstant);
export type CursorInstant = z.infer<typeof CursorInstant>;
/** The one payload shape of a keyset cursor: the boundary row's creation instant and its id. Strict, so a cursor carrying a third key is refused rather than interpreted. */
export const KeysetCursor = z.strictObject({ t: CursorInstant, i: Uuid });
export type KeysetCursor = z.infer<typeof KeysetCursor>;
/** A decoded keyset position: where one page ended and the next one continues (AAP 0.5.4). */
export interface KeysetCursorPosition {
  /** The boundary row's `created_at`, as {@link CURSOR_INSTANT_FORMAT} renders it. */
  readonly createdAt: string;
  /** The boundary row's id, the tie-breaker under the creation instant. */
  readonly id: string;
}
/** Encodes a keyset position as the opaque cursor a client echoes back unchanged; a position the codec could not read back is never issued. */
export function encodeKeysetCursor(position: KeysetCursorPosition): string {
  const payload = KeysetCursor.parse({ t: position.createdAt, i: position.id });
  return encodeBase64Url(JSON.stringify(payload));
}
/** Decodes a keyset cursor, or answers `null` for anything that is not one; the refusal is `null` rather than an error because each caller answers it as the `400 invalid_field` of its own route. */
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
/** The payload shape of a cursor over an ordered column that may hold no instant: `CallTask.outcomeAt`. A `null` instant continues inside the block of rows that hold none, which that order places last. */
export const NullableKeysetCursor = z.strictObject({ t: CursorInstant.nullable(), i: Uuid });
export type NullableKeysetCursor = z.infer<typeof NullableKeysetCursor>;
/** A decoded position on a nullable ordered column: where one page ended and the next continues. */
export interface NullableKeysetCursorPosition {
  /** The boundary row's instant, or null when it has none. */
  readonly instant: string | null;
  /** The boundary row's id, the tie-breaker under the instant. */
  readonly id: string;
}
/** Encodes a position on a nullable ordered column as the cursor a client echoes back; one this codec could not read back is never issued. */
export function encodeNullableKeysetCursor(position: NullableKeysetCursorPosition): string {
  const payload = NullableKeysetCursor.parse({ t: position.instant, i: position.id });
  return encodeBase64Url(JSON.stringify(payload));
}
/** Decodes a cursor over a nullable ordered column, or answers `null` for anything that is not one, which each caller answers as its own `400 invalid_field`. */
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
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Base64url-encodes ASCII `text`, unpadded, over character codes: the Node encoding and the DOM pair are both absent under Hermes and in a browser. */
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
/** Base64url-decodes `text`, or answers `null` when it is not canonical base64url of ASCII: an empty value, a bad length, a character outside the alphabet, a padding bit, or a decoded byte above `0x7f`. */
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
/** The `GET /v1/health` body, the liveness and readiness probe for compose (AAP 0.5.4). */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.object({
    database: z.enum(['ok', 'fail']),
    redis: z.enum(['ok', 'fail']),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
/** The header carrying `TEST_CONTROL_TOKEN`, mounted only when `APP_ENV=test` and that token is set. */
export const TEST_CONTROL_HEADER = 'X-Test-Control-Token' as const;
/** The body of `POST /test/clock`, which moves the injected clock so a test can cross the 45-minute check-in period and the 24-hour erasure limit; exactly one of `now` and `advanceMs` is supplied. */
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
/** The body of `POST /test/run-settlement`: one meetup when `meetupId` is supplied, otherwise a full sweeper pass. */
export const RunSettlementRequest = z.strictObject({ meetupId: Uuid.optional() });
export type RunSettlementRequest = z.infer<typeof RunSettlementRequest>;
/** The number of UTF-8 bytes `s` encodes to, counted by hand so no platform encoder is needed; the circuit caps an anchor and a city alias at 32 bytes and the client checks that limit, so the count must match what the prover hashes. */
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
