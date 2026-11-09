/**
 * The client's Metro entry point: the eval-free declaration, then Expo Router's own entry (AAP 0.3.2).
 *
 * `expo` reads this file from the `main` field of `apps/mobile/package.json`, so every platform starts here.
 * The order of the two imports below is load-bearing and is the whole reason this file exists: a module's body
 * runs after its own imports, and Zod reads `jitless` while the first `@tablemate/shared` schema is
 * constructed, so only a module the entry reaches before anything that imports that barrel can set the flag
 * in time.
 *
 * `./src/zod-jitless` is inert — it touches nothing but Zod's own configuration object — so the vendored
 * `expo-router/entry` still loads `@expo/metro-runtime` as its own first import, which is what Fast Refresh
 * on the web needs. The extensionless specifier is what lets one entry serve every platform: Metro resolves
 * the `.web.ts` half for the web export and the `.native.ts` half for an iOS or Android bundle.
 */
import './src/zod-jitless';

import 'expo-router/entry';
