/**
 * The off-circuit mirror of the circuit's encodings: byte packing, RSA-limb hashing, city-alias
 * hashing, the registry's two leaves and the nullifier (AAP 0.5.5).
 *
 * Every function must equal its in-circuit counterpart bit for bit, because the registry builder derives each
 * leaf with them and the client derives the value the API keys `SpentNullifier` on: `packBytes` mirrors
 * `CheckedPackBytes(32)` in `circuits/lib/anchor_extract.circom`, `pubkeyHash` mirrors
 * `PoseidonLarge(121, 17)` in `@zk-email/circuits`'s `utils/hash.circom`, and `cityAliasHash`, `cityLeaf`,
 * `issuerLeaf` and `nullifierOf` mirror the `CityAliasHash`, `RegistryMembership` and `Nullifier` templates.
 *
 * Client-safe: it runs under Hermes (React Native 0.76.9) through `../inputs/build-inputs.ts` and in the
 * browser Web Worker, so `poseidon-lite` is its only import: no Node built-in, no global `Buffer`, no
 * platform text or base64 codec, no DOM API, no I/O, and no work at module load beyond declaring constants.
 */
import { poseidon3, poseidon4, poseidon9 } from 'poseidon-lite';

/**
 * The BN254 scalar field modulus `r`, the circuit's field (AAP 0.5.5). Every value a Poseidon input
 * takes must be below it.
 */
export const BN254_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Bits per RSA limb in the circuit's `pubkey` and `signature` chunks — zk-email's `n`. */
export const RSA_LIMB_BITS = 121;

/** The number of RSA limbs — zk-email's `k`. `RSA_LIMB_BITS * RSA_LIMB_COUNT` is 2,057 bits. */
export const RSA_LIMB_COUNT = 17;

/** The width in bytes of every packed anchor, city alias and booking reference (AAP 0.5.5). */
export const PACKED_VALUE_BYTES = 32;

/**
 * The domain tag opening an issuer leaf: `Poseidon(1, issuerId, pubkeyHash, templateHash)`. The tag,
 * together with the leaves' differing arities, keeps an issuer leaf from standing in for a city leaf
 * (AAP 0.5.5).
 */
export const ISSUER_LEAF_TAG = 1n;

/** The domain tag opening a city leaf: `Poseidon(2, cityId, cityAliasHash)`. See {@link ISSUER_LEAF_TAG}. */
export const CITY_LEAF_TAG = 2n;

/** A printed field element: at most the modulus's 78 decimal digits. */
const DECIMAL_FIELD_PATTERN = /^\d{1,78}$/;

/**
 * Narrows a caller-supplied id or hash to a field element. A `number` must be a non-negative safe
 * integer, so `BigInt` of it is exact; a `bigint` must be in `0 .. BN254_SCALAR_FIELD - 1`.
 *
 * @param value - The id or hash to narrow.
 * @param fn - The calling export's name, for the error message.
 * @throws {RangeError} When `value` is not a field integer.
 */
function toFieldInt(value: number | bigint, fn: string): bigint {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return BigInt(value);
    }
  } else if (value >= 0n && value < BN254_SCALAR_FIELD) {
    return value;
  }
  throw new RangeError(`${fn}: not a field integer`);
}

/**
 * The six-bit value of one base64 alphabet character, or -1 when the character is outside the
 * alphabet. Computed from character-code ranges rather than read from a table built at module load.
 */
function base64Sextet(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

/** The sextet of one base64 character, throwing for one outside the alphabet. */
function base64SextetOrThrow(code: number): number {
  const sextet = base64Sextet(code);
  if (sextet < 0) {
    throw new TypeError('base64ToBytes: invalid base64');
  }
  return sextet;
}

/**
 * Encodes a string as UTF-8 bytes, by code point rather than through a platform codec (AAP 0.5.5).
 *
 * Written out because `TextEncoder` is unavailable under Hermes. The byte count must agree with
 * `utf8ByteLength` in `@tablemate/shared`, which validates a template anchor and a city alias at 1-32 bytes:
 * an unpaired surrogate becomes U+FFFD and therefore counts 3 bytes in both.
 *
 * @param s - The string to encode.
 * @returns Its UTF-8 bytes.
 */
export function utf8Encode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    let codePoint = unit;
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Decodes standard base64, padded or unpadded, to bytes (AAP 0.5.5). `DkimKey.modulusBase64` carries
 * the DKIM modulus in this form and the DKIM `b=` and `bh=` tags carry a signature and a body hash in
 * it; callers strip a tag's folding whitespace first, so none of it reaches here.
 *
 * Written out rather than delegated to `atob` or `Buffer`, both unavailable under Hermes; up to two trailing
 * `=` are accepted and, when padding is present, the length must be a multiple of four.
 *
 * @param s - The base64 text.
 * @returns The decoded bytes.
 * @throws {TypeError} When `s` is not valid standard base64.
 */
export function base64ToBytes(s: string): Uint8Array {
  let dataLength = s.length;
  let padding = 0;
  while (dataLength > 0 && s.charCodeAt(dataLength - 1) === 0x3d) {
    padding += 1;
    dataLength -= 1;
  }
  if (padding > 2 || (padding > 0 && s.length % 4 !== 0) || dataLength % 4 === 1) {
    throw new TypeError('base64ToBytes: invalid base64');
  }
  const bytes = new Uint8Array(Math.floor((dataLength * 3) / 4));
  let outIndex = 0;
  for (let i = 0; i < dataLength; i += 4) {
    const remaining = dataLength - i;
    const triple =
      (base64SextetOrThrow(s.charCodeAt(i)) << 18) |
      (remaining > 1 ? base64SextetOrThrow(s.charCodeAt(i + 1)) << 12 : 0) |
      (remaining > 2 ? base64SextetOrThrow(s.charCodeAt(i + 2)) << 6 : 0) |
      (remaining > 3 ? base64SextetOrThrow(s.charCodeAt(i + 3)) : 0);
    bytes[outIndex] = (triple >> 16) & 0xff;
    outIndex += 1;
    if (remaining > 2) {
      bytes[outIndex] = (triple >> 8) & 0xff;
      outIndex += 1;
    }
    if (remaining > 3) {
      bytes[outIndex] = triple & 0xff;
      outIndex += 1;
    }
  }
  return bytes;
}

/**
 * Reads an unsigned big-endian byte string as an integer (AAP 0.5.5); the empty array is 0. Used for
 * the DKIM RSA modulus and signature, which {@link modulusToLimbs} then splits into limbs.
 *
 * @param bytes - The bytes, most significant first.
 */
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * Parses a decimal field element — the form `RegistryFile`'s `root`, `leaves` and leaf hashes and the
 * published `NULLIFIER_SALT` carry (AAP 0.5.5) — and rejects one not below the field modulus.
 *
 * The shared `FieldElement` schema enforces the same digit pattern on the wire; the modulus bound is
 * checked here, because a value at or above `r` is not the element the circuit hashed.
 *
 * @param decimal - The decimal text.
 * @returns The field element.
 * @throws {RangeError} When `decimal` is not a decimal field element below `BN254_SCALAR_FIELD`.
 */
export function parseFieldElement(decimal: string): bigint {
  if (!DECIMAL_FIELD_PATTERN.test(decimal)) {
    throw new RangeError('parseFieldElement: not a field element');
  }
  const value = BigInt(decimal);
  if (value >= BN254_SCALAR_FIELD) {
    throw new RangeError('parseFieldElement: not a field element');
  }
  return value;
}

/**
 * Decodes a DKIM RSA modulus from the base64 `DkimKey.modulusBase64` carries (AAP 0.5.5): standard
 * base64 of the unsigned big-endian modulus with no leading zero byte, as
 * `scripts/make-test-fixtures.ts` and `scripts/fetch-dkim-key.ts` write it. A stray leading zero does
 * not change the value and is tolerated.
 *
 * The modulus must be below `2^2057`, the circuit's `n * k` bound, so {@link modulusToLimbs} can split
 * it into the 17 limbs the circuit hashes.
 *
 * @param modulusBase64 - The base64 modulus.
 * @returns The modulus.
 * @throws {TypeError} When `modulusBase64` is not valid base64.
 * @throws {RangeError} When the decoded value is zero or at or above 2^2057.
 */
export function modulusFromBase64(modulusBase64: string): bigint {
  const value = bytesToBigIntBE(base64ToBytes(modulusBase64));
  if (value === 0n) {
    throw new RangeError('modulusFromBase64: empty modulus');
  }
  if (value >= 1n << BigInt(RSA_LIMB_BITS * RSA_LIMB_COUNT)) {
    throw new RangeError('modulusFromBase64: modulus exceeds 2057 bits');
  }
  return value;
}

/**
 * Splits an unsigned integer into little-endian limbs of `n` bits, most significant limb last — the
 * `pubkey[k]` and `signature[k]` chunking `EmailVerifier` takes at `n = 121`, `k = 17`, the same split
 * as zk-email's `toCircomBigIntBytes` (AAP 0.5.5).
 *
 * @param value - The integer to split.
 * @param n - Bits per limb; 121 for the RSA limbs.
 * @param k - The number of limbs; 17 for the RSA limbs.
 * @returns `k` limbs, limb 0 least significant.
 * @throws {RangeError} When `n` or `k` is not a positive safe integer whose product is exact, or when
 *   `value` is negative or at or above `2^(n * k)`.
 */
export function modulusToLimbs(value: bigint, n = RSA_LIMB_BITS, k = RSA_LIMB_COUNT): bigint[] {
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(k) ||
    n <= 0 ||
    k <= 0 ||
    !Number.isSafeInteger(n * k)
  ) {
    throw new RangeError('modulusToLimbs: invalid limb parameters');
  }
  if (value < 0n || value >= 1n << BigInt(n * k)) {
    throw new RangeError('modulusToLimbs: value out of range');
  }
  const mask = (1n << BigInt(n)) - 1n;
  const limbs: bigint[] = [];
  let remaining = value;
  for (let i = 0; i < k; i += 1) {
    limbs.push(remaining & mask);
    remaining >>= BigInt(n);
  }
  return limbs;
}

/**
 * The `pubkeyHash` of the issuer leaf and of `EmailVerifier`: `PoseidonLarge(121, 17)` in
 * `@zk-email/circuits` 6.3.4's `utils/hash.circom`, over the RSA modulus's limbs.
 *
 * A circomlib `Poseidon` instance takes at most 16 inputs, so the installed template merges consecutive limb
 * pairs — `in[2i] + 2^121 * in[2i + 1]` — into the 9 hashed inputs `ceil(17 / 2)`, letting the odd last chunk
 * stand alone; each merged input stays below 2^242, inside the field. The circuit hashes the very modulus its
 * RSA check consumed, so the leaf commits to the key that verified the signature.
 *
 * @param modulus - The DKIM RSA modulus, as {@link modulusFromBase64} decodes it.
 * @returns The limb hash.
 * @throws {RangeError} When `modulus` is not a 17-limb value.
 */
export function pubkeyHash(modulus: bigint): bigint {
  const limbs = modulusToLimbs(modulus, RSA_LIMB_BITS, RSA_LIMB_COUNT);
  const merged: bigint[] = [];
  const pairs = RSA_LIMB_COUNT >> 1;
  for (let i = 0; i < pairs; i += 1) {
    merged.push((limbs[2 * i] ?? 0n) + ((limbs[2 * i + 1] ?? 0n) << BigInt(RSA_LIMB_BITS)));
  }
  merged.push(limbs[RSA_LIMB_COUNT - 1] ?? 0n);
  return poseidon9(merged);
}

/**
 * Packs up to 32 bytes into the two field elements every anchor, city alias and booking reference is
 * hashed as: `[out[0], out[1]]` of `CheckedPackBytes(32)` in `circuits/lib/anchor_extract.circom`,
 * which is zk-email's `PackBytes(32)` plus the per-byte 0-255 range check (AAP 0.5.5, "Packing").
 *
 * `out[0]` holds bytes 0-30 little-endian, so byte 0 is the least significant, and `out[1]` holds byte 31
 * alone; bytes past the input's length count as 0, the zero padding the circuit applies. With every byte in
 * 0-255, `out[0]` stays below 2^248, inside the field, and no byte can carry weight out of `out[1]`, so the
 * encoding is injective for a given length — which is why a packed value is always hashed together with its
 * length (see {@link cityAliasHash} and {@link nullifierOf}).
 *
 * @param bytes - The bytes to pack, at most 32.
 * @returns The two packed field elements, `out[0]` first.
 * @throws {RangeError} When `bytes` is longer than 32.
 */
export function packBytes(bytes: Uint8Array): readonly [bigint, bigint] {
  if (bytes.length > PACKED_VALUE_BYTES) {
    throw new RangeError('packBytes: more than 32 bytes');
  }
  let low = 0n;
  for (let i = PACKED_VALUE_BYTES - 2; i >= 0; i -= 1) {
    low = (low << 8n) | BigInt(bytes[i] ?? 0);
  }
  return [low, BigInt(bytes[PACKED_VALUE_BYTES - 1] ?? 0)];
}

/**
 * The `cityAliasHash` of the city leaf: `Poseidon(cityLength, pack[0], pack[1])`, the `CityAliasHash`
 * template of `circuits/lib/registry_membership.circom` off the circuit (AAP 0.5.5).
 *
 * The bytes are the alias exactly as the decoded body carried it, quoted-printable escapes included, so
 * callers pass `utf8Encode(alias)` from `config/cities.json` or the bytes `FieldExtract` returned. The length
 * is hashed with the bytes because they are zero-padded: two aliases differing only in length and the fill
 * after them would otherwise hash alike, and that fill is not signed text.
 *
 * @param aliasBytes - The alias's bytes, 1-32 of them.
 * @returns The alias hash.
 * @throws {RangeError} When `aliasBytes` is empty or longer than 32 bytes.
 */
export function cityAliasHash(aliasBytes: Uint8Array): bigint {
  if (aliasBytes.length < 1 || aliasBytes.length > PACKED_VALUE_BYTES) {
    throw new RangeError('cityAliasHash: alias must be 1–32 bytes');
  }
  const [low, high] = packBytes(aliasBytes);
  return poseidon3([BigInt(aliasBytes.length), low, high]);
}

/**
 * The city leaf `Poseidon(2, cityId, cityAliasHash)`, the second leaf `RegistryMembership` proves
 * membership of (AAP 0.5.5). The leading domain tag, with the leaf's arity, keeps an issuer leaf from
 * standing in for a city leaf.
 *
 * @param cityId - The city's `circuitCityId`, the circuit's public `cityId`.
 * @param aliasHash - The alias hash from {@link cityAliasHash}.
 * @returns The leaf value.
 * @throws {RangeError} When either argument is not a field integer.
 */
export function cityLeaf(cityId: number | bigint, aliasHash: bigint): bigint {
  return poseidon3([
    CITY_LEAF_TAG,
    toFieldInt(cityId, 'cityLeaf'),
    toFieldInt(aliasHash, 'cityLeaf'),
  ]);
}

/**
 * The issuer leaf `Poseidon(1, issuerId, pubkeyHash, templateHash)`, the first leaf
 * `RegistryMembership` proves membership of (AAP 0.5.5): the key that verified the signature with the
 * template that read the stay, both hashed as the circuit hashed them.
 *
 * @param issuerId - The issuer's id, the circuit's public `issuerId`.
 * @param keyHash - The key's limb hash from {@link pubkeyHash}.
 * @param templateHashValue - The extraction template's hash from `./template-hash.ts`.
 * @returns The leaf value.
 * @throws {RangeError} When any argument is not a field integer.
 */
export function issuerLeaf(
  issuerId: number | bigint,
  keyHash: bigint,
  templateHashValue: bigint,
): bigint {
  return poseidon4([
    ISSUER_LEAF_TAG,
    toFieldInt(issuerId, 'issuerLeaf'),
    toFieldInt(keyHash, 'issuerLeaf'),
    toFieldInt(templateHashValue, 'issuerLeaf'),
  ]);
}

/**
 * The `nullifier` public signal: `Poseidon(refLength, pack[0], pack[1], salt)`, the `Nullifier` template
 * of `circuits/lib/nullifier.circom` off the circuit (AAP 0.5.5).
 *
 * The value must equal the circuit's output for the same canonical booking reference and the published
 * `NULLIFIER_SALT`, because the API keys `SpentNullifier` on it: hashing the length with the zero-padded bytes
 * is what makes one booking yield exactly one nullifier, however the reference is laid out in the email
 * (AAP 0.12.2).
 *
 * @param referenceBytes - The canonical booking reference, 1-32 bytes.
 * @param salt - The published nullifier salt, as a decimal string or a field element.
 * @returns The nullifier.
 * @throws {RangeError} When `referenceBytes` is empty or longer than 32 bytes, or the salt is not a
 *   field element.
 */
export function nullifierOf(referenceBytes: Uint8Array, salt: bigint | string): bigint {
  if (referenceBytes.length < 1 || referenceBytes.length > PACKED_VALUE_BYTES) {
    throw new RangeError('nullifierOf: reference must be 1–32 bytes');
  }
  const [low, high] = packBytes(referenceBytes);
  const salted =
    typeof salt === 'string' ? parseFieldElement(salt) : toFieldInt(salt, 'nullifierOf');
  return poseidon4([BigInt(referenceBytes.length), low, high, salted]);
}
