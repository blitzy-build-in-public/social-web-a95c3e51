/**
 * Site-terms decisions per domain for the menu crawler (AAP 0.5.6).
 *
 * Nothing here reads a site's terms. Phrase matching over a terms page can never establish
 * permission, and every unmatched site would need operator review anyway, so an operator's decision
 * — recorded through `PATCH /v1/admin/crawl-domains/:domain` (AAP 0.5.4) — is the only thing that
 * makes a domain `allowed`; reading terms automatically is out of scope (AAP 0.7.2).
 *
 * The rules applied here:
 *
 * - A host that is itself a public suffix (`com.ar`, `co.nz`, `co.uk`) is refused `prohibited`, and
 *   no row is written for it: it has no site of its own to judge, and a row keyed on it would stand
 *   for every site beneath it ({@link isPublicSuffix}).
 * - A domain named by `config/crawl-blocklist.json`, or a subdomain of one, is `prohibited` with
 *   reason `blocklist`. The configured list outranks an earlier operator decision, because the
 *   blocklist names aggregator, delivery and review sites the pipeline never fetches.
 * - Any other domain is recorded `uncertain` with reason `awaiting_review` *before* its first menu
 *   fetch, so `GET /v1/admin/crawl-domains` lists it for an operator. Nothing is fetched while it
 *   stays `uncertain`.
 * - A decision, once recorded, is not rechecked automatically: only the blocklist, and an operator
 *   acting through the review route, ever change one.
 * - `prohibited` and `uncertain` both leave the place to the phone fallback ({@link fallbackFor}),
 *   so the pipeline never invents a price and never reads a page it has no permission for.
 *
 * A decision is taken on the *registrable domain* ({@link registrableDomain}) wherever an operator
 * would take it, so one entry covers a site and its subdomains; a row for a more specific host
 * outranks it. That is how the seed grants `allowed` to the local fixture hosts, whose names
 * (`lisbon.fixture.test`, `127.0.0.1`) are not the domain of any real site (AAP 0.5.6).
 *
 * Everything with an effect is injected: {@link CrawlPolicyStore} owns the rows, so a suite passes
 * an in-memory store and needs no database; the time arrives as `now` or through the injected
 * {@link Clock} (AAP 0.11.1); and the blocklist is loaded once, at startup, by `./blocklist.ts`.
 * There is no network call, no clock read and no logging here.
 *
 * {@link domainKey} and `isBlocklisted` are defined in `./blocklist.ts`, which this module imports,
 * and the host key is re-exported below so `import { domainKey } from './crawl-policy.ts'` keeps
 * working for every consumer of this folder.
 *
 * @see AAP 0.5.6 for the site-terms policy and the phone fallback, 0.5.4 for the review routes,
 *   0.5.2 for the `CrawlDomainPolicy` model, and 0.8.1 for this file.
 */

import { isIP } from 'node:net';

import type { DbClient, DbTx } from '@tablemate/db';
import type { Clock } from '@tablemate/server-core';
import type { CrawlDecision } from '@tablemate/shared';

import { domainKey, domainSuffixes, isBlocklisted } from './blocklist.ts';
import type { Blocklist } from './blocklist.ts';

export { domainKey } from './blocklist.ts';

/**
 * The multi-label suffixes a registrable domain may end in (AAP 0.5.6): the ones the launch cities'
 * countries need, plus the Portuguese, British, Australian and Brazilian sites the crawler meets.
 *
 * Deliberately a small embedded set rather than a public-suffix dependency, which the dependency
 * inventory does not include (AAP 0.4.1). It is read together with {@link SUFFIX_CATEGORY_LABELS}:
 * between them they name an entry of this set, or a category label under a two-letter country code —
 * `com.mx` here, `com.ar` and `co.nz` from the category rule. A suffix outside both would make a
 * registrable domain the public suffix itself, which is the one value no decision may be recorded
 * against, because a row keyed on it would stand for every site beneath it. That is why
 * {@link domainDecision} refuses a host that is itself a public suffix ({@link isPublicSuffix})
 * instead of recording a row for it.
 */
export const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'ac.th',
  'co.id',
  'co.th',
  'co.uk',
  'com.au',
  'com.br',
  'com.co',
  'com.mx',
  'com.pt',
  'in.th',
  'my.id',
  'net.co',
  'or.id',
  'or.th',
  'org.co',
  'web.id',
]);

/**
 * The labels a registry uses as a second-level category under a country code (AAP 0.5.6), which is
 * what makes `<category>.<cc>` a public suffix: `com.ar`, `co.nz`, `com.tr`, `com.sg` and `co.za`
 * are places a registry sells registrations under, so a site's own domain is the label before them.
 *
 * The generic categories (`com`, `net`, `org`, `edu`, `gov`, `mil`, `co`, `biz`, `info`, `name`,
 * `pro`, `firm`, `gen`, `ind`, `web`, …) are here beside the national and provincial ones (`govt`,
 * `gouv`, `gob`, `or`, `ne`, `gr`, `lg`, `muni`, `sch`, `k12`, …). A category missing from the set
 * leaves its suffix unrecognised, and the derived domain collapses onto that suffix — the state
 * {@link domainDecision} refuses — so a label is only ever removed from this list by widening what
 * one row would cover.
 */
const SUFFIX_CATEGORY_LABELS: ReadonlySet<string> = new Set([
  'ac',
  'ad',
  'asn',
  'assn',
  'biz',
  'co',
  'com',
  'conf',
  'corp',
  'ed',
  'edu',
  'firm',
  'gen',
  'go',
  'gob',
  'gov',
  'gouv',
  'govt',
  'gr',
  'health',
  'hs',
  'in',
  'ind',
  'info',
  'kiwi',
  'k12',
  'lg',
  'ltd',
  'med',
  'mil',
  'muni',
  'my',
  'name',
  'ne',
  'net',
  'nom',
  'or',
  'org',
  'per',
  'plc',
  'pro',
  're',
  'res',
  'sch',
  'school',
  'sc',
  'sport',
  'travel',
  'web',
]);

/** A two-letter country code as it appears in a lower-cased key (AAP 0.5.6). */
const COUNTRY_CODE_LABEL = /^[a-z]{2}$/;

/**
 * Whether the last two labels of a key are a public suffix (AAP 0.5.6): a
 * {@link MULTI_LABEL_SUFFIXES} entry, or a {@link SUFFIX_CATEGORY_LABELS} category under a two-letter
 * country code.
 *
 * Keys arrive from {@link domainKey}, so they are lower case already and no country code is missed
 * for its case.
 *
 * @param lastTwo The key's last two labels, dot-joined.
 * @returns True when a registrable domain sits one label above them.
 */
function isPublicSuffix(lastTwo: string): boolean {
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return true;
  }

  const dot = lastTwo.indexOf('.');

  return (
    dot !== -1 &&
    SUFFIX_CATEGORY_LABELS.has(lastTwo.slice(0, dot)) &&
    COUNTRY_CODE_LABEL.test(lastTwo.slice(dot + 1))
  );
}

/**
 * The registrable domain of a host (AAP 0.5.6): its last two labels, or its last three when the last
 * two are a public suffix ({@link isPublicSuffix}) — `menu.example.com.mx` yields `example.com.mx`,
 * `menu.someplace.com.ar` yields `someplace.com.ar` and `lisbon.fixture.test` yields `fixture.test`.
 *
 * This is the value `CrawlDomainPolicy.domain` is keyed by (AAP 0.5.2): a row, the review queue and an
 * operator's decision are all scoped to it, so deriving it one label short would let one decision
 * stand for every site beneath a public suffix.
 *
 * An IP literal and a single-label host yield themselves, because neither has a registrable domain:
 * a fixture host reached as `127.0.0.1` is then keyed exactly as the seed recorded it. A host with no
 * label before its suffix yields the key itself — `com.ar` derives `com.ar` — because there is no
 * site above the suffix to name; {@link domainDecision} refuses such a host rather than recording it.
 *
 * @param host A host name, a registrable domain or an IP literal, with or without brackets.
 * @returns The domain an operator decision and the review queue are scoped to.
 */
export function registrableDomain(host: string): string {
  const key = domainKey(host);
  const labels = key.split('.');

  if (isIP(key) !== 0 || labels.length < 2) {
    return key;
  }

  const lastTwo = labels.slice(-2).join('.');
  const lastThree = labels.length >= 3 ? labels.slice(-3).join('.') : lastTwo;

  return isPublicSuffix(lastTwo) ? lastThree : lastTwo;
}

/** The reason recorded on a row the configured blocklist produced (AAP 0.5.6). */
export const REASON_BLOCKLIST = 'blocklist';

/** The reason recorded on a row awaiting an operator's site-terms judgement (AAP 0.5.6). */
export const REASON_AWAITING_REVIEW = 'awaiting_review';

/** One recorded decision, as {@link CrawlPolicyStore.find} reads it back (AAP 0.5.2). */
export interface CrawlPolicyRow {
  /** The domain the row is keyed by: a registrable domain, or an exact host the seed recorded. */
  domain: string;
  /** The decision in force for that domain. */
  decision: CrawlDecision;
}

/**
 * The persistence {@link domainDecision} needs (AAP 0.5.6), kept to three methods so a test passes
 * an in-memory implementation and exercises the routing rules without PostgreSQL.
 */
export interface CrawlPolicyStore {
  /**
   * Reads the rows recorded for the given domains.
   *
   * @param domains The candidate domains, most specific first.
   * @returns The rows that exist; a domain with none is absent from the result rather than `null`.
   */
  find(domains: readonly string[]): Promise<CrawlPolicyRow[]>;
  /**
   * Records `prohibited` for a domain, replacing whatever decision stood there: a blocklisted
   * domain is never fetched, however an operator decided it before.
   */
  upsertProhibited(domain: string, reason: string, now: Date): Promise<void>;
  /**
   * Records `uncertain` / {@link REASON_AWAITING_REVIEW} for a domain unless a row already exists,
   * so an operator's decision and a concurrent insert both survive.
   */
  insertUncertain(domain: string, now: Date): Promise<void>;
}

/**
 * Builds the PostgreSQL-backed {@link CrawlPolicyStore} over the `CrawlDomainPolicy` model
 * (AAP 0.5.2). The caller passes the guarded client, or the transaction it is already in, so a
 * decision can be taken inside a larger unit of work.
 *
 * `find` selects `domain` and `decision` alone: `reason`, `checkedAt` and `overriddenBy` belong to
 * the review screen, and a crawler that never loads them cannot put them in a log.
 *
 * @param db The Prisma client or transaction from `@tablemate/db`.
 * @returns The store {@link domainDecision} and `./safe-fetch.ts` consult.
 */
export function createPrismaCrawlPolicyStore(db: DbClient | DbTx): CrawlPolicyStore {
  return {
    async find(domains: readonly string[]): Promise<CrawlPolicyRow[]> {
      return db.crawlDomainPolicy.findMany({
        where: { domain: { in: [...domains] } },
        select: { domain: true, decision: true },
      });
    },

    async upsertProhibited(domain: string, reason: string, now: Date): Promise<void> {
      await db.crawlDomainPolicy.upsert({
        where: { domain },
        create: { domain, decision: 'prohibited', reason, checkedAt: now },
        update: { decision: 'prohibited', reason, checkedAt: now, overriddenBy: null },
      });
    },

    async insertUncertain(domain: string, now: Date): Promise<void> {
      await db.crawlDomainPolicy.createMany({
        data: [{ domain, decision: 'uncertain', reason: REASON_AWAITING_REVIEW, checkedAt: now }],
        skipDuplicates: true,
      });
    },
  };
}

/**
 * The domains {@link domainDecision} consults for a host, most specific first (AAP 0.5.6): every
 * label-wise suffix down to the registrable domain, so an exact-host row outranks the row of the
 * site it belongs to. An IP literal or a single-label host yields itself alone.
 */
function decisionChain(key: string, registrable: string): string[] {
  const registrableLabels = registrable.split('.').length;

  return domainSuffixes(key).filter((suffix) => suffix.split('.').length >= registrableLabels);
}

/**
 * Decides whether a host may be fetched (AAP 0.5.6), and records what was decided, in this order:
 *
 * 1. A host that is itself a public suffix is `prohibited`, and no row is written for it.
 * 2. The configured blocklist, and every row for the host's chain, are read. A blocklisted host is
 *    `prohibited`; a `blocklist` row is written at its registrable domain unless one already says
 *    so, and the decision is returned whatever any other row says.
 * 3. Otherwise the first row in chain order decides — an exact-host row before a registrable-domain
 *    row — so a domain an operator approved is honoured for its subdomains.
 * 4. With no row at all, the registrable domain is inserted `uncertain` / `awaiting_review`
 *    *before* the decision is returned, so the review queue holds it from the first fetch attempt
 *    and the caller, which never fetches on `uncertain`, cannot race past it.
 *
 * An existing decision is only ever overwritten by step 2: an operator's `allowed` stands until an
 * operator changes it, and the decision is never rechecked automatically.
 *
 * @param store The recorded decisions.
 * @param host The host of the request, from the URL about to be fetched.
 * @param now The time to record on a row this call writes, from the injected clock (AAP 0.11.1).
 * @param blocklist The blocklist `./blocklist.ts` loaded at startup.
 * @returns `allowed`, `prohibited` or `uncertain`.
 */
export async function domainDecision(
  store: CrawlPolicyStore,
  host: string,
  now: Date,
  blocklist: Blocklist,
): Promise<CrawlDecision> {
  const key = domainKey(host);

  // A public-suffix host is no site at all: `com.ar`, `co.nz` and `co.uk` are where a registry places
  // registrations, so a row keyed on one would stand for every site beneath it, and an operator's
  // `allowed` would cover all of them with none of their own terms read. Refused without a row, so
  // the review queue never offers that decision either, and the place takes the phone fallback.
  if (key.split('.').length === 2 && isPublicSuffix(key)) {
    return 'prohibited';
  }

  const registrable = registrableDomain(key);
  const chain = decisionChain(key, registrable);
  const rows = await store.find(chain);
  const recorded = new Map(rows.map((row): [string, CrawlDecision] => [row.domain, row.decision]));

  if (isBlocklisted(key, blocklist)) {
    if (recorded.get(registrable) !== 'prohibited') {
      await store.upsertProhibited(registrable, REASON_BLOCKLIST, now);
    }

    return 'prohibited';
  }

  for (const candidate of chain) {
    const decision = recorded.get(candidate);

    if (decision !== undefined) {
      return decision;
    }
  }

  await store.insertUncertain(registrable, now);

  return 'uncertain';
}

/**
 * Binds a store, a clock and a blocklist into the `policy` function `./safe-fetch.ts` calls before
 * every request the pipeline makes (AAP 0.5.6): the entry URL, each redirect target, each followed
 * menu link and each browser request. `queues.ts` builds it once at startup, and the menu
 * evaluation passes `async () => 'allowed'` instead, because its fixture sites are local.
 *
 * The clock is read per call rather than captured, so a test clock moved between two fetches moves
 * the `checkedAt` the store records.
 *
 * @param deps The store, the injected clock and the loaded blocklist.
 * @returns A policy taking a host and answering `allowed`, `prohibited` or `uncertain`.
 */
export function createDomainPolicy(deps: {
  store: CrawlPolicyStore;
  clock: Clock;
  blocklist: Blocklist;
}): (host: string) => Promise<CrawlDecision> {
  return (host) => domainDecision(deps.store, host, deps.clock.now(), deps.blocklist);
}

/**
 * What a host's decision leaves the pipeline to do (AAP 0.5.6): fetch it, or queue the phone
 * fallback. `prohibited` and `uncertain` both take the fallback, because a domain whose terms have
 * not been approved is crawled no more than one that forbids the crawl, and a place left without an
 * online menu is called rather than given a guessed price.
 *
 * The switch is exhaustive over `CrawlDecision`, so a decision added to the contract fails the
 * build here instead of silently reaching a default.
 *
 * @param decision The decision {@link domainDecision} returned for the host.
 * @returns `fetch` for `allowed`, `phone_fallback` otherwise.
 */
export function fallbackFor(decision: CrawlDecision): 'fetch' | 'phone_fallback' {
  switch (decision) {
    case 'allowed':
      return 'fetch';
    case 'prohibited':
    case 'uncertain':
      return 'phone_fallback';
  }
}
