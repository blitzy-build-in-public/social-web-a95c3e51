#!/usr/bin/env bash
#
# Circuit compile with the size check of AAP 0.5.5.
#
# Compiles circuits/tablemate_itinerary.circom into the git-ignored build/ (R1CS, symbols and the wasm witness
# generator), then records the constraint count and the public signal shape in docs/zk-proofs.md and fails when the
# circuit outgrows the Phase 1 file powersOfTau28_hez_final_22.ptau can prove: 4,194,304 constraints (2^22).
#
# Invoked as `bash scripts/compile.sh` through the `circuit:compile` package script. Environment knobs, all optional;
# `--help` prints the same list. CIRCUITS_NODE_HEAP_MB is node's heap for the `snarkjs r1cs info` parse of the R1CS,
# which a circuit of a few million constraints does not fit in node's default heap: default 8192 MB, a positive integer
# of megabytes, any other value rejected before the multi-minute compile it precedes. TMPDIR is the directory the
# docs-block temporary content file is created in (default /tmp); the temp write_doc_block renames into place is
# created next to the document instead, so its rename is atomic whatever TMPDIR is.

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

usage() {
    # usage: the script's own contract, for an operator who has no other way to read it. It runs
    # before the lock is taken, so --help neither waits on a run in progress nor starts one.
    cat <<'USAGE'
usage: bash scripts/compile.sh

Compiles the itinerary circuit (circuits/tablemate_itinerary.circom) into the git-ignored build/,
records the constraint count and public-signal shape in docs/zk-proofs.md, and fails when the circuit
outgrows the 4,194,304 constraints (2^22) the powers-of-tau file powersOfTau28_hez_final_22.ptau can
prove.

Environment:
  CIRCUITS_NODE_HEAP_MB  node heap for the R1CS parse; default 8192, a positive integer of megabytes
  TMPDIR                 where the docs-block content temp file is created; default /tmp

Writes:
  build/tablemate_itinerary.r1cs, .sym, .wasm and build/tablemate_itinerary_js/
  the circuits:compile block of docs/zk-proofs.md

Options:
  -h, --help             print this text and exit, without taking the build directory lock
USAGE
}

# The script takes no arguments: anything other than a help request is a caller's mistake to report
# rather than an invocation to guess at, so it exits before the lock and before the compile below.
while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown argument '$1'; this script takes no arguments, and --help prints its contract" ;;
    esac
done

# The build directory lock

# build/ is shared with setup.sh, and both write fixed intermediate names inside it, so one run at a time owns it: two
# runs interleaving those writes can leave a proving key, a verification key or a manifest that corresponds to no single
# compile. The lock is taken before the first of those writes and held for the whole run.
#
# flock is preferred where it exists, because the kernel drops the lock when the process ends, a killed one included.
# macOS ships no flock, so the fallback is an atomic mkdir. `-n` gives up at once instead of queueing: a second run in
# one checkout is a mistake to report, not a run to hold for the minutes a compile takes.
LOCK_DIR="$BUILD_DIR/.lock.d"
LOCK_HELD=""
mkdir -p "$BUILD_DIR"
if command -v flock >/dev/null 2>&1; then
    # The lock is the build directory itself, opened read-only: a read-only open has neither O_CREAT nor O_TRUNC, so no
    # file is created for a local writer to plant a symlink at, and a fixed lock-file name can no longer be followed and
    # truncated as `9>"$BUILD_DIR/.lock"` was.
    exec 9<"$BUILD_DIR"
    flock -n 9 ||
        die "another compile or ceremony holds the build directory lock $BUILD_DIR; wait for it to finish and run again"
    LOCK_HELD="flock"
elif ! mkdir "$LOCK_DIR" 2>/dev/null; then
    die "another compile or ceremony holds the build directory lock $LOCK_DIR; remove that directory if no run is active, then run again"
else
    LOCK_HELD="mkdir"
fi

release_lock() {
    # release_lock: gives the build directory back. Under flock there is nothing to do — the lock is taken on the
    # directory itself, which must not be removed — and the mkdir fallback owns its directory and removes it.
    if [ "$LOCK_HELD" = "mkdir" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
}

# Registered at acquisition, so a failure before the traps below is covered too; the EXIT trap is replaced there by one
# that releases the lock as well. The signal handlers release the lock and then end the run, because a trapped signal no
# longer terminates the shell by default: a `kill`ed compile must still stop it. 130 and 143 are the shell's status for
# SIGINT and SIGTERM.
trap release_lock EXIT
trap 'release_lock; exit 130' INT
trap 'release_lock; exit 143' TERM

# Tools and dependency files

command -v circom >/dev/null 2>&1 || die \
    "circom is not on PATH; install it with: cargo install --locked --git https://github.com/iden3/circom.git --tag v2.1.9 circom"

CIRCOM_VERSION="$(circom --version 2>&1 || true)"
case "$CIRCOM_VERSION" in
    *2.1.9*) ;;
    *) die "circom 2.1.9 is required (the requested 2.1 line; 2.2.x is outside it), but PATH has: ${CIRCOM_VERSION:-unknown}" ;;
esac

# CIRCUITS_NODE_HEAP_MB tunes the heap snarkjs gets for the R1CS parse below. It comes from the environment, so a value
# it cannot use is rejected here, before the multi-minute compile it precedes. Only a plain decimal count of megabytes
# with no leading zero is accepted: a glob such as [1-9][0-9]* would also match "16G", because its trailing * means any
# characters, and a leading zero is the octal spelling of a number.
CIRCUITS_NODE_HEAP_MB="${CIRCUITS_NODE_HEAP_MB:-8192}"
case "$CIRCUITS_NODE_HEAP_MB" in
    ''|0*|*[!0-9]*) die "CIRCUITS_NODE_HEAP_MB must be a positive integer number of megabytes, without a sign and without a leading zero (for example 8192); got: '$CIRCUITS_NODE_HEAP_MB'" ;;
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

# Compile

mkdir -p "$BUILD_DIR"

# The outputs of an earlier compile are removed first, so a compile that fails part way leaves no earlier revision's
# R1CS or WASM behind for setup.sh to build a proving key for: only these four paths are touched, and none of the
# artefacts setup.sh owns is.
rm -f "$ARTIFACT.r1cs" "$ARTIFACT.sym" "$ARTIFACT.wasm" "$WASM_DIR/tablemate_itinerary.wasm"

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

# Constraint count and public signal shape

# snarkjs colours its output even when stdout is not a terminal, so the codes are stripped before parsing. The heap
# bound is raised because the R1CS of a multi-million-constraint circuit does not fit node's default heap;
# CIRCUITS_NODE_HEAP_MB, validated above, tunes it.
if ! INFO="$(NODE_OPTIONS="--max-old-space-size=${CIRCUITS_NODE_HEAP_MB}" \
    "$SNARKJS" r1cs info "$ARTIFACT.r1cs" 2>&1 | sed $'s/\x1b\\[[0-9;]*m//g')"; then
    # INFO holds the parse's own output, node's complaint included: it is printed before dying because the assignment
    # that captured it is otherwise discarded and the message below names only the file.
    if [ -n "$INFO" ]; then
        printf '%s\n' "$INFO" >&2
    fi
    die "snarkjs r1cs info failed on $ARTIFACT.r1cs"
fi

info_value() {
    # The number snarkjs prints after "# of <label>:", empty when that line is absent.
    printf '%s\n' "$INFO" |
        awk -v key="# of $1:" 'index($0, key) > 0 { sub(/.*: */, ""); gsub(/[ \r]/, ""); print; exit }'
}

CONSTRAINTS="$(info_value Constraints)"
# The count is parsed out of snarkjs's free-form output, so anything that is not a run of digits is rejected here: the
# `-gt` comparison below cannot fail on a non-integer, it evaluates false, which would leave RESULT at "within limit".
case "$CONSTRAINTS" in
    ''|*[!0-9]*) die "could not parse the constraint count from snarkjs r1cs info: '${CONSTRAINTS:-empty}'" ;;
esac
WIRES="$(info_value Wires)"
PRIVATE_INPUTS="$(info_value 'Private Inputs')"
PUBLIC_INPUTS="$(info_value 'Public Inputs')"
OUTPUTS="$(info_value Outputs)"

# The 7-signal contract of PUBLIC_SIGNAL_NAMES in packages/shared/src/schemas/proofs.ts: the five outputs (cityId,
# arrivalDate, departureDate, issuerId, nullifier) followed by the two public inputs (registryRoot, nullifierSalt). A
# drift here invalidates every proof a client generates.
[ "$OUTPUTS" = "5" ] || die "the circuit has ${OUTPUTS:-no} outputs; the 7-signal contract requires 5 (cityId, arrivalDate, departureDate, issuerId, nullifier)"
[ "$PUBLIC_INPUTS" = "2" ] || die "the circuit has ${PUBLIC_INPUTS:-no} public inputs; the 7-signal contract requires 2 (registryRoot, nullifierSalt)"

RESULT="within limit"
if [ "$CONSTRAINTS" -gt "$LIMIT" ]; then
    RESULT="exceeds limit"
fi

# docs/zk-proofs.md

write_doc_block() {
    # write_doc_block <file> <block name> <content file>: replaces what sits between the named markers, or appends the
    # block when the file or either marker is absent. The replacement goes through a temporary file in the same
    # directory, so a reader never sees a half-written document.
    local file="$1" name="$2" content="$3" tmp begin end
    begin="<!-- BEGIN $name -->"
    end="<!-- END $name -->"
    mkdir -p "$(dirname "$file")"
    # The temp file stays in the document's own directory, so the rename below is atomic. Its name comes from mktemp,
    # never from this process's pid and the document's name: a symlink planted at a predictable name cannot make this
    # script truncate a file outside the repository (CWE-377, CWE-59). mktemp creates it 0600.
    tmp="$(mktemp "${file}.tmp.XXXXXX")" || die "could not create a temporary file next to $file"
    chmod 0644 "$tmp"
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
trap 'rm -f "$DOC_CONTENT"; release_lock' EXIT

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
    # A two-column table whose cells are padded to the widest of their column: the exact shape prettier gives markdown
    # tables, which the repository lint runs this file through.
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
