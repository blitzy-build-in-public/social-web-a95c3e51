import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const DEFAULT_RANDOM_BYTES = 32;
const MIN_RANDOM_BYTES = 16;
const MAX_RANDOM_BYTES = 64;
/** HMAC-SHA256 of `data` under `key`, as raw bytes. */
export function hmac(key: string | Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}
/** HMAC-SHA256 as 64 lowercase hex characters. */
export function hmacHex(key: string | Uint8Array, data: string | Uint8Array): string {
  return hmac(key, data).toString('hex');
}
/** SHA-256 as 64 lowercase hex characters. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
/** Canonical lookup form of an email address: trimmed, NFC-normalized and lowercased with the locale-independent `toLowerCase`. */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}
/** `User.emailLookupHash` and `MagicLinkToken.emailLookupHash`: a keyed HMAC of the normalized address under `EMAIL_LOOKUP_PEPPER`, so spelling and spacing variations reach one account. */
export function emailLookupHash(pepper: string, email: string): string {
  return hmacHex(pepper, normalizeEmail(email));
}
/** `AnalyticsEvent.actorHash`: HMAC-SHA256 of the user id under `ANALYTICS_SALT`. */
export function actorHash(salt: string, userId: string): string {
  return hmacHex(salt, userId);
}
/** `LodgingActivityFact.pairKey`: HMAC-SHA256 of the two user ids under `ANALYTICS_SALT`, in an order fixed here so both parties derive the same key and the leaderboard can count the pair once per 30 days. */
export function pairKey(salt: string, idA: string, idB: string): string {
  assertUsablePairId(idA);
  assertUsablePairId(idB);
  const low = idA < idB ? idA : idB;
  const high = idA < idB ? idB : idA;
  return hmacHex(salt, `${low}:${high}`);
}
/** `Venue.secretLookupHash` and `Lodging.secretLookupHash`: unkeyed SHA-256 of a console secret, looked up on every console request. */
export function secretLookupHash(secret: string): string {
  return sha256Hex(secret);
}
/** A fresh console secret: 32 random bytes as 43 base64url characters, shown once at issue. */
export function randomSecret(bytes: number = DEFAULT_RANDOM_BYTES): string {
  return randomBase64Url(bytes);
}
/** A fresh magic-link or refresh token, encoded like {@link randomSecret}. */
export function randomToken(bytes: number = DEFAULT_RANDOM_BYTES): string {
  return randomBase64Url(bytes);
}
/** Constant-time comparison of two strings, for console secrets and stored token digests. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
function assertUsablePairId(id: string): void {
  if (id.length === 0 || id.includes(':')) {
    throw new RangeError('pair ids must be non-empty and must not contain a colon');
  }
}
function randomBase64Url(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes < MIN_RANDOM_BYTES || bytes > MAX_RANDOM_BYTES) {
    throw new RangeError(
      `random byte length must be an integer between ${MIN_RANDOM_BYTES} and ${MAX_RANDOM_BYTES}`,
    );
  }
  return randomBytes(bytes).toString('base64url');
}
