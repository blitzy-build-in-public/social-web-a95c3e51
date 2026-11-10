/**
 * `babel-preset-expo` carries the expo-router transform and `EXPO_PUBLIC_*` inlining. The `.cjs`
 * extension keeps this file CommonJS against `"type": "module"`; the loader reads `module.exports`.
 */
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
