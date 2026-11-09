/**
 * The client input generator measured against its oracle, `@zk-email/helpers` 6.4.2 (AAP 0.5.5). The oracle is a
 * Node-side reference that reads the issuer's DKIM key over DNS-over-HTTPS, which a device cannot do, and it is never
 * imported by the client-safe generator. These suites hold four things: every EmailVerifier signal
 * `buildEmailVerifierInputs` produces equals the oracle's for each validly signed fixture, both given the same 960-byte
 * body window and the same SHA-256 precompute cut the circuit's `lib/body_window.circom` fixes; the two honest
 * fixtures yield the city, the issuer and one nullifier per booking; the generator refuses the tampered, wrong-issuer,
 * ambiguous-anchor, header-only and invalid-date fixtures with a code; and an LF-ended message and its CRLF twin
 * produce one witness.
 *
 * No circuit is compiled and no `build/` artefact is needed: the oracle verifies the signature with Node's crypto, and
 * the `p=` record it resolves over DoH is built from the published `modulusBase64`. Nothing here writes to the
 * repository, and the only outbound call the run can make is the oracle's own DoH query: the fetch stub below answers
 * the test issuer's name, returns NXDOMAIN for any other name, and throws for any other host.
 */

import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { CitiesFile, IssuerConfig, RegistryFile } from '@tablemate/shared';
import { generateEmailVerifierInputs } from '@zk-email/helpers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CircuitInputs } from '../src/inputs/build-inputs.ts';
import {
  MAX_BODY_LENGTH,
  MAX_BODY_WINDOW,
  MAX_HEADER_LENGTH,
  buildCircuitInputs,
  buildEmailVerifierInputs,
} from '../src/inputs/build-inputs.ts';
import { canonicalizeBody } from '../src/inputs/dkim-canonicalize.ts';
import type { CircuitInputErrorCode } from '../src/inputs/eml-parse.ts';
import {
  CR,
  CircuitInputError,
  LF,
  bytesToLatin1,
  indexOfBytes,
  latin1ToBytes,
  parseEml,
} from '../src/inputs/eml-parse.ts';
import { sha256Pad } from '../src/inputs/sha-partial.ts';
import { RSA_LIMB_COUNT, modulusFromBase64, nullifierOf } from '../src/registry/leaves.ts';

/** `NULLIFIER_SALT` (AAP 0.6.2), as `ZkConfig.nullifierSalt` publishes it: a decimal field element. */
const NULLIFIER_SALT = '123456789';

/** The oracle's body bound: the same window {@link MAX_BODY_WINDOW} fixes for the circuit. */
const ORACLE_MAX_BODY_LENGTH = MAX_BODY_WINDOW;

/** The shortest SHA precompute selector the oracle's own 64-byte cut can be aimed with. */
const MIN_SELECTOR_BYTES = 16;

/** The width of a SHA-256 digest: `precomputedSHA`'s declared signal count. */
const SHA256_BYTES = 32;

/** A 12-character window, the shortest run of message text the refusal suite must never find. */
const PRIVACY_WINDOW = 12;

/** The two DoH servers `@zk-email/helpers` 6.4.2 queries, in the order `resolveDNSHTTP` queries them. */
const DOH_HOSTS = ['dns.google', 'cloudflare-dns.com'];

const FIXTURE_PATH = '../fixtures/test-issuer/';
const CONFIG_PATH = '../../../config/';

type SignedFixture = readonly [path: string, windowCase: 'precomputed' | 'whole' | undefined];

/**
 * The fixtures whose DKIM signature verifies (AAP 0.5.5). The five `adversarial/` bodies are signed by the test key
 * exactly as the honest two are, so they differ from them only in where the stay fields sit: the extraction refuses
 * them, and everything up to that point must agree with the oracle.
 */
const SIGNED_FIXTURES: readonly SignedFixture[] = [
  // Padded body 1,664 bytes: the window is its last 960, so the precompute cut falls inside it.
  ['valid.eml', 'precomputed'],
  // Padded body 448 bytes: the whole padded body is the window, so the precompute prefix is empty.
  ['valid-second.eml', 'whole'],
  ['adversarial/duplicate-anchor.eml', undefined],
  ['adversarial/header-field.eml', undefined],
  ['adversarial/date-feb-30.eml', undefined],
  ['adversarial/date-month-13.eml', undefined],
  ['adversarial/date-non-digit.eml', undefined],
];

type RefusalCase = readonly [
  path: string,
  code: CircuitInputErrorCode,
  field: CircuitInputError['field'],
];

/** Every fixture `buildCircuitInputs` refuses, with the one code each is built to raise. */
const REFUSALS: readonly RefusalCase[] = [
  ['tampered.eml', 'body_hash_mismatch', undefined],
  ['other-issuer.eml', 'unsupported_issuer', undefined],
  ['adversarial/duplicate-anchor.eml', 'field_ambiguous', 'city'],
  ['adversarial/header-field.eml', 'field_not_found', 'reference'],
  ['adversarial/date-feb-30.eml', 'field_invalid', 'arrival'],
  ['adversarial/date-month-13.eml', 'field_invalid', 'arrival'],
  ['adversarial/date-non-digit.eml', 'field_invalid', 'arrival'],
];

/** The published test issuer, `config/issuers/tablemate-test.json` (AAP 0.5.5). */
const testIssuer = IssuerConfig.parse(readConfig('issuers/tablemate-test.json'));

const testRegistry = RegistryFile.parse(readConfig('registry/test.json'));

/** The launch cities, whose `circuitCityId` the witness's `cityId` must equal. */
const cities = CitiesFile.parse(readConfig('cities.json')).cities;

/** The issuer's extraction template; a key is only ever selected for an issuer that carries one. */
const template = requireTemplate();

const dkimRecord = buildDkimRecord();

/** The names the stub was asked for, so the generator itself can be shown to resolve none. */
const dnsQueries: string[] = [];

function readConfig(path: string): unknown {
  return JSON.parse(readFileSync(new URL(CONFIG_PATH + path, import.meta.url), 'utf8'));
}

function fixtureBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(FIXTURE_PATH + path, import.meta.url)));
}

function lfTwin(bytes: Uint8Array): Uint8Array {
  const twin = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    // A CRLF whose own CR is preceded by a CR is left alone: the template's terminator byte is a CR, so an LF-ended
    // file cannot spell "content CR then line ending" distinctly, and normalizing it would drop a byte of the signed
    // body.
    const convertible = bytes[i] === CR && bytes[i + 1] === LF && i > 0 && bytes[i - 1] !== CR;
    twin[length] = convertible ? LF : (bytes[i] ?? 0);
    length += 1;
    if (convertible) i += 1;
  }
  return twin.subarray(0, length);
}

/**
 * The oracle's `p=` record for the test issuer: SPKI DER, base64, as a DKIM TXT answer carries it. The `p=` a real
 * sender publishes encloses the same modulus, so the oracle's own RSA verification checks the fixture's signature
 * against the published key rather than a copy of it.
 */
function buildDkimRecord(): { name: string; data: string } {
  const key = testIssuer.keys[0];
  if (key === undefined) throw new RangeError('the test issuer records no DKIM key');
  // The JWK parameter is the modulus in unsigned big-endian base64url with no leading zero, the byte range `p=`
  // encloses once the base64 is decoded.
  const hex = modulusFromBase64(key.modulusBase64).toString(16);
  const der = createPublicKey({
    key: {
      kty: 'RSA',
      n: Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex').toString('base64url'),
      e: 'AQAB',
    },
    format: 'jwk',
  }).export({ type: 'spki', format: 'der' });
  return {
    name: `${key.selector}._domainkey.${key.domain}`,
    data: `v=DKIM1; k=rsa; p=${der.toString('base64')}`,
  };
}

/** The issuer's template, or a harness failure: `buildEmailVerifierInputs` never selects another. */
function requireTemplate() {
  const value = testIssuer.template;
  if (value === null) throw new RangeError('the test issuer records no template');
  return value;
}

/** A DoH query URL for one name, in the shape `resolveDNSHTTP` builds. */
function dohUrl(host: string, name: string): URL {
  return new URL(`https://${host}/resolve?name=${encodeURIComponent(name)}&type=16`);
}

/**
 * The oracle's DKIM key lookup, standing in for the network: it answers the test issuer's own name with the record
 * built from the published modulus, reports NXDOMAIN for every other name, and throws for any other host, so a request
 * the suite does not expect fails rather than reaching out.
 */
function dohFetch(input: unknown): Promise<Response> {
  const target = input instanceof Request ? input.url : String(input);
  const url = new URL(target);
  const name = url.searchParams.get('name') ?? '';
  dnsQueries.push(name);
  // A rejection rather than a throw: the oracle awaits the promise, and the suite asserts on it.
  if (!DOH_HOSTS.includes(url.host)) {
    return Promise.reject(new Error(`unexpected DNS host ${url.host}`));
  }
  const answer =
    name === dkimRecord.name
      ? { Status: 0, Answer: [{ name, type: 16, data: dkimRecord.data }] }
      : { Status: 3, Answer: [] };
  return Promise.resolve(
    new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/dns-json' },
    }),
  );
}

/** A value of an oracle or generator array as the decimal string both spellings compare in. */
function dec(value: ArrayLike<number | bigint | string>): string[] {
  return Array.from(value, (entry) => entry.toString());
}

/** The body window a fixture proves over: where it starts, and the selector that selects it. */
interface WindowCase {
  /** Where the window starts: `max(0, paddedLength - 960)`. */
  readonly cut: number;
  /** The oracle's precompute selector, absent when the window starts at block 0. */
  readonly selector: string | undefined;
}

/**
 * The padded body of a fixture, the window cut, and the selector that aims the oracle's cut at it.
 *
 * The body is canonicalized exactly as the generator does and padded with `sha256Pad`, so the cut is the one
 * `lib/body_window.circom` constrains rather than a second opinion on it.
 */
function windowOf(bytes: Uint8Array): WindowCase {
  const parsed = parseEml(bytes);
  const sig = parsed.signatures[0];
  if (sig === undefined) throw new RangeError('the fixture carries no DKIM signature');
  const body = canonicalizeBody(parsed.body, sig.c.body);
  const maxLength = Math.max(MAX_BODY_WINDOW, 64 * Math.ceil((body.length + 9) / 64));
  const { padded, paddedLength } = sha256Pad(body, maxLength);
  const cut = Math.max(0, paddedLength - MAX_BODY_WINDOW);
  return { cut, selector: precomputeSelector(padded, paddedLength, cut) };
}

/**
 * The selector that makes the oracle cut the padded body at `cut`: the shortest printable slice from the window's start
 * whose first occurrence in the padded body lies in the window's first 64-byte block, which is where
 * `floor(index / 64) * 64` lands.
 */
function precomputeSelector(
  padded: Uint8Array,
  paddedLength: number,
  cut: number,
): string | undefined {
  if (cut === 0) return undefined;
  for (let start = cut; start < cut + 64; start += 1) {
    for (let width = MIN_SELECTOR_BYTES; start + width <= paddedLength; width += 1) {
      const candidate = bytesToLatin1(padded, start, start + width);
      if (!/^[\x20-\x7e]+$/.test(candidate)) break;
      const at = indexOfBytes(padded, latin1ToBytes(candidate));
      if (Math.floor(at / 64) * 64 === cut && at >= cut && at < cut + 64) return candidate;
    }
  }
  throw new RangeError('no precompute selector selects the window');
}

/** The oracle's EmailVerifier inputs, with the same window bound and cut the circuit declares. */
function oracleInputs(
  bytes: Uint8Array,
  window: WindowCase,
): ReturnType<typeof generateEmailVerifierInputs> {
  return generateEmailVerifierInputs(Buffer.from(bytes), {
    maxHeadersLength: MAX_HEADER_LENGTH,
    maxBodyLength: ORACLE_MAX_BODY_LENGTH,
    ...(window.selector === undefined ? {} : { shaPrecomputeSelector: window.selector }),
    ignoreBodyHashCheck: false,
    removeSoftLineBreaks: true,
    enableHeaderMasking: false,
    enableBodyMasking: false,
  });
}

/**
 * Asserts one of the two arrays that carry the body window matches the oracle's.
 *
 * The oracle pads its window array to its own body bound and this generator pads to the circuit's 1,024-byte signal,
 * so the two differ in width exactly where the zero fill beyond the window begins: the shared prefix must be equal and
 * every entry past it zero on both sides.
 */
function expectSameWindow(ours: readonly string[], oracle: readonly string[]): void {
  const shared = Math.min(ours.length, oracle.length);
  expect(ours.slice(0, shared)).toEqual(oracle.slice(0, shared));
  expect(ours.slice(shared).every((entry) => entry === '0')).toBe(true);
  expect(oracle.slice(shared).every((entry) => entry === '0')).toBe(true);
}

/**
 * The soft line break removal `removeSoftLineBreaks` of `@zk-email/circuits` 6.3.4 performs, written here from the rule
 * rather than read back from the generator: every `=` CR LF inside the window is deleted and the rest is compacted into
 * its place, zero-filled to the circuit's body bound.
 */
function decodeWindow(encoded: Uint8Array): string[] {
  const decoded: string[] = new Array<string>(MAX_BODY_LENGTH).fill('0');
  const text = bytesToLatin1(encoded);
  let write = 0;
  for (let read = 0; read < MAX_BODY_LENGTH; read += 1) {
    if (text.startsWith(`=${String.fromCharCode(CR, LF)}`, read)) {
      read += 2;
      continue;
    }
    decoded[write] = String(encoded[read] ?? 0);
    write += 1;
  }
  return decoded;
}

/** An error a fixture is expected to raise, or `undefined` when it raised nothing at all. */
function errorFrom(run: () => unknown): CircuitInputError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof CircuitInputError) return error;
    throw error;
  }
}

/** A value the oracle must return for a body-hash-checking call, or a harness failure. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new RangeError(`the oracle returned no ${name}`);
  return value;
}

/** One entry of a fixed-length `[4]` or `[8]` signal array, or a harness failure. */
function fieldAt(values: readonly string[], index: number, signal: string): string {
  const value = values[index];
  if (value === undefined) throw new RangeError(`${signal} has no entry ${index}`);
  return value;
}

/** The complete witness for one message, as `apps/mobile` builds it before proving. */
function witnessOf(bytes: Uint8Array): ReturnType<typeof buildCircuitInputs> {
  return buildCircuitInputs(bytes, [testIssuer], testRegistry, {
    nullifierSalt: NULLIFIER_SALT,
  });
}

/** The booking reference the witness locates: the value the reference slot's own signals point at. */
function referenceOf(inputs: CircuitInputs): Uint8Array {
  const start =
    Number(fieldAt(inputs.anchorIndex, 3, 'anchorIndex')) +
    Number(fieldAt(inputs.anchorLength, 3, 'anchorLength'));
  const length = Number(fieldAt(inputs.valueLength, 3, 'valueLength'));
  return Uint8Array.from(dec(inputs.decodedEmailBodyIn).slice(start, start + length), Number);
}

/** The `circuitCityId` of the city whose published alias is the one the message's body carries. */
function cityCircuitIdOf(bytes: Uint8Array): number {
  const city = template.fields.city;
  const decoded = bytesToLatin1(buildEmailVerifierInputs(bytes, [testIssuer]).decodedEmailBodyIn);
  const alias = anchoredValue(decoded, city.anchor, city.terminator);
  const match = cities.find((entry) => entry.aliases.includes(alias));
  if (match === undefined) throw new RangeError(`no launch city carries the alias ${alias}`);
  return match.circuitCityId;
}

/** Every stay value the message carries, each located by its own anchor and terminator byte. */
function fieldValues(bytes: Uint8Array): string[] {
  const text = bytesToLatin1(bytes);
  const values: string[] = [];
  for (const name of ['city', 'arrival', 'departure', 'reference'] as const) {
    const field = template.fields[name];
    const value = anchoredValue(text, field.anchor, field.terminator);
    if (value.length > 0) values.push(value);
  }
  return values;
}

/** The display name of the `To:` header, which the fixtures' own text carries. */
function guestNames(bytes: Uint8Array): string[] {
  const field = parseEml(bytes).headers.find((header) => header.lowerName === 'to');
  if (field === undefined) return [];
  const raw = bytesToLatin1(field.raw);
  const value = raw
    .slice(raw.indexOf(':') + 1)
    .split('<')[0]
    ?.trim();
  return value === undefined || value.length === 0 ? [] : [value];
}

/** The printable run following one anchor, up to its terminator byte, or an empty string. */
function anchoredValue(text: string, anchor: string, terminator: number): string {
  const pattern = new RegExp(
    `${escapePattern(anchor)}([^${String.fromCharCode(terminator)}]{1,32})`,
  );
  return pattern.exec(text)?.[1] ?? '';
}

/** One string as a literal in a pattern, so an anchor's own punctuation is not read as syntax. */
function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textWindows(text: string): Set<string> {
  const windows = new Set<string>();
  for (let i = 0; i + PRIVACY_WINDOW <= text.length; i += 1) {
    windows.add(text.slice(i, i + PRIVACY_WINDOW));
  }
  return windows;
}

/** The message's own windows: its raw text and the same text with soft line breaks deleted. */
function messageWindows(bytes: Uint8Array): Set<string> {
  const text = bytesToLatin1(bytes);
  return new Set([...textWindows(text), ...textWindows(text.replace(/=\r\n/g, ''))]);
}

beforeAll(() => {
  dnsQueries.length = 0;
  vi.stubGlobal('fetch', dohFetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("the oracle's DKIM key lookup over DNS", () => {
  it('answers the published key for the issuer name and NXDOMAIN for every other name', async () => {
    const answer = await dohFetch(dohUrl('dns.google', dkimRecord.name));
    expect(await answer.json()).toEqual({
      Status: 0,
      Answer: [{ name: dkimRecord.name, type: 16, data: dkimRecord.data }],
    });
    const missing = await dohFetch(dohUrl('cloudflare-dns.com', 'x._domainkey.other-issuer.test'));
    expect(await missing.json()).toEqual({ Status: 3, Answer: [] });
    await expect(dohFetch(dohUrl('example.test', dkimRecord.name))).rejects.toThrow(
      'unexpected DNS host example.test',
    );
  });
  it('resolves the key from the published configuration, with no DNS lookup at all', () => {
    dnsQueries.length = 0;
    const result = witnessOf(fixtureBytes('valid.eml'));
    expect(result.issuerId).toBe(testIssuer.issuerId);
    expect(dnsQueries).toEqual([]);
  });
});

describe('the EmailVerifier inputs the circuit and the oracle agree on', () => {
  it.each(SIGNED_FIXTURES)(
    '%s produces the same EmailVerifier inputs as @zk-email/helpers',
    async (path, windowCase) => {
      const bytes = fixtureBytes(path);
      const window = windowOf(bytes);
      if (windowCase !== undefined) {
        // The two window cases body_window.circom admits: the cut inside the padded body, which the oracle can only be
        // aimed at with a selector, and the whole padded body from block 0, which takes none.
        expect(window.cut > 0).toBe(windowCase === 'precomputed');
        expect(window.selector !== undefined).toBe(windowCase === 'precomputed');
      }
      const ours = buildEmailVerifierInputs(bytes, [testIssuer]);
      const oracle = await oracleInputs(bytes, window);
      // The widths the circuit declares, before the two sides are compared value by value.
      expect(ours.emailHeader).toHaveLength(MAX_HEADER_LENGTH);
      expect(ours.emailBody).toHaveLength(MAX_BODY_LENGTH);
      expect(ours.decodedEmailBodyIn).toHaveLength(MAX_BODY_LENGTH);
      expect(ours.pubkey).toHaveLength(RSA_LIMB_COUNT);
      expect(ours.signature).toHaveLength(RSA_LIMB_COUNT);
      expect(ours.precomputedSHA).toHaveLength(SHA256_BYTES);
      expect(dec(ours.emailHeader)).toEqual(dec(oracle.emailHeader));
      expect(String(ours.emailHeaderLength)).toBe(oracle.emailHeaderLength);
      expect(dec(ours.pubkey)).toEqual(dec(oracle.pubkey));
      expect(dec(ours.signature)).toEqual(dec(oracle.signature));
      expect(String(ours.bodyHashIndex)).toBe(oracle.bodyHashIndex);
      expect(dec(ours.precomputedSHA)).toEqual(
        dec(required(oracle.precomputedSHA, 'precomputedSHA')),
      );
      expect(String(ours.emailBodyLength)).toBe(oracle.emailBodyLength);
      expectSameWindow(dec(ours.emailBody), dec(required(oracle.emailBody, 'emailBody')));
      expectSameWindow(
        dec(ours.decodedEmailBodyIn),
        dec(required(oracle.decodedEmailBodyIn, 'decodedEmailBodyIn')),
      );
      // The decoded window is the encoded one with every soft line break deleted, derived here from the bytes the two
      // sides agreed on rather than read back from either of them.
      expect(dec(ours.decodedEmailBodyIn)).toEqual(decodeWindow(ours.emailBody));
    },
  );
});

describe('the codes the generator refuses a fixture with, and the privacy of its errors', () => {
  it.each(REFUSALS)('%s is refused as %s', (path, code, field) => {
    const error = errorFrom(() => witnessOf(fixtureBytes(path)));
    expect(error).toBeInstanceOf(CircuitInputError);
    expect(error?.code).toBe(code);
    if (field !== undefined) expect(error?.field).toBe(field);
    // The one thing every refusal says about the message is its code, and the message it carries is that code, so a
    // caller can log or show it without a value ever reaching the surface.
    expect(error?.message).toBe(error?.code);
  });
  it('accepts both honest fixtures and reports the city, the issuer and one nullifier per booking', () => {
    const valid = witnessOf(fixtureBytes('valid.eml'));
    const second = witnessOf(fixtureBytes('valid-second.eml'));
    expect(valid.issuerId).toBe(testIssuer.issuerId);
    expect(second.issuerId).toBe(testIssuer.issuerId);
    expect(valid.cityId).toBe(cityCircuitIdOf(fixtureBytes('valid.eml')));
    expect(second.cityId).toBe(cityCircuitIdOf(fixtureBytes('valid-second.eml')));
    // The reference bytes the witness locates are the nullifier's own input, and the two bookings are different
    // references of the same length, so one booking yields one nullifier and not the other.
    const first = referenceOf(valid.inputs);
    const other = referenceOf(second.inputs);
    expect(bytesToLatin1(first)).not.toBe(bytesToLatin1(other));
    expect(first).toHaveLength(other.length);
    expect(nullifierOf(first, NULLIFIER_SALT)).not.toBe(nullifierOf(other, NULLIFIER_SALT));
  });
  it.each(['valid.eml', 'valid-second.eml'])(
    'reads %s the same with LF line endings as with CRLF',
    (path) => {
      const bytes = fixtureBytes(path);
      const twin = lfTwin(bytes);
      // The twin is genuinely LF-ended: only the four stay-field lines keep their terminator CR, so a line ending here
      // is a bare LF, which `parseEml` normalizes back to the CRLF the signature covers.
      expect(twin.length).toBeLessThan(bytes.length);
      expect(JSON.stringify(witnessOf(twin).inputs)).toBe(JSON.stringify(witnessOf(bytes).inputs));
    },
  );
  it.each(REFUSALS)('refuses %s with no part of the message in the error', (path) => {
    const bytes = fixtureBytes(path);
    const error = errorFrom(() => witnessOf(bytes));
    const reported = [
      error?.name,
      error?.message,
      error?.code,
      error?.field,
      JSON.stringify(error),
    ].join('|');
    const windows = messageWindows(bytes);
    const values = [...fieldValues(bytes), ...guestNames(bytes)];
    // A fixture whose values could not be located would make the assertions below vacuous.
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(reported).not.toContain(value);
    }
    for (const window of textWindows(reported)) {
      expect(windows.has(window)).toBe(false);
    }
  });
});
