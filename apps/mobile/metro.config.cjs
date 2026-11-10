/**
 * Metro configuration for the client, which bundles for iOS, Android and the web export from this one app
 * directory.
 *
 * Four settings are not Expo SDK 52 defaults: `unstable_enablePackageExports` is on, because Metro 0.81.5
 * leaves it off and every installed package's `exports` map would otherwise be ignored — including the
 * `tablemate-source` condition the internal packages publish their TypeScript source through, and
 * snarkjs's `browser` condition; `tablemate-source` heads `unstable_conditionNames` so that condition is
 * active on every platform; `eml` joins `resolver.assetExts` so the benchmark's booking-confirmation
 * fixture bundles as an asset, and has to stay out of `sourceExts`, because Expo drops any asset
 * extension that is also a source extension; and `resolver.resolveRequest` answers Metro's own empty
 * module for that fixture whenever `EXPO_PUBLIC_ZK_BENCH` is not `1`, because a literal `require` is
 * collected from the module's syntax tree whatever the runtime guard around it says, so the flag cannot
 * remove the asset by itself.
 * A consequence worth knowing before chasing a failed native bundle: `snarkjs` declares only `node`,
 * `browser` and `umd` entries, so web gets its browser build while no condition matches on iOS or Android
 * and Metro falls back to the package's Node build, which imports `crypto`.
 * No Node built-in shims and no `extraNodeModules` polyfills on purpose, because client code, `src/zk`
 * included, has to run under Hermes and in a browser, so the bundle must fail on an unresolved `crypto`,
 * `dns` or `fs` import rather than resolve a polyfill for it.
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

config.watchFolders = withValue(config.watchFolders, monorepoRoot);

config.resolver.nodeModulesPaths = [
  ...new Set([
    path.resolve(projectRoot, 'node_modules'),
    path.resolve(monorepoRoot, 'node_modules'),
    ...config.resolver.nodeModulesPaths,
  ]),
];

// `resolver.disableHierarchicalLookup` stays at Metro's default `false`, so a dependency kept in a
// package's own nested node_modules is still found by walking up from the importing file.
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = [
  'tablemate-source',
  ...config.resolver.unstable_conditionNames.filter((name) => name !== 'tablemate-source'),
];
config.resolver.assetExts = withValue(config.resolver.assetExts, 'eml');

const BENCH_FIXTURE = path.resolve(
  monorepoRoot,
  'packages/circuits/fixtures/test-issuer/valid.eml',
);

// Keeps that fixture out of a non-bench bundle (see the header): the literal `require` is collected from
// the syntax tree whatever the runtime guard says, so answering the empty module for this one request
// drops the asset while every other request is resolved as usual.
if (process.env.EXPO_PUBLIC_ZK_BENCH !== '1') {
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    // Resolved as Metro resolves a relative or absolute specifier: against the module asking for it.
    const requested = path.resolve(path.dirname(context.originModulePath), moduleName);
    if (requested === BENCH_FIXTURE) return { type: 'empty' };
    return context.resolveRequest(context, moduleName, platform);
  };
}

module.exports = config;
