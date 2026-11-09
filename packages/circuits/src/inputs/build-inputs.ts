/**
 * The `.eml` → `TablemateItinerary` witness-input generator: the device side of the itinerary proof
 * (AAP 0.5.1, AAP 0.5.5).
 *
 * {@link buildCircuitInputs} is what `apps/mobile` calls with the published ZK configuration in place of a
 * DNS lookup: the DKIM key is selected from the registry by the signature's own `d=` and `s=`. The email never
 * leaves the device, and only `{ proof, publicSignals }` is sent to the API (AAP 0.12.2).
 *
 * {@link buildEmailVerifierInputs} builds the EmailVerifier half of the witness the way `@zk-email/helpers`
 * 6.4.2 does with `maxHeadersLength` 1,024, `maxBodyLength` 960 and soft line breaks removed, cutting the
 * SHA-256 precompute at the window's start; `test/inputs.test.ts` compares the two against that oracle.
 *
 * Client-safe: it runs under Hermes (React Native 0.76.9), in the browser Web Worker and in Node tests, so it
 * imports `./`, `../registry/` and the shared contract types and nothing else — no Node built-in, no global
 * `Buffer`, no `TextEncoder`/`TextDecoder`, no `atob`, no DOM API, no randomness, no I/O and no logging.
 *
 * Privacy: every refusal is a {@link CircuitInputError} carrying a code and, for a stay field, that field's
 * template slot name. No error, return value or intermediate here carries email bytes, header text, a field
 * value, the guest name or the booking reference.
 */
import type { DkimKey, IssuerConfig, RegistryFile } from '@tablemate/shared';

import {
  RSA_LIMB_COUNT,
  bytesToBigIntBE,
  cityAliasHash,
  cityLeaf,
  issuerLeaf,
  modulusFromBase64,
  modulusToLimbs,
  parseFieldElement,
  pubkeyHash,
  utf8Encode,
} from '../registry/leaves.ts';
import { REGISTRY_DEPTH, buildMerkleTree } from '../registry/merkle.ts';
import { TEMPLATE_FIELD_ORDER, templateHash, templateParams } from '../registry/template-hash.ts';
import type { TemplateParams } from '../registry/template-hash.ts';
import { canonicalSignedHeader, canonicalizeBody, verifyBodyHash } from './dkim-canonicalize.ts';
import { CircuitInputError, bytesEqual, bytesToLatin1, fail, parseEml } from './eml-parse.ts';
import type { DkimSignature, ParsedEml } from './eml-parse.ts';
import { generatePartialSha, sha256Pad } from './sha-partial.ts';
import { locateFields, parseDateValue, removeSoftLineBreaks } from './template-locate.ts';
import type { FieldLocation } from './template-locate.ts';

/** The circuit's `maxHeadersLength`: the canonical signed header's bound in bytes. */
export const MAX_HEADER_LENGTH = 1024;

/**
 * The circuit's `maxBodyLength`: the padded body window's bound in bytes. `EmailVerifier` range-checks
 * a body length with `Num2Bits(log2Ceil(maxBodyLength))`, which is what makes {@link MAX_BODY_WINDOW}
 * the longest window the circuit can prove.
 */
export const MAX_BODY_LENGTH = 1024;

/**
 * The longest body window the circuit can prove: 960 bytes, the largest multiple of 64 below
 * {@link MAX_BODY_LENGTH}. `EmailVerifier` range-checks `emailBodyLength` with
 * `Num2Bits(log2Ceil(1024))`, so a 1,024-byte window cannot be proved, and this generator never emits
 * one.
 */
export const MAX_BODY_WINDOW = 960;

/** The CR and LF bytes of the CRLF ending every canonicalized header line. */
const CR = 13;
const LF = 10;

/** The width in bytes of one packed anchor: `anchors[4][32]`'s inner bound. */
const ANCHOR_BYTES = 32;

/** The width of a SHA-256 digest, the only `bh=` the circuit's body check can match. */
const SHA256_BYTES = 32;

/** That digest in base64: `ceil(32 / 3) * 4`. */
const BODY_HASH_BASE64_LENGTH = 44;

/** The slots of the stay fields among the four {@link locateFields} returns, in `TEMPLATE_FIELD_ORDER`. */
const CITY_FIELD = 0;
const ARRIVAL_FIELD = 1;
const DEPARTURE_FIELD = 2;

/**
 * The matcher the circuit's `BodyHashRegex` implies, read against the signature line alone: zk-regex 2.3.x's
 * `(\r\n|^)dkim-signature:([a-z]+=[^;]+; )+bh=[a-zA-Z0-9+/=]+;`, which `@zk-email/circuits` 6.3.4 uses to
 * reveal the `bh=` value. It is anchored at the line's start and case-sensitive, so it refuses a `c=simple`
 * header canonicalization (whose field name is not lowercased), a folded `bh=` and every other tag separator —
 * none of which the circuit could reveal. Checking it here reports one code instead of failing later inside
 * witness generation.
 */
const BODY_HASH_PATTERN = /^dkim-signature:([a-z]+=[^;]+; )+bh=([a-zA-Z0-9+/=]+);/;

/**
 * One issuer as this module reads it: the part of `IssuerConfig` a proof needs. It fits both a
 * `config/issuers/<issuer>.json` record and an entry of `ZkConfig.issuers` from `GET /v1/zk/config`, so
 * the client passes the published configuration straight through.
 */
export type SupportedIssuer = Pick<IssuerConfig, 'issuerId' | 'displayName' | 'keys' | 'template'>;

/** The published configuration a proof needs that is not derived from the email. */
export interface BuildCircuitInputsOptions {
  /** `ZkConfig.nullifierSalt`: the decimal salt the booking reference is hashed with. */
  readonly nullifierSalt: string;
}

/**
 * The witness `tablemate_itinerary.circom` takes, as the decimal strings snarkjs and the native prover
 * read: every array zero-padded to the size its signal declares, under the signal names the circuit
 * writes down. `JSON.stringify` of this object is what `generateProof` (native) and
 * `groth16.fullProve` (web) receive.
 */
export interface CircuitInputs {
  /* The EmailVerifier half. */
  /** The canonical signed header, zero-padded to {@link MAX_HEADER_LENGTH}. */
  emailHeader: string[];
  /** Its length including the SHA-256 padding. */
  emailHeaderLength: string;
  /** The RSA modulus, {@link RSA_LIMB_COUNT} little-endian 121-bit limbs. */
  pubkey: string[];
  /** The DKIM signature, split the same way. */
  signature: string[];
  /** The padded body window, zero-padded to {@link MAX_BODY_LENGTH}. */
  emailBody: string[];
  /** The window's length in whole SHA-256 blocks, which `emailBody`'s own length field fixes. */
  emailBodyLength: string;
  /** Where the `bh=` value starts in `emailHeader`. */
  bodyHashIndex: string;
  /** The SHA-256 state entering the window: the IV when the window starts at block 0. */
  precomputedSHA: string[];
  /** The window with soft line breaks removed, the only input the extraction reads. */
  decodedEmailBodyIn: string[];

  /* The located fields and the template that read them. */
  /** Each field's anchor position in the decoded window, in field order. */
  anchorIndex: string[];
  /** Each field's value length in bytes, 1-32. */
  valueLength: string[];
  /** The four anchors, each zero-padded to 32 bytes. */
  anchors: string[][];
  /** The four anchor lengths in bytes, 1-32. */
  anchorLength: string[];
  /** The byte ending each field's value. */
  terminator: string[];
  /** Each field's charset code. */
  charset: string[];
  /** The template's date layout code, shared by both dates. */
  dateFormat: string;

  /* The two registry leaves and their paths. */
  /** The issuer's id, hashed into its leaf and reported as a public output. */
  issuerIdIn: string;
  /** The city's id, hashed into its leaf and reported as a public output. */
  cityIdIn: string;
  /** The issuer leaf's Merkle path, level 0 first. */
  issuerPathElements: string[];
  /** Its path bits. */
  issuerPathIndices: string[];
  /** The city leaf's Merkle path, level 0 first. */
  cityPathElements: string[];
  /** Its path bits. */
  cityPathIndices: string[];

  /* The public inputs. */
  /** The registry root both paths must reach. */
  registryRoot: string;
  /** The published salt the nullifier is taken with. */
  nullifierSalt: string;
}

/** A built witness and the two ids it proves. */
export interface BuildCircuitInputsResult {
  /** The witness, ready for `JSON.stringify`. */
  readonly inputs: CircuitInputs;
  /** The issuer's integer id, the proof's public `issuerId` output. */
  readonly issuerId: number;
  /** The city's circuit id, the proof's public `cityId` output. */
  readonly cityId: number;
}

/**
 * The EmailVerifier half of a witness, before it is stringified: what `./sha-partial.ts`,
 * `./dkim-canonicalize.ts` and the RSA limb split produce, plus what the registry checks of
 * {@link buildCircuitInputs} need. Exported so `test/inputs.test.ts` can compare each value against
 * `@zk-email/helpers`, and so `test/adversarial.test.ts` can re-check the signed header's RSA signature with
 * `node:crypto`: hence `canonicalHeader`, unpadded, and `precomputeCut`, the block boundary the oracle has to
 * precompute from to select the same window.
 */
export interface EmailVerifierParts {
  /** The canonical signed header, zero-padded to {@link MAX_HEADER_LENGTH}. */
  readonly emailHeader: Uint8Array;
  /** Its length including the SHA-256 padding. */
  readonly emailHeaderLength: number;
  /** The canonical signed header itself, unpadded: the bytes the RSA signature covers. */
  readonly canonicalHeader: Uint8Array;
  /** The RSA modulus's limbs. */
  readonly pubkey: bigint[];
  /** The signature's limbs. */
  readonly signature: bigint[];
  /** The padded body window, zero-padded to {@link MAX_BODY_LENGTH}. */
  readonly emailBody: Uint8Array;
  /** The window's length in whole SHA-256 blocks. */
  readonly emailBodyLength: number;
  /**
   * Where the window starts in the padded body: `max(0, paddedLength - 960)`, and 0 when the whole
   * padded body fits the window.
   */
  readonly precomputeCut: number;
  /** The SHA-256 state entering the window. */
  readonly precomputedSHA: Uint8Array;
  /** The window with soft line breaks removed. */
  readonly decodedEmailBodyIn: Uint8Array;
  /** Where the `bh=` value starts in `canonicalHeader`. */
  readonly bodyHashIndex: number;
  /** The issuer whose key matched, and whose template the extraction will use. */
  readonly issuer: SupportedIssuer;
  /** The key record the signature was matched to. */
  readonly key: DkimKey;
  /** The modulus `key.modulusBase64` holds. */
  readonly modulus: bigint;
  /** The signature's `d=` tag, lowercased. */
  readonly signatureDomain: string;
  /** The signature's `s=` tag, lowercased. */
  readonly signatureSelector: string;
}

/** Everything {@link assembleInputs} needs to stringify one witness. */
export interface AssembleInputsParts {
  /**
   * The nine EmailVerifier signals taken from {@link EmailVerifierParts}. The two fields that interface
   * carries for the tests, `canonicalHeader` and `precomputeCut`, name no circuit signal.
   */
  readonly emailVerifier: {
    readonly emailHeader: Uint8Array;
    readonly emailHeaderLength: number;
    readonly pubkey: readonly bigint[];
    readonly signature: readonly bigint[];
    readonly emailBody: Uint8Array;
    readonly emailBodyLength: number;
    readonly bodyHashIndex: number;
    readonly precomputedSHA: Uint8Array;
    readonly decodedEmailBodyIn: Uint8Array;
  };

  /** The four located stay fields, in `TEMPLATE_FIELD_ORDER` order. */
  readonly fields: readonly { readonly anchorIndex: number; readonly valueLength: number }[];

  /** The template the extraction used, emitted signal by signal and hashed into the issuer leaf. */
  readonly template: TemplateParams;

  /** The issuer's circuit id: the issuer leaf's input and the `issuerId` public output. */
  readonly issuerId: number | bigint;

  /** The city's circuit id: the city leaf's input and the `cityId` public output. */
  readonly cityId: number | bigint;

  /** The issuer leaf's Merkle path, level 0 first. */
  readonly issuerPath: {
    readonly pathElements: readonly bigint[];
    readonly pathIndices: readonly (number | bigint)[];
  };

  /** The city leaf's Merkle path, level 0 first. */
  readonly cityPath: {
    readonly pathElements: readonly bigint[];
    readonly pathIndices: readonly (number | bigint)[];
  };

  /** The registry root both paths reach: a field element or its printed decimal form. */
  readonly registryRoot: bigint | string;

  /** The published nullifier salt: a field element or its printed decimal form. */
  readonly nullifierSalt: bigint | string;
}

/**
 * Runs `compute`, mapping the `RangeError`/`TypeError` the registry, leaf and padding helpers raise to
 * the code that describes what went wrong. The original error is never rethrown, wrapped or attached
 * as a `cause`, so no value it carries can reach a caller; anything else is a defect and propagates.
 */
function mapped<T>(code: CircuitInputError['code'], compute: () => T): T {
  try {
    return compute();
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) fail(code);
    throw error;
  }
}

/** Reads `values[index]`, or throws for a missing entry: every array read here has a fixed length. */
function entryAt<T>(values: readonly T[], index: number, signal: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`${signal} has no entry ${index}`);
  }
  return value;
}

/**
 * The key of `issuer` that signs for `domain`/`selector`, compared case-insensitively, or `undefined`.
 *
 * An issuer with no template is skipped: with no registered anchors there is no leaf a proof could
 * name, so its keys can never verify a signature this circuit can read (AAP 0.5.5).
 */
function matchingKey(
  issuer: SupportedIssuer,
  domain: string,
  selector: string,
): DkimKey | undefined {
  if (issuer.template === null) return undefined;
  return issuer.keys.find(
    (key) => key.domain.toLowerCase() === domain && key.selector.toLowerCase() === selector,
  );
}

/** The signature, issuer and key one message proves against. */
interface SelectedSignature {
  readonly sig: DkimSignature;
  readonly issuer: SupportedIssuer;
  readonly key: DkimKey;
}

/**
 * Selects the first `DKIM-Signature` field a supported issuer's key signs for, walking the signatures in
 * header order and each issuer's keys in configuration order (AAP 0.5.5).
 *
 * A message whose every signature was unusable reports the parser's own code when the offending
 * signature's `d=`/`s=` names a supported issuer's key, and `unsupported_issuer` otherwise: the first is
 * a supported site signed in a way the circuit does not implement, the second the state the import
 * screen shows as "This booking site isn't supported yet." (AAP 0.5.8).
 */
function selectSignature(
  parsed: ParsedEml,
  issuers: readonly SupportedIssuer[],
): SelectedSignature {
  for (const sig of parsed.signatures) {
    const selector = sig.s.toLowerCase();
    for (const issuer of issuers) {
      const key = matchingKey(issuer, sig.d, selector);
      if (key !== undefined) return { sig, issuer, key };
    }
  }
  for (const rejected of parsed.rejectedSignatures) {
    const { d, s } = rejected;
    if (d === undefined || s === undefined) continue;
    const selector = s.toLowerCase();
    if (issuers.some((issuer) => matchingKey(issuer, d, selector) !== undefined)) {
      throw new CircuitInputError(rejected.code);
    }
  }
  return fail('unsupported_issuer');
}

/** The offset of the first byte after `bytes`'s last CRLF, or 0 when it holds none. */
function lastLineStart(bytes: Uint8Array): number {
  for (let i = bytes.length - 2; i >= 0; i -= 1) {
    if (bytes[i] === CR && bytes[i + 1] === LF) return i + 2;
  }
  return 0;
}

/**
 * Where the `bh=` value starts in the canonical signed header: the circuit's `bodyHashIndex`.
 *
 * The signature is the header's last field, so its line is the bytes after the last CRLF, and
 * {@link BODY_HASH_PATTERN} requires that line to carry a tag list the circuit can reveal. The value the match
 * locates must be the `bh=` the signature carries, 44 base64 characters long and contiguous: the circuit
 * reveals it between two fixed anchors, so a folded `bh=` cannot be located at all. `@zk-email/helpers` 6.4.2
 * computes the first occurrence of the same value as a character index into the same ASCII header, which is
 * this byte offset for every fixture.
 */
function bodyHashIndexIn(canonicalHeader: Uint8Array, sig: DkimSignature): number {
  if (sig.bh.length !== SHA256_BYTES || sig.bhBase64.length !== BODY_HASH_BASE64_LENGTH) {
    fail('dkim_unsupported');
  }
  const lineStart = lastLineStart(canonicalHeader);
  const match = BODY_HASH_PATTERN.exec(bytesToLatin1(canonicalHeader, lineStart));
  if (match === null) fail('dkim_unsupported');
  const line = match[0] ?? '';
  const value = match[2];
  if (value === undefined || value.length !== BODY_HASH_BASE64_LENGTH) fail('dkim_unsupported');
  // The match starts at the line's start and ends with the tag's `;`, so the value begins this far into
  // it. Comparing the bytes there with the signature's own `bh=` is what makes the offset trustworthy.
  const index = lineStart + line.length - value.length - 1;
  if (bytesToLatin1(canonicalHeader, index, index + BODY_HASH_BASE64_LENGTH) !== sig.bhBase64) {
    fail('dkim_unsupported');
  }
  return index;
}

/**
 * The padded body window the circuit hashes, mirroring `circuits/lib/body_window.circom`: the longest
 * 64-byte-aligned padded suffix of at most {@link MAX_BODY_WINDOW} bytes, which is the whole padded body when
 * it fits and otherwise exactly 960 bytes. The email's own SHA-256 length field, not the prover, fixes that
 * cut, and with it every occurrence of a field's anchor the extraction can reach at all.
 */
function bodyWindowOf(canonicalBody: Uint8Array): {
  emailBody: Uint8Array;
  emailBodyLength: number;
  precomputeCut: number;
  precomputedSHA: Uint8Array;
} {
  // A body whose minimal padding is wider than the circuit's body bound needs a larger buffer to pad
  // into; the window is cut down to MAX_BODY_WINDOW below either way.
  const maxLength = Math.max(MAX_BODY_LENGTH, 64 * Math.ceil((canonicalBody.length + 9) / 64));
  const { padded, paddedLength } = sha256Pad(canonicalBody, maxLength);
  const precomputeCut = Math.max(0, paddedLength - MAX_BODY_WINDOW);
  const { precomputedSha, bodyRemaining, bodyRemainingLength } = generatePartialSha(
    padded,
    paddedLength,
    precomputeCut,
    MAX_BODY_LENGTH,
  );
  return {
    emailBody: bodyRemaining,
    emailBodyLength: bodyRemainingLength,
    precomputeCut,
    precomputedSHA: precomputedSha,
  };
}

/**
 * Builds the EmailVerifier half of a witness from a booking confirmation (AAP 0.5.5).
 *
 * It mirrors `@zk-email/helpers` 6.4.2's `generateEmailVerifierInputsFromDKIMResult` with `maxHeadersLength`
 * 1,024, `maxBodyLength` 960, `removeSoftLineBreaks` on and the precompute selector placed at
 * {@link EmailVerifierParts.precomputeCut}, but with no Node API and no DNS lookup: the key comes from
 * `issuers`, selected by the signature's own `d=`/`s=`. RSA verification is deliberately absent — the
 * circuit's `EmailVerifier` is the authority on the signature.
 *
 * @param eml - The message bytes, as the file picker, the share sheet or a test fixture supplied them.
 * @param issuers - The supported issuers of the published configuration.
 * @returns The EmailVerifier signals, plus what the registry checks of {@link buildCircuitInputs} need.
 * @throws {CircuitInputError} `eml_malformed`, `dkim_missing`, `dkim_unsupported`, `unsupported_issuer`,
 *   `header_too_long` or `body_hash_mismatch`; no code carries any part of the message.
 */
export function buildEmailVerifierInputs(
  eml: Uint8Array,
  issuers: readonly SupportedIssuer[],
): EmailVerifierParts {
  const parsed = parseEml(eml);
  const { sig, issuer, key } = selectSignature(parsed, issuers);
  // zk-email's RSA verifier at n = 121, k = 17 targets 2,048-bit keys, so a key outside that shape is
  // refused here rather than inside witness generation; `pnpm circuits:samples` is the authority on the
  // shape of a real issuer's modulus.
  const modulus = mapped('dkim_unsupported', () => modulusFromBase64(key.modulusBase64));
  const canonicalHeader = canonicalSignedHeader(parsed, sig);
  const bodyHashIndex = bodyHashIndexIn(canonicalHeader, sig);
  const { padded, paddedLength } = mapped('header_too_long', () =>
    sha256Pad(canonicalHeader, MAX_HEADER_LENGTH),
  );
  // This is the check that refuses `fixtures/test-issuer/tampered.eml`, before anything is proved.
  const canonicalBody = canonicalizeBody(parsed.body, sig.c.body);
  verifyBodyHash(canonicalBody, sig);
  const window = bodyWindowOf(canonicalBody);
  const decodedEmailBodyIn = removeSoftLineBreaks(window.emailBody, MAX_BODY_LENGTH);
  // An unsigned draft — `b=`, which RFC 6376 allows in the field the signer is about to fill — and a
  // signature at or above the modulus are both refused before the limbs are split.
  if (sig.b.length === 0) fail('dkim_unsupported');
  const signatureInt = bytesToBigIntBE(sig.b);
  if (signatureInt >= modulus) fail('dkim_unsupported');
  return {
    emailHeader: padded,
    emailHeaderLength: paddedLength,
    canonicalHeader,
    pubkey: mapped('dkim_unsupported', () => modulusToLimbs(modulus)),
    signature: mapped('dkim_unsupported', () => modulusToLimbs(signatureInt)),
    emailBody: window.emailBody,
    emailBodyLength: window.emailBodyLength,
    precomputeCut: window.precomputeCut,
    precomputedSHA: window.precomputedSHA,
    decodedEmailBodyIn,
    bodyHashIndex,
    issuer,
    key,
    modulus,
    signatureDomain: sig.d,
    signatureSelector: sig.s.toLowerCase(),
  };
}

/**
 * Builds the complete `TablemateItinerary` witness for a booking confirmation (AAP 0.5.1, AAP 0.5.5):
 * the EmailVerifier signals, the located stay fields, and the two registry paths that the extraction's
 * issuer leaf and city leaf are proven against, all of them bound to one published root.
 *
 * Everything the circuit would reject is checked here first and reported as a code, so the device never
 * spends a proving run on a message the circuit cannot accept: the date layouts, the city alias's leaf,
 * the issuer's key and template hashes, the registry's depth, root and leaves, and the published salt.
 *
 * @param eml - The message bytes.
 * @param issuerConfig - The supported issuers, `ZkConfig.issuers` as published.
 * @param registry - The published registry, `ZkConfig.registry`, whose root the proof must name.
 * @param options - The published non-email configuration, `ZkConfig.nullifierSalt`.
 * @returns The witness, and the two ids it proves.
 * @throws {CircuitInputError} Every code {@link buildEmailVerifierInputs} raises, plus `field_invalid`,
 *   `city_not_supported`, `unsupported_issuer` and `registry_mismatch`.
 */
export function buildCircuitInputs(
  eml: Uint8Array,
  issuerConfig: readonly SupportedIssuer[],
  registry: RegistryFile,
  options: BuildCircuitInputsOptions,
): BuildCircuitInputsResult {
  const nullifierSalt = mapped('registry_mismatch', () => parseFieldElement(options.nullifierSalt));
  const ev = buildEmailVerifierInputs(eml, issuerConfig);
  // Selection only ever returns an issuer that carries a template, so a null one here means the
  // published configuration and this generator disagree: a registry problem, not an email one.
  const template = ev.issuer.template;
  if (template === null) fail('registry_mismatch');
  const params = mapped('registry_mismatch', () => templateParams(template));
  const fields: FieldLocation[] = locateFields(ev.decodedEmailBodyIn, params);
  // Both dates are parsed from the template's one layout, so a value the circuit could not read is
  // refused here, with the field's slot name and never its text.
  const arrival = entryAt(fields, ARRIVAL_FIELD, 'buildCircuitInputs: stay fields');
  const departure = entryAt(fields, DEPARTURE_FIELD, 'buildCircuitInputs: stay fields');
  if (parseDateValue(arrival.value, arrival.valueLength, params.dateFormat) === null) {
    fail('field_invalid', TEMPLATE_FIELD_ORDER[ARRIVAL_FIELD]);
  }
  if (parseDateValue(departure.value, departure.valueLength, params.dateFormat) === null) {
    fail('field_invalid', TEMPLATE_FIELD_ORDER[DEPARTURE_FIELD]);
  }
  // The city is the alias the signed body carried, byte for byte, quoted-printable escapes included.
  const cityLocation = entryAt(fields, CITY_FIELD, 'buildCircuitInputs: stay fields');
  const cityBytes = cityLocation.value.subarray(0, cityLocation.valueLength);
  const cityEntry = registry.cities.find((entry) => bytesEqual(utf8Encode(entry.alias), cityBytes));
  if (cityEntry === undefined) fail('city_not_supported');
  const aliasHash = mapped('registry_mismatch', () => cityAliasHash(cityBytes));
  if (mapped('registry_mismatch', () => parseFieldElement(cityEntry.aliasHash)) !== aliasHash) {
    fail('registry_mismatch');
  }
  // The key the signature verified under and the template the extraction used, both as the registry
  // records them for this issuer.
  const issuerEntry = registry.issuers.find(
    (entry) =>
      entry.issuerId === ev.issuer.issuerId &&
      entry.domain.toLowerCase() === ev.signatureDomain &&
      entry.selector.toLowerCase() === ev.signatureSelector,
  );
  if (issuerEntry === undefined) fail('unsupported_issuer');
  const keyHash = mapped('registry_mismatch', () => pubkeyHash(ev.modulus));
  const templateHashValue = mapped('registry_mismatch', () => templateHash(params));
  if (mapped('registry_mismatch', () => parseFieldElement(issuerEntry.pubkeyHash)) !== keyHash) {
    fail('registry_mismatch');
  }
  if (
    mapped('registry_mismatch', () => parseFieldElement(issuerEntry.templateHash)) !==
    templateHashValue
  ) {
    fail('registry_mismatch');
  }
  // One tree, built once, both paths taken from it: the circuit folds each path to the one root its
  // `registryRoot` input names.
  if (registry.depth !== REGISTRY_DEPTH) fail('registry_mismatch');
  const leaves = registry.leaves.map((leaf) =>
    mapped('registry_mismatch', () => parseFieldElement(leaf)),
  );
  const tree = mapped('registry_mismatch', () => buildMerkleTree(leaves));
  if (tree.root !== mapped('registry_mismatch', () => parseFieldElement(registry.root))) {
    fail('registry_mismatch');
  }
  const issuerLeafValue = mapped('registry_mismatch', () =>
    issuerLeaf(ev.issuer.issuerId, keyHash, templateHashValue),
  );
  const cityLeafValue = mapped('registry_mismatch', () => cityLeaf(cityEntry.cityId, aliasHash));
  if (issuerEntry.leafIndex >= leaves.length) fail('registry_mismatch');
  if (cityEntry.leafIndex >= leaves.length) fail('registry_mismatch');
  if (
    entryAt(leaves, issuerEntry.leafIndex, 'buildCircuitInputs: registry leaves') !==
    issuerLeafValue
  ) {
    fail('registry_mismatch');
  }
  if (
    entryAt(leaves, cityEntry.leafIndex, 'buildCircuitInputs: registry leaves') !== cityLeafValue
  ) {
    fail('registry_mismatch');
  }
  const inputs = assembleInputs({
    emailVerifier: {
      emailHeader: ev.emailHeader,
      emailHeaderLength: ev.emailHeaderLength,
      pubkey: ev.pubkey,
      signature: ev.signature,
      emailBody: ev.emailBody,
      emailBodyLength: ev.emailBodyLength,
      bodyHashIndex: ev.bodyHashIndex,
      precomputedSHA: ev.precomputedSHA,
      decodedEmailBodyIn: ev.decodedEmailBodyIn,
    },
    fields,
    template: params,
    issuerId: ev.issuer.issuerId,
    cityId: cityEntry.cityId,
    issuerPath: tree.proof(issuerEntry.leafIndex),
    cityPath: tree.proof(cityEntry.leafIndex),
    registryRoot: tree.root,
    nullifierSalt,
  });
  return { inputs, issuerId: ev.issuer.issuerId, cityId: cityEntry.cityId };
}

/**
 * Stringifies a witness, and does nothing else: it sizes, zero-pads and prints every signal, so
 * `packages/circuits/test/*` can build deliberately invalid witnesses — a tampered window, a shifted index, a
 * rogue registry, non-binary path bits, a 1,024-byte window — and assert that the circuit refuses them. No
 * semantic rule is repeated here; {@link buildCircuitInputs} is where the checks a real proof depends on live.
 *
 * @param parts - The witness's values, already sized by their producers.
 * @returns The circuit inputs, every array at the size its signal declares, in signal order.
 * @throws {RangeError} When an array is longer than its signal or a number is not a non-negative safe integer;
 *   the message names the signal, never a value.
 */
export function assembleInputs(parts: AssembleInputsParts): CircuitInputs {
  const { emailVerifier, fields, template } = parts;
  const anchors: string[][] = [];
  for (let index = 0; index < TEMPLATE_FIELD_ORDER.length; index += 1) {
    anchors.push(
      decimalBytes(
        entryAt(template.anchors, index, 'assembleInputs: anchors'),
        ANCHOR_BYTES,
        'anchors',
      ),
    );
  }
  return {
    emailHeader: decimalBytes(emailVerifier.emailHeader, MAX_HEADER_LENGTH, 'emailHeader'),
    emailHeaderLength: decimal(emailVerifier.emailHeaderLength, 'emailHeaderLength'),
    pubkey: decimalArray(emailVerifier.pubkey, RSA_LIMB_COUNT, 'pubkey'),
    signature: decimalArray(emailVerifier.signature, RSA_LIMB_COUNT, 'signature'),
    emailBody: decimalBytes(emailVerifier.emailBody, MAX_BODY_LENGTH, 'emailBody'),
    emailBodyLength: decimal(emailVerifier.emailBodyLength, 'emailBodyLength'),
    bodyHashIndex: decimal(emailVerifier.bodyHashIndex, 'bodyHashIndex'),
    precomputedSHA: decimalBytes(emailVerifier.precomputedSHA, SHA256_BYTES, 'precomputedSHA'),
    decodedEmailBodyIn: decimalBytes(
      emailVerifier.decodedEmailBodyIn,
      MAX_BODY_LENGTH,
      'decodedEmailBodyIn',
    ),
    anchorIndex: fourEntries(fields, 'anchorIndex', (field) =>
      decimal(field.anchorIndex, 'anchorIndex'),
    ),
    valueLength: fourEntries(fields, 'valueLength', (field) =>
      decimal(field.valueLength, 'valueLength'),
    ),
    anchors,
    anchorLength: fourEntries(template.anchorLength, 'anchorLength', (length) =>
      decimal(length, 'anchorLength'),
    ),
    terminator: fourEntries(template.terminator, 'terminator', (byte) =>
      decimal(byte, 'terminator'),
    ),
    charset: fourEntries(template.charset, 'charset', (code) => decimal(code, 'charset')),
    dateFormat: decimal(template.dateFormat, 'dateFormat'),
    issuerIdIn: decimal(parts.issuerId, 'issuerIdIn'),
    cityIdIn: decimal(parts.cityId, 'cityIdIn'),
    issuerPathElements: decimalArray(
      parts.issuerPath.pathElements,
      REGISTRY_DEPTH,
      'issuerPathElements',
    ),
    issuerPathIndices: decimalArray(
      parts.issuerPath.pathIndices,
      REGISTRY_DEPTH,
      'issuerPathIndices',
    ),
    cityPathElements: decimalArray(parts.cityPath.pathElements, REGISTRY_DEPTH, 'cityPathElements'),
    cityPathIndices: decimalArray(parts.cityPath.pathIndices, REGISTRY_DEPTH, 'cityPathIndices'),
    registryRoot: printedField(parts.registryRoot, 'registryRoot'),
    nullifierSalt: printedField(parts.nullifierSalt, 'nullifierSalt'),
  };
}

/** One signal as the decimal string the circuit reads: a `bigint`, or a non-negative safe integer. */
function decimal(value: number | bigint, signal: string): string {
  if (typeof value === 'bigint') return value.toString();
  if (Number.isSafeInteger(value) && value >= 0) return value.toString();
  throw new RangeError(`assembleInputs: ${signal} is not a non-negative safe integer`);
}

/** A list of limbs or path elements as decimal strings, zero-filled to the signal's declared size. */
function decimalArray(
  values: readonly (number | bigint)[],
  size: number,
  signal: string,
): string[] {
  if (values.length > size) {
    throw new RangeError(`assembleInputs: ${signal} exceeds ${size}`);
  }
  const out: string[] = [];
  for (let index = 0; index < size; index += 1) {
    out.push(decimal(values[index] ?? 0n, signal));
  }
  return out;
}

/** A byte array as decimal strings, zero-padded to `size`: the `'0'` fill these signals take. */
function decimalBytes(bytes: Uint8Array, size: number, signal: string): string[] {
  if (bytes.length > size) {
    throw new RangeError(`assembleInputs: ${signal} exceeds ${size}`);
  }
  const out: string[] = [];
  for (let index = 0; index < size; index += 1) {
    out.push(String(bytes[index] ?? 0));
  }
  return out;
}

/** The four entries of a `[4]` circuit array, projected to their decimal strings in field order. */
function fourEntries<T>(
  values: readonly T[],
  signal: string,
  project: (entry: T) => string,
): string[] {
  const out: string[] = [];
  for (let index = 0; index < TEMPLATE_FIELD_ORDER.length; index += 1) {
    out.push(project(entryAt(values, index, `assembleInputs: ${signal}`)));
  }
  return out;
}

/**
 * A public input as a decimal string: a `bigint` as it stands, or printed decimal text normalized
 * through {@link parseFieldElement}, so `'007'` and `'7'` are the same signal.
 */
function printedField(value: bigint | string, signal: string): string {
  if (typeof value !== 'string') return value.toString();
  try {
    return parseFieldElement(value).toString();
  } catch (error) {
    if (error instanceof RangeError) {
      throw new RangeError(`assembleInputs: ${signal} is not a field element`);
    }
    throw error;
  }
}
