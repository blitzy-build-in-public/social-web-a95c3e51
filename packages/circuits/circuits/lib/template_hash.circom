pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "./anchor_extract.circom";

// template_hash: the hash of the extraction parameters a proof actually used (AAP 0.5.5). An issuer's
// registry leaf is `Poseidon(1, issuerId, pubkeyHash, templateHash)`, so this value binds a proof to the
// template the issuer registered: moving an anchor, or changing one of its bytes or its length, a terminator,
// a charset code or the date-format code gives a hash with no registry leaf, hence no path to the published
// root and no proof naming that issuer (the "Templates" adversarial cases).
//
// Two nesting levels, because circomlib's `Poseidon` admits at most 16 inputs: `anchorsHash` hashes the four
// packed anchors, `paramsHash` the four lengths, terminators, charset codes and the date format, and `out` the
// two. Field order is city (0), arrival (1), departure (2), reference (3) everywhere in the circuit.
// `src/registry/template-hash.ts` computes the identical value over the same zero-padded anchors and the same
// packed encoding; the two must never diverge, because every issuer leaf is built from them.

/// @title TemplateHash
/// @notice The `templateHash` of the issuer leaf `Poseidon(1, issuerId, pubkeyHash, templateHash)`.
/// @notice Anchors are packed by `CheckedPackBytes(32)` — bytes 0-30 little-endian in `out[0]`, byte 31 in
///         `out[1]`, every byte range-checked to 0-255 — so the encoding is injective and byte 31 cannot
///         carry weight back into `out[0]`. `anchorLength` and `terminator` reach the four `FieldExtract`
///         instances the main circuit wires these same signals into, which range-check a length of 1-32 and a
///         non-zero terminator; the charset and date-format codes are pinned to the coded sets here so
///         `TemplateHash` is well-formed on its own, and `FieldExtract` and `DateParse` pin the same signals
///         again in the instantiated circuit, so the two paths agree rather than one relying on the other.
/// @notice A date format, terminator class or charset outside the coded sets below needs a circuit revision
///         and a new trusted setup, which `docs/zk-proofs.md` records, not a configuration edit.
/// @input anchors The four anchors, zero-padded to 32 bytes, in field order.
/// @input anchorLength The anchors' lengths in bytes, 1-32.
/// @input terminator The byte that ends each field's value.
/// @input charset Each field's charset code: 1 digits, 2 alnum, 3 date, 4 text.
/// @input dateFormat The date layout code: 1 ISO_YMD, 2 D_MONTH_YYYY, 3 MONTH_D_YYYY, 4 DOW_D_MON_YYYY.
/// @output out The template hash.
template TemplateHash() {
    signal input anchors[4][32];
    signal input anchorLength[4];
    signal input terminator[4];
    signal input charset[4];
    signal input dateFormat;
    signal output out;
    // Anchors, packed by field: `packedAnchor[2f]` and `packedAnchor[2f + 1]` are `anchors[f]`'s two
    // elements, in the order `Poseidon` receives them below.
    component anchorPack[4];
    signal packedAnchor[8];
    for (var f = 0; f < 4; f++) {
        anchorPack[f] = CheckedPackBytes(32);
        for (var b = 0; b < 32; b++) {
            anchorPack[f].in[b] <== anchors[f][b];
        }
        packedAnchor[2 * f] <== anchorPack[f].out[0];
        packedAnchor[2 * f + 1] <== anchorPack[f].out[1];
    }
    component anchorsHash = Poseidon(8);
    for (var i = 0; i < 8; i++) {
        anchorsHash.inputs[i] <== packedAnchor[i];
    }
    // Lengths, then terminators, then charsets, then the date format: the same parameter order
    // `src/registry/template-hash.ts` hashes.
    component paramsHash = Poseidon(13);
    for (var g = 0; g < 4; g++) {
        paramsHash.inputs[g] <== anchorLength[g];
        paramsHash.inputs[4 + g] <== terminator[g];
        paramsHash.inputs[8 + g] <== charset[g];
    }
    paramsHash.inputs[12] <== dateFormat;
    component templateDigest = Poseidon(2);
    templateDigest.inputs[0] <== anchorsHash.out;
    templateDigest.inputs[1] <== paramsHash.out;
    out <== templateDigest.out;
    // The codes are pinned to the ones `packages/shared/src/schemas/proofs.ts` writes down — `CHARSET_CODE`
    // 1 digits, 2 alnum, 3 date, 4 text and `DATE_FORMAT_CODE` 1 ISO_YMD, 2 D_MONTH_YYYY, 3 MONTH_D_YYYY,
    // 4 DOW_D_MON_YYYY — by requiring (x - 1)(x - 2)(x - 3)(x - 4) = 0. Two intermediate signals keep each
    // constraint quadratic, since circom admits no degree-four constraint.
    signal charsetLower[4];
    signal charsetUpper[4];
    for (var c = 0; c < 4; c++) {
        charsetLower[c] <== (charset[c] - 1) * (charset[c] - 2);
        charsetUpper[c] <== (charset[c] - 3) * (charset[c] - 4);
        charsetLower[c] * charsetUpper[c] === 0;
    }
    signal formatLower;
    signal formatUpper;
    formatLower <== (dateFormat - 1) * (dateFormat - 2);
    formatUpper <== (dateFormat - 3) * (dateFormat - 4);
    formatLower * formatUpper === 0;
}
