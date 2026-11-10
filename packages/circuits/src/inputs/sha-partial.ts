/*
 * SHA-256 padding and the partial-SHA precompute state the circuit's in-circuit `EmailVerifier` starts the body
 * window from (AAP 0.5.5). Ported from @zk-email/helpers 6.4.2 — `src/sha-utils.ts` and `src/lib/fast-sha256.ts`
 * of zkemail/zk-email-verify — so the state produced here is byte for byte the state `EmailVerifier` consumes as
 * `precomputedSHA[32]` and equal to what the helpers produce. Both upstream notices follow.
 *
 * MIT License
 * Copyright (c) 2023 zk-email
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * SHA-256 (+ HMAC and PBKDF2) for JavaScript.
 * Written in 2014-2016 by Dmitry Chestnykh.
 * Public domain, no warranty.
 * Client-safe: it imports nothing and uses no Node built-in, no global `Buffer`, no `TextEncoder`, no DOM API and
 * no I/O.
 */

/** The 64 round constants of FIPS 180-4 §4.2.2, as the helpers' `fast-sha256.ts` declares them. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The eight initial hash words of FIPS 180-4 §5.3.3. */
const IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * The 64-word message schedule, reused across every block and every call. Safe as module state because JavaScript is
 * single-threaded and {@link compress} never re-enters itself; it keeps the compression loop allocation-free, which is
 * what the Hermes path needs.
 */
const W = new Uint32Array(64);

/**
 * Compresses `blocks` 64-byte blocks of `data` from `offset` into `state` in place: the schedule expansion and the 64
 * rounds of FIPS 180-4 §6.2.2, ported from the helpers' `hashBlocks`. Every sum is exact in a double — at most five
 * 32-bit terms — and is truncated to 32 bits by `| 0` or `>>> 0`, which is why no `BigInt` appears on the hashing path.
 */
function compress(state: Uint32Array, data: Uint8Array, offset: number, blocks: number): void {
  for (let block = 0; block < blocks; block += 1) {
    const base = offset + block * 64;
    for (let t = 0; t < 16; t += 1) {
      const at = base + t * 4;
      W[t] =
        (((data[at] ?? 0) << 24) |
          ((data[at + 1] ?? 0) << 16) |
          ((data[at + 2] ?? 0) << 8) |
          (data[at + 3] ?? 0)) >>>
        0;
    }
    for (let t = 16; t < 64; t += 1) {
      const w2 = W[t - 2] ?? 0;
      const w15 = W[t - 15] ?? 0;
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      W[t] = ((W[t - 7] ?? 0) + s1 + ((W[t - 16] ?? 0) + s0)) >>> 0;
    }
    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let t = 0; t < 64; t += 1) {
      const sum1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + (K[t] ?? 0) + (W[t] ?? 0)) | 0;
      const sum0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }
}

/**
 * Packs the eight state words into 32 big-endian bytes: the layout the helpers' `cacheState()` emits and the circuit
 * consumes as `precomputedSHA[32]`, and the digest layout too, so the state left after the final padded block
 * re-encoded here is the SHA-256 digest.
 */
function stateToBytes(state: Uint32Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    const word = state[i] ?? 0;
    const at = i * 4;
    out[at] = (word >>> 24) & 0xff;
    out[at + 1] = (word >>> 16) & 0xff;
    out[at + 2] = (word >>> 8) & 0xff;
    out[at + 3] = word & 0xff;
  }
  return out;
}

/**
 * The initial state as the 32 big-endian bytes `circuits/lib/body_window.circom` requires `precomputedSHA` to equal
 * when the precompute prefix is empty. Derived from {@link IV} above so the two spellings cannot drift apart.
 */
export const SHA256_IV: Uint8Array = stateToBytes(IV);

/**
 * Pads `message` to a whole number of SHA-256 blocks: a `0x80` byte, zeros up to 56 mod 64 bytes, then the message's
 * bit length over eight big-endian bytes (FIPS 180-4 §5.1.1). Mirrors the helpers' `sha256Pad(message, maxShaBytes)`.
 *
 * @throws {RangeError} When `maxLength` is not a non-negative multiple of 64, or when the padded message does not fit
 *   in it — the latter is what `build-inputs.ts` maps to `header_too_long` for the header.
 */
export function sha256Pad(
  message: Uint8Array,
  maxLength: number,
): { padded: Uint8Array; paddedLength: number } {
  if (!Number.isInteger(maxLength) || maxLength < 0 || maxLength % 64 !== 0) {
    throw new RangeError('sha256Pad: maxLength is not a non-negative integer multiple of 64');
  }
  const paddedLength = 64 * Math.ceil((message.length + 9) / 64);
  if (paddedLength > maxLength) {
    throw new RangeError('sha256Pad: padded length exceeds maxLength');
  }
  const padded = new Uint8Array(maxLength);
  padded.set(message, 0);
  padded[message.length] = 0x80;
  // The bit length as two big-endian words: len * 8 = hi * 2^32 + lo, exact because every length here is far below
  // 2^53.
  const hi = Math.floor(message.length / 2 ** 29);
  const lo = (message.length * 8) >>> 0;
  const at = paddedLength - 8;
  padded[at] = (hi >>> 24) & 0xff;
  padded[at + 1] = (hi >>> 16) & 0xff;
  padded[at + 2] = (hi >>> 8) & 0xff;
  padded[at + 3] = hi & 0xff;
  padded[at + 4] = (lo >>> 24) & 0xff;
  padded[at + 5] = (lo >>> 16) & 0xff;
  padded[at + 6] = (lo >>> 8) & 0xff;
  padded[at + 7] = lo & 0xff;
  return { padded, paddedLength };
}

/**
 * The SHA-256 state after compressing `prefix` to its last block boundary: the helpers' `partialSha(msg, msgLen)`,
 * which is `new Hash().update(msg, msgLen).cacheState()`. Nothing is finalized, so the result is the state the
 * remaining blocks continue from.
 *
 * @throws {RangeError} When `prefix.length` is not a multiple of 64, because a partial block would leave the state the
 *   rest of the message could not continue from.
 */
export function partialSha(prefix: Uint8Array): Uint8Array {
  if (prefix.length % 64 !== 0) {
    throw new RangeError('partialSha: prefix length is not a multiple of 64 bytes');
  }
  const state = new Uint32Array(IV);
  compress(state, prefix, 0, prefix.length / 64);
  return stateToBytes(state);
}

/**
 * Splits a padded message into the state up to `cut` and the remaining bytes the in-circuit verifier hashes: the
 * helpers' `generatePartialSHA`, with the cut passed in instead of derived from a selector string. `build-inputs.ts`
 * supplies `cut = max(0, paddedLength - 960)`, so the window the circuit proves over is the whole padded body when it
 * fits and the trailing 960 bytes otherwise, exactly as `circuits/lib/body_window.circom` constrains it.
 *
 * @returns The state after the prefix, the window of `maxRemaining` bytes, and the window's real length. The helpers
 *   copy the whole `padded.slice(cut)` and zero-pad it to the bound; the first `maxRemaining` bytes of that copy are
 *   the ones returned here, which is what the oracle comparison in `test/inputs.test.ts` reads.
 * @throws {RangeError} When `maxRemaining` is not a non-negative multiple of 64, when `paddedLength` is not a 64-byte
 *   multiple inside `padded`, when `cut` is not a 64-byte boundary of the padded message, or when the remaining bytes
 *   do not fit in `maxRemaining`.
 */
export function generatePartialSha(
  padded: Uint8Array,
  paddedLength: number,
  cut: number,
  maxRemaining = 1024,
): { precomputedSha: Uint8Array; bodyRemaining: Uint8Array; bodyRemainingLength: number } {
  if (!Number.isInteger(maxRemaining) || maxRemaining < 0 || maxRemaining % 64 !== 0) {
    throw new RangeError(
      'generatePartialSha: maxRemaining is not a non-negative integer multiple of 64',
    );
  }
  if (!Number.isInteger(paddedLength) || paddedLength % 64 !== 0 || paddedLength > padded.length) {
    throw new RangeError('generatePartialSha: paddedLength is not a 64-byte multiple of padded');
  }
  if (!Number.isInteger(cut) || cut % 64 !== 0 || cut < 0 || cut > paddedLength) {
    throw new RangeError('generatePartialSha: cut is not a 64-byte boundary of the padded message');
  }
  const bodyRemainingLength = paddedLength - cut;
  if (bodyRemainingLength > maxRemaining) {
    throw new RangeError('generatePartialSha: bodyRemainingLength exceeds maxRemaining');
  }
  const precomputedSha = partialSha(padded.subarray(0, cut));
  const bodyRemaining = new Uint8Array(maxRemaining);
  bodyRemaining.set(padded.subarray(cut, paddedLength), 0);
  return { precomputedSha, bodyRemaining, bodyRemainingLength };
}
