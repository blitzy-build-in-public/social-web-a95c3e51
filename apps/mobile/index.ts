/**
 * The client's Metro entry point (`main` in `apps/mobile/package.json`), loaded for every platform.
 *
 * The import order is load-bearing: a module's body runs after its own imports, and Zod reads `jitless`
 * while the first `@tablemate/shared` schema is constructed, so the inert `./src/zod-jitless` module has
 * to be reached before anything that imports that barrel; the extensionless specifier then resolves the
 * `.web` or the `.native` half per platform.
 */
import './src/zod-jitless';
import 'expo-router/entry';
