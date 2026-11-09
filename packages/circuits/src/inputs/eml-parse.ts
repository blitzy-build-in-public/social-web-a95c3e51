/**
 * The `.eml` front end of the client input generator: it splits a raw message into its header fields
 * and body and parses each `DKIM-Signature` field, so a proof can be built from a booking confirmation
 * that never leaves the device (AAP 0.5.5).
 *
 * Everything here reports a code, never the message: {@link CircuitInputError} carries a
 * {@link CircuitInputErrorCode} and, for a stay field, its template slot name. No error, message or
 * `cause` holds header text, a tag value, the guest name or the booking reference.
 *
 * Client-safe: this module runs under Hermes (React Native 0.76.9) through `./build-inputs.ts`, in the
 * browser Web Worker and in Node tests, so it imports `../registry/leaves.ts` and the
 * `TemplateFieldName` type and nothing else. It uses no Node built-in, no global `Buffer`, no
 * `TextEncoder`, no `atob`, no DOM API, no randomness and no I/O, and it does no work at module load
 * beyond declaring constants.
 */
import { base64ToBytes } from '../registry/leaves.ts';
import type { TemplateFieldName } from '../registry/template-hash.ts';

/**
 * Every code a {@link CircuitInputError} carries, each naming one way the input generator refuses a message:
 *
 * - `eml_malformed` — no header/body separator, a malformed header line or DKIM tag-list, a missing required
 *   DKIM tag, or invalid base64.
 * - `dkim_missing` — the message holds no `DKIM-Signature` field at all.
 * - `dkim_unsupported` — a signature the circuit cannot use: an `a=` other than `rsa-sha256`, an `l=` tag, an
 *   unknown `c=`, a `v=` other than `1`, a `bh=` that is not 32 bytes, or (from `./build-inputs.ts`) a key
 *   above 2057 bits, a signature not below the modulus, or a `bh=` not contiguous in the signed header.
 * - `unsupported_issuer` — no supported key matches any signature's `d=`/`s=`, which puts "This booking site
 *   isn't supported yet." on the import screen (AAP 0.5.8).
 * - `header_too_long`, `body_hash_mismatch` — the signed header block exceeds `maxHeadersLength`, or the
 *   signed body does not hash to the `bh=` the signature commits to.
 * - `field_not_found`, `field_ambiguous`, `field_invalid` — an anchor is absent from the signed body window,
 *   occurs more than once, or the value breaks its charset, terminator or date format.
 * - `city_not_supported`, `registry_mismatch` — the extracted city has no leaf in the active registry, or the
 *   published registry, its root, its leaves, a template or the salt is inconsistent.
 */
export const CIRCUIT_INPUT_ERROR_CODES = [
  'eml_malformed',
  'dkim_missing',
  'dkim_unsupported',
  'unsupported_issuer',
  'header_too_long',
  'body_hash_mismatch',
  'field_not_found',
  'field_ambiguous',
  'field_invalid',
  'city_not_supported',
  'registry_mismatch',
] as const;

/**
 * One reason the input generator refused a message: a {@link CIRCUIT_INPUT_ERROR_CODES} entry, and the
 * only thing the generator ever says about an email it could not use.
 */
export type CircuitInputErrorCode = (typeof CIRCUIT_INPUT_ERROR_CODES)[number];

/**
 * The one error the input generator throws. `message` equals `code`, and `field` names a stay field's
 * template slot — `'city'`, `'arrival'`, `'departure'` or `'reference'` — never its value, so
 * `scripts/check-samples.ts` can print a pass or a fail per field without revealing one.
 */
export class CircuitInputError extends Error {
  /** The reason the input was refused. */
  readonly code: CircuitInputErrorCode;

  /** The stay field the failure concerns; set only for the `field_*` codes. */
  readonly field?: TemplateFieldName;

  /**
   * @param code - The reason the input was refused, which also becomes `message`.
   * @param field - The stay field, for a `field_*` code.
   */
  constructor(code: CircuitInputErrorCode, field?: TemplateFieldName) {
    super(code);
    this.name = 'CircuitInputError';
    this.code = code;
    if (field !== undefined) {
      this.field = field;
    }
    // Metro transpiles classes with Babel, which does not preserve the prototype chain of a built-in
    // subclass; restoring it keeps `instanceof CircuitInputError` true in the app.
    Object.setPrototypeOf(this, CircuitInputError.prototype);
  }
}

/**
 * Throws a {@link CircuitInputError}. Every refusal in this folder goes through it, and its `never`
 * return type lets a caller's control flow carry on as if the check had passed.
 *
 * @param code - The reason the input was refused.
 * @param field - The stay field, for a `field_*` code.
 * @throws {CircuitInputError} Always.
 */
export function fail(code: CircuitInputErrorCode, field?: TemplateFieldName): never {
  throw new CircuitInputError(code, field);
}

/** Carriage return: the first byte of the CRLF every line of a normalized message ends with. */
export const CR = 13;

/** Line feed: the second byte of CRLF. */
export const LF = 10;

/** Space: one of the two whitespace bytes RFC 5322 and RFC 6376 call WSP. */
export const SP = 32;

/** Horizontal tab: the other WSP byte. A vertical tab or a form feed is not WSP. */
export const HTAB = 9;

/** Colon, which ends a header field's name. */
export const COLON = 58;

/** Semicolon, which ends a `DKIM-Signature` tag. */
export const SEMI = 59;

/**
 * The most code units handed to one `String.fromCharCode` call: a spread of a longer array overflows
 * the Hermes stack, so strings are built a chunk at a time.
 */
const STRING_CHUNK = 4096;

/** The width in bytes of a SHA-256 body hash, the only `bh=` the circuit's body check can match. */
const SHA256_BYTES = 32;

/** The width of the CRLFCRLF separating a message's headers from its body. */
const HEADER_BODY_SEPARATOR_BYTES = 4;

/**
 * One byte range of a header block: a line between two CRLFs, excluding the CRLF itself.
 */
interface HeaderLine {
  start: number;
  end: number;
}

/**
 * Turns bytes into a string of one code unit per byte, the latin1 spelling RFC 6376 works in.
 *
 * The round trip through {@link latin1ToBytes} is lossless for every byte; the string is built in chunks,
 * because spreading a whole message's bytes over `String.fromCharCode` overflows the Hermes stack.
 *
 * @param bytes - The bytes to read.
 * @param start - The first byte to read.
 * @param end - One past the last byte to read.
 * @returns The bytes, one code unit each.
 */
export function bytesToLatin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let text = '';
  for (let i = start; i < end; i += STRING_CHUNK) {
    const chunk: number[] = [];
    for (let j = i; j < Math.min(i + STRING_CHUNK, end); j += 1) {
      chunk.push(bytes[j] ?? 0);
    }
    text += String.fromCharCode(...chunk);
  }
  return text;
}

/**
 * The inverse of {@link bytesToLatin1}: one byte per code unit.
 *
 * @param s - The latin1 text.
 * @returns Its bytes.
 * @throws {RangeError} When a code unit is above `0xFF`, which latin1 cannot carry.
 */
export function latin1ToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    if (unit > 0xff) {
      throw new RangeError('latin1ToBytes: code unit above 0xFF');
    }
    bytes[i] = unit;
  }
  return bytes;
}

/**
 * The first offset at or after `from` where `needle` occurs in `haystack`, or −1 when it does not. An
 * empty needle occurs at `from`, as `Array.prototype.indexOf` would have it.
 *
 * @param haystack - The bytes to search.
 * @param needle - The bytes to find.
 * @param from - The offset to start at; a negative value is read as 0.
 */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const start = from < 0 ? 0 : from;
  if (needle.length === 0) return start;
  if (needle.length > haystack.length - start) return -1;
  const limit = haystack.length - needle.length;
  for (let i = start; i <= limit; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

/**
 * Whether two byte ranges hold the same bytes.
 *
 * @param a - The first range.
 * @param b - The second range.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Joins byte ranges into one array.
 *
 * @param parts - The ranges, in order.
 * @returns Their bytes, as a new array.
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * Normalizes every bare LF to CRLF, so an LF-only `.eml` and its CRLF twin parse and canonicalize
 * identically (AAP 0.5.5; `test/inputs.test.ts` asserts the equivalence). A `.eml` exported from a mail
 * client routinely uses LF alone, while SMTP, and so the bytes a `DKIM-Signature` covers, use CRLF;
 * normalizing here makes the header canonicalization, the body hash and the signature all see the line
 * ending the signature was computed over. A lone CR is left as it is, because RFC 5322 does not read it as
 * a line break either.
 *
 * @param bytes - The message bytes.
 * @returns The bytes with every bare LF doubled; a copy when any LF was bare.
 */
export function normalizeLineEndings(bytes: Uint8Array): Uint8Array {
  let bareLfs = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === LF && (i === 0 || bytes[i - 1] !== CR)) {
      bareLfs += 1;
    }
  }
  if (bareLfs === 0) return bytes.slice();
  const normalized = new Uint8Array(bytes.length + bareLfs);
  let offset = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === LF && (i === 0 || bytes[i - 1] !== CR)) {
      normalized[offset] = CR;
      offset += 1;
    }
    normalized[offset] = byte;
    offset += 1;
  }
  return normalized;
}

/**
 * One header field of a message: its first line and every continuation line it folds over, exactly as
 * the message carried them.
 */
export interface HeaderField {
  /** The latin1 text before the field's first colon, with trailing WSP removed. */
  name: string;

  /** {@link name} ASCII-lowercased, the spelling an exact header-name comparison uses. */
  lowerName: string;

  /**
   * The complete field: its first line and every continuation line, including the CRLFs it folds over
   * and excluding the CRLF that ends it.
   */
  raw: Uint8Array;
}

/**
 * A parsed message: its header fields in file order, its body, and the DKIM signatures the input
 * generator can work from.
 */
export interface ParsedEml {
  /** Every header field, in file order, with continuations folded into their field. */
  headers: HeaderField[];

  /** The bytes after the header/body separator, possibly empty. */
  body: Uint8Array;

  /** The signatures the circuit can use, in header order. */
  signatures: DkimSignature[];

  /**
   * The signatures it cannot, each with the reason it was refused and, when the tag-list yielded them,
   * its `d=` and `s=`.
   */
  rejectedSignatures: RejectedSignature[];
}

/**
 * Parses a message into its header fields, its body and its DKIM signatures (AAP 0.5.5).
 *
 * A message whose signatures are all unusable fails with the first one's code, because there is then
 * nothing to prove against; a message with no `DKIM-Signature` field at all is `dkim_missing`.
 *
 * @param bytes - The message bytes, as the file picker, the share sheet or a test fixture supplied them.
 * @returns The parsed message.
 * @throws {CircuitInputError} When the message is malformed, carries no DKIM signature, or carries none
 *   the circuit can use.
 */
export function parseEml(bytes: Uint8Array): ParsedEml {
  const normalized = normalizeLineEndings(bytes);
  const separator = findHeaderEnd(normalized);
  // Without a blank line there is no body to sign; at offset 0 there are no headers to sign.
  if (separator < 0 || separator === 0) {
    fail('eml_malformed');
  }
  // Both halves are copies, so nothing of the caller's buffer is aliased into the returned value.
  const headers = parseHeaderBlock(normalized.slice(0, separator));
  const body = normalized.slice(separator + HEADER_BODY_SEPARATOR_BYTES);
  const dkimFields = headers.filter((field) => field.lowerName === 'dkim-signature');
  if (dkimFields.length === 0) {
    fail('dkim_missing');
  }
  const signatures: DkimSignature[] = [];
  const rejectedSignatures: RejectedSignature[] = [];
  let firstRejection: CircuitInputError | undefined;
  // A confirmation is often signed twice — an Ed25519 signature from the sending service beside the
  // issuer's RSA one — so an unusable signature is recorded rather than thrown away, and only a
  // message whose every signature was rejected fails.
  for (const field of dkimFields) {
    try {
      signatures.push(parseDkimSignature(field));
    } catch (error) {
      if (!(error instanceof CircuitInputError)) {
        throw error;
      }
      rejectedSignatures.push(rejectedSignatureOf(field, error));
      firstRejection ??= error;
    }
  }
  if (signatures.length === 0 && firstRejection !== undefined) {
    throw new CircuitInputError(firstRejection.code);
  }
  return { headers, body, signatures, rejectedSignatures };
}

/**
 * The offset of the first CRLFCRLF, the header/body separator, or −1 when the message has none.
 */
function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === CR && bytes[i + 1] === LF && bytes[i + 2] === CR && bytes[i + 3] === LF) {
      return i;
    }
  }
  return -1;
}

/**
 * The header block's lines, each as the byte range between two CRLFs. The block never ends with a
 * CRLF — the first CRLFCRLF belongs to the separator — so its last line is simply unterminated.
 */
function splitHeaderLines(block: Uint8Array): HeaderLine[] {
  const lines: HeaderLine[] = [];
  let start = 0;
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] === CR && block[i + 1] === LF) {
      lines.push({ start, end: i });
      i += 1;
      start = i + 1;
    }
  }
  if (start < block.length) {
    lines.push({ start, end: block.length });
  }
  return lines;
}

/**
 * Groups a header block's lines into fields: a line starting with SP or HTAB continues the field
 * before it (RFC 5322 folding), and any other line opens a field.
 *
 * @throws {CircuitInputError} `eml_malformed` for a continuation line before any field, or a field
 *   whose first line has no colon or no valid name.
 */
function parseHeaderBlock(block: Uint8Array): HeaderField[] {
  const fields: HeaderField[] = [];
  let start = -1;
  let end = 0;
  let firstNameEnd = 0;
  const flush = (): void => {
    if (start < 0) return;
    fields.push(headerFieldOf(block.slice(start, end), firstNameEnd - start));
    start = -1;
  };
  for (const line of splitHeaderLines(block)) {
    const first = block[line.start] ?? 0;
    if (first === SP || first === HTAB) {
      if (start < 0) fail('eml_malformed');
      end = line.end;
      continue;
    }
    flush();
    start = line.start;
    end = line.end;
    firstNameEnd = line.end;
  }
  flush();
  return fields;
}

/**
 * One field from its raw bytes. The name is the latin1 text before the first colon of the field's
 * first line, the only line a name can occupy, with trailing WSP removed.
 *
 * A name must be RFC 5322 `ftext` — printable US-ASCII, colon aside — so a byte above `0x7f` is
 * malformed. That is also what refuses a message carrying a UTF-8 BOM before its first field name,
 * which would otherwise become a field named after a byte no header lookup can match.
 *
 * @throws {CircuitInputError} `eml_malformed` when the first line has no colon, or the name is empty or
 *   holds a byte outside `ftext`.
 */
function headerFieldOf(raw: Uint8Array, nameEnd: number): HeaderField {
  const colon = indexOfByte(raw, COLON, 0, nameEnd);
  if (colon < 0) fail('eml_malformed');
  const name = bytesToLatin1(raw, 0, colon).replace(/[ \t]+$/, '');
  if (name.length === 0 || !isFieldName(name)) fail('eml_malformed');
  return { name, lowerName: asciiLower(name), raw };
}

/** Whether a field name is RFC 5322 `ftext`: every code unit printable US-ASCII, the colon aside. */
function isFieldName(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const unit = name.charCodeAt(i);
    if (unit < 33 || unit > 126) return false;
  }
  return true;
}

/** A string's A–Z lowercased, leaving every other code unit as it stands. */
function asciiLower(s: string): string {
  let lowered = '';
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    lowered += String.fromCharCode(unit >= 65 && unit <= 90 ? unit + 32 : unit);
  }
  return lowered;
}

/** The offset of `byte` in `bytes` between `start` and `end`, or −1. */
function indexOfByte(bytes: Uint8Array, byte: number, start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    if (bytes[i] === byte) return i;
  }
  return -1;
}

/** The canonicalization a DKIM signature applies to the header and to the body (RFC 6376 §3.5). */
export type Canonicalization = 'simple' | 'relaxed';

/**
 * A parsed `DKIM-Signature` field: the tags the input generator needs, with `bh=` and `b=` already
 * decoded. Only the tags of RFC 6376 §3.5 that change what is signed are kept; `t`, `x`, `i`, `q` and
 * `z` are ignored.
 */
export interface DkimSignature {
  /** The header field, whose raw bytes the header canonicalization covers. */
  field: HeaderField;

  /** The `v=` tag. */
  v: string;

  /** The `a=` tag, as written. */
  a: string;

  /** The `c=` tag, resolved. */
  c: { header: Canonicalization; body: Canonicalization };

  /** The `d=` tag, lowercased: the signing domain. */
  d: string;

  /** The `s=` tag, as written: the selector. `./build-inputs.ts` compares it case-insensitively. */
  s: string;

  /** The `h=` tag, lowercased: the signed header field names, in signature order. */
  h: string[];

  /** The decoded `bh=` tag: the body hash the signature commits to. */
  bh: Uint8Array;

  /**
   * The whitespace-stripped `bh=` tag. `./build-inputs.ts` looks for it contiguously in the canonical
   * header, because the circuit's `BodyHashRegex` matches it there without folding.
   */
  bhBase64: string;

  /** The decoded `b=` tag: the signature. Empty in an unsigned draft, which `build-inputs` refuses. */
  b: Uint8Array;
}

/**
 * A `DKIM-Signature` field the circuit cannot use, with the reason and the domain and selector the
 * tag-list yielded. Keeping it tells `dkim_unsupported` from `unsupported_issuer`: when the signature whose
 * `d=`/`s=` matches a supported issuer is the rejected one, the message is a supported site signed in a way
 * the circuit does not implement, not an unsupported site.
 */
export interface RejectedSignature {
  /** The `d=` tag, lowercased, when the tag-list yielded one. */
  d?: string;

  /** The `s=` tag, as written, when the tag-list yielded one. */
  s?: string;

  /** The code that refused the signature. */
  code: CircuitInputErrorCode;
}

/**
 * Parses one `DKIM-Signature` field into the tags the circuit needs (RFC 6376 §3.2, §3.5).
 *
 * @param field - A field whose `lowerName` is `dkim-signature`.
 * @returns The parsed signature.
 * @throws {CircuitInputError} `eml_malformed` for a malformed tag-list, a missing required tag or
 *   invalid base64; `dkim_unsupported` for a version, algorithm, length or canonicalization the circuit
 *   does not implement, or a `bh=` that is not a SHA-256 digest.
 */
export function parseDkimSignature(field: HeaderField): DkimSignature {
  const tags = parseTagList(dkimValueText(field));
  const v = requiredTag(tags, 'v');
  const a = requiredTag(tags, 'a');
  const d = requiredTag(tags, 'd');
  const s = requiredTag(tags, 's');
  const h = requiredTag(tags, 'h');
  const bh = requiredTag(tags, 'bh');
  // `b` may be empty: `scripts/make-test-fixtures.ts` parses the unsigned draft it is about to sign.
  const b = requiredTag(tags, 'b');
  if (v !== '1' || a.toLowerCase() !== 'rsa-sha256' || tags.has('l')) {
    fail('dkim_unsupported');
  }
  const c = parseCanonicalization(tags.get('c'));
  const headerNames = headerNameList(h);
  const bhBase64 = stripWhitespace(bh);
  const bhBytes = decodeBase64Tag(bhBase64);
  // The circuit's body check compares against exactly one SHA-256 digest, so a shorter or longer `bh=`
  // could never match it. The key and signature bounds of the same class are checked in
  // `./build-inputs.ts`, which is where the registry's modulus is at hand.
  if (bhBytes.length !== SHA256_BYTES) fail('dkim_unsupported');
  return {
    field,
    v,
    a,
    c,
    d: d.toLowerCase(),
    s,
    h: headerNames,
    bh: bhBytes,
    bhBase64,
    b: decodeBase64Tag(stripWhitespace(b)),
  };
}

/**
 * A `DKIM-Signature` field's unfolded value: the latin1 text after the first colon, with every CRLF
 * removed (RFC 6376 §3.2). Folding therefore survives only as the SP or HTAB the fold left behind,
 * which is why `bh=` and `b=` strip whitespace before decoding.
 */
function dkimValueText(field: HeaderField): string {
  const text = bytesToLatin1(field.raw);
  const colon = text.indexOf(':');
  return (colon < 0 ? text : text.slice(colon + 1)).replace(/\r\n/g, '');
}

/** A tag-list piece: the tag name, then WSP, `=`, WSP and the value, which reaches the piece's end. */
const DKIM_TAG_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)[ \t]*=[ \t]*([\s\S]*)$/;

/**
 * The tag-list as a map. Tag names are case-sensitive and a repeated name is malformed; the empty
 * piece a trailing `;` leaves is allowed, and any other empty piece is not.
 *
 * @throws {CircuitInputError} `eml_malformed` for a piece that is not `name=value`, a repeated name, or
 *   an empty piece that is not the last.
 */
function parseTagList(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  const pieces = value.split(';');
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = (pieces[i] ?? '').trim();
    if (piece.length === 0) {
      if (i === pieces.length - 1) continue;
      fail('eml_malformed');
    }
    const match = DKIM_TAG_PATTERN.exec(piece);
    if (match === null) fail('eml_malformed');
    const name = match[1] ?? '';
    if (tags.has(name)) fail('eml_malformed');
    tags.set(name, match[2] ?? '');
  }
  return tags;
}

/**
 * A required tag's value, empty allowed. A missing tag is malformed rather than unsupported, because
 * the signature itself is incomplete.
 *
 * @throws {CircuitInputError} `eml_malformed` when the tag is absent.
 */
function requiredTag(tags: ReadonlyMap<string, string>, name: string): string {
  const value = tags.get(name);
  if (value === undefined) fail('eml_malformed');
  return value;
}

/**
 * Resolves the `c=` tag: an absent tag means `simple/simple`, and a single value is the header's
 * canonicalization with `simple` for the body (`relaxed` becomes `relaxed/simple`).
 *
 * @throws {CircuitInputError} `dkim_unsupported` for an unknown name or more than two parts.
 */
function parseCanonicalization(value: string | undefined): {
  header: Canonicalization;
  body: Canonicalization;
} {
  if (value === undefined) {
    return { header: 'simple', body: 'simple' };
  }
  const parts = value.toLowerCase().split('/');
  const header = canonicalizationOf(parts[0]);
  if (parts.length === 1) {
    if (header === undefined) fail('dkim_unsupported');
    return { header, body: 'simple' };
  }
  const body = parts.length === 2 ? canonicalizationOf(parts[1]) : undefined;
  if (header === undefined || body === undefined) fail('dkim_unsupported');
  return { header, body };
}

/** One canonicalization name, or `undefined` for a name the circuit does not implement. */
function canonicalizationOf(name: string | undefined): Canonicalization | undefined {
  return name === 'simple' || name === 'relaxed' ? name : undefined;
}

/**
 * The `h=` tag as the ordered, lowercased names of the signed header fields.
 *
 * @throws {CircuitInputError} `eml_malformed` for an empty entry, which names no field.
 */
function headerNameList(value: string): string[] {
  const names: string[] = [];
  for (const piece of value.split(':')) {
    const name = piece.trim().toLowerCase();
    if (name.length === 0) fail('eml_malformed');
    names.push(name);
  }
  return names;
}

/** A tag value with every SP, HTAB, CR and LF removed, the form `bh=` and `b=` are decoded from. */
function stripWhitespace(value: string): string {
  return value.replace(/[ \t\r\n]+/g, '');
}

/**
 * A `bh=` or `b=` value's bytes. `../registry/leaves.ts` reports invalid base64 as a `TypeError`, which
 * maps to `eml_malformed`; nothing it carries is rethrown or attached as a `cause`, so no part of a tag
 * value can reach an error. Any other error is a defect and is rethrown.
 *
 * @throws {CircuitInputError} `eml_malformed` for a value that is not valid base64.
 */
function decodeBase64Tag(stripped: string): Uint8Array {
  try {
    return base64ToBytes(stripped);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    fail('eml_malformed');
  }
}

/**
 * The report a rejected signature leaves behind: the code that refused it, and its `d=` and `s=` read
 * as tolerantly as the tag-list allows, because the strict parse is what already failed.
 */
function rejectedSignatureOf(field: HeaderField, error: CircuitInputError): RejectedSignature {
  const value = dkimValueText(field);
  const d = lenientTagValue(value, 'd');
  const s = lenientTagValue(value, 's');
  return {
    ...(d !== undefined ? { d: d.toLowerCase() } : {}),
    ...(s !== undefined ? { s } : {}),
    code: error.code,
  };
}

/**
 * One tag's value read without validating anything: the first `name=value` piece whose name matches, or
 * `undefined`. The name is matched case-insensitively, because this reader exists only to name a
 * signature the strict parser has already refused.
 */
function lenientTagValue(value: string, tag: string): string | undefined {
  for (const piece of value.split(';')) {
    const separator = piece.indexOf('=');
    if (separator < 0) continue;
    if (piece.slice(0, separator).trim().toLowerCase() !== tag) continue;
    const found = piece.slice(separator + 1).trim();
    if (found.length > 0) return found;
  }
  return undefined;
}
