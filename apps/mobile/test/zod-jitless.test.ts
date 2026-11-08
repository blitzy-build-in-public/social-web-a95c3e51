/**
 * The web client's eval-free declaration, and the probe it keeps out of the bundle (AAP 0.3.2).
 *
 * The web export is served under a policy of `script-src 'self'` and no `'unsafe-eval'`
 * (`infra/nginx/web.conf`), so any `new Function` the bundle itself performs is blocked and reported
 * by the browser as a `securitypolicyviolation` on every load. Zod runs exactly one, out of
 * `util.allowsEval`, while the first `z.object` schema is constructed -- and
 * `packages/shared/src/schemas/*` builds its schemas at module scope, so importing that barrel is
 * enough to trigger it. `src/zod-jitless.web.ts` states the eval-free environment the policy already
 * enforces, and `index.ts` imports it ahead of `expo-router/entry`, so the flag is set before the
 * first shared schema exists.
 *
 * Three properties are asserted, in an order that keeps each one provable: the flag is set, the
 * configuration object Zod binds is mutated rather than replaced, and the probe is never attempted
 * while the shared schemas are built. Every import here is dynamic and every case starts from a cold
 * `globalThis`, because the ordering is the whole mechanism: a module's body runs after its own
 * imports, Zod hangs `globalConfig` off `globalThis` when it loads, and `util.allowsEval` memoises
 * its answer -- so a flag set, or a configuration object swapped in, after any of those has happened
 * would leave Zod probing exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The object Zod shares through `globalThis.__zod_globalConfig`, as far as this test reads it. */
interface ZodGlobalConfig {
  jitless?: boolean;
  postProcessor?: unknown;
}

const globals = globalThis as typeof globalThis & { __zod_globalConfig?: ZodGlobalConfig };

/**
 * A configured city in the shape `CityDto` accepts. `CityDto` is a `z.object`, which is the schema
 * kind whose constructor reads the flag, and the second value differs only in its slug, so the pair
 * covers the accepted and the rejected parse in one place.
 */
const CITY = {
  id: 'lisbon',
  name: 'Lisbon',
  countryCode: 'PT',
  timezone: 'Europe/Lisbon',
  currency: 'EUR',
};
const NOT_A_SLUG = { ...CITY, id: 'Lisbon' };

beforeEach(() => {
  // A cold start, which is the state the app is in when its entry point runs.
  delete globals.__zod_globalConfig;
  vi.resetModules();
});

afterEach(() => {
  delete globals.__zod_globalConfig;
});

describe("the web client's eval-free declaration", () => {
  it('sets jitless on the configuration object Zod reads', async () => {
    await import('../src/zod-jitless.web.ts');

    expect(globals.__zod_globalConfig?.jitless).toBe(true);
  });

  it('mutates the configuration object rather than replacing it', async () => {
    const marker = { postProcessor: (): void => undefined };
    globals.__zod_globalConfig = marker;

    await import('../src/zod-jitless.web.ts');

    // Zod binds the object it finds on `globalThis`, so a replacement would leave the bound one
    // untouched: the sentinel has to survive beside the flag for the declaration to work at all.
    expect(globals.__zod_globalConfig).toBe(marker);
    expect(globals.__zod_globalConfig?.postProcessor).toBe(marker.postProcessor);
    expect(globals.__zod_globalConfig?.jitless).toBe(true);
  });

  it('never constructs a function while the shared schemas are built and parsed', async () => {
    await import('../src/zod-jitless.web.ts');

    const original = globalThis.Function;
    let constructions = 0;
    const counting = function (...args: string[]): unknown {
      constructions += 1;
      return original(...args);
    };
    globalThis.Function = counting as unknown as typeof globalThis.Function;
    try {
      // Dynamic on purpose: a static import is hoisted, so it would evaluate the barrel before the
      // stub is in place and leave the count below meaning nothing.
      const shared = await import('@tablemate/shared');

      expect(constructions).toBe(0);
      expect(shared.CityDto.parse(CITY)).toEqual(CITY);
      expect(shared.CityDto.safeParse(NOT_A_SLUG).success).toBe(false);

      // The stub is wired and does count, so the zero above is a real zero.
      const countingGlobal = globalThis.Function;
      expect(typeof new countingGlobal('')).toBe('function');
      expect(constructions).toBe(1);
    } finally {
      globalThis.Function = original;
    }
  });
});
