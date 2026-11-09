/** Build config for the venue console: the check-in code screen and the lodging stats screen. */
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';

/** The API origin this app reads at build time (AAP 0.6.2), without a path. */
const API_URL_VAR = 'VITE_API_URL';

/** The repository root, which holds the `.env` file this build loads (AAP 0.6.2). */
const ENV_DIR = '../..';

/**
 * The build-time variable naming the port `server` and `preview` listen on, read from the repository-root
 * `.env` or the shell. It is overridable because this run reserves a per-clone port block, so the console's
 * port is `21000 + clone index × 10 + 2`: pinned to one value, a second clone's dev server fails to start.
 */
const CONSOLE_PORT_VAR = 'VITE_CONSOLE_PORT';

/** The console's dev and preview port when `VITE_CONSOLE_PORT` is absent or blank: the origin in the
 * API's `VENUE_CONSOLE_ORIGIN` allowlist. */
const DEFAULT_CONSOLE_PORT = 8090;

const MISSING_MESSAGE = `${API_URL_VAR} is required: the API origin without a path, e.g. http://localhost:3000 (see .env.example)`;
/** The message an unusable `VITE_API_URL` fails with, quoting the value it echoes. */
function invalidMessage(value: string): string {
  return `${API_URL_VAR} is invalid: expected the API origin without a path, e.g. http://localhost:3000 (got ${JSON.stringify(value)})`;
}

/**
 * Validates and normalizes the API origin the console calls (AAP 0.6.2). A path, query, fragment or
 * credentials are refused rather than trimmed, because dropping any of them would call an origin other
 * than the one configured; one trailing slash is removed, because the client appends `/v1` by
 * concatenation. The value is the only thing the error echoes.
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
/** The message an unusable `VITE_CONSOLE_PORT` fails with, quoting the value it echoes. */
function invalidPortMessage(value: string): string {
  return `${CONSOLE_PORT_VAR} is invalid: expected an integer between 1 and 65535 (got ${JSON.stringify(value)})`;
}
/**
 * Resolves the port the dev server and the preview server listen on. An absent or blank value is the
 * default rather than an error, because the variable exists only to move the console inside the port
 * block a parallel run reserves. A value that is set is taken as a port or refused: `1e3`, `0x1F90` and
 * `21132/tcp` are rejected instead of being read as a different port.
 */
function resolveConsolePort(configured: string | undefined): number {
  const value = (configured ?? '').trim();
  if (value.length === 0) {
    return DEFAULT_CONSOLE_PORT;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(invalidPortMessage(value));
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(invalidPortMessage(value));
  }
  return port;
}
/**
 * The console's Vite configuration (AAP 0.6.2, 0.8.1). The function form is required, because `loadEnv`
 * needs the resolved mode to pick `.env.<mode>`.
 *
 * `resolve.conditions` is replaced wherever it is set, so Vite's own client conditions are spread back
 * in beside `tablemate-source` -- the condition that resolves `@tablemate/shared` to its TypeScript
 * source as Metro, tsx and Vitest do, with `browser` kept because `qrcode` ships a browser entry.
 * `envDir` is the repository root, so the `.env` a developer copies from `.env.example` reaches this
 * file, and only `VITE_`-prefixed values cross into the bundle. Both servers bind the port
 * `VITE_CONSOLE_PORT` names, so the console follows the per-clone port block the run reserves.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ENV_DIR, 'VITE_');
  const apiUrl = resolveApiOrigin(env[API_URL_VAR]);
  const port = resolveConsolePort(env[CONSOLE_PORT_VAR]);
  return {
    plugins: [react()],
    resolve: { conditions: ['tablemate-source', ...defaultClientConditions] },
    envDir: ENV_DIR,
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl) },
    server: { port, strictPort: true },
    preview: { port, strictPort: true },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  };
});
