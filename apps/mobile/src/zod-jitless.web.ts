/**
 * Declares the web client eval-free to Zod, so the probe it runs while the first shared schema is built never reaches the
 * browser's Content-Security-Policy (AAP 0.3.2): the policy serving this bundle grants `script-src 'self'` and no
 * `'unsafe-eval'` (`infra/nginx/web.conf`), so the blocked call is reported as a `securitypolicyviolation` on every load,
 * and widening the policy is what this module exists to avoid, since `'unsafe-eval'` would let a real eval through with
 * the probe.
 *
 * The flag has to be set before the first shared schema is built, and a module's body runs after its own imports, so
 * `../index.ts` imports this one ahead of `expo-router/entry`. Zod hangs the configuration object off `globalThis` and it
 * is mutated rather than replaced, because Zod binds the object it finds there.
 */
type ZodGlobalConfig = { jitless?: boolean };

const globals = globalThis as typeof globalThis & { __zod_globalConfig?: ZodGlobalConfig };

const zodConfig: ZodGlobalConfig = (globals.__zod_globalConfig ??= {});

zodConfig.jitless = true;
