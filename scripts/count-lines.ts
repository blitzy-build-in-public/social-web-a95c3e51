/**
 * `pnpm loc` — the delivered-code ceiling check (AAP 0.7.1, 0.8.1, 0.12.2).
 *
 * Counts the physical lines — blank and comment lines included — of every text file the run
 * delivers, sums them per area of the AAP 0.8.1 budget table and reports each area against its
 * budget. The check fails on a total at or above {@link LINE_CEILING}, on an area over its budget by
 * more than the 10% allowance other areas' unused budget must cover, and on a counted file that
 * belongs to no area.
 *
 * The file set is the working tree — tracked files plus untracked files that are not git-ignored —
 * so a count taken at a phase exit includes work not yet committed. `--json` prints the report as
 * JSON; `--write` records it in the `loc` block of `docs/acceptance.md` (AAP 0.12.2). Exit codes: 0
 * the check passes, 1 it fails, 2 a usage error.
 */
import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Files the rule excludes by name (AAP 0.7.1): the two tool-written lockfiles and the emitted OpenAPI document. */
export const EXCLUDED_FILES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'apps/mobile/modules/tablemate-prover/rust/Cargo.lock',
  'docs/api/openapi.json',
]);

/** Extensions the rule excludes (AAP 0.7.1): the binary menu fixtures. Only these three, compared case-insensitively, so a text file with any other extension is still counted. */
export const EXCLUDED_EXTENSIONS: ReadonlySet<string> = new Set(['.pdf', '.png', '.jpg']);

/** The ceiling on delivered code (AAP 0.7.1); the total must stay strictly below it. */
export const LINE_CEILING = 100_000;

/** The sum of the {@link AREAS} budgets (AAP 0.8.1), asserted below so a budget edit cannot drift. */
export const TOTAL_BUDGET = 83_300;

/** The share of its budget an area may run over (AAP 0.8.1). */
const OVERRUN_SHARE = 0.1;

const BINARY_SNIFF_BYTES = 8_000;

const LINE_FEED = 0x0a;

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const RIGHT_ALIGNED: ReadonlySet<number> = new Set([1, 2, 3]);

/**
 * The lines of a file's bytes: every line feed, plus the last line when the file does not end in
 * one. An empty file has none. Bytes rather than characters, so a CRLF file counts as `wc -l` counts
 * it.
 */
export function countPhysicalLines(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) {
    return 0;
  }

  let lines = 0;
  for (const byte of bytes) {
    if (byte === LINE_FEED) {
      lines += 1;
    }
  }

  return bytes[bytes.byteLength - 1] === LINE_FEED ? lines : lines + 1;
}

/** The area a counted file belongs to, one per row of the AAP 0.8.1 budget table. */
export type AreaId =
  | 'mobile-prover'
  | 'mobile-app'
  | 'mobile-tests'
  | 'mobile-config-src'
  | 'api-tests'
  | 'api-src'
  | 'workers-tests'
  | 'workers-src'
  | 'venue-console'
  | 'shared'
  | 'db'
  | 'server-core'
  | 'circuits'
  | 'system-tests'
  | 'config'
  | 'docs'
  | 'root';

/**
 * How an area stands against its budget (AAP 0.8.1): `ok` within budget; `over` above it by no more
 * than its 10% allowance, which another area's unused budget may cover; `over_limit` above that
 * allowance, which has to be cut back before the phase ends.
 */
export type AreaStatus = 'ok' | 'over' | 'over_limit';

/** One area of the AAP 0.8.1 budget table. */
export interface Area {
  readonly id: AreaId;
  readonly label: string;
  readonly budget: number;
  readonly matches: (filePath: string) => boolean;
}

function underAny(...directories: readonly string[]): (filePath: string) => boolean {
  return (filePath) => directories.some((directory) => filePath.startsWith(`${directory}/`));
}

// Every area but the last is the files under its directories, with the rows in the AAP 0.8.1 order.
// The order is load-bearing: `classify` takes the first match, which is what keeps the narrower
// rules (`apps/mobile/app/**`) ahead of the broader ones (all of `apps/mobile/`).
const AREA_TABLE: readonly (readonly [AreaId, number, string, readonly string[]])[] = [
  ['mobile-prover', 1_200, 'prover module', ['apps/mobile/modules/tablemate-prover']],
  ['mobile-app', 9_000, 'app screens', ['apps/mobile/app']],
  ['mobile-tests', 2_500, 'tests and e2e', ['apps/mobile/test', 'apps/mobile/e2e']],
  ['mobile-config-src', 5_000, 'configuration and src', ['apps/mobile']],
  ['api-tests', 15_000, 'tests', ['apps/api/test']],
  ['api-src', 16_000, 'source and scripts', ['apps/api']],
  ['workers-tests', 5_500, 'tests, fixtures, eval', ['apps/workers/test', 'apps/workers/eval']],
  ['workers-src', 5_500, 'source', ['apps/workers']],
  ['venue-console', 900, 'console app', ['apps/venue-console']],
  ['shared', 4_000, 'contracts and constants', ['packages/shared']],
  ['db', 2_800, 'schema, migrations and seed', ['packages/db']],
  ['server-core', 2_500, 'server utilities', ['packages/server-core']],
  ['circuits', 5_500, 'circuits and registry', ['packages/circuits']],
  ['system-tests', 1_800, 'system tests', ['tests']],
  ['config', 1_000, 'cities, fixtures, registries', ['config']],
  ['docs', 3_000, 'documents and results', ['docs']],
];

/**
 * The areas and budgets of the AAP 0.8.1 table.
 *
 * The last row is root tooling in full: the files sitting at the repository root itself, which carry
 * no `/`, the build and check scripts, the compose and nginx infrastructure, and the pnpm patches
 * `pnpm-workspace.yaml` pins, which share that budget rather than forming an area of their own.
 */
export const AREAS: readonly Area[] = [
  ...AREA_TABLE.map(([id, budget, label, directories]) => ({
    id,
    label,
    budget,
    matches: underAny(...directories),
  })),
  {
    id: 'root',
    label: 'root files, scripts/, infra/, patches/',
    budget: 2_100,
    matches: (filePath) =>
      !filePath.includes('/') || underAny('scripts', 'infra', 'patches')(filePath),
  },
];

// Editing one budget without the total is how the ceiling a check enforces quietly moves, so the
// arithmetic is asserted where the table is read rather than trusted.
const BUDGET_TOTAL = AREAS.reduce((sum, area) => sum + area.budget, 0);
if (BUDGET_TOTAL !== TOTAL_BUDGET) {
  throw new Error(`area budgets total ${BUDGET_TOTAL} lines, expected ${TOTAL_BUDGET}`);
}

/**
 * The area a counted file belongs to.
 */
export function classify(filePath: string): AreaId | null {
  for (const area of AREAS) {
    if (area.matches(filePath)) {
      return area.id;
    }
  }
  return null;
}

interface ScanResult {
  readonly counts: Map<AreaId, number>;
  readonly unassigned: readonly string[];
  readonly excluded: number;
  /** Files dropped because a NUL byte in their opening bytes proves they are not text. */
  readonly skippedBinary: number;
}

export interface ScanTotals {
  readonly excluded: number;
  /** Files skipped because they are not text. */
  readonly skippedBinary: number;
}

/** One area's lines against its budget (AAP 0.8.1). */
export interface AreaResult {
  readonly id: AreaId;
  readonly label: string;
  readonly lines: number;
  readonly budget: number;
  readonly delta: number;
  readonly overrun: number;
  readonly allowance: number;
  readonly status: AreaStatus;
}

export interface Report {
  readonly areas: readonly AreaResult[];
  readonly total: number;
  readonly totalBudget: number;
  readonly ceiling: number;
  readonly skippedBinary: number;
  readonly excluded: number;
  readonly unassigned: readonly string[];
  /** Empty when the check passes; `pnpm loc` exits 1 whenever it is not. */
  readonly failures: readonly string[];
}

/** Runs `git` with an argument vector and no shell (AAP 0.7.1) and returns its stdout. */
function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(messageOf(error)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * The bytes of a counted file, or `null` when the path holds nothing to count.
 *
 * A path that is not a regular file is skipped rather than followed, so a symlink cannot make the
 * count depend on something outside the repository, and a tracked file deleted from the working tree
 * is skipped because it has no lines of its own. Every other read failure propagates, so a
 * permission problem cannot quietly shrink the count.
 */
async function readCountedFile(repoRoot: string, filePath: string): Promise<Uint8Array | null> {
  const absolute = path.join(repoRoot, filePath);

  try {
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      return null;
    }
    return await readFile(absolute);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Counts the working tree: the lines of every text file the run delivers, per area (AAP 0.7.1).
 *
 * The file set is `git ls-files --cached --others --exclude-standard` at the repository root.
 * Tracked files are what the run commits; untracked files that are not git-ignored are counted too,
 * so a count taken mid-phase sees work not yet committed. Git-ignored outputs — circuit artefacts,
 * `.local/`, `node_modules`, `dist`, the native build directories, samples — need no rule of their
 * own, because `.gitignore` already excludes them.
 */
async function scan(repoRoot: string): Promise<ScanResult> {
  const listing = await git(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name'],
    repoRoot,
  );
  const paths = [...new Set(listing.split('\0').filter((entry) => entry.length > 0))].sort();

  const counts = new Map<AreaId, number>();
  const unassigned: string[] = [];
  let excluded = 0;
  let skippedBinary = 0;

  for (const filePath of paths) {
    const extension = path.extname(filePath).toLowerCase();
    if (EXCLUDED_FILES.has(filePath) || EXCLUDED_EXTENSIONS.has(extension)) {
      excluded += 1;
      continue;
    }

    const bytes = await readCountedFile(repoRoot, filePath);
    if (bytes === null) {
      continue;
    }
    if (looksBinary(bytes)) {
      skippedBinary += 1;
      continue;
    }

    const area = classify(filePath);
    if (area === null) {
      unassigned.push(filePath);
      continue;
    }
    counts.set(area, (counts.get(area) ?? 0) + countPhysicalLines(bytes));
  }

  return { counts, unassigned, excluded, skippedBinary };
}

/**
 * Judges the counts against the budgets (AAP 0.8.1).
 *
 * An area within its budget is `ok`. One over by no more than 10% of its budget is `over`, which is
 * allowed only while the areas together stay within {@link TOTAL_BUDGET}, since an area may be over
 * "only when another area gives up the same number of lines". One over by more than its allowance
 * has to be cut back and is `over_limit`. The total at or above {@link LINE_CEILING} fails on its
 * own, and so does a counted file in no area: its lines would sit outside every budget and bypass
 * the ceiling the check exists to enforce.
 */
export function evaluate(
  counts: Map<AreaId, number>,
  unassigned: readonly string[],
  scan: ScanTotals = { excluded: 0, skippedBinary: 0 },
): Report {
  const areas: AreaResult[] = AREAS.map((area) => {
    const lines = counts.get(area.id) ?? 0;
    const delta = lines - area.budget;
    const overrun = Math.max(0, delta);
    const allowance = Math.floor(area.budget * OVERRUN_SHARE);
    const status: AreaStatus = overrun === 0 ? 'ok' : overrun <= allowance ? 'over' : 'over_limit';

    return {
      id: area.id,
      label: area.label,
      lines,
      budget: area.budget,
      delta,
      overrun,
      allowance,
      status,
    };
  });

  const total = areas.reduce((sum, area) => sum + area.lines, 0);
  const overs = areas.filter((area) => area.overrun > 0);
  const overrunLines = overs.reduce((sum, area) => sum + area.overrun, 0);
  const unusedLines = areas.reduce((sum, area) => sum + Math.max(0, -area.delta), 0);
  const shortfall = Math.max(0, overrunLines - unusedLines);

  const failures: string[] = [];
  for (const area of areas) {
    if (area.status === 'over_limit') {
      failures.push(
        `over_limit: ${area.id} is ${area.lines} lines, ${area.overrun} over its ${area.budget} budget; the 10% allowance is ${area.allowance}`,
      );
    }
  }
  if (shortfall > 0) {
    const named = overs.map((area) => `${area.id} (+${area.overrun})`).join(', ');
    failures.push(
      `uncompensated_overrun: ${named} need ${overrunLines} lines given up by other areas, which give up ${unusedLines} (short by ${shortfall})`,
    );
  }
  if (total >= LINE_CEILING) {
    failures.push(`ceiling: ${total} lines is at or above the ${LINE_CEILING}-line ceiling`);
  }
  for (const filePath of unassigned) {
    failures.push(`unassigned: ${filePath} belongs to no area, so its lines bypass the ceiling`);
  }

  return {
    areas,
    total,
    totalBudget: TOTAL_BUDGET,
    ceiling: LINE_CEILING,
    skippedBinary: scan.skippedBinary,
    excluded: scan.excluded,
    unassigned: [...unassigned],
    failures,
  };
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatDelta(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function columnWidths(header: readonly string[], rows: readonly (readonly string[])[]): number[] {
  return header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
}

function padCells(cells: readonly string[], widths: readonly number[]): string[] {
  return widths.map((width, column) => {
    const cell = cells[column] ?? '';
    return RIGHT_ALIGNED.has(column) ? cell.padStart(width, ' ') : cell.padEnd(width, ' ');
  });
}

function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = columnWidths(header, rows);
  const line = (cells: readonly string[]): string => padCells(cells, widths).join('  ').trimEnd();

  return [line(header), ...rows.map((row) => line(row))].join('\n');
}

function renderMarkdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = columnWidths(header, rows);
  const line = (cells: readonly string[]): string => `| ${padCells(cells, widths).join(' | ')} |`;
  const divider = `| ${widths
    .map((width, column) =>
      RIGHT_ALIGNED.has(column) ? `${'-'.repeat(width - 1)}:` : '-'.repeat(width),
    )
    .join(' | ')} |`;

  return [line(header), divider, ...rows.map((row) => line(row))].join('\n');
}

function render(report: Report): string {
  const rows = report.areas.map((area) => [
    area.id,
    formatNumber(area.lines),
    formatNumber(area.budget),
    formatDelta(area.delta),
    area.status,
  ]);

  return [
    renderTable(['area', 'lines', 'budget', 'delta', 'status'], rows),
    `total ${formatNumber(report.total)} / ${formatNumber(report.totalBudget)} budget / ${formatNumber(report.ceiling)} ceiling`,
    `excluded by name or extension: ${formatNumber(report.excluded)}`,
    `skipped as non-text: ${formatNumber(report.skippedBinary)}`,
    ...report.failures,
  ].join('\n');
}

/** The document holding the recorded counts (AAP 0.12.2). */
const DOC_PATH = 'docs/acceptance.md';

const DOC_BEGIN = '<!-- BEGIN loc -->';
const DOC_END = '<!-- END loc -->';

function renderDocBlock(report: Report, date: string, commit: string): string {
  const rows = report.areas.map((area) => [
    area.label,
    formatNumber(area.lines),
    formatNumber(area.budget),
    formatDelta(area.delta),
    area.status,
  ]);
  rows.push([
    '**Total**',
    formatNumber(report.total),
    formatNumber(report.totalBudget),
    formatDelta(report.total - report.totalBudget),
    report.failures.length === 0 ? 'ok' : 'failing',
  ]);

  return [
    DOC_BEGIN,
    '',
    renderMarkdownTable(['Area', 'Lines', 'Budget', 'Delta', 'Status'], rows),
    '',
    `Total ${formatNumber(report.total)} / ${formatNumber(report.totalBudget)} budget / ${formatNumber(report.ceiling)} ceiling.`,
    `Run ${date} at commit ${commit}.`,
    DOC_END,
  ].join('\n');
}

function replaceBlock(document: string, block: string): string {
  const begin = document.indexOf(DOC_BEGIN);
  const end = document.indexOf(DOC_END);
  if (begin === -1 || end < begin) {
    const separator =
      document === '' || document.endsWith('\n\n') ? '' : document.endsWith('\n') ? '\n' : '\n\n';
    return `${document}${separator}${block}\n`;
  }

  return `${document.slice(0, begin)}${block}${document.slice(end + DOC_END.length)}`;
}

async function writeDocBlock(repoRoot: string, block: string): Promise<boolean> {
  const absolute = path.join(repoRoot, DOC_PATH);

  let existing: string | null = null;
  try {
    existing = await readFile(absolute, 'utf8');
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }

  const next = existing === null ? `${block}\n` : replaceBlock(existing, block);
  if (next === existing) {
    return false;
  }

  await writeFile(absolute, next, 'utf8');
  return true;
}

function parseOptions(argv: readonly string[]): { json: boolean; write: boolean } {
  let json = false;
  let write = false;

  for (const argument of argv) {
    switch (argument) {
      case '--json':
        json = true;
        break;
      case '--write':
        write = true;
        break;
      case '--':
        // pnpm forwards the separator of its own `pnpm loc -- --write` form to the script, so a bare
        // `--` is dropped instead of rejected: that documented invocation has to reach the flags
        // that follow it.
        break;
      default:
        throw new Error(`unknown argument "${argument}"`);
    }
  }

  return { json, write };
}

/**
 * Runs the check.
 */
async function main(argv: readonly string[]): Promise<number> {
  let options: { json: boolean; write: boolean };
  try {
    options = parseOptions(argv);
  } catch (error) {
    process.stderr.write(`loc: ${messageOf(error)}\nusage: pnpm loc [--json] [--write]\n`);
    return 2;
  }

  try {
    const repoRoot = (await git(['rev-parse', '--show-toplevel'], process.cwd())).trim();
    const { counts, unassigned, excluded, skippedBinary } = await scan(repoRoot);
    const report = evaluate(counts, unassigned, { excluded, skippedBinary });

    let written = false;
    if (options.write) {
      const commit = (await git(['rev-parse', '--short', 'HEAD'], repoRoot)).trim();
      const dirty = (await git(['status', '--porcelain'], repoRoot)).trim() !== '';
      const date = new Date().toISOString().slice(0, 10);
      written = await writeDocBlock(
        repoRoot,
        renderDocBlock(report, date, dirty ? `${commit}-dirty` : commit),
      );
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${render(report)}\n`);
      if (written) {
        process.stdout.write(`updated ${DOC_PATH}\n`);
      }
    }

    return report.failures.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`loc: ${messageOf(error)}\n`);
    return 1;
  }
}

// An import of this module — by a test, a tool, an editor — must not run the check; only the direct
// run does, which is the only way the flags of the command line reach it.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
