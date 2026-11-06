/**
 * The depth-8 Poseidon registry tree and the issuer/city registry builder (AAP 0.5.5): the tree
 * `MerkleInclusion` in `circuits/lib/registry_membership.circom` folds a path through, and the
 * committed `config/registry/{production,test}.json` that `pnpm circuits:registry` writes.
 *
 * Level 0 is the leaf level, so `pathElements[0]` is the leaf's sibling, and the leaf index is the sum
 * of the path bits with bit i weighting 2^i, bit 0 meaning the current node is the left child. The
 * tree is padded to its 256 leaves with `EMPTY_LEAF`, and issuer key leaves come before city alias
 * leaves, because the circuit proves one of each against the single published root.
 *
 * Client-safe: `buildMerkleTree` runs on the device through `../inputs/build-inputs.ts` under Hermes
 * (React Native 0.76.9) and in the browser Web Worker, so this module imports `poseidon-lite`, the
 * shared contract and `./leaves.ts`/`./template-hash.ts` only — no Node built-in, no global `Buffer`,
 * no `TextEncoder`, no DOM API, no I/O, no randomness, no logging, and no work at module load.
 */
import type { CityConfig, IssuerConfig, RegistryFile } from '@tablemate/shared';

import { poseidon2 } from 'poseidon-lite';

import {
  BN254_SCALAR_FIELD,
  cityAliasHash,
  cityLeaf,
  issuerLeaf,
  modulusFromBase64,
  pubkeyHash,
  utf8Encode,
} from './leaves.ts';
import { templateHash } from './template-hash.ts';

/** The tree's fixed depth: the `depth` of `RegistryFile` and of `RegistryMembership(8)`. */
export const REGISTRY_DEPTH = 8;

/** The number of leaves the fixed-depth tree holds, 2^8 (AAP 0.5.5). */
export const MAX_REGISTRY_LEAVES = 256;

/**
 * The leaf a padded position holds: zero, which no Poseidon output can be, so an empty position can
 * never be proven as a member of the tree (AAP 0.5.5, `registry_membership.circom`).
 */
export const EMPTY_LEAF = 0n;

/**
 * A Merkle path through the registry tree, the shape `RegistryMembership`'s `MerkleInclusion` takes
 * and `../inputs/build-inputs.ts` emits as the circuit's `*PathElements[8]` and `*PathIndices[8]`.
 *
 * Both arrays hold exactly {@link REGISTRY_DEPTH} entries, level 0 (the leaf's sibling) first, and a
 * proof is bound to the root it was taken against.
 */
export interface MerkleProof {
  /** The sibling hash at each level, level 0 first. */
  pathElements: bigint[];
  /**
   * The path bit at each level: 0 when the current node is the left child, so the parent hashes
   * `(current, sibling)`, and 1 when it is the right child.
   */
  pathIndices: (0 | 1)[];
  /** The root this path reaches, the `registryRoot` public input. */
  root: bigint;
}

/**
 * The built tree: its root, and a proof of any leaf position it was built over.
 *
 * Built once per registry — the client hashes the tree once and takes both of its paths from it —
 * which is why the paths are extracted here rather than by a free function that rebuilds the tree.
 */
export interface MerkleTree {
  /** The root of the padded tree, the commitment `RegistryMembership` proves membership of. */
  readonly root: bigint;
  /**
   * The path of the leaf at `index`, level 0 first.
   *
   * @param index - The leaf position, 0 to 255.
   * @throws {RangeError} When `index` is not an integer in that range.
   */
  proof(index: number): MerkleProof;
}

/** The configuration {@link buildRegistry} builds a registry from. */
export interface RegistryBuildInput {
  /** Which registry this is: `production` or `test`. */
  name: RegistryFile['name'];
  /**
   * The issuer records to take leaves from. The caller decides inclusion by status: only `verified`
   * issuers are passed for the production registry, and `tablemate-test` is added for the test one.
   * An issuer carrying no template or no key records no leaf at all.
   */
  issuers: readonly IssuerConfig[];
  /** The launch cities, each contributing one leaf per alias. */
  cities: readonly CityConfig[];
}

/** The generated registry and the path of any leaf in it. */
export interface RegistryBuild {
  /** The file to write as `config/registry/<name>.json`, or to publish in `GET /zk/config`. */
  registry: RegistryFile;
  /**
   * The path of the leaf at `leafIndex`, the index a registry entry carries.
   *
   * @param leafIndex - A populated leaf position, 0 to `registry.leaves.length - 1`.
   * @throws {RangeError} When `leafIndex` is not an integer naming a populated leaf.
   */
  proofFor(leafIndex: number): MerkleProof;
}

/** Reads `list[index]`, throwing for an index no entry holds. */
function nodeAt(list: readonly bigint[], index: number): bigint {
  const value = list[index];
  if (value === undefined) {
    throw new RangeError('buildMerkleTree: missing node');
  }
  return value;
}

/** Whether `value` is a field element, the only kind of value a Poseidon input or output may be. */
function inField(value: bigint): boolean {
  return value >= 0n && value < BN254_SCALAR_FIELD;
}

/**
 * Builds the fixed-depth Poseidon registry tree over `leaves` (AAP 0.5.5), padding past the last one
 * with {@link EMPTY_LEAF}.
 *
 * The tree mirrors `MerkleInclusion` exactly — level 0 is the leaf level, each parent is
 * `Poseidon(left, right)`, and the root is the one node at depth {@link REGISTRY_DEPTH} — so a path
 * this returns is the path the circuit folds of the root its `registryRoot` input names. Hashing every
 * level once lets the client take both of a proof's paths from one build, and lets the input generator
 * check the registry it was handed before emitting anything.
 *
 * A parent whose two children are both the empty subtree at their depth is read from a table of the
 * empty-subtree root at each depth instead of hashed — the same value, because it is the hash of the
 * same two children — which is what turns about 255 Poseidon calls into the populated count plus
 * eight and keeps the build affordable under Hermes.
 *
 * @param leaves - The populated leaves, issuer leaves first.
 * @returns The tree, with a proof of any of its 256 positions.
 * @throws {RangeError} When there are more than 256 leaves, or a leaf is not a field element.
 */
export function buildMerkleTree(leaves: readonly bigint[]): MerkleTree {
  if (leaves.length > MAX_REGISTRY_LEAVES) {
    throw new RangeError('buildMerkleTree: more than 256 leaves');
  }
  for (const leaf of leaves) {
    if (!inField(leaf)) {
      throw new RangeError('buildMerkleTree: leaf outside the field');
    }
  }

  // The root of an all-empty subtree at each depth, depths 0 to REGISTRY_DEPTH inclusive.
  const emptyRoots: bigint[] = [EMPTY_LEAF];
  for (let depth = 0; depth < REGISTRY_DEPTH; depth += 1) {
    const child = nodeAt(emptyRoots, depth);
    emptyRoots.push(poseidon2([child, child]));
  }

  const levels: bigint[][] = [];
  const bottom: bigint[] = [];
  for (let index = 0; index < MAX_REGISTRY_LEAVES; index += 1) {
    bottom.push(leaves[index] ?? EMPTY_LEAF);
  }
  levels.push(bottom);

  for (let depth = 0; depth < REGISTRY_DEPTH; depth += 1) {
    const empty = nodeAt(emptyRoots, depth);
    const emptyParent = nodeAt(emptyRoots, depth + 1);
    const level = nodeAtLevel(levels, depth);
    const parents: bigint[] = [];

    for (let index = 0; index < level.length; index += 2) {
      const left = nodeAt(level, index);
      const right = nodeAt(level, index + 1);
      parents.push(left === empty && right === empty ? emptyParent : poseidon2([left, right]));
    }

    levels.push(parents);
  }

  const root = nodeAt(nodeAtLevel(levels, REGISTRY_DEPTH), 0);

  return {
    root,
    proof(index: number): MerkleProof {
      if (!Number.isInteger(index) || index < 0 || index >= MAX_REGISTRY_LEAVES) {
        throw new RangeError('buildMerkleTree: index out of range');
      }

      const pathElements: bigint[] = [];
      const pathIndices: (0 | 1)[] = [];

      for (let depth = 0; depth < REGISTRY_DEPTH; depth += 1) {
        const position = index >> depth;
        pathElements.push(nodeAt(nodeAtLevel(levels, depth), position ^ 1));

        const bit: 0 | 1 = (position & 1) === 1 ? 1 : 0;
        pathIndices.push(bit);
      }

      return { pathElements, pathIndices, root };
    },
  };
}

/** Reads `levels[depth]`, the node array of one tree level. */
function nodeAtLevel(levels: readonly (readonly bigint[])[], depth: number): readonly bigint[] {
  const level = levels[depth];
  if (level === undefined) {
    throw new RangeError('buildMerkleTree: missing level');
  }
  return level;
}

/**
 * The root of the tree over `leaves`, the value `RegistryMembership`'s `registryRoot` input and the
 * `root` of the committed registry must equal.
 *
 * @param leaves - The populated leaves, issuer leaves first.
 * @throws {RangeError} When there are more than 256 leaves, or a leaf is not a field element.
 */
export function merkleRoot(leaves: readonly bigint[]): bigint {
  return buildMerkleTree(leaves).root;
}

/**
 * The path of the leaf at `index`, for a caller that needs a single proof (AAP 0.5.5).
 *
 * @param leaves - The populated leaves, issuer leaves first.
 * @param index - The leaf position.
 * @throws {RangeError} When there are more than 256 leaves, a leaf is not a field element, or `index`
 *   is not a leaf position.
 */
export function merkleProof(leaves: readonly bigint[], index: number): MerkleProof {
  return buildMerkleTree(leaves).proof(index);
}

/**
 * Folds a path the way `MerkleInclusion` does and reports whether it reaches the proof's root: the
 * check `../inputs/build-inputs.ts` makes of the registry entry it read, and the check the registry
 * tests make of every generated proof.
 *
 * It answers rather than throws, so a proof read from configuration cannot break a caller that only
 * wants to know whether it holds: a path that is not {@link REGISTRY_DEPTH} long, an index that is not
 * a path bit, and a value outside the field all return false.
 *
 * @param leaf - The leaf value the path starts from.
 * @param proof - The path, at the level-0-first order {@link MerkleProof} fixes.
 * @returns Whether the path reaches `proof.root`.
 */
export function verifyMerkleProof(leaf: bigint, proof: MerkleProof): boolean {
  const { pathElements, pathIndices, root } = proof;
  if (pathElements.length !== REGISTRY_DEPTH || pathIndices.length !== REGISTRY_DEPTH) {
    return false;
  }
  if (!inField(leaf) || !inField(root)) {
    return false;
  }

  let current = leaf;
  for (let depth = 0; depth < REGISTRY_DEPTH; depth += 1) {
    const sibling = pathElements[depth];
    const bit = pathIndices[depth];
    if (sibling === undefined || bit === undefined) {
      return false;
    }
    if (bit !== 0 && bit !== 1) {
      return false;
    }
    if (!inField(sibling)) {
      return false;
    }

    current = bit === 0 ? poseidon2([current, sibling]) : poseidon2([sibling, current]);
  }

  return current === root;
}

/**
 * Builds the registry {@link RegistryFile} of one environment and the path of any leaf in it
 * (AAP 0.5.5): the tree the circuit proves membership against, with the readable entries
 * `pnpm circuits:registry` writes to `config/registry/<name>.json` and `GET /zk/config` publishes.
 *
 * Leaf layout, which the circuit and the committed file both depend on: issuer key leaves first, in
 * ascending `issuerId` and, within an issuer, in configured key order; then city alias leaves, in
 * ascending `circuitCityId` and configured alias order. Inclusion by verification status is the
 * caller's decision — an issuer whose template is absent or whose keys are empty, as a record
 * awaiting samples is, contributes nothing, and no status is filtered out here. A key's domain is
 * lowercased because the client selects a key by the lowercased `d=` tag, while its selector is kept
 * as written; an alias's bytes are exactly what the decoded body carries, escapes included.
 *
 * An entry's `leafIndex` is its leaf's position in `registry.leaves`, which holds the populated leaves
 * only, while `registry.root` is the root of the tree padded to 256 with {@link EMPTY_LEAF}. The
 * result is deterministic — identical configuration gives a byte-identical
 * `JSON.stringify(registry, null, 2)`, whatever order the caller supplied its records in — so
 * `pnpm circuits:registry --check` and the registry test can compare it with the committed file.
 *
 * @param input - The environment's name, with the issuer and city configuration records.
 * @returns The built registry and a proof of any populated leaf.
 * @throws {RangeError} When an `issuerId`, city slug or `circuitCityId` repeats, a `(domain,
 *   selector)` pair repeats across issuers, two cities register identical alias bytes, or the
 *   populated leaves exceed 256. A repeated key or alias names neither value in the message.
 */
export function buildRegistry(input: RegistryBuildInput): RegistryBuild {
  const seenIssuerIds = new Set<number>();
  for (const issuer of input.issuers) {
    if (seenIssuerIds.has(issuer.issuerId)) {
      throw new RangeError('buildRegistry: duplicate issuerId');
    }
    seenIssuerIds.add(issuer.issuerId);
  }

  const leaves: bigint[] = [];
  const issuers: RegistryFile['issuers'] = [];
  const seenKeys = new Set<string>();
  const orderedIssuers = input.issuers.slice().sort((a, b) => a.issuerId - b.issuerId);

  for (const issuer of orderedIssuers) {
    if (issuer.template === null || issuer.keys.length === 0) {
      continue;
    }

    const th = templateHash(issuer.template);

    for (const key of issuer.keys) {
      const domain = key.domain.toLowerCase();
      const keyId = JSON.stringify([domain, key.selector]);
      if (seenKeys.has(keyId)) {
        throw new RangeError('buildRegistry: duplicate DKIM domain and selector');
      }
      seenKeys.add(keyId);

      const pk = pubkeyHash(modulusFromBase64(key.modulusBase64));
      const leafIndex = leaves.length;
      leaves.push(issuerLeaf(issuer.issuerId, pk, th));
      issuers.push({
        issuerId: issuer.issuerId,
        displayName: issuer.displayName,
        domain,
        selector: key.selector,
        pubkeyHash: pk.toString(),
        templateHash: th.toString(),
        leafIndex,
      });
    }
  }

  const seenCityIds = new Set<number>();
  const seenCitySlugs = new Set<string>();
  for (const city of input.cities) {
    if (seenCityIds.has(city.circuitCityId) || seenCitySlugs.has(city.id)) {
      throw new RangeError('buildRegistry: duplicate city');
    }
    seenCityIds.add(city.circuitCityId);
    seenCitySlugs.add(city.id);
  }

  const cities: RegistryFile['cities'] = [];
  const seenAliases = new Set<string>();
  const orderedCities = input.cities.slice().sort((a, b) => a.circuitCityId - b.circuitCityId);

  for (const city of orderedCities) {
    for (const alias of city.aliases) {
      const bytes = utf8Encode(alias);
      const aliasId = Array.prototype.join.call(bytes, ',');
      if (seenAliases.has(aliasId)) {
        throw new RangeError('buildRegistry: duplicate city alias');
      }
      seenAliases.add(aliasId);

      const ah = cityAliasHash(bytes);
      const leafIndex = leaves.length;
      leaves.push(cityLeaf(city.circuitCityId, ah));
      cities.push({
        cityId: city.circuitCityId,
        slug: city.id,
        alias,
        aliasHash: ah.toString(),
        leafIndex,
      });
    }
  }

  if (leaves.length > MAX_REGISTRY_LEAVES) {
    throw new RangeError('buildRegistry: more than 256 leaves');
  }

  const tree = buildMerkleTree(leaves);
  const registry: RegistryFile = {
    name: input.name,
    depth: REGISTRY_DEPTH,
    root: tree.root.toString(),
    leaves: leaves.map((leaf) => leaf.toString()),
    issuers,
    cities,
  };

  return {
    registry,
    proofFor(leafIndex: number): MerkleProof {
      if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
        throw new RangeError('buildRegistry: no leaf at index');
      }
      return tree.proof(leafIndex);
    },
  };
}
