pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "./anchor_extract.circom";

// =================================================================================================
// registry_membership: membership of both of the itinerary proof's leaves in the one published
// registry (AAP 0.5.5). It is what makes the circuit's public `issuerId` and `cityId` mean anything:
// the key that verified the DKIM signature, with the extraction template that located the stay
// fields, must be an issuer leaf, and the city alias the signed body carried must be a city leaf.
// Both proofs run against the same root, which the main circuit takes as a public input and
// `apps/api/src/modules/proofs/verifier.ts` checks against the active root.
//
//   issuer leaf   Poseidon(1, issuerId, pubkeyHash, templateHash)
//   city leaf     Poseidon(2, cityId, cityAliasHash)
//
// The registry is a fixed-depth binary Poseidon tree, depth 8 (256 leaves), built by
// `src/registry/merkle.ts` from the leaves `src/registry/leaves.ts` derives and committed to
// `config/registry/{production,test}.json`. Level 0 is the leaf level, the leaf index is the sum of
// the path bits with bit i weighting 2^i, bit 0 meaning the current node is the left child, the empty
// leaf is zero, and issuer leaves come first.
//
// Soundness. Every value entering a hash is an input signal, an output of a template that constrains
// it, or a constant, and nothing is assigned with `<--`, so the two roots depend on the prover's
// inputs only through the declared constraints. The leading domain tags keep one leaf type from
// standing in for the other, because the tag is the first hash input and the two leaf hashes differ
// in arity. An empty leaf cannot be proven either, since zero is not a Poseidon output, and a path
// bit outside {0, 1} fails witness generation.
// =================================================================================================

/// @title MerkleInclusion
/// @notice Proves that `leaf` sits at the position `pathIndices` names in a binary Poseidon tree of
///         the given depth, and returns the root the path reaches (AAP 0.5.5). `RegistryMembership`
///         runs two instances of it, one per leaf, and constrains both roots to the published root.
/// @notice The gadget is the sibling-swap form, one multiplication per level for the swap plus one for
///         the binary check: with `b` the path bit and `d = pathElements[i] − cur`, the pair hashed is
///         `(cur + b·d, pathElements[i] − b·d)`, which is `(cur, pathElements[i])` at bit 0 and the
///         reverse at bit 1. Level 0 is the leaf level, so the leaf index is `Σ bit_i · 2^i`, the
///         encoding `merkleRoot`/`merkleProof` in `src/registry/merkle.ts` builds the tree with.
/// @param depth The tree depth; 8 for the published registry, so at most 256 leaves.
/// @input leaf The leaf value, the output of the leaf hash of `RegistryMembership`.
/// @input pathElements The sibling hash at each level, level 0 first.
/// @input pathIndices The path bit at each level: 0 when the current node is the left child.
/// @output root The root this path reaches, which the caller constrains to the published root.
template MerkleInclusion(depth) {
    // A depth of zero would make `nodes[depth]` the leaf itself, proving no membership at all.
    assert(depth > 0);

    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    signal output root;

    // The node at each level; `nodes[0]` is the leaf, and `nodes[depth]` is what the path reaches.
    signal nodes[depth + 1];
    // Per-level working signals. circom admits signal and component declarations only in a template's
    // initial scope, so they are arrays sized by `depth` rather than declared inside the loop.
    signal bit[depth];
    signal offset[depth];
    signal left[depth];
    signal right[depth];

    component hashers[depth];

    nodes[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // The path bit is constrained binary, so a third value fails witness generation rather than
        // quietly selecting a child the tree does not have. circom admits a single multiplication per
        // constraint, which this and the swap below are.
        bit[i] <== pathIndices[i];
        bit[i] * (bit[i] - 1) === 0;

        // `offset` is zero at bit 0 and the difference between sibling and node at bit 1, so the left
        // child is the node at bit 0 and the sibling at bit 1, and the right child is the other.
        offset[i] <== bit[i] * (pathElements[i] - nodes[i]);
        left[i] <== nodes[i] + offset[i];
        right[i] <== pathElements[i] - offset[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        nodes[i + 1] <== hashers[i].out;
    }

    root <== nodes[depth];
}

/// @title CityAliasHash
/// @notice Hashes one city alias into the value the city leaf commits to (AAP 0.5.5), from the alias as
///         `FieldExtract` returns it: the value's bytes zero-padded to 32, and its length.
/// @notice `cityAliasHash` in `packages/circuits/src/registry/leaves.ts` computes the identical value
///         off the circuit, so the alias an issuer's email actually carried is the alias the registry
///         registered, and a prover cannot name a city whose leaf the tree does not hold.
/// @notice The length is hashed together with the bytes because the bytes arrive zero-padded: without
///         it, two aliases differing only in length and the zero fill after them would hash alike, and
///         that zero fill is not part of the signed text. `FieldExtract` bounds `cityLength` to 1-32 and
///         zeroes every byte at or beyond it, so the pair is canonical for the extracted value.
/// @input cityBytes The alias's bytes, zero-padded to 32 by `FieldExtract`.
/// @input cityLength The alias's length in bytes, 1 to 32.
/// @output out The alias hash the city leaf takes.
template CityAliasHash() {
    signal input cityBytes[32];
    signal input cityLength;

    signal output out;

    // The packing that is injective over byte strings, with each byte range-checked to 0-255.
    component packed = CheckedPackBytes(32);
    packed.in <== cityBytes;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== cityLength;
    hasher.inputs[1] <== packed.out[0];
    hasher.inputs[2] <== packed.out[1];
    out <== hasher.out;
}

/// @title RegistryMembership
/// @notice Proves that both leaves of the itinerary proof are leaves of the one registry the verifier
///         holds: the issuer key and extraction template that produced the proof, and the city alias
///         the signed email body carried (AAP 0.5.5). Instantiated with depth 8 by the main circuit.
/// @notice `pubkeyHash` is `EmailVerifier`'s `PoseidonLarge(n, k)` hash of the RSA modulus limbs its
///         check consumed — 121 limbs of 17 bits at the parameters the main circuit instantiates — so
///         the key whose membership is proven here is the very key that verified the DKIM signature
///         over this email, and `templateHash` is the hash of the extraction parameters
///         `lib/template_hash.circom` computed over the ones the extraction actually used. The main
///         circuit assigns the public `issuerId` and `cityId` from these same signals and its public
///         `registryRoot` from the input constrained below, so neither value can be reported as one the
///         tree does not hold. `apps/api/src/modules/proofs/verifier.ts` accepts only the active
///         published root.
/// @param depth The tree depth; 8 for the published registry, so at most 256 leaves.
/// @input registryRoot The published registry root both proofs are constrained to reach.
/// @input issuerId The issuer's id, the second input of the issuer leaf.
/// @input pubkeyHash The verifying key's limb hash, the third input of the issuer leaf.
/// @input templateHash The extraction template's hash, the fourth input of the issuer leaf.
/// @input issuerPathElements The issuer leaf's sibling hashes, level 0 first.
/// @input issuerPathIndices The issuer leaf's path bits; `build-inputs.ts` emits both arrays.
/// @input cityId The city's id, the second input of the city leaf.
/// @input cityAliasHash The alias hash from `CityAliasHash`, the third input of the city leaf.
/// @input cityPathElements The city leaf's sibling hashes, level 0 first.
/// @input cityPathIndices The city leaf's path bits.
template RegistryMembership(depth) {
    assert(depth > 0);

    signal input registryRoot;

    signal input issuerId;
    signal input pubkeyHash;
    signal input templateHash;
    signal input issuerPathElements[depth];
    signal input issuerPathIndices[depth];

    signal input cityId;
    signal input cityAliasHash;
    signal input cityPathElements[depth];
    signal input cityPathIndices[depth];

    // Issuer leaf, domain tag 1: the key that signed the email and the template that read it, exactly
    // the leaf `issuerLeaf` builds for the registry.
    component issuerLeaf = Poseidon(4);
    issuerLeaf.inputs[0] <== 1;
    issuerLeaf.inputs[1] <== issuerId;
    issuerLeaf.inputs[2] <== pubkeyHash;
    issuerLeaf.inputs[3] <== templateHash;

    // City leaf, domain tag 2: the city the proof names and the alias the body carried.
    component cityLeaf = Poseidon(3);
    cityLeaf.inputs[0] <== 2;
    cityLeaf.inputs[1] <== cityId;
    cityLeaf.inputs[2] <== cityAliasHash;

    component issuerMembership = MerkleInclusion(depth);
    issuerMembership.leaf <== issuerLeaf.out;
    for (var i = 0; i < depth; i++) {
        issuerMembership.pathElements[i] <== issuerPathElements[i];
        issuerMembership.pathIndices[i] <== issuerPathIndices[i];
    }
    issuerMembership.root === registryRoot;

    component cityMembership = MerkleInclusion(depth);
    cityMembership.leaf <== cityLeaf.out;
    for (var i = 0; i < depth; i++) {
        cityMembership.pathElements[i] <== cityPathElements[i];
        cityMembership.pathIndices[i] <== cityPathIndices[i];
    }
    cityMembership.root === registryRoot;
}
