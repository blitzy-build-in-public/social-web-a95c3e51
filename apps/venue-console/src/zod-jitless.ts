/**
 * Declares the console eval-free to Zod, so the probe it runs while the first schema is built never reaches the
 * browser's Content-Security-Policy (AAP 0.3.2).
 *
 * Zod 4 probes `new Function('')` once while the first schema is constructed; its throw only costs the JIT path, but a
 * `script-src 'self'` policy reports the call as a `securitypolicyviolation` on every load, and widening the policy
 * would let a real eval through with it. `main.tsx` imports this module ahead of `@tablemate/shared`, whose schemas are
 * built at import, so the flag must be set from a module the entry point reaches first; the configuration object Zod
 * hangs off `globalThis` is mutated rather than replaced, because Zod binds the object it finds there.
 */
type ZodGlobalConfig = { jitless?: boolean };
const globals = globalThis as typeof globalThis & { __zod_globalConfig?: ZodGlobalConfig };
const zodConfig: ZodGlobalConfig = (globals.__zod_globalConfig ??= {});
zodConfig.jitless = true;
