#!/usr/bin/env bash
#
# Circuit compile with the size check of AAP 0.5.5.
#
# Compiles circuits/tablemate_itinerary.circom into the git-ignored build/ (R1CS, symbols and the
# wasm witness generator), then records the constraint count and the public signal shape in
# docs/zk-proofs.md and fails when the circuit outgrows the Phase 1 file
# powersOfTau28_hez_final_22.ptau can prove: 4,194,304 constraints (2^22).
#
# Invoked as `bash scripts/compile.sh` through the `circuit:compile` package script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

CIRCUIT="circuits/tablemate_itinerary.circom"
BUILD_DIR="$PKG_DIR/build"
ARTIFACT="$BUILD_DIR/tablemate_itinerary" # r1cs, sym and the flattened wasm copy share this stem
WASM_DIR="$BUILD_DIR/tablemate_itinerary_js"
LIMIT=4194304 # 2^22, the capacity of powersOfTau28_hez_final_22.ptau
DOC="$REPO_ROOT/docs/zk-proofs.md"

die() {
    printf 'compile.sh: %s\n' "$1" >&2
    exit 1
}

# ---------------------------------------------------------------------------------------------
# Tools and dependency files
# ---------------------------------------------------------------------------------------------

command -v circom >/dev/null 2>&1 || die \
    "circom is not on PATH; install it with: cargo install --locked --git https://github.com/iden3/circom.git --tag v2.1.9 circom"

CIRCOM_VERSION="$(circom --version 2>&1 || true)"
case "$CIRCOM_VERSION" in
    *2.1.9*) ;;
    *) die "circom 2.1.9 is required (the requested 2.1 line; 2.2.x is outside it), but PATH has: ${CIRCOM_VERSION:-unknown}" ;;
esac

# Both roots are searched because the hoisted install keeps snarkjs and the circuit libraries at
# the repository root, while a package-local node_modules may hold either instead.
SNARKJS=""
SNARKJS_MODULES=""
for root in "$PKG_DIR/node_modules" "$REPO_ROOT/node_modules"; do
    if [ -x "$root/.bin/snarkjs" ]; then
        SNARKJS="$root/.bin/snarkjs"
        SNARKJS_MODULES="$root"
        break
    fi
done
[ -n "$SNARKJS" ] || die "snarkjs is not installed under node_modules/.bin; run pnpm install"

[ -f "$PKG_DIR/$CIRCUIT" ] || die "circuit source not found: $PKG_DIR/$CIRCUIT"

# Both roots are also passed to circom below, so an include resolves whichever copy is present.
LIB_ARGS=(-l "$PKG_DIR/node_modules" -l "$REPO_ROOT/node_modules")
for lib in "@zk-email/circuits/email-verifier.circom" "circomlib/circuits/poseidon.circom"; do
    [ -f "$PKG_DIR/node_modules/$lib" ] || [ -f "$REPO_ROOT/node_modules/$lib" ] ||
        die "$lib is not installed under node_modules; run pnpm install"
done

# ---------------------------------------------------------------------------------------------
# Compile
# ---------------------------------------------------------------------------------------------

mkdir -p "$BUILD_DIR"
printf 'compile.sh: compiling %s (this takes several minutes)\n' "$CIRCUIT"

# `--sym` and `--r1cs` are what packages/circuits/test/* load through circom_tester's
# `recompile: false`, so both are produced here and not only the R1CS snarkjs reads.
(
    cd "$PKG_DIR"
    circom "$CIRCUIT" --r1cs --wasm --sym --O2 -o "$BUILD_DIR" "${LIB_ARGS[@]}"
)

for produced in "$ARTIFACT.r1cs" "$ARTIFACT.sym" "$WASM_DIR/tablemate_itinerary.wasm"; do
    [ -f "$produced" ] || die "circom did not produce $produced"
done

# The `artifacts` service and artifacts.manifest.json serve and hash the flattened name, not
# circom's `<name>_js/` directory layout.
cp "$WASM_DIR/tablemate_itinerary.wasm" "$ARTIFACT.wasm"

# ---------------------------------------------------------------------------------------------
# Constraint count and public signal shape
# ---------------------------------------------------------------------------------------------

# snarkjs colours its output even when stdout is not a terminal, so the codes are stripped before
# parsing. The heap bound is raised because the R1CS of a multi-million-constraint circuit does not
# fit node's default heap.
if ! INFO="$(NODE_OPTIONS="--max-old-space-size=${CIRCUITS_NODE_HEAP_MB:-8192}" \
    "$SNARKJS" r1cs info "$ARTIFACT.r1cs" 2>&1 | sed $'s/\x1b\\[[0-9;]*m//g')"; then
    die "snarkjs r1cs info failed on $ARTIFACT.r1cs"
fi

info_value() {
    # The number snarkjs prints after "# of <label>:", empty when that line is absent.
    printf '%s\n' "$INFO" |
        awk -v key="# of $1:" 'index($0, key) > 0 { sub(/.*: */, ""); gsub(/[ \r]/, ""); print; exit }'
}

CONSTRAINTS="$(info_value Constraints)"
[ -n "$CONSTRAINTS" ] || die "could not read the constraint count from snarkjs r1cs info"
WIRES="$(info_value Wires)"
PRIVATE_INPUTS="$(info_value 'Private Inputs')"
PUBLIC_INPUTS="$(info_value 'Public Inputs')"
OUTPUTS="$(info_value Outputs)"

# The 7-signal contract of PUBLIC_SIGNAL_NAMES in packages/shared/src/schemas/proofs.ts: the five
# outputs (cityId, arrivalDate, departureDate, issuerId, nullifier) followed by the two public
# inputs (registryRoot, nullifierSalt). A drift here invalidates every proof a client generates.
[ "$OUTPUTS" = "5" ] || die "the circuit has ${OUTPUTS:-no} outputs; the 7-signal contract requires 5 (cityId, arrivalDate, departureDate, issuerId, nullifier)"
[ "$PUBLIC_INPUTS" = "2" ] || die "the circuit has ${PUBLIC_INPUTS:-no} public inputs; the 7-signal contract requires 2 (registryRoot, nullifierSalt)"

RESULT="within limit"
if [ "$CONSTRAINTS" -gt "$LIMIT" ]; then
    RESULT="exceeds limit"
fi

# ---------------------------------------------------------------------------------------------
# docs/zk-proofs.md
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

SNARKJS_VERSION="$(node -p "require('$SNARKJS_MODULES/snarkjs/package.json').version" 2>/dev/null)" ||
    die "could not read the snarkjs version from $SNARKJS_MODULES/snarkjs/package.json"

DOC_CONTENT="$(mktemp "${TMPDIR:-/tmp}/tablemate-compile-block.XXXXXX")" ||
    die "could not create a temporary file for the docs block"
trap 'rm -f "$DOC_CONTENT"' EXIT

{
    printf 'Constraints|%s\n' "$CONSTRAINTS"
    printf 'Phase 1 capacity|4,194,304 (2^22, powersOfTau28_hez_final_22.ptau)\n'
    printf 'Result|%s\n' "$RESULT"
    printf 'Wires|%s\n' "$WIRES"
    printf 'Private inputs|%s\n' "$PRIVATE_INPUTS"
    printf 'Public inputs|%s\n' "$PUBLIC_INPUTS"
    printf 'Outputs|%s\n' "$OUTPUTS"
    printf 'circom|%s\n' "$CIRCOM_VERSION"
    printf 'snarkjs|%s\n' "$SNARKJS_VERSION"
    printf 'Compiled (UTC)|%s\n' "$(date -u +%Y-%m-%d)"
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

# Written before the limit is enforced, so an oversize circuit is recorded as "exceeds limit"
# rather than only rejected.
write_doc_block "$DOC" "circuits:compile" "$DOC_CONTENT"

if [ "$RESULT" = "exceeds limit" ]; then
    die "the circuit has $CONSTRAINTS constraints, above the $LIMIT that powersOfTau28_hez_final_22.ptau can prove; recorded as \"$RESULT\" in docs/zk-proofs.md"
fi

printf 'compile.sh: %s constraints (%s), wires %s, private inputs %s; artefacts in %s, recorded in docs/zk-proofs.md\n' \
    "$CONSTRAINTS" "$RESULT" "$WIRES" "$PRIVATE_INPUTS" "$BUILD_DIR"
