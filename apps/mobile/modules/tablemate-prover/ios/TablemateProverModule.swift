import ExpoModulesCore

/// The proving key is not a file at the path the JS layer handed over.
///
/// Its reason is fixed text: it never carries the path, which names the app's
/// document directory, and the Rust error's own message never reaches JS (AAP 0.5.5).
final class ZkeyMissingException: Exception {
  override var code: String {
    "ERR_ZKEY_MISSING"
  }

  override var reason: String {
    "Proving key not found"
  }
}

/// The circuit inputs handed over are not a JSON object of non-empty arrays of
/// decimal integers, so no witness can be generated from them.
final class InputsInvalidException: Exception {
  override var code: String {
    "ERR_INPUTS_INVALID"
  }

  override var reason: String {
    "Circuit inputs are invalid"
  }
}

/// Witness generation or proving failed, for any reason the prover did not name itself.
final class ProverFailedException: Exception {
  override var code: String {
    "ERR_PROVER_FAILED"
  }

  override var reason: String {
    "Proof generation failed"
  }
}

/// On-device Groth16 proving for the `TablemateItinerary` circuit on iOS, plus the
/// incremental SHA-256 the artefacts layer checks a downloaded proving key with.
///
/// The Rust prover is statically linked into this pod — `MoproBindings.xcframework` and
/// the `Generated/mopro.swift` bindings are compiled in by `TablemateProver.podspec` — so
/// nothing here loads a library at runtime.
public class TablemateProverModule: Module {
  /// Proving takes up to about 90 s and hashing a gigabyte-scale proving key several
  /// seconds, so neither may run on the main queue, on the JS thread, or on
  /// expo-modules-core's shared async function queue: both are serialized on this one
  /// instead. Serial order is sound because the JS layer verifies the downloaded key
  /// before it proves with it.
  private let queue = DispatchQueue(label: "expo.modules.tablemateprover", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("TablemateProver")

    // Always true: the proving library is linked into this pod, and the podspec refuses to
    // install without it. The JS layer reads false only when the module is absent
    // altogether (Expo Go, web), which is the one case this module cannot report.
    Function("isProverAvailable") { () -> Bool in
      true
    }

    AsyncFunction("generateProof") { (zkeyPath: String, inputsJson: String) throws -> String in
      // The inputs are the private circuit input object, in memory for this call alone:
      // nothing is written to disk, and nothing is logged.
      do {
        // Returned untouched. The JS layer parses and checks this JSON, so it is never
        // decoded, re-encoded, inspected or logged here.
        return try generateTablemateProof(zkeyPath: zkeyPath, inputsJson: inputsJson)
      } catch let error as ProverError {
        // The variants are spelled as the generated uniffi bindings declare them, so a
        // regenerated binding that renames one is fixed in this switch.
        switch error {
        case .ZkeyMissing: throw ZkeyMissingException()
        case .InputsInvalid: throw InputsInvalidException()
        case .ProverFailed: throw ProverFailedException()
        }
      } catch {
        throw ProverFailedException()
      }
    }.runOnQueue(queue)

    AsyncFunction("sha256File") { (path: String) throws -> String in
      try Sha256File.hex(path)
    }.runOnQueue(queue)
  }
}
