/**
 * Metro configuration for the Tablemate client, which bundles for iOS, Android and the web
 * export from this one app directory.
 *
 * Three settings here are not Expo SDK 52 defaults, and each follows from the way this
 * workspace consumes its own packages:
 *
 *  1. `resolver.unstable_enablePackageExports` is off in Metro 0.81.5 and Expo leaves it off,
 *     so every installed package's `exports` map would be ignored. The internal packages
 *     (`@tablemate/shared`, `@tablemate/circuits`, …) publish their TypeScript source through
 *     the `tablemate-source` export condition, which only an `exports`-aware resolver reads;
 *     the same switch is what gives the web bundle `snarkjs`'s self-contained browser build
 *     through that package's `browser` condition.
 *  2. `tablemate-source` is prepended to `resolver.unstable_conditionNames` so the condition is
 *     active on every platform. Metro matches conditions as a set — the package's own `exports`
 *     map decides which entry wins — so this only adds a condition: `require` and `import`, and
 *     Expo's per-platform sets in `resolver.unstable_conditionsByPlatform` (`browser` on web,
 *     `react-native` on native), are kept as Expo defines them.
 *  3. `eml` joins `resolver.assetExts` so the booking-confirmation fixture that the `bench`-only
 *     proving benchmark screen bundles resolves as an asset. It has to stay out of
 *     `sourceExts`: Expo drops any asset extension that is also a source extension, and a
 *     module extension wins over an asset one.
 *
 * One consequence of the first two is worth knowing before chasing a failed native bundle.
 * `snarkjs` declares only `node`, `browser` and `umd` entries, so web gets its browser build
 * while no condition matches on iOS or Android. Metro warns and falls back to the package's
 * main field, its Node build, which imports `crypto` — a module that resolves nowhere here. So
 * a native bundle that reaches `snarkjs` fails on an unresolved `crypto` in
 * `snarkjs/build/main.cjs` rather than at the import that pulled it in.
 *
 * Two more settings are stated rather than inherited, because each encodes the monorepo
 * layout: the repository root is watched (Expo's own watch folders are kept), and both
 * `node_modules` roots are searched, as the workspace hoists most packages to the root.
 *
 * Deliberately absent: no Node built-in shims and no `extraNodeModules` polyfills. Client code,
 * `src/zk` included, has to run under Hermes and in a browser, so the bundle must fail on an
 * unresolved `crypto`, `dns` or `fs` import rather than resolve a polyfill for it.
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

module.exports = config;
