/**
 * Declares the web client eval-free to Zod, so the probe it runs while the first shared schema is built
 * never trips the CSP serving this bundle (`script-src 'self'`, no `'unsafe-eval'`;
 * `infra/nginx/web.conf`), which widening the policy would let a real eval through with. The flag has to
 * precede the first shared schema, so `../index.ts` imports this ahead of `expo-router/entry`; Zod's
 * configuration object on `globalThis` is mutated rather than replaced, because Zod binds what it finds.
 */
type ZodGlobalConfig = { jitless?: boolean };
const globals = globalThis as typeof globalThis & { __zod_globalConfig?: ZodGlobalConfig };
const zodConfig: ZodGlobalConfig = (globals.__zod_globalConfig ??= {});
zodConfig.jitless = true;
