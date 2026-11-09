/**
 * Sandboxed page rendering for the menu crawler (AAP 0.3.1, 0.5.6).
 *
 * A menu page is untrusted input, and rendering it is the one step of the crawl that would
 * otherwise open connections the policy chain never saw: a script, a frame, an image or a service
 * worker can each ask for a URL the page itself chose. The browser context built here therefore
 * makes no request of its own.
 *
 * - `serviceWorkers: 'block'`, so a page can neither register a worker nor fetch through one.
 * - `context.routeWebSocket`, given the routes-everything pattern, with a handler that closes every
 *   socket and never calls `connectToServer`, so no WebSocket is dialed.
 * - `context.route` over that same pattern, which intercepts every request and subrequest of every
 *   frame and fulfils it from `./safe-fetch.ts` — the same address check, blocklist, site-terms
 *   decision, `robots.txt` and per-domain throttle the entry URL passed. Nothing the page asks for
 *   is opened by the browser itself.
 * - A launch-time proxy at a closed port, so a request that somehow escaped interception fails
 *   instead of reaching the internet.
 *
 * Only GET and HEAD are forwarded. Images, media and fonts are refused without being fetched: they
 * would spend the 50-request place budget on bytes the price pipeline never reads, because a menu
 * image is followed deliberately through {@link RenderResult}'s `menuLinks` instead — under
 * `menuUrlKind`, which tells the caller a PDF or an image apart from a page. Every `fulfill` and
 * `abort` is guarded, because the page may already be gone when a late request arrives, and the
 * context is closed in a `finally` whatever happens (AAP 0.5.6).
 *
 * A page that asks for a password, answers 401 or 403, or lands on a login path is a
 * `login_wall` — AAP 0.5.6's "Stop on 401 or 403 responses, password fields or login redirects" —
 * and the caller takes the phone fallback rather than reading a page it has no access to.
 *
 * Logs carry the host, the outcome and character and link counts, and never page text or a URL with
 * its query (AAP 0.11.1).
 */

import { chromium } from 'playwright';
import { z } from 'zod';

import type { Browser, Page, Request, Route } from 'playwright';

import type { Logger } from '@tablemate/server-core';

import { registrableDomain } from './crawl-policy.ts';
import { SafeFetchError } from './safe-fetch.ts';
import type {
  FetchBudget,
  FetchKind,
  SafeFetch,
  SafeFetchReason,
  SafeFetchResponse,
} from './safe-fetch.ts';

/** How long the main navigation may take before it is given up (AAP 0.5.6: a 30 s navigation timeout). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** How long the page is given to settle after `load`, so a JS-rendered menu is read as rendered. */
const NETWORK_IDLE_TIMEOUT_MS = 5_000;

/** How long the visible text may take to be read once the page has loaded. */
const TEXT_TIMEOUT_MS = 5_000;

/** Anchors read from one page; a page with more of them is a link farm, not a menu. */
const MAX_ANCHORS = 500;

/** Characters of anchor text kept per anchor: enough for a menu label, never a link description. */
const MAX_ANCHOR_TEXT = 200;

/** Menu images reported per page (AAP 0.5.6: at most 20 images per place). */
const MAX_MENU_IMAGES = 20;

/**
 * The resource types refused without a fetch: they carry no menu text, and a page that links its
 * menu as an image is served by `menuLinks` rather than by the browser.
 */
const BLOCKED_RESOURCE_TYPES: ReadonlySet<string> = new Set(['image', 'media', 'font']);

/** The request headers worth forwarding; `./safe-fetch.ts` drops every other one anyway. */
const FORWARDED_HEADERS = ['accept', 'accept-language', 'referer'] as const;

/** A path that is a login page rather than a menu (AAP 0.5.6, "login redirects"). */
const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|signin|auth|account\/login)(\/|\.|$)/i;

/** A `.pdf` path, and the image extensions a menu may be photographed or exported as. */
const PDF_PATH = /\.pdf$/i;
const IMAGE_PATH = /\.(?:jpe?g|png|webp|gif|tiff?)$/i;

/** The anchors of a page, as `[href, text]` pairs; anything else the page returns is ignored. */
const ANCHOR_LIST = z.array(z.tuple([z.string(), z.string()]));

/**
 * The in-page expression that lists a page's anchors. It is a string expression rather than a
 * function because `apps/workers/test/**` and `src/**` compile without the DOM library
 * (`types: ['node']`), so `document` and `HTMLAnchorElement` have no types here.
 */
const ANCHOR_EXPRESSION =
  `Array.from(document.querySelectorAll('a[href]')).slice(0, ${MAX_ANCHORS})` +
  `.map(a => [a.href, (a.textContent || '').trim().slice(0, ${MAX_ANCHOR_TEXT})])`;
/** The options `route.fulfill` takes, built field by field so an absent one is absent (TS exactOptionalPropertyTypes). */
type FulfillOptions = { status: number; body?: Buffer; contentType?: string };

/**
 * The words that mark a link as a menu, in the launch cities' languages (AAP 0.5.6): the English,
 * Portuguese and Spanish menu words, the Thai one, and the Indonesian phrase.
 *
 * Exported because `./menu-ingest.ts` classifies the URLs it was given before it renders anything,
 * and both callers must agree on what a menu link is.
 */
export const MENU_WORDS = /menu|card[aá]pio|carta|เมนู|daftar\s*menu/iu;

/**
 * What a URL would be fetched as (AAP 0.5.6), decided by its path alone so no response is needed:
 * a `.pdf` is a PDF, an image extension is an image, everything else is a page to render.
 *
 * `./menu-ingest.ts` reads this before choosing a path: a place whose `menuUrl` is a PDF or an image
 * goes to `safeFetch` and `./pdf-text.ts` or `./ocr.ts` directly, and only an `html` URL is
 * rendered by {@link renderPage}.
 */
export function menuUrlKind(url: string): 'html' | 'pdf' | 'image' {
  const path = pathPortionOf(url);
  if (PDF_PATH.test(path)) return 'pdf';
  if (IMAGE_PATH.test(path)) return 'image';
  return 'html';
}

/**
 * Classify one link of a rendered page as a same-domain menu document (AAP 0.5.6): "Same-domain
 * links to PDFs or images whose text or URL matches menu words … are followed".
 *
 * A link qualifies only when all four hold: its scheme is http or https; its registrable domain is
 * the page's own ({@link registrableDomain}, so `menu.example.com` is the site's own menu while
 * another site's is not); {@link MENU_WORDS} matches the anchor text or the decoded URL — a
 * `card%C3%A1pio.pdf` link is a menu link, and a malformed escape sequence is left to the URL test
 * rather than throwing; and {@link menuUrlKind} finds a PDF or an image.
 *
 * The link is not fetched here. `./menu-ingest.ts` fetches it through `safeFetch`, so it passes the
 * address check, the blocklist, the site-terms decision, `robots.txt` and the throttle again.
 */
export function classifyMenuLink(
  href: string,
  text: string,
  pageUrl: string,
): 'pdf' | 'image' | null {
  const target = parseHttpUrl(href);
  const page = parseHttpUrl(pageUrl);
  if (target === null || page === null) return null;
  if (registrableDomain(target.hostname) !== registrableDomain(page.hostname)) return null;
  const kind = menuUrlKind(href);
  if (kind === 'html') return null;
  return MENU_WORDS.test(text) || MENU_WORDS.test(decodeSafely(href)) ? kind : null;
}

/**
 * One Chromium per process, shared by every place the job renders (AAP 0.3.1, 0.5.6).
 *
 * Launching a browser per place would cost more than the render itself, and one browser serving
 * every place keeps the crawl's memory bounded by the per-place contexts — which is why
 * {@link renderPage} opens a fresh context per call and closes it in a `finally`.
 */
export interface BrowserProvider {
  /** The browser to render in, launching it on first use and relaunching it after a crash. */
  get(): Promise<Browser>;
  /** Closes the browser if one was launched; safe to call twice, and safe to call before `get`. */
  close(): Promise<void>;
}

/** How the browser is launched; injectable so the evaluation and the suites supply their own. */
type BrowserLaunch = () => Promise<Browser>;

/**
 * Build the process's {@link BrowserProvider} (AAP 0.5.6).
 *
 * Nothing is launched here: the first {@link BrowserProvider.get} starts one headless Chromium, and
 * every later call returns that same instance, so a process that never renders a page never pays
 * for a browser. A browser that disconnected — a crash, an out-of-memory kill or someone else's
 * `close()` — is forgotten, so the next `get()` launches a fresh one instead of handing out a dead
 * handle.
 */
export function createBrowserProvider(opts: { launch?: BrowserLaunch } = {}): BrowserProvider {
  const launch = opts.launch ?? launchChromium;
  let browser: Browser | null = null;
  let launching: Promise<Browser> | null = null;
  const remember = (instance: Browser): Browser => {
    browser = instance;
    launching = null;
    instance.once('disconnected', () => {
      if (browser === instance) browser = null;
    });
    return instance;
  };
  return {
    async get(): Promise<Browser> {
      if (browser !== null) return browser;
      launching ??= launch();
      try {
        return remember(await launching);
      } catch (error) {
        // Nothing was launched, so the next call tries again rather than reusing a failed attempt.
        launching = null;
        throw error;
      }
    },
    async close(): Promise<void> {
      const inFlight = launching;
      const instance = browser ?? (inFlight === null ? null : await inFlight.catch(() => null));
      browser = null;
      launching = null;
      if (instance !== null) await instance.close().catch(() => undefined);
    },
  };
}

/** One rendering's outcome (AAP 0.5.6). */
export type RenderResult =
  | {
      kind: 'ok';
      /** The page's visible text, as `./extract-items.ts` reads it. */
      text: string;
      /** The main document's final URL, after every redirect `safeFetch` followed itself. */
      finalUrl: string;
      /** Same-domain menu documents linked from the page, to be fetched through `safeFetch`. */
      menuLinks: { pdfs: string[]; images: string[] };
    }
  | { kind: 'login_wall' }
  | {
      kind: 'failed';
      /**
       * Why the page could not be read: a {@link SafeFetchReason} that refused the main document,
       * or one of `navigation_failed` (the browser could not load it), `not_html` (the main document
       * is not a page) and `empty_page` (it rendered no visible text). The caller takes the phone
       * fallback for every one of them, so no price is guessed.
       */
      reason: string;
    };
/** What the route handler records about the main document, read once the navigation has settled. */
interface MainDocument {
  /** The final URL of the main document's answer, or `null` while none was fulfilled. */
  url: string | null;
  /** Its `Content-Type`, or `null` — also when it sent none. */
  contentType: string | null;
  /** Why the main document was refused, or `null` when it was permitted. */
  reason: SafeFetchReason | null;
}

/** The injected behaviour of {@link renderPage} (AAP 0.5.6). */
interface RenderDeps {
  /** The shared browser to render in. */
  browser: Pick<BrowserProvider, 'get'>;
  /** The policy-checked fetch every request of the page is fulfilled from. */
  safeFetch: SafeFetch;
  /** This place's crawl allowance, shared with the entry page and every document followed from it. */
  budget: FetchBudget;
  /** The `User-Agent` the context sends, from `./robots.ts` `crawlerUserAgent`. */
  userAgent: string;
  /** Where the render is recorded. */
  logger: Pick<Logger, 'info' | 'warn'>;
  /** How long the main navigation may take; 30,000 ms when omitted. */
  timeoutMs?: number;
}

/**
 * Render one menu page in a context that reaches the network only through `./safe-fetch.ts`, and
 * report either its visible text and its same-domain menu links or why it could not be read
 * (AAP 0.5.6).
 *
 * A new context per call keeps one place's cookies, storage and service-worker attempts out of the
 * next place's render, and it is closed in a `finally` — even when the page fails — so a crawl of
 * many places holds one context at a time.
 *
 * A browser that cannot be launched, or a context that cannot be created, throws instead of
 * returning: that is an operational failure of the process, which the job's own retry is for, not a
 * property of this place — answering `failed` for it would send every place to the paid phone
 * fallback.
 */
export async function renderPage(
  url: string,
  deps: {
    browser: Pick<BrowserProvider, 'get'>;
    safeFetch: SafeFetch;
    budget: FetchBudget;
    userAgent: string;
    logger: Pick<Logger, 'info' | 'warn'>;
    timeoutMs?: number;
  },
): Promise<RenderResult> {
  const result = await render(url, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  logRender(deps.logger, hostOf(url), result);
  return result;
}

/**
 * Render `url` and decide what the render was.
 */
async function render(url: string, deps: RenderDeps, timeoutMs: number): Promise<RenderResult> {
  const browser = await deps.browser.get();
  const context = await browser.newContext({
    // No worker may register, no download may be kept, and the crawler's own identity is sent.
    serviceWorkers: 'block',
    acceptDownloads: false,
    userAgent: deps.userAgent,
    javaScriptEnabled: true,
  });
  const main: MainDocument = { url: null, contentType: null, reason: null };
  let page: Page | null = null;
  /**
   * Fulfil one request of the page from `safeFetch`, so the browser opens no connection of its own.
   */
  const routeThrough = async (route: Route, request: Request): Promise<void> => {
    // Read before the fetch, so a refusal below can tell the main navigation from a subrequest.
    const navigatesMainFrame = page !== null && isMainNavigation(request, page);
    try {
      const method = request.method();
      if (method !== 'GET' && method !== 'HEAD') {
        await abort(route);
        return;
      }
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        await abort(route);
        return;
      }
      // The kind is the document's own, read by `menuUrlKind` from its URL — the pipeline's single
      // reading of a URL's kind, which `./menu-ingest.ts` picks its fetch path with. A PDF a frame
      // asks for is bounded by the PDF limit `safeFetch` applies to that kind, not by the page's own.
      const kind: FetchKind = menuUrlKind(request.url());
      const answer = await deps.safeFetch(request.url(), {
        kind,
        budget: deps.budget,
        method,
        headers: forwardedHeaders(request.headers()),
      });
      if (navigatesMainFrame) {
        main.url = answer.url;
        main.contentType = answer.contentType;
      }
      await route.fulfill(fulfillOptions(answer, method));
    } catch (error) {
      if (navigatesMainFrame) {
        main.reason = error instanceof SafeFetchError ? error.reason : 'network_error';
      }
      // The page or the context may be gone by now; the abort is the only thing left to try.
      await abort(route);
    }
  };
  try {
    // Both routes are registered before the page exists: Playwright routes only the WebSockets opened
    // after `routeWebSocket`, and `**\/*` matches the main navigation as well as every subrequest.
    await context.routeWebSocket('**/*', (socket) => socket.close().catch(() => undefined));
    await context.route('**/*', routeThrough);
    page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    } catch {
      // The navigation was refused by the route handler, so its recorded reason is the answer; a
      // navigation that failed without one (a crashed renderer, a refused resource type) is not.
      if (main.reason === 'auth_required') return { kind: 'login_wall' };
      // Chromium refuses to render a document that is not a page, so the navigation often fails before
      // the content-type check below is reached. Answering `not_html` for it keeps the caller's
      // decision the same either way: fetch it directly, as `menuUrlKind` decides.
      const refusedAsNotHtml = main.url !== null && !isHtml(main.contentType);
      if (refusedAsNotHtml) return { kind: 'failed', reason: 'not_html' };
      return { kind: 'failed', reason: main.reason ?? 'navigation_failed' };
    }
    // A page that keeps a poll or an analytics beacon open still renders its menu, so the wait is
    // best-effort: its timeout is ignored and the text is read regardless.
    await page
      .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS })
      .catch(() => undefined);
    if (main.url !== null && !isHtml(main.contentType)) {
      // The navigation loaded something that is not a page: a PDF or an image served at the page's own
      // URL is not rendered, so the caller fetches it directly as `menuUrlKind` decides.
      return { kind: 'failed', reason: 'not_html' };
    }
    const finalUrl = main.url ?? url;
    if (main.reason === 'auth_required' || (await isLoginWall(page, finalUrl))) {
      return { kind: 'login_wall' };
    }
    const text = await visibleText(page);
    if (text === null || text.trim() === '') return { kind: 'failed', reason: 'empty_page' };
    return { kind: 'ok', text, finalUrl, menuLinks: await collectMenuLinks(page, finalUrl) };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * The launch every render uses (AAP 0.3.1): one headless Chromium.
 *
 * The proxy at `127.0.0.1:9` is defence in depth. Every request the context issues is fulfilled by
 * the route handler, so a request that reaches the network at all is a bug in the interception;
 * pointed at the `discard` port it fails locally instead of handing the page an unfiltered
 * connection.
 */
async function launchChromium(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    proxy: { server: 'http://127.0.0.1:9' },
  });
}

/**
 * Whether a request is the main frame's own navigation, which is the document whose URL and content
 * type decide what was rendered. A frame's or a subresource's request leaves them alone.
 */
function isMainNavigation(request: Request, page: Page): boolean {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame();
  } catch {
    // A frame that was already detached has no answer to give, and its request is not the main one.
    return false;
  }
}

/**
 * Whether the page asks for a password or sits on a login path (AAP 0.5.6, "login redirects"). The
 * main document's own `auth_required` refusal is checked by the caller, before this.
 *
 * The password check runs in every frame, because a login wall is as often an embedded form as the
 * page itself; a frame that cannot be read counts as no password rather than as a wall.
 */
async function isLoginWall(page: Page, finalUrl: string): Promise<boolean> {
  if (LOGIN_PATH.test(pathPortionOf(finalUrl))) return true;
  const counts = await Promise.all(
    page.frames().map((frame) =>
      frame
        .locator('input[type="password"]')
        .count()
        .catch(() => 0),
    ),
  );
  return counts.some((count) => count > 0);
}

/**
 * The page's visible text, as the price extraction reads it (AAP 0.5.6, "takes its visible text").
 */
async function visibleText(page: Page): Promise<string | null> {
  try {
    return await page.locator('body').innerText({ timeout: TEXT_TIMEOUT_MS });
  } catch {
    // No body to read, or the page was torn down first: the caller reports an empty page.
    return null;
  }
}

/**
 * The same-domain menu documents the page links to: every menu PDF, and {@link MAX_MENU_IMAGES}
 * images, each absolute, deduplicated without its fragment, and each still to be fetched through
 * `safeFetch` by the caller.
 *
 * The PDFs carry no count of their own: AAP 0.5.6 bounds one place by 50 requests and 30 MiB, names
 * a count for images alone, and says same-domain links to menu documents "are followed", so a site
 * that splits its menu across several cards is reported in full rather than up to a fixed number of
 * documents. How many of them are read is bounded by the place's own shared `FetchBudget`, which
 * `safeFetch` enforces on the page, on its subrequests and on every document the caller follows.
 */
async function collectMenuLinks(
  page: Page,
  pageUrl: string,
): Promise<{ pdfs: string[]; images: string[] }> {
  // A page whose anchors cannot be read is still a page, so its text stands and no link is followed.
  const anchors = ANCHOR_LIST.safeParse(await page.evaluate(ANCHOR_EXPRESSION).catch(() => []));
  if (!anchors.success) return { pdfs: [], images: [] };
  const pdfs = new Set<string>();
  const images = new Set<string>();
  for (const [href, text] of anchors.data) {
    const kind = classifyMenuLink(href, text, pageUrl);
    if (kind === null) continue;
    const target = withoutFragment(href);
    if (target === null) continue;
    (kind === 'pdf' ? pdfs : images).add(target);
  }
  return {
    // No count bounds the PDFs: the place's own shared `FetchBudget` (50 requests, 30 MiB) is what
    // bounds how many documents the caller follows. Images are the one kind AAP 0.5.6 caps.
    pdfs: [...pdfs],
    images: [...images].slice(0, MAX_MENU_IMAGES),
  };
}

/**
 * Fulfil a route with a permitted answer. The body is left out for a HEAD request, whose answer has
 * none, and the content type only when the site sent one, so no absent field is written as absent.
 */
function fulfillOptions(answer: SafeFetchResponse, method: string): FulfillOptions {
  const options: FulfillOptions = { status: answer.status };
  if (method !== 'HEAD') options.body = answer.body;
  if (answer.contentType !== null) options.contentType = answer.contentType;
  return options;
}

/**
 * Abort a route, tolerating a page or context that closed first: a rejected abort is an unhandled
 * rejection inside the browser's own request pipeline, which nothing would catch.
 */
async function abort(route: Route): Promise<void> {
  await route.abort('blockedbyclient').catch(() => undefined);
}

/**
 * Record one render once, in the two lines an operator needs: the outcome with its counts, and the
 * reason a page was unusable.
 */
function logRender(
  logger: Pick<Logger, 'info' | 'warn'>,
  host: string | null,
  result: RenderResult,
): void {
  const links = result.kind === 'ok' ? result.menuLinks : null;
  logger.info({
    event: 'menu_render',
    host,
    outcome: result.kind,
    textChars: result.kind === 'ok' ? result.text.length : 0,
    pdfs: links?.pdfs.length ?? 0,
    images: links?.images.length ?? 0,
  });
  if (result.kind === 'failed') {
    // The code travels under `dropReason`, not `reason`: the logger's redaction list censors `reason`
    // (a dispute's free text), and a code that has to be read back is logged under a name it does not
    // cover (AAP 0.11.1).
    logger.warn({ event: 'menu_render_failed', host, dropReason: result.reason });
  }
}

/**
 * The headers a request of the page contributes, and no others: `./safe-fetch.ts` drops everything
 * outside its own forwarded set, so a page cannot hand the site a cookie or an authorization header
 * the crawl never earned.
 */
function forwardedHeaders(headers: Record<string, string>): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headers[name];
    if (value !== undefined) forwarded[name] = value;
  }
  return forwarded;
}

/**
 * Whether an answer is a page (AAP 0.5.6): `text/html` or `application/xhtml+xml`, either with
 * whatever charset or boundary a site appends.
 *
 * An answer with no `Content-Type` at all is read as a page rather than refused: what the page holds
 * is decided by the text that follows, and refusing it would lose a menu that a terse server does
 * serve.
 */
function isHtml(contentType: string | null): boolean {
  if (contentType === null) return true;
  const media = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return media === 'text/html' || media === 'application/xhtml+xml';
}

/**
 * The path of a URL, for the two decisions taken on it: the extension {@link menuUrlKind} reads and
 * the login path {@link isLoginWall} matches. A query and a fragment are dropped either way, so no
 * token in a query string can decide anything, and a value that is not a URL at all is read as the
 * path it looks like.
 */
function pathPortionOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

/**
 * The host of a URL, which is all a log line about it may carry: never a path, and never a query.
 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Parse a URL that a crawl could follow.
 */
function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The same URL without its fragment, so two links to one document are followed once.
 */
function withoutFragment(href: string): string | null {
  try {
    const url = new URL(href);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Decode a URL for a word test, leaving a malformed escape sequence as it was written rather than
 * throwing over a link that is only being classified.
 */
function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
