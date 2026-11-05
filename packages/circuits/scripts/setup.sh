#!/usr/bin/env bash
#
# Groth16 phase 2 — the development ceremony and the proving-artefact manifest (AAP 0.5.5).
#
# Turns the circuit compile.sh produced into the artefacts the clients prove with:
#
#   build/tablemate_itinerary.zkey   the proving key; only the `artifacts` service serves it
#   build/verification_key.json      the only circuit artefact the api image mounts
#   build/artifacts.manifest.json    sizes and SHA-256 of the three artefacts, the clients' check
#
# In order: `groth16 setup` against the phase 1 file powersOfTau28_hez_final_22.ptau, two
# contributions, a public beacon, a full `zkey verify` against the R1CS, and the verification-key
# export. The transcript, the contribution hashes and the final key hashes go to docs/zk-proofs.md.
#
# A development ceremony for this environment only: the contributions are made by this script alone
# and the beacon is public. The multi-party production ceremony belongs to launch preparation and is
# out of scope (AAP 0.7.2).
#
# Invoked as `bash scripts/setup.sh` through the `circuit:setup` package script and root
# `circuits:setup`; root `circuits:build` runs compile.sh first, which this script does not repeat.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

BUILD_DIR="$PKG_DIR/build"
ARTIFACT="$BUILD_DIR/tablemate_itinerary"
R1CS="$ARTIFACT.r1cs"
WASM="$ARTIFACT.wasm"
ZKEY="$ARTIFACT.zkey"
VKEY="$BUILD_DIR/verification_key.json"
MANIFEST="$BUILD_DIR/artifacts.manifest.json"
DOC="$REPO_ROOT/docs/zk-proofs.md"

# The phase 1 file, its published digest and its byte size. The digest is the
# powersOfTau28_hez_final_22.ptau row of the snarkjs README's "Prepare phase 2" ptau table, which the
# v0.7.5 tag and current master list identically, and BLAKE2b-512 is the algorithm that table
# publishes. The size check reads no bytes and catches a truncated download before the digest pass,
# which alone takes minutes on 4.8 GB.
PTAU="${PTAU_PATH:-$BUILD_DIR/ptau/powersOfTau28_hez_final_22.ptau}"
PTAU_B2SUM=0d64f63dba1a6f11139df765cb690da69d9b2f469a1ddd0de5e4aa628abb28f787f04c6a5fb84a235ec5ea7f41d0548746653ecab0559add658a83502d1cb21b
PTAU_SIZE=4831921304
PTAU_URL="${PTAU_URL:-https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_22.ptau}"
PTAU_MIRROR="https://circom.info/powersOfTau28_hez_final_22.ptau"

# A beacon is public by definition: a supplied BEACON_HASH reproduces an earlier ceremony, and
# otherwise fresh random bytes are used and recorded in docs/zk-proofs.md. The exponent is fixed at
# 10 (2^10 iterations); snarkjs accepts 10 to 63.
BEACON_HASH="${BEACON_HASH:-}"
BEACON_EXP=10

die() {
    printf 'setup.sh: %s\n' "$1" >&2
    exit 1
}

command -v node >/dev/null 2>&1 || die "node is not on PATH; install Node 22.23.4"

# snarkjs and tsx are resolved the way compile.sh resolves snarkjs: the hoisted install keeps both at
# the repository root, while a package-local node_modules may hold either instead.
SNARKJS=""
SNARKJS_MODULES=""
TSX=""
for root in "$PKG_DIR/node_modules" "$REPO_ROOT/node_modules"; do
    if [ -z "$SNARKJS" ] && [ -x "$root/.bin/snarkjs" ]; then
        SNARKJS="$root/.bin/snarkjs"
        SNARKJS_MODULES="$root"
    fi
    if [ -z "$TSX" ] && [ -x "$root/.bin/tsx" ]; then TSX="$root/.bin/tsx"; fi
done
[ -n "$SNARKJS" ] || die "snarkjs is not installed under node_modules/.bin; run pnpm install"
[ -n "$TSX" ] || die "tsx is not installed under node_modules/.bin; run pnpm install"

# ---------------------------------------------------------------------------------------------
# Phase 1 — the compiled circuit and the powers-of-tau file
# ---------------------------------------------------------------------------------------------

if [ ! -f "$R1CS" ] || [ ! -f "$WASM" ]; then
    die "run pnpm circuits:compile first: $R1CS and $WASM are both required"
fi

DOWNLOADED=0
if [ ! -f "$PTAU" ]; then
    command -v curl >/dev/null 2>&1 ||
        die "curl is not on PATH and $PTAU is missing; fetch powersOfTau28_hez_final_22.ptau (4.8 GB) and set PTAU_PATH"
    mkdir -p "$(dirname "$PTAU")"
    printf 'setup.sh: fetching %s (about 4.8 GB); an interrupted transfer resumes on the next run\n' "$PTAU_URL"
    if ! curl -fL --retry 3 -C - -o "$PTAU.part" "$PTAU_URL"; then
        printf 'setup.sh: %s failed; trying the mirror %s\n' "$PTAU_URL" "$PTAU_MIRROR"
        curl -fL --retry 3 -C - -o "$PTAU.part" "$PTAU_MIRROR" ||
            die "could not download powersOfTau28_hez_final_22.ptau from either URL"
    fi
    mv "$PTAU.part" "$PTAU"
    DOWNLOADED=1
fi

stream_digest() {
    # stream_digest <file> <algorithm>: the lowercase hex digest of the whole file, read in 4 MiB
    # chunks so a multi-gigabyte artefact is never held in memory. It hashes BLAKE2b-512 where no
    # b2sum exists (macOS) and every SHA-256 the manifest records.
    node -e '
        const { createHash } = require("node:crypto");
        const { createReadStream } = require("node:fs");
        const hash = createHash(process.argv[2]);
        createReadStream(process.argv[1], { highWaterMark: 4194304 })
            .on("data", (chunk) => hash.update(chunk))
            .on("error", (error) => { console.error(error.message); process.exit(1); })
            .on("end", () => process.stdout.write(hash.digest("hex") + "\n"));
    ' "$1" "$2"
}

file_size() {
    # file_size <file>: the byte size, whatever padding this platform's wc prints around it.
    wc -c < "$1" | tr -d ' \t'
}

PTAU_BYTES="$(file_size "$PTAU")"
if [ "$PTAU_BYTES" != "$PTAU_SIZE" ]; then
    if [ "$DOWNLOADED" = 1 ]; then rm -f "$PTAU"; fi
    die "$PTAU is $PTAU_BYTES bytes, not the $PTAU_SIZE bytes of powersOfTau28_hez_final_22.ptau"
fi

if command -v b2sum >/dev/null 2>&1; then
    PTAU_DIGEST="$(b2sum "$PTAU" | awk '{print $1}')" || die "b2sum failed on $PTAU"
else
    PTAU_DIGEST="$(stream_digest "$PTAU" blake2b512)" || die "could not hash $PTAU"
fi
if [ "$PTAU_DIGEST" != "$PTAU_B2SUM" ]; then
    # A file this run downloaded is unusable, so it is removed for the next run to fetch again; a
    # file the caller supplied through PTAU_PATH belongs to the caller and is only reported.
    if [ "$DOWNLOADED" = 1 ]; then rm -f "$PTAU"; fi
    die "$PTAU has BLAKE2b-512 $PTAU_DIGEST, not the published $PTAU_B2SUM"
fi
printf 'setup.sh: phase 1 file verified at %s (%s bytes)\n' "$PTAU" "$PTAU_BYTES"

# ---------------------------------------------------------------------------------------------
# Phase 2 — the ceremony
# ---------------------------------------------------------------------------------------------

# A circuit of a few million constraints needs well over node's default heap, and the run is long:
# the step labels below are all the progress a reader gets for a while.
export NODE_OPTIONS="--max-old-space-size=${CIRCUITS_NODE_HEAP_MB:-16384}"
SNARKJS_VERSION="$(node -p "require('$SNARKJS_MODULES/snarkjs/package.json').version" 2>/dev/null)" ||
    die "could not read the snarkjs version from $SNARKJS_MODULES/snarkjs/package.json"
printf 'setup.sh: snarkjs %s under %s (the ceremony takes a long time)\n' "$SNARKJS_VERSION" "$NODE_OPTIONS"

LOG="$(mktemp "${TMPDIR:-/tmp}/tablemate-setup-transcript.XXXXXX")" || die "could not create a temporary transcript"
STEP_OUT="$(mktemp "${TMPDIR:-/tmp}/tablemate-setup-step.XXXXXX")" || die "could not create a temporary step output"
DOC_CONTENT=""

cleanup() {
    # Neither an intermediate key nor the transcript outlives the run: a _000N.zkey is not an
    # artefact, and a transcript could hold a contribution entropy.
    rm -f "$LOG" "$STEP_OUT" \
        "$ARTIFACT"_0000.zkey "$ARTIFACT"_0001.zkey "$ARTIFACT"_0002.zkey
    if [ -n "$DOC_CONTENT" ]; then rm -f "$DOC_CONTENT"; fi
}
trap cleanup EXIT

capture() {
    # capture <command...>: shows the command's output with the ANSI colour codes stripped and
    # appends that output to the transcript the hashes are parsed from, returning the command's exit
    # status to the caller.
    local status=0
    "$@" 2>&1 | sed $'s/\x1b\\[[0-9;]*m//g' | tee "$STEP_OUT" || status=$?
    cat "$STEP_OUT" >> "$LOG"
    return "$status"
}

run_step() {
    # run_step <label> <command...>: runs one ceremony step, which has to succeed. The command line
    # is never printed, because a `zkey contribute` command line carries its entropy.
    local label="$1"
    shift
    printf '\nsetup.sh: %s\n' "$label"
    if ! capture "$@"; then
        die "$label failed; its output above is the end of the transcript"
    fi
}

run_check() {
    # run_check <label> <command...>: run_step for a command whose non-zero exit is an answer rather
    # than a failure, such as `zkey verify`, and whose status is therefore returned to the caller.
    local label="$1"
    shift
    printf '\nsetup.sh: %s\n' "$label"
    local status=0
    capture "$@" || status=$?
    return "$status"
}

extract_hash() {
    # extract_hash <label>: the digest snarkjs prints under that label in the current step's output,
    # with formatHash's indentation and group spacing collapsed. Empty when the label or the digest
    # is absent, which the caller records as "unavailable": `zkey verify` is the authoritative check.
    awk -v label="$1" '
        function collapse(s) { gsub(/[ \t\r]/, "", s); sub(/^:?/, "", s); return s }
        !started {
            at = index($0, label)
            if (at == 0) next
            started = 1
            rest = collapse(substr($0, at + length(label)))
            if (rest ~ /^[0-9a-fA-F]+$/) digest = rest
            next
        }
        started {
            line = collapse($0)
            if (line ~ /^[0-9a-fA-F]+$/) { digest = digest line; next }
            exit
        }
        END { if (digest != "") print tolower(digest) }
    ' "$STEP_OUT"
}

entropy() {
    # Fresh 64 random bytes as hex, the entropy of one contribution. `od -v` prints every group:
    # without it, a run of identical 16-byte groups collapses into a `*` line and the value would
    # come out short. The width is checked rather than assumed, because a short entropy would
    # silently weaken the contribution.
    local value
    value="$(head -c 64 /dev/urandom | od -An -v -tx1 | tr -d ' \n')"
    [ "${#value}" = 128 ] || die "entropy generation produced ${#value} hex characters, not 128"
    printf '%s\n' "$value"
}

scrub_secret() {
    # scrub_secret <literal>: removes a literal secret from the transcript, so an entropy cannot sit
    # in the log even if a tool ever echoes one.
    local tmp="$LOG.scrubbed"
    awk -v secret="$1" 'index($0, secret) == 0 { print; next } { gsub(secret, "***"); print }' "$LOG" > "$tmp"
    mv "$tmp" "$LOG"
}

run_step 'phase 2: groth16 setup against the phase 1 file (the longest step)' \
    "$SNARKJS" groth16 setup "$R1CS" "$PTAU" "$ARTIFACT"_0000.zkey
CIRCUIT_HASH="$(extract_hash 'Circuit hash')"

CONTRIBUTION_1="$(entropy)"
run_step 'phase 2: contribution 1 of 2' \
    "$SNARKJS" zkey contribute "$ARTIFACT"_0000.zkey "$ARTIFACT"_0001.zkey \
    -v -e="$CONTRIBUTION_1" -n="tablemate dev contribution 1"
HASH_1="$(extract_hash 'Contribution Hash')"
scrub_secret "$CONTRIBUTION_1"
CONTRIBUTION_1=""

CONTRIBUTION_2="$(entropy)"
run_step 'phase 2: contribution 2 of 2' \
    "$SNARKJS" zkey contribute "$ARTIFACT"_0001.zkey "$ARTIFACT"_0002.zkey \
    -v -e="$CONTRIBUTION_2" -n="tablemate dev contribution 2"
HASH_2="$(extract_hash 'Contribution Hash')"
scrub_secret "$CONTRIBUTION_2"
CONTRIBUTION_2=""

if [ -z "$BEACON_HASH" ]; then
    BEACON_HASH="$(head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n')"
    [ "${#BEACON_HASH}" = 64 ] || die "beacon generation produced ${#BEACON_HASH} hex characters, not 64"
fi
run_step 'phase 2: beacon' \
    "$SNARKJS" zkey beacon "$ARTIFACT"_0002.zkey "$ZKEY" "$BEACON_HASH" "$BEACON_EXP" -n="tablemate dev beacon"
BEACON_CONTRIBUTION="$(extract_hash 'Contribution Hash')"

# The `ZKey Ok!` line is the authoritative check of the whole ceremony. snarkjs's H-section test
# draws a random linear combination and, on a circuit small enough to drive its worker threads into
# degenerate sizes, reports a mismatch for a key that verifies, while a genuinely wrong key fails
# every attempt. The check only reads the R1CS, the phase 1 file and the key, all unchanged between
# attempts, so it is retried rather than trusted once.
ZKEY_VERIFIED=""
for attempt in 1 2 3; do
    if run_check 'phase 2: verifying the final key against the R1CS and the phase 1 file (slow)' \
        "$SNARKJS" zkey verify "$R1CS" "$PTAU" "$ZKEY" && grep -q 'ZKey Ok!' "$STEP_OUT"; then
        ZKEY_VERIFIED="$attempt"
        break
    fi
    printf 'setup.sh: that attempt reported no "ZKey Ok!"; the three files are unchanged, so the key is verified again\n'
done
[ -n "$ZKEY_VERIFIED" ] ||
    die "zkey verify reported no \"ZKey Ok!\" in three attempts: $ZKEY does not match the circuit and the phase 1 file"
[ "$ZKEY_VERIFIED" = 1 ] || printf 'setup.sh: the key verified on attempt %s of 3\n' "$ZKEY_VERIFIED"

run_step 'phase 2: exporting the verification key' \
    "$SNARKJS" zkey export verificationkey "$ZKEY" "$VKEY"
[ -f "$VKEY" ] || die "snarkjs did not write $VKEY"

[ -n "$CIRCUIT_HASH" ] || CIRCUIT_HASH="unavailable"
[ -n "$HASH_1" ] || HASH_1="unavailable"
[ -n "$HASH_2" ] || HASH_2="unavailable"
[ -n "$BEACON_CONTRIBUTION" ] || BEACON_CONTRIBUTION="unavailable"

# ---------------------------------------------------------------------------------------------
# Phase 3 — artifacts.manifest.json (AAP 0.5.5)
# ---------------------------------------------------------------------------------------------

WASM_SIZE="$(file_size "$WASM")"
WASM_SHA="$(stream_digest "$WASM" sha256)" || die "could not hash $WASM"
ZKEY_SIZE="$(file_size "$ZKEY")"
ZKEY_SHA="$(stream_digest "$ZKEY" sha256)" || die "could not hash $ZKEY"
VKEY_SIZE="$(file_size "$VKEY")"
VKEY_SHA="$(stream_digest "$VKEY" sha256)" || die "could not hash $VKEY"

manifest_entry() {
    # manifest_entry <key> <file name> <size> <sha256>: one `files` entry, indented for the 2-space
    # JSON the clients and the `artifacts` service read.
    printf '    "%s": {\n      "name": "%s",\n      "size": %s,\n      "sha256": "%s"\n    }' \
        "$1" "$2" "$3" "$4"
}

{
    printf '{\n  "circuit": "tablemate_itinerary",\n  "createdAt": "%s",\n  "files": {\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    manifest_entry wasm tablemate_itinerary.wasm "$WASM_SIZE" "$WASM_SHA"
    printf ',\n'
    manifest_entry zkey tablemate_itinerary.zkey "$ZKEY_SIZE" "$ZKEY_SHA"
    printf ',\n'
    manifest_entry verificationKey verification_key.json "$VKEY_SIZE" "$VKEY_SHA"
    printf '\n  }\n}\n'
} > "$MANIFEST"

# The manifest is a contract with ArtifactsManifest in packages/shared, so it is parsed rather than
# trusted: an unknown key, an uppercase digest or a missing file entry stops the ceremony here.
manifest_check='Promise.all([import("@tablemate/shared"), import("node:fs")]).then(([shared, fs]) => {
  shared.ArtifactsManifest.parse(JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, "utf8")));
}, (error) => { console.error(String((error && error.message) || error)); process.exitCode = 1; });'

if ! ( cd "$PKG_DIR" && MANIFEST_PATH="$MANIFEST" "$TSX" --conditions=tablemate-source --eval "$manifest_check" ); then
    die "$MANIFEST does not parse against ArtifactsManifest from @tablemate/shared"
fi
printf 'setup.sh: %s parses against ArtifactsManifest\n' "$(basename "$MANIFEST")"

# ---------------------------------------------------------------------------------------------
# Phase 4 — docs/zk-proofs.md
# ---------------------------------------------------------------------------------------------

write_doc_block() {
    # write_doc_block <file> <block name> <content file>: replaces what sits between the named
    # markers, or appends the block when the file or either marker is absent. The replacement goes
    # through a temporary file in the same directory, so a reader never sees a half-written
    # document.
    local file="$1" name="$2" content="$3" tmp begin end
    begin="<!-- BEGIN $name -->"
    end="<!-- END $name -->"
    tmp="$file.tmp.$$"
    mkdir -p "$(dirname "$file")"
    if [ -f "$file" ] && grep -qF "$begin" "$file" && grep -qF "$end" "$file"; then
        # The content file is read with awk's getline: a multi-line value cannot travel through
        # `awk -v`, which BSD awk and mawk both reject.
        awk -v begin="$begin" -v end="$end" -v content="$content" '
            $0 == begin { print; while ((getline line < content) > 0) print line; close(content); inside = 1; next }
            $0 == end { inside = 0 }
            !inside { print }
        ' "$file" > "$tmp"
    else
        : > "$tmp"
        if [ -f "$file" ]; then cat "$file" >> "$tmp"; fi
        { printf '\n%s\n' "$begin"; cat "$content"; printf '%s\n' "$end"; } >> "$tmp"
    fi
    mv "$tmp" "$file"
}

DOC_CONTENT="$(mktemp "${TMPDIR:-/tmp}/tablemate-setup-block.XXXXXX")" ||
    die "could not create a temporary file for the docs block"

{
    printf 'ptau file|%s (%s bytes)\n' "$(basename "$PTAU")" "$PTAU_BYTES"
    printf 'ptau BLAKE2b-512|%s\n' "$PTAU_B2SUM"
    printf 'ptau source|%s\n' "$PTAU_URL"
    printf 'snarkjs|%s\n' "$SNARKJS_VERSION"
    printf 'Circuit hash|%s\n' "$CIRCUIT_HASH"
    printf 'Contribution 1 name|%s\n' 'tablemate dev contribution 1'
    printf 'Contribution 1 hash|%s\n' "$HASH_1"
    printf 'Contribution 2 name|%s\n' 'tablemate dev contribution 2'
    printf 'Contribution 2 hash|%s\n' "$HASH_2"
    printf 'Beacon hash|%s\n' "$BEACON_HASH"
    printf 'Beacon iterations|%s (2^%s)\n' "$BEACON_EXP" "$BEACON_EXP"
    printf 'Beacon contribution hash|%s\n' "$BEACON_CONTRIBUTION"
    printf 'zkey verify|%s\n' "ZKey Ok! (attempt $ZKEY_VERIFIED of 3)"
    printf 'Final zkey SHA-256|%s\n' "$ZKEY_SHA"
    printf 'Final zkey size|%s bytes\n' "$ZKEY_SIZE"
    printf 'Verification key SHA-256|%s\n' "$VKEY_SHA"
    printf 'Ceremony (UTC)|%s\n' "$(date -u +%Y-%m-%d)"
    printf 'Note|Development ceremony for this environment; the multi-party production ceremony is out of scope (AAP 0.7.2).\n'
} | awk -F'|' '
    # A two-column table whose cells are padded to the widest of their column and which is framed
    # by a blank line on each side: the exact shape prettier gives markdown tables, which the
    # repository lint runs this file through.
    { label[NR] = $1; value[NR] = $2
      if (length($1) > labelWidth) labelWidth = length($1)
      if (length($2) > valueWidth) valueWidth = length($2) }
    END {
        labelRule = sprintf("%*s", labelWidth, ""); gsub(/ /, "-", labelRule)
        valueRule = sprintf("%*s", valueWidth, ""); gsub(/ /, "-", valueRule)
        printf "\n| %-*s | %-*s |\n", labelWidth, "Item", valueWidth, "Value"
        printf "| %s | %s |\n", labelRule, valueRule
        for (i = 1; i <= NR; i++) printf "| %-*s | %-*s |\n", labelWidth, label[i], valueWidth, value[i]
        printf "\n"
    }' > "$DOC_CONTENT"

write_doc_block "$DOC" "circuits:setup" "$DOC_CONTENT"

printf 'setup.sh: ceremony complete; the artefacts are in %s\n' "$BUILD_DIR"
printf '  %-30s %12s bytes  sha256 %s\n' 'tablemate_itinerary.zkey' "$ZKEY_SIZE" "$ZKEY_SHA"
printf '  %-30s %12s bytes  sha256 %s\n' 'tablemate_itinerary.wasm' "$WASM_SIZE" "$WASM_SHA"
printf '  %-30s %12s bytes  sha256 %s\n' 'verification_key.json' "$VKEY_SIZE" "$VKEY_SHA"
printf 'setup.sh: the ceremony is recorded in %s (block circuits:setup)\n' "$DOC"
