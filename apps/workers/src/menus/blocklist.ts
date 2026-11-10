/**
 * Crawl blocklist and host normalization (AAP 0.5.6): the aggregator, delivery and review sites whose menus the price
 * pipeline never fetches, the host key every crawl decision is taken on — lower case, without a port, a trailing dot or IPv6
 * brackets — and the suffixes that let one entry cover a host's subdomains without letting `notyelp.com` pass as `yelp.com`.
 *
 * A blocklisted domain is recorded `prohibited` with reason `blocklist`, and its places take the phone fallback instead, so no
 * price is ever taken from a review site (AAP 0.5.6, 0.12.2). Every request of the menu pipeline passes this check — the entry
 * URL, each redirect target, each followed menu link and each browser request — because an allowed page must not reach,
 * through a redirect or a subresource, a domain the pipeline refuses on its own.
 *
 * The host helpers live here rather than in `crawl-policy.ts`, which the folder brief names for them: `crawl-policy.ts`
 * imports this module, so defining `domainKey` there would make the two files import each other; it re-exports both helpers
 * instead, so `import { domainKey } from './crawl-policy.ts'` keeps working. The configuration is read from disk once, at
 * startup: no clock, no network, no database.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CrawlBlocklist } from '@tablemate/shared';

/** The workspace marker identifying the repository root (AAP 0.6.1). */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';
/** The blocklist configuration, relative to the repository root (AAP 0.5.6). */
const BLOCKLIST_FILE = 'config/crawl-blocklist.json';
/** The directory this module was loaded from: the walk's default starting point (AAP 0.8.1). */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The domains the menu pipeline never fetches (AAP 0.5.6), held as normalized host keys ({@link domainKey}) so that a decision is a plain set lookup. */
export type Blocklist = { readonly domains: ReadonlySet<string> };
/**
 * A host with the port of a `host:port` spelling cut (AAP 0.5.6).
 *
 * A caller holding a URL's `host` rather than its `hostname` passes the port, which is not part of
 * the name a crawl decision or a throttle slot is about: `example.com:8080` and `example.com` are
 * one host, and must take one key. The port is cut at its colon, and only where everything after
 * that colon is digits, so a name is never truncated into a different one:
 *
 * - A bracketed IPv6 literal loses the port alone — `[::1]:8080` yields `[::1]`, whose brackets
 *   {@link domainKey} removes next.
 * - A host without brackets keeps every label unless exactly one colon remains, so a bare IPv6
 *   address (`2001:db8::1`, no port at all) is untouched.
 * - A tail that is not a number is left alone (`example.com:`).
 */
function withoutPort(key: string): string {
  const colon = key.lastIndexOf(':');
  if (colon === -1 || !/^[0-9]+$/.test(key.slice(colon + 1))) {
    return key;
  }
  if (key.startsWith('[')) {
    return colon > key.lastIndexOf(']') ? key.slice(0, colon) : key;
  }
  return key.indexOf(':') === colon ? key.slice(0, colon) : key;
}

/**
 * The host key every crawl decision is taken on (AAP 0.5.6): lower case, a `host:port` spelling's
 * port cut ({@link withoutPort}), at most one trailing dot removed, IPv6 brackets removed, and a
 * leading `www.` removed only while at least two labels remain so a host whose registrable name *is*
 * `www.com` keeps it. Cutting the port is what makes every spelling of one host — a `www.` prefix, a
 * port, letter case — reach one key, which is the guarantee `./domain-throttle.ts`'s lock rests on.
 *
 * IP literals and `localhost` are returned unchanged apart from lower casing and that port, and the
 * function is idempotent, so a host read back from the review queue keys the same way as a freshly
 * parsed one.
 */
export function domainKey(host: string): string {
  let key = withoutPort(host.toLowerCase());
  if (key.startsWith('[') && key.endsWith(']')) {
    key = key.slice(1, -1);
  }
  if (key.endsWith('.')) {
    key = key.slice(0, -1);
  }
  if (isIP(key) !== 0) {
    return key;
  }
  if (key.startsWith('www.') && key.slice('www.'.length).includes('.')) {
    return key.slice('www.'.length);
  }
  return key;
}

/** Every label-wise suffix of a host that a blocklist entry may name (AAP 0.5.6), most specific first: `a.b.example.co.uk` yields `a.b.example.co.uk`, `b.example.co.uk`, `example.co.uk` and `co.uk`, so an entry covers a host and its subdomains. Suffixes are cut on label boundaries only, never as substrings, which is what keeps `notyelp.com` from matching an entry for `yelp.com`. An IP literal and a single-label host yield themselves alone, and a suffix never drops to a single label, so `com` is not matchable. */
export function domainSuffixes(host: string): string[] {
  const key = domainKey(host);
  if (isIP(key) !== 0) {
    return [key];
  }
  const labels = key.split('.');
  const suffixes: string[] = [];
  for (let start = 0; start + 2 <= labels.length; start += 1) {
    suffixes.push(labels.slice(start).join('.'));
  }
  return suffixes.length > 0 ? suffixes : [key];
}

/** The repository root: the nearest ancestor of `from` holding `pnpm-workspace.yaml` (AAP 0.6.1). Both locations this module is loaded from walk to the same root — `apps/workers/src/menus` for the TypeScript source the `tablemate-source` condition resolves, `apps/workers/dist/src/menus` for the compiled JavaScript the workers image runs, whose `/app` holds the marker beside `config/crawl-blocklist.json` (AAP 0.8.1). */
export function findRepoRoot(from: string = MODULE_DIR): string {
  const start = path.resolve(from);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, WORKSPACE_MARKER))) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`${WORKSPACE_MARKER} not found above ${start}`);
    }
  }
}

/** The message of an unknown thrown value, for an error that names the file but not its content. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One schema issue as `path: message`; an issue at the file root is its message alone. */
function formatIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) => {
      const where = issue.path.map((segment) => String(segment)).join('.');
      return where === '' ? `  - ${issue.message}` : `  - ${where}: ${issue.message}`;
    })
    .join('\n');
}

/** Loads the crawl blocklist (AAP 0.5.6): `config/crawl-blocklist.json`, validated against {@link CrawlBlocklist}, which rejects an unknown key, a host that is not already lower case and a repeated domain, so a mistyped entry fails loudly at startup instead of being crawled. The read is synchronous on purpose: it happens once, before the menu pipeline accepts work, and the returned blocklist is the immutable value every later fetch consults. A failure names the offending path and what is wrong with it, and never echoes the file's content. */
export function loadBlocklist(repoRoot: string): Blocklist {
  const file = path.join(repoRoot, BLOCKLIST_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`crawl blocklist ${BLOCKLIST_FILE} could not be read: ${messageOf(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`crawl blocklist ${BLOCKLIST_FILE} is not valid JSON: ${messageOf(error)}`);
  }
  const parsed = CrawlBlocklist.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `crawl blocklist ${BLOCKLIST_FILE} is invalid:\n${formatIssues(parsed.error.issues)}`,
    );
  }
  const domains = new Set(parsed.data.domains.map((domain) => domainKey(domain)));
  return Object.freeze({ domains });
}

/** Whether a host is blocklisted (AAP 0.5.6): true when the host is a blocklisted domain or a subdomain of one, which is what stops `m.tripadvisor.com` while `nottripadvisor.com` passes. */
export function isBlocklisted(host: string, list: Blocklist): boolean {
  return domainSuffixes(host).some((suffix) => list.domains.has(suffix));
}
