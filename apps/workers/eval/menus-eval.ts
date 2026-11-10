/** Criterion 11 menu-extraction evaluation: the labeled fixture set read end to end through the real menu pipeline (AAP 0.8.1, 0.11.2, 0.12.1). */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { z } from 'zod';

import { CurrencyCode, ItemCategory } from '@tablemate/shared';
import {
  createLlmAdapter,
  createLlmSpend,
  createLogger,
  isSupportedModel,
  parseUsdPerMTok,
  systemClock,
} from '@tablemate/server-core';
import type {
  LlmAdapter,
  LlmPrices,
  LlmReservation,
  LlmSpend,
  Logger,
  SpendStore,
  SuspensionStore,
} from '@tablemate/server-core';

import { findRepoRoot, loadBlocklist } from '../src/menus/blocklist.ts';
import { createDomainPolicy } from '../src/menus/crawl-policy.ts';
import type { CrawlPolicyStore } from '../src/menus/crawl-policy.ts';
import { extractMenuItems } from '../src/menus/extract-items.ts';
import { createBrowserProvider, renderPage } from '../src/menus/fetch-page.ts';
import type { BrowserProvider } from '../src/menus/fetch-page.ts';
import { OcrError, ocrImage } from '../src/menus/ocr.ts';
import type { OcrLanguage } from '../src/menus/ocr.ts';
import {
  PDF_MAX_PAGES,
  PdfTextError,
  extractPdfText,
  rasterizePdf,
} from '../src/menus/pdf-text.ts';
import { parsePrice } from '../src/menus/price-parse.ts';
import { crawlerUserAgent, createMemoryRobotsCache } from '../src/menus/robots.ts';
import { SafeFetchError, createFetchBudget, createSafeFetch } from '../src/menus/safe-fetch.ts';
import type { SafeFetch } from '../src/menus/safe-fetch.ts';
import { gateItems, normalizeWhitespace } from '../src/menus/source-gate.ts';
import type { GatedMenuItem } from '../src/menus/source-gate.ts';
// Imported for `normalizeItemName` alone — the label key the pipeline stores as `PriceRecord.normalizedName`. That module value-imports `@tablemate/db`, so the Prisma client must be generated before this file loads; nothing here opens a database connection.
import { normalizeItemName } from '../src/jobs/menu-ingest.ts';

const REPO_ROOT = findRepoRoot();
const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const MENUS_DIR = join(EVAL_DIR, 'fixtures', 'menus');
const MANIFEST_FILE = join(MENUS_DIR, 'manifest.json');
const DOC_FILE = join(REPO_ROOT, 'docs', 'menu-extraction.md');
/** The document's generated-block markers and the status line it must always keep (AAP 0.12.3). */
const STATUS_LINE = 'Unverified — fixture set only';
const BEGIN_MARKER = '<!-- BEGIN menus-eval -->';
const END_MARKER = '<!-- END menus-eval -->';
const RESULT_MARKER = '<!-- menus-eval:result -->';
const PENDING_MARKER = '<!-- menus-eval:pending -->';
const DOC_HEADING = '# Menu extraction';
const FIXTURE_HOST = '127.0.0.1';
const FIXTURE_CONTACT_URL = 'http://127.0.0.1/menus-eval';
const LANGUAGES = ['en', 'pt', 'es', 'th', 'id'] as const;
const FORMATS = ['html', 'pdf', 'image'] as const;
const OCR_LANGUAGES = ['eng', 'por', 'spa', 'tha', 'ind'] as const satisfies readonly OcrLanguage[];
const EXPECTED_MENUS = 20;
const EXPECTED_PER_LANGUAGE = 4;
const EXPECTED_PER_FORMAT: Readonly<Record<(typeof FORMATS)[number], number>> = {
  html: 6,
  pdf: 7,
  image: 7,
};
/** The one PDF without a text layer, and the format each extension must be declared as. */
const SCANNED_PDF = 'id/id-03-scanned.pdf';
const FORMAT_BY_EXTENSION: Readonly<Record<string, (typeof FORMATS)[number] | undefined>> = {
  '.html': 'html',
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
};
/** The only shape a manifest entry's `file` may take, built from {@link LANGUAGES} and {@link FORMAT_BY_EXTENSION} so that those two stay the single list of languages and extensions: one language directory, one `/`, a name of `[a-z0-9]` groups joined by single `-`, and one known extension. This is the invariant that makes the three `join(MENUS_DIR, menu.file)` call sites safe — the value carries no `..` segment and no second separator, so it cannot name a file outside the labeled set — and every other shape is rejected as the manifest loads, before any of them. */
const MENU_FILE_PATTERN = new RegExp(
  `^(?:${LANGUAGES.join('|')})/[a-z0-9]+(?:-[a-z0-9]+)*(?:${Object.keys(FORMAT_BY_EXTENSION)
    .map((extension) => extension.replaceAll('.', '\\.'))
    .join('|')})$`,
);
const CITY_ID = 'eval';
const DEFAULT_CAP_USD = 25;
const EVALUATED_PROVIDER = 'openai';
const MATCHED_THRESHOLD = 0.9;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);
/** One expected priced item: the label the extraction is scored against. `normalizedName` is `normalizeItemName(name)` and `amountMinor` is `parsePrice(priceText, currency)`, both checked below, so no label can be written that the pipeline's own rules could never produce. */
const ManifestItem = z.strictObject({
  name: z.string().min(1),
  normalizedName: z.string().min(1),
  priceText: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: CurrencyCode,
  category: ItemCategory,
});
type ManifestItem = z.infer<typeof ManifestItem>;
const ManifestMenu = z.strictObject({
  file: z
    .string()
    .regex(
      MENU_FILE_PATTERN,
      `file must be <language>/<name>.<ext>, for example "en/en-01.html" — a directory from ${LANGUAGES.join(', ')}, a name of lowercase words joined by "-", and one of ${Object.keys(FORMAT_BY_EXTENSION).join(', ')}`,
    ),
  language: z.enum(LANGUAGES),
  format: z.enum(FORMATS),
  textLayer: z.boolean().optional(),
  currency: CurrencyCode,
  ocrLanguage: z.enum(OCR_LANGUAGES),
  items: z.array(ManifestItem).min(1),
});
type ManifestMenu = z.infer<typeof ManifestMenu>;
/** The manifest itself: versioned, so a shape change fails loudly instead of scoring wrongly. */
const Manifest = z.strictObject({ version: z.literal(1), menus: z.array(ManifestMenu) });
/** One label as the report names it: normalized name and exact price text, never menu text. */
interface LabelRef {
  readonly normalizedName: string;
  readonly priceText: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown';
}

/** The code a failure is recorded under, so the report says which stage rejected a menu without carrying any of its text: a fetch refusal's own reason, a PDF or OCR reason, a language-model error code, or the error's name for anything unexpected. */
function failureCode(error: unknown): string {
  if (error instanceof SafeFetchError) return `fetch_${error.reason}`;
  if (error instanceof PdfTextError) return `pdf_${error.reason}`;
  if (error instanceof OcrError) return `ocr_${error.reason}`;
  return errorCode(error);
}

/** Load the labeled set and check it against the shape criterion 11 is measured on (AAP 0.12.1). Every problem is collected and reported together, because a run that stopped at the first one would hide the rest of a broken fixture set. A message names a file, an item index and a field, never menu text. @returns The menus and every problem found; an empty `errors` means the set may be measured. */
function loadManifest(): { menus: ManifestMenu[]; errors: string[] } {
  let text: string;
  try {
    text = readFileSync(MANIFEST_FILE, 'utf8');
  } catch (error) {
    return { menus: [], errors: [`manifest could not be read: ${messageOf(error)}`] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return { menus: [], errors: [`manifest is not valid JSON: ${messageOf(error)}`] };
  }

  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const where = issue.path.map((segment) => String(segment)).join('.');
      return where === '' ? `manifest: ${issue.message}` : `manifest.${where}: ${issue.message}`;
    });
    return { menus: [], errors };
  }

  return { menus: parsed.data.menus, errors: checkManifest(parsed.data.menus) };
}

/** Every cross-record rule of the labeled set, collected rather than short-circuited. */
function checkManifest(menus: readonly ManifestMenu[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const perLanguage = new Map<string, number>();
  const perFormat = new Map<(typeof FORMATS)[number], number>();
  if (menus.length !== EXPECTED_MENUS) {
    errors.push(`expected ${EXPECTED_MENUS} menus, found ${menus.length}`);
  }

  for (const menu of menus) {
    if (seen.has(menu.file)) errors.push(`${menu.file}: the file is listed twice`);
    seen.add(menu.file);
    perLanguage.set(menu.language, (perLanguage.get(menu.language) ?? 0) + 1);
    perFormat.set(menu.format, (perFormat.get(menu.format) ?? 0) + 1);
    if (!menu.file.startsWith(`${menu.language}/${menu.language}-`)) {
      errors.push(`${menu.file}: the path must start with "${menu.language}/${menu.language}-"`);
    }
    if (FORMAT_BY_EXTENSION[extname(menu.file)] !== menu.format) {
      errors.push(`${menu.file}: the extension does not match the declared format`);
    }
    if (menu.format === 'pdf' && menu.textLayer === undefined) {
      errors.push(`${menu.file}: a PDF menu must declare textLayer`);
    }
    if (menu.format !== 'pdf' && menu.textLayer !== undefined) {
      errors.push(`${menu.file}: textLayer applies to PDF menus only`);
    }
    if (!existsSync(join(MENUS_DIR, menu.file))) {
      errors.push(`${menu.file}: the fixture file is missing`);
    }
    checkItems(menu, errors);
  }

  for (const language of LANGUAGES) {
    const count = perLanguage.get(language) ?? 0;
    if (count !== EXPECTED_PER_LANGUAGE) {
      errors.push(`language ${language}: expected ${EXPECTED_PER_LANGUAGE} menus, found ${count}`);
    }
  }
  for (const format of FORMATS) {
    const count = perFormat.get(format) ?? 0;
    if (count !== EXPECTED_PER_FORMAT[format]) {
      errors.push(
        `format ${format}: expected ${EXPECTED_PER_FORMAT[format]} menus, found ${count}`,
      );
    }
  }

  const scanned = menus.filter((menu) => menu.format === 'pdf' && menu.textLayer === false);
  if (scanned.length !== 1 || scanned[0]?.file !== SCANNED_PDF) {
    errors.push(`exactly one PDF must declare textLayer: false, and it must be ${SCANNED_PDF}`);
  }

  return errors;
}

function checkItems(menu: ManifestMenu, errors: string[]): void {
  const seen = new Set<string>();
  menu.items.forEach((item, index) => {
    const where = `${menu.file} item ${index + 1}`;
    if (item.normalizedName !== normalizeItemName(item.name)) {
      errors.push(`${where}: normalizedName is not normalizeItemName(name)`);
    }
    if (item.currency !== menu.currency) {
      errors.push(`${where}: the item currency is not the menu currency`);
    }
    if (parsePrice(item.priceText, item.currency) !== item.amountMinor) {
      errors.push(`${where}: priceText does not parse to amountMinor`);
    }
    const key = `${item.normalizedName}|${item.amountMinor}`;
    if (seen.has(key)) errors.push(`${where}: the label appears twice`);
    seen.add(key);
  });
}

function readEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

interface RunConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly prices: LlmPrices;
  readonly capMicros: number;
}

type Mode =
  | { readonly kind: 'pending' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'run'; readonly config: RunConfig };
/** Decide between a measured run, a pending run and a configuration error (AAP 0.5.6, 0.12.3). */
function resolveMode(): Mode {
  const provider = readEnv('LLM_PROVIDER');
  if (provider !== null && provider !== 'fake' && provider !== 'openai') {
    return {
      kind: 'error',
      message: 'LLM_PROVIDER must be "openai", or "fake" for a pending run.',
    };
  }
  if (provider === null || provider === 'fake') return { kind: 'pending' };
  const model = readEnv('LLM_MODEL');
  if (model !== null && !isSupportedModel(model)) {
    return { kind: 'error', message: 'LLM_MODEL is not one of the supported models.' };
  }

  const apiKey = readEnv('LLM_API_KEY');
  const inputUsdPerMTok = readEnv('LLM_PRICE_INPUT_USD_PER_MTOK');
  const outputUsdPerMTok = readEnv('LLM_PRICE_OUTPUT_USD_PER_MTOK');
  if (apiKey === null || model === null || inputUsdPerMTok === null || outputUsdPerMTok === null) {
    return { kind: 'pending' };
  }

  const priceVariables = [
    ['LLM_PRICE_INPUT_USD_PER_MTOK', inputUsdPerMTok],
    ['LLM_PRICE_OUTPUT_USD_PER_MTOK', outputUsdPerMTok],
  ] as const;
  for (const [name, value] of priceVariables) {
    try {
      parseUsdPerMTok(value);
    } catch {
      return { kind: 'error', message: `${name} is not a positive USD-per-million-tokens price.` };
    }
  }

  const capText = readEnv('CAP_LLM_USD_PER_CITY_DAY') ?? String(DEFAULT_CAP_USD);
  if (!/^[1-9][0-9]*$/u.test(capText)) {
    return {
      kind: 'error',
      message: 'CAP_LLM_USD_PER_CITY_DAY must be a positive whole number of USD.',
    };
  }
  const capMicros = Number(capText) * 1_000_000;
  if (!Number.isSafeInteger(capMicros) || capMicros <= 0) {
    return { kind: 'error', message: 'CAP_LLM_USD_PER_CITY_DAY is out of range.' };
  }

  return {
    kind: 'run',
    config: { apiKey, model, prices: { inputUsdPerMTok, outputUsdPerMTok }, capMicros },
  };
}

/** What the preflight found: the Tesseract banner line, and every reason the run cannot start. */
interface Preflight {
  readonly tesseract: string;
  readonly problems: readonly string[];
}

/** Check the tools the documents need before any menu is read: Tesseract with the five OCR languages of the labeled set, and `pdftoppm` for the one scanned PDF. Chromium is checked by launching it, which the run does next, because a browser that cannot start is the same class of failure. */
async function preflightTools(): Promise<Preflight> {
  const problems: string[] = [];
  let tesseract = 'unknown';
  try {
    const banner = await execFileAsync('tesseract', ['--version'], {
      timeout: PREFLIGHT_TIMEOUT_MS,
    });
    tesseract = (banner.stdout.split('\n')[0] ?? '').trim() || 'unknown';
  } catch (error) {
    problems.push(
      `tesseract is not runnable (${messageOf(error)}); install tesseract-ocr and the tessdata_best models.`,
    );
  }

  try {
    const langs = await execFileAsync('tesseract', ['--list-langs'], {
      timeout: PREFLIGHT_TIMEOUT_MS,
    });
    const available = new Set(langs.stdout.split('\n').map((line) => line.trim()));
    const missing = OCR_LANGUAGES.filter((language) => !available.has(language));
    if (missing.length > 0) {
      problems.push(
        `tesseract is missing the OCR languages ${missing.join(', ')}; install the tessdata_best 4.1.0 models and set TESSDATA_PREFIX.`,
      );
    }
  } catch (error) {
    problems.push(`tesseract --list-langs failed (${messageOf(error)}).`);
  }

  try {
    // `pdftoppm -v` prints its banner and exits 0, so a rejection here is a real failure.
    await execFileAsync('pdftoppm', ['-v'], { timeout: PREFLIGHT_TIMEOUT_MS });
  } catch (error) {
    problems.push(`pdftoppm is not runnable (${messageOf(error)}); install poppler-utils.`);
  }

  return { tesseract, problems };
}

/** The day counter `createLlmSpend` reserves against, held in memory: the SQL store's own predicate — `spent + reserved + micros <= capMicros` — over a map keyed by city and local day, so the whole evaluation needs no database and is bounded by one `CAP_LLM_USD_PER_CITY_DAY`. */
function createMemorySpendStore(): SpendStore & { spentMicros: () => number } {
  const days = new Map<string, { spent: number; reserved: number }>();
  const dayOf = (cityId: string, localDate: string): { spent: number; reserved: number } => {
    const key = `${cityId}|${localDate}`;
    const existing = days.get(key);
    if (existing !== undefined) return existing;
    const created = { spent: 0, reserved: 0 };
    days.set(key, created);
    return created;
  };
  return {
    tryReserve: ({ cityId, localDate, micros, capMicros }) => {
      const day = dayOf(cityId, localDate);
      if (day.spent + day.reserved + micros > capMicros) return Promise.resolve(false);
      day.reserved += micros;
      return Promise.resolve(true);
    },
    charge: (reservation: LlmReservation, chargedMicros: number) => {
      const day = dayOf(reservation.cityId, reservation.localDate);
      day.spent += chargedMicros;
      day.reserved = Math.max(0, day.reserved - Math.min(chargedMicros, reservation.micros));
      return Promise.resolve();
    },
    release: (reservation: LlmReservation, micros: number) => {
      const day = dayOf(reservation.cityId, reservation.localDate);
      day.reserved = Math.max(0, day.reserved - micros);
      return Promise.resolve();
    },
    spentMicros: () => [...days.values()].reduce((total, day) => total + day.spent, 0),
  };
}

/** The suspension flag, held in memory (AAP 0.5.6). A counted/reported mismatch suspends every city through this store; the run notes it, records the failing evidence and clears it, so one bad request does not hide the measurement of the menus behind it. */
function createMemorySuspensionStore(): SuspensionStore {
  let suspended = false;
  let mismatches = 0;
  return {
    isSuspended: () => Promise.resolve(suspended),
    suspend: () => {
      suspended = true;
      mismatches += 1;
      return Promise.resolve();
    },
    clear: () => {
      suspended = false;
      return Promise.resolve();
    },
    mismatchCount: () => Promise.resolve(mismatches),
  };
}

interface TokenRecord {
  readonly menu: string;
  readonly chunk: number;
  counted: number;
  countedPayload: string | null;
  reportedInput: number | null;
  reportedOutput: number | null;
  samePayload: boolean | null;
  error: string | null;
}

/** Whether the request's evidence holds: the provider reported exactly the input count that was reserved for, over a payload identical to the one counted. Both halves matter — a count covering a different payload would bound nothing — and a request that errored before answering fails, because it proves nothing about the model's profile. */
function evidenceHolds(record: TokenRecord): boolean {
  return record.reportedInput === record.counted && record.samePayload === true;
}

/** Wrap the provider so every request's count and reply are recorded (AAP 0.5.6). */
function recordingAdapter(inner: LlmAdapter, records: TokenRecord[], menu: string): LlmAdapter {
  const opened = new WeakMap<object, TokenRecord>();
  let lastOpened: TokenRecord | null = null;
  let chunk = 0;
  return {
    provider: inner.provider,
    model: inner.model,
    async countInputTokens(request, options) {
      chunk += 1;
      const record: TokenRecord = {
        menu,
        chunk,
        counted: 0,
        countedPayload: null,
        reportedInput: null,
        reportedOutput: null,
        samePayload: null,
        error: null,
      };
      records.push(record);
      opened.set(request, record);
      lastOpened = record;
      try {
        record.counted = await inner.countInputTokens(request, options);
        record.countedPayload = JSON.stringify(request);
        return record.counted;
      } catch (error) {
        // The request is not sent after a failed count, so this record is its whole evidence.
        record.error = errorCode(error);
        throw error;
      }
    },
    async complete(request, options) {
      const record = opened.get(request) ?? lastOpened;
      try {
        const result = await inner.complete(request, options);
        if (record !== null) {
          record.reportedInput = result.usage?.inputTokens ?? null;
          record.reportedOutput = result.usage?.outputTokens ?? null;
          record.samePayload =
            record.countedPayload !== null && JSON.stringify(request) === record.countedPayload;
        }
        return result;
      } catch (error) {
        if (record !== null) record.error = errorCode(error);
        throw error;
      }
    },
  };
}

/** This run's site-terms decisions, in memory: the fixture host is `allowed`, mirroring the `overriddenBy = seed` rows the seed records for the local fixture hosts. `upsertProhibited` and `insertUncertain` throw, because reaching either means the run asked about a host the labeled set never names — a broken fixture rather than a decision to take here. */
function createFixturePolicyStore(): CrawlPolicyStore {
  return {
    find: (domains) =>
      Promise.resolve(
        domains.includes(FIXTURE_HOST) ? [{ domain: FIXTURE_HOST, decision: 'allowed' }] : [],
      ),
    upsertProhibited: () => {
      throw new Error('menus-eval: the crawl policy tried to prohibit a domain');
    },
    insertUncertain: () => {
      throw new Error('menus-eval: the crawl policy tried to review an unknown domain');
    },
  };
}

interface FixtureServer {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

/** Serve the labeled HTML menus over loopback, so the page path of the pipeline runs against a real HTTP response (AAP 0.5.6). Only the manifest's HTML files are served, at `/<file>`; `/robots.txt` and everything else answer 404, which RFC 9309 reads as "every path is allowed". The port is ephemeral, so nothing on the host is reserved and no sibling agent can collide with it. */
async function startFixtureServer(menus: readonly ManifestMenu[]): Promise<FixtureServer> {
  const files = new Set(menus.filter((menu) => menu.format === 'html').map((menu) => menu.file));
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${FIXTURE_HOST}`).pathname.replace(/^\//u, '');
    if (!files.has(path)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    const body = readFileSync(join(MENUS_DIR, path));
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.byteLength),
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, FIXTURE_HOST, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://${FIXTURE_HOST}:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface EvalRun {
  readonly origin: string;
  readonly browser: Pick<BrowserProvider, 'get'>;
  readonly safeFetch: SafeFetch;
  readonly userAgent: string;
  readonly logger: Logger;
  readonly llm: LlmAdapter;
  readonly spend: LlmSpend;
  readonly records: TokenRecord[];
  readonly suspension: SuspensionStore;
}

interface MenuRun {
  readonly menu: ManifestMenu;
  error: string | null;
  labeled: number;
  matched: number;
  modelItems: number;
  modelInSource: number;
  kept: number;
  keptInSource: number;
  gateNotInSource: number;
  gateUnparseable: number;
  extractionDrops: Record<string, number>;
  unmatched: LabelRef[];
  durationMs: number;
}

function allLabels(menu: ManifestMenu): LabelRef[] {
  return menu.items.map((item) => ({
    normalizedName: item.normalizedName,
    priceText: item.priceText,
  }));
}

function matchKey(normalizedName: string, amountMinor: number, currency: string): string {
  return `${normalizedName}|${amountMinor}|${currency.toUpperCase()}`;
}

/** Score the kept items against the labels (AAP 0.12.1): a multiset match, so each kept item consumes at most one label and a menu printing one dish twice cannot satisfy two labels with one price. @param labels - The menu's expected items. @param kept - The items that survived the source gate. @returns How many labels matched, and those that did not, in manifest order. */
function scoreLabels(
  labels: readonly ManifestItem[],
  kept: readonly GatedMenuItem[],
): { matched: number; unmatched: LabelRef[] } {
  const pool = new Map<string, number>();
  for (const item of kept) {
    const key = matchKey(normalizeItemName(item.name), item.localAmountMinor, item.currency);
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }

  const unmatched: LabelRef[] = [];
  let matched = 0;
  for (const label of labels) {
    const left = pool.get(matchKey(label.normalizedName, label.amountMinor, label.currency)) ?? 0;
    if (left > 0) {
      pool.set(matchKey(label.normalizedName, label.amountMinor, label.currency), left - 1);
      matched += 1;
    } else {
      unmatched.push({ normalizedName: label.normalizedName, priceText: label.priceText });
    }
  }

  return { matched, unmatched };
}

/** One menu's source text, or the code that says why it could not be read. */
type SourceOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'error'; readonly code: string };
/** Read one menu's source text the way `menu-ingest` does (AAP 0.5.6): a rendered page for HTML, a text layer or a rasterize-and-OCR pass for a PDF, and OCR for an image. Everything is bounded by the pipeline's own constants — a fresh per-place fetch budget, twenty PDF pages, the OCR timeout — and every refusal becomes a code in the report rather than an exception, so one unusable document does not stop the measurement of the others. */
async function readSource(menu: ManifestMenu, run: EvalRun): Promise<SourceOutcome> {
  try {
    if (menu.format === 'html') {
      const rendered = await renderPage(`${run.origin}/${menu.file}`, {
        browser: run.browser,
        safeFetch: run.safeFetch,
        budget: createFetchBudget(),
        userAgent: run.userAgent,
        logger: run.logger,
      });
      if (rendered.kind === 'ok') return { kind: 'text', text: rendered.text };
      return {
        kind: 'error',
        code: rendered.kind === 'failed' ? `render_${rendered.reason}` : 'render_login_wall',
      };
    }
    const bytes = await readFile(join(MENUS_DIR, menu.file));
    if (menu.format === 'image') {
      return { kind: 'text', text: await ocrImage(bytes, { language: menu.ocrLanguage }) };
    }
    const extracted = await extractPdfText(bytes, { maxPages: PDF_MAX_PAGES });
    if (extracted.hasTextLayer !== menu.textLayer) {
      return { kind: 'error', code: 'text_layer_mismatch' };
    }
    if (extracted.hasTextLayer) return { kind: 'text', text: extracted.text };
    const pages = await rasterizePdf(bytes, { maxPages: PDF_MAX_PAGES });
    const perPage: string[] = [];
    for (const page of pages) {
      perPage.push(await ocrImage(page, { language: menu.ocrLanguage }));
    }
    return { kind: 'text', text: perPage.join('\n') };
  } catch (error) {
    return { kind: 'error', code: failureCode(error) };
  }
}

/** Read one menu end to end and score it (AAP 0.12.1): the source text, then the metered extraction — `extractMenuItems` counts, reserves and sends through the shared spend meter, and the recording adapter captures each request's evidence — then the source gate, the multiset score and the source-text share of what was stored. */
async function runMenu(menu: ManifestMenu, run: EvalRun): Promise<MenuRun> {
  const startedMs = systemClock.nowMs();
  const result: MenuRun = {
    menu,
    error: null,
    labeled: menu.items.length,
    matched: 0,
    modelItems: 0,
    modelInSource: 0,
    kept: 0,
    keptInSource: 0,
    gateNotInSource: 0,
    gateUnparseable: 0,
    extractionDrops: {},
    unmatched: allLabels(menu),
    durationMs: 0,
  };
  const source = await readSource(menu, run);
  if (source.kind === 'error') {
    result.error = source.code;
  } else {
    try {
      const text = source.text;
      const extraction = await extractMenuItems(text, {
        llm: recordingAdapter(run.llm, run.records, menu.file),
        spend: run.spend,
        cityId: CITY_ID,
        currency: menu.currency,
        logger: run.logger,
      });
      const normalized = normalizeWhitespace(text);
      const inSource = (priceText: string): boolean =>
        normalized.includes(normalizeWhitespace(priceText));
      const gated = gateItems(extraction.items, text, menu.currency);
      const scored = scoreLabels(menu.items, gated.kept);
      result.modelItems = extraction.items.length;
      result.modelInSource = extraction.items.filter((item) => inSource(item.priceText)).length;
      result.extractionDrops = extraction.drops;
      result.kept = gated.kept.length;
      result.keptInSource = gated.kept.filter((item) => inSource(item.priceText)).length;
      result.gateNotInSource = gated.drops.not_in_source;
      result.gateUnparseable = gated.drops.unparseable;
      result.matched = scored.matched;
      result.unmatched = scored.unmatched;
    } catch (error) {
      // A refusal or a suspension: the request was not sent, and the failure costs this menu only.
      result.error = failureCode(error);
    }
  }

  result.durationMs = systemClock.nowMs() - startedMs;
  if (await run.suspension.isSuspended()) {
    run.logger.warn({ event: 'menus_eval_suspended', menu: menu.file });
    await run.suspension.clear();
  }

  return result;
}

function shareOf(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : `${((100 * part) / whole).toFixed(1)}%`;
}

/** A status word, exactly `pass` or `fail` (the documents' convention). */
function verdict(passed: boolean): string {
  return passed ? 'pass' : 'fail';
}

function sum(runs: readonly MenuRun[], pick: (run: MenuRun) => number): number {
  return runs.reduce((total, run) => total + pick(run), 0);
}

/** One Markdown table, padded exactly as prettier pads one: every column as wide as its widest cell (three characters at least, so the separator is valid), cells right-padded with spaces. The document is generated rather than hand-written, so it has to satisfy `pnpm format:check` as it stands; the tables hold paths, counts and status words only, all single-width, which is what keeps this padding identical to prettier's own. */
function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(3, header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 3)).join(' | ')} |`;
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join(
    '\n',
  );
}

interface Counts {
  readonly labeled: number;
  readonly matched: number;
  readonly kept: number;
  readonly keptInSource: number;
  readonly modelItems: number;
  readonly modelInSource: number;
  readonly gateNotInSource: number;
  readonly gateUnparseable: number;
  readonly requests: number;
  readonly mismatches: number;
  readonly matchedPass: boolean;
  readonly sourcePass: boolean;
  readonly evidencePass: boolean;
}

interface Summary {
  readonly runs: readonly MenuRun[];
  readonly fixtureErrors: readonly string[];
  readonly records: readonly TokenRecord[];
  readonly spentMicros: number;
  readonly capMicros: number;
  readonly model: string;
  readonly commit: string;
  readonly tesseract: string;
}

/** Compute the two thresholds and the token evidence (AAP 0.12.1, 0.5.6). */
function countOf(summary: Summary): Counts {
  const { runs, records } = summary;
  const labeled = sum(runs, (run) => run.labeled);
  const matched = sum(runs, (run) => run.matched);
  const kept = sum(runs, (run) => run.kept);
  const keptInSource = sum(runs, (run) => run.keptInSource);
  const mismatches = records.filter((record) => !evidenceHolds(record)).length;
  return {
    labeled,
    matched,
    kept,
    keptInSource,
    modelItems: sum(runs, (run) => run.modelItems),
    modelInSource: sum(runs, (run) => run.modelInSource),
    gateNotInSource: sum(runs, (run) => run.gateNotInSource),
    gateUnparseable: sum(runs, (run) => run.gateUnparseable),
    requests: records.length,
    mismatches,
    matchedPass: labeled > 0 && matched / labeled >= MATCHED_THRESHOLD,
    sourcePass: kept > 0 && keptInSource === kept,
    evidencePass: records.length > 0 && mismatches === 0,
  };
}

/** The per-menu rows of one group, keyed by language or by format. */
function groupedRows(
  runs: readonly MenuRun[],
  keys: readonly string[],
  keyOf: (run: MenuRun) => string,
): string[][] {
  return keys.map((key) => {
    const group = runs.filter((run) => keyOf(run) === key);
    const labeled = sum(group, (run) => run.labeled);
    const matched = sum(group, (run) => run.matched);
    return [
      key,
      String(group.length),
      String(labeled),
      String(matched),
      String(sum(group, (run) => run.kept)),
      shareOf(matched, labeled),
    ];
  });
}

function evidenceRows(records: readonly TokenRecord[]): string[][] {
  return records.map((record, index) => [
    String(index + 1),
    record.menu,
    String(record.chunk),
    String(record.counted),
    record.reportedInput === null ? 'none' : String(record.reportedInput),
    record.reportedOutput === null ? 'none' : String(record.reportedOutput),
    record.samePayload === null ? 'none' : String(record.samePayload),
    verdict(evidenceHolds(record)),
  ]);
}

/** The results block: what criterion 11 measured, the per-language, per-format and per-menu tables, the labels that did not match, and the token evidence for the spend cap (AAP 0.12.1, 0.5.6). Only label names and price strings appear — never a menu's text, a prompt, a payload or a model answer. */
function resultsBody(summary: Summary, counts: Counts): string {
  const unmatched = summary.runs.flatMap((run) =>
    run.unmatched.map(
      (label) => `- ${run.menu.file}: ${label.normalizedName} — ${label.priceText}`,
    ),
  );
  const failures = summary.records.filter((record) => !evidenceHolds(record));
  const failureCodes = [...new Set(failures.map((record) => record.error ?? 'count_mismatch'))];
  const fixtureNote =
    summary.fixtureErrors.length > 0
      ? `\n- Fixture problems: ${summary.fixtureErrors.join('; ')}`
      : '';
  const failureNote =
    failureCodes.length > 0 ? `\n\nEvidence failures: ${failureCodes.join(', ')}.` : '';
  return `${RESULT_MARKER}

Measured ${systemClock.now().toISOString()} by \`pnpm --filter @tablemate/workers eval:menus\` (commit ${summary.commit}, provider ${EVALUATED_PROVIDER}, model ${summary.model}).

- Labeled items matched: ${counts.matched} / ${counts.labeled} (${shareOf(counts.matched, counts.labeled)}) — ${verdict(counts.matchedPass)} (threshold ≥ 90%)
- Stored price strings found in source text: ${counts.keptInSource} / ${counts.kept} (${shareOf(counts.keptInSource, counts.kept)}) — ${verdict(counts.sourcePass)} (threshold 100%)
- Source-gate drops (diagnostic): not_in_source ${counts.gateNotInSource}, unparseable ${counts.gateUnparseable}
- Model items found in the source before the gate (diagnostic): ${counts.modelInSource} / ${counts.modelItems}
- Tesseract: ${summary.tesseract}${fixtureNote}

### By language

${markdownTable(
  ['language', 'menus', 'labeled', 'matched', 'stored', 'match share'],
  groupedRows(summary.runs, LANGUAGES, (run) => run.menu.language),
)}

### By format

${markdownTable(
  ['format', 'menus', 'labeled', 'matched', 'stored', 'match share'],
  groupedRows(summary.runs, FORMATS, (run) => run.menu.format),
)}

### By menu

${markdownTable(
  ['menu', 'format', 'labeled', 'matched', 'stored', 'seconds', 'error'],
  summary.runs.map((run) => [
    run.menu.file,
    run.menu.format,
    String(run.labeled),
    String(run.matched),
    String(run.kept),
    (run.durationMs / 1000).toFixed(1),
    run.error ?? 'none',
  ]),
)}

### Unmatched labels

${unmatched.length > 0 ? unmatched.join('\n') : 'None.'}

### Language-model token evidence (AAP 0.5.6)

${markdownTable(['#', 'menu', 'chunk', 'counted input', 'reported input', 'reported output', 'same payload', 'match'], evidenceRows(summary.records))}

requests ${counts.requests}, mismatches ${counts.mismatches} — ${verdict(counts.evidencePass)}; charged ${(summary.spentMicros / 1_000_000).toFixed(6)} USD of the ${(summary.capMicros / 1_000_000).toFixed(6)} USD per-city-day cap.${failureNote}`;
}

/** The block a run without provider credentials writes: no date, so a repeated run changes nothing. */
function pendingBody(): string {
  return `${PENDING_MARKER}

Evaluation pending provider credentials

Counted-against-reported token evidence for the spend cap (AAP 0.5.6): pending.

Set \`LLM_PROVIDER=openai\` with a supported \`LLM_MODEL\`, \`LLM_API_KEY\` and both \`LLM_PRICE_*_USD_PER_MTOK\` prices to record the measurement.`;
}

function readDoc(): string {
  return existsSync(DOC_FILE) ? readFileSync(DOC_FILE, 'utf8') : `${DOC_HEADING}\n`;
}

function replaceBlock(doc: string, body: string): string {
  const begin = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  const block = `${BEGIN_MARKER}\n${body}\n${END_MARKER}`;
  if (begin === -1 || end <= begin) return `${doc.trimEnd()}\n\n${block}`;
  return `${doc.slice(0, begin)}${block}${doc.slice(end + END_MARKER.length)}`;
}

/** Keep the fixture-set-only status line (AAP 0.12.3): the accuracy of this pipeline on real launch-city menus is unverified beyond the labeled set, and no run may drop that statement. The line is appended after the block when it is missing, and never removed. */
function ensureStatusLine(doc: string): string {
  const withLine = doc.includes(STATUS_LINE) ? doc : `${doc.trimEnd()}\n\n${STATUS_LINE}\n`;
  return withLine.endsWith('\n') ? withLine : `${withLine}\n`;
}

/** Write the document, and only when it changed, so a repeated pending run is a byte-identical no-op. */
function saveDoc(doc: string): boolean {
  const current = existsSync(DOC_FILE) ? readFileSync(DOC_FILE, 'utf8') : null;
  if (current === doc) return false;
  writeFileSync(DOC_FILE, doc, 'utf8');
  return true;
}

function say(stream: 'out' | 'err', line: string): void {
  const message = `${line}\n`;
  if (stream === 'out') process.stdout.write(message);
  else process.stderr.write(message);
}

/** The commit the measurement was taken at, or `unknown` when git cannot answer. */
async function shortCommit(): Promise<string> {
  try {
    const result = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      timeout: PREFLIGHT_TIMEOUT_MS,
      cwd: REPO_ROOT,
    });
    return result.stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A run with no provider credentials (AAP 0.12.3): the fixture set has already been validated and the document is marked pending, so nothing measured is claimed. A recorded measurement is never overwritten by such a run — it is kept as it stands, and the run exits 0. */
function pendingRun(menus: readonly ManifestMenu[]): number {
  const doc = readDoc();
  const kept = doc.includes(RESULT_MARKER);
  saveDoc(kept ? ensureStatusLine(doc) : ensureStatusLine(replaceBlock(doc, pendingBody())));
  say(
    'out',
    kept
      ? 'menus-eval: pending — a recorded measurement is kept as it stands.'
      : `menus-eval: pending — provider credentials absent; the fixture set is valid (${menus.length} menus).`,
  );
  return 0;
}

async function measuredRun(menus: readonly ManifestMenu[], config: RunConfig): Promise<number> {
  const preflight = await preflightTools();
  for (const problem of preflight.problems) say('err', `menus-eval: ${problem}`);
  if (preflight.problems.length > 0) return 1;
  const browser = createBrowserProvider();
  try {
    await browser.get();
  } catch (error) {
    say(
      'err',
      `menus-eval: Chromium could not be launched (${messageOf(error)}); run \`pnpm --filter @tablemate/workers exec playwright install chromium\`.`,
    );
    await browser.close();
    return 1;
  }

  let server: FixtureServer | null = null;
  try {
    server = await startFixtureServer(menus);
    const logger = createLogger({ name: 'menus-eval', level: 'warn', appEnv: 'test' });
    const store = createMemorySpendStore();
    const suspension = createMemorySuspensionStore();
    const blocklist = loadBlocklist(REPO_ROOT);
    const userAgent = crawlerUserAgent(FIXTURE_CONTACT_URL);
    const run: EvalRun = {
      origin: server.origin,
      browser,
      // `appEnv: 'test'` with the loopback host exempt is AAP 0.5.6's test-environment exemption, passed directly instead of read from the environment. The no-op throttle is safe because every request goes to the one host this process serves itself.
      safeFetch: createSafeFetch({
        appEnv: 'test',
        allowPrivateHosts: [FIXTURE_HOST],
        blocklist,
        policy: createDomainPolicy({
          store: createFixturePolicyStore(),
          clock: systemClock,
          blocklist,
        }),
        robotsCache: createMemoryRobotsCache(),
        throttle: () => Promise.resolve(),
        userAgent,
        logger,
        clock: systemClock,
      }),
      userAgent,
      logger,
      llm: createLlmAdapter({
        provider: EVALUATED_PROVIDER,
        apiKey: config.apiKey,
        model: config.model,
      }),
      spend: createLlmSpend({
        store,
        suspension,
        clock: systemClock,
        capMicros: config.capMicros,
        prices: config.prices,
        timezoneFor: () => 'UTC',
        logger,
      }),
      records: [],
      suspension,
    };
    const runs: MenuRun[] = [];
    const fixtureErrors: string[] = [];
    for (const menu of menus) {
      const result = await runMenu(menu, run);
      if (result.error === 'text_layer_mismatch') {
        fixtureErrors.push(`${menu.file}: textLayer does not match the manifest`);
      }
      runs.push(result);
    }
    const summary: Summary = {
      runs,
      fixtureErrors,
      records: run.records,
      spentMicros: store.spentMicros(),
      capMicros: config.capMicros,
      model: run.llm.model,
      commit: await shortCommit(),
      tesseract: preflight.tesseract,
    };
    const counts = countOf(summary);
    const written = saveDoc(
      ensureStatusLine(replaceBlock(readDoc(), resultsBody(summary, counts))),
    );
    const code =
      counts.matchedPass && counts.sourcePass && counts.evidencePass && fixtureErrors.length === 0
        ? 0
        : 1;
    say(
      'out',
      [
        `menus-eval: matched ${counts.matched}/${counts.labeled} (${shareOf(counts.matched, counts.labeled)}) ${verdict(counts.matchedPass)}`,
        `stored-in-source ${counts.keptInSource}/${counts.kept} (${shareOf(counts.keptInSource, counts.kept)}) ${verdict(counts.sourcePass)}`,
        `token evidence ${counts.requests} requests ${counts.mismatches} mismatches ${verdict(counts.evidencePass)}`,
        written ? `written to ${DOC_FILE}` : 'document unchanged',
      ].join(', '),
    );
    return code;
  } catch (error) {
    say('err', `menus-eval: the run failed: ${messageOf(error)}`);
    return 1;
  } finally {
    if (server !== null) await server.stop();
    await browser.close();
  }
}

/** The evaluator: validate the labeled set, then measure it or mark it pending (AAP 0.12.1, 0.12.3). */
async function main(): Promise<number> {
  const manifest = loadManifest();
  const mode = resolveMode();
  if (mode.kind === 'error') {
    say('err', `menus-eval: ${mode.message}`);
    return 1;
  }
  if (manifest.errors.length > 0) {
    for (const error of manifest.errors) say('err', `menus-eval: fixture set: ${error}`);
    return 1;
  }

  if (mode.kind === 'pending') return pendingRun(manifest.menus);
  return await measuredRun(manifest.menus, mode.config);
}

process.exitCode = await main();
