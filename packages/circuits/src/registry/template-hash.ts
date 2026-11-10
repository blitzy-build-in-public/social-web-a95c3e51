/**
 * The extraction parameters an issuer template hands the circuit, and the Poseidon hash that binds a proof to that
 * template (AAP 0.5.5). Off-circuit mirror of `circuits/lib/template_hash.circom`, and the value an issuer's
 * `Poseidon(1, issuerId, pubkeyHash, templateHash)` leaf commits to: both must produce the identical value, because a
 * template differing from the registered one in any anchor byte, anchor length, terminator, charset code or
 * date-format code hashes to a value the registry holds no leaf for, so no proof can name that issuer.
 *
 * An anchor is the literal text preceding a value in the decoded body window, which `FieldExtract` in
 * `circuits/lib/anchor_extract.circom` matches: 1-32 non-zero bytes, zero-padded to 32 here because the fill after an
 * anchor is not signed text. Client-safe: Hermes and the browser Web Worker run it too.
 */
import type { IssuerTemplate } from '@tablemate/shared';

import { CHARSET_CODE, DATE_FORMAT_CODE } from '@tablemate/shared';
import { poseidon13, poseidon2, poseidon8 } from 'poseidon-lite';

import { PACKED_VALUE_BYTES, packBytes, utf8Encode } from './leaves.ts';

/**
 * The field order of every `[4]` array the circuit takes and of every array in {@link TemplateParams}: city at 0,
 * arrival at 1, departure at 2, booking reference at 3 (AAP 0.5.5). Nothing redeclares it, because the circuit's
 * `anchors[4][32]`, the `FieldExtract` instances wired to it and the extraction are all positional.
 */
export const TEMPLATE_FIELD_ORDER = ['city', 'arrival', 'departure', 'reference'] as const;

/** One stay field of {@link TEMPLATE_FIELD_ORDER}, and a key of `IssuerTemplate['fields']`. */
export type TemplateFieldName = (typeof TEMPLATE_FIELD_ORDER)[number];

/** The number of stay fields, and so the length of every `[4]` circuit array. */
const TEMPLATE_FIELD_COUNT = TEMPLATE_FIELD_ORDER.length;

/**
 * An issuer template as the circuit takes it: the shape `../inputs/build-inputs.ts` emits as the `anchors[4][32]`,
 * `anchorLength[4]`, `terminator[4]`, `charset[4]` and `dateFormat` signals, and the shape {@link templateHash}
 * hashes. Every array holds exactly {@link TEMPLATE_FIELD_COUNT} entries in {@link TEMPLATE_FIELD_ORDER};
 * {@link templateParams} produces a well-formed value, while one built by hand is structurally checked only, so
 * parameters differing from an issuer's registered ones can still be hashed and compared.
 */
export interface TemplateParams {
  /**
   * The four anchors in field order, each zero-padded to {@link PACKED_VALUE_BYTES} (32) bytes: the circuit input
   * `anchors[4][32]`, whose bytes `FieldExtract` requires to be non-zero inside the anchor's length and zero after it.
   */
  readonly anchors: readonly Uint8Array[];
  /** The anchors' lengths in bytes, 1-32: the circuit input `anchorLength[4]`. */
  readonly anchorLength: readonly number[];
  /** The byte ending each field's value: the circuit input `terminator[4]`. */
  readonly terminator: readonly number[];
  /** Each field's charset code from `CHARSET_CODE`: the circuit input `charset[4]`. */
  readonly charset: readonly number[];
  /** The date layout code from `DATE_FORMAT_CODE`, shared by both dates: the circuit input `dateFormat`. */
  readonly dateFormat: number;
}

/**
 * Validates a configured issuer template and converts it to the parameters the circuit takes, so a malformed
 * configuration fails on the registry build and on the client rather than in witness generation. An anchor is 1-32
 * UTF-8 bytes none of which is `0x00`, which zk-email's substring matcher would read as a wildcard; a terminator is
 * 1-255, because a zero would let a value run through the `0x00` after the body's SHA-256 padding into the length
 * field; and a charset and a date format must be names of the coded sets whose values `TemplateHash` pins to 1-4, since
 * anything outside them needs a circuit revision rather than a configuration edit. Anchors are matched against the
 * soft-line-break-decoded body window, which still carries quoted-printable escapes, so an anchor containing one is
 * written literally in configuration.
 *
 * @throws {RangeError} When an anchor is empty or longer than 32 bytes, contains a zero byte, the terminator is not
 *   1-255, or a charset or date format is not a name of its coded set.
 */
export function templateParams(template: IssuerTemplate): TemplateParams {
  const anchors: Uint8Array[] = [];
  const anchorLength: number[] = [];
  const terminator: number[] = [];
  const charset: number[] = [];
  for (const name of TEMPLATE_FIELD_ORDER) {
    const field = template.fields[name];
    const bytes = utf8Encode(field.anchor);
    if (bytes.length < 1 || bytes.length > PACKED_VALUE_BYTES) {
      throw new RangeError('templateParams: anchor must be 1–32 bytes');
    }
    if (bytes.includes(0)) {
      throw new RangeError('templateParams: anchor contains a zero byte');
    }
    if (!Number.isInteger(field.terminator) || field.terminator < 1 || field.terminator > 255) {
      throw new RangeError('templateParams: terminator must be 1–255');
    }
    const charsetCode = charsetCodeOf(field.charset);
    if (charsetCode === undefined) {
      throw new RangeError('templateParams: unknown charset');
    }
    const padded = new Uint8Array(PACKED_VALUE_BYTES);
    padded.set(bytes);
    anchors.push(padded);
    anchorLength.push(bytes.length);
    terminator.push(field.terminator);
    charset.push(charsetCode);
  }
  const dateFormat = dateFormatCodeOf(template.dateFormat);
  if (dateFormat === undefined) {
    throw new RangeError('templateParams: unknown date format');
  }
  return { anchors, anchorLength, terminator, charset, dateFormat };
}

/**
 * The `templateHash` of an issuer leaf, `Poseidon(1, issuerId, pubkeyHash, templateHash)`: the hash of the extraction
 * parameters a proof actually used, equal to `TemplateHash` in `circuits/lib/template_hash.circom`, and the value
 * `../inputs/build-inputs.ts` compares with the registry entry it proves against (AAP 0.5.5).
 *
 * Two nesting levels, because circomlib's `Poseidon` admits at most 16 inputs: `Poseidon(8)` over the four anchors
 * packed by {@link packBytes} in field order, `Poseidon(13)` over the lengths, terminators, charset codes and date
 * format, and `Poseidon(2)` over those two.
 * @throws {RangeError} When the input is an `IssuerTemplate` breaking a rule of {@link templateParams}, or a
 *   `TemplateParams` that is not four 32-byte anchors with four lengths, four terminators, four charset codes and a
 *   date format, all non-negative safe integers.
 */
export function templateHash(template: IssuerTemplate | TemplateParams): bigint {
  const params = 'fields' in template ? templateParams(template) : template;
  assertTemplateParams(params);
  const packedAnchors: bigint[] = [];
  for (const anchor of params.anchors) {
    const [low, high] = packBytes(anchor);
    packedAnchors.push(low, high);
  }
  const anchorsHash = poseidon8(packedAnchors);
  const paramsHash = poseidon13([
    ...params.anchorLength.map((length) => BigInt(length)),
    ...params.terminator.map((byte) => BigInt(byte)),
    ...params.charset.map((code) => BigInt(code)),
    BigInt(params.dateFormat),
  ]);
  return poseidon2([anchorsHash, paramsHash]);
}

/**
 * Structure only, so {@link templateHash} can hash the deliberately altered parameters of the adversarial
 * "Templates" cases (AAP 0.5.5) while still refusing a shape the circuit's arrays would reject. Values are checked to
 * be non-negative safe integers, not to be in range, so a length of 33 or a charset code of 5 hashes — and that hash
 * rightly has no leaf.
 *
 * @throws {RangeError} When an array is not four entries long, an anchor is not 32 bytes, or a number is not a
 *   non-negative safe integer.
 */
function assertTemplateParams(params: TemplateParams): void {
  // The three arrays whose length and integer range are checked, beyond the anchors.
  const groups = [params.anchorLength, params.terminator, params.charset];
  const wellFormed = (group: readonly number[]): boolean =>
    group.length === TEMPLATE_FIELD_COUNT &&
    group.every((value) => Number.isSafeInteger(value) && value >= 0);
  if (
    params.anchors.length !== TEMPLATE_FIELD_COUNT ||
    params.anchors.some((anchor) => anchor.length !== PACKED_VALUE_BYTES) ||
    !groups.every(wellFormed) ||
    !Number.isSafeInteger(params.dateFormat) ||
    params.dateFormat < 0
  ) {
    throw new RangeError('templateHash: malformed template parameters');
  }
}

/**
 * The code `CHARSET_CODE` gives a charset name, or `undefined` for a name outside its vocabulary. The lookup is
 * widened to a string key because unvalidated configuration reaches this module too.
 */
function charsetCodeOf(name: string): number | undefined {
  return (CHARSET_CODE as Readonly<Record<string, number | undefined>>)[name];
}

/** The code `DATE_FORMAT_CODE` gives a date format name, or `undefined` for one outside its vocabulary. */
function dateFormatCodeOf(name: string): number | undefined {
  return (DATE_FORMAT_CODE as Readonly<Record<string, number | undefined>>)[name];
}
