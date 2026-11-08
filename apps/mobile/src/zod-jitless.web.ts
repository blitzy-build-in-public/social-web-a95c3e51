/**
 * Declares the web client eval-free to Zod, so the probe it runs while the first shared schema is
 * built never reaches the browser's Content-Security-Policy (AAP 0.3.2).
 *
 * Every screen imports `@tablemate/shared`, whose contract schemas are `z.object` values built at
 * module scope, and Zod 4 probes `new Function('')` once while the first of them is constructed. The
 * probe sits in a `try`/`catch` and its throw only costs the JIT path -- but the policy that serves
 * this bundle grants `script-src 'self'` and no `'unsafe-eval'` (`infra/nginx/web.conf`), so a
 * browser reports the blocked call as a `securitypolicyviolation` on every load. Widening the policy
 * is what this module exists to avoid: `'unsafe-eval'` would let a real eval through with the probe.
 * Zod reads this one flag before probing, so the client states the eval-free environment its policy
 * already enforces.
 *
 * The flag has to be set before the first shared schema is built, and a module's body runs after its
 * own imports: only a module the entry point reaches first can do it, which is why `../index.ts`
 * imports this one ahead of `expo-router/entry`. Zod hangs the configuration object off `globalThis`
 * for exactly this case, and it is mutated rather than replaced, because Zod binds the object it
 * finds there.
 */
type ZodGlobalConfig = { jitless?: boolean };

const globals = globalThis as typeof globalThis & { __zod_globalConfig?: ZodGlobalConfig };

const zodConfig: ZodGlobalConfig = (globals.__zod_globalConfig ??= {});

zodConfig.jitless = true;
