/**
 * Babel config for Metro (Expo SDK 52), loaded by @expo/metro-config's babel transformer.
 *
 * `babel-preset-expo` already carries the expo-router transform and `EXPO_PUBLIC_*` inlining, so no plugin is
 * listed here. `apps/mobile/package.json` declares `"type": "module"`, so the `.cjs` extension is what keeps
 * this file CommonJS and `module.exports` is the export the loader reads.
 */
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
