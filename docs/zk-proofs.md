# ZK proofs

The circuit a traveler's device proves an imported booking confirmation with, the registry its two leaves
must reach, the issuer records behind it, and the trusted setup the artefacts in the tree were built by
(AAP 0.5.5). The device builds the circuit inputs, proves locally and posts `{ proof, publicSignals }`
alone; the server verifies that submission and reads the stay it proves, holding no proving key, no circuit
WASM, no witness generator and no private input (AAP 0.5.5, 0.12.2).

Two blocks are written by the build and replaced on every run of the script that owns them, so nothing
inside their markers is edited by hand: **Circuit size** by `pnpm circuits:compile`, **Development trusted
setup** by `pnpm circuits:setup`. Measured proving and verification times are in
[`zk-performance.md`](./zk-performance.md); what the scripts write, and when, is in
[`operations.md`](./operations.md).

## The statement proved

Proved, in the request's words: _"I hold a genuine booking from an allowlisted issuer that places me in
city X between dates A and B."_ The circuit statement
(`packages/circuits/circuits/tablemate_itinerary.circom`, template `TablemateItinerary`): the DKIM
RSA-SHA256 signature over this email's canonical headers verifies under a public key whose issuer record is
in the published registry; the signed body hash matches the body; and the bytes the issuer's registered
template locates in the signed body hold a stay in city X from date A to date B with booking reference R.
Every public output is therefore bound to a registry leaf or to authenticated body bytes, and a prover can
substitute neither a key, a template, a city alias nor a field boundary.

## Signals

The seven public signals, in the order snarkjs delivers them and `PUBLIC_SIGNAL_NAMES`
(`packages/shared/src/schemas/proofs.ts`) fixes — five outputs, then two public inputs:

| #   | Signal          | Kind         | Meaning                                                                         |
| --- | --------------- | ------------ | ------------------------------------------------------------------------------- |
| 0   | `cityId`        | output       | The city's integer circuit id, the same signal its registry leaf was built from |
| 1   | `arrivalDate`   | output       | The arrival date as a `YYYYMMDD` integer, day precision                         |
| 2   | `departureDate` | output       | The departure date as a `YYYYMMDD` integer, day precision                       |
| 3   | `issuerId`      | output       | The issuer's id, the same signal its leaf was built from                        |
| 4   | `nullifier`     | output       | The booking reference hashed with `nullifierSalt`                               |
| 5   | `registryRoot`  | public input | The published root both Merkle paths must reach                                 |
| 6   | `nullifierSalt` | public input | The published salt the nullifier is taken with                                  |

Position is part of the contract — a signal is read by index, the compiled circuit must report exactly five
outputs and two public inputs, and `compile.sh` fails the build on any other count. A submission that does
not carry exactly seven signals is `400 proof_malformed` (AAP 0.5.4).

Private inputs, as `TablemateItinerary` declares them: the signed canonical header bytes and their length;
the padded body window's bytes and its length; `bodyHashIndex`; the SHA-256 state entering the window; the
decoded body with soft line breaks removed; the DKIM RSA modulus (`pubkey[17]`) and the signature
(`signature[17]`) as 121-bit limbs; the four fields' `anchorIndex`, `valueLength`, `anchors[4][32]`,
`anchorLength`, `terminator` and `charset`; the `dateFormat` code; the `issuerIdIn` and `cityIdIn` signals
the leaves and the outputs share; and the two Merkle paths (`issuerPathElements[8]`,
`issuerPathIndices[8]`, `cityPathElements[8]`, `cityPathIndices[8]`).

The guest name, the booking reference, the address, the price and the email text appear in no public
signal, and the client transmits nothing but `{ proof, publicSignals }` — `ProofSubmission` is a
`z.strictObject` at both levels (AAP 0.12.2).

## Composition

`TablemateItinerary(maxHeadersLength = 1024, maxBodyLength = 1024, n = 121, k = 17, depth = 8)`: a
composition of `EmailVerifier` from `@zk-email/circuits` 6.3.4 and six templates in
`packages/circuits/circuits/lib/`.

### DKIM verification

`EmailVerifier(1024, 1024, 121, 17, 0, 0, 0, 1)`, in the template's parameter order `(maxHeadersLength,
maxBodyLength, n, k, ignoreBodyHashCheck, enableHeaderMasking, enableBodyMasking, removeSoftLineBreaks)`:
the body-hash check on, both maskings off, soft line breaks removed, and SHA-256 precompute so only the
padded window's tail is hashed in-circuit. `n · k` is 2,057 bits, above the 2,048 an RSA-2048 modulus needs.
The verifier's own `Num2Bits(log2Ceil(maxBodyLength))` check rejects a padded window of the full 1,024
bytes, so the longest window it accepts — and the longest `BodyWindow` permits — is 960 bytes, the largest
64-byte multiple below the bound. Its `pubkeyHash` output, the `PoseidonLarge(121, 17)` hash over the 17
modulus limbs its RSA check consumed, is wired straight into the issuer leaf, so the key whose registry
membership is proven is the very key that verified this signature. The packed `shaHi`/`shaLo` digest outputs
are left unconnected: no rule here needs them.

### `lib/body_window.circom`

Fixes which window is hashed, from the email rather than from the prover. SHA-256 padding ends every padded
body with the message's bit length, so the last eight window bytes are that field; `BodyWindow` reads the
body's byte count out of it and requires `emailBodyLength === maxWindow + isFull · (totalPadded − maxWindow)`
— the whole padded body when it fits in 960 bytes, otherwise exactly 960 bytes. Without that constraint the
prover would choose the window, and with it which occurrence of every anchor the extraction can reach. A
whole-body window additionally requires the entered SHA-256 state to be the IV, since nothing is
precomputed then.

### `lib/anchor_extract.circom`

Reads the four stay fields — city, arrival, departure, booking reference — out of the decoded,
DKIM-authenticated body window and never out of a header, because the statement places the stay in the body.
`FieldExtract(1024, 32, 32)`, one instance per field:

- the anchor is 1–32 bytes at the prover-supplied `anchorIndex`, non-zero inside its length and zero after
  it;
- the anchor occurs exactly once in the whole 1,024-byte window (`CountSubstringOccurrences === 1`), so no
  second occurrence can be selected, and a field that lives only in a signed header is rejected with a count
  of 0;
- the value runs from the end of the anchor to the field's terminator: 1–32 bytes, each in the field's
  charset, none of them the terminator, with that terminator at exactly `valueLength`;
- every byte from `valueLength` on is zero, so the padding cannot vary and the packed value is canonical;
- the 65-byte slice the extraction reads is range-checked per byte, because `EmailVerifier` binds
  `decodedEmailBodyIn` through a Poseidon random linear combination rather than per byte.

`CheckedPackBytes(32)` is the injective packing every anchor, extracted value and city alias is hashed with:
bytes 0–30 little-endian in the first field element, byte 31 in the second, every byte range-checked to
0–255, and a packed value always hashed with its length. `packBytes` in
`packages/circuits/src/registry/leaves.ts` mirrors it off-circuit.

**Deviation:** the AAP names this template `PackBytes(32)`. `@zk-email/circuits`, already included by
`email-verifier.circom`, defines a `PackBytes(maxBytes)` of its own and circom rejects a duplicate name, so
the name here is `CheckedPackBytes(32)`: zk-email's encoding, instantiated, plus the byte range check the
AAP's injectivity argument rests on and zk-email's version omits.

**Deviation:** the terminator is prohibited inside the value, an addition beyond the AAP's extraction rules.
A terminator the charset admits — say `<` under `text` — would otherwise leave several valid value lengths,
and the length is what the template hash and the nullifier are taken over.

### `lib/template_hash.circom`

`templateHash` commits a proof to the extraction parameters it used: the four anchors packed by
`CheckedPackBytes(32)`, their lengths, the four terminators, the four charset codes and the date-format
code. Circomlib's `Poseidon` takes at most 16 inputs, so the value is nested — `Poseidon(8)` over the eight
packed anchor halves, `Poseidon(13)` over the lengths, terminators, charsets and format code, then
`Poseidon(2)` over those two — in the parameter order
`packages/circuits/src/registry/template-hash.ts` hashes off-circuit. Both codes are pinned to their coded
sets, each by `(x−1)(x−2)(x−3)(x−4) = 0`, so a template differing from the registered one in any anchor
byte, anchor length, terminator, charset code or date-format code hashes to a value the registry holds no
leaf for.

### `lib/date_parse.circom`

`DateParse`, one instance per date, turns an extracted value into the public `YYYYMMDD` integer under the
layout the template's format code names:

| Code | Layout           | Example           |
| ---- | ---------------- | ----------------- |
| 1    | `ISO_YMD`        | `2026-03-04`      |
| 2    | `D_MONTH_YYYY`   | `4 March 2026`    |
| 3    | `MONTH_D_YYYY`   | `March 4, 2026`   |
| 4    | `DOW_D_MON_YYYY` | `Wed, 4 Mar 2026` |

The grammar is exact and English: full capitalized month names for layouts 2 and 3, a three-letter month and
weekday for layout 4, one ASCII space between the parts, and the whole value consumed. The year must be
2020–2099, the month 1–12 (exactly one of the twelve name rows must match) and the day within that month's
length under the Gregorian leap-year rule, so `2026-02-30`, month 13 and non-digit date bytes are
unsatisfiable. The format code is part of the template hash and so of the issuer's leaf, which is why a
prover cannot choose a layout the issuer never registered.

The circuit neither orders the two dates nor bounds the stay: `1 ≤ departure − arrival ≤ 120` days is
checked on the public outputs by the server (AAP 0.5.5).

### `lib/registry_membership.circom`

Two `MerkleInclusion(8)` proofs against the one public `registryRoot`, with every path bit constrained
binary, level 0 the leaf level and the leaf index the sum of the path bits weighted `2^i`:

- issuer leaf `Poseidon(1, issuerId, pubkeyHash, templateHash)` — the key that verified the signature with
  the template that read the stay;
- city leaf `Poseidon(2, cityId, cityAliasHash)`, where `CityAliasHash` is
  `Poseidon(cityLength, pack(city)[0], pack(city)[1])` over the alias the signed body carried.

The leading domain tags keep one leaf type from standing in for the other: the tags differ and the two leaf
hashes differ in arity. The public `issuerId` and `cityId` are the same signals their leaves are built from,
so neither can be reported as a value the tree does not hold, and the padded positions hold zero, which no
Poseidon output can be, so an empty leaf cannot be proven either.

### `lib/nullifier.circom`

`nullifier = Poseidon(refLength, pack(ref)[0], pack(ref)[1], nullifierSalt)`: the booking reference —
canonical, because the extraction zeroes its padding and fixes its length — hashed with the public salt. It
is the only public value the reference produces and the value the API keys `SpentNullifier` on, so one
booking backs one proof, and hashing the length apart from the bytes means references differing only in byte
31, or only in length over the same bytes, give different nullifiers. `nullifierOf` in
`packages/circuits/src/registry/leaves.ts` computes the same value off-circuit with `poseidon-lite`, so the
device knows the nullifier the API will look up before it proves.

## Circuit size

The circuit was estimated at 2.5–3.5 million constraints. `pnpm circuits:compile` records the count the
compiler reports, requires five outputs and two public inputs, and fails when the count exceeds 4,194,304
(2^22), the capacity of the phase 1 file the ceremony is run against. The count is written as
`exceeds limit` before the failure is reported, so an oversize circuit is documented rather than only
rejected.

<!-- BEGIN circuits:compile -->

| Item             | Value                                             |
| ---------------- | ------------------------------------------------- |
| Constraints      | 2538201                                           |
| Phase 1 capacity | 4,194,304 (2^22, powersOfTau28_hez_final_22.ptau) |
| Result           | within limit                                      |
| Wires            | 2491345                                           |
| Private inputs   | 3324                                              |
| Public inputs    | 2                                                 |
| Outputs          | 5                                                 |
| circom           | circom compiler 2.1.9                             |
| snarkjs          | 0.7.6                                             |
| Compiled (UTC)   | 2026-11-05                                        |

<!-- END circuits:compile -->

## Registry and issuers

The registry is a fixed-depth-8 binary Poseidon tree — at most 256 leaves — built by
`packages/circuits/src/registry/merkle.ts` from the leaves in
`packages/circuits/src/registry/leaves.ts`, and written by `pnpm circuits:registry` to
`config/registry/{production,test}.json`. Issuer key leaves come first, then city alias leaves, and the
padded positions hold the empty leaf, zero. A committed file holds its populated `leaves` in index order
beside the `issuers` and `cities` entries they were built from — the issuer's id and key hashes, the city's
id, slug and alias, and each entry's leaf index.

### Issuer records

One file per issuer, `config/issuers/<stem>.json`, parsed by `IssuerConfig`
(`packages/shared/src/schemas/proofs.ts`): `issuerId`, `displayName`, `verificationStatus`, `keys` (each a
DKIM `domain`, `selector` and `modulusBase64`) and `template` — the four fields' `anchor`, `terminator` and
`charset`, plus the `dateFormat` code. Those four fields are the ones the circuit's `FieldExtract` instances
are wired to, in the order city, arrival, departure, reference, and each key's `pubkeyHash` and the
template's `templateHash` are derived by the builder with the circuit's own hashing, never entered by hand.
An anchor is 1–32 UTF-8 bytes, a terminator a non-zero byte no charset admits as `0x00`, and a city alias
the bytes it has in the decoded body, quoted-printable escapes included — which is why `config/cities.json`
lists `Ciudad de M=C3=A9xico` beside `Ciudad de México`.

### Verification lifecycle

| Status             | Meaning                                                                                              | Registry leaf                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `awaiting_samples` | No real confirmation email supplied: no key, `template: null`                                        | None; `GET /v1/zk/config` lists the issuer as unsupported |
| `unverified`       | Records authored from user-supplied samples in the git-ignored `packages/circuits/samples/<issuer>/` | None                                                      |
| `verified`         | Every sample builds inputs, proves and verifies under `pnpm circuits:samples`                        | One, in the production registry                           |

`fetch-dkim-key` fills the key records from the samples' `d=` and `s=` tags, keeping only a signature whose
signing domain is the message's `From` domain or a parent of it. `check-samples` then builds a witness,
proves and verifies every sample, printing pass or fail per file and field and never a field's value.
Promotion to `verified` is an explicit operator act: `check-samples` prints the status change and the
rebuild to run, and the new status is recorded below.

### Issuer status

| Issuer         | File                                 | Status             | Notes                                                                                                                                                                                             |
| -------------- | ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking.com    | `config/issuers/booking-com.json`    | `awaiting_samples` | **Unverified — awaiting real confirmation emails**                                                                                                                                                |
| Airbnb         | `config/issuers/airbnb.json`         | `awaiting_samples` | **Unverified — awaiting real confirmation emails**                                                                                                                                                |
| Tablemate test | `config/issuers/tablemate-test.json` | `verified`         | A synthetic RSA-2048 key generated per fixture build by `make-test-fixtures.ts`, whose private half is never written or logged. It receives a leaf in the test registry only, never in production |

Both real issuers await samples, so at this revision no production proof can name an issuer:
`config/registry/production.json` holds 13 city alias leaves and no issuer leaf, while
`config/registry/test.json` holds those same aliases plus the test issuer's key leaf at index 0 — 14 leaves
and a root of its own. The import screen therefore shows "This booking site isn't supported yet." for them
and lists the supported issuers from `GET /v1/zk/config`, and the fixtures, the circuit tests and an
`APP_ENV=test` stack prove against the test registry.

### Committed registries

Both files are deterministic — no timestamp and no ordering the configuration does not fix — so a rerun is
byte-identical, and `pnpm circuits:registry --check` reports a stale file and exits 1 without writing. The
API refuses to start when a rebuild of `config/issuers/*.json` and `config/cities.json` differs from the
committed file on `root`, `leaves`, `issuers` or `cities` (`checkZkConfiguration`, called from `main.ts`
before the app listens), so adding an issuer or a city alias is a configuration edit plus a rebuild, with no
circuit change.

## Client input generation

`packages/circuits/src/inputs/` builds the circuit inputs on the device — under Hermes in the native app and
in the web Worker — from the `.eml` the traveler picked: `eml-parse.ts` parses the message,
`dkim-canonicalize.ts` reproduces the signed header and body, `sha-partial.ts` exposes the SHA-256 state the
precompute needs, `template-locate.ts` locates the four fields and parses their dates, and `build-inputs.ts`
assembles the inputs. The module works on `Uint8Array` throughout, imports no Node built-in (`crypto`,
`dns`, `fs`), never touches a global `Buffer`, and never imports `@zk-email/helpers`, whose git-hosted
snarkjs fork and Node built-ins cannot run under Hermes.

The DKIM key comes from the published registry by the signature's `d=` and `s=` tags, so the client performs
no DNS lookup — resolving selectors is `fetch-dkim-key`'s job alone. `template-locate.ts` mirrors
`FieldExtract` and `DateParse` exactly and never tightens them, because a false refusal on the device blocks
an email that would have proved; the window is cut at `max(0, paddedLength − 960)`, so a 1,024-byte window is
never emitted. `test/inputs.test.ts` compares the generator's output with `@zk-email/helpers` 6.4.2
`generateEmailVerifierInputs`, configured with the same 960-byte bound, for every fixture.

## Server verification

`POST /itinerary-proofs` hands `verifyItineraryProof` (`apps/api/src/modules/proofs/verifier.ts`) the
`{ proof, publicSignals }` and nothing else. The checks run in this order:

| #   | Check                                                                                                  | Answer                       |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| 0   | Each signal is a canonical field element, below the BN254 scalar field order `r`                       | `422 proof_invalid`          |
| 1   | `snarkjs.groth16.verify` against the mounted verification key                                          | `422 proof_invalid`          |
| 2   | The `nullifierSalt` signal equals the published `NULLIFIER_SALT`                                       | `422 proof_invalid`          |
| 3   | The `registryRoot` signal is a root this process publishes                                             | `422 issuer_not_allowlisted` |
| 4   | `cityId`, `issuerId` and both dates name entries of that registry and of the launch-city configuration | `422 proof_invalid`          |
| 5   | The stay is between `STAY_MIN_DAYS` (1) and `STAY_MAX_DAYS` (120) days                                 | `422 stay_out_of_range`      |
| 6   | The nullifier is spent by an insert into `SpentNullifier`                                              | `409 nullifier_used`         |

A submission that does not carry the seven signals is `400 proof_malformed`, and an absent or unusable
verification key is `503 service_unavailable`.

**Deviation:** steps 0 and 4 are narrower than the AAP's ordered list, which names schema, Groth16, the
salt, the root, the stay and the nullifier. Step 0 canonicalizes the signals before either verifying or
reading them: a value at or above the field order is reduced in-circuit and would verify a different number
than the checks read, and `FieldElement` admits leading zeros, so `"007"` and `"7"` would otherwise be two
spellings of one nullifier and could slip past a unique index. Step 4 resolves the city and the issuer out
of the registry the root named, and the dates out of the launch-city configuration. Step 6 belongs to the
route (`proofs/routes.ts`), inside the same transaction as the `ItineraryProof` row.

The proof is stored with `validFrom` two local days before the arrival (`PROOF_VALID_FROM_DAYS_BEFORE`) and
`validTo` the last instant of the departure day in the city's zone, both inclusive. The `api` image mounts
`verification_key.json` and the artefact manifest and nothing else: it calls no proving entrypoint and holds
no proving key, no circuit WASM and no witness generator (`apps/api/test/unit/no-prover.test.ts`).

## The nullifier salt

`NULLIFIER_SALT` is a decimal BN254 scalar field element — `FieldElement`'s `^\d{1,78}$` and below the field
order `r` — validated at startup by `packages/server-core/src/env/api.ts`, which refuses a value at or above
`r` because the circuit would reduce it and no proof could then ever pass. It is published to devices by
`GET /v1/zk/config` and compared with every submission's `nullifierSalt` signal.

Generate a fresh random value per environment and keep it fixed for that environment's lifetime: changing it
changes every nullifier, so `SpentNullifier` rows written under the old salt no longer match new proofs of
the same booking. An environment that verifies the committed circuit fixtures sets the salt they are built
with, `1` (`make-test-fixtures.ts`, `check-samples.ts`; `docker-compose.yml` defaults `NULLIFIER_SALT` to `1`
for the same reason), while the API integration harness sets `TEST_NULLIFIER_SALT` of its own in
`apps/api/test/support/proofs.ts`. `.env.example` records the rule.

## Development trusted setup

`pnpm circuits:setup` runs the Groth16 phase 2 over the compiled circuit: `snarkjs groth16 setup` against the
phase 1 file, two contributions, a public beacon, a full `zkey verify` against the R1CS, and the
verification-key export. The transcript below records the phase 1 file with its verified BLAKE2b-512 digest
and the source it came from, the R1CS hash, each contribution's hash and the beacon's, the verify result,
and the final proving key's and verification key's SHA-256 and sizes — public hashes and sizes only, never
contribution entropy. A rerun draws fresh beacon entropy unless `BEACON_HASH` is supplied, so it produces a
different proving key and a different transcript, and the rows below are the record of the run that wrote
them. The ceremony leaves three artefacts in the git-ignored
`packages/circuits/build/`: `tablemate_itinerary.zkey`, the proving key, which only the `artifacts` service
serves; `verification_key.json`, the only circuit artefact the `api` mounts; and `artifacts.manifest.json`,
whose names, sizes and SHA-256 digests are what a client checks its downloads against and what
`GET /v1/zk/config` publishes.

<!-- BEGIN circuits:setup -->

| Item                     | Value                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| ptau file                | powersOfTau28_hez_final_22.ptau (4831921304 bytes)                                                                               |
| ptau BLAKE2b-512         | 0d64f63dba1a6f11139df765cb690da69d9b2f469a1ddd0de5e4aa628abb28f787f04c6a5fb84a235ec5ea7f41d0548746653ecab0559add658a83502d1cb21b |
| ptau source              | https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_22.ptau                                                        |
| snarkjs                  | 0.7.6                                                                                                                            |
| Circuit hash             | b0fac5ba5d20ea633a54793d3dae3324f484cd613fc67f7cfe3faa3289c66485ca92b21966c07329299f21582c4bad15a33056764ac6030a921145fdcedd2971 |
| Contribution 1 name      | tablemate dev contribution 1                                                                                                     |
| Contribution 1 hash      | 3c6c48c55aecd57ce8cd32409db219c01dcb7949caf867d640257b554d1e26a5468451499841e8f9a3d67ba3ff377a7d02f7b298cc0ac608af0e275a45801970 |
| Contribution 2 name      | tablemate dev contribution 2                                                                                                     |
| Contribution 2 hash      | f0f918be9b9cc7e0c5c27e7f41cf7ba42f4268ead479c1a7f2ed784de8f27b1662b08e95e2e34fbc3d06b432488ffb9c3e9e5559e217b78fe875749df524b147 |
| Beacon hash              | db66284b2ef1368951cd0a0ea640e273c327ea9fb90d7f9f997fadb9cd371e3b                                                                 |
| Beacon iterations        | 10 (2^10)                                                                                                                        |
| Beacon contribution hash | b4b4d289a5d3db3dff44493ea3655bebb081f22487204d6fa8ef0d9d71b8526b081a2099476ae1f757b25df334dddc81e5c596f9fd1d9752d54e47238debc623 |
| zkey verify              | ZKey Ok! (attempt 1 of 3)                                                                                                        |
| Final zkey SHA-256       | cfe3c06bb77ca8bc792854e43a37489d85aa7acbb240855d791249cda7400713                                                                 |
| Final zkey size          | 1588395630 bytes                                                                                                                 |
| Verification key SHA-256 | 228452d42b79634272fabc6b52c6df6907a26a9f457040c7c1cbb0d9e4dc5306                                                                 |
| Ceremony (UTC)           | 2026-11-05                                                                                                                       |
| Note                     | Development ceremony for this environment; the multi-party production ceremony is out of scope (AAP 0.7.2).                      |

<!-- END circuits:setup -->

This is a development ceremony for the environment it was run in: both contributions are made by the
script alone and the beacon is public, so no independent party vouches for the key. A multi-party
production ceremony belongs to launch preparation and is out of scope (AAP 0.7.2).

## Circuit revisions

A date format, terminator or charset outside the coded sets that `CHARSET_CODE` and `DATE_FORMAT_CODE`
name requires a circuit revision and a new trusted setup: the extraction, the template hash and every
registry leaf change with it. Adding an issuer or a city alias, by contrast, is a configuration change
and a registry rebuild. After a revision the artefacts change too, and each client re-downloads them by
comparing the manifest's size and SHA-256 with what it holds.

| Date       | Change          | Constraints | Setup                            |
| ---------- | --------------- | ----------- | -------------------------------- |
| 2026-11-05 | Initial circuit | 2538201     | The `circuits:setup` block above |
