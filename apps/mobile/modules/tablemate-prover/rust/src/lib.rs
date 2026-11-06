//! On-device prover for the `TablemateItinerary` circuit (AAP 0.3.1, AAP 0.5.5).
//!
//! One entry point, [`generate_tablemate_proof`], resolves the circuit witness natively with
//! `rust-witness` and produces the Groth16 proof with rapidsnark, both through mopro's Circom
//! adapter. The inputs, the witness and the proof live only in memory for the duration of that
//! call: the module writes nothing to disk and nothing to any log stream, and no static or cache
//! keeps any of them after it returns.

// mopro's `app!()` expands a check on a `feature = "wasm"` that this crate has no reason to
// declare — the branch it guards is only taken for a wasm32 build, which the native prover never
// is — so the lint for that one check is allowed crate-wide rather than left to fail the build.
#![allow(unexpected_cfgs)]

mopro_ffi::app!();

// The linked witness generator. `build.rs` transpiles `tablemate_itinerary.wasm`, and rust-witness
// derives this symbol from the file's basename with `_` and `-` removed.
rust_witness::witness!(tablemateitinerary);

use std::path::Path;
use std::thread;
use std::time::Instant;

use circom_prover::prover::{prove, CircomProof, ProofLib};
use circom_prover::witness::{generate_witness, WitnessFn};
use serde_json::{json, Map, Value};

/// The circuit's seven public signals — the five outputs `cityId`, `arrivalDate`, `departureDate`,
/// `issuerId` and `nullifier`, then the two public inputs `registryRoot` and `nullifierSalt` — in
/// the order snarkjs delivers them: the order `PUBLIC_SIGNAL_NAMES` lists in
/// `packages/shared/src/schemas/proofs.ts` and the length `ProofSubmission` pins (AAP 0.5.5).
const PUBLIC_SIGNAL_COUNT: usize = 7;

/// Why a proof could not be produced.
///
/// Every variant is a unit variant and every message is fixed, so an error never carries a path, a
/// signal name, a field value or any part of the email the inputs came from (AAP 0.5.5). The native
/// module maps the variants to `ERR_ZKEY_MISSING`, `ERR_INPUTS_INVALID` and `ERR_PROVER_FAILED`.
#[derive(Debug)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum ProverError {
    /// The proving key is not a file at the given path.
    ZkeyMissing,
    /// The circuit inputs are not a JSON object of non-empty arrays of decimal integers.
    InputsInvalid,
    /// Witness generation or proving failed.
    ProverFailed,
}

impl std::fmt::Display for ProverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            ProverError::ZkeyMissing => "proving key file not found",
            ProverError::InputsInvalid => "circuit inputs are invalid",
            ProverError::ProverFailed => "proof generation failed",
        };
        f.write_str(message)
    }
}

impl std::error::Error for ProverError {}

/// Generates a Groth16 proof of `TablemateItinerary` for the given circuit inputs.
///
/// `zkey_path` is the on-device proving key, which rapidsnark loads itself. `inputs_json` is the
/// private circuit input object the client's input generator builds from the imported booking
/// email; it, its witness and the proof never leave the device. The return value is a JSON string
/// carrying the proof, its seven public signals and the two timings, in the shape
/// `modules/tablemate-prover/src/TablemateProverModule.ts` checks and the shared `ProofSubmission`
/// schema validates.
///
/// # Errors
///
/// - [`ProverError::ZkeyMissing`] when `zkey_path` is not a file.
/// - [`ProverError::InputsInvalid`] when `inputs_json` cannot become the arrays of decimal strings
///   the witness generator reads.
/// - [`ProverError::ProverFailed`] when witness generation or proving fails.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn generate_tablemate_proof(
    zkey_path: String,
    inputs_json: String,
) -> Result<String, ProverError> {
    // The key is never opened or read here: it is gigabyte-scale (AAP 0.2.4) and rapidsnark loads
    // it from the path itself, so only its presence is checked.
    if !Path::new(&zkey_path).is_file() {
        return Err(ProverError::ZkeyMissing);
    }

    let normalized = normalize_inputs(&inputs_json)?;

    // The two phases are timed apart: `prove` takes a `JoinHandle`, so what it receives is a spawn
    // around the already-joined witness, which leaves `prove_ms` holding the proving time alone
    // (AAP 0.5.5).
    let witness_started = Instant::now();
    let witness = generate_witness(
        WitnessFn::RustWitness(tablemateitinerary_witness),
        normalized,
    )
    .join()
    .map_err(|_| ProverError::ProverFailed)?;
    let witness_ms = witness_started.elapsed().as_millis() as u64;

    let prove_started = Instant::now();
    // A native panic becomes `ProverFailed` instead of reaching uniffi as a panic message, which
    // would carry library internals back to the caller.
    let guarded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        prove(
            ProofLib::Rapidsnark,
            zkey_path,
            thread::spawn(move || witness),
        )
    }));
    let circom_proof = guarded
        .map_err(|_| ProverError::ProverFailed)?
        .map_err(|_| ProverError::ProverFailed)?;
    let prove_ms = prove_started.elapsed().as_millis() as u64;

    let proof = proof_json(&circom_proof)?;
    let public_signals = public_signals(&circom_proof)?;

    let result = json!({
        "proof": proof,
        "publicSignals": public_signals,
        "witnessMs": witness_ms,
        "proveMs": prove_ms,
    });

    Ok(result.to_string())
}

/// Rebuilds the circuit inputs in the form the parser behind `generate_witness` reads.
///
/// circom-prover 0.1.4 reads the JSON as a `serde_json::Value` and keeps only top-level object
/// entries whose values are arrays, and only the string elements of those arrays: a scalar, a
/// number or a nested array is dropped without complaint, which would generate a wrong witness
/// rather than an error. Every signal is therefore flattened here to a non-empty array of decimal
/// strings, and anything that cannot become one is rejected.
fn normalize_inputs(inputs_json: &str) -> Result<String, ProverError> {
    let parsed: Value =
        serde_json::from_str(inputs_json).map_err(|_| ProverError::InputsInvalid)?;
    let signals = match parsed {
        Value::Object(signals) if !signals.is_empty() => signals,
        _ => return Err(ProverError::InputsInvalid),
    };

    let mut normalized = Map::new();
    for (signal, value) in signals {
        let mut leaves = Vec::new();
        flatten_into(&value, &mut leaves)?;
        normalized.insert(signal, Value::Array(leaves));
    }

    Ok(Value::Object(normalized).to_string())
}

/// Flattens one signal's value row-major into its decimal-string leaves, recursively, so that
/// `anchors[4][32]` or `issuerPathElements[8]` arrives as the flat array the witness generator
/// expects. At any depth, a boolean, a null, an object, a negative, fractional or out-of-`u64`
/// number, an empty or non-digit string and an empty array are all rejected.
fn flatten_into(value: &Value, leaves: &mut Vec<Value>) -> Result<(), ProverError> {
    match value {
        Value::String(text) => {
            if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(ProverError::InputsInvalid);
            }
            leaves.push(Value::String(text.clone()));
        }
        Value::Number(number) => match number.as_u64() {
            Some(integer) => leaves.push(Value::String(integer.to_string())),
            None => return Err(ProverError::InputsInvalid),
        },
        Value::Array(items) => {
            if items.is_empty() {
                return Err(ProverError::InputsInvalid);
            }
            for item in items {
                flatten_into(item, leaves)?;
            }
        }
        _ => return Err(ProverError::InputsInvalid),
    }

    Ok(())
}

/// The proof in the snarkjs JSON shape `Groth16Proof` requires, with every coordinate a decimal
/// string.
fn proof_json(circom_proof: &CircomProof) -> Result<Value, ProverError> {
    let proof = &circom_proof.proof;

    // rapidsnark returns affine points, so every projective coordinate is one — `[1, 0]` for the
    // G2 point — and the arkworks affine conversion is unavailable because circom-prover's
    // `arkworks` feature is off. A projective point would make the serialized proof unverifiable.
    let g1_is_affine = dec(&proof.a.z) == "1" && dec(&proof.c.z) == "1";
    let g2_is_affine = dec(&proof.b.z[0]) == "1" && dec(&proof.b.z[1]) == "0";
    if !g1_is_affine || !g2_is_affine {
        return Err(ProverError::ProverFailed);
    }

    // The G2 limbs keep the order circom-prover parsed them in from rapidsnark's snarkjs-format
    // output. `snarkjs groth16 verify` on the host is the arbiter of that order: a mismatch is
    // corrected here, never in the check.
    let pi_a = json!([dec(&proof.a.x), dec(&proof.a.y), "1"]);
    let pi_b = json!([
        [dec(&proof.b.x[0]), dec(&proof.b.x[1])],
        [dec(&proof.b.y[0]), dec(&proof.b.y[1])],
        ["1", "0"]
    ]);
    let pi_c = json!([dec(&proof.c.x), dec(&proof.c.y), "1"]);

    // `protocol` and `curve` are the literals `Groth16Proof` pins, not the crate's own spellings.
    Ok(json!({
        "pi_a": pi_a,
        "pi_b": pi_b,
        "pi_c": pi_c,
        "protocol": "groth16",
        "curve": "bn128",
    }))
}

/// The circuit's public signals as decimal strings, in witness order (AAP 0.5.5).
fn public_signals(circom_proof: &CircomProof) -> Result<Vec<String>, ProverError> {
    let field_elements = &circom_proof.pub_inputs.0;
    let signals: Vec<String> = field_elements.iter().map(dec).collect();

    // Position is part of the contract and a signal is read by index, so a count other than the
    // seven `PUBLIC_SIGNAL_NAMES` names is a failure here rather than a submission the API answers
    // with `400 proof_malformed`.
    if signals.len() != PUBLIC_SIGNAL_COUNT {
        return Err(ProverError::ProverFailed);
    }

    Ok(signals)
}

/// One field element as the decimal string the shared schemas expect.
fn dec(value: &impl std::fmt::Display) -> String {
    value.to_string()
}
