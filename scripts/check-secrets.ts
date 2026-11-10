/**
 * `pnpm lint` step — the repository secret scan (AAP 0.8.1, 0.12.2).
 *
 * Fails the gate when a file of the working tree holds a complete credential shape (the six of
 * {@link SECRET_PATTERNS}). A bare prefix (`sk_test_`, `whsec_`, `sk-`), a placeholder (`<STRIPE_SECRET_KEY>`,
 * `sk_test_replace_me`) and public material (a `pk_` key, a certificate, a SHA-256 digest) are not secrets and
 * pass on purpose. No finding, and no line of output, carries any part of the matched text: a scan that copied the
 * secret it found into a CI log would be worse than no scan. Exit codes: 0 clean, 1 on findings or an operational
 * failure such as git being unavailable.
 */
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export interface SecretPattern {
  readonly id: string;
  readonly description: string;
  readonly regex: RegExp;
}

// The PEM header is assembled from fragments, because a literal header written into this file would be a
// finding the moment the scan read it.
const DASHES = '-'.repeat(5);
const PEM_PRIVATE_KEY_WORDS = '(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?';

/** The credential shapes the scan rejects (AAP 0.12.2); each matches a whole value, never a prefix. */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'stripe_secret_key',
    description: 'Stripe secret or restricted key: sk_/rk_, live/test, then 24+ alphanumerics',
    // A negative look-behind rather than `\b`, so a key preceded by `_` (`FOO_sk_live_...`) is caught too.
    regex: /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}/g,
  },
  {
    id: 'stripe_webhook_secret',
    description: 'Stripe webhook signing secret: whsec_ then 32+ alphanumerics',
    regex: /(?<![A-Za-z0-9])whsec_[A-Za-z0-9]{32,}/g,
  },
  {
    id: 'openai_key',
    description: 'OpenAI-style API key: sk- then 40+ key characters',
    regex: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{40,}/g,
  },
  {
    id: 'twilio_auth_token',
    description: 'Twilio auth token assigned to TWILIO_AUTH_TOKEN: exactly 32 hex characters',
    // The assigned form alone keeps a bare 32-hex digest out, and the exact length keeps a 64-hex one out.
    regex: /TWILIO_AUTH_TOKEN["']?\s*[:=]\s*["']?[0-9A-Fa-f]{32}(?![0-9A-Za-z])/g,
  },
  {
    id: 'twilio_api_key_sid',
    description: 'Twilio API key SID: SK then exactly 32 hex characters',
    regex: /(?<![A-Za-z0-9])SK[0-9A-Fa-f]{32}(?![0-9A-Za-z])/g,
  },
  {
    id: 'pem_private_key',
    description: 'PEM private-key header (RSA, EC, DSA, OpenSSH or encrypted)',
    regex: new RegExp(`${DASHES}BEGIN ${PEM_PRIVATE_KEY_WORDS}PRIVATE KEY${DASHES}`, 'g'),
  },
];

export interface SecretFinding {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly patternId: string;
}

export interface SecretScanReport {
  readonly files: number;
  readonly skipped: number;
  readonly findings: SecretFinding[];
}

const BINARY_SNIFF_BYTES = 8_000;

const READ_CONCURRENCY = 32;

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const REMEDIATION =
  'check-secrets: move each value above into an environment variable and keep only a placeholder in .env.example.';

/** Scans one text for every credential shape: pure, with no I/O and no global state, sorted by line and then
 * column so one file's report reads top to bottom whatever order the patterns ran in. */
export function scanText(filePath: string, text: string): SecretFinding[] {
  const lineStarts = [0];
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === '\n') {
      lineStarts.push(offset + 1);
    }
  }

  const findings: SecretFinding[] = [];
  for (const { id, regex } of SECRET_PATTERNS) {
    // The patterns are module state shared by every call and carry the `g` flag, so reset the cursor first.
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const offset = match.index ?? 0;
      const line = lineIndexAt(lineStarts, offset);
      findings.push({
        path: filePath,
        line: line + 1,
        column: offset - (lineStarts[line] ?? 0) + 1,
        patternId: id,
      });
    }
  }

  return findings.sort((left, right) => left.line - right.line || left.column - right.column);
}

function lineIndexAt(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

export function isProbablyBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

export function formatFinding(finding: SecretFinding): string {
  return `${finding.path}:${finding.line}:${finding.column}  ${finding.patternId}`;
}

/** The repository root `git` reports for the current working directory, or an error when `git` is unavailable. */
export async function repoRoot(): Promise<string> {
  return repositoryRootOf(process.cwd());
}

/** The repository root holding `cwd`. Listing and reading start here rather than at `cwd`, because
 * `git ls-files --full-name` names every path from the root, so a subdirectory scan covers the repository. */
async function repositoryRootOf(cwd: string): Promise<string> {
  const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
  if (root.length === 0) {
    throw new Error('git rev-parse --show-toplevel printed no path');
  }
  return root;
}

/** Every file a scan must consider: the tracked files plus the untracked files that are not ignored,
 * deduplicated and sorted so a report reads the same twice. Untracked files are included so the gate catches a
 * secret before it is committed; `.gitignore` excludes the rest itself. */
export async function listCandidateFiles(cwd?: string): Promise<string[]> {
  const listing = await git(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name'],
    await repositoryRootOf(cwd ?? process.cwd()),
  );

  return [...new Set(listing.split('\0').filter((entry) => entry.length > 0))].sort();
}

/** Scans the repository's working tree (AAP 0.12.2). Each path is `lstat`ed before it is read, so a symlink, a
 * directory or a path the working tree no longer holds is skipped rather than followed or failed on, and binary
 * content is skipped. Files are read {@link READ_CONCURRENCY} at a time. */
export async function scanRepository(cwd?: string): Promise<SecretScanReport> {
  const root = await repositoryRootOf(cwd ?? process.cwd());
  const candidates = await listCandidateFiles(root);

  let files = 0;
  let skipped = 0;
  const findings: SecretFinding[] = [];

  for (let start = 0; start < candidates.length; start += READ_CONCURRENCY) {
    const batch = candidates.slice(start, start + READ_CONCURRENCY);
    const scanned = await Promise.all(batch.map((filePath) => scanFile(root, filePath)));
    for (const result of scanned) {
      if (result.scanned) {
        files += 1;
      } else {
        skipped += 1;
      }
      findings.push(...result.findings);
    }
  }

  return { files, skipped, findings };
}

interface FileScan {
  readonly scanned: boolean;
  readonly findings: SecretFinding[];
}

/** One file's scan. A read failure other than a missing path propagates, so a permission problem cannot quietly
 * shrink the scan. */
async function scanFile(root: string, filePath: string): Promise<FileScan> {
  const absolute = path.join(root, filePath);
  let bytes: Uint8Array;

  try {
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      return { scanned: false, findings: [] };
    }
    bytes = await readFile(absolute);
  } catch (error) {
    if (isMissing(error)) {
      return { scanned: false, findings: [] };
    }
    throw error;
  }

  if (isProbablyBinary(bytes)) {
    return { scanned: false, findings: [] };
  }

  return { scanned: true, findings: scanText(filePath, TEXT_DECODER.decode(bytes)) };
}

/** Runs the scan and reports it: a clean run prints one summary line to stdout, a run with findings prints one
 * {@link formatFinding} line per finding and the closing instruction to stderr. */
export async function main(): Promise<number> {
  let report: SecretScanReport;
  try {
    report = await scanRepository();
  } catch (error) {
    process.stderr.write(`check-secrets: ${messageOf(error)}\n`);
    process.exitCode = 1;
    return 1;
  }

  if (report.findings.length === 0) {
    process.stdout.write(`check-secrets: scanned ${report.files} files, 0 findings\n`);
    process.exitCode = 0;
    return 0;
  }

  process.stderr.write(
    [
      `check-secrets: ${report.findings.length} findings in ${report.files} scanned files`,
      ...report.findings.map(formatFinding),
      REMEDIATION,
    ].join('\n') + '\n',
  );
  process.exitCode = 1;
  return 1;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    throw new Error(`git ${args[0] ?? ''} failed: ${messageOf(error)}`);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const execFileAsync = promisify(execFile);
const TEXT_DECODER = new TextDecoder('utf-8');

// Importing this module — from a test, a tool, an editor — must scan nothing and set no exit code.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
