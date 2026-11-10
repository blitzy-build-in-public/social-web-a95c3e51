/**
 * The app's entry point to the local native prover module: the rapidsnark and rust-witness Groth16 prover and the streaming SHA-256 of a downloaded proving key, behind the Expo module `TablemateProver`.
 * `pnpm circuits:native` must run first — Expo Go, the web build and any native build made without those generated libraries have none, so `isProverAvailable()` answers false there.
 */

export {
  isProverAvailable,
  generateProof,
  sha256File,
  TablemateProverError,
} from './src/TablemateProverModule';
export type { NativeProofResult, ProverErrorCode } from './src/TablemateProverModule';
