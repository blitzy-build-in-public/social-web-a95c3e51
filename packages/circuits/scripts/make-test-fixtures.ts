/**
 * Generates the DKIM-signed test-issuer fixtures (AAP 0.4.2, AAP 0.5.5): the nine `.eml` files under
 * `fixtures/test-issuer/`, the public key they are signed with, and the rebuilt registries.
 *
 * The RSA-2048 key pair is generated per run and kept in memory: only the public modulus reaches
 * `config/issuers/tablemate-test.json`, and the private key is never exported, written or logged, so no key material
 * can reach the repository (AAP 0.12.2). A rerun therefore rotates the key, which is why every file this script writes
 * belongs in the same commit as its fixtures.
 * The fixtures are the input side of the circuit statement (AAP 0.5.5). `valid.eml` and `valid-second.eml` prove for
 * two travellers staying in one city; `tampered.eml` holds `valid.eml`'s own signed bytes with one byte of its
 * departure date changed after the signature was made, so the header still verifies while the body no longer hashes to
 * the `bh=` it commits to; `other-issuer.eml` is signed by a key the registry does not hold; and the five
 * `adversarial/` bodies are DKIM-honest messages only the circuit rejects: a repeated anchor, a field that lives only
 * in a signed header, and three dates no calendar has. Every other body is rendered from the issuer's own template, so a
 * change to its anchors, terminators, charsets or date layout is carried into them. Every check runs before the first
 * write, so a failure leaves the previous fixture set in place.
 */
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHARSET_CODE, IssuerConfig, RegistryFile } from '@tablemate/shared';
import type { CityConfig, DateFormat, IssuerTemplate } from '@tablemate/shared';

import {
  MAX_BODY_WINDOW,
  MAX_HEADER_LENGTH,
  buildCircuitInputs,
  buildEmailVerifierInputs,
} from '../src/inputs/build-inputs.ts';
import type { SupportedIssuer } from '../src/inputs/build-inputs.ts';
import {
  canonicalSignedHeader,
  canonicalizeBody,
  computeBodyHash,
  verifyBodyHash,
} from '../src/inputs/dkim-canonicalize.ts';
import { CircuitInputError, indexOfBytes, parseEml } from '../src/inputs/eml-parse.ts';
import type { CircuitInputErrorCode } from '../src/inputs/eml-parse.ts';
import { sha256Pad } from '../src/inputs/sha-partial.ts';
import { MAX_VALUE_BYTES, inCharset } from '../src/inputs/template-locate.ts';
import { buildRegistry } from '../src/registry/merkle.ts';
import { TEMPLATE_FIELD_ORDER, templateParams } from '../src/registry/template-hash.ts';
import type { TemplateFieldName, TemplateParams } from '../src/registry/template-hash.ts';
import {
  PKG_DIR,
  REPO_ROOT,
  TEST_ISSUER_STEM,
  buildRegistries,
  loadCities,
  loadIssuers,
  writeRegistries,
} from './build-registry.ts';
import type { LoadedIssuer } from './build-registry.ts';

/** The step a failure is reported under: `make-test-fixtures: <step>: <message|code>`. */
let currentStep = 'startup';

/** The key every fixture is signed with, and the one outside the registry `other-issuer` uses. */
const KEY_OPTIONS = { modulusLength: 2048, publicExponent: 0x10001 };

/** The four signed header fields, in the order the signature's `h=` tag lists them. */
const SIGNED_HEADERS = 'from:to:subject:date:message-id';

/** The `Date` header every fixture carries; nothing checks it, so it is fixed, not a clock read. */
const FIXTURE_DATE = 'Wed, 04 Nov 2026 10:00:00 +0000';

/** The draft's `b=` value: `canonicalSignedHeader` empties it, and a signature needs one to parse. */
const SIGNATURE_PLACEHOLDER = 'AAAA';

/** The subject every fixture carries, bar `header-field`, which appends its booking reference. */
const SUBJECT = 'Fixture booking confirmation';

/** The domain the outside key signs under: never an allowlisted issuer (AAP 0.5.5). */
const OTHER_DOMAIN = 'other-issuer.test';

/** The fixture city, so criterion 1 has two valid accounts in one city (AAP 0.5.5). */
const FIXTURE_CITY = 'lisbon';

/** The published salt the input generator is exercised with; no nullifier value is asserted here. */
const NULLIFIER_SALT = '1';

/** The city's slot in every `[4]` circuit array, and so in the parameters a template produces. */
const CITY_FIELD = 0;

/** The quoted-printable width: 74 plus the ` =` a wrap adds keeps every encoded line under 76. */
const WRAP_WIDTH = 74;

/** The quoted-printable escape byte, which no plain-text fixture line may carry. */
const EQUALS = 0x3d;

/** The days a stay may span before the API answers `422 stay_out_of_range` (AAP 0.5.4). */
const MAX_STAY_DAYS = 120;

/** One day in milliseconds, the unit a stay's length is taken in. */
const DAY_MS = 86_400_000;

/** The ten digits, in the order `tampered.eml` walks them when it moves the departure day's last one. */
const DIGITS = '0123456789'.split('');

/** The month names, the month abbreviations and the weekdays of `date_parse.circom`, in table order. */
const MONTH_NAMES =
  'January February March April May June July August September October November December'.split(
    ' ',
  );
const MONTH_ABBREVIATIONS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** Indexed by `Date#getUTCDay`, which counts from Sunday. */
const WEEKDAYS = 'Sun Mon Tue Wed Thu Fri Sat'.split(' ');

/** One date of a stay: a calendar date the template's layout renders, or text written as given. */
type StayDate = { readonly year: number; readonly month: number; readonly day: number } | string;

/** One stay a fixture proves: its guest, its booking reference and its dates. */
interface StaySpec {
  readonly guest: string;
  readonly reference: string;
  readonly arrival: StayDate;
  readonly departure: StayDate;
}

/**
 * The two stays the tests and the end-to-end runs set the test clock inside (AAP 0.5.5). They share the fixture city
 * and overlap, so criterion 1 has two valid accounts to propose between. Renewing them is an edit to this table plus a
 * fixtures run, because the fixtures, the issuer key and the test registry are rewritten together.
 */
const VALID: StaySpec = {
  guest: 'Fixture Marlow Quenby',
  reference: 'FIXTURE-7Q4K9M2X',
  arrival: { year: 2026, month: 11, day: 2 },
  departure: { year: 2027, month: 2, day: 27 },
};

const VALID_SECOND: StaySpec = {
  guest: 'Fixture Ines Thackeray',
  reference: 'FIXTURE-3H8N5W1R',
  arrival: { year: 2026, month: 11, day: 5 },
  departure: { year: 2027, month: 3, day: 1 },
};

/** The stay of the outside key's message, in the same city as the two valid ones. */
const OTHER_ISSUER: StaySpec = {
  guest: 'Fixture Rowan Ashdown',
  reference: 'FIXTURE-9K2OTHER4',
  arrival: { year: 2026, month: 11, day: 10 },
  departure: { year: 2027, month: 1, day: 20 },
};

/**
 * The long boilerplate of `valid.eml`: distinctive fictional prose whose text criterion 3 searches the request body
 * for. It carries no `=` and none of the four anchors, and it is long enough that the padded body needs the 960-byte
 * tail window `valid.eml` exists to exercise.
 */
const LONG_BOILERPLATE: readonly string[] = [
  'Thank you for booking with Fixture Stays. This confirmation repeats every detail our reservation record holds for your stay, and it is the only document the property needs at the desk.',
  'The property is a quiet guesthouse on the corner of Rua das Oliveiras and Travessa do Sossego, four streets up from the tram stop. Reception is open from eight in the morning until ten at night, and a night porter answers the bell outside those hours. Your room is on the second floor, at the end of the corridor, and the key card is waiting in an envelope with your name on it.',
  'Please read the house notes before you arrive. Breakfast is served in the courtyard between seven and ten thirty, and there is a small kitchen on the ground floor that guests may use at any time. The wifi password is printed on the back of the key card holder. Towels are exchanged on request, and the laundry room beside the stairs takes coins.',
  'Free cancellation applies until seven days before your arrival. After that date the first night is charged, and the remaining nights are refunded within five working days. The city tax is collected by the property when you leave. If your plans change, write to the address in the footer and a member of the reservations team will answer within one working day.',
];

/**
 * The short boilerplate of `valid-second.eml` and the adversarial bodies: the same voice, sized so the whole padded
 * body fits the window and no SHA-256 precompute is needed (AAP 0.5.5).
 */
const SHORT_BOILERPLATE: readonly string[] = [
  'Thank you for booking with Fixture Stays. Your reservation is confirmed and the property has been notified of your dates. Keep this message for your own records.',
];

/**
 * The lines after the guest line of the long body `valid.eml` carries, and so of `tampered.eml`, which shares its
 * bytes: they sit inside the 960-byte window the circuit hashes.
 */
const LONG_FOOTER: readonly string[] = [
  'Fixture Stays Reservations, 1 Example Bay, Example Port',
  'This message was generated for a Tablemate circuit fixture and describes no real booking.',
];

/** The lines the short bodies close with. */
const SHORT_FOOTER: readonly string[] = [
  'Fixture Stays Reservations, 1 Example Bay',
  'This message was generated for a Tablemate circuit fixture.',
];

/** One fixture to generate: the stay it proves, the body that wraps it, and the variation it needs. */
interface FixtureSpec {
  /** The fixture's stem, which its `Message-ID` carries and a failure names. */
  readonly name: string;
  /** Its path below `fixtures/test-issuer/`; the five adversarial bodies sit in their own folder. */
  readonly path: string;
  readonly stay: StaySpec;
  readonly subject: string;
  readonly boilerplate: readonly string[];
  readonly footer: readonly string[];
  /** The city alias the `city` anchor is followed by, in the bytes the template's charset admits. */
  readonly city: string;
  /** Write the city line twice, so the anchor occurs twice and the field has no unique boundary. */
  readonly duplicateCity?: boolean;
  /** Leave the reference line out, so the anchor sits only in the signed `Subject` header. */
  readonly omitReference?: boolean;
  /** Headers appended below the signed ones, which no `h=` entry therefore covers. */
  readonly extraHeaders?: readonly string[];
}

/** The key and identity one message is signed with. */
interface Signer {
  readonly domain: string;
  readonly selector: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/** One generated fixture and its path below `fixtures/test-issuer/`. */
interface FixtureFile {
  readonly name: string;
  readonly eml: Buffer;
}

/** `list[index]`, or a failure naming what was missing; every list here is one the script built. */
function at<T>(list: readonly T[], index: number, what: string): T {
  const value = list[index];
  if (value === undefined) throw new Error(`no ${what} at ${index}`);
  return value;
}

/**
 * A calendar date in one of the four layouts `date_parse.circom` reads, byte for byte as its grammar writes them:
 * `2026-03-04`, `4 March 2026`, `March 4, 2026` and `Wed, 4 Mar 2026`. The day carries no leading zero, the names are
 * the circuit's capitalised English tables, and the weekday is the real one for the date.
 *
 * @throws {Error} When the layout needs a month name a month above 12 has none of.
 */
function formatDate(year: number, month: number, day: number, format: DateFormat): string {
  const zeros = (value: number, width: number): string => String(value).padStart(width, '0');
  switch (format) {
    case 'ISO_YMD':
      return `${zeros(year, 4)}-${zeros(month, 2)}-${zeros(day, 2)}`;
    case 'D_MONTH_YYYY':
      return `${day} ${at(MONTH_NAMES, month - 1, 'month names')} ${year}`;
    case 'MONTH_D_YYYY':
      return `${at(MONTH_NAMES, month - 1, 'month names')} ${day}, ${year}`;
    case 'DOW_D_MON_YYYY':
      return `${at(WEEKDAYS, new Date(Date.UTC(year, month - 1, day)).getUTCDay(), 'weekdays')}, ${day} ${at(MONTH_ABBREVIATIONS, month - 1, 'month abbreviations')} ${year}`;
  }
}

/** A stay date as the body carries it: a calendar date rendered, or text written as given. */
function renderDate(value: StayDate, format: DateFormat): string {
  return typeof value === 'string' ? value : formatDate(value.year, value.month, value.day, format);
}

/** The text a field's anchor is followed by, in the template's own date layout. */
function fieldValue(template: IssuerTemplate, spec: FixtureSpec, field: TemplateFieldName): string {
  switch (field) {
    case 'city':
      return spec.city;
    case 'arrival':
      return renderDate(spec.stay.arrival, template.dateFormat);
    case 'departure':
      return renderDate(spec.stay.departure, template.dateFormat);
    case 'reference':
      return spec.stay.reference;
  }
}

/**
 * A field line: the template's anchor, the value, and the terminator byte — which for the configured template is a
 * carriage return, so the line ends `\r\r\n` once the body's own CRLF follows it.
 */
function fieldLine(template: IssuerTemplate, field: TemplateFieldName, value: string): string {
  const { anchor, terminator } = template.fields[field];
  return `${anchor}${value}${String.fromCharCode(terminator)}`;
}

/**
 * Checks a value against the template exactly as `FieldExtract` does (AAP 0.5.5): 1-32 bytes, every one of them in the
 * field's charset, and none of them the terminator, which would shorten the value and move the field's boundary.
 * Nothing about the value reaches the message (AAP 0.12.2).
 */
function assertFieldValue(template: IssuerTemplate, field: TemplateFieldName, value: string): void {
  const { terminator, charset } = template.fields[field];
  const bytes = [...value].map((character) => character.charCodeAt(0));
  if (bytes.length < 1 || bytes.length > MAX_VALUE_BYTES) {
    throw new Error(`the ${field} value is ${bytes.length} bytes, not 1-${MAX_VALUE_BYTES}`);
  }
  for (const byte of bytes) {
    if (byte === terminator || !inCharset(byte, CHARSET_CODE[charset])) {
      throw new Error(`the ${field} value carries a byte its charset or its terminator forbids`);
    }
  }
}

/** Refuses text that repeats a field's anchor, which would leave that field with no unique boundary. */
function assertNoAnchor(template: IssuerTemplate, text: readonly string[]): void {
  for (const field of TEMPLATE_FIELD_ORDER) {
    const anchor = template.fields[field].anchor;
    if (text.some((line) => line.includes(anchor))) {
      throw new Error(`the fixture text repeats the ${field} anchor`);
    }
  }
}

/**
 * Refuses a stay outside the 1-120 day rule the API enforces (AAP 0.5.4), which the fixtures would otherwise only
 * discover after a proving run. A date no calendar has — a 30 February, a month 13, or text written as given — leaves
 * the check alone: what refuses those fixtures is the circuit's own date parse.
 */
function assertStay(stay: StaySpec): void {
  const arrival = typeof stay.arrival === 'string' ? null : calendarInstant(stay.arrival);
  const departure = typeof stay.departure === 'string' ? null : calendarInstant(stay.departure);
  if (arrival === null || departure === null) return;
  const days = (departure - arrival) / DAY_MS;
  if (days < 1 || days > MAX_STAY_DAYS) {
    throw new Error(`the stay is ${days} days, not 1-${MAX_STAY_DAYS}`);
  }
}

/** A calendar date as a UTC instant, or `null` for one that does not exist in any calendar. */
function calendarInstant(date: Exclude<StayDate, string>): number | null {
  if (!Number.isInteger(date.month) || date.month < 1 || date.month > 12) return null;
  const instant = Date.UTC(date.year, date.month - 1, date.day);
  const landed = new Date(instant);
  // A day past the month's end rolls into the next month, which is how a 30 February is caught.
  if (landed.getUTCMonth() !== date.month - 1 || landed.getUTCDate() !== date.day) return null;
  return instant;
}

/**
 * A rendered stay date as a UTC instant, or `null` for text in another layout or a day no month has. Only the `ISO_YMD`
 * layout the test template must use reaches a date: `main` refuses any other, and a value of any other shape is
 * refused here rather than read as a date it does not spell.
 */
function renderedInstant(value: string): number | null {
  const parts = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (parts === null) return null;
  return calendarInstant({
    year: Number(at(parts, 1, 'year digits')),
    month: Number(at(parts, 2, 'month digits')),
    day: Number(at(parts, 3, 'day digits')),
  });
}

/** The length of a stay whose departure is a rendered value, or `null` when either date is not. */
function renderedStayDays(arrival: StayDate, departure: string): number | null {
  if (typeof arrival === 'string') return null;
  const start = calendarInstant(arrival);
  const end = renderedInstant(departure);
  return start === null || end === null ? null : (end - start) / DAY_MS;
}

/**
 * The departure value `tampered.eml` carries: the rendered one with its last digit advanced, one digit at a time and
 * wrapping past nine, to the first that still names a real calendar date with a stay of 1-120 days. A digit the field's
 * charset or the calendar would refuse, or a stay the API would answer `422 stay_out_of_range` for, would leave the
 * fixture failing a check other than its body hash, and would no longer show that the circuit's body-hash binding is
 * what rejects it (AAP 0.5.5).
 *
 * @throws {Error} When the rendered value ends in no digit, or no digit keeps the stay a real date.
 */
function tamperedDepartureValue(stay: StaySpec, format: DateFormat): string {
  const value = renderDate(stay.departure, format);
  const start = DIGITS.indexOf(value.slice(-1));
  if (start < 0) throw new Error('the departure value ends in no digit');
  for (let step = 1; step < DIGITS.length; step += 1) {
    const digit = at(DIGITS, (start + step) % DIGITS.length, 'digits');
    const candidate = `${value.slice(0, -1)}${digit}`;
    const days = renderedStayDays(stay.arrival, candidate);
    if (days !== null && days >= 1 && days <= MAX_STAY_DAYS) return candidate;
  }
  throw new Error(
    `no last digit keeps the departure a real date with a stay of 1-${MAX_STAY_DAYS} days`,
  );
}

/**
 * Wraps quoted-printable text with a soft line break — `= CR LF` — at every `WRAP_WIDTH`, so no encoded line exceeds
 * the 76 characters RFC 2045 §6.7 allows. The break follows a space the reader keeps, so removing the soft breaks
 * returns the text with its single spaces intact, and no `=` in the plain text means the wrap is the only escape byte
 * the body carries.
 *
 * @throws {Error} When the text carries an `=` or is padded with whitespace, either of which would make the encoding
 *   ambiguous.
 */
function qpWrap(text: string, width = WRAP_WIDTH): string[] {
  if (text.includes('=') || text.trim() !== text || text === '') {
    throw new Error('quoted-printable text must be unpadded, non-empty and free of =');
  }
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(`${line} =`);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Renders one fixture body (AAP 0.5.5): the boilerplate, the four field lines in template order, the guest line and the
 * footer, every line CRLF-terminated. A field line is never wrapped — a soft break inside one would move its
 * terminator — and the text outside the fields is checked for a repeated anchor, which would leave that field with no
 * unique boundary.
 */
function renderBody(template: IssuerTemplate, spec: FixtureSpec): string {
  assertStay(spec.stay);
  const lines = spec.boilerplate.flatMap((paragraph) => qpWrap(paragraph));
  for (const field of TEMPLATE_FIELD_ORDER) {
    if (field === 'reference' && spec.omitReference === true) continue;
    const value = fieldValue(template, spec, field);
    assertFieldValue(template, field, value);
    lines.push(fieldLine(template, field, value));
    if (field === 'city' && spec.duplicateCity === true) {
      lines.push(fieldLine(template, field, value));
    }
  }
  const guestLine = `Guest: ${spec.stay.guest}`;
  lines.push(guestLine);
  for (const paragraph of spec.footer) lines.push(...qpWrap(paragraph));
  assertNoAnchor(template, [...spec.boilerplate, guestLine, ...spec.footer]);
  return `${lines.join('\r\n')}\r\n`;
}

/** One `DKIM-Signature` header line, its tags ordered so the circuit's `BodyHashRegex` can read `bh=`. */
function dkimSignatureHeader(signer: Signer, bodyHash: string, value: string): string {
  return (
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${signer.domain}; s=${signer.selector}; ` +
    `h=${SIGNED_HEADERS}; bh=${bodyHash}; b=${value}`
  );
}

/** The message bytes: the headers, the blank line, then the body, every line CRLF-terminated. */
function assemble(signer: Signer, spec: FixtureSpec, body: string, dkimHeader: string): Buffer {
  const headers = [
    dkimHeader,
    `From: Fixture Stays <bookings@${signer.domain}>`,
    `To: ${spec.stay.guest} <guest@example.test>`,
    `Subject: ${spec.subject}`,
    `Date: ${FIXTURE_DATE}`,
    `Message-ID: <fixture-${spec.name}@${signer.domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    ...(spec.extraHeaders ?? []),
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'latin1');
}

/**
 * Signs one fixture (AAP 0.5.5). The draft carries a placeholder `b=`, which canonicalization empties anyway, so the
 * bytes signed and the bytes a verifier recomputes are the same once the real base64 signature replaces it. The
 * finished message is re-parsed and checked before it is returned.
 */
function renderMessage(template: IssuerTemplate, signer: Signer, spec: FixtureSpec): Buffer {
  const body = renderBody(template, spec);
  const hashBase64 = Buffer.from(
    computeBodyHash(canonicalizeBody(Buffer.from(body, 'latin1'), 'relaxed')),
  ).toString('base64');
  const draft = parseEml(
    assemble(signer, spec, body, dkimSignatureHeader(signer, hashBase64, SIGNATURE_PLACEHOLDER)),
  );
  const signedHeader = canonicalSignedHeader(draft, at(draft.signatures, 0, 'DKIM signatures'));
  const signature = sign('sha256', signedHeader, signer.privateKey).toString('base64');
  const message = assemble(signer, spec, body, dkimSignatureHeader(signer, hashBase64, signature));
  assertSigned(message, signer, spec.name);
  return message;
}

/**
 * Checks a finished fixture: the RSA signature over the canonical header verifies under the key the issuer record will
 * carry, the body hashes to the `bh=` it commits to, and the header fits its bound.
 */
function assertSigned(message: Buffer, signer: Signer, name: string): void {
  const parsed = parseEml(message);
  const signature = at(parsed.signatures, 0, 'DKIM signatures');
  const signedHeader = canonicalSignedHeader(parsed, signature);
  if (!verify('sha256', signedHeader, signer.publicKey, signature.b)) {
    throw new Error(`${name}.eml: the RSA signature does not verify`);
  }
  verifyBodyHash(canonicalizeBody(parsed.body, signature.c.body), signature);
  try {
    sha256Pad(signedHeader, MAX_HEADER_LENGTH);
  } catch {
    throw new Error(`${name}.eml: the signed header exceeds ${MAX_HEADER_LENGTH} bytes`);
  }
}

/**
 * The modulus as `DkimKey.modulusBase64` records it (AAP 0.5.5): standard base64 of the unsigned big-endian modulus
 * with no leading zero byte, the encoding `../src/registry/leaves.ts` decodes and `./fetch-dkim-key.ts` writes. It comes
 * from the JWK export, so the private key is never read.
 */
function modulusBase64Of(publicKey: KeyObject): string {
  const n = (publicKey.export({ format: 'jwk' }) as { n?: unknown }).n;
  if (typeof n !== 'string') throw new Error('the generated key carries no JWK modulus');
  const bytes = Buffer.from(n, 'base64url');
  const start = bytes.findIndex((byte) => byte !== 0);
  if (start < 0) throw new Error('the generated key carries a zero modulus');
  return bytes.subarray(start).toString('base64');
}

/**
 * The city's first alias the template can carry (AAP 0.5.5): 1-32 bytes, every one of them in the city field's charset,
 * none of them its terminator, and none needing a quoted-printable escape. Only soft line breaks are removed from the
 * window the circuit reads, so an alias written with an escape (a non-ASCII name, or any `=`) would appear there as
 * bytes the field cannot hold.
 */
function chooseAlias(city: CityConfig, template: IssuerTemplate, params: TemplateParams): string {
  const charset = at(params.charset, CITY_FIELD, 'city charset');
  const terminator = at(params.terminator, CITY_FIELD, 'city terminator');
  const carries = (alias: string): boolean =>
    alias.length >= 1 &&
    alias.length <= MAX_VALUE_BYTES &&
    [...alias].every((character) => {
      const byte = character.charCodeAt(0);
      return (
        byte >= 0x20 &&
        byte <= 0x7e &&
        byte !== EQUALS &&
        byte !== terminator &&
        inCharset(byte, charset)
      );
    });
  const alias = city.aliases.find(carries);
  if (alias === undefined) {
    throw new Error(`config/cities.json: city ${city.id} has no alias the city field can carry`);
  }
  return alias;
}

/**
 * The records the test registry takes production leaves from: every other `verified` record, with the placeholder keys
 * the registry builder drops (AAP 0.5.5). The selection mirrors `buildRegistries`, so the in-memory root and the written
 * one are the same value.
 */
function productionIssuers(issuers: readonly LoadedIssuer[]): IssuerConfig[] {
  return issuers
    .filter(
      (issuer) =>
        issuer.stem !== TEST_ISSUER_STEM && issuer.config.verificationStatus === 'verified',
    )
    .map((issuer) => ({
      ...issuer.config,
      keys: issuer.config.keys.filter((key) => key.modulusBase64.trim() !== ''),
    }));
}

/**
 * Checks one fixture's body window (AAP 0.5.5): that the padded body needs the precomputed tail the fixture exists for,
 * and that every field's anchor is inside the window the circuit hashes.
 */
function checkWindow(
  template: IssuerTemplate,
  name: string,
  eml: Buffer,
  issuers: readonly SupportedIssuer[],
  precomputed: boolean,
): void {
  const parts = buildEmailVerifierInputs(eml, issuers);
  const used = parts.precomputeCut > 0;
  if (used !== precomputed) {
    throw new Error(`${name}: the window is ${used ? 'a precomputed tail' : 'the whole body'}`);
  }
  for (const field of TEMPLATE_FIELD_ORDER) {
    const anchor = Buffer.from(template.fields[field].anchor, 'latin1');
    if (indexOfBytes(parts.emailBody, anchor) < 0) {
      throw new Error(`${name}: the ${field} anchor is outside the body window`);
    }
  }
}

/**
 * Checks what makes `tampered.eml` the fixture criterion 3 needs (AAP 0.5.5): it is `valid.eml` byte for byte except
 * one, that byte lies inside the departure value, the value it changed sits inside the body window the circuit hashes,
 * and the signature the two files share still verifies. Nothing but the body hash can then separate a proof of one
 * message from a proof of the other, and the change cannot be hidden in the precomputed SHA-256 prefix, which is a
 * private input.
 *
 * @throws {Error} When any of those properties does not hold.
 */
function checkTampered(
  template: IssuerTemplate,
  valid: Buffer,
  tampered: Buffer,
  publicKey: KeyObject,
  window: Uint8Array,
): void {
  if (valid.length !== tampered.length) {
    throw new Error(`tampered.eml is ${tampered.length} bytes, not valid.eml's ${valid.length}`);
  }
  const changed: number[] = [];
  for (let index = 0; index < valid.length; index += 1) {
    if (valid[index] !== tampered[index]) changed.push(index);
  }
  if (changed.length !== 1) {
    throw new Error(`tampered.eml differs from valid.eml in ${changed.length} bytes, not one`);
  }
  const anchor = Buffer.from(template.fields.departure.anchor, 'latin1');
  const anchorIndex = indexOfBytes(valid, anchor);
  if (anchorIndex < 0) throw new Error('valid.eml carries no departure anchor');
  const valueStart = anchorIndex + anchor.length;
  const valueEnd = valid.indexOf(template.fields.departure.terminator, valueStart);
  if (valueEnd < 0) throw new Error('valid.eml: the departure value carries no terminator');
  const index = at(changed, 0, 'changed bytes');
  if (index < valueStart || index >= valueEnd) {
    throw new Error('tampered.eml: the changed byte is outside the departure value');
  }
  if (indexOfBytes(window, valid.subarray(valueStart, valueEnd)) < 0) {
    throw new Error(
      'tampered.eml: the departure value is outside the body window the circuit hashes',
    );
  }
  const parsed = parseEml(tampered);
  const signature = at(parsed.signatures, 0, 'DKIM signatures');
  if (!verify('sha256', canonicalSignedHeader(parsed, signature), publicKey, signature.b)) {
    throw new Error('tampered.eml: the signature the two files share no longer verifies');
  }
}

/** Checks that the input generator refuses a fixture for the reason the circuit's tests expect. */
function expectCode(
  issuer: IssuerConfig,
  registry: RegistryFile,
  name: string,
  eml: Buffer,
  expected: CircuitInputErrorCode,
): void {
  try {
    buildCircuitInputs(eml, [issuer], registry, { nullifierSalt: NULLIFIER_SALT });
  } catch (error) {
    if (error instanceof CircuitInputError) {
      if (error.code === expected) return;
      throw new Error(`${name}: refused as ${error.code}, not ${expected}`);
    }
    throw error;
  }
  throw new Error(`${name}: built inputs, but ${expected} was expected`);
}

/** One fixture's line: its size, its padded body length and the window the circuit would hash. */
function summaryOf(file: FixtureFile): string {
  const parsed = parseEml(file.eml);
  const body = canonicalizeBody(parsed.body, at(parsed.signatures, 0, 'DKIM signatures').c.body);
  const { paddedLength } = sha256Pad(body, 64 * Math.ceil((body.length + 9) / 64));
  const window = paddedLength > MAX_BODY_WINDOW ? `${MAX_BODY_WINDOW}-byte tail` : 'whole body';
  return `${file.name}: ${file.eml.length} bytes, padded body ${paddedLength}, window ${window}`;
}

/** Generates the keys, fixtures, issuer record and registries (AAP 0.4.2, AAP 0.5.5, AAP 0.8.1). */
async function main(): Promise<void> {
  try {
    currentStep = 'configuration';
    const [issuers, cities] = await Promise.all([loadIssuers(), loadCities()]);
    const record = issuers.find((issuer) => issuer.stem === TEST_ISSUER_STEM);
    if (record === undefined) throw new Error(`config/issuers/${TEST_ISSUER_STEM}.json is missing`);
    const template = record.config.template;
    if (template === null) {
      throw new Error('config/issuers/tablemate-test.json has no template; author it first');
    }
    const params = templateParams(template);
    const domain = record.config.keys[0]?.domain ?? 'tablemate.test';
    const selector = record.config.keys[0]?.selector ?? 'fixture';
    const city =
      cities.cities.find((entry) => entry.id === FIXTURE_CITY) ?? at(cities.cities, 0, 'cities');
    const alias = chooseAlias(city, template, params);
    currentStep = 'keys';
    const test = generateKeyPairSync('rsa', KEY_OPTIONS);
    const outside = generateKeyPairSync('rsa', KEY_OPTIONS);
    const modulusBase64 = modulusBase64Of(test.publicKey);
    const outsideModulusBase64 = modulusBase64Of(outside.publicKey);
    currentStep = 'fixtures';
    const signer: Signer = {
      domain,
      selector,
      privateKey: test.privateKey,
      publicKey: test.publicKey,
    };
    if (template.dateFormat !== 'ISO_YMD') {
      throw new Error(
        'the date-month-13 fixture needs a numeric date format, so the test template must use ISO_YMD',
      );
    }
    const arrival = renderDate(VALID.arrival, template.dateFormat);
    const nonDigit = arrival.replace(/[0-9]/, 'O');
    if (nonDigit === arrival) throw new Error('the arrival date carries no digit to replace');
    // The three dates no calendar has: the circuit's `DateParse` is what refuses them, and each one differs from the
    // honest body in that value alone.
    const feb30: StaySpec = { ...VALID, arrival: { year: 2026, month: 2, day: 30 } };
    const month13: StaySpec = { ...VALID, arrival: { year: 2026, month: 13, day: 5 } };
    const badDigit: StaySpec = { ...VALID, arrival: nonDigit };
    // The bodies that differ from the short layout only in the one variation that names them.
    const shared = {
      boilerplate: SHORT_BOILERPLATE,
      footer: SHORT_FOOTER,
      city: alias,
      subject: SUBJECT,
    };
    const specs: readonly FixtureSpec[] = [
      {
        name: 'valid',
        path: 'valid.eml',
        stay: VALID,
        boilerplate: LONG_BOILERPLATE,
        footer: LONG_FOOTER,
        city: alias,
        subject: SUBJECT,
      },
      { name: 'valid-second', path: 'valid-second.eml', stay: VALID_SECOND, ...shared },
      {
        name: 'duplicate-anchor',
        path: 'adversarial/duplicate-anchor.eml',
        stay: VALID_SECOND,
        ...shared,
        duplicateCity: true,
      },
      {
        name: 'header-field',
        path: 'adversarial/header-field.eml',
        stay: VALID_SECOND,
        ...shared,
        omitReference: true,
        subject: `${SUBJECT}. ${template.fields.reference.anchor}${VALID_SECOND.reference}`,
      },
      { name: 'date-feb-30', path: 'adversarial/date-feb-30.eml', stay: feb30, ...shared },
      { name: 'date-month-13', path: 'adversarial/date-month-13.eml', stay: month13, ...shared },
      { name: 'date-non-digit', path: 'adversarial/date-non-digit.eml', stay: badDigit, ...shared },
    ];
    const generated = new Map<string, Buffer>();
    const bytes = (name: string): Buffer => {
      const found = generated.get(name);
      if (found === undefined) throw new Error(`${name} was not generated`);
      return found;
    };
    for (const spec of specs) generated.set(spec.path, renderMessage(template, signer, spec));
    // Not listed in `h=`, so the signature does not cover it: a test reads it to build a rogue registry whose root
    // the API never publishes (AAP 0.5.5).
    generated.set(
      'other-issuer.eml',
      renderMessage(
        template,
        {
          ...signer,
          domain: OTHER_DOMAIN,
          privateKey: outside.privateKey,
          publicKey: outside.publicKey,
        },
        {
          name: 'other-issuer',
          path: 'other-issuer.eml',
          stay: OTHER_ISSUER,
          ...shared,
          extraHeaders: [`X-Tablemate-Fixture-Key: ${outsideModulusBase64}`],
        },
      ),
    );
    // `tampered.eml` is the signed `valid.eml` bytes with one byte of the departure date changed after that signature
    // was made: nothing else differs, so the header still verifies under the test key and the body no longer hashes to
    // the `bh=` it commits to (criterion 3). The changed byte has to sit inside the 960-byte tail the circuit hashes,
    // because the precomputed SHA-256 prefix state is a private input a prover may state dishonestly.
    const departureLine = fieldLine(
      template,
      'departure',
      renderDate(VALID.departure, template.dateFormat),
    );
    const signedValid = bytes('valid.eml').toString('latin1');
    if (signedValid.split(departureLine).length !== 2) {
      throw new Error('valid.eml must carry its departure line exactly once');
    }
    generated.set(
      'tampered.eml',
      Buffer.from(
        signedValid.replace(
          departureLine,
          fieldLine(template, 'departure', tamperedDepartureValue(VALID, template.dateFormat)),
        ),
        'latin1',
      ),
    );
    currentStep = 'checks';
    const issuer: IssuerConfig = IssuerConfig.parse({
      issuerId: record.config.issuerId,
      displayName: record.config.displayName,
      verificationStatus: record.config.verificationStatus,
      keys: [{ domain, selector, modulusBase64 }],
      template,
    });
    // The outside key's message is checked against a record of its own: it is not an allowlisted issuer, so the test
    // issuer's keys would not select its signature at all.
    const outsideIssuer: SupportedIssuer = {
      issuerId: issuer.issuerId,
      displayName: issuer.displayName,
      keys: [{ domain: OTHER_DOMAIN, selector, modulusBase64: outsideModulusBase64 }],
      template,
    };
    const registry = RegistryFile.parse(
      buildRegistry({
        name: 'test',
        issuers: [...productionIssuers(issuers), issuer],
        cities: cities.cities,
      }).registry,
    );
    // Both valid fixtures must build inputs, and the two ids they prove must be the ones the registry recorded: the
    // city the alias belongs to and the issuer whose key signed them (AAP 0.5.5).
    for (const name of ['valid.eml', 'valid-second.eml']) {
      const built = buildCircuitInputs(bytes(name), [issuer], registry, {
        nullifierSalt: NULLIFIER_SALT,
      });
      if (built.cityId !== city.circuitCityId || built.issuerId !== issuer.issuerId) {
        throw new Error(
          `${name} proves city ${built.cityId} and issuer ${built.issuerId}, not ${city.circuitCityId} and ${issuer.issuerId}`,
        );
      }
    }
    // `tampered.eml` and `header-field.eml` are absent here: the first fails its body hash before a window exists,
    // and the second omits its reference anchor from the body on purpose.
    for (const [name, precomputed] of [
      ['valid.eml', true],
      ['valid-second.eml', false],
      ['other-issuer.eml', false],
      ['adversarial/duplicate-anchor.eml', false],
      ['adversarial/date-feb-30.eml', false],
      ['adversarial/date-month-13.eml', false],
      ['adversarial/date-non-digit.eml', false],
    ] as const) {
      checkWindow(template, name, bytes(name), [issuer, outsideIssuer], precomputed);
    }
    // `tampered.eml` is checked outside that loop because it is not a message of its own: it keeps `valid.eml`'s
    // signature, so what has to hold is that one byte differs, inside the departure value, inside the hashed window.
    checkTampered(
      template,
      bytes('valid.eml'),
      bytes('tampered.eml'),
      test.publicKey,
      buildEmailVerifierInputs(bytes('valid.eml'), [issuer, outsideIssuer]).emailBody,
    );
    // The three date fixtures parse, pass DKIM and build EmailVerifier inputs; what refuses them is the circuit's own
    // date parse, so no code is asserted for them (AAP 0.5.5).
    for (const [name, code] of [
      ['tampered.eml', 'body_hash_mismatch'],
      ['other-issuer.eml', 'unsupported_issuer'],
      ['adversarial/duplicate-anchor.eml', 'field_ambiguous'],
      ['adversarial/header-field.eml', 'field_not_found'],
    ] as const) {
      expectCode(issuer, registry, name, bytes(name), code);
    }
    // The one check that needs the registry builder runs here, while every input is still in memory and nothing has
    // been written: it passes the freshly generated record in rather than letting the builder read the file, because
    // the file on disk still holds the previous run's modulus and the test root is a function of that modulus.
    const rebuilt = await buildRegistries({ testIssuer: issuer });
    if (rebuilt.test.root !== registry.root) {
      throw new Error(
        `config/registry/test.json: the generated record builds test root ${rebuilt.test.root}, not the fixture registry's ${registry.root}`,
      );
    }
    currentStep = 'writes';
    const directory = path.join(PKG_DIR, 'fixtures', 'test-issuer');
    const files: readonly FixtureFile[] = [...generated].map(([name, eml]) => ({ name, eml }));
    // Read before the writes for the reason the checks are: a message that cannot be summarised must not leave the
    // tree already rewritten.
    const summaries = files.map((file) => summaryOf(file));
    for (const file of files) {
      const target = path.join(directory, file.name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.eml);
    }
    await writeFile(
      path.join(REPO_ROOT, 'config', 'issuers', `${TEST_ISSUER_STEM}.json`),
      `${JSON.stringify(issuer, null, 2)}\n`,
      'utf8',
    );
    const written = await writeRegistries();
    for (const line of summaries) process.stdout.write(`${line}\n`);
    const changed =
      written.changed.length === 0
        ? 'both files already current'
        : `rewrote ${written.changed.join(', ')}`;
    process.stdout.write(`d=${domain} s=${selector} registry: ${changed}\n`);
  } catch (error) {
    const reason =
      error instanceof CircuitInputError
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`make-test-fixtures: ${currentStep}: ${reason}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
