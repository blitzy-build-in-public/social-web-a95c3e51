package expo.modules.tablemateprover

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import uniffi.mopro.ProverException
import uniffi.mopro.generateTablemateProof

// The cause is null in all three: Expo renders a chained cause into the rejection message, and native or Rust text can carry a proving-key path or part of the private circuit inputs.
internal class ZkeyMissingException : CodedException("ERR_ZKEY_MISSING", "The proving key file is missing.", null)
internal class InputsInvalidException : CodedException("ERR_INPUTS_INVALID", "The proving inputs are invalid.", null)
internal class ProverFailedException : CodedException("ERR_PROVER_FAILED", "Proof generation failed.", null)

/**
 * On-device Groth16 prover for the Tablemate itinerary circuit, over the Mopro-generated uniffi bindings in `uniffi.mopro`: rust-witness generates the witness and rapidsnark the proof.
 * The circuit inputs arrive as an in-memory string and pass straight to Rust, so the inputs, the witness and the proof live only for the duration of a call: nothing here writes to disk, keeps a reference to them or logs them.
 */
class TablemateProverModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TablemateProver")

    // The key is never opened here, because rapidsnark loads it by path and it can be gigabytes; the Rust JSON comes back untouched for `src/TablemateProverModule.ts` to parse and the shared ProofSubmission schema to validate.
    AsyncFunction("generateProof") Coroutine { zkeyPath: String, inputsJson: String ->
      try {
        // Proving blocks for up to about 90 s, and a coroutine body otherwise runs on the single expo.modules.AsyncFunctionQueue thread every module call shares, so the native call is moved to the Default pool and the JS thread stays responsive.
        withContext(Dispatchers.Default) { generateTablemateProof(zkeyPath, inputsJson) }
      } catch (e: Throwable) {
        // Rust owns the key check and the input validation, so its variants are the only outcomes worth naming; a link failure, an out-of-memory proof or a uniffi contract mismatch is the same failure to the caller.
        throw when (e) {
          is CancellationException -> e
          is ProverException.ZkeyMissing -> ZkeyMissingException()
          is ProverException.InputsInvalid -> InputsInvalidException()
          else -> ProverFailedException()
        }
      }
    }

    AsyncFunction("sha256File") Coroutine { path: String ->
      try {
        // Sha256File streams the gigabyte-scale key, so it belongs on the IO pool.
        withContext(Dispatchers.IO) { Sha256File.hex(path) }
      } catch (e: Throwable) {
        throw when (e) {
          is CancellationException -> e
          // Sha256File's own codes have to survive: Expo wraps an uncoded exception and appends its message, which for a file failure carries the path.
          is CodedException -> e
          else -> HashFailedException()
        }
      }
    }

    Function("isProverAvailable") { available }
  }

  private companion object {
    // Must equal the name the generated `uniffi/mopro/mopro.kt` passes to JNA's `Native.load` and
    // the library `pnpm circuits:native android` writes; `[lib] name` in rust/Cargo.toml fixes both.
    const val LIB_NAME = "mopro_bindings"

    // A native library belongs to the process, so the probe runs once: an ABI without the .so fails as a LinkageError and a build without JNA as a ClassNotFoundException, and both only mean proving is unavailable, which JS reports as prover_unavailable rather than as a crash.
    val available: Boolean by lazy {
      try {
        Class.forName("com.sun.jna.Native")
        System.loadLibrary(LIB_NAME)
        true
      } catch (e: LinkageError) {
        false
      } catch (e: ClassNotFoundException) {
        false
      }
    }
  }
}
