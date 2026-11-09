/**
 * Where the four stay fields sit in the soft-line-break-decoded body window, and whether the dates they
 * hold are readable (AAP 0.5.5).
 *
 * The off-circuit half of the extraction layer: it mirrors three circuit rules exactly, so a message the
 * circuit cannot accept is refused on the device with a code instead of failing later, inside witness
 * generation.
 *
 * - `RemoveSoftLineBreaks(maxLength)` of `@zk-email/circuits` 6.3.4: {@link removeSoftLineBreaks} drops
 *   every `=` CR LF triple that fits inside the window and compacts the rest. Quoted-printable escapes such
 *   as `=3D` are left alone, which is why a city alias is configured as the bytes it has in the decoded
 *   body.
 * - `FieldExtract(1024, 32, 32)` and `TmCharsetMember` in `circuits/lib/anchor_extract.circom`:
 *   {@link locateField} reports the one anchor position and the one value length the circuit accepts, and
 *   {@link inCharset} implements the four sets `CHARSET_CODE` names.
 * - `DateParse` in `circuits/lib/date_parse.circom`: {@link parseDateValue} applies its four date layouts
 *   and its year, month and day bounds, answering `null` for a value it would reject.
 *
 * Mirrored exactly and never tightened: a message the circuit accepts must be accepted here, because a
 * false refusal on the device blocks an email that would have proved.
 *
 * Error privacy: a refusal reports a `CircuitInputError` code and the field's slot name, never a value, an
 * anchor or an offset; malformed template parameters, which are configuration rather than message content,
 * raise a `RangeError`.
 *
 * Client-safe: it runs under Hermes (React Native 0.76.9) through `./build-inputs.ts` and in the browser Web
 * Worker, so it imports `./eml-parse.ts`, `../registry/template-hash.ts` and the shared contract only.
 */
import type { TemplateFieldName, TemplateParams } from '../registry/template-hash.ts';

import { CHARSET_CODE, DATE_FORMAT_CODE } from '@tablemate/shared';

import { TEMPLATE_FIELD_ORDER } from '../registry/template-hash.ts';
import { bytesToLatin1, fail } from './eml-parse.ts';

/** The decoded body window's length in bytes: `FieldExtract`'s `maxLen`, and the window array's width. */
export const DECODED_WINDOW_BYTES = 1024;

/** The anchor bound in bytes: `FieldExtract`'s `maxAnchor`, and the width an anchor is zero-padded to. */
export const MAX_ANCHOR_BYTES = 32;

/** The value bound in bytes: `FieldExtract`'s `maxValue`, and the width a located value is padded to. */
export const MAX_VALUE_BYTES = 32;

/** `=`, the first byte of a quoted-printable soft line break. */
const EQUALS = 0x3d;

/** CR, the second byte of a soft line break. */
const CR = 0x0d;

/** LF, the third byte of a soft line break. */
const LF = 0x0a;

/**
 * The four field slots in {@link TEMPLATE_FIELD_ORDER} order, which is the order of every `[4]` circuit
 * array: city, arrival, departure, booking reference.
 */
const FIELD_INDEXES = [0, 1, 2, 3] as const;

/** One stay field's slot: the index of a `[4]` circuit array, and of {@link TEMPLATE_FIELD_ORDER}. */
type FieldIndex = (typeof FIELD_INDEXES)[number];

/**
 * Removes every soft line break — the three bytes `=`, CR, LF — that fits inside an encoded body window,
 * compacting the rest into its place and leaving the tail zero.
 *
 * This is `RemoveSoftLineBreaks(maxLength)` of `@zk-email/circuits` 6.3.4, whose `isSoftBreak[i]` is defined
 * for `i < maxLength - 2` only: it zeroes each break's three bytes and compacts what remains under a
 * Poseidon random linear combination, so the array returned here is the `decoded` array the circuit's
 * `EmailVerifier(..., removeSoftLineBreaks = 1)` accepts. A break cannot overlap itself, so skipping three
 * bytes at a time agrees with the circuit's per-position detection.
 *
 * The input is the whole window — the body tail, the SHA-256 `0x80` pad byte, the zero fill and the body's
 * length field — and a position past the array's own end reads as zero, which is the fill the circuit sees
 * there.
 *
 * @param encoded - The encoded body window.
 * @param maxLength - The window length in bytes, 1024 for the circuit's body bound.
 * @returns The compacted window, zero-filled to `maxLength`.
 */
export function removeSoftLineBreaks(
  encoded: Uint8Array,
  maxLength = DECODED_WINDOW_BYTES,
): Uint8Array {
  const decoded = new Uint8Array(maxLength);
  let write = 0;
  for (let i = 0; i < maxLength; i += 1) {
    if (
      i + 2 < maxLength &&
      (encoded[i] ?? 0) === EQUALS &&
      (encoded[i + 1] ?? 0) === CR &&
      (encoded[i + 2] ?? 0) === LF
    ) {
      i += 2;
      continue;
    }
    decoded[write] = encoded[i] ?? 0;
    write += 1;
  }
  return decoded;
}

/**
 * Whether a byte belongs to one of the four charsets a template may name for a field: the sets
 * `TmCharsetMember` implements, over the codes of `CHARSET_CODE`.
 *
 * `digits` is `0`-`9`; `alnum` adds `A`-`Z`, `a`-`z` and `-`; `date` adds the space and the comma the
 * English date layouts need; `text` is the printable range 0x20-0x7E together with every byte at or above
 * 0x80, so an accented place name or booking reference still extracts. Any other code selects nothing,
 * exactly as the circuit's four one-hot terms do, leaving such a field unsatisfiable; and no charset admits
 * 0x00, so a value can never run through the `0x80` pad byte into the zero fill beyond it.
 *
 * @param byte - A byte of a value; the circuit's own operand is range-checked to eight bits.
 * @param code - A `CHARSET_CODE` value.
 * @returns Whether the byte is a member of the selected charset.
 */
export function inCharset(byte: number, code: number): boolean {
  const digit = byte >= 0x30 && byte <= 0x39;
  const upper = byte >= 0x41 && byte <= 0x5a;
  const lower = byte >= 0x61 && byte <= 0x7a;
  switch (code) {
    case CHARSET_CODE.digits:
      return digit;
    case CHARSET_CODE.alnum:
      return digit || upper || lower || byte === 0x2d;
    case CHARSET_CODE.date:
      return digit || upper || lower || byte === 0x2d || byte === 0x20 || byte === 0x2c;
    case CHARSET_CODE.text:
      return (byte >= 0x20 && byte <= 0x7e) || byte >= 0x80;
    default:
      return false;
  }
}

/** One stay field's position in the decoded body window, as `FieldExtract` constrains it. */
export interface FieldLocation {
  /** The window index the field's anchor starts at: the circuit input `anchorIndex`. */
  readonly anchorIndex: number;
  /** The value's length in bytes, 1-32: the circuit input `valueLength`. */
  readonly valueLength: number;
  /**
   * The value's bytes, zero-padded to {@link MAX_VALUE_BYTES}: the circuit's `value` output, whose
   * bytes at and beyond `valueLength` are zero, which is what makes its packed encoding canonical.
   */
  readonly value: Uint8Array;
}

/**
 * One entry of a {@link TemplateParams} array, or a `RangeError` when the parameters are not the shape
 * `templateParams` produces: a malformed template is configuration, not message content.
 */
function fieldEntry<T>(values: readonly T[], fieldIndex: FieldIndex, what: string): T {
  const value = values[fieldIndex];
  if (value === undefined) {
    throw new RangeError(`template-locate: parameters carry no ${what} for field ${fieldIndex}`);
  }
  return value;
}

/** The field's slot name, the only thing about an email a `field_*` refusal reports. */
function fieldName(fieldIndex: FieldIndex): TemplateFieldName {
  return TEMPLATE_FIELD_ORDER[fieldIndex];
}

/**
 * Whether the anchor's declared bytes occur at `start`.
 *
 * `CountSubstringOccurrences(1024, 32)` slides over all 1024 window positions and reads zero past the end
 * of the window, and its match test treats a zero pattern byte as a wildcard. An anchor carries no zero byte
 * inside its length and the fill beyond a real window is zero, so a match can never extend past the window
 * and this bounds check answers exactly as the circuit does.
 */
function anchorOccursAt(
  decoded: Uint8Array,
  anchor: Uint8Array,
  anchorLength: number,
  start: number,
): boolean {
  for (let j = 0; j < anchorLength; j += 1) {
    const position = start + j;
    if (position >= DECODED_WINDOW_BYTES) return false;
    if ((decoded[position] ?? 0) !== (anchor[j] ?? 0)) return false;
  }
  return true;
}

/**
 * Locates one stay field in the decoded body window, exactly as `FieldExtract(1024, 32, 32)` does.
 *
 * The anchor must occur exactly once in the window, so no second occurrence can be selected and a field
 * whose text appears only in the headers is not found at all, headers never being scanned. The value is the
 * 1-32 bytes from the end of the anchor up to the first byte equal to the field's terminator, every one of
 * them in the field's charset and none of them the terminator, and the terminator's own index
 * (`anchorIndex + anchorLength + valueLength`, the circuit's `withinWindow`) stays below the window length.
 *
 * @param decoded - The decoded body window, exactly {@link DECODED_WINDOW_BYTES} bytes long.
 * @param params - The issuer template's circuit parameters.
 * @param fieldIndex - The field slot to locate.
 * @returns The anchor's index, the value's length and the value zero-padded to 32 bytes.
 * @throws {CircuitInputError} `field_not_found`, `field_ambiguous` or `field_invalid`, with the slot name.
 * @throws {RangeError} For a window that is not 1024 bytes, or parameters `templateParams` could not
 *   produce; both are programming errors rather than properties of an email.
 */
export function locateField(
  decoded: Uint8Array,
  params: TemplateParams,
  fieldIndex: FieldIndex,
): FieldLocation {
  if (decoded.length !== DECODED_WINDOW_BYTES) {
    throw new RangeError('template-locate: the decoded window must be 1024 bytes');
  }
  const name = fieldName(fieldIndex);
  const anchor = fieldEntry(params.anchors, fieldIndex, 'anchor');
  const anchorLength = fieldEntry(params.anchorLength, fieldIndex, 'anchorLength');
  const terminator = fieldEntry(params.terminator, fieldIndex, 'terminator');
  const charset = fieldEntry(params.charset, fieldIndex, 'charset');
  if (anchor.length !== MAX_ANCHOR_BYTES) {
    throw new RangeError('template-locate: an anchor must be 32 bytes wide');
  }
  if (!Number.isInteger(anchorLength) || anchorLength < 1 || anchorLength > MAX_ANCHOR_BYTES) {
    throw new RangeError('template-locate: an anchor length must be 1-32');
  }
  if (!Number.isInteger(terminator) || terminator < 1 || terminator > 255) {
    throw new RangeError('template-locate: a terminator must be 1-255');
  }
  // Occurrences, at every start position and overlaps included, because the circuit sums a match at each
  // of the window's 1024 positions. Exactly one count is accepted.
  let anchorIndex = -1;
  let occurrences = 0;
  for (let start = 0; start < DECODED_WINDOW_BYTES; start += 1) {
    if (anchorOccursAt(decoded, anchor, anchorLength, start)) {
      if (occurrences === 0) anchorIndex = start;
      occurrences += 1;
    }
  }
  if (occurrences === 0) fail('field_not_found', name);
  if (occurrences > 1) fail('field_ambiguous', name);
  const valueStart = anchorIndex + anchorLength;
  let valueLength = -1;
  for (let k = 0; k <= MAX_VALUE_BYTES; k += 1) {
    if (valueStart + k >= DECODED_WINDOW_BYTES) fail('field_invalid', name);
    if ((decoded[valueStart + k] ?? 0) === terminator) {
      valueLength = k;
      break;
    }
  }
  // A length of zero is a value whose first byte is the terminator, and minus one is a value with no
  // terminator inside the 32-byte bound; the circuit rejects both.
  if (valueLength < 1) fail('field_invalid', name);
  const value = new Uint8Array(MAX_VALUE_BYTES);
  for (let k = 0; k < valueLength; k += 1) {
    const byte = decoded[valueStart + k] ?? 0;
    if (!inCharset(byte, charset)) fail('field_invalid', name);
    value[k] = byte;
  }
  // The circuit's own bound, `anchorIndex + anchorLength + valueLength < maxLen`. The terminator search
  // above already implies it; asserting it here keeps both loops' obligations independent, so a change
  // to either cannot drop the bound silently.
  if (valueStart + valueLength >= DECODED_WINDOW_BYTES) fail('field_invalid', name);
  return { anchorIndex, valueLength, value };
}

/**
 * Locates all four stay fields of a template, in {@link TEMPLATE_FIELD_ORDER} order: city, arrival,
 * departure and booking reference.
 *
 * @param decoded - The decoded body window, exactly {@link DECODED_WINDOW_BYTES} bytes long.
 * @param params - The issuer template's circuit parameters.
 * @returns The four field locations, in field order.
 * @throws {CircuitInputError} The first field the circuit could not accept.
 * @throws {RangeError} Under the same conditions as {@link locateField}.
 */
export function locateFields(decoded: Uint8Array, params: TemplateParams): FieldLocation[] {
  return FIELD_INDEXES.map((fieldIndex) => locateField(decoded, params, fieldIndex));
}

/** The twelve capitalized English month names, the rows of `TmMatchMonthNames`, in table order. */
const FULL_MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The twelve three-letter month abbreviations, the rows of `TmMatchMonthAbbrevs`, in table order. */
const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The seven three-letter weekdays, the rows of `TmMatchWeekdays`, in table order. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * The alternation a name table contributes to a layout's pattern: built from the same rows the month numbers
 * are read from, so the grammar and the numbering cannot disagree.
 */
function alternation(names: readonly string[]): string {
  return names.join('|');
}

/**
 * Layout 1, `ISO_YMD`: four year digits, a dash, two month digits, a dash and two day digits — ten bytes, the
 * length `DateParse` requires of this layout.
 */
const ISO_YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Layout 2, `D_MONTH_YYYY`: a day of one or two digits, a space, a full month name, a space and four year
 * digits — `7 + t + L` bytes, `t` the day's extra digit and `L` the name's length, which is what `DateParse`
 * constrains the value's length to.
 */
const D_MONTH_YYYY = new RegExp(`^(\\d{1,2}) (${alternation(FULL_MONTH_NAMES)}) (\\d{4})$`);

/**
 * Layout 3, `MONTH_D_YYYY`: a full month name, a space, a day, a comma, a space and four year digits,
 * `8 + t + L` bytes long.
 */
const MONTH_D_YYYY = new RegExp(`^(${alternation(FULL_MONTH_NAMES)}) (\\d{1,2}), (\\d{4})$`);

/**
 * Layout 4, `DOW_D_MON_YYYY`: a weekday abbreviation, a comma, a space, a day, a space, a three-letter month
 * abbreviation, a space and four year digits, `15 + t` bytes long; the weekday is read as a literal and never
 * checked against the date it precedes.
 *
 * Each pattern is anchored and carries neither the `m` nor the `u` flag, so it has to match the value's whole
 * length and `\d` is ASCII `0`-`9` alone: the two ways a regex could be looser than the circuit.
 */
const DOW_D_MON_YYYY = new RegExp(
  `^(${alternation(WEEKDAYS)}), (\\d{1,2}) (${alternation(MONTH_ABBREVIATIONS)}) (\\d{4})$`,
);

/** The 1-based month a name stands for, from the table its layout's pattern was built from. */
function monthNumber(table: readonly string[], name: string | null): number | null {
  if (name === null) return null;
  const index = table.indexOf(name);
  return index === -1 ? null : index + 1;
}

/**
 * A capture group as text, or `null` when the group is absent — which a pattern that has just matched
 * cannot produce, and which the range checks then refuse rather than guessing at.
 */
function captureText(match: RegExpExecArray, index: number): string | null {
  return match[index] ?? null;
}

/** A capture group as a number, or `null` when the group is absent. */
function captureNumber(match: RegExpExecArray, index: number): number | null {
  const digits = captureText(match, index);
  return digits === null ? null : Number(digits);
}

/**
 * The number of days a month has in a year: the table `TmMonthLength` carries, in which only February ever
 * moves. The leap-year rule is `year % 4 === 0`; `DateParse` constrains the year to 2020-2099 before this
 * applies, and no century exception falls inside that range.
 */
function daysInMonth(month: number, year: number): number {
  if (month === 2) return year % 4 === 0 ? 29 : 28;
  switch (month) {
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/**
 * A date as `YYYYMMDD`, or `null` when `DateParse` would reject it: the year in 2020-2099, the month in
 * 1-12, and the day at least 1 and at most the month's length for that year.
 */
function calendarDate(
  year: number | null,
  month: number | null,
  day: number | null,
): number | null {
  if (year === null || month === null || day === null) return null;
  if (year < 2020 || year > 2099) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(month, year)) return null;
  return year * 10000 + month * 100 + day;
}

/**
 * Parses an extracted date value as `DateParse` does, answering `YYYYMMDD` or `null` when the circuit
 * would reject the value.
 *
 * The layout is the issuer template's `dateFormat` code, which is part of the template hash and so of the
 * issuer's registry leaf, so a prover cannot read a layout its issuer never registered. The value must match
 * the selected layout's grammar exactly and be exactly as long as that layout accounts for — the circuit
 * constrains `length === pickedLength`, ten bytes for `ISO_YMD` and the layout's own count otherwise — so a
 * value written in another layout's shape, or of a length no layout accounts for, is refused. The range rules
 * of {@link calendarDate} then apply to the parsed date.
 *
 * @param value - The extracted value, zero-padded to 32 bytes, as {@link locateField} returns it.
 * @param length - The value's length in bytes, 1-32 as `FieldExtract` constrains it.
 * @param formatCode - A `DATE_FORMAT_CODE` value.
 * @returns The date as `year * 10000 + month * 100 + day`, or `null`.
 */
export function parseDateValue(
  value: Uint8Array,
  length: number,
  formatCode: number,
): number | null {
  // `FieldExtract` bounds a value to 1-32 bytes, so any other length is one the circuit cannot accept,
  // and a length past the padded array could not be read from it at all.
  if (!Number.isInteger(length) || length < 1 || length > MAX_VALUE_BYTES) return null;
  const text = bytesToLatin1(value, 0, length);
  switch (formatCode) {
    case DATE_FORMAT_CODE.ISO_YMD: {
      const match = ISO_YMD.exec(text);
      if (match === null) return null;
      return calendarDate(
        captureNumber(match, 1),
        captureNumber(match, 2),
        captureNumber(match, 3),
      );
    }
    case DATE_FORMAT_CODE.D_MONTH_YYYY: {
      const match = D_MONTH_YYYY.exec(text);
      if (match === null) return null;
      return calendarDate(
        captureNumber(match, 3),
        monthNumber(FULL_MONTH_NAMES, captureText(match, 2)),
        captureNumber(match, 1),
      );
    }
    case DATE_FORMAT_CODE.MONTH_D_YYYY: {
      const match = MONTH_D_YYYY.exec(text);
      if (match === null) return null;
      return calendarDate(
        captureNumber(match, 3),
        monthNumber(FULL_MONTH_NAMES, captureText(match, 1)),
        captureNumber(match, 2),
      );
    }
    case DATE_FORMAT_CODE.DOW_D_MON_YYYY: {
      const match = DOW_D_MON_YYYY.exec(text);
      if (match === null) return null;
      return calendarDate(
        captureNumber(match, 4),
        monthNumber(MONTH_ABBREVIATIONS, captureText(match, 3)),
        captureNumber(match, 2),
      );
    }
    default:
      // A layout outside the four needs a circuit revision, so no value can name one.
      return null;
  }
}
