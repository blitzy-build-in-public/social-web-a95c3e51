/**
 * Metro configuration for the Tablemate client, which bundles for iOS, Android and the web export from this one app
 * directory.
 *
 * Four settings here are not Expo SDK 52 defaults, each explained where it is set: `unstable_enablePackageExports` is
 * on, because it is off in Metro 0.81.5 and every installed package's `exports` map would otherwise be ignored —
 * including the `tablemate-source` condition the internal packages publish their TypeScript source through, and
 * snarkjs's `browser` condition; `tablemate-source` is prepended to `unstable_conditionNames` so that condition is
 * active on every platform; `eml` joins `resolver.assetExts` so the benchmark's booking-confirmation fixture bundles as
 * an asset, and has to stay out of `sourceExts`, because Expo drops any asset extension that is also a source
 * extension; and `resolver.resolveRequest` answers Metro's own empty module for that fixture whenever
 * `EXPO_PUBLIC_ZK_BENCH` is not `1`, because a literal `require` is collected from the module's syntax tree whatever the
 * runtime guard around it says, so the flag cannot remove the asset by itself.
 *
 * One consequence of the first two is worth knowing before chasing a failed native bundle: `snarkjs` declares only
 * `node`, `browser` and `umd` entries, so web gets its browser build while no condition matches on iOS or Android and
 * Metro falls back to the package's Node build, which imports `crypto` — so a native bundle that reaches `snarkjs` fails
 * on an unresolved `crypto` in `snarkjs/build/main.cjs` rather than at the import that pulled it in.
 *
 * Two more settings are stated rather than inherited, because each encodes the monorepo layout: the repository root is
 * watched (Expo's own watch folders are kept) and both `node_modules` roots are searched. Deliberately absent: no Node
 * built-in shims and no `extraNodeModules` polyfills, because client code, `src/zk` included, has to run under Hermes
 * and in a browser, so the bundle must fail on an unresolved `crypto`, `dns` or `fs` import rather than resolve a
 * polyfill for it.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

/** Adds a value Metro or Expo has not set already, so no default is ever duplicated. */
function withValue(values, value) {
  return values.includes(value) ? values : [...values, value];
}

// Expo watches the root node_modules and each workspace package directory; the repository root
// itself is added so that everything else in the tree, the circuit sources included, is
// watched too.
config.watchFolders = withValue(config.watchFolders, monorepoRoot);

// The app's own node_modules first, then the root's, which carries the hoisted packages. Expo
// computes this same pair for a detected workspace; stating it keeps resolution correct even
// when that detection finds nothing.
config.resolver.nodeModulesPaths = [
  ...new Set([
    path.resolve(projectRoot, 'node_modules'),
    path.resolve(monorepoRoot, 'node_modules'),
    ...config.resolver.nodeModulesPaths,
  ]),
];

// `resolver.disableHierarchicalLookup` stays at Metro's default `false`, so a dependency kept
// in a package's own nested node_modules is still found by walking up from the importing file.

// Reads the internal packages' `tablemate-source` entry (see the header comment).
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = [
  'tablemate-source',
  ...config.resolver.unstable_conditionNames.filter((name) => name !== 'tablemate-source'),
];

// The ZK benchmark screen bundles a booking-confirmation `.eml` as a fixture asset.
config.resolver.assetExts = withValue(config.resolver.assetExts, 'eml');

// The file that asset resolves to, whoever asks for it.
const BENCH_FIXTURE = path.resolve(
  monorepoRoot,
  'packages/circuits/fixtures/test-issuer/valid.eml',
);

// Keeps that fixture out of a non-bench bundle (see the header). Metro still reads the literal
// `require` in app/dev/zk-bench.tsx, so the runtime guard around it is not enough; answering the
// empty module for this one request drops the asset while every other request is resolved as usual.
if (process.env.EXPO_PUBLIC_ZK_BENCH !== '1') {
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    // Resolved the way Metro resolves a relative or absolute specifier: against the directory of
    // the module asking for it, which an absolute specifier replaces outright.
    const requested = path.resolve(path.dirname(context.originModulePath), moduleName);
    if (requested === BENCH_FIXTURE) return { type: 'empty' };
    return context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = config;
