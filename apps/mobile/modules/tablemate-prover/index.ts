/**
 * The app's entry point to the local native prover module (AAP 0.5.1, AAP 0.8.1): the rapidsnark
 * and rust-witness Groth16 prover and the streaming SHA-256 of a downloaded proving key, behind the
 * Expo module `TablemateProver` that `expo-module.config.json` registers. `pnpm circuits:native`
 * must run first: the module is linked into an Expo development or `bench` build, and Expo Go, the
 * web build and any native build made without those generated libraries have none at all, so
 * `isProverAvailable()` answers false there.
 */

export {
  isProverAvailable,
  generateProof,
  sha256File,
  TablemateProverError,
} from './src/TablemateProverModule';
export type { NativeProofResult, ProverErrorCode } from './src/TablemateProverModule';
