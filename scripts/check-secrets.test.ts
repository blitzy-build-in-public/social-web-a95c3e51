/**
 * The repository secret scan (AAP 0.8.1, `scripts/check-secrets.test.ts`): every credential shape AAP 0.12.2 lists
 * is caught, and every near miss it lists -- a bare prefix, a placeholder, a value one character short of a shape,
 * a digest, public material -- passes clean.
 *
 * Not one credential shape may be written into this file, because `pnpm lint` runs that scan over the whole
 * repository: every sample is assembled at run time from fragments, and the last suite enforces the property.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { formatFinding, isProbablyBinary, scanText, SECRET_PATTERNS } from './check-secrets.ts';

/** The path every sample is scanned under: a finding echoes it, and never the text that matched. */
const PATH = 'config/tablemate.env';

const WINDOW = 8;

/** `length` alphanumerics: the body of a Stripe key or webhook secret, assembled, never literal. */
function alnum(length: number): string {
  return 'aB3'.repeat(Math.ceil(length / 3)).slice(0, length);
}

function hex(length: number): string {
  return 'a1f9'.repeat(Math.ceil(length / 4)).slice(0, length);
}

function hexUpper(length: number): string {
  return 'A1F9'.repeat(Math.ceil(length / 4)).slice(0, length);
}

/** One PEM header: dashes, `BEGIN`, the label, dashes. Built, because a literal header is a finding. */
function pem(label: string): string {
  const dashes = '-'.repeat(5);
  return `${dashes}BEGIN ${label}${dashes}`;
}

function join(...parts: readonly string[]): string {
  return parts.join('');
}

const K_LIVE = join('sk', '_', 'live', '_', alnum(24));
const K_TEST = join('sk', '_', 'test', '_', alnum(24));
const R_LIVE = join('rk', '_', 'live', '_', alnum(24));
const R_TEST = join('rk', '_', 'test', '_', alnum(30));
const W32 = join('wh', 'sec_', alnum(32));
const W40 = join('wh', 'sec_', alnum(40));
const O40 = join('s', 'k-', alnum(40));
const O_PROJECT = join('s', 'k-', 'proj-', alnum(20), '_', alnum(20));
const H32 = hex(32);
const H32U = hexUpper(32);
const H31 = hex(31);
const H33 = hex(33);
const H64 = hex(64);
const SID = join('S', 'K', H32);
const PEM_PLAIN = pem('PRIVATE KEY');
const PEM_RSA = pem('RSA PRIVATE KEY');
const PEM_EC = pem('EC PRIVATE KEY');
const PEM_OPENSSH = pem('OPENSSH PRIVATE KEY');
const PEM_ENCRYPTED = pem('ENCRYPTED PRIVATE KEY');

const TOKEN = join('TWILIO_AUTH_TOKEN');
const TOKEN_ENV = join(TOKEN, '=');
const TOKEN_YAML = join(TOKEN, ': "');
const TOKEN_JSON = join('"', TOKEN, '": "');
const TOKEN_SPACED = join(TOKEN, ' = ');

/** One row per shape the scan must catch: the label Vitest prints (never the value), the pattern id, the text
 * scanned, the value behind the finding for the leak check, and the column the match starts at. Every text is one
 * line and the match is the whole credential, so a row asserts exactly one finding. */
const CAUGHT = [
  ['live secret key, 24 chars', 'stripe_secret_key', join('KEY=', K_LIVE), K_LIVE, 5],
  ['test secret key, YAML line', 'stripe_secret_key', join('KEY: ', K_TEST), K_TEST, 6],
  ['live restricted key, _ before', 'stripe_secret_key', join('FOO_', R_LIVE), R_LIVE, 5],
  ['test restricted key, quoted', 'stripe_secret_key', join('"', R_TEST, '"'), R_TEST, 2],
  ['webhook secret, 32 chars', 'stripe_webhook_secret', W32, W32, 1],
  ['webhook secret, 40 chars', 'stripe_webhook_secret', join('WEBHOOK=', W40), W40, 9],
  ['OpenAI key, 40 chars', 'openai_key', join('API_KEY=', O40), O40, 9],
  ['OpenAI project key', 'openai_key', O_PROJECT, O_PROJECT, 1],
  ['auth token, .env upper hex', 'twilio_auth_token', join(TOKEN_ENV, H32U), H32U, 1],
  ['auth token, .env lower hex', 'twilio_auth_token', join(TOKEN_ENV, H32), H32, 1],
  ['auth token, YAML quoted', 'twilio_auth_token', join(TOKEN_YAML, H32, '"'), H32, 1],
  ['auth token, JSON quoted', 'twilio_auth_token', join(TOKEN_JSON, H32, '"'), H32, 2],
  ['auth token, spaces round =', 'twilio_auth_token', join(TOKEN_SPACED, H32), H32, 1],
  ['API key SID, 32 hex chars', 'twilio_api_key_sid', join('API_KEY_SID=', SID), SID, 13],
  ['PEM, plain private key', 'pem_private_key', PEM_PLAIN, PEM_PLAIN, 1],
  ['PEM, RSA private key', 'pem_private_key', PEM_RSA, PEM_RSA, 1],
  ['PEM, EC private key', 'pem_private_key', PEM_EC, PEM_EC, 1],
  ['PEM, OpenSSH private key', 'pem_private_key', PEM_OPENSSH, PEM_OPENSSH, 1],
  ['PEM, encrypted private key', 'pem_private_key', PEM_ENCRYPTED, PEM_ENCRYPTED, 1],
] as const satisfies readonly (readonly [string, string, string, string, number])[];

/** One row per near miss the scan must let through: the label and the text. The placeholders the repository itself
 * ships are here beside the boundaries and the public material, because a false positive fails `pnpm lint` for
 * every developer. */
const MISSED = [
  ['bare test key prefix', join('sk', '_', 'test', '_')],
  ['bare live key prefix', join('sk', '_', 'live', '_')],
  ['bare restricted key prefix', join('rk', '_', 'test', '_')],
  ['bare webhook secret prefix', join('wh', 'sec_')],
  ['bare OpenAI key prefix', join('s', 'k-')],
  ['mock secret key placeholder', join('sk', '_', 'test', '_', 'replace_me')],
  ['mock mode secret key', join('sk', '_', 'test', '_', 'mock')],
  ['mock mode publishable key', join('pk', '_', 'test', '_', 'mock')],
  ['mock mode webhook secret', join('wh', 'sec_', 'mock')],
  ['angle-bracket key placeholder', join('<', 'STRIPE_SECRET_KEY', '>')],
  ['angle-bracket token placeholder', join('<', TOKEN, '>')],
  ['readable simulator token', join(TOKEN_ENV, 'tablemate-voice-simulator-token')],
  ['empty token assignment', TOKEN_ENV],
  ['simulator account SID', join('AC', '0'.repeat(32))],
  ['secret key one character short', join('sk', '_', 'test', '_', alnum(23))],
  ['webhook secret one character short', join('wh', 'sec_', alnum(31))],
  ['OpenAI key one character short', join('s', 'k-', alnum(39))],
  ['auth token one hex char short', join(TOKEN_ENV, H31)],
  ['API key SID one hex char short', join('S', 'K', H31)],
  ['API key SID one hex char long', join('S', 'K', H33)],
  ['auth token one hex char long', join(TOKEN_ENV, H33)],
  ['SHA-256 digest alone', H64],
  ['SHA-256 digest after a label', join('sha256:', H64)],
  ['SHA-256 digest as the token', join(TOKEN_ENV, H64)],
  ['32 hex chars assigned elsewhere', join('ETAG=', H32)],
  ['npm integrity hash', join('integrity: sha512-', alnum(64), '==')],
  ['publishable live key', join('pk', '_', 'live', '_', alnum(24))],
  ['publishable test key', join('pk', '_', 'test', '_', alnum(24))],
  ['public key PEM header', pem('PUBLIC KEY')],
  ['certificate PEM header', pem('CERTIFICATE')],
] as const satisfies readonly (readonly [string, string])[];

const NEWLINES = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
] as const satisfies readonly (readonly [string, string])[];

/** The six ids AAP 0.12.2 names, the whole set of shapes the gate enforces. */
const EXPECTED_PATTERN_IDS = [
  'stripe_secret_key',
  'stripe_webhook_secret',
  'openai_key',
  'twilio_auth_token',
  'twilio_api_key_sid',
  'pem_private_key',
];

describe('scanText', () => {
  describe('credential shapes', () => {
    it.each(CAUGHT)('%s', (_label, patternId, text, _value, column) => {
      expect(scanText(PATH, text)).toEqual([{ path: PATH, line: 1, column, patternId }]);
    });
  });

  describe('near misses', () => {
    it.each(MISSED)('%s', (_label, text) => {
      expect(scanText(PATH, text)).toEqual([]);
    });
  });

  it.each(NEWLINES)('reports line 3, column 7 with %s line endings', (_label, newline) => {
    // `KEY = ` ends in a space, which the look-behind needs: an alphanumeric there would read as the tail
    // of a longer word and hide the key.
    const text = join('# a comment', newline, 'host=example.test', newline, 'KEY = ', K_LIVE);

    expect(scanText(PATH, text)).toEqual([
      { path: PATH, line: 3, column: 7, patternId: 'stripe_secret_key' },
    ]);
  });

  it('sorts two findings on one line by column', () => {
    expect(scanText(PATH, join(W32, ' ', K_LIVE))).toEqual([
      { path: PATH, line: 1, column: 1, patternId: 'stripe_webhook_secret' },
      { path: PATH, line: 1, column: 40, patternId: 'stripe_secret_key' },
    ]);
  });

  it('reports every pattern one text matches', () => {
    const text = join(K_LIVE, '\n', PEM_RSA, '\n', W32);

    expect(scanText(PATH, text).map((finding) => finding.patternId)).toEqual([
      'stripe_secret_key',
      'pem_private_key',
      'stripe_webhook_secret',
    ]);
  });

  it('carries the path it was handed', () => {
    expect(scanText('apps/api/.env.example', K_LIVE).map((finding) => finding.path)).toEqual([
      'apps/api/.env.example',
    ]);
  });

  it('prints no part of the value it found', () => {
    for (const [label, , text, value] of CAUGHT) {
      const findings = scanText(PATH, text);
      const report = join(JSON.stringify(findings), '\n', findings.map(formatFinding).join('\n'));

      expect(report, label).not.toContain(value);
      for (let start = 0; start + WINDOW <= value.length; start += 1) {
        expect(report, `${label} at ${start}`).not.toContain(value.slice(start, start + WINDOW));
      }
    }
  });
});

describe('formatFinding', () => {
  it('renders the path, position and pattern id, and nothing else', () => {
    const finding = { path: 'config/tablemate.env', line: 12, column: 7, patternId: 'openai_key' };

    expect(formatFinding(finding)).toBe('config/tablemate.env:12:7  openai_key');
  });
});

describe('isProbablyBinary', () => {
  it.each([
    ['NUL as the second byte', join('a', '\0', 'b')],
    ['NUL as the last sniffed byte', join('a'.repeat(7_999), '\0', 'a'.repeat(100))],
  ])('is true for %s', (_label, text) => {
    expect(isProbablyBinary(new TextEncoder().encode(text))).toBe(true);
  });

  it('is false past the sniffed prefix, which the scan reads as text either way', () => {
    const bytes = new Uint8Array(8_100).fill(0x61);
    bytes[8_000] = 0;

    expect(isProbablyBinary(bytes)).toBe(false);
  });

  it.each([
    ['plain text', 'tablemate'],
    ['Thai text', 'สวัสดีครับ'],
    ['emoji', '🙏'],
    ['nothing at all', ''],
  ])('is false for %s', (_label, text) => {
    expect(isProbablyBinary(new TextEncoder().encode(text))).toBe(false);
  });
});

describe('SECRET_PATTERNS', () => {
  it('holds exactly the six shapes the gate enforces', () => {
    expect(SECRET_PATTERNS.map((pattern) => pattern.id).sort()).toEqual(
      [...EXPECTED_PATTERN_IDS].sort(),
    );
  });

  it('marks every pattern global, which scanText needs to walk all matches', () => {
    for (const { id, regex } of SECRET_PATTERNS) {
      expect(regex.global, id).toBe(true);
    }
  });
});

describe('this suite', () => {
  it('holds no credential shape, in itself or in the scan it covers', async () => {
    for (const name of ['check-secrets.ts', 'check-secrets.test.ts']) {
      const source = fileURLToPath(new URL(name, import.meta.url));

      expect(scanText(source, await readFile(source, 'utf8')), name).toEqual([]);
    }
  });
});
