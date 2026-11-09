/**
 * The client entry of `@tablemate/circuits`: the `.eml` → circuit-witness input generator and the issuer-registry
 * builder that share this package's leaf and hash construction (AAP 0.5.5).
 *
 * Client-safe: `apps/mobile` loads it from source and bundles it for Hermes, a browser Web Worker and Node, so it
 * reaches no Node built-in and no `@zk-email/helpers`, which is a Node-side test oracle only. Re-exports only, and
 * every one by name — a wildcard would also publish the test-only helpers — while `@tablemate/shared` types keep one
 * type identity by being imported from their own package.
 */
export { buildCircuitInputs } from './inputs/build-inputs.ts';
export type {
  BuildCircuitInputsOptions,
  BuildCircuitInputsResult,
  CircuitInputs,
  SupportedIssuer,
} from './inputs/build-inputs.ts';
export { CIRCUIT_INPUT_ERROR_CODES, CircuitInputError } from './inputs/eml-parse.ts';
export type { CircuitInputErrorCode } from './inputs/eml-parse.ts';

export { REGISTRY_DEPTH, buildRegistry, merkleProof, merkleRoot } from './registry/merkle.ts';
export type { MerkleProof, RegistryBuild, RegistryBuildInput } from './registry/merkle.ts';

export {
  base64ToBytes,
  cityAliasHash,
  cityLeaf,
  issuerLeaf,
  modulusToLimbs,
  nullifierOf,
  packBytes,
  pubkeyHash,
  utf8Encode,
} from './registry/leaves.ts';
export { templateHash, templateParams } from './registry/template-hash.ts';
export type { TemplateParams } from './registry/template-hash.ts';
