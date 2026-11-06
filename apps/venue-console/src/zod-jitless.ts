/**
 * Declares the console eval-free to Zod, so the probe it runs while the first schema is built never
 * reaches the browser's Content-Security-Policy (AAP 0.3.2).
 *
 * Every console page imports `@tablemate/shared`, whose schemas are built at module scope, and Zod
 * 4 probes `new Function('')` once while the first of them is constructed. The probe sits in a
 * `try`/`catch` and its throw only costs the JIT path -- but a policy of `script-src 'self'` still
 * reports the blocked call as a `securitypolicyviolation` on every load, and no policy can excuse a
 * single swallowed `eval`. Zod reads this one flag before probing, so the console states the
 * eval-free environment its policy already enforces, instead of the policy being widened to
 * `'unsafe-eval'` and letting a real eval through with it.
 *
 * `main.tsx` imports this module ahead of `@tablemate/shared`: a module's body runs after its own
 * imports, so the flag has to be set from a module the entry point reaches first. Zod hangs the
 * configuration object off `globalThis` for exactly this case, and it is mutated rather than
 * replaced, because Zod binds the object it finds there.
 */
type ZodGlobalConfig = { jitless?: boolean };

const globals = globalThis as typeof globalThis & { __zod_globalConfig?: ZodGlobalConfig };

const zodConfig: ZodGlobalConfig = (globals.__zod_globalConfig ??= {});

zodConfig.jitless = true;
