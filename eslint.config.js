/**
 * Root ESLint configuration for the Tablemate workspace (flat config, ESLint 10, ESM).
 *
 * Five invariants are enforced here that no compiler can express, each because a violation would
 * show up only on a platform or in a mode the build never exercised:
 *
 *   - Client-safe code — `packages/circuits/src`, the mobile app's `app/` and `src/`, and the local
 *     prover module — imports no Node built-in, no `Buffer` and not `@zk-email/helpers`: it runs
 *     under Hermes and in browsers (AAP 0.5.5).
 *   - Only `apps/api/src/modules/payments/stripe-gateway.ts` imports the `stripe` SDK, and only
 *     `packages/server-core/src/telephony/twilio-client.ts` imports `twilio` (AAP 0.6.2, 0.11.1).
 *   - Server code reads the time from the injected clock, never `Date.now()` or an argument-less
 *     `new Date()` (AAP 0.11.1).
 *   - Server code logs through the logger, never `console`, so no line reaches stdout or stderr
 *     outside pino's redaction paths (AAP 0.3.2, 0.11.1).
 *   - Every React surface follows the Rules of React.
 *
 * Two orderings are load-bearing. A later object REPLACES an earlier one's options for the same rule
 * rather than merging with them, so the client-safe object follows the server objects (its own list
 * repeats the two server-only SDKs) and the three re-allowing overrides come last. And every
 * TypeScript file is matched by one workspace `tsconfig.json`, which is what lets `projectService`
 * resolve types for all of them.
 */
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const CLIENT_SAFE =
  'Client-safe code runs under Hermes and in browsers; use Uint8Array, @noble/hashes or poseidon-lite.';
const CLOCK = 'Use the injected clock (packages/server-core/src/clock.ts).';

/* Ships inside the client bundle, so it runs where Node's modules do not exist. */
const NODE_BUILT_INS = [
  'buffer',
  'child_process',
  'crypto',
  'dns',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'stream',
  'tls',
  'zlib',
];

/**
 * Everything the client bundle is built from. `apps/mobile/e2e`, `apps/mobile/test`, `app.config.ts`
 * and the `*.config.cjs` files are deliberately absent: Playwright, Vitest, Expo's config loader and
 * Metro run in Node, where `fs` and `path` are legitimate.
 */
const CLIENT_SAFE_FILES = [
  'packages/circuits/src/**/*.ts',
  'apps/mobile/index.ts',
  'apps/mobile/app/**/*.{ts,tsx}',
  'apps/mobile/src/**/*.{ts,tsx}',
  'apps/mobile/modules/tablemate-prover/index.ts',
  'apps/mobile/modules/tablemate-prover/src/**/*.ts',
];

/**
 * Server code, wherever it lives. Widening this to every app's and package's `src` also covers the
 * two client trees above, which the client-safe object below then narrows to its own list; nothing
 * is lost, because both lists ban the two SDKs.
 */
const SERVER_FILES = ['apps/**/src/**/*.{ts,tsx}', 'packages/**/src/**/*.{ts,tsx}'];

/* The server trees, where time comes from the injected clock and output goes through the logger
 * (AAP 0.3.2, 0.11.1). */
const SERVER_TREES = [
  'apps/api/src/**/*.{ts,tsx}',
  'apps/workers/src/**/*.{ts,tsx}',
  'packages/server-core/src/**/*.{ts,tsx}',
  'packages/db/src/**/*.{ts,tsx}',
  'packages/db/seed/**/*.{ts,tsx}',
];

const REACT_FILES = ['apps/mobile/**/*.{ts,tsx}', 'apps/venue-console/**/*.{ts,tsx}'];

const CLIENT_SAFE_IMPORTS = [
  ...NODE_BUILT_INS.map((name) => ({ name, message: CLIENT_SAFE })),
  {
    name: '@zk-email/helpers',
    message:
      'Loads Node crypto and dns and a git-hosted snarkjs fork; it is a Node-side test oracle only. Use @tablemate/circuits for input generation.',
  },
  {
    name: 'stripe',
    message:
      'The Stripe SDK is server-only; the clients use @stripe/stripe-js or @stripe/stripe-react-native.',
  },
  {
    name: 'twilio',
    message: 'Only packages/server-core/src/telephony/twilio-client.ts calls Twilio.',
  },
];

const STRIPE_SEAM = {
  name: 'stripe',
  message:
    'Only apps/api/src/modules/payments/stripe-gateway.ts imports the Stripe SDK (AAP 0.6.2).',
};
const TWILIO_SEAM = {
  name: 'twilio',
  message: 'Only packages/server-core/src/telephony/twilio-client.ts imports Twilio (AAP 0.11.1).',
};

export default tseslint.config(
  /* Generated, vendored and fixture content: Expo prebuild and cargo output, signed test emails,
   * recorded Overpass responses and menu documents rather than project code. */
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.tsbuild/**',
      'coverage/**',
      '.local/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'packages/circuits/build/**',
      'packages/circuits/samples/**',
      'packages/circuits/fixtures/**',
      'apps/mobile/.expo/**',
      'apps/mobile/dist/**',
      'apps/mobile/ios/**',
      'apps/mobile/android/**',
      'apps/mobile/expo-env.d.ts',
      'apps/mobile/modules/tablemate-prover/rust/target/**',
      'apps/workers/test/fixtures/**',
      'apps/workers/eval/fixtures/**',
    ],
  },

  /* TypeScript, type-aware. `projectService` maps each file to its workspace project. */
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // verbatimModuleSyntax (tsconfig.base.json) means a type-only import must be written as one.
      // Inline `typeof import('x')` annotations stay allowed: they emit nothing at runtime, and they
      // are the only way to name the callable default of a CommonJS module under NodeNext, where a
      // bare `import type` would name its namespace instead.
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  /* Test code: only Vitest's `expect(instance.method)` idiom needs relaxing. */
  {
    files: ['**/test/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/e2e/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/unbound-method': 'off' },
  },

  /* JavaScript carries no type information. The plugin is registered here because the type-aware
   * base above is scoped to TypeScript files, and a rule cannot be switched off by a config that has
   * not loaded the plugin providing it. */
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    plugins: { '@typescript-eslint': tseslint.plugin },
  },

  /* Expo's Babel and Metro configs are CommonJS inside an ESM package. */
  {
    files: ['apps/mobile/*.config.{js,cjs}'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        module: 'writable',
        process: 'readonly',
        require: 'readonly',
      },
    },
  },

  /* k6 scripts are ES modules run by the k6 runtime, not by Node. */
  {
    files: ['infra/k6/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { __ENV: 'readonly', __ITER: 'readonly', __VU: 'readonly' },
    },
  },

  /* Maestro's JavaScript steps run in its own sandbox with these four objects in scope. */
  {
    files: ['apps/mobile/e2e/maestro/scripts/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { http: 'readonly', json: 'readonly', maestro: 'readonly', output: 'readonly' },
    },
  },

  /* Rules of React for the traveler app, its operator screens and the venue console. */
  { ...reactHooks.configs.flat.recommended, files: REACT_FILES },

  /* Stripe and Twilio are reached through one seam each, so a provider stays swappable. */
  {
    files: SERVER_FILES,
    rules: { 'no-restricted-imports': ['error', { paths: [STRIPE_SEAM, TWILIO_SEAM] }] },
  },

  /* Server invariants. Time comes from the injected clock, so the test clock can move it, and output
   * goes through the logger rather than `console`, so no line reaches stdout or stderr outside pino's
   * redaction paths (AAP 0.3.2, 0.11.1). The browser surfaces stay outside this set on purpose: the
   * venue console's once-per-page unreadable-`Date` warning and the mobile app's client-side push and
   * proof notices are the user's console, not the server's. */
  {
    files: SERVER_TREES,
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: CLOCK,
        },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK },
      ],
    },
  },

  /* Client-safe code. Placed after the server objects on purpose: the later object replaces the
   * import list for every file both patterns match, and this list covers the server-only SDKs too. */
  {
    files: CLIENT_SAFE_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: CLIENT_SAFE_IMPORTS,
          patterns: [{ group: ['node:*'], message: CLIENT_SAFE }],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Buffer',
          message: 'Node global, absent under Hermes and in browsers; use Uint8Array.',
        },
      ],
    },
  },

  /* The two seams, and the one file whose job is to read the wall clock. */
  {
    files: ['apps/api/src/modules/payments/stripe-gateway.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [TWILIO_SEAM] }] },
  },
  {
    files: ['packages/server-core/src/telephony/twilio-client.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [STRIPE_SEAM] }] },
  },
  { files: ['packages/server-core/src/clock.ts'], rules: { 'no-restricted-syntax': 'off' } },
);
