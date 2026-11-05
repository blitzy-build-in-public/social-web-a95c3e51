import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Default byte length of a minted secret or token: 43 base64url characters. */
const DEFAULT_RANDOM_BYTES = 32;

/** Safety floor, so no caller can mint an accidentally weak secret. */
const MIN_RANDOM_BYTES = 16;

/**
 * Safety ceiling, so a computed length cannot turn a mint into an allocation: the longest secret
 * anything in the workspace mints is 32 bytes, and 64 already yields 86 base64url characters.
 */
const MAX_RANDOM_BYTES = 64;

/**
 * HMAC-SHA256 of `data` under `key`, as raw bytes.
 *
 * The experiment module derives a variant bucket from the whole digest
 * (`BigInt('0x' + digest.toString('hex')) % 10000n`), so the digest must never be truncated.
 */
export function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** HMAC-SHA256 as 64 lowercase hex characters. */
export function hmacSha256Hex(key: string | Uint8Array, data: string | Uint8Array): string {
  return hmacSha256(key, data).toString('hex');
}

/** SHA-256 as 64 lowercase hex characters. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Canonical lookup form of an email address: trimmed, NFC-normalized and lowercased with the
 * locale-independent `toLowerCase`. Callers validate the address shape before calling.
 */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}

/**
 * `User.emailLookupHash` and `MagicLinkToken.emailLookupHash`: a keyed HMAC of the normalized
 * address under `EMAIL_LOOKUP_PEPPER`, so spelling and spacing variations reach one account.
 */
export function emailLookupHash(pepper: string, email: string): string {
  return hmacSha256Hex(pepper, normalizeEmail(email));
}

/**
 * `AnalyticsEvent.actorHash`: HMAC-SHA256 of the user id under `ANALYTICS_SALT`. Pseudonymous,
 * not anonymous — the hash still reconnects a user's events until erasure strips it.
 */
export function actorHash(salt: string, userId: string): string {
  return hmacSha256Hex(salt, userId);
}

/**
 * `LodgingActivityFact.pairKey`: HMAC-SHA256 of the two user ids under `ANALYTICS_SALT`, in an
 * order fixed here so both parties derive the same key and the leaderboard can count the pair
 * once per 30 days.
 *
 * Pair ids are UUIDv7 and contain no `:`, which keeps the `low:high` encoding injective; a
 * malformed id is rejected rather than allowed to collide with another pair's key.
 */
export function pairKey(salt: string, idA: string, idB: string): string {
  assertUsablePairId(idA);
  assertUsablePairId(idB);
  const low = idA < idB ? idA : idB;
  const high = idA < idB ? idB : idA;
  return hmacSha256Hex(salt, `${low}:${high}`);
}

/**
 * `Venue.secretLookupHash` and `Lodging.secretLookupHash`: unkeyed SHA-256 of a console secret,
 * looked up on every console request. Unkeyed suffices because the secret is 32 random bytes;
 * the secret itself is kept separately as AES-256-GCM ciphertext, since code generation needs it.
 */
export function secretLookupHash(secret: string): string {
  return sha256Hex(secret);
}

/**
 * A fresh console secret: 32 random bytes as 43 base64url characters, shown once at issue. The
 * encoding carries no prefix, so the value matches no credential shape a scanner looks for.
 */
export function randomSecret(bytes: number = DEFAULT_RANDOM_BYTES): string {
  return randomBase64Url(bytes);
}

/**
 * A fresh magic-link or refresh token, encoded like {@link randomSecret}. Only its
 * {@link sha256Hex} digest is stored, so a database leak yields no usable token.
 */
export function randomToken(bytes: number = DEFAULT_RANDOM_BYTES): string {
  return randomBase64Url(bytes);
}

/**
 * Constant-time comparison of two strings, for console secrets and stored token digests.
 *
 * Both inputs are hashed first: `timingSafeEqual` throws on buffers of unequal length, and
 * comparing lengths beforehand would leak the secret's length. The two digests are always 32
 * bytes, so the comparison runs over the same length whatever the inputs.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/** Rejects an id that would make the `low:high` pair encoding ambiguous. */
function assertUsablePairId(id: string): void {
  if (id.length === 0 || id.includes(':')) {
    throw new RangeError('pair ids must be non-empty and must not contain a colon');
  }
}

/**
 * Mints `bytes` random bytes as base64url, refusing a length outside the 16-64 byte range so a
 * computed count fails fast instead of reaching `randomBytes` as an allocation.
 */
function randomBase64Url(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes < MIN_RANDOM_BYTES || bytes > MAX_RANDOM_BYTES) {
    throw new RangeError(
      `random byte length must be an integer between ${MIN_RANDOM_BYTES} and ${MAX_RANDOM_BYTES}`,
    );
  }
  return randomBytes(bytes).toString('base64url');
}
