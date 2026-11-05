//! Build script for the native prover module: transpiles the compiled circuit's WASM witness
//! generator into native code linked into the app, so the module computes the circuit witness
//! natively rather than interpreting WebAssembly under Hermes.
//!
//! The directory holding the generator arrives in `TABLEMATE_CIRCUIT_WASM_DIR`, which
//! `packages/circuits/scripts/build-native.sh` exports before `mopro build`.

use std::env;
use std::path::PathBuf;

/// Environment variable naming the directory holding the circuit's compiled witness generator.
const WASM_DIR_VAR: &str = "TABLEMATE_CIRCUIT_WASM_DIR";

/// The witness generator `packages/circuits/scripts/compile.sh` produces for this circuit.
/// rust-witness derives the linked symbol from the file's basename with `_` and `-` removed, so
/// `rust_witness::witness!(tablemateitinerary)` in `src/lib.rs` is the name this file yields.
const WASM_FILE: &str = "tablemate_itinerary.wasm";

fn main() {
    // Printing any rerun-if-* directive replaces Cargo's default of watching every file in the
    // package, so the script names itself as well as the variable and the file it reads.
    println!("cargo:rerun-if-env-changed={WASM_DIR_VAR}");
    println!("cargo:rerun-if-changed=build.rs");

    // A value that is not valid UTF-8 is as unusable as an unset one, because the directory has to
    // name a path: `env::var` reports it as an error, and both cases read as empty here.
    let configured = env::var(WASM_DIR_VAR).unwrap_or_default();
    let configured = configured.trim();
    let wasm_dir = resolve(configured);
    let wasm = wasm_dir.join(WASM_FILE);

    // Checked here rather than left to the transpiler, which panics on a directory that does not
    // exist: one message names the variable, the file and the commands that produce it.
    let problem = if configured.is_empty() {
        Some(format!(
            "is unset, empty or not valid UTF-8, so {WASM_FILE} cannot be located"
        ))
    } else if !wasm.is_file() {
        Some(format!(
            "resolves to {}, which holds no {WASM_FILE}",
            wasm.display()
        ))
    } else {
        None
    };
    if let Some(problem) = problem {
        panic!(
            "{WASM_DIR_VAR} {problem}. Run `pnpm circuits:compile` to produce the file, then build \
             through `pnpm circuits:native`, which sets {WASM_DIR_VAR}."
        );
    }

    // The linked witness is generated from this file, so a recompiled circuit must rerun the script.
    println!("cargo:rerun-if-changed={}", wasm.display());

    rust_witness::transpile::transpile_wasm(wasm_dir.to_string_lossy().into_owned());
}

/// Resolves the configured directory: an absolute value as given, a relative one against the crate
/// root Cargo reports, because a build script's working directory is the crate root only by
/// convention. Outside Cargo the process working directory stands in.
fn resolve(configured: &str) -> PathBuf {
    let dir = PathBuf::from(configured);
    if configured.is_empty() || dir.is_absolute() {
        return dir;
    }
    let root = match env::var_os("CARGO_MANIFEST_DIR") {
        Some(root) => PathBuf::from(root),
        None => PathBuf::from("."),
    };
    root.join(dir)
}
