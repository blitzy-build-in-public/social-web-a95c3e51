/**
 * Root Vitest configuration (AAP 0.8.1, 0.11.2): a `unit` project for the fast in-process suites
 * and an `integration` project for the suites requiring the PostgreSQL, Redis and Stripe
 * containers `apps/api/test/support/app.ts` starts in its globalSetup. Both resolve `@tablemate/*`
 * through the `tablemate-source` condition — each workspace as source, not its `dist`, without
 * a prior build (`tsconfig.base.json`) — so both projects run from a fresh checkout.
 */
import { defineConfig } from 'vitest/config';

/**
 * Points a workspace import at its source rather than at its compiled output, beside the conditions
 * a Node toolchain also needs.
 */
const SOURCE_CONDITIONS = ['tablemate-source', 'module', 'node', 'development|production'];

export default defineConfig({
  // `@tablemate/*` is symlinked into the hoisted `node_modules` and inlined by Vitest, so these are
  // the conditions its imports resolve under. Fresh arrays: Vite normalizes conditions in place.
  resolve: { conditions: [...SOURCE_CONDITIONS] },
  ssr: { resolve: { conditions: [...SOURCE_CONDITIONS] } },
  // Vitest loads a project's globalSetup in its internal `__vitest__` environment, which inherits
  // no root conditions: without this line the harness's own `@tablemate/*` imports need a build.
  environments: { __vitest__: { resolve: { conditions: [...SOURCE_CONDITIONS] } } },
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html'],
      include: ['apps/*/src/**', 'packages/*/src/**'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          testTimeout: 20_000,
          // Circuit suites compile a multi-million-constraint circuit; they set their own timeout.
          include: [
            'apps/*/test/unit/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
            'apps/mobile/test/**/*.test.ts',
            'apps/venue-console/test/**/*.test.ts',
            'scripts/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'apps/api/test/integration/**/*.test.ts',
            'apps/workers/test/integration/**/*.test.ts',
            'tests/system/**/*.test.ts',
          ],
          globalSetup: ['apps/api/test/support/app.ts'],
          // One shared database and Stripe proxy: suites serialize and reset their own state.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 240_000,
          env: {
            APP_ENV: 'test',
            LLM_PROVIDER: 'fake',
            TELEPHONY_MODE: 'simulator',
            // `pnpm test:stripe` sets STRIPE_MODE=test and passes the operator's test-mode keys in.
            STRIPE_MODE: process.env.STRIPE_MODE ?? 'mock',
          },
        },
      },
    ],
  },
});
