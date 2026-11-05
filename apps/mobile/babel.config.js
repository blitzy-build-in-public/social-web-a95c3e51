/**
 * Babel config for Metro (Expo SDK 52), loaded by @expo/metro-config's babel transformer.
 *
 * `babel-preset-expo` already carries the expo-router transform and `EXPO_PUBLIC_*` inlining,
 * so no plugin is listed here. This package is CommonJS: `apps/mobile/package.json` declares no
 * `"type": "module"`, so keep `module.exports`.
 */
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
