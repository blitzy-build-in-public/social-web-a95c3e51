pragma circom 2.1.9;

// tablemate_itinerary — the statement a traveler's device proves about an imported booking
// confirmation, on the device, with the email never leaving it (AAP 0.5.5):
//
//   "The DKIM RSA-SHA256 signature over this email's canonical headers verifies under a public key
//    whose issuer record is in the published registry; the signed body hash matches the body; and
//    the bytes the issuer's registered template locates in the signed body hold a stay in city X
//    from date A to date B with booking reference R."
//
// A thin composition: `EmailVerifier` from @zk-email/circuits 6.3.4 does the DKIM and body-hash work, and
// every extraction, template, date, registry and nullifier rule lives in ./lib. The public signals, in the
// order snarkjs delivers them, are the five outputs followed by the two public inputs —
// `[cityId, arrivalDate, departureDate, issuerId, nullifier, registryRoot, nullifierSalt]`, the
// `PUBLIC_SIGNAL_NAMES` of `packages/shared/src/schemas/proofs.ts`. Nothing else about the email is public:
// the guest name, the booking reference, the address, the price and the email text never reach a public
// signal (AAP 0.12.2).

include "@zk-email/circuits/email-verifier.circom";
include "./lib/body_window.circom";
include "./lib/anchor_extract.circom";
include "./lib/template_hash.circom";
include "./lib/date_parse.circom";
include "./lib/registry_membership.circom";
include "./lib/nullifier.circom";

/// @title TablemateItinerary
/// @notice One DKIM-authenticated booking email, one stay in one registered city, one spendable
///         nullifier (AAP 0.5.5).
/// @param maxHeadersLength Signed-header bound in bytes: 1,024, a whole number of SHA-256 blocks.
/// @param maxBodyLength Body bound in bytes: 1,024. `EmailVerifier` range-checks a body length with
///        `Num2Bits(log2Ceil(maxBodyLength))`, so the longest padded window it admits — and the
///        longest `BodyWindow` permits — is `maxBodyLength - 64`, 960 bytes.
/// @param n Bits per RSA chunk: 121.
/// @param k RSA chunks: 17. `n * k` exceeds 2,048 and `n` stays below 127, as the verifier requires.
/// @param depth Registry tree depth: 8, so at most 256 leaves.
/// @input registryRoot The published registry root both Merkle paths must reach.
/// @input nullifierSalt The server-published salt the nullifier is taken with.
/// @input emailHeader The signed canonical headers as ASCII bytes, padded to `maxHeadersLength`.
/// @input emailHeaderLength The header length including its SHA-256 padding.
/// @input pubkey The DKIM RSA modulus, split into `k` chunks of `n` bits.
/// @input signature The DKIM signature, split the same way.
/// @input emailBody The padded body window as ASCII bytes.
/// @input emailBodyLength The window's length in whole SHA-256 blocks, which `emailBody`'s own bit
///        length field fixes.
/// @input bodyHashIndex Where the `bh=` body hash sits in the header.
/// @input precomputedSHA The SHA-256 state entering the window: the IV when it starts at block 0.
/// @input decodedEmailBodyIn The body with soft line breaks removed; `EmailVerifier` constrains it
///        against the signed bytes and it is the only input the field extraction reads.
/// @input anchorIndex Each field's anchor position in the decoded window, in field order: city,
///        arrival, departure, booking reference.
/// @input valueLength Each field's value length in bytes, 1 to 32.
/// @input anchors The four anchors, zero-padded to 32 bytes, in field order.
/// @input anchorLength The four anchor lengths in bytes, 1 to 32.
/// @input terminator The byte that ends each field's value; non-zero.
/// @input charset Each field's charset code: 1 digits, 2 alnum, 3 date, 4 text.
/// @input dateFormat The registered date layout: 1 ISO_YMD, 2 D_MONTH_YYYY, 3 MONTH_D_YYYY,
///        4 DOW_D_MON_YYYY.
/// @input issuerIdIn, cityIdIn The ids hashed into the two leaves and reported as the outputs.
/// @input issuerPathElements, issuerPathIndices The issuer leaf's Merkle path, level 0 first.
/// @input cityPathElements, cityPathIndices The city leaf's Merkle path, level 0 first.
/// @output cityId The city's integer circuit id, the same signal its leaf was built from.
/// @output arrivalDate The arrival date as a `YYYYMMDD` integer.
/// @output departureDate The departure date as a `YYYYMMDD` integer.
/// @output issuerId The issuer's id, the same signal its leaf was built from.
/// @output nullifier The booking reference hashed with `nullifierSalt`.
template TablemateItinerary(maxHeadersLength, maxBodyLength, n, k, depth) {
    // Compile-time checks, on template parameters only — never on signals, which a prover chooses.
    // `maxWindow` is the largest window the verifier's `Num2Bits(log2Ceil(maxBodyLength))` check admits:
    // at most `maxBodyLength - 64`. A body bound that is not a 64-byte multiple or not a power of two
    // would put those two bounds at odds, so both are rejected here; `BodyWindow` re-checks the window.
    assert(maxBodyLength % 64 == 0);
    assert((1 << log2Ceil(maxBodyLength)) == maxBodyLength);
    assert(depth >= 1);
    var maxWindow = maxBodyLength - 64;
    assert(maxWindow > 0);
    // Public outputs first and public inputs next, in the one order PUBLIC_SIGNAL_NAMES fixes; the
    // `public` list on `main` below repeats it.
    signal output cityId;
    signal output arrivalDate;
    signal output departureDate;
    signal output issuerId;
    signal output nullifier;
    signal input registryRoot;
    signal input nullifierSalt;
    // DKIM passthrough, exactly the verifier's input set under the flags used below.
    signal input emailHeader[maxHeadersLength];
    signal input emailHeaderLength;
    signal input pubkey[k];
    signal input signature[k];
    signal input emailBody[maxBodyLength];
    signal input emailBodyLength;
    signal input bodyHashIndex;
    signal input precomputedSHA[32];
    signal input decodedEmailBodyIn[maxBodyLength];
    // The extraction, in field order city (0), arrival (1), departure (2), reference (3).
    signal input anchorIndex[4];
    signal input valueLength[4];
    signal input anchors[4][32];
    signal input anchorLength[4];
    signal input terminator[4];
    signal input charset[4];
    signal input dateFormat;
    // The two registry paths.
    signal input issuerIdIn;
    signal input cityIdIn;
    signal input issuerPathElements[depth];
    signal input issuerPathIndices[depth];
    signal input cityPathElements[depth];
    signal input cityPathIndices[depth];
    component emailVerifier = EmailVerifier(maxHeadersLength, maxBodyLength, n, k, 0, 0, 0, 1);
    component bodyWindow = BodyWindow(maxBodyLength, maxWindow);
    component fields[4];
    component templateHash = TemplateHash();
    component arrivalParse = DateParse();
    component departureParse = DateParse();
    component cityAlias = CityAliasHash();
    component registry = RegistryMembership(depth);
    component nullifierHash = Nullifier();
    // The DKIM check, with body-hash checking on, both maskings off and soft line breaks removed (the AAP
    // 0.5.5 flags): `pubkeyHash` below is the very key this check consumed. `shaHi` and `shaLo` carry the
    // same digest in packed form and no rule here needs them, so they are left unconnected.
    emailVerifier.emailHeader <== emailHeader;
    emailVerifier.emailHeaderLength <== emailHeaderLength;
    emailVerifier.pubkey <== pubkey;
    emailVerifier.signature <== signature;
    emailVerifier.emailBody <== emailBody;
    emailVerifier.emailBodyLength <== emailBodyLength;
    emailVerifier.bodyHashIndex <== bodyHashIndex;
    emailVerifier.precomputedSHA <== precomputedSHA;
    emailVerifier.decodedEmailBodyIn <== decodedEmailBodyIn;
    // Window rule: the email's own length field, not the prover, decides whether the whole padded
    // body is hashed or only its `maxWindow`-byte tail (960 for the instance below), and with it
    // which occurrence of each anchor the extraction below can reach at all.
    bodyWindow.emailBody <== emailBody;
    bodyWindow.emailBodyLength <== emailBodyLength;
    bodyWindow.precomputedSHA <== precomputedSHA;
    // The four stay fields, read from the decoded signed body and never from a header, because the
    // statement places the stay in the body. `FieldExtract` requires the anchor to occur exactly
    // once in the window and the value to end at the first terminator after it, so a field has one
    // possible position and one possible length.
    for (var f = 0; f < 4; f++) {
        fields[f] = FieldExtract(maxBodyLength, 32, 32);
        fields[f].in <== decodedEmailBodyIn;
        fields[f].anchor <== anchors[f];
        fields[f].anchorLength <== anchorLength[f];
        fields[f].anchorIndex <== anchorIndex[f];
        fields[f].valueLength <== valueLength[f];
        fields[f].terminator <== terminator[f];
        fields[f].charset <== charset[f];
    }
    // Over exactly the signals the extractions were handed, so a template differing from the registered
    // one in any anchor, length, terminator, charset or date format hashes to a value with no leaf.
    templateHash.anchors <== anchors;
    templateHash.anchorLength <== anchorLength;
    templateHash.terminator <== terminator;
    templateHash.charset <== charset;
    templateHash.dateFormat <== dateFormat;
    // Both dates in the layout the template selected. This circuit does not order the dates, check the
    // stay length or bound the stay to 120 days: the server checks `1 <= departure - arrival <= 120`
    // days on the public outputs (AAP 0.5.5), so nothing here is duplicated into a constraint.
    arrivalParse.value <== fields[1].value;
    arrivalParse.length <== valueLength[1];
    arrivalParse.format <== dateFormat;
    departureParse.value <== fields[2].value;
    departureParse.length <== valueLength[2];
    departureParse.format <== dateFormat;
    cityAlias.cityBytes <== fields[0].value;
    cityAlias.cityLength <== valueLength[0];
    // Both leaves in the one published registry: the verifying key with the template that read the
    // stay, and the alias the signed body carried. Neither the issuer nor the city can be named
    // unless the tree holds it.
    registry.registryRoot <== registryRoot;
    registry.issuerId <== issuerIdIn;
    registry.pubkeyHash <== emailVerifier.pubkeyHash;
    registry.templateHash <== templateHash.out;
    registry.cityId <== cityIdIn;
    registry.cityAliasHash <== cityAlias.out;
    for (var i = 0; i < depth; i++) {
        registry.issuerPathElements[i] <== issuerPathElements[i];
        registry.issuerPathIndices[i] <== issuerPathIndices[i];
        registry.cityPathElements[i] <== cityPathElements[i];
        registry.cityPathIndices[i] <== cityPathIndices[i];
    }
    // The booking reference with the published salt: the only public value the reference produces,
    // and the value the API keys `SpentNullifier` on.
    nullifierHash.refBytes <== fields[3].value;
    nullifierHash.refLength <== valueLength[3];
    nullifierHash.salt <== nullifierSalt;
    cityId <== cityIdIn;
    arrivalDate <== arrivalParse.out;
    departureDate <== departureParse.out;
    issuerId <== issuerIdIn;
    nullifier <== nullifierHash.out;
}

component main { public [registryRoot, nullifierSalt] } = TablemateItinerary(1024, 1024, 121, 17, 8);
