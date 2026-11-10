pragma circom 2.1.9;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "@zk-email/circuits/utils/array.circom";
include "@zk-email/circuits/utils/bytes.circom";
include "@zk-email/circuits/utils/functions.circom";

// Field extraction for the itinerary circuit (AAP 0.5.5): it reads the four stay fields — city, arrival, departure and
// booking reference — out of the decoded, DKIM-authenticated body window, never from the headers, and fixes the
// injective byte packing every hash of an anchor, a value or a city alias is taken over. A field exists only where its
// anchor occurs exactly once in that window and the value after it is a bounded, charset-checked literal ending at the
// first terminator following the anchor, so no key, template, city alias or field boundary can be substituted.
//
// The packing template is `CheckedPackBytes`, not the `PackBytes(32)` the AAP names: zk-email's `PackBytes(maxBytes)` is
// already defined by `bytes.circom`, circom rejects a duplicate name, and this name adds the byte range check
// zk-email's version omits.

/// @title CheckedPackBytes
/// @notice Packs a 32-byte value into the two field elements this circuit hashes anchors, extracted values and city
///         aliases with: `out[0]` holds bytes 0-30 little-endian, `out[1]` holds byte 31.
/// @notice The encoding is zk-email's `PackBytes(32)`, instantiated rather than reimplemented, and `packBytes` in
///         `packages/circuits/src/registry/leaves.ts` mirrors it. The range check below is what zk-email's version
///         lacks: without it a byte above 255 could carry weight into `out[0]`, two byte strings could pack to the
///         same pair, and the encoding would not be injective — the registry leaf and the nullifier both rest on it.
///         With every byte in 0-255, `out[0]` stays below 2^248, well inside the BN254 field.
/// @param maxBytes The number of bytes packed; every caller's value is 32 bytes wide.
/// @input in The bytes to pack, zero-padded to `maxBytes`; each one must be in 0-255.
/// @output out The two packed field elements.
template CheckedPackBytes(maxBytes) {
    assert(maxBytes == 32);
    signal input in[maxBytes];
    signal output out[2];
    component byteBits[maxBytes];
    for (var i = 0; i < maxBytes; i++) {
        byteBits[i] = Num2Bits(8);
        byteBits[i].in <== in[i];
    }
    component packer = PackBytes(maxBytes);
    packer.in <== in;
    for (var c = 0; c < 2; c++) {
        out[c] <== packer.out[c];
    }
}

/// @title TmCharsetMember
/// @notice Tests one byte against one of the four charsets an extraction template may name, selected by a one-hot
///         selector so `FieldExtract` derives that selector once per field, not per byte.
/// @notice The codes and the sets are those `CHARSET_CODE` in `packages/shared/src/schemas/proofs.ts` writes down:
///         1 `digits` is `0`-`9`; 2 `alnum` adds `A`-`Z`, `a`-`z` and `-`; 3 `date` adds the space and the comma the
///         English date layouts need; 4 `text` is the printable range 0x20-0x7E plus every byte at or above 0x80, so
///         an accented place name or booking reference still extracts. No charset admits 0x00, so a value can never
///         run through the zero fill that follows the SHA-256 0x80 pad byte into the body's length field.
/// @input in A byte the caller has already range-checked to 0-255; sel the one-hot charset selector, `sel[c] = 1`
///         for charset code `c + 1`.
/// @output out 1 when `in` belongs to the selected charset, 0 otherwise.
template TmCharsetMember() {
    signal input in;
    signal input sel[4];
    signal output out;
    // Every comparator is handed operands that fit in 8 bits — `in` is a range-checked byte and each bound
    // is a constant below 256 — because `LessThan(n)` is sound only for operands of n bits.
    var geBounds[5] = [0x30, 0x41, 0x61, 0x20, 0x80];
    var ltBounds[4] = [0x3A, 0x5B, 0x7B, 0x7F];
    component ge[5];
    component lt[4];
    for (var g = 0; g < 5; g++) {
        ge[g] = LessThan(8);
        ge[g].in[0] <== in;
        ge[g].in[1] <== geBounds[g];
    }
    for (var l = 0; l < 4; l++) {
        lt[l] = LessThan(8);
        lt[l].in[0] <== in;
        lt[l].in[1] <== ltBounds[l];
    }
    // `ge[k]` is `in >= geBounds[k]` and `lt[k]` is `in < ltBounds[k]`, so each range is the product of
    // its two bounds. 0x80 needs no upper bound: `in <= 0xFF` is already given by the range check.
    signal isDigit;
    signal isUpper;
    signal isLower;
    signal isPrintable;
    signal isHigh;
    isDigit <== (1 - ge[0].out) * lt[0].out;
    isUpper <== (1 - ge[1].out) * lt[1].out;
    isLower <== (1 - ge[2].out) * lt[2].out;
    isPrintable <== (1 - ge[3].out) * lt[3].out;
    isHigh <== 1 - ge[4].out;
    component dashEqual = IsEqual();
    dashEqual.in[0] <== in;
    dashEqual.in[1] <== 0x2D;
    component spaceEqual = IsEqual();
    spaceEqual.in[0] <== in;
    spaceEqual.in[1] <== 0x20;
    component commaEqual = IsEqual();
    commaEqual.in[0] <== in;
    commaEqual.in[1] <== 0x2C;
    // Each sum is over disjoint cases — a byte is never both a digit and an upper-case letter, and
    // 0x2D, 0x20 and 0x2C lie outside every range above — so every predicate below stays boolean.
    signal alnum;
    signal date;
    signal text;
    alnum <== isDigit + isUpper + isLower + dashEqual.out;
    date <== alnum + spaceEqual.out + commaEqual.out;
    text <== isPrintable + isHigh;
    // One multiplication per constraint: circom admits `a·b + c` and not a sum of two products, so the
    // four one-hot terms are taken separately and added afterwards.
    signal selected[4];
    selected[0] <== sel[0] * isDigit;
    selected[1] <== sel[1] * alnum;
    selected[2] <== sel[2] * date;
    selected[3] <== sel[3] * text;
    out <== selected[0] + selected[1] + selected[2] + selected[3];
}

/// @title FieldExtract
/// @notice Locates one stay field inside the decoded, DKIM-authenticated body window and returns its bytes, zero from
///         `valueLength` on (AAP 0.5.5).
/// @notice The anchor is read at the prover-supplied `anchorIndex` and the value immediately after it, as the bytes up
///         to the field's terminator: at least one byte, each in the field's charset, none of them the terminator,
///         then the terminator itself. The anchor is bounded to its declared length — non-zero inside it, zero
///         outside — and occurs exactly once in the window, and the value ends at the first terminator after the
///         anchor, so the field has one possible position and one length.
/// @param maxLen The window length in bytes, 1,024 for the circuit's body bound; maxAnchor the anchor bound in bytes,
///         32; maxValue the value bound in bytes, 32.
/// @input in The decoded body window: the body with soft line breaks removed, zero-padded to `maxLen`.
/// @input anchor The anchor's bytes, zero-padded to `maxAnchor`; anchorLength its length in bytes, 1 to 32;
///         anchorIndex its position in the window; valueLength the value's length in bytes, 1 to 32.
/// @input terminator The byte that ends the value; non-zero, as no charset admits 0x00; charset the value's charset
///         code: 1 `digits`, 2 `alnum`, 3 `date`, 4 `text`.
/// @output value The value's bytes, zero from `valueLength` on.
template FieldExtract(maxLen, maxAnchor, maxValue) {
    assert(maxAnchor == 32);
    assert(maxValue == 32);
    assert(maxLen >= maxAnchor + maxValue + 1);
    // Keeps the terminator's index, `anchorIndex + anchorLength + valueLength`, inside the 11-bit
    // comparator below, whose two operands must both fit in 11 bits.
    assert(maxLen + maxAnchor + maxValue < 2048);
    signal input in[maxLen];
    signal input anchor[maxAnchor];
    signal input anchorLength;
    signal input anchorIndex;
    signal input valueLength;
    signal input terminator;
    signal input charset;
    signal output value[maxValue];
    // Ranges. Every length, index and byte the extraction reads with is bounded before it is used; the two lengths and
    // the terminator are rejected at zero, so an anchor and a value always have at least one byte and the terminator
    // can never stand in for an empty field.
    component anchorLengthBits = Num2Bits(6);
    anchorLengthBits.in <== anchorLength;
    component anchorLengthNonZero = IsZero();
    anchorLengthNonZero.in <== anchorLength;
    anchorLengthNonZero.out === 0;
    component anchorLengthAtMost32 = LessThan(6);
    anchorLengthAtMost32.in[0] <== anchorLength;
    anchorLengthAtMost32.in[1] <== 33;
    anchorLengthAtMost32.out === 1;
    component valueLengthBits = Num2Bits(6);
    valueLengthBits.in <== valueLength;
    component valueLengthNonZero = IsZero();
    valueLengthNonZero.in <== valueLength;
    valueLengthNonZero.out === 0;
    component valueLengthAtMost32 = LessThan(6);
    valueLengthAtMost32.in[0] <== valueLength;
    valueLengthAtMost32.in[1] <== 33;
    valueLengthAtMost32.out === 1;
    component terminatorBits = Num2Bits(8);
    terminatorBits.in <== terminator;
    component terminatorNonZero = IsZero();
    terminatorNonZero.in <== terminator;
    terminatorNonZero.out === 0;
    component anchorIndexBits = Num2Bits(log2Ceil(maxLen));
    anchorIndexBits.in <== anchorIndex;
    // The terminator lies inside the window: anchorIndex + anchorLength + valueLength < maxLen, with valueLength at
    // least 1. Bounding the whole sum before the shifted reads below is also what keeps `VarShiftLeft`'s modulo
    // indexing from wrapping.
    signal anchorEnd;
    anchorEnd <== anchorIndex + anchorLength + valueLength;
    component withinWindow = LessThan(11);
    withinWindow.in[0] <== anchorEnd;
    withinWindow.in[1] <== maxLen;
    withinWindow.out === 1;
    // Charset selector, derived once per field rather than 32 times. The one-hot sum also forces
    // `charset` into 1-4: any other code leaves every `IsEqual` false and the sum unsatisfiable.
    signal sel[4];
    component charsetIsEqual[4];
    component selTotal = CalculateTotal(4);
    for (var c = 0; c < 4; c++) {
        charsetIsEqual[c] = IsEqual();
        charsetIsEqual[c].in[0] <== charset;
        charsetIsEqual[c].in[1] <== c + 1;
        sel[c] <== charsetIsEqual[c].out;
        selTotal.nums[c] <== sel[c];
    }
    selTotal.sum === 1;
    // Anchor shape: non-zero inside its declared length and zero outside it. zk-email's `CheckSubstringMatch`
    // treats a zero pattern byte as a wildcard, so the shape is asserted here rather than relied on; the zero fill
    // is also what makes the anchor's packed encoding unique.
    signal inAnchor[maxAnchor];
    component anchorLengthAbove[maxAnchor];
    component anchorByteIsZero[maxAnchor];
    for (var i = 0; i < maxAnchor; i++) {
        anchorLengthAbove[i] = LessThan(6);
        anchorLengthAbove[i].in[0] <== i;
        anchorLengthAbove[i].in[1] <== anchorLength;
        inAnchor[i] <== anchorLengthAbove[i].out;
        anchorByteIsZero[i] = IsZero();
        anchorByteIsZero[i].in <== anchor[i];
        inAnchor[i] * anchorByteIsZero[i].out === 0;
        (1 - inAnchor[i]) * anchor[i] === 0;
    }
    // Slice: the bytes at and after the anchor — its 32 bytes, the longest value and the terminator, 65 at the 32/32
    // bound. Every byte the extraction reads is range-checked here, because `EmailVerifier` binds `decodedEmailBodyIn`
    // through a Poseidon random linear combination and never per byte.
    component sliceShift = VarShiftLeft(maxLen, maxAnchor + maxValue + 1);
    sliceShift.in <== in;
    sliceShift.shift <== anchorIndex;
    signal slice[maxAnchor + maxValue + 1];
    component sliceBits[maxAnchor + maxValue + 1];
    for (var k = 0; k < maxAnchor + maxValue + 1; k++) {
        slice[k] <== sliceShift.out[k];
        sliceBits[k] = Num2Bits(8);
        sliceBits[k].in <== slice[k];
    }
    // The anchor's declared bytes are the slice's first `anchorLength` bytes. With the occurrence count
    // below, that makes `anchorIndex` the anchor's only position in the window.
    for (var m = 0; m < maxAnchor; m++) {
        inAnchor[m] * (slice[m] - anchor[m]) === 0;
    }
    // The anchor occurs exactly once in `in`, so no second occurrence can be selected, and a field that appears only
    // in the headers is rejected with a count of 0. The count runs over all `maxLen` entries, SHA-256 padding and zero
    // fill included, exactly as `src/inputs/template-locate.ts` counts over the same array. It is the dominant cost of
    // this template, so it is not repeated anywhere.
    component anchorOccurrences = CountSubstringOccurrences(maxLen, maxAnchor);
    anchorOccurrences.in <== in;
    anchorOccurrences.substring <== anchor;
    anchorOccurrences.count === 1;
    // Tail: the slice from the end of the anchor, so `tail[j]` is the byte at distance `j` after the
    // anchor. 32 + 32 < 65, so this shift cannot wrap either.
    component tailShift = VarShiftLeft(maxAnchor + maxValue + 1, maxValue + 1);
    tailShift.in <== slice;
    tailShift.shift <== anchorLength;
    signal tail[maxValue + 1];
    for (var j = 0; j <= maxValue; j++) {
        tail[j] <== tailShift.out[j];
    }
    // Value: the first `valueLength` tail bytes, zero from there on so the packed encoding is canonical. Each of
    // those bytes is in the field's charset and none of them is the terminator, while `tail[valueLength]` is the
    // terminator itself.
    signal inValue[maxValue];
    component valueLengthAbove[maxValue];
    component charsetMember[maxValue];
    component terminatorEqual[maxValue];
    for (var v = 0; v < maxValue; v++) {
        valueLengthAbove[v] = LessThan(6);
        valueLengthAbove[v].in[0] <== v;
        valueLengthAbove[v].in[1] <== valueLength;
        inValue[v] <== valueLengthAbove[v].out;
        value[v] <== tail[v] * inValue[v];
        charsetMember[v] = TmCharsetMember();
        charsetMember[v].in <== tail[v];
        terminatorEqual[v] = IsEqual();
        terminatorEqual[v].in[0] <== tail[v];
        terminatorEqual[v].in[1] <== terminator;
        for (var s = 0; s < 4; s++) {
            charsetMember[v].sel[s] <== sel[s];
        }
        inValue[v] * (1 - charsetMember[v].out) === 0;
        inValue[v] * terminatorEqual[v].out === 0;
    }
    // Prohibiting the terminator inside the value goes beyond AAP 0.5.5's text: without it a terminator the charset
    // admits — say `<` under `text` — would leave several lengths valid, because the value could end at any of its
    // terminators. With it the value ends at the first terminator after the anchor, so exactly one length satisfies
    // the constraints. Changing a supported charset or the terminator rule changes what the extraction accepts, and so
    // requires a circuit revision and a new trusted setup.
    //
    // Padding: SHA-256 ends every padded body with its 8-byte bit length, whose high bytes are zero for any real body,
    // so a 0x00 always follows the 0x80 pad marker; no charset admits 0x00 and the terminator is non-zero, so a value
    // can never run past the marker into that length field.
    //
    // The byte after the value is that terminator: an asserting gadget rather than a selector, since `valueLength` is
    // in 1-32, so the index is always valid and only a length whose byte is not the terminator can fail it.
    component terminatorAtLength = ItemAtIndex(maxValue + 1);
    terminatorAtLength.in <== tail;
    terminatorAtLength.index <== valueLength;
    terminatorAtLength.out === terminator;
}

