/**
 * Policy-checked, SSRF-safe, bounded fetch (AAP 0.5.6).
 *
 * Every request the menu pipeline makes — the entry page, each redirect target, each followed menu
 * link, each browser subrequest and each host's `robots.txt` — is made here and nowhere else, so the
 * blocklist, the operator's site-terms decision and `robots.txt` are checked on every hop, never only
 * on the URL the pipeline started from.
 *
 * Three properties make a request safe against a page the pipeline does not control:
 *
 * - **The address is pinned before the connection is opened.** The host is resolved once, every answer
 *   is checked against {@link isBlockedAddress}, and the request then connects to that validated
 *   address itself — the name is never resolved a second time, at connect time or by a redirect, so no
 *   later DNS answer can point the connection at a private address (DNS rebinding).
 * - **Every hop re-runs every check.** A redirect target is validated exactly like the entry URL, so
 *   an allowed page cannot hand the crawler a review site, a domain nobody approved or an internal
 *   address through a 30x before its subrequests even begin.
 * - **The work is bounded.** {@link FETCH_LIMITS} caps one response and a {@link FetchBudget} caps a
 *   whole place: 50 requests and 30 MiB across the page, its subrequests, its PDFs and its images.
 *
 * No request is made without a slot from the per-domain throttle, so a domain sees at most one
 * request per second — a site and its subdomains share one slot, because the slot is taken on the
 * request host's registrable domain (AAP 0.3.3, AAP 0.12.2). A refusal is a {@link SafeFetchError}
 * naming its reason, and the caller takes the phone fallback: no price is guessed and no page without
 * permission is read. Log lines carry a host, a kind, a status, a byte count or a reason, and never a
 * body, page text, a price or a URL with its query (AAP 0.11.1).
 *
 * The crawl runs in `apps/workers` alone, so a refused fetch cannot delay proposing, locking, checking
 * in or settling (AAP 0.3.2).
 *
 * @see AAP 0.5.6 for the request-safety and resource bounds and the crawl policy, 0.3.3 for the
 *   menu-website rules, 0.12.2 for the checks `apps/workers/test/unit/safe-fetch.test.ts` makes, and
 *   0.8.1 for this file.
 */

import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';

import type { AppEnv, CrawlDecision } from '@tablemate/shared';
import type { Clock, Logger } from '@tablemate/server-core';

import { domainKey, isBlocklisted } from './blocklist.ts';
import type { Blocklist } from './blocklist.ts';
import { registrableDomain } from './crawl-policy.ts';
import { ThrottleTimeoutError } from './domain-throttle.ts';
import { createRobotsChecker } from './robots.ts';
import type { RobotsCache } from './robots.ts';

/**
 * The DNS answers of one host, as a resolver returns them (AAP 0.5.6).
 *
 * `apps/workers/src/queues.ts` injects the process resolver and
 * {@link SafeFetchDeps.lookup} lets a suite inject one whose second answer differs from its first,
 * which is how the rebinding defence is exercised.
 */
export type LookupFn = (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;

/**
 * The process resolver: every address the host answers with, in the resolver's own order.
 *
 * Every answer is validated, so this order only decides which of several acceptable addresses the
 * request uses.
 */
export const defaultLookup: LookupFn = async (host) => {
  const answers = await lookup(host, { all: true, verbatim: true });

  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

/** What a fetch is for, which decides its `Accept` header and its size limit (AAP 0.5.6). */
export type FetchKind = 'html' | 'pdf' | 'image' | 'robots';

/**
 * The bounds of one crawl (AAP 0.5.6). Binary megabytes, so `html: 10 MiB` is 10,485,760 bytes.
 *
 * One response is capped by its kind — 10 MiB of HTML or image, 20 MiB of PDF, 512 KiB of
 * `robots.txt`, which sits inside RFC 9309's own 500 KiB parsing limit — and one place is capped
 * across everything it pulls: {@link placeRequests} requests and {@link placeBytes} bytes of bodies,
 * the PDFs and images followed from the page included. `timeoutMs` covers connect, headers and body
 * of each hop.
 */
export const FETCH_LIMITS = {
  html: 10 * 1024 * 1024,
  image: 10 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  robots: 512 * 1024,
  placeBytes: 30 * 1024 * 1024,
  placeRequests: 50,
  timeoutMs: 30_000,
  maxRedirects: 5,
} as const;

/**
 * Why a request was refused (AAP 0.5.6). Each leaves the caller a decision it can act on: the URL is
 * unusable (`invalid_url`, `scheme`, `port`, `method_not_allowed`); it resolves nowhere or somewhere
 * forbidden (`dns_failed`, `blocked_address`); the crawl rules refuse it (`blocklisted`,
 * `policy_prohibited`, `policy_uncertain` — the site's terms are unreviewed, `robots_disallowed`);
 * the site wants a session (`auth_required`); or it was permitted but produced no usable answer
 * (`too_large`, `budget_exhausted`, `redirect_limit`, `timeout`, `http_error`, `network_error`,
 * `throttle_timeout`).
 */
export type SafeFetchReason =
  | 'invalid_url'
  | 'scheme'
  | 'port'
  | 'dns_failed'
  | 'blocked_address'
  | 'blocklisted'
  | 'policy_prohibited'
  | 'policy_uncertain'
  | 'robots_disallowed'
  | 'auth_required'
  | 'too_large'
  | 'budget_exhausted'
  | 'redirect_limit'
  | 'timeout'
  | 'http_error'
  | 'network_error'
  | 'throttle_timeout'
  | 'method_not_allowed';

/**
 * A refused request (AAP 0.5.6). The message names the reason and, when one is known, the host — never
 * the path or the query, so a URL carrying a token in its query cannot reach a log line through it.
 */
export class SafeFetchError extends Error {
  /** Why the request was refused. */
  readonly reason: SafeFetchReason;
  /** The host the refusal concerns, or `null` when no usable URL was parsed. */
  readonly host: string | null;
  /** The response status, when the refusal is an answer; `null` otherwise. */
  readonly status: number | null;

  /** @param reason - Why the request was refused. @param host - The host, when one is known. @param status - The status, for a refusal that is an answer. */
  constructor(reason: SafeFetchReason, host: string | null = null, status: number | null = null) {
    super(`${reason}${host ? ` (${host})` : ''}`);
    this.name = 'SafeFetchError';
    this.reason = reason;
    this.host = host;
    this.status = status;
  }
}

/**
 * One place's crawl allowance (AAP 0.5.6), shared by the page render, its subrequests and the PDFs and
 * images followed from it: 50 requests and 30 MiB of bodies. `apps/workers/src/jobs/menu-ingest.ts`
 * creates one per place and passes it to every fetch that place makes.
 *
 * Only bytes a caller keeps are counted; a redirect hop's body is discarded without being retained.
 */
export class FetchBudget {
  private usedRequests = 0;
  private usedBytes = 0;

  /** How many requests of the allowance have been reserved. */
  get requests(): number {
    return this.usedRequests;
  }

  /** How many body bytes of the allowance have been kept. */
  get bytes(): number {
    return this.usedBytes;
  }

  /**
   * Reserve one request of the allowance.
   *
   * @throws SafeFetchError with reason `budget_exhausted` when 50 requests were already reserved, so
   *   the 51st is refused before its address is resolved.
   */
  reserveRequest(): void {
    if (this.usedRequests >= FETCH_LIMITS.placeRequests) {
      throw new SafeFetchError('budget_exhausted');
    }

    this.usedRequests += 1;
  }

  /**
   * Account for `count` body bytes a caller is keeping.
   *
   * @throws SafeFetchError with reason `budget_exhausted` when they would take the place past
   *   `FETCH_LIMITS.placeBytes`.
   */
  addBytes(count: number): void {
    if (this.usedBytes + count > FETCH_LIMITS.placeBytes) {
      throw new SafeFetchError('budget_exhausted');
    }

    this.usedBytes += count;
  }

  /** The body bytes the place may still keep. */
  remainingBytes(): number {
    return Math.max(0, FETCH_LIMITS.placeBytes - this.usedBytes);
  }
}

/** One budget per place, from `menu-ingest`'s own scope (AAP 0.5.6). */
export function createFetchBudget(): FetchBudget {
  return new FetchBudget();
}

/** A permitted answer (AAP 0.5.6). */
export interface SafeFetchResponse {
  /**
   * The final URL, after every redirect was followed. `./fetch-page.ts` compares it with the URL it
   * asked for to recognise a login redirect.
   */
  url: string;
  /** The HTTP status of the final answer. */
  status: number;
  /** The `Content-Type` of the final answer, when it sent one. */
  contentType: string | null;
  /** The body, capped by the kind's {@link FETCH_LIMITS} entry. Empty for a `HEAD`. */
  body: Buffer;
}

/** What one fetch is asked for (AAP 0.5.6). */
type SafeFetchOptions = {
  kind: FetchKind;
  budget: FetchBudget;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
};

/**
 * The one fetch the menu pipeline uses (AAP 0.5.6): it either resolves with a permitted answer or
 * rejects with a {@link SafeFetchError} the caller maps to the phone fallback.
 */
export type SafeFetch = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResponse>;

/** The injected behaviour of {@link createSafeFetch} (AAP 0.5.6). */
export interface SafeFetchDeps {
  /** The resolver to use; {@link defaultLookup} when omitted. */
  lookup?: LookupFn;
  /**
   * The hosts the crawler may reach inside the test network, from `CRAWL_ALLOW_PRIVATE_HOSTS`. Honoured
   * only when `appEnv` is `test`, so an exempt host skips the address and port checks alone — the
   * blocklist, the site-terms decision and `robots.txt` still apply to it.
   */
  allowPrivateHosts: readonly string[];
  /** The deployment mode `APP_ENV` selects, which is what decides whether the exemption is honoured. */
  appEnv: AppEnv;
  /** The blocklist loaded once at startup by `./blocklist.ts`. */
  blocklist: Blocklist;
  /** The operator's site-terms decision for a host, from `./crawl-policy.ts` `createDomainPolicy`. */
  policy: (host: string) => Promise<CrawlDecision>;
  /** Where a fetched `robots.txt` is kept for its 24-hour lifetime. */
  robotsCache: RobotsCache;
  /**
   * The per-domain slot, from `./domain-throttle.ts` `createDomainThrottle`, called with the
   * request host's registrable domain — `registrableDomain(domainKey(host))` — so one site and all
   * its subdomains contend for the same slot.
   */
  throttle: (domain: string) => Promise<void>;
  /** The `User-Agent` every request sends, from `./robots.ts` `crawlerUserAgent`. */
  userAgent: string;
  /** Where a fetch and its refusals are recorded. */
  logger: Pick<Logger, 'debug' | 'warn'>;
  /** The injected clock, read for a log line's duration only (AAP 0.11.1). */
  clock: Clock;
}

/** The headers a caller may add: everything else — `host`, `cookie`, `authorization`, `connection` —
 * is dropped rather than forwarded, so a caller cannot hand a site a session the crawl never earned. */
const FORWARDED_HEADERS: ReadonlySet<string> = new Set(['accept', 'accept-language', 'referer']);

/** The `Accept` header of each kind (AAP 0.5.6). */
const KIND_ACCEPT: Readonly<Record<FetchKind, string>> = {
  html: 'text/html,application/xhtml+xml,*/*;q=0.8',
  pdf: 'application/pdf',
  image: 'image/*',
  robots: 'text/plain',
};

/** The statuses whose `Location` this module follows (AAP 0.5.6). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The body of an answer whose bytes are not wanted, so no caller has to special-case an empty read. */
const EMPTY_BODY = Buffer.alloc(0);

/**
 * The IPv4 ranges no request may reach (AAP 0.5.6): the unspecified, private, loopback, link-local
 * (the cloud metadata address `169.254.169.254` included), carrier-grade NAT, protocol-assignment,
 * documentation, benchmarking, multicast and reserved space. Every prefix below is 4 to 24 bits, so
 * the mask shift needs no edge case.
 */
const BLOCKED_IPV4_RANGES: readonly (readonly [network: string, prefix: number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** The 32-bit value of a dotted-quad IPv4 address, or `null` when it is not one. */
function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }

  return value;
}

/** Whether an IPv4 value lies in a blocked range (AAP 0.5.6). */
function ipv4BlockedValue(value: number): boolean {
  return BLOCKED_IPV4_RANGES.some(([network, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === ((ipv4ToInt(network) ?? 0) & mask) >>> 0;
  });
}

/** One side of an IPv6 address split on `::`, as its 16-bit groups, or `null` when it does not parse. */
function parseIPv6Side(side: string): number[] | null {
  if (side === '') return [];

  const groups: number[] = [];
  for (const group of side.split(':')) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }

  return groups;
}

/** The eight 16-bit groups of an IPv6 address, or `null` when it does not parse (AAP 0.5.6). */
function ipv6Groups(address: string): number[] | null {
  // A zone id names an interface of the local host, which a public request can never need.
  if (address.includes('%')) return null;

  let text = address.toLowerCase();
  const dot = text.lastIndexOf('.');
  if (dot >= 0) {
    // A trailing dotted quad — `::ffff:127.0.0.1` — becomes the last two groups, so both spellings of
    // one address reach the same checks.
    const colon = text.lastIndexOf(':', dot);
    const embedded = colon < 0 ? null : ipv4ToInt(text.slice(colon + 1));
    if (embedded === null || colon < 0) return null;
    const high = ((embedded >>> 16) & 0xffff).toString(16);
    const low = (embedded & 0xffff).toString(16);
    text = `${text.slice(0, colon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = parseIPv6Side(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = parseIPv6Side(halves[1] ?? '');
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;

  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * Whether an IPv6 address is one no request may reach (AAP 0.5.6): the unspecified and loopback
 * addresses, unique-local, link-local, multicast, documentation and discard-only space, and the
 * addresses that carry an IPv4 address inside them, which are blocked whenever the IPv4 address they
 * carry is.
 *
 * Four kinds of prefix carry an IPv4 address, and each is read the way the RFC that lays it out
 * defines it. An IPv4-mapped or IPv4-compatible address and the well-known NAT64 prefix
 * `64:ff9b::/96` hold it in the last 32 bits. A 6to4 `2002::/16` address holds the tunnel endpoint's
 * own IPv4 address there, so decoding it is exact rather than conservative (RFC 3056, §2). A
 * local-use NAT64 `64:ff9b:1::/48` address spreads it over the 16 bits after the prefix and the two
 * octets around the reserved `u` octet (RFC 6052, §2.2; the prefix is assigned by RFC 8215, §3), and
 * a literal that does not follow that layout is refused outright, because no address can be decoded
 * from it. Teredo `2001:0000::/32` is refused outright too: it holds the Teredo server's IPv4 address
 * and the client's obfuscated one rather than a destination the filter can judge (RFC 4380, §4).
 */
function ipv6Blocked(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = g6 * 65536 + g7;

  // `::`, `::1`, an IPv4-compatible address and an IPv4-mapped one all carry their IPv4 address here,
  // and the unspecified and loopback shapes carry 0.0.0.0 and 0.0.0.1, which the IPv4 list blocks.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) return ipv4BlockedValue(embedded);
  // 64:ff9b::/96, the well-known NAT64 prefix.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ipv4BlockedValue(embedded);
  }
  // 2002::/16, 6to4: bits 16-47 are the IPv4 address of the 6to4 endpoint itself (RFC 3056, §2), so
  // a literal built on a blocked address is refused and one built on a public address is not.
  if (g0 === 0x2002) return ipv4BlockedValue(g1 * 65536 + g2);
  // 2001:0000::/32, Teredo (RFC 4380, §4): it carries the Teredo server's IPv4 address and the
  // client's obfuscated (one's-complemented) one, and a relay chosen by the routing system finishes
  // the path, so no value decodable from the literal establishes which IPv4 address a request to it
  // reaches. Refusing the whole prefix is the only answer that closes the hole. This is not the
  // 2001:db8::/32 documentation range checked below: `g1` separates the two (`0x0000` against
  // `0x0db8`).
  if (g0 === 0x2001 && g1 === 0x0000) return true;
  // 64:ff9b:1::/48, the local-use NAT64 prefix (RFC 8215, §3). RFC 6052, §2.2 lays a /48 prefix out
  // with IPv4 bits 0-15 in `g3`, the reserved `u` octet in `g4`'s high half, IPv4 bits 16-31 in
  // `g4`'s low byte and `g5`'s high byte, and reserved zero bits from `g5`'s low byte on. A literal
  // that departs from that layout carries no IPv4 address this filter can decode, so it is refused
  // rather than trusted.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) {
    const wellFormed = (g4 & 0xff00) === 0 && (g5 & 0x00ff) === 0 && g6 === 0 && g7 === 0;

    return !wellFormed || ipv4BlockedValue(g3 * 65536 + ((g4 & 0xff) << 8) + (g5 >> 8));
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only

  return false;
}

/**
 * Whether an address is one the crawler may never connect to (AAP 0.5.6, pure).
 *
 * True for every private, loopback, link-local, carrier-grade NAT, multicast, reserved, documentation
 * and benchmarking range of IPv4; for the unspecified, loopback, unique-local, link-local, multicast,
 * documentation and discard-only ranges of IPv6; for an IPv6 address that embeds a blocked IPv4
 * address — IPv4-mapped, IPv4-compatible, both NAT64 prefixes and 6to4, each decoded as its own RFC
 * lays the embedded address out — and for one that reaches an IPv4 address through a transition
 * prefix whose embedded address cannot be decoded, Teredo and a malformed local-use NAT64 address,
 * which are refused outright; for an address carrying a zone id; and — failing closed — for anything
 * that does not parse as an address at all.
 *
 * @param ip The address from a {@link LookupFn} answer or from an IP-literal host.
 * @returns True when no request may be made to it.
 */
export function isBlockedAddress(ip: string): boolean {
  const address = ip.trim().toLowerCase();
  const family = isIP(address);

  if (family === 4) {
    const value = ipv4ToInt(address);
    return value === null ? true : ipv4BlockedValue(value);
  }
  if (family !== 6) return true;

  const groups = ipv6Groups(address);

  return groups === null ? true : ipv6Blocked(groups);
}

/**
 * The host a request connects to (AAP 0.5.6): `url.hostname` lower-cased and without the brackets an
 * IPv6 literal carries, because a `Host` header and an SNI name must not be `[::1]`. {@link domainKey}
 * is the key the crawl decisions are taken on, and drops a leading `www.` as well.
 */
function hostOf(url: URL): string {
  const host = url.hostname;

  return (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host).toLowerCase();
}

/**
 * The URL of one hop, or the {@link SafeFetchError} it earns (AAP 0.5.6). A URL carrying credentials
 * is refused outright, and the scheme is judged before the host so `file:` and `data:` report `scheme`
 * rather than an unusable host.
 */
function parseHttpUrl(rawUrl: string): { url: URL; host: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('invalid_url');
  }

  const host = hostOf(url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('scheme', host || null);
  }
  if (url.username !== '' || url.password !== '' || host === '') {
    throw new SafeFetchError('invalid_url', host || null);
  }

  return { url, host };
}

/** The port a request would use, including the scheme's own default (AAP 0.5.6). */
function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port);

  return url.protocol === 'https:' ? 443 : 80;
}

/** One header's value, or `null`; a repeated header is read as its first value. */
function headerOf(response: IncomingMessage, name: string): string | null {
  const value = response.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : null;
  }

  return null;
}

/** The headers one request sends: the crawler's own, then the caller's allowlisted ones (AAP 0.5.6). */
function buildHeaders(
  kind: FetchKind,
  userAgent: string,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: KIND_ACCEPT[kind],
    // Nothing compressed: a decompression bomb is otherwise a way around the byte bounds below.
    'accept-encoding': 'identity',
  };

  for (const [name, value] of Object.entries(extra ?? {})) {
    const key = name.toLowerCase();
    if (FORWARDED_HEADERS.has(key)) {
      headers[key] = value;
    }
  }

  return headers;
}

/**
 * Where a redirect points (AAP 0.5.6), resolved against the URL that answered it. A target that cannot
 * be parsed stops the fetch: following it would be following bytes the site never named.
 */
function resolveLocation(base: URL, location: string): string {
  try {
    return new URL(location, base).href;
  } catch {
    throw new SafeFetchError('invalid_url', hostOf(base));
  }
}

/** One answer of a redirect chain, before any status decision (AAP 0.5.6). */
type Hop = {
  readonly url: URL;
  readonly host: string;
  readonly status: number;
  readonly location: string | null;
  readonly contentType: string | null;
  readonly body: Buffer;
};

/**
 * Build the crawler's one fetch (AAP 0.5.6).
 *
 * Every hop of every request runs the same chain, in this order: the URL, the port, the blocklist, the
 * operator's site-terms decision, the resolved addresses, `robots.txt`, the place's budget, the
 * per-domain throttle, and only then the connection to the address that was validated. The `robots`
 * kind is the chain's one exception: it is not itself subject to `robots.txt`.
 *
 * The returned function rejects with a {@link SafeFetchError} and never falls back to an unsafe
 * request, so a caller that cannot fetch has nothing left to try but the phone route.
 */
export function createSafeFetch(deps: SafeFetchDeps): SafeFetch {
  const lookup = deps.lookup ?? defaultLookup;
  // The exemption is honoured in `test` alone. `CRAWL_ALLOW_PRIVATE_HOSTS` is refused outside it by
  // the environment schema, and an injected list must not widen the crawler anywhere else either.
  const exemptHosts = new Set(
    deps.appEnv === 'test' ? deps.allowPrivateHosts.map((host) => host.toLowerCase()) : [],
  );

  if (deps.appEnv !== 'test' && deps.allowPrivateHosts.length > 0) {
    deps.logger.warn({
      event: 'crawl_private_hosts_ignored',
      hosts: deps.allowPrivateHosts.length,
    });
  }

  const robots = createRobotsChecker({
    cache: deps.robotsCache,
    userAgent: deps.userAgent,
    fetchRobotsTxt: async (origin) => {
      try {
        // A fresh budget: a robots.txt is cached for 24 hours and is not the place's page, so it must
        // not spend the place's 50 requests. It still passes the blocklist, policy, address and
        // throttle checks, because it goes through the one chain below.
        const answer = await safeFetch(`${origin}/robots.txt`, {
          kind: 'robots',
          budget: createFetchBudget(),
        });

        return { status: answer.status, body: answer.body.toString('utf8') };
      } catch {
        // No answer at all: the checker reads `null` as "nothing may be crawled", never as "no
        // robots.txt" (AAP 0.5.6).
        return null;
      }
    },
  });

  /** Resolve a host, or refuse `dns_failed` (AAP 0.5.6). */
  async function resolveHost(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
    try {
      return await lookup(host);
    } catch {
      throw new SafeFetchError('dns_failed', host);
    }
  }

  /** One HTTP answer, from the URL checks to the last body byte (AAP 0.5.6). */
  async function performHop(
    rawUrl: string,
    kind: FetchKind,
    method: 'GET' | 'HEAD',
    headers: Record<string, string>,
    budget: FetchBudget,
  ): Promise<Hop> {
    const { url, host } = parseHttpUrl(rawUrl);
    const exempt = exemptHosts.has(host);
    const port = effectivePort(url);

    // An exempt host is a fixture server on this host, which is why it alone may use another port.
    if (!exempt && port !== 80 && port !== 443) {
      throw new SafeFetchError('port', host);
    }

    const hostKey = domainKey(host);
    if (isBlocklisted(host, deps.blocklist)) {
      throw new SafeFetchError('blocklisted', host);
    }

    const decision = await deps.policy(hostKey);
    if (decision !== 'allowed') {
      // `uncertain` is recorded by the policy before it answers, so a domain awaiting an operator's
      // judgement is never fetched even once.
      throw new SafeFetchError(
        decision === 'prohibited' ? 'policy_prohibited' : 'policy_uncertain',
        host,
      );
    }

    const literal = isIP(host);
    const answers: { address: string; family: 4 | 6 }[] =
      literal === 0 ? await resolveHost(host) : [{ address: host, family: literal === 6 ? 6 : 4 }];
    const target = answers[0];
    if (target === undefined) {
      throw new SafeFetchError('dns_failed', host);
    }
    if (!exempt) {
      // Every answer is checked, not only the one the request will use: a host that answers with a
      // public address and a private one is refused rather than partly trusted.
      for (const answer of answers) {
        if (isBlockedAddress(answer.address)) {
          throw new SafeFetchError('blocked_address', host);
        }
      }
    }

    // The address is judged before `robots.txt` is fetched, though both belong to this one hop: a host
    // the crawler may not reach has no readable robots.txt either, so that fetch fails closed and a
    // later address check would report the masked `robots_disallowed`. Every check still runs on
    // every hop. A host whose robots.txt cannot be read in the deadline is refused as
    // `robots_disallowed` on purpose (RFC 9309 §2.3.1.4); the reason its own fetch failed is on that
    // fetch's own `menu_fetch_refused` line, with kind `robots`.
    if (kind !== 'robots' && !(await robots.isAllowed(url))) {
      throw new SafeFetchError('robots_disallowed', host);
    }

    budget.reserveRequest();

    try {
      // The slot is scoped to the site, not to the host spelling the request happens to use, so
      // `a.example.com` and `b.example.com` cannot each make a request a second to `example.com`
      // (AAP 0.5.6, 0.3.3). The full host stays on the refusal line below and in the policy call
      // above, where the exact name the crawler reached is what the log and the decision are about.
      await deps.throttle(registrableDomain(hostKey));
    } catch (error) {
      if (error instanceof ThrottleTimeoutError) {
        throw new SafeFetchError('throttle_timeout', host);
      }
      throw error;
    }

    const secure = url.protocol === 'https:';
    // The connection is opened to the address itself, so no name is resolved at connect time and no
    // second answer can point the socket somewhere the check above refused. A connect this address
    // cannot serve (an IPv6 address on a host without one, say) is then the request's own error and
    // reaches the caller as a `SafeFetchError`; asked for by name it would be an unhandled socket
    // error instead, because `net` fails it before the HTTP layer can attach its listener.
    const defaultPort = secure ? 443 : 80;
    // The name as a `Host` header carries it: an IPv6 literal is bracketed, an IPv4 one is not.
    const authority = literal === 6 ? `[${host}]` : host;
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: target.address,
      port,
      path: `${url.pathname}${url.search}`,
      method,
      // The header Node derives for the original host: the name, with the port only when it differs
      // from the scheme's own, so the site still answers as itself though the socket went to the
      // literal. `buildHeaders` drops a caller-supplied `host`, so no caller can override it.
      headers: { ...headers, host: port === defaultPort ? authority : `${authority}:${port}` },
      agent: false,
    };
    // SNI carries a name, never an IP literal.
    if (secure && literal === 0) options.servername = host;

    const limit = FETCH_LIMITS[kind];
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    try {
      const response = await new Promise<IncomingMessage>((onResponse, onError) => {
        const request = (secure ? httpsRequest : httpRequest)(options, onResponse);
        // One deadline covers connect, headers and body; destroying the request surfaces the refusal
        // to the reader at the catch below.
        timer = setTimeout(() => {
          timedOut = true;
          request.destroy(new SafeFetchError('timeout', host));
        }, FETCH_LIMITS.timeoutMs);
        request.on('error', onError);
        request.end();
      });
      const status = response.statusCode ?? 0;
      const location = headerOf(response, 'location');
      const contentType = headerOf(response, 'content-type');

      if (REDIRECT_STATUSES.has(status) && location !== null) {
        // The body is discarded by closing the connection rather than drained, so a hostile 302 cannot
        // stream past the byte bounds, and the socket was never reusable anyway (`agent: false`).
        response.destroy();
        return { url, host, status, location, contentType, body: EMPTY_BODY };
      }
      if (method === 'HEAD') {
        response.destroy();
        return { url, host, status, location: null, contentType, body: EMPTY_BODY };
      }

      // A declared length over the kind's limit is refused before a byte of the body is read.
      const declared = Number(headerOf(response, 'content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > limit) {
        response.destroy();
        throw new SafeFetchError('too_large', host, status);
      }

      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of response as AsyncIterable<Buffer>) {
        received += chunk.length;
        if (received > limit) {
          response.destroy();
          throw new SafeFetchError('too_large', host, status);
        }
        budget.addBytes(chunk.length);
        chunks.push(chunk);
      }

      return { url, host, status, location: null, contentType, body: Buffer.concat(chunks) };
    } catch (error) {
      // The refusals raised above are already typed. Everything else is the socket or the TLS
      // handshake failing, which is a `timeout` when the deadline above fired — a deadline that
      // expires mid-body reaches here as the socket's own error — and `network_error` otherwise.
      if (error instanceof SafeFetchError) throw error;
      throw new SafeFetchError(timedOut ? 'timeout' : 'network_error', host);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Follow `rawUrl` through its redirects, re-checking every hop, and refuse any answer the kind
   * cannot use (AAP 0.5.6).
   */
  async function perform(
    rawUrl: string,
    opts: SafeFetchOptions,
    startedMs: number,
  ): Promise<SafeFetchResponse> {
    const method = opts.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      throw new SafeFetchError('method_not_allowed');
    }

    const headers = buildHeaders(opts.kind, deps.userAgent, opts.headers);
    let target = rawUrl;
    let followed = 0;

    for (;;) {
      const hop = await performHop(target, opts.kind, method, headers, opts.budget);

      if (REDIRECT_STATUSES.has(hop.status) && hop.location !== null) {
        if (followed >= FETCH_LIMITS.maxRedirects) {
          throw new SafeFetchError('redirect_limit', hop.host);
        }
        followed += 1;
        // The next URL is checked by `performHop` exactly as the entry URL was, so an allowed page
        // cannot redirect the crawler to a review site, an unreviewed domain or an internal address.
        target = resolveLocation(hop.url, hop.location);
        continue;
      }

      if (opts.kind !== 'robots') {
        if (hop.status === 401 || hop.status === 403) {
          throw new SafeFetchError('auth_required', hop.host, hop.status);
        }
        if (hop.status < 200 || hop.status > 299) {
          throw new SafeFetchError('http_error', hop.host, hop.status);
        }
      }

      deps.logger.debug({
        event: 'menu_fetch',
        host: hop.host,
        kind: opts.kind,
        status: hop.status,
        bytes: hop.body.length,
        durationMs: deps.clock.nowMs() - startedMs,
      });

      return {
        url: hop.url.href,
        status: hop.status,
        contentType: hop.contentType,
        body: hop.body,
      };
    }
  }

  const safeFetch: SafeFetch = async (url, opts) => {
    try {
      return await perform(url, opts, deps.clock.nowMs());
    } catch (error) {
      // One line per refused fetch, whatever hop refused it, and never a path or a query string.
      if (error instanceof SafeFetchError) {
        deps.logger.warn({
          event: 'menu_fetch_refused',
          host: error.host,
          kind: opts.kind,
          reason: error.reason,
        });
      }
      throw error;
    }
  };

  return safeFetch;
}
