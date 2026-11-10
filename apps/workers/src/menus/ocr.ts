/**
 * Tesseract OCR for menu images and rasterized PDF pages (AAP 0.3.1, 0.5.6).
 *
 * Menu ingestion reaches text three ways: a PDF's text layer through `pdf-text.ts`, a fetched HTML page's rendered text, and
 * this module for everything carrying pixels — a menu published as an image, a photograph of one, and an image-only PDF that
 * `fetch-page.ts` rasterized with `pdftoppm` first. It enforces two of the bounds AAP 0.5.6 sets for one ingest: sharp
 * refuses an image above {@link MAX_IMAGE_PIXELS} before a pixel is decoded, and the child process is killed at
 * {@link OCR_TIMEOUT_MS}.
 *
 * The native CLI replaces `tesseract.js`, whose Node 22 path aborts on a `tessdata_best` model (AAP 0.3.1); the child
 * inherits `TESSDATA_PREFIX` from `apps/workers/Dockerfile`. Recognized text is menu content and never reaches a log or an
 * error message, and its quality is measured by the labeled set in `apps/workers/eval/menus-eval.ts`.
 */

import { execFile, type ExecFileException } from 'node:child_process';

import sharp from 'sharp';

import type { CallLanguage } from '@tablemate/shared';

/** A Tesseract language whose `tessdata_best` model `apps/workers/Dockerfile` installs (AAP 0.3.1): the four non-English menu languages of the launch cities, plus English as the shared fallback. */
export type OcrLanguage = 'eng' | 'por' | 'spa' | 'tha' | 'ind';
/** The OCR language of each city's `callLanguage` (AAP 0.5.2, 0.5.6). `satisfies Record<CallLanguage, OcrLanguage>` is load-bearing: a new value in the shared enum fails compilation here until a model is chosen and installed for it. */
export const OCR_LANGUAGE_BY_CALL_LANGUAGE = {
  'en-US': 'eng',
  'pt-PT': 'por',
  'es-US': 'spa',
  'th-TH': 'tha',
  'id-ID': 'ind',
} as const satisfies Record<CallLanguage, OcrLanguage>;
/** The OCR language for a city's `callLanguage` (AAP 0.5.6). */
export function ocrLanguageFor(callLanguage: CallLanguage): OcrLanguage {
  return OCR_LANGUAGE_BY_CALL_LANGUAGE[callLanguage];
}

/** The largest image Tesseract is asked to read: the 25-megapixel bound of AAP 0.5.6. */
export const MAX_IMAGE_PIXELS = 25_000_000;
/** How long one image may occupy Tesseract: the 60-second bound of AAP 0.5.6. */
export const OCR_TIMEOUT_MS = 60_000;
/** Why {@link ocrImage} produced no text, so a caller can tell a retry from a drop (AAP 0.5.6). */
export type OcrFailureReason = 'too_large' | 'unsupported_image' | 'timeout' | 'tesseract_failed';
/** An image that could not be recognized. The upstream failure travels in `cause`, never in `message`, which stays free of the image and of the text being read (AAP 0.11.1). */
export class OcrError extends Error {
  /** Which of the bounded ways the attempt failed (AAP 0.5.6). */
  readonly reason: OcrFailureReason;
  constructor(reason: OcrFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OcrError';
    this.reason = reason;
  }
}

/** Recognize the text of one menu image (AAP 0.5.6). The bytes are normalized first — EXIF orientation applied, colour dropped, re-encoded as PNG — so one decode path serves a JPEG photograph, a WebP export and a rasterized PDF page alike. Tesseract reads that PNG from stdin in `opts.language` plus English: the city's language carries the menu's own words, English the loanwords and numerals. `--psm 6`, "a single uniform block of text", is the page-segmentation mode for a menu, and all Thai needs — `tha` takes no extra flag. */
export async function ocrImage(
  bytes: Uint8Array,
  opts: { language: OcrLanguage; timeoutMs?: number },
): Promise<string> {
  const png = await normalizeToPng(bytes);
  const text = await runTesseract(png, opts.language, opts.timeoutMs ?? OCR_TIMEOUT_MS);
  return text.replace(/\r\n/gu, '\n').trimEnd();
}

/** Decode `bytes` into the grayscale PNG Tesseract reads, mapping sharp's refusal to `OcrError`. */
async function normalizeToPng(bytes: Uint8Array): Promise<Buffer> {
  try {
    return await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
      .rotate()
      .grayscale()
      .png()
      .toBuffer();
  } catch (error) {
    // sharp reports the bound only in its message ("Input image exceeds pixel limit"), and an oversized image must not reach Tesseract's own memory, so it keeps a reason of its own.
    if (isPixelLimitError(error)) {
      throw new OcrError('too_large', `image exceeds ${MAX_IMAGE_PIXELS} pixels`, { cause: error });
    }
    throw new OcrError('unsupported_image', 'image could not be decoded', { cause: error });
  }
}

/** Whether `error` is sharp's refusal of an image larger than `limitInputPixels`. */
function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && /pixel limit/iu.test(error.message);
}

/** Run Tesseract over `png` and resolve with its stdout. The image is fed on stdin and the text taken from stdout, so neither touches the filesystem. `killSignal: 'SIGKILL'` is deliberate: a Tesseract wedged on a large image can ignore a `SIGTERM` for an unbounded time. */
function runTesseract(png: Buffer, language: OcrLanguage, timeoutMs: number): Promise<string> {
  const languages = language === 'eng' ? 'eng' : `${language}+eng`;
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'tesseract',
      ['stdin', 'stdout', '-l', languages, '--psm', '6'],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 << 20, encoding: 'utf8' },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(toOcrError(error, timeoutMs));
      },
    );
    // A child that has already exited — a spawn failure, or the kill on timeout — makes the stdin write raise EPIPE. The callback above carries the real reason, so the stream error is consumed here rather than escaping as an unhandled event.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(png);
  });
}

/** Classify a failed run: the kill Node sends on timeout gets its own reason, everything else fails. */
function toOcrError(error: ExecFileException, timeoutMs: number): OcrError {
  // A stdout `maxBuffer` overflow also leaves `killed` set, and it is a failed run, not a timeout.
  const timedOut = error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  if (timedOut) {
    return new OcrError('timeout', `tesseract exceeded ${timeoutMs} ms`, { cause: error });
  }
  const status = error.code ?? error.signal ?? 'no exit status';
  return new OcrError('tesseract_failed', `tesseract failed (${String(status)})`, { cause: error });
}
