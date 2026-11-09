/**
 * Metro configuration for the Tablemate client, which bundles for iOS, Android and the web
 * export from this one app directory.
 *
 * Four settings here are not Expo SDK 52 defaults: the first three follow from the way this
 * workspace consumes its own packages, the fourth keeps a bench-only asset out of every other
 * bundle, and each is explained where it is set.
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
 *  4. `resolver.resolveRequest` answers Metro's own empty module for that booking-confirmation
 *     fixture whenever `EXPO_PUBLIC_ZK_BENCH` is not `1`, so every other bundle leaves the asset
 *     out of its graph. A literal `require` is collected from the module's syntax tree whatever
 *     the runtime guard around it says, so the flag cannot remove the asset by itself, and the
 *     screen the fixture serves is unreachable unless the flag is `1`. The exclusion is
 *     conditional on the flag, so a `bench` export still bundles the fixture it proves.
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
