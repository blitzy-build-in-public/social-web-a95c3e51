pragma circom 2.1.9;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "@zk-email/circuits/utils/array.circom";

/// @title BodyWindow
/// @notice Fixes the body tail window that `EmailVerifier` hashes, from the email's own length bytes:
///         the longest 64-byte-aligned padded suffix the verifier admits, which is the whole padded body
///         when it fits in `maxWindow` bytes (prefix length 0, nothing precomputed) and otherwise exactly
///         `maxWindow` bytes.
/// @notice Without this constraint the prover would choose the window, and with it which occurrence of
///         every anchor the body-window extraction can see. `maxWindow` is 960 for the 1,024-byte body
///         bound, the largest 64-byte multiple below that bound.
/// @param maxBodyLength The body bound handed to `EmailVerifier`; the window is zero-padded to this size.
/// @param maxWindow The largest window `EmailVerifier` admits for that bound.
/// @input emailBody The padded body window as ASCII byte values, zero-padded to `maxBodyLength`.
/// @input emailBodyLength The window length in bytes, a whole number of SHA-256 blocks.
/// @input precomputedSHA SHA-256 state entering the window; the IV when the prefix is empty.
template BodyWindow(maxBodyLength, maxWindow) {
    assert(maxWindow % 64 == 0);
    assert(maxWindow < maxBodyLength);
    assert(maxWindow <= 960);

    signal input emailBody[maxBodyLength];
    signal input emailBodyLength;
    signal input precomputedSHA[32];

    // SHA-256 initial state as 32 big-endian bytes:
    // 6a09e667 bb67ae85 3c6ef372 a54ff53a 510e527f 9b05688c 1f83d9ab 5be0cd19.
    var IV[32] = [
        0x6a, 0x09, 0xe6, 0x67, 0xbb, 0x67, 0xae, 0x85,
        0x3c, 0x6e, 0xf3, 0x72, 0xa5, 0x4f, 0xf5, 0x3a,
        0x51, 0x0e, 0x52, 0x7f, 0x9b, 0x05, 0x68, 0x8c,
        0x1f, 0x83, 0xd9, 0xab, 0x5b, 0xe0, 0xcd, 0x19
    ];

    // SHA-256 padding ends every padded message with the message's bit length, so the last eight bytes of
    // the padded body are that length field. The window is a suffix of the padded body under either rule
    // below, so the last eight window bytes are the same field, and those bytes are part of the message
    // whose digest is the `bh=` value the DKIM signature over the headers covers. The email, and not the
    // prover, therefore fixes the window and every anchor occurrence extractable inside it.
    component lengthField = VarShiftLeft(maxBodyLength, 8);
    lengthField.in <== emailBody;
    lengthField.shift <== emailBodyLength - 8;

    signal lengthBytes[8];
    for (var t = 0; t < 8; t++) {
        lengthBytes[t] <== lengthField.out[t];
    }

    // The bit length is the big-endian integer over those eight bytes, and its three low bits are zero
    // because the field counts whole bytes. Decomposing the last byte therefore gives the body's byte
    // count L = Σ_{t<7} len[t]·2^(8·(6−t)+5) + Σ_{b=3..7} bit_b·2^(b−3), formed here as a linear
    // combination. `Sha256BytesPartial` range-checks the seven high bytes in the full circuit; standing
    // alone, the 58-bit quotient below is what already bounds L.
    component lastByteBits = Num2Bits(8);
    lastByteBits.in <== lengthBytes[7];
    for (var b = 0; b < 3; b++) {
        lastByteBits.out[b] === 0;
    }

    var byteLengthSum = 0;
    for (var t = 0; t < 7; t++) {
        byteLengthSum += lengthBytes[t] * (1 << (8 * (6 - t) + 5));
    }
    for (var b = 3; b < 8; b++) {
        byteLengthSum += lastByteBits.out[b] * (1 << (b - 3));
    }
    signal byteLength;
    byteLength <== byteLengthSum;

    // Minimal SHA-256 padding: the L body bytes, a 0x80 marker, zeros and the 8 length bytes land on the
    // next 64-byte boundary, so with L + 8 = 64·q + r the padded length is 64·(q + 1), equal to
    // 64·ceil((L + 9)/64) for every r in [0, 63]. q is constrained to 58 bits to keep the padded length
    // within 2^64.
    signal quotient;
    signal remainder;
    quotient <-- (byteLength + 8) \ 64;
    remainder <-- (byteLength + 8) % 64;
    byteLength + 8 === 64 * quotient + remainder;

    component quotientBits = Num2Bits(58);
    quotientBits.in <== quotient;
    component remainderBits = Num2Bits(6);
    remainderBits.in <== remainder;

    signal totalPadded;
    totalPadded <== 64 * (quotient + 1);

    // q < 2^58 keeps totalPadded at or below 2^64, over which range the circomlib comparator is sound;
    // at that endpoint it answers "does not fit", which is the correct answer for every admissible
    // maxWindow.
    component fits = LessEqThan(64);
    fits.in[0] <== totalPadded;
    fits.in[1] <== maxWindow;
    signal isFull;
    isFull <== fits.out;

    // Window rule: the whole padded body when it fits, otherwise exactly maxWindow bytes. Email body
    // lengths are multiples of 64 bytes, so this admits only a window between 64 and 960 bytes, which
    // keeps the length-field indexes above below maxBodyLength and makes a 1,024-byte window impossible.
    // `EmailVerifier` applies the same bound from the other side: Num2Bits(log2Ceil(1024)) = Num2Bits(10)
    // rejects 1,024 outright, and `src/inputs/build-inputs.ts` never emits such a window either, cutting
    // at max(0, paddedLen − 960).
    emailBodyLength === maxWindow + isFull * (totalPadded - maxWindow);

    // Defence in depth for the whole-body case: with nothing precomputed the hash runs from block 0, so
    // the state entering the window must be the IV. The prover cannot widen the window, but it could
    // otherwise hand in a state that claims a prefix the padding does not allow; this denies that.
    for (var i = 0; i < 32; i++) {
        isFull * (precomputedSHA[i] - IV[i]) === 0;
    }
}
