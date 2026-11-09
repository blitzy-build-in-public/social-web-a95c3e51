pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "./anchor_extract.circom";

// The proof's nullifier (AAP 0.5.5): the booking reference hashed with the server-published salt. It is the only
// public value the reference produces and the value the API keys `SpentNullifier` on, so one booking backs one proof
// (AAP 0.12.2). `nullifierOf` in `src/registry/leaves.ts` must hash the same argument order over the same packing, so
// the device derives the value the API looks up before it proves.

/// @title Nullifier
/// @notice Hashes one canonical booking reference with the published `nullifierSalt`.
/// @notice Invariants: `refBytes` is canonical — `FieldExtract` zeroes every byte at or beyond `refLength`, the
///         anchor's single occurrence fixes which value the field holds, and the terminator at `valueLength`,
///         never inside the value, fixes its length — so a booking cannot yield a second nullifier; `refLength`
///         is bounded to 1-32 where it is derived and hashed apart from the bytes it counts, so references
///         differing only in byte 31, or only in length over the same bytes, give different nullifiers;
///         `CheckedPackBytes` range-checks every byte to 0-255, so the packing is injective and each packed half
///         stays below 2^248, inside the BN254 field. `salt` is the public input `nullifierSalt`; the API rejects
///         a proof whose salt differs from the published `NULLIFIER_SALT` with `422 proof_invalid` (AAP 0.5.4).
/// @input refBytes The booking reference, zero-padded to 32 bytes as `FieldExtract` returns it; refLength
///         the reference length in bytes, 1-32.
/// @input salt The published `nullifierSalt`.
/// @output out The nullifier.
template Nullifier() {
    signal input refBytes[32];
    signal input refLength;
    signal input salt;
    signal output out;
    // `packed.out[0]` holds bytes 0-30 little-endian and `packed.out[1]` byte 31: the encoding
    // `packBytes` in `src/registry/leaves.ts` must reproduce.
    component packed = CheckedPackBytes(32);
    packed.in <== refBytes;
    // `Poseidon(refLength, p[0], p[1], salt)`: the argument order the nullifier rule and `nullifierOf` use.
    component hash = Poseidon(4);
    hash.inputs[0] <== refLength;
    hash.inputs[1] <== packed.out[0];
    hash.inputs[2] <== packed.out[1];
    hash.inputs[3] <== salt;
    out <== hash.out;
}
