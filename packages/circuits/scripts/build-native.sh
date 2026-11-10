#!/usr/bin/env bash
#
# Native prover libraries for the tablemate-prover Expo module (AAP 0.4.2).
#
# Builds mopro 0.3.7's Circom adapter over the compiled circuit — rust-witness for the witness, rapidsnark for the
# Groth16 proof — and installs what it produces where the local Expo module reads it. All four destinations are
# machine-generated per circuit build and git-ignored:
#
#   ios/Frameworks/MoproBindings.xcframework     vendored by ios/TablemateProver.podspec
#   ios/Generated/mopro.swift                    the uniffi Swift bindings that podspec compiles
#   android/src/main/jniLibs/<abi>/libmopro_bindings.so
#   android/src/main/java/uniffi/mopro/mopro.kt  the Kotlin bindings android/build.gradle loads
#
# It builds the libraries only. Whether that integration works at zk-email scale inside an Expo SDK 52 development
# build is unverified (AAP 0.2.4); scripts/native-smoke.sh decides that, per platform.
#
# Invoked as `bash scripts/build-native.sh [ios|android|all]` through the `native` package script and root
# `circuits:native`. `pnpm circuits:compile` must have run first: rust/build.rs transpiles the circuit's WASM witness
# generator into the app, so a library built against another revision of the circuit proves nothing. Expect a long
# compile per target and a large resident set.
#
# Environment: NATIVE_PLATFORMS (platforms when no argument is given, default `all`) and ANDROID_NDK_HOME (the NDK
# cargo-ndk builds with, default $ANDROID_HOME/ndk/26.1.10909125). TABLEMATE_CIRCUIT_WASM_DIR is exported here from the
# circuit build; rust/build.rs reads it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

MODULE_DIR="$REPO_ROOT/apps/mobile/modules/tablemate-prover"
CRATE_DIR="$MODULE_DIR/rust"
WASM_DIR="$PKG_DIR/build/tablemate_itinerary_js"
WASM="$WASM_DIR/tablemate_itinerary.wasm"
CONFIG_TOML="$CRATE_DIR/Config.toml"

IOS_XCFRAMEWORK="$MODULE_DIR/ios/Frameworks/MoproBindings.xcframework"
IOS_SWIFT="$MODULE_DIR/ios/Generated/mopro.swift"
ANDROID_JNILIBS="$MODULE_DIR/android/src/main/jniLibs"
ANDROID_UNIFFI="$MODULE_DIR/android/src/main/java/uniffi"

MOPRO_VERSION="0.3.7"
RUST_VERSION="1.99.1"
NDK_VERSION="26.1.10909125"
IOS_ARCHS=(aarch64-apple-ios aarch64-apple-ios-sim)
ANDROID_ARCHS=(aarch64-linux-android x86_64-linux-android)

die() { printf 'build-native.sh: %s\n' "$1" >&2; exit 1; }

usage() {
    # This script's own contract, for an operator who has no other way to read it.
    cat <<'USAGE'
usage: bash scripts/build-native.sh [ios|android|all]

Builds mopro's native prover libraries for the tablemate-prover Expo module from the compiled
circuit and installs them into apps/mobile/modules/tablemate-prover. Run `pnpm circuits:compile`
first: the libraries embed the circuit's witness generator, so both must come from one revision.

Arguments:   ios | android | all  platform(s) to build; default NATIVE_PLATFORMS, else `all`
Environment: NATIVE_PLATFORMS, ANDROID_NDK_HOME (default $ANDROID_HOME/ndk/26.1.10909125)
Exit status: 0  every requested platform was built, or is pending a host it cannot run on: iOS
               needs macOS with Xcode, Android needs NDK 26.1.10909125
             1  a requested build failed
Options:     -h, --help
USAGE
}

if [ "$#" -gt 1 ]; then
    usage >&2
    die "at most one platform argument is accepted, got $#"
fi

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac

PLATFORM="${1:-${NATIVE_PLATFORMS:-all}}"
case "$PLATFORM" in
    ios|android|all) ;;
    *)
        usage >&2
        die "unknown platform '$PLATFORM'; expected ios, android or all"
        ;;
esac

# A platform named on its own was asked for deliberately, so a host toolchain it needs but does not
# have is a failure to report; under `all`, a platform this host cannot build is deferred instead.
if [ "$PLATFORM" = "all" ]; then EXPLICIT=0; else EXPLICIT=1; fi

# Prerequisites

[ -f "$WASM" ] || die \
    "run pnpm circuits:compile first: $WASM is missing, and rust/build.rs transpiles the witness generator it holds"

[ -f "$CRATE_DIR/Cargo.toml" ] || die "the native prover crate is missing: $CRATE_DIR/Cargo.toml not found"

command -v mopro >/dev/null 2>&1 || die \
    "mopro is not on PATH; install it with: cargo install mopro-cli --version $MOPRO_VERSION --locked"

# mopro prints `<package name> <version>`, and only the version token, with any leading `v`
# dropped, is compared, so the check holds whatever the first token is spelled as.
MOPRO_OUTPUT=""
if ! MOPRO_OUTPUT="$(mopro --version 2>&1)"; then MOPRO_OUTPUT=""; fi
MOPRO_SELECTED="$(printf '%s\n' "$MOPRO_OUTPUT" | awk '{print $2}' | sed 's/^[vV]//')"
[ "$MOPRO_SELECTED" = "$MOPRO_VERSION" ] || die \
    "mopro $MOPRO_VERSION is required as the native prover's witness and proving backend, but PATH has: ${MOPRO_OUTPUT:-nothing found}; install it with: cargo install mopro-cli --version $MOPRO_VERSION --locked"

command -v cargo >/dev/null 2>&1 ||
    die "cargo is not on PATH; install Rust $RUST_VERSION with rustup from https://rustup.rs"
command -v rustup >/dev/null 2>&1 ||
    die "rustup is not on PATH; the crate pins its toolchain and targets through rustup: https://rustup.rs"

# rust-toolchain.toml pins the toolchain and rustup selects it from inside the crate, so a `rustc` that is not rustup's
# shim, or a missing pinned toolchain, is reported with the command that installs it.
RUSTC_OUTPUT=""
if ! RUSTC_OUTPUT="$(cd "$CRATE_DIR" && rustc --version 2>&1)"; then RUSTC_OUTPUT=""; fi
RUSTC_SELECTED="$(printf '%s\n' "$RUSTC_OUTPUT" | awk '{print $2}')"
[ "$RUSTC_SELECTED" = "$RUST_VERSION" ] || die \
    "the crate needs Rust $RUST_VERSION, pinned by $CRATE_DIR/rust-toolchain.toml, but $CRATE_DIR selects '${RUSTC_SELECTED:-nothing}'; install it with: rustup toolchain install $RUST_VERSION --profile minimal --component rustfmt"

# TABLEMATE_CIRCUIT_WASM_DIR is the binding contract with rust/build.rs, which reads it and hands the directory to
# rust_witness::transpile_wasm. Without it the witness generator is not compiled into the app, and the module fails at
# its first proof rather than here. It must name a directory holding exactly one .wasm: rust-witness appends one handler
# stub per wasm it walks, so the build root's second copy of the circuit wasm yields duplicate definitions.
export TABLEMATE_CIRCUIT_WASM_DIR="$WASM_DIR"

# mopro-cli 0.3.7 reads a project-root Config.toml from the directory it runs in and writes a default one when it is
# absent. A transient one is written per build below and removed on exit; one the operator already keeps is left as it
# was found.
CONFIG_EXISTED=0
if [ -e "$CONFIG_TOML" ]; then CONFIG_EXISTED=1; fi

cleanup() {
    if [ "$CONFIG_EXISTED" = 0 ]; then rm -f "$CONFIG_TOML"; fi
}
trap cleanup EXIT

# Helpers

resolve_ndk() {
    # resolve_ndk: prints the NDK directory cargo-ndk builds against, or nothing when there is none: an explicit
    # ANDROID_NDK_HOME is taken as it stands, otherwise the React Native 0.76.9 default NDK under the SDK root.
    # source.properties has to name $NDK_VERSION because cargo-ndk builds with the most recent NDK it finds, and another
    # NDK links a libc++ the app does not load.
    local ndk="${ANDROID_NDK_HOME:-}"
    if [ -z "$ndk" ]; then
        local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
        [ -n "$sdk" ] || return 1
        ndk="$sdk/ndk/$NDK_VERSION"
    fi
    [ -f "$ndk/source.properties" ] || return 1
    local revision
    revision="$(sed -n 's/^Pkg\.Revision *= *//p' "$ndk/source.properties" | tr -d ' \r' | head -n 1)"
    [ "$revision" = "$NDK_VERSION" ] || return 1
    printf '%s' "$ndk"
}

require_targets() {
    # require_targets <platform> <arch>...: fails with the exact command that installs what is missing, because mopro
    # adds a missing target itself once it has started, which buries the cause in its own output.
    local platform="$1" installed missing="" arch
    shift
    installed="$(rustup target list --installed)"
    for arch in "$@"; do
        printf '%s\n' "$installed" | grep -qx "$arch" || missing="$missing $arch"
    done
    [ -z "$missing" ] ||
        die "$platform needs Rust targets that are not installed:$missing; install them with: rustup target add$missing"
}

write_config_toml() {
    # write_config_toml <platform> <arch>...: the flat keys mopro-cli 0.3.7 reads (build_mode, target_adapters,
    # target_platforms, ios, android, auto_update), holding the same selections the command's flags carry, so no
    # selection can fall back to an interactive prompt.
    local platform="$1" arch archs="" key
    shift
    for arch in "$@"; do archs="$archs\"$arch\", "; done
    if [ "$platform" = "ios" ]; then key="ios"; else key="android"; fi
    {
        printf 'build_mode = "release"\n'
        printf 'target_adapters = ["circom"]\n'
        printf 'target_platforms = ["%s"]\n' "$platform"
        printf 'auto_update = false\n'
        printf '%s = [%s]\n' "$key" "${archs%, }"
    } >"$CONFIG_TOML"
}

first_missing() {
    # first_missing <path>...: prints the first path that does not exist, or nothing when all do.
    local path
    for path in "$@"; do
        if [ ! -e "$path" ]; then
            printf '%s' "$path"
            return 0
        fi
    done
}

install_outputs() {
    # install_outputs <platform>: checks every expected output and installs it into the Expo module. The layout is
    # version-specific, so each path is named, and an absent one fails the run rather than leaving the module on a stale
    # binding of an earlier circuit. These checks, not mopro's exit status, report a failed build: mopro-cli 0.3.7
    # prints a build failure in red and still exits 0. Only the destinations are replaced, and the crate-side bindings
    # directory goes once they hold everything.
    local platform="$1" bindings arch abi missing
    local -a expected
    if [ "$platform" = "ios" ]; then
        bindings="$CRATE_DIR/MoproiOSBindings"
        expected=("$bindings/MoproBindings.xcframework" "$bindings/mopro.swift")
    else
        bindings="$CRATE_DIR/MoproAndroidBindings"
        for arch in "${ANDROID_ARCHS[@]}"; do
            case "$arch" in
                aarch64-linux-android) abi="arm64-v8a" ;;
                x86_64-linux-android) abi="x86_64" ;;
                *) abi="$arch" ;;
            esac
            expected+=("$bindings/jniLibs/$abi/libmopro_bindings.so")
        done
        # uniffi/mopro/mopro.kt is the file android/build.gradle loads from src/main/java/uniffi.
        expected+=("$bindings/uniffi/mopro/mopro.kt")
    fi
    missing="$(first_missing "${expected[@]}")"
    if [ -n "$missing" ]; then
        INSTALL_FAILURE="mopro produced no $missing"
        return 1
    fi
    if [ "$platform" = "ios" ]; then
        rm -rf "$IOS_XCFRAMEWORK" "$IOS_SWIFT"
        mkdir -p "$MODULE_DIR/ios/Frameworks" "$MODULE_DIR/ios/Generated"
        cp -R "$bindings/MoproBindings.xcframework" "$IOS_XCFRAMEWORK"
        cp -R "$bindings/mopro.swift" "$IOS_SWIFT"
    else
        rm -rf "$ANDROID_JNILIBS" "$ANDROID_UNIFFI"
        mkdir -p "$(dirname "$ANDROID_JNILIBS")" "$(dirname "$ANDROID_UNIFFI")"
        cp -R "$bindings/jniLibs" "$ANDROID_JNILIBS"
        cp -R "$bindings/uniffi" "$ANDROID_UNIFFI"
    fi
    rm -rf "$bindings"
}

# Build and install

run_platform() {
    # run_platform <platform> <arch>...: builds one platform and installs its outputs, then sets
    # STATE to `built`, `pending (<reason>)` or `failed (<step>)`.
    local platform="$1" ndk
    shift
    if [ "$platform" = "ios" ]; then
        if [ "$(uname -s)" != "Darwin" ] || ! command -v xcrun >/dev/null 2>&1; then
            STATE="pending (macOS host required)"
            printf 'iOS: Pending — macOS host required\n'
            return 0
        fi
    else
        if ! ndk="$(resolve_ndk)"; then
            if [ "$EXPLICIT" = 1 ]; then
                die "Android was requested but NDK $NDK_VERSION was not found; install it through the Android SDK Manager, or point ANDROID_NDK_HOME at it"
            fi
            STATE="pending (NDK $NDK_VERSION required)"
            printf 'Android: Pending — NDK %s required\n' "$NDK_VERSION"
            return 0
        fi
        # cargo-ndk reads this to pick the NDK, and the app links that NDK's libc++.
        export ANDROID_NDK_HOME="$ndk"
    fi
    require_targets "$platform" "$@"
    write_config_toml "$platform" "$@"
    printf 'build-native.sh: %s: mopro build --mode release (rust-witness transpiles the circuit WASM per target: a long compile that needs several GB of memory)\n' \
        "$platform"
    if ! (cd "$CRATE_DIR" && mopro build --mode release --platforms "$platform" \
        --architectures "$@" --no-auto-update); then
        STATE="failed (mopro build)"
        return 0
    fi
    INSTALL_FAILURE="installing the outputs"
    install_outputs "$platform" || {
        STATE="failed ($INSTALL_FAILURE)"
        return 0
    }
    STATE="built"
}

IOS_STATE="not requested"
ANDROID_STATE="not requested"

case "$PLATFORM" in
    ios)
        run_platform ios "${IOS_ARCHS[@]}"
        IOS_STATE="$STATE"
        ;;
    android)
        run_platform android "${ANDROID_ARCHS[@]}"
        ANDROID_STATE="$STATE"
        ;;
    all)
        run_platform ios "${IOS_ARCHS[@]}"
        IOS_STATE="$STATE"
        run_platform android "${ANDROID_ARCHS[@]}"
        ANDROID_STATE="$STATE"
        ;;
esac

printf 'build-native.sh: iOS: %s\n' "$IOS_STATE"
printf 'build-native.sh: Android: %s\n' "$ANDROID_STATE"

case "$IOS_STATE$ANDROID_STATE" in
    *"failed ("*) exit 1 ;;
esac
