/**
 * The venue check-in code: derivation, tolerance and verification.
 *
 * A partner venue's console displays a code that rotates every 60 seconds and an attendee submits it with their
 * coordinates. The code is `HOTP(K, floor(t / 60))` truncated to six digits (RFC 4226), where `K` is HKDF-SHA256
 * over the venue's issued secret and `t` is the server clock.
 *
 * The server clock is the only clock: every `at` comes from the injected clock, and no function here accepts a
 * device-supplied instant, so device clock skew of two minutes or more changes what a skewed device displays and
 * nothing else.
 *
 * A leaf module: Node's crypto and the shared constants only. The secret, the derived key and any candidate code
 * stay inside; a thrown error carries no key material and nothing here logs.
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { CODE_DIGITS, CODE_STEP_SECONDS, CODE_TOLERANCE_STEPS } from '@tablemate/shared';

/**
 * HKDF `info` string of the check-in key. It domain-separates the derivation, so the same secret would yield another
 * key for any other purpose. Changing it invalidates every code ever displayed, so it is a constant, never a
 * parameter.
 */
export const CHECKIN_HKDF_INFO = 'tablemate-checkin-v1';

/** Shape of a submitted code, built from {@link CODE_DIGITS} so the two cannot drift apart. */
const CODE_PATTERN = new RegExp(`^\\d{${CODE_DIGITS}}$`);

/**
 * The 32-byte HMAC key of one venue's rotating code: HKDF-SHA256 with an empty salt and
 * {@link CHECKIN_HKDF_INFO}.
 *
 * The input keying material is the UTF-8 bytes of the secret string exactly as issued — the base64url text
 * `randomSecret(32)` produces, not its decoded bytes. The seed and the operator onboarding route store that same
 * string encrypted and `secrets.ts` decrypts it back, so seed, issue and API all derive the identical key; decoding
 * here would break every secret already issued.
 */
export function deriveKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), CHECKIN_HKDF_INFO, 32),
  );
}

/**
 * One HOTP value (RFC 4226): the six-digit truncation of `HMAC-SHA-1(K, counter)`. RFC 4226 specifies HMAC-SHA-1 for
 * the code itself; the HKDF-SHA256 of {@link deriveKey} is only the key derivation and does not replace it.
 *
 * @throws RangeError - When `counter` or `digits` falls outside its domain; the message names the parameter alone,
 *   never the key or a code.
 */
export function hotp(key: Uint8Array, counter: number, digits: number = CODE_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('counter must be a non-negative safe integer');
  }
  // Dynamic truncation reads four bytes from an offset of at most 15, and the truncated
  // 31-bit value is the whole range one code can carry: a width above ten digits could never be
  // filled, so it is refused rather than silently producing a wider code.
  if (!Number.isInteger(digits) || digits < 1 || digits > 10) {
    throw new RangeError('digits must be an integer between 1 and 10');
  }
  const block = Buffer.alloc(8);
  block.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(block).digest();
  const offset = mac.readUInt8(19) & 0x0f;
  const truncated = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 10 ** digits).padStart(digits, '0');
}

/** The step counter of one server instant: `T = floor(t / 60)`, `t` in epoch seconds. */
export function counterAt(at: Date): number {
  return Math.floor(at.getTime() / (CODE_STEP_SECONDS * 1000));
}

/**
 * The code a venue displays at one server instant, and when it stops being current.
 *
 * `GET /venue/check-in-code` answers with exactly this pair, `expiresAt` serialized by `toISOString()`. The boundary
 * is the first millisecond of the next step, because the console polls at `expiresAt` and asks for the next code only
 * once the server has reached the new step.
 */
export function codeFor(secret: string, at: Date): { code: string; expiresAt: Date } {
  const counter = counterAt(at);
  return {
    code: hotp(deriveKey(secret), counter),
    expiresAt: new Date((counter + 1) * CODE_STEP_SECONDS * 1000),
  };
}

/**
 * Whether a submitted code is one a venue displayed within one step of `at`.
 *
 * Accepted counters are `T-1`, `T` and `T+1` ({@link CODE_TOLERANCE_STEPS} either side), which absorbs the round trip
 * between a console showing a code and an attendee submitting it; `T-2` or older, and `T+2` or newer, are refused and
 * the caller answers `422 invalid_code`.
 *
 * Every candidate is compared and none short-circuits — the loop assigns rather than returns — so the time taken does
 * not reveal which step matched, and each comparison is `timingSafeEqual` on two equal-length ASCII digit strings.
 */
export function verifyCode(secret: string, code: string, at: Date): boolean {
  if (!CODE_PATTERN.test(code)) {
    return false;
  }
  const key = deriveKey(secret);
  const submitted = Buffer.from(code, 'utf8');
  const counter = counterAt(at);
  let matched = false;
  for (let step = -CODE_TOLERANCE_STEPS; step <= CODE_TOLERANCE_STEPS; step += 1) {
    const candidateCounter = counter + step;
    if (candidateCounter < 0) {
      continue;
    }
    const candidate = Buffer.from(hotp(key, candidateCounter), 'utf8');
    matched = timingSafeEqual(candidate, submitted) || matched;
  }
  return matched;
}
