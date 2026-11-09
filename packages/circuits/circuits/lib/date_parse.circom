pragma circom 2.1.9;

// date_parse: parses the arrival or the departure date of a confirmed stay out of the bytes the
// extraction layer located in the DKIM-signed email body, and emits it as a `YYYYMMDD` integer
// (AAP 0.5.5). The public outputs `arrivalDate` and `departureDate` are this template's outputs, and
// the stay-length check (1 to 120 days) and the proof's validity window are computed from them.
//
// An issuer template names one of four layouts through its `dateFormat` code, and the code is part of
// the template hash and therefore of the issuer's registry leaf, so a prover cannot choose a layout the
// issuer never registered: 1 `ISO_YMD` `2026-03-04` (10 bytes); 2 `D_MONTH_YYYY` `4 March 2026`
// (7 + t + L_m); 3 `MONTH_D_YYYY` `March 4, 2026` (8 + t + L_m); 4 `DOW_D_MON_YYYY` `Wed, 4 Mar 2026`
// (15 + t), where `t` is 1 for a two-digit day and `L_m` the full English month name's length. The
// grammar is exact, with a single ASCII space (0x20): full capitalized English month names, `Jan`…`Dec`
// and one of `Mon Tue Wed Thu Fri Sat Sun` for layout 4, whose weekday is read as a literal and is not
// checked against the date it accompanies; the date must fall in 2020-2099, its month in 1-12, and its
// day between 1 and the month's length under the Gregorian leap-year rule. A layout outside these four
// requires a circuit revision and a new trusted setup, which `docs/zk-proofs.md` records.
//
// Soundness. All four layouts are parsed on every witness and only the selected one is used, so a
// layout that is not selected parses another layout's bytes and must not be able to fail: a prover
// holds no freedom to skip a branch. Every gadget below therefore runs on range-checked bytes, on
// constants, or on `IsEqual`, `IsZero`, `Mux1` and a `VarShiftLeft` whose shift is bounded whatever the
// input is — never an asserting gadget on a branch-computed value, and never a comparison of a digit
// value that a non-digit byte would have produced; byte positions that depend on the day's length are
// reached by shifting the value rather than by indexing it with a signal, which circom does not allow.
// Impossible calendar dates are rejected by the constraints at the end of `DateParse` rather than by
// assertions — the day bound, the month one-hot and the leap-year rule are what make `date-feb-30`,
// `date-month-13` and `date-non-digit` unsatisfiable. The value arrives zero-padded from `FieldExtract`,
// which also constrains every byte at or beyond `length` to zero: no read here goes past the selected
// layout's last byte (`length - 1`), and a padded zero can equal neither a name byte nor the space that
// delimits a name.

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/mux1.circom";
include "@zk-email/circuits/utils/array.circom";

/// @title TmIsDigit
/// @notice 1 when the byte `b` is an ASCII digit, `0`..`9` (`0x30`..`0x39`), and 0 otherwise.
/// @dev `b` must already be range-checked to 8 bits: circomlib's comparators fail witness generation
///      when an input exceeds their width, the one failure mode every branch here has to avoid.
template TmIsDigit() {
    signal input b;
    signal output out;
    component atLeastZero = GreaterEqThan(8);
    atLeastZero.in[0] <== b;
    atLeastZero.in[1] <== 0x30;
    component atMostNine = LessEqThan(8);
    atMostNine.in[0] <== b;
    atMostNine.in[1] <== 0x39;
    out <== atLeastZero.out * atMostNine.out;
}

/// @title TmTwoDigits
/// @notice Two digits as their numeric value, `10·(in[0] − '0') + (in[1] − '0')`, with `ok` set when
///         both are digits.
/// @dev The value is gated on `ok`, so it stays below 100 whatever a branch is handed and the range
///      checks that consume it neither fail nor lose soundness.
template TmTwoDigits() {
    signal input in[2];
    signal output ok;
    signal output value;
    component first = TmIsDigit();
    first.b <== in[0];
    component second = TmIsDigit();
    second.b <== in[1];
    ok <== first.out * second.out;
    value <== ok * (10 * (in[0] - 0x30) + (in[1] - 0x30));
}

/// @title TmYear4
/// @notice Four consecutive digits as a four-digit year, with `ok` set when all four are digits.
/// @dev Each digit contributes `digit · 10^k` only under its own digit indicator, so the value stays
///      below 10,000 whatever the bytes are; the 2020-2099 range is checked on that year.
template TmYear4() {
    signal input in[4];
    signal output ok;
    signal output value;
    component digits[4];
    signal weighted[4];
    var weight = 1000;
    for (var i = 0; i < 4; i++) {
        digits[i] = TmIsDigit();
        digits[i].b <== in[i];
        weighted[i] <== digits[i].out * (in[i] - 0x30) * weight;
        weight = weight \ 10;
    }
    signal firstPair;
    firstPair <== digits[0].out * digits[1].out;
    signal secondPair;
    secondPair <== digits[2].out * digits[3].out;
    ok <== firstPair * secondPair;
    value <== weighted[0] + weighted[1] + weighted[2] + weighted[3];
}

/// @title TmDay
/// @notice A day of the month written as one or two digits: `in[0]` must be a digit, and `in[1]` is
///         read as the second digit exactly when it is one.
/// @dev `twoDigits` is that bit, and the layouts use it to locate everything that follows the day.
///      `value` is 1-99, and 0 when `in[0]` is not a digit.
template TmDay() {
    signal input in[2];
    signal output ok;
    signal output twoDigits;
    signal output value;
    component firstDigit = TmIsDigit();
    firstDigit.b <== in[0];
    component secondDigit = TmIsDigit();
    secondDigit.b <== in[1];
    component pick = Mux1();
    pick.c[0] <== in[0] - 0x30;
    pick.c[1] <== 10 * (in[0] - 0x30) + (in[1] - 0x30);
    pick.s <== secondDigit.out;
    twoDigits <== secondDigit.out;
    ok <== firstDigit.out;
    value <== firstDigit.out * pick.out;
}

// Name tables. Each matcher reads a fixed window of bytes, compares whole constant rows against it and
// adds up the rows that matched. Every pattern of a table ends in the delimiter that follows the name,
// which makes a table's patterns prefix-free: two of them matching the same bytes would need the byte a
// shorter pattern's delimiter occupies to be a letter as well as a space. So at most one row matches and
// `found` is 0 or 1; a second match would take the month out of 1-12, which `DateParse`'s one-hot check
// rejects. Comparisons of the bytes a row does not use are computed all the same, on range-checked
// bytes, where they can neither fail nor change the result.

/// @title TmMatchMonthNames
/// @notice One of the twelve capitalized English full month names followed by a single space, at the
///         start of `w`, together with its 1-based month number and the name's length.
/// @input w The bytes from the month's position; ten of them cover the longest name, `September`.
template TmMatchMonthNames() {
    signal input w[10];
    signal output found;
    signal output month;
    signal output length;
    var LENGTHS[12] = [7, 8, 5, 5, 3, 4, 4, 6, 9, 7, 8, 8];
    // Row m is January, February, … December, zero-padded past the name's length.
    var NAMES[12][9] = [
        [0x4a, 0x61, 0x6e, 0x75, 0x61, 0x72, 0x79, 0, 0],
        [0x46, 0x65, 0x62, 0x72, 0x75, 0x61, 0x72, 0x79, 0],
        [0x4d, 0x61, 0x72, 0x63, 0x68, 0, 0, 0, 0],
        [0x41, 0x70, 0x72, 0x69, 0x6c, 0, 0, 0, 0],
        [0x4d, 0x61, 0x79, 0, 0, 0, 0, 0, 0],
        [0x4a, 0x75, 0x6e, 0x65, 0, 0, 0, 0, 0],
        [0x4a, 0x75, 0x6c, 0x79, 0, 0, 0, 0, 0],
        [0x41, 0x75, 0x67, 0x75, 0x73, 0x74, 0, 0, 0],
        [0x53, 0x65, 0x70, 0x74, 0x65, 0x6d, 0x62, 0x65, 0x72],
        [0x4f, 0x63, 0x74, 0x6f, 0x62, 0x65, 0x72, 0, 0],
        [0x4e, 0x6f, 0x76, 0x65, 0x6d, 0x62, 0x65, 0x72, 0],
        [0x44, 0x65, 0x63, 0x65, 0x6d, 0x62, 0x65, 0x72, 0]
    ];
    component byteEq[12][9];
    signal prefix[12][9];
    component delimiter[12];
    signal match[12];
    signal foundAcc[12];
    signal monthAcc[12];
    signal lengthAcc[12];
    for (var m = 0; m < 12; m++) {
        for (var i = 0; i < 9; i++) {
            byteEq[m][i] = IsEqual();
            byteEq[m][i].in[0] <== w[i];
            byteEq[m][i].in[1] <== NAMES[m][i];
            if (i == 0) {
                prefix[m][0] <== byteEq[m][0].out;
            } else {
                prefix[m][i] <== prefix[m][i - 1] * byteEq[m][i].out;
            }
        }
        delimiter[m] = IsEqual();
        delimiter[m].in[0] <== w[LENGTHS[m]];
        delimiter[m].in[1] <== 0x20;
        // The name's own bytes and the space that ends it: past that, a row's comparisons are unused.
        match[m] <== prefix[m][LENGTHS[m] - 1] * delimiter[m].out;
    }
    foundAcc[0] <== match[0];
    monthAcc[0] <== match[0];
    lengthAcc[0] <== match[0] * LENGTHS[0];
    for (var m = 1; m < 12; m++) {
        foundAcc[m] <== foundAcc[m - 1] + match[m];
        monthAcc[m] <== monthAcc[m - 1] + match[m] * (m + 1);
        lengthAcc[m] <== lengthAcc[m - 1] + match[m] * LENGTHS[m];
    }
    found <== foundAcc[11];
    month <== monthAcc[11];
    length <== lengthAcc[11];
}

/// @title TmMatchMonthAbbrevs
/// @notice One of the twelve three-letter month abbreviations followed by a single space, at the
///         start of `w`, together with its 1-based month number.
/// @input w The bytes from the month's position; four of them cover the abbreviation and its space.
/// @dev Every row is four bytes long, so no row can be a prefix of another and at most one matches.
template TmMatchMonthAbbrevs() {
    signal input w[4];
    signal output found;
    signal output month;
    // Row m is Jan, Feb, … Dec.
    var NAMES[12][3] = [
        [0x4a, 0x61, 0x6e],
        [0x46, 0x65, 0x62],
        [0x4d, 0x61, 0x72],
        [0x41, 0x70, 0x72],
        [0x4d, 0x61, 0x79],
        [0x4a, 0x75, 0x6e],
        [0x4a, 0x75, 0x6c],
        [0x41, 0x75, 0x67],
        [0x53, 0x65, 0x70],
        [0x4f, 0x63, 0x74],
        [0x4e, 0x6f, 0x76],
        [0x44, 0x65, 0x63]
    ];
    component byteEq[12][3];
    signal prefix[12][3];
    component delimiter[12];
    signal match[12];
    signal foundAcc[12];
    signal monthAcc[12];
    for (var m = 0; m < 12; m++) {
        for (var i = 0; i < 3; i++) {
            byteEq[m][i] = IsEqual();
            byteEq[m][i].in[0] <== w[i];
            byteEq[m][i].in[1] <== NAMES[m][i];
            if (i == 0) {
                prefix[m][0] <== byteEq[m][0].out;
            } else {
                prefix[m][i] <== prefix[m][i - 1] * byteEq[m][i].out;
            }
        }
        delimiter[m] = IsEqual();
        delimiter[m].in[0] <== w[3];
        delimiter[m].in[1] <== 0x20;
        match[m] <== prefix[m][2] * delimiter[m].out;
    }
    foundAcc[0] <== match[0];
    monthAcc[0] <== match[0];
    for (var m = 1; m < 12; m++) {
        foundAcc[m] <== foundAcc[m - 1] + match[m];
        monthAcc[m] <== monthAcc[m - 1] + match[m] * (m + 1);
    }
    found <== foundAcc[11];
    month <== monthAcc[11];
}

/// @title TmMatchWeekdays
/// @notice One of the seven three-letter English weekday abbreviations at the start of `w`.
/// @dev The weekday belongs to layout 4's grammar and is read as a literal: the statement binds the
///      stay's dates and not the day of the week an issuer chose to print beside them. The three-byte
///      rows are distinct, so at most one matches and `found` is 0 or 1.
template TmMatchWeekdays() {
    signal input w[3];
    signal output found;
    // Row k is Mon, Tue, … Sun.
    var NAMES[7][3] = [
        [0x4d, 0x6f, 0x6e],
        [0x54, 0x75, 0x65],
        [0x57, 0x65, 0x64],
        [0x54, 0x68, 0x75],
        [0x46, 0x72, 0x69],
        [0x53, 0x61, 0x74],
        [0x53, 0x75, 0x6e]
    ];
    component byteEq[7][3];
    signal prefix[7][3];
    signal match[7];
    signal acc[7];
    for (var k = 0; k < 7; k++) {
        for (var i = 0; i < 3; i++) {
            byteEq[k][i] = IsEqual();
            byteEq[k][i].in[0] <== w[i];
            byteEq[k][i].in[1] <== NAMES[k][i];
            if (i == 0) {
                prefix[k][0] <== byteEq[k][0].out;
            } else {
                prefix[k][i] <== prefix[k][i - 1] * byteEq[k][i].out;
            }
        }
        match[k] <== prefix[k][2];
    }
    acc[0] <== match[0];
    for (var k = 1; k < 7; k++) {
        acc[k] <== acc[k - 1] + match[k];
    }
    found <== acc[6];
}

/// @title TmMonthLength
/// @notice The number of days in `month` for the given leap-year bit: 31, 28 or 29, 31, 30 …
/// @dev Only February takes the extra day. `DateParse` applies this to a month its one-hot check has
///      already constrained to 1-12, which is what makes the day bound it feeds sound; a month no
///      length row matches selects none and contributes nothing.
template TmMonthLength() {
    signal input month;
    signal input isLeap;
    signal output out;
    var LENGTHS[12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    component matches[12];
    signal days[12];
    signal running[12];
    for (var k = 1; k <= 12; k++) {
        matches[k - 1] = IsEqual();
        matches[k - 1].in[0] <== month;
        matches[k - 1].in[1] <== k;
        days[k - 1] <== matches[k - 1].out * LENGTHS[k - 1];
    }
    running[0] <== days[0];
    for (var k = 1; k < 12; k++) {
        running[k] <== running[k - 1] + days[k];
    }
    component february = IsEqual();
    february.in[0] <== month;
    february.in[1] <== 2;
    out <== running[11] + february.out * isLeap;
}

// The four layouts. A layout template parses its own format out of the value and reports `ok` beside the
// fields, so a layout the prover did not select is still parsed, never fails, and simply goes unused.
// Byte positions that depend on the day's length are reached by shifting the value (`VarShiftLeft`); every
// shift is bounded by construction — the day-length bit, or a month-name length of at most nine — so it
// can neither wrap past the end of the window nor fail the shift gadget's own range check.
// `v` must be range-checked to 8 bits, as `DateParse` does before any layout sees it.

/// @title TmParseIso
/// @notice Layout 1, `YYYY-MM-DD`: `v[0..3]` the year, `-`, `v[5..6]` the month, `-`, `v[8..9]` the
///         day, ten bytes in all.
template TmParseIso() {
    signal input v[32];
    signal output ok;
    signal output year;
    signal output month;
    signal output day;
    component yearPart = TmYear4();
    for (var i = 0; i < 4; i++) {
        yearPart.in[i] <== v[i];
    }
    component monthPart = TmTwoDigits();
    monthPart.in[0] <== v[5];
    monthPart.in[1] <== v[6];
    component dayPart = TmTwoDigits();
    dayPart.in[0] <== v[8];
    dayPart.in[1] <== v[9];
    component dashBeforeMonth = IsEqual();
    dashBeforeMonth.in[0] <== v[4];
    dashBeforeMonth.in[1] <== 0x2d;
    component dashBeforeDay = IsEqual();
    dashBeforeDay.in[0] <== v[7];
    dashBeforeDay.in[1] <== 0x2d;
    signal yearMonthOk;
    yearMonthOk <== yearPart.ok * monthPart.ok;
    signal dashesOk;
    dashesOk <== dashBeforeMonth.out * dashBeforeDay.out;
    signal dateOk;
    dateOk <== yearMonthOk * dayPart.ok;
    ok <== dateOk * dashesOk;
    year <== yearPart.value;
    month <== monthPart.value;
    day <== dayPart.value;
}

/// @title TmParseDayFullMonthYear
/// @notice Layout 2, `D Month YYYY`, for example `4 March 2026` or `14 March 2026`: `v[0]` the day's
///         first digit, `v[1]` its second digit or the space ending a one-digit day, `v[2+t]`… the
///         month name and the space after it, `v[3+t+L_m]`… the four year digits.
/// @dev `t` is the day-length bit and `L_m` the matched name's length, so the layout accounts for
///      `7 + t + L_m` bytes. Both spaces are part of the grammar (`D Month YYYY`), so both are counted:
///      `4 March 2026` is twelve bytes, not eleven.
template TmParseDayFullMonthYear() {
    signal input v[32];
    signal output ok;
    signal output year;
    signal output month;
    signal output day;
    signal output length;
    component dayPart = TmDay();
    dayPart.in[0] <== v[0];
    dayPart.in[1] <== v[1];
    // Everything from the byte after the day: the space that ends it, then the month and the year.
    component afterDay = VarShiftLeft(32, 31);
    afterDay.in <== v;
    afterDay.shift <== dayPart.twoDigits;
    component dayDelimiter = IsEqual();
    dayDelimiter.in[0] <== afterDay.out[1];
    dayDelimiter.in[1] <== 0x20;
    component monthPart = TmMatchMonthNames();
    for (var i = 0; i < 10; i++) {
        monthPart.w[i] <== afterDay.out[2 + i];
    }
    // The year starts after the day, its space, the name and the name's space.
    component yearShift = VarShiftLeft(31, 4);
    yearShift.in <== afterDay.out;
    yearShift.shift <== 3 + monthPart.length;
    component yearPart = TmYear4();
    for (var i = 0; i < 4; i++) {
        yearPart.in[i] <== yearShift.out[i];
    }
    signal dayOk;
    dayOk <== dayPart.ok * dayDelimiter.out;
    signal monthOk;
    monthOk <== dayOk * monthPart.found;
    ok <== monthOk * yearPart.ok;
    year <== yearPart.value;
    month <== monthPart.month;
    day <== dayPart.value;
    length <== 7 + dayPart.twoDigits + monthPart.length;
}

/// @title TmParseFullMonthDayYear
/// @notice Layout 3, `Month D, YYYY`, for example `March 4, 2026` or `March 14, 2026`: `v[0]`… the month
///         name and the space after it, `v[L_m+1]` the day's first digit, `v[L_m+2]` its second digit if
///         the day has one, `v[L_m+2+t]` the comma, `v[L_m+3+t]` the space after it, `v[L_m+4+t]`… the
///         four year digits.
/// @dev `t` is the day-length bit and `L_m` the matched name's length, so the layout accounts for
///      `8 + t + L_m` bytes.
template TmParseFullMonthDayYear() {
    signal input v[32];
    signal output ok;
    signal output year;
    signal output month;
    signal output day;
    signal output length;
    component monthPart = TmMatchMonthNames();
    for (var i = 0; i < 10; i++) {
        monthPart.w[i] <== v[i];
    }
    // Everything after the month name and its space, read at the matched name's length.
    component afterMonth = VarShiftLeft(32, 31);
    afterMonth.in <== v;
    afterMonth.shift <== monthPart.length + 1;
    component dayPart = TmDay();
    dayPart.in[0] <== afterMonth.out[0];
    dayPart.in[1] <== afterMonth.out[1];
    // Shifted again by the day's length: the comma, the space after it and the year.
    component afterDay = VarShiftLeft(31, 7);
    afterDay.in <== afterMonth.out;
    afterDay.shift <== dayPart.twoDigits;
    component comma = IsEqual();
    comma.in[0] <== afterDay.out[1];
    comma.in[1] <== 0x2c;
    component space = IsEqual();
    space.in[0] <== afterDay.out[2];
    space.in[1] <== 0x20;
    component yearPart = TmYear4();
    for (var i = 0; i < 4; i++) {
        yearPart.in[i] <== afterDay.out[3 + i];
    }
    signal monthOk;
    monthOk <== monthPart.found * dayPart.ok;
    signal commaOk;
    commaOk <== monthOk * comma.out;
    signal spaceOk;
    spaceOk <== commaOk * space.out;
    ok <== spaceOk * yearPart.ok;
    year <== yearPart.value;
    month <== monthPart.month;
    day <== dayPart.value;
    length <== 8 + monthPart.length + dayPart.twoDigits;
}

/// @title TmParseDowDayAbbrevMonthYear
/// @notice Layout 4, `Ddd, D Mmm YYYY`, for example `Wed, 4 Mar 2026` or `Wed, 14 Mar 2026`: `v[0..2]`
///         the weekday abbreviation, `v[3]` the comma, `v[4]` the space before the day, `v[5]` the day's
///         first digit, `v[6]` its second digit or the space ending a one-digit day, `v[7+t]`… the month
///         abbreviation and the space after it, `v[11+t]`… the four year digits.
/// @dev `t` is the day-length bit, so the layout accounts for `15 + t` bytes. The weekday is not checked
///      against the date it precedes.
template TmParseDowDayAbbrevMonthYear() {
    signal input v[32];
    signal output ok;
    signal output year;
    signal output month;
    signal output day;
    signal output length;
    component weekdayPart = TmMatchWeekdays();
    for (var i = 0; i < 3; i++) {
        weekdayPart.w[i] <== v[i];
    }
    component comma = IsEqual();
    comma.in[0] <== v[3];
    comma.in[1] <== 0x2c;
    component beforeDay = IsEqual();
    beforeDay.in[0] <== v[4];
    beforeDay.in[1] <== 0x20;
    component dayPart = TmDay();
    dayPart.in[0] <== v[5];
    dayPart.in[1] <== v[6];
    // Everything from the byte after the day: the space that ends it, then the month and the year.
    component afterDay = VarShiftLeft(32, 31);
    afterDay.in <== v;
    afterDay.shift <== dayPart.twoDigits;
    component dayDelimiter = IsEqual();
    dayDelimiter.in[0] <== afterDay.out[6];
    dayDelimiter.in[1] <== 0x20;
    component monthPart = TmMatchMonthAbbrevs();
    for (var i = 0; i < 4; i++) {
        monthPart.w[i] <== afterDay.out[7 + i];
    }
    component yearShift = VarShiftLeft(31, 4);
    yearShift.in <== afterDay.out;
    yearShift.shift <== 11;
    component yearPart = TmYear4();
    for (var i = 0; i < 4; i++) {
        yearPart.in[i] <== yearShift.out[i];
    }
    signal weekdayOk;
    weekdayOk <== weekdayPart.found * comma.out;
    signal prefixOk;
    prefixOk <== weekdayOk * beforeDay.out;
    signal dayOk;
    dayOk <== prefixOk * dayPart.ok;
    signal dayEndOk;
    dayEndOk <== dayOk * dayDelimiter.out;
    signal monthOk;
    monthOk <== dayEndOk * monthPart.found;
    ok <== monthOk * yearPart.ok;
    year <== yearPart.value;
    month <== monthPart.month;
    day <== dayPart.value;
    length <== 15 + dayPart.twoDigits;
}

/// @title DateParse
/// @notice Parses one date out of an extracted, zero-padded value and emits it as `YYYYMMDD`, using
///         the layout `format` names: 1 `ISO_YMD`, 2 `D_MONTH_YYYY`, 3 `MONTH_D_YYYY`,
///         4 `DOW_D_MON_YYYY`.
/// @notice The date must fall in 2020-2099, its month in 1-12 and its day between 1 and the month's
///         length under the Gregorian leap-year rule; a date that does not, such as `2026-02-30`, a
///         month 13 or a non-digit date byte, leaves the constraints unsatisfiable.
/// @input value The extracted bytes, zero-padded to 32: `FieldExtract` constrains every byte at or
///        beyond `length` to zero.
/// @input length The value's length in bytes. The selected layout has to consume exactly that many,
///        which is what pins the date's end and the length of a one- or two-digit day.
/// @input format The layout code. It comes from the issuer's registered template and is part of the
///        template hash, so a prover cannot substitute a layout the template does not name.
/// @output out The date as `year·10000 + month·100 + day`.
template DateParse() {
    signal input value[32];
    signal input length;
    signal input format;
    signal output out;
    // Every byte of the padded value is range-checked to 8 bits before any layout sees it. The
    // extraction layer already constrains them; repeating it here is what makes every comparator
    // below sound, and unable to fail, when this template is instantiated on its own.
    component byteRange[32];
    for (var i = 0; i < 32; i++) {
        byteRange[i] = Num2Bits(8);
        byteRange[i].in <== value[i];
    }
    // All four layouts are parsed on every witness; the selection below uses exactly one of them.
    component iso = TmParseIso();
    iso.v <== value;
    component dayFullMonthYear = TmParseDayFullMonthYear();
    dayFullMonthYear.v <== value;
    component fullMonthDayYear = TmParseFullMonthDayYear();
    fullMonthDayYear.v <== value;
    component dowDayAbbrevMonthYear = TmParseDowDayAbbrevMonthYear();
    dowDayAbbrevMonthYear.v <== value;
    component isIso = IsEqual();
    isIso.in[0] <== format;
    isIso.in[1] <== 1;
    component isDayFullMonthYear = IsEqual();
    isDayFullMonthYear.in[0] <== format;
    isDayFullMonthYear.in[1] <== 2;
    component isFullMonthDayYear = IsEqual();
    isFullMonthDayYear.in[0] <== format;
    isFullMonthDayYear.in[1] <== 3;
    component isDowDayAbbrevMonthYear = IsEqual();
    isDowDayAbbrevMonthYear.in[0] <== format;
    isDowDayAbbrevMonthYear.in[1] <== 4;
    signal selected[4];
    selected[0] <== isIso.out;
    selected[1] <== isDayFullMonthYear.out;
    selected[2] <== isFullMonthDayYear.out;
    selected[3] <== isDowDayAbbrevMonthYear.out;
    // Exactly one layout is named: 0 and 5 are as unsatisfiable as any other code outside 1-4.
    selected[0] + selected[1] + selected[2] + selected[3] === 1;
    // One selection per layout, and then the sums. Each product stands as its own constraint, because
    // circom admits one product of two linear combinations per constraint and not a sum of them.
    signal pickedLength[4];
    signal pickedOk[4];
    signal pickedYear[4];
    signal pickedMonth[4];
    signal pickedDay[4];
    pickedLength[0] <== selected[0] * 10;
    pickedLength[1] <== selected[1] * dayFullMonthYear.length;
    pickedLength[2] <== selected[2] * fullMonthDayYear.length;
    pickedLength[3] <== selected[3] * dowDayAbbrevMonthYear.length;
    pickedOk[0] <== selected[0] * iso.ok;
    pickedOk[1] <== selected[1] * dayFullMonthYear.ok;
    pickedOk[2] <== selected[2] * fullMonthDayYear.ok;
    pickedOk[3] <== selected[3] * dowDayAbbrevMonthYear.ok;
    pickedYear[0] <== selected[0] * iso.year;
    pickedYear[1] <== selected[1] * dayFullMonthYear.year;
    pickedYear[2] <== selected[2] * fullMonthDayYear.year;
    pickedYear[3] <== selected[3] * dowDayAbbrevMonthYear.year;
    pickedMonth[0] <== selected[0] * iso.month;
    pickedMonth[1] <== selected[1] * dayFullMonthYear.month;
    pickedMonth[2] <== selected[2] * fullMonthDayYear.month;
    pickedMonth[3] <== selected[3] * dowDayAbbrevMonthYear.month;
    pickedDay[0] <== selected[0] * iso.day;
    pickedDay[1] <== selected[1] * dayFullMonthYear.day;
    pickedDay[2] <== selected[2] * fullMonthDayYear.day;
    pickedDay[3] <== selected[3] * dowDayAbbrevMonthYear.day;
    // The selected layout must have consumed every byte of the value — `ISO_YMD` is ten by definition,
    // the other three report the length they parsed — so a one-digit day where the value has two digits,
    // or a layout stopping short of the value's end, cannot pass.
    length === pickedLength[0] + pickedLength[1] + pickedLength[2] + pickedLength[3];
    // And that layout's string must have matched, which is what rejects a value written in another
    // layout's shape, a non-digit where a digit belongs, and a month name the tables do not hold.
    signal matched;
    matched <== pickedOk[0] + pickedOk[1] + pickedOk[2] + pickedOk[3];
    matched === 1;
    // The selected fields. An unselected layout contributes nothing, whatever its own parse produced.
    signal year;
    signal month;
    signal day;
    year <== pickedYear[0] + pickedYear[1] + pickedYear[2] + pickedYear[3];
    month <== pickedMonth[0] + pickedMonth[1] + pickedMonth[2] + pickedMonth[3];
    day <== pickedDay[0] + pickedDay[1] + pickedDay[2] + pickedDay[3];
    // The year. Every layout weighs its year digits under their own digit indicators, so `year` is
    // below 10,000 whatever the branches produced and a 14-bit comparison is sound.
    component yearLow = GreaterEqThan(14);
    yearLow.in[0] <== year;
    yearLow.in[1] <== 2020;
    yearLow.out === 1;
    component yearHigh = LessEqThan(14);
    yearHigh.in[0] <== year;
    yearHigh.in[1] <== 2099;
    yearHigh.out === 1;
    // The month is one of the twelve. `month` is below 100 whatever the branches produced, and any
    // other value — 0, 13, or one no table and no pair of digits could have produced — leaves every
    // one-hot term zero.
    component monthIs[12];
    signal monthHits[12];
    for (var k = 1; k <= 12; k++) {
        monthIs[k - 1] = IsEqual();
        monthIs[k - 1].in[0] <== month;
        monthIs[k - 1].in[1] <== k;
    }
    monthHits[0] <== monthIs[0].out;
    for (var k = 1; k < 12; k++) {
        monthHits[k] <== monthHits[k - 1] + monthIs[k].out;
    }
    monthHits[11] === 1;
    // Leap year: `year` is 2020-2099, so the Gregorian century rule has no case to make (2000 and 2100
    // both lie outside the range) and divisibility by four is the whole test. `quotient` and `remainder`
    // are the only witnesses computed by assignment in this file, and each is constrained immediately —
    // `remainder` to two bits, `quotient` to ten, which `year` ≤ 2099 keeps sufficient.
    signal quotient;
    signal remainder;
    quotient <-- year \ 4;
    remainder <-- year % 4;
    year === 4 * quotient + remainder;
    component remainderBits = Num2Bits(2);
    remainderBits.in <== remainder;
    component quotientBits = Num2Bits(10);
    quotientBits.in <== quotient;
    component leapYear = IsZero();
    leapYear.in <== remainder;
    component monthLength = TmMonthLength();
    monthLength.month <== month;
    monthLength.isLeap <== leapYear.out;
    // The day has to exist in that month: at least 1, and at most the month's length for that year,
    // which is 29 in February of a leap year and 28 otherwise.
    component dayNonZero = IsZero();
    dayNonZero.in <== day;
    dayNonZero.out === 0;
    component dayInMonth = LessEqThan(7);
    dayInMonth.in[0] <== day;
    dayInMonth.in[1] <== monthLength.out;
    dayInMonth.out === 1;
    out <== year * 10000 + month * 100 + day;
}

