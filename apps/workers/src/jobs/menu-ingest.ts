/**
 * The `menu-ingest` queue: one place's menu read from its own website, and the city-wide fan-out that finds the places
 * whose online prices are missing or stale (AAP 0.5.1, 0.5.6, 0.5.7).
 *
 * The queue carries two job names. `ingest {placeId}` reads one place: the crawl policy decides its host before
 * anything is fetched, the entry document is read as a rendered page, a PDF (text layer or rasterized and OCR'd) or an
 * image, the text goes through the metered language-model extraction in at most three chunks of 60,000 characters,
 * every item passes the no-invention gate of `../menus/source-gate.ts`, and the survivors are converted at the capture
 * date's FX rate and stored as one `PriceRecord` batch. `ingest-city {cityId}` is the fan-out that
 * `POST /v1/admin/price-jobs` with `kind: "menus"` enqueues: it selects the city's places that have a website or a menu
 * link and no approved online price inside the 30-day freshness window, and queues one `ingest` job per place in the
 * call-and-menu priority order of AAP 0.5.7.
 *
 * Three properties keep a menu crawl from inventing a price: an item survives only when its `priceText` occurs in the
 * extracted text it came from and parses to the same positive amount, so criterion 11's "100% of extracted price
 * strings found in the source text" holds by construction (AAP 0.12.2); every way a place can fail to yield
 * `MIN_PRICED_ITEMS` priced items opens a `menu_prices` `CallTask` instead (AAP 0.5.6); and a refused reservation —
 * `LlmBudgetRefusedError` or `LlmSuspendedError`, the request was never sent — re-adds the place's job for 00:05 local
 * the next day, while every other language-model failure is left to the queue's three tries.
 *
 * Time comes from the injected clock and city-local reasoning from `nextLocalDayAt`/`localDateKey` (AAP 0.11.1); no
 * third-party call runs inside a transaction; and every raw read carries `fixturePredicate`, because raw SQL bypasses
 * the guarded client's fixture filter (AAP 0.5.2).
 */

import { randomUUID } from 'node:crypto';

import type { Queue } from 'bullmq';

import { Prisma, fixturePredicate, type DbClient, type DbTx } from '@tablemate/db';
import {
  JOB,
  LlmBudgetRefusedError,
  LlmSuspendedError,
  QUEUE,
  QueuePayloadError,
  isJobName,
  jobOptionsFor,
  localDateKey,
  nextLocalDayAt,
  parseJobData,
} from '@tablemate/server-core';
import {
  CallLanguage,
  FRESHNESS_ONLINE_DAYS,
  MIN_PRICED_ITEMS,
  SUGGESTION_RADIUS_METERS,
} from '@tablemate/shared';
import type { AppEnv, ExtractedMenuItem } from '@tablemate/shared';

import { menuPriority, nearLockedMeetupSql } from '../calls/priority.ts';
import { fxRateFor, toUsdCents } from '../fx/open-er-api.ts';
import { domainKey } from '../menus/blocklist.ts';
import {
  createPrismaCrawlPolicyStore,
  domainDecision,
  fallbackFor,
} from '../menus/crawl-policy.ts';
import { MAX_CHUNKS_PER_PLACE, chunkText, extractMenuItems } from '../menus/extract-items.ts';
import { menuUrlKind, renderPage } from '../menus/fetch-page.ts';
import {
  OCR_TIMEOUT_MS,
  OcrError,
  ocrImage,
  ocrLanguageFor,
  type OcrLanguage,
} from '../menus/ocr.ts';
import { PDF_MAX_PAGES, PdfTextError, extractPdfText, rasterizePdf } from '../menus/pdf-text.ts';
import { isPriceCurrency } from '../menus/price-parse.ts';
import { SafeFetchError, createFetchBudget, type FetchBudget } from '../menus/safe-fetch.ts';
import { gateItems } from '../menus/source-gate.ts';
// Type-only on purpose: `queues.ts` value-imports this file's `process`, so a value import back would close a runtime cycle.
import type { WorkerContext } from '../queues.ts';

const INGEST_JOB = JOB[QUEUE.menuIngest].ingest;
const INGEST_CITY_JOB = JOB[QUEUE.menuIngest].ingestCity;
const MENU_PRICES_KIND = 'menu_prices';
// Wall time a refused reservation moves its place's job to: 00:05 local the next day, the city's own next day (AAP 0.5.6). The counter it was refused against is the city's local day's, so the retry waits for that day to end.
const DEFERRAL_LOCAL_TIME = '00:05';
/** The advisory-lock key prefix that serializes one place's call-task creation (AAP 0.5.3). */
const MENU_TASK_LOCK_PREFIX = 'menu-task:';
// The one definition of "this place's `menu_prices` refresh is still outstanding", as a predicate over `call_task` aliased `t` (AAP 0.5.3, 0.5.6): `queued`, `in_progress`, `needs_review`, plus an `unreachable` task no operator has resolved, because an item already waiting in the queue would otherwise be duplicated by every weekly refresh. `IS DISTINCT FROM` rather than `<>` is deliberate: `resolved_by` is NULL on every unresolved task.
const OPEN_TASK_PREDICATE = Prisma.sql`(
        "t"."status" IN ('queued', 'in_progress', 'needs_review')
        OR ("t"."status" = 'unreachable' AND "t"."resolved_by" IS DISTINCT FROM 'operator')
      )`;
// {@link hasOpenMenuPricesTask} applies {@link OPEN_TASK_PREDICATE} to refuse a second task for one place, and `./price-freshness.ts` to leave a place whose refresh is in flight out of its page, so the two cannot drift apart.
export const OPEN_MENU_PRICES_TASK_PREDICATE: Prisma.Sql = OPEN_TASK_PREDICATE;
// The reason a place took the phone fallback, as the `menu_phone_fallback` log line carries it (AAP 0.5.6, 0.11.1): a `SafeFetchError`'s own reason travels verbatim, because it is the operator's evidence for the call.
type FallbackReason = string;
// What one place's ingestion reported (AAP 0.5.1, 0.5.6): `pricedItems` counts the rows this run stored and `queuedCall` whether it opened a phone-price task — not opposites, because a menu that yielded four items keeps all four and still takes the call. `deferred` is present only when a refused reservation moved the work to 00:05 local.
export interface PlaceIngestResult {
  readonly pricedItems: number;
  readonly queuedCall: boolean;
  readonly deferred?: boolean;
}

// What one city's fan-out reported (AAP 0.5.4, 0.5.6): how many `ingest` jobs it queued. A duplicate id for the same local day is suppressed by BullMQ.
export interface CityIngestResult {
  readonly enqueued: number;
}

// A structural subset of BullMQ's `Job`, so a test can call {@link process} with a plain object: the job id is `menu-ingest-<placeId>-<localDate>`, read for the log only, and the data is `{ placeId }` or `{ cityId }`.
export interface MenuIngestJob {
  readonly id?: string;
  readonly name: string;
  readonly data: unknown;
}

// One document whose text the extraction reads, with the URL it was fetched from (AAP 0.5.6): the entry URL or a menu document followed from it, and that document's own text — rendered page text, a PDF text layer or OCR output.
interface MenuSource {
  readonly url: string;
  readonly text: string;
}

// A place row as {@link ingestPlace} reads it: the link to fetch and the city whose rules apply.
interface MenuedPlace {
  readonly id: string;
  readonly isFixture: boolean;
  readonly website: string | null;
  readonly menuUrl: string | null;
  readonly city: {
    readonly id: string;
    readonly currency: string;
    readonly callLanguage: string;
    readonly timezone: string;
  };
}

// The canonical form of an item's name, which two captures of one dish are matched on (AAP 0.5.6): NFKC, lower-cased, every whitespace run collapsed and trimmed. `./call-results.ts` re-derives it and the seed writes its fixtures with it.
export function normalizeItemName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Adds `count` to `drops[key]`, creating the key on first use. A zero count writes nothing, so the object a place logs holds exactly the reasons that fired (AAP 0.11.1).
function bump(drops: Record<string, number>, key: string, count = 1): void {
  if (count === 0) {
    return;
  }
  drops[key] = (drops[key] ?? 0) + count;
}

/** Merges one extraction's drop counts into the run's, key by key. */
function mergeDrops(drops: Record<string, number>, counted: Record<string, number>): void {
  for (const [key, count] of Object.entries(counted)) {
    bump(drops, key, count);
  }
}

// Runs `work` in a transaction: the given client's own when one is already open, a fresh one otherwise (AAP 0.5.6). The type test is made defensively — the proxy may answer a property read with `undefined` or throw, and either answer means "already inside a transaction", which Prisma's deny-list would otherwise refuse.
async function inTransaction<T>(db: DbClient | DbTx, work: (tx: DbTx) => Promise<T>): Promise<T> {
  if (opensTransaction(db)) {
    return await db.$transaction(work);
  }
  return await work(db);
}

// Whether `db` is a full client rather than an open transaction. The test is defensive: a property read may answer `undefined` or throw, and either answer means the work simply joins the caller's unit of work.
function opensTransaction(db: DbClient | DbTx): db is DbClient {
  try {
    return typeof (db as { $transaction?: unknown }).$transaction === 'function';
  } catch {
    return false;
  }
}

// Opens the `menu_prices` call task for one place, unless one is already open (AAP 0.5.6): it is what carries a place
// without a usable online menu into the price pipeline, and `call-dispatch` reads it as the task it dials.
//
// Four facts shape it: `pg_advisory_xact_lock(hashtext('menu-task:<placeId>'))` serializes two concurrent ingestions of
// one place for the rest of the transaction; an open task is left alone ({@link OPEN_TASK_PREDICATE}); a `doNotCall`
// place gets no task at all; and a place without a phone still gets one, which `call-dispatch` moves straight to the
// operator queue as `unreachable` with `no_phone`. The task's `priority` is the same 1-10 number `enqueueMenuIngest`
// puts on the place's job, so a job and its fallback call are ordered by one rule.
export async function ensureMenuPricesTask(
  db: DbClient | DbTx,
  ctx: WorkerContext,
  placeId: string,
  now: Date,
): Promise<boolean> {
  return await inTransaction(db, async (tx) => {
    await lockMenuTaskCreation(tx, placeId);
    const inputs = await placePriorityInputs(tx, placeId, now, ctx.env.APP_ENV);
    if (inputs === null || inputs.doNotCall) {
      return false;
    }
    if (await hasOpenMenuPricesTask(tx, placeId)) {
      return false;
    }
    await tx.callTask.create({
      data: {
        kind: MENU_PRICES_KIND,
        placeId,
        status: 'queued',
        nextAttemptAt: now,
        priority: priorityForPlace(inputs),
      },
    });
    ctx.logger.info({ event: 'menu_phone_fallback', placeId });
    return true;
  });
}

/** The two inputs the call-and-menu priority rule reads (AAP 0.5.7). */
interface PriorityInputs {
  readonly nearestPartnerDistanceM: number | null;
  readonly nearLockedMeetup: boolean;
}

interface PlacePriorityInputs extends PriorityInputs {
  readonly doNotCall: boolean;
}

// Takes the per-place call-task creation lock for the rest of the transaction (AAP 0.5.3): it is released by the commit or the rollback, never by this file, so it cannot outlive the unit of work that took it.
async function lockMenuTaskCreation(tx: DbTx, placeId: string): Promise<void> {
  await tx.$queryRaw<{ lock: string }[]>(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${MENU_TASK_LOCK_PREFIX + placeId})::bigint)::text AS "lock"
  `);
}

// The place's priority inputs, or `null` when the guarded read finds no such place (AAP 0.5.2, 0.5.7): one statement answers all three questions `menuPriority` needs, with the fixture predicate in the `WHERE`.
async function placePriorityInputs(
  tx: DbTx,
  placeId: string,
  now: Date,
  appEnv: AppEnv,
): Promise<PlacePriorityInputs | null> {
  const rows = await tx.$queryRaw<
    { nearestPartnerDistanceM: number | null; nearLockedMeetup: boolean; doNotCall: boolean }[]
  >(Prisma.sql`
    SELECT "p"."nearest_partner_distance_m" AS "nearestPartnerDistanceM",
           "p"."do_not_call" AS "doNotCall",
           COALESCE(${nearLockedMeetupSql('p', now, appEnv)}, false) AS "nearLockedMeetup"
      FROM "place" AS "p"
     WHERE "p"."id" = ${placeId}::uuid
       AND ${fixturePredicate(appEnv, 'p')}
  `);
  return rows[0] ?? null;
}

// The BullMQ priority of a place, 1 through 10 (AAP 0.5.7). `lodgingOnly` — the distance absent or beyond the 2 km neighbourhood — places it after every venue-near place, whatever its meetups.
function priorityForPlace(inputs: PriorityInputs): number {
  return menuPriority({
    nearestPartnerDistanceM: inputs.nearestPartnerDistanceM,
    nearLockedMeetup: inputs.nearLockedMeetup,
    lodgingOnly:
      inputs.nearestPartnerDistanceM === null ||
      inputs.nearestPartnerDistanceM > SUGGESTION_RADIUS_METERS,
  });
}

/** Whether the place has a `menu_prices` task that is still outstanding (AAP 0.5.6). */
async function hasOpenMenuPricesTask(tx: DbTx, placeId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "t"."id"::text AS "id"
      FROM "call_task" AS "t"
     WHERE "t"."place_id" = ${placeId}::uuid
       AND "t"."kind" = 'menu_prices'
       AND ${OPEN_TASK_PREDICATE}
     LIMIT 1
  `);
  return rows.length > 0;
}

// The producer for the `menu-ingest` queue. A worker whose producer is missing is a configuration fault, not a property of a place: the throw reaches BullMQ rather than sending every place of a city to a paid call.
function menuIngestQueue(ctx: WorkerContext): Queue {
  const queue: Queue | undefined = ctx.queues.get(QUEUE.menuIngest);
  if (queue === undefined) {
    throw new Error('menu_ingest_queue_unavailable');
  }
  return queue;
}

// The custom id of one place's ingestion on one city-local day (AAP 0.3.2, 0.5.6): `-` separates and never `:`, which BullMQ refuses, and the local date is the place's own city's, so the id turns over at that city's midnight.
function menuIngestJobId(placeId: string, timezone: string, at: Date): string {
  return `menu-ingest-${placeId}-${localDateKey(timezone, at)}`;
}

interface PlaceJobRow {
  readonly id: string;
  readonly timezone: string;
  readonly nearestPartnerDistanceM: number | null;
  readonly nearLockedMeetup: boolean;
}

// Queues one `ingest` job per place, each in the call-and-menu priority order (AAP 0.5.6, 0.5.7). One raw statement reads every place's priority inputs and its city's zone, with `fixturePredicate` in the `WHERE`. The job id carries the place's own local date, which bounds one place to one ingestion per local day while tomorrow's id is new; `priority` is set on every job, because BullMQ runs an unprioritized job before every prioritized one.
export async function enqueueMenuIngest(
  ctx: WorkerContext,
  placeIds: readonly string[],
): Promise<number> {
  const wanted = [...new Set(placeIds)];
  if (wanted.length === 0) {
    return 0;
  }
  const now = ctx.clock.now();
  const rows = await ctx.db.$queryRaw<PlaceJobRow[]>(Prisma.sql`
    SELECT "p"."id"::text AS "id",
           "c"."timezone" AS "timezone",
           "p"."nearest_partner_distance_m" AS "nearestPartnerDistanceM",
           ${nearLockedMeetupSql('p', now, ctx.env.APP_ENV)} AS "nearLockedMeetup"
      FROM "place" AS "p"
      JOIN "city" AS "c" ON "c"."id" = "p"."city_id"
     WHERE "p"."id" = ANY(${wanted}::uuid[])
       AND ${fixturePredicate(ctx.env.APP_ENV, 'p')}
  `);
  if (rows.length === 0) {
    return 0;
  }
  const jobs = rows.map((row) => ({
    name: INGEST_JOB,
    data: { placeId: row.id },
    opts: jobOptionsFor(QUEUE.menuIngest, {
      jobId: menuIngestJobId(row.id, row.timezone, now),
      priority: priorityForPlace(row),
    }),
  }));
  const added = await menuIngestQueue(ctx).addBulk(jobs);
  ctx.logger.info({ event: 'menu_ingest_enqueued', places: rows.length, jobs: added.length });
  return added.length;
}

// Reads one place's menu and turns it into `PriceRecord` rows, or opens its phone fallback (AAP 0.5.1, 0.5.6).
//
// The order of the steps is the design: the place and its city are read through the guarded client, so a fixture row is
// invisible and a place that is gone reports nothing rather than failing the job; `menuUrl` wins over `website`; the
// crawl policy decides the host before a single byte is fetched, recording an `uncertain` domain for operator review
// and refusing a `prohibited` one; the documents are read under one 50-request/30 MiB budget for the place; extraction
// is bounded to three chunks of 60,000 characters across every source, so one menu cannot spend an unbounded share of
// its city's language-model day; every item passes the source gate; and one transaction writes the batch, with fewer
// than `MIN_PRICED_ITEMS` survivors keeping the rows and opening the phone fallback on top.
//
// A page or document that cannot be fetched or parsed is a property of the place and takes the fallback, while a
// failure of the process itself — a browser that will not launch, a database error — is rethrown so BullMQ retries it.
export async function ingestPlace(ctx: WorkerContext, placeId: string): Promise<PlaceIngestResult> {
  const now = ctx.clock.now();
  const place = await loadMenuedPlace(ctx, placeId);
  if (place === null) {
    return { pricedItems: 0, queuedCall: false };
  }
  const drops: Record<string, number> = {};
  const link = place.menuUrl ?? place.website;
  if (link === null) {
    return await takePhoneFallback(ctx, placeId, now, 'no_link', 0, drops);
  }
  const target = parseHttpUrl(link);
  if (target === null) {
    return await takePhoneFallback(ctx, placeId, now, 'bad_url', 0, drops);
  }
  const decision = await domainDecision(
    createPrismaCrawlPolicyStore(ctx.db),
    domainKey(target.hostname),
    now,
    ctx.blocklist,
  );
  if (fallbackFor(decision) === 'phone_fallback') {
    return await takePhoneFallback(ctx, placeId, now, `domain_${decision}`, 0, drops);
  }
  let sources: MenuSource[];
  try {
    sources = await collectMenuSources({
      ctx,
      target,
      ocrLanguage: resolveOcrLanguage(ctx, place),
      drops,
    });
  } catch (error) {
    if (!isDocumentFailure(error)) {
      throw error;
    }
    return await takePhoneFallback(ctx, placeId, now, documentFailureReason(error), 0, drops);
  }
  if (sources.length === 0) {
    return await takePhoneFallback(ctx, placeId, now, 'empty_text', 0, drops);
  }
  let stored: number;
  try {
    stored = await storeOnlinePrices({ ctx, place, now, sources, drops });
  } catch (error) {
    if (error instanceof LlmBudgetRefusedError || error instanceof LlmSuspendedError) {
      // The request was never sent, so nothing was spent and nothing was written: the whole place waits for its city's next local day.
      await deferPlaceIngestion(ctx, placeId, place.city.timezone, now);
      ctx.logger.warn({ event: 'menu_ingest_deferred', placeId, code: error.code });
      return { pricedItems: 0, queuedCall: false, deferred: true };
    }
    throw error;
  }
  if (stored >= MIN_PRICED_ITEMS) {
    logDrops(ctx, placeId, drops);
    return { pricedItems: stored, queuedCall: false };
  }
  return await takePhoneFallback(ctx, placeId, now, 'too_few_items', stored, drops);
}

/** The place and its city as {@link ingestPlace} reads them, or `null` when it is not visible. */
async function loadMenuedPlace(ctx: WorkerContext, placeId: string): Promise<MenuedPlace | null> {
  return await ctx.db.place.findUnique({
    where: { id: placeId },
    select: {
      id: true,
      isFixture: true,
      website: true,
      menuUrl: true,
      city: { select: { id: true, currency: true, callLanguage: true, timezone: true } },
    },
  });
}

// One place's link as an `http` or `https` URL, or `null` (AAP 0.5.6): an operator entry may hold anything, and `safeFetch` would refuse a non-web scheme only after a browser was launched, so the check is taken here.
function parseHttpUrl(link: string): URL | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

// The OCR language for one place (AAP 0.5.6): its city's `callLanguage`, or English when the stored value is not one of the five the pipeline knows, so a migrated row keeps the place readable instead of failing every one of its images.
function resolveOcrLanguage(ctx: WorkerContext, place: MenuedPlace): OcrLanguage {
  const language = CallLanguage.safeParse(place.city.callLanguage);
  if (language.success) {
    return ocrLanguageFor(language.data);
  }
  ctx.logger.warn({ event: 'menu_ocr_language_defaulted', cityId: place.city.id });
  return ocrLanguageFor(DEFAULT_CALL_LANGUAGE);
}

/** The fallback language of {@link resolveOcrLanguage}: the one every launch city also speaks. */
const DEFAULT_CALL_LANGUAGE: CallLanguage = 'en-US';
// A place's entry document that yields no text, raised for the phone fallback (AAP 0.5.6): it exists so that "this place has no usable menu" and "this process failed" stay distinguishable.
class MenuDocumentError extends Error {
  readonly reason: FallbackReason;
  constructor(reason: FallbackReason) {
    super(reason);
    this.name = 'MenuDocumentError';
    this.reason = reason;
  }
}

// The documents one place's menu is read from, in reading order (AAP 0.5.6): a `.pdf` entry is read as a PDF, an image extension is OCR'd, and anything else is rendered as a page whose same-domain menu links are then fetched through the same budget; a menu link that fails is skipped and counted, while the entry document's failure is the place's.
async function collectMenuSources(deps: {
  ctx: WorkerContext;
  target: URL;
  ocrLanguage: OcrLanguage;
  drops: Record<string, number>;
}): Promise<MenuSource[]> {
  const { ctx, target, ocrLanguage, drops } = deps;
  const budget = createFetchBudget();
  const entry = target.href;
  const kind = menuUrlKind(entry);
  if (kind === 'pdf') {
    return singleSource(entry, await readPdfSource(ctx, entry, budget, ocrLanguage));
  }
  if (kind === 'image') {
    return singleSource(entry, await readImageSource(ctx, entry, budget, ocrLanguage));
  }
  const render = await renderPage(entry, {
    browser: ctx.browser,
    safeFetch: ctx.safeFetch,
    budget,
    // Read off the environment rather than composed again: `env.crawlerUserAgent` is the identical string `robots.ts` builds from `CRAWLER_CONTACT_URL`.
    userAgent: ctx.env.crawlerUserAgent,
    logger: ctx.logger,
  });
  if (render.kind === 'login_wall') {
    throw new MenuDocumentError('login_wall');
  }
  if (render.kind === 'failed') {
    throw new MenuDocumentError(render.reason);
  }
  const sources: MenuSource[] = [];
  const pageText = render.text.trim();
  if (pageText !== '') {
    sources.push({ url: render.finalUrl, text: pageText });
  }
  for (const href of render.menuLinks.pdfs) {
    const text = await followedLink(() => readPdfSource(ctx, href, budget, ocrLanguage), drops);
    if (text !== null && text.trim() !== '') {
      sources.push({ url: href, text });
    }
  }
  for (const href of render.menuLinks.images) {
    const text = await followedLink(() => readImageSource(ctx, href, budget, ocrLanguage), drops);
    if (text !== null && text.trim() !== '') {
      sources.push({ url: href, text });
    }
  }
  return sources;
}

function singleSource(url: string, text: string): MenuSource[] {
  return text.trim() === '' ? [] : [{ url, text }];
}

// Reads one document linked from a rendered page, counting a refusal instead of failing the place (AAP 0.5.6). The link has already passed `safeFetch`'s own checks, so a refusal here is one of those or a document that will not parse, and the drop count is what tells an operator a menu was partly unreadable.
async function followedLink(
  read: () => Promise<string>,
  drops: Record<string, number>,
): Promise<string | null> {
  try {
    return await read();
  } catch {
    bump(drops, 'link_refused');
    return null;
  }
}

// A PDF's text: its own text layer, or OCR of its rasterized pages when it has none (AAP 0.5.6): a scanned menu PDF is the normal case for a photographed card, and both calls carry the same page bound.
async function readPdfSource(
  ctx: WorkerContext,
  url: string,
  budget: FetchBudget,
  language: OcrLanguage,
): Promise<string> {
  const response = await ctx.safeFetch(url, { kind: 'pdf', budget });
  const extracted = await extractPdfText(response.body, { maxPages: PDF_MAX_PAGES });
  if (extracted.hasTextLayer) {
    return extracted.text;
  }
  const pages = await rasterizePdf(response.body, {
    maxPages: PDF_MAX_PAGES,
    timeoutMs: OCR_TIMEOUT_MS,
  });
  const texts: string[] = [];
  for (const page of pages) {
    texts.push(await ocrImage(page, { language, timeoutMs: OCR_TIMEOUT_MS }));
  }
  return texts.join('\n\n');
}

/** An image menu's text, read by Tesseract in the city's own language (AAP 0.5.6). */
async function readImageSource(
  ctx: WorkerContext,
  url: string,
  budget: FetchBudget,
  language: OcrLanguage,
): Promise<string> {
  const response = await ctx.safeFetch(url, { kind: 'image', budget });
  return await ocrImage(response.body, { language, timeoutMs: OCR_TIMEOUT_MS });
}

/** Whether an error is a property of the place rather than a failure of the process. */
function isDocumentFailure(
  error: unknown,
): error is MenuDocumentError | SafeFetchError | PdfTextError | OcrError {
  return (
    error instanceof MenuDocumentError ||
    error instanceof SafeFetchError ||
    error instanceof PdfTextError ||
    error instanceof OcrError
  );
}

// The fallback reason of a document failure (AAP 0.5.6): a refusal keeps its own reason, because it is the operator's evidence for the call, while a permitted document that could not be parsed is reported as `parse_failed`.
function documentFailureReason(
  error: MenuDocumentError | SafeFetchError | PdfTextError | OcrError,
): FallbackReason {
  if (error instanceof SafeFetchError) {
    return error.reason;
  }
  return error instanceof MenuDocumentError ? error.reason : 'parse_failed';
}

// Extracts one place's sources, gates and converts the items, and stores the survivors as one batch (AAP 0.5.6).
//
// The per-place bound is spent across every source in reading order: the chunks of each source are measured with
// `chunkText`, only as many as are still within the three-chunk allowance are sent, and the ones refused are counted as
// `chunk_limit`. The allowed chunks are joined back into one string, a prefix of that source's own text, so
// `extractMenuItems` re-derives exactly those chunks. `chunkText` additionally bounds a single source at the same three
// chunks, so a longer source loses its tail, counted as `text_truncated` one per source: both counters are what tells an
// operator that a long menu was only partly read.
//
// A source's items are grouped by upper-cased currency before the gate, so a currency the pipeline holds no rate for is
// a `currency_unsupported` drop rather than an unparseable price. The gate is the last word: an item whose `priceText`
// is not in the text it came from is dropped, which is criterion 11's 100% guarantee (AAP 0.12.2), and nothing is
// written before the whole place has been read.
async function storeOnlinePrices(deps: {
  ctx: WorkerContext;
  place: MenuedPlace;
  now: Date;
  sources: readonly MenuSource[];
  drops: Record<string, number>;
}): Promise<number> {
  const { ctx, place, now, sources, drops } = deps;
  const captureBatchId = randomUUID();
  const captureDate = utcDate(now);
  const rates = new Map<string, { date: string; usdPerUnit: Prisma.Decimal } | null>();
  const rows: Prisma.PriceRecordCreateManyInput[] = [];
  let chunksLeft = MAX_CHUNKS_PER_PLACE;
  for (const source of sources) {
    const chunks = chunkText(source.text);
    if (chunks.length === 0) {
      continue;
    }
    const allowed = chunks.slice(0, chunksLeft);
    if (allowed.length < chunks.length) {
      bump(drops, 'chunk_limit', chunks.length - allowed.length);
    }
    if (allowed.length === 0) {
      continue;
    }
    chunksLeft -= allowed.length;
    // `chunkText` bounds one source's own text at the same three chunks, so a longer source loses its tail before this loop can count it. Comparing what is sent with the source is the only way to see that loss.
    const text = allowed.join('');
    if (text.length < source.text.trim().length) {
      bump(drops, 'text_truncated');
    }
    const extraction = await extractMenuItems(text, {
      llm: ctx.llm,
      spend: ctx.spend,
      cityId: place.city.id,
      currency: place.city.currency,
      logger: ctx.logger,
    });
    mergeDrops(drops, extraction.drops);
    for (const [currency, items] of groupByCurrency(extraction.items)) {
      if (!isPriceCurrency(currency)) {
        bump(drops, 'currency_unsupported', items.length);
        continue;
      }
      const gated = gateItems(items, source.text, place.city.currency);
      bump(drops, 'not_in_source', gated.drops.not_in_source);
      bump(drops, 'unparseable', gated.drops.unparseable);
      let rate = rates.get(currency);
      if (rate === undefined) {
        // Read once per currency per run: one capture date and one code always convert to the same cents. A currency with no row reaching back to the capture date cannot be converted at all, so the place is called instead.
        rate = await fxRateFor(ctx.db, currency, captureDate);
        rates.set(currency, rate);
      }
      if (rate === null) {
        bump(drops, 'currency_unsupported', gated.kept.length);
        continue;
      }
      for (const item of gated.kept) {
        rows.push({
          placeId: place.id,
          captureBatchId,
          itemName: item.name,
          normalizedName: normalizeItemName(item.name),
          itemCategory: item.category,
          alcoholic: item.alcoholic,
          perPerson: item.perPerson,
          ticketType: item.ticketType,
          priceText: item.priceText,
          localAmountMinor: item.localAmountMinor,
          currency,
          priceUsdCents: toUsdCents(item.localAmountMinor, currency, rate.usdPerUnit),
          source: 'online_menu',
          sourceUrl: source.url,
          capturedAt: now,
          // Prisma types a `@db.Date` column as a DateTime and refuses a bare `YYYY-MM-DD`, so the rate's own day is passed as its UTC midnight, whatever zone the process runs in.
          fxDate: new Date(`${rate.date}T00:00:00.000Z`),
          confidence: null,
          reviewStatus: 'approved',
          isFixture: place.isFixture,
        });
      }
    }
  }
  if (rows.length === 0) {
    return 0;
  }
  await ctx.db.$transaction(async (tx) => {
    await tx.priceRecord.createMany({ data: rows });
  });
  ctx.logger.info({ event: 'menu_prices_stored', placeId: place.id, items: rows.length });
  return rows.length;
}

// The extracted items grouped by their upper-cased ISO 4217 currency (AAP 0.5.6): a menu may print a foreign price, and the pipeline converts only the currencies it holds rates for. Grouping before the gate keeps the support check ahead of it, so an unsupported currency is counted as `currency_unsupported` rather than as an unparseable price.
function groupByCurrency(items: readonly ExtractedMenuItem[]): Map<string, ExtractedMenuItem[]> {
  const groups = new Map<string, ExtractedMenuItem[]>();
  for (const item of items) {
    const currency = item.currency.toUpperCase();
    const group = groups.get(currency);
    if (group === undefined) {
      groups.set(currency, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

/** The UTC calendar date of `at`, `YYYY-MM-DD`: the day a captured price converts at (AAP 0.5.6). */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// Opens the place's phone fallback and reports why, in one place (AAP 0.5.6): every path that leaves a place without a usable online menu comes through here, so the log line and the task are written by one function.
async function takePhoneFallback(
  ctx: WorkerContext,
  placeId: string,
  now: Date,
  reason: FallbackReason,
  pricedItems: number,
  drops: Record<string, number>,
): Promise<PlaceIngestResult> {
  const queuedCall = await ensureMenuPricesTask(ctx.db, ctx, placeId, now);
  ctx.logger.info({ event: 'menu_phone_fallback', placeId, fallbackReason: reason });
  logDrops(ctx, placeId, drops);
  return { pricedItems, queuedCall };
}

// Re-adds one place's ingestion for 00:05 local the next day (AAP 0.5.6). The refusal reaching here is the city's own local day's budget being exhausted, so the retry waits for that day to end rather than burning the queue's three tries; the job id carries the local date it is deferred to, and the priority is read again from the place.
async function deferPlaceIngestion(
  ctx: WorkerContext,
  placeId: string,
  timezone: string,
  now: Date,
): Promise<void> {
  const deferUntil = nextLocalDayAt(timezone, now, DEFERRAL_LOCAL_TIME);
  const inputs = await placePriorityInputs(ctx.db, placeId, now, ctx.env.APP_ENV);
  await menuIngestQueue(ctx).add(
    INGEST_JOB,
    { placeId },
    jobOptionsFor(QUEUE.menuIngest, {
      jobId: menuIngestJobId(placeId, timezone, deferUntil),
      delay: Math.max(0, deferUntil.getTime() - ctx.clock.nowMs()),
      priority: priorityForPlace(inputs ?? UNREADABLE_PLACE_INPUTS),
    }),
  );
}

// The priority inputs of a place the guarded read can no longer return: the last band with no locked meetup puts its deferred job behind every place the queue can still rank (AAP 0.5.7).
const UNREADABLE_PLACE_INPUTS: PriorityInputs = {
  nearestPartnerDistanceM: null,
  nearLockedMeetup: false,
};
// Records the run's drop counts, once per place (AAP 0.11.1). Only reasons that occurred are written, so a place that dropped nothing logs nothing; counts, ids and reason codes only — never page text, an item name or a price.
function logDrops(ctx: WorkerContext, placeId: string, drops: Record<string, number>): void {
  if (Object.keys(drops).length === 0) {
    return;
  }
  ctx.logger.info({ event: 'menu_pipeline_drops', placeId, drops });
}

// Queues one `ingest` job per place of a city whose online prices are missing or stale (AAP 0.5.4, 0.5.6). A place qualifies when it has a website or a menu link and holds no approved `online_menu` record captured inside the 30-day freshness window that `suggestions` reads prices by, so the fan-out re-reads exactly what the pipeline cannot serve from; `review_status` is part of the test. Both raw reads carry `fixturePredicate`.
async function ingestCity(ctx: WorkerContext, cityId: string): Promise<CityIngestResult> {
  const now = ctx.clock.now();
  const rows = await ctx.db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "p"."id"::text AS "id"
      FROM "place" AS "p"
     WHERE "p"."city_id" = ${cityId}
       AND ("p"."website" IS NOT NULL OR "p"."menu_url" IS NOT NULL)
       AND NOT EXISTS (
             SELECT 1
               FROM "price_record" AS "pr"
              WHERE "pr"."place_id" = "p"."id"
                AND "pr"."source" = 'online_menu'
                AND "pr"."review_status" = 'approved'
                AND "pr"."captured_at" >=
                    ${now}::timestamptz - ${FRESHNESS_ONLINE_DAYS}::int * interval '1 day'
                AND ${fixturePredicate(ctx.env.APP_ENV, 'pr')}
           )
       AND ${fixturePredicate(ctx.env.APP_ENV, 'p')}
     ORDER BY "p"."nearest_partner_distance_m" ASC NULLS LAST, "p"."id" ASC
  `);
  const enqueued = await enqueueMenuIngest(
    ctx,
    rows.map((row) => row.id),
  );
  ctx.logger.info({ event: 'menu_ingest_city', cityId, enqueued });
  return { enqueued };
}

// Runs one `menu-ingest` job (AAP 0.5.6). The job name is narrowed with `isJobName` before the data is parsed: a name this queue does not accept, or data that does not match its schema, fails here rather than reaching a rule.
export async function process(job: MenuIngestJob, ctx: WorkerContext): Promise<unknown> {
  const queue = QUEUE.menuIngest;
  if (!isJobName(queue, job.name)) {
    throw new QueuePayloadError(`${queue}/${job.name}`);
  }
  switch (job.name) {
    case INGEST_JOB: {
      const { placeId } = parseJobData(queue, job.name, job.data);
      return await ingestPlace(ctx, placeId);
    }
    case INGEST_CITY_JOB: {
      const { cityId } = parseJobData(queue, job.name, job.data);
      return await ingestCity(ctx, cityId);
    }
  }
}
