/**
 * RFC 6376 canonicalization and the body-hash check behind the itinerary statement (AAP 0.5.5).
 *
 * The bytes returned here are the ones the in-circuit `EmailVerifier` feeds to SHA-256: a device builds the exact
 * signed header and the exact canonical body of a booking confirmation without the message leaving it, and
 * `scripts/make-test-fixtures.ts` signs with these same functions. No RSA verification happens here — the circuit is
 * the authority on the signature — so the one property this module owes is byte-exactness.
 * Client-safe: Hermes, the browser Web Worker and Node tests run it, so it imports `@noble/hashes/sha2.js` and
 * `./eml-parse.ts` and nothing else. Every refusal is a code, never a message: the only error it raises is
 * `body_hash_mismatch`, from {@link verifyBodyHash}.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import { COLON, CR, HTAB, LF, SEMI, SP, concatBytes, fail, latin1ToBytes } from './eml-parse.ts';
import type { Canonicalization, DkimSignature, HeaderField, ParsedEml } from './eml-parse.ts';

const CRLF = new Uint8Array([CR, LF]);

/**
 * Canonicalizes one header field for signing, ending it with CRLF (RFC 6376 §3.4.2, §3.4.3). `simple` returns the
 * field's bytes untouched, continuation lines and all; `relaxed` returns `lowercase-name:value` — the name
 * ASCII-lowercased with the WSP before the colon dropped, and the value unfolded, with every run of WSP inside it
 * reduced to one SP and its leading and trailing WSP removed, so no space follows the colon.
 */
export function canonicalizeHeaderField(field: HeaderField, mode: Canonicalization): Uint8Array {
  if (mode === 'simple') return concatBytes([field.raw, CRLF]);
  // The value is shorter than the field it follows, so it always fits in this buffer.
  const value = new Uint8Array(field.raw.length);
  const length = writeCollapsed(
    value,
    0,
    field.raw,
    colonOffset(field.raw) + 1,
    field.raw.length,
    true,
    false,
  );
  // `lowerName` is the parser's ASCII-lowercased name with its trailing WSP removed, which is the name §3.4.2 asks
  // for.
  return concatBytes([latin1ToBytes(`${field.lowerName}:`), value.subarray(0, length), CRLF]);
}

/**
 * Picks the header fields a signature covers, in the order its `h=` tag lists them (RFC 6376 §5.4.2).
 *
 * The n-th occurrence of a name in `h=` takes the n-th instance of that name counted from the bottom of the header
 * block, and an occurrence with no instance left contributes nothing: that is how a signature covers every instance of
 * a name it repeats, and how oversigning (`h=from:from`) refuses a field added above the signed ones afterwards. The
 * signature field itself is never selected — §3.5 forbids a signature covering itself through `h=` — because
 * {@link canonicalSignedHeader} appends it separately, with its value emptied.
 */
export function selectSignedHeaderFields(parsed: ParsedEml, sig: DkimSignature): HeaderField[] {
  const selected: HeaderField[] = [];
  const consumed = new Map<string, number>();
  for (const name of sig.h) {
    const already = consumed.get(name) ?? 0;
    let skipped = 0;
    for (let i = parsed.headers.length - 1; i >= 0; i -= 1) {
      const field = parsed.headers[i];
      if (field === undefined || field === sig.field || field.lowerName !== name) continue;
      if (skipped < already) {
        skipped += 1;
        continue;
      }
      selected.push(field);
      consumed.set(name, already + 1);
      break;
    }
  }
  return selected;
}

/**
 * Empties the `b=` tag value of a `DKIM-Signature` header line, which is what the signer computes over and what a
 * verifier checks (RFC 6376 §3.7). The tag is found by its own bytes after a tag boundary, so `bh=` is never touched —
 * its `b` is followed by `h` — and only the first occurrence is emptied. The line is returned as it stands when it
 * carries no such tag, or when the tag's value is already empty.
 */
export function stripSignatureValue(line: Uint8Array): Uint8Array {
  for (let i = 1; i + 1 < line.length; i += 1) {
    if (line[i] !== 0x62 /* b */ || line[i + 1] !== 0x3d /* = */) continue;
    if (!isTagBoundary(line[i - 1] ?? 0)) continue;
    // The value runs to the tag's own `;`, so an empty one leaves the line untouched.
    let end = i + 2;
    while (end < line.length && line[end] !== SEMI) end += 1;
    if (end === i + 2) return line;
    return concatBytes([line.subarray(0, i + 2), line.subarray(end)]);
  }
  return line;
}

/**
 * The exact bytes a signature's RSA-SHA256 signature covers (RFC 6376 §3.5, §3.7): the canonical form of every field
 * {@link selectSignedHeaderFields} picked, in `h=` order, followed by the `DKIM-Signature` field itself with its `b=`
 * value emptied and with no trailing CRLF. These are the bytes `EmailVerifier` hashes inside the circuit, and
 * `@zk-email/helpers` 6.4.2 canonicalizes the same string into `emailHeader`, which `test/inputs.test.ts` compares
 * against after padding.
 *
 * `./build-inputs.ts` additionally requires the signature to be the last line here, matching the circuit's
 * `BodyHashRegex` `(\r\n|^)dkim-signature:([a-z]+=[^;]+; )+bh=[a-zA-Z0-9+/=]+;`: a fixture signature is therefore
 * signed `c=relaxed/relaxed`, with `bh=` before `b=` and `; ` between tags.
 */
export function canonicalSignedHeader(parsed: ParsedEml, sig: DkimSignature): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const field of selectSignedHeaderFields(parsed, sig)) {
    parts.push(canonicalizeHeaderField(field, sig.c.header));
  }
  if (sig.c.header === 'simple') {
    parts.push(stripSignatureValue(sig.field.raw));
  } else {
    // Relaxed canonicalizes the signature line before emptying it, as mailauth does; the CRLF that canonicalization
    // adds ends no line, so it is dropped first — the field is always longer.
    const relaxed = canonicalizeHeaderField(sig.field, 'relaxed');
    parts.push(stripSignatureValue(relaxed.subarray(0, relaxed.length - 2)));
  }
  return concatBytes(parts);
}

/**
 * Canonicalizes the message body a signature's `bh=` commits to (RFC 6376 §3.4.3, §3.4.4).
 *
 * `simple` drops the body's trailing CRLFs and ends it with exactly one, so an empty body becomes a single CRLF.
 * `relaxed` drops every line's trailing WSP, reduces each run of WSP inside a line to one SP, and removes the empty
 * lines at the end; a body left with no line at all canonicalizes to nothing, which is what an empty body hashes as.
 * Nothing is truncated — `l=` never reaches here, because `./eml-parse.ts` refuses it as `dkim_unsupported` — and the
 * body must already use CRLF, which `parseEml` guarantees through its line ending normalization.
 */
export function canonicalizeBody(body: Uint8Array, mode: Canonicalization): Uint8Array {
  return mode === 'simple' ? simpleBody(body) : relaxedBody(body);
}

/**
 * The SHA-256 digest of a canonical body: the value a signature carries in `bh=` (RFC 6376 §3.7), which
 * `scripts/make-test-fixtures.ts` uses to fill that tag once it has signed a draft.
 */
export function computeBodyHash(canonicalBody: Uint8Array): Uint8Array {
  return sha256(canonicalBody);
}

/**
 * Checks a canonical body against the body hash its signature commits to (RFC 6376 §3.7). The comparison has a fixed
 * shape — lengths first, then every byte folded into one accumulator with no early exit — so it reports only that the
 * body did not match.
 *
 * @throws {CircuitInputError} `body_hash_mismatch`, which is what `packages/circuits/fixtures/test-issuer/tampered.eml`
 *   is built to raise.
 */
export function verifyBodyHash(canonicalBody: Uint8Array, sig: DkimSignature): void {
  const digest = computeBodyHash(canonicalBody);
  const expected = sig.bh;
  const shared = Math.min(digest.length, expected.length);
  let difference = digest.length ^ expected.length;
  for (let i = 0; i < shared; i += 1) {
    difference |= (digest[i] ?? 0) ^ (expected[i] ?? 0);
  }
  if (difference !== 0) fail('body_hash_mismatch');
}

/**
 * The offset of the colon that ends a field's name: the first COLON byte of the field. The parser guarantees one — a
 * field is built from the bytes before it — and ftext excludes the colon, so it is the name's own terminator.
 */
function colonOffset(raw: Uint8Array): number {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === COLON) return i;
  }
  return raw.length;
}

/** Whether a byte may precede a `b=` tag in a `DKIM-Signature` line: `;`, `:`, WSP, CR or LF. */
function isTagBoundary(byte: number): boolean {
  return (
    byte === SEMI || byte === COLON || byte === SP || byte === HTAB || byte === CR || byte === LF
  );
}

/**
 * Writes `bytes[start, end)` into `target` from `offset` with RFC 6376's relaxed whitespace applied: a run of WSP
 * inside the range becomes one SP, a run at its end vanishes, and every other byte is copied as it stands. With
 * `unfold`, a CRLF pair inside the range disappears as well, which joins a folded header value back into one line.
 *
 * WSP is SP and HTAB only (RFC 5322 §3.2.3, RFC 6376 §3.4.2), and where the range begins decides how a leading run is
 * treated: a header value's leading WSP follows the colon and is deleted (§3.4.2 d), while a body line's leading WSP is
 * WSP within the line and collapses to one SP (§3.4.4 a.2). `keepLeadingSpace` selects the second reading, and neither
 * reading emits anything when the range holds no content at all. The oracle this module is measured against
 * canonicalizes a UTF-8-decoded string with the JavaScript `\s` class, which also collapses a vertical tab, a form feed
 * and a non-breaking space; no such byte can appear in this run's fixtures, and where the two could differ the RFC
 * wins, because that is what real signers implement.
 * @returns One past the last byte written, which is `offset` when the range carries no content.
 */
function writeCollapsed(
  target: Uint8Array,
  offset: number,
  bytes: Uint8Array,
  start: number,
  end: number,
  unfold: boolean,
  keepLeadingSpace: boolean,
): number {
  let at = offset;
  let pendingSpace = false;
  let hasContent = false;
  for (let i = start; i < end; i += 1) {
    const byte = bytes[i] ?? 0;
    if (unfold && byte === CR && bytes[i + 1] === LF) {
      i += 1;
      continue;
    }
    if (byte === SP || byte === HTAB) {
      if (hasContent || keepLeadingSpace) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      target[at] = SP;
      at += 1;
      pendingSpace = false;
    }
    target[at] = byte;
    at += 1;
    hasContent = true;
  }
  return at;
}

/** `simple`: the body without its trailing CRLFs, then exactly one (RFC 6376 §3.4.3). */
function simpleBody(body: Uint8Array): Uint8Array {
  let end = body.length;
  while (end >= 2 && body[end - 2] === CR && body[end - 1] === LF) {
    end -= 2;
  }
  const canonical = new Uint8Array(end + 2);
  canonical.set(body.subarray(0, end), 0);
  canonical[end] = CR;
  canonical[end + 1] = LF;
  return canonical;
}

/** `relaxed`: collapsed lines joined with CRLF, their trailing empty ones dropped (§3.4.4). */
function relaxedBody(body: Uint8Array): Uint8Array {
  // Every line contributes at most its own bytes plus one CRLF, and a body not ending with a CRLF leaves one
  // unterminated line, so this bound is exact.
  const canonical = new Uint8Array(body.length + 2);
  let at = 0;
  let keep = 0;
  // `keep` remembers where the last line with content ended, so the trailing empty lines the RFC drops are not
  // returned, while an empty line between two lines with content survives as its own CRLF.
  const writeLine = (start: number, end: number): void => {
    const length = writeCollapsed(canonical, at, body, start, end, false, true);
    canonical[length] = CR;
    canonical[length + 1] = LF;
    if (length > at) keep = length + 2;
    at = length + 2;
  };
  let lineStart = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== CR || body[i + 1] !== LF) continue;
    writeLine(lineStart, i);
    lineStart = i + 2;
    i += 1;
  }
  if (lineStart < body.length) writeLine(lineStart, body.length);
  return canonical.subarray(0, keep);
}
