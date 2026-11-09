/**
 * Menu PDFs: the text layer, and the page images of a PDF that has none (AAP 0.3.1, 0.4.2, 0.5.6).
 *
 * A menu PDF is untrusted input that `./safe-fetch.ts` has already fetched and capped at 20 MiB; this module opens no
 * connection of its own. It answers the one question the pipeline asks of a PDF — is there text to extract, or is this a
 * scan? The caller reads the text layer when there is one, and otherwise rasterizes the file with {@link rasterizePdf} and
 * hands the page images to `./ocr.ts`. Extraction is tried first because it is orders of magnitude cheaper than OCR, and
 * {@link extractPdfText} reports which case it found through `hasTextLayer` instead of guessing from the file's size or name.
 *
 * Both halves hold nothing afterwards: pdf.js's loading task is destroyed in a `finally`, and the directory
 * {@link rasterizePdf} creates for `pdftoppm` is removed in a `finally` whatever the outcome. Errors are reason codes only,
 * and no PDF text, field value or extracted string is logged or attached to one (AAP 0.5.6, "Never log extracted text").
 * The document may not be trusted to run code, and the option that used to say so is deliberately absent: `isEvalSupported`
 * was removed from pdf.js and pdfjs-dist 6.5.438 ships neither an `eval(` nor a `new Function(` call, so an attacker-supplied
 * file has no code path that executes.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PasswordException, getDocument, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Pages read from one PDF (AAP 0.5.6: "the first 20 PDF pages"). The bound is what keeps one large document from spending the crawl budget: both functions cap their work here, and a menu whose prices sit beyond page 20 is treated as unpriced, so the place takes the phone fallback rather than the pipeline reading without limit.
export const PDF_MAX_PAGES = 20;
// Non-whitespace characters a PDF must yield before it counts as having a text layer. The threshold separates a scan (Tesseract's job) from a real text layer: a page of menu items carries hundreds of characters, while a rasterized scan yields at most the stray whitespace and the few glyph identifiers pdf.js synthesizes for it. Twenty is high enough to reject that noise and low enough that a short price list still clears it.
const MIN_TEXT_LAYER_CHARS = 20;
/** Render resolution of the page images, in dots per inch. */
const RASTERIZE_DPI = 200;
// How long `pdftoppm` may run before it is killed (`killSignal: 'SIGKILL'`): twenty pages at 200 dpi take a few seconds, and two minutes leaves room for a slow host without letting one file hold the crawl slot for the whole run.
const RASTERIZE_TIMEOUT_MS = 120_000;
// Cap on the bytes `pdftoppm` may write to stdout and stderr before the call fails.
const RASTERIZE_MAX_OUTPUT_BYTES = 1 << 20; // 1 MiB

// A page image `pdftoppm` wrote for the output prefix `page`. It zero-pads to the width of the document's page count (`page-1.png` for nine pages and fewer, `page-01.png` for ten and more), so the numeric suffix rather than the name orders the images.
const PAGE_FILE = /^page-(\d+)\.png$/u;
const execFileAsync = promisify(execFile);
/** The pdf.js text items of one page, derived from the library's own declarations. */
type TextContentItem = Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number];
// What a {@link PdfTextError} says went wrong. `encrypted` and `invalid_pdf` come from reading the document, `rasterize_timeout` and `rasterize_failed` from rasterizing it, and the two rasterizing reasons are separate because they are handled differently upstream: a timeout is one slow file, while a failure is a file `pdftoppm` cannot read at all.
export type PdfTextReason = 'invalid_pdf' | 'encrypted' | 'rasterize_failed' | 'rasterize_timeout';
// The only rejection {@link extractPdfText} and {@link rasterizePdf} produce. Its message is the reason code itself, so a caller can log or map it without a second dictionary, and it carries no document text, no path and no library message.
export class PdfTextError extends Error {
  readonly reason: PdfTextReason;
  constructor(reason: PdfTextReason) {
    super(reason);
    this.name = 'PdfTextError';
    this.reason = reason;
  }
}

// The text layer of a PDF, and whether it is worth anything (AAP 0.5.6).
//
// Pages are read one at a time and joined with a blank line, each page's items concatenated with a newline wherever
// pdf.js marks an end of line. Only the first `maxPages` pages are read, while `pages` reports the document's own page
// count, so a caller can tell a 30-page menu whose tail was not read from a 30-page menu that is short of text.
//
// `hasTextLayer` is false when fewer than {@link MIN_TEXT_LAYER_CHARS} non-whitespace characters came back, which is
// the signal to rasterize and OCR the file instead; a PDF with no pages extracts to empty text and reports false.
export async function extractPdfText(
  bytes: Uint8Array,
  opts: { maxPages?: number } = {},
): Promise<{ text: string; pages: number; hasTextLayer: boolean }> {
  const maxPages = opts.maxPages ?? PDF_MAX_PAGES;
  // pdf.js takes ownership of the buffer it is handed — it can detach or transfer it — and a Node Buffer may be a view on a pooled ArrayBuffer another caller is still reading, so it is given a copy of this call's own. The copy also bounds the view to exactly the bytes passed in.
  const data = new Uint8Array(bytes);
  // No `isEvalSupported`: pdfjs-dist 6.5.438 removed the option and the capability with it (the built library holds no `eval(` and no `new Function(`), so there is nothing left to switch off.
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await loadingTask.promise;
    const pages = doc.numPages;
    const perPage: string[] = [];
    for (let number = 1; number <= Math.min(pages, maxPages); number += 1) {
      const page = await doc.getPage(number);
      try {
        perPage.push(pageText((await page.getTextContent()).items));
      } finally {
        page.cleanup();
      }
    }
    const text = perPage.join('\n\n');
    return { text, pages, hasTextLayer: nonWhitespaceChars(text) >= MIN_TEXT_LAYER_CHARS };
  } catch (error) {
    throw pdfLoadError(error);
  } finally {
    // destroy() rejects when the task never loaded; by then the reason above is the one that matters, so this secondary failure is dropped rather than replacing it.
    await loadingTask.destroy().catch(() => undefined);
  }
}

// The page images of a PDF that has no usable text layer, ready for `./ocr.ts` (AAP 0.5.6).
//
// `pdftoppm` writes one PNG per page at {@link RASTERIZE_DPI} into a private temporary directory, and they come back in
// page order. The images are not scaled here: a page that lands over `./ocr.ts`'s 25-megapixel input limit is rejected
// there by `limitInputPixels`, the one place that knows what the OCR engine accepts.
//
// The argument array is passed to `execFile` directly — no shell, so nothing in a name or a path is ever interpreted —
// and the temporary directory is removed in a `finally`, including when the call times out or `pdftoppm` is missing. A
// timeout becomes `rasterize_timeout` after {@link RASTERIZE_TIMEOUT_MS}, and any other failure `rasterize_failed`, an
// unreadable PDF included.
export async function rasterizePdf(
  bytes: Uint8Array,
  opts: { maxPages?: number; timeoutMs?: number } = {},
): Promise<Buffer[]> {
  const maxPages = opts.maxPages ?? PDF_MAX_PAGES;
  const timeoutMs = opts.timeoutMs ?? RASTERIZE_TIMEOUT_MS;
  const directory = await mkdtemp(join(tmpdir(), 'tablemate-pdf-'));
  try {
    const input = join(directory, 'input.pdf');
    await writeFile(input, bytes);
    await execFileAsync(
      'pdftoppm',
      [
        '-r',
        String(RASTERIZE_DPI),
        '-png',
        '-f',
        '1',
        '-l',
        String(maxPages),
        input,
        join(directory, 'page'),
      ],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: RASTERIZE_MAX_OUTPUT_BYTES },
    );
    const names = (await readdir(directory)).filter((name) => PAGE_FILE.test(name));
    names.sort((left, right) => pageNumberOf(left) - pageNumberOf(right));
    const pages: Buffer[] = [];
    for (const name of names) {
      pages.push(await readFile(join(directory, name)));
    }
    return pages;
  } catch (error) {
    throw rasterizeError(error);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** One page's text: the items that carry `str`, a newline wherever pdf.js ends a line. */
function pageText(items: readonly TextContentItem[]): string {
  let text = '';
  for (const item of items) {
    if ('str' in item) {
      text += item.hasEOL ? `${item.str}\n` : item.str;
    }
  }
  return text;
}

/** Characters a reader would see, which is what tells a text layer from a scan. */
function nonWhitespaceChars(text: string): number {
  return text.replace(/\s/gu, '').length;
}

/** The 1-based page number of a `page-<n>.png` name; `0` for a name that does not match. */
function pageNumberOf(name: string): number {
  const digits = PAGE_FILE.exec(name)?.[1];
  return digits === undefined ? 0 : Number(digits);
}

/** A document that was not read at all: a password-protected file, or one pdf.js cannot parse. */
function pdfLoadError(error: unknown): PdfTextError {
  return new PdfTextError(error instanceof PasswordException ? 'encrypted' : 'invalid_pdf');
}

/** A `pdftoppm` call that did not produce images: killed at its deadline, or failed outright. */
function rasterizeError(error: unknown): PdfTextError {
  return new PdfTextError(isKilled(error) ? 'rasterize_timeout' : 'rasterize_failed');
}

/** Whether the child was killed by its own timeout rather than failing on its own. */
function isKilled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'killed' in error && error.killed === true;
}
