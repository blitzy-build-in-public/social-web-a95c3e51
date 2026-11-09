#!/usr/bin/env bash
#
# The native prover smoke check: mopro 0.3.7 with rust-witness and rapidsnark inside an Expo SDK 52 development build
# (AAP 0.2.4, AAP 0.5.5).
#
# That combination is unverified, and a standalone native-library test would not settle it, because the risk is the
# integration inside the app. So this script drives the real bench build through Maestro on a device or simulator and
# verifies the proof it produces on the host:
#
#   compile.sh, setup.sh                only when the circuit artefacts are missing or stale
#   build-native.sh <platform>          only when that platform's libraries are missing or stale
#   eas build --local --profile bench    a build with the JS bundle embedded, so no Metro server
#   install, then `maestro test apps/mobile/e2e/maestro/zk-bench.yaml` with RUNS=1
#   snarkjs groth16 verify              the host's own verdict on the proof the device produced
#
# A `pass` is the gate of AAP 0.8.2: native-prover work on that platform proceeds only after it. A platform whose host,
# device or tool is unavailable is recorded as `pending` and stays unverified, which is the fallback AAP 0.2.4 permits —
# proving there is neither confirmed nor moved to the server. Neither outcome is a crash, and one platform's failure
# never stops the other.
#
# The row this writes into docs/zk-performance.md reports one run's timings as a diagnostic; the criterion 4 p95 figures
# come from the device benchmark (RUNS defaults to 30, run directly with `maestro test`), not from this check.
#
# Invoked as `bash scripts/native-smoke.sh [ios|android|all]` through the `native-smoke` package script and root
# `circuits:smoke`. The default is `all`. Environment: ARTIFACTS_PORT (host port the `artifacts` service publishes,
# default 8070) and ARTIFACTS_BASE_URL (the origin to check and hand the device, default
# http://localhost:$ARTIFACTS_PORT); CIRCUITS_NODE_HEAP_MB, PTAU_PATH, BEACON_HASH and TMPDIR pass through to
# compile.sh and setup.sh.
#
# Exit status: 0 every selected platform passed or is pending a host it cannot run on; 1 a platform failed its native
# build, bench build, install, Maestro run or verification.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

# Paths

BUILD_DIR="$PKG_DIR/build"
R1CS="$BUILD_DIR/tablemate_itinerary.r1cs"
WITNESS_WASM="$BUILD_DIR/tablemate_itinerary_js/tablemate_itinerary.wasm"
ZKEY="$BUILD_DIR/tablemate_itinerary.zkey"
VKEY="$BUILD_DIR/verification_key.json"
MANIFEST="$BUILD_DIR/artifacts.manifest.json"

MODULE_DIR="$REPO_ROOT/apps/mobile/modules/tablemate-prover"
CRATE_DIR="$MODULE_DIR/rust"
IOS_XCFRAMEWORK="$MODULE_DIR/ios/Frameworks/MoproBindings.xcframework"
ANDROID_JNILIBS="$MODULE_DIR/android/src/main/jniLibs"
BENCH_SCREEN="$REPO_ROOT/apps/mobile/app/dev/zk-bench.tsx"
BENCH_PROFILE="$REPO_ROOT/apps/mobile/eas.json"
ZK_BENCH_FLOW="$REPO_ROOT/apps/mobile/e2e/maestro/zk-bench.yaml"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"

RUN_DIR="$REPO_ROOT/.local/zk-bench" # git-ignored, shared with the device benchmark
DOC="$REPO_ROOT/docs/zk-performance.md"

# The version each external side of a contract pins: named in the message when the tool is missing,
# and only warned about when it differs.
EAS_CLI_VERSION="27.4.1"
MAESTRO_VERSION="2.12.1"
XCODE_VERSION="16.4"

ARTIFACTS_BASE_URL="${ARTIFACTS_BASE_URL:-http://localhost:${ARTIFACTS_PORT:-8070}}"

# State

# One row per platform, index 0 iOS and index 1 Android, in the order the document lists them. Bash
# 3.2 (the macOS shell) has no associative arrays, so the platform functions index these by name.
PLATFORM_NAMES=(iOS Android)
RESULT=(pending pending)
REASON=("not run" "not run")
TOTAL=("n/a" "n/a")
INPUT=("n/a" "n/a")
WITNESS=("n/a" "n/a")
PROVE=("n/a" "n/a")
DEVICE=("n/a" "n/a")
RUNNABLE=(0 0)

IOS_DEVICE=""; IOS_REASON=""
ANDROID_SERIAL=""; ANDROID_REASON=""
TOOLS_REASON=""
FAILED=0
FAIL_STEP=""
ARTIFACTS_STARTED=0
ANY_RUNNABLE=0
SAMPLE_TOTAL=""; SAMPLE_INPUT=""; SAMPLE_WITNESS=""; SAMPLE_PROVE=""; DEVICE_CELL=""
DATE=""; COMMIT=""

# What this run creates and removes again. Declared before the exit trap that reads them, so an early
# failure cannot leave an unbound variable in the cleanup.
HELPER=""
PROOF_JSON=""
PUBLIC_JSON=""
ROWS_TSV=""
DOC_CONTENT=""
IOS_APP_DIR="$RUN_DIR/ios-app"

die() { printf 'native-smoke.sh: %s\n' "$1" >&2; exit 1; }

usage() {
    cat <<'USAGE'
usage: bash scripts/native-smoke.sh [ios|android|all]

Builds the `bench` development build of apps/mobile for each platform, installs it on a booted
simulator or an attached emulator or device, runs apps/mobile/e2e/maestro/zk-bench.yaml with RUNS=1,
and verifies the proof the device produced on the host with `snarkjs groth16 verify`. The circuit, its
setup and the native prover libraries are rebuilt only when they are missing or older than their
sources. The outcome is recorded in the native-smoke block of docs/zk-performance.md.

Arguments:   ios | android | all  platform(s) to check; default all
Environment: ARTIFACTS_PORT (default 8070), ARTIFACTS_BASE_URL (default http://localhost:$ARTIFACTS_PORT),
             and CIRCUITS_NODE_HEAP_MB, PTAU_PATH, BEACON_HASH, TMPDIR for compile.sh and setup.sh
Exit status: 0  every selected platform passed, or is pending a host it cannot run on: iOS needs macOS
                with Xcode and a booted simulator, Android needs adb with an attached emulator or
                device, and both need the EAS CLI and Maestro
             1  a selected platform failed one of its steps
Options:     -h, --help
USAGE
}

# Arguments

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac

if [ "$#" -gt 1 ]; then
    usage >&2
    die "at most one platform argument is accepted, got $#"
fi

case "${1:-all}" in
    ios|android|all) PLATFORM="${1:-all}" ;;
    *)
        usage >&2
        die "unknown platform '$1'; expected ios, android or all"
        ;;
esac

# The platform row that was not selected keeps `pending — not run`, so a single-platform run can
# never be read as a pass on the other one.
case "$PLATFORM" in
    ios) PLATFORMS_TO_RUN=(ios) ;;
    android) PLATFORMS_TO_RUN=(android) ;;
    all) PLATFORMS_TO_RUN=(ios android) ;;
esac

DATE="$(date -u +%Y-%m-%d)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
if [ -z "$COMMIT" ]; then COMMIT="unknown"; fi

# The Node helper and the one exit path

mkdir -p "$RUN_DIR"
PROOF_JSON="$RUN_DIR/native-smoke-proof.json"
PUBLIC_JSON="$RUN_DIR/native-smoke-public.json"
ROWS_TSV="$RUN_DIR/native-smoke-rows.tsv"
# `.cjs`, not `.js`: the repository is a CommonJS-free ESM package ("type": "module" in the root
# package.json), and .local/ sits inside it, so a .js helper would be loaded as a module and could
# not require('node:fs').
HELPER="$RUN_DIR/native-smoke-helper.cjs"

# The shell cannot parse JSON and jq is not a dependency of this repository, so the three pieces of
# JSON work live in one small Node program: the bench profile's contract, the device result Maestro
# printed, and the table the document's block holds. It is written fresh on every run.
cat > "$HELPER" <<'NODE'
'use strict';

/*
 * The Node side of native-smoke.sh: the JSON work the shell cannot do by itself.
 *
 *   eas-contract <eas.json>                    the `bench` profile is the build this check drives
 *   extract <out> <proof> <public> <log>...    the device's result, from the output Maestro printed
 *   table <rows.tsv>                           the markdown table the document's block holds
 */
const fs = require('node:fs');

const RESULT_MARKER = 'ZK_BENCH_RESULT';
const ERROR_MARKER = 'ZK_BENCH_ERROR';
const PUBLIC_SIGNALS = 7;
const FIELD_ELEMENT = /^\d{1,78}$/;
const TIMINGS = ['totalMs', 'inputMs', 'witnessMs', 'proveMs'];
const TABLE_HEADER = [
  'Platform',
  'Result',
  'Total ms',
  'Input ms',
  'Witness ms',
  'Prove ms',
  'Device / OS',
  'Date',
  'Commit',
  'Note',
];

function usage() {
  process.stderr.write('usage: helper.cjs <eas-contract|extract|table> ...\n');
  process.exit(2);
}

function mismatch(message) {
  process.stderr.write('native-smoke.sh: the bench profile does not match this check: ' + message + '\n');
  process.exit(1);
}

/** The build contract with apps/mobile/eas.json, named in full when it does not hold. */
function easContract(args) {
  const [path] = args;
  if (!path) usage();
  let eas;
  try {
    eas = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    mismatch(path + ' is not readable JSON: ' + String((error && error.message) || error));
  }
  const bench = eas.build && eas.build.bench;
  if (!bench) mismatch('it declares no build.bench profile');
  if (bench.developmentClient !== false) {
    mismatch(
      'build.bench.developmentClient is not false: a development client is loaded from a Metro server, which this check does not start',
    );
  }
  if (!bench.ios || bench.ios.simulator !== true) {
    mismatch('build.bench.ios.simulator is not true: this check installs the .app into a booted simulator');
  }
  if (!bench.android || bench.android.buildType !== 'apk') {
    mismatch('build.bench.android.buildType is not apk: this check installs the .apk with adb');
  }
  process.stdout.write('OK\n');
}

function noResult(reason) {
  // The verdict is the exit status, so what fails prints only why: the script's message keeps its
  // own prefix rather than a marker of this helper's.
  process.stdout.write(reason + '\n');
  process.exit(1);
}

/** A Groth16 point: pi_a and pi_c are three coordinates, pi_b three coordinate pairs. */
function isPoint(value) {
  return Array.isArray(value) && value.length === 3;
}

function isG2Point(value) {
  return isPoint(value) && value.every((pair) => Array.isArray(pair) && pair.length === 2);
}

/**
 * Reads what Maestro printed for the run. scripts/collect-bench.js has no filesystem of its own, so its payload
 * reaches the host on the single ZK_BENCH_RESULT line, and this writes the files the script goes on to verify: the
 * result itself, the proof and the public signals. A missing or malformed result fails with its reason, and never
 * becomes an empty pass.
 */
function extract(args) {
  const [out, proofPath, publicPath, ...logs] = args;
  if (!out || !proofPath || !publicPath) usage();

  let text = '';
  for (const log of logs) {
    if (!log) continue;
    let candidate;
    try {
      candidate = fs.readFileSync(log, 'utf8');
    } catch {
      continue; // a log this run never produced: try the next one
    }
    // Maestro colours its output, so the escape codes are stripped before the payload is matched.
    candidate = candidate.replace(/\u001b\[[0-9;]*m/g, '');
    if (candidate.includes(RESULT_MARKER) || candidate.includes(ERROR_MARKER)) {
      text = candidate;
      break;
    }
    // A log that holds neither is kept only as the diagnostic: it is what tells "nothing was printed"
    // apart from "no log was written at all".
    if (text === '') text = candidate;
  }

  const printed = [...text.matchAll(/ZK_BENCH_RESULT[ \t]+(.+)$/gm)];
  if (printed.length === 0) {
    const benchError = text.match(/ZK_BENCH_ERROR[ \t]+(\S+)[ \t]+(\S+)/);
    if (benchError) noResult('zk-bench reported ' + benchError[2] + ' on ' + benchError[1]);
    if (text === '') noResult('no result: Maestro left no log to read');
    noResult('no result: Maestro printed no ' + RESULT_MARKER + ' line');
  }

  let payload;
  try {
    payload = JSON.parse(printed[printed.length - 1][1]);
  } catch {
    noResult('no result: the ' + RESULT_MARKER + ' payload is not complete JSON');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    noResult('no result: the payload is not a JSON object');
  }
  const proof = payload.proof;
  if (!proof || !isPoint(proof.pi_a) || !isPoint(proof.pi_c) || !isG2Point(proof.pi_b)) {
    noResult('no result: the payload carries no Groth16 proof');
  }
  const signals = payload.publicSignals;
  if (
    !Array.isArray(signals) ||
    signals.length !== PUBLIC_SIGNALS ||
    !signals.every((signal) => typeof signal === 'string' && FIELD_ELEMENT.test(signal))
  ) {
    noResult('no result: publicSignals is not the ' + PUBLIC_SIGNALS + '-signal vector of the circuit');
  }
  const samples = payload.runs;
  if (!Array.isArray(samples) || samples.length === 0) {
    noResult('no result: the payload carries no timing sample');
  }
  const sample = samples[0];
  for (const field of TIMINGS) {
    const value = sample === null || typeof sample !== 'object' ? undefined : sample[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      noResult('no result: runs[0].' + field + ' is not a timing');
    }
  }

  const label = (value) => (typeof value === 'string' ? value : '');
  fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n');
  fs.writeFileSync(publicPath, JSON.stringify(signals, null, 2) + '\n');
  process.stdout.write(
    [
      sample.totalMs,
      sample.inputMs,
      sample.witnessMs,
      sample.proveMs,
      label(payload.device),
      label(payload.os),
      label(payload.buildId),
    ].join('\t') + '\n',
  );
}

/**
 * The markdown table of the document's block. Cells are padded to the widest of their column counted in characters
 * rather than bytes, so the em dash a pending note carries (one character, three bytes) lines the table up the way
 * `prettier --check`, which `pnpm lint` runs over docs/, wants to find it.
 */
function table(args) {
  const [rowsPath] = args;
  if (!rowsPath) usage();
  const rows = fs
    .readFileSync(rowsPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
  for (const row of rows) {
    if (row.length !== TABLE_HEADER.length) {
      process.stderr.write(
        'native-smoke.sh: a docs row has ' + row.length + ' fields, and the table has ' + TABLE_HEADER.length + '\n',
      );
      process.exit(1);
    }
  }
  const width = TABLE_HEADER.map((_, column) =>
    Math.max(...[TABLE_HEADER, ...rows].map((row) => [...row[column]].length)),
  );
  const line = (row) => '| ' + row.map((cell, i) => cell + ' '.repeat(width[i] - [...cell].length)).join(' | ') + ' |';
  const rule = '| ' + width.map((width) => '-'.repeat(width)).join(' | ') + ' |';
  // A blank line on each side: the shape prettier gives a table, and the shape compile.sh and
  // setup.sh write into docs/zk-proofs.md.
  process.stdout.write('\n' + [line(TABLE_HEADER), rule, ...rows.map(line)].join('\n') + '\n\n');
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'eas-contract') easContract(rest);
else if (mode === 'extract') extract(rest);
else if (mode === 'table') table(rest);
else usage();
NODE

cleanup() {
    # Only what this run created is removed: the helper, the temporary proof and public signals, the
    # row and table files, and the simulator app extracted from the tarball. The downloaded artefacts
    # under packages/circuits/build, the result JSONs and the Maestro log stay — .local/ is
    # git-ignored, and the proving key is far too expensive to fetch twice.
    local path
    for path in "$HELPER" "$PROOF_JSON" "$PUBLIC_JSON" "$ROWS_TSV" "$DOC_CONTENT"; do
        if [ -n "$path" ]; then rm -f "$path"; fi
    done
    if [ -n "$IOS_APP_DIR" ]; then rm -rf "$IOS_APP_DIR"; fi
    if [ "$ARTIFACTS_STARTED" = 1 ]; then
        printf 'native-smoke.sh: stopping the artefacts service this run started\n'
        docker compose -f "$COMPOSE_FILE" stop artifacts >/dev/null 2>&1 || true
    fi
    return 0
}

trap cleanup EXIT
# A trapped signal no longer ends the shell by itself, and the exit trap still has to run, so the
# handlers end the run and let it: 130 and 143 are the shell's status for SIGINT and SIGTERM.
trap 'exit 130' INT
trap 'exit 143' TERM

# Prerequisites: dependencies and the contracts of the build itself

# node parses the bench profile and the device result, and snarkjs is the host's verifier. Both are
# resolved the way compile.sh and setup.sh resolve snarkjs: the hoisted install keeps them at the
# repository root, while a package-local node_modules may hold them instead.
command -v node >/dev/null 2>&1 || die "node is not on PATH; install Node 22.23.4"
SNARKJS=""
for root in "$PKG_DIR/node_modules" "$REPO_ROOT/node_modules"; do
    if [ -x "$root/.bin/snarkjs" ]; then
        SNARKJS="$root/.bin/snarkjs"
        break
    fi
done
[ -n "$SNARKJS" ] || die "snarkjs is not installed under node_modules/.bin; run pnpm install"

# The bench build is the only one a pass can come from, so what it is made of is checked before
# anything is built: a profile that expects a Metro server, or a screen the profile does not bundle,
# would otherwise surface as a Maestro timeout after a full native build.
[ -d "$MODULE_DIR" ] || die "the native prover module is missing: $MODULE_DIR"
[ -f "$BENCH_SCREEN" ] || die "the benchmark screen is missing: $BENCH_SCREEN (the bench profile renders it)"
[ -f "$ZK_BENCH_FLOW" ] || die "the Maestro flow is missing: $ZK_BENCH_FLOW"
if ! node "$HELPER" eas-contract "$BENCH_PROFILE"; then
    die "$BENCH_PROFILE does not describe the build this check drives (see the message above)"
fi

# Tools, host and devices

pl_index() {
    # pl_index <platform>: the row index of the platform table.
    case "$1" in
        ios) printf '0' ;;
        android) printf '1' ;;
        *) die "internal error: unknown platform '$1'" ;;
    esac
}

warn_version() {
    # warn_version <tool> <what it reported> <expected>: a differing version only warns. EAS enforces
    # its own floor in eas.json, and a newer Maestro drives the same flow.
    local tool="$1" reported="$2" expected="$3"
    case "$reported" in
        *"$expected"*) ;;
        *)
            printf 'native-smoke.sh: warning: %s reports "%s", and this check was written against %s\n' \
                "$tool" "$(printf '%s' "$reported" | tr '\n' ' ')" "$expected" >&2
            ;;
    esac
}

check_tools() {
    # check_tools: sets TOOLS_REASON when a tool the check drives is missing. A missing tool is not a
    # crash: it leaves every platform pending, named, with the command that installs it.
    local missing=""
    if command -v eas >/dev/null 2>&1; then
        warn_version eas "$(eas --version 2>&1 || true)" "$EAS_CLI_VERSION"
    else
        missing="${missing:+$missing and }EAS CLI"
        printf 'native-smoke.sh: eas is not on PATH; install it with: npm i -g eas-cli@%s\n' \
            "$EAS_CLI_VERSION" >&2
    fi
    if command -v maestro >/dev/null 2>&1; then
        warn_version maestro "$(maestro --version 2>&1 || true)" "$MAESTRO_VERSION"
    else
        missing="${missing:+$missing and }Maestro CLI"
        printf 'native-smoke.sh: maestro is not on PATH; install Maestro %s from https://maestro.mobile.dev\n' \
            "$MAESTRO_VERSION" >&2
    fi
    if ! docker compose version >/dev/null 2>&1; then
        missing="${missing:+$missing and }docker compose"
        printf 'native-smoke.sh: docker compose is not available; install Docker with the compose plugin\n' >&2
    fi
    TOOLS_REASON=""
    if [ -n "$missing" ]; then TOOLS_REASON="$missing required"; fi
}

detect_ios() {
    # detect_ios: sets IOS_DEVICE to a booted simulator's UDID, or IOS_REASON to why there is none.
    # Xcode's version only warns: another Xcode still builds an Expo SDK 52 project.
    IOS_DEVICE=""
    IOS_REASON=""
    if [ "$(uname -s)" != "Darwin" ]; then
        IOS_REASON="macOS host required"
        return 0
    fi
    if ! command -v xcrun >/dev/null 2>&1; then
        IOS_REASON="Xcode $XCODE_VERSION required"
        printf 'native-smoke.sh: xcrun is not on PATH; install Xcode %s\n' "$XCODE_VERSION" >&2
        return 0
    fi
    if command -v xcodebuild >/dev/null 2>&1; then
        warn_version xcodebuild "$(xcodebuild -version 2>&1 || true)" "$XCODE_VERSION"
    fi
    local booted
    booted="$(xcrun simctl list devices booted 2>/dev/null || true)"
    # A booted device is listed as `    iPhone 16 Pro (UDID) (Booted)`.
    IOS_DEVICE="$(printf '%s\n' "$booted" | sed -n 's/.*(\([0-9A-Fa-f-]\{36\}\)) (Booted).*/\1/p' | head -n 1)"
    if [ -z "$IOS_DEVICE" ]; then IOS_REASON="booted iOS simulator required"; fi
}

detect_android() {
    # detect_android: sets ANDROID_SERIAL to the first attached device or emulator, or ANDROID_REASON.
    ANDROID_SERIAL=""
    ANDROID_REASON=""
    if ! command -v adb >/dev/null 2>&1; then
        ANDROID_REASON="Android emulator or device required"
        printf 'native-smoke.sh: adb is not on PATH; install the Android SDK platform-tools\n' >&2
        return 0
    fi
    # `adb devices` lists one serial per line, with `device` for an attached and authorised target and
    # `offline`, `unauthorized` or `no permissions` for one that is not.
    ANDROID_SERIAL="$(adb devices 2>/dev/null | awk '$2 == "device" { print $1; exit }' || true)"
    if [ -z "$ANDROID_SERIAL" ]; then ANDROID_REASON="Android emulator or device required"; fi
}

device_artifacts_url() {
    # device_artifacts_url <platform>: the Android emulator reaches the host's loopback as 10.0.2.2,
    # while the iOS simulator shares the host's own network. Nothing else of the origin changes.
    if [ "$1" = android ]; then
        printf '%s' "${ARTIFACTS_BASE_URL/localhost/10.0.2.2}"
    else
        printf '%s' "$ARTIFACTS_BASE_URL"
    fi
}

# Prerequisites the device run needs: the circuit artefacts and the artefacts service

ensure_circuit_artifacts() {
    # Rebuilt only when missing or older than what they are built from, so a checkout that has run
    # `pnpm circuits:build` goes straight to the bench build. Called outside an `if`, so `set -e`
    # still ends the run at a failing step: without these artefacts nothing can be checked at all.
    if [ ! -f "$R1CS" ] ||
        [ -n "$(find "$PKG_DIR/circuits" -name '*.circom' -newer "$R1CS" -print -quit 2>/dev/null)" ]; then
        printf 'native-smoke.sh: compiling the circuit (it is missing, or older than its sources)\n'
        bash "$SCRIPT_DIR/compile.sh"
    else
        printf 'native-smoke.sh: the compiled circuit is current\n'
    fi
    if [ ! -f "$ZKEY" ] || [ ! -f "$VKEY" ] || [ ! -f "$MANIFEST" ] ||
        [ "$R1CS" -nt "$ZKEY" ] || [ "$R1CS" -nt "$VKEY" ] || [ "$R1CS" -nt "$MANIFEST" ]; then
        printf 'native-smoke.sh: running the trusted setup (an artefact is missing, or older than the circuit)\n'
        bash "$SCRIPT_DIR/setup.sh"
    else
        printf 'native-smoke.sh: the proving key, the verification key and the manifest are current\n'
    fi
}

ensure_artifacts() {
    # The device fetches the manifest, the WASM and the proving key from the `artifacts` service, so
    # it is started once, before the first run, and left running when it was already up: only a
    # service this script started is stopped again, by the exit trap. The manifest is fetched because
    # the service answers for `/healthz` before a circuit build exists but 404s every artefact.
    local running
    running="$(docker compose -f "$COMPOSE_FILE" ps --status running -q artifacts 2>/dev/null || true)"
    if [ -n "$running" ]; then
        printf 'native-smoke.sh: the artefacts service is already running; it is left as it is\n'
    else
        printf 'native-smoke.sh: starting the artefacts service\n'
        # The flag is set before the result is known, so a service that came up short of healthy is
        # still stopped again by the exit trap.
        ARTIFACTS_STARTED=1
        docker compose -f "$COMPOSE_FILE" up -d --wait artifacts ||
            die "docker compose could not start the artefacts service"
    fi
    if ! curl -fsS "$ARTIFACTS_BASE_URL/artifacts.manifest.json" >/dev/null; then
        die "the artefacts service does not serve $ARTIFACTS_BASE_URL/artifacts.manifest.json; check ARTIFACTS_PORT and its packages/circuits/build mount"
    fi
}

# One platform: native libraries, bench build, install, the flow, verification

# Each of these is called from run_platform under `if !`, where bash suppresses errexit, so each one
# checks every step itself and returns non-zero rather than relying on the shell to end.

ensure_native_libs() {
    # ensure_native_libs <platform>: builds mopro's libraries for the platform only when they are
    # missing or older than the circuit's witness generator or the Rust crate they are built from.
    local p="$1" out="" stale=0 newer=""
    case "$p" in
        ios) out="$IOS_XCFRAMEWORK" ;;
        android) out="$ANDROID_JNILIBS" ;;
    esac
    if [ -e "$out" ]; then
        if [ "$WITNESS_WASM" -nt "$out" ]; then stale=1; fi
        if [ "$stale" = 0 ]; then
            newer="$(find "$CRATE_DIR/src" "$CRATE_DIR/Cargo.toml" "$CRATE_DIR/build.rs" \
                -newer "$out" -print -quit 2>/dev/null || true)"
            if [ -n "$newer" ]; then stale=1; fi
        fi
    else
        stale=1
    fi
    if [ "$stale" = 0 ]; then
        printf 'native-smoke.sh: %s: the native prover libraries are current\n' "$p"
        return 0
    fi
    printf 'native-smoke.sh: %s: building the native prover libraries (mopro over the circuit WASM: a long compile that needs several GB of memory)\n' \
        "$p"
    bash "$SCRIPT_DIR/build-native.sh" "$p"
}

build_bench_app() {
    # build_bench_app <platform>: the local bench build. Its profile embeds the JS bundle and carries
    # the native prover module and app/dev/zk-bench.tsx, so no Metro server is involved. The two
    # variables app.config.ts validates are defaulted here; the bench screen calls neither the API nor
    # Stripe, so the values only have to be well formed.
    local p="$1" api_url ws_url output
    case "$p" in
        ios)
            api_url="http://localhost:3000"; ws_url="ws://localhost:3000"
            output="$RUN_DIR/tablemate-bench-ios.tar.gz"
            ;;
        android)
            api_url="http://10.0.2.2:3000"; ws_url="ws://10.0.2.2:3000"
            output="$RUN_DIR/tablemate-bench-android.apk"
            ;;
    esac
    export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-$api_url}"
    export EXPO_PUBLIC_WS_URL="${EXPO_PUBLIC_WS_URL:-$ws_url}"
    export EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY="${EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY:-pk_test_bench_placeholder}"
    export EXPO_PUBLIC_ZK_BENCH=1
    rm -f "$output"
    printf 'native-smoke.sh: %s: eas build --local --profile bench (a full native build)\n' "$p"
    (cd "$REPO_ROOT/apps/mobile" && eas build --local --profile bench --platform "$p" --non-interactive --output "$output")
}

install_app() {
    # install_app <platform>: the simulator takes the .app inside the tarball the bench profile emits,
    # the emulator or device the .apk.
    local p="$1" output app
    case "$p" in
        ios)
            output="$RUN_DIR/tablemate-bench-ios.tar.gz"
            rm -rf "$IOS_APP_DIR"
            mkdir -p "$IOS_APP_DIR"
            if ! tar -xzf "$output" -C "$IOS_APP_DIR"; then
                printf 'native-smoke.sh: ios: %s could not be extracted\n' "$output" >&2
                return 1
            fi
            app="$(find "$IOS_APP_DIR" -maxdepth 2 -name '*.app' -print -quit)"
            if [ -z "$app" ]; then
                printf 'native-smoke.sh: ios: no .app inside %s; the bench profile builds a simulator app\n' \
                    "$output" >&2
                return 1
            fi
            xcrun simctl install "$IOS_DEVICE" "$app"
            ;;
        android)
            output="$RUN_DIR/tablemate-bench-android.apk"
            adb -s "$ANDROID_SERIAL" install -r "$output"
            ;;
    esac
}

run_maestro() {
    # run_maestro <platform>: the check itself, through the flow that renders app/dev/zk-bench.tsx. RUNS and
    # ARTIFACTS_URL and OUTPUT (with the flow's optional COLLECT_URL and SALT) are the binding contract with
    # apps/mobile/e2e/maestro/zk-bench.yaml, its scripts/collect-bench.js and the screen: RUNS=1 makes this the
    # single-run smoke check the flow would otherwise run 30 times, and OUTPUT is the file the result is written to
    # here, because GraalJS has no filesystem and the payload reaches the host on the one ZK_BENCH_RESULT line Maestro
    # prints. A stale result must never be read as this run's, so OUTPUT is removed first.
    local p="$1" device output log debug_dir artifacts_url status=0 summary sample_device sample_os sample_build
    case "$p" in
        ios) device="$IOS_DEVICE"; output="$RUN_DIR/ios.json" ;;
        android) device="$ANDROID_SERIAL"; output="$RUN_DIR/android.json" ;;
    esac
    artifacts_url="$(device_artifacts_url "$p")"
    log="$RUN_DIR/$p.maestro.log"
    debug_dir="$RUN_DIR/$p-maestro-debug"
    rm -f "$output" "$log"
    printf 'native-smoke.sh: %s: maestro zk-bench.yaml with RUNS=1; the first run downloads and verifies the proving key (hundreds of MB to GB) and takes many minutes\n' \
        "$p"
    maestro --device "$device" --debug-output "$debug_dir" test \
        -e RUNS=1 -e ARTIFACTS_URL="$artifacts_url" -e OUTPUT="$output" "$ZK_BENCH_FLOW" \
        >"$log" 2>&1 || status=$?
    # The extraction runs even when Maestro failed, so a bench error it printed is reported by its own
    # code rather than only as a failed flow.
    if ! summary="$(node "$HELPER" extract "$output" "$PROOF_JSON" "$PUBLIC_JSON" "$log" "$debug_dir/maestro.log")"; then
        printf 'native-smoke.sh: %s: %s\n' "$p" "$summary" >&2
        if [ "$status" -ne 0 ]; then
            printf 'native-smoke.sh: %s: Maestro exited %s; its output is in %s\n' "$p" "$status" "$log" >&2
            FAIL_STEP="maestro"
        else
            FAIL_STEP="no result"
        fi
        return 1
    fi
    if [ "$status" -ne 0 ]; then
        # The payload is complete, but the flow did not finish cleanly: that is not a pass.
        printf 'native-smoke.sh: %s: Maestro exited %s after printing a result\n' "$p" "$status" >&2
        FAIL_STEP="maestro"
        return 1
    fi
    IFS=$'\t' read -r SAMPLE_TOTAL SAMPLE_INPUT SAMPLE_WITNESS SAMPLE_PROVE \
        sample_device sample_os sample_build <<<"$summary"
    DEVICE_CELL="$(device_cell "$sample_device" "$sample_os")"
    if [ -n "$sample_build" ]; then
        printf 'native-smoke.sh: %s: the device proved in %s ms (input %s, witness %s, prove %s) on %s, build %s\n' \
            "$p" "$SAMPLE_TOTAL" "$SAMPLE_INPUT" "$SAMPLE_WITNESS" "$SAMPLE_PROVE" "$DEVICE_CELL" "$sample_build"
    else
        printf 'native-smoke.sh: %s: the device proved in %s ms (input %s, witness %s, prove %s) on %s\n' \
            "$p" "$SAMPLE_TOTAL" "$SAMPLE_INPUT" "$SAMPLE_WITNESS" "$SAMPLE_PROVE" "$DEVICE_CELL"
    fi
}

device_cell() {
    # device_cell <model> <os version>: the document's Device / OS cell, from what the app reported
    # about the device it ran on.
    local label="$1" os="$2"
    if [ -z "$label" ]; then label="unknown"; fi
    if [ -n "$os" ]; then printf '%s / %s' "$label" "$os"; else printf '%s' "$label"; fi
}

verify_proof() {
    # verify_proof <platform>: the host's verdict, and the whole point of the check: it is what shows
    # that this build's native witness generator, proving key and verifier agree. snarkjs exits
    # non-zero on a bad proof and prints `[INFO] snarkJS: OK!` on a good one.
    local p="$1" output
    if ! output="$("$SNARKJS" groth16 verify "$VKEY" "$PUBLIC_JSON" "$PROOF_JSON" 2>&1)"; then
        printf 'native-smoke.sh: %s: snarkjs groth16 verify failed:\n%s\n' "$p" "$output" >&2
        return 1
    fi
    case "$output" in
        *OK*) return 0 ;;
        *)
            printf 'native-smoke.sh: %s: snarkjs groth16 verify printed no OK:\n%s\n' "$p" "$output" >&2
            return 1
            ;;
    esac
}

mark_fail() {
    # mark_fail <platform> <step>: a step this run started failed, named so the row says which.
    local i
    i="$(pl_index "$1")"
    RESULT[i]="fail"
    REASON[i]="$2"
    FAILED=1
    printf 'native-smoke.sh: %s: FAIL (%s)\n' "$1" "$2" >&2
}

mark_pass() {
    # mark_pass <platform>: records the measured run. A pass is never written without one.
    local i
    i="$(pl_index "$1")"
    RESULT[i]="pass"
    REASON[i]="host groth16 verify OK"
    TOTAL[i]="$SAMPLE_TOTAL"
    INPUT[i]="$SAMPLE_INPUT"
    WITNESS[i]="$SAMPLE_WITNESS"
    PROVE[i]="$SAMPLE_PROVE"
    DEVICE[i]="$DEVICE_CELL"
    printf 'native-smoke.sh: %s: PASS\n' "$1"
}

run_platform() {
    # run_platform <platform>: builds, installs, runs and verifies one platform, and records the
    # outcome. Nothing here may rely on `set -e`: errexit is suppressed in a function called from an
    # `if`, and this one is written so that one platform's failure can neither stop the other nor be
    # recorded as a pass. Every step is checked where it is taken.
    local p="$1"
    if ! ensure_native_libs "$p"; then mark_fail "$p" "native libraries"; return 0; fi
    if ! build_bench_app "$p"; then mark_fail "$p" "eas build"; return 0; fi
    if ! install_app "$p"; then mark_fail "$p" "install"; return 0; fi
    if ! run_maestro "$p"; then mark_fail "$p" "$FAIL_STEP"; return 0; fi
    if ! verify_proof "$p"; then mark_fail "$p" "verify"; return 0; fi
    mark_pass "$p"
}

# docs/zk-performance.md

write_doc_block() {
    # write_doc_block <file> <block name> <content file>: replaces what sits between the named markers, or appends the
    # block when the file or either marker is absent. The replacement goes through a temporary file in the same
    # directory, so a reader never sees a half-written document. This is the function compile.sh and setup.sh carry, with
    # one difference: a document that does not exist yet starts at the marker instead of after a blank line, because a
    # leading blank line is the one thing `prettier --check`, which `pnpm lint` runs over docs/, rejects there.
    local file="$1" name="$2" content="$3" tmp begin end
    begin="<!-- BEGIN $name -->"
    end="<!-- END $name -->"
    mkdir -p "$(dirname "$file")"
    # The temp file stays in the document's own directory, so the rename below is atomic, but its name is generated
    # rather than derived from this process's pid and the document's name: a symlink planted at a predictable name can
    # then no longer make this script truncate a file outside the repository (CWE-377, CWE-59). mktemp creates it 0600.
    tmp="$(mktemp "${file}.tmp.XXXXXX")" || die "could not create a temporary file next to $file"
    chmod 0644 "$tmp"
    if [ -s "$file" ] && grep -qF "$begin" "$file" && grep -qF "$end" "$file"; then
        # The content file is read with awk's getline: a multi-line value cannot travel through
        # `awk -v`, which BSD awk and mawk both reject.
        awk -v begin="$begin" -v end="$end" -v content="$content" '
            $0 == begin { print; while ((getline line < content) > 0) print line; close(content); inside = 1; next }
            $0 == end { inside = 0 }
            !inside { print }
        ' "$file" >"$tmp"
    elif [ -s "$file" ]; then
        cat "$file" >>"$tmp"
        { printf '\n%s\n' "$begin"; cat "$content"; printf '%s\n' "$end"; } >>"$tmp"
    else
        { printf '%s\n' "$begin"; cat "$content"; printf '%s\n' "$end"; } >>"$tmp"
    fi
    mv "$tmp" "$file"
}

write_performance_block() {
    # The native-smoke block: one row per platform in the order the table lists them, `Result` one of
    # pass, fail or pending, and the timings of the single run this check took. A cell with no
    # measurement carries n/a rather than being empty, so nothing reads as a zero, and the whole block
    # is replaced on every run.
    local row note
    : >"$ROWS_TSV"
    for row in 0 1; do
        case "${RESULT[row]}" in
            pass) note="RUNS=1; host groth16 verify OK" ;;
            fail) note="fail (${REASON[row]})" ;;
            *)
                if [ "${REASON[row]}" = "not run" ]; then note="not run"; else note="Pending — ${REASON[row]}"; fi
                ;;
        esac
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
            "${PLATFORM_NAMES[row]}" "${RESULT[row]}" "${TOTAL[row]}" "${INPUT[row]}" \
            "${WITNESS[row]}" "${PROVE[row]}" "${DEVICE[row]}" "$DATE" "$COMMIT" "$note" >>"$ROWS_TSV"
    done
    DOC_CONTENT="$(mktemp "${TMPDIR:-/tmp}/tablemate-smoke-block.XXXXXX")" ||
        die "could not create a temporary file for the docs block"
    if ! node "$HELPER" table "$ROWS_TSV" >"$DOC_CONTENT"; then
        die "could not format the native-smoke block of $DOC"
    fi
    write_doc_block "$DOC" "native-smoke" "$DOC_CONTENT"
}

print_summary() {
    # print_summary: one line per platform, in the document's row order.
    local row
    for row in 0 1; do
        case "${RESULT[row]}" in
            pass)
                printf 'native-smoke.sh: %s: pass — %s; %s ms total (input %s, witness %s, prove %s) on %s\n' \
                    "${PLATFORM_NAMES[row]}" "${REASON[row]}" "${TOTAL[row]}" "${INPUT[row]}" \
                    "${WITNESS[row]}" "${PROVE[row]}" "${DEVICE[row]}"
                ;;
            fail)
                printf 'native-smoke.sh: %s: fail (%s)\n' "${PLATFORM_NAMES[row]}" "${REASON[row]}" >&2
                ;;
            *)
                printf 'native-smoke.sh: %s: pending — %s\n' "${PLATFORM_NAMES[row]}" "${REASON[row]}"
                ;;
        esac
    done
}

# The run

# Whether a platform can be driven here is settled before any long work, so a host with no simulator
# or device records its rows and stops, instead of compiling a circuit and a native library it cannot
# use. A missing tool leaves every platform pending, and it is named before the platform's own reason
# because it affects all of them.
check_tools
for platform in "${PLATFORMS_TO_RUN[@]}"; do
    case "$platform" in
        ios) detect_ios ;;
        android) detect_android ;;
    esac
done

for platform in "${PLATFORMS_TO_RUN[@]}"; do
    row="$(pl_index "$platform")"
    blocked="$TOOLS_REASON"
    if [ -z "$blocked" ]; then
        case "$platform" in
            ios) blocked="$IOS_REASON" ;;
            android) blocked="$ANDROID_REASON" ;;
        esac
    fi
    if [ -n "$blocked" ]; then
        RESULT[row]="pending"
        REASON[row]="$blocked"
    else
        RUNNABLE[row]=1
    fi
done

for row in 0 1; do
    if [ "${RUNNABLE[row]}" = 1 ]; then ANY_RUNNABLE=1; fi
done

if [ "$ANY_RUNNABLE" = 1 ]; then
    ensure_circuit_artifacts
    ensure_artifacts
    for platform in "${PLATFORMS_TO_RUN[@]}"; do
        row="$(pl_index "$platform")"
        if [ "${RUNNABLE[row]}" = 1 ]; then
            run_platform "$platform"
        fi
    done
else
    printf 'native-smoke.sh: no platform can be driven on this host; recording the reasons and building nothing\n'
fi

write_performance_block
printf 'native-smoke.sh: recorded in %s (block native-smoke)\n' "$DOC"
print_summary

if [ "$FAILED" = 1 ]; then
    printf 'native-smoke.sh: a platform failed; the rows above and %s say which step\n' "$DOC" >&2
    exit 1
fi

if [ "${RESULT[0]}" = pending ] || [ "${RESULT[1]}" = pending ]; then
    printf 'native-smoke.sh: a pending platform remains unverified (AAP 0.2.4): proving there is neither confirmed nor moved to the server\n'
fi

printf 'native-smoke.sh: done\n'
