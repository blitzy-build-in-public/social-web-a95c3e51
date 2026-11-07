/**
 * The venue check-in code's unit suite (AAP 0.5.7, 0.12.2): the RFC 4226 truncation, the HKDF
 * derivation, the code's own shape and expiry, the one-step tolerance in either direction, and the
 * fact that no device-supplied instant reaches validation.
 *
 * The rule under test is `key = HKDF-SHA256(secret, info "tablemate-checkin-v1")` with counter
 * `T = floor(t / 60)` truncated to six digits, counters `T-1`, `T` and `T+1` accepted and `T-2`
 * refused as `422 invalid_code`. The venue secret is generated here in the shape `issueSecret`
 * produces and is never written down; the only literal keying material is RFC 4226's own Appendix D
 * secret, which is public test data rather than a credential.
 *
 * Every instant comes from integer arithmetic on a step counter, so the suite is reproducible in a
 * plain `vitest` run with no clock control. A caller inside the API passes `request.receivedAt`, set
 * once per request by `plugins/clock.ts` (AAP 0.11.1), which is why the argument these functions take
 * IS the server instant — and why the arity rows below assert no fourth, device-supplied one exists.
 */

import { hkdfSync, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CODE_DIGITS, CODE_STEP_SECONDS, CODE_TOLERANCE_STEPS } from '@tablemate/shared';

import {
  CHECKIN_HKDF_INFO,
  codeFor,
  counterAt,
  deriveKey,
  hotp,
  verifyCode,
} from '../../src/modules/consoles/totp.ts';

/** The derivation's `info` string, spelled out so a change to the constant is caught here. */
const HKDF_INFO = 'tablemate-checkin-v1';

/** Milliseconds in one step, from the shared constant `counterAt` divides by. */
const STEP_MS = CODE_STEP_SECONDS * 1000;

/** A step far enough from zero that its first millisecond is an exact, easily read instant. */
const STEP_COUNT = 29_000_000;

/** The shape every code has, built from `CODE_DIGITS` so it cannot drift from the unit. */
const CODE_PATTERN = new RegExp(`^\\d{${CODE_DIGITS}}$`);

/** RFC 4226 Appendix D's secret: twenty ASCII characters, public test data and not a credential. */
const RFC_SECRET_KEY = Buffer.from('12345678901234567890', 'ascii');

/** A venue secret of the shape `issueSecret` issues: 32 random bytes in base64url. */
function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** The instant `offsetMs` into step `counter`, from integer arithmetic rather than a clock read. */
function stepInstant(counter: number, offsetMs = 0): Date {
  return new Date(counter * STEP_MS + offsetMs);
}

/** The first counter below `limit` whose code needs its leading zero; throws when there is none. */
function firstZeroPaddedCode(key: Uint8Array, limit: number): { counter: number; code: string } {
  for (let counter = 0; counter < limit; counter += 1) {
    const code = hotp(key, counter);
    if (code.startsWith('0')) {
      return { counter, code };
    }
  }
  throw new Error(`no zero-padded code in the first ${limit} counters`);
}

/** RFC 4226 Appendix D: the counter, and the six digits HMAC-SHA-1 truncates it to. */
const RFC_VECTORS: ReadonlyArray<[counter: number, code: string]> = [
  [0, '755224'],
  [1, '287082'],
  [2, '359152'],
  [3, '969429'],
  [4, '338314'],
  [5, '254676'],
  [6, '287922'],
  [7, '162583'],
  [8, '399871'],
  [9, '520489'],
];

/** How the instant reads at each edge of step `STEP_COUNT`: the first and the last millisecond. */
const STEP_EDGE_ROWS: ReadonlyArray<[described: string, offsetMs: number]> = [
  ['the first millisecond', 0],
  ['the last millisecond', STEP_MS - 1],
];

/**
 * The tolerance from `CODE_TOLERANCE_STEPS`: the three steps around the server's are accepted, and
 * the step beyond either edge is not.
 */
const TOLERANCE_ROWS: ReadonlyArray<[offset: number, accepted: boolean]> = [
  [-(CODE_TOLERANCE_STEPS + 1), false], // T-2, answered `422 invalid_code`
  [-CODE_TOLERANCE_STEPS, true],
  [0, true],
  [CODE_TOLERANCE_STEPS, true],
  [CODE_TOLERANCE_STEPS + 1, false], // T+2, the mirror of T-2
];

/** Submissions that are no code at all: how to name each in a failure, and what was typed. */
const MALFORMED_ROWS: ReadonlyArray<[described: string, code: string]> = [
  ['five digits', '12345'],
  ['seven digits', '1234567'],
  ['letters', 'abcdef'],
  ['nothing at all', ''],
];

/** How far a device's clock reads from the server's, in whole steps of 60 seconds. */
const SKEW_ROWS: ReadonlyArray<[described: string, offset: number]> = [
  ['two minutes ahead', 2],
  ['two minutes behind', -2],
];

describe('hotp — the RFC 4226 truncation', () => {
  it.each(RFC_VECTORS)('counter %i truncates to %s', (counter, code) => {
    expect(hotp(RFC_SECRET_KEY, counter)).toBe(code);
  });

  it('carries the counter in all eight bytes, not in the low 32 bits', () => {
    const bigCounter = 2 ** 33 + 5;

    expect(hotp(RFC_SECRET_KEY, bigCounter)).toMatch(CODE_PATTERN);
    // A 32-bit read of the big-endian block would make these two the same code.
    expect(hotp(RFC_SECRET_KEY, bigCounter)).not.toBe(hotp(RFC_SECRET_KEY, bigCounter % 2 ** 32));
  });

  it('refuses a counter it cannot encode', () => {
    expect(() => hotp(RFC_SECRET_KEY, -1)).toThrow(RangeError);
  });
});

describe('deriveKey — HKDF-SHA256 over the issued secret', () => {
  it('derives 32 bytes from the secret text, an empty salt and the check-in info string', () => {
    const secret = newSecret();
    const derived = deriveKey(secret);
    const expected = Buffer.from(
      hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), HKDF_INFO, 32),
    );
    const other = Buffer.from(
      hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), `${HKDF_INFO}-other`, 32),
    );

    expect(CHECKIN_HKDF_INFO).toBe(HKDF_INFO);
    expect(derived).toEqual(expected);
    expect(derived).toHaveLength(32);
    // The info string domain-separates the derivation: a different one gives a different key.
    expect(derived).not.toEqual(other);
  });
});

describe('codeFor — the code a venue displays, and when it expires', () => {
  it.each(STEP_EDGE_ROWS)("%s of a step carries that step's own code", (_described, offsetMs) => {
    const secret = newSecret();
    const at = stepInstant(STEP_COUNT, offsetMs);
    const { code, expiresAt } = codeFor(secret, at);

    expect(counterAt(at)).toBe(STEP_COUNT);
    expect(code).toBe(hotp(deriveKey(secret), STEP_COUNT));
    expect(code).toMatch(CODE_PATTERN);
    // The console polls at this instant, which is the first millisecond of the next step.
    expect(expiresAt.getTime()).toBe((STEP_COUNT + 1) * STEP_MS);
  });

  it('pads a code whose truncation needs it', () => {
    const secret = newSecret();
    const found = firstZeroPaddedCode(deriveKey(secret), 1_000);

    expect(found.code).toHaveLength(CODE_DIGITS);
    expect(found.code.startsWith('0')).toBe(true);
    expect(codeFor(secret, stepInstant(found.counter)).code).toBe(found.code);
  });

  it('gives each venue its own code, and a new one as the step advances', () => {
    const first = newSecret();
    const second = newSecret();
    const steps = [0, 1, 2, 3, 4];
    const codesFor = (secret: string): string[] =>
      steps.map((step) => codeFor(secret, stepInstant(STEP_COUNT + step)).code);

    expect(deriveKey(first)).not.toEqual(deriveKey(second));
    expect(new Set(codesFor(first)).size).toBeGreaterThan(1);
    // Over five steps at least one differs, which ties the code to the secret without the
    // one-in-a-million flake a single comparison of two codes would carry.
    expect(codesFor(first)).not.toEqual(codesFor(second));
  });
});

describe('verifyCode — the one-step tolerance', () => {
  it.each(TOLERANCE_ROWS)(
    'a code %d steps from the server step is accepted: %s',
    (offset, accepted) => {
      const secret = newSecret();
      const at = stepInstant(STEP_COUNT, 1_000);
      const code = hotp(deriveKey(secret), STEP_COUNT + offset);

      expect(verifyCode(secret, code, at)).toBe(accepted);
    },
  );

  it("measures the tolerance from the step edge, not from the code's age", () => {
    const secret = newSecret();
    const key = deriveKey(secret);
    const previous = hotp(key, STEP_COUNT - 1);

    // The last millisecond of step T still accepts step T-1 ...
    expect(verifyCode(secret, previous, stepInstant(STEP_COUNT, STEP_MS - 1))).toBe(true);
    // ... and the first millisecond of T+1 refuses it, because there it is T'-2.
    expect(verifyCode(secret, previous, stepInstant(STEP_COUNT + 1))).toBe(false);
    // A code a console is about to display is accepted at the start of its own step.
    expect(verifyCode(secret, hotp(key, STEP_COUNT + 1), stepInstant(STEP_COUNT))).toBe(true);
  });

  it.each(MALFORMED_ROWS)('refuses %s without throwing', (_described, code) => {
    const secret = newSecret();
    const at = stepInstant(STEP_COUNT, 1_000);

    expect(verifyCode(secret, code, at)).toBe(false);
    expect(() => verifyCode(secret, code, at)).not.toThrow();
  });

  it('refuses the current code with anything surrounding it', () => {
    const secret = newSecret();
    const at = stepInstant(STEP_COUNT, 1_000);
    const code = codeFor(secret, at).code;

    expect(verifyCode(secret, `${code} `, at)).toBe(false);
    expect(verifyCode(secret, ` ${code}`, at)).toBe(false);
    expect(verifyCode(secret, code, at)).toBe(true);
  });
});

describe("no clock but the server's", () => {
  it('takes the secret, the code and the server instant, and nothing else', () => {
    // Callers pass `request.receivedAt` from `plugins/clock.ts`, so the third argument is the
    // server's own instant: a device-supplied one has no parameter to travel in.
    expect(verifyCode.length).toBe(3);
    expect(codeFor.length).toBe(2);
  });

  it.each(SKEW_ROWS)('refuses a code a console %s would display', (_described, offset) => {
    const secret = newSecret();
    const at = stepInstant(STEP_COUNT, 1_000);
    // What a device that derived the code itself from its own skewed clock would submit. The console
    // renders the server's `{ code, expiresAt }` instead (AAP 0.5.7), so device skew moves a
    // countdown and nothing else; `apps/mobile/e2e/playwright/console-clock.spec.ts` covers that
    // browser side.
    const skewed = hotp(deriveKey(secret), counterAt(at) + offset);

    expect(verifyCode(secret, skewed, at)).toBe(false);
  });

  it('is deterministic: the same instant always yields the same code', () => {
    const secret = newSecret();
    const at = stepInstant(STEP_COUNT, 30_000);

    expect(codeFor(secret, at)).toEqual(codeFor(secret, new Date(at.getTime())));
    expect(verifyCode(secret, codeFor(secret, at).code, at)).toBe(true);
  });
});
