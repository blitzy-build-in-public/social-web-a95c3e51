/**
 * The client entry of `@tablemate/circuits`: the `.eml` → circuit-witness input generator and the
 * issuer-registry builder that share this package's leaf and hash construction (AAP 0.5.1, AAP 0.5.5
 * "Client input generation", AAP 0.8.1).
 *
 * Client-safe, because `apps/mobile` loads it from source through the `tablemate-source` export
 * condition and bundles it for three platforms: it runs under Hermes (React Native 0.76.9), in a
 * browser Web Worker and in Node, so it reaches no Node built-in, no global `Buffer` and no
 * `@zk-email/helpers` — that package is a Node-side test oracle only. `apps/api` consumes the registry
 * builder (for its startup root check) from this same entry.
 *
 * Re-exports only, and every one of them by name: the package declares `sideEffects: false`, and a
 * wildcard would also publish the test-only helpers (`assembleInputs`, `parseEml`, the DKIM
 * canonicalization and partial-SHA-256 internals, the field locator), which `scripts/` and `test/`
 * import by relative path. `@tablemate/shared` types such as `IssuerConfig` are deliberately not
 * re-exported here: consumers import those from `@tablemate/shared` directly, so one schema keeps one
 * type identity.
 */

/* The input generator, the result it returns, and the only error it throws. */
export { buildCircuitInputs } from './inputs/build-inputs.ts';
export type {
  BuildCircuitInputsOptions,
  BuildCircuitInputsResult,
  CircuitInputs,
  SupportedIssuer,
} from './inputs/build-inputs.ts';
export { CIRCUIT_INPUT_ERROR_CODES, CircuitInputError } from './inputs/eml-parse.ts';
export type { CircuitInputErrorCode } from './inputs/eml-parse.ts';

/* The issuer registry: the depth-8 Poseidon tree the circuit's two Merkle paths are proven against. */
export { REGISTRY_DEPTH, buildRegistry, merkleProof, merkleRoot } from './registry/merkle.ts';
export type { MerkleProof, RegistryBuild, RegistryBuildInput } from './registry/merkle.ts';

/* Leaf, anchor and nullifier construction, and the template hash the issuer leaf commits to. */
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
