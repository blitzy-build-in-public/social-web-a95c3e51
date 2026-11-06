/** Build config for the venue console: the check-in code screen and the lodging stats screen. */
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';

/** The one build-time variable this app reads (AAP 0.6.2): the API origin, without a path. */
const API_URL_VAR = 'VITE_API_URL';

/** The repository root, which holds the `.env` file this build loads (AAP 0.6.2). */
const ENV_DIR = '../..';

/** The console's dev and preview port: the origin in the API's `VENUE_CONSOLE_ORIGIN` allowlist. */
const CONSOLE_PORT = 8090;

const MISSING_MESSAGE = `${API_URL_VAR} is required: the API origin without a path, e.g. http://localhost:3000 (see .env.example)`;

/** The message an unusable `VITE_API_URL` fails with; the value is quoted and is all it echoes. */
function invalidMessage(value: string): string {
  return `${API_URL_VAR} is invalid: expected the API origin without a path, e.g. http://localhost:3000 (got ${JSON.stringify(value)})`;
}

/**
 * Validates and normalizes the API origin the console calls (AAP 0.6.2).
 *
 * A path, query, fragment or credentials are refused rather than trimmed, because dropping any of them
 * would call an origin other than the one configured; one trailing slash is removed, because the client
 * appends `/v1` by concatenation.
 *
 * @param configured - `VITE_API_URL` as the environment file or the shell supplied it.
 * @returns The origin as configured, without a trailing slash.
 * @throws Error when it is absent, blank or not an `http`/`https` origin.
 */
function resolveApiOrigin(configured: string | undefined): string {
  const value = (configured ?? '').trim();
  if (value.length === 0) {
    throw new Error(MISSING_MESSAGE);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(invalidMessage(value));
  }
  const bareOrigin =
    parsed.pathname === '/' &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0 &&
    parsed.username.length === 0 &&
    parsed.password.length === 0;
  const schemeAllowed = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (!schemeAllowed || !bareOrigin) {
    throw new Error(invalidMessage(value));
  }
  return value.replace(/\/$/, '');
}

/**
 * The console's Vite configuration (AAP 0.6.2, 0.8.1). The function form is required, because `loadEnv`
 * needs the resolved mode to pick `.env.<mode>`.
 *
 * `resolve.conditions` is replaced wherever it is set, so Vite's own client conditions are spread back
 * in beside `tablemate-source` -- the condition that resolves `@tablemate/shared` to
 * `packages/shared/src/index.ts` as Metro, tsx and Vitest do it, with `browser` kept because `qrcode`
 * ships a browser entry. `envDir` is the repository root, so the `.env` a developer copies from
 * `.env.example` reaches this file and `import.meta.env`; only `VITE_`-prefixed values cross into the
 * bundle, leaving the root file's server secrets out of it.
 *
 * @param env - The mode Vite runs in (`development`, `production`, or `--mode`).
 * @returns The resolved Vite configuration.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ENV_DIR, 'VITE_');
  const apiUrl = resolveApiOrigin(env[API_URL_VAR]);

  return {
    plugins: [react()],
    resolve: { conditions: ['tablemate-source', ...defaultClientConditions] },
    envDir: ENV_DIR,
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl) },
    server: { port: CONSOLE_PORT, strictPort: true },
    preview: { port: CONSOLE_PORT, strictPort: true },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  };
});
